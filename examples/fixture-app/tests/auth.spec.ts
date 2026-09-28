import { expect, test } from '@playwright/test';
import { signIn, USERS } from './helpers';

test('valid credentials sign in and show the welcome message', async ({ page }) => {
  await signIn(page, 'alice');
  await expect(page).toHaveURL('/');
  await expect(page.getByRole('heading', { name: 'Welcome, Alice' })).toBeVisible();
});

test('a wrong password shows an error and stays on the sign-in page', async ({ page }) => {
  await page.goto('/signin');
  await page.getByLabel('Email').fill(USERS.alice.email);
  await page.getByLabel('Password').fill('not-the-password');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('alert')).toHaveText('Invalid email or password');
  await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
});

test('signing out returns to the sign-in page', async ({ page }) => {
  await signIn(page, 'alice');
  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page).toHaveURL('/signin');
  await page.goto('/');
  await expect(page).toHaveURL('/signin');
});
