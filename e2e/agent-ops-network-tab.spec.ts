import { test, expect, Page, Route } from '@playwright/test';

/**
 * Agent Operations Overview > "Agent Network" tab (after "Overview"): signed in as an Agent Ops user, open it, pick "This month" and check that
 * what is on screen is exactly what get_agent_ops_network_overview returned (synthetic payload), in UGX. Read-only: nothing is written.
 */

const H = 'wirntoujqoyjobfhyelc.supabase.co';
const U = '00000000-0000-0000-0000-0000000000a8';
const json = (route: Route, body: unknown) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });

const PAYLOAD = {
  range: { start: '2026-10-01', end: '2026-10-15', min_expected: 50000 },
  counts: { agents: 31, with_service_centres: 7, with_bikes: 2, with_smartphone_plan: 5, with_smartphone_tenants: 19, with_subagents: 4, posted_requests: 23, approved_agents: 11 },
  approved: { agents: 9, requests: 41, amount: 12345678, receivables_outstanding: 8765432 },
  bikes: { agents: 2, leases: 3, amount_outstanding: 2820000 },
  smartphone_usage: { as_of: '2026-10-15', from_day: '2026-10-01', to_day: '2026-10-15', tenants: 5000, recorded_smartphone: 4900, recorded_without: 100, confirmed_smartphone: 12, confirmed_feature_phone: 40, device_unknown: 4948, joined: 70, joined_recorded_smartphone: 60, checks: 10, checks_smartphone: 2, checks_feature_phone: 8, seen_on_phone: 6 },
  // the rate is deliberately not collected / expected: the tab must show the server's figure
  top_portfolios: [{ agent_id: 'a1', name: 'Test Agent One', phone: '+256700000001', portfolio: 5000000, plans: 6 }, { agent_id: 'a2', name: 'Test Agent Two', phone: '+256700000002', portfolio: 3000000, plans: 2 }],
  top_collection_rate: [{ agent_id: 'a1', name: 'Test Agent One', phone: '+256700000001', collected: 900000, expected: 400000, rate_pct: 77.7 }],
  default_rate_ascending: [],
};

async function seed(page: Page, calls: Record<string, unknown>[]) {
  const session = { access_token: 'a', refresh_token: 'r', token_type: 'bearer', expires_in: 3600, expires_at: Math.floor(Date.now() / 1000) + 3600, user: { id: U, aud: 'authenticated', role: 'authenticated', email: 'e2e-network@welile.test', email_confirmed_at: new Date().toISOString(), app_metadata: { provider: 'email' }, user_metadata: {}, created_at: new Date().toISOString() } };
  await page.addInitScript(({ key, session }) => { try { localStorage.setItem(key, JSON.stringify(session)); } catch { /* ignore */ } }, { key: 'sb-wirntoujqoyjobfhyelc-auth-token', session });
  await page.route('**://' + H + '/**', async (route) => {
    const url = route.request().url();
    if (url.includes('/auth/v1/user')) return json(route, session.user);
    if (url.includes('/auth/v1/token')) return json(route, session);
    if (url.startsWith('https://' + H + '/auth/v1/')) return json(route, {});
    if (url.includes('/rest/v1/user_roles')) return json(route, [{ role: 'employee', enabled: true }, { role: 'agent_ops', enabled: true }, { role: 'operations', enabled: true }]);
    if (url.includes('/rest/v1/staff_permissions')) return json(route, [{ permitted_dashboard: 'agent-ops' }]);
    if (url.includes('/rest/v1/profiles')) return json(route, { id: U, phone: '+256700000003', phone_verified: true, is_frozen: false, frozen_reason: null, full_name: 'Agnes Nakato', mobile_money_name: 'Agnes Nakato' });
    if (url.includes('/rest/v1/rpc/get_my_listing_block')) return json(route, { blocked: false });
    if (url.includes('/rest/v1/rpc/get_agent_ops_network_overview')) { calls.push((route.request().postDataJSON() ?? {}) as Record<string, unknown>); return json(route, PAYLOAD); }
    if (url.includes('/rest/v1/rpc/get_agent_ops_overview')) return json(route, { kpis: {}, trend: [], top_performers: [], listings_funnel: {} });
    return json(route, []);
  });
}

