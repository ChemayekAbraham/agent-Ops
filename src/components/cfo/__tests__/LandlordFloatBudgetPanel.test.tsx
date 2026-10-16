import { beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { LandlordFloatBudgetStatus } from '@/lib/landlordFloatBudget';

const mocks = vi.hoisted(() => ({ setBudget: vi.fn(), decideMisc: vi.fn(), allocations: vi.fn(), status: {} as LandlordFloatBudgetStatus }));
vi.mock('@/hooks/useLandlordFloatBudget', () => ({
  useLandlordFloatBudgetStatus: () => ({ data: mocks.status }),
  useLandlordFloatBudgetActions: () => ({ setBudget: { mutateAsync: mocks.setBudget, isPending: false }, decideMisc: { mutateAsync: mocks.decideMisc, isPending: false } }),
  useLandlordFloatBudgetHistory: () => ({ data: [{ id: 'history', period_type: 'daily', period_start: '2026-10-16', period_end: '2026-10-16', amount: 100000, used: 50000, misc_used: 10000, excess: 0, is_current: false, set_by_name: 'CFO', reason: 'Original budget', created_at: '2026-10-16T07:00:00Z' }] }),
  useLandlordFloatBudgetAllocations: (...args: unknown[]) => { mocks.allocations(...args); return { data: [{ allocation_id: 'allocation', tenant_name: 'Tenant One', landlord_name: 'Landlord One', kind: 'within_cap', amount: 50000, approved_by_name: 'COO', approved_at: '2026-10-16T08:00:00Z', released_at: '2026-10-16T09:00:00Z', released_reason: 'Returned for review' }] }; },
  useLandlordFloatMiscQueue: () => ({ data: [{ id: 'misc-1', rent_request_id: 'rent-1', tenant_name: 'Tenant One', landlord_name: 'Landlord One', agent_name: 'Agent One', amount: 150000, reason: 'Urgent landlord payment', requested_by_name: 'COO', requested_at: '2026-10-16T08:00:00Z', room_at_request: 10000 }] }),
}));
vi.mock('sonner', () => ({ toast: { success: vi.fn() } }));
import { LandlordFloatBudgetPanel } from '../LandlordFloatBudgetPanel';
import { LandlordFloatBudgetPosition } from '@/components/shared/LandlordFloatBudgetPosition';

beforeEach(() => {
  cleanup(); vi.clearAllMocks();
  const period = { budget_id: 'budget', amount: 100000, used: 50000, misc_used: 0, approved_count: 1, remaining: 50000, excess: 0, reason: null, over_weekly_warning: false, set_by: 'cfo', set_by_name: 'CFO', set_at: '2026-10-16T07:00:00Z' };
  mocks.status = { day: '2026-10-16', today: '2026-10-16', week_start: '2026-10-12', week_end: '2026-10-18', blocked: false, blocked_reason: null, room: 50000, daily: { ...period }, weekly: { ...period, amount: 500000 }, can_set_budget: true, can_decide_misc: true, can_approve: true, pending_misc: [{ id: 'misc-1', rent_request_id: 'rent-1', amount: 150000 }], pending_misc_total: 150000 };
  mocks.setBudget.mockResolvedValue({});
  mocks.decideMisc.mockResolvedValue({ approved: [], rejected: [{ id: 'misc-1' }], skipped: [] });
});
describe('Landlord float budget workspace', () => {
  it('saves a comma-separated daily amount through the existing action', async () => {
    render(<LandlordFloatBudgetPanel />);
    fireEvent.change(screen.getByLabelText('Daily amount (UGX)'), { target: { value: '200,000' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save daily budget' }));
    await waitFor(() => expect(mocks.setBudget).toHaveBeenCalledWith({ periodType: 'daily', amount: 200000, reason: undefined }));
  });
  it('requires ten trimmed characters for daily above weekly and weekly below daily', () => {
    render(<LandlordFloatBudgetPanel />);
    fireEvent.change(screen.getByLabelText('Daily amount (UGX)'), { target: { value: '600000' } });
    expect(screen.getByRole('button', { name: 'Save daily budget' })).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Reason (at least 10 characters)'), { target: { value: 'Urgent rent payments' } });
    expect(screen.getByRole('button', { name: 'Save daily budget' })).toBeEnabled();
    fireEvent.change(screen.getByLabelText('Weekly amount (UGX)'), { target: { value: '50000' } });
    expect(screen.getByRole('button', { name: 'Save weekly budget' })).toBeDisabled();
  });
  it('shows the reason field on a server reason-required error', async () => {
    mocks.setBudget.mockRejectedValue(new Error('OVER_WEEKLY_REASON_REQUIRED: Please explain the mismatch'));
    render(<LandlordFloatBudgetPanel />);
    fireEvent.change(screen.getByLabelText('Daily amount (UGX)'), { target: { value: '200000' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save daily budget' }));
    await waitFor(() => expect(screen.getByLabelText('Reason (at least 10 characters)')).toBeInTheDocument());
    expect(screen.getByRole('alert')).toHaveTextContent('Please explain the mismatch');
  });
  it('keeps budget and miscellaneous values read-only without permission', () => {
    mocks.status.can_set_budget = false; mocks.status.can_decide_misc = false;
    render(<LandlordFloatBudgetPanel />);
    expect(screen.queryByLabelText('Daily amount (UGX)')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Approve' })).not.toBeInTheDocument();
    expect(screen.getByText('Urgent landlord payment')).toBeInTheDocument();
  });
  it('bulk rejects only with a sufficient note and sends selected IDs', async () => {
    render(<LandlordFloatBudgetPanel />);
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select all miscellaneous requests' }));
    fireEvent.click(screen.getByRole('button', { name: 'Reject selected' }));
    expect(screen.getByRole('button', { name: 'Reject requests' })).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Required note (at least 10 characters)'), { target: { value: 'Return for more evidence' } });
    fireEvent.click(screen.getByRole('button', { name: 'Reject requests' }));
    await waitFor(() => expect(mocks.decideMisc).toHaveBeenCalledWith({ miscIds: ['misc-1'], decision: 'reject', note: 'Return for more evidence' }));
  });
  it('opens period approvals with released history', () => {
    render(<LandlordFloatBudgetPanel />);
    fireEvent.click(screen.getByRole('button', { name: /Daily · 2026-10-16/ }));
    expect(mocks.allocations).toHaveBeenLastCalledWith('daily', '2026-10-16');
    expect(screen.getByText('Released')).toBeInTheDocument();
  });
  it('shows blocked and over-budget positions', () => {
    mocks.status.blocked = true; mocks.status.blocked_reason = 'no_weekly_budget'; mocks.status.daily.excess = 1000;
    render(<LandlordFloatBudgetPosition position={mocks.status} />);
    expect(screen.getByText(/waiting for the CFO to set this week’s/)).toBeInTheDocument();
    expect(screen.getByText(/exceeds the daily budget by UGX 1,000/)).toBeInTheDocument();
  });
});