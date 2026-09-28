/** Milliseconds since `start` (a `performance.now()` value), rounded to 0.1 ms. */
export function elapsedMs(start: number): number {
  return Math.round((performance.now() - start) * 10) / 10;
}
