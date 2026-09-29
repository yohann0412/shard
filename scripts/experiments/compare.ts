import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { readResults, type PwResults, type TestRecord } from '../../src/playwright/results.js';
import type { Report } from '../../src/report/schema.js';
import { browsersFor } from './browsers.js';
import { patchCheckout, prepareCheckout } from './checkout.js';
import { breakdown, FAILURE_KINDS, failureKind, newFailures, passedEverywhere, type FailureBreakdown, type FailureKind } from './compare-analysis.js';
import { machineFacts } from './machine.js';
import { harnessRoot, workDir } from './paths.js';
import { waitForFreePorts } from './ports.js';
import { say } from './provenance.js';
import { armEnv, loadRecipe, recipeEnv } from './recipe.js';
import { startServices } from './services.js';
import { median } from './stats.js';
import { runSuite, type Invocation, type LoadedRun } from './suite-run.js';
import { ensureToolchain } from './toolchain.js';

const USAGE = `Usage: node dist/scripts/experiments/compare.js <recipe> [--rounds R] [--workers 2,4] [--no-shared] [--no-rate-limit] [--fresh] [-- <extra playwright args>]
       node dist/scripts/experiments/compare.js --report work/compare/<recipe>/<timestamp>

Runs a repo's Playwright suite three ways, R rounds in rotating order, and prints the medians:

  theirs      the repo's own config as its CI runs it: its worker count, one app, one database
  shared@N    the same with --workers=N: N workers on the one app and database, which is what the repo could do
              without isolate. Tests that pass in theirs and fail here ("new fails") collide on shared state
  isolate@N   isolate run: N workers, each with its own app and its own copy of the database

  --rounds R      timed rounds per arm (default: the recipe's rounds, else 3)
  --workers LIST  worker counts for shared@N and isolate@N. Default: 2, 4 and 8 when their setup runs one worker; when
                  it already runs W workers, W (same parallelism, so only the isolation differs) and 2W; never more than
                  the cores
  --no-shared     skip the shared@N arms
  --no-rate-limit turn the app's own rate limiter off in every arm (recipes with a noRateLimit entry: evershop), so
                  that 429s do not hide which failures come from shared state. The run stops after the first warm-up
                  if a test still fails with 429
  --fresh         clone, install and build again even if work/repos/<recipe> was prepared before
  --report DIR    print the report of an earlier run again, from its saved results
  -- ARGS         extra arguments for every playwright test command, e.g. a directory to run a subset (give flags in
                  --flag=value form)
`;

/** One way of running the suite. */
interface Arm {
  name: string;
  args: string[];
}

/** One timed run of one arm. */
interface Sample {
  arm: string;
  round: number;
  /** Name of the run's files in the output directory: <label>.log, <label>.json, <label>.pw-results.json. */
  label: string;
  exitCode: number;
  exceededCap: boolean;
  wallMs: number | null;
  testPhaseMs: number | null;
  workers: number | null;
  passed: number | null;
  failed: number | null;
  flaky: number | null;
  error: string | null;
  log: string;
  /** The failures by kind and the time they took; null without reporter results. */
  failures: FailureBreakdown | null;
}

/**
 * The tests each run failed although they passed in every run of theirs, by sample label; null for a run without
 * reporter results, and for every run when theirs wrote none (nothing to compare with).
 */
type NewFailures = Map<string, TestRecord[] | null>;

/**
 * Worker counts to try when none are given. A setup held to one worker (the case isolate is for) gets 2, 4 and 8. A
 * setup that already runs W workers gets W, where only the isolation differs, and 2W. Never above the cores.
 */
function defaultWorkers(cores: number, theirWorkers: number | null): number[] {
  const wanted = theirWorkers === null || theirWorkers <= 1 ? [2, 4, 8] : [theirWorkers, theirWorkers * 2];
  return [...new Set(wanted.map((workers) => Math.min(workers, cores)))].sort((a, b) => a - b);
}

/** Parses `--workers 2,4`. */
function parseWorkerList(value: string): number[] {
  const list = value.split(',').map((part) => Number(part.trim()));
  if (list.length === 0 || list.some((workers) => !Number.isInteger(workers) || workers < 1)) throw new Error(`--workers needs a comma-separated list of positive integers (got ${value})`);
  return [...new Set(list)].sort((a, b) => a - b);
}

