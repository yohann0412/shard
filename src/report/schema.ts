import { z } from 'zod';

const ms = z.number().nonnegative();
const count = z.number().int().nonnegative();
const megabytes = z.number().nonnegative();
const percent = z.number().min(0).max(100);

/** Names of the contiguous phases of a run, in the order they happen. Phases that did not happen are omitted. */
export const PHASE_NAMES = ['setup', 'restore', 'build', 'postgresStart', 'migrateSeed', 'clone', 'appBoot', 'tests', 'reruns', 'teardown'] as const;

/** Name of one phase of a run. */
export type PhaseName = (typeof PHASE_NAMES)[number];

/** Schema of `.isolate/report.json`, used both to write it and by `isolate report --check`. */
export const reportSchema = z.strictObject({
  version: z.literal(1),
  startedAt: z.iso.datetime(),
  repoDir: z.string().min(1),
  command: z.array(z.string()).min(1),
  mode: z.enum(['run', 'trace', 'baseline']),
  /** Workers requested from isolate; in baseline mode, the worker count Playwright resolved. */
  workerCount: count,
  cache: z.strictObject({ hit: z.boolean(), key: z.string() }).nullable(),
  wallMs: ms,
  phases: z.partialRecord(z.enum(PHASE_NAMES), ms),
  machine: z.strictObject({
    cpuModel: z.string(),
    cores: count,
    threadsPerCore: count.nullable(),
    ramGb: z.number().nonnegative(),
    os: z.string(),
    node: z.string(),
    postgres: z.string(),
    playwright: z.string().nullable(),
    loadAvg1: z.number().nonnegative(),
  }),
  cpu: z.strictObject({ busyPct: percent, stealPct: percent }).nullable(),
  /** Null when Playwright exited before its reporters finished (for example, a config error). */
  playwright: z
    .strictObject({
      testPhaseMs: ms,
      preTestMs: ms,
      postTestMs: ms,
      resolvedWorkers: count,
      maxConcurrent: count,
      parallelIndexes: z.array(count),
      setupMs: ms,
      bodyMs: ms,
    })
    .nullable(),
  apps: z.array(z.strictObject({ index: count, port: count, bootMs: ms, peakRssMb: megabytes })),
  postgresPeakRssMb: megabytes,
  clones: z.array(z.strictObject({ name: z.string(), ms })),
  workers: z.array(z.strictObject({ parallelIndex: z.number().int(), tests: count, passed: count, failed: count })),
  tests: z.strictObject({ total: count, passed: count, failed: count, flaky: count, skipped: count }),
  failures: z.array(
    z.strictObject({
      id: z.string(),
      title: z.string(),
      file: z.string(),
      line: count,
      project: z.string(),
      classification: z.enum(['flaky', 'deterministic', 'not-rerun']),
      reruns: z.array(z.enum(['passed', 'failed'])),
    }),
  ),
  dbActivity: z.array(z.strictObject({ name: z.string(), xactCommitDelta: z.number().int() })),
  routingValid: z.boolean(),
  warnings: z.array(z.string()),
});

/** The timing and outcome report of one run. */
export type Report = z.infer<typeof reportSchema>;

/** One failed test and how its reruns classified it. */
export type Failure = Report['failures'][number];
