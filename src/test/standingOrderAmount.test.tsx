import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { StandingOrderRow } from '@/hooks/useStandingOrders';

const mocks = vi.hoisted(() => ({ rpc: vi.fn(), from: vi.fn(), invoke: vi.fn() }));
vi.mock('@/integrations/supabase/client', () => ({ supabase: { rpc: mocks.rpc, from: mocks.from, functions: { invoke: mocks.invoke } } }));
import { StandingOrderAmountDialog } from '@/components/cfo/StandingOrderAmountDialog';

const order: StandingOrderRow = {
  id: '00000000-0000-0000-0000-000000000010', amount: 100000, updated_at: '2026-10-23T01:00:00Z',
  target_user_id: 'recipient', target_name: 'Local Recipient', target_phone: null, target_missing: false,
  category_id: 'lunch_allowance', sub_category: null, reason: 'Fixture', frequency: 'daily',
  day_of_month: null, day_of_week: null, interval_days: null, enabled: true,
  created_at: '2026-10-01', next_run_at: '2026-10-24', last_run_at: '2026-10-23', last_run_status: 'completed', last_run_error: null,
  consecutive_failures: 0, health: 'ok',
};
function setup() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(<QueryClientProvider client={client}><StandingOrderAmountDialog order={order} onClose={vi.fn()} /></QueryClientProvider>);
}
beforeEach(() => { vi.clearAllMocks(); });
afterEach(() => { cleanup(); });

describe('standing order amount confirmation and configuration-only save', () => {
  it.each(['Increase', 'Decrease'])('preview-only %s can be reviewed but cannot save even with a local destination', (direction) => {
    setup(true);
    fireEvent.click(screen.getByRole('button', { name: direction }));
    fireEvent.change(screen.getByLabelText('Change amount (UGX)'), { target: { value: '25000' } });
    fireEvent.change(screen.getByLabelText('Reason for change'), { target: { value: 'Preview amount correction' } });
    fireEvent.click(screen.getByRole('button', { name: 'Review change' }));
    const save = screen.getByRole('button', { name: 'Saving disabled' });
    expect(save).toBeDisabled();
    fireEvent.click(save);
    expect(mocks.rpc).not.toHaveBeenCalled();
    expect(mocks.from).not.toHaveBeenCalled();
    expect(mocks.invoke).not.toHaveBeenCalled();
  });
  it.each([['increase', 125000], ['decrease', 75000]])('%s requires explicit confirmation and uses only the atomic configuration RPC', async (direction, amount) => {
    mocks.rpc.mockResolvedValue({ data: { order: { id: order.id, amount, updated_at: '2026-10-23T02:00:00Z' }, audit_id: 'audit', previous_amount: 100000 }, error: null });
    setup();
    if (direction === 'decrease') fireEvent.click(screen.getByRole('button', { name: 'Decrease' }));
    fireEvent.change(screen.getByLabelText('Change amount (UGX)'), { target: { value: '25000' } });
    fireEvent.change(screen.getByLabelText('Reason for change'), { target: { value: 'Approved amount correction' } });
    expect(mocks.rpc).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Review change' }));
    expect(mocks.rpc).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Confirm amount change' }));
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent(`UGX ${amount.toLocaleString('en-US')}`));
    expect(mocks.rpc).toHaveBeenCalledExactlyOnceWith('standing_order_set_amount', { p_order_id: order.id, p_expected_amount: 100000, p_expected_updated_at: order.updated_at, p_new_amount: amount, p_reason: 'Approved amount correction' });
    expect(mocks.from).not.toHaveBeenCalled(); expect(mocks.invoke).not.toHaveBeenCalled();
    expect(order.next_run_at).toBe('2026-10-24'); expect(order.enabled).toBe(true);
  });
  it('cancelling confirmation does not save', () => {
    setup();
    fireEvent.change(screen.getByLabelText('Change amount (UGX)'), { target: { value: '1' } });
    fireEvent.change(screen.getByLabelText('Reason for change'), { target: { value: 'Reason for local test' } });
    fireEvent.click(screen.getByRole('button', { name: 'Review change' }));
    fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    expect(mocks.rpc).not.toHaveBeenCalled();
  });
  it('surfaces a stale-edit failure without fallback writes or retries', async () => {
    mocks.rpc.mockResolvedValue({ data: null, error: { message: 'Standing order changed. Refresh and review.' } });
    setup();
    fireEvent.change(screen.getByLabelText('Change amount (UGX)'), { target: { value: '25000' } });
    fireEvent.change(screen.getByLabelText('Reason for change'), { target: { value: 'Approved amount correction' } });
    fireEvent.click(screen.getByRole('button', { name: 'Review change' }));
    fireEvent.click(screen.getByRole('button', { name: 'Confirm amount change' }));
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Standing order changed'));
    expect(mocks.rpc).toHaveBeenCalledTimes(1); expect(mocks.from).not.toHaveBeenCalled(); expect(mocks.invoke).not.toHaveBeenCalled();
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });
});