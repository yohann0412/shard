import { expect, test } from '@playwright/test';
import { signIn } from './helpers';

test('the dashboard shows no maintenance banner', async ({ page }) => {
  await signIn(page, 'alice');
  await expect(page.getByText('Maintenance mode is on')).toBeHidden();
});

test('the dashboard greets Bob by name', async ({ page }) => {
  await signIn(page, 'bob');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Welcome, Bob');
});
