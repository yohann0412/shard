import type { EnvEntry } from '../env-files.js';
import { relPath } from '../files.js';
import { found, guess, type Finding } from '../finding.js';
import type { PrismaSchema } from './prisma.js';

/** The variables the app reads its database URL from. */
export interface DatabaseEnvs {
  urlEnv: Finding<string>;
  extraUrlEnvs: Finding<string[]>;
}

const URL_KEY = /(DATABASE_URL|POSTGRES_URL|DB_URL)$/;

/**
 * The database URL variables: every variable the Prisma datasource reads, plus committed dotenv keys ending in
 * DATABASE_URL, POSTGRES_URL or DB_URL. All of them get the worker's database; DATABASE_URL (else the first) is the
 * main one. Falls back to DATABASE_URL.
 */
export function detectDatabaseEnvs(repoDir: string, prisma: PrismaSchema | null, env: EnvEntry[]): DatabaseEnvs {
  const sources = new Map<string, string>();
  if (prisma !== null) for (const key of prisma.urlEnvs) sources.set(key, `datasource of ${relPath(repoDir, prisma.schema)}`);
  for (const entry of env) if (URL_KEY.test(entry.key) && !sources.has(entry.key)) sources.set(entry.key, entry.file);
  const keys = [...sources.keys()];
  if (keys.length === 0) {
    const none = 'no Prisma datasource variable and no *DATABASE_URL, *POSTGRES_URL or *DB_URL key in a committed .env file';
    return { urlEnv: guess('DATABASE_URL', none), extraUrlEnvs: guess([], none) };
  }
  const urlEnv = keys.includes('DATABASE_URL') ? 'DATABASE_URL' : keys[0]!;
  const extras = keys.filter((key) => key !== urlEnv);
  const extraSources = [...new Set(extras.map((key) => sources.get(key)!))].join(', ');
  return { urlEnv: found(urlEnv, sources.get(urlEnv)!), extraUrlEnvs: found(extras, extraSources || sources.get(urlEnv)!) };
}
