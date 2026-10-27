import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { kampalaTodayYmd } from '@/lib/kampalaDays';

const mocks = vi.hoisted(() => ({
  rpc: vi.fn(), toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
  server: { issuance: false, recon: { a20_ledger_balance: 940000, subledger_outstanding: 940000, difference: 0, balanced: true, mismatched_advances: [] as unknown[] },
    fail: null as null | { fn: string; error: { code: string; message: string; details?: string } } },
}));
vi.mock('@/integrations/supabase/client', () => ({ supabase: { rpc: mocks.rpc } }));
vi.mock('sonner', () => ({ toast: mocks.toast }));
vi.mock('@/components/cfo/SpecialAdvanceModal', () => ({ SpecialAdvanceModal: ({ open }: { open: boolean }) => (open ? <div>record modal open</div> : null) }));
import { SpecialAdvancesPanel } from '@/components/cfo/special-advances/SpecialAdvancesPanel';
import { describeSpecialAdvanceError, buildCreateRequest } from '@/lib/specialAdvances';

const position = (outstanding: number, paid = 0) => ({ total_repayable: 940000, total_paid: paid, outstanding, outstanding_access_fee: 0,
  outstanding_registration_fee: 0, outstanding_principal: 0, overdue_amount: 0, overdue_instalments: 0,
  instalments: [{ number: 1, due_date: null, amount: 313334, paid: 0, outstanding: 313334, status: 'not_due' }] });
const adv = (id: string, status: string, over: Record<string, unknown> = {}) => ({
  id, reference: `SA-00000${id}`, status, borrower_kind: 'welile_user', borrower_user_id: 'u1', borrower_name: `Borrower ${id}`, external_borrower: null,
  principal: 500000, rate_percent: 28, rate_basis: 'monthly', term_days: 90, frequency: 'monthly', access_fee: 420000, registration_fee: 20000,
  total_repayable: 940000, instalments: 3, purpose: 'Working capital for verified supplier stock', planned_payout_date: null, payout_date: null,
  payout_method: null, payout_reference: null, decision_reason: null, created_at: '2026-10-27T08:00:00Z', updated_at: `2026-10-27T08:00:0${id}Z`,
  events: [{ event_type: 'created', from_status: null, to_status: 'pending_approval', actor_id: 'c', actor_name: 'CFO', reason: null, details: null, created_at: '2026-10-27T08:00:00Z' }],
  position: position(940000), repayments: [], ...over,
});
const ADVANCES: Record<string, ReturnType<typeof adv>> = {
  '1': adv('1', 'pending_approval'),
  '2': adv('2', 'approved'),
  '3': adv('3', 'approved', { borrower_kind: 'external', borrower_name: 'Acme Supplies Ltd' }),
  '4': adv('4', 'disbursed', { payout_date: '2026-10-20', payout_method: 'wallet', position: position(740000, 200000) }),
};

const renderPanel = () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}><SpecialAdvancesPanel /></QueryClientProvider>);
};
const calls = (fn: string) => mocks.rpc.mock.calls.filter(([f]) => f === fn).map(([, a]) => a);
const btn = (id: string) => document.getElementById(id) as HTMLButtonElement;
const open = async (ref: string) => { fireEvent.click((await screen.findByText(ref)).closest('tr')!); await screen.findByText('Schedule'); };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.server.issuance = false;
  mocks.server.fail = null;
  mocks.server.recon = { a20_ledger_balance: 940000, subledger_outstanding: 940000, difference: 0, balanced: true, mismatched_advances: [] };
  mocks.rpc.mockImplementation((fn: string, args: Record<string, unknown> = {}) => {
    if (mocks.server.fail?.fn === fn) return Promise.resolve({ data: null, error: mocks.server.fail.error });
    switch (fn) {
      case 'special_advance_list': return Promise.resolve({ data: { issuance_enabled: mocks.server.issuance, total_count: 4, items: Object.values(ADVANCES) }, error: null });
      case 'special_advance_reconciliation': return Promise.resolve({ data: mocks.server.recon, error: null });
      case 'special_advance_statement': return Promise.resolve({ data: ADVANCES[String(args.p_id)], error: null });
      default: return Promise.resolve({ data: { ...ADVANCES[String(args.p_id)], reference: ADVANCES[String(args.p_id)]?.reference }, error: null });
    }
  });
});
afterEach(cleanup);

