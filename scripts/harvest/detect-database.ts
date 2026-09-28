import {
  appFiles,
  appPackages,
  capped,
  COMPOSE_FILE,
  composeImages,
  dependencies,
  DRIZZLE_CONFIG,
  ENV_EXAMPLE,
  envKeys,
  isAppPath,
  PRISMA_SCHEMA,
} from './patterns.js';
import type { RepoSnapshot } from './repo.js';
import type { Candidate } from './schema.js';

type Database = Candidate['database']['kind'];
type Orm = Candidate['orm']['kind'];
type Language = Candidate['backendLanguage']['kind'];

/** How much one file's evidence counts: a schema/dialect declaration, a driver or connection URL, or only a container. */
const SCHEMA = 3;
const DRIVER = 2;
const CONTAINER = 1;

/** One piece of database evidence. */
interface Hit {
  kind: Database;
  weight: number;
  file: string;
  text: string;
}

const PRISMA_PROVIDERS: Record<string, Database> = { postgresql: 'postgres', postgres: 'postgres', mysql: 'mysql', sqlite: 'sqlite', mongodb: 'mongodb' };
const DRIZZLE_DIALECTS: Record<string, Database> = {
  postgresql: 'postgres', pg: 'postgres', mysql: 'mysql', mysql2: 'mysql', singlestore: 'mysql',
  sqlite: 'sqlite', turso: 'sqlite', libsql: 'sqlite', 'better-sqlite': 'sqlite', d1: 'sqlite', 'd1-http': 'sqlite',
};
const URL_SCHEMES: Array<[RegExp, Database]> = [
  [/^postgres(ql)?:\/\//, 'postgres'],
  [/^(mysql|mariadb):\/\//, 'mysql'],
  [/^(file:|sqlite:)/, 'sqlite'],
  [/^mongodb(\+srv)?:\/\//, 'mongodb'],
];
const DB_TYPE_VALUES: Array<[RegExp, Database]> = [
  [/^(postgres(ql)?|pg)$/i, 'postgres'],
  [/^(mysql2?|mariadb)$/i, 'mysql'],
  [/^(sqlite3?|better-sqlite3)$/i, 'sqlite'],
  [/^mongo(db)?$/i, 'mongodb'],
];
const IMAGE_DATABASES: Array<[RegExp, Database]> = [
  [/ferretdb|documentdb/i, 'mongodb'],
  [/postgres|postgis|pgvector|timescale|paradedb/i, 'postgres'],
  [/(^|\/)(mysql|mariadb)|planetscale/i, 'mysql'],
  [/(^|\/)mongo(:|$)/i, 'mongodb'],
];
const DEPENDENCY_DATABASES: Array<[RegExp, Database]> = [
  [/^(pg|postgres|pg-promise|slonik|@neondatabase\/serverless|@vercel\/postgres|@electric-sql\/pglite|@payloadcms\/db-postgres|@mikro-orm\/postgresql|pg-boss)$/, 'postgres'],
  [/^(mysql|mysql2|@planetscale\/database|@mikro-orm\/mysql|@mikro-orm\/mariadb)$/, 'mysql'],
  [/^(better-sqlite3|sqlite3|@libsql\/client|@payloadcms\/db-sqlite|@mikro-orm\/sqlite)$/, 'sqlite'],
  [/^(mongodb|mongoose|@payloadcms\/db-mongodb|@mikro-orm\/mongodb)$/, 'mongodb'],
];
const CONNECTION_KEY = /(DATABASE|DB|MONGO|POSTGRES|MYSQL|PG)\w*(URL|URI|DSN)$/;
const TYPE_KEY = /^(DB_TYPE|DB_CLIENT|DB_DIALECT|DB_ENGINE|DATABASE_TYPE|DATABASE_CLIENT|DB_DRIVER)$/;
const POSTGRES_KEY = /^(POSTGRES_|PG(HOST|USER|DATABASE|PASSWORD|PORT)$)/;

function firstMatch(value: string, table: Array<[RegExp, Database]>): Database | null {
  return table.find(([pattern]) => pattern.test(value))?.[1] ?? null;
}

/** The spec's database evidence: a Prisma schema, a Drizzle config, a compose file mentioning postgres, or DATABASE_URL in an env example. */
export function databaseEvidence(repo: RepoSnapshot): string[] {
  const evidence = [
    ...repo.paths.filter((p) => PRISMA_SCHEMA.test(p)).map((p) => `${p}: Prisma schema`),
    ...repo.paths.filter((p) => DRIZZLE_CONFIG.test(p)).map((p) => `${p}: Drizzle config`),
    ...repo.fetched(COMPOSE_FILE).filter(([, text]) => /postgres/i.test(text)).map(([p]) => `${p}: mentions postgres`),
    ...repo.fetched(ENV_EXAMPLE).flatMap(([p, text]) => {
      if (/^\s*(export\s+)?DATABASE_URL\s*=/m.test(text)) return [`${p}: DATABASE_URL`];
      return /^\s*#\s*(export\s+)?DATABASE_URL\s*=/m.test(text) ? [`${p}: DATABASE_URL (commented out)`] : [];
    }),
  ];
  return capped(evidence);
}

function databaseHits(repo: RepoSnapshot): Hit[] {
  const hits: Hit[] = [];
  for (const [file, text] of appFiles(repo, PRISMA_SCHEMA)) {
    const provider = /datasource\s+\w+\s*\{[^}]*?provider\s*=\s*"(\w+)"/.exec(text)?.[1] ?? '';
    const kind = PRISMA_PROVIDERS[provider];
    if (kind) hits.push({ kind, weight: SCHEMA, file, text: `${file}: datasource provider "${provider}"` });
  }
  for (const [file, text] of appFiles(repo, DRIZZLE_CONFIG)) {
    const dialect = /\b(?:dialect|driver)\s*:\s*['"]([\w-]+)['"]/.exec(text)?.[1] ?? '';
    const kind = DRIZZLE_DIALECTS[dialect];
    if (kind) hits.push({ kind, weight: SCHEMA, file, text: `${file}: dialect "${dialect}"` });
  }
  for (const [file, text] of appFiles(repo, ENV_EXAMPLE)) {
    for (const { key, value } of envKeys(text)) {
      const driver = (CONNECTION_KEY.test(key) ? firstMatch(value, URL_SCHEMES) : null) ?? (TYPE_KEY.test(key) ? firstMatch(value, DB_TYPE_VALUES) : null);
      if (driver) hits.push({ kind: driver, weight: DRIVER, file, text: `${file}: ${key}=${value.slice(0, 40)}` });
      else if (POSTGRES_KEY.test(key)) hits.push({ kind: 'postgres', weight: CONTAINER, file, text: `${file}: ${key}` });
    }
  }
  for (const [file, text] of appFiles(repo, COMPOSE_FILE)) {
    for (const image of composeImages(text)) {
      const kind = firstMatch(image, IMAGE_DATABASES);
      if (kind) hits.push({ kind, weight: CONTAINER, file, text: `${file}: image ${image}` });
    }
  }
  for (const [file, manifest] of appPackages(repo)) {
    for (const dependency of dependencies(manifest)) {
      const kind = firstMatch(dependency, DEPENDENCY_DATABASES);
      if (kind) hits.push({ kind, weight: DRIVER, file, text: `${file}: dependency ${dependency}` });
    }
  }
  return hits;
}

/**
 * The app's main database by weighted evidence outside examples and docs: per file, a schema declaration counts 3,
 * a driver dependency or connection URL 2, a container image or POSTGRES_* key 1. The highest total wins; postgres wins ties.
 */
export function detectDatabase(repo: RepoSnapshot): Candidate['database'] {
  const hits = databaseHits(repo);
  const perFile = new Map<string, number>();
  for (const hit of hits) {
    const key = `${hit.kind}\0${hit.file}`;
    perFile.set(key, Math.max(perFile.get(key) ?? 0, hit.weight));
  }
  const scores = new Map<Database, number>();
  for (const [key, weight] of perFile) {
    const kind = key.split('\0')[0] as Database;
    scores.set(kind, (scores.get(kind) ?? 0) + weight);
  }
  const best = Math.max(0, ...scores.values());
  const leaders = [...scores].filter(([, score]) => score === best).map(([kind]) => kind);
  const kind: Database = leaders.includes('postgres') ? 'postgres' : (leaders[0] ?? 'unknown');
  const ordered = [...hits.filter((hit) => hit.kind === kind), ...hits.filter((hit) => hit.kind !== kind)];
  const summary = [...scores].map(([k, score]) => `${k} ${score}`).join(', ');
  const evidence = capped(ordered.map((hit) => `${hit.kind}: ${hit.text}`));
  return { kind, evidence: summary ? [...evidence, `scores: ${summary}`] : evidence };
}

/** Prisma schemas that generate the Prisma client (not only types for another query builder, e.g. prisma-kysely). */
function prismaClientSchemas(repo: RepoSnapshot): string[] {
  return appFiles(repo, PRISMA_SCHEMA)
    .filter(([, text]) => /generator\s+\w+\s*\{[^}]*?provider\s*=\s*"prisma-client(-js)?"/.test(text))
    .map(([p]) => `${p}: generator prisma-client`);
}

const ORM_RULES: Array<[Orm, RegExp, (repo: RepoSnapshot) => string[]]> = [
  ['prisma', /^@prisma\/client$/, prismaClientSchemas],
  ['drizzle', /^drizzle-orm$/, (repo) => repo.paths.filter((p) => DRIZZLE_CONFIG.test(p) && isAppPath(p))],
  ['typeorm', /^(typeorm|@nestjs\/typeorm)$/, () => []],
  ['mikro-orm', /^@mikro-orm\/core$/, () => []],
  ['sequelize', /^(sequelize|sequelize-typescript)$/, () => []],
  ['knex', /^knex$/, () => []],
  ['kysely', /^kysely$/, () => []],
];

/** The ORM or query builder of a Node backend: schema/config files first, then dependencies, in a fixed priority order. */
export function detectOrm(repo: RepoSnapshot, language: Language): Candidate['orm'] {
  const hits: Array<[Orm, string]> = [];
  for (const [kind, dependencyPattern, fileEvidence] of ORM_RULES) {
    hits.push(...fileEvidence(repo).map((text): [Orm, string] => [kind, text]));
    for (const [p, manifest] of appPackages(repo)) {
      const found = dependencies(manifest).filter((dependency) => dependencyPattern.test(dependency));
      hits.push(...found.map((dependency): [Orm, string] => [kind, `${p}: dependency ${dependency}`]));
    }
  }
  const kind = language === 'node' ? (hits[0]?.[0] ?? 'none') : 'unknown';
  return { kind, evidence: capped(hits.map(([k, text]) => `${k}: ${text}`)) };
}
