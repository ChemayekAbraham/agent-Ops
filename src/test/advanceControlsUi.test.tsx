import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  NEW_MONEY_TAG, advanceControlCode, advanceControlMessage, exceptionSummary, transferArgs, withNewMoney,
} from '@/lib/advanceControls';

/*
 * The CFO screens for the 20261105090000 controls: closing an advance (transfer / recoup / approved write-off), the
 * second-person write-off queue, and the "this is new money" confirmation on a top-up. The database is mocked; what is
 * checked is which RPC each screen calls with which arguments, and that nothing is sent that the controls would refuse.
 */

const mocks = vi.hoisted(() => {
  const tables: Record<string, unknown[]> = {};
  const chain = (table: string) => {
    const q: any = {};
    for (const m of ['select', 'eq', 'in', 'neq', 'order', 'limit']) q[m] = () => q;
    q.then = (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) =>
      Promise.resolve({ data: tables[table] ?? [], error: null }).then(res, rej);
    return q;
  };
  return {
    tables,
    supabase: { rpc: vi.fn(), from: vi.fn((t: string) => chain(t)) },
    toast: { success: vi.fn(), error: vi.fn() },
    user: { id: 'cfo-1' },
  };
});
vi.mock('@/integrations/supabase/client', () => ({ supabase: mocks.supabase }));
vi.mock('sonner', () => ({ toast: mocks.toast }));
vi.mock('@/hooks/useAuth', () => ({ useAuth: () => ({ user: mocks.user }) }));
vi.mock('@/components/cfo/UserSearchPicker', () => ({ UserSearchPicker: () => null }));

import { CancelAdvanceDialog } from '@/components/cfo/CancelAdvanceDialog';
import { AdvanceWriteOffApprovals } from '@/components/cfo/AdvanceWriteOffApprovals';
import CFOAdvanceTopupDialog from '@/components/cfo/CFOAdvanceTopupDialog';

const ADV = { id: 'adv-00000001', agent_id: 'agent-1', principal: 1000000, outstanding_balance: 1033875, monthly_rate: 0.33,
  profiles: { full_name: 'Replica Agent' } };

function wrap(node: ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}>{node}</QueryClientProvider>);
}
const type = (el: HTMLElement, value: string) => fireEvent.change(el, { target: { value } });
const reasonBox = () => screen.getAllByRole('textbox').find((t) => t.tagName === 'TEXTAREA')!;

beforeEach(() => {
  vi.clearAllMocks();
  for (const k of Object.keys(mocks.tables)) delete mocks.tables[k];
  mocks.supabase.rpc.mockResolvedValue({ data: {}, error: null });
});

