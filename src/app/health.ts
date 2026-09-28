import type { GroupProcess } from '../proc/group.js';
import { waitForReady } from '../proc/ready.js';

async function answersOk(url: string): Promise<boolean> {
  try {
    const response = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(2_000) });
    await response.body?.cancel();
    return response.status >= 200 && response.status < 400;
  } catch {
    return false;
  }
}

/**
 * Polls `http://127.0.0.1:<port><healthPath>` until it answers 2xx or 3xx. Fails early, with the tail of the app's
 * log, if the app exits, or after `timeoutMs` (`app.bootTimeoutMs`).
 */
export async function waitForHealthy(port: number, healthPath: string, app: GroupProcess, name: string, timeoutMs: number): Promise<void> {
  await waitForReady(() => answersOk(`http://127.0.0.1:${port}${healthPath}`), app, `app ${name}`, timeoutMs);
}