/** Formats milliseconds as "1m 23.4s" or "12.3s". */
function duration(ms: number | null): string {
  if (ms === null) return 'n/a';
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  return `${Math.floor(seconds / 60)}m ${(seconds % 60).toFixed(1).padStart(4, '0')}s`;
}

/** The numbers of one run, from isolate's report (null when isolate wrote none). */
function sample(arm: Arm, round: number, label: string, loaded: LoadedRun): Sample {
  const report: Report | null = loaded.report;
  return {
    arm: arm.name,
    round,
    label,
    exitCode: loaded.run.exitCode,
    exceededCap: loaded.run.exceededCap,
    wallMs: report?.wallMs ?? null,
    testPhaseMs: report?.playwright?.testPhaseMs ?? null,
    workers: report?.playwright?.resolvedWorkers ?? null,
    passed: report?.tests.passed ?? null,
    failed: report?.tests.failed ?? null,
    flaky: report?.tests.flaky ?? null,
    error: loaded.run.error,
    log: loaded.run.files.log,
    failures: loaded.results === null ? null : breakdown(loaded.results),
  };
}

/** The reporter results of one sample's run, or null if Playwright wrote none. */
function resultsOf(outDir: string, entry: Sample): PwResults | null {
  return readResults(path.join(outDir, `${entry.label}.pw-results.json`));
}

/** For each run but theirs, the tests it failed that passed in every run of theirs. */
function findNewFailures(outDir: string, samples: Sample[]): NewFailures {
  const theirs = samples.filter((entry) => entry.arm === 'theirs').map((entry) => resultsOf(outDir, entry));
  const known = theirs.filter((results): results is PwResults => results !== null);
  const passed = known.length === 0 ? null : passedEverywhere(known);
  const found: NewFailures = new Map();
  for (const entry of samples) {
    if (entry.arm === 'theirs') continue;
    const results = resultsOf(outDir, entry);
    found.set(entry.label, passed === null || results === null ? null : newFailures(results, passed));
  }
  return found;
}

/** min–max of a list of counts, or "n/a". */
function range(values: (number | null)[]): string {
  const known = values.filter((value): value is number => value !== null);
  if (known.length === 0) return 'n/a';
  const low = Math.min(...known);
  const high = Math.max(...known);
  return low === high ? String(low) : `${low}-${high}`;
}

/** Everything but Playwright's test phase: database, apps, Playwright start-up and exit, teardown. */
function overheadMs(entry: Sample): number | null {
  return entry.wallMs === null || entry.testPhaseMs === null ? null : entry.wallMs - entry.testPhaseMs;
}

/** The median of the known values of `pick` over `list`, or null. */
function medianBy<T>(list: T[], pick: (entry: T) => number | null): number | null {
  const values = list.map(pick).filter((value): value is number => value !== null);
  return values.length === 0 ? null : median(values);
}

/** The number of new failures of one run, or null when it could not be told. */
function newFailureCount(found: NewFailures, entry: Sample): number | null {
  return found.get(entry.label)?.length ?? null;
}

/** The median new failures of one arm's runs, or null. */
function medianNewFailures(found: NewFailures, samples: Sample[], arm: string): number | null {
  return medianBy(
    samples.filter((entry) => entry.arm === arm),
    (entry) => newFailureCount(found, entry),
  );
}

/** "3 rate limit (429), 1 other" for a count per kind (medians may be fractional). */
function byKind(counts: Record<FailureKind, number>): string {
  return FAILURE_KINDS.filter((kind) => counts[kind] > 0)
    .map((kind) => `${counts[kind]} ${kind}`)
    .join(', ');
}

/** "12.3s of 45.6s (27%)". */
function share(part: number, whole: number): string {
  return `${duration(part)} of ${duration(whole)} (${whole > 0 ? Math.round((100 * part) / whole) : 0}%)`;
}

