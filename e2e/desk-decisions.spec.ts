import { test, expect, type Page, type Route } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The review drawer's decision buttons at 360 and 1280 px (dev-only harness
 * /__e2e/desk-review: the real drawer, a stand-in reviewer). Every server call
 * is answered here, so the spec sees exactly which RPCs each button makes and
 * that nothing writes rent_requests from the browser.
 *
 *   npx playwright test e2e/desk-decisions.spec.ts
 *
 * Screenshots go to e2e/desk-decisions.screenshots/.
 */

const SHOTS = join(process.cwd(), 'e2e', 'desk-decisions.screenshots');
mkdirSync(SHOTS, { recursive: true });
const REQ = '06df1e3b-94f7-4efb-af5b-ea8fcccb6997';

/* ───────────── fixtures: request 06df1e3b, Odenyo Elly ───────────── */

const LO_CHECKS: [string, string, 'amount' | null][] = [
  ['lo_reachable', 'Landlord reachable', null],
  ['lo_number_is_landlord', "Number is the landlord's", null],
  ['lo_knows_tenant', 'Knows the tenant', null],
  ['lo_uses_otp_dashboard', 'Will use OTP / dashboard', null],
  ['lo_accepts_deposit', 'Accepts deposit, no charges', null],
  ['lo_rent_confirmed', 'Rent confirmed by the landlord', 'amount'],
  ['lo_tenant_no_arrears', 'Tenant not in rent arrears', null],
  ['lo_value_prop', 'Value proposition offered', null],
];
const check = (stage: string, [code, label, value_kind]: [string, string, 'amount' | null]) => ({
  code, stage, label, question: `${label}?`, method: 'call', weight: 1, required: true, on_fail: 'reject',
  value_kind, assumption: null, system_said: null, system_detail: null, last: null,
});
const person = (id: string, name: string) => ({ id, name, phone: '+256700000001' });
const sheet = (stage: string, checklist: unknown[], recommended: string) => ({
  request: {
    id: REQ, status: 'tenant_ops_approved', stage, round: 0, rent_amount: 700000, duration_days: 30, created_at: '2026-11-01',
    tenant: { ...person('t1', 'Odenyo Elly'), occupation: 'Trader' }, agent: person('a1', 'Andy Agent'),
    landlord: { ...person('l1', 'Lucy Landlord'), verified: true },
    lc1: null, lc_letter: null, house_photos: [], gps: null, funder_visible: true,
  },
  checklist,
  history: [],
  score: null,
  recommendation: { recommended, reason_code: null, failed: [] },
  can_review: true,
  my_staff_ref: 'EMP-1',
});
const LANDLORD_SHEET = sheet('landlord_ops', LO_CHECKS.map((c) => check('landlord_ops', c)), 'pass');
const AGENT_SHEET = sheet('agent_ops', [check('agent_ops', ['ao_agent_performance', 'Agent performance', null])], 'transfer');
const LANDLORD_CTX = {
  rent_on_request: 700000, duration_days: 30,
  tenant: { id: 't1', name: 'Odenyo Elly', phone: '+256700000001', payment_health: null },
  agent: { id: 'a1', name: 'Andy Agent', phone: '+256700000002' },
  landlord: { id: 'l1', name: 'Lucy Landlord', phone: '0700000003', mobile_money_number: null, mobile_money_name: null, verified: true, caretaker: null, is_agent_managed: false, number_of_houses: 2, arrears_hint: null, welile_tenants: 1 },
  script: null,
};
const REASONS = [
  { code: 'LANDLORD_UNREACHABLE', desks: ['Landlord Ops'], meaning: 'Landlord not reachable', requires_text: false },
  { code: 'AGENT_PERFORMANCE', desks: ['Agent Ops'], meaning: 'Transfer or hold for agent recovery / overdue float', requires_text: false },
  { code: 'OTHER', desks: ['all'], meaning: 'Reviewed weekly to create new codes', requires_text: true },
  { code: 'RISK_JUDGEMENT', desks: ['all'], meaning: 'Person overrides the rule on judgement', requires_text: true },
];
const OPTIONS_FROM_LANDLORD = [
  { code: 'agent', label: 'Field agent (to correct)', hint: 'Ends this round; the agent fixes and resubmits' },
  { code: 'service_centre', label: 'Service Centre', hint: 'Items to be checked again' },
  { code: 'agent_ops', label: 'Agent Ops', hint: 'Agent, items or photos to be reviewed again' },
  { code: 'tenant_ops', label: 'Tenant Ops', hint: 'Tenant to be called again' },
];

