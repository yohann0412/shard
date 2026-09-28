import type { IsolateConfig } from '../config/schema.js';
import { log } from '../log.js';
import { buildKey, databaseKey, type BuildConfig } from './key.js';
import { findEntry } from './store.js';

/** One kind of cache entry for one stack start: its key, and the entry to restore from on a hit. */
export interface EntryPlan<Key> {
  key: Key;
  /** Undefined on a miss, and always when refreshing. */
  entry: string | undefined;
}

/** What the cache holds for one stack start. */
export interface CachePlan {
  db: EntryPlan<string>;
  /** Null when this start does not build; the key is undefined when the build cannot be keyed and always runs. */
  build: EntryPlan<string | undefined> | null;
}

/** What the cache did for one stack start, as written into the report. */
export interface CacheOutcome {
  /** True when every entry this start needed was restored: the database, and the build if there was one. */
  hit: boolean;
  /** The database key. */
  key: string;
  db: { hit: boolean; key: string };
  /** Null when this start did not build; the key is null when the build could not be keyed. */
  build: { hit: boolean; key: string | null } | null;
}

/** What planCache needs. */
export interface PlanOptions {
  repoDir: string;
  config: IsolateConfig;
  postgresVersion: string;
  /** The build this start runs, or undefined when it does not build. */
  build: BuildConfig | undefined;
  /** Ignore existing entries, so everything is rebuilt and the entries are overwritten. */
  refresh: boolean;
}

/** The first 8 characters of a key, as printed. */
export function shortKey(key: string): string {
  return key.slice(0, 8);
}

/** A size as printed: whole kilobytes below 1 MB, else megabytes with one decimal. */
export function formatSize(bytes: number): string {
  return bytes < 1024 * 1024 ? `${Math.ceil(bytes / 1024)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** Computes the keys, looks up both entries, and prints one `cache miss (...)` line naming whatever is not cached. */
export async function planCache(options: PlanOptions): Promise<CachePlan> {
  const { repoDir, config, postgresVersion, refresh } = options;
  const dbKey = databaseKey(repoDir, config, postgresVersion);
  const lookUp = (kind: 'db' | 'build', key: string | undefined) => (refresh || key === undefined ? undefined : findEntry(repoDir, kind, key));
  const db = { key: dbKey, entry: lookUp('db', dbKey) };
  let build: EntryPlan<string | undefined> | null = null;
  if (options.build !== undefined) {
    const key = await buildKey(repoDir, options.build, dbKey);
    build = { key, entry: lookUp('build', key) };
  }

  const misses = db.entry === undefined ? [`db ${shortKey(db.key)}`] : [];
  if (build !== null && build.entry === undefined) misses.push(build.key === undefined ? 'build not cacheable' : `build ${shortKey(build.key)}`);
  if (misses.length > 0) log.info(`${refresh ? 'cache refresh' : 'cache miss'} (${misses.join(', ')})`);
  return { db, build };
}

/** The report's view of a plan. */
export function cacheOutcome(plan: CachePlan): CacheOutcome {
  const db = { hit: plan.db.entry !== undefined, key: plan.db.key };
  const build = plan.build === null ? null : { hit: plan.build.entry !== undefined, key: plan.build.key ?? null };
  return { hit: db.hit && (build === null || build.hit), key: db.key, db, build };
}
