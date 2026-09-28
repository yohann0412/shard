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

const LOCKFILES = new Set(['pnpm-lock.yaml', 'package-lock.json', 'npm-shrinkwrap.json', 'yarn.lock', 'bun.lock', 'bun.lockb']);

/** Repo-relative form of a configured path: forward slashes, no `./`, no trailing slash. */
function normalize(configured: string): string {
  return path.posix.normalize(configured.split(path.sep).join('/')).replace(/\/$/, '');
}

/** Why changing this file affects every test (a lockfile, a package.json, a config, a cache input, an env file), or null. */
function alwaysAllReason(file: string, config: IsolateConfig): string | null {
  const name = path.posix.basename(file);
  if (LOCKFILES.has(name)) return `${file} is a lockfile`;
  if (name === 'package.json') return `${file} is a package.json`;
  if (name.startsWith('.env')) return `${file} is an env file`;
  if (file === CONFIG_FILE) return `${file} is the isolate config`;
  if (file === normalize(config.playwright.config)) return `${file} is the Playwright config`;
  const input = config.cache.inputs.map(normalize).find((entry) => file === entry || file.startsWith(`${entry}/`));
  return input === undefined ? null : `${file} is a build or seed input (cache.inputs: ${input})`;
}

/**
 * Selects the tests to run for a set of changed files, applying in order: a change to a global file (or, with
 * `strict`, a boot-loaded file) runs everything; so does a change to an always-all input; a changed test file selects
 * its tests; any other changed file selects the tests whose server or client set contains it.
 */
export function selectTests(map: ImpactMap, changed: string[], config: IsolateConfig, strict: boolean): Selection {
  const everything = (reason: string): Selection => ({ all: true, reason, tests: Object.keys(map.tests).sort(), changed });
  const global = new Set(map.global);
  const bootLoaded = new Set(map.bootLoaded);
  for (const file of changed) {
    if (global.has(file)) return everything(`${file} runs at app boot (global)`);
    if (strict && bootLoaded.has(file)) return everything(`${file} is loaded at app boot (--strict)`);
  }
  for (const file of changed) {
    const reason = alwaysAllReason(file, config);
    if (reason !== null) return everything(reason);
  }
  const touched = new Set(changed);
  const tests = Object.entries(map.tests)
    .filter(([, test]) => touched.has(test.file) || test.server.some((file) => touched.has(file)) || test.client.some((file) => touched.has(file)))
    .map(([id]) => id)
    .sort();
  return { all: false, reason: null, tests, changed };
}
