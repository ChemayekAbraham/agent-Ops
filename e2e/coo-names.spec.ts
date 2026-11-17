import { test, expect, type Page, type Route } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * COO desk rows (bug, 17 Nov): tenant and agent names rendered one letter per
 * line once "Push anyway" widened the action column. At 1280, 1024 and 390 px
 * every name stays on one line (an ellipsis when long, the full name on hover),
 * the name column is at least 200 px from md up, the actions wrap under the
 * row instead of squeezing it, and there is no duplicate missing-items line.
 *
 *   npx playwright test e2e/coo-names.spec.ts
 *
 * Screenshots go to e2e/coo-names.screenshots/ (local test output, not in git).
 */

const SHOTS = join(process.cwd(), 'e2e', 'coo-names.screenshots');
mkdirSync(SHOTS, { recursive: true });

const ratings = { agent_ops: 80, tenant_ops: 70, landlord_ops: 60, average: 70, grade: 'B', partly_rated: false };
const row = (id: string, over: Record<string, unknown>) => ({
  id, req: id.slice(0, 8), tenant: 'Tenant', agent: 'Agent', agent_grade: 'B', agent_pct: 72, landlord: 'L', landlord_verified: true, rent: 450000, days_here: 4,
  ratings, grade: 'A', avg: 80, flags: null, auto_forwarded: false, waiting: null, rank: 1, pushable: true, frozen: null, incomplete: [], ...over,
});
const ROWS = [
  row('a0000001', { rank: 1, tenant: 'Nakimuli Christine Namubiru', agent: 'Ssemwogerere Abdul-Karim' }),
  // Held only for missing items: the widest action set (Push anyway, Review, Send back, ⋯).
  row('a0000002', { rank: 2, tenant: 'Kemigisha Annet Tumusiime', agent: 'Byaruhanga Emmanuel Kato', pushable: false, incomplete: ['ID back', 'LC1 letter'] }),
  row('a0000003', {
    rank: 3, tenant: 'Odongkara Patrick', agent: 'Atuhaire Doreen', pushable: false, incomplete: ['ID back'],
    frozen: { reason: 'Agent below 50% collected', since: '2026-11-02T08:00:00Z', returns_to_agent_ops_at: '2026-11-20T08:00:00Z' },
  }),
  row('a0000004', { rank: 4, tenant: 'Ali', agent: 'Bo' }),
];

async function answer(page: Page) {
  await page.route('**/rest/v1/**', (route: Route) => {
    const url = route.request().url();
    const json = (body: unknown) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
    if (url.includes('/rpc/pipeline_coo_board')) return json({ counts: { A: 4, pushable: 2, frozen: 1 }, can_push: true, rows: ROWS });
    if (url.includes('/rpc/')) return json(null);
    return json([]);
  });
}

/** Every tenant and agent name: one line high, not squeezed to a few letters, and not wrapped. */
async function measure(page: Page) {
  return page.evaluate(() => {
    const names = Array.from(document.querySelectorAll<HTMLElement>('[data-coo-tenant], [data-agent-link]'));
    const out = names.map((el) => {
      const r = el.getBoundingClientRect();
      // The text's own lines (a button may be taller than its text: phones give it a 44 px tap target).
      const range = document.createRange();
      range.selectNodeContents(el);
      const lines = new Set(Array.from(range.getClientRects()).filter((x) => x.width > 0).map((x) => Math.round(x.top))).size;
      return { text: el.textContent?.trim() ?? '', width: Math.round(r.width), lines, title: el.getAttribute('title'), nowrap: getComputedStyle(el).whiteSpace === 'nowrap' };
    });
    const cells = Array.from(document.querySelectorAll<HTMLElement>('[data-coo-name-cell]')).map((el) => Math.round(el.getBoundingClientRect().width));
    const rows = Array.from(document.querySelectorAll<HTMLElement>('[data-gridrow]')).map((li) => {
      const facts = li.querySelector('[data-coo-facts-row]')?.getBoundingClientRect();
      const actions = li.querySelector('[data-coo-actions]')?.getBoundingClientRect();
      return { id: li.getAttribute('data-row'), wrapped: !!facts && !!actions && actions.top >= facts.bottom - 1 };
    });
    return { names: out, cells, rows, sideways: document.documentElement.scrollWidth > window.innerWidth + 1 };
  });
}

for (const width of [1280, 1024, 390]) {
  test(`COO rows at ${width}px: names readable on one line, no vertical letters`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await answer(page);
    await page.goto('/__e2e/coo-board');
    await expect(page.getByText('Kemigisha Annet Tumusiime').first()).toBeVisible({ timeout: 60_000 }); // the first visit waits on Vite's cold compile
    // App.tsx remounts the route tree about 1 s after first paint; wait it out.
    await page.waitForTimeout(1500);
    await expect(page.getByText('Kemigisha Annet Tumusiime').first()).toBeVisible();
    const m = await measure(page);

    expect(m.names.length).toBeGreaterThanOrEqual(8);
    for (const n of m.names) {
      expect(n.nowrap, `${n.text} wraps`).toBe(true);
      expect(n.lines, `${n.text} runs over ${n.lines} lines`).toBe(1);
      expect(n.title, `${n.text} has its full name on hover`).toBe(n.text);
      // Short names keep their natural width; long ones get room for more than a few letters.
      expect(n.width, `${n.text} squeezed to ${n.width}px`).toBeGreaterThanOrEqual(Math.min(60, n.text.length * 6));
    }
    if (width >= 600) {
      for (const c of m.cells) expect(c, 'name column').toBeGreaterThanOrEqual(200);
    }
    // The red chip says what is missing; no second line under the row.
    await expect(page.locator('[data-missing-line]')).toHaveCount(0);
    await expect(page.locator('[data-row="a0000002"]').getByRole('button', { name: 'Push anyway' })).toBeVisible();
    expect(m.sideways).toBe(false);
    if (width === 1024) {
      // Not enough room beside the facts: the held row's actions sit on their own line under it.
      expect(m.rows.find((r) => r.id === 'a0000002')?.wrapped).toBe(true);
    }
    await page.screenshot({ path: join(SHOTS, `coo-${width}.png`), fullPage: true });
  });
}
