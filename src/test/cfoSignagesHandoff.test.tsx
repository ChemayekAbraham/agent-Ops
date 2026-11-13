import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { CFOSignagesDesk } from '@/components/cfo/CFOSignagesDesk';

vi.mock('@/hooks/useWelileSignages', () => ({
  useSignageDetail: () => ({ data: { photos: [] }, isPending: false }),
  useSignageCfoQueue: () => ({ data: [
    { id: 'coo-approved', status: 'pending_installation', property_name: 'Approved shop',
      reference_no: 'SGN-1', owner_full_name: 'Owner', owner_phone: '0700000000', district_name: 'Kampala',
      village_name: 'Central', property_type: 'shop', photos: [], agent_reward_status: 'not_eligible', owner_rent_status: 'not_due',
      owner_payment_method: 'momo_mtn', owner_payment_number: '0700000000', owner_payment_name: 'Owner' },
    { id: 'awaiting-coo', status: 'awaiting_coo', property_name: 'Not yet approved', reference_no: 'SGN-2' },
  ], isLoading: false, refetch: vi.fn() }),
  useCfoDisburseSignage: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useCfoDeclineInstallation: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useCfoTerminateSignage: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));

afterEach(cleanup);
describe('COO to CFO Signages handoff', () => {
  it('shows COO-approved applications while they are being installed, with no payment yet', () => {
    render(<CFOSignagesDesk />);
    expect(screen.getByText('Approved shop')).toBeInTheDocument();
    expect(screen.queryByText('Not yet approved')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Pay Agent|Pay Owner/ })).not.toBeInTheDocument();
  });
});