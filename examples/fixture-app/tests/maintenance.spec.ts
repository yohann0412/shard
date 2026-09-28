import { expect, test } from '@playwright/test';
import { setMaintenance, signIn } from './helpers';

test('turning maintenance on shows the banner on the dashboard and the settings page', async ({ page }) => {
  await signIn(page, 'alice');
  await setMaintenance(page, 'on');
  const banner = page.getByText('Maintenance mode is on');
  for (const path of ['/settings', '/', '/settings', '/']) {
    await page.goto(path);
    await expect(banner).toBeVisible();
    await page.reload();
    await expect(banner).toBeVisible();
  }
  await setMaintenance(page, 'off');
  await expect(banner).toBeHidden();
});

test('the mode survives a reload and signing in again', async ({ page }) => {
  await signIn(page, 'alice');
  await setMaintenance(page, 'on');
  await page.reload();
  await expect(page.locator('#maintenance-mode')).toHaveText('Maintenance: on');
  await page.getByRole('button', { name: 'Sign out' }).click();
  await signIn(page, 'alice');
  await expect(page.getByText('Maintenance mode is on')).toBeVisible();
  await page.goto('/settings');
  await expect(page.locator('#maintenance-mode')).toHaveText('Maintenance: on');
  await setMaintenance(page, 'off');
  await expect(page.locator('#maintenance-mode')).toHaveText('Maintenance: off');
});

test('other signed-in users see the banner while maintenance is on', async ({ page, browser }) => {
  await signIn(page, 'alice');
  await setMaintenance(page, 'on');
  const bobContext = await browser.newContext();
  const bobPage = await bobContext.newPage();
  await signIn(bobPage, 'bob');
  await expect(bobPage.getByText('Maintenance mode is on')).toBeVisible();
  await bobPage.goto('/settings');
  await expect(bobPage.getByText('Maintenance mode is on')).toBeVisible();
  await setMaintenance(page, 'off');
  await bobPage.goto('/');
  await expect(bobPage.getByText('Maintenance mode is on')).toBeHidden();
  await bobContext.close();
});
