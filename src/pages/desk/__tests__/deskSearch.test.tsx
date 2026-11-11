import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

/** E72 desk search: desk_search(p_query, p_desk, p_limit) on every board, the COO desk and the Command Centre. */

const h = vi.hoisted(() => ({ rpc: vi.fn() }));
const fromChain = { select: () => fromChain, eq: () => fromChain, in: () => fromChain, order: () => Promise.resolve({ data: [], error: null }) };
vi.mock('@/integrations/supabase/client', () => ({
  supabase: { rpc: (...a: unknown[]) => h.rpc(...a), from: () => fromChain, storage: { from: vi.fn() } },
}));
vi.mock('@/hooks/useAuth', () => ({ useAuth: () => ({ user: { id: 'u1' }, roles: ['coo'] }) }));
vi.mock('@/hooks/useCrmVoiceCall', () => ({
  useCrmVoiceCall: () => ({ state: 'idle', callId: null, elapsed: 0, error: null, isEnding: false, start: vi.fn(), end: vi.fn() }),
  useHumanCallingPaused: () => ({ data: { paused: false, reason: null, paused_at: null } }),
  isTerminalCallState: () => false,
}));
vi.mock('@/components/coo/CooReasonPicker', () => ({
  useCooReasonPicker: () => ({ picker: null, askReason: vi.fn(), meaningOf: () => null }),
  useCooReasonCodes: () => ({ data: [], isLoading: false }),
}));

import { SEARCH_PLACEHOLDER, searchReady, type SearchRow } from '../deskSearch';
import { ReadyBoard } from '../ReadyBoard';
import { CooBoard } from '../CooBoard';
import { CommandSearch } from '../CommandCentre';
import { ReviewStatusProvider } from '../reviewStatus';
import type { Stage } from '../reviewTypes';

const setWidth = (w: number) => Object.defineProperty(window, 'innerWidth', { value: w, configurable: true, writable: true });
afterEach(() => setWidth(1024));

const wrap = (ui: ReactNode) =>
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter>
        <ReviewStatusProvider>{ui}</ReviewStatusProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );

const result = (over: Partial<SearchRow>): SearchRow => ({
  id: 'id-tina-0000-0000', short_id: 'aaaa1111', status: 'agent_ops_approved', desk: 'Tenant Ops',
  tenant: 'Tina Nakato', tenant_phone: '+256700111222', agent: 'Andy Agent', agent_phone: '+256700333444',
  landlord: 'Lucy Landlord', landlord_phone: '0700555666', funder: null, rent: 500000,
  kind: { code: 'renewal', label: 'Renewal', color: '#0EA5E9', detail: 'Plan 2 · repaid 100% before' }, matched_on: 'tenant',
  ...over,
});

const BOARD_ROW = {
  id: 'b1', req: 'b1', tenant: 'Board Row Tenant', tenant_id: 't9', tenant_phone: null, agent_id: 'a9', agent: 'Ann', agent_phone: null,
  agent_grade: 'B', agent_grade_week_ago: null, agent_flags: [], landlord: 'L', landlord_phone: null, rent: 300000, days_here: 1,
  rating: null, flags: { passes: 5, total: 5, hard_fail: false, soft_fail: false, failing: [], notes: [], flags: [] },
  decision: 'pass', rule_id: null, why: 'ok', receiver: null, waiting: null, wait_suggest: null,
  push: { decision: 'pass', results: [], reason_code: null, note: null, target_agent_id: null }, call: null,
};

type Answer = { data?: unknown; error?: unknown };
function serve(search: (args: Record<string, unknown>) => Answer, extra: Record<string, Answer> = {}) {
  h.rpc.mockReset();
  h.rpc.mockImplementation((fn: string, args: Record<string, unknown>) => {
    if (fn === 'desk_search') return Promise.resolve({ data: null, error: null, ...search(args) });
    if (fn in extra) return Promise.resolve({ data: null, error: null, ...extra[fn] });
    if (fn === 'pipeline_desk_board') return Promise.resolve({ data: { stage: 'tenant_ops', can_act: true, counts: { pass: 1 }, rows: [BOARD_ROW] }, error: null });
    return Promise.resolve({ data: null, error: null });
  });
}
const searchCalls = () => h.rpc.mock.calls.filter((c) => c[0] === 'desk_search');

