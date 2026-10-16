import { test, expect, Page, Route } from '@playwright/test';

/**
 * Tenant Ops summary > the two all-time rent request cards: signed in as an operations user, open /executive-hub?tab=tenant-ops and check that what
 * is on screen is exactly what tenant_ops_rent_request_lifetime() returned (synthetic payload), and that changing the page's date filter neither
 * changes the cards nor calls the function again. Read-only: nothing is written.
 */

const H = 'wirntoujqoyjobfhyelc.supabase.co';
const U = '00000000-0000-0000-0000-0000000000b1';
const SHOTS = process.env.LIFETIME_SHOTS_DIR;
const json = (route: Route, body: unknown) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });

const counts = [2540, 2152, 1976, 1906, 1902, 1855, 1744, 1329];
const STAGES = ['service_center', 'agent_ops', 'tenant_ops', 'landlord_ops', 'partner_ops', 'coo', 'funded', 'financed'];
const PAYLOAD = {
  as_at: '2026-10-16', basis: 'All time, not tied to any date range.', submitted: 6577,
  stage_funnel: STAGES.map((stage, i) => ({ stage, count: counts[i] })),
  outcomes: { waiting_service_centre: 3786, pending: 22, rejected: 668, deleted_by_agent: 172, cancelled: 44 },
  funded: 1742, financed: 1329,
  // the percentage is deliberately left for the page to show from these server counts
  repayment: { full: 489, partial: 773, never_paid: 22, too_early: 45 },
  financed_now_closed: 6, funded_not_financed: 415,
  money: { total_repayment: 1007310368, amount_repaid: 614908410 },
};

async function seed(page: Page, calls: { name: string; body: unknown }[]) {
  const session = { access_token: 'a', refresh_token: 'r', token_type: 'bearer', expires_in: 3600, expires_at: Math.floor(Date.now() / 1000) + 3600, user: { id: U, aud: 'authenticated', role: 'authenticated', email: 'e2e-lifetime@welile.test', email_confirmed_at: new Date().toISOString(), app_metadata: { provider: 'email' }, user_metadata: {}, created_at: new Date().toISOString() } };
  await page.addInitScript(({ key, session }) => { try { localStorage.setItem(key, JSON.stringify(session)); } catch { /* ignore */ } }, { key: 'sb-wirntoujqoyjobfhyelc-auth-token', session });
  await page.route('**://' + H + '/**', async (route) => {
    const url = route.request().url();
    if (url.includes('/auth/v1/user')) return json(route, session.user);
    if (url.includes('/auth/v1/token')) return json(route, session);
    if (url.startsWith('https://' + H + '/auth/v1/')) return json(route, {});
    if (url.includes('/rest/v1/user_roles')) return json(route, [{ role: 'employee', enabled: true }, { role: 'operations', enabled: true }, { role: 'super_admin', enabled: true }]);
    if (url.includes('/rest/v1/staff_permissions')) return json(route, [{ permitted_dashboard: 'tenant-ops' }]);
    if (url.includes('/rest/v1/profiles')) return json(route, { id: U, phone: '+256700000003', phone_verified: true, is_frozen: false, frozen_reason: null, full_name: 'Tess Nabirye', mobile_money_name: 'Tess Nabirye' });
    if (url.includes('/rest/v1/rpc/get_my_listing_block')) return json(route, { blocked: false });
    const m = url.match(/\/rest\/v1\/rpc\/(\w+)/);
    if (m) {
      calls.push({ name: m[1], body: route.request().postDataJSON() ?? null });
      if (m[1] === 'tenant_ops_rent_request_lifetime') return json(route, PAYLOAD);
      if (m[1] === 'ops_tenant_ops_home_range') return json(route, {});
      // every other widget on the page is not under test: let its call fail so it shows its own error state instead of reading made-up data
      return route.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ code: 'XX000', message: 'not mocked in this spec' }) });
    }
    return json(route, []);
  });
}

