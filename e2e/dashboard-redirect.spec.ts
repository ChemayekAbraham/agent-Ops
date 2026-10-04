import { test, expect, Page } from '@playwright/test';

/**
 * End-to-end tests for DashboardRedirect ("why you were sent here" toasts).
 *
 * Strategy: we don't go through real auth. We seed a fake Supabase session
 * into localStorage and intercept all calls to the Supabase REST + auth
 * endpoints so the AuthProvider sees a stable user with configurable
 * roles, and the rent_requests count can be tuned per-scenario.
 *
 * Each test then visits `/dashboard` (or `/dashboard/agent`) and asserts
 * the sonner toast description that explains the routing decision.
 */

const SUPABASE_HOST = 'wirntoujqoyjobfhyelc.supabase.co';
const PROJECT_REF = 'wirntoujqoyjobfhyelc';
const USER_ID = '00000000-0000-0000-0000-000000000abc';
const EMAIL = 'e2e@welile.test';
const STORAGE_KEY = `sb-${PROJECT_REF}-auth-token`;

type Scenario = {
  roles: string[];
  rentRequestsCount: number;
  routingPrefs?: Record<string, unknown>;
  /** Pre-seeded local app prefs (`welile_app_preferences`). */
  localPrefs?: Record<string, unknown>;
  /** Pre-seeded `welile_has_posted_rent_request_<uid>` cache. */
  rentCache?: '1' | '0';
  /** Optional cached last role (`welile_last_role`). */
  lastRole?: string;
};

async function seedAuthAndRoutes(page: Page, scenario: Scenario) {
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
      email: EMAIL,
      app_metadata: { provider: 'email' },
      user_metadata: {},
      created_at: new Date().toISOString(),
    },
  };

  await page.addInitScript(
    ({ key, session, localPrefs, rentCache, uid, lastRole }) => {
      try {
        localStorage.setItem(key, JSON.stringify(session));
      } catch {}
      if (localPrefs) {
        try { localStorage.setItem('welile_app_preferences', JSON.stringify(localPrefs)); } catch {}
      }
      if (rentCache !== undefined) {
        try { localStorage.setItem(`welile_has_posted_rent_request_${uid}`, rentCache); } catch {}
      }
      if (lastRole) {
        try { localStorage.setItem('welile_last_role', lastRole); } catch {}
      }
    },
    {
      key: STORAGE_KEY,
      session,
      localPrefs: scenario.localPrefs ?? null,
      rentCache: scenario.rentCache,
      uid: USER_ID,
      lastRole: scenario.lastRole,
    },
  );

  // Block ALL traffic to supabase host by default, then handle specific
  // endpoints below. Order matters: more specific routes register first.
  await page.route(`**://${SUPABASE_HOST}/auth/v1/user**`, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(session.user) }),
  );

  await page.route(`**://${SUPABASE_HOST}/auth/v1/token**`, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(session) }),
  );

  // user_roles: return rows matching scenario.roles
  await page.route(`**://${SUPABASE_HOST}/rest/v1/user_roles**`, (route) => {
    const rows = scenario.roles.map((r) => ({ role: r, user_id: USER_ID }));
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(rows) });
  });

  // profiles: routing_preferences fetch
  await page.route(`**://${SUPABASE_HOST}/rest/v1/profiles**`, (route) => {
    const url = route.request().url();
    if (url.includes('routing_preferences')) {
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([{ routing_preferences: scenario.routingPrefs ?? {} }]),
      });
      return;
    }
    // updates / other selects — just ack
    route.fulfill({ status: 200, contentType: 'application/json', body: '[]' });
  });

  // rent_requests count
  await page.route(`**://${SUPABASE_HOST}/rest/v1/rent_requests**`, (route) => {
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      headers: { 'content-range': `0-0/${scenario.rentRequestsCount}` },
      body: '[]',
    });
  });

  // Catch-all for any other supabase REST call — return empty array so
  // misc. queries (notifications, etc.) don't fail loudly.
  await page.route(`**://${SUPABASE_HOST}/rest/v1/**`, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }),
  );
}

