import { z } from 'zod';

/**
 * Values in `app.env`, `playwright.env` and `app.start` may use {i}, {port}, {url} (the app's own URL), {origin} (the
 * shared origin, or the app's own URL without one), {db} (the worker's database URL) and that URL's parts {dbHost},
 * {dbPort}, {dbName}, {dbUser}, {dbPassword}; they are filled in per worker.
 */
const envMap = z.record(z.string(), z.string()).default({});

/** Schema of `isolate.config.ts`. */
export const configSchema = z.object({
  packageManager: z.enum(['pnpm', 'npm', 'yarn', 'bun']),
  build: z
    .object({
      command: z.string().min(1),
      outputs: z.array(z.string()).default([]),
      /** Files and directories the build reads; they key the build cache. Default: every git-tracked or untracked-not-ignored file. */
      inputs: z.array(z.string()).optional(),
    })
    .optional(),
  db: z.object({
    migrate: z.string().min(1),
    seed: z.string().min(1).optional(),
    urlEnv: z.string().default('DATABASE_URL'),
    extraUrlEnvs: z.array(z.string()).default([]),
    /**
     * More variables that point at the database, set wherever the URL variables are (migrate, seed, apps, Playwright):
     * {db} and the URL's parts {dbHost}, {dbPort}, {dbName}, {dbUser}, {dbPassword}, e.g. { DB_NAME: '{dbName}' }.
     */
    env: envMap,
  }),
  app: z.object({
    start: z.string().min(1),
    portEnv: z.string().default('PORT'),
    healthPath: z.string().default('/'),
    env: envMap,
    bootTimeoutMs: z.number().int().positive().default(120_000),
    /** Host in each app's URL ({url}, and the browser's base URL): `localhost` for an app that builds its links from it. */
    urlHost: z.enum(['127.0.0.1', 'localhost']).default('127.0.0.1'),
  }),
  playwright: z.object({
    config: z.string().min(1),
    baseUrlEnvs: z.array(z.string()).default(['BASE_URL']),
    env: envMap,
    /** The origin the app's build baked in (e.g. http://localhost:3201); like `--shared-origin` (DECISIONS D-014). */
    sharedOrigin: z.string().optional(),
    /**
     * `fan-out` (default): run the config's globalSetup once against w0, then copy w0's database to every worker
     * (DECISIONS D-015). `worker0`: run it inside the test run as Playwright does, so its writes reach w0 only.
     */
    globalSetup: z.enum(['fan-out', 'worker0']).default('fan-out'),
  }),
  postgres: z
    .object({
      binDir: z.string().optional(),
      sharedBuffers: z.string().optional(),
      /** Overrides the default max_connections (50 + 40 per worker), e.g. for a suite whose own config runs 10 workers. */
      maxConnections: z.number().int().positive().optional(),
    })
    .default({}),
  cache: z.object({ inputs: z.array(z.string()).default([]) }).default({ inputs: [] }),
  unmanaged: z
    .object({
      allow: z.boolean().default(false),
      services: z.array(z.string()).default([]),
    })
    .default({ allow: false, services: [] }),
  trace: z
    .object({
      clientRoots: z.array(z.object({ urlPrefix: z.string(), dir: z.string() })).default([]),
    })
    .default({ clientRoots: [] }),
});

/** A validated isolate configuration with defaults applied. */
export type IsolateConfig = z.infer<typeof configSchema>;
