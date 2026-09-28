import { isTimed, type Arm, type ArmRun } from './arms.js';
import { resourceCeiling, schedulingCeiling, schedulingInputs } from './ceilings.js';
import { testOutcomes, type Outcome } from './outcomes.js';
import { referenceOutcomes, runMetrics, runValidity, type RunMetrics, type RunValidity } from './run-metrics.js';
import { median, ratio, round, spread } from './stats.js';

/** A harness effect (baseline@1 / isolated@1) outside this range is flagged, and vs-baseline speedups are not quoted. */
const HARNESS_EFFECT_RANGE: [number, number] = [0.85, 1.15];

/** The verdict metric compares isolated@1 with isolated@4 (PLAN §1). */
const VERDICT_WORKERS = 4;

/** Isolation failures need this many failing isolated@4 rounds and passing baseline@1 rounds (PLAN §5.6). */
const MIN_ROUNDS_FOR_CLASSIFICATION = 2;

/** One run with its metrics and validity. */
interface Scored {
  run: ArmRun;
  metrics: RunMetrics | null;
  validity: RunValidity;
}

/** Medians of one arm's valid timed runs, used for the speedups. */
interface ArmMedians {
  testPhaseMs: number;
  playwrightWallMs: number;
  endToEndMs: number;
  sumDurationMs: number;
  cpuDemand: number | null;
}

/** What each field of the aggregate means, written next to the numbers. */
const DEFINITIONS = {
  testPhaseMs: 'first test begin to last test end, from the isolate reporter (the verdict span)',
  wallMs: "the isolate command's whole wall time from its report (setup, build, Postgres, migrate/seed, clone, app boot, tests, reruns, teardown)",
  preTestMs: 'Playwright start to first test begin: webServer boot, globalSetup, worker and browser start',
  playwrightWallMs: 'pre-test + test phase + post-test: Playwright alone',
  endToEndMs: 'wallMs minus the build phase (done once before timing) and the failure reruns',
  valid: 'a run counts when it wrote a report and results, stayed under the 45-min cap, routing was valid, no "too many clients", and its per-test outcomes equal baseline@1\'s reference outcomes (most frequent outcome over its timed rounds)',
  speedups: 'medians of valid timed runs: test phase, Playwright wall ("wall") and end-to-end of isolated@1 divided by those of isolated@N; vs-baseline divides the baseline arm by isolated@N',
  harnessEffect: 'test phase of baseline@1 / isolated@1; outside 0.85-1.15 it is flagged and vs-baseline speedups should not be quoted',
  schedulingCeiling: 'T1 / max(T1/N, longest file); T1 = sum of per-test median durations at isolated@1; a file is its longest test if two of its tests were seen running at once in an isolated N > 1 run, else the sum of its tests',
  resourceCeiling: 'min(N, cores/d); d = machine-wide busy CPU seconds (busyPct x cores x Playwright wall) per test-phase second at isolated@1 (includes Postgres, the app and anything else on the machine)',
  perTestInflation: 'sum of test durations at N / at N=1 (medians over valid runs)',
  setupFraction: 'sum of hook and fixture time / sum of test durations; pre-test and post-test shares of the Playwright wall',
  isolationFailure: 'fails in >= 2 isolated@4 timed rounds and passes in >= 2 baseline@1 timed rounds',
  memory: 'peak RSS of every app tree plus the Postgres tree at the largest N that ran (each tree sampled once a second, peaks summed)',
  cacheEffect: 'the cold run (fresh .isolate/, before everything) against the valid timed isolated@1 runs; never part of a speedup',
};

/** Median of one metric over runs that have metrics, or null. */
function medianOf(runs: Scored[], pick: (metrics: RunMetrics) => number | null): number | null {
  const values = runs.flatMap((scored) => {
    const value = scored.metrics === null ? null : pick(scored.metrics);
    return value === null ? [] : [value];
  });
  return values.length === 0 ? null : median(values);
}

/** Median, min and max of one metric over runs that have metrics. */
function spreadOf(runs: Scored[], pick: (metrics: RunMetrics) => number) {
  return spread(runs.flatMap((scored) => (scored.metrics === null ? [] : [pick(scored.metrics)])));
}

/** The timed runs of one arm; with `validOnly`, only the ones that count. */
function timedRuns(scored: Scored[], arm: string, validOnly: boolean): Scored[] {
  return scored.filter((entry) => entry.run.arm === arm && isTimed(entry.run) && (!validOnly || entry.validity.valid));
}

