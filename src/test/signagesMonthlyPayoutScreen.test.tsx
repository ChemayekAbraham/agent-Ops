import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { CFOSignagesDesk } from '@/components/cfo/CFOSignagesDesk';

const mocks = vi.hoisted(() => ({
  pay: vi.fn(), returnToAgent: vi.fn(), terminate: vi.fn(),
  row: {} as Record<string, unknown>,
}));
const base = {
  id: 'signage', status: 'active', coo_approved_at: '2026-11-01T00:00:00Z',
  property_name: 'Shop', reference_no: 'SGN-1', owner_full_name: 'Owner', owner_phone: '0700000000',
  owner_payment_method: 'momo_mtn', owner_payment_number: '0700000000', district_name: 'Kampala', village_name: 'Central',
  property_type: 'shop', agent_reward_status: 'paid', owner_rent_status: 'not_due', owner_rent_payable: false,
  owner_rent_period_index: 0, created_at: '2026-11-01T00:00:00Z', owner_rent_due_at: '2026-12-13T00:00:00Z',
  owner_account_id: 'owner-acct', owner_account_name: 'Owner Name', owner_account_issue: null,
};
vi.mock('@/hooks/useWelileSignages', () => ({
  useSignageDetail: () => ({ data: { photos: [] }, isPending: false }),
  useSignageCfoQueue: () => ({ data: [{ ...base, ...mocks.row }], refetch: vi.fn(), isLoading: false }),
  useCfoDisburseSignage: () => ({ mutateAsync: mocks.pay, isPending: false }),
  useCfoReturnSignage: () => ({ mutateAsync: mocks.returnToAgent, isPending: false }),
  useCfoTerminateSignage: () => ({ mutateAsync: mocks.terminate, isPending: false }),
}));

afterEach(() => { cleanup(); vi.clearAllMocks(); mocks.row = {}; });
describe('CFO signage money actions', () => {
  it('pays the agent once after COO approval, and that payment activates', async () => {
    mocks.row = { status: 'awaiting_cfo', agent_reward_status: 'not_eligible' };
    render(<CFOSignagesDesk />);
    fireEvent.click(screen.getByRole('button', { name: 'Pay Agent & Activate' }));
    expect(mocks.pay).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Confirm & Disburse' }));
    await waitFor(() => expect(mocks.pay).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ payoutType: 'agent_reward', periodIndex: 0 })));
  });
  it('returns an application to the agent with a reason and pays nothing', async () => {
    mocks.row = { status: 'awaiting_cfo', agent_reward_status: 'not_eligible' };
    render(<CFOSignagesDesk />);
    fireEvent.click(screen.getByRole('button', { name: 'Return to agent' }));
    fireEvent.change(screen.getByPlaceholderText('Reason (at least 10 characters)'), { target: { value: 'Signage not visible in photo' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send back to agent' }));
    await waitFor(() => expect(mocks.returnToAgent).toHaveBeenCalledExactlyOnceWith({ signageId: 'signage', reason: 'Signage not visible in photo' }));
    expect(mocks.pay).not.toHaveBeenCalled();
  });
  it('offers no owner payment in the first month', () => {
    render(<CFOSignagesDesk />);
    expect(screen.queryByRole('button', { name: /Pay Owner/ })).not.toBeInTheDocument();
  });
  it('offers the owner payout from month 2 once due and the owner wallet is known', async () => {
    mocks.row = { owner_rent_payable: true };
    render(<CFOSignagesDesk />);
    fireEvent.click(screen.getByRole('button', { name: 'Pay Owner (month 2)' }));
    fireEvent.click(screen.getByRole('button', { name: 'Confirm & Disburse' }));
    await waitFor(() => expect(mocks.pay).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ payoutType: 'owner_rent', periodIndex: 0 })));
  });
  it('blocks the owner payout when the owner has no Welile wallet yet', () => {
    mocks.row = { owner_rent_payable: true, owner_account_id: null, owner_account_issue: 'The owner has no Welile account yet.' };
    render(<CFOSignagesDesk />);
    expect(screen.queryByRole('button', { name: /Pay Owner/ })).not.toBeInTheDocument();
    expect(screen.getByText('The owner has no Welile account yet.')).toBeInTheDocument();
  });
  it('terminates with a reason and pays nothing', async () => {
    render(<CFOSignagesDesk />);
    fireEvent.click(screen.getByRole('button', { name: 'Terminate contract' }));
    fireEvent.change(screen.getByPlaceholderText('Reason (at least 10 characters)'), { target: { value: 'Owner ended the contract' } });
    fireEvent.click(screen.getAllByRole('button', { name: 'Terminate contract' }).at(-1)!);
    await waitFor(() => expect(mocks.terminate).toHaveBeenCalledExactlyOnceWith({ signageId: 'signage', reason: 'Owner ended the contract' }));
    expect(mocks.pay).not.toHaveBeenCalled();
  });
  it('has no batch payment and no approve-without-paying button', () => {
    mocks.row = { status: 'awaiting_cfo', agent_reward_status: 'not_eligible' };
    render(<CFOSignagesDesk />);
    expect(screen.queryByRole('button', { name: /Batch Pay/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Approve & Activate/ })).not.toBeInTheDocument();
  });
});
