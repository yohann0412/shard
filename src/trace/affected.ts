import path from 'node:path';
import { CONFIG_FILE } from '../config/load.js';
import type { IsolateConfig } from '../config/schema.js';
import type { ImpactMap } from './map.js';

/** The answer of `isolate affected`. */
export interface Selection {
  /** True when every test must run. */
  all: boolean;
  /** Why every test must run, or null. */
  reason: string | null;
  /** Selected test ids, sorted; every test in the map when `all` is true. */
  tests: string[];
  /** The changed files the selection is based on. */
  changed: string[];
}

const LOCKFILES = ['pnpm-lock.yaml', 'package-lock.json', 'npm-shrinkwrap.json', 'yarn.lock', 'bun.lock', 'bun.lockb'];

/** Where Playwright writes by default, relative to its config: `outputDir` and the HTML and blob reports. */
const PLAYWRIGHT_OUTPUTS = ['test-results', 'playwright-report', 'blob-report'];

/** Repo-relative form of a configured path: forward slashes, no `./`, no trailing slash. */
function normalize(configured: string): string {
  return path.posix.normalize(configured.split(path.sep).join('/')).replace(/\/$/, '');
}

/** True if the repo-relative `file` is `dir` or lies below it; `.` holds every file inside the repository. */
function isUnder(dir: string, file: string): boolean {
  if (dir === '.') return !file.startsWith('../');
  return file === dir || file.startsWith(`${dir}/`);
}

/**
 * Paths, relative to the repository as configured, whose changes run every test even when they lie above it: the
 * cache inputs and a lockfile in any parent directory. The relative diff cannot see those, so they are diffed by name.
 */
export function alwaysAllPaths(repoDir: string, config: IsolateConfig): string[] {
  const parents = path.resolve(repoDir).split(path.sep).length - 1;
  const lockfiles = Array.from({ length: parents }, (_, level) => '../'.repeat(level + 1)).flatMap((up) => LOCKFILES.map((name) => `${up}${name}`));
  return [...config.cache.inputs, ...lockfiles];
}

/** Why changing this file affects every test (a lockfile, a package.json, a config, a cache input, an env file), or null. */
function alwaysAllReason(file: string, config: IsolateConfig): string | null {
  const name = path.posix.basename(file);
  if (LOCKFILES.includes(name)) return `${file} is a lockfile`;
  if (name === 'package.json') return `${file} is a package.json`;
  if (name.startsWith('.env')) return `${file} is an env file`;
  if (file === CONFIG_FILE) return `${file} is the isolate config`;
  if (file === normalize(config.playwright.config)) return `${file} is the Playwright config`;
  const input = config.cache.inputs.map(normalize).find((entry) => isUnder(entry, file));
  return input === undefined ? null : `${file} is a build or seed input (cache.inputs: ${input})`;
}

/**
 * Returns the test support rule for this map: tracing sees only code that the app and the browser run, so a changed
 * helper, fixture, page object or global setup file would otherwise select nothing. A file counts when no traced test
 * is defined in it, the map has no record of the app or browser running it, it is not build or Playwright output, and
 * it lies in a directory holding a traced spec file, or in the Playwright config's directory outside every top-level
 * directory there that holds app code.
 */
function testSupportRule(map: ImpactMap, config: IsolateConfig): (file: string) => string | null {
  const tests = Object.values(map.tests);
  const specs = new Set(tests.map((test) => test.file));
  const specDirs = new Set([...specs].map((file) => path.posix.dirname(file)));
  const appFiles = new Set([...map.global, ...map.bootLoaded, ...tests.flatMap((test) => [...test.server, ...test.client])]);
  const configDir = path.posix.dirname(normalize(config.playwright.config));
  const outputs = [...(config.build?.outputs ?? []).map(normalize), ...PLAYWRIGHT_OUTPUTS.map((dir) => path.posix.join(configDir, dir))];
  const below = (file: string) => (configDir === '.' ? file : file.slice(configDir.length + 1));
  const appRoots = new Set(
    [...appFiles].filter((file) => isUnder(configDir, file) && below(file).includes('/')).map((file) => below(file).split('/')[0]),
  );
  return (file) => {
    if (specs.has(file) || appFiles.has(file) || outputs.some((dir) => isUnder(dir, file))) return null;
    const specDir = [...specDirs].find((dir) => isUnder(dir, file));
    if (specDir !== undefined) return `${file} is a test support file (in ${specDir}/, next to spec files)`;
    if (isUnder(configDir, file) && !appRoots.has(below(file).split('/')[0])) {
      return `${file} is a test support file (in the Playwright config's directory, outside the app's source directories)`;
    }
    return null;
  };
}

/**
 * Selects the tests to run for a set of changed files, applying in order: a change to a global file (or, with
 * `strict`, a boot-loaded file) runs everything; so does a change to an always-all input or a test support file; a
 * changed spec file selects its tests; any other changed file selects the tests whose server or client set contains it.
 */
export function selectTests(map: ImpactMap, changed: string[], config: IsolateConfig, strict: boolean): Selection {
  const everything = (reason: string): Selection => ({ all: true, reason, tests: Object.keys(map.tests).sort(), changed });
  const global = new Set(map.global);
  const bootLoaded = new Set(map.bootLoaded);
  for (const file of changed) {
    if (global.has(file)) return everything(`${file} runs at app boot (global)`);
    if (strict && bootLoaded.has(file)) return everything(`${file} is loaded at app boot (--strict)`);
  }
  const testSupport = testSupportRule(map, config);
  for (const file of changed) {
    const reason = alwaysAllReason(file, config) ?? testSupport(file);
    if (reason !== null) return everything(reason);
  }
  const touched = new Set(changed);
  const tests = Object.entries(map.tests)
    .filter(([, test]) => touched.has(test.file) || test.server.some((file) => touched.has(file)) || test.client.some((file) => touched.has(file)))
    .map(([id]) => id)
    .sort();
  return { all: false, reason: null, tests, changed };
}
