import path from 'node:path';
import { readPackageJson, relPath } from '../files.js';
import { found, guess, type Finding } from '../finding.js';
import { templatePort } from '../port-template.js';
import { inDir, scriptCommand, type PackageManager } from '../scripts.js';
import type { Probe, WebServer } from './web-server.js';

/** How the app is started, derived from the Playwright config's first webServer. */
export interface AppStart {
  start: Finding<string>;
  /** A build step split off a composite webServer command such as `npm run build && npm start`. */
  build: Finding<string> | null;
  /** Directory the app runs in (absolute). */
  appDir: string;
  /** The port the webServer listens on, or null if the config does not say. */
  port: number | null;
  /** The path of webServer.url, or null if it has none. */
  urlPath: string | null;
  /** webServer.env entries the config sets explicitly, with the port templated. */
  env: Record<string, string>;
  bootTimeoutMs: number | null;
  warnings: string[];
}

/** What a start command is split into: leading `cd`s, a build step, and the start step. */
interface CommandParts {
  cd: string[];
  build: string[];
  start: string[];
}

/** Splits `cd x && npm run build && npm start` into its cd, build and start steps. */
function splitCommand(command: string): CommandParts {
  const steps = command.split(/\s*&&\s*/);
  const firstNonCd = steps.findIndex((step) => !/^cd\s/.test(step));
  const cdCount = firstNonCd === -1 ? steps.length : firstNonCd;
  const cd = steps.slice(0, cdCount);
  const rest = steps.slice(cdCount);
  const lastBuild = rest.findLastIndex((step) => /\bbuild\b/.test(step));
  if (lastBuild === -1 || lastBuild === rest.length - 1) return { cd, build: [], start: rest };
  return { cd, build: rest.slice(0, lastBuild + 1), start: rest.slice(lastBuild + 1) };
}

/** The port a webServer entry waits for: `port`, else the port of `url`. */
function serverPort(server: WebServer): number | null {
  if (server.port !== undefined) return server.port;
  if (server.url === undefined) return null;
  const url = new URL(server.url);
  return url.port === '' ? null : Number(url.port);
}

/** The path of webServer.url when it is more than `/`. */
function serverUrlPath(server: WebServer): string | null {
  if (server.url === undefined) return null;
  const pathname = new URL(server.url).pathname;
  return pathname === '/' ? null : pathname;
}

/** A warning when the start command runs a dev server, which N copies in one checkout may not survive (RISKS R18). */
function devServerWarning(command: string): string[] {
  const dev = /\b(next|nuxt|vite|remix|astro)\s+dev\b|\bvite\s+serve\b|(^|&&\s*)vite(\s+-|\s*$)|\b(npm run|pnpm|yarn|bun run)\s+dev\b/.test(command);
  if (!dev) return [];
  return [`app.start \`${command}\` runs a dev server: N copies in one checkout can collide (Next.js shares .next, RISKS R18). Prefer a production build and start.`];
}

/** The app start command when the config has no webServer: the package.json start script, as a guess. */
function startScriptFallback(repoDir: string, configFile: string, packageManager: PackageManager): AppStart | null {
  const dirs = [path.dirname(configFile), repoDir];
  const appDir = dirs.find((dir) => readPackageJson(dir)?.scripts?.start !== undefined);
  if (appDir === undefined) return null;
  const source = `no webServer in ${relPath(repoDir, configFile)}; "start" script in ${relPath(repoDir, path.join(appDir, 'package.json'))}`;
  const start = guess(inDir(repoDir, appDir, scriptCommand(packageManager, 'start')), source);
  return { start, build: null, appDir, port: null, urlPath: null, env: {}, bootTimeoutMs: null, warnings: [] };
}

/**
 * Derives app.start (and a build step split off it), the app directory, port, env and boot timeout from the first
 * webServer entry the probe returned. Falls back to the package.json start script; null if there is neither.
 */
export function deriveStart(repoDir: string, configFile: string, probe: Probe, packageManager: PackageManager): AppStart | null {
  const [server, ...others] = probe.webServers;
  if (server?.command === undefined) return startScriptFallback(repoDir, configFile, packageManager);

  const configName = relPath(repoDir, configFile);
  const evaluated = probe.ciForced ? ' (evaluated with CI=true)' : '';
  const appDir = path.resolve(path.dirname(configFile), server.cwd ?? '.');
  const port = serverPort(server);
  const parts = splitCommand(templatePort(server.command, port));
  const start = found(inDir(repoDir, appDir, [...parts.cd, ...parts.start].join(' && ')), `webServer.command in ${configName}${evaluated}`);
  const build = parts.build.length === 0 ? null : found(inDir(repoDir, appDir, [...parts.cd, ...parts.build].join(' && ')), `build step of webServer.command in ${configName}`);
  const env = Object.fromEntries(
    Object.entries(server.env ?? {})
      .filter(([key]) => !server.inheritedEnv.includes(key))
      .map(([key, value]) => [key, templatePort(String(value), port)]),
  );
  const warnings = [
    ...devServerWarning(start.value),
    ...others.map((other) => `${configName} has another webServer (\`${other.command ?? other.url ?? '?'}\`) that isolate does not start: V1 starts one app per worker.`),
  ];
  return { start, build, appDir, port, urlPath: serverUrlPath(server), env, bootTimeoutMs: server.timeout ?? null, warnings };
}
