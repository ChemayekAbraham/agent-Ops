import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { CFOSignagesDesk } from '@/components/cfo/CFOSignagesDesk';

const mocks = vi.hoisted(() => ({ approve: vi.fn(), pay: vi.fn(), payable: false, status: 'active' }));
vi.mock('@/hooks/useWelileSignages', () => ({
  useSignageDetail: () => ({ data: { photos: [] }, isPending: false }),
  useSignageCfoQueue: () => ({ data: [{ id: 'signage', status: mocks.status, coo_approved_at: '2026-11-01T00:00:00Z',
    property_name: 'Shop', reference_no: 'SGN-1', owner_full_name: 'Owner', owner_phone: '0700000000',
    owner_payment_method: 'momo_mtn', owner_payment_number: '0700000000', district_name: 'Kampala', village_name: 'Central',
    property_type: 'shop', agent_reward_status: 'eligible', owner_rent_status: 'pending', owner_rent_payable: mocks.payable,
    owner_rent_period_index: 0, created_at: '2026-11-01T00:00:00Z', owner_rent_due_at: '2026-12-01T00:00:00Z',
  }], refetch: vi.fn(), isLoading: false }),
  useCfoDisburseSignage: () => ({ mutateAsync: mocks.pay, isPending: false }),
  useCfoApproveSignage: () => ({ mutateAsync: mocks.approve, isPending: false }),
}));

afterEach(() => { cleanup(); vi.clearAllMocks(); mocks.payable = false; mocks.status = 'active'; });
describe('server-owned signage actions', () => {
  it('does not offer owner payment when the server says the first 30 days are not complete, but keeps agent payment', () => {
    render(<CFOSignagesDesk />);
    expect(screen.queryByRole('button', { name: 'Monthly payout' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Pay Agent' })).toBeEnabled();
    expect(mocks.pay).not.toHaveBeenCalled();
  });
  it('offers the monthly owner action only when the server reports it due', () => {
    mocks.payable = true;
    render(<CFOSignagesDesk />);
    expect(screen.getByRole('button', { name: 'Monthly payout' })).toBeEnabled();
    expect(mocks.pay).not.toHaveBeenCalled();
  });
  it('requires explicit CFO confirmation to activate and makes no payment', async () => {
    mocks.status = 'awaiting_cfo';
    mocks.approve.mockResolvedValue({ status: 'active' });
    render(<CFOSignagesDesk />);
    fireEvent.click(screen.getByRole('button', { name: 'Approve & Activate' }));
    expect(mocks.approve).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Confirm approval' }));
    await waitFor(() => expect(mocks.approve).toHaveBeenCalledExactlyOnceWith('signage'));
    expect(mocks.pay).not.toHaveBeenCalled();
  });
});