import { test, expect, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Landlord Ops board on phones (dev-only harness /__e2e/desk-landlord: seeded
 * board, no auth, no network). Screenshots go to e2e/desk-landlord.screenshots/.
 *
 *   npx playwright test e2e/desk-landlord.spec.ts
 */

const HARNESS = '/__e2e/desk-landlord';
const SHOTS = join(process.cwd(), 'e2e', 'desk-landlord.screenshots');
mkdirSync(SHOTS, { recursive: true });
const TOP_BAR = 56;

async function open(page: Page, query = '') {
  await page.goto(`${HARNESS}${query ? `?${query}` : ''}`);
  await page.waitForSelector('[data-landlord-card]', { timeout: 120_000 });
  // App.tsx's DeferredProviders remounts the route tree about a second after first paint.
  await page.waitForTimeout(1500);
  await page.waitForSelector('[data-landlord-card]', { timeout: 30_000 });
  // The app's "Install the Welile app" prompt opens on phone widths and locks scrolling.
  for (let i = 0; i < 3; i += 1) {
    const prompt = page.getByRole('dialog', { name: /Install the Welile app|Get the Welile app/ });
    if ((await prompt.count()) === 0) break;
    const later = page.getByRole('button', { name: /Maybe later|Not now|Close/ });
    if (await later.count()) await later.first().click();
    else await page.keyboard.press('Escape');
    await page.waitForTimeout(300);
  }
}

/** Scroll the page by dy px, at once (the app sets scroll-behavior: smooth). */
async function scrollPage(page: Page, dy: number) {
  await page.evaluate((d) => (document.scrollingElement as HTMLElement).scrollBy({ top: d, behavior: 'instant' as ScrollBehavior }), dy);
}

test.describe.configure({ mode: 'serial' });
// Phones are 2-3x screens; at 1x the app's "Reduce paint" rule drops every box-shadow.
test.use({ deviceScaleFactor: 2 });
test.setTimeout(180_000);

for (const size of [{ width: 360, height: 800 }, { width: 412, height: 915 }]) {
  test.describe(`${size.width}x${size.height}`, () => {
    test.beforeEach(async ({ page }) => {
      await page.setViewportSize(size);
    });

    test('Landlord Ops phone card: three lines, one chip row, one main button, no stray dots', async ({ page }) => {
      await open(page);
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      expect(overflow, 'no sideways scroll').toBeLessThanOrEqual(0);

      const card = page.locator('[data-landlord-card]').first();
      await expect(card.locator('[data-line="tenant"]')).toHaveText('Tina Nakato');
      await expect(card.locator('[data-line="rent"]')).toContainText('UGX');
      await expect(card.locator('[data-days-tone]')).toBeVisible();
      await expect(card.locator('[data-line="landlord"]')).toContainText(/phone ends \d{4}/);
      const chips = card.locator('[data-line="chips"]');
      await expect(chips).toContainText('Landlord checks 8/8');
      await expect(chips).toContainText('Tenant OK');
      await expect(chips).toContainText(/Repaid before: \d+%|First plan/);
      await expect(chips).toContainText(/Agent grade [A-D]|New agent/);
      // One main button plus the ⋯ menu; no inline call buttons.
      const buttons = card.locator('article > div:last-of-type button');
      await expect(buttons).toHaveCount(2);
      await expect(card.getByRole('button', { name: /from the company line/ })).toHaveCount(0);
      expect(await card.textContent()).not.toContain('·');

      // LC1 chip where the flags note has it; red days chip past 5 days.
      await expect(page.locator('[data-landlord-card]').nth(1).locator('[data-line="chips"]')).toContainText('LC1 not confirmed');
      await expect(page.locator('[data-days-tone="bad"]').first()).toBeVisible();
      await page.screenshot({ path: join(SHOTS, `landlord-${size.width}x${size.height}.png`) });
    });

    test('about three cards fit on one screen', async ({ page }) => {
      await open(page);
      const first = page.locator('[data-landlord-card]').first();
      // Put the first card right under the top bar and its sticky heading.
      const firstTop = await first.evaluate((el) => el.getBoundingClientRect().top);
      await scrollPage(page, firstTop - TOP_BAR - 40);
      const fullyVisible = await page.evaluate(() => {
        const vh = window.innerHeight;
        return Array.from(document.querySelectorAll('[data-landlord-card]')).filter((el) => {
          const r = el.getBoundingClientRect();
          return r.top >= 56 && r.bottom <= vh;
        }).length;
      });
      expect(fullyVisible).toBeGreaterThanOrEqual(3);
      const heights = await page.locator('[data-landlord-card] article').evaluateAll((els) => els.slice(0, 6).map((e) => e.getBoundingClientRect().height));
      for (const h of heights) expect(h).toBeLessThanOrEqual((size.height - TOP_BAR - 40) / 3);
    });

    test('the ⋯ menu holds the calls, Send back, Hold and Concern, with labels', async ({ page }) => {
      await open(page);
      const card = page.locator('[data-landlord-card]').first();
      await card.getByRole('button', { name: /More for/ }).click();
      for (const name of [/^Call tenant \(Tina Nakato\)/, /^Call agent \(Agent 0\)/, /^Call landlord \(/,/^Send back to the agent/, /^Hold \(wait on someone\)/, /^Log a concern/]) {
        await expect(page.getByRole('button', { name })).toBeVisible();
      }
      await page.screenshot({ path: join(SHOTS, `landlord-menu-${size.width}x${size.height}.png`) });
    });

    for (const theme of ['dark', 'light'] as const) {
      test(`sticky section headers are solid with a shadow and sit over the cards (${theme})`, async ({ page }) => {
        await open(page, `theme=${theme}`);
        const head = page.locator('[data-group-head="call"]');
        // Scroll so cards of that group pass under the heading.
        const headTop = await head.evaluate((el) => el.getBoundingClientRect().top);
        await scrollPage(page, headTop - TOP_BAR + 260);
        await page.waitForTimeout(100);
        const info = await head.evaluate((el) => {
          const cs = getComputedStyle(el);
          const r = el.getBoundingClientRect();
          const probe = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
          return { top: r.top, bg: cs.backgroundColor, shadow: cs.boxShadow, position: cs.position, onTop: !!probe && (probe === el || el.contains(probe)) };
        });
        expect(info.position).toBe('sticky');
        expect(Math.round(info.top)).toBe(56);
        // Opaque background: rgb(...) or rgba(..., 1).
        expect(info.bg).toMatch(/^rgb\(|rgba\([^)]*,\s*1\)$/);
        expect(info.shadow).not.toBe('none');
        expect(info.onTop, 'the heading is drawn over the card under it').toBe(true);
        await page.screenshot({ path: join(SHOTS, `landlord-sticky-${theme}-${size.width}x${size.height}.png`) });
      });
    }
  });
}
