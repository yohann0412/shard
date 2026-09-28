/** Bisection steps: 2^-60 is far below any precision a proportion is reported with. */
const STEPS = 60;

/** P(X <= k) for X ~ Binomial(n, p), summing the terms in log space so large n does not overflow. */
function binomialCdf(k: number, n: number, p: number): number {
  if (p <= 0) return 1;
  if (p >= 1) return k >= n ? 1 : 0;
  let logChoose = 0;
  let sum = 0;
  for (let i = 0; i <= k; i++) {
    if (i > 0) logChoose += Math.log(n - i + 1) - Math.log(i);
    sum += Math.exp(logChoose + i * Math.log(p) + (n - i) * Math.log(1 - p));
  }
  return Math.min(1, sum);
}

/** The p in [0, 1] where a function that falls as p rises crosses `target`, by bisection. */
function solveDecreasing(f: (p: number) => number, target: number): number {
  let low = 0;
  let high = 1;
  for (let step = 0; step < STEPS; step++) {
    const mid = (low + high) / 2;
    if (f(mid) > target) low = mid;
    else high = mid;
  }
  return (low + high) / 2;
}

/**
 * Exact (Clopper-Pearson) two-sided confidence interval for a proportion with `successes` out of `n`. The lower bound
 * is the p where P(X >= successes) = alpha/2, the upper bound the p where P(X <= successes) = alpha/2.
 */
export function clopperPearson(successes: number, n: number, confidence = 0.95): { lower: number; upper: number } | null {
  if (n === 0) return null;
  const tail = (1 - confidence) / 2;
  const lower = successes === 0 ? 0 : solveDecreasing((p) => binomialCdf(successes - 1, n, p), 1 - tail);
  const upper = successes === n ? 1 : solveDecreasing((p) => binomialCdf(successes, n, p), tail);
  return { lower, upper };
}