type Call = { fn: string; args: Record<string, unknown> };
type Answer = { data?: unknown; error?: { message: string; code?: string } };

/** Answer every server call; record the RPCs and any table write. */
async function serve(page: Page, rpcAnswers: Record<string, Answer>) {
  const calls: Call[] = [];
  const writes: string[] = [];
  await page.route('**/rest/v1/**', async (route: Route) => {
    const req = route.request();
    const url = new URL(req.url());
    const rpc = /\/rest\/v1\/rpc\/([^/?]+)/.exec(url.pathname)?.[1];
    if (rpc) {
      let args: Record<string, unknown> = {};
      try {
        args = req.postDataJSON() ?? {};
      } catch {
        /* GET rpc */
      }
      calls.push({ fn: rpc, args });
      const a = rpcAnswers[rpc];
      if (a?.error) return route.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ code: a.error.code ?? 'P0001', message: a.error.message, details: null, hint: null }) });
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(a ? (a.data ?? null) : []) });
    }
    // Any write to rent_requests from the browser (the app's own telemetry inserts are not ours to count).
    if (req.method() !== 'GET' && req.method() !== 'HEAD' && url.pathname.endsWith('/rent_requests')) writes.push(`${req.method()} ${url.pathname}`);
    if (url.pathname.endsWith('/ontology_reason_codes')) return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(REASONS) });
    return route.fulfill({ status: 200, contentType: 'application/json', body: '[]' });
  });
  return { calls, writes, names: () => calls.map((c) => c.fn) };
}

async function open(page: Page, stage: string) {
  await page.goto(`/__e2e/desk-review?stage=${stage}`);
  await page.getByRole('heading', { name: 'Your decision' }).waitFor({ timeout: 120_000 });
  // App.tsx's DeferredProviders remounts the route tree about a second after first paint.
  await page.waitForTimeout(1500);
  await page.getByRole('heading', { name: 'Your decision' }).waitFor({ timeout: 30_000 });
  for (let i = 0; i < 3; i += 1) {
    const prompt = page.getByRole('dialog', { name: /Install the Welile app|Get the Welile app/ });
    if ((await prompt.count()) === 0) break;
    const later = page.getByRole('button', { name: /Maybe later|Not now/ });
    if (await later.count()) await later.first().click();
    else await page.keyboard.press('Escape');
    await page.waitForTimeout(300);
  }
}

const panel = (page: Page) => page.locator('section', { has: page.getByRole('heading', { name: 'Your decision' }) });
const chip = (page: Page, name: RegExp) => panel(page).getByRole('button', { name });
const submit = (page: Page) => page.getByRole('button', { name: 'Record the review and act' });
/** A check's row: its label reads "<label>(required)". */
const row = (page: Page, label: string) => page.locator('li', { has: page.locator('p', { hasText: label }) }).first();
const tick = (page: Page, label: string, result = 'Pass') => row(page, label).getByRole('button', { name: result, exact: true }).click();

async function logAnsweredLandlordCall(page: Page) {
  const pick = (legend: RegExp, option: string) =>
    page.locator('fieldset', { has: page.locator('legend', { hasText: legend }) }).getByRole('button', { name: option, exact: true }).click();
  await pick(/How did the call go/, 'Answered');
  await pick(/Knew Welile pays rent/, 'Knew');
  await pick(/Consent to the deposit/, 'Consents');
  await pick(/payout code/, 'Knew');
  await pick(/explain it fully/, 'Yes');
  await page.getByRole('button', { name: 'Save the call' }).click();
  await expect(page.getByText('Answered call logged.')).toBeVisible();
}

test.describe.configure({ mode: 'serial' });
test.use({ deviceScaleFactor: 2 });
test.setTimeout(150_000);

