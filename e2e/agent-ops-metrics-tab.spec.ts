import { test, expect, Page, Route } from '@playwright/test';

/**
 * Agent Ops home > "Metrics" chip (after Agent Network): signed in as an Agent Ops user, open it and check that what is on screen is exactly what
 * the agent_ops_metrics_* functions returned (synthetic payloads), in UGX, on a 380px phone and at 1280px. Read-only: nothing is written.
 */

const H = 'byrzshwlentqvktcksem.supabase.co';
const U = '00000000-0000-0000-0000-0000000000a9';
const SHOTS = process.env.METRICS_SHOTS_DIR;
const json = (route: Route, body: unknown) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });

const TOTALS = [{
  as_at: '2026-10-16', range_start: '2026-09-17', range_end: '2026-10-16', basis: 'Kampala days. Houses are listings created in the range; listing money only from the ledger (not agent_earnings); advances given/repaid are for advances issued in the range, outstanding and overdue are today\'s balances.',
  agents_role: 59160, linked_subagents: 3125, qualifying_agents: 770, listers_ever: 456, listers_in_range: 29,
  houses_listed: 292, houses_verified: 220, houses_pending: 69, houses_rejected: 36, houses_with_gps: 292,
  listing_earned: 1752000, listing_clawed_back: 64000,
  advances_given_count: 5, advances_given_amount: 9300000, advances_repaid: 104024.34, advances_outstanding: 59086790.98, advances_overdue_count: 282, advances_overdue_amount: 36177592.28,
}];
const AGENTS = [
  { agent_id: 'a1', name: 'Test Agent One', phone: '+256700000001', main_agent_id: 'm1', main_agent_name: 'Main One', houses_listed: 12, houses_approved: 9, houses_pending: 3, houses_rejected: 1, top_district: 'Wakiso', gps_share: 100, listing_earned: 600000, clawed_back: 100000, net: 123456, advance_principal: 300000, advance_outstanding: 250000, advance_status: 'active', last_listing: '2026-10-15', total_matched: 2 },
  { agent_id: 'a2', name: 'Test Agent Two', phone: '+256700000002', main_agent_id: null, main_agent_name: null, houses_listed: 4, houses_approved: 4, houses_pending: 0, houses_rejected: 0, top_district: 'Kampala', gps_share: 75, listing_earned: 200000, clawed_back: 0, net: 200000, advance_principal: 0, advance_outstanding: 0, advance_status: null, last_listing: '2026-10-10', total_matched: 2 },
];
const LOCATIONS = [
  { region: 'Central', district: 'Wakiso', sub_county: null, houses_listed: 150, houses_verified: 120, houses_pending: 30, houses_with_gps: 150, agents: 12 },
  { region: 'Central', district: 'Kampala', sub_county: null, houses_listed: 142, houses_verified: 100, houses_pending: 39, houses_with_gps: 142, agents: 9 },
];
const MAINS = [{ main_agent_id: 'm1', name: 'Main One', phone: '+256700000009', team_size: 4, team_houses: 40, team_earnings: 900000, team_advances_outstanding: 1200000, total_matched: 1 }];

