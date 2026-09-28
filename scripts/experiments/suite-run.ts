import { spawn } from 'node:child_process';
import { closeSync, copyFileSync, existsSync, openSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isolatePaths } from '../../src/paths.js';
import { readResults, type PwResults } from '../../src/playwright/results.js';
import { sendSignal } from '../../src/proc/group.js';
import type { Report } from '../../src/report/schema.js';
import { loadAvg1 } from './machine.js';
import { cliPath, harnessRoot } from './paths.js';

/** A run that has not finished after 45 minutes is stopped and recorded as "exceeded cap" (PLAN §5). */
const RUN_CAP_MS = 45 * 60_000;

/** After the cap, isolate gets this long to stop Playwright and tear down before its process group is killed. */
const GRACE_MS = 60_000;

/** Where and with what an isolate command runs. */
export interface Invocation {
  /** The checkout directory isolate runs in. */
  cwd: string;
  /** Variables added to the harness's own environment. */
  env: Record<string, string>;
  /** Stop a run after this long (default 45 minutes, PLAN §5). */
  capMs?: number;
}

/** One isolate CLI command as it ran. Paths are relative to the harness root. */
export interface SuiteRun {
  label: string;
  argv: string[];
  cwd: string;
  env: Record<string, string>;
  startedAt: string;
  loadAvg1AtStart: number;
  exitCode: number;
  exceededCap: boolean;
  /** Wall time measured by the harness around the CLI process. */
  outsideWallMs: number;
  /** "too many clients" in this run's Postgres log (PLAN §8, rule 5). */
  tooManyClients: boolean;
  /** The first error isolate printed (for example, an app that never became healthy), or null. */
  error: string | null;
  files: { report: string | null; results: string | null; log: string };
}

/** A run with its report and Playwright results loaded (null when isolate did not write them). */
export interface LoadedRun {
  run: SuiteRun;
  report: Report | null;
  results: PwResults | null;
}

/** The first `[isolate] error:` line of a run's output, shortened, or null. */
function firstError(logFile: string): string | null {
  const line = readFileSync(logFile, 'utf8')
    .split('\n')
    .find((text) => text.startsWith('[isolate] error:'));
  return line === undefined ? null : line.slice('[isolate] error:'.length).trim().slice(0, 300);
}

/** Path relative to the harness root, for the JSON output. */
function relative(file: string): string {
  return path.relative(harnessRoot, file).split(path.sep).join('/');
}

/**
 * Runs `node dist/src/cli.js <args>` in its own process group with output in `logFile`. At the cap it sends SIGINT
 * (isolate then stops Playwright and tears down), and SIGKILL to the group a minute later (isolate's reaper then
 * kills the apps and Postgres). Resolves with the exit code (128 + n after signal n) and whether the cap was hit.
 */
function runCli(args: string[], invocation: Invocation, logFile: string): Promise<{ exitCode: number; exceededCap: boolean }> {
  const fd = openSync(logFile, 'w');
  const child = spawn(process.execPath, [cliPath, ...args], {
    cwd: invocation.cwd,
    env: { ...process.env, ...invocation.env },
    detached: true,
    stdio: ['ignore', fd, fd],
  });
  closeSync(fd);
  let exceededCap = false;
  const cap = setTimeout(() => {
    exceededCap = true;
    sendSignal(-child.pid!, 'SIGINT');
    setTimeout(() => sendSignal(-child.pid!, 'SIGKILL'), GRACE_MS).unref();
  }, invocation.capMs ?? RUN_CAP_MS);
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      clearTimeout(cap);
      resolve({ exitCode: code ?? 128 + (signal ? os.constants.signals[signal] : 0), exceededCap });
    });
  });
}

/**
 * Runs one isolate command in the checkout and keeps its outputs: the report as `<outDir>/<label>.json`, the isolate
 * reporter's per-test results as `<label>.pw-results.json` and the output as `<label>.log`. Stale outputs of an earlier
 * run are deleted first, so a run that writes nothing is recorded as such.
 */
export async function runSuite(label: string, args: string[], invocation: Invocation, outDir: string): Promise<LoadedRun> {
  const paths = isolatePaths(invocation.cwd);
  for (const stale of [paths.report, paths.pwResults, paths.postgresLog]) rmSync(stale, { force: true });
  const log = path.join(outDir, `${label}.log`);
  const startedAt = new Date().toISOString();
  const loadAtStart = loadAvg1();
  const start = performance.now();
  const { exitCode, exceededCap } = await runCli(args, invocation, log);
  const outsideWallMs = Math.round(performance.now() - start);

  const reportCopy = path.join(outDir, `${label}.json`);
  const resultsCopy = path.join(outDir, `${label}.pw-results.json`);
  const tooManyClients = existsSync(paths.postgresLog) && readFileSync(paths.postgresLog, 'utf8').includes('too many clients');
  const hasReport = existsSync(paths.report);
  const hasResults = existsSync(paths.pwResults);
  if (hasReport) copyFileSync(paths.report, reportCopy);
  if (hasResults) copyFileSync(paths.pwResults, resultsCopy);
  return {
    run: {
      label,
      argv: ['node', relative(cliPath), ...args],
      cwd: relative(invocation.cwd),
      env: invocation.env,
      startedAt,
      loadAvg1AtStart: loadAtStart,
      exitCode,
      exceededCap,
      outsideWallMs,
      tooManyClients,
      error: firstError(log),
      files: { report: hasReport ? relative(reportCopy) : null, results: hasResults ? relative(resultsCopy) : null, log: relative(log) },
    },
    report: hasReport ? (JSON.parse(readFileSync(reportCopy, 'utf8')) as Report) : null,
    results: hasResults ? readResults(resultsCopy) : null,
  };
}
