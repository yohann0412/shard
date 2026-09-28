import { appendFileSync, copyFileSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { isolatePaths } from '../../src/paths.js';
import { runAffected, type AffectedCall } from './affected.js';
import { git, runSteps, type Checkout } from './checkout.js';
import { countMarkers } from './liveness.js';
import type { Mutant } from './mutants.js';
import { failingIds, notRunIds, testDurations } from './outcomes.js';
import { shuffled, type Random } from './prng.js';
import type { RunnableRecipe } from './recipe.js';
import { round } from './stats.js';
import { runSuite, type Invocation, type SuiteRun } from './suite-run.js';
import type { Target } from './targets.js';

/** What every run of the mutation loop shares. */
export interface LoopContext {
  recipe: RunnableRecipe;
  checkout: Checkout;
  invocation: Invocation;
  /** data/results/<name>/mutants: every run's report, results and log. */
  outDir: string;
  /** The best N from Experiment A. */
  workers: number;
  /** The map `affected` must read (copied to .isolate/map.json before each call, since a trace writes it last). */
  mapFile: string;
}

/** The unmutated reference: tests failing in either run are left out of every F; durations weight the selection ratio. */
export interface Reference {
  runs: SuiteRun[];
  excluded: string[];
  allTests: string[];
  /** Mean duration per test over both runs, in ms. */
  durations: Record<string, number>;
}

/** Everything observed for one mutant. */
export interface MutantRecord {
  id: string;
  kind: Mutant['kind'];
  file: string;
  stratum: Target['stratum'];
  side: Target['side'];
  line: number;
  functionName: string;
  description: string;
  buildError: string | null;
  live: boolean;
  liveness: { marker: string; cleanCount: number; mutantCount: number | null };
  affected: AffectedCall[];
  run: SuiteRun | null;
  /** Tests failing in the mutant's run (before the reference exclusions), or null when it did not run. */
  failing: string[] | null;
  notRun: string[] | null;
  /** The mutant stopped an app from becoming healthy, so no test could run: every test counts as failing. */
  bootFailure: boolean;
}

/** A non-JS edit and what `affected` answered for it. */
export interface NonJsEdit {
  kind: 'css' | 'sql' | 'json';
  file: string | null;
  note: string | null;
  affected: AffectedCall[];
}

const NON_JS_KINDS = [
  { kind: 'css', pattern: /\.(css|scss|sass|less)$/, edit: '\n/* isolate-mutant */\n' },
  { kind: 'sql', pattern: /\.sql$/, edit: '\n-- isolate-mutant\n' },
  { kind: 'json', pattern: /\.json$/, edit: '\n' },
] as const;
const LOCKFILE_JSON = /(^|\/)(package-lock|npm-shrinkwrap)\.json$/;

/** The suite command every reference and mutant run uses: isolated at the best N, no retries. */
function suiteArgs(context: LoopContext): string[] {
  return ['run', '--workers', String(context.workers), '--no-rerun', '--', 'npx', 'playwright', 'test', '--retries=0', ...context.recipe.playwrightArgs];
}

/** Throws unless the checkout has no uncommitted change (the loop aborts rather than let a mutant leak). */
export async function assertClean(context: LoopContext): Promise<void> {
  const status = await git(context.checkout.root, ['status', '--porcelain']);
  if (status !== '') throw new Error(`the checkout ${context.checkout.root} is not clean; aborting so no edit leaks into the next run:\n${status}`);
}

/** Reverts one edited file with `git checkout` and checks that the whole tree is clean again. */
async function revert(context: LoopContext, file: string): Promise<void> {
  await git(context.checkout.appDir, ['checkout', '--', file]);
  await assertClean(context);
}

/** True when isolate stopped because an app never became healthy, i.e. the mutant broke app startup. */
function brokeStartup(run: SuiteRun): boolean {
  return run.error !== null && /\bw\d+ (exited before it was ready|was not ready within)/.test(run.error);
}

/** `affected` under both policies, reading the chosen map. */
async function affectedBoth(context: LoopContext): Promise<AffectedCall[]> {
  const paths = isolatePaths(context.checkout.appDir);
  mkdirSync(paths.root, { recursive: true });
  copyFileSync(context.mapFile, paths.map);
  return [await runAffected(context.invocation, 'default'), await runAffected(context.invocation, 'strict')];
}

/** Two unmutated runs at the best N: the tests failing in either, every test seen, and mean durations. */
export async function referenceRuns(context: LoopContext): Promise<Reference> {
  const loaded = [];
  for (const label of ['reference-1', 'reference-2']) loaded.push(await runSuite(label, suiteArgs(context), context.invocation, context.outDir));
  const results = loaded.flatMap((run) => (run.results === null ? [] : [run.results]));
  if (results.length < 2) throw new Error(`a reference run wrote no Playwright results; see ${loaded.map((run) => run.run.files.log).join(', ')}`);
  const durations = results.map(testDurations);
  const allTests = [...new Set(durations.flatMap((entry) => Object.keys(entry)))].sort();
  return {
    runs: loaded.map((run) => run.run),
    excluded: [...new Set(results.flatMap(failingIds))].sort(),
    allTests,
    durations: Object.fromEntries(allTests.map((id) => [id, round(durations.reduce((sum, entry) => sum + (entry[id] ?? 0), 0) / durations.length, 1)])),
  };
}

/**
 * One mutant: apply it, run the recipe's build, check liveness (its marker's count in the served output must exceed
 * `cleanCount`), ask `affected` under both policies, run the suite if it is live, then revert and check the tree is
 * clean. A build failure is recorded and the mutant is not live. A mutant that keeps an app from starting fails every
 * test in `allTests`.
 */
export async function runMutant(
  context: LoopContext,
  id: string,
  target: Target,
  mutant: Mutant,
  cleanCount: number,
  allTests: string[],
): Promise<MutantRecord> {
  const { checkout, recipe } = context;
  writeFileSync(path.join(checkout.appDir, mutant.file), mutant.source);
  try {
    let buildError: string | null = null;
    try {
      await runSteps(recipe.build, checkout.root, recipe, path.join(context.outDir, `${id}.build.log`), `build with ${id}`);
    } catch (error) {
      buildError = error instanceof Error ? error.message.split('\n')[0]! : String(error);
    }
    const mutantCount = buildError === null ? countMarkers(checkout.appDir, recipe.servedOutput, [mutant.marker])[mutant.marker]! : null;
    const live = mutantCount !== null && mutantCount > cleanCount;
    const affected = await affectedBoth(context);
    const loaded = live ? await runSuite(id, suiteArgs(context), context.invocation, context.outDir) : null;
    const bootFailure = loaded !== null && loaded.results === null && brokeStartup(loaded.run);
    return {
      id,
      kind: mutant.kind,
      file: mutant.file,
      stratum: target.stratum,
      side: target.side,
      line: mutant.line,
      functionName: mutant.functionName,
      description: mutant.description,
      buildError,
      live,
      liveness: { marker: mutant.marker, cleanCount, mutantCount },
      affected,
      run: loaded?.run ?? null,
      failing: loaded?.results ? failingIds(loaded.results) : bootFailure ? allTests : null,
      notRun: loaded?.results ? notRunIds(loaded.results) : null,
      bootFailure,
    };
  } finally {
    await revert(context, mutant.file);
  }
}

/**
 * One edit each to a tracked CSS file, migration SQL file and JSON file (not a lockfile; package.json only when there is
 * no other), drawn with the seeded PRNG, recording only what `affected` returns.
 */
export async function nonJsEdits(context: LoopContext, random: Random): Promise<NonJsEdit[]> {
  const tracked = (await git(context.checkout.appDir, ['ls-files'])).split('\n').filter(Boolean);
  const edits: NonJsEdit[] = [];
  for (const { kind, pattern, edit } of NON_JS_KINDS) {
    const candidates = tracked.filter((file) => pattern.test(file) && !LOCKFILE_JSON.test(file));
    const preferred = kind === 'json' ? candidates.filter((file) => path.basename(file) !== 'package.json') : candidates;
    const file = shuffled(preferred.length > 0 ? preferred : candidates, random)[0];
    if (file === undefined) {
      edits.push({ kind, file: null, note: `no tracked file matches ${pattern}`, affected: [] });
      continue;
    }
    appendFileSync(path.join(context.checkout.appDir, file), edit);
    try {
      edits.push({ kind, file, note: null, affected: await affectedBoth(context) });
    } finally {
      await revert(context, file);
    }
  }
  return edits;
}
