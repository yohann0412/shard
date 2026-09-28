import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { closeSync, openSync } from 'node:fs';
import type { Reaper } from './reaper.js';
import { readTail } from './tail.js';
import { waitUntil } from './wait.js';

/** Environment variable stamped on every process one isolate invocation starts, so escaped descendants can be found. */
export const RUN_ID_ENV = 'ISOLATE_RUN_ID';

/** How a process ended. */
export interface ExitInfo {
  exitCode: number | null;
  signal: string | null;
}

/** A process started as the leader of its own process group. */
export interface GroupProcess {
  /** PID of the leader, which is also the process group ID. */
  pid: number;
  /** File that receives the process's stdout and stderr. */
  logFile: string;
  /** Resolves when the leader exits; never rejects. */
  exited: Promise<ExitInfo>;
}

/** How to run a process group. */
export interface GroupOptions {
  cwd: string;
  env: NodeJS.ProcessEnv;
  /** stdout and stderr are appended here; the parent opens the file and hands the descriptor to the child. */
  logFile: string;
  /** Records the group for cleanup while it runs; its run ID is stamped into the environment as ISOLATE_RUN_ID. */
  reaper: Reaper;
}

/**
 * Spawns a program as the leader of a new process group (detached), tracked by the reaper until it exits. Its stdout
 * and stderr are the log file's descriptor itself, not a pipe through this process, so the child never depends on the
 * CLI's event loop and holds none of the CLI's own stdio open. (execa's typings only accept descriptors up to 9, so
 * this uses node:child_process directly.)
 */
export async function spawnGroup(file: string, args: string[], options: GroupOptions): Promise<GroupProcess> {
  const fd = openSync(options.logFile, 'a');
  const child = spawn(file, args, {
    cwd: options.cwd,
    env: { ...options.env, [RUN_ID_ENV]: options.reaper.runId },
    detached: true,
    stdio: ['ignore', fd, fd],
  });
  closeSync(fd);
  const { pid } = child;
  if (pid === undefined) {
    const [error] = (await once(child, 'error')) as [Error];
    throw new Error(`could not start ${file}: ${error.message}`);
  }
  options.reaper.trackGroup(pid);
  const exited = new Promise<ExitInfo>((resolve) => {
    child.once('exit', (exitCode, signal) => {
      options.reaper.untrackGroup(pid);
      resolve({ exitCode, signal });
    });
  });
  return { pid, logFile: options.logFile, exited };
}

/** Runs a program as a process group until it exits; throws with the tail of its log if it did not exit with code 0. */
export async function runGroup(file: string, args: string[], options: GroupOptions, description: string): Promise<void> {
  const exit = await (await spawnGroup(file, args, options)).exited;
  if (exit.exitCode !== 0) {
    throw new Error(`${description} failed (${describeExit(exit)}). Last lines of ${options.logFile}:\n${readTail(options.logFile)}`);
  }
}

/** Describes an exit as "exit code N" or "signal SIGX". */
export function describeExit(exit: ExitInfo): string {
  return exit.signal === null ? `exit code ${exit.exitCode}` : `signal ${exit.signal}`;
}

/** Sends a signal to a PID (a negative PID means a whole group); returns false if no such process or group exists. */
export function sendSignal(pid: number, signal: NodeJS.Signals | 0): boolean {
  try {
    process.kill(pid, signal);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** True while any process in the group still exists (an unreaped zombie counts). */
function groupAlive(pgid: number): boolean {
  return sendSignal(-pgid, 0);
}

/** Kills a whole process group: SIGTERM, then SIGKILL if anything is left after `graceMs`. */
export async function killGroup(pgid: number, graceMs = 5_000): Promise<void> {
  if (!sendSignal(-pgid, 'SIGTERM')) return;
  if (await waitUntil(() => !groupAlive(pgid), graceMs)) return;
  sendSignal(-pgid, 'SIGKILL');
  await waitUntil(() => !groupAlive(pgid), 2_000);
}
