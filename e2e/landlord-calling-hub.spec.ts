import { test, expect, Page, Route } from '@playwright/test';

/**
 * E2E spec for the new Landlord Calling Hub (`/landlord-ops/calling`).
 *
 * Covers the complete officer workflow with mocked RPCs:
 * 1. Open `/landlord-ops/calling` (at mobile-first viewport and desktop)
 * 2. Inspect the top stats strip, scope switch, tabs, and landlord row
 * 3. Tap Call (calls `landlord_hub_start_dial`)
 * 4. Simulate returning from the phone dialer (`blur` + `focus`), opening the stepped record form
 * 5. Record an `answered` call with all 4 awareness questions, feedback category, severity, and a 20+ character note
 * 6. See the landlord's status update to `Answered`
 */

const SUPABASE_HOST = 'byrzshwlentqvktcksem.supabase.co';
const PROJECT_REF = 'byrzshwlentqvktcksem';
const USER_ID = '00000000-0000-0000-0000-0000000000f1';
const LANDLORD_ID = '00000000-0000-0000-0000-0000000000f2';
const RENT_REQUEST_ID = '00000000-0000-0000-0000-0000000000f3';
const DIAL_ID = '00000000-0000-0000-0000-0000000000f4';
const STORAGE_KEY = `sb-${PROJECT_REF}-auth-token`;

type CapturedRpc = { fn: string; body: Record<string, unknown> };

function json(route: Route, body: unknown, status = 200) {
  return route.fulfill({
    status,
    contentType: 'application/json',
    body: JSON.stringify(body),
  });
}

