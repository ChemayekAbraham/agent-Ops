import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

/**
 * Wallet payment after receipt confirmation (20261013128000), client side.
 * The server rules (who may confirm and pay, verification, idempotency,
 * disputes, wallets, reversal detection) are proven in
 * supabase/tests/food_m1/local/48_payment.sql and race.sh (RACE-PAY).
 * Here: the hooks send ONLY the order id, and report outcomes honestly.
 */

const rpcCalls: Array<[string, Record<string, unknown>]> = [];
let payResult: unknown = null;
const toastSuccess = vi.fn(); const toastError = vi.fn();

vi.mock('@/integrations/supabase/client', () => ({
  supabase: {
    rpc: (fn: string, args: Record<string, unknown>) => {
      rpcCalls.push([fn, args]);
      if (fn === 'food_confirm_receipt') return Promise.resolve({ data: { status: 'confirmed', order_id: args.p_order_id, payee_id: 'c', amount_due: 5000 }, error: null });
      if (fn === 'food_pay_order') return Promise.resolve({ data: payResult, error: null });
      if (fn === 'food_verify_payment') return Promise.resolve({ data: { status: 'paid', order_id: args.p_order_id, verified: true }, error: null });
      return Promise.resolve({ data: null, error: null });
    },
    auth: { getUser: () => Promise.resolve({ data: { user: { id: 'u' } } }) },
  },
}));
vi.mock('sonner', () => ({ toast: { success: (...a: unknown[]) => toastSuccess(...a), error: (...a: unknown[]) => toastError(...a) } }));
vi.stubEnv('VITE_FOOD_SERVICE_MOCK', '');

import { useConfirmFoodReceipt, usePayFoodOrder, useVerifyFoodPayment } from '@/hooks/useFoodService';

function wrapper({ children }: { children: ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}
const ORDER = 'f0000000-0000-4000-8000-0000000000aa';

beforeEach(() => { rpcCalls.length = 0; payResult = null; toastSuccess.mockClear(); toastError.mockClear(); });

describe('confirm receipt', () => {
  it('sends only the order id', async () => {
    const { result } = renderHook(() => useConfirmFoodReceipt(), { wrapper });
    await act(async () => { await result.current.mutateAsync({ orderId: ORDER }); });
    expect(rpcCalls).toEqual([['food_confirm_receipt', { p_order_id: ORDER }]]);
    expect(toastSuccess).toHaveBeenCalled();
  });
});

describe('pay', () => {
  it('sends only the order id: no amount, recipient, wallet or status', async () => {
    payResult = { status: 'paid', order_id: ORDER, transaction_group_id: 'g', amount: 5000, replayed: false };
    const { result } = renderHook(() => usePayFoodOrder(), { wrapper });
    await act(async () => { await result.current.mutateAsync({ orderId: ORDER }); });
    expect(rpcCalls).toEqual([['food_pay_order', { p_order_id: ORDER }]]);
    expect(toastSuccess).toHaveBeenCalledWith('Paid from your wallet');
  });

  it('insufficient funds is reported as a failure, never as paid', async () => {
    payResult = { status: 'failed', order_id: ORDER, reason: 'insufficient_funds' };
    const { result } = renderHook(() => usePayFoodOrder(), { wrapper });
    let r: unknown;
    await act(async () => { r = await result.current.mutateAsync({ orderId: ORDER }); });
    expect((r as { status: string }).status).toBe('failed');
    expect(toastSuccess).not.toHaveBeenCalled();
    expect(toastError.mock.calls[0][0]).toMatch(/nothing was charged/i);
  });

  it('a retry of a paid order says so instead of claiming a new payment', async () => {
    payResult = { status: 'paid', order_id: ORDER, transaction_group_id: 'g', replayed: true };
    const { result } = renderHook(() => usePayFoodOrder(), { wrapper });
    await act(async () => { await result.current.mutateAsync({ orderId: ORDER }); });
    expect(toastSuccess).toHaveBeenCalledWith('This order is already paid');
  });
});

describe('verify', () => {
  it('sends only the order id', async () => {
    const { result } = renderHook(() => useVerifyFoodPayment(), { wrapper });
    await act(async () => { await result.current.mutateAsync({ orderId: ORDER }); });
    expect(rpcCalls).toEqual([['food_verify_payment', { p_order_id: ORDER }]]);
  });
});
