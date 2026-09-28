import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { isolatePaths } from '../../src/paths.js';
import { browsersFor } from './browsers.js';
import { prepareCheckout } from './checkout.js';
import { mapStability, readImpactMap } from './impact-map.js';
import { machineFacts } from './machine.js';
import type { MutantKind } from './mutants.js';
import { mutationStudy } from './mutation-study.js';
import { harnessRoot, resultPaths } from './paths.js';
import { provenance, say } from './provenance.js';
import { armEnv, loadRecipe, type RunnableRecipe } from './recipe.js';
import { controlMisses, headline, recallSummary, scoreMutant, selectionSummary } from './score-b.js';
import { runSuite, type Invocation, type SuiteRun } from './suite-run.js';

const USAGE = `Usage: node dist/scripts/experiments/experiment-b.js <recipe> [--workers N] [--max-targets K] [--kinds throw|all] [--seed S]

  --workers N       workers of the reference and mutant runs (default: bestWorkers in experiment-a.json)
  --max-targets K   keep only the first K targets of the sample (ordered round-robin across in-map, control, global)
  --kinds           throw: the throw mutant only; all: also toplevel and wrongvalue (default: the recipe's mutantKinds)
  --seed S          seed of the target draw (default 20260928)
`;

const DEFAULT_SEED = 20260928;

/** The two map builds compared for stability (PLAN §5, B.1); the first is the one `affected` reads. */
const TRACE_WORKERS = [4, 2] as const;

const DEFINITIONS = {
  F: 'tests failing with the mutant minus every test failing in either unmutated reference run',
  P: 'the tests `isolate affected --base HEAD --json` selects for the mutated file (all tests when it answers all)',
  recall: '|F ∩ P| / |F| when F is non-empty',
  selectionRatios: '|P| / all tests, and the sum of reference-run durations of P / of all tests',
  headline: 'fraction of live, non-global mutants with non-empty F and P not all whose misses (F \\ P) are empty, with a 95% Clopper-Pearson interval',
  live: "the mutant's marker (\"isolate-mutant\", \"return undefined\" or the changed number) occurs more often in the served build output than in the clean build",
  policies: 'default: global files select all tests (function-level, D-011); strict: boot-loaded files do too',
  stability: 'per file, Jaccard of the tests selecting it in the workers-4 and workers-2 maps, over files selected by < 50% of tests in at least one map; per test, Jaccard of its file sets',
  emptyF: 'never-executed: the mutated function (or, for a top-level edit, any function of the file) is not in map.executedFunctions; executed-no-failure otherwise',
};

/** Parses an integer flag value of at least 1. */
function positiveInteger(flag: string, value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) throw new Error(`${flag} needs a positive integer (got ${value})`);
  return parsed;
}

/** The best N recorded by Experiment A for this repo. */
function bestWorkersFromA(file: string): number {
  if (!existsSync(file)) throw new Error(`no ${path.relative(harnessRoot, file)}: run Experiment A first, or pass --workers N`);
  const best = (JSON.parse(readFileSync(file, 'utf8')) as { aggregate?: { bestWorkers?: number | null } }).aggregate?.bestWorkers;
  if (typeof best !== 'number') throw new Error(`${path.relative(harnessRoot, file)} has no bestWorkers; pass --workers N`);
  return best;
}

/** Builds the map at each N in TRACE_WORKERS and copies each map.json into the results directory. */
async function traceMaps(recipe: RunnableRecipe, invocation: Invocation, outDir: string): Promise<SuiteRun[]> {
  const runs: SuiteRun[] = [];
  const mapFile = isolatePaths(invocation.cwd).map;
  for (const workers of TRACE_WORKERS) {
    say(`isolate trace --workers ${workers}`);
    rmSync(mapFile, { force: true });
    const args = ['trace', '--workers', String(workers), '--', 'npx', 'playwright', 'test', '--retries=0', ...recipe.playwrightArgs];
    const loaded = await runSuite(`trace-w${workers}`, args, invocation, outDir);
    if (!existsSync(mapFile)) {
      const why = loaded.run.error === null ? `exit code ${loaded.run.exitCode}` : `exit code ${loaded.run.exitCode}: ${loaded.run.error}`;
      throw new Error(`isolate trace --workers ${workers} wrote no map (${why}); see ${loaded.run.files.log}`);
    }
    copyFileSync(mapFile, resultPaths(recipe.name).map(workers));
    runs.push(loaded.run);
  }
  return runs;
}

