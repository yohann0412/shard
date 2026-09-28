import { z } from 'zod';

const Evidence = z.array(z.string());

/** A repository to scan, with its star count (null when unavailable) and where that count came from. */
export interface PoolEntry {
  url: string;
  name: string;
  stars: number | null;
  starsSource: string;
}

/** The e2e command: a package.json script or Nx target; `direct` when it runs `playwright test` itself, not a wrapper. */
export const E2EScriptSchema = z.object({
  file: z.string(),
  name: z.string(),
  command: z.string(),
  direct: z.boolean(),
});
export type E2EScript = z.infer<typeof E2EScriptSchema>;

/** One unmanaged service or third-party API the app appears to need. */
export const ServiceSchema = z.object({
  name: z.string(),
  kind: z.enum(['service', 'third-party']),
  evidence: Evidence,
  referencedByE2E: z.boolean(),
  requiredByE2E: z.boolean(),
});
export type Service = z.infer<typeof ServiceSchema>;

/** Main database of the app; `unknown` when no evidence outside examples and docs. */
const DATABASES = ['postgres', 'mysql', 'sqlite', 'mongodb', 'unknown'] as const;
/** ORM of a Node backend; `none` for a Node backend without one, `unknown` for other backends. */
const ORMS = ['prisma', 'drizzle', 'typeorm', 'knex', 'sequelize', 'kysely', 'mikro-orm', 'none', 'unknown'] as const;
/** Backend language; JVM languages (Kotlin, Scala, Clojure) count as `java`. */
const LANGUAGES = ['node', 'go', 'python', 'ruby', 'php', 'java', 'rust', 'elixir', 'dotnet', 'unknown'] as const;

/** Everything recorded for a repository that meets the search criteria. */
export const CandidateSchema = z.object({
  url: z.string().url(),
  name: z.string(),
  headCommit: z.string().regex(/^[0-9a-f]{40}$/),
  stars: z.number().int().nullable(),
  starsSource: z.string(),
  meetsStarFilter: z.union([z.boolean(), z.literal('unknown')]),
  lastPush: z.string(),
  lastPushSource: z.literal('HEAD commit date'),
  playwrightVersion: z.object({
    range: z.string().nullable(),
    package: z.string().nullable(),
    packageJson: z.string().nullable(),
    note: z.string().nullable(),
  }),
  playwrightConfigPath: z.string(),
  otherPlaywrightConfigs: z.array(z.string()),
  configuredWorkers: z.string().nullable(),
  fullyParallel: z.string().nullable(),
  hasWebServer: z.boolean(),
  webServerCommand: z.string().nullable(),
  baseURLSource: z.enum(['env', 'hardcoded', 'none', 'unknown']),
  baseURLExpression: z.string().nullable(),
  globalSetup: z.boolean(),
  setupProjects: z.boolean(),
  database: z.object({ kind: z.enum(DATABASES), evidence: Evidence }),
  orm: z.object({ kind: z.enum(ORMS), evidence: Evidence }),
  unmanagedServices: z.array(ServiceSchema),
  backendLanguage: z.object({ kind: z.enum(LANGUAGES), evidence: Evidence }),
  e2eScript: E2EScriptSchema.nullable(),
  documentedE2E: z.object({ value: z.boolean(), evidence: Evidence }),
  class: z.enum(['A', 'B', 'C']),
  classReasons: z.array(z.string()).min(1),
  blockers: z.array(z.string()),
});
export type Candidate = z.infer<typeof CandidateSchema>;

/** Why a scanned repository does not qualify: the first failed check, in scan order. */
const EXCLUSION_REASONS = [
  'low stars',
  'clone failed',
  'timeout',
  'duplicate',
  'stale',
  'no playwright config',
  'no DB evidence',
] as const;

/** A scanned repository that does not meet the criteria, and the first criterion it failed. */
export const ExcludedSchema = z.object({
  url: z.string(),
  reason: z.enum(EXCLUSION_REASONS),
  detail: z.string(),
});
export type Excluded = z.infer<typeof ExcludedSchema>;

/** The whole `data/repos.json` document. */
export const HarvestSchema = z.object({
  harvestedAt: z.string(),
  sources: z.object({
    seedList: z.array(z.string()),
    awesomeSelfhostedData: z.object({
      url: z.string(),
      commit: z.string(),
      commitDate: z.string(),
      entries: z.number().int(),
      pool: z.number().int(),
      poolFilteredOut: z.record(z.string(), z.number().int()),
    }),
  }),
  criteria: z.object({
    playwrightConfig: z.string(),
    minStars: z.number().int(),
    lastPushAfter: z.string(),
    databaseEvidence: z.array(z.string()),
    target: z.number().int(),
    order: z.string(),
  }),
  counts: z.object({
    scanned: z.number().int(),
    qualified: z.number().int(),
    notScanned: z.number().int(),
    byClass: z.object({ A: z.number().int(), B: z.number().int(), C: z.number().int() }),
    byExclusionReason: z.record(z.string(), z.number().int()),
  }),
  candidates: z.array(CandidateSchema),
  excluded: z.array(ExcludedSchema),
});
export type Harvest = z.infer<typeof HarvestSchema>;