describe('Special Advances panel', () => {
  it('lists agreements, shows the issuance switch and the A20 reconciliation', async () => {
    renderPanel();
    expect(await screen.findByText('SA-000001')).toBeTruthy();
    expect(screen.getByText('Acme Supplies Ltd')).toBeTruthy();
    expect(document.getElementById('special-advance-issuance-state')?.textContent).toMatch(/switched off/);
    await waitFor(() => expect(document.getElementById('special-advance-reconciliation')?.textContent).toMatch(/reconciled/));
    fireEvent.click(btn('special-advance-new'));
    expect(screen.getByText('record modal open')).toBeTruthy();
  });

  it('highlights a reconciliation difference', async () => {
    mocks.server.recon = { a20_ledger_balance: 940007, subledger_outstanding: 940000, difference: 7, balanced: false, mismatched_advances: [] };
    renderPanel();
    await waitFor(() => expect(document.getElementById('special-advance-reconciliation')?.textContent).toMatch(/difference/));
  });

  it('issuance off: approval disabled; rejection needs a reason and calls the server with the version', async () => {
    renderPanel();
    await open('SA-000001');
    expect(btn('special-advance-approve').disabled).toBe(true);
    expect(screen.getAllByText(/approval and payout are disabled/).length).toBe(2); // panel header + detail sheet
    expect(btn('special-advance-reject').disabled).toBe(true);
    fireEvent.change(screen.getByLabelText(/Decision note/), { target: { value: 'Borrower withdrew the request' } });
    fireEvent.click(btn('special-advance-reject'));
    await waitFor(() => expect(calls('special_advance_reject')).toEqual([{ p_id: '1', p_expected_updated_at: '2026-10-27T08:00:01Z', p_reason: 'Borrower withdrew the request' }]));
    expect(mocks.toast.success).toHaveBeenCalledWith('SA-000001 rejected');
  });

  it('issuance on: the CFO approves (note optional)', async () => {
    mocks.server.issuance = true;
    renderPanel();
    await open('SA-000001');
    await waitFor(() => expect(btn('special-advance-approve').disabled).toBe(false));
    fireEvent.click(btn('special-advance-approve'));
    await waitFor(() => expect(calls('special_advance_approve')).toEqual([{ p_id: '1', p_expected_updated_at: '2026-10-27T08:00:01Z', p_reason: null }]));
  });

  it('payout to a Welile borrower: wallet, today, after explicit confirmation; disabled while issuance is off', async () => {
    renderPanel();
    await open('SA-000002');
    fireEvent.click(document.getElementById('special-advance-payout-confirm') as HTMLElement);
    expect(btn('special-advance-payout').disabled).toBe(true); // issuance off
    cleanup();
    mocks.server.issuance = true;
    renderPanel();
    await open('SA-000002');
    expect(screen.getByText(/Credited to the borrower's Welile wallet/)).toBeTruthy();
    expect(btn('special-advance-payout').disabled).toBe(true); // not confirmed yet
    fireEvent.click(document.getElementById('special-advance-payout-confirm') as HTMLElement);
    fireEvent.click(btn('special-advance-payout'));
    await waitFor(() => expect(calls('special_advance_disburse')).toEqual([{ p_id: '2', p_expected_updated_at: '2026-10-27T08:00:02Z',
      p_payout: { payout_date: kampalaTodayYmd(), method: 'wallet' } }]));
  });

  it('payout to an external borrower needs a method and a transaction reference', async () => {
    mocks.server.issuance = true;
    renderPanel();
    await open('SA-000003');
    fireEvent.click(document.getElementById('special-advance-payout-confirm') as HTMLElement);
    expect(btn('special-advance-payout').disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('Transaction reference'), { target: { value: 'MM-TXN-778899' } });
    fireEvent.click(btn('special-advance-payout'));
    await waitFor(() => expect(calls('special_advance_disburse')).toEqual([{ p_id: '3', p_expected_updated_at: '2026-10-27T08:00:03Z',
      p_payout: { payout_date: kampalaTodayYmd(), method: 'mobile_money', reference: 'MM-TXN-778899' } }]));
  });

  it('a pending or approved advance can be cancelled with a reason', async () => {
    renderPanel();
    await open('SA-000002');
    fireEvent.change(screen.getByLabelText(/Reason to cancel before payout/), { target: { value: 'Payout no longer needed' } });
    fireEvent.click(btn('special-advance-cancel-approved'));
    await waitFor(() => expect(calls('special_advance_cancel')).toEqual([{ p_id: '2', p_expected_updated_at: '2026-10-27T08:00:02Z', p_reason: 'Payout no longer needed' }]));
  });

  it('repayment: refuses more than is outstanding, sends a key, retries with the same key, and a new key after a change', async () => {
    renderPanel();
    await open('SA-000004');
    expect(screen.getByText(/Overpayments are not accepted/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Amount (UGX)'), { target: { value: '740001' } });
    fireEvent.change(screen.getByLabelText('Transaction reference'), { target: { value: 'MM-REP-0001' } });
    expect(btn('special-advance-repay').disabled).toBe(true);
    expect(screen.getByText('That is more than is outstanding.')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Amount (UGX)'), { target: { value: '200000' } });
    mocks.server.fail = { fn: 'special_advance_record_repayment', error: { code: '23505', message: 'REPAYMENT_REFERENCE_ALREADY_RECORDED' } };
    fireEvent.click(btn('special-advance-repay'));
    expect(await screen.findByText(/already recorded/)).toBeTruthy();
    mocks.server.fail = null;
    fireEvent.click(btn('special-advance-repay'));
    await waitFor(() => expect(calls('special_advance_record_repayment')).toHaveLength(2));
    const [first, second] = calls('special_advance_record_repayment') as Array<{ p_id: string; p_repayment: Record<string, unknown> }>;
    expect(first.p_repayment).toMatchObject({ amount: 200000, received_date: kampalaTodayYmd(), method: 'mobile_money', reference: 'MM-REP-0001' });
    expect(second.p_repayment.idempotency_key).toBe(first.p_repayment.idempotency_key); // same action retried
    fireEvent.change(screen.getByLabelText('Amount (UGX)'), { target: { value: '1000' } });
    fireEvent.change(screen.getByLabelText('Transaction reference'), { target: { value: 'MM-REP-0002' } });
    fireEvent.click(btn('special-advance-repay'));
    await waitFor(() => expect(calls('special_advance_record_repayment')).toHaveLength(3));
    const third = calls('special_advance_record_repayment')[2] as { p_repayment: Record<string, unknown> };
    expect(third.p_repayment.idempotency_key).not.toBe(first.p_repayment.idempotency_key);
  });

  it('a server refusal is shown in plain words', async () => {
    mocks.server.fail = { fn: 'special_advance_list', error: { code: '42501', message: 'NOT_AUTHORIZED' } };
    renderPanel();
    expect(await screen.findByText(/Only an enabled CFO account/)).toBeTruthy();
  });

  it('uses Special Advance / access-fee wording, never interest or loan', async () => {
    renderPanel();
    await open('SA-000004');
    expect(document.body.textContent).not.toMatch(/\binterest\b|\bloan\b|\blender\b|\bROI\b/i);
  });
});

describe('Special Advances messages and requests', () => {
  it('decodes server errors', () => {
    expect(describeSpecialAdvanceError({ code: '22023', message: 'BORROWER_NOT_ELIGIBLE', details: '["OPEN_SPECIAL_ADVANCE","OVERDUE_AGENT_ADVANCE"]' }))
      .toBe('This borrower already has an open Special Advance. This borrower has an overdue agent advance with a balance.');
    expect(describeSpecialAdvanceError({ code: '22023', message: 'OVERPAYMENT_REFUSED', details: '{"outstanding": 440000}' })).toMatch(/UGX 440,000/);
    expect(describeSpecialAdvanceError({ code: '22023', message: 'SPECIAL_ADVANCE_INVALID_REQUEST', details: '["purpose","national_id"]' }))
      .toBe('Check the purpose, National ID (NIN).');
    expect(describeSpecialAdvanceError({ code: '42501', message: 'SELF_ADVANCE' })).toMatch(/cannot give a Special Advance to themselves/);
    expect(describeSpecialAdvanceError({ code: '55000', message: 'SPECIAL_ADVANCES_DISABLED' })).toMatch(/switched off/);
    expect(describeSpecialAdvanceError({ code: '42501', message: 'SPECIAL_ADVANCE_DECISION_IMMUTABLE' })).not.toMatch(/Only an enabled CFO/);
  });

  it('the create request carries terms, purpose, the confirmed total and a key — no fees or schedule', () => {
    const r = buildCreateRequest({ borrower: { kind: 'welile_user', user_id: 'u' }, terms: { principal: 500000, rate_percent: 28, rate_basis: 'monthly', term_days: 7, frequency: 'daily' },
      purpose: '  Working capital for stock  ', confirmedTotal: 552667, idempotencyKey: 'k'.repeat(36) });
    expect(r).toEqual({ borrower: { kind: 'welile_user', user_id: 'u' }, terms: { principal: 500000, rate_percent: 28, rate_basis: 'monthly', term_days: 7, frequency: 'daily' },
      purpose: 'Working capital for stock', expected_total_repayable: 552667, idempotency_key: 'k'.repeat(36) });
  });
});
