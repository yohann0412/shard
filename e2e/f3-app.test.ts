import assert from 'node:assert/strict';
import { test } from 'node:test';
import pg from 'pg';
import { isAlive, startForeground, waitFor } from './helpers.js';

interface AppReady {
  postgresPid: number;
  apps: { index: number; port: number; url: string; pid: number; dbUrl: string }[];
}

async function reachable(url: string): Promise<boolean> {
  try {
    await fetch(url, { signal: AbortSignal.timeout(1000) });
    return true;
  } catch {
    return false;
  }
}

test('app up runs 4 healthy apps, each on its own database, and none survive the parent', async () => {
  const { proc, ready, output } = await startForeground(['app', 'up', '--workers', '4']);
  const { apps, postgresPid } = ready as unknown as AppReady;
  assert.equal(apps.length, 4);
  assert.equal(new Set(apps.map((a) => a.port)).size, 4, 'each app needs its own port');

  for (const app of apps) {
    const health = (await (await fetch(`${app.url}/health`)).json()) as { database: string };
    assert.equal(health.database, `w${app.index}`, `app ${app.index} must be connected to w${app.index}`);
  }

  const client = new pg.Client({ connectionString: apps[0]!.dbUrl });
  await client.connect();
  await client.query("insert into items (name) values ('only-in-w0')");
  await client.end();
  const names = async (url: string) => ((await (await fetch(`${url}/api/items`)).json()) as { name: string }[]).map((i) => i.name);
  assert.ok((await names(apps[0]!.url)).includes('only-in-w0'));
  assert.ok(!(await names(apps[1]!.url)).includes('only-in-w0'));

  proc.kill('SIGTERM');
  const result = await proc;
  assert.equal(result.exitCode, 0);
  assert.match(output(), /"event":"stopped".*"peakRssMb"/);
  for (const app of apps) assert.equal(await reachable(app.url), false, `app ${app.index} still answers`);
  assert.equal(isAlive(postgresPid), false, 'postgres survived its parent');

  const second = await startForeground(['app', 'up', '--workers', '2']);
  const secondReady = second.ready as unknown as AppReady;
  second.proc.kill('SIGKILL');
  await second.proc;
  assert.ok(await waitFor(() => !isAlive(secondReady.postgresPid), 10_000), 'postgres survived SIGKILL of its parent');
  for (const app of secondReady.apps) {
    assert.ok(await waitFor(() => !isAlive(app.pid), 10_000), `app ${app.index} survived SIGKILL of its parent`);
    assert.equal(await reachable(app.url), false);
  }
});
