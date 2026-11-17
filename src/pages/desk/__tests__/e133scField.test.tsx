import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import type { ReactNode } from 'react';

/** E133: the simple Service Centre view for field agents; Service Centre staff keep the full desk. */

const rpcMock = vi.fn();
const fromChain: Record<string, unknown> = {};
for (const k of ['select', 'eq', 'in', 'is', 'gte', 'lte', 'neq', 'order', 'limit', 'not', 'or']) fromChain[k] = () => fromChain;
fromChain.maybeSingle = () => Promise.resolve({ data: null, error: null });
fromChain.single = () => Promise.resolve({ data: null, error: null });
fromChain.then = (ok: (v: unknown) => unknown) => Promise.resolve({ data: [], error: null }).then(ok);
vi.mock('@/integrations/supabase/client', () => ({
  supabase: {
    rpc: (...a: unknown[]) => rpcMock(...a),
    from: () => fromChain,
    storage: { from: vi.fn() },
    channel: () => ({ on: function on() { return this; }, subscribe: () => ({}) }),
    removeChannel: vi.fn(),
    auth: { getSession: () => Promise.resolve({ data: { session: null } }), onAuthStateChange: () => ({ data: { subscription: { unsubscribe: vi.fn() } } }) },
  },
}));
let roles: string[] = ['agent'];
vi.mock('@/hooks/useAuth', () => ({ useAuth: () => ({ user: { id: 'u1' }, roles }) }));
vi.mock('@/hooks/useCrmVoiceCall', () => ({
  useCrmVoiceCall: () => ({ state: 'idle', callId: null, elapsed: 0, error: null, isEnding: false, start: vi.fn(), end: vi.fn() }),
  useHumanCallingPaused: () => ({ data: { paused: false, reason: null, paused_at: null } }),
  isTerminalCallState: () => false,
}));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));

// This test environment has no window.localStorage; give it a plain in-memory one.
const store = new Map<string, string>();
Object.defineProperty(window, 'localStorage', {
  configurable: true,
  value: {
    getItem: (k: string) => (store.has(k) ? (store.get(k) as string) : null),
    setItem: (k: string, v: string) => void store.set(k, String(v)),
    removeItem: (k: string) => void store.delete(k),
    clear: () => store.clear(),
    key: (i: number) => Array.from(store.keys())[i] ?? null,
    get length() {
      return store.size;
    },
  },
});

import DeskPage from '../DeskPage';
import { ScFieldView } from '../scField';
import { isFieldAgent, isScStaff, useScFieldMenuVisible } from '../scFieldApi';
import { AgentMenuDrawer } from '@/components/agent/AgentMenuDrawer';

const FIELD = {
  allowed: true,
  team_agents: 3,
  rows: [
    {
      rent_request_id: 'r-fix', ref: 'AAAA1111', tenant: { name: 'Tina Fix', phone: '0772000001' }, agent: { id: 'a2', name: 'Sam Sub', phone: '0772000002', is_me: false },
      rent: 400000, where: 'Sent back to the agent', to_fix: true, days_waiting: 3, missing: ['ID back', 'LC1 letter'], desk_note: 'ID back photo is blurred',
    },
    {
      rent_request_id: 'r-sc', ref: 'BBBB2222', tenant: { name: 'Sara Centre', phone: '0772000003' }, agent: { id: 'u1', name: 'Me Agent', phone: '0772000004', is_me: true },
      rent: 300000, where: 'Service Centre', to_fix: false, days_waiting: 1, missing: [], desk_note: null,
    },
    {
      rent_request_id: 'r-far', ref: 'CCCC3333', tenant: { name: 'Fay Along', phone: null }, agent: { id: 'a3', name: 'Ann Sub', phone: '0772000005', is_me: false },
      rent: 250000, where: 'Tenant Ops', to_fix: false, days_waiting: 6, missing: [], desk_note: null,
    },
  ],
};

