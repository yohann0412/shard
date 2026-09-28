/**
 * One monotonic stopwatch for a whole run. It starts at process start (performance.now() is 0 there), and each
 * `lap` closes the current phase where the previous one ended, so the phases always add up to the wall time.
 */
export class Stopwatch {
  private last = 0;
  private readonly laps: Record<string, number> = {};

  /** Ends the current phase and books its time under `name` (added to earlier laps of the same name). */
  lap(name: string): void {
    const now = performance.now();
    this.laps[name] = (this.laps[name] ?? 0) + (now - this.last);
    this.last = now;
  }

  /**
   * Ends the current phase when a callee timed its own sub-phases: books each non-zero part under its name
   * and whatever the parts do not cover under `rest`.
   */
  lapParts(parts: Record<string, number>, rest: string): void {
    const now = performance.now();
    let covered = 0;
    for (const [name, ms] of Object.entries(parts)) {
      if (ms <= 0) continue;
      this.laps[name] = (this.laps[name] ?? 0) + ms;
      covered += ms;
    }
    this.laps[rest] = (this.laps[rest] ?? 0) + (now - this.last - covered);
    this.last = now;
  }

  /** Time from process start to the last lap. */
  wallMs(): number {
    return this.last;
  }

  /** Every phase so far, in the order each first ended. */
  phases(): Record<string, number> {
    return { ...this.laps };
  }
}