/** Wait for a sonner toast whose description contains `substring`. */
async function expectToast(page: Page, substring: string) {
  // Sonner renders toasts inside `ol[data-sonner-toaster]` with each toast
  // a `<li>`; the description sits inside `[data-description]`.
  const desc = page.locator(`[data-description]`, { hasText: substring }).first();
  await expect(desc).toBeVisible({ timeout: 8000 });
}

test.describe('DashboardRedirect routing toasts', () => {
  test('agent with rent requests → opens agent dashboard with auto-rule reason', async ({ page }) => {
    await seedAuthAndRoutes(page, {
      roles: ['agent', 'tenant'],
      rentRequestsCount: 5,
      rentCache: '1', // skip DB roundtrip, deterministic
      localPrefs: {},
    });
    await page.goto('/dashboard');
    await expectToast(page, 'agent role and have posted a rent request');
    await expect(page).toHaveURL(/\/dashboard\/agent/);
  });

  test('agent with zero rent requests → falls back to last role', async ({ page }) => {
    await seedAuthAndRoutes(page, {
      roles: ['agent', 'tenant'],
      rentRequestsCount: 0,
      rentCache: '0',
      lastRole: 'tenant',
      localPrefs: {},
    });
    await page.goto('/dashboard');
    await expectToast(page, 'Continuing where you last left off');
    await expect(page).toHaveURL(/\/dashboard\/tenant/);
  });

  test('user opted out of agent auto-default → skips agent rule', async ({ page }) => {
    await seedAuthAndRoutes(page, {
      roles: ['agent', 'supporter'],
      rentRequestsCount: 99,
      localPrefs: { disableAgentAutoDefault: true },
      lastRole: 'supporter',
    });
    await page.goto('/dashboard');
    await expectToast(page, 'Continuing where you last left off');
    await expect(page).toHaveURL(/\/dashboard\/funder/);
  });

  test('chosen default in Settings wins over agent auto-rule', async ({ page }) => {
    await seedAuthAndRoutes(page, {
      roles: ['agent', 'supporter'],
      rentRequestsCount: 10,
      rentCache: '1',
      localPrefs: { defaultRole: 'supporter' },
    });
    await page.goto('/dashboard');
    await expectToast(page, 'Matches your chosen home screen');
    await expect(page).toHaveURL(/\/dashboard\/funder/);
  });

  test('direct /dashboard/agent URL → opened-directly reason', async ({ page }) => {
    await seedAuthAndRoutes(page, {
      roles: ['agent', 'tenant'],
      rentRequestsCount: 0,
      localPrefs: {},
    });
    await page.goto('/dashboard/agent');
    await expectToast(page, 'opened this URL directly');
    await expect(page).toHaveURL(/\/dashboard\/agent/);
  });

  test('?role= hint → followed-link reason', async ({ page }) => {
    await seedAuthAndRoutes(page, {
      roles: ['agent', 'tenant'],
      rentRequestsCount: 0,
      localPrefs: {},
    });
    await page.goto('/dashboard?role=agent');
    await expectToast(page, 'Followed the role hint in your link');
    await expect(page).toHaveURL(/\/dashboard\/agent/);
  });

  test('no local prefs + server defaultRole → synced reason', async ({ page }) => {
    await seedAuthAndRoutes(page, {
      roles: ['agent', 'supporter'],
      rentRequestsCount: 10,
      routingPrefs: { defaultRole: 'supporter' },
      // no localPrefs at all → server fallback path runs
    });
    await page.goto('/dashboard');
    await expectToast(page, 'Synced from your saved choice on another device');
    await expect(page).toHaveURL(/\/dashboard\/funder/);
  });

  test('revoked agent role → never lands on agent dashboard', async ({ page }) => {
    await seedAuthAndRoutes(page, {
      roles: ['tenant'], // agent revoked
      rentRequestsCount: 100,
      rentCache: '1',
      lastRole: 'tenant',
      localPrefs: {},
    });
    await page.goto('/dashboard');
    await expect(page).not.toHaveURL(/\/dashboard\/agent/);
    await expectToast(page, 'Continuing where you last left off');
  });
});