type Answers = { access?: unknown; scope?: unknown; field?: unknown };
function mockRpcs(a: Answers = {}) {
  rpcMock.mockImplementation((fn: string) => {
    if (fn === 'desk_my_access') return Promise.resolve({ data: a.access ?? { enforced: false, all: false, desks: [], desk: null, sc_person: false }, error: null });
    if (fn === 'desk_my_sc_scope') return Promise.resolve({ data: a.scope ?? { is_sc_person: true, open_new: 3, open_batch: 40, staff_ref: null }, error: null });
    if (fn === 'sc_field_board') return Promise.resolve({ data: a.field ?? FIELD, error: null });
    return Promise.resolve({ data: null, error: null });
  });
}
const called = (fn: string) => rpcMock.mock.calls.some((c) => c[0] === fn);

const client = () => new QueryClient({ defaultOptions: { queries: { retry: false } } });
const wrap = (ui: ReactNode, path = '/') =>
  render(
    <QueryClientProvider client={client()}>
      <MemoryRouter initialEntries={[path]}>{ui}</MemoryRouter>
    </QueryClientProvider>,
  );
const desk = () =>
  wrap(
    <Routes>
      <Route path="/desk/:desk" element={<DeskPage />} />
    </Routes>,
    '/desk/service-centre',
  );

beforeEach(() => {
  rpcMock.mockReset();
  store.clear();
  roles = ['agent'];
});

describe('a field agent on the Service Centre desk', () => {
  it('sees only the simple view: the team header and the three chips', async () => {
    mockRpcs();
    desk();
    const view = await waitFor(() => {
      const el = document.querySelector('[data-sc-field]');
      expect(el).toBeTruthy();
      return el as HTMLElement;
    });
    await within(view).findByText('Your team: 3 agents · 3 requests');
    const chips = view.querySelector('[data-sc-field-chips]') as HTMLElement;
    const pills = within(chips).getAllByRole('button');
    expect(pills.map((b) => b.textContent)).toEqual(['To fix (1)', 'At Service Centre (1)', 'Further along (1)']);
    expect(pills[0].getAttribute('aria-pressed')).toBe('true');
    // The full desk never loads for them.
    expect(called('pipeline_desk_board')).toBe(false);
  });

  it('no In/Out tables, August batch tab, totals, pipeline banner, Push all, Select mode or Pass / Send back / Waiting', async () => {
    mockRpcs();
    const { container } = desk();
    await waitFor(() => expect(container.querySelector('[data-sc-field-card]')).toBeTruthy());
    expect(container.querySelector('table')).toBeNull();
    expect(container.textContent).not.toMatch(/August batch|Push all|Median|median/);
    for (const name of [/^Pass$/, /^Send back/, /^Waiting/, /^Select$/, /Push all/]) expect(screen.queryByRole('button', { name })).toBeNull();
    expect(screen.queryByRole('radio', { name: /August batch/ })).toBeNull();
    expect(container.querySelector('[data-desk-tabs], [data-push-bar], [data-pipeline-strip]')).toBeNull();
  });

  it('cards: tenant and agent with Call, "You" for my own, where, days, missing chips, the desk note on sent-back cards; a tap opens a read-only summary', async () => {
    mockRpcs();
    wrap(<ScFieldView />);
    // "To fix" opens first.
    const fix = await waitFor(() => {
      const el = document.querySelector('[data-sc-field-card="r-fix"]');
      expect(el).toBeTruthy();
      return el as HTMLElement;
    });
    expect(within(fix).getByRole('link', { name: 'Call tenant Tina Fix' })).toBeTruthy();
    expect(within(fix).getByRole('link', { name: 'Call agent Sam Sub' })).toBeTruthy();
    expect(fix.querySelector('[data-sc-field-where]')?.textContent).toBe('Sent back to the agent');
    expect(fix.querySelector('[data-sc-field-days]')?.textContent).toBe('3 days');
    expect(within(fix.querySelector('[data-sc-field-missing]') as HTMLElement).getByText('LC1 letter')).toBeTruthy();
    expect(fix.querySelector('[data-sc-field-note]')?.textContent).toContain('ID back photo is blurred');
    // At Service Centre: my own request reads "You", with no call to myself.
    fireEvent.click(screen.getByRole('button', { name: /At Service Centre/ }));
    const sc = document.querySelector('[data-sc-field-card="r-sc"]') as HTMLElement;
    expect(sc.querySelector('[data-sc-field-agent]')?.textContent).toBe('You');
    expect(within(sc).queryByRole('link', { name: /Call agent/ })).toBeNull();
    expect(sc.querySelector('[data-sc-field-note]')).toBeNull();
    // Tap: the summary, no actions.
    fireEvent.click(within(sc).getByRole('button', { name: 'Open the summary for Sara Centre' }));
    const sheet = await screen.findByRole('dialog', { name: 'Sara Centre' });
    expect(sheet.querySelector('[data-sc-field-summary="r-sc"]')?.textContent).toContain('BBBB2222');
    for (const name of [/^Pass/, /^Send back/, /^Waiting/, /Push/]) expect(within(sheet).queryByRole('button', { name })).toBeNull();
  });
});

