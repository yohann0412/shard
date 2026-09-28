import path from 'node:path';
import { git } from './checkout.js';
import { testsByFile, type ImpactMap } from './impact-map.js';
import { shuffled, type Random } from './prng.js';

/** Where a file stands in the map: in some test's set, loaded at boot only, global, or absent. */
export type Stratum = 'inTests' | 'bootLoadedOnly' | 'global' | 'absent';

/** A candidate mutation target. */
export interface Target {
  file: string;
  stratum: Stratum;
  /** `client` if some test executed it in the browser (or it lives under public/), `both` if also on the server. */
  side: 'server' | 'client' | 'both';
}

/** How many targets of each kind a full sample draws (PLAN §5, B.2). */
const SAMPLE_SIZES = { inMap: 20, controls: 5, global: 3 };

const SOURCE_EXTENSION = /\.(ts|tsx|js|jsx|mjs|cjs)$/;
const TEST_FILE = /\.(spec|test)\.[cm]?[jt]sx?$/;
const TEST_DIRS = new Set(['tests', 'test', '__tests__', 'e2e', 'playwright']);
const CONFIG_FILE = /(^|[./-])config\.[cm]?[jt]s$/;
const GENERATED = /\.d\.ts$|\.min\.js$/;
const GENERATED_DIRS = new Set(['dist', 'build', '.next', 'generated', '__generated__', 'node_modules']);

/** True if a repo-relative path is application source: a JS/TS file under a source dir, not a test, config or generated file. */
function isSource(file: string, sourceDirs: string[], testFiles: Set<string>): boolean {
  const segments = file.split('/');
  if (!SOURCE_EXTENSION.test(file) || !sourceDirs.includes(segments[0]!)) return false;
  if (TEST_FILE.test(file) || testFiles.has(file) || segments.some((segment) => TEST_DIRS.has(segment))) return false;
  if (CONFIG_FILE.test(path.basename(file)) || GENERATED.test(file)) return false;
  return !segments.some((segment) => GENERATED_DIRS.has(segment));
}

/** Tracked source files of the checkout (paths relative to `appDir`, as `git ls-files` prints them there). */
export async function sourceFiles(appDir: string, sourceDirs: string[], map: ImpactMap): Promise<string[]> {
  const testFiles = new Set(Object.values(map.tests).map((test) => test.file));
  const tracked = (await git(appDir, ['ls-files'])).split('\n').filter(Boolean);
  return tracked.filter((file) => isSource(file, sourceDirs, testFiles)).sort();
}

/** Puts each file into its stratum (global first, then in a test set, then boot-loaded only, else absent). */
export function stratify(files: string[], map: ImpactMap): Target[] {
  const global = new Set(map.global);
  const bootLoaded = new Set(map.bootLoaded);
  const selecting = testsByFile(map);
  const client = new Set(Object.values(map.tests).flatMap((test) => test.client));
  const server = new Set(Object.values(map.tests).flatMap((test) => test.server));
  return files.map((file) => {
    const stratum: Stratum = global.has(file) ? 'global' : selecting.has(file) ? 'inTests' : bootLoaded.has(file) ? 'bootLoadedOnly' : 'absent';
    const inClient = client.has(file) || file.startsWith('public/');
    const side = inClient && server.has(file) ? 'both' : inClient ? 'client' : 'server';
    return { file, stratum, side };
  });
}

/** Takes the first item of every list, then the second of every list, and so on, skipping lists that ran out. */
function roundRobin<T>(lists: T[][]): T[] {
  const mixed: T[] = [];
  for (let i = 0; i < Math.max(0, ...lists.map((list) => list.length)); i++) {
    for (const list of lists) {
      if (i < list.length) mixed.push(list[i]!);
    }
  }
  return mixed;
}

/**
 * Draws the sample with a seeded PRNG: up to 20 in-map files (in a test set or boot-loaded only; server and client
 * files alternate when both exist), 5 absent-file controls and up to 3 global files. The sample is ordered round-robin
 * across those three groups, so `maxTargets` keeps every group in a truncated sample.
 */
export function drawSample(targets: Target[], random: Random, maxTargets: number | null): Target[] {
  const inMap = targets.filter((target) => target.stratum === 'inTests' || target.stratum === 'bootLoadedOnly');
  const serverSide = shuffled(inMap.filter((target) => target.side !== 'client'), random);
  const clientSide = shuffled(inMap.filter((target) => target.side === 'client'), random);
  const ordered = roundRobin([
    roundRobin([serverSide, clientSide]).slice(0, SAMPLE_SIZES.inMap),
    shuffled(targets.filter((target) => target.stratum === 'absent'), random).slice(0, SAMPLE_SIZES.controls),
    shuffled(targets.filter((target) => target.stratum === 'global'), random).slice(0, SAMPLE_SIZES.global),
  ]);
  return maxTargets === null ? ordered : ordered.slice(0, maxTargets);
}
