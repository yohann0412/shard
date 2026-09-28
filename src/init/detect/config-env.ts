import type { EnvEntry } from '../env-files.js';
import { templatePort } from '../port-template.js';
import { BUILD_TIME_PREFIX } from './self-urls.js';

/** The variables the Playwright config loaded into its own environment (webServer inherits them), split by origin. */
export interface ConfigEnv {
  /** Values a committed dotenv file holds verbatim: safe to write into app.env (port templated). */
  committed: Record<string, string>;
  /** The committed files those values are in. */
  files: string[];
  /** Keys whose values are in no committed file (e.g. a developer's own .env): reported, never written. */
  uncommitted: string[];
}

/**
 * Splits the variables the config added while loading (e.g. `dotenv.config({ path: '.env.test' })`) into those a
 * committed dotenv file holds and the rest, skipping those isolate sets itself and build-time ones.
 */
export function configLoadedEnv(added: Record<string, string>, committed: EnvEntry[], port: number | null, managed: string[]): ConfigEnv {
  const result: ConfigEnv = { committed: {}, files: [], uncommitted: [] };
  for (const [key, value] of Object.entries(added)) {
    if (managed.includes(key) || BUILD_TIME_PREFIX.test(key)) continue;
    const entry = committed.find((candidate) => candidate.key === key && candidate.value === value);
    if (entry === undefined) {
      result.uncommitted.push(key);
      continue;
    }
    result.committed[key] = templatePort(value, port);
    if (!result.files.includes(entry.file)) result.files.push(entry.file);
  }
  return result;
}