describe('advanceControls helpers', () => {
  it('recognises each control code and strips it for staff', () => {
    expect(advanceControlCode('ADVANCE_POSSIBLE_TRANSFER: matches 1,033,875 owed')).toBe('possible_transfer');
    expect(advanceControlCode('ADVANCE_DUPLICATE_SUBMISSION: just submitted')).toBe('duplicate_submission');
    expect(advanceControlCode('ADVANCE_CANCEL_NEEDS_DESTINATION: UGX 5 owed')).toBe('needs_destination');
    expect(advanceControlCode('REVERSAL_EXCEEDS_ORIGINAL: too much')).toBe('reversal_exceeds');
    expect(advanceControlCode('ADVANCE_WRITE_OFF_EXCEEDS_APPROVAL: more owed')).toBe('write_off_exceeds');
    expect(advanceControlCode('some other error')).toBeNull();
    expect(advanceControlMessage('ADVANCE_CANCEL_NEEDS_DESTINATION: UGX 5 is still owed')).toBe('UGX 5 is still owed');
    expect(advanceControlMessage('plain')).toBe('plain');
  });
  it('tags new money once, and only when confirmed', () => {
    expect(withNewMoney(' Working capital ', false)).toBe('Working capital');
    expect(withNewMoney('Working capital', true)).toBe(`${NEW_MONEY_TAG} Working capital`);
    expect(withNewMoney(`${NEW_MONEY_TAG} Working capital`, true)).toBe(`${NEW_MONEY_TAG} Working capital`);
  });
  it('maps every destination onto cfo_transfer_agent_advance', () => {
    const base = { fromAdvanceId: 'a', reason: ' Replacement on new terms ', idempotencyKey: 'k' };
    expect(transferArgs({ ...base, destination: 'replacement' })).toEqual({ p_from_advance: 'a', p_reason: 'Replacement on new terms',
      p_idempotency_key: 'k', p_amount: null, p_destination: 'new_advance', p_new_agent_id: null, p_new_recovery_source: null,
      p_new_roi_percent: null, p_new_cycle_days: null, p_cross_account_reason: null });
    expect(transferArgs({ ...base, destination: 'roi', roiPercent: 25, amount: 500 })).toMatchObject({ p_destination: 'new_advance',
      p_new_recovery_source: 'roi', p_new_roi_percent: 25, p_amount: 500, p_new_agent_id: null });
    expect(transferArgs({ ...base, destination: 'partnership', partnerAgentId: 'p', roiPercent: 0, crossAccountReason: ' same person ' }))
      .toMatchObject({ p_destination: 'new_advance', p_new_agent_id: 'p', p_new_recovery_source: 'wallet_daily', p_new_roi_percent: null,
        p_cross_account_reason: 'same person' });
    expect(transferArgs({ ...base, destination: 'existing', toAdvanceId: 'b' })).toMatchObject({ p_destination: 'existing_advance',
      p_to_advance: 'b', p_cross_account_reason: null });
  });
  it('summarises exceptions in plain figures', () => {
    const f = (n: number) => `UGX ${n}`;
    expect(exceptionSummary({ kind: 'reversal_exceeds_original', severity: 'high', advance_id: null, agent_id: 'x', agent: 'X',
      detail: { payout: 1033875, returned: 1056788, excess: 22913 } }, f)).toBe('Paid UGX 1033875, UGX 1056788 taken back: UGX 22913 too much');
    expect(exceptionSummary({ kind: 'live_book_mismatch', severity: 'legacy', advance_id: 'a', agent_id: 'x', agent: 'X',
      detail: { record_outstanding: 100, book: { a10: 60, a11: 10, a20: 0 }, difference: 30 } }, f)).toBe('Record says UGX 100, books say UGX 70 (difference UGX 30)');
  });
});