/** How often each test passed, failed or was skipped over an arm's timed runs. */
function outcomeTally(runs: Scored[]): Record<string, Record<Outcome, number>> {
  const tally: Record<string, Record<Outcome, number>> = {};
  for (const { run } of runs) {
    if (run.results === null) continue;
    for (const [id, outcome] of Object.entries(testOutcomes(run.results))) {
      tally[id] ??= { passed: 0, failed: 0, skipped: 0 };
      tally[id][outcome]++;
    }
  }
  return tally;
}

/** Per arm: timings over valid runs, what was excluded and why, stability, observed concurrency and per-test outcomes. */
function armSummary(arm: Arm, scored: Scored[]) {
  const timed = timedRuns(scored, arm.name, false);
  const valid = timedRuns(scored, arm.name, true);
  const phases = timed.flatMap((entry) => (entry.metrics === null ? [] : [entry.metrics.testPhaseMs]));
  const measured = timed.flatMap((entry) => (entry.metrics === null ? [] : [entry.metrics]));
  const maxConcurrent = Math.max(0, ...measured.map((metrics) => metrics.maxConcurrent));
  return {
    arm: arm.name,
    kind: arm.kind,
    workers: arm.workers,
    oversubscribed: arm.oversubscribed,
    timedRuns: timed.length,
    validRuns: valid.length,
    excluded: timed.filter((entry) => !entry.validity.valid).map((entry) => ({ round: entry.run.round, reasons: entry.validity.reasons })),
    testPhaseMs: spreadOf(valid, (metrics) => metrics.testPhaseMs),
    wallMs: spreadOf(valid, (metrics) => metrics.wallMs),
    preTestMs: spreadOf(valid, (metrics) => metrics.preTestMs),
    playwrightWallMs: spreadOf(valid, (metrics) => metrics.playwrightWallMs),
    endToEndMs: spreadOf(valid, (metrics) => metrics.endToEndMs),
    allTimedRunsTestPhaseMs: spread(phases),
    maxOverMinTestPhase: phases.length === 0 ? null : round(Math.max(...phases) / Math.min(...phases)),
    concurrency: {
      resolvedWorkers: [...new Set(measured.map((metrics) => metrics.resolvedWorkers))],
      maxConcurrent,
      distinctParallelIndexes: Math.max(0, ...measured.map((metrics) => metrics.distinctParallelIndexes)),
      label: arm.workers !== null && maxConcurrent < arm.workers ? `asked ${arm.workers}, at most ${maxConcurrent} ran at once` : `at most ${maxConcurrent} at once`,
    },
    startedAtLoadAboveOne: timed.filter((entry) => entry.run.run.loadAvg1AtStart >= 1).length,
    outcomes: outcomeTally(timed),
  };
}

/** Medians of an arm's valid timed runs, or null when it has none. */
function armMedians(scored: Scored[], arm: string): ArmMedians | null {
  const valid = timedRuns(scored, arm, true);
  if (valid.length === 0) return null;
  return {
    testPhaseMs: medianOf(valid, (metrics) => metrics.testPhaseMs)!,
    playwrightWallMs: medianOf(valid, (metrics) => metrics.playwrightWallMs)!,
    endToEndMs: medianOf(valid, (metrics) => metrics.endToEndMs)!,
    sumDurationMs: medianOf(valid, (metrics) => metrics.sumDurationMs)!,
    cpuDemand: medianOf(valid, (metrics) => metrics.cpuDemand),
  };
}

