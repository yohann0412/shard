import assert from 'node:assert/strict';
import { test } from 'node:test';
import { rowCounts, startForeground } from './helpers.js';

interface DbReady {
  seedUrl: string;
  databases: { name: string; url: string; copyMs: number }[];
}

test('db up creates 4 reachable template copies with the same row counts as seed and prints copy times', async () => {
  const { proc, ready, output } = await startForeground(['db', 'up', '--workers', '4']);
  try {
    const { seedUrl, databases } = ready as unknown as DbReady;
    assert.equal(databases.length, 4);
    const seedCounts = await rowCounts(seedUrl);
    assert.ok(Object.values(seedCounts).some((n) => n > 0), 'seed database must contain seeded rows');
    for (const db of databases) {
      assert.equal(typeof db.copyMs, 'number');
      assert.deepEqual(await rowCounts(db.url), seedCounts, `${db.name} row counts differ from seed`);
    }
    for (const db of databases) assert.match(output(), new RegExp(`${db.name}\\b.*\\d+(\\.\\d+)?\\s?ms`));
  } finally {
    proc.kill('SIGTERM');
    await proc;
  }
  assert.equal((await proc).exitCode, 0);
});
