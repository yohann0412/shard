import { existsSync, readFileSync } from 'node:fs';

/** Cumulative CPU time counters from the first line of /proc/stat, in clock ticks. */
export interface CpuTimes {
  total: number;
  idle: number;
  steal: number;
}

/** Machine-wide CPU busy and steal percentages over an interval. */
export interface CpuUsage {
  busyPct: number;
  stealPct: number;
}

/** Reads the machine-wide CPU counters, or null where /proc/stat does not exist (not Linux). */
export function readCpuTimes(): CpuTimes | null {
  if (!existsSync('/proc/stat')) return null;
  const fields = readFileSync('/proc/stat', 'utf8').split('\n')[0]!.trim().split(/\s+/).slice(1, 9).map(Number);
  const [user = 0, nice = 0, system = 0, idle = 0, iowait = 0, irq = 0, softirq = 0, steal = 0] = fields;
  return { total: user + nice + system + idle + iowait + irq + softirq + steal, idle: idle + iowait, steal };
}

/** Busy and steal percentages between two readings, or null if either is missing or no time passed. */
export function cpuUsage(before: CpuTimes | null, after: CpuTimes | null): CpuUsage | null {
  if (before === null || after === null) return null;
  const total = after.total - before.total;
  if (total <= 0) return null;
  const round = (value: number) => Math.round(value * 10) / 10;
  return {
    busyPct: round((100 * (total - (after.idle - before.idle))) / total),
    stealPct: round((100 * (after.steal - before.steal)) / total),
  };
}
