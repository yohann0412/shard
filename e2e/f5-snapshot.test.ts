import assert from 'node:assert/strict';
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
    const args = ['run', '--workers', '2', '--', 'npx', 'playwright', 'test'];
    const first = await isolate(args, { cwd: dir });
    assert.equal(first.exitCode, 0, first.all);
    assert.match(first.all ?? '', /cache miss/i);

    const second = await isolate(args, { cwd: dir });
    assert.equal(second.exitCode, 0, second.all);
    assert.match(second.all ?? '', /cache hit/i);
    assert.match(second.all ?? '', /restored .*in \d+(\.\d+)?\s?ms/i);

    const report = readJson<Report>(path.join(dir, '.isolate', 'report.json'));
    assert.equal(report.cache?.hit, true);
    assert.equal(typeof report.phases.restore, 'number');
    assert.equal(report.phases.build, undefined, 'build must be skipped on a cache hit');
    assert.equal(report.phases.migrateSeed, undefined, 'migrate and seed must be skipped on a cache hit');
  } finally {
    removeDir(dir);
  }
});
