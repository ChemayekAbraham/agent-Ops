/**
 * End-to-end parity test for the exact per-filter house COUNTERS.
 *
 * The marketplace no longer shows a misleading "24+" — it shows the exact number
 * of listed houses for the active filter, split into "verified" (live in the
 * public marketplace) and "pending verification" (awaiting Landlord Ops). This
 * spec drives the real UI (public "Find a House" page and the tenant "Available
 * Houses" sheet), selects Kampala, reads the rendered verified/pending numbers,
 * and asserts they EXACTLY match the same `count: exact` queries the UI's
 * `useHouseListingCount` hook issues against the database.
 *
 * Run: bunx playwright test e2e/kampala-house-count-parity.spec.ts
 */
import { test, expect, Page } from '@playwright/test';

const KAMPALA = { latitude: 0.3476, longitude: 32.5825 };
const SUPABASE_URL = process.env.VITE_SUPABASE_URL || 'https://wirntoujqoyjobfhyelc.supabase.co';
const SUPABASE_KEY =
  process.env.VITE_SUPABASE_PUBLISHABLE_KEY ||
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Indpcm50b3VqcW95am9iZmh5ZWxjIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjY1NjE1MTYsImV4cCI6MjA4MjEzNzUxNn0.5-zxcRPVxvpxNiXhoo5VHpIuvbtuOLfiI3ph8jPIod8';

/**
 * Replay the EXACT count query `useHouseListingCount` runs for a region filter:
 * status=available, is_hidden=false, verified=<bool>, and the broadened
 * region/district/sub-county/village/address OR match. Returns the exact count.
 */
async function fetchDbCount(page: Page, verified: boolean, region: string): Promise<number> {
  return page.evaluate(
    async ({ url, key, ver, term }) => {
      const or =
        `or=(region.ilike.*${term}*,district.ilike.*${term}*,` +
        `sub_county.ilike.*${term}*,village.ilike.*${term}*,address.ilike.*${term}*)`;
      const qs =
        `select=id&status=eq.available&is_hidden=eq.false&verified=eq.${ver}&${or}`;
      const res = await fetch(`${url}/rest/v1/house_listings?${qs}`, {
        method: 'GET',
        headers: {
          apikey: key,
          Authorization: `Bearer ${key}`,
          Prefer: 'count=exact',
          Range: '0-0',
        },
      });
      const cr = res.headers.get('content-range') || '';
      const total = cr.split('/')[1];
      return total && total !== '*' ? parseInt(total, 10) : 0;
    },
    { url: SUPABASE_URL, key: SUPABASE_KEY, ver: verified, term: region },
  );
}

/** Open the shadcn region <Select> and choose "Kampala". */
async function selectKampalaRegion(page: Page, root = page.locator('body')) {
  const trigger = root
    .getByRole('combobox')
    .filter({ hasText: /All Regions|Region|Central|Eastern|Northern|Western|Kampala/ })
    .first();
  await page.waitForTimeout(2500);
  const current = (await trigger.innerText().catch(() => '')).trim();
  if (/kampala/i.test(current)) return;
  for (let attempt = 0; attempt < 3; attempt++) {
    const now = (await trigger.innerText().catch(() => '')).trim();
    if (/kampala/i.test(now)) return;
    await trigger.click();
    const option = page.getByRole('option', { name: 'Kampala', exact: true });
    try {
      await option.click({ timeout: 5_000 });
      await option.waitFor({ state: 'hidden' }).catch(() => {});
      return;
    } catch {
      await page.keyboard.press('Escape').catch(() => {});
      await page.waitForTimeout(500);
    }
  }
}

/**
 * Read the resolved verified/pending counters the UI renders. Waits for the
 * exact-count element (only present once `useHouseListingCount` resolves — the
 * loading/error fallback renders a plain <p> without these testids). The
 * `data-count` attributes carry the raw integers (comma-free), so we compare
 * numbers, not formatted strings.
 */
async function readUiCounts(
  page: Page,
  scope = page.locator('body'),
): Promise<{ verified: number; pending: number }> {
  const count = scope.locator('[data-testid="house-listing-count"]').first();
  await expect(count).toBeVisible({ timeout: 20_000 });
  const verified = Number(
    await count.locator('[data-testid="house-count-verified"]').getAttribute('data-count'),
  );
  // The pending span is only rendered when there are unverified listings.
  const pendingEl = count.locator('[data-testid="house-count-pending"]');
  const pending = (await pendingEl.count())
    ? Number(await pendingEl.getAttribute('data-count'))
    : 0;
  return { verified, pending };
}

test.use({
  geolocation: KAMPALA,
  permissions: ['geolocation'],
  viewport: { width: 1280, height: 1600 },
});

test.describe('Kampala counter parity: UI counters == DB counts', () => {
  test('Find a House page', async ({ page }) => {
    test.setTimeout(120_000);
    await page.goto('/find-a-house');
    await selectKampalaRegion(page);

    const ui = await readUiCounts(page);
    const [dbVerified, dbPending] = await Promise.all([
      fetchDbCount(page, true, 'Kampala'),
      fetchDbCount(page, false, 'Kampala'),
    ]);

    expect(dbVerified, 'Kampala must have verified listings').toBeGreaterThan(0);
    expect(ui.verified, 'verified counter must match DB').toBe(dbVerified);
    expect(ui.pending, 'pending counter must match DB').toBe(dbPending);
  });

  test('Available Houses sheet', async ({ page }) => {
    test.setTimeout(120_000);
    await page.goto('/__e2e/available-houses');
    const sheet = page.getByRole('dialog');
    await expect(sheet).toBeVisible({ timeout: 20_000 });

    await selectKampalaRegion(page, sheet);

    const ui = await readUiCounts(page, sheet);
    const [dbVerified, dbPending] = await Promise.all([
      fetchDbCount(page, true, 'Kampala'),
      fetchDbCount(page, false, 'Kampala'),
    ]);

    expect(dbVerified, 'Kampala must have verified listings').toBeGreaterThan(0);
    expect(ui.verified, 'verified counter must match DB').toBe(dbVerified);
    expect(ui.pending, 'pending counter must match DB').toBe(dbPending);
  });
});
