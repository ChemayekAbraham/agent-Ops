import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const rpcMock = vi.fn();
const fromChain = { select: () => fromChain, eq: () => fromChain, order: () => Promise.resolve({ data: [], error: null }) };
vi.mock('@/integrations/supabase/client', () => ({
  supabase: { rpc: (...a: unknown[]) => rpcMock(...a), from: () => fromChain, storage: { from: vi.fn() } },
}));
vi.mock('@/hooks/useAuth', () => ({ useAuth: () => ({ user: { id: 'u1' }, roles: [] }) }));
vi.mock('@/hooks/useCrmVoiceCall', () => ({
  useCrmVoiceCall: () => ({ state: 'idle', callId: null, elapsed: 0, error: null, isEnding: false, start: vi.fn(), end: vi.fn() }),
  useHumanCallingPaused: () => ({ data: { paused: false, reason: null, paused_at: null } }),
  isTerminalCallState: () => false,
}));
vi.mock('@/components/coo/CooReasonPicker', () => ({ useCooReasonPicker: () => ({ picker: null, askReason: vi.fn(), meaningOf: () => null }) }));

import { PHONE_PAGE, groupHeading, groupRows, rowChips, rowMeta, rowReason, shortPrimary } from '../boardRowModel';
import { ReadyBoard } from '../ReadyBoard';
import { CooBoard, cooChips, type CooRow } from '../CooBoard';
import { ReviewDrawer } from '../ReviewDrawer';
import { ReviewStatusProvider } from '../reviewStatus';
import { photoColumns } from '../PhotoReview';
import { RANKING_COLUMNS } from '../AgentRanking';
import { PRIMARY_LABEL_MAX } from '../ui';
import type { BoardRow } from '../boardApi';

function row(over: Partial<BoardRow>): BoardRow {
  return {
    id: 'r1', req: 'r1', tenant: 'Tina', tenant_id: 't1', tenant_phone: null, agent_id: 'a1', agent: 'Andy', agent_phone: null,
    agent_grade: 'C', agent_grade_week_ago: null, agent_flags: [], landlord: 'Lucy', landlord_phone: null, rent: 500000, days_here: 72.6,
    rating: null, flags: { passes: 5, total: 5, hard_fail: false, soft_fail: false, failing: [], notes: [], flags: [] },
    decision: 'pass', rule_id: 'AO-4', why: 'AO-4: Agent D: move to Bena', receiver: null, waiting: null, wait_suggest: null,
    push: { decision: 'pass', results: [], reason_code: null, note: 'n', target_agent_id: null }, call: null,
    ...over,
  };
}

const setWidth = (w: number) => Object.defineProperty(window, 'innerWidth', { value: w, configurable: true, writable: true });
afterEach(() => setWidth(1024));
beforeEach(() => rpcMock.mockReset());

const wrap = (ui: React.ReactNode) =>
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <ReviewStatusProvider>{ui}</ReviewStatusProvider>
    </QueryClientProvider>,
  );

describe('short main-button labels', () => {
  it('short words on the button, the target on the line under it', () => {
    const t = row({ decision: 'transfer', receiver: { agent_id: 'b', name: 'Bena', grade: 'B', km: 2.4, score: 70, pct: 82 } });
    expect(shortPrimary(t, 'agent_ops')).toEqual({ label: 'Transfer', detail: 'Bena (82%, 2.4 km)' });
    expect(shortPrimary(row({ decision: 'complete' }), 'agent_ops')?.label).toBe('Call and fill');
    expect(shortPrimary(row({ decision: 'review_photos' }), 'agent_ops')?.label).toBe('Review photos');
    expect(shortPrimary(row({}), 'landlord_ops')?.label).toBe('Forward to COO');
    expect(shortPrimary(row({}), 'tenant_ops')?.label).toBe('Forward to Landlord Ops');
    const wait = row({ decision: 'wait', wait_suggest: { reason_code: 'NO_RECEIVER', owner_kind: 'desk_lead', hours: 48, rule_id: 'AO-5', note: null } });
    expect(shortPrimary(wait, 'agent_ops')).toEqual({ label: 'Wait 48 h', detail: 'on Agent Ops lead' });
    expect(shortPrimary(row({ decision: 'waiting' }), 'agent_ops')).toBeNull();
    for (const d of ['pass', 'transfer', 'complete', 'review_photos', 'send_back', 'reject', 'call', 'call_again'] as const) {
      for (const st of ['service_centre', 'agent_ops', 'tenant_ops', 'landlord_ops'] as const) {
        const s = shortPrimary(row({ decision: d, receiver: { agent_id: 'b', name: 'A very long agent name indeed', grade: 'B', km: 2, score: 1, pct: 70 } }), st);
        if (s) expect(s.label.length).toBeLessThanOrEqual(PRIMARY_LABEL_MAX);
      }
    }
  });

  it('chips in priority order, whole days, plain reasons', () => {
    const r = row({ eligibility: { eligible: false, pct: null, new: true, open: 11 }, batch: true, call: { answered_since_stage: null, attempts_24h: 3 } });
    const chips = rowChips(r, 'agent_ops', undefined, { open: 1, serious: 1, latest: 'x' });
    expect(chips.map((c) => c.key)).toEqual(['elig', 'concerns', 'flags', 'batch', 'tries']);
    expect(chips[0].text).toBe('New agent · 11 open (limit 3)');
    expect(rowChips(r, 'tenant_ops', { status: 'poor', summary: null, completed_plans: 0, completed_repaid_pct: null, active_plans: 0, active_collected_pct: null, owing: 0 }).map((c) => c.key)[0]).toBe('health');
    expect(rowMeta(r)).toBe('UGX 500K · 73 d');
    expect(rowReason(r)).toEqual({ text: 'Agent D: move to Bena', title: 'Rule AO-4' });
  });

  it('groups keep server order; headings use the short words', () => {
    const g = groupRows([row({ id: '1', decision: 'complete' }), row({ id: '2', decision: 'pass' }), row({ id: '3', decision: 'complete' })]);
    expect(g.map((x) => [x.decision, x.rows.map((r) => r.id)])).toEqual([['complete', ['1', '3']], ['pass', ['2']]]);
    expect(groupHeading('complete', 'agent_ops')).toBe('Call and fill');
    expect(groupHeading('pass', 'landlord_ops')).toBe('Forward to COO');
  });
});

