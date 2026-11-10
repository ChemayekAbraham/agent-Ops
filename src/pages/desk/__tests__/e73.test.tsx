import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

/**
 * E73: the kind chip (New / Renewal / Self-applied), Agent Ops' "Assign an
 * agent" group, and the "Tenants waiting for an agent" card.
 */

const h = vi.hoisted(() => ({
  rpc: vi.fn(),
  toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn(), message: vi.fn() }),
}));
vi.mock('sonner', () => ({ toast: h.toast }));
const fromChain = { select: () => fromChain, eq: () => fromChain, in: () => fromChain, order: () => Promise.resolve({ data: [], error: null }) };
vi.mock('@/integrations/supabase/client', () => ({
  supabase: { rpc: (...a: unknown[]) => h.rpc(...a), from: () => fromChain, storage: { from: vi.fn() } },
}));
vi.mock('@/hooks/useAuth', () => ({ useAuth: () => ({ user: { id: 'u1' }, roles: ['agent_ops'] }) }));
vi.mock('@/hooks/useCrmVoiceCall', () => ({
  useCrmVoiceCall: () => ({ state: 'idle', callId: null, elapsed: 0, error: null, isEnding: false, start: vi.fn(), end: vi.fn() }),
  useHumanCallingPaused: () => ({ data: { paused: false, reason: null, paused_at: null } }),
  isTerminalCallState: () => false,
}));
vi.mock('@/components/coo/CooReasonPicker', () => ({
  useCooReasonPicker: () => ({ picker: null, askReason: vi.fn(), meaningOf: () => null }),
  useCooReasonCodes: () => ({ data: [], isLoading: false }),
}));

import { KindChip, kindColor, kindText, type RequestKind } from '../KindChip';
import { ReadyBoard } from '../ReadyBoard';
import { CooBoard, type CooRow } from '../CooBoard';
import { LandlordOpsCard } from '../LandlordOpsCard';
import { ReviewDrawer } from '../ReviewDrawer';
import { ReviewStatusProvider } from '../reviewStatus';
import { SelfAppliedCard, queueLine, queueTone } from '../SelfAppliedQueue';
import { PushQueueCards } from '../PushQueueCards';
import { groupsFor, primaryLabel, type BoardRow } from '../boardApi';
import { groupHeading } from '../boardRowModel';

const NEW: RequestKind = { code: 'new', label: 'New', color: '#475569', detail: 'First plan', needs_agent: false };
const RENEWAL: RequestKind = { code: 'renewal', label: 'Renewal', color: '#0EA5E9', detail: 'Plan 2 · repaid 100% before', needs_agent: false };
const SELF: RequestKind = {
  code: 'self_applied', label: 'Self-applied', color: '#DB2777', via: 'WhatsApp assistant', needs_agent: true,
  detail: 'Applied without an agent — Agent Ops assigns one',
};

const setWidth = (w: number) => Object.defineProperty(window, 'innerWidth', { value: w, configurable: true, writable: true });
afterEach(() => setWidth(1024));
beforeEach(() => {
  h.rpc.mockReset();
  h.toast.success.mockReset();
});

const wrap = (ui: ReactNode) =>
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter>
        <ReviewStatusProvider>{ui}</ReviewStatusProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );

function row(over: Partial<BoardRow>): BoardRow {
  return {
    id: 'r1', req: 'r1', tenant: 'Tina', tenant_id: 't1', tenant_phone: null, agent_id: 'a1', agent: 'Andy', agent_phone: null,
    agent_grade: 'C', agent_grade_week_ago: null, agent_flags: [], landlord: 'Lucy', landlord_phone: null, rent: 500000, days_here: 2.1,
    rating: null, flags: { passes: 5, total: 5, hard_fail: false, soft_fail: false, failing: [], notes: [], flags: [] },
    decision: 'pass', rule_id: 'AO-4', why: 'All checks pass', receiver: null, waiting: null, wait_suggest: null,
    push: { decision: 'pass', results: [], reason_code: null, note: null, target_agent_id: null }, call: null, kind: NEW,
    ...over,
  };
}

/* ───────────── 1. the kind chip ───────────── */

