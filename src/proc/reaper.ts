import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { closeSync, openSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { killGroup } from './group.js';
import { killMarkedProcesses } from './sweep.js';

/** What must be cleaned up if the CLI dies: written by the CLI, read by the reaper process. */
export interface ReaperState {
  /** Value of ISOLATE_RUN_ID in every process this invocation started. */
  runId: string;
  /** Process group IDs that are still running. */
  groups: number[];
  /** Directories to delete (the Postgres data directory). */
  dirs: string[];
}

/** The CLI's side of the reaper: it records what to clean up in the state file the reaper process watches. */
export interface Reaper {
  runId: string;
  trackGroup(pgid: number): void;
  untrackGroup(pgid: number): void;
  trackDir(dir: string): void;
  untrackDir(dir: string): void;
  /**
   * Cleans up whatever is still recorded, then deletes the state file, which tells the reaper process to exit.
   * Returns the PIDs of escaped processes that had to be killed by their ISOLATE_RUN_ID marker.
   */
  close(): Promise<number[]>;
}

/**
 * Kills the recorded groups, then any process still carrying the run's ISOLATE_RUN_ID, then deletes the recorded
 * directories. Returns the PIDs found by the marker sweep.
 */
export async function cleanUp(state: ReaperState): Promise<number[]> {
  await Promise.all(state.groups.map((pgid) => killGroup(pgid)));
  const escaped = await killMarkedProcesses(state.runId);
  for (const dir of state.dirs) rmSync(dir, { recursive: true, force: true });
  return escaped;
}

/**
 * Writes the state file and starts the detached reaper process (reaper-main.ts), which cleans up for this CLI if it
 * disappears without calling close(), for example after SIGKILL (DECISIONS.md D-007).
 */
export function startReaper(stateFile: string, logFile: string): Reaper {
  const state: ReaperState = { runId: randomUUID(), groups: [], dirs: [] };
  let closed = false;
  const save = () => {
    if (closed) return;
    writeFileSync(`${stateFile}.tmp`, JSON.stringify(state));
    renameSync(`${stateFile}.tmp`, stateFile);
  };
  save();

  const fd = openSync(logFile, 'w');
  const main = fileURLToPath(new URL('./reaper-main.js', import.meta.url));
  spawn(process.execPath, [main, String(process.pid), stateFile], { detached: true, stdio: ['ignore', fd, fd] }).unref();
  closeSync(fd);

  return {
    runId: state.runId,
    trackGroup(pgid) {
      state.groups.push(pgid);
      save();
    },
    untrackGroup(pgid) {
      state.groups = state.groups.filter((group) => group !== pgid);
      save();
    },
    trackDir(dir) {
      state.dirs.push(dir);
      save();
    },
    untrackDir(dir) {
      state.dirs = state.dirs.filter((recorded) => recorded !== dir);
      save();
    },
    async close() {
      const escaped = await cleanUp(state);
      closed = true;
      rmSync(stateFile, { force: true });
      return escaped;
    },
  };
}
