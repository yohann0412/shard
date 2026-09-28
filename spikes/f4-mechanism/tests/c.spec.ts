import { test, expect } from '@playwright/test';
import { appendFileSync } from 'fs';
for (let i = 0; i < 4; i++) {
  test('c-' + i, async ({ page, baseURL }, info) => {
    await page.goto('/');
    const h1 = await page.locator('h1').textContent();
    appendFileSync('results.jsonl', JSON.stringify({ t: 'c-' + i, pi: info.parallelIndex, wi: info.workerIndex, baseURL, env: process.env.BASE_URL, h1 }) + '\n');
    expect(h1).toBe('server-' + (4100 + info.parallelIndex));
    await page.waitForTimeout(300);
  });
}
