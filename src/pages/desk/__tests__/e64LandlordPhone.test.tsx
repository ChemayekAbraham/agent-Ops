import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const rpcMock = vi.fn();
const fromMock = vi.fn();
vi.mock('@/integrations/supabase/client', () => ({
  supabase: { rpc: (...a: unknown[]) => rpcMock(...a), from: (...a: unknown[]) => fromMock(...a), storage: { from: vi.fn() } },
}));
vi.mock('@/hooks/useAuth', () => ({ useAuth: () => ({ user: { id: 'u1' }, roles: [] }) }));
vi.mock('@/hooks/useCrmVoiceCall', () => ({
  useCrmVoiceCall: () => ({ state: 'idle', callId: null, elapsed: 0, error: null, isEnding: false, start: vi.fn(), end: vi.fn() }),
  useHumanCallingPaused: () => ({ data: { paused: false, reason: null, paused_at: null } }),
  isTerminalCallState: () => false,
}));
vi.mock('@/components/coo/CooReasonPicker', () => ({ useCooReasonPicker: () => ({ picker: null, askReason: vi.fn(), meaningOf: () => null }) }));
const toastSuccess = vi.fn();
vi.mock('sonner', () => ({ toast: { success: (...a: unknown[]) => toastSuccess(...a), error: vi.fn(), info: vi.fn() } }));

import { PASS_SENT_TO, passMovesOnServer, runMove } from '../deskActions';
import { daysHere, landlordChecks, landlordOpsChips, phoneLast4 } from '../boardRowModel';
import { ReadyBoard } from '../ReadyBoard';
import { ReviewStatusProvider } from '../reviewStatus';
import type { BoardRow } from '../boardApi';
import type { TenantHealth } from '../paymentHealth';

function row(over: Partial<BoardRow> = {}): BoardRow {
  return {
    id: 'r1', req: 'r1', tenant: 'Tina Tenant', tenant_id: 't1', tenant_phone: '+256700000001', agent_id: 'a1', agent: 'Andy Agent', agent_phone: '+256700000002',
    agent_grade: 'C', agent_grade_week_ago: null, agent_flags: [], landlord: 'Lucy Landlord', landlord_phone: '+256 772 123 4521', rent: 500000, days_here: 3.4,
    rating: null, flags: { passes: 5, total: 5, hard_fail: false, soft_fail: false, failing: [], notes: [], flags: [] },
    decision: 'pass', rule_id: 'LO-3', why: 'Call answered, all checks pass', receiver: null, waiting: null, wait_suggest: null,
    push: {
      decision: 'pass',
      results: Array.from({ length: 8 }, (_, i) => ({ code: `lo_check_${i}`, result: 'pass' as const })),
      reason_code: null,
      note: null,
      target_agent_id: null,
    },
    call: { answered_since_stage: 'yes', attempts_24h: 1 },
    ...over,
  };
}

const setWidth = (w: number) => Object.defineProperty(window, 'innerWidth', { value: w, configurable: true, writable: true });
afterEach(() => setWidth(1024));
beforeEach(() => {
  rpcMock.mockReset();
  fromMock.mockReset();
  toastSuccess.mockReset();
});

const wrap = (ui: React.ReactNode) =>
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <ReviewStatusProvider>{ui}</ReviewStatusProvider>
    </QueryClientProvider>,
  );