describe('Close advance dialog', () => {
  it('nothing owed: a plain cancel', async () => {
    wrap(<CancelAdvanceDialog advance={{ ...ADV, outstanding_balance: 0 }} open onOpenChange={() => {}} />);
    expect(screen.queryByText('Transfer the balance')).toBeNull();
    type(reasonBox(), 'Test advance, never used');
    fireEvent.click(screen.getByRole('button', { name: 'Cancel advance' }));
    await waitFor(() => expect(mocks.supabase.rpc).toHaveBeenCalledWith('cancel_agent_advance',
      { p_advance_id: ADV.id, p_recoup: false, p_reason: 'Test advance, never used' }));
  });

  it('a balance owed defaults to an accounting-only transfer with an idempotency key', async () => {
    mocks.supabase.rpc.mockResolvedValue({ data: { amount: 1033875, source_closed: true }, error: null });
    const onOpenChange = vi.fn();
    wrap(<CancelAdvanceDialog advance={ADV} open onOpenChange={onOpenChange} />);
    const btn = screen.getByRole('button', { name: 'Transfer balance' });
    expect((btn as HTMLButtonElement).disabled).toBe(true);
    type(screen.getByPlaceholderText(/Replacement advance on new terms/), 'Replacement advance on new terms agreed');
    fireEvent.click(btn);
    await waitFor(() => expect(mocks.supabase.rpc).toHaveBeenCalledTimes(1));
    const [fn, args] = mocks.supabase.rpc.mock.calls[0];
    expect(fn).toBe('cfo_transfer_agent_advance');
    expect(args).toMatchObject({ p_from_advance: ADV.id, p_destination: 'new_advance', p_amount: null, p_new_agent_id: null,
      p_reason: 'Replacement advance on new terms agreed' });
    expect(String(args.p_idempotency_key)).toMatch(/^adv-transfer-/);
    expect(mocks.supabase.rpc).not.toHaveBeenCalledWith('cancel_agent_advance', expect.anything());
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
    expect(mocks.toast.success.mock.calls[0][0]).toMatch(/No money was paid out/);
  });

  it('refuses a transfer above the balance before calling the database', () => {
    wrap(<CancelAdvanceDialog advance={ADV} open onOpenChange={() => {}} />);
    type(screen.getByPlaceholderText(String(ADV.outstanding_balance)), '2000000');
    type(screen.getByPlaceholderText(/Replacement advance on new terms/), 'Replacement advance on new terms agreed');
    expect(screen.getByText(/at most/)).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Transfer balance' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('keep for recoup cancels with p_recoup true', async () => {
    wrap(<CancelAdvanceDialog advance={ADV} open onOpenChange={() => {}} />);
    fireEvent.click(screen.getByRole('radio', { name: /keep the balance owed/i }));
    type(reasonBox(), 'Recover from the wallet over time');
    fireEvent.click(screen.getByRole('button', { name: 'Cancel, keep balance owed' }));
    await waitFor(() => expect(mocks.supabase.rpc).toHaveBeenCalledWith('cancel_agent_advance',
      { p_advance_id: ADV.id, p_recoup: true, p_reason: 'Recover from the wallet over time' }));
  });

  it('write-off without approval only requests it; it never cancels', async () => {
    wrap(<CancelAdvanceDialog advance={ADV} open onOpenChange={() => {}} />);
    fireEvent.click(screen.getByRole('radio', { name: /write off/i }));
    type(reasonBox(), 'Agent left the network and cannot be traced');
    fireEvent.click(await screen.findByRole('button', { name: 'Request write-off' }));
    await waitFor(() => expect(mocks.supabase.rpc).toHaveBeenCalledWith('request_agent_advance_write_off',
      { p_advance_id: ADV.id, p_reason: 'Agent left the network and cannot be traced' }));
    expect(mocks.supabase.rpc).not.toHaveBeenCalledWith('cancel_agent_advance', expect.anything());
  });

  it('a pending write-off shows its status and offers no action', async () => {
    mocks.tables.agent_advance_write_off_requests = [{ id: 'w1', status: 'requested', amount: ADV.outstanding_balance,
      reason: 'Agent left the network', requested_by: 'cfo-1', requested_at: '2026-11-04T10:00:00Z', decided_at: null, decision_note: null }];
    wrap(<CancelAdvanceDialog advance={ADV} open onOpenChange={() => {}} />);
    fireEvent.click(screen.getByRole('radio', { name: /write off/i }));
    expect(await screen.findByText(/waiting for approval/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /write-off/i })).toBeNull();
  });

  it('an approved write-off is posted through cancel_agent_advance', async () => {
    mocks.tables.agent_advance_write_off_requests = [{ id: 'w1', status: 'approved', amount: ADV.outstanding_balance,
      reason: 'Agent left the network', requested_by: 'cfo-2', requested_at: '2026-11-04T10:00:00Z', decided_at: '2026-11-04T11:00:00Z', decision_note: 'Approved by the CEO' }];
    wrap(<CancelAdvanceDialog advance={ADV} open onOpenChange={() => {}} />);
    fireEvent.click(screen.getByRole('radio', { name: /write off/i }));
    const btn = await screen.findByRole('button', { name: 'Post approved write-off' });
    type(reasonBox(), 'Approved write-off of the balance');
    fireEvent.click(btn);
    await waitFor(() => expect(mocks.supabase.rpc).toHaveBeenCalledWith('cancel_agent_advance',
      { p_advance_id: ADV.id, p_recoup: false, p_reason: 'Approved write-off of the balance' }));
  });

  it('an approval for a smaller amount cannot be used; a new request is offered instead', async () => {
    mocks.tables.agent_advance_write_off_requests = [{ id: 'w1', status: 'approved', amount: 1000000,
      reason: 'Agent left the network', requested_by: 'cfo-2', requested_at: '2026-11-04T10:00:00Z', decided_at: '2026-11-04T11:00:00Z', decision_note: 'ok' }];
    wrap(<CancelAdvanceDialog advance={ADV} open onOpenChange={() => {}} />);
    fireEvent.click(screen.getByRole('radio', { name: /write off/i }));
    expect(await screen.findByText(/can never exceed what was approved/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Post approved write-off' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Request write-off of current balance' })).toBeTruthy();
  });

  it('shows the database refusal without its code', async () => {
    mocks.supabase.rpc.mockResolvedValue({ data: null, error: { message: 'ADVANCE_DUPLICATE_SUBMISSION: this transfer was just submitted' } });
    wrap(<CancelAdvanceDialog advance={ADV} open onOpenChange={() => {}} />);
    type(screen.getByPlaceholderText(/Replacement advance on new terms/), 'Replacement advance on new terms agreed');
    fireEvent.click(screen.getByRole('button', { name: 'Transfer balance' }));
    expect((await screen.findByRole('alert')).textContent).toBe('this transfer was just submitted');
  });
});

