import { readdirSync, readFileSync } from 'node:fs';
import { RUN_ID_ENV, sendSignal } from './group.js';
import { waitUntil } from './wait.js';

function hasMarker(pid: string, marker: string): boolean {
  try {
    return readFileSync(`/proc/${pid}/environ`, 'latin1').split('\0').includes(marker);
  } catch {
    return false;
  }
}

/** PIDs of live processes whose environment has ISOLATE_RUN_ID=<runId>. Reads /proc, so it finds nothing outside Linux. */
function markedProcesses(runId: string): number[] {
  if (process.platform !== 'linux') return [];
  const marker = `${RUN_ID_ENV}=${runId}`;
  return readdirSync('/proc')
    .filter((entry) => /^\d+$/.test(entry) && Number(entry) !== process.pid && hasMarker(entry, marker))
    .map(Number);
}

/**
 * Kills every process still carrying this run's marker (for example app children that daemonized or called setsid and
 * so escaped their group): SIGTERM, then SIGKILL after `graceMs`. Returns the PIDs it found.
 */
export async function killMarkedProcesses(runId: string, graceMs = 3_000): Promise<number[]> {
  const found = markedProcesses(runId);
  for (const pid of found) sendSignal(pid, 'SIGTERM');
  if (found.length > 0 && !(await waitUntil(() => markedProcesses(runId).length === 0, graceMs))) {
    for (const pid of markedProcesses(runId)) sendSignal(pid, 'SIGKILL');
    await waitUntil(() => markedProcesses(runId).length === 0, 2_000);
  }
  return found;
}