const QUALITY = {
  network: { as_at: '2026-10-16', range_start: '2026-09-17', range_end: '2026-10-16', basis: 'Quality basis from the server.', agents: 29, houses_listed: 307, houses_verified: 230, houses_pending: 74, houses_currently_rejected: 3, rejection_events: 36, occupied: 0, empty: 307, approval_rate: 74.9, avg_days_to_verify: 1.2, listing_earned: 1850000, listing_earned_listers: 1776000, earn_per_approved: 8043, waiting_total: 2031, oldest_waiting_days: 108 },
  agents: [],
  waiting: [{ listing_id: 'l1', agent_id: 'a9', agent_name: 'Grace Paul', phone: '+256700212384', district: 'Wakiso', listed_at: '2026-06-30T05:18:54.406225+00:00', days_waiting: 108 }],
};
const RISK = {
  summary: { as_at: '2026-10-16', range_start: '2026-09-17', range_end: '2026-10-16', inactive_window_start: '2026-09-17', basis: 'Risk basis from the server.', advance_no_listing_count: 320, advance_no_listing_amount: 57002116.28, owing_agents: 322, owing_amount: 57941492.28, flag_no_earnings: 321, flag_high: 1, flag_watch: 0, flag_ok: 0, inactive_listers_count: 427, never_listed_subagents_count: 2695, main_agents_owing_count: 82, main_agents_owing_amount: 30969197.78 },
  advance_no_listing: [{ agent_id: 'r1', name: 'Risk Agent One', phone: '+256700000011', advance_outstanding: 7415000, last_listing: '2026-08-01' }],
  // the ratio is deliberately not outstanding / earned: the page must show the server's figure and flag
  advance_vs_earnings: [{ agent_id: 'r2', name: 'Risk Agent Two', phone: null, advance_outstanding: 900000, listing_earned: 100000, ratio: 9.5, flag: 'high' }],
  inactive_listers: [{ agent_id: 'i1', name: 'Quiet Lister', phone: '+256700000021', last_listing: '2026-09-16', days_inactive: 30, houses_listed_ever: 8 }],
  never_listed_subagents: [{ agent_id: 'n1', name: 'New Sub', phone: '+256700000031', main_agent_id: 'm1', main_agent_name: 'Main One', linked_on: '2026-01-19' }],
  main_agents_by_advance: [{ main_agent_id: 'm7', name: 'Team Owes Lead', phone: '+256700000041', team_size: 443, team_houses: 4, team_earnings: 62000, team_advances_outstanding: 12891354.74 }],
};

async function seed(page: Page, calls: { name: string; body: Record<string, unknown> }[], opts: { failTotals?: boolean } = {}) {
  const session = { access_token: 'a', refresh_token: 'r', token_type: 'bearer', expires_in: 3600, expires_at: Math.floor(Date.now() / 1000) + 3600, user: { id: U, aud: 'authenticated', role: 'authenticated', email: 'e2e-metrics@welile.test', email_confirmed_at: new Date().toISOString(), app_metadata: { provider: 'email' }, user_metadata: {}, created_at: new Date().toISOString() } };
  await page.addInitScript(({ key, session }) => { try { localStorage.setItem(key, JSON.stringify(session)); } catch { /* ignore */ } }, { key: 'sb-byrzshwlentqvktcksem-auth-token', session });
  await page.route('**://' + H + '/**', async (route) => {
    const url = route.request().url();
    if (url.includes('/auth/v1/user')) return json(route, session.user);
    if (url.includes('/auth/v1/token')) return json(route, session);
    if (url.startsWith('https://' + H + '/auth/v1/')) return json(route, {});
    if (url.includes('/rest/v1/user_roles')) return json(route, [{ role: 'employee', enabled: true }, { role: 'agent_ops', enabled: true }, { role: 'operations', enabled: true }]);
    if (url.includes('/rest/v1/staff_permissions')) return json(route, [{ permitted_dashboard: 'agent-ops' }]);
    if (url.includes('/rest/v1/profiles')) return json(route, { id: U, phone: '+256700000003', phone_verified: true, is_frozen: false, frozen_reason: null, full_name: 'Agnes Nakato', mobile_money_name: 'Agnes Nakato' });
    if (url.includes('/rest/v1/rpc/get_my_listing_block')) return json(route, { blocked: false });
    const m = url.match(/\/rest\/v1\/rpc\/(agent_ops_metrics_\w+)/);
    if (m) {
      calls.push({ name: m[1], body: (route.request().postDataJSON() ?? {}) as Record<string, unknown> });
      if (m[1] === 'agent_ops_metrics_totals') return opts.failTotals ? route.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ code: '42501', message: 'not authorized' }) }) : json(route, TOTALS);
      if (m[1] === 'agent_ops_metrics_agents') return json(route, AGENTS);
      if (m[1] === 'agent_ops_metrics_locations') return json(route, LOCATIONS);
      if (m[1] === 'agent_ops_metrics_main_agents') return json(route, MAINS);
      if (m[1] === 'agent_ops_metrics_listing_quality') return json(route, QUALITY);
      if (m[1] === 'agent_ops_metrics_risk') return json(route, RISK);
      return json(route, []);
    }
    if (url.includes('/rest/v1/rpc/get_maps_browser_key')) return json(route, null);
    if (url.includes('/rest/v1/rpc/get_agent_ops_overview')) return json(route, { kpis: {}, trend: [], top_performers: [], listings_funnel: {} });
    return json(route, []);
  });
}

