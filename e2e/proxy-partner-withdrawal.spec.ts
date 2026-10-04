import { test, expect } from '@playwright/test';

/**
 * Verifies the merchant / cash-out agent "withdraw for a proxy partner" flow:
 *   - When an agent withdraws ON BEHALF OF a partner, the payout card resolves
 *     the PARTNER name (never the literal "Unknown"), even though the requesting
 *     user (the agent) has no readable profile name.
 *   - Resolution falls back to the registered payout name (bank/momo) when no
 *     partner profile is available.
 *   - The "· on behalf" proxy marker is shown so the agent knows it is a proxy
 *     partner payout.
 *
 * Drives the dev-only harness at /__e2e/proxy-partner-withdrawal. The withdrawal
 * rows are static props, so the test needs no auth or seeded data.
 */

const HARNESS = '/__e2e/proxy-partner-withdrawal';

test.beforeEach(async ({ page }) => {
  await page.goto(HARNESS, { waitUntil: 'networkidle' });
  await expect(page.getByTestId('e2e-proxy-partner-withdrawal-harness')).toBeVisible();
});

test('resolves partner name from the linked partner profile', async ({ page }) => {
  const card = page.getByTestId('proxy-card-linked-partner');
  await expect(card).toBeVisible();

  // Partner name resolved (NOT "Unknown").
  await expect(card.getByText('Grace Nakato').first()).toBeVisible();
  await expect(card.getByText(/^Unknown$/)).toHaveCount(0);

  // Proxy marker present so the agent knows this is on behalf of a partner.
  await expect(card.getByText(/on behalf/i)).toBeVisible();
});

test('falls back to the registered payout name when no partner profile exists', async ({ page }) => {
  const card = page.getByTestId('proxy-card-payout-fallback');
  await expect(card).toBeVisible();

  // Bank account name is used as the resolved recipient name.
  await expect(card.getByText('Moses Okello').first()).toBeVisible();
  await expect(card.getByText(/^Unknown$/)).toHaveCount(0);
  await expect(card.getByText(/on behalf/i)).toBeVisible();
});
