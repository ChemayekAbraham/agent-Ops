import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';

const mocks = vi.hoisted(() => ({ rpc: vi.fn(), gate: {} as Record<string, unknown> }));
vi.mock('@/integrations/supabase/client', () => {
  const rows: Record<string, unknown[]> = {
    rent_requests: [{
      id: 'req-1', rent_amount: 300000, total_repayment: 420000, amount_repaid: 0, duration_days: 30, daily_repayment: 14000,
      status: 'pending', created_at: '2026-11-16T08:00:00Z', tenant_id: '11111111-1111-4111-8111-111111111111', landlord_id: 'll-1',
      agent_id: 'agent-1', house_listing_id: null, registration_type: null, initial_outstanding_balance: null,
      outstanding_grace_days: null, agent_verified: false, manager_verified: false, request_latitude: null, request_longitude: null,
      request_city: null, request_country: null, pricing_version: null,
    }],
    profiles: [{ id: '11111111-1111-4111-8111-111111111111', full_name: 'John Mukasa', phone: '0783123456', city: null }],
    landlords: [],
  };
  const builder = (table: string) => {
    const b: Record<string, unknown> = {};
    for (const m of ['select', 'or', 'neq', 'order', 'in', 'eq', 'is', 'limit']) b[m] = () => b;
    b.then = (resolve: (v: unknown) => unknown) => Promise.resolve({ data: rows[table] ?? [], error: null }).then(resolve);
    return b;
  };
  return { supabase: { rpc: mocks.rpc, from: builder } };
});
const auth = vi.hoisted(() => ({ user: { id: 'agent-1' } }));
vi.mock('@/hooks/useAuth', () => ({ useAuth: () => auth }));
vi.mock('@/hooks/use-toast', () => ({ useToast: () => ({ toast: vi.fn() }) }));
vi.mock('@/components/agent/PostingDraftsList', () => ({ PostingDraftsList: () => null }));
vi.mock('@/components/agent/AgentRejectedRequestsSection', () => ({ AgentRejectedRequestsSection: () => null }));
vi.mock('@/components/v360/V360AgentDayActions', () => ({ V360AgentDayActions: () => null }));
vi.mock('@/components/verification', () => ({ VerifyTenantButton: () => null, VerifyLandlordButton: () => null }));

import { AgentMyRentRequestsSheet } from '@/components/agent/AgentMyRentRequestsSheet';

beforeEach(() => {
  mocks.rpc.mockReset();
  mocks.rpc.mockImplementation(async (fn: string) => (fn === 'agent_vetting_gate_status' ? { data: mocks.gate, error: null } : { data: null, error: null }));
});

describe('E111: the agent\'s request list', () => {
  it('an unverified agent\'s open request says "Waiting at COO: complete your verification", not a status or error', async () => {
    mocks.gate = { blocked: false, vetted: false, funding_frozen: true, notice: 'You can post rent requests.' };
    render(<AgentMyRentRequestsSheet open onOpenChange={vi.fn()} />);
    const line = await screen.findByTestId('waiting-at-coo');
    expect(line).toHaveTextContent('Waiting at COO: complete your verification');
    expect(line).toHaveAttribute('href', '/dashboard/agent/verification');
    expect(screen.queryByText('Pending')).toBeNull();
    expect(mocks.rpc).toHaveBeenCalledWith('agent_vetting_gate_status', { p_agent_id: 'agent-1' });
  });

  it('a verified agent sees the usual status', async () => {
    mocks.gate = { blocked: false, vetted: true, funding_frozen: false, notice: null };
    render(<AgentMyRentRequestsSheet open onOpenChange={vi.fn()} />);
    expect(await screen.findByText('Pending')).toBeInTheDocument();
    await waitFor(() => expect(mocks.rpc).toHaveBeenCalledWith('agent_vetting_gate_status', { p_agent_id: 'agent-1' }));
    expect(screen.queryByTestId('waiting-at-coo')).toBeNull();
  });
});
