import { test, expect, Page, Route } from '@playwright/test';

/**
 * E2E coverage for the agent Business Advance request dialog — specifically
 * that GPS capture, manual location entry, and phonebook (Contact Picker)
 * selection survive end-to-end and land in the `business_advances` insert
 * payload (including the `location_history` audit trail).
 *
 * Strategy: we mount the dialog in isolation via the dev-only harness route
 * `/__e2e/business-advance` so we don't have to stub the entire agent
 * dashboard. Geolocation is provided by Playwright's `context.geolocation`,
 * the Contact Picker API is shimmed into `navigator.contacts` via
 * `addInitScript`, and every Supabase REST/Function call is intercepted so
 * the dialog runs against a fully deterministic backend.
 */

const SUPABASE_HOST = 'wirntoujqoyjobfhyelc.supabase.co';
const PROJECT_REF = 'wirntoujqoyjobfhyelc';
const USER_ID = '00000000-0000-0000-0000-000000000abc';
const STORAGE_KEY = `sb-${PROJECT_REF}-auth-token`;

type CapturedInsert = { url: string; body: Record<string, unknown> };

async function seed(page: Page) {
  const session = {
    access_token: 'fake',
    refresh_token: 'fake',
    token_type: 'bearer',
    expires_in: 3600,
    expires_at: Math.floor(Date.now() / 1000) + 3600,
    user: {
      id: USER_ID,
      aud: 'authenticated',
      role: 'authenticated',
      email: 'e2e-agent@welile.test',
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

      // Shim navigator.contacts (Contact Picker API) — Playwright/Chromium
      // does not expose it by default. The dialog only checks for
      // `navigator.contacts.select` existence + calls it once.
      Object.defineProperty(navigator, 'contacts', {
        configurable: true,
        value: {
          select: async (_props: string[]) => [
            { name: ['John Picked'], tel: ['+256 700 999 888'] },
          ],
          getProperties: async () => ['name', 'tel'],
        },
      });

      // Stub the OSM Nominatim reverse-geocode call so tests are offline-safe.
      const origFetch = window.fetch.bind(window);
      window.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === 'string' ? input : input.toString();
        if (url.startsWith('https://nominatim.openstreetmap.org/')) {
          return Promise.resolve(
            new Response(
              JSON.stringify({
                display_name: 'Test Road 1, Bukoto, Kampala',
                address: {
                  road: 'Test Road',
                  suburb: 'Bukoto',
                  city: 'Kampala',
                },
              }),
              { status: 200, headers: { 'content-type': 'application/json' } },
            ),
          );
        }
        return origFetch(input as RequestInfo, init);
      }) as typeof fetch;
    },
    { key: STORAGE_KEY, session },
  );

  // Auth endpoints
  await page.route(`**://${SUPABASE_HOST}/auth/v1/**`, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(session.user) }),
  );

  // user_roles → agent
  await page.route(`**://${SUPABASE_HOST}/rest/v1/user_roles**`, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify([{ role: 'agent', user_id: USER_ID }]),
    }),
  );

  // Generous catch-all so unrelated lookups don't error.
  await page.route(`**://${SUPABASE_HOST}/rest/v1/**`, async (route) => {
    const req = route.request();
    const url = req.url();
    // Existing-tenant phone lookup — return "no match" so register-tenant fires.
    if (url.includes('/rest/v1/profiles') && req.method() === 'GET') {
      await route.fulfill({ status: 200, contentType: 'application/json', body: '[]' });
      return;
    }
    await route.fulfill({ status: 200, contentType: 'application/json', body: '[]' });
  });

  // register-tenant edge function → fixed tenant id
  await page.route(`**://${SUPABASE_HOST}/functions/v1/register-tenant`, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ user_id: '11111111-1111-1111-1111-111111111111' }),
    }),
  );
}

/** Install a one-shot interceptor on the `business_advances` POST and resolve
 *  with the parsed body the dialog sends. */
async function captureBusinessAdvanceInsert(page: Page): Promise<Promise<CapturedInsert>> {
  let resolve!: (v: CapturedInsert) => void;
  const pending = new Promise<CapturedInsert>((r) => {
    resolve = r;
  });

  await page.route(`**://${SUPABASE_HOST}/rest/v1/business_advances**`, async (route: Route) => {
    const req = route.request();
    if (req.method() === 'POST') {
      const raw = req.postData() ?? '{}';
      let body: Record<string, unknown> = {};
      try {
        const parsed = JSON.parse(raw);
        body = Array.isArray(parsed) ? parsed[0] : parsed;
      } catch {
        body = {};
      }
      resolve({ url: req.url(), body });
      await route.fulfill({
        status: 201,
        contentType: 'application/json',
        body: JSON.stringify([{ id: 'adv-1', ...body }]),
      });
      return;
    }
    await route.fulfill({ status: 200, contentType: 'application/json', body: '[]' });
  });

  return pending;
}

