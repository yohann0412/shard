import { existsSync, readFileSync } from 'node:fs';
import os from 'node:os';
import { setTimeout as sleep } from 'node:timers/promises';
import { describeMachine } from '../../src/report/machine.js';

/** Load average a timed run should start below (PLAN §8, rule 6). */
const LOAD_THRESHOLD = 1.0;

const LOAD_POLL_MS = 10_000;

/** The machine an experiment ran on. `postgres` is filled in from the first run's report. */
export interface MachineFacts {
  cpuModel: string;
  /** Logical CPUs; arms with more workers than this are skipped or labelled oversubscribed. */
  cores: number;
  threadsPerCore: number | null;
  ramGb: number;
  os: string;
  kernel: string;
  node: string;
  postgres: string | null;
  /** The Playwright version the checkout resolves. */
  playwright: string | null;
  cloudSandbox: boolean;
}

/** What the load gate saw before one timed run. */
export interface LoadWait {
  threshold: number;
  maxWaitMs: number;
  waitedMs: number;
  /** 1-minute load averages sampled while waiting, first to last. */
  seen: number[];
  /** True if the last sample was below the threshold. */
  below: boolean;
}

/** The distribution's name from /etc/os-release, or the kernel's OS type. */
function osName(): string {
  if (!existsSync('/etc/os-release')) return os.type();
  const match = /^PRETTY_NAME="?([^"\n]*)"?$/m.exec(readFileSync('/etc/os-release', 'utf8'));
  return match?.[1] ?? os.type();
}

/** Describes this machine and the Playwright version resolved from `appDir` (Postgres comes later, from a report). */
export function machineFacts(appDir: string): MachineFacts {
  const described = describeMachine('', appDir, loadAvg1());
  return {
    cpuModel: described.cpuModel,
    cores: described.cores,
    threadsPerCore: described.threadsPerCore,
    ramGb: described.ramGb,
    os: osName(),
    kernel: os.release(),
    node: process.version,
    postgres: null,
    playwright: described.playwright,
    cloudSandbox: existsSync('/root/.ccr'),
  };
}

/** The current 1-minute load average. */
export function loadAvg1(): number {
  return Math.round((os.loadavg()[0] ?? 0) * 100) / 100;
}

/** Waits, polling every 10 s for at most `maxWaitMs`, until the 1-minute load average is below 1.0; records what it saw. */
export async function waitForLowLoad(maxWaitMs: number): Promise<LoadWait> {
  const start = performance.now();
  const seen = [loadAvg1()];
  while (seen.at(-1)! >= LOAD_THRESHOLD && performance.now() - start + LOAD_POLL_MS <= maxWaitMs) {
    await sleep(LOAD_POLL_MS);
    seen.push(loadAvg1());
  }
  return { threshold: LOAD_THRESHOLD, maxWaitMs, waitedMs: Math.round(performance.now() - start), seen, below: seen.at(-1)! < LOAD_THRESHOLD };
}
