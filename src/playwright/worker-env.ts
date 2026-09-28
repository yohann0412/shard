import { fillPlaceholders, type WorkerValues } from '../app/env.js';
import type { IsolateConfig } from '../config/schema.js';
import { databaseUrlVars } from '../db/databases.js';

/**
 * The variables one Playwright worker gets through ISOLATE_WORKER_ENVS: the URL its browser uses for its app (the shared
 * origin, or the app's own URL) under every base-URL variable, its database's URL under every database variable (for
 * tests that seed directly), then `playwright.env` filled in. ISOLATE_APP_INDEX is the worker's x-isolate-worker value.
 */
export function workerEnv(config: IsolateConfig, worker: WorkerValues): Record<string, string> {
  const baseUrls = Object.fromEntries(config.playwright.baseUrlEnvs.map((name) => [name, worker.origin]));
  const configured = Object.fromEntries(Object.entries(config.playwright.env).map(([name, template]) => [name, fillPlaceholders(template, worker)]));
  return { ...baseUrls, ...databaseUrlVars(config, worker.dbUrl), ...configured, ISOLATE_BASE_URL: worker.origin, ISOLATE_APP_INDEX: String(worker.index) };
}
