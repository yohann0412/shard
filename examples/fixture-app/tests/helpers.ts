import { expect, type Page } from '@playwright/test';

/** Where the app under test listens, for requests made outside the browser page. */
export const BASE_URL = process.env.BASE_URL ?? 'http://localhost:3000';

/** The seeded accounts. */
export const USERS = {
  alice: { email: 'alice@example.com', password: 'alice-password', name: 'Alice' },
  bob: { email: 'bob@example.com', password: 'bob-password', name: 'Bob' },
} as const;

/** Signs in through the form as a seeded user and waits for the dashboard greeting. */
export async function signIn(page: Page, who: keyof typeof USERS): Promise<void> {
  const user = USERS[who];
  await page.goto('/signin');
  await page.getByLabel('Email').fill(user.email);
  await page.getByLabel('Password').fill(user.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { name: `Welcome, ${user.name}` })).toBeVisible();
}

/** Switches maintenance mode from the settings page, accepting the confirmation dialog. */
export async function setMaintenance(page: Page, mode: 'on' | 'off'): Promise<void> {
  await page.goto('/settings');
  page.once('dialog', (dialog) => void dialog.accept());
  await page.getByRole('button', { name: `Turn maintenance ${mode}` }).click();
  await expect(page.getByText(`Maintenance: ${mode}`)).toBeVisible();
}

/** Reads the `<n> items` count line on the items page. */
export async function itemCount(page: Page): Promise<number> {
  const text = await page.locator('#item-count').textContent();
  return Number.parseInt(text ?? '', 10);
}

/** Adds an item through the form on the items page and waits for it to be listed. */
export async function addItem(page: Page, name: string): Promise<void> {
  await page.getByLabel('New item').fill(name);
  await page.getByRole('button', { name: 'Add item' }).click();
  await expect(page.locator('#items li', { hasText: name })).toBeVisible();
}

/** A unique item name, so a test can find the items it created. */
export function uniqueName(prefix: string): string {
  return `${prefix} ${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}