function boardRows(n: number, decision: BoardRow['decision'] = 'complete'): BoardRow[] {
  return Array.from({ length: n }, (_, i) => row({ id: `r${i}`, req: `r${i}`, tenant: `Tenant ${i}`, decision, push: null }));
}

function mockBoard(rows: BoardRow[]) {
  rpcMock.mockImplementation((fn: string) =>
    Promise.resolve(
      fn === 'pipeline_desk_board'
        ? { data: { stage: 'agent_ops', can_act: true, staff_ref: 'E', sc_only: false, counts: { complete: rows.length }, rows }, error: null }
        : { data: fn === 'pipeline_concerns_list' || fn === 'pipeline_request_calls' || fn === 'pipeline_waiting_list' ? [] : null, error: null },
    ),
  );
}

describe('board rows: card below md, grid row from md', () => {
  it('375 px: RowCards with a sticky group heading, 20 at a time', async () => {
    setWidth(375);
    mockBoard(boardRows(25));
    wrap(<ReadyBoard stage="agent_ops" board={false} onOpen={() => {}} />);
    await screen.findByText('Tenant 0');
    expect(document.querySelectorAll('[data-rowcard]').length).toBe(PHONE_PAGE);
    expect(document.querySelector('[data-gridrow]')).toBeNull();
    const head = document.querySelector('[data-group-head="complete"]') as HTMLElement;
    expect(head.textContent).toBe('Call and fill · 25');
    expect(head.style.position).toBe('sticky');
    expect(screen.getAllByRole('button', { name: 'Call and fill' }).length).toBe(PHONE_PAGE);
    fireEvent.click(screen.getByRole('button', { name: 'Show 5 more' }));
    await waitFor(() => expect(document.querySelectorAll('[data-rowcard]').length).toBe(25));
    expect(screen.queryByRole('button', { name: /Show \d+ more/ })).toBeNull();
  });

  it('1280 px: compact grid rows, every row, the action never wrapping', async () => {
    setWidth(1280);
    mockBoard(boardRows(25));
    wrap(<ReadyBoard stage="agent_ops" board={false} onOpen={() => {}} />);
    await screen.findByText('Tenant 0');
    const rowsEls = document.querySelectorAll<HTMLElement>('[data-gridrow]');
    expect(rowsEls.length).toBe(25);
    expect(document.querySelector('[data-rowcard]')).toBeNull();
    expect(rowsEls[0].style.display).toBe('grid');
    expect(rowsEls[0].getAttribute('data-layout')).toBe('lg');
    const action = rowsEls[0].children[5] as HTMLElement;
    expect(action.style.whiteSpace).toBe('nowrap');
  });
});

const coo = (over: Partial<CooRow>): CooRow => ({
  id: 'c1', req: 'c1', tenant: 'Cara', agent: 'Andy', agent_grade: 'B', landlord: 'L', landlord_verified: true, rent: 300000, days_here: 4.4,
  ratings: { agent_ops: 80, tenant_ops: null, landlord_ops: 60, average: 70, grade: 'B', partly_rated: true }, grade: 'A', avg: 80,
  flags: null, auto_forwarded: false, waiting: null, rank: 1, pushable: true, frozen: null, ...over,
});