async function openChip(page: Page) {
  await page.goto('/executive-hub?tab=agent-ops');
  for (let i = 0; i < 3; i++) {
    const notNow = page.getByRole('button', { name: 'Not now' });
    if (await notNow.isVisible({ timeout: 1_500 }).catch(() => false)) await notNow.click();
    else break;
  }
  const chip = page.getByRole('button', { name: /^Metrics\s*\d*$/ });
  await expect(chip).toBeVisible({ timeout: 150_000 });
  await chip.scrollIntoViewIfNeeded();
  await chip.click();
  await expect(page.getByTestId('agent-metrics-standalone')).toBeVisible();
}

test('Metrics chip on a 380px phone: stacked cards, server figures as returned, reorder, agent sheet', async ({ page }) => {
  test.setTimeout(240_000);
  const calls: { name: string; body: Record<string, unknown> }[] = [];
  await page.setViewportSize({ width: 380, height: 800 });
  await seed(page, calls);
  await openChip(page);

  // after Agent Network
  const labels = await page.locator('button:has-text("Agent Network"), button:has-text("Metrics")').allInnerTexts();
  expect(labels.findIndex((t) => /^Agent Network/.test(t.trim()))).toBe(labels.findIndex((t) => /^Metrics/.test(t.trim())) - 1);

  await expect(page.getByRole('button', { name: 'Last 30 days' })).toHaveAttribute('aria-pressed', 'true');
  await expect(page).toHaveURL(/metrics=1/);
  await expect(page).toHaveURL(/mfrom=\d{4}-\d{2}-\d{2}/);
  const totalsCall = calls.find((c) => c.name === 'agent_ops_metrics_totals');
  expect(totalsCall?.body.p_start).toMatch(/^\d{4}-\d{2}-\d{2}$/);

  await expect(page.getByTestId('metrics-houses-listed')).toContainText('292');
  await expect(page.getByTestId('metrics-listing-earned')).toContainText('UGX 1,752,000');
  await expect(page.getByTestId('metrics-listing-clawed')).toContainText('UGX 64,000');
  await expect(page.getByTestId('metrics-adv-outstanding')).toContainText('UGX 59,086,791');
  await expect(page.getByTestId('metrics-agent-cards')).toBeVisible();
  await expect(page.getByTestId('metrics-agent-table')).toBeHidden();
  await expect(page.getByTestId('metrics-map')).toHaveCount(0);
  await expect(page.getByTestId('metrics-location-list')).toContainText('Wakiso');
  expect(calls.some((c) => c.name === 'agent_ops_metrics_pins')).toBe(false);

  // no horizontal page scroll at 380px
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  // every control that moves or collapses a card is at least 44px
  for (const b of await page.getByRole('button', { name: /^Move / }).all()) {
    const box = await b.boundingBox();
    expect(box!.width).toBeGreaterThanOrEqual(43.5);
    expect(box!.height).toBeGreaterThanOrEqual(43.5);
  }
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/phone-top.png` });

  // listing quality: Currently rejected beside the rejection events, the quality figures and Waiting longest, as returned
  await expect(page.getByTestId('metrics-houses-rejected')).toContainText('36');
  await expect(page.getByTestId('metrics-houses-current-rejected')).toContainText('3');
  await expect(page.getByTestId('metrics-approval-rate')).toContainText('74.9%');
  await expect(page.getByTestId('metrics-earn-per-approved')).toContainText('UGX 8,043');
  await expect(page.getByTestId('metrics-waiting-list')).toContainText('Grace Paul');
  await expect(page.getByTestId('metrics-waiting-list')).toContainText('108 days');
  await expect(page.getByTestId('metrics-waiting').getByRole('link', { name: 'Call Grace Paul' })).toHaveAttribute('href', 'tel:+256700212384');
  // top earners on the Listing earnings card
  await expect(page.getByTestId('metrics-top-earners-list')).toContainText('Test Agent One');
  // risk card: the flag and ratio are the server's, the call link only where there is a phone
  await page.getByTestId('metrics-card-risk').scrollIntoViewIfNeeded();
  await expect(page.getByTestId('metrics-risk-nolisting')).toContainText('320');
  await expect(page.getByTestId('metrics-risk-nolisting')).toContainText('UGX 57,002,116');
  await expect(page.getByTestId('metrics-risk-ratio-list')).toContainText('High (3x or more)');
  await expect(page.getByTestId('metrics-risk-ratio-list')).toContainText('advance is 9.5x');
  await expect(page.getByTestId('metrics-risk-ratio-list').getByRole('link')).toHaveCount(0);
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/phone-risk.png` });
  // activity card: inactive listers and sub-agents who never listed
  await page.getByTestId('metrics-card-activity').scrollIntoViewIfNeeded();
  await expect(page.getByTestId('metrics-inactive-count')).toContainText('427');
  await expect(page.getByTestId('metrics-never-count')).toContainText('2,695');
  await expect(page.getByTestId('metrics-inactive-list')).toContainText('Quiet Lister');
  await expect(page.getByTestId('metrics-never-list')).toContainText('New Sub');
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/phone-activity.png` });
  // main agents: Team owes most
  await page.getByTestId('metrics-card-main-agents').scrollIntoViewIfNeeded();
  await page.getByRole('button', { name: 'Team owes most' }).click();
  await expect(page.getByTestId('metrics-card-main-agents')).toContainText('Team Owes Lead');
  await expect(page.getByTestId('metrics-card-main-agents')).toContainText('UGX 12,891,355');
  expect(calls.some((c) => c.name === 'agent_ops_metrics_risk' && c.body.p_limit === 50 && c.body.p_offset === 0)).toBe(true);
  expect(calls.some((c) => c.name === 'agent_ops_metrics_listing_quality' && c.body.p_limit === 10)).toBe(true);
  expect(calls.some((c) => c.name === 'agent_ops_metrics_agents' && c.body.p_sort === 'listing_earned' && c.body.p_limit === 5)).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);

  // reorder with the buttons; kept after a reload
  await page.getByRole('button', { name: 'Move Advances up' }).click();
  const order = await page.evaluate((k) => localStorage.getItem(k), `agentOpsMetricsOrder:${U}`);
  expect(JSON.parse(order!).indexOf('advances')).toBe(5);

  // the "How these are counted" popover is on the page and reads in plain words
  await page.getByRole('button', { name: /How these are counted/ }).scrollIntoViewIfNeeded();
  await page.getByRole('button', { name: /How these are counted/ }).click();
  await expect(page.getByTestId('metrics-how-counted-body')).toContainText('add up to the houses listed');
  await page.keyboard.press('Escape');

  // an agent opens in a sheet with a call link
  await page.getByRole('button', { name: 'Open Test Agent One' }).first().scrollIntoViewIfNeeded();
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/phone-agents.png` });
  await page.getByRole('button', { name: 'Open Test Agent One' }).first().click();
  const sheet = page.getByTestId('metrics-agent-sheet');
  await expect(sheet).toContainText('UGX 123,456');
  await expect(sheet.getByRole('link', { name: 'Call Test Agent One' })).toHaveAttribute('href', 'tel:+256700000001');
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/phone-sheet.png` });
});

test('Metrics chip at 1280px: agents as a table, the map area, a link with m* parameters opens it', async ({ page }) => {
  test.setTimeout(240_000);
  const calls: { name: string; body: Record<string, unknown> }[] = [];
  await page.setViewportSize({ width: 1280, height: 900 });
  await seed(page, calls);
  await page.goto('/executive-hub?tab=agent-ops&metrics=1&mfrom=2026-10-01&mto=2026-10-10&mscope=linked&msort=net:asc');
  for (let i = 0; i < 3; i++) {
    const notNow = page.getByRole('button', { name: 'Not now' });
    if (await notNow.isVisible({ timeout: 1_500 }).catch(() => false)) await notNow.click();
    else break;
  }
  await expect(page.getByTestId('agent-metrics-standalone')).toBeVisible({ timeout: 150_000 });
  await expect.poll(() => calls.some((c) => c.name === 'agent_ops_metrics_agents' && c.body.p_scope === 'linked' && c.body.p_sort === 'net:asc' && c.body.p_start === '2026-10-01' && c.body.p_end === '2026-10-10' && c.body.p_limit === 50 && c.body.p_offset === 0)).toBe(true);
  await expect(page.getByTestId('metrics-agent-table')).toBeVisible();
  await expect(page.getByTestId('metrics-agent-cards')).toBeHidden();
  await expect(page.getByTestId('metrics-agent-table').locator('tbody tr')).toHaveCount(2);
  await expect(page.getByTestId('metrics-agent-table').locator('tbody tr').first()).toContainText('UGX 123,456');
  await expect(page.getByTestId('metrics-map')).toBeVisible();
  await expect(page.getByTestId('metrics-drag-listings')).toBeVisible();
  // the new cards at 1280px
  await expect(page.getByTestId('metrics-houses-current-rejected')).toContainText('3');
  await expect(page.getByTestId('metrics-risk-ratio-list')).toContainText('advance is 9.5x');
  await expect(page.getByTestId('metrics-inactive-list')).toContainText('Quiet Lister');
  await page.getByTestId('metrics-card-main-agents').scrollIntoViewIfNeeded();
  await page.getByRole('button', { name: 'Team owes most' }).click();
  await expect(page.getByTestId('metrics-main-table')).toContainText('Team Owes Lead');
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/desktop-main-owes.png` });
  await page.getByTestId('metrics-card-risk').scrollIntoViewIfNeeded();
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/desktop-risk.png` });
  // the sidebar is open at 1280px and the page still does not scroll sideways
  await expect(page.getByText(/additional tools/i).first()).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  // the chip comes right after Agent Network
  const labels = await page.locator('button:has-text("Agent Network"), button:has-text("Metrics")').allInnerTexts();
  expect(labels.findIndex((t) => /^Agent Network/.test(t.trim()))).toBe(labels.findIndex((t) => /^Metrics/.test(t.trim())) - 1);
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/desktop-top.png` });
  await page.getByTestId('metrics-card-agents').scrollIntoViewIfNeeded();
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/desktop-agents.png` });

  // search is sent once, after the pause
  await page.getByRole('textbox', { name: 'Search agents' }).fill('ian');
  await expect.poll(() => calls.some((c) => c.name === 'agent_ops_metrics_agents' && c.body.p_search === 'ian')).toBe(true);
});

test('an error on the totals shows a message and Retry on each card that uses them', async ({ page }) => {
  test.setTimeout(240_000);
  const calls: { name: string; body: Record<string, unknown> }[] = [];
  await page.setViewportSize({ width: 380, height: 800 });
  await seed(page, calls, { failTotals: true });
  await openChip(page);
  await expect(page.getByTestId('metrics-card-listings').getByRole('alert')).toContainText('do not have access');
  await expect(page.getByTestId('metrics-card-listings').getByRole('button', { name: /Retry/ })).toBeVisible();
  // the cards that do not use the totals still work
  await expect(page.getByTestId('metrics-agent-cards')).toBeVisible();
});