/** Runs Experiment B on one recipe and writes data/results/<name>/experiment-b.json; returns the exit code. */
async function main(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: { workers: { type: 'string' }, 'max-targets': { type: 'string' }, kinds: { type: 'string' }, seed: { type: 'string' } },
  });
  const name = positionals[0];
  if (name === undefined || positionals.length > 1 || (values.kinds !== undefined && !['throw', 'all'].includes(values.kinds))) {
    process.stderr.write(USAGE);
    return 2;
  }
  const recipe = loadRecipe(name);
  const out = resultPaths(name);
  const workers = values.workers === undefined ? bestWorkersFromA(out.experimentA) : positiveInteger('--workers', values.workers);
  const kinds: MutantKind[] = (values.kinds ?? recipe.mutantKinds) === 'all' ? ['throw', 'toplevel', 'wrongvalue'] : ['throw'];
  const options = { seed: values.seed === undefined ? DEFAULT_SEED : positiveInteger('--seed', values.seed), kinds, maxTargets: values['max-targets'] === undefined ? null : positiveInteger('--max-targets', values['max-targets']) };
  const origin = await provenance();
  rmSync(out.mutants, { recursive: true, force: true });
  mkdirSync(out.mutants, { recursive: true });
  for (const workerCount of TRACE_WORKERS) rmSync(out.map(workerCount), { force: true });

  say(`${name}: preparing a fresh checkout (untimed)`);
  const checkout = await prepareCheckout(recipe, path.join(out.mutants, 'checkout.log'));
  const browsers = browsersFor(checkout.appDir);
  const invocation: Invocation = { cwd: checkout.appDir, env: armEnv(recipe, browsers.path) };
  const traces = await traceMaps(recipe, invocation, out.mutants);
  const map = readImpactMap(out.map(TRACE_WORKERS[0]));
  const secondMap = readImpactMap(out.map(TRACE_WORKERS[1]));

  const context = { recipe, checkout, invocation, outDir: out.mutants, workers, mapFile: out.map(TRACE_WORKERS[0]) };
  const study = await mutationStudy(context, map, options);
  const scored = study.mutants.map((record) => ({ record, score: scoreMutant(record, study.reference, map) }));
  const stability = mapStability(map, secondMap);
  const result = {
    version: 1,
    experiment: 'B',
    name,
    ...origin,
    protocol: { ...options, workers, workersFrom: values.workers === undefined ? 'experiment-a.json bestWorkers' : '--workers', traceWorkers: TRACE_WORKERS },
    definitions: DEFINITIONS,
    recipe,
    checkout: { root: path.relative(harnessRoot, checkout.root), appDir: path.relative(harnessRoot, checkout.appDir), commit: checkout.commit },
    browsers,
    machine: machineFacts(checkout.appDir),
    maps: { files: TRACE_WORKERS.map((workerCount) => path.relative(harnessRoot, out.map(workerCount))), traces, global: map.global, bootLoaded: map.bootLoaded, stability },
    reference: study.reference,
    targets: { sourceFiles: study.sourceFiles, byStratum: study.byStratum, sample: study.sample, noMutant: study.noMutant },
    mutants: scored.map(({ record, score }) => ({ ...record, score })),
    nonJsEdits: study.nonJsEdits,
    summary: {
      headline: { default: headline(scored, 'default'), strict: headline(scored, 'strict') },
      recall: { default: recallSummary(scored, 'default'), strict: recallSummary(scored, 'strict') },
      selection: { default: selectionSummary(scored, 'default'), strict: selectionSummary(scored, 'strict') },
      controlMisses: controlMisses(scored),
      emptyF: {
        neverExecuted: scored.filter(({ score }) => score.emptyF === 'never-executed').length,
        executedNoFailure: scored.filter(({ score }) => score.emptyF === 'executed-no-failure').length,
      },
      stability,
    },
  };
  writeFileSync(out.experimentB, `${JSON.stringify(result, null, 2)}\n`);
  const top = result.summary.headline.default;
  say(`wrote ${path.relative(harnessRoot, out.experimentB)}: ${scored.length} mutants; headline ${top.zeroMisses}/${top.n}${top.ci95 ? ` (95% CI ${top.ci95.lower}-${top.ci95.upper})` : ''}`);
  return 0;
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    say(`failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  },
);
