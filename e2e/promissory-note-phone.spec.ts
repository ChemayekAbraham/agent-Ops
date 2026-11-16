import { test, expect, type Page, type Locator } from '@playwright/test';

/**
 * Quick Promissory Note on phones (bug: agents stuck on the Tenants step because a long
 * house title widened the dialog and pushed Next off-screen).
 *
 * Dev-only harness /__e2e/promissory-note mounts the real dialog with one house whose
 * name and address are very long. Every Supabase call is answered here, so nothing
 * reaches the live database. Checked at 360 and 384 px wide with Android's 1.3 font scale.
 */

const HARNESS = '/__e2e/promissory-note';
const ANDROID_UA =
  'Mozilla/5.0 (Linux; Android 14; SM-A146P) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36';

test.use({ deviceScaleFactor: 2, isMobile: true, hasTouch: true, userAgent: ANDROID_UA });

type Rpc = { fn: string; body: Record<string, unknown> };

async function mockBackend(page: Page, calls: Rpc[]) {
  // Playwright tries the newest route first: catch-alls go in before the RPC route.
  await page.route('**/rest/v1/**', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
  await page.route('**/functions/v1/**', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '{}' }));
  await page.route('**/auth/v1/**', (route) => route.fulfill({ status: 401, contentType: 'application/json', body: '{}' }));
  await page.route('**/rest/v1/rpc/**', async (route) => {
    const fn = new URL(route.request().url()).pathname.split('/').pop() || '';
    let body: Record<string, unknown> = {};
    try { body = route.request().postDataJSON() ?? {}; } catch { /* no body */ }
    calls.push({ fn, body });
    const json = (v: unknown) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(v) });
    if (fn === 'partner_note_rate') return json(5000);
    if (fn === 'agent_create_promissory_note_for_houses') {
      return json({ note: { id: 'e2e-note-1', partner_name: 'Grace Namata' }, house_count: 1, houses_monthly_rent: 450000 });
    }
    return json(null);
  });
}

/** The element is on screen and entirely inside the phone's width. */
async function expectInsideScreen(el: Locator, width: number) {
  await expect(el).toBeVisible();
  const box = await el.boundingBox();
  expect(box, 'element has a box').not.toBeNull();
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(width + 0.5);
}

async function expectStepFits(page: Page, dialog: Locator, width: number) {
  await expectInsideScreen(dialog.getByRole('button', { name: /^Next/ }), width);
  await expectInsideScreen(dialog.getByTestId('promissory-steps'), width);
  // Nothing inside the dialog is wider than the dialog.
  const overflow = await dialog.evaluate((el) => el.scrollWidth - el.clientWidth);
  expect(overflow).toBeLessThanOrEqual(1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(1);
}

const isoInDays = (n: number) => {
  const d = new Date(Date.now() + n * 86_400_000);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

for (const width of [360, 384]) {
  test(`at ${width}px with font scale 1.3: Next is on screen on every step, and the note is created`, async ({ page }) => {
    const calls: Rpc[] = [];
    await mockBackend(page, calls);
    await page.setViewportSize({ width, height: 760 });
    await page.addInitScript(() => {
      // Android "font size" 1.3: every rem-sized text and gap grows by 30%.
      document.documentElement.style.fontSize = '130%';
      document.documentElement.classList.add('android-compositor-safe');
      // The old-browser banner (index.html) is for real old phones, not this emulated one.
      try { localStorage.setItem('welile-outdated-dismissed', '1'); } catch { /* ignore */ }
    });
    await page.goto(HARNESS);
    const dialog = page.getByRole('dialog', { name: /Quick Promissory Note/ });
    // A cold dev server can take a while to serve the app the first time.
    await expect(dialog).toBeVisible({ timeout: 80_000 });
    const later = page.getByRole('button', { name: /Maybe later/i });
    if (await later.isVisible().catch(() => false)) await later.click();

    // 1. Who
    await expectStepFits(page, dialog, width);
    await dialog.locator('#promissory-partner-first-name').fill('Grace');
    await dialog.locator('#promissory-partner-last-name').fill('Namata');
    await dialog.getByRole('button', { name: /^Next/ }).click();

    // 2. Contact
    await expect(dialog.locator('#promissory-whatsapp')).toBeVisible();
    await expectStepFits(page, dialog, width);
    await dialog.locator('#promissory-whatsapp').fill('+256 786 358012');
    await dialog.getByRole('button', { name: /^Next/ }).click();

    // 3. Promise
    await expect(dialog.locator('#promissory-amount')).toBeVisible();
    await expectStepFits(page, dialog, width);
    await dialog.locator('#promissory-amount').fill('450000');
    await dialog.locator('#promissory-fulfilment').fill(isoInDays(7));
    await dialog.getByRole('button', { name: /^Next/ }).click();

    // 4. Tenants: the long house is listed; picking it must not push Next off-screen.
    const house = dialog.getByRole('button', { name: /Spacious two-bedroom/ });
    await expect(house).toBeVisible();
    await expectStepFits(page, dialog, width);
    await house.click();
    await expectStepFits(page, dialog, width);
    await dialog.getByRole('button', { name: /^Next/ }).click();

    // 5. Review: Create is on screen and the note is created.
    const create = dialog.getByRole('button', { name: /Create note/ });
    await create.scrollIntoViewIfNeeded();
    await expectInsideScreen(create, width);
    await create.click();
    await expect(page.getByRole('dialog', { name: /Note created/ })).toBeVisible();

    const created = calls.find((c) => c.fn === 'agent_create_promissory_note_for_houses');
    expect(created?.body).toMatchObject({ p_house_ids: ['e2e-house-1'] });
    expect((created?.body.p_payload as Record<string, unknown>).whatsapp_number).toBe('256786358012');
  });
}
