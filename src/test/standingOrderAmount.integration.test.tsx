import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import postgres from 'postgres';
import type { StandingOrderRow } from '@/hooks/useStandingOrders';

const bridge = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock('@/integrations/supabase/client', () => ({ supabase: { rpc: bridge.rpc } }));
import { StandingOrderAmountDialog } from '@/components/cfo/StandingOrderAmountDialog';

const socket = process.env.STANDING_ORDER_TEST_SOCKET;
const localOnly = Boolean(socket?.startsWith('/tmp/standing-order-db.'));
afterEach(() => { cleanup(); vi.unstubAllEnvs(); });

describe.skipIf(!localOnly)('standing order local UI → PostgreSQL → readback', () => {
  it.each([['Increase', 125000], ['Decrease', 75000]])('%s saves a confirmed edit and displays the actual database result', async (direction, proposed) => {
    if (!socket || !localOnly) throw new Error('Disposable local database required');
    const sql = postgres({ host: socket, port: 55439, username: process.env.STANDING_ORDER_TEST_USER, database: 'postgres', max: 1 });
    vi.stubEnv('VITE_SUPABASE_URL', 'http://localhost:54321');
    try {
      await sql.begin(async tx => {
        await tx`select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000001',true), set_config('request.jwt.claim.aal','aal2',true)`;
        const [before] = await tx`select * from public.scheduled_payouts`;
        const [financialBefore] = await tx`select (select jsonb_agg(to_jsonb(w)) from public.wallets w) wallets, (select jsonb_agg(to_jsonb(l)) from public.general_ledger l) ledger, (select jsonb_agg(to_jsonb(r)) from public.scheduled_payout_runs r) runs`;
        if (!before) throw new Error('Local fixture missing');
        const order = { ...before, updated_at: new Date(before.updated_at).toISOString(), amount: Number(before.amount), target_name: 'Local Recipient', target_phone: null, target_missing: false, health: 'ok', consecutive_failures: 0, last_run_error: null, last_run_status: 'completed' } as StandingOrderRow;
        bridge.rpc.mockImplementation(async (_name, args) => {
          const [result] = await tx`select public.standing_order_set_amount(${args.p_order_id}::uuid,${args.p_expected_amount}::numeric,${args.p_expected_updated_at}::timestamptz,${args.p_new_amount}::numeric,${args.p_reason}::text) result`;
          return { data: result?.result, error: null };
        });
        const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
        render(<QueryClientProvider client={client}><StandingOrderAmountDialog order={order} onClose={() => {}} /></QueryClientProvider>);
        fireEvent.click(screen.getByRole('button', { name: direction }));
        fireEvent.change(screen.getByLabelText('Change amount (UGX)'), { target: { value: '25000' } });
        fireEvent.change(screen.getByLabelText('Reason for change'), { target: { value: 'Local integration correction' } });
        fireEvent.click(screen.getByRole('button', { name: 'Review change' }));
        fireEvent.click(screen.getByRole('button', { name: 'Confirm amount change' }));
        await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent(`UGX ${Number(proposed).toLocaleString('en-US')}`));
        const [after] = await tx`select * from public.scheduled_payouts`;
        const [audit] = await tx`select * from public.standing_order_audit_log order by created_at desc limit 1`;
        expect(Number(after?.amount)).toBe(proposed);
        const { amount: _oldAmount, updated_at: _oldVersion, ...untouchedBefore } = before;
        const { amount: _newAmount, updated_at: _newVersion, ...untouchedAfter } = after ?? {};
        expect(untouchedAfter).toEqual(untouchedBefore);
        expect(audit?.details.previous_amount).toBe(100000);
        expect(audit?.details.new_amount).toBe(proposed);
        expect(audit?.reason).toBe('Local integration correction');
        const [financialAfter] = await tx`select (select jsonb_agg(to_jsonb(w)) from public.wallets w) wallets, (select jsonb_agg(to_jsonb(l)) from public.general_ledger l) ledger, (select jsonb_agg(to_jsonb(r)) from public.scheduled_payout_runs r) runs`;
        expect(financialAfter).toEqual(financialBefore);
        cleanup(); client.clear();
        throw new Error('intentional-local-rollback');
      }).catch(e => { if (e.message !== 'intentional-local-rollback') throw e; });
    } finally { await sql.end(); }
  });
});