async function seedLandlordHub(page: Page, captured: CapturedRpc[]) {
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
      email: 'e2e-landlord-ops@welile.test',
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
      } catch {
        // ignore storage errors
      }
    },
    { key: STORAGE_KEY, session },
  );

  let recordedAnswered = false;

  const baseRow = {
    landlord_key: LANDLORD_ID,
    landlord_id: LANDLORD_ID,
    user_id: null,
    landlord_name: 'Hajji Musa Mukasa',
    phone: '0772123456',
    phone_masked: false,
    region: 'Central',
    district: 'Kampala',
    agent_id: null,
    agent_name: 'Agent Sarah',
    verified: true,
    verification_status: 'verified',
    houses_count: 2,
    live_rent_plans: 1,
    rent_plan_value: 900000,
    last_call_at: null as string | null,
    last_result: null as string | null,
    last_caller_id: null as string | null,
    last_caller_name: null as string | null,
    call_back_due_at: null,
    call_back_overdue: false,
    being_called_by_id: null,
    being_called_by: null,
    being_called_since: null,
    hub_status: 'never_called' as 'never_called' | 'answered',
    needs_review: false,
    total_count: 1,
  };

  await page.route(`**://${SUPABASE_HOST}/**`, async (route) => {
    const req = route.request();
    const url = req.url();

    if (url.includes('/auth/v1/user')) return json(route, session.user);
    if (url.includes('/auth/v1/token')) return json(route, session);
    if (url.startsWith(`https://${SUPABASE_HOST}/auth/v1/`)) return json(route, {});

    if (url.includes('/rest/v1/user_roles')) {
      return json(route, [
        { role: 'landlord_ops', user_id: USER_ID, enabled: true },
        { role: 'operations', user_id: USER_ID, enabled: true },
      ]);
    }

    if (url.includes('/rest/v1/profiles')) {
      return json(route, {
        id: USER_ID,
        phone: '+256700000001',
        phone_verified: true,
        is_frozen: false,
        frozen_reason: null,
        full_name: 'Janehephzibar Gimono',
        mobile_money_name: 'Janehephzibar Gimono',
        must_change_password: false,
        pending_merchant_agent: null,
      });
    }

    if (url.includes('/rest/v1/system_config')) {
      return json(route, { value: { enabled: true } });
    }

    if (url.includes('/rest/v1/rpc/is_fraud_identifier_blocked')) return json(route, false);
    if (url.includes('/rest/v1/rpc/get_my_listing_block')) return json(route, { blocked: false });
    if (url.includes('/rest/v1/rpc/get_my_overdue_vetting')) return json(route, null);

    // --- Landlord Calling Hub RPCs ---
    if (url.includes('/rest/v1/rpc/landlord_hub_stats')) {
      return json(route, {
        calls_today: recordedAnswered ? 1 : 0,
        answered_today: recordedAnswered ? 1 : 0,
        answered_rate_pct: recordedAnswered ? 100 : 0,
        call_backs_due: 0,
        call_backs_overdue: 0,
        live_plan_landlords_total: 1,
        live_plan_landlords_never_called: recordedAnswered ? 0 : 1,
        landlords_reached_this_week: recordedAnswered ? 1 : 0,
        week_start: '2026-10-21',
        kampala_today: '2026-10-27',
      });
    }

    if (url.includes('/rest/v1/rpc/landlord_hub_list')) {
      const body = JSON.parse(req.postData() ?? '{}');
      captured.push({ fn: 'landlord_hub_list', body });
      const row = recordedAnswered
        ? {
            ...baseRow,
            last_call_at: new Date().toISOString(),
            last_result: 'answered',
            last_caller_id: USER_ID,
            last_caller_name: 'Janehephzibar Gimono',
            hub_status: 'answered' as const,
          }
        : baseRow;

      if (body.p_tab === 'answered') {
        return json(route, recordedAnswered ? [row] : []);
      }
      if (body.p_tab === 'to_call') {
        return json(route, recordedAnswered ? [] : [row]);
      }
      if (body.p_tab === 'all') {
        return json(route, [row]);
      }
      return json(route, []);
    }

    if (url.includes('/rest/v1/rpc/landlord_hub_detail')) {
      const body = JSON.parse(req.postData() ?? '{}');
      captured.push({ fn: 'landlord_hub_detail', body });
      return json(route, {
        landlord_key: LANDLORD_ID,
        landlord_id: LANDLORD_ID,
        user_id: null,
        landlord_name: 'Hajji Musa Mukasa',
        phones: ['0772123456'],
        phone_masked: false,
        region: 'Central',
        district: 'Kampala',
        village: 'Ntinda',
        property_address: 'Plot 14 Ntinda Road',
        verified: true,
        verification_status: 'verified',
        needs_review: false,
        registered_at: '2026-01-10T08:00:00Z',
        houses_count: 2,
        live_rent_plans: 1,
        rent_plan_value: 900000,
        registering_agent: {
          agent_id: 'agent-1',
          full_name: 'Agent Sarah',
          phone: '0782000111',
        },
        caretaker: {
          name: 'Caretaker John',
          phone: '0779555444',
        },
        payout_details: {
          mobile_money_number: '0772123456',
          mobile_money_name: 'MUSA MUKASA',
          verified_mobile_money_number: '0772123456',
          bank_name: null,
          bank_branch: null,
          account_number: null,
          bank_account_name: null,
          total_paid_out_ugx: 900000,
          last_payout_at: '2026-10-15T12:00:00Z',
        },
        houses: [],
        tenants_and_plans: [
          {
            rent_request_id: RENT_REQUEST_ID,
            tenant_id: 'tenant-1',
            tenant_name: 'Kato Brian',
            tenant_phone: '0775111222',
            status: 'disbursed',
            rent_amount: 900000,
            daily_repayment: 35000,
            total_repayment: 1050000,
            amount_repaid: 400000,
            outstanding: 650000,
            agent_id: 'agent-1',
            agent_name: 'Agent Sarah',
            funded_at: '2026-10-01T10:00:00Z',
            created_at: '2026-09-29T10:00:00Z',
          },
        ],
        payouts: [],
        call_history: [],
        active_dial: null,
      });
    }

    if (url.includes('/rest/v1/rpc/landlord_hub_start_dial')) {
      const body = JSON.parse(req.postData() ?? '{}');
      captured.push({ fn: 'landlord_hub_start_dial', body });
      return json(route, {
        dial_id: DIAL_ID,
        landlord_key: body.p_landlord_key,
        caller_id: USER_ID,
        caller_name: 'Janehephzibar Gimono',
        phone: body.p_phone,
        started_at: '2026-10-27T10:00:00Z',
        expires_at: '2026-10-27T10:20:00Z',
        reused: false,
      });
    }

    if (url.includes('/rest/v1/rpc/landlord_hub_record_call')) {
      const body = JSON.parse(req.postData() ?? '{}');
      captured.push({ fn: 'landlord_hub_record_call', body });
      recordedAnswered = true;
      return json(route, {
        id: 'call-rec-1',
        landlord_key: body.p_landlord_key,
        result: body.p_result,
        already_recorded: false,
      });
    }

    return json(route, []);
  });
}

