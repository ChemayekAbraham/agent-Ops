import { test, expect, type Page, type Route } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The desks' send-back dialogs on a phone (bug, Service Centre, 16 Nov):
 * 360 and 390 px wide with the text scaled 1.3×. Every control is at least
 * 44 px tall, no two rows overlap, no label is cut; the only destination is
 * chosen already; the reasons are the desk's short labels.
 *
 *   npx playwright test e2e/send-back-phone.spec.ts
 *
 * Screenshots go to e2e/send-back-phone.screenshots/.
 */

const SHOTS = join(process.cwd(), 'e2e', 'send-back-phone.screenshots');
mkdirSync(SHOTS, { recursive: true });

const ALL_OPTIONS = [
  { code: 'agent', label: 'Field agent (to correct)', hint: 'Ends this round; the agent fixes and resubmits' },
  { code: 'service_centre', label: 'Service Centre', hint: 'Items to be checked again' },
  { code: 'agent_ops', label: 'Agent Ops', hint: 'Agent, items or photos to be reviewed again' },
  { code: 'tenant_ops', label: 'Tenant Ops', hint: 'Tenant to be called again' },
  { code: 'landlord_ops', label: 'Landlord Ops', hint: 'Landlord to be called again' },
];
// The live catalogue's shape, the system and other desks' codes included: the desks must hide them.
const CATALOGUE = [
  ['DATA_ERROR', ['all'], 'System data wrong; opens a data conflict', true],
  ['DOC_MISSING', ['SC', 'Agent Ops'], 'Required item missing', false],
  ['DOC_UNREADABLE', ['SC', 'Agent Ops'], 'Present but not usable', false],
  ['DUPLICATE_REQUEST', ['Tenant Ops'], 'Another open request exists', false],
  ['FAKE_REQUEST', ['Service Centre', 'Agent Ops'], 'Fake or fraudulent request - discarded', true],
  ['OTHER', ['all'], 'Reviewed weekly to create new codes', true],
  ['PARTNER_OPS_RETIRED', ['all'], 'Forwarded to the COO by the system: Partner Ops attaches nothing', false],
  ['RISK_JUDGEMENT', ['all'], 'Person overrides the rule on judgement', true],
  ['RULE_FOLLOWED', ['all'], 'Acted as the desk recommended (auto-filled)', false],
  ['STALE_REQUEST', ['Service Centre'], 'Old request no longer active - closed', true],
  ['TENANT_ID_MISSING', ['Agent Ops', 'SC'], 'Tenant ID not on file', false],
].map(([code, desks, meaning, requires_text]) => ({ code, desks, meaning, requires_text }));
const COO_CODES = [
  { code: 'AGENT_NONE', meaning: 'No real agent attached to the request', requires_text: false },
  { code: 'DATA_ERROR', meaning: 'System data wrong; opens a data conflict', requires_text: true },
  { code: 'FUNDERS_BOARD_DEMOTED', meaning: 'Demoted from the funders board; waiting for the COO to choose the level', requires_text: false },
  { code: 'LANDLORD_UNVERIFIED', meaning: 'Landlord or payout number not verified', requires_text: false },
  { code: 'OTHER', meaning: 'Reviewed weekly to create new codes', requires_text: true },
  { code: 'PARTNER_OPS_RETIRED', meaning: 'Forwarded to the COO by the system', requires_text: false },
  { code: 'RISK_JUDGEMENT', meaning: 'Person overrides the rule on judgement', requires_text: true },
];

async function answer(page: Page, which: string) {
  await page.route('**/rest/v1/**', (route: Route) => {
    const url = route.request().url();
    const json = (body: unknown) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
    if (url.includes('/rpc/pipeline_send_back_options')) return json(which === 'single' ? ALL_OPTIONS.slice(0, 1) : ALL_OPTIONS);
    if (url.includes('/rpc/coo_reason_codes')) return json(COO_CODES);
    if (url.includes('/ontology_reason_codes')) return json(CATALOGUE);
    if (url.includes('/rpc/')) return json(null);
    return json([]);
  });
}

