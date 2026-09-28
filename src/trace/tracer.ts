import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { IsolateConfig } from '../config/schema.js';
import { log } from '../log.js';
import { isolatePaths } from '../paths.js';
import { startController, type Controller } from './controller.js';
import { headCommit } from './git.js';
import { buildMap, writeMap, type ImpactMap } from './map.js';
import { SourceResolver } from './sourcemap.js';

const APP_PRELOAD = fileURLToPath(new URL('./app-preload.cjs', import.meta.url));
const WORKER_PRELOAD = fileURLToPath(new URL('./worker-preload.cjs', import.meta.url));

/** Source map failures printed in the summary; the map's stats list all of them. */
const SHOWN_FAILURES = 5;

/** Tracing for one `isolate trace` session. */
export interface Tracer {
  /** The socket directory; hand it to the reaper so it is removed even if isolate is killed. */
  dir: string;
  /** The config to start the apps with: its `app.env` also loads the app preload and names the socket directory. */
  appConfig: IsolateConfig;
  /** Variables to add to the Playwright command's environment. */
  playwrightEnv: Record<string, string>;
  /**
   * Builds and writes .isolate/map.json (while the apps still run, so client source maps can be fetched), prints a
   * summary, and returns a warning if some test that ran is missing from the map.
   */
  finish(ranTestIds: string[]): Promise<string[]>;
  /** Stops the control server and deletes the socket directory. */
  close(): Promise<void>;
}

/** Appends `--require <file>` to a NODE_OPTIONS value. */
function withRequire(nodeOptions: string | undefined, file: string): string {
  return [nodeOptions, `--require ${JSON.stringify(file)}`].filter(Boolean).join(' ');
}

function summarize(map: ImpactMap, file: string): string {
  const { stats } = map;
  return (
    `trace: ${Object.keys(map.tests).length} tests mapped; global: ${map.global.length} files, bootLoaded: ${map.bootLoaded.length} files; ` +
    `between-test takes: ${stats.betweenTestTakes}, take timeouts: ${stats.takeTimeouts}, ` +
    `source map failures: ${stats.sourceMapFailures.length}, unresolved client URLs: ${stats.unresolvedClientUrls.length}; wrote ${file}`
  );
}

async function writeTraceMap(repoDir: string, root: string, config: IsolateConfig, workers: number, controller: Controller, ranTestIds: string[]): Promise<string[]> {
  const resolver = new SourceResolver(root, config.trace.clientRoots, controller.record.sources);
  const map = await buildMap(controller.record, resolver, { workers, commit: await headCommit(repoDir) });
  const file = isolatePaths(repoDir).map;
  writeMap(file, map);
  log.info(summarize(map, file));
  for (const failure of map.stats.sourceMapFailures.slice(0, SHOWN_FAILURES)) log.warn(`source map: ${failure}`);
  if (map.stats.sourceMapFailures.length > SHOWN_FAILURES) log.warn(`source map: ${map.stats.sourceMapFailures.length - SHOWN_FAILURES} more failures in ${file}`);
  const missing = [...new Set(ranTestIds)].filter((id) => !(id in map.tests)).sort();
  if (missing.length === 0) return [];
  const warning = `${missing.length} test(s) ran but are missing from the impact map: ${missing.join('; ')}`;
  log.warn(warning);
  return [warning];
}

/**
 * Starts tracing for `isolate trace`: a socket directory for the apps' coverage (a short path under the OS temp
 * directory, since Unix socket paths are limited to about 100 bytes) and the control server the workers call.
 */
export async function startTracer(repoDir: string, config: IsolateConfig, workers: number): Promise<Tracer> {
  const traceDir = mkdtempSync(path.join(os.tmpdir(), 'isolate-trace-'));
  const root = realpathSync(repoDir);
  const controller = await startController(traceDir);
  const appEnv = {
    ...config.app.env,
    NODE_OPTIONS: withRequire(config.app.env.NODE_OPTIONS ?? process.env.NODE_OPTIONS, APP_PRELOAD),
    ISOLATE_TRACE_DIR: traceDir,
    ISOLATE_TRACE_ROOT: root,
  };
  return {
    dir: traceDir,
    appConfig: { ...config, app: { ...config.app, env: appEnv } },
    playwrightEnv: {
      NODE_OPTIONS: withRequire(process.env.NODE_OPTIONS, WORKER_PRELOAD),
      ISOLATE_CONTROL_URL: controller.url,
      ISOLATE_TRACE_ROOT: repoDir,
    },
    finish: (ranTestIds) => writeTraceMap(repoDir, root, config, workers, controller, ranTestIds),
    close: async () => {
      await controller.close();
      rmSync(traceDir, { recursive: true, force: true });
    },
  };
}
