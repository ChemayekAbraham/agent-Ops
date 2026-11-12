import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SpecialAdvanceTopUpDialog } from '@/components/cfo/special-advances/SpecialAdvanceTopUpDialog';
import { SpecialAdvanceDetailSheet } from '@/components/cfo/special-advances/SpecialAdvanceDetailSheet';
import { describeSpecialAdvanceError, type SpecialAdvanceStatement } from '@/lib/specialAdvances';

/** Add Top-Up (CFO): details, server quote, confirm, one server call that records and pays out (server mocked). */

// many screen steps per test: allow for a busy machine when every suite runs at once
vi.setConfig({ testTimeout: 30_000 });

const mocks = vi.hoisted(() => ({
  rpc: vi.fn(),
  upload: vi.fn(() => Promise.resolve({ error: null })),
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
}));
vi.mock('@/integrations/supabase/client', () => ({
  supabase: { rpc: mocks.rpc, storage: { from: vi.fn(() => ({ upload: mocks.upload, createSignedUrl: vi.fn() })) } },
}));
vi.mock('sonner', () => ({ toast: mocks.toast }));

const ADV_ID = '11111111-1111-4111-8111-111111111111';
const advance = (over: Record<string, unknown> = {}) => ({
  id: ADV_ID, reference: 'SA-000009', status: 'disbursed', borrower_kind: 'welile_user', borrower_user_id: 'u1', borrower_name: 'Borrower',
  external_borrower: null, principal: 500000, rate_percent: 28, rate_basis: 'monthly', term_days: 90, frequency: 'monthly',
  access_fee: 440000, registration_fee: 0, total_repayable: 940000, instalments: 3, purpose: 'Working capital for inventory',
  planned_payout_date: null, payout_date: '2026-11-01', payout_method: 'wallet', payout_reference: null, payout_proof_path: null,
  decision_reason: null, created_at: '2026-11-01T08:00:00Z', updated_at: '2026-11-01T08:00:05.123456+00:00',
  events: [], schedule: [],
  position: { total_repayable: 940000, total_paid: 0, outstanding: 940000, paid_out: true, scheduled_outstanding: 940000,
    outstanding_access_fee: 440000, outstanding_principal: 500000, overdue_amount: 0, overdue_instalments: 0, instalments: [] },
  repayments: [], corrections: [], write_offs: [], recoveries: [], allowance_held: 0, topups: [],
  ...over,
}) as unknown as SpecialAdvanceStatement;
const QUOTE = { term_days: 80, end_date: '2027-01-30', outstanding_now: 940000, outstanding_after: 1307334, payout_method: 'wallet',
  schedule: { principal: 300000, access_fee: 67334, total_repayable: 367334, instalments: 3,
    schedule: [{ number: 1, due_date: '2026-12-12', amount: 122445, access_fee: 67334, principal: 55111 },
               { number: 2, due_date: '2027-01-11', amount: 122445, access_fee: 0, principal: 122445 },
               { number: 3, due_date: '2027-01-30', amount: 122444, access_fee: 0, principal: 122444 }] } };

const renderUi = (ui: React.ReactElement) =>
  render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>{ui}</QueryClientProvider>);

beforeEach(() => {
  vi.clearAllMocks();
  if (typeof document !== 'undefined' && !document.elementFromPoint) document.elementFromPoint = () => null;
});
afterEach(cleanup);

async function fillDetails(user: ReturnType<typeof userEvent.setup>, amount = '300000') {
  await user.type(screen.getByLabelText(/Top-up amount/), amount);
  await user.type(screen.getByLabelText(/^Reason/), 'Borrower needs more stock for the season');
}

