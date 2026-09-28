import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { copyFixture, isolate, readJson, removeDir } from './helpers.js';

interface Report {
  cache: { hit: boolean; key: string } | null;
  phases: Record<string, number>;
}

test('a second run restores the seeded state from cache instead of rebuilding', async () => {
  const dir = copyFixture();
  try {
    const configFile = path.join(dir, 'isolate.config.ts');
    writeFileSync(
      configFile,
      readFileSync(configFile, 'utf8')
        .replace("command: 'pnpm build'", "command: 'mkdir -p .isolate && echo build >> .isolate/side-effects.log && pnpm build'")
        .replace("migrate: 'node scripts/migrate.mjs'", "migrate: 'mkdir -p .isolate && echo migrate >> .isolate/side-effects.log && node scripts/migrate.mjs'")
        .replace("seed: 'node scripts/seed.mjs'", "seed: 'mkdir -p .isolate && echo seed >> .isolate/side-effects.log && node scripts/seed.mjs'"),
    );
    const args = ['run', '--workers', '2', '--', 'npx', 'playwright', 'test'];
    const first = await isolate(args, { cwd: dir });
    assert.equal(first.exitCode, 0, first.all);
    assert.match(first.all ?? '', /cache miss/i);

    const second = await isolate(args, { cwd: dir });
    assert.equal(second.exitCode, 0, second.all);
    assert.match(second.all ?? '', /cache hit/i);
    assert.match(second.all ?? '', /restored .*in \d+(\.\d+)?\s?ms/i);

    const sideEffects = readFileSync(path.join(dir, '.isolate', 'side-effects.log'), 'utf8').split('\n').filter(Boolean);
    assert.deepEqual(sideEffects, ['build', 'migrate', 'seed'], 'build, migrate and seed must each have run exactly once across both runs');

    const report = readJson<Report>(path.join(dir, '.isolate', 'report.json'));
    assert.equal(report.cache?.hit, true);
    assert.equal(typeof report.phases.restore, 'number');
    assert.equal(report.phases.build, undefined, 'build must be skipped on a cache hit');
    assert.equal(report.phases.migrateSeed, undefined, 'migrate and seed must be skipped on a cache hit');
  } finally {
    removeDir(dir);
  }
});