describe('Service Centre staff', () => {
  it('keep the full desk (desk role, HR list not enforced)', async () => {
    roles = ['agent', 'operations'];
    mockRpcs({ access: { enforced: false, all: false, desks: [], desk: null, sc_person: false } });
    const { container } = desk();
    await waitFor(() => expect(called('pipeline_desk_board')).toBe(true));
    expect(container.querySelector('[data-sc-field]')).toBeNull();
    expect(called('sc_field_board')).toBe(false);
  });

  it('who is staff: the Service Centre desk or every desk from HR; an agent running a service centre is not', () => {
    expect(isScStaff(['agent'], { enforced: true, all: false, desks: ['service_centre'], desk: null, sc_person: false, employee: true, can_manage: false })).toBe(true);
    expect(isScStaff(['agent'], { enforced: true, all: true, desks: [], desk: null, sc_person: false, employee: true, can_manage: false })).toBe(true);
    expect(isFieldAgent(['agent'], { enforced: true, all: false, desks: [], desk: null, sc_person: true, employee: false, can_manage: false })).toBe(true);
    // Enforced: a manager role alone no longer opens the desk, so they are not staff here either.
    expect(isFieldAgent(['agent', 'manager'], { enforced: true, all: false, desks: ['agent-ops'], desk: null, sc_person: false, employee: true, can_manage: false })).toBe(true);
    expect(isFieldAgent(['operations'], null)).toBe(false);
  });
});

describe('the agent menu entry', () => {
  const menu = () =>
    wrap(<AgentMenuDrawer open onOpenChange={() => {}} onDeposit={() => {}} onInviteSubAgent={() => {}} onOpenEarningsRank={() => {}} />);

  it('every agent gets "Service Centre — my agents"', async () => {
    mockRpcs();
    menu();
    fireEvent.change(screen.getByRole('textbox', { name: 'Search agent actions' }), { target: { value: 'Service Centre' } });
    expect(await screen.findByText('Service Centre — my agents')).toBeTruthy();
  });

  it('allowed:false (HEADS_ONLY) hides the entry', async () => {
    mockRpcs({ field: { allowed: false, reason: 'HEADS_ONLY', message: 'This view is for Service Centre heads.', rows: [] } });
    menu();
    await waitFor(() => expect(called('sc_field_board')).toBe(true));
    fireEvent.change(screen.getByRole('textbox', { name: 'Search agent actions' }), { target: { value: 'Service Centre' } });
    // Give the answer a tick to land, then the entry is still not there.
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByText('Service Centre — my agents')).toBeNull();
  });

  it('the visibility hook: hidden while loading and on allowed:false, shown otherwise', async () => {
    mockRpcs({ field: { allowed: false, reason: 'HEADS_ONLY', rows: [] } });
    let seen: boolean[] = [];
    function Probe() {
      seen.push(useScFieldMenuVisible(true));
      return null;
    }
    wrap(<Probe />);
    await waitFor(() => expect(called('sc_field_board')).toBe(true));
    await new Promise((r) => setTimeout(r, 20));
    expect(seen[0]).toBe(false);
    expect(seen.at(-1)).toBe(false);
    seen = [];
    rpcMock.mockReset();
    mockRpcs();
    wrap(<Probe />);
    await waitFor(() => expect(seen.at(-1)).toBe(true));
  });
});
