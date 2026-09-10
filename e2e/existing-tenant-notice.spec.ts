import { test, expect, type Route } from '@playwright/test';

/**
 * Verifies the agent "existing tenant" rent-request flow:
 *   - When an agent types a phone number that already belongs to a registered
 *     tenant, the `ExistingTenantPhoneNotice` reveals the tenant, their
 *     OUTSTANDING BALANCE and the PREVIOUS AGENT.
 *   - The Renew button is present and, when clicked, fires the renew action.
 *
 * Drives the dev-only harness at /__e2e/existing-tenant-notice and intercepts
 * the platform lookups (profiles + get_tenant_rent_summary RPC) so the test
 * needs no auth or seeded rows.
 */

const HARNESS = '/__e2e/existing-tenant-notice';

const TENANT_ID = '11111111-1111-1111-1111-111111111111';
const TENANT_NAME = 'Jane Existing Tenant';
const PREV_AGENT_NAME = 'Peter Previous Agent';
const PREV_AGENT_PHONE = '0782000111';
const OUTSTANDING = 450000;

async function stubPlatform(page) {
  // Live phone lookup -> return the existing tenant profile.
  await page.route('**/rest/v1/profiles*', (route: Route) => {
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify([
        {
          id: TENANT_ID,
          full_name: TENANT_NAME,
          phone: '0700000001',
          national_id: 'CM99001122334',
          avatar_url: null,
        },
      ]),
    });
  });

  // Tenant rent summary RPC -> outstanding balance + previous agent.
  await page.route('**/rest/v1/rpc/get_tenant_rent_summary*', (route: Route) => {
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify([
        {
          tenant_id: TENANT_ID,
          outstanding_balance: OUTSTANDING,
          total_obligation: 600000,
          total_repaid: 150000,
          active_plan_count: 1,
          latest_request_id: '22222222-2222-2222-2222-222222222222',
          latest_status: 'repaying',
          latest_registration_type: 'standard',
          latest_daily_repayment: 15000,
          latest_created_at: '2026-06-01T10:00:00Z',
          previous_agent_id: '33333333-3333-3333-3333-333333333333',
          previous_agent_name: PREV_AGENT_NAME,
          previous_agent_phone: PREV_AGENT_PHONE,
        },
      ]),
    });
  });
}

test.beforeEach(async ({ page }) => {
  await stubPlatform(page);
  await page.goto(HARNESS, { waitUntil: 'networkidle' });
  await expect(page.getByTestId('e2e-existing-tenant-notice-harness')).toBeVisible();
});

test('shows outstanding balance + previous agent and Renew works', async ({ page }) => {
  // Agent types the existing tenant's phone number.
  await page.getByTestId('tenant-phone-input').fill('0700000001');

  // The notice reveals the already-registered tenant.
  await expect(page.getByText(/already on Welile/i)).toBeVisible();
  await expect(page.getByText(new RegExp(TENANT_NAME, 'i')).first()).toBeVisible();

  // Outstanding balance is shown prominently (UGX 450,000).
  await expect(page.getByText(/Outstanding Balance/i)).toBeVisible();
  await expect(page.getByText(/UGX\s*450,000/i)).toBeVisible();

  // Previous agent details are shown.
  await expect(page.getByText(/Previous agent:/i)).toBeVisible();
  await expect(page.getByText(new RegExp(PREV_AGENT_NAME, 'i')).first()).toBeVisible();

  // Renew button is present and functional.
  const renewBtn = page.getByRole('button', { name: /Renew/i });
  await expect(renewBtn).toBeVisible();
  await renewBtn.click();

  await expect(page.getByTestId('renew-result')).toContainText(TENANT_NAME);
});

test('offers the "Use their details" action too', async ({ page }) => {
  await page.getByTestId('tenant-phone-input').fill('0700000001');

  const useBtn = page.getByRole('button', { name: /Use their details/i });
  await expect(useBtn).toBeVisible();
  await useBtn.click();

  await expect(page.getByTestId('use-result')).toContainText(TENANT_NAME);
});