describe('Write-off approvals', () => {
  const REQ = { id: 'w1', advance_id: ADV.id, amount: 1033875, reason: 'Agent left the network and cannot be traced',
    status: 'requested', requested_at: '2026-11-04T10:00:00Z' };
  beforeEach(() => {
    mocks.tables.agent_advances = [{ id: ADV.id, agent_id: 'agent-1', outstanding_balance: 1033875 }];
    mocks.tables.profiles = [{ id: 'agent-1', full_name: 'Replica Agent' }, { id: 'cfo-2', full_name: 'Other CFO' }];
  });
  it('the requester cannot decide their own request', async () => {
    mocks.tables.agent_advance_write_off_requests = [{ ...REQ, requested_by: 'cfo-1' }];
    wrap(<AdvanceWriteOffApprovals />);
    expect(await screen.findByText(/someone else must decide it/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Approve/ })).toBeNull();
  });
  it('another person approves with a note', async () => {
    mocks.tables.agent_advance_write_off_requests = [{ ...REQ, requested_by: 'cfo-2' }];
    wrap(<AdvanceWriteOffApprovals />);
    expect(await screen.findByText('Replica Agent')).toBeTruthy();
    const approve = screen.getByRole('button', { name: /Approve/ });
    expect((approve as HTMLButtonElement).disabled).toBe(true);
    type(screen.getByLabelText('Decision note'), 'Reviewed the file; approve');
    fireEvent.click(approve);
    await waitFor(() => expect(mocks.supabase.rpc).toHaveBeenCalledWith('decide_agent_advance_write_off',
      { p_request_id: 'w1', p_approve: true, p_note: 'Reviewed the file; approve' }));
  });
});

describe('Top-up: a payout that looks like a transfer', () => {
  it('asks for confirmation, then resubmits tagged as new money', async () => {
    mocks.supabase.rpc
      .mockResolvedValueOnce({ data: null, error: { message: 'ADVANCE_POSSIBLE_TRANSFER: UGX 50,000 matches a balance this agent already owes' } })
      .mockResolvedValueOnce({ data: {}, error: null });
    wrap(<CFOAdvanceTopupDialog advance={ADV} open onOpenChange={() => {}} />);
    type(screen.getByPlaceholderText('e.g. 50000'), '50000');
    type(screen.getByPlaceholderText(/Why is this top-up/), 'Extra stock for the busy season');
    fireEvent.click(screen.getByRole('button', { name: /Apply top-up/ }));
    expect(await screen.findByText(/matches a balance this agent already owes/)).toBeTruthy();
    expect(mocks.supabase.rpc.mock.calls[0][1].p_reason).toBe('Extra stock for the busy season');
    expect(mocks.toast.error).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: /This is new money/ }));
    await waitFor(() => expect(mocks.supabase.rpc).toHaveBeenCalledTimes(2));
    expect(mocks.supabase.rpc.mock.calls[1][1].p_reason).toBe(`${NEW_MONEY_TAG} Extra stock for the busy season`);
  });
});
