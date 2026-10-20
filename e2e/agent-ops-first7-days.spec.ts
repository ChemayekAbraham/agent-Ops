import { test, expect, Page, Route } from '@playwright/test';

/**
 * Agent Ops > First 7 Days (the 7th category tab): signed in as an agent_ops user, open the tab, switch Daily / Weekly and open a
 * Rent Plan's side panel. Read-only: the three am_new_tenant_first7 functions are answered from here; nothing is written.
 */

const SUPABASE_HOST = 'byrzshwlentqvktcksem.supabase.co';
const PROJECT_REF = 'byrzshwlentqvktcksem';
const USER_ID = '00000000-0000-0000-0000-0000000000a7';
const STORAGE_KEY = `sb-${PROJECT_REF}-auth-token`;

const json = (route: Route, body: unknown, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });

const kampalaToday = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Kampala' }).format(new Date());
const addDays = (iso: string, n: number) => { const d = new Date(`${iso}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const TODAY = kampalaToday();

const plan = (over: Record<string, unknown>) => ({
  rent_request_id: 'rr-x', tenant_id: 't-x', tenant_name: 'Tenant', tenant_phone: '0772000111', agent_id: '11111111-1111-4111-8111-111111111111', agent_name: 'Joy Namukasa',
  landlord_paid_on: addDays(TODAY, -4), day1: addDays(TODAY, -3), frequency: 'daily', daily_due: 10000, total_repayment: 300000,
  day_paid: [10000, 0, 5000, 0, 0, 0, 0], day_due: Array(7).fill(10000), day_state: ['paid', 'missed', 'part', 'future', 'future', 'future', 'future'],
  paid_7d: 15000, expected_to_date: 30000, first_paid_day: 1, row_status: 'behind', ...over,
});
const PLANS = [
  plan({ rent_request_id: 'rr-1', tenant_name: 'Amina Nakato' }),
  plan({ rent_request_id: 'rr-2', tenant_name: 'Carol Auma', row_status: 'not_started', day_paid: Array(7).fill(0), day_state: ['missed', 'missed', 'missed', 'future', 'future', 'future', 'future'], paid_7d: 0, first_paid_day: null }),
  plan({
    rent_request_id: 'rr-3', tenant_name: 'Bosco Ouma', tenant_phone: '0701000222', agent_name: 'Peter Kato', agent_id: '22222222-2222-4222-8222-222222222222', frequency: 'weekly',
    day_paid: [70000, 0, 0, 0, 0, 0, 0], day_due: [70000, 0, 0, 0, 0, 0, 0], day_state: ['paid', 'not_due', 'not_due', 'future', 'future', 'future', 'future'], paid_7d: 70000, expected_to_date: 70000, row_status: 'on_track',
  }),
];

const summaryFor = (rows: typeof PLANS) => ({
  from: TODAY, to: TODAY, as_at: TODAY, plans: rows.length, daily_plans: rows.filter((r) => r.frequency === 'daily').length, weekly_plans: rows.filter((r) => r.frequency === 'weekly').length,
  status: { on_track: rows.filter((r) => r.row_status === 'on_track').length, behind: rows.filter((r) => r.row_status === 'behind').length, not_started: rows.filter((r) => r.row_status === 'not_started').length, too_early: 0 },
  day1: { started: rows.length, payers: rows.filter((r) => r.day_paid[0] > 0).length, pct: 66.7 },
  per_day: Array.from({ length: 7 }, (_, i) => ({ day: i + 1, started: rows.length, payers: rows.filter((r) => r.day_paid[i] > 0).length, paid_amount: 0, due_amount: 0, states: { paid: 0, part: 0, missed: 0, not_due: 0, future: 0 } })),
  collected: rows.reduce((a, r) => a + r.paid_7d, 0), expected: rows.reduce((a, r) => a + r.expected_to_date, 0), collected_pct: 60,
});

async function seed(page: Page, calls: { fn: string; body: Record<string, unknown> }[]) {
  const session = {
    access_token: 'fake-access', refresh_token: 'fake-refresh', token_type: 'bearer', expires_in: 3600, expires_at: Math.floor(Date.now() / 1000) + 3600,
    user: { id: USER_ID, aud: 'authenticated', role: 'authenticated', email: 'e2e-agent-ops@welile.test', email_confirmed_at: new Date().toISOString(), app_metadata: { provider: 'email' }, user_metadata: {}, created_at: new Date().toISOString() },
  };
  await page.addInitScript(({ key, session }) => { try { localStorage.setItem(key, JSON.stringify(session)); } catch { /* ignore */ } }, { key: STORAGE_KEY, session });

  await page.route(`**://${SUPABASE_HOST}/**`, async (route) => {
    const url = route.request().url();
    if (url.includes('/auth/v1/user')) return json(route, session.user);
    if (url.includes('/auth/v1/token')) return json(route, session);
    if (url.startsWith(`https://${SUPABASE_HOST}/auth/v1/`)) return json(route, {});
    // an agent_ops user: the Executive Hub needs a staff role and the agent-ops dashboard grant
    if (url.includes('/rest/v1/user_roles')) return json(route, [{ role: 'employee', enabled: true }, { role: 'agent_ops', enabled: true }]);
    if (url.includes('/rest/v1/staff_permissions')) return json(route, [{ permitted_dashboard: 'agent-ops' }]);
    if (url.includes('/rest/v1/profiles')) {
      return json(route, { id: USER_ID, phone: '+256700000002', phone_verified: true, is_frozen: false, frozen_reason: null, full_name: 'Agnes Nakato', mobile_money_name: 'Agnes Nakato' });
    }
    if (url.includes('/rest/v1/rpc/get_my_listing_block')) return json(route, { blocked: false });
    const rpc = url.match(/\/rest\/v1\/rpc\/(am_new_tenant_first7(?:_v2|_summary_v2|_payments))/);
    if (rpc) {
      const body = (route.request().postDataJSON() ?? {}) as Record<string, unknown>;
      calls.push({ fn: rpc[1], body });
      const rows = PLANS.filter((r) => !body.p_frequency || r.frequency === body.p_frequency);
      if (rpc[1] === 'am_new_tenant_first7_v2') return json(route, rows);
      if (rpc[1] === 'am_new_tenant_first7_summary_v2') return json(route, summaryFor(rows));
      return json(route, [
        { collection_id: 'c1', collected_at: `${addDays(TODAY, -3)}T07:15:00Z`, collected_day: addDays(TODAY, -3), day_number: 1, amount: 10000, payment_method: 'cash', collection_channel: 'agent_float', agent_id: PLANS[0].agent_id, agent_name: 'Joy Namukasa' },
        { collection_id: 'c2', collected_at: `${addDays(TODAY, -1)}T09:00:00Z`, collected_day: addDays(TODAY, -1), day_number: 3, amount: 5000, payment_method: 'in_app_wallet', collection_channel: 'tenant_deposit_auto', agent_id: null, agent_name: null },
      ]);
    }
    return json(route, []);
  });
}

