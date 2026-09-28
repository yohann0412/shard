import { setTimeout as sleep } from 'node:timers/promises';
import { describeExit, type ExitInfo, type GroupProcess } from './group.js';
import { readTail } from './tail.js';

/**
 * Polls `probe` every 100 ms until it returns true. Throws, with the tail of the process's log, as soon as the process
 * exits or once `timeoutMs` has passed.
 */
export async function waitForReady(probe: () => Promise<boolean>, proc: GroupProcess, what: string, timeoutMs: number): Promise<void> {
  let exit: ExitInfo | undefined;
  void proc.exited.then((info) => {
    exit = info;
  });
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (exit !== undefined) {
      throw new Error(`${what} exited before it was ready (${describeExit(exit)}). Last lines of ${proc.logFile}:\n${readTail(proc.logFile)}`);
    }
    if (await probe()) return;
    if (Date.now() > deadline) {
      throw new Error(`${what} was not ready within ${timeoutMs} ms. Last lines of ${proc.logFile}:\n${readTail(proc.logFile)}`);
    }
    await sleep(100);
  }
}
