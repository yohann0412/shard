import { mkdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import type { Report } from '../../src/report/schema.js';
import { browsersFor } from './browsers.js';
import { prepareCheckout } from './checkout.js';
import { machineFacts } from './machine.js';
import { harnessRoot, workDir } from './paths.js';
import { waitForFreePorts } from './ports.js';
import { say } from './provenance.js';
import { armEnv, loadRecipe, recipeEnv } from './recipe.js';
import { startServices } from './services.js';
import { median } from './stats.js';
import { runSuite, type Invocation, type LoadedRun } from './suite-run.js';
import { ensureToolchain } from './toolchain.js';

const USAGE = `Usage: node dist/scripts/experiments/compare.js <recipe> [--rounds R] [--workers 2,4] [--fresh] [-- <extra playwright args>]

Times a repo's own Playwright setup ("theirs": its config, worker count and one shared app and database, as CI runs it)
against isolate run at each worker count, R rounds in rotating order, and prints the medians.

  --rounds R      timed rounds per arm (default: the recipe's rounds, else 3)
  --workers LIST  isolate worker counts. Default: 2, 4 and 8 when their setup runs one worker; when it already runs
                  W workers, W (same parallelism, so only the isolation differs) and 2W; never more than the cores
  --fresh         clone, install and build again even if work/repos/<recipe> was prepared before
  -- ARGS         extra arguments for every playwright test command, e.g. a directory to run a subset
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
}

/**
 * isolate worker counts to try when none are given. A setup held to one worker (the case isolate is for) gets 2, 4 and
 * 8. A setup that already runs W workers gets W, where only the isolation differs, and 2W. Never above the cores.
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
function sample(arm: Arm, round: number, loaded: LoadedRun): Sample {
  const report: Report | null = loaded.report;
  return {
    arm: arm.name,
    round,
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
  };
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
function medianBy(list: Sample[], pick: (entry: Sample) => number | null): number | null {
  const values = list.map(pick).filter((value): value is number => value !== null);
  return values.length === 0 ? null : median(values);
}

/**
 * What the reader needs to know to read the table: whether their setup was already parallel, and whether the suite is
 * short enough for isolate's fixed cost to dominate.
 */
function notes(arms: Arm[], samples: Sample[], cores: number): string[] {
  const theirs = samples.filter((entry) => entry.arm === 'theirs');
  const theirWorkers = medianBy(theirs, (entry) => entry.workers);
  const theirTests = medianBy(theirs, (entry) => entry.testPhaseMs);
  const theirOverhead = medianBy(theirs, overheadMs);
  const found: string[] = [];
  if (theirWorkers !== null && theirWorkers > 1) {
    const same = arms.some((arm) => arm.name === `isolate@${theirWorkers}`);
    found.push(
      `Their setup already runs ${theirWorkers} workers against one app and one database, so shared state is not what holds it back, and isolate has little to win: it speeds a suite up by letting it run more workers than shared state allows. ${
        same
          ? `isolate@${theirWorkers} runs the same parallelism, so it shows what the isolation alone costs or saves.`
          : `This machine has ${cores} cores, so no isolate arm matches their ${theirWorkers} workers.`
      }`,
    );
  }
  const largest = arms.length > 1 ? arms.at(-1)!.name : undefined;
  const largestOverhead = largest === undefined ? null : medianBy(samples.filter((entry) => entry.arm === largest), overheadMs);
  if (theirTests !== null && theirTests < 60_000 && largestOverhead !== null && theirOverhead !== null) {
    found.push(
      `Their test phase is only ${duration(theirTests)}. Outside the test phase, ${largest} spends ${duration(largestOverhead)} (starting Postgres, copying the database, booting one app per worker, Playwright start-up, teardown) against ${duration(theirOverhead)} for theirs; on a run this short that difference decides the wall time, so the test-phase column is the fairer one, and a longer suite the better test.`,
    );
  }
  return found;
}

/** The summary table: medians per arm and the speedup of each isolate arm over theirs. */
function summarize(arms: Arm[], samples: Sample[]): string {
  const rows = [['arm', 'workers', 'runs', 'median wall', 'median tests', 'overhead', 'passed', 'failed', 'wall speedup', 'tests speedup']];
  const theirs = samples.filter((entry) => entry.arm === 'theirs');
  const theirWall = medianBy(theirs, (entry) => entry.wallMs);
  const theirTests = medianBy(theirs, (entry) => entry.testPhaseMs);
  for (const arm of arms) {
    const runs = samples.filter((entry) => entry.arm === arm.name);
    const wall = medianBy(runs, (entry) => entry.wallMs);
    const tests = medianBy(runs, (entry) => entry.testPhaseMs);
    const speedup = (base: number | null, value: number | null) => (base === null || value === null ? 'n/a' : `${(base / value).toFixed(2)}x`);
    rows.push([
      arm.name,
      range(runs.map((entry) => entry.workers)),
      String(runs.length),
      duration(wall),
      duration(tests),
      duration(medianBy(runs, overheadMs)),
      range(runs.map((entry) => entry.passed)),
      range(runs.map((entry) => entry.failed)),
      arm.name === 'theirs' ? '1.00x' : speedup(theirWall, wall),
      arm.name === 'theirs' ? '1.00x' : speedup(theirTests, tests),
    ]);
  }
  const widths = rows[0]!.map((_, column) => Math.max(...rows.map((row) => row[column]!.length)));
  return rows.map((row) => row.map((cell, column) => (column === 0 ? cell.padEnd(widths[column]!) : cell.padStart(widths[column]!))).join('  ')).join('\n');
}

/** Runs the comparison for one recipe; returns the exit code. */
async function main(argv: string[]): Promise<number> {
  const dashDash = argv.indexOf('--');
  const extra = dashDash === -1 ? [] : argv.slice(dashDash + 1);
  const { values, positionals } = parseArgs({
    args: dashDash === -1 ? argv : argv.slice(0, dashDash),
    allowPositionals: true,
    options: { rounds: { type: 'string' }, workers: { type: 'string' }, fresh: { type: 'boolean', default: false } },
  });
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

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const outDir = path.join(workDir, 'compare', name, stamp);
  mkdirSync(outDir, { recursive: true });

  await ensureToolchain(recipe);
  say(`${name}: preparing work/repos/${name}${values.fresh ? ' from scratch' : ' (reused if already prepared)'}; log: ${path.relative(harnessRoot, path.join(outDir, 'checkout.log'))}`);
  const checkout = await prepareCheckout(recipe, path.join(outDir, 'checkout.log'), { reuse: !values.fresh });
  const browsers = await browsersFor(checkout.appDir, recipeEnv(recipe));
  const machine = machineFacts(checkout.appDir);
  const invocation: Invocation = { cwd: checkout.appDir, env: armEnv(recipe, browsers.path), capMs: (recipe.runCapMin ?? 45) * 60_000 };

  const playwright = [...recipe.playwrightCommand, '--retries=0', ...recipe.playwrightArgs, ...extra];
  const theirArm: Arm = { name: 'theirs', args: ['run', '--baseline', ...(recipe.baselineApp ? ['--app'] : []), '--', ...playwright] };
  const isolateArm = (workers: number): Arm => ({ name: `isolate@${workers}`, args: ['run', '--workers', String(workers), '--no-rerun', '--', ...playwright] });

  const services = await startServices(recipe);
  const samples: Sample[] = [];
  let arms: Arm[] = [theirArm];
  try {
    const run = async (arm: Arm, round: number) => {
      if (arm.name === 'theirs' && recipe.baselinePorts.length > 0) await waitForFreePorts(recipe.baselinePorts, 15 * 60_000);
      const label = round === 0 ? `${arm.name}-warmup` : `${arm.name}-r${round}`;
      const loaded = await runSuite(label, arm.args, invocation, outDir);
      const entry = sample(arm, round, loaded);
      const outcome = entry.passed === null ? `no report (${entry.error ?? `exit ${entry.exitCode}`})` : `${entry.passed} passed, ${entry.failed} failed`;
      say(`${label}: wall ${duration(entry.wallMs)}, tests ${duration(entry.testPhaseMs)}, ${entry.workers ?? '?'} worker(s), ${outcome}${entry.exceededCap ? ', STOPPED at the time cap' : ''}`);
      return entry;
    };
    say('warm-up (not counted): their setup first, to learn its worker count; it also fills the snapshot cache');
    const theirWorkers = (await run(theirArm, 0)).workers;
    const workerCounts = requested ?? defaultWorkers(cores, theirWorkers);
    arms = [theirArm, ...workerCounts.map(isolateArm)];
    say(`their setup runs ${theirWorkers ?? 'an unknown number of'} worker(s); isolate arms: ${workerCounts.join(', ')}`);
    say('warm-up (not counted): the largest isolate arm, so its build cache and the disk cache are warm too');
    await run(arms.at(-1)!, 0);
    for (let round = 1; round <= rounds; round++) {
      const shift = (round - 1) % arms.length;
      for (const arm of [...arms.slice(shift), ...arms.slice(0, shift)]) samples.push(await run(arm, round));
    }
  } finally {
    for (const service of services) await service.stop();
  }

  const table = summarize(arms, samples);
  const found = notes(arms, samples, cores);
  const footer = found.length === 0 ? '' : `\n\nNotes:\n${found.map((note) => `- ${note}`).join('\n')}`;
  const header = [
    `${name} @ ${checkout.commit.slice(0, 12)}: ${rounds} round(s); ${machine.cpuModel}, ${machine.cores} cores, ${machine.ramGb} GB, ${machine.os}`,
    `theirs = the repo's own Playwright config (its worker count, one app, one database${recipe.baselineApp ? ', app started by isolate --baseline --app' : ''}); isolate@N = one app and database per worker`,
    `wall = the whole isolate command; tests = Playwright's test phase (first test start to last test end); overhead = wall minus tests`,
  ].join('\n');
  writeFileSync(path.join(outDir, 'summary.txt'), `${header}\n\n${table}${footer}\n`);
  writeFileSync(path.join(outDir, 'samples.json'), `${JSON.stringify({ recipe: name, commit: checkout.commit, machine, browsers, arms, samples }, null, 2)}\n`);
  process.stdout.write(`\n${header}\n\n${table}${footer}\n\nraw logs and reports: ${path.relative(harnessRoot, outDir)}\n`);
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