/** The summary table: medians per arm, the new failures, and the speedup of each arm over theirs. */
function summarize(arms: Arm[], samples: Sample[], found: NewFailures): string {
  const rows = [['arm', 'workers', 'runs', 'median wall', 'median tests', 'overhead', 'passed', 'failed', 'new fails', 'wall speedup', 'tests speedup']];
  const theirs = samples.filter((entry) => entry.arm === 'theirs');
  const theirWall = medianBy(theirs, (entry) => entry.wallMs);
  const theirTests = medianBy(theirs, (entry) => entry.testPhaseMs);
  for (const arm of arms) {
    const runs = samples.filter((entry) => entry.arm === arm.name);
    const wall = medianBy(runs, (entry) => entry.wallMs);
    const tests = medianBy(runs, (entry) => entry.testPhaseMs);
    const speedup = (base: number | null, value: number | null) => (base === null || value === null ? 'n/a' : `${(base / value).toFixed(2)}x`);
    const isTheirs = arm.name === 'theirs';
    rows.push([
      arm.name,
      range(runs.map((entry) => entry.workers)),
      String(runs.length),
      duration(wall),
      duration(tests),
      duration(medianBy(runs, overheadMs)),
      range(runs.map((entry) => entry.passed)),
      range(runs.map((entry) => entry.failed)),
      isTheirs ? '-' : range(runs.map((entry) => newFailureCount(found, entry))),
      isTheirs ? '1.00x' : speedup(theirWall, wall),
      isTheirs ? '1.00x' : speedup(theirTests, tests),
    ]);
  }
  const widths = rows[0]!.map((_, column) => Math.max(...rows.map((row) => row[column]!.length)));
  return rows.map((row) => row.map((cell, column) => (column === 0 ? cell.padEnd(widths[column]!) : cell.padStart(widths[column]!))).join('  ')).join('\n');
}

/**
 * One line per arm about its failures (medians over the arm's runs): how many, of which kind, how many of them are new
 * (passed in theirs), and how much of the test time they took. Failed tests that wait for a timeout make a run slower,
 * and a serial group that stops at a failure makes it faster, so arms that fail different tests do different work.
 */
function failureLines(arms: Arm[], samples: Sample[], found: NewFailures): string[] {
  return arms.flatMap((arm) => {
    const runs = samples.filter((entry) => entry.arm === arm.name && entry.failures !== null);
    if (runs.length === 0) return [`${arm.name}: no reporter results`];
    const med = (pick: (failures: FailureBreakdown) => number) => median(runs.map((entry) => pick(entry.failures!)));
    const failed = med((failures) => failures.failed);
    const didNotRun = med((failures) => failures.didNotRun);
    if (failed === 0 && didNotRun === 0) return [`${arm.name}: no failures`];
    const kinds = Object.fromEntries(FAILURE_KINDS.map((kind) => [kind, med((failures) => failures.byKind[kind])])) as Record<FailureKind, number>;
    let fresh = '';
    if (arm.name !== 'theirs') {
      const counts = runs.map((entry) => found.get(entry.label) ?? null).filter((list): list is TestRecord[] => list !== null);
      if (counts.length > 0) {
        const freshKinds = Object.fromEntries(FAILURE_KINDS.map((kind) => [kind, median(counts.map((list) => list.filter((test) => failureKind(test) === kind).length))])) as Record<FailureKind, number>;
        const total = median(counts.map((list) => list.length));
        fresh = total === 0 ? '; none of them new' : `; ${total} new (passed in theirs: ${byKind(freshKinds)})`;
      }
    }
    return [
      `${arm.name}: ${failed} failed${failed > 0 ? ` (${byKind(kinds)})` : ''}${fresh}, ${didNotRun} did not run after a failure; failed tests took ${share(med((failures) => failures.failedMs), med((failures) => failures.ranMs))} of the summed test time`,
    ];
  });
}

/**
 * What the reader needs to know to read the table: what the shared@N arms say about isolate, whether isolate broke
 * tests, whether their setup was already parallel, and whether the suite is short enough for fixed costs to dominate.
 */
