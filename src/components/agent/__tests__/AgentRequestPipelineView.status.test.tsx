import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const mocks = vi.hoisted(() => ({
  rpc: vi.fn(async (fn: string) => (fn === 'agent_vetting_gate_status'
    ? { data: { blocked: false, vetted: false, funding_frozen: true }, error: null }
    : { data: null, error: null })),
}));
vi.mock('@/integrations/supabase/client', () => {
  const row = (id: string, status: string) => ({
    id, rent_amount: 300000, total_repayment: 420000, duration_days: 30, amount_repaid: 0, status,
    created_at: '2026-11-16T08:00:00Z', disbursed_at: null, tenant_id: `t-${id}`, landlord_id: 'll-1',
    resubmitted_at: null, resubmission_count: 0,
  });
  const rows: Record<string, unknown[]> = {
    rent_requests: [row('r1', 'coo_approved'), row('r2', 'tenant_ops_approved')],
    profiles: [{ id: 't-r1', full_name: 'Grace Nakato', phone: '' }, { id: 't-r2', full_name: 'Peter Okot', phone: '' }],
  };
  const builder = (table: string) => {
    const b: Record<string, unknown> = {};
    for (const m of ['select', 'eq', 'in', 'order', 'range', 'limit', 'or', 'neq']) b[m] = () => b;
    b.then = (resolve: (v: unknown) => unknown) =>
      Promise.resolve({ data: rows[table] ?? [], error: null, count: (rows[table] ?? []).length }).then(resolve);
    return b;
  };
  return { supabase: { rpc: mocks.rpc, from: builder } };
});
vi.mock('@/hooks/useAuth', () => ({ useAuth: () => ({ user: { id: 'agent-1' }, enabledRoles: ['agent'] }) }));
vi.mock('@/hooks/useAgentRejectedRequests', () => ({ useAgentRejectedRequests: () => ({ data: [], isLoading: false, isFetching: false, refetch: vi.fn() }) }));

import { AgentRequestPipelineView } from '@/components/agent/AgentRequestPipelineView';

describe('agent pipeline: status labels', () => {
  it('a request on the funders\' board says so, and one at the COO from an unverified agent waits with the reason', async () => {
    render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <AgentRequestPipelineView initialTab="submitted" />
      </QueryClientProvider>,
    );
    expect(await screen.findByText("On the funders' board — waiting for a funder")).toBeInTheDocument();
    expect(screen.getByText('Next: a funder selects, then the money comes to your landlord float')).toBeInTheDocument();
    expect(await screen.findByText('Waiting at the COO')).toBeInTheDocument();
    expect(screen.getByTestId('status-note')).toHaveTextContent('You are not verified yet');
    expect(screen.queryByText(/CFO funding|Funds sent to landlord/)).toBeNull();
  });
});
