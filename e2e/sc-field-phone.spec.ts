import { test, expect, type Page, type Route } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * E133 on a phone: the field agents' Service Centre view at 360 and 390 px,
 * text scaled 1.3×. The three chips all show (they wrap, never a dropdown or
 * a sideways scroll), names and pills stay inside their card, Call is a real
 * tap target, and a tap on a card opens its read-only summary.
 *
 *   npx playwright test e2e/sc-field-phone.spec.ts
 *
 * Screenshots go to e2e/sc-field-phone.screenshots/ (local test output, not in git).
 */

const SHOTS = join(process.cwd(), 'e2e', 'sc-field-phone.screenshots');
mkdirSync(SHOTS, { recursive: true });

const BOARD = {
  allowed: true,
  team_agents: 7,
  rows: [
    {
      rent_request_id: 'r1', ref: 'AB12CD34', tenant: { name: 'Nakimuli Christine Namubiru', phone: '0772000001' }, agent: { id: 'a2', name: 'Ssemwogerere Abdul-Karim', phone: '0772000002', is_me: false },
      rent: 450000, where: 'Sent back to the agent', to_fix: true, days_waiting: 3, missing: ['ID back', 'LC1 letter', "Tenant's face photo"], desk_note: 'ID back photo is blurred; retake it in daylight',
    },
    {
      rent_request_id: 'r2', ref: 'EF56GH78', tenant: { name: 'Odongkara Patrick', phone: '0772000003' }, agent: { id: 'u1', name: 'Me', phone: '0772000004', is_me: true },
      rent: 300000, where: 'Service Centre', to_fix: false, days_waiting: 1, missing: ['GPS'], desk_note: null,
    },
    {
      rent_request_id: 'r3', ref: 'IJ90KL12', tenant: { name: 'Kemigisha Annet', phone: null }, agent: { id: 'a3', name: 'Atuhaire Doreen', phone: '0772000005', is_me: false },
      rent: 250000, where: "Funders' board", to_fix: false, days_waiting: 12, missing: [], desk_note: null,
    },
  ],
};

async function answer(page: Page) {
  await page.route('**/rest/v1/**', (route: Route) => {
    const url = route.request().url();
    const json = (body: unknown) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
    if (url.includes('/rpc/sc_field_board')) return json(BOARD);
    if (url.includes('/rpc/')) return json(null);
    return json([]);
  });
}

for (const width of [360, 390]) {
  test(`field agents' Service Centre at ${width}px, text ×1.3`, async ({ page }) => {
    await page.setViewportSize({ width, height: 800 });
    await answer(page);
    await page.goto('/__e2e/sc-field');
    await expect(page.locator('[data-sc-field-header]')).toBeVisible({ timeout: 60_000 }); // the first visit waits on Vite's cold compile
    await page.addStyleTag({ content: 'html { font-size: 130% !important; }' });
    // App.tsx remounts the route tree about 1 s after first paint; wait it out before tapping.
    await page.waitForTimeout(1500);
    await expect(page.locator('[data-sc-field-header]')).toHaveText('Your team: 7 agents · 3 requests');

    const m = await page.evaluate(() => {
      const vw = window.innerWidth;
      const chips = Array.from(document.querySelectorAll<HTMLElement>('[data-sc-field-chip]')).map((c) => {
        const r = c.getBoundingClientRect();
        return { text: c.textContent, inside: r.left >= 0 && r.right <= vw + 0.5, h: r.height };
      });
      const cut = Array.from(document.querySelectorAll<HTMLElement>('[data-sc-field-card]')).flatMap((card) => {
        const cr = card.getBoundingClientRect();
        return Array.from(card.querySelectorAll<HTMLElement>('*'))
          .filter((el) => {
            const r = el.getBoundingClientRect();
            return r.width > 0 && (r.right > cr.right + 1 || r.left < cr.left - 1);
          })
          .map((el) => el.textContent?.trim().slice(0, 40));
      });
      const calls = Array.from(document.querySelectorAll<HTMLElement>('[data-sc-field-card] [data-call]')).map((a) => Math.round(a.getBoundingClientRect().height));
      return { chips, cut, calls, sideways: document.documentElement.scrollWidth > vw + 1, selects: document.querySelectorAll('[data-sc-field] select').length };
    });
    expect(m.chips.map((c) => c.text)).toEqual(['To fix (1)', 'At Service Centre (1)', 'Further along (1)']);
    for (const c of m.chips) {
      expect(c.inside, `${c.text} inside the screen`).toBe(true);
      expect(c.h).toBeGreaterThanOrEqual(40);
    }
    expect(m.selects, 'no dropdown').toBe(0);
    expect(m.cut, 'nothing spills out of a card').toEqual([]);
    expect(m.sideways).toBe(false);
    for (const h of m.calls) expect(h, 'Call tap target').toBeGreaterThanOrEqual(32);
    // The sent-back card: red missing chips and the desk note.
    const fix = page.locator('[data-sc-field-card="r1"]');
    await expect(fix.locator('[data-sc-field-note]')).toContainText('ID back photo is blurred');
    await expect(fix.locator('[data-sc-field-missing]')).toContainText("Tenant's face photo");
    await page.screenshot({ path: join(SHOTS, `to-fix-${width}.png`), fullPage: true });

    // Tap a card: the read-only summary.
    await page.locator('[data-sc-field-chip="further"]').click();
    await page.locator('[data-sc-field-card="r3"]').click({ position: { x: 20, y: 60 } });
    const sheet = page.getByRole('dialog', { name: 'Kemigisha Annet' });
    await expect(sheet).toBeVisible();
    await expect(sheet).toContainText('IJ90KL12');
    await expect(sheet.getByRole('button', { name: /Pass|Send back|Waiting|Push/ })).toHaveCount(0);
    await page.screenshot({ path: join(SHOTS, `summary-${width}.png`) });
  });
}
