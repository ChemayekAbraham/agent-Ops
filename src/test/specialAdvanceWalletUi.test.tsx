import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MySpecialAdvancesCard } from '@/components/wallet/MySpecialAdvancesCard';
import { checkWalletAmount, describeWalletPaymentError, maxWalletPayment, nextInstalment } from '@/lib/specialAdvanceWallet';

/** Pay from Wallet, borrower side: the card, the confirm step, the receipt and the retry key (server mocked). */

const mocks = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock('@/integrations/supabase/client', () => ({ supabase: { rpc: mocks.rpc } }));

const advance = (over: Record<string, unknown> = {}) => ({
  id: '11111111-1111-1111-1111-111111111111', reference: 'SA-000007', status: 'disbursed', principal: 500_000, access_fee: 140_000,
  total_repayable: 640_000, payout_date: '2026-11-01', settled_at: null,
  position: {
    outstanding: 640_000, total_paid: 0, overdue_amount: 0, overdue_instalments: 0,
    instalments: [
      { number: 1, due_date: '2026-12-01', amount: 213_334, paid: 0, outstanding: 213_334, status: 'due' },
      { number: 2, due_date: '2026-12-31', amount: 213_333, paid: 0, outstanding: 213_333, status: 'not_due' },
      { number: 3, due_date: '2027-01-30', amount: 213_333, paid: 0, outstanding: 213_333, status: 'not_due' },
    ],
  },
  repayments: [],
  ...over,
});
const receipt = { repayment_id: 'r1', receipt_reference: 'WALLET-ABCDEF123456', advance_id: advance().id, advance_reference: 'SA-000007',
  amount: 213_334, paid_on: '2026-11-12', recorded_at: '2026-11-12T08:00:00Z', applied_to_access_fee: 46_667, applied_to_principal: 166_667,
  status: 'disbursed', outstanding: 426_666, wallet_available: 286_666, replayed: false };

const renderCard = () => render(
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    <MySpecialAdvancesCard />
  </QueryClientProvider>,
);

beforeEach(() => mocks.rpc.mockReset());
afterEach(cleanup);