describe('kind chip', () => {
  it('New shows its name; Renewal its detail; Self-applied how it came in', () => {
    expect(kindText(NEW)).toBe('New');
    expect(kindText(RENEWAL)).toBe('Renewal · Plan 2 · repaid 100% before');
    expect(kindText(SELF)).toBe('Self-applied · via WhatsApp assistant');
    expect(kindText({ ...SELF, via: 'tenant app' })).toBe('Self-applied · via tenant app');
  });

  it("the server's colours, with the brief's as the fallback", () => {
    expect(kindColor(NEW)).toBe('#475569');
    expect(kindColor(RENEWAL)).toBe('#0EA5E9');
    expect(kindColor(SELF)).toBe('#DB2777');
    expect(kindColor({ ...RENEWAL, color: null })).toBe('#0EA5E9');
    expect(kindColor({ ...SELF, color: 'red; background:url(x)' })).toBe('#DB2777');
  });

  it('draws a dot and border in the colour; no kind, no chip', () => {
    const { container } = render(<KindChip kind={RENEWAL} />);
    const chip = container.querySelector('[data-kind="renewal"]') as HTMLElement;
    expect(chip.textContent).toBe('Renewal · Plan 2 · repaid 100% before');
    expect(chip.style.border).toContain('rgb(14, 165, 233)');
    expect(render(<KindChip kind={null} />).container.innerHTML).toBe('');
  });

  it('on every desk card and table row', async () => {
    const rows = [row({ id: 'n', tenant: 'Nina', kind: NEW }), row({ id: 'r', tenant: 'Rose', kind: RENEWAL }), row({ id: 's', tenant: 'Sam', kind: SELF })];
    h.rpc.mockImplementation((fn: string) =>
      Promise.resolve(fn === 'pipeline_desk_board' ? { data: { stage: 'tenant_ops', can_act: true, counts: { pass: 3 }, rows }, error: null } : { data: null, error: null }),
    );
    for (const w of [375, 1280]) {
      setWidth(w);
      const { unmount } = wrap(<ReadyBoard stage="tenant_ops" board={false} onOpen={() => {}} />);
      await screen.findByText('Rose');
      expect(document.querySelector('[data-row="n"] [data-kind="new"]')).toBeTruthy();
      expect(document.querySelector('[data-row="r"] [data-kind="renewal"]')?.textContent).toContain('Plan 2');
      expect(document.querySelector('[data-row="s"] [data-kind="self_applied"]')?.textContent).toContain('via WhatsApp assistant');
      unmount();
    }
  });

  it('on the Landlord Ops phone card, first in the chip row', () => {
    wrap(
      <LandlordOpsCard row={row({ kind: RENEWAL })} stage="landlord_ops" canAct board={false} primary={null} onOpen={() => {}} extraMenu={() => null} waitingLine={null} noteLine={null} needsRoleTitle="" />,
    );
    const first = document.querySelector('[data-line="chips"]')?.firstElementChild as HTMLElement;
    expect(first.getAttribute('data-kind')).toBe('renewal');
  });

  it('on every COO board row', async () => {
    const coo = (over: Partial<CooRow>): CooRow => ({
      id: 'c1', req: 'c1', tenant: 'Cara', agent: 'Andy', agent_grade: 'B', landlord: 'L', landlord_verified: true, rent: 300000, days_here: 4.4,
      ratings: { agent_ops: 80, tenant_ops: null, landlord_ops: 60, average: 70, grade: 'B', partly_rated: false }, grade: 'A', avg: 80,
      flags: null, auto_forwarded: false, waiting: null, rank: 1, pushable: true, frozen: null, kind: SELF, ...over,
    });
    h.rpc.mockImplementation((fn: string) =>
      Promise.resolve(
        fn === 'pipeline_coo_board'
          ? { data: { counts: {}, can_push: true, rows: [coo({}), coo({ id: 'c2', tenant: 'Bea', kind: RENEWAL })] }, error: null }
          : { data: null, error: null },
      ),
    );
    for (const w of [375, 1280]) {
      setWidth(w);
      const { unmount } = wrap(<CooBoard board={false} onOpen={() => {}} />);
      await screen.findByText('Bea');
      expect(document.querySelector('[data-row="c1"] [data-kind="self_applied"]')).toBeTruthy();
      expect(document.querySelector('[data-row="c2"] [data-kind="renewal"]')).toBeTruthy();
      unmount();
    }
  });
});

/* ───────────── 2. Agent Ops: assign an agent ───────────── */

const OPTIONS = [
  { agent_id: 'g1', agent: 'Grace Near', phone: '+256700000009', pct: 88, new_agent: false, open_requests: 2, plans: 12, km: 1.4, within_25km: true, transfers_7d: 0, grade: 'A' },
];

function serveAgentOps(rows: BoardRow[], extra: Record<string, { data?: unknown; error?: unknown }> = {}) {
  h.rpc.mockImplementation((fn: string) => {
    if (fn in extra) return Promise.resolve({ data: null, error: null, ...extra[fn] });
    if (fn === 'pipeline_desk_board') return Promise.resolve({ data: { stage: 'agent_ops', can_act: true, counts: {}, rows }, error: null });
    if (fn === 'agent_ops_transfer_options') return Promise.resolve({ data: { rows: OPTIONS }, error: null });
    return Promise.resolve({ data: null, error: null });
  });
}