async function dismissOnboarding(page: Page) {
  for (let i = 0; i < 3; i++) {
    const notNow = page.getByRole('button', { name: 'Not now' });
    if (await notNow.isVisible({ timeout: 1_500 }).catch(() => false)) await notNow.click();
    else break;
  }
}

test('agent_ops opens First 7 Days, switches Daily / Weekly and opens a Rent Plan panel', async ({ page }) => {
  // the first visit to a cold dev server compiles the whole app
  test.setTimeout(180_000);
  const calls: { fn: string; body: Record<string, unknown> }[] = [];
  await seed(page, calls);
  await page.goto('/executive-hub?tab=agent-ops');
  await dismissOnboarding(page);

  // the 7th category tab, after "Ranks & Reports"
  const tab = page.getByRole('button', { name: /^First 7 Days\s*\d*$/ });
  await expect(tab).toBeVisible({ timeout: 120_000 });
  await expect(page.getByRole('button', { name: /^Ranks & Reports/ })).toBeVisible();
  await tab.click();

  // Yesterday by default; all three Rent Plans, behind and not started first
  await expect(page.getByTestId('first7-row')).toHaveCount(3, { timeout: 15_000 });
  await expect(page.getByRole('button', { name: 'Yesterday', exact: true })).toHaveAttribute('aria-pressed', 'true');
  expect(calls.some((c) => c.fn === 'am_new_tenant_first7_v2' && !('p_frequency' in c.body))).toBe(true);
  await expect(page.getByTestId('first7-row').first()).toContainText('Amina Nakato');

  // Weekly: asked of the server and kept in the URL
  await page.getByRole('button', { name: 'Weekly', exact: true }).click();
  await expect(page.getByTestId('first7-row')).toHaveCount(1);
  await expect(page.getByTestId('first7-row')).toContainText('Bosco Ouma');
  await expect(page).toHaveURL(/f7freq=weekly/);
  expect(calls.some((c) => c.fn === 'am_new_tenant_first7_v2' && c.body.p_frequency === 'weekly')).toBe(true);
  // a weekly Rent Plan shows "not due" on the days it owes nothing
  await expect(page.getByTestId('first7-row').getByText('not due')).toHaveCount(6);

  // Daily
  await page.getByRole('button', { name: 'Daily', exact: true }).click();
  await expect(page.getByTestId('first7-row')).toHaveCount(2);
  await expect(page).toHaveURL(/f7freq=daily/);

  // open a Rent Plan: its panel, the call link and the payments; Esc closes it
  await page.getByTestId('first7-row').first().getByText('Amina Nakato').click();
  const panel = page.getByRole('dialog');
  await expect(panel).toBeVisible();
  await expect(panel).toContainText('Amina Nakato');
  await expect(panel.getByRole('link', { name: /Call Amina Nakato/ })).toHaveAttribute('href', 'tel:0772000111');
  await expect(panel.getByRole('region', { name: 'Payments' })).toContainText('UGX 10,000');
  await expect(panel.getByRole('region', { name: 'Payments' })).toContainText('Cash');
  await expect(panel.getByRole('region', { name: 'Payments' })).toContainText('Self-pay');
  expect(calls.some((c) => c.fn === 'am_new_tenant_first7_payments' && c.body.p_rent_request_id === 'rr-1')).toBe(true);
  // a day cell opens that day's payments only
  await page.keyboard.press('Escape');
  await expect(panel).toBeHidden();
  await page.getByTestId('first7-row').first().getByTitle(/^Day 3 /).click();
  await expect(page.getByRole('dialog').getByRole('heading', { name: /Payments on day 3/ })).toBeVisible();
  await expect(page.getByRole('dialog').getByRole('region', { name: 'Payments' })).toContainText('UGX 5,000');
  await expect(page.getByRole('dialog').getByRole('region', { name: 'Payments' })).not.toContainText('UGX 10,000');
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toBeHidden();

  // keyboard: Enter on a focused row opens it
  await page.getByTestId('first7-row').nth(1).focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('dialog')).toContainText('Carol Auma');
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toBeHidden();
});