function notes(arms: Arm[], samples: Sample[], found: NewFailures, cores: number, rateLimit: RateLimit): string[] {
  const theirs = samples.filter((entry) => entry.arm === 'theirs');
  const theirWorkers = medianBy(theirs, (entry) => entry.workers);
  const theirTests = medianBy(theirs, (entry) => entry.testPhaseMs);
  const theirOverhead = medianBy(theirs, overheadMs);
  const testsOf = (arm: string) =>
    medianBy(
      samples.filter((entry) => entry.arm === arm),
      (entry) => entry.testPhaseMs,
    );
  const noted: string[] = [];

  const limitedArms = arms.filter((arm) => samples.some((entry) => entry.arm === arm.name && (entry.failures?.byKind['rate limit (429)'] ?? 0) > 0)).map((arm) => arm.name);
  if (limitedArms.length > 0 && rateLimit.off) {
    noted.push(`Tests still failed with 429 in ${limitedArms.join(', ')} although --no-rate-limit was on: something else limits requests. Read those failures in new-failures.txt and the logs.`);
  } else if (limitedArms.length > 0) {
    noted.push(
      `${limitedArms.join(', ')} failed tests with 429 (Too Many Requests): the app's own rate limiter, which counts requests per app process. It fails more tests the more workers share one app, and fewer the more apps there are, so it blurs both what shared state breaks and how fast each arm is. ${
        rateLimit.rerun === null ? 'This recipe has no noRateLimit entry to turn it off.' : `To take it out of every arm, run \`${rateLimit.rerun}\`.`
      }`,
    );
  }

  for (const arm of arms.filter((candidate) => candidate.name.startsWith('shared@'))) {
    const workers = arm.name.slice('shared@'.length);
    const isolated = `isolate@${workers}`;
    const shared = medianNewFailures(found, samples, arm.name);
    const isolateNew = medianNewFailures(found, samples, isolated);
    const sharedTests = testsOf(arm.name);
    const isolateTests = testsOf(isolated);
    if (shared === null) continue;
    if (shared === 0) {
      noted.push(
        `${arm.name} broke no test that passes in theirs: this suite already runs ${workers} workers on one app and one database, so it can get that parallelism without isolate. isolate@${workers} is only worth it where it is faster than ${arm.name} (test phase ${duration(isolateTests)} against ${duration(sharedTests)}).`,
      );
    } else {
      const isolateSays =
        isolateNew === null
          ? `isolate@${workers} did not run or wrote no results.`
          : isolateNew === 0
            ? `isolate@${workers} ran the same parallelism with no new failures: that is the parallelism the repo cannot have without isolation.`
            : `isolate@${workers} also failed a median ${isolateNew} test(s) that pass in theirs: either state isolate does not copy (the app's memory, files, outside services) or flaky tests.`;
      noted.push(
        `${arm.name} failed a median ${shared} test(s) that pass in theirs (listed in new-failures.txt): ${workers} workers on one app and one database break this suite. ${isolateSays} A shared run that fails tests is not a fair speed comparison: failures that wait for a timeout slow it down, and serial groups that stop at a failure speed it up.`,
      );
    }
  }

  for (const arm of arms.filter((candidate) => candidate.name.startsWith('isolate@'))) {
    const isolateNew = medianNewFailures(found, samples, arm.name);
    const shared = medianNewFailures(found, samples, `shared@${arm.name.slice('isolate@'.length)}`);
    if (isolateNew !== null && isolateNew > 0 && shared === null) {
      noted.push(`${arm.name} failed a median ${isolateNew} test(s) that pass in theirs (listed in new-failures.txt): either state isolate does not copy (the app's memory, files, outside services) or flaky tests. Read them before trusting its speed.`);
    }
  }

  if (theirWorkers !== null && theirWorkers > 1) {
    const same = arms.some((arm) => arm.name === `isolate@${theirWorkers}`);
    noted.push(
      `Their setup already runs ${theirWorkers} workers against one app and one database, so shared state is not what holds it back, and isolate has little to win: it speeds a suite up by letting it run more workers than shared state allows. ${
        same ? `isolate@${theirWorkers} runs the same parallelism, so it shows what the isolation alone costs or saves.` : `This machine has ${cores} cores, so no isolate arm matches their ${theirWorkers} workers.`
      }`,
    );
  }

  const largest = arms.filter((arm) => arm.name.startsWith('isolate@')).at(-1)?.name;
  const largestOverhead = largest === undefined ? null : medianBy(samples.filter((entry) => entry.arm === largest), overheadMs);
  if (theirTests !== null && theirTests < 60_000 && largestOverhead !== null && theirOverhead !== null) {
    noted.push(
      `Their test phase is only ${duration(theirTests)}. Outside the test phase, ${largest} spends ${duration(largestOverhead)} (starting Postgres, copying the database, booting one app per worker, Playwright start-up, teardown) against ${duration(theirOverhead)} for theirs; on a run this short that difference decides the wall time, so the test-phase column is the fairer one, and a longer suite the better test.`,
    );
  }
  return noted;
}