describe('Agent Ops: "Assign an agent"', () => {
  it('words', () => {
    expect(groupsFor('agent_ops')[0]).toBe('assign_agent');
    expect(groupHeading('assign_agent', 'agent_ops')).toBe('Assign an agent');
    expect(primaryLabel(row({ decision: 'assign_agent' }), 'agent_ops')).toBe('Assign agent');
  });

  it('comes first under "Assign an agent (n)"; the button opens the nearby agents and one transfer call assigns', async () => {
    setWidth(1280);
    const rows = [
      row({ id: 's1', tenant: 'Sam Self', decision: 'assign_agent', kind: SELF, push: null, agent: 'WhatsApp bot' }),
      row({ id: 's2', tenant: 'Sue Self', decision: 'assign_agent', kind: { ...SELF, via: 'tenant app' }, push: null }),
      row({ id: 'p1', tenant: 'Pat Pass' }),
    ];
    serveAgentOps(rows, { ops_transfer_pipeline_request_agent: { data: { success: true } } });
    wrap(<ReadyBoard stage="agent_ops" board={false} onOpen={() => {}} />);
    await screen.findByText('Sam Self');
    const heads = Array.from(document.querySelectorAll('[data-group-head]'));
    expect(heads[0].getAttribute('data-group-head')).toBe('assign_agent');
    expect(heads[0].textContent).toBe('Assign an agent (2)');

    const first = document.querySelector('[data-row="s1"]') as HTMLElement;
    fireEvent.click(within(first).getByRole('button', { name: 'Assign agent' }));
    const picker = await screen.findByRole('dialog', { name: 'Pick an agent to assign' });
    fireEvent.click(await within(picker).findByText('Grace Near'));
    fireEvent.click(within(picker).getByRole('button', { name: 'Assign Grace Near' }));

    await waitFor(() => expect(h.toast.success).toHaveBeenCalledWith('Agent assigned: Grace Near'));
    const writes = h.rpc.mock.calls.filter((c) => c[0] === 'ops_transfer_pipeline_request_agent' || c[0] === 'pipeline_record_review');
    expect(writes).toHaveLength(1);
    expect(writes[0][1]).toMatchObject({ p_request_id: 's1', p_to_agent_id: 'g1' });
    expect(String(writes[0][1].p_reason).length).toBeGreaterThanOrEqual(10);
  });

  it("the server's refusal stays in the picker, as-is", async () => {
    setWidth(1280);
    const refusal = 'That agent already received 5 transfers in 7 days (cap 5): choose another agent';
    serveAgentOps([row({ id: 's1', tenant: 'Sam Self', decision: 'assign_agent', kind: SELF, push: null })], {
      ops_transfer_pipeline_request_agent: { error: { message: refusal } },
    });
    wrap(<ReadyBoard stage="agent_ops" board={false} onOpen={() => {}} />);
    await screen.findByText('Sam Self');
    fireEvent.click(screen.getByRole('button', { name: 'Assign agent' }));
    const picker = await screen.findByRole('dialog', { name: 'Pick an agent to assign' });
    fireEvent.click(await within(picker).findByText('Grace Near'));
    fireEvent.click(within(picker).getByRole('button', { name: 'Assign Grace Near' }));
    expect((await within(picker).findByRole('alert')).textContent).toBe(refusal);
  });

  it('a pass on a row with no agent: the server refuses (E73_NEEDS_AGENT), shown as-is', async () => {
    const refusal = 'E73_NEEDS_AGENT: this tenant applied without an agent — assign one first';
    const sheet = {
      request: {
        id: 's1', status: 'pending', stage: 'agent_ops', round: 0, rent_amount: 500000, duration_days: 30, created_at: '2026-11-10',
        tenant: { id: 't1', name: 'Sam Self', phone: null, occupation: null }, agent: null, landlord: null, lc1: null, lc_letter: null,
        house_photos: [], gps: null, funder_visible: true,
      },
      checklist: [], history: [], score: null, recommendation: { recommended: 'pass', reason_code: null, failed: [] }, can_review: true, my_staff_ref: 'E',
    };
    h.rpc.mockImplementation((fn: string) =>
      Promise.resolve(
        fn === 'pipeline_review_sheet'
          ? { data: sheet, error: null }
          : fn === 'pipeline_record_review'
            ? { data: null, error: { code: 'P0001', message: refusal } }
            : { data: null, error: null },
      ),
    );
    wrap(<ReviewDrawer stage="agent_ops" requestId="s1" onClose={() => {}} />);
    await screen.findByRole('heading', { name: 'Your decision' });
    const panel = screen.getByRole('heading', { name: 'Your decision' }).closest('section') as HTMLElement;
    fireEvent.click(within(panel).getByRole('button', { name: /^Pass/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Record the review and act' }));
    expect((await within(panel).findByRole('alert')).textContent).toBe(refusal);
  });
});

/* ───────────── 3. "Tenants waiting for an agent" ───────────── */

const QUEUE = {
  count: 3, ugx: 1500000, oldest_hours: 30.2, over_24h: 1, over_72h: 0,
  items: [
    { id: 'q1', short_id: 'q1q1q1q1', tenant: 'Sam Self', tenant_phone: '+256700000001', city: 'Kampala', rent: 500000, via: 'WhatsApp assistant', hours_waiting: 30.2 },
    { id: 'q2', short_id: 'q2q2q2q2', tenant: 'Sue Self', tenant_phone: null, city: null, rent: 600000, via: 'tenant app', hours_waiting: 5 },
    { id: 'q3', short_id: 'q3q3q3q3', tenant: 'Tom Self', tenant_phone: '+256700000003', city: 'Wakiso', rent: 400000, via: 'tenant app', hours_waiting: 1 },
  ],
};

describe('"Tenants waiting for an agent"', () => {
  it('"{count} waiting · oldest {oldest_hours} h"; amber when any is over 24 h, red over 72 h', () => {
    expect(queueLine(QUEUE)).toBe('3 waiting · oldest 30 h');
    expect(queueLine({ count: 0, oldest_hours: null })).toBe('0 waiting');
    expect(queueTone(QUEUE)).toBe('warn');
    expect(queueTone({ ...QUEUE, over_72h: 1 })).toBe('bad');
    expect(queueTone({ ...QUEUE, over_24h: 0 })).toBe('ok');
    expect(queueTone({ count: 0, over_24h: 0, over_72h: 0 })).toBe('idle');
  });

  it('skeleton first (never a zero), then the line; tap lists tenant, phone, city, rent, via, hours', async () => {
    let answer!: (v: unknown) => void;
    h.rpc.mockReturnValue(new Promise((r) => (answer = r)));
    wrap(<SelfAppliedCard board={false} />);
    expect(screen.queryByText(/\d+ waiting/)).toBeNull();
    answer({ data: QUEUE, error: null });
    const tile = (await screen.findByText('3 waiting · oldest 30 h')).closest('button') as HTMLElement;
    expect(h.rpc).toHaveBeenCalledWith('pipeline_self_applied_queue', { p_limit: 100 });
    expect(tile.getAttribute('data-tone')).toBe('warn');

    fireEvent.click(tile);
    const sheet = screen.getByRole('dialog', { name: 'Tenants waiting for an agent' });
    const items = within(sheet).getAllByRole('listitem');
    expect(items).toHaveLength(3);
    expect(items[0].textContent).toContain('Sam Self');
    expect(items[0].textContent).toContain('+256700000001');
    expect(items[0].textContent).toContain('Kampala');
    expect(items[0].textContent).toContain('UGX 500,000');
    expect(items[0].textContent).toContain('via WhatsApp assistant');
    expect(items[0].textContent).toContain('30 h');
    expect(items[1].textContent).toContain('no number');
  });

  it('a desk the server does not show it to has no card; any other failure says why', async () => {
    h.rpc.mockResolvedValue({ data: null, error: { code: '42501', message: 'not authorized' } });
    const { container, unmount } = wrap(<SelfAppliedCard board={false} />);
    await waitFor(() => expect(h.rpc).toHaveBeenCalled(), { timeout: 5000 });
    await waitFor(() => expect(container.querySelector('[data-self-applied]')).toBeNull(), { timeout: 5000 });
    unmount();
    h.rpc.mockResolvedValue({ data: null, error: { code: 'XX000', message: 'statement timeout' } });
    wrap(<SelfAppliedCard board={false} />);
    expect((await screen.findByRole('alert', {}, { timeout: 5000 })).textContent).toBe('statement timeout');
  });

  it('sits with the COO / Command Centre cards', async () => {
    h.rpc.mockImplementation((fn: string) => Promise.resolve(fn === 'pipeline_self_applied_queue' ? { data: QUEUE, error: null } : { data: {}, error: null }));
    wrap(<PushQueueCards board={false} enabled onCooDesk />);
    await waitFor(() => expect(document.querySelector('[data-self-applied]')).toBeTruthy());
  });
});