/** Speedups of every isolated arm against isolated@1 and against both baselines, with ceilings and inflation. */
function speedups(arms: Arm[], scored: Scored[], cores: number) {
  const one = armMedians(scored, 'isolated@1');
  const configured = armMedians(scored, 'baseline@configured');
  const baseline1 = armMedians(scored, 'baseline@1');
  const parallelRuns = scored.filter((entry) => entry.run.arm.startsWith('isolated@') && entry.run.arm !== 'isolated@1' && entry.run.results !== null);
  const scheduling = schedulingInputs(timedRuns(scored, 'isolated@1', true).map((entry) => entry.run), parallelRuns.map((entry) => entry.run));
  const rows = arms
    .filter((arm) => arm.kind === 'isolated')
    .map((arm) => {
      const n = armMedians(scored, arm.name);
      const testPhase = ratio(one?.testPhaseMs, n?.testPhaseMs);
      const schedulingLimit = schedulingCeiling(scheduling, arm.workers!);
      const resourceLimit = resourceCeiling(arm.workers!, cores, one?.cpuDemand ?? null);
      const limits = [schedulingLimit, resourceLimit].filter((limit): limit is number => limit !== null);
      return {
        arm: arm.name,
        workers: arm.workers,
        oversubscribed: arm.oversubscribed,
        testPhase,
        wall: ratio(one?.playwrightWallMs, n?.playwrightWallMs),
        endToEnd: ratio(one?.endToEndMs, n?.endToEndMs),
        vsBaselineConfigured: { testPhase: ratio(configured?.testPhaseMs, n?.testPhaseMs), endToEnd: ratio(configured?.endToEndMs, n?.endToEndMs) },
        vsBaseline1: { testPhase: ratio(baseline1?.testPhaseMs, n?.testPhaseMs), endToEnd: ratio(baseline1?.endToEndMs, n?.endToEndMs) },
        schedulingCeiling: schedulingLimit,
        resourceCeiling: resourceLimit,
        fractionOfLowerCeiling: limits.length === 0 ? null : ratio(testPhase, Math.min(...limits)),
        perTestInflation: ratio(n?.sumDurationMs, one?.sumDurationMs),
      };
    });
  const harnessEffect = ratio(baseline1?.testPhaseMs, one?.testPhaseMs);
  const flagged = harnessEffect === null || harnessEffect < HARNESS_EFFECT_RANGE[0] || harnessEffect > HARNESS_EFFECT_RANGE[1];
  return {
    verdict: { metric: `test phase isolated@1 / isolated@${VERDICT_WORKERS}`, value: rows.find((row) => row.workers === VERDICT_WORKERS)?.testPhase ?? null },
    harnessEffect: { value: harnessEffect, range: HARNESS_EFFECT_RANGE, flagged, vsBaselineQuotable: !flagged },
    cpuDemandAtIsolated1: one === null || one.cpuDemand === null ? null : round(one.cpuDemand),
    scheduling,
    byWorkers: rows,
  };
}

/** Setup, pre-test and post-test shares for one arm's valid runs (medians of per-run ratios). */
function setupFraction(scored: Scored[], arm: string) {
  const valid = timedRuns(scored, arm, true);
  if (valid.length === 0) return null;
  const share = (pick: (metrics: RunMetrics) => number | null) => {
    const value = medianOf(valid, pick);
    return value === null ? null : round(value);
  };
  return {
    arm,
    runs: valid.length,
    setupShareOfTestTime: share((metrics) => (metrics.sumDurationMs === 0 ? null : metrics.sumSetupMs / metrics.sumDurationMs)),
    preTestShareOfPlaywrightWall: share((metrics) => metrics.preTestMs / metrics.playwrightWallMs),
    postTestShareOfPlaywrightWall: share((metrics) => metrics.postTestMs / metrics.playwrightWallMs),
  };
}

/**
 * Every test that failed in some isolated@4 timed round, whether it counts as an isolation failure (PLAN §5.6), what
 * isolate's own reruns said about it, and a category the lead fills in by hand.
 */
function failureClassification(scored: Scored[]) {
  const isolatedArm = `isolated@${VERDICT_WORKERS}`;
  const isolated = timedRuns(scored, isolatedArm, false).filter((entry) => entry.run.results !== null);
  const baseline = timedRuns(scored, 'baseline@1', false).filter((entry) => entry.run.results !== null);
  const isolatedOutcomes = isolated.map((entry) => testOutcomes(entry.run.results!));
  const baselineOutcomes = baseline.map((entry) => testOutcomes(entry.run.results!));
  const failed = [...new Set(isolatedOutcomes.flatMap((outcomes) => Object.keys(outcomes).filter((id) => outcomes[id] === 'failed')))].sort();
  return {
    isolatedArm,
    isolatedRounds: isolated.length,
    baselineRounds: baseline.length,
    tests: failed.map((id) => {
      const failedIn = isolatedOutcomes.filter((outcomes) => outcomes[id] === 'failed').length;
      const baselinePassedIn = baselineOutcomes.filter((outcomes) => outcomes[id] === 'passed').length;
      return {
        id,
        failedInIsolatedRounds: failedIn,
        passedInBaselineRounds: baselinePassedIn,
        isolationFailure: failedIn >= MIN_ROUNDS_FOR_CLASSIFICATION && baselinePassedIn >= MIN_ROUNDS_FOR_CLASSIFICATION,
        toolClassification: isolated.flatMap((entry) => {
          const failure = entry.run.report?.failures.find((candidate) => candidate.id === id);
          return failure === undefined ? [] : [{ round: entry.run.round, classification: failure.classification, reruns: failure.reruns }];
        }),
        category: 'uninvestigated',
      };
    }),
  };
}

