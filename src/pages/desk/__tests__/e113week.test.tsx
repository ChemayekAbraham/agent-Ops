import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

/** E113: "Yesterday | Last week" on the Arrears calls tabs. E114: the push banner and the bell's 07:30 call list. */

const h = vi.hoisted(() => ({
  rpc: vi.fn(),
  from: vi.fn(),
  ensure: vi.fn(),
  notices: [] as Record<string, unknown>[],
  inserted: [] as unknown[],
}));
vi.mock('@/integrations/supabase/client', () => {
  // A small query builder: every step returns itself, and awaiting it gives the rows for its table.
  const builder = (table: string) => {
    const b: Record<string, unknown> = {};
    const self = () => b;
    for (const m of ['select', 'eq', 'is', 'order', 'limit', 'update', 'delete']) b[m] = vi.fn(self);
    b.insert = vi.fn((row: unknown) => {
      h.inserted.push({ table, row });
      return Promise.resolve({ error: null });
    });
    b.then = (ok: (v: unknown) => unknown) => Promise.resolve({ data: table === 'notifications' ? h.notices : [], error: null }).then(ok);
    return b;
  };
  const channel = { on: () => channel, subscribe: () => channel };
  return {
    supabase: {
      rpc: (...a: unknown[]) => h.rpc(...a),
      from: (t: string) => {
        h.from(t);
        return builder(t);
      },
      channel: () => channel,
      removeChannel: vi.fn(),
      storage: { from: vi.fn() },
    },
  };
});
vi.mock('@/hooks/useAuth', () => ({ useAuth: () => ({ user: { id: 'u1' }, roles: ['tenant_ops'] }) }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('@/lib/webPush', () => ({
  isPushSupported: () => true,
  isInIframe: () => false,
  isLegacyPushOrigin: () => false,
  subscriptionUsesCurrentVapidKey: () => true,
  ensurePushSubscription: (...a: unknown[]) => h.ensure(...a),
}));

import { TenantArrearsTab } from '../arrears/TenantArrearsTab';
import { AgentArrearsTab } from '../arrears/AgentArrearsTab';
import { daysShortText, defaultWatchMode, lastSundayKampala } from '../arrears/arrearsApi';
import { BANNER_TEXT, DeskPushBanner } from '../DeskPushBanner';
import { DeskBell, deskNotificationTarget } from '../DeskBell';

const ZERO = { plans: 0, agents: 0, due: 0, collected: 0, shortfall: 0, arrears_to_date: 0, new_slip: 0, new_plan: 0, behind: 0, silent: 0, tenant_called: 0, agent_called: 0 };
const row = (id: string, freq: string, days_short: number | null) => ({
  rent_request_id: id,
  tier: 'behind',
  frequency: freq,
  daily_due: 10000,
  window_due: 70000,
  days_short,
  collected: 20000,
  pct: 28.6,
  arrears_to_date: 50000,
  last_paid_on: '2026-11-12',
  days_since_paid: 3,
  plan_day: 30,
  tenant: { id: `t-${id}`, name: `Tenant ${id}`, phone: '0772000111' },
  agent: { id: 'a1', name: 'Paul Okello', phone: '0700123456', collection_pct: 60, eligible: true },
  landlord: { id: 'l1', name: 'Grace L', phone: null },
  funder: { name: 'No named funder (Welile pool)' },
  tenant_ops_call: null,
  agent_ops_call: null,
});
const WEEK = { day: '2026-11-15', from: '2026-11-09', to: '2026-11-15', mode: 'week', tiers: {}, totals: { ...ZERO, plans: 2, agents: 1 }, matching: 2, rows: [row('d', 'daily', 3), row('w', 'weekly', null)] };
const DAY = { day: '2026-11-15', tiers: {}, totals: ZERO, matching: 0, rows: [] };

const wrap = (ui: ReactNode, path = '/desk/tenant-ops') =>
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter initialEntries={[path]}>{ui}</MemoryRouter>
    </QueryClientProvider>,
  );
const answer = (map: Record<string, unknown>) =>
  h.rpc.mockImplementation((fn: string) => Promise.resolve(fn in map ? (map[fn] as object) : { data: null, error: null }));
const findEl = (sel: string, root: ParentNode = document) =>
  waitFor(() => {
    const el = root.querySelector(sel) as HTMLElement | null;
    expect(el).toBeTruthy();
    return el!;
  });

// Monday 16 Nov 2026, 09:00 in Kampala; Tuesday 17 Nov.
const MONDAY = new Date('2026-11-16T06:00:00Z');
const TUESDAY = new Date('2026-11-17T06:00:00Z');
const setNow = (d: Date) => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(d);
};