/** new-failures.txt: per arm, each test that failed in some run although it passed in every run of theirs. */
function newFailuresText(arms: Arm[], samples: Sample[], found: NewFailures): string {
  const sections = arms
    .filter((arm) => arm.name !== 'theirs')
    .map((arm) => {
      const runs = samples.filter((entry) => entry.arm === arm.name);
      const lists = runs.map((entry) => found.get(entry.label) ?? null).filter((list): list is TestRecord[] => list !== null);
      if (lists.length === 0) return `${arm.name}: no results to compare`;
      const byTest = new Map<string, { test: TestRecord; runs: number }>();
      for (const test of lists.flat()) {
        const seen = byTest.get(test.id);
        byTest.set(test.id, { test: seen?.test ?? test, runs: (seen?.runs ?? 0) + 1 });
      }
      if (byTest.size === 0) return `${arm.name}: none in ${lists.length} run(s)`;
      const lines = [...byTest.values()]
        .sort((a, b) => b.runs - a.runs || a.test.file.localeCompare(b.test.file) || a.test.line - b.test.line)
        .map(({ test, runs: count }) => {
          const error = (test.error ?? '').split('\n')[0]!.trim().slice(0, 200);
          return `  ${test.file}:${test.line} ${test.title} (failed in ${count}/${lists.length} runs; ${failureKind(test)})${error === '' ? '' : `\n      ${error}`}`;
        });
      return `${arm.name}: ${byTest.size} test(s)\n${lines.join('\n')}`;
    });
  return `Tests that failed although they passed in every run of theirs, per arm:\n\n${sections.join('\n\n')}\n`;
}

/** Whether the rate limiter was off, and the command that would turn it off (null if the recipe cannot). */
interface RateLimit {
  off: boolean;
  rerun: string | null;
}

/** The printable report: the header, the table, the failure lines and the notes. */
function render(header: string, arms: Arm[], samples: Sample[], found: NewFailures, cores: number, rateLimit: RateLimit): string {
  const parts = [header, summarize(arms, samples, found), `Failures (medians per run; new = passed in every run of theirs):\n${failureLines(arms, samples, found).map((line) => `- ${line}`).join('\n')}`];
  const noted = notes(arms, samples, found, cores, rateLimit);
  if (noted.length > 0) parts.push(`Notes:\n${noted.map((line) => `- ${line}`).join('\n')}`);
  return parts.join('\n\n');
}

/** The first lines of the report: what ran where, and what the arms and columns mean. */
function headerLines(recipe: string, commit: string, rounds: number | null, machine: { cpuModel: string; cores: number; ramGb: number; os: string }, baselineApp: boolean, rateLimitOff: string | null): string {
  return [
    `${recipe} @ ${commit.slice(0, 12)}: ${rounds === null ? '' : `${rounds} round(s); `}${machine.cpuModel}, ${machine.cores} cores, ${machine.ramGb} GB, ${machine.os}`,
    `theirs = the repo's own Playwright config (its worker count, one app, one database${baselineApp ? ', app started by isolate --baseline --app' : ''}); shared@N = the same with --workers=N; isolate@N = one app and database per worker`,
    `wall = the whole isolate command; tests = Playwright's test phase (first test start to last test end); overhead = wall minus tests; new fails = tests that passed in every run of theirs and failed in this arm`,
    ...(rateLimitOff === null ? [] : [`--no-rate-limit: ${rateLimitOff}`]),
  ].join('\n');
}

/** The command that reruns a recipe with its rate limiter off, or null if its recipe has no way to. */
function rerunWithoutLimit(name: string): string | null {
  try {
    return loadRecipe(name).noRateLimit === undefined ? null : `just compare ${name} --no-rate-limit`;
  } catch {
    return null;
  }
}

