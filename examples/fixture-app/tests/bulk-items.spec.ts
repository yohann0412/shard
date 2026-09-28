import { expect, test } from '@playwright/test';
import { addItem, itemCount, signIn, uniqueName } from './helpers';

test('adding three items raises the count by exactly three', async ({ page }) => {
  await signIn(page, 'bob');
  await page.goto('/items');
  const before = await itemCount(page);
  for (const prefix of ['Stapler', 'Folder', 'Binder']) {
    await addItem(page, uniqueName(prefix));
  }
  await expect(page.locator('#item-count')).toHaveText(`${before + 3} items`);
});