/** Peak RSS of apps plus Postgres in every timed run of the isolated arm with the most workers. */
function memory(arms: Arm[], scored: Scored[]) {
  const ran = arms.filter((arm) => arm.kind === 'isolated' && timedRuns(scored, arm.name, false).some((entry) => entry.run.report !== null));
  const largest = ran.at(-1);
  if (largest === undefined) return null;
  const perRun = timedRuns(scored, largest.name, false).flatMap(({ run }) =>
    run.report === null
      ? []
      : [{ round: run.round, totalMb: round(run.report.apps.reduce((sum, app) => sum + app.peakRssMb, 0) + run.report.postgresPeakRssMb, 1), appsMb: run.report.apps.map((app) => app.peakRssMb), postgresMb: run.report.postgresPeakRssMb }],
  );
  return { arm: largest.name, workers: largest.workers, oversubscribed: largest.oversubscribed, peakMb: Math.max(...perRun.map((entry) => entry.totalMb)), perRun };
}

/** The cold run against the warm isolated@1 runs. */
function cacheEffect(scored: Scored[]) {
  const cold = scored.find((entry) => entry.run.round === 'cold');
  const warm = timedRuns(scored, 'isolated@1', true);
  const phasesOf = (entry: Scored): Record<string, number> => entry.run.report?.phases ?? {};
  const phaseNames = [...new Set(warm.flatMap((entry) => Object.keys(phasesOf(entry))))];
  const warmPhases = Object.fromEntries(phaseNames.map((name) => [name, round(median(warm.map((entry) => phasesOf(entry)[name] ?? 0)), 1)]));
  const warmWall = medianOf(warm, (metrics) => metrics.wallMs);
  return {
    cold: cold?.run.report ? { wallMs: cold.run.report.wallMs, phases: cold.run.report.phases, cache: cold.run.report.cache, valid: cold.validity.valid } : null,
    warm: { arm: 'isolated@1', runs: warm.length, wallMs: warmWall === null ? null : round(warmWall, 1), phases: warmPhases },
    coldOverWarmWall: ratio(cold?.run.report?.wallMs, warmWall),
    note:
      cold?.run.report?.cache === null
        ? 'report.cache is null: this isolate has no snapshot cache (F5), so the difference is page cache and other warm-up effects only'
        : 'see cold.cache for the snapshot cache result',
  };
}

/** The non-oversubscribed isolated N with the lowest median test phase over valid runs. */
function bestWorkers(arms: Arm[], scored: Scored[]): number | null {
  const candidates = arms.flatMap((arm) => {
    const medians = arm.kind === 'isolated' && !arm.oversubscribed ? armMedians(scored, arm.name) : null;
    return medians === null ? [] : [{ workers: arm.workers!, testPhaseMs: medians.testPhaseMs }];
  });
  candidates.sort((a, b) => a.testPhaseMs - b.testPhaseMs);
  return candidates[0]?.workers ?? null;
}

/** Everything Experiment A reports, computed from the raw runs (PLAN §5, Experiment A). */
export function aggregateA(arms: Arm[], runs: ArmRun[], cores: number) {
  const reference = referenceOutcomes(runs);
  const scored: Scored[] = runs.map((run) => ({ run, metrics: runMetrics(run, cores), validity: runValidity(run, reference) }));
  return {
    definitions: DEFINITIONS,
    referenceOutcomes: reference,
    validity: scored.map((entry) => entry.validity),
    perArm: arms.map((arm) => armSummary(arm, scored)),
    speedups: speedups(arms, scored, cores),
    setupFraction: { isolated1: setupFraction(scored, 'isolated@1'), baseline1: setupFraction(scored, 'baseline@1') },
    failures: failureClassification(scored),
    memory: memory(arms, scored),
    cacheEffect: cacheEffect(scored),
    bestWorkers: bestWorkers(arms, scored),
  };
}
