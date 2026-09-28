import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { execa } from 'execa';
import { isFile } from '../files.js';

/** One `webServer` entry of the repo's Playwright config, as the config evaluated it. */
export interface WebServer {
  command?: string;
  url?: string;
  port?: number;
  cwd?: string;
  env?: Record<string, string>;
  timeout?: number;
  /** Keys of `env` whose value equals what the config process already had: pass-throughs, not settings. */
  inheritedEnv: string[];
}

/** What loading the repo's Playwright config revealed. */
export interface Probe {
  webServers: WebServer[];
  /** Variables (and values) the config added to its own environment while loading, e.g. through dotenv. */
  addedEnv: Record<string, string>;
  /** True if CI was unset in isolate's environment and the config was evaluated with CI=true. */
  ciForced: boolean;
}

/** Variables Playwright itself sets while loading a config; they are not the config's doing. */
const PLAYWRIGHT_OWN_ENV = /^(PW_|PWDEBUG$|PLAYWRIGHT_|TEST_|DEBUG$|BROWSERSLIST_IGNORE_OLD_DATA$)/;

/** A test-file filter that matches nothing, so `--list` loads the config but no test file. */
const NO_TEST_FILE = '__isolate_probe_matches_no_test_file__';

const PROBE_BODY = `const known = new Set(JSON.parse(process.env.ISOLATE_PROBE_KEYS ?? '[]'));
const servers = base.webServer === undefined ? [] : [base.webServer].flat();
writeFileSync(process.env.ISOLATE_PROBE_OUT, JSON.stringify({
  webServers: servers.map((server) => ({ ...server, inheritedEnv: Object.keys(server.env ?? {}).filter((key) => server.env[key] === process.env[key]) })),
  addedEnv: Object.fromEntries(Object.entries(process.env).filter(([key]) => !known.has(key))),
}));
`;

/** Source of the probe config: imports the repo's config, writes its webServer list, and exports it without webServer. */
function probeSource(repoConfig: string): string {
  const base = path.basename(repoConfig);
  const header = '// Written by `isolate init` to read the resolved webServer, and removed right after.\n';
  if (base.endsWith('.cjs')) {
    const load = `const { writeFileSync } = require('node:fs');\nconst loaded = require('./${base}');\nconst base = loaded.default ?? loaded;\n`;
    return `${header}${load}${PROBE_BODY}module.exports = { ...base, webServer: undefined };\n`;
  }
  const specifier = base.endsWith('.ts') ? base.slice(0, -'.ts'.length) : base;
  const load = `import { writeFileSync } from 'node:fs';\nimport base from './${specifier}';\n`;
  return `${header}${load}${PROBE_BODY}export default { ...base, webServer: undefined };\n`;
}

/** The Playwright CLI the repo's config resolves (so the probe runs the repo's own Playwright version). */
function playwrightCli(configDir: string): string {
  const require = createRequire(path.join(configDir, 'package.json'));
  for (const name of ['@playwright/test/cli', 'playwright/cli']) {
    try {
      return require.resolve(name);
    } catch {
      continue;
    }
  }
  throw new Error(`Playwright is not installed where ${configDir} can load it (@playwright/test). Install the repo's dependencies first.`);
}

/**
 * Evaluates the repo's Playwright config with Playwright's own loader (`playwright test -c <probe> --list`, where the
 * probe config imports the repo's) and returns its webServer entries. The probe sits next to the repo's config so
 * relative imports resolve as usual, and it is removed afterwards.
 */
export async function probeWebServers(repoConfig: string): Promise<Probe> {
  const configDir = path.dirname(repoConfig);
  const probeFile = path.join(configDir, `.isolate.probe.config${path.extname(repoConfig)}`);
  // A private directory: the output holds the values the config loaded, which may include secrets from a local .env.
  const outDir = mkdtempSync(path.join(os.tmpdir(), 'isolate-probe-'));
  const outFile = path.join(outDir, 'probe.json');
  const ciForced = process.env.CI === undefined;
  const env: Record<string, string | undefined> = { ...process.env, CI: process.env.CI ?? 'true', FORCE_COLOR: '0', ISOLATE_PROBE_OUT: outFile };
  env.ISOLATE_PROBE_KEYS = JSON.stringify([...Object.keys(env), 'ISOLATE_PROBE_KEYS']);
  try {
    writeFileSync(probeFile, probeSource(repoConfig));
    const result = await execa(process.execPath, [playwrightCli(configDir), 'test', '-c', probeFile, '--list', NO_TEST_FILE], {
      cwd: configDir,
      env,
      extendEnv: false,
      reject: false,
      all: true,
      timeout: 120_000,
    });
    if (!isFile(outFile)) {
      throw new Error(`Playwright could not load ${repoConfig}:\n${String(result.all ?? '').trim()}`);
    }
    const probed = JSON.parse(readFileSync(outFile, 'utf8')) as Omit<Probe, 'ciForced'>;
    const addedEnv = Object.fromEntries(Object.entries(probed.addedEnv).filter(([key]) => !PLAYWRIGHT_OWN_ENV.test(key)));
    return { webServers: probed.webServers, addedEnv, ciForced };
  } finally {
    rmSync(probeFile, { force: true });
    rmSync(outDir, { recursive: true, force: true });
  }
}
