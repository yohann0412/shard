import type { IsolateConfig } from '../config/schema.js';
import { databaseUrlVars } from '../db/databases.js';

/** One worker's values, substituted into configured env templates. */
export interface WorkerValues {
  /** Worker index, for `{i}`. */
  index: number;
  /** App port, for `{port}`. */
  port: number;
  /** App base URL (http://127.0.0.1:<port>), for `{url}`. */
  url: string;
  /** Worker database URL, for `{db}`. */
  dbUrl: string;
}

/** Replaces `{i}`, `{port}`, `{url}` and `{db}` in a template with one worker's values. */
export function fillPlaceholders(template: string, worker: WorkerValues): string {
  return template
    .replaceAll('{i}', String(worker.index))
    .replaceAll('{port}', String(worker.port))
    .replaceAll('{url}', worker.url)
    .replaceAll('{db}', worker.dbUrl);
}

/**
 * Environment of worker i's app: the process environment, then `app.env` with placeholders filled in, then the port
 * variable, the database URL variables and ISOLATE_WORKER_INDEX (later entries win).
 */
export function appEnv(config: IsolateConfig, worker: WorkerValues): NodeJS.ProcessEnv {
  const configured = Object.entries(config.app.env).map(([name, template]) => [name, fillPlaceholders(template, worker)]);
  return {
    ...process.env,
    ...Object.fromEntries(configured),
    [config.app.portEnv]: String(worker.port),
    ...databaseUrlVars(config, worker.dbUrl),
    ISOLATE_WORKER_INDEX: String(worker.index),
  };
}
