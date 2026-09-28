import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fixtureDir, isolate, readJson, sh } from './helpers.js';

interface PwResults {
  tests: { id: string; title: string; status: string; parallelIndex: number }[];
}

test('isolate run at workers 4 passes the tests that collide without it, and routes each worker to its own app', async () => {
  const collide = await sh('pnpm run test:collide -- --reporter=json');
  const report = JSON.parse(collide.stdout.slice(collide.stdout.indexOf('{'))) as {
    suites: { specs: { title: string; ok: boolean }[]; suites?: { specs: { title: string; ok: boolean }[] }[] }[];
  };
  const collided = report.suites.flatMap((s) => [...s.specs, ...(s.suites ?? []).flatMap((c) => c.specs)]).filter((s) => !s.ok).map((s) => s.title);
  assert.ok(collided.length > 0, 'the collide run must have failures to fix');

  const run = await isolate(['run', '--workers', '4', '--tag-requests', '--', 'npx', 'playwright', 'test']);
  assert.equal(run.exitCode, 0, run.all);
  assert.match(run.all ?? '', /hardcoded URL/i, 'absolute URLs in test files must be reported');

  const results = readJson<PwResults>(path.join(fixtureDir, '.isolate', 'pw-results.json'));
  for (const title of collided) {
    const result = results.tests.find((t) => t.title === title);
    assert.equal(result?.status, 'passed', `${title} still fails under isolation`);
  }

  let workersWithTraffic = 0;
  for (let i = 0; i < 4; i++) {
    const lines = readFileSync(path.join(fixtureDir, '.isolate', 'logs', `w${i}.log`), 'utf8').split('\n');
    const tags = lines.map((l) => /worker=(\S+)/.exec(l)?.[1]).filter((t): t is string => t !== undefined && t !== '-');
    if (tags.length > 0) workersWithTraffic++;
    assert.deepEqual([...new Set(tags)].filter((t) => t !== String(i)), [], `w${i}.log has requests from other workers`);
  }
  assert.ok(workersWithTraffic >= 2, 'at least two workers must have sent traffic');
});
