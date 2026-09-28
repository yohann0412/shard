import { expect, test } from '@playwright/test';
import { addItem, BASE_URL, itemCount, signIn, uniqueName } from './helpers';

test.beforeEach(async ({ page }) => {
  await signIn(page, 'alice');
  await page.goto('/items');
});

test('adding an item raises the count by exactly one', async ({ page }) => {
  const before = await itemCount(page);
  await addItem(page, uniqueName('Notebook'));
  await expect(page.locator('#item-count')).toHaveText(`${before + 1} items`);
});

test('every seeded item is listed', async ({ page, request }) => {
  const response = await request.get(`${BASE_URL}/api/items`);
  expect(response.ok()).toBe(true);
  const names = ((await response.json()) as { name: string }[]).map((item) => item.name);
  const seeded = ['Seed item 5', 'Seed item 4', 'Seed item 3', 'Seed item 2', 'Seed item 1'];
  expect(names).toEqual(expect.arrayContaining(seeded));

  await page.getByLabel('Filter').fill('Seed item');
  await expect(page.locator('#items li:visible')).toHaveText(seeded);
});

test('the two newest items are the two just added', async ({ page }) => {
  const first = uniqueName('Pencil');
  const second = uniqueName('Eraser');
  await addItem(page, first);
  await addItem(page, second);
  const newest = page.locator('#items li');
  await expect(newest.nth(0)).toHaveText(second);
  await expect(newest.nth(1)).toHaveText(first);
});