describe('MySpecialAdvancesCard', () => {
  it('renders nothing without a Special Advance, or when the server does not offer it yet', async () => {
    mocks.rpc.mockResolvedValue({ data: { wallet_available: 10_000, advances: [] }, error: null });
    const a = renderCard();
    await waitFor(() => expect(mocks.rpc).toHaveBeenCalledWith('special_advance_my_advances', undefined));
    expect(a.container).toBeEmptyDOMElement();
    a.unmount();
    mocks.rpc.mockResolvedValue({ data: null, error: { code: 'PGRST202', message: 'Could not find the function' } });
    const b = renderCard();
    await waitFor(() => expect(mocks.rpc).toHaveBeenCalledTimes(2));
    expect(b.container).toBeEmptyDOMElement();
  });

  it('shows what is owed and the wallet balance; pays the next instalment after a confirmation; shows the receipt', async () => {
    const user = userEvent.setup();
    mocks.rpc.mockImplementation((fn: string) => Promise.resolve(fn === 'special_advance_my_advances'
      ? { data: { wallet_available: 500_000, advances: [advance()] }, error: null }
      : { data: receipt, error: null }));
    renderCard();
    expect(await screen.findByText('SA-000007')).toBeInTheDocument();
    expect(screen.getByText('UGX 640,000')).toBeInTheDocument();
    expect(screen.getByText('UGX 500,000')).toBeInTheDocument();
    expect(screen.getByText(/Merchant Line/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /Pay from Wallet/ }));
    // defaults to the next instalment
    expect(screen.getByLabelText(/Amount to pay/)).toHaveValue('213334');
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    expect(screen.getByText('You will owe').nextSibling).toHaveTextContent('UGX 426,666');
    expect(screen.getByText('Wallet after').nextSibling).toHaveTextContent('UGX 286,666');
    expect(mocks.rpc).not.toHaveBeenCalledWith('special_advance_pay_from_wallet', expect.anything()); // nothing paid before confirming
    await user.click(screen.getByRole('button', { name: 'Confirm payment' }));
    expect(await screen.findByText('Payment received')).toBeInTheDocument();
    expect(screen.getByText('WALLET-ABCDEF123456')).toBeInTheDocument();
    expect(screen.getByText('Applied to access fee').nextSibling).toHaveTextContent('UGX 46,667');
    const [, args] = mocks.rpc.mock.calls.find(([fn]) => fn === 'special_advance_pay_from_wallet')!;
    expect(args).toMatchObject({ p_id: advance().id, p_amount: 213_334, p_expected_outstanding: 640_000 });
    expect(String(args.p_idempotency_key).length).toBeGreaterThanOrEqual(16);
  });

  it('refuses an amount above the wallet or the balance before asking the server', async () => {
    const user = userEvent.setup();
    mocks.rpc.mockResolvedValue({ data: { wallet_available: 100_000, advances: [advance()] }, error: null });
    renderCard();
    await user.click(await screen.findByRole('button', { name: /Pay from Wallet/ }));
    const input = screen.getByLabelText(/Amount to pay/);
    await user.clear(input);
    await user.type(input, '150000');
    expect(screen.getByText(/Your wallet has UGX 100,000 available/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Continue' })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: /All my wallet/ }));
    expect(input).toHaveValue('100000');
  });

  it('a network failure keeps the same key for the retry; a changed balance starts a new payment on the new figures', async () => {
    const user = userEvent.setup();
    let outstanding = 640_000;
    const payCalls: Array<Record<string, unknown>> = [];
    let next: 'network' | 'stale' | 'ok' = 'network';
    mocks.rpc.mockImplementation((fn: string, args: Record<string, unknown>) => {
      if (fn === 'special_advance_my_advances') {
        return Promise.resolve({ data: { wallet_available: 900_000, advances: [advance({ position: { ...advance().position, outstanding } })] }, error: null });
      }
      payCalls.push(args);
      if (next === 'network') return Promise.resolve({ data: null, error: { message: 'Failed to fetch' } });
      if (next === 'stale') { outstanding = 600_000; return Promise.resolve({ data: null, error: { code: '22023', message: 'SPECIAL_ADVANCE_STATE_CHANGED', details: '{"outstanding": 600000}' } }); }
      return Promise.resolve({ data: { ...receipt, amount: 50_000 }, error: null });
    });
    renderCard();
    await user.click(await screen.findByRole('button', { name: /Pay from Wallet/ }));
    const input = screen.getByLabelText(/Amount to pay/);
    await user.clear(input);
    await user.type(input, '50000');
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    await user.click(screen.getByRole('button', { name: 'Confirm payment' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/Nothing was taken from your wallet/);
    next = 'stale';
    await user.click(screen.getByRole('button', { name: 'Confirm payment' })); // retry of the same payment
    expect(payCalls[1].p_idempotency_key).toBe(payCalls[0].p_idempotency_key);
    expect(await screen.findByRole('alert')).toHaveTextContent(/You now owe UGX 600,000/);
    // back on the amount step with the new figures
    await waitFor(() => expect(screen.getByText('You owe').nextSibling).toHaveTextContent('UGX 600,000'));
    next = 'ok';
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    await user.click(screen.getByRole('button', { name: 'Confirm payment' }));
    expect(await screen.findByText('Payment received')).toBeInTheDocument();
    expect(payCalls[2].p_idempotency_key).not.toBe(payCalls[1].p_idempotency_key);
    expect(payCalls[2].p_expected_outstanding).toBe(600_000);
  });
});

describe('specialAdvanceWallet helpers', () => {
  it('checks amounts: whole UGX, above zero, within what is owed and what the wallet holds', () => {
    expect(checkWalletAmount('1,000', 5_000, 2_000)).toEqual({ ok: true, amount: 1_000 });
    expect(checkWalletAmount('', 5_000, 2_000).ok).toBe(false);
    expect(checkWalletAmount('10.5', 5_000, 2_000).ok).toBe(false);
    expect(checkWalletAmount('0', 5_000, 2_000).ok).toBe(false);
    expect(checkWalletAmount('6000', 5_000, 9_000)).toEqual({ ok: false, message: 'That is more than you owe (UGX 5,000).' });
    expect(checkWalletAmount('3000', 5_000, 2_000)).toEqual({ ok: false, message: 'Your wallet has UGX 2,000 available.' });
    expect(maxWalletPayment(5_000, 2_000.9)).toBe(2_000);
    expect(maxWalletPayment(0, 2_000)).toBe(0);
    expect(nextInstalment(advance() as never)?.number).toBe(1);
  });

  it('explains every server refusal and says when the figures must be reloaded', () => {
    expect(describeWalletPaymentError({ message: 'INSUFFICIENT_WALLET_BALANCE', details: '{"available": 1200}' }))
      .toEqual({ message: 'Your wallet does not have enough available. Available now: UGX 1,200.', refresh: true });
    expect(describeWalletPaymentError({ message: 'OVERPAYMENT_REFUSED', details: '{"outstanding": 50}' }).message).toMatch(/UGX 50/);
    expect(describeWalletPaymentError({ message: 'SPECIAL_ADVANCE_NOT_REPAYABLE' }).refresh).toBe(true);
    expect(describeWalletPaymentError({ message: 'Failed to fetch' })).toEqual({ message: 'The payment could not be completed. Please try again.', refresh: false });
  });
});
