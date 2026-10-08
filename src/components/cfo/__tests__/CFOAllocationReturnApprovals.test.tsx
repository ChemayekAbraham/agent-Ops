import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';

const rows = [
  {
    id: 'pending-1', agent_id: 'a1', allocation_id: 'al1', rent_request_id: 'rr1', landlord_id: 'l1',
    landlord_name: 'Pending Landlord', amount: 300000, reason: 'Landlord asked to wait', status: 'pending',
    cfo_id: null, cfo_decision_at: null, cfo_note: null, auto_approved: false,
    created_at: new Date().toISOString(),
  },
  {
    id: 'auto-1', agent_id: 'a1', allocation_id: 'al2', rent_request_id: 'rr2', landlord_id: 'l2',
    landlord_name: 'Automatic Landlord', amount: 200000, reason: 'Tenant changed their mind', status: 'approved',
    cfo_id: null, cfo_decision_at: new Date().toISOString(), cfo_note: 'auto-approved agent send-back', auto_approved: true,
    created_at: new Date().toISOString(),
  },
  {
    id: 'cfo-1', agent_id: 'a1', allocation_id: 'al3', rent_request_id: 'rr3', landlord_id: 'l3',
    landlord_name: 'Decided Landlord', amount: 100000, reason: 'Wrong landlord chosen', status: 'approved',
    cfo_id: 'cfo', cfo_decision_at: new Date().toISOString(), cfo_note: 'ok', auto_approved: false,
    created_at: new Date().toISOString(),
  },
];

const rpc = vi.fn();

vi.mock('@/integrations/supabase/client', () => ({
  supabase: {
    from: (table: string) => {
      if (table === 'agent_allocation_return_requests') {
        return { select: () => ({ order: () => ({ limit: async () => ({ data: rows, error: null }) }) }) };
      }
      return { select: () => ({ in: async () => ({ data: [{ id: 'a1', full_name: 'Agent One', phone: '0700' }] }) }) };
    },
    rpc: (...args: unknown[]) => rpc(...args),
  },
}));
vi.mock('@/hooks/use-toast', () => ({ useToast: () => ({ toast: vi.fn() }) }));

import { CFOAllocationReturnApprovals } from '../CFOAllocationReturnApprovals';

describe('CFOAllocationReturnApprovals', () => {
  beforeEach(() => rpc.mockReset());

  it('keeps only the waiting send-back on the pending tab, with approve controls', async () => {
    render(<CFOAllocationReturnApprovals />);
    await waitFor(() => expect(screen.getByText(/Pending Landlord/)).toBeTruthy());
    expect(screen.queryByText(/Automatic Landlord/)).toBeNull();
    expect(screen.getByRole('button', { name: /Approve & return to CFO/ })).toBeTruthy();
  });

  it('shows automatic send-backs as read-only history, never with approve or reject buttons', async () => {
    render(<CFOAllocationReturnApprovals />);
    await waitFor(() => expect(screen.getByText(/Pending Landlord/)).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: /Automatic \(1\)/ }));
    expect(screen.getByText(/Automatic Landlord/)).toBeTruthy();
    expect(screen.getByText(/System note:/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Approve & return to CFO/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /^Reject/ })).toBeNull();
    expect(screen.queryByText(/Decided Landlord/)).toBeNull();
  });

  it('keeps CFO-decided rows on the decided tab, separate from automatic ones', async () => {
    render(<CFOAllocationReturnApprovals />);
    await waitFor(() => expect(screen.getByText(/Pending Landlord/)).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: /Decided \(1\)/ }));
    expect(screen.getByText(/Decided Landlord/)).toBeTruthy();
    expect(screen.getByText(/CFO note:/)).toBeTruthy();
    expect(screen.queryByText(/Automatic Landlord/)).toBeNull();
  });
});
