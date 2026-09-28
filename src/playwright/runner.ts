import os from 'node:os';
import { execa } from 'execa';
import { RUN_ID_ENV } from '../proc/group.js';
import type { Reaper } from '../proc/reaper.js';

/** A Playwright process running in its own process group. */
export interface PlaywrightProcess {
  pid: number;
  /** Resolves with the exit code (128 + signal number if a signal killed it). */
  exited: Promise<number>;
  /** Asks Playwright to stop gracefully, exactly as one Ctrl+C would: SIGINT to its whole process group. */
  interrupt(): void;
}

/** What to run with; output goes to the terminal unless `logFile` is set. */
export interface PlaywrightRunOptions {
  cwd: string;
  env: Record<string, string>;
  /** Tracks the process group, and stamps the run ID, so nothing survives if isolate itself is killed. */
  reaper: Reaper;
  logFile?: string;
}

/**
 * Starts a Playwright command in its own process group, so a Ctrl+C reaches it once, through isolate
 * (Playwright treats a second SIGINT as "exit now" and would skip its reporters).
 */
export function startPlaywright(argv: string[], options: PlaywrightRunOptions): PlaywrightProcess {
  const output = options.logFile === undefined ? 'inherit' : { file: options.logFile, append: true };
  const child = execa(argv[0]!, argv.slice(1), {
    cwd: options.cwd,
    env: { ...options.env, [RUN_ID_ENV]: options.reaper.runId },
    detached: true,
    stdio: ['ignore', output, output],
    reject: false,
  });
  const pid = child.pid;
  if (pid === undefined) throw new Error(`could not start: ${argv.join(' ')}`);
  options.reaper.trackGroup(pid);
  return {
    pid,
    exited: child.then((result) => {
      options.reaper.untrackGroup(pid);
      return result.exitCode ?? 128 + (result.signal ? os.constants.signals[result.signal] : 0);
    }),
    interrupt: () => {
      try {
        process.kill(-pid, 'SIGINT');
      } catch {
        // The process group has already exited.
      }
    },
  };
}
