import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { copyFixture, isolate, readJson, removeDir } from './helpers.js';

interface Report {
  wallMs: number;
  phases: Record<string, number>;
  tests: { total: number };
  workers: { parallelIndex: number; tests: number }[];
  failures: { title: string; classification: string }[];
}

const CLASSIFY_SPEC = `
import { test, expect } from '@playwright/test';
import { existsSync, writeFileSync } from 'node:fs';
import path from 'node:path';

test('always fails', async () => {
  expect(1).toBe(2);
});

test('fails only the first time', async () => {
  const marker = path.join(path.dirname(test.info().file), '.flaky-marker');
  if (!existsSync(marker)) {
    writeFileSync(marker, 'x');
    expect('first attempt').toBe('a later attempt');
  }
});
`;

test('every run writes a schema-valid report whose phases add up to the wall time and classifies failures', async () => {
  const dir = copyFixture();
  try {
    writeFileSync(path.join(dir, 'tests', 'zz-classify.spec.ts'), CLASSIFY_SPEC);
    const run = await isolate(['run', '--workers', '2', '--', 'npx', 'playwright', 'test'], { cwd: dir });
    assert.notEqual(run.exitCode, 0, 'a run with a failing test must exit non-zero');

    const file = path.join(dir, '.isolate', 'report.json');
    const check = await isolate(['report', '--check', file], { cwd: dir });
    assert.equal(check.exitCode, 0, check.all);

    const report = readJson<Report>(file);
    const phaseSum = Object.values(report.phases).reduce((a, b) => a + b, 0);
    assert.ok(Math.abs(phaseSum - report.wallMs) <= 0.05 * report.wallMs, `phases ${phaseSum}ms vs wall ${report.wallMs}ms`);
    assert.equal(report.workers.reduce((a, w) => a + w.tests, 0), report.tests.total);
    assert.equal(report.failures.find((f) => f.title === 'always fails')?.classification, 'deterministic');
    assert.equal(report.failures.find((f) => f.title === 'fails only the first time')?.classification, 'flaky');
  } finally {
    removeDir(dir);
  }
});