describe('SpecialAdvanceTopUpDialog', () => {
  it('wallet borrower: shows the server terms, needs an explicit confirmation, then records and pays out in one call', async () => {
    const user = userEvent.setup();
    const onSuccess = vi.fn();
    mocks.rpc.mockImplementation((fn: string) => Promise.resolve(fn === 'special_advance_topup_quote'
      ? { data: QUOTE, error: null }
      : { data: { ...advance(), topup: { reference: 'SAT-000001' }, replayed: false }, error: null }));
    renderUi(<SpecialAdvanceTopUpDialog open onOpenChange={() => {}} advance={advance()} onSuccess={onSuccess} />);
    expect(screen.getByText(/Paid to the borrower's Welile wallet immediately/)).toBeInTheDocument();
    await fillDetails(user);
    expect(await screen.findByText('UGX 367,334')).toBeInTheDocument();       // server figure, not computed in the browser
    expect(mocks.rpc).toHaveBeenCalledWith('special_advance_topup_quote', { p_id: ADV_ID, p_principal: 300000 });
    await user.click(screen.getByRole('button', { name: 'Review' }));
    expect(screen.getByText('Instalment 3: UGX 122,444 due 2027-01-30')).toBeInTheDocument();
    const pay = screen.getByRole('button', { name: /Add top-up and pay out/ });
    expect(pay).toBeDisabled();                                              // nothing moves without the CFO's confirmation
    expect(mocks.rpc).not.toHaveBeenCalledWith('special_advance_add_topup', expect.anything());
    await user.click(screen.getByRole('checkbox'));
    await user.click(pay);
    await waitFor(() => expect(onSuccess).toHaveBeenCalled());
    const [, args] = mocks.rpc.mock.calls.find(([fn]) => fn === 'special_advance_add_topup')!;
    expect(args).toMatchObject({ p_id: ADV_ID, p_expected_updated_at: '2026-11-01T08:00:05.123456+00:00',
      p_request: { principal: 300000, expected_total_repayable: 367334, reason: 'Borrower needs more stock for the season' } });
    expect(args.p_request).not.toHaveProperty('method');
    expect(mocks.toast.success).toHaveBeenCalledWith('Top-up SAT-000001 added', expect.objectContaining({ description: expect.stringMatching(/credited to the borrower's wallet/) }));
  });

  it('external borrower: needs the reference and proof; the proof is uploaded and sent with the payout', async () => {
    const user = userEvent.setup();
    mocks.rpc.mockImplementation((fn: string) => Promise.resolve(fn === 'special_advance_topup_quote'
      ? { data: { ...QUOTE, payout_method: null }, error: null }
      : { data: { ...advance(), topup: { reference: 'SAT-000002' }, replayed: false }, error: null }));
    const ext = advance({ borrower_kind: 'external', borrower_user_id: null });
    renderUi(<SpecialAdvanceTopUpDialog open onOpenChange={() => {}} advance={ext} />);
    await fillDetails(user);
    await screen.findByText('UGX 367,334');
    expect(screen.getByRole('button', { name: 'Review' })).toBeDisabled();
    await user.type(screen.getByLabelText(/Transaction reference/), 'MM-778899');
    await user.upload(document.querySelector('#topup-proof') as HTMLInputElement, new File(['%PDF'], 'proof.pdf', { type: 'application/pdf' }));
    await user.click(screen.getByRole('button', { name: 'Review' }));
    await user.click(screen.getByRole('checkbox'));
    await user.click(screen.getByRole('button', { name: /Add top-up and pay out/ }));
    await waitFor(() => expect(mocks.rpc).toHaveBeenCalledWith('special_advance_add_topup', expect.anything()));
    const [, args] = mocks.rpc.mock.calls.find(([fn]) => fn === 'special_advance_add_topup')!;
    expect(args.p_request).toMatchObject({ method: 'mobile_money', reference: 'MM-778899', proof_path: expect.stringMatching(new RegExp(`^advances/${ADV_ID}/`)) });
    expect(mocks.upload).toHaveBeenCalledTimes(1);
  });

  it('a failed call is retried with the same key (never paid twice); changing the amount starts a new top-up', async () => {
    const user = userEvent.setup();
    const keys: string[] = [];
    let fail = true;
    mocks.rpc.mockImplementation((fn: string, args: { p_request?: { idempotency_key: string } }) => {
      if (fn === 'special_advance_topup_quote') return Promise.resolve({ data: QUOTE, error: null });
      keys.push(args.p_request!.idempotency_key);
      return Promise.resolve(fail ? { data: null, error: { message: 'Failed to fetch' } }
        : { data: { ...advance(), topup: { reference: 'SAT-000003' }, replayed: false }, error: null });
    });
    renderUi(<SpecialAdvanceTopUpDialog open onOpenChange={() => {}} advance={advance()} />);
    await fillDetails(user);
    await screen.findByText('UGX 367,334');
    const confirmAndPay = async () => {
      await user.click(screen.getByRole('button', { name: 'Review' }));
      await user.click(screen.getByRole('checkbox'));
      await user.click(screen.getByRole('button', { name: /Add top-up and pay out/ }));
    };
    await confirmAndPay();
    expect(await screen.findByRole('alert')).toHaveTextContent(/Failed to fetch/);
    await confirmAndPay();                                         // retry of the same top-up
    await waitFor(() => expect(keys).toHaveLength(2));
    expect(keys[1]).toBe(keys[0]);
    const amount = screen.getByLabelText(/Top-up amount/);
    await user.clear(amount);
    await user.type(amount, '300001');                             // a different top-up
    fail = false;
    await screen.findByText('UGX 367,334');
    await confirmAndPay();
    await waitFor(() => expect(keys).toHaveLength(3));
    expect(keys[2]).not.toBe(keys[0]);
  });

  it('server refusals read clearly', () => {
    expect(describeSpecialAdvanceError({ message: 'TOPUP_AFTER_END', details: '{"end_date": "2026-11-01"}' })).toMatch(/2026-11-01.*has passed/);
    expect(describeSpecialAdvanceError({ message: 'STALE_VERSION' })).toMatch(/changed by someone else/);
    expect(describeSpecialAdvanceError({ message: 'QUOTE_CHANGED', details: '{"total_repayable": 367335}' })).toMatch(/UGX 367,335/);
    expect(describeSpecialAdvanceError({ message: 'NOT_AUTHORIZED' })).toMatch(/CFO/);
  });
});

describe('Special Advance detail: Add top-up action and top-ups list', () => {
  const sheet = (stmt: SpecialAdvanceStatement) => {
    mocks.rpc.mockImplementation((fn: string) => Promise.resolve(fn === 'special_advance_statement' ? { data: stmt, error: null } : { data: null, error: null }));
    return renderUi(<SpecialAdvanceDetailSheet advanceId={ADV_ID} issuanceEnabled onOpenChange={() => {}} />);
  };

  it('a paid-out advance offers Add top-up and lists its top-ups', async () => {
    sheet(advance({ position: { ...advance().position, total_repayable: 1307334 }, topups: [{ id: 't1', reference: 'SAT-000004', advance_id: ADV_ID, topup_date: '2026-11-12', principal: 300000, access_fee: 67334,
      total_repayable: 367334, term_days: 80, reason: 'Seasonal stock top-up approved', payout_method: 'wallet', payout_reference: null,
      payout_proof_path: null, ledger_group_id: 'g1', recorded_by: 'c', recorded_at: '2026-11-12T08:00:00Z' }] }));
    expect(await screen.findByRole('button', { name: /Add top-up/ })).toBeInTheDocument();
    expect(screen.getByText('SAT-000004')).toBeInTheDocument();
    expect(screen.getByText('Seasonal stock top-up approved')).toBeInTheDocument();
    expect(screen.getByText('Total repayable (incl. top-ups)').nextSibling).toHaveTextContent('1,307,334');
  });

  it('no Add top-up before payout or after settlement', async () => {
    const a = sheet(advance({ status: 'approved', payout_date: null }));
    await screen.findByText('SA-000009');
    expect(screen.queryByRole('button', { name: /Add top-up/ })).toBeNull();
    a.unmount();
    sheet(advance({ status: 'settled' }));
    await screen.findByText('SA-000009');
    expect(screen.queryByRole('button', { name: /Add top-up/ })).toBeNull();
  });
});
