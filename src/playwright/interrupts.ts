import type { PlaywrightProcess } from './runner.js';

/**
 * Turns the first SIGINT or SIGTERM into a graceful stop of whatever Playwright process is running (and of any started
 * later), so isolate can still tear down, write the report and remove its files. A second signal calls `onForce`.
 */
export class InterruptGuard {
  private received: NodeJS.Signals | null = null;
  private readonly running = new Set<PlaywrightProcess>();
  private readonly handler = (signal: NodeJS.Signals) => {
    if (this.received !== null) {
      this.onForce(signal);
      return;
    }
    this.received = signal;
    for (const proc of this.running) proc.interrupt();
  };

  constructor(private readonly onForce: (signal: NodeJS.Signals) => void) {
    process.on('SIGINT', this.handler);
    process.on('SIGTERM', this.handler);
  }

  /** The first signal received, or null. */
  get signal(): NodeJS.Signals | null {
    return this.received;
  }

  /** Waits for a Playwright process, interrupting it if a signal arrives (or already arrived); resolves with its exit code. */
  async run(proc: PlaywrightProcess): Promise<number> {
    this.running.add(proc);
    if (this.received !== null) proc.interrupt();
    try {
      return await proc.exited;
    } finally {
      this.running.delete(proc);
    }
  }

  /** Removes the signal handlers. */
  dispose(): void {
    process.off('SIGINT', this.handler);
    process.off('SIGTERM', this.handler);
  }
}
