import { fillPlaceholders, type WorkerValues } from '../app/env.js';
import type { IsolateConfig } from '../config/schema.js';
import { databaseUrlVars } from '../db/databases.js';

/**
 * The variables one Playwright worker gets through ISOLATE_WORKER_ENVS: its app's URL under every base-URL variable,
 * its database's URL under every database variable (for tests that seed directly), then `playwright.env` filled in.
 */
export function workerEnv(config: IsolateConfig, worker: WorkerValues): Record<string, string> {
  const baseUrls = Object.fromEntries(config.playwright.baseUrlEnvs.map((name) => [name, worker.url]));
  const configured = Object.fromEntries(Object.entries(config.playwright.env).map(([name, template]) => [name, fillPlaceholders(template, worker)]));
  return { ...baseUrls, ...databaseUrlVars(config, worker.dbUrl), ...configured, ISOLATE_BASE_URL: worker.url };
}
