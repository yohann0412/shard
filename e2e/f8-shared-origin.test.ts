import assert from 'node:assert/strict';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { createServer } from 'node:net';
import path from 'node:path';
import { test } from 'node:test';
import { execa, type ResultPromise } from 'execa';
import { cliPath, copyFixture, isolate, readJson, removeDir, waitFor } from './helpers.js';

const PORT = 3999;
const ORIGIN = `http://localhost:${PORT}`;
const RUN = ['run', '--shared-origin', ORIGIN, '--', 'npx', 'playwright', 'test'];

interface Report {
  routingValid: boolean | null;
  workers: { parallelIndex: number; tests: number }[];
  apps: { index: number; requests: number | null }[];
  proxy: { origin: string; requests: { worker: string; app: number | null; requests: number }[]; refused: number } | null;
}

/** True if nothing listens on 127.0.0.1:`port`, proven by listening there for a moment. */
function portFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer();
    server.once('error', () => resolve(false));
    server.listen(port, '127.0.0.1', () => server.close(() => resolve(true)));
  });
}

/**
 * SIGKILLs an isolate CLI running in `dir` and waits until its reaper has cleaned up and deleted its state file, so the
 * directory is not removed under a reaper that has not read it yet. Returns whether the reaper finished within 30 s.
 */
async function killAndReap(cli: ResultPromise, dir: string): Promise<boolean> {
  const state = path.join(dir, '.isolate', `reaper-${cli.pid}.json`);
  cli.kill('SIGKILL');
  await cli;
  return waitFor(() => !existsSync(state), 30_000);
}

test('with a shared origin every worker reaches its own app through one proxy, which dies with isolate and refuses a taken port', async () => {
  const dir = copyFixture();
  try {
    const run = await isolate(['run', '--workers', '4', ...RUN.slice(1)], { cwd: dir });
    assert.equal(run.exitCode, 0, run.all);
    const report = readJson<Report>(path.join(dir, '.isolate', 'report.json'));
    assert.equal(report.routingValid, true);
    assert.equal(report.proxy?.origin, ORIGIN);
    assert.equal(report.proxy?.refused, 0);
    for (const record of report.proxy!.requests) assert.equal(String(record.app), record.worker, `requests of worker ${record.worker} reached app ${record.app}`);
    for (const worker of report.workers.filter((w) => w.tests > 0)) {
      assert.ok((report.apps[worker.parallelIndex]?.requests ?? 0) > 0, `app w${worker.parallelIndex} served no proxied request`);
    }
    assert.ok(await portFree(PORT), 'the proxy must release its port when the run ends');

    const background = execa('node', [cliPath, ...RUN], { cwd: dir, reject: false });
    let reaped = false;
    try {
      assert.ok(await waitFor(() => existsSync(path.join(dir, '.isolate.playwright.config.ts')), 120_000), 'the stack never came up');
      assert.equal((await fetch(ORIGIN)).status, 421, 'a request without the worker header must be refused');
      reaped = await killAndReap(background, dir);
      assert.ok(reaped, 'the reaper did not clean up within 30 s of SIGKILL');
      assert.ok(await portFree(PORT), 'the proxy survived SIGKILL of isolate');
    } finally {
      if (!reaped) await killAndReap(background, dir);
    }

    const blocker = createServer().listen(PORT, '127.0.0.1');
    await once(blocker, 'listening');
    try {
      const refused = await isolate(RUN, { cwd: dir });
      assert.notEqual(refused.exitCode, 0);
      assert.match(refused.all ?? '', new RegExp(`port ${PORT} of localhost is taken`));
    } finally {
      blocker.close();
    }
  } finally {
    removeDir(dir);
  }
});
