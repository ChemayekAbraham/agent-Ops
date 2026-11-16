/**
 * COO Rent profit share Return Approvals: a Return whose cycle was locked by an earlier payout
 * saved under the wrong month must be visibly a correction, with the reason the requester gave.
 * Approve and Reject stay exactly as they are.
 */
import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, expect, it, vi } from 'vitest';

const rows = [
  {
    id: 'op-correction', user_id: null, amount: 213612, category: 'roi_payout', description: null,
    status: 'pending_coo_approval', created_at: '2026-11-13T08:00:00.000Z', reference_id: 'PAY-111',
    operation_type: 'roi_wallet_credit', target_wallet_user_id: null, source_id: 'portfolio-1',
    metadata: {
      partner_name: 'Ruth Amaa', cycle_anchor: '2026-11-13',
      correction: 'misdated_cycle_key',
      correction_reason: 'October payout was saved under the November cycle key by mistake',
    },
    reviewed_by: null, reviewed_at: null, rejection_reason: null,
  },
  {
    id: 'op-plain', user_id: null, amount: 603750, category: 'roi_payout', description: null,
    status: 'pending_coo_approval', created_at: '2026-11-12T08:00:00.000Z', reference_id: 'PAY-222',
    operation_type: 'roi_wallet_credit', target_wallet_user_id: null, source_id: 'portfolio-2',
    metadata: { partner_name: 'Musa Sekalaala', cycle_anchor: '2026-10-28' },
    reviewed_by: null, reviewed_at: null, rejection_reason: null,
  },
];

vi.mock('@/integrations/supabase/client', () => ({
  supabase: {
    from: (table: string) => {
      const answer = table === 'pending_wallet_operations'
        ? { data: rows, error: null }
        : { data: [], error: null };
      const query: Record<string, unknown> = { then: (res: (v: unknown) => unknown) => Promise.resolve(answer).then(res) };
      for (const m of ['select', 'eq', 'order', 'limit', 'in']) query[m] = () => query;
      return query;
    },
  },
}));
vi.mock('@/hooks/useAuth', () => ({ useAuth: () => ({ user: { id: 'coo-1' } }) }));

import { COOROIApprovals } from '@/components/coo/COOROIApprovals';

function renderList() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <COOROIApprovals />
    </QueryClientProvider>,
  );
}

describe('COO Rent profit share Return Approvals — correction items', () => {
  it('marks the misdated-key Return as a correction and shows its reason', async () => {
    renderList();
    await screen.findByText('Ruth Amaa');
    expect(screen.getAllByText('Correction')).toHaveLength(1);
    expect(screen.getByText(/October payout was saved under the November cycle key by mistake/)).toBeInTheDocument();
  });

  it('keeps Approve and Reject on every item and leaves ordinary Returns unmarked', async () => {
    renderList();
    await screen.findByText('Ruth Amaa');
    expect(screen.getAllByRole('button', { name: 'Approve' })).toHaveLength(2);
    expect(screen.getAllByRole('button', { name: 'Reject' })).toHaveLength(2);
    expect(screen.queryByText(/Musa Sekalaala's correction/)).toBeNull();
    expect(screen.getAllByText('Correction')).toHaveLength(1);
  });
});
