import assert from 'node:assert/strict';
import { appendFileSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { copyFixture, isolate, removeDir } from './helpers.js';

test('init writes a config the other commands accept, and refuses unmanaged services without --allow-unmanaged', async () => {
  const plain = copyFixture();
  try {
    rmSync(path.join(plain, 'isolate.config.ts'));
    const init = await isolate(['init'], { cwd: plain });
    assert.equal(init.exitCode, 0, init.all);
    assert.ok(existsSync(path.join(plain, 'isolate.config.ts')));
    const run = await isolate(['run', '--workers', '2', '--', 'npx', 'playwright', 'test'], { cwd: plain });
    assert.equal(run.exitCode, 0, run.all);
  } finally {
    removeDir(plain);
  }

  const withRedis = copyFixture();
  try {
    rmSync(path.join(withRedis, 'isolate.config.ts'));
    const pkgFile = path.join(withRedis, 'package.json');
    const pkg = JSON.parse(readFileSync(pkgFile, 'utf8')) as { dependencies: Record<string, string> };
    pkg.dependencies.ioredis = '^5.4.0';
    writeFileSync(pkgFile, JSON.stringify(pkg, null, 2));
    appendFileSync(path.join(withRedis, '.env.example'), '\nREDIS_URL=redis://localhost:6379\n');

    const refused = await isolate(['init'], { cwd: withRedis });
    assert.notEqual(refused.exitCode, 0);
    assert.match(refused.all ?? '', /redis/i);
    assert.match(refused.all ?? '', /--allow-unmanaged/);
    assert.ok(!existsSync(path.join(withRedis, 'isolate.config.ts')), 'no config may be written without --allow-unmanaged');

    const allowed = await isolate(['init', '--allow-unmanaged'], { cwd: withRedis });
    assert.equal(allowed.exitCode, 0, allowed.all);
    assert.match(readFileSync(path.join(withRedis, 'isolate.config.ts'), 'utf8'), /redis/i);
  } finally {
    removeDir(withRedis);
  }
});