function mockBoard(rows: BoardRow[], opts: { reviewError?: string } = {}) {
  // Like the server: once a pass is recorded the request has left this desk.
  const moved = new Set<string>();
  rpcMock.mockImplementation((fn: string, args?: { p_request_id?: string; p_decision?: string }) => {
    if (fn === 'pipeline_desk_board') {
      const left = rows.filter((r) => !moved.has(r.id));
      return Promise.resolve({ data: { stage: 'landlord_ops', can_act: true, staff_ref: 'E1', sc_only: false, counts: { pass: left.length }, rows: left }, error: null });
    }
    if (fn === 'pipeline_record_review') {
      if (opts.reviewError) return Promise.resolve({ data: null, error: { message: opts.reviewError } });
      if (args?.p_decision === 'pass' && args.p_request_id) moved.add(args.p_request_id);
      return Promise.resolve({ data: { review_id: 1 }, error: null });
    }
    if (fn === 'tenant_payment_health_many') {
      const h: Record<string, TenantHealth> = {
        t1: { status: 'good', summary: null, completed_plans: 2, completed_repaid_pct: 92, active_plans: 0, active_collected_pct: null, owing: 0 },
      };
      return Promise.resolve({ data: h, error: null });
    }
    return Promise.resolve({ data: fn.endsWith('_list') || fn === 'pipeline_request_calls' ? [] : {}, error: null });
  });
}

describe('E64 pass flow: the review moves the request; the client never updates rent_requests', () => {
  for (const stage of ['agent_ops', 'tenant_ops', 'landlord_ops'] as const) {
    it(`${stage}: pass returns "${PASS_SENT_TO[stage]}" with no table write`, async () => {
      const out = await runMove({ requestId: 'r1', stage, decision: 'pass', userId: 'u1', note: '' });
      expect(out).toEqual({ ok: true, message: PASS_SENT_TO[stage] });
      expect(fromMock).not.toHaveBeenCalled();
      expect(rpcMock).not.toHaveBeenCalled();
    });
  }

  it('the words for each desk', () => {
    expect(PASS_SENT_TO).toEqual({ agent_ops: 'Sent to Tenant Ops', tenant_ops: 'Sent to Landlord Ops', landlord_ops: 'Sent to the COO' });
    expect(passMovesOnServer('landlord_ops', 'pass')).toBe(true);
    expect(passMovesOnServer('landlord_ops', 'send_back')).toBe(false);
    expect(passMovesOnServer('partner_ops', 'pass')).toBe(false);
  });
});

describe('Landlord Ops card wording', () => {
  it('days here: amber over 2 days, red over 5', () => {
    expect(daysHere(0.4)).toEqual({ text: 'Today', tone: 'idle' });
    expect(daysHere(1.2)).toEqual({ text: '1 day here', tone: 'idle' });
    expect(daysHere(2.5)).toEqual({ text: '2 days here', tone: 'warn' });
    expect(daysHere(5.1)).toEqual({ text: '5 days here', tone: 'bad' });
    expect(daysHere(9)).toEqual({ text: '9 days here', tone: 'bad' });
  });

  it('last four digits of the landlord phone', () => {
    expect(phoneLast4('+256 772 123 4521')).toBe('4521');
    expect(phoneLast4('12')).toBeNull();
    expect(phoneLast4(null)).toBeNull();
  });

  it('landlord checks from the push, the "finish N" reason, or none before the call', () => {
    expect(landlordChecks(row())).toEqual({ done: 8, total: 8 });
    expect(landlordChecks(row({ decision: 'complete', push: null, why: 'Call answered: finish 3 check(s)' }))).toEqual({ done: 5, total: 8 });
    expect(landlordChecks(row({ decision: 'call', push: null, why: 'Call the landlord' }))).toEqual({ done: 0, total: 8 });
  });

  it('one chip row in order; LC1 only when the flags note says so', () => {
    const health: TenantHealth = { status: 'good', summary: null, completed_plans: 2, completed_repaid_pct: 92, active_plans: 0, active_collected_pct: null, owing: 0 };
    expect(landlordOpsChips(row(), health).map((c) => c.text)).toEqual(['Landlord checks 8/8', 'Tenant OK', 'Repaid before: 92%', 'Agent grade C']);
    const failing = row({
      agent_grade: null,
      flags: {
        passes: 3, total: 5, hard_fail: false, soft_fail: true, failing: ['sc_items'], notes: ['LC1 not yet confirmed (no letter, no phone confirmation)'],
        flags: [{ code: 'sc_items', label: 'Service Centre items complete', level: 'soft', ok: false, detail: 'missing: GPS' }],
      },
    });
    const first: TenantHealth = { ...health, completed_plans: 0, completed_repaid_pct: null };
    const chips = landlordOpsChips(failing, first);
    expect(chips.map((c) => c.text)).toEqual(['Landlord checks 8/8', 'Service Centre items complete', 'LC1 not confirmed', 'First plan', 'New agent']);
    expect(chips.find((c) => c.key === 'lc1')?.tone).toBe('warn');
  });
});

