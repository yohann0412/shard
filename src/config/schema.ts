import { z } from 'zod';

/** Values in `app.env`, `playwright.env` and `app.start` may use {i}, {port}, {url} and {db} (the worker's database URL); they are filled in per worker. */
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
  }),
  app: z.object({
    start: z.string().min(1),
    portEnv: z.string().default('PORT'),
    healthPath: z.string().default('/'),
    env: envMap,
    bootTimeoutMs: z.number().int().positive().default(120_000),
  }),
  playwright: z.object({
    config: z.string().min(1),
    baseUrlEnvs: z.array(z.string()).default(['BASE_URL']),
    env: envMap,
  }),
  postgres: z
    .object({
      binDir: z.string().optional(),
      sharedBuffers: z.string().optional(),
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
