import assert from 'node:assert/strict';
import { test } from 'node:test';
import { sh } from './helpers.js';

test('fixture suite passes serially and collides at workers 4 against one shared app', async () => {
  const baseline = await sh('pnpm run test:baseline');
  assert.equal(baseline.exitCode, 0, baseline.all);
  assert.match(baseline.all ?? '', /\d+ passed/);

  const collide = await sh('pnpm run test:collide');
  assert.notEqual(collide.exitCode, 0, 'the shared-app run at workers 4 must fail');
  assert.match(collide.all ?? '', /\d+ failed/);
});
