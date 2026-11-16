import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { RentRequestProgressCard } from './RentRequestProgressCard';
import type { TenantRentRequestRow } from '@/lib/rentRequestProgress';

const request: TenantRentRequestRow = {
  id: 'r1',
  status: 'pending',
  rent_amount: 300000,
  total_repayment: 419000,
  daily_repayment: 13967,
  duration_days: 30,
  created_at: '2026-11-14T07:52:49Z',
  service_center_reviewed_at: null,
  coo_reviewed_at: null,
  approved_at: null,
  funded_at: null,
  disbursed_at: null,
  rejected_at: null,
};

describe('RentRequestProgressCard', () => {
  it('shows where a new request is, the steps ahead and the amounts', () => {
    render(<RentRequestProgressCard request={request} />);
    expect(screen.getByText('Request received')).toBeTruthy();
    expect(screen.getByText('In progress')).toBeTruthy();
    for (const label of ['Request sent', 'Checking your details', 'Final approval', 'Rent paid to your landlord', 'Your Rent Plan']) {
      expect(screen.getByText(label)).toBeTruthy();
    }
    expect(screen.getByText('UGX 419,000')).toBeTruthy();
    expect(screen.getByText('30 days')).toBeTruthy();
  });

  it('asks a tenant with a stale request whether they still need rent', () => {
    const onConfirm = vi.fn();
    render(
      <RentRequestProgressCard
        request={{ ...request, status: 'service_center_review', reconfirm: { outcome: 'asked', respond_by: '2026-11-30T09:00:00Z' } }}
        onConfirmStillNeeded={onConfirm}
      />,
    );
    expect(screen.getByText('Do you still need rent?')).toBeTruthy();
    fireEvent.click(screen.getByText('Yes, I still need rent'));
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it('thanks a tenant who confirmed and asks nothing more', () => {
    render(<RentRequestProgressCard request={{ ...request, reconfirm: { outcome: 'still_needed', respond_by: '2026-11-30T09:00:00Z' } }} />);
    expect(screen.queryByText('Yes, I still need rent')).toBeNull();
    expect(screen.getByText('Thanks, we are checking your request again.')).toBeTruthy();
  });

  it('tells a rejected tenant what to do and hides the amounts', () => {
    render(<RentRequestProgressCard request={{ ...request, status: 'rejected', rejected_at: '2026-11-15T09:00:00Z' }} />);
    expect(screen.getByText('Your request was not approved')).toBeTruthy();
    expect(screen.getByText('Stopped')).toBeTruthy();
    expect(screen.queryByText('Total to repay')).toBeNull();
    expect(screen.getByText('+256 748 747134')).toBeTruthy();
  });
});