beforeEach(() => {
  h.rpc.mockReset();
  h.ensure.mockReset();
  h.notices = [];
  h.inserted = [];
});
afterEach(() => vi.useRealTimers());

describe('the week', () => {
  it('ends on the most recent Sunday before today (the server’s own default); Mondays open on last week', () => {
    expect(lastSundayKampala(MONDAY)).toBe('2026-11-15');
    expect(lastSundayKampala(TUESDAY)).toBe('2026-11-15');
    expect(lastSundayKampala(new Date('2026-11-15T09:00:00Z'))).toBe('2026-11-08'); // a Sunday reads the week before
    expect(defaultWatchMode(MONDAY)).toBe('week');
    expect(defaultWatchMode(TUESDAY)).toBe('day');
  });
  it('days_short as "missed X of 7 days" for daily plans, nothing for weekly ones', () => {
    expect(daysShortText({ days_short: 3, frequency: 'daily' })).toBe('missed 3 of 7 days');
    expect(daysShortText({ days_short: null, frequency: 'weekly' })).toBeNull();
    expect(daysShortText({ days_short: 4, frequency: 'weekly' })).toBeNull();
    expect(daysShortText({ days_short: undefined, frequency: 'daily' })).toBeNull();
  });
});

describe('Tenant Ops · Yesterday | Last week', () => {
  it('Monday opens on last week: the week RPC, the date range, "missed X of 7 days"; the toggle goes back to yesterday', async () => {
    setNow(MONDAY);
    answer({ arrears_watch_week: { data: WEEK, error: null }, arrears_watch: { data: DAY, error: null } });
    wrap(<TenantArrearsTab board={false} />);
    expect((await findEl('[data-watch-range]')).textContent).toBe('Arrears for 9 Nov 2026 – 15 Nov 2026');
    expect(h.rpc).toHaveBeenCalledWith('arrears_watch_week', { p_week_end: '2026-11-15', p_tier: null, p_search: null, p_limit: 50, p_offset: 0 });
    expect(screen.getByRole('button', { name: 'Last week' }).getAttribute('aria-pressed')).toBe('true');
    expect(document.querySelector('[data-tenant-card="d"] [data-days-short]')?.textContent).toBe('missed 3 of 7 days');
    expect(document.querySelector('[data-tenant-card="w"] [data-days-short]')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Yesterday' }));
    await waitFor(() => expect(h.rpc).toHaveBeenCalledWith('arrears_watch', { p_day: '2026-11-15', p_tier: null, p_search: null, p_limit: 50, p_offset: 0 }));
    expect((await findEl('[data-watch-range]')).textContent).toBe('Arrears for 15 Nov 2026');
  });

  it('another day opens on yesterday', async () => {
    setNow(TUESDAY);
    answer({ arrears_watch: { data: { ...DAY, day: '2026-11-16' }, error: null } });
    wrap(<TenantArrearsTab board={false} />);
    await findEl('[data-watch-range]');
    expect(h.rpc).toHaveBeenCalledWith('arrears_watch', expect.objectContaining({ p_day: '2026-11-16' }));
    expect(h.rpc.mock.calls.some((c) => c[0] === 'arrears_watch_week')).toBe(false);
    expect(screen.getByRole('button', { name: 'Yesterday' }).getAttribute('aria-pressed')).toBe('true');
  });

  it('a call logged in week mode belongs to the week’s last day (`to`)', async () => {
    setNow(MONDAY);
    answer({ arrears_watch_week: { data: { ...WEEK, to: '2026-11-15' }, error: null }, arrears_log_call: { data: { ok: true }, error: null } });
    wrap(<TenantArrearsTab board={false} />);
    const card = await findEl('[data-tenant-card="d"]');
    fireEvent.click(within(card).getByRole('button', { name: 'Log call' }));
    const sheet = await screen.findByRole('dialog', { name: 'Log call · Tenant d' });
    fireEvent.change(sheet.querySelector('[data-outcome]')!, { target: { value: 'no_answer' } });
    fireEvent.click(within(sheet).getByRole('button', { name: 'Save call' }));
    await waitFor(() => expect(h.rpc.mock.calls.some((c) => c[0] === 'arrears_log_call')).toBe(true));
    expect(h.rpc.mock.calls.find((c) => c[0] === 'arrears_log_call')![1]).toEqual(expect.objectContaining({ p_day: '2026-11-15', p_desk: 'tenant-ops' }));
  });
});

describe('Agent Ops · Last week', () => {
  it('reads arrears_watch_week_agents; an agent’s tenants come from arrears_watch_week', async () => {
    setNow(MONDAY);
    answer({
      arrears_watch_week_agents: {
        data: {
          day: '2026-11-15',
          from: '2026-11-09',
          to: '2026-11-15',
          mode: 'week',
          agents: [{ agent_id: 'a1', name: 'Paul Okello', phone: '0700123456', tenants_short: 2, shortfall: 1, arrears_to_date: 1, new_slip: 0, new_plan: 0, behind: 2, silent: 0, collection_pct: 60, eligible: true, agent_ops_call: null }],
        },
        error: null,
      },
      arrears_watch_week: { data: WEEK, error: null },
    });
    wrap(<AgentArrearsTab board={false} />, '/desk/agent-ops');
    const rowEl = await findEl('[data-agent-row="a1"]');
    expect(h.rpc).toHaveBeenCalledWith('arrears_watch_week_agents', { p_week_end: '2026-11-15' });
    expect(document.querySelector('[data-watch-range]')?.textContent).toBe('Arrears for 9 Nov 2026 – 15 Nov 2026');
    fireEvent.click(rowEl.querySelector('[data-expand]')!);
    await findEl('[data-tenant-card="d"]', rowEl);
    expect(h.rpc).toHaveBeenCalledWith('arrears_watch_week', { p_week_end: '2026-11-15', p_tier: null, p_search: '0700123456', p_limit: 500, p_offset: 0 });
    expect(rowEl.querySelector('[data-tenant-card="d"] [data-days-short]')?.textContent).toBe('missed 3 of 7 days');
  });
});

describe('the push banner', () => {
  const device = (permission: NotificationPermission, sub: object | null) => {
    vi.stubGlobal('Notification', { permission });
    Object.defineProperty(navigator, 'serviceWorker', {
      configurable: true,
      value: { getRegistration: vi.fn().mockResolvedValue({ pushManager: { getSubscription: vi.fn().mockResolvedValue(sub) } }) },
    });
  };
  afterEach(() => vi.unstubAllGlobals());

  it('shows without a subscription on this device; a tap subscribes and saves it, and the banner goes', async () => {
    device('default', null);
    h.ensure.mockImplementation(async (save: (s: object) => Promise<void>) => {
      await save({ endpoint: 'https://push/e1', p256dh: 'k', auth: 'a' });
      return { ok: true, endpoint: 'https://push/e1', p256dh: 'k', auth: 'a' };
    });
    wrap(<DeskPushBanner />);
    const banner = await findEl('[data-push-banner]');
    expect(banner.textContent).toContain(BANNER_TEXT);
    fireEvent.click(within(banner).getByRole('button', { name: 'Turn on notifications' }));
    await waitFor(() => expect(document.querySelector('[data-push-banner]')).toBeNull());
    expect(h.ensure).toHaveBeenCalledTimes(1);
    expect(h.inserted).toEqual([{ table: 'push_subscriptions', row: { user_id: 'u1', endpoint: 'https://push/e1', p256dh: 'k', auth: 'a' } }]);
  });

  it('hidden when this device is already subscribed', async () => {
    device('granted', { endpoint: 'https://push/e1' });
    const { container } = wrap(<DeskPushBanner />);
    await new Promise((r) => setTimeout(r, 20));
    expect(container.querySelector('[data-push-banner]')).toBeNull();
  });

  it('a refusal (blocked in the browser) stays on the banner in the browser’s words', async () => {
    device('default', null);
    h.ensure.mockResolvedValue({ ok: false, reason: 'blocked', message: 'Notifications are blocked for this site.' });
    wrap(<DeskPushBanner />);
    const banner = await findEl('[data-push-banner]');
    fireEvent.click(within(banner).getByRole('button', { name: 'Turn on notifications' }));
    expect((await within(banner).findByRole('alert')).textContent).toBe('Notifications are blocked for this site.');
  });
});

describe('the 07:30 call list in the bell', () => {
  it('a desk_morning_brief opens that desk’s Arrears calls tab', () => {
    expect(deskNotificationTarget({ type: 'desk_morning_brief', link_path: '/desk/agent-ops' })).toBe('/desk/agent-ops?tab=arrears');
    expect(deskNotificationTarget({ type: 'desk_morning_brief', link_path: '/desk/tenant-ops' })).toBe('/desk/tenant-ops?tab=arrears');
    expect(deskNotificationTarget({ type: 'desk_send_back', link_path: '/desk/agent-ops' })).toBe('/desk/agent-ops');
    expect(deskNotificationTarget({ type: 'info', link_path: null })).toBeNull();
  });

  it('the bell lists it unread; a tap marks it read and goes to /desk/tenant-ops?tab=arrears', async () => {
    h.notices = [
      { id: 'n1', title: 'Good morning - your calls today (Tenant Ops)', message: '37 tenants to call for Sun 15 Nov. Open Arrears calls.', type: 'desk_morning_brief', is_read: false, created_at: new Date().toISOString(), link_path: '/desk/tenant-ops' },
    ];
    const Where = () => {
      const l = useLocation();
      return <span data-where>{l.pathname + l.search}</span>;
    };
    wrap(
      <Routes>
        <Route
          path="*"
          element={
            <>
              <DeskBell />
              <Where />
            </>
          }
        />
      </Routes>,
      '/desk/agent-ops',
    );
    const bell = await screen.findByRole('button', { name: 'Notifications, 1 unread' });
    fireEvent.click(bell);
    const notice = await findEl('[data-notice="desk_morning_brief"]');
    expect(notice.textContent).toContain('Good morning - your calls today (Tenant Ops)');
    fireEvent.click(notice);
    await waitFor(() => expect(document.querySelector('[data-where]')?.textContent).toBe('/desk/tenant-ops?tab=arrears'));
    expect(screen.getByRole('button', { name: 'Notifications' })).toBeTruthy();
  });

  it('the desk opens its second tab (Arrears calls) for ?tab=arrears, also when it is already open; a push tap gets the same link', () => {
    const page = readFileSync(resolve(__dirname, '../DeskPage.tsx'), 'utf8');
    expect(page).toContain("deskParams.get('tab') && deskParams.get('tab') !== 'queue' ? 'extra' : 'queue'");
    expect(page).toContain("if (tabParam) setTab(tabParam !== 'queue' ? 'extra' : 'queue');");
    expect(page).toContain("'agent-ops': 'Arrears calls'");
    expect(page).toContain("'tenant-ops': 'Arrears calls'");
    expect(page).toContain('{!board && <DeskBell />}');
    expect(page).toContain("{!board && (desk.id === 'agent-ops' || desk.id === 'tenant-ops') && <DeskPushBanner />}");
    const sw = readFileSync(resolve(__dirname, '../../../../public/sw.js'), 'utf8');
    expect(sw).toContain("data.type === 'desk_morning_brief'");
    expect(sw).toContain("target.replace(/\\/$/, '') + '?tab=arrears'");
  });
});
