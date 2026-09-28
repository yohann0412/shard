import path from 'node:path';
import { isDir, isFile, readPackageJson, readText, relPath } from '../files.js';
import { found, type Finding } from '../finding.js';
import { filesInCommand, inDir, scriptCommand, type PackageManager } from '../scripts.js';
import type { PrismaSchema } from './prisma.js';

/** A database step (migrate or seed) and the files it reads, which key the cache (absolute paths). */
export interface DbStep {
  command: Finding<string>;
  inputs: string[];
}

/** Where to look and how to run things (absolute directories). */
export interface StepContext {
  repoDir: string;
  appDir: string;
  /** The app's directory, the repo's, then the other workspace packages. */
  dirs: string[];
  packageManager: PackageManager;
}

const MIGRATE_SCRIPTS = ['migrate', 'db:migrate', 'migration:run', 'prisma:migrate'];
const MIGRATION_DIRS = ['migrations', 'db/migrations', 'database/migrations', 'src/migrations', 'src/db/migrations'];

/** The first file with one of these names in any of the directories, or null. */
function firstFile(dirs: string[], names: string[]): string | null {
  return dirs.flatMap((dir) => names.map((name) => path.join(dir, name))).find(isFile) ?? null;
}

/** A directory named by `<key>: '<dir>'` in a config file, else the default, if it exists (absolute). */
function configuredDir(configFile: string, key: string, fallback: string): string[] {
  const named = new RegExp(String.raw`\b${key}\s*:\s*['"]([^'"]+)['"]`).exec(readText(configFile) ?? '')?.[1];
  const dir = path.resolve(path.dirname(configFile), named ?? fallback);
  return isDir(dir) ? [dir] : [];
}

/** Runs a package.json script of `dir`, reading the files its body names. */
export function scriptStep(ctx: StepContext, dir: string, script: string, source: string): DbStep {
  const body = readPackageJson(dir)?.scripts?.[script] ?? '';
  return { command: found(inDir(ctx.repoDir, dir, scriptCommand(ctx.packageManager, script)), source), inputs: filesInCommand(dir, body) };
}

/** Prisma: `migrate deploy` when there is a migrations directory, else `db push`. */
function prismaMigrate(ctx: StepContext, prisma: PrismaSchema): DbStep {
  const command = prisma.migrationsDir !== null ? 'npx prisma migrate deploy' : 'npx prisma db push --skip-generate';
  const source = `Prisma schema ${relPath(ctx.repoDir, prisma.schema)}${prisma.migrationsDir !== null ? ' with migrations' : ' without a migrations directory'}`;
  const inputs = [prisma.schema, ...(prisma.migrationsDir !== null ? [prisma.migrationsDir] : [])];
  return { command: found(inDir(ctx.repoDir, prisma.packageDir, command), source), inputs };
}

/** A package.json script (in any workspace package) that runs TypeORM or MikroORM migrations. */
function ormScript(ctx: StepContext): DbStep | null {
  for (const dir of ctx.dirs) {
    const scripts = Object.entries(readPackageJson(dir)?.scripts ?? {});
    const hit = scripts.find(([, body]) => /\btypeorm\b.*\bmigration:run\b|\bmikro-orm\b.*\bmigration:up\b/.test(body));
    if (hit) return scriptStep(ctx, dir, hit[0], `"${hit[0]}" script in ${relPath(ctx.repoDir, path.join(dir, 'package.json'))} runs ORM migrations`);
  }
  return null;
}

/** A package.json script of the app or the repo named migrate, db:migrate, migration:run or prisma:migrate. */
function namedScript(ctx: StepContext): DbStep | null {
  for (const dir of new Set([ctx.appDir, ctx.repoDir])) {
    const script = MIGRATE_SCRIPTS.find((name) => readPackageJson(dir)?.scripts?.[name] !== undefined);
    if (script === undefined) continue;
    const step = scriptStep(ctx, dir, script, `"${script}" script in ${relPath(ctx.repoDir, path.join(dir, 'package.json'))}`);
    const migrationDirs = MIGRATION_DIRS.map((name) => path.join(dir, name)).filter(isDir);
    return { ...step, inputs: [...migrationDirs, ...step.inputs] };
  }
  return null;
}

/**
 * The migrate command: Prisma, Drizzle (drizzle.config.*), Knex (knexfile.*), a TypeORM/MikroORM migration script,
 * else a script named migrate, db:migrate, migration:run or prisma:migrate. Null if none is found.
 */
export function detectMigrate(ctx: StepContext, prisma: PrismaSchema | null): DbStep | null {
  if (prisma !== null) return prismaMigrate(ctx, prisma);
  const drizzle = firstFile(ctx.dirs, ['drizzle.config.ts', 'drizzle.config.js', 'drizzle.config.mjs', 'drizzle.config.cjs', 'drizzle.config.json']);
  if (drizzle !== null) {
    const command = found(inDir(ctx.repoDir, path.dirname(drizzle), 'npx drizzle-kit migrate'), relPath(ctx.repoDir, drizzle));
    return { command, inputs: [drizzle, ...configuredDir(drizzle, 'out', 'drizzle')] };
  }
  const knexfile = firstFile(ctx.dirs, ['knexfile.ts', 'knexfile.js', 'knexfile.mjs', 'knexfile.cjs']);
  if (knexfile !== null) {
    const command = found(inDir(ctx.repoDir, path.dirname(knexfile), 'npx knex migrate:latest'), relPath(ctx.repoDir, knexfile));
    return { command, inputs: [knexfile, ...configuredDir(knexfile, 'directory', 'migrations')] };
  }
  return ormScript(ctx) ?? namedScript(ctx);
}