describe('the md band (600–1023): two-line rows, chips on their own line', () => {
  it('768 px', async () => {
    setWidth(768);
    mockBoard(boardRows(3));
    wrap(<ReadyBoard stage="agent_ops" board={false} onOpen={() => {}} />);
    await screen.findByText('Tenant 0');
    const r = document.querySelector('[data-gridrow]') as HTMLElement;
    expect(r.getAttribute('data-layout')).toBe('md');
    expect(r.style.gridTemplateColumns).toBe('minmax(0, 1fr) 5.5rem 3rem max-content');
  });
});

describe('COO board', () => {
  const mockCoo = () =>
    rpcMock.mockImplementation((fn: string) =>
      Promise.resolve(fn === 'pipeline_coo_board' ? { data: { counts: { A: 1, pushable: 1, frozen: 1 }, can_push: true, rows: [coo({}), coo({ id: 'c2', tenant: 'Fred', pushable: false, frozen: { reason: 'Agent below 50%', since: null, returns_to_agent_ops_at: '2026-11-12' } })] }, error: null } : { data: null, error: null }),
    );

  it('375 px: cards, "Push to funders" on pushable rows only, and Push top N in a sticky bottom bar', async () => {
    setWidth(375);
    mockCoo();
    wrap(<CooBoard board={false} onOpen={() => {}} />);
    await screen.findByText('Cara');
    expect(document.querySelectorAll('[data-rowcard]').length).toBe(2);
    expect(screen.getAllByRole('button', { name: 'Push to funders' })).toHaveLength(1);
    const bar = document.querySelector('[data-push-bar]') as HTMLElement;
    expect(bar.getAttribute('data-push-bar')).toBe('sticky');
    expect(bar.style.position).toBe('sticky');
  });

  it('1280 px: grid rows and the push control inline', async () => {
    setWidth(1280);
    mockCoo();
    wrap(<CooBoard board={false} onOpen={() => {}} />);
    await screen.findByText('Cara');
    expect(document.querySelectorAll('[data-gridrow]').length).toBe(2);
    expect(document.querySelector('[data-push-bar]')?.getAttribute('data-push-bar')).toBe('inline');
  });

  it('COO chips: concerns, frozen, partly rated', () => {
    expect(cooChips(coo({ frozen: { reason: 'r', since: null, returns_to_agent_ops_at: null } }), { open: 1, serious: 0, latest: null }).map((c) => c.key)).toEqual([
      'concerns', 'frozen', 'partly',
    ]);
  });
});

describe('drawer and panels', () => {
  const SHEET = {
    request: {
      id: 'q1', status: 'pending', stage: 'agent_ops', round: 0, rent_amount: 1, duration_days: 30, created_at: '2026-11-01',
      tenant: { id: 't', name: 'Tina', phone: null, occupation: null }, agent: { id: 'a', name: 'Andy', phone: null },
      landlord: { id: 'l', name: 'Lucy', phone: null, verified: true }, lc1: null, lc_letter: null, house_photos: [], gps: null, funder_visible: true,
    },
    checklist: [], history: [], score: null, recommendation: null, can_review: true, my_staff_ref: 'E',
  };
  const mockSheet = () =>
    rpcMock.mockImplementation((fn: string) =>
      Promise.resolve(fn === 'pipeline_review_sheet' ? { data: SHEET, error: null } : { data: ['pipeline_concerns_list', 'pipeline_request_calls', 'pipeline_waiting_list'].includes(fn) ? [] : null, error: null }),
    );

  it('375 px: a full-screen sheet with the actions pinned to the bottom', async () => {
    setWidth(375);
    mockSheet();
    wrap(<ReviewDrawer stage="agent_ops" requestId="q1" onClose={() => {}} />);
    const bar = await waitFor(() => {
      const el = document.querySelector('[data-action-bar]');
      if (!el) throw new Error('no bar yet');
      return el as HTMLElement;
    });
    expect(document.querySelector('[data-drawer]')?.getAttribute('data-drawer')).toBe('sheet');
    expect(bar.textContent).toMatch(/Record the review and act/);
    expect(bar.textContent).toMatch(/Close/);
  });

  it('1280 px: a side drawer with the actions inline', async () => {
    setWidth(1280);
    mockSheet();
    wrap(<ReviewDrawer stage="agent_ops" requestId="q1" onClose={() => {}} />);
    await screen.findByRole('button', { name: 'Record the review and act' });
    expect(document.querySelector('[data-drawer]')?.getAttribute('data-drawer')).toBe('side');
    expect(document.querySelector('[data-action-bar]')).toBeNull();
  });

  it('photo grid columns and ranking priorities', () => {
    expect([photoColumns('xs'), photoColumns('sm'), photoColumns('md'), photoColumns('lg'), photoColumns('xl')]).toEqual([2, 2, 3, 4, 4]);
    expect(RANKING_COLUMNS.map((c) => [c.key, c.priority])).toEqual([
      ['agent', 1], ['pct', 1], ['money', 2], ['plans', 2], ['open', 3],
    ]);
  });
});