async function openSummary(page: Page) {
  await page.goto('/executive-hub?tab=tenant-ops');
  for (let i = 0; i < 3; i++) {
    const notNow = page.getByRole('button', { name: 'Not now' });
    if (await notNow.isVisible({ timeout: 1_500 }).catch(() => false)) await notNow.click();
    else break;
  }
  await expect(page.getByTestId('lifetime-cards')).toBeVisible({ timeout: 150_000 });
}

async function figures(page: Page) {
  return page.getByTestId('lifetime-cards').innerText();
}

test('Tenant Ops summary at 1280px: both all-time cards show the RPC figures and ignore the date filter', async ({ page }) => {
  test.setTimeout(240_000);
  const calls: { name: string; body: unknown }[] = [];
  await page.setViewportSize({ width: 1280, height: 900 });
  await seed(page, calls);
  await openSummary(page);

  // the function is called once, with no arguments at all (no dates)
  const lifetimeCalls = () => calls.filter((c) => c.name === 'tenant_ops_rent_request_lifetime');
  expect(lifetimeCalls()).toHaveLength(1);
  expect(lifetimeCalls()[0].body === null || Object.keys(lifetimeCalls()[0].body as object).length === 0).toBe(true);

  await expect(page.getByTestId('lifetime-journey').getByTestId('lifetime-all-time-badge')).toHaveText('All time');
  await expect(page.getByTestId('lifetime-repayment').getByTestId('lifetime-all-time-badge')).toHaveText('All time');
  await expect(page.getByTestId('lifetime-row-submitted')).toContainText('6,577');
  await expect(page.getByTestId('lifetime-row-funded')).toContainText('1,744');
  await expect(page.getByTestId('lifetime-row-financed')).toContainText('1,329');
  await expect(page.getByTestId('lifetime-of-submitted-financed')).toHaveText('20.2%');
  await expect(page.getByTestId('lifetime-of-previous-financed')).toHaveText('76.2%');
  await expect(page.getByTestId('lifetime-outcomes')).toContainText('3,786');
  await expect(page.getByTestId('lifetime-bucket-full')).toContainText('489');
  await expect(page.getByTestId('lifetime-bucket-partial')).toContainText('773');
  await expect(page.getByTestId('lifetime-bucket-never_paid')).toContainText('22');
  await expect(page.getByTestId('lifetime-bucket-too_early')).toContainText('45');
  await expect(page.getByTestId('lifetime-funded-not-financed')).toContainText('415');
  await expect(page.getByTestId('lifetime-recovered')).toContainText('UGX 614,908,410 of UGX 1,007,310,368');
  if (SHOTS) { await page.getByTestId('lifetime-cards').scrollIntoViewIfNeeded(); await page.screenshot({ path: `${SHOTS}/lifetime-before.png` }); }
  const before = await figures(page);

  // change the page's date filter: the period figures may change, these two cards must not, and the function must not be asked again
  const homeCallsBefore = calls.filter((c) => c.name === 'ops_tenant_ops_home_range').length;
  for (const label of ['Last 5 days', 'This year', 'Today']) {
    await page.getByRole('button', { name: label, exact: true }).first().click();
    await expect.poll(() => calls.filter((c) => c.name === 'ops_tenant_ops_home_range').length, { timeout: 20_000 }).toBeGreaterThan(homeCallsBefore);
    expect(await figures(page)).toBe(before);
  }
  expect(lifetimeCalls()).toHaveLength(1);
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/lifetime-after.png` });
});

test('Tenant Ops summary at 380px: both cards fit without horizontal scroll', async ({ page }) => {
  test.setTimeout(240_000);
  const calls: { name: string; body: unknown }[] = [];
  await page.setViewportSize({ width: 380, height: 800 });
  await seed(page, calls);
  await openSummary(page);
  await expect(page.getByTestId('lifetime-bucket-full')).toContainText('489');
  await page.getByTestId('lifetime-journey').scrollIntoViewIfNeeded();
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/lifetime-phone-a.png` });
  await page.getByTestId('lifetime-repayment').scrollIntoViewIfNeeded();
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/lifetime-phone-b.png` });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});