/** `--report <dir>`: prints the report of an earlier run from its samples.json and reporter results. */
function report(outDir: string): number {
  const saved = JSON.parse(readFileSync(path.join(outDir, 'samples.json'), 'utf8')) as {
    recipe: string;
    commit: string;
    rounds?: number;
    baselineApp?: boolean;
    rateLimitOff?: string | null;
    machine: { cpuModel: string; cores: number; ramGb: number; os: string };
    arms: Arm[];
    samples: (Omit<Sample, 'label' | 'failures'> & Partial<Pick<Sample, 'label' | 'failures'>>)[];
  };
  const samples: Sample[] = saved.samples.map((entry) => {
    const label = entry.label ?? path.basename(entry.log, '.log');
    const results = readResults(path.join(outDir, `${label}.pw-results.json`));
    return { ...entry, label, failures: results === null ? null : breakdown(results) };
  });
  const found = findNewFailures(outDir, samples);
  const header = `${headerLines(saved.recipe, saved.commit, saved.rounds ?? null, saved.machine, saved.baselineApp ?? false, saved.rateLimitOff ?? null)}\n(report of ${outDir})`;
  writeFileSync(path.join(outDir, 'new-failures.txt'), newFailuresText(saved.arms, samples, found));
  const rateLimit: RateLimit = { off: Boolean(saved.rateLimitOff), rerun: rerunWithoutLimit(saved.recipe) };
  process.stdout.write(`${render(header, saved.arms, samples, found, saved.machine.cores, rateLimit)}\n\nnew failures by test: ${path.join(outDir, 'new-failures.txt')}\n`);
  return 0;
}

