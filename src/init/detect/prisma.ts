import { readdirSync } from 'node:fs';
import path from 'node:path';
import { isDir, isFile, readPackageJson, readText } from '../files.js';

/** A Prisma schema and what it says about the database. */
export interface PrismaSchema {
  /** The schema file, or the folder of a multi-file schema (absolute). */
  schema: string;
  /** The package directory Prisma commands run in (absolute). */
  packageDir: string;
  /** The migrations directory next to the datasource, if it exists (absolute). */
  migrationsDir: string | null;
  /** Every variable the datasource's `url` and `directUrl` read, in order. */
  urlEnvs: string[];
  /** The seed command from package.json `prisma.seed` or prisma.config.ts `seed`, if any. */
  seed: string | null;
}

/** The schema file or folder Prisma would use in a package directory, or null. */
function schemaPath(dir: string): string | null {
  const configured = readPackageJson(dir)?.prisma?.schema;
  const candidates = [configured, 'prisma/schema.prisma', 'schema.prisma', 'prisma/schema'].filter((c) => c !== undefined);
  for (const candidate of candidates) {
    const full = path.resolve(dir, candidate);
    if (isFile(full) || (isDir(full) && readdirSync(full).some((name) => name.endsWith('.prisma')))) return full;
  }
  return null;
}

/** The `.prisma` files of a schema path, with their text. */
function schemaFiles(schema: string): Array<{ file: string; text: string }> {
  const files = isFile(schema) ? [schema] : readdirSync(schema).filter((name) => name.endsWith('.prisma')).map((name) => path.join(schema, name));
  return files.map((file) => ({ file, text: readText(file) ?? '' }));
}

/**
 * The variables a datasource field reads: `field = env("X")` in a schema, or every `env('X')` and `process.env.X` in
 * the field's value in prisma.config.ts (e.g. `url: process.env.DIRECT_URL || process.env.DATABASE_URL`).
 */
function envsOf(text: string, field: string): string[] {
  const value = new RegExp(String.raw`\b${field}\s*[=:]([\s\S]*?)(?:,\s*\n|\n\s*\}|\n\s*\w+\s*[=:])`).exec(`${text}\n}`)?.[1] ?? '';
  return [...value.matchAll(/\benv\(\s*['"](\w+)['"]\s*\)|process\.env\.(\w+)/g)].map((match) => (match[1] ?? match[2])!);
}

/** Reads one package directory's Prisma setup, or null if it has no schema. */
function readPrisma(dir: string): PrismaSchema | null {
  const schema = schemaPath(dir);
  if (schema === null) return null;
  const files = schemaFiles(schema);
  const datasource = files.find(({ text }) => /\bdatasource\s+\w+\s*\{/.test(text)) ?? files[0];
  const block = /\bdatasource\s+\w+\s*\{([^}]*)\}/.exec(datasource?.text ?? '')?.[1] ?? '';
  const config = ['prisma.config.ts', 'prisma.config.mts', 'prisma.config.js', 'prisma.config.mjs'].map((name) => readText(path.join(dir, name))).find((text) => text !== null) ?? '';
  const migrationsDir = path.join(path.dirname(datasource?.file ?? schema), 'migrations');
  return {
    schema,
    packageDir: dir,
    migrationsDir: isDir(migrationsDir) ? migrationsDir : null,
    urlEnvs: [...new Set([block, config].flatMap((text) => [...envsOf(text, 'url'), ...envsOf(text, 'directUrl')]))],
    seed: readPackageJson(dir)?.prisma?.seed ?? /\bseed\s*:\s*['"`]([^'"`]+)['"`]/.exec(config)?.[1] ?? null,
  };
}

/** The first Prisma schema in these package directories (the app's own first), or null. */
export function findPrisma(dirs: string[]): PrismaSchema | null {
  for (const dir of dirs) {
    const prisma = readPrisma(dir);
    if (prisma !== null) return prisma;
  }
  return null;
}