for (const size of [{ width: 360, height: 800 }, { width: 1280, height: 900 }]) {
  const tag = `${size.width}`;
  test.describe(`${size.width}x${size.height}`, () => {
    test.beforeEach(async ({ page }) => {
      await page.setViewportSize(size);
    });

    test('Landlord Ops, 06df1e3b (3 of 8 checks): Pass says why under it, then one review call and a toast', async ({ page }) => {
      const s = await serve(page, {
        pipeline_review_sheet: { data: LANDLORD_SHEET },
        landlord_ops_context: { data: LANDLORD_CTX },
        record_awareness_call: { data: { id: 'call-1' } },
        pipeline_record_review: { data: { review_id: 1 } },
      });
      await open(page, 'landlord_ops');
      expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);

      // No answered call: Pass is off and says why right under the chips.
      await expect(chip(page, /^Pass/)).toBeDisabled();
      await expect(page.locator('[data-pass-why]')).toHaveText('Pass: Log an answered landlord call first');

      await logAnsweredLandlordCall(page);
      await expect(chip(page, /^Pass/)).toBeEnabled();

      for (const [, label] of LO_CHECKS.slice(0, 3)) await tick(page, label);
      await chip(page, /^Pass/).click();
      const why = page.locator('[data-blocked-why]');
      await expect(why).toHaveText('Answer 5 more checks');
      await expect(submit(page)).toBeDisabled();
      // Right under the button it disables, and on screen with it.
      await submit(page).scrollIntoViewIfNeeded();
      const [b, w] = [await submit(page).boundingBox(), await why.boundingBox()];
      expect(b && w && w.y >= b.y + b.height - 1).toBeTruthy();
      expect(w && w.y + w.height <= size.height).toBeTruthy();
      await page.screenshot({ path: join(SHOTS, `pass-why-${tag}.png`) });

      for (const [, label] of LO_CHECKS.slice(3)) await tick(page, label);
      await expect(why).toHaveText('Enter the rent the landlord states');
      await row(page, 'Rent confirmed by the landlord').getByRole('spinbutton').fill('700000');
      await expect(why).toHaveCount(0);
      await expect(submit(page)).toBeEnabled();

      await submit(page).click();
      await expect(page.getByText('Sent to the COO').first()).toBeVisible();
      expect(s.names().filter((f) => f === 'pipeline_record_review')).toHaveLength(1);
      const review = s.calls.find((c) => c.fn === 'pipeline_record_review')!.args;
      expect(review).toMatchObject({ p_stage: 'landlord_ops', p_decision: 'pass' });
      expect(review.p_results).toContainEqual({ code: 'lo_rent_confirmed', result: 'pass', value: 700000 });
      expect(s.writes, 'no rent_requests write from the browser').toEqual([]);
      await page.screenshot({ path: join(SHOTS, `pass-sent-${tag}.png`) });
    });

    test('Landlord Ops: a refused pass shows the server message as-is', async ({ page }) => {
      const refusal = 'Request is at "partner_ops_approved", not at the landlord_ops desk';
      const s = await serve(page, {
        pipeline_review_sheet: { data: LANDLORD_SHEET },
        landlord_ops_context: { data: LANDLORD_CTX },
        record_awareness_call: { data: { id: 'call-1' } },
        pipeline_record_review: { error: { message: refusal } },
      });
      await open(page, 'landlord_ops');
      await logAnsweredLandlordCall(page);
      for (const [, label] of LO_CHECKS) await tick(page, label);
      await row(page, 'Rent confirmed by the landlord').getByRole('spinbutton').fill('700000');
      await chip(page, /^Pass/).click();
      await submit(page).click();
      await expect(panel(page).getByRole('alert')).toHaveText(refusal);
      expect(s.writes).toEqual([]);
    });

    test('Send back (and the reject): office picker with "Field agent (to correct)", one pipeline_send_back_to call', async ({ page }) => {
      const s = await serve(page, {
        pipeline_review_sheet: { data: LANDLORD_SHEET },
        landlord_ops_context: { data: LANDLORD_CTX },
        pipeline_send_back_options: { data: OPTIONS_FROM_LANDLORD },
        pipeline_send_back_to: { data: { ok: true, to: 'agent', to_label: 'the field agent (to correct)', status: 'rejected' } },
      });
      await open(page, 'landlord_ops');
      await chip(page, /^Send back/).click();
      const form = page.locator('[data-send-back]');
      for (const o of OPTIONS_FROM_LANDLORD) await expect(form.getByText(o.label, { exact: true })).toBeVisible();
      await form.getByText('Field agent (to correct)', { exact: true }).click();
      await form.getByRole('radio', { name: 'Landlord not reachable' }).click();
      await form.getByRole('button', { name: 'Send back to Field agent (to correct)' }).click();
      await expect(page.getByText('Sent back to the agent').first()).toBeVisible();
      expect(s.names().filter((f) => /record_review|send_back_to|return_rent/.test(f))).toEqual(['pipeline_send_back_to']);
      expect(s.calls.find((c) => c.fn === 'pipeline_send_back_to')!.args).toMatchObject({
        p_request_id: REQ, p_from_stage: 'landlord_ops', p_to: 'agent', p_reason_code: 'LANDLORD_UNREACHABLE',
      });
      expect(s.writes).toEqual([]);
      await page.screenshot({ path: join(SHOTS, `send-back-${tag}.png`) });
    });

    test('Agent Ops Transfer: the transfer call, then the pass (server moves it); a refusal as-is', async ({ page }) => {
      const s = await serve(page, {
        pipeline_review_sheet: { data: AGENT_SHEET },
        pipeline_suggest_agents: { data: [{ agent_id: 'a2', agent_name: 'Grace Strong', km: 1.2, in_window_pct: 0.92, active_tenants: 14 }] },
        ops_transfer_pipeline_request_agent: { data: { success: true } },
        pipeline_record_review: { data: { review_id: 2 } },
      });
      await open(page, 'agent_ops');
      await tick(page, 'Agent performance', 'Fail');
      await chip(page, /^Transfer to another agent/).click();
      await page.getByRole('button', { name: /Grace Strong/ }).click();
      await panel(page).getByPlaceholder(/What you saw/).fill('Old agent is below 50% collected');
      await submit(page).click();
      await expect(page.getByText('Transferred to Grace Strong. Sent to Tenant Ops').first()).toBeVisible();
      expect(s.names().filter((f) => f === 'ops_transfer_pipeline_request_agent' || f === 'pipeline_record_review')).toEqual([
        'ops_transfer_pipeline_request_agent',
        'pipeline_record_review',
      ]);
      expect(s.calls.find((c) => c.fn === 'pipeline_record_review')!.args).toMatchObject({ p_decision: 'pass', p_stage: 'agent_ops', p_reason_code: 'AGENT_PERFORMANCE' });
      expect(s.writes).toEqual([]);
      await page.screenshot({ path: join(SHOTS, `transfer-${tag}.png`) });
    });

    test('Agent Ops Transfer refused: nothing recorded, the server message as-is', async ({ page }) => {
      const refusal = 'That agent already received 5 transfers in 7 days (cap 5): choose another agent';
      const s = await serve(page, {
        pipeline_review_sheet: { data: AGENT_SHEET },
        pipeline_suggest_agents: { data: [{ agent_id: 'a2', agent_name: 'Grace Strong', km: 1.2, in_window_pct: 0.92, active_tenants: 14 }] },
        ops_transfer_pipeline_request_agent: { error: { message: refusal } },
      });
      await open(page, 'agent_ops');
      await tick(page, 'Agent performance', 'Fail');
      await chip(page, /^Transfer to another agent/).click();
      await page.getByRole('button', { name: /Grace Strong/ }).click();
      await panel(page).getByPlaceholder(/What you saw/).fill('Old agent is below 50% collected');
      await submit(page).click();
      await expect(panel(page).getByRole('alert')).toHaveText(refusal);
      expect(s.names()).not.toContain('pipeline_record_review');
    });

    test('Wait on…: one pipeline_set_waiting call; a refusal as-is, then the toast on success', async ({ page }) => {
      const refusal = 'You cannot act on this desk for this request';
      let refuse = true;
      const s = await serve(page, {
        pipeline_review_sheet: { data: LANDLORD_SHEET },
        landlord_ops_context: { data: LANDLORD_CTX },
      });
      await page.route('**/rest/v1/rpc/pipeline_set_waiting', (route) =>
        refuse
          ? route.fulfill({ status: 403, contentType: 'application/json', body: JSON.stringify({ code: '42501', message: refusal, details: null, hint: null }) })
          : route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify('w-1') }),
      );
      await open(page, 'landlord_ops');
      await chip(page, /^Wait on/).click();
      const [owner, reason] = [panel(page).locator('select').nth(0), panel(page).locator('select').nth(1)];
      await owner.selectOption('landlord');
      await expect(reason.locator('option[value="LANDLORD_UNREACHABLE"]')).toHaveCount(1);
      await reason.selectOption('LANDLORD_UNREACHABLE');
      await panel(page).getByRole('button', { name: 'Set the wait' }).click();
      await expect(panel(page).getByRole('alert')).toHaveText(refusal);
      refuse = false;
      await panel(page).getByRole('button', { name: 'Set the wait' }).click();
      await expect(page.getByText(/Waiting on landlord for \d+ hours/).first()).toBeVisible();
      expect(s.writes).toEqual([]);
      await page.screenshot({ path: join(SHOTS, `wait-${tag}.png`) });
    });
  });
}