/** Runs the comparison for one recipe; returns the exit code. */
async function main(argv: string[]): Promise<number> {
  const dashDash = argv.indexOf('--');
  const extra = dashDash === -1 ? [] : argv.slice(dashDash + 1);
  const { values, positionals } = parseArgs({
    args: dashDash === -1 ? argv : argv.slice(0, dashDash),
    allowPositionals: true,
    options: {
      rounds: { type: 'string' },
      workers: { type: 'string' },
      'no-shared': { type: 'boolean', default: false },
      'no-rate-limit': { type: 'boolean', default: false },
      fresh: { type: 'boolean', default: false },
      report: { type: 'string' },
    },
  });
  if (values.report !== undefined) return report(path.resolve(values.report));
  const name = positionals[0];
  if (name === undefined || positionals.length > 1) {
    process.stderr.write(USAGE);
    return 2;
  }
  const recipe = loadRecipe(name);
  const rounds = values.rounds === undefined ? (recipe.rounds ?? 3) : Number(values.rounds);
  if (!Number.isInteger(rounds) || rounds < 1) throw new Error(`--rounds needs a positive integer (got ${values.rounds})`);
  const cores = os.availableParallelism();
  const requested = values.workers === undefined ? null : parseWorkerList(values.workers);
  const noRateLimit = values['no-rate-limit'] ? recipe.noRateLimit : undefined;
  if (values['no-rate-limit'] && noRateLimit === undefined) throw new Error(`--no-rate-limit: the ${name} recipe has no noRateLimit entry saying how to turn its app's rate limiter off`);

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const outDir = path.join(workDir, 'compare', name, noRateLimit === undefined ? stamp : `${stamp}-no-rate-limit`);
  mkdirSync(outDir, { recursive: true });

  await ensureToolchain(recipe);
  say(`${name}: preparing work/repos/${name}${values.fresh ? ' from scratch' : ' (reused if already prepared)'}; log: ${path.relative(harnessRoot, path.join(outDir, 'checkout.log'))}`);
  const checkout = await prepareCheckout(recipe, path.join(outDir, 'checkout.log'), { reuse: !values.fresh });
  const browsers = await browsersFor(checkout.appDir, recipeEnv(recipe));
  const machine = machineFacts(checkout.appDir);
  const invocation: Invocation = { cwd: checkout.appDir, env: armEnv(recipe, browsers.path), capMs: (recipe.runCapMin ?? 45) * 60_000 };
  if (noRateLimit !== undefined) {
    // The patch only makes the limiter switchable; the variable switches it off, for every arm alike.
    patchCheckout(checkout.root, noRateLimit.patch);
    invocation.env = { ...invocation.env, ...noRateLimit.env };
    say(`rate limiter off in every arm: ${noRateLimit.note}`);
  }

  const playwright = [...recipe.playwrightCommand, '--retries=0', ...recipe.playwrightArgs, ...extra];
  const baseline = ['run', '--baseline', ...(recipe.baselineApp ? ['--app'] : []), '--', ...playwright];
  const theirArm: Arm = { name: 'theirs', args: baseline };
  const sharedArm = (workers: number): Arm => ({ name: `shared@${workers}`, args: [...baseline, `--workers=${workers}`] });
  const isolateArm = (workers: number): Arm => ({ name: `isolate@${workers}`, args: ['run', '--workers', String(workers), '--no-rerun', '--', ...playwright] });

  const services = await startServices(recipe);
  const samples: Sample[] = [];
  let arms: Arm[] = [theirArm];
  try {
    const run = async (arm: Arm, round: number) => {
      // theirs and shared@N start the repo's own app, often on a fixed port the previous run may still hold.
      if (!arm.name.startsWith('isolate@') && recipe.baselinePorts.length > 0) await waitForFreePorts(recipe.baselinePorts, 15 * 60_000);
      const label = round === 0 ? `${arm.name}-warmup` : `${arm.name}-r${round}`;
      const loaded = await runSuite(label, arm.args, invocation, outDir);
      const entry = sample(arm, round, label, loaded);
      const outcome = entry.passed === null ? `no report (${entry.error ?? `exit ${entry.exitCode}`})` : `${entry.passed} passed, ${entry.failed} failed`;
      say(`${label}: wall ${duration(entry.wallMs)}, tests ${duration(entry.testPhaseMs)}, ${entry.workers ?? '?'} worker(s), ${outcome}${entry.exceededCap ? ', STOPPED at the time cap' : ''}`);
      return entry;
    };
    say('warm-up (not counted): their setup first, to learn its worker count; it also fills the snapshot cache');
    const warmup = await run(theirArm, 0);
    const limited = warmup.failures?.byKind['rate limit (429)'] ?? 0;
    if (noRateLimit !== undefined && limited > 0) {
      throw new Error(`--no-rate-limit is on, but ${limited} test(s) of the warm-up still failed with 429, so the limiter is not off; stopping before the timed runs. Log: ${warmup.log}`);
    }
    const theirWorkers = warmup.workers;
    const workerCounts = requested ?? defaultWorkers(cores, theirWorkers);
    // shared@W with W their own worker count is theirs again.
    const sharedCounts = values['no-shared'] ? [] : workerCounts.filter((workers) => workers !== theirWorkers);
    arms = [theirArm, ...sharedCounts.map(sharedArm), ...workerCounts.map(isolateArm)];
    say(`their setup runs ${theirWorkers ?? 'an unknown number of'} worker(s); arms: ${arms.map((arm) => arm.name).join(', ')}`);
    say('warm-up (not counted): the largest isolate arm, so its build cache and the disk cache are warm too');
    await run(arms.at(-1)!, 0);
    for (let round = 1; round <= rounds; round++) {
      const shift = (round - 1) % arms.length;
      for (const arm of [...arms.slice(shift), ...arms.slice(0, shift)]) samples.push(await run(arm, round));
    }
  } finally {
    for (const service of services) await service.stop();
  }

  const found = findNewFailures(outDir, samples);
  const text = render(headerLines(name, checkout.commit, rounds, machine, recipe.baselineApp, noRateLimit?.note ?? null), arms, samples, found, cores, {
    off: noRateLimit !== undefined,
    rerun: rerunWithoutLimit(name),
  });
  writeFileSync(path.join(outDir, 'summary.txt'), `${text}\n`);
  writeFileSync(path.join(outDir, 'new-failures.txt'), newFailuresText(arms, samples, found));
  writeFileSync(path.join(outDir, 'samples.json'), `${JSON.stringify({ recipe: name, commit: checkout.commit, rounds, baselineApp: recipe.baselineApp, rateLimitOff: noRateLimit?.note ?? null, machine, browsers, arms, samples }, null, 2)}\n`);
  process.stdout.write(`\n${text}\n\nnew failures by test: ${path.relative(harnessRoot, path.join(outDir, 'new-failures.txt'))}\nraw logs and reports: ${path.relative(harnessRoot, outDir)}\n`);
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