test('Agent Network tab: after Overview, asks for the Kampala days, shows the server figures as returned', async ({ page }) => {
  test.setTimeout(240_000);
  const calls: Record<string, unknown>[] = [];
  await seed(page, calls);
  await page.goto('/executive-hub?tab=agent-ops&section=general-activities');
  for (let i = 0; i < 3; i++) {
    const notNow = page.getByRole('button', { name: 'Not now' });
    if (await notNow.isVisible({ timeout: 1_500 }).catch(() => false)) await notNow.click();
    else break;
  }

  // the tab bar: Overview first, Agent Network after it
  const tabs = page.getByRole('tab');
  await expect(tabs.nth(1)).toHaveText('Agent Network', { timeout: 150_000 });
  await expect(tabs.nth(0)).toHaveText('Overview');
  // nothing is asked of the server until the tab is opened
  expect(calls).toHaveLength(0);
  await tabs.nth(1).click();

  const panel = page.getByRole('tabpanel');
  await panel.getByRole('button', { name: 'This month' }).click();
  await expect.poll(() => calls.some((c) => /^\d{4}-\d{2}-01$/.test(String(c.p_start)) && /^\d{4}-\d{2}-\d{2}$/.test(String(c.p_end))), { timeout: 20_000 }).toBe(true);

  await expect(page.getByTestId('network-kpi')).toHaveCount(8);
  const kpi = (t: string) => page.getByTestId('network-kpi').filter({ hasText: t });
  await expect(kpi('Agents').first()).toContainText('31');
  await expect(kpi('With service centres')).toContainText('7');
  await expect(kpi('Tenants on smartphones')).toContainText('19');
  await expect(kpi('Posted rent requests')).toContainText('23');
  await expect(kpi('Approved agents')).toContainText('11');

  const approved = page.getByTestId('network-approved');
  await expect(approved).toContainText('41');
  await expect(approved).toContainText('UGX 12,345,678');
  await expect(approved).toContainText('UGX 8,765,432');
  await expect(approved.getByTestId('in-range-badge')).toHaveText('In the chosen dates');
  await expect(page.getByTestId('network-collection-rate').getByTestId('in-range-badge')).toBeVisible();
  await expect(page.getByRole('region', { name: "Today's network (all time)" })).toBeVisible();
  await expect(kpi('With bikes')).toContainText('3 leases');
  await expect(kpi('With bikes')).toContainText('still owed');
  await expect(page.getByTestId('network-smartphones')).toContainText('Platform-wide');
  await expect(page.getByTestId('network-smartphones')).toContainText('5,000');
  await expect(page.getByRole('button', { name: 'Download CSV: Biggest portfolios' })).toBeVisible();

  const portfolios = page.getByTestId('network-portfolios');
  await expect(portfolios.locator('tbody tr')).toHaveCount(2);
  await expect(portfolios.locator('tbody tr').first()).toContainText('Test Agent One');
  await expect(portfolios.locator('tbody tr').first()).toContainText('UGX 5,000,000');
  await expect(portfolios.getByRole('link', { name: /Call Test Agent One/ })).toHaveAttribute('href', 'tel:+256700000001');
  await expect(page.getByTestId('network-collection-rate')).toContainText('77.7%'); // not 900,000 / 400,000
  await expect(page.getByTestId('network-default-rate')).toContainText('No agent has a live book of at least UGX 50,000.');

  // back to Overview: the page's own content is still there
  await tabs.nth(0).click();
  await expect(page.getByText('Agent Operations Overview')).toBeVisible();
});

/** The "Agent Network" chip on the Agent Ops home page. */
test('Agent Network chip: after First 7 Days, shows the tab, opens from a link, and typing in search leaves it', async ({ page }) => {
  test.setTimeout(240_000);
  const calls: Record<string, unknown>[] = [];
  await seed(page, calls);
  await page.goto('/executive-hub?tab=agent-ops');
  for (let i = 0; i < 3; i++) {
    const notNow = page.getByRole('button', { name: 'Not now' });
    if (await notNow.isVisible({ timeout: 1_500 }).catch(() => false)) await notNow.click();
    else break;
  }
  const first7 = page.getByRole('button', { name: /^First 7 Days\s*\d*$/ });
  const chip = page.getByRole('button', { name: /^Agent Network\s*\d*$/ });
  await expect(first7).toBeVisible({ timeout: 150_000 });
  await expect(chip).toBeVisible();
  // the chip comes right after First 7 Days
  const labels = await page.locator('button:has-text("Reports"), button:has-text("First 7 Days"), button:has-text("Agent Network")').allInnerTexts();
  expect(labels.findIndex((t) => /^First 7 Days/.test(t.trim()))).toBe(labels.findIndex((t) => /^Agent Network/.test(t.trim())) - 1);

  await chip.click();
  await expect(page.getByTestId('agent-network-standalone')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Last 30 days' })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByTestId('network-kpi')).toHaveCount(8);
  expect(calls.some((c) => c.p_min_expected === 50000)).toBe(true);
  await expect(page).toHaveURL(/net=1/);
  await expect(page).toHaveURL(/netfrom=\d{4}-\d{2}-\d{2}/);
  await expect(page).toHaveURL(/netto=\d{4}-\d{2}-\d{2}/);

  // the minimum is passed to the function and kept in the link
  await page.getByRole('combobox', { name: 'Minimum size for the rankings' }).click();
  await page.getByRole('option').nth(3).click();
  await expect.poll(() => calls.some((c) => c.p_min_expected === 500000)).toBe(true);
  await expect(page).toHaveURL(/netmin=500000/);

  // typing in the search box returns to search results
  await page.getByPlaceholder(/Search all 14 business areas/).fill('bikes');
  await expect(page.getByTestId('agent-network-standalone')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Agents Bikes', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Clear search' }).click();

  // First 7 Days is untouched by the new chip
  await first7.click();
  await expect(page.getByRole('button', { name: /Export CSV/ })).toBeVisible();
  await expect(page.getByTestId('agent-network-standalone')).toHaveCount(0);
});

test('a link with net parameters opens on the Agent Network chip', async ({ page }) => {
  test.setTimeout(240_000);
  const calls: Record<string, unknown>[] = [];
  await seed(page, calls);
  await page.goto('/executive-hub?tab=agent-ops&net=1&netfrom=2026-10-01&netto=2026-10-10&netmin=100000');
  for (let i = 0; i < 3; i++) {
    const notNow = page.getByRole('button', { name: 'Not now' });
    if (await notNow.isVisible({ timeout: 1_500 }).catch(() => false)) await notNow.click();
    else break;
  }
  await expect(page.getByTestId('agent-network-standalone')).toBeVisible({ timeout: 150_000 });
  await expect(page.getByTestId('network-kpi')).toHaveCount(8);
  expect(calls.some((c) => c.p_start === '2026-10-01' && c.p_end === '2026-10-10' && c.p_min_expected === 100000)).toBe(true);
  await expect(page.getByRole('combobox', { name: 'Minimum size for the rankings' })).toContainText('100,000');
});
