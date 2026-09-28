/** Median, minimum and maximum of a sample. */
export interface Spread {
  n: number;
  median: number;
  min: number;
  max: number;
}

/** Rounds to `digits` decimals, for readable JSON. */
export function round(value: number, digits = 3): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

/** The median of a non-empty sample (the mean of the two middle values for an even size). */
export function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

/** Median, min and max of a sample, or null for an empty one. */
export function spread(values: number[]): Spread | null {
  if (values.length === 0) return null;
  return { n: values.length, median: round(median(values), 1), min: round(Math.min(...values), 1), max: round(Math.max(...values), 1) };
}

/** a / b rounded, or null when either is missing or b is zero. */
export function ratio(a: number | null | undefined, b: number | null | undefined): number | null {
  if (a === null || a === undefined || b === null || b === undefined || b === 0) return null;
  return round(a / b);
}

/** |a ∩ b| / |a ∪ b|, or null when both sets are empty. */
export function jaccard<T>(a: Set<T>, b: Set<T>): number | null {
  const union = new Set([...a, ...b]);
  if (union.size === 0) return null;
  const shared = [...a].filter((item) => b.has(item)).length;
  return shared / union.size;
}
