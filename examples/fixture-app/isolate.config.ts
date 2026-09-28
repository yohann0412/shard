export default {
  packageManager: 'pnpm',
  build: { command: 'pnpm build', outputs: ['dist'] },
  db: { migrate: 'node scripts/migrate.mjs', seed: 'node scripts/seed.mjs', urlEnv: 'DATABASE_URL', extraUrlEnvs: [] },
  app: { start: 'node dist/server.js', portEnv: 'PORT', healthPath: '/health', env: {}, bootTimeoutMs: 60000 },
  playwright: { config: 'playwright.config.ts', baseUrlEnvs: ['BASE_URL'], env: {} },
  cache: { inputs: ['../../pnpm-lock.yaml', 'package.json', 'migrations', 'scripts/migrate.mjs', 'scripts/seed.mjs', 'isolate.config.ts'] },
  trace: { clientRoots: [{ urlPrefix: '/js/', dir: 'public/js' }] },
};
