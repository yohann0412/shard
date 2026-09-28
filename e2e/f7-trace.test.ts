import assert from 'node:assert/strict';
import { appendFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { copyFixture, isolate, readJson, removeDir, sh } from './helpers.js';

interface ImpactMap {
  global: string[];
  tests: Record<string, { server: string[]; client: string[] }>;
}

const GIT_ENV = { GIT_AUTHOR_NAME: 'e2e', GIT_AUTHOR_EMAIL: 'e2e@example.com', GIT_COMMITTER_NAME: 'e2e', GIT_COMMITTER_EMAIL: 'e2e@example.com' };

test('trace builds a map; affected names only the item tests for an items edit and "all" for a db edit', async () => {
  const dir = copyFixture();
  try {
    assert.equal((await sh('git init -q && git add -A && git commit -qm base', { cwd: dir, env: GIT_ENV })).exitCode, 0);
    const trace = await isolate(['trace', '--workers', '2', '--', 'npx', 'playwright', 'test'], { cwd: dir });
    assert.equal(trace.exitCode, 0, trace.all);

    const map = readJson<ImpactMap>(path.join(dir, '.isolate', 'map.json'));
    assert.ok(map.global.includes('src/db.ts'), `global set: ${map.global.join(', ')}`);
    assert.ok(Object.keys(map.tests).length >= 8);
    assert.ok(Object.values(map.tests).some((t) => t.client.length > 0), 'client coverage must be recorded');

    appendFileSync(path.join(dir, 'src', 'routes', 'items.ts'), '\n// edited by e2e\n');
    const items = await isolate(['affected', '--base', 'HEAD'], { cwd: dir });
    assert.equal(items.exitCode, 0, items.all);
    const selected = items.stdout.split('\n').filter(Boolean);
    assert.notDeepEqual(selected, ['all']);
    assert.ok(selected.length >= 2, `selected: ${selected.join(', ')}`);
    for (const id of selected) assert.match(id, /items\.spec/, `${id} is not an item test`);

    await sh('git checkout -q -- src/routes/items.ts', { cwd: dir });
    appendFileSync(path.join(dir, 'src', 'db.ts'), '\n// edited by e2e\n');
    const db = await isolate(['affected', '--base', 'HEAD'], { cwd: dir });
    assert.equal(db.exitCode, 0, db.all);
    assert.deepEqual(db.stdout.split('\n').filter(Boolean), ['all']);
  } finally {
    removeDir(dir);
  }
});
