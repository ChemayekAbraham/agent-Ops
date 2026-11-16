import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { AgentRejectedRequest } from '@/hooks/useAgentRejectedRequests';

const mocks = vi.hoisted(() => ({
  rpc: vi.fn(),
  open: vi.fn(),
  rejected: [] as unknown[],
  /** What the head-count query asked for. */
  countStatuses: null as unknown,
}));
vi.mock('@/integrations/supabase/client', () => {
  // Today's pending request: the Submitted count must include it.
  const today = { id: 'r-today', rent_amount: 300000, total_repayment: 420000, duration_days: 30, amount_repaid: 0, status: 'pending',
    created_at: new Date().toISOString(), disbursed_at: null, tenant_id: 't-1', landlord_id: 'll-1', resubmitted_at: null, resubmission_count: 0 };
  const builder = (table: string) => {
    const b: Record<string, unknown> = {};
    let head = false;
    b.select = (_c: string, o?: { head?: boolean }) => { head = !!o?.head; return b; };
    for (const m of ['eq', 'order', 'range', 'limit', 'or', 'neq']) b[m] = () => b;
    b.in = (_c: string, v: unknown) => { if (head) mocks.countStatuses = v; return b; };
    b.then = (resolve: (v: unknown) => unknown) => {
      if (table === 'rent_requests' && head) return Promise.resolve({ data: null, error: null, count: 1 }).then(resolve);
      const data = table === 'rent_requests' ? [today] : table === 'profiles' ? [{ id: 't-1', full_name: 'Grace Nakato', phone: '' }] : [];
      return Promise.resolve({ data, error: null, count: data.length }).then(resolve);
    };
    return b;
  };
  return { supabase: { rpc: mocks.rpc, from: builder } };
});
vi.mock('@/hooks/useAuth', () => ({ useAuth: () => ({ user: { id: 'agent-1' }, enabledRoles: ['agent'] }) }));
vi.mock('@/hooks/useAgentRejectedRequests', () => ({
  useAgentRejectedRequests: () => ({ data: mocks.rejected, isLoading: false, isFetching: false, refetch: vi.fn() }),
}));
vi.mock('@/lib/t4RentRequest', async (orig) => ({ ...(await orig<typeof import('@/lib/t4RentRequest')>()), openT4RentRequest: mocks.open }));

import { AgentRequestPipelineView, SUBMITTED_STATUSES } from '@/components/agent/AgentRequestPipelineView';

const rejected = (over: Partial<AgentRejectedRequest>) => ({
  id: 'x', rent_amount: 300000, duration_days: 30, status: 'rejected', created_at: '2026-11-10T08:00:00Z', rejected_at: '2026-11-12T08:00:00Z',
  rejected_reason: 'Wrong landlord', returned_at: null, tenant_name: 'Tenant', landlord_name: 'Landlord', stage_label: 'Tenant Ops', reviewer_name: 'Desk',
  ...over,
}) as AgentRejectedRequest;

const renderView = (initialTab: 'submitted' | 'rejected') => render(
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    <AgentRequestPipelineView initialTab={initialTab} />
  </QueryClientProvider>,
);

beforeEach(() => {
  mocks.rpc.mockReset();
  mocks.open.mockReset();
  mocks.countStatuses = null;
  mocks.rpc.mockImplementation(async (fn: string, args: { p_request_id?: string }) => (fn === 'resubmit_needs' && args?.p_request_id === 'r-back'
    ? { data: { items: [{ code: 'id_front', label: 'ID front', why: 'desk' }, { code: 'id_back', label: 'ID back', why: 'missing' }], count: 2, desk: 'Tenant Ops', desk_note: 'Blurry', auto_note: 'Fixed: ID front, ID back' }, error: null }
    : { data: null, error: null }));
  // The closed rejection comes first in the data; the sent-back one must still be on top.
  mocks.rejected = [
    rejected({ id: 'r-closed', tenant_name: 'Closed Tenant', rejected_reason: 'Tenant already has a Rent Plan' }),
    rejected({ id: 'r-back', tenant_name: 'Sent Back Tenant', returned_at: '2026-11-15T09:00:00Z', rejected_reason: 'ID photos blurry' }),
  ];
});

describe('Submissions: the "To fix" tab', () => {
  it('the Rejected tab is now "To fix", in amber, not red', async () => {
    renderView('rejected');
    const tab = screen.getByRole('button', { name: /To fix/ });
    expect(tab.className).toContain('bg-amber-600');
    expect(tab.className).not.toContain('bg-destructive');
    expect(screen.queryByRole('button', { name: /^\d*\s*Rejected$/ })).toBeNull();
  });

  it('sent-back requests are above "Closed" (hard rejections), with the right labels and buttons', async () => {
    renderView('rejected');
    const back = await screen.findByTestId('to-fix-sent-back');
    const closed = screen.getByTestId('to-fix-closed');
    const heading = screen.getByTestId('to-fix-closed-heading');
    expect(heading).toHaveTextContent('Closed');
    expect(back.compareDocumentPosition(heading) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(heading.compareDocumentPosition(closed) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(back).toHaveTextContent('Sent back to you — fix and resubmit');
    expect(back).toHaveTextContent('ID photos blurry');
    expect(within(back).getByRole('button', { name: /Edit & Resubmit/ })).toBeInTheDocument();
    // A closed rejection can still go again: no cap.
    expect(within(closed).getByRole('button', { name: /Fix and send again/ })).toBeInTheDocument();
  });

  it('a sent-back card shows "N to fix" from resubmit_needs', async () => {
    renderView('rejected');
    const chips = await screen.findByTestId('to-fix-chips');
    expect(chips).toHaveTextContent('2 to fix:');
    expect(within(chips).getByText('ID front')).toBeInTheDocument();
    expect(within(chips).getByText('ID back')).toBeInTheDocument();
    expect(mocks.rpc).toHaveBeenCalledWith('resubmit_needs', { p_request_id: 'r-back' });
    // Closed rejections don't ask.
    expect(mocks.rpc).not.toHaveBeenCalledWith('resubmit_needs', { p_request_id: 'r-closed' });
  });

  it('Edit & Resubmit (and Fix and send again) open the chat resubmit', async () => {
    renderView('rejected');
    fireEvent.click(within(await screen.findByTestId('to-fix-sent-back')).getByRole('button', { name: /Edit & Resubmit/ }));
    expect(mocks.open).toHaveBeenCalledWith(expect.objectContaining({ mode: 'resubmit', rejected: expect.objectContaining({ id: 'r-back' }) }));
    fireEvent.click(within(screen.getByTestId('to-fix-closed')).getByRole('button', { name: /Fix and send again/ }));
    expect(mocks.open).toHaveBeenLastCalledWith(expect.objectContaining({ mode: 'resubmit', rejected: expect.objectContaining({ id: 'r-closed' }) }));
  });
});

describe('Submissions: the Submitted count', () => {
  it('counts every request in the pipeline, a pending one posted today included, even with another tab open', async () => {
    renderView('rejected');
    const submittedTab = screen.getByRole('button', { name: /Submitted/ });
    await waitFor(() => expect(submittedTab).toHaveTextContent('1'));
    expect(mocks.countStatuses).toEqual(SUBMITTED_STATUSES);
    for (const s of ['pending', 'service_center_review', 'agent_ops_approved', 'tenant_ops_approved', 'landlord_ops_approved', 'partner_ops_approved', 'coo_approved']) {
      expect(SUBMITTED_STATUSES).toContain(s);
    }
  });
});
