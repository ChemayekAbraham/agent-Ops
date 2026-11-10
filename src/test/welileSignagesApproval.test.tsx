import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, cleanup } from '@testing-library/react';
import { WelileSignagesOps } from '@/components/executive/agent-ops-v2/WelileSignagesOps';

const mocks = vi.hoisted(() => ({ status: 'awaiting_coo', decide: vi.fn() }));
vi.mock('@/hooks/useWelileSignages', () => ({
  useSignageDetail: () => ({ data: { photos: [] }, isPending: false }),
  useSignageOpsQueue: () => ({ data: [{ id: 'signage', property_name: 'Busy shop', reference_no: 'SGN-1', status: mocks.status,
    property_type: 'shop', owner_phone: '0700000000', district_name: 'Kampala', village_name: 'Central',
    gps_latitude: 0.3, gps_longitude: 32.5, gps_accuracy_meters: 10, owner_full_name: 'Owner', owner_payment_method: 'momo_mtn', photos: [] }], refetch: vi.fn() }),
  useReviewSignage: () => ({ mutateAsync: mocks.decide, isPending: false }),
}));

describe('COO Signages approval controls', () => {
  beforeEach(() => { cleanup(); mocks.status = 'awaiting_coo'; mocks.decide.mockReset().mockResolvedValue({}); });
  it('lets the COO review and confirm an application awaiting COO without installation controls', async () => {
    render(<WelileSignagesOps stage="coo" onBack={vi.fn()} />);
    expect(screen.queryByRole('button', { name: 'Verify Installation' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Inspect & Decide' }));
    fireEvent.click(screen.getByRole('button', { name: 'Confirm Decision' }));
    await waitFor(() => expect(mocks.decide).toHaveBeenCalledWith({ signageId: 'signage', decision: 'approve', notes: undefined, rejectionReason: undefined }));
  });
  it('does not offer Agent Ops approval or installation while an application awaits COO', () => {
    render(<WelileSignagesOps onBack={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Inspect & Decide' }));
    expect(screen.queryByRole('button', { name: 'Confirm Decision' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Verify Installation' })).not.toBeInTheDocument();
  });
  it('sends a pending application through the Agent Ops approval action', async () => {
    mocks.status = 'pending';
    render(<WelileSignagesOps onBack={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Inspect & Decide' }));
    fireEvent.click(screen.getByRole('button', { name: 'Send to COO' }));
    fireEvent.click(screen.getByRole('button', { name: 'Confirm Decision' }));
    await waitFor(() => expect(mocks.decide).toHaveBeenCalledWith({ signageId: 'signage', decision: 'approve', notes: undefined, rejectionReason: undefined }));
  });
});