beforeEach(() => setWidth(1280));

describe('when a search starts', () => {
  it('at 2 letters, or 6 digits for a phone', () => {
    expect(searchReady('T')).toBe(false);
    expect(searchReady('Ti')).toBe(true);
    expect(searchReady('  ')).toBe(false);
    expect(searchReady('07001')).toBe(false);
    expect(searchReady('070011')).toBe(true);
    expect(searchReady('+256 700')).toBe(true);
    expect(searchReady('06df1e3b')).toBe(true);
  });
});

describe('stage boards: a search box passing the desk’s own slug', () => {
  const CASES: [Stage, keyof typeof SEARCH_PLACEHOLDER, string][] = [
    ['service_centre', 'service-centre', 'Search tenant or agent'],
    ['agent_ops', 'agent-ops', 'Search agent or tenant'],
    ['tenant_ops', 'tenant-ops', 'Search tenant name or phone'],
    ['landlord_ops', 'landlord-ops', 'Search landlord or tenant'],
  ];

  it.each(CASES)('%s: placeholder and slug', async (stage, slug, placeholder) => {
    serve(() => ({ data: { rows: [result({})], scope: 'requests at this desk' } }));
    wrap(<ReadyBoard stage={stage} board={false} onOpen={() => {}} />);
    const box = screen.getByPlaceholderText(placeholder);
    fireEvent.change(box, { target: { value: 'Tina' } });
    await screen.findByText('Tina Nakato');
    expect(searchCalls().at(-1)?.[1]).toEqual({ p_query: 'Tina', p_desk: slug, p_limit: 30 });
  });

  it('waits for 2 letters / 6 digits and for the typing to pause; results replace the list; tap opens the drawer', async () => {
    serve(() => ({ data: { rows: [result({}), result({ id: 'id-2', short_id: 'bbbb2222', tenant: 'Tim Self', kind: { code: 'self_applied', label: 'Self-applied', color: '#DB2777', detail: null, via: 'tenant app' } })], scope: 'requests at this desk' } }));
    const onOpen = vi.fn();
    wrap(<ReadyBoard stage="tenant_ops" board={false} onOpen={onOpen} />);
    await screen.findByText('Board Row Tenant');
    const box = screen.getByPlaceholderText('Search tenant name or phone');

    fireEvent.change(box, { target: { value: 'T' } });
    expect(screen.getByText('Type at least 2 letters or 6 digits.')).toBeTruthy();
    fireEvent.change(box, { target: { value: '07001' } });
    await new Promise((r) => setTimeout(r, 400));
    expect(searchCalls()).toHaveLength(0);

    // Typing fast sends one search, for what was typed last.
    fireEvent.change(box, { target: { value: 'Ti' } });
    fireEvent.change(box, { target: { value: 'Tin' } });
    const results = await screen.findByRole('list', { name: 'Search results' });
    expect(searchCalls()).toHaveLength(1);
    expect(searchCalls()[0][1]).toMatchObject({ p_query: 'Tin' });
    // The list is replaced (hidden), each result carries its kind chip.
    expect(screen.getByText('Board Row Tenant').closest('[hidden]')).toBeTruthy();
    expect(results.querySelector('[data-result="aaaa1111"] [data-kind="renewal"]')).toBeTruthy();
    expect(results.querySelector('[data-result="bbbb2222"] [data-kind="self_applied"]')?.textContent).toContain('via tenant app');

    fireEvent.click(within(results).getByText('Tim Self'));
    expect(onOpen).toHaveBeenCalledWith('id-2');

    // Clearing brings the list back.
    fireEvent.click(screen.getByRole('button', { name: 'Clear the search' }));
    expect(screen.getByText('Board Row Tenant').closest('[hidden]')).toBeNull();
  });

  it('a refusal is shown as the server wrote it', async () => {
    serve(() => ({ error: { code: '42501', message: 'This desk is not assigned to you' } }));
    wrap(<ReadyBoard stage="landlord_ops" board={false} onOpen={() => {}} />);
    fireEvent.change(screen.getByPlaceholderText('Search landlord or tenant'), { target: { value: 'Lucy' } });
    expect((await screen.findByRole('alert')).textContent).toBe('This desk is not assigned to you');
  });
});

describe('COO desk: every desk, the desk each result is at', () => {
  const ROWS = [
    result({}),
    result({ id: 'id-coo', short_id: 'cccc3333', tenant: 'Cara At Coo', status: 'partner_ops_approved', desk: 'COO', funder: null }),
    result({ id: 'id-f', short_id: 'ffff4444', tenant: 'Fred Funded', status: 'coo_approved', desk: 'Funders board', funder: 'Grace Funder', matched_on: 'phone or funder' }),
  ];

  function serveCoo() {
    serve(() => ({ data: { rows: ROWS, scope: 'every desk' } }), {
      pipeline_coo_board: { data: { counts: {}, can_push: true, rows: [] } },
      pipeline_review_sheet: {
        data: { request: {}, checklist: [], history: [{ stage: 'tenant_ops', decision: 'pass', by: 'Tess', note: null, at: '2026-11-10T10:00:00Z' }], score: null, recommendation: null, can_review: false, my_staff_ref: null },
      },
    });
  }

  it("p_desk 'coo'; a request at the COO opens the drawer, any other the read-only view", async () => {
    serveCoo();
    const onOpen = vi.fn();
    wrap(<CooBoard board={false} onOpen={onOpen} />);
    fireEvent.change(screen.getByPlaceholderText('Search any name, phone or request id'), { target: { value: 'Grace' } });
    const results = await screen.findByRole('list', { name: 'Search results' });
    expect(searchCalls().at(-1)?.[1]).toEqual({ p_query: 'Grace', p_desk: 'coo', p_limit: 30 });
    expect(within(results).getAllByText(/^At /).map((e) => e.textContent)).toEqual(['At Tenant Ops', 'At COO', 'At Funders board']);
    expect(results.querySelectorAll('[data-kind]')).toHaveLength(3);

    fireEvent.click(within(results).getByText('Cara At Coo'));
    expect(onOpen).toHaveBeenCalledWith('id-coo');

    fireEvent.click(within(results).getByText('Fred Funded'));
    expect(onOpen).toHaveBeenCalledTimes(1);
    const view = screen.getByRole('dialog', { name: 'Fred Funded · ffff4444' });
    expect(view.textContent).toContain('At Funders board');
    expect(view.textContent).toContain('Grace Funder');
    expect(view.textContent).toContain('UGX 500,000');
    expect(await within(view).findByText(/Pass · Tess/)).toBeTruthy();
    expect(within(view).queryByRole('button', { name: /Record the review/ })).toBeNull();
  });
});

describe('Command Centre', () => {
  it("p_desk 'command'; the at-COO result opens the COO drawer", async () => {
    serve(() => ({ data: { rows: [result({ id: 'id-coo', short_id: 'cccc3333', tenant: 'Cara At Coo', status: 'partner_ops_approved', desk: 'COO' })], scope: 'every desk' } }), {
      pipeline_review_sheet: { data: null, error: { message: 'not loaded in this test' } },
    });
    wrap(<CommandSearch />);
    fireEvent.change(screen.getByPlaceholderText('Search any name, phone or request id'), { target: { value: 'cccc3333' } });
    fireEvent.click(await screen.findByText('Cara At Coo'));
    expect(searchCalls().at(-1)?.[1]).toEqual({ p_query: 'cccc3333', p_desk: 'command', p_limit: 30 });
    expect(await screen.findByRole('dialog', { name: 'Review this request' })).toBeTruthy();
  });

  it('a refusal is shown as-is', async () => {
    serve(() => ({ error: { code: '42501', message: 'Searching every desk is for the COO desk and the Command Centre' } }));
    wrap(<CommandSearch />);
    fireEvent.change(screen.getByPlaceholderText('Search any name, phone or request id'), { target: { value: 'Tina' } });
    expect((await screen.findByRole('alert')).textContent).toBe('Searching every desk is for the COO desk and the Command Centre');
  });

  it('nothing found says so, never a blank', async () => {
    serve(() => ({ data: { rows: [], scope: 'every desk' } }));
    wrap(<CommandSearch />);
    fireEvent.change(screen.getByPlaceholderText('Search any name, phone or request id'), { target: { value: 'Zed' } });
    await waitFor(() => expect(screen.getByText('Nothing matches “Zed” in every desk.')).toBeTruthy());
  });
});