/** Each control's height, every pair of rows that overlap, every label cut short. */
async function measure(page: Page) {
  return page.evaluate(() => {
    const dlg = document.querySelector('[role="dialog"]') as HTMLElement;
    const visible = (el: Element) => {
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0 && (el as HTMLElement).tabIndex !== -1;
    };
    const controls = Array.from(dlg.querySelectorAll('button, [role="checkbox"], [role="radio"], select, textarea, input')).filter(visible);
    const small = controls
      .map((el) => ({ el, h: el.getBoundingClientRect().height }))
      .filter((x) => x.h < 43.5)
      .map((x) => `${x.el.tagName.toLowerCase()} "${(x.el.textContent || x.el.getAttribute('aria-label') || '').trim().slice(0, 40)}" ${x.h.toFixed(1)}px`);
    const rows = Array.from(dlg.querySelectorAll('[data-fix-item], [data-office], [data-reason], [data-destination]')).filter(visible);
    const overlaps: string[] = [];
    for (let i = 0; i < rows.length; i++) {
      for (let j = i + 1; j < rows.length; j++) {
        const a = rows[i].getBoundingClientRect();
        const b = rows[j].getBoundingClientRect();
        const w = Math.min(a.right, b.right) - Math.max(a.left, b.left);
        const h = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
        if (w > 1 && h > 1) overlaps.push(`${rows[i].textContent?.trim()} × ${rows[j].textContent?.trim()}`);
      }
    }
    const cut = rows
      .map((row) => {
        const label = row.lastElementChild as HTMLElement;
        const r = row.getBoundingClientRect();
        const l = label.getBoundingClientRect();
        const outside = l.right > r.right + 1 || l.bottom > r.bottom + 1 || l.left < r.left - 1;
        return outside || label.scrollWidth > label.clientWidth + 1 ? row.textContent?.trim() : null;
      })
      .filter(Boolean);
    const page = document.documentElement.scrollWidth > window.innerWidth + 1;
    return { small, overlaps, cut, sideways: page, rows: rows.length };
  });
}

for (const width of [360, 390]) {
  for (const which of ['single', 'coo', 'sc'] as const) {
    test(`${which} send-back at ${width}px, text ×1.3`, async ({ page }) => {
      await page.setViewportSize({ width, height: 800 });
      await answer(page, which);
      await page.goto(`/__e2e/send-back?which=${which}`);
      await page.addStyleTag({ content: 'html { font-size: 130% !important; }' });
      // App.tsx remounts the route tree about 1 s after first paint (DeferredProviders); wait it out before tapping.
      await page.waitForTimeout(1500);
      const dlg = page.getByRole('dialog').first();
      await expect(dlg).toBeVisible();
      await expect(dlg.locator('[data-fix-item]')).toHaveCount(11);
      if (which !== 'sc') await expect(dlg.locator('[data-reason], [data-coo-reason] option').first()).toBeAttached();

      if (which === 'single') {
        // The only destination is chosen already, and looks it; no "choose where" while it shows chosen.
        await expect(dlg.locator('[data-office="agent"]')).toHaveAttribute('aria-checked', 'true');
        await expect(dlg.getByText(/Choose where to send it back/)).toHaveCount(0);
        // The Service Centre's own reasons, short labels; nothing internal or from another desk.
        const reasons = await dlg.locator('[data-reason]').evaluateAll((els) => els.map((e) => [e.getAttribute('data-reason'), e.textContent?.trim()]));
        expect(reasons).toEqual([
          ['DATA_ERROR', 'Information is wrong'],
          ['DOC_MISSING', 'Document missing'],
          ['FAKE_REQUEST', 'Fake request'],
          ['DUPLICATE_REQUEST', 'Duplicate'],
          ['STALE_REQUEST', 'Old / stale request'],
          ['RISK_JUDGEMENT', 'My judgement (explain)'],
          ['OTHER', 'Other (explain)'],
        ]);
        await expect(dlg.getByText(/Reviewed weekly|Partner Ops|auto-filled/)).toHaveCount(0);
        // Tick two items: each stays one full row.
        await dlg.locator(`[data-fix-item="Tenant's face photo"]`).click();
        await dlg.locator('[data-fix-item="LC1 letter"]').click();
        await expect(dlg.locator(`[data-fix-item="Tenant's face photo"]`)).toHaveAttribute('aria-checked', 'true');
      }
      if (which === 'coo') {
        const opts = await dlg.locator('[data-coo-reason] option').evaluateAll((els) => els.map((e) => e.textContent?.trim()));
        expect(opts).toEqual(['Choose…', 'Landlord not verified', 'No real agent', 'Information is wrong', 'My judgement (explain)', 'Other (explain)']);
        await dlg.locator('[data-destination="agent_ops"]').click();
        await expect(dlg.locator('[data-destination="agent_ops"]')).toHaveAttribute('aria-checked', 'true');
      }

      const m = await measure(page);
      expect(m.rows).toBeGreaterThan(11);
      expect(m.small, 'controls under 44 px').toEqual([]);
      expect(m.overlaps, 'rows that overlap').toEqual([]);
      expect(m.cut, 'labels cut short').toEqual([]);
      expect(m.sideways, 'the page scrolls sideways').toBe(false);
      await page.screenshot({ path: join(SHOTS, `${which}-${width}.png`), fullPage: true });
    });
  }
}
