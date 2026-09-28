import { test, expect, Page, Route } from '@playwright/test';

/**
 * E2E coverage for the Tenant Ops Workspace's Calling tab: open the tab, open
 * a tenant (via the queue's "Call" button, which is this workspace's actual
 * "open a tenant" affordance), read their plan position, log a call with an
 * outcome, and set a promise-to-pay.
 *
 * Strategy: same as e2e/dashboard-redirect.spec.ts and
 * e2e/business-advance-dialog.spec.ts — seed a fake Supabase session into
 * localStorage and intercept every Supabase REST/RPC call so the page runs
 * against a fully deterministic backend, no real auth or database needed.
 *
 * IMPORTANT (found the hard way): register ONE `page.route()` per host and
 * branch inside it with if/else, rather than many separate `page.route()`
 * calls on overlapping patterns (e.g. a specific `/rest/v1/profiles**` route
 * plus a broad `/rest/v1/**` catch-all). With multiple overlapping
 * registrations, whichever one actually answers the request is not reliable
 * here — in practice the broad catch-all silently swallowed the specific
 * routes' traffic (confirmed by logging: the specific handlers' code never
 * ran at all). A single handler with explicit branching has no such
 * ambiguity.
 */

const SUPABASE_HOST = 'wirntoujqoyjobfhyelc.supabase.co';
const PROJECT_REF = 'wirntoujqoyjobfhyelc';
const USER_ID = '00000000-0000-0000-0000-0000000000e2';
const TENANT_ID = '00000000-0000-0000-0000-0000000000e3';
const RENT_REQUEST_ID = '00000000-0000-0000-0000-0000000000e4';
const CYCLE_ROW_ID = '00000000-0000-0000-0000-0000000000e5';
const ATTEMPT_ID = '00000000-0000-0000-0000-0000000000e6';
const STORAGE_KEY = `sb-${PROJECT_REF}-auth-token`;

type Captured = { url: string; body: Record<string, unknown> };

function json(route: Route, body: unknown, status = 200) {
  return route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
}

