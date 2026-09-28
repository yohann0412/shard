import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { copyFixture, isolate, readJson, removeDir } from './helpers.js';

interface PwResults {
  tests: { title: string; status: string; parallelIndex: number }[];
}

/** A globalSetup like EverShop's: signs in once, saves the session cookie, writes a row, and keeps a pool open. */
const GLOBAL_SETUP = `import { request } from '@playwright/test';
import pg from 'pg';

export default async function globalSetup(): Promise<void> {
  const context = await request.newContext({ baseURL: process.env.BASE_URL });
  const response = await context.post('/signin', { form: { email: 'alice@example.com', password: 'alice-password' } });
  if (!response.ok()) throw new Error(\`sign-in failed: \${response.status()}\`);
  await context.storageState({ path: '.auth/alice.json' });
  await context.dispose();
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  await pool.query("insert into items (name) values ('Made by globalSetup')");
  // Left open on purpose, as suites that close their pool in globalTeardown do.
  (globalThis as { setupPool?: pg.Pool }).setupPool = pool;
}
`;

/** Eight tests that each need globalSetup's session and row, spread over the workers. */
const SPEC = `import { expect, test } from '@playwright/test';
import { BASE_URL } from './helpers';

test.use({ storageState: '.auth/alice.json' });
test.describe.configure({ mode: 'parallel' });

for (let i = 0; i < 8; i++) {
  test(\`signed in by globalSetup \${i}\`, async ({ page, request }) => {
    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'Welcome, Alice' })).toBeVisible();
    const names = ((await (await request.get(\`\${BASE_URL}/api/items\`)).json()) as { name: string }[]).map((item) => item.name);
    expect(names).toContain('Made by globalSetup');
    await page.waitForTimeout(500);
  });
}
`;

/** Adds the globalSetup and its spec to a fixture copy; `mode` goes into isolate.config.ts as playwright.globalSetup. */
function withGlobalSetup(dir: string, mode: 'fan-out' | 'worker0'): void {
  writeFileSync(path.join(dir, 'tests', 'global-setup.ts'), GLOBAL_SETUP);
  writeFileSync(path.join(dir, 'tests', 'from-global-setup.spec.ts'), SPEC);
  const configFile = path.join(dir, 'playwright.config.ts');
  writeFileSync(configFile, readFileSync(configFile, 'utf8').replace("testDir: './tests',", "testDir: './tests',\n  globalSetup: './tests/global-setup.ts',"));
  const isolateConfig = path.join(dir, 'isolate.config.ts');
  writeFileSync(isolateConfig, readFileSync(isolateConfig, 'utf8').replace("baseUrlEnvs: ['BASE_URL'],", `baseUrlEnvs: ['BASE_URL'], globalSetup: '${mode}',`));
}

const COMMAND = ['--', 'npx', 'playwright', 'test', 'tests/from-global-setup.spec.ts'];

test("globalSetup runs once against w0 and w0 is copied to every worker, so its session and rows reach them all", async () => {
  const dir = copyFixture();
  try {
    withGlobalSetup(dir, 'fan-out');
    const run = await isolate(['run', '--workers', '4', '--no-rerun', ...COMMAND], { cwd: dir });
    assert.equal(run.exitCode, 0, run.all);
    const results = readJson<PwResults>(path.join(dir, '.isolate', 'pw-results.json'));
    assert.equal(results.tests.filter((t) => t.status === 'passed').length, 8, run.all);
    const workers = new Set(results.tests.map((t) => t.parallelIndex));
    assert.ok(workers.size >= 2, `the tests must run on several workers (ran on ${[...workers].join(', ')})`);
    const report = readJson<{ phases: Record<string, number> }>(path.join(dir, '.isolate', 'report.json'));
    assert.ok((report.phases.globalSetup ?? 0) > 0, 'the report must time the globalSetup run');
  } finally {
    removeDir(dir);
  }

  // Control: without the fan-out, globalSetup's session and row exist in w0 only, so the other workers fail.
  const control = copyFixture();
  try {
    withGlobalSetup(control, 'worker0');
    const run = await isolate(['run', '--workers', '4', '--no-rerun', ...COMMAND], { cwd: control });
    assert.notEqual(run.exitCode, 0, 'without the fan-out the workers other than w0 must fail');
    const results = readJson<PwResults>(path.join(control, '.isolate', 'pw-results.json'));
    const failedElsewhere = results.tests.filter((t) => t.status !== 'passed' && t.parallelIndex !== 0);
    assert.ok(failedElsewhere.length > 0, 'tests on workers other than w0 must fail without the fan-out');
  } finally {
    removeDir(control);
  }
});
