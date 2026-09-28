import { setTimeout as sleep } from 'node:timers/promises';

/** Polls `predicate` every `intervalMs` until it holds or `timeoutMs` passes; returns whether it held. */
export async function waitUntil(predicate: () => boolean, timeoutMs: number, intervalMs = 100): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) return false;
    await sleep(intervalMs);
  }
  return true;
}

/** Resolves true if `promise` settles within `timeoutMs`, false otherwise; never rejects. */
export async function settlesWithin(promise: Promise<unknown>, timeoutMs: number): Promise<boolean> {
  const timeout = new AbortController();
  const timedOut = sleep(timeoutMs, false, { signal: timeout.signal }).catch(() => false);
  const settled = promise.then(
    () => true,
    () => true,
  );
  const result = await Promise.race([settled, timedOut]);
  timeout.abort();
  return result;
}