describe('Landlord Ops board on a phone', () => {
  it('360 px: the phone card, three lines, no stray separators, calls and actions in the ⋯ menu', async () => {
    setWidth(360);
    mockBoard([row(), row({ id: 'r2', tenant: 'Tom Two', decision: 'call', push: null, days_here: 6.2, why: 'Call the landlord' })]);
    wrap(<ReadyBoard stage="landlord_ops" board={false} onOpen={() => {}} />);
    await screen.findByText('Tina Tenant');
    const cards = document.querySelectorAll<HTMLElement>('[data-landlord-card]');
    expect(cards.length).toBe(2);
    const first = cards[0];
    expect(within(first).getByText('Lucy Landlord', { exact: false }).textContent).toContain('phone ends 4521');
    await waitFor(() => expect(within(first).getByText('Repaid before: 92%')).toBeTruthy());
    expect(within(first).getByText('Landlord checks 8/8')).toBeTruthy();
    expect(within(first).getByText('Agent grade C')).toBeTruthy();
    expect(first.textContent).not.toContain('·');
    // Days chip: amber for 3.4 days, red for 6.2.
    expect(first.querySelector('[data-days-tone]')?.getAttribute('data-days-tone')).toBe('warn');
    expect(cards[1].querySelector('[data-days-tone]')?.getAttribute('data-days-tone')).toBe('bad');
    // One main button per card; the second card's is "Call landlord".
    expect(within(cards[1]).getByRole('button', { name: 'Call landlord' })).toBeTruthy();
    // No inline call buttons on the card: calls are in the menu.
    expect(within(first).queryByRole('button', { name: /from the company line/ })).toBeNull();
    fireEvent.click(within(first).getByRole('button', { name: 'More for Tina Tenant' }));
    for (const name of [/Call tenant \(Tina Tenant\)/, /Call agent \(Andy Agent\)/, /Send back to the agent/, /Hold \(wait on someone\)/, /Log a concern/]) {
      expect(await screen.findByRole('button', { name })).toBeTruthy();
    }
  });

  it('pass: one review call, no rent_requests write, the card goes, toast "Sent to the COO"', async () => {
    setWidth(360);
    mockBoard([row()]);
    wrap(<ReadyBoard stage="landlord_ops" board={false} onOpen={() => {}} />);
    await screen.findByText('Tina Tenant');
    fireEvent.click(screen.getByRole('button', { name: 'Forward to COO' }));
    await waitFor(() => expect(toastSuccess).toHaveBeenCalledWith('Sent to the COO'));
    expect(rpcMock.mock.calls.filter((c) => c[0] === 'pipeline_record_review').length).toBe(1);
    expect(fromMock).not.toHaveBeenCalledWith('rent_requests');
    await waitFor(() => expect(document.querySelector('[data-row="r1"]')).toBeNull());
  });

  it('pass refused: the server message as-is, the card stays', async () => {
    setWidth(360);
    mockBoard([row()], { reviewError: 'Log the answered landlord call first, then pass' });
    wrap(<ReadyBoard stage="landlord_ops" board={false} onOpen={() => {}} />);
    await screen.findByText('Tina Tenant');
    fireEvent.click(screen.getByRole('button', { name: 'Forward to COO' }));
    expect(await screen.findByText('Log the answered landlord call first, then pass')).toBeTruthy();
    expect(toastSuccess).not.toHaveBeenCalled();
    expect(document.querySelector('[data-row="r1"]')).not.toBeNull();
  });
});
