import { test, expect, Page, Route } from '@playwright/test';

/**
 * The kill switch (docs/TOPS_RULES.md): the whole Tenant Ops Workspace must
 * render nothing but a plain unavailable state when tops_workspace_enabled
 * is off, and the real shell when it's on — turning it off must never need a
 * deploy or a revert. Permanent regression coverage, not a one-off check.
 */

const SUPABASE_HOST = 'wirntoujqoyjobfhyelc.supabase.co';
const PROJECT_REF = 'wirntoujqoyjobfhyelc';
const USER_ID = '00000000-0000-0000-0000-0000000000e2';
const STORAGE_KEY = `sb-${PROJECT_REF}-auth-token`;

function json(route: Route, body: unknown, status = 200) {
  return route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
}

async function seed(page: Page, workspaceEnabled: boolean) {
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
      email_confirmed_at: new Date().toISOString(),
      app_metadata: { provider: 'email' },
      user_metadata: {},
      created_at: new Date().toISOString(),
    },
  };
  await page.addInitScript(({ key, session }) => {
    try { localStorage.setItem(key, JSON.stringify(session)); } catch {}
  }, { key: STORAGE_KEY, session });

  await page.route(`**://${SUPABASE_HOST}/**`, async (route) => {
    const url = route.request().url();
    if (url.includes('/auth/v1/user')) return json(route, session.user);
    if (url.includes('/auth/v1/token')) return json(route, session);
    if (url.startsWith(`https://${SUPABASE_HOST}/auth/v1/`)) return json(route, {});
    if (url.includes('/rest/v1/user_roles')) {
      return json(route, [{ role: 'tenant_ops', user_id: USER_ID, enabled: true }]);
    }
    if (url.includes('/rest/v1/profiles')) {
      return json(route, {
        id: USER_ID, phone: '+256700000001', phone_verified: true, is_frozen: false,
        frozen_reason: null, full_name: 'Grace Namono', mobile_money_name: 'Grace Namono',
      });
    }
    if (url.includes('/rest/v1/rpc/tops_is_workspace_enabled')) return json(route, workspaceEnabled);
    if (url.includes('/rest/v1/rpc/get_my_listing_block')) return json(route, { blocked: false });
    return json(route, []);
  });
}

test('flag OFF: the workspace route renders only the unavailable state, nothing else', async ({ page }) => {
  await seed(page, false);
  await page.goto('/tenant-ops/workspace?section=today');
  await page.waitForTimeout(3000);
  for (let i = 0; i < 3; i++) {
    const notNow = page.getByRole('button', { name: 'Not now' });
    if (await notNow.isVisible({ timeout: 2_000 }).catch(() => false)) await notNow.click();
    else break;
  }
  await expect(page.getByText('This page is not available.')).toBeVisible({ timeout: 10_000 });
  // Nothing from the workspace shell (nav, tabs, KPI cards) should exist.
  await expect(page.getByRole('tab', { name: /to call/i })).toHaveCount(0);
  await expect(page.getByText('Today', { exact: true })).toHaveCount(0);
});

test('flag ON: the same route renders the real workspace shell', async ({ page }) => {
  await seed(page, true);
  await page.goto('/tenant-ops/workspace?section=today');
  await page.waitForTimeout(3000);
  for (let i = 0; i < 3; i++) {
    const notNow = page.getByRole('button', { name: 'Not now' });
    if (await notNow.isVisible({ timeout: 2_000 }).catch(() => false)) await notNow.click();
    else break;
  }
  await expect(page.getByText('This page is not available.')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Calling' })).toBeVisible({ timeout: 10_000 });
});