async function seed(page: Page, captured: Captured[]) {
  const session = {
    access_token: 'fake-access',
    refresh_token: 'fake-refresh',
    token_type: 'bearer',
    expires_in: 3600,
    expires_at: Math.floor(Date.now() / 1000) + 3600,
    user: {
      id: USER_ID,
      aud: 'authenticated',
      role: 'authenticated',
      email: 'e2e-ops@welile.test',
      // useAuth.tsx's enforceAccountAccess() force-signs-out any real (non
      // @welile.*) email with no email_confirmed_at, as a backstop against a
      // session ever standing for an unconfirmed real-email account.
      email_confirmed_at: new Date().toISOString(),
      app_metadata: { provider: 'email' },
      user_metadata: {},
      created_at: new Date().toISOString(),
    },
  };

  await page.addInitScript(
    ({ key, session }) => {
      try {
        localStorage.setItem(key, JSON.stringify(session));
      } catch {}
    },
    { key: STORAGE_KEY, session },
  );

  const PROFILES: Record<string, Record<string, unknown>> = {
    [USER_ID]: {
      id: USER_ID,
      phone: '+256700000001',
      phone_verified: true,
      is_frozen: false,
      frozen_reason: null,
      // NameCompletionGate runs validateFullName() against this — a name
      // containing digits trips its junk-name filter, so a clean,
      // real-looking two-part name is required here.
      full_name: 'Grace Namono',
      mobile_money_name: 'Grace Namono',
      must_change_password: false,
      pending_merchant_agent: null,
    },
    [TENANT_ID]: {
      id: TENANT_ID,
      phone: '+256700000002',
      phone_verified: true,
      is_frozen: false,
      frozen_reason: null,
      full_name: 'Peter Okello',
      mobile_money_name: 'Peter Okello',
    },
  };

  const CALLING_QUEUE_ROW = {
    cycle_row_id: CYCLE_ROW_ID,
    subject_id: TENANT_ID,
    state: 'to_call',
    name: 'Peter Okello',
    district: 'Kampala',
    linked_agent_name: 'E2E Agent',
    attempts_made: 0,
    last_attempt_at: null,
    callback_due_at: null,
    metric_label: 'Days overdue',
    metric_value: 5,
    total_count: 1,
  };

  const PLAN_POSITION = {
    rent_request_id: RENT_REQUEST_ID,
    cadence: 'daily',
    cadence_source: 'explicit',
    clock_start: '2026-01-01',
    clock_source: 'funded_at',
    term_end_date: '2026-03-01',
    expected_to_date_ugx: 100_000,
    paid_to_date_ugx: 65_000,
    position_ugx: -35_000,
    periods_due: 20,
    days_past_due: 7,
    days_behind: 7,
    days_ahead: null,
    outstanding_ugx: 235_000,
    catch_up_daily_ugx: 6_500,
    term_expired: false,
    as_at: '2026-01-20',
    basis: 'kampala;reversals_excluded',
  };

  const RENT_REQUEST_ROW = {
    id: RENT_REQUEST_ID,
    tenant_id: TENANT_ID,
    total_repayment: 300_000,
    duration_days: 60,
    daily_repayment: 5_000,
  };

  await page.route(`**://${SUPABASE_HOST}/**`, async (route) => {
    const req = route.request();
    const url = req.url();
    const method = req.method();

    // --- Auth ---
    if (url.includes('/auth/v1/user')) return json(route, session.user);
    // The SDK's session-refresh call (`/auth/v1/token`) must return the FULL
    // session shape or it treats the refresh as failed and signs out.
    if (url.includes('/auth/v1/token')) return json(route, session);
    if (url.startsWith(`https://${SUPABASE_HOST}/auth/v1/`)) return json(route, {});

    // --- Roles / gates ---
    if (url.includes('/rest/v1/user_roles')) {
      // useAuth.tsx's real query selects `role,enabled` — a row with no
      // `enabled` field gets filtered out as if the role were disabled.
      return json(route, [{ role: 'tenant_ops', user_id: USER_ID, enabled: true }]);
    }
    if (url.includes('/rest/v1/profiles')) {
      // Every caller here uses `.maybeSingle()`, which expects a bare object
      // (or null) in the response body — NOT an array-of-one. Returning an
      // array left every `.maybeSingle()` read silently seeing an array
      // instead of the row (no error, just wrong data), which is how the
      // NameCompletionGate/PhoneCollectionGate false positives above
      // happened.
      const match = /id=eq\.([^&]+)/.exec(url);
      const id = match ? decodeURIComponent(match[1]) : null;
      const row = id ? PROFILES[id] : undefined;
      return json(route, row ?? null);
    }
    if (url.includes('/rest/v1/rpc/tops_is_workspace_enabled')) return json(route, true);
    if (url.includes('/rest/v1/rpc/get_my_listing_block')) return json(route, { blocked: false });
    if (url.includes('/rest/v1/rpc/is_fraud_identifier_blocked')) return json(route, false);

    // --- Calling queue ---
    if (url.includes('/rest/v1/rpc/cc_call_queue_page')) return json(route, [CALLING_QUEUE_ROW]);
    if (url.includes('/rest/v1/rpc/cc_state_counts')) return json(route, [{ state: 'to_call', row_count: 1 }]);
    if (url.includes('/rest/v1/rpc/tops_calling_money_at_risk')) {
      return json(route, [{ tenant_id: TENANT_ID, rent_request_id: RENT_REQUEST_ID, money_at_risk_ugx: 65_000 }]);
    }

    // --- Reveal flow: no prior open attempt, so useCallReveal inserts one. ---
    // The GET (existing-attempt check) is `.maybeSingle()` (bare object/null);
    // the POST is `.select('id').single()` (also a bare object, not [obj]).
    if (url.includes('/rest/v1/cc_call_attempts')) {
      if (method === 'POST') return json(route, { id: ATTEMPT_ID });
      return json(route, null);
    }
    if (url.includes('/rest/v1/rpc/cc_reveal_phone')) return json(route, '+256700000002');

    // --- The tenant's plan --- both callers use `.maybeSingle()`.
    if (url.includes('/rest/v1/rent_requests')) return json(route, RENT_REQUEST_ROW);
    if (url.includes('/rest/v1/rpc/tops_plan_position')) return json(route, [PLAN_POSITION]);
    if (url.includes('/functions/v1/tops-tenant-brief')) {
      return json(route, {
        rent_request_id: RENT_REQUEST_ID,
        generated_at: new Date().toISOString(),
        narrative: null,
        degraded: true,
        facts: {
          as_at: PLAN_POSITION.as_at,
          basis: PLAN_POSITION.basis,
          tenant_name: 'Peter Okello',
          cadence: PLAN_POSITION.cadence,
          days_past_due: PLAN_POSITION.days_past_due,
          term_expired: PLAN_POSITION.term_expired,
          outstanding_ugx: PLAN_POSITION.outstanding_ugx,
          expected_to_date_ugx: PLAN_POSITION.expected_to_date_ugx,
          paid_to_date_ugx: PLAN_POSITION.paid_to_date_ugx,
          catch_up_daily_ugx: PLAN_POSITION.catch_up_daily_ugx,
          missed_instalments_count: 7,
          total_instalments_count: 20,
          last_promise: null,
          last_contact_at: null,
          last_contact_outcome: null,
          total_contact_attempts: 0,
        },
      });
    }
    if (url.includes('/rest/v1/rpc/tops_promise_kept_rate')) {
      return json(route, { kept: 0, taken: 0, kept_rate_pct: null });
    }
    if (url.includes('/rest/v1/rpc/tops_plan_schedule_ledger_count')) return json(route, 0);
    if (url.includes('/rest/v1/rpc/tops_plan_schedule_ledger')) return json(route, []);

    // --- Capture the writes "log a call, set a promise" is really about. ---
    if (url.includes('/rest/v1/rpc/cc_record_engaged')) {
      captured.push({ url, body: JSON.parse(req.postData() ?? '{}') });
      return json(route, null);
    }
    if (url.includes('/rest/v1/tops_call_outcomes') && method === 'POST') {
      const raw = JSON.parse(req.postData() ?? '{}');
      captured.push({ url, body: Array.isArray(raw) ? raw[0] : raw });
      return json(route, Array.isArray(raw) ? raw : [raw], 201);
    }
    if (url.includes('/rest/v1/tops_promises_to_pay') && method === 'POST') {
      const raw = JSON.parse(req.postData() ?? '{}');
      captured.push({ url, body: Array.isArray(raw) ? raw[0] : raw });
      return json(route, Array.isArray(raw) ? raw : [raw], 201);
    }

    // Generous catch-all: every other REST/RPC call (work items, promise-kept
    // rate, calling gap, call history, budget/feature-flag/onboarding-nag
    // lookups, etc.) returns an empty result, which every one of those
    // surfaces already handles as its natural "nothing here yet" state.
    return json(route, []);
  });
}

test.describe('Tenant Ops Workspace — Calling tab', () => {
  test('open the tab, open a tenant, read the position, log a call, and set a promise', async ({ page }) => {
    const captured: Captured[] = [];
    await seed(page, captured);

    // 1. Open the tab.
    await page.goto('/tenant-ops/workspace?section=calling');
    // The authenticated shell can show onboarding nags unrelated to this
    // flow — dismiss anything with a "Not now" exit before proceeding.
    for (let i = 0; i < 3; i++) {
      const notNow = page.getByRole('button', { name: 'Not now' });
      if (await notNow.isVisible({ timeout: 2_000 }).catch(() => false)) {
        await notNow.click();
      } else {
        break;
      }
    }
    await expect(page.getByRole('tab', { name: /to call/i })).toBeVisible({ timeout: 15_000 });

    // 2. Open a tenant — the queue's "Call" button is this workspace's own
    //    "open a tenant" affordance (it opens the tenant's CallPanel sheet).
    await page.getByRole('button', { name: 'Call', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Call', exact: true })).toBeVisible();

    // 3. Read the position.
    await expect(page.getByText(/Behind by/)).toBeVisible();
    await expect(page.getByText('UGX 35,000').first()).toBeVisible();

    // 4. Log a call with an outcome, and 5. set a promise.
    await page.getByLabel('Reached — promised to pay').check();
    await page.getByLabel('Amount (UGX)').fill('40000');
    await page.getByLabel('By date').fill('2026-02-15');
    await page.getByPlaceholder('Note (optional)').fill('Tenant confirmed by phone.');
    await page.getByRole('button', { name: 'Close call' }).click();

    await expect(page.getByRole('heading', { name: 'Call', exact: true })).not.toBeVisible();

    const engaged = captured.find((c) => c.url.includes('cc_record_engaged'));
    expect(engaged?.body).toMatchObject({ p_attempt_id: ATTEMPT_ID });

    const outcomeInsert = captured.find((c) => c.url.includes('tops_call_outcomes'));
    expect(outcomeInsert?.body).toMatchObject({
      cc_call_id: ATTEMPT_ID,
      rent_request_id: RENT_REQUEST_ID,
      outcome: 'promised',
      note: 'Tenant confirmed by phone.',
      recorded_by: USER_ID,
    });

    const promiseInsert = captured.find((c) => c.url.includes('tops_promises_to_pay'));
    expect(promiseInsert?.body).toMatchObject({
      rent_request_id: RENT_REQUEST_ID,
      tenant_user_id: TENANT_ID,
      cc_call_id: ATTEMPT_ID,
      promised_amount_ugx: 40_000,
      promised_date: '2026-02-15',
      channel: 'call',
      taken_by: USER_ID,
    });
  });
});