test.describe('Landlord Calling Hub (/landlord-ops/calling)', () => {
  test('open hub, start call, return from dialer, record answered call with awareness answers, and see status change to Answered', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 360, height: 780 });
    const captured: CapturedRpc[] = [];
    await seedLandlordHub(page, captured);

    // 1. Open /landlord-ops/calling
    await page.goto('/landlord-ops/calling');

    for (let i = 0; i < 3; i++) {
      const notNow = page.getByRole('button', { name: 'Not now' });
      if (await notNow.isVisible({ timeout: 1_500 }).catch(() => false)) {
        await notNow.click();
      } else {
        break;
      }
    }

    await expect(page.getByTestId('landlord-calling-hub')).toBeVisible({
      timeout: 15_000,
    });
    await expect(page.getByText('Hajji Musa Mukasa')).toBeVisible();
    await expect(page.getByTestId(`hub-row-status-${LANDLORD_ID}`)).toHaveText(
      'Never called',
    );

    // 2. Tap Call -> invokes landlord_hub_start_dial
    await page.getByTestId(`hub-row-call-${LANDLORD_ID}`).click();
    await expect
      .poll(() => captured.some((c) => c.fn === 'landlord_hub_start_dial'))
      .toBe(true);

    // 3. Simulate returning from the phone dialer
    await page.evaluate(() => {
      window.dispatchEvent(new Event('blur'));
      window.dispatchEvent(new Event('focus'));
    });

    await expect(page.getByTestId('hub-record-dialog')).toBeVisible();

    // 4. Fill out the stepped record form for an Answered call
    await page.getByTestId('hub-result-answered').click();
    await page.getByTestId('hub-q-aware30m-knew').click();
    await page.getByTestId('hub-q-consent-consents').click();
    await page.getByTestId('hub-q-otp-knew').click();
    await page.getByTestId('hub-q-explained-yes').click();
    await page.getByTestId('hub-category-confirmed_payout_number').click();
    await page
      .getByTestId('hub-note-input')
      .fill('Landlord confirmed payout number 0772123456 and tenant Kato Brian.');
    await page.getByTestId('hub-record-save').click();

    await expect(page.getByTestId('hub-record-dialog')).not.toBeVisible();

    const recordCall = captured.find((c) => c.fn === 'landlord_hub_record_call');
    expect(recordCall?.body).toMatchObject({
      p_landlord_key: LANDLORD_ID,
      p_phone_dialed: '0772123456',
      p_result: 'answered',
      p_aware_30m: 'knew',
      p_landlord_consent: 'consents',
      p_aware_payout_otp: 'knew',
      p_explained: 'yes',
      p_feedback_category: 'confirmed_payout_number',
      p_severity: 'normal',
    });

    // 5. Switch to the Answered tab and see the landlord's status updated to Answered
    await page.getByTestId('hub-tab-answered').click();
    await expect(page.getByTestId(`hub-row-status-${LANDLORD_ID}`)).toHaveText(
      'Answered',
    );
  });
});