test('the six existing tabs and the sidebar First 7 Days Tracker behave as before', async ({ page }) => {
  test.setTimeout(180_000);
  const calls: { fn: string; body: Record<string, unknown> }[] = [];
  await seed(page, calls);
  await page.goto('/executive-hub?tab=agent-ops');
  await dismissOnboarding(page);

  const chip = (label: RegExp) => page.getByRole('button', { name: label });
  const area = (title: string) => page.getByRole('button', { name: title, exact: true });
  await expect(chip(/^All\s*14$/)).toBeVisible({ timeout: 120_000 });

  // All: every business area, and no First 7 Days content
  await expect(area('Agents Rent')).toBeVisible();
  await expect(area('Welile Agents Ranks')).toBeVisible();
  await expect(page.getByRole('button', { name: /Export CSV/ })).toHaveCount(0);

  // each existing tab still narrows the grid to its own areas
  await chip(/^Ranks & Reports\s*1$/).click();
  await expect(area('Welile Agents Ranks')).toBeVisible();
  await expect(area('Agents Rent')).toHaveCount(0);
  await chip(/^Rent & Bikes\s*2$/).click();
  await expect(area('Agents Rent')).toBeVisible();
  await expect(area('Welile Agents Ranks')).toHaveCount(0);
  await chip(/^Advances\s*4$/).click();
  await expect(area('Agent Advances')).toBeVisible();
  await expect(area('Agents Rent')).toHaveCount(0);
  await chip(/^Commerce & Float\s*3$/).click();
  await expect(area('Agents Rent')).toHaveCount(0);
  await expect(area('Welile Merchandise')).toBeVisible();
  await chip(/^Field & Hubs\s*4$/).click();
  await expect(area('Welile Merchandise')).toHaveCount(0);
  await expect(page.getByRole('button', { name: /Export CSV/ })).toHaveCount(0);

  // First 7 Days replaces the grid; going back to All brings the grid back
  await chip(/^First 7 Days\s*1$/).click();
  await expect(page.getByRole('button', { name: /Export CSV/ })).toBeVisible();
  await expect(area('Agents Rent')).toHaveCount(0);
  await chip(/^All\s*14$/).click();
  await expect(area('Agents Rent')).toBeVisible();
  await expect(page.getByRole('button', { name: /Export CSV/ })).toHaveCount(0);

  // typing in the search still searches the business areas, even from the First 7 Days tab
  await chip(/^First 7 Days\s*1$/).click();
  await page.getByPlaceholder(/Search all 14 business areas/).fill('bikes');
  await expect(area('Agents Bikes')).toBeVisible();
  await expect(page.getByRole('button', { name: /Export CSV/ })).toHaveCount(0);
  await page.getByRole('button', { name: 'Clear search' }).click();

  // the sidebar tracker opens the same component
  await page.getByRole('button', { name: 'Field Operations', exact: true }).click(); // the sidebar section is closed until opened
  await page.getByRole('button', { name: 'First 7 Days Tracker' }).click();
  await expect(page.getByRole('button', { name: /Export CSV/ })).toBeVisible();
  await expect(page.getByTestId('first7-row')).toHaveCount(3);
  await page.getByTestId('first7-row').first().getByText('Amina Nakato').click();
  await expect(page.getByRole('dialog')).toContainText('Amina Nakato');
});