/** Drive the form to the confirm step and submit, returning the insert body. */
async function fillAndSubmit(
  page: Page,
  opts: {
    captureGps: boolean;
    useManualLocation: boolean;
    usePhonebookForAlt: boolean;
  },
) {
  // STEP 1 — Amount
  await page.getByPlaceholder('e.g. 500,000').fill('200000');
  await page
    .getByPlaceholder(/Restock|Why|reason/i)
    .first()
    .fill('Restock smartphone inventory for Q4 push.');
  await page.getByRole('button', { name: /Next.*Tenant/i }).click();

  // STEP 2 — Tenant info
  await page.getByPlaceholder('e.g. Sarah Nakato').fill('Sarah Test');
  await page.getByPlaceholder('0783 123 456').fill('0783123456');
  await page.getByPlaceholder('CM12345...').fill('CM1234567890');

  if (opts.usePhonebookForAlt) {
    // Click the phonebook icon next to the alternate phone field.
    const altRow = page.locator('label:has-text("Alternate phone")').locator('..');
    await altRow.getByRole('button', { name: /Pick from phonebook/i }).click();
  } else {
    await page.getByPlaceholder(/Second number/i).fill('0788888888');
  }

  // Next-of-kin + Guarantor are now required.
  const nokSection = page.locator('text=Next of kin').locator('..');
  await nokSection.getByPlaceholder('Full name *').fill('NoK Person');
  await nokSection.getByPlaceholder('Phone number *').fill('0700111222');
  await nokSection.getByPlaceholder(/Relationship/i).fill('Spouse');

  const guarSection = page.locator('text=Guarantor *').locator('..');
  await guarSection.getByPlaceholder('Full name *').fill('Guar Person');
  await guarSection.getByPlaceholder('Phone number *').fill('0700333444');

  if (opts.captureGps) {
    await page.getByRole('button', { name: /Capture applicant GPS/i }).click();
    // Wait for the green/amber accuracy badge to appear.
    await expect(page.getByText(/Applicant GPS captured/i)).toBeVisible({ timeout: 5000 });
  }
  if (opts.useManualLocation) {
    await page.getByPlaceholder(/Manual location/i).fill('Bukoto, near St. Jude');
    await page.getByPlaceholder(/Manual location/i).blur();
  }

  await page.getByRole('button', { name: /Next.*Business/i }).click();

  // STEP 3 — Business
  await page.getByPlaceholder("e.g. Sarah's Salon").fill('Test Shop');
  await page.getByRole('combobox').first().click();
  await page.getByRole('option').first().click();
  await page.getByPlaceholder('Plot 12, Kampala Road').fill('Plot 9, Test Rd');
  await page.getByRole('button', { name: /Capture.*location|GPS/i }).click();
  await expect(page.getByText(/Business location captured/i)).toBeVisible({ timeout: 5000 });

  await page.getByRole('button', { name: /Next.*Review|Review/i }).click();

  // STEP 4 — Confirm
  await page.getByRole('button', { name: /Submit|Confirm/i }).click();
}

test.describe('Business Advance dialog — location & phonebook persistence', () => {
  test.beforeEach(async ({ context }) => {
    await context.grantPermissions(['geolocation', 'contacts-select' as never]);
    await context.setGeolocation({ latitude: 0.3163, longitude: 32.5822, accuracy: 25 });
  });

  test('GPS capture persists lat/lng/accuracy + location_history entry', async ({ page }) => {
    await seed(page);
    const captured = await captureBusinessAdvanceInsert(page);
    await page.goto('/__e2e/business-advance');

    await fillAndSubmit(page, {
      captureGps: true,
      useManualLocation: false,
      usePhonebookForAlt: false,
    });

    const { body } = await captured;
    expect(body.applicant_latitude).toBeCloseTo(0.3163, 3);
    expect(body.applicant_longitude).toBeCloseTo(32.5822, 3);
    expect(body.applicant_location_accuracy).toBe(25);

    const history = body.location_history as Array<Record<string, unknown>>;
    expect(Array.isArray(history)).toBe(true);
    expect(history.some((h) => h.event === 'gps_captured' && h.source === 'applicant')).toBe(true);
    expect(history.some((h) => h.event === 'gps_captured' && h.source === 'business')).toBe(true);
  });

  test('manual location entry is persisted to applicant_location_manual + history', async ({ page }) => {
    await seed(page);
    const captured = await captureBusinessAdvanceInsert(page);
    await page.goto('/__e2e/business-advance');

    await fillAndSubmit(page, {
      captureGps: false,
      useManualLocation: true,
      usePhonebookForAlt: false,
    });

    const { body } = await captured;
    expect(body.applicant_location_manual).toBe('Bukoto, near St. Jude');
    const history = body.location_history as Array<Record<string, unknown>>;
    expect(
      history.some(
        (h) =>
          h.event === 'manual_edit' &&
          h.source === 'applicant' &&
          h.field === 'manual_location' &&
          String(h.value).includes('Bukoto'),
      ),
    ).toBe(true);
  });

  test('phonebook selection populates alternate phone (normalised to UG format)', async ({ page }) => {
    await seed(page);
    const captured = await captureBusinessAdvanceInsert(page);
    await page.goto('/__e2e/business-advance');

    await fillAndSubmit(page, {
      captureGps: false,
      useManualLocation: true,
      usePhonebookForAlt: true,
    });

    const { body } = await captured;
    // The stub returned "+256 700 999 888" → normaliseUgPhone → "0700999888"
    expect(body.tenant_alternate_phone).toBe('0700999888');
  });
});