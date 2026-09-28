import type { RunningApp } from '../app/apps.js';
import type { WorkerDatabase } from '../db/databases.js';
import type { PwResults } from '../playwright/results.js';
import type { UnmanagedService } from '../init/unmanaged.js';
import type { CacheOutcome } from '../snapshot/plan.js';
import type { CpuUsage } from './cpu.js';
import type { Machine } from './machine.js';
import { requestsTo, type ProxyReport } from './requests.js';
import type { DbActivity } from './routing.js';
import { reportSchema, type Failure, type Report } from './schema.js';
import type { Stopwatch } from './stopwatch.js';
import { playwrightTiming, testTotals, workerCounts } from './summary.js';

/** Everything one run's report is built from. */
export interface ReportInput {
  repoDir: string;
  command: string[];
  mode: Report['mode'];
  workerCount: number;
  cache: CacheOutcome;
  stopwatch: Stopwatch;
  machine: Machine;
  cpu: CpuUsage | null;
  results: PwResults | null;
  apps: RunningApp[];
  peakRssMb: Record<string, number>;
  clones: WorkerDatabase[];
  failures: Failure[];
  dbActivity: DbActivity[];
  proxy: ProxyReport | null;
  routingValid: boolean | null;
  unmanaged: UnmanagedService[];
  warnings: string[];
}

/** Assembles and validates the report of one run (a schema violation here is a bug in isolate, so it throws). */
export function buildReport(input: ReportInput): Report {
  return reportSchema.parse({
    version: 1,
    startedAt: new Date(performance.timeOrigin).toISOString(),
    repoDir: input.repoDir,
    command: input.command,
    mode: input.mode,
    workerCount: input.workerCount,
    cache: input.cache,
    wallMs: input.stopwatch.wallMs(),
    phases: input.stopwatch.phases(),
    machine: input.machine,
    cpu: input.cpu,
    playwright: playwrightTiming(input.results),
    apps: input.apps.map((app) => ({
      index: app.index,
      port: app.port,
      bootMs: app.bootMs,
      peakRssMb: input.peakRssMb[`w${app.index}`] ?? 0,
      requests: input.proxy === null ? null : requestsTo(input.proxy, app.index),
    })),
    postgresPeakRssMb: input.peakRssMb.postgres ?? 0,
    clones: input.clones.map((database) => ({ name: database.name, ms: database.copyMs })),
    workers: workerCounts(input.results),
    tests: testTotals(input.results),
    failures: input.failures,
    dbActivity: input.dbActivity,
    proxy: input.proxy,
    routingValid: input.routingValid,
    unmanaged: input.unmanaged,
    warnings: input.warnings,
  });
}
