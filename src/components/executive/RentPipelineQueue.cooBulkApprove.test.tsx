/**
 * The COO bulk-approve bar must say what the landlord float budget actually allows before the
 * operator clicks, and must send only the requests that fit. The cap itself is enforced in the
 * database; this is the clarity layer on top — the button counts, the amount it names, and the ids
 * that reach coo_approve_rent_requests.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';


const { rpcMock, queueRows } = vi.hoisted(() => ({
  rpcMock: vi.fn(),
  queueRows: [] as any[],
}));

/** A chainable postgrest-shaped builder whose awaited result is the fixture rows for rent_requests. */
vi.mock('@/integrations/supabase/client', () => {
  const builder = (table: string): any => {
    const q: any = {
      select: () => q,
      in: () => q,
      or: () => q,
      eq: () => q,
      neq: () => q,
      order: () => q,
      limit: () => q,
      maybeSingle: () => Promise.resolve({ data: null, error: null }),
      single: () => Promise.resolve({ data: null, error: null }),
      upsert: () => Promise.resolve({ error: null }),
      insert: () => q,
      update: () => q,
      delete: () => q,
      then: (onOk: (v: unknown) => unknown, onErr: (e: unknown) => unknown) =>
        Promise.resolve({ data: table === 'rent_requests' ? queueRows : [], error: null }).then(onOk, onErr),
    };
    return q;
  };
  return {
    supabase: {
      from: (table: string) => builder(table),
      rpc: (...args: unknown[]) => rpcMock(...args),
      functions: { invoke: () => Promise.resolve({ data: null, error: null }) },
      auth: { getUser: () => Promise.resolve({ data: { user: null } }) },
    },
  };
});

vi.mock('@/hooks/useAuth', () => ({
  useAuth: () => ({ user: { id: 'coo-1', email: 'coo@welile.com' } }),
}));
vi.mock('@/hooks/use-toast', () => ({ useToast: () => ({ toast: vi.fn() }) }));
vi.mock('sonner', () => ({ toast: vi.fn() }));
vi.mock('@/hooks/useCriticalFlow', () => ({ useCriticalFlow: () => undefined }));
vi.mock('@/hooks/useRentDeskUrlState', () => ({
  useRentDeskUrlState: () => ({
    sort: 'best',
    filters: {},
    setSort: () => {},
    setFilters: () => {},
    clearFilters: () => {},
    isFiltered: false,
    isDefaultSort: true,
  }),
}));
vi.mock('@/hooks/useAboveSuggestionFilter', () => ({
  useAboveSuggestionFilter: () => ({ only: false, setOnly: () => {} }),
}));
vi.mock('@/hooks/useRentDeskOrder', () => ({
  useRentDeskOrder: () => ({ data: undefined, isLoading: false }),
  withRentDeskScores: (rows: any[]) => rows,
  filterByRentDesk: (rows: any[]) => rows,
  orderByRentDesk: (rows: any[]) => rows,
  nextRentDeskSort: (sort: string) => sort,
  RENT_DESK_SORT_LABELS: {},
}));
vi.mock('@/hooks/useAwarenessCallStatus', () => ({
  useAwarenessCallStatus: () => ({ byId: new Map(), loaded: true }),
}));
vi.mock('@/hooks/useRentRequestTiming', () => ({
  useRentRequestTiming: () => ({ byId: new Map(), loaded: true }),
}));
vi.mock('@/hooks/useRentRequestAgentChain', () => ({
  useRentRequestAgentChain: () => ({ byId: new Map(), loaded: true }),
}));

// Desk chrome and per-card panels: each would run its own reads and none is what this test is about.
vi.mock('./RentPipelineTracker', () => ({ RentPipelineTracker: () => null }));
vi.mock('./RentApprovalMoneyCounter', () => ({ RentApprovalMoneyCounter: () => null }));
vi.mock('./TenantOpsReportToolbar', () => ({ TenantOpsReportToolbar: () => null }));
vi.mock('./AgentProximitySelector', () => ({ AgentProximitySelector: () => null }));
vi.mock('./PipelineAgentTransferDialog', () => ({ PipelineAgentTransferDialog: () => null }));
vi.mock('./TenantPaymentHistoryCard', () => ({ TenantPaymentHistoryCard: () => null }));
vi.mock('./RentApprovalConfirmDialog', () => ({ RentApprovalConfirmDialog: () => null }));
vi.mock('./TenantPhotoChecksPanel', () => ({ TenantPhotoChecksPanel: () => null }));
vi.mock('./LandlordFloatMiscAction', () => ({ LandlordFloatMiscAction: () => null }));
vi.mock('@/components/shared/LandlordFloatBudgetPosition', () => ({
  LandlordFloatBudgetPosition: () => null,
  LandlordFloatExcessBanner: () => null,
}));
vi.mock('@/components/ops/UserDrilldownDrawer', () => ({ UserDrilldownDrawer: () => null }));
vi.mock('@/components/landlord/agreement', () => ({ LandlordAgreementHistory: () => null }));
vi.mock('@/components/rent/RenewalReviewPanel', () => ({
  RenewalReviewPanel: () => null,
  RenewalListTags: () => null,
}));
vi.mock('@/components/rent/AboveSuggestionToggle', () => ({ AboveSuggestionToggle: () => null }));
vi.mock('@/components/rent-desk/PaymentLabelChip', () => ({ PaymentLabelChip: () => null }));
vi.mock('@/components/rent-desk/RentDeskControls', () => ({ RentDeskControls: () => null }));
vi.mock('@/components/rent-desk/RentTimingRow', () => ({ RentTimingRow: () => null }));
vi.mock('@/components/rent-desk/RentAgentChain', () => ({ RentAgentChain: () => null }));
vi.mock('@/components/pipeline/AwarenessCallPanel', () => ({ AwarenessCallPanel: () => null }));
vi.mock('@/components/pipeline/AwarenessCallBadge', () => ({ AwarenessCallBadge: () => null }));
vi.mock('@/components/pipeline/MyAwarenessCallsCard', () => ({ MyAwarenessCallsCard: () => null }));

import { RentPipelineQueue } from './RentPipelineQueue';
import { TooltipProvider } from '@/components/ui/tooltip';


const request = (id: string, rentAmount: number, createdAt: string) => ({
  id,
  tenant_id: `tenant-${id}`,
  agent_id: `agent-${id}`,
  landlord_id: `landlord-${id}`,
  lc1_id: null,
  rent_amount: rentAmount,
  duration_days: 30,
  repayment_frequency: 'daily',
  access_fee: 0,
  request_fee: 0,
  total_repayment: rentAmount,
  daily_repayment: Math.round(rentAmount / 30),
  status: 'partner_ops_approved',
  created_at: createdAt,
  updated_at: createdAt,
  pending_window_reset_at: null,
  registration_type: null,
  agent_verified: true,
  house_category: 'standard',
  request_city: 'Kampala',
});

const position = (room: number) => ({
  day: '2026-10-20',
  week_start: '2026-10-19',
  week_end: '2026-10-25',
  blocked: false,
  blocked_reason: null,
  room,
  daily: { amount: 20_000_000, used: 20_000_000 - room, excess: 0 },
  weekly: { amount: 100_000_000, used: 0, excess: 0 },
});

const budgetStatus = (room: number) => ({
  ...position(room),
  today: '2026-10-20',
  can_approve: true,
  pending_misc: [],
});

function renderQueue() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <TooltipProvider>
        <RentPipelineQueue stage="partner_ops_approved" />
      </TooltipProvider>
    </QueryClientProvider>,
  );
}


beforeEach(() => {
  rpcMock.mockReset();
  queueRows.length = 0;
  // Oldest first: 600k, then 500k, then 400k. With UGX 1,000,000 of room the 600k and the 400k fit.
  queueRows.push(
    request('r600', 600_000, '2026-10-19T08:00:00Z'),
    request('r500', 500_000, '2026-10-19T09:00:00Z'),
    request('r400', 400_000, '2026-10-19T10:00:00Z'),
  );
  rpcMock.mockImplementation((fn: string) => {
    if (fn === 'get_landlord_float_budget_status') {
      return Promise.resolve({ data: budgetStatus(1_000_000), error: null });
    }
    if (fn === 'coo_approve_rent_requests') {
      return Promise.resolve({
        data: {
          approved: [
            { id: 'r600', rent_amount: 600_000 },
            { id: 'r400', rent_amount: 400_000 },
          ],
          over_cap: [],
          skipped: [],
          approved_total: 1_000_000,
          room_left: 0,
          status: position(0),
        },
        error: null,
      });
    }
    return Promise.resolve({ data: null, error: null });
  });
});

describe('COO bulk approve under the landlord float budget', () => {
  it('names what fits on the button and sends only those requests', async () => {
    renderQueue();

    const selectAll = (await screen.findAllByRole('checkbox'))[0];
    fireEvent.click(selectAll);

    const approve = await screen.findByRole('button', { name: /Approve 2 that fit/ });
    expect(approve).toHaveTextContent('Approve 2 that fit (UGX 1,000,000)');
    expect(screen.getByText('1 over budget stay at the COO step')).toBeInTheDocument();

    fireEvent.click(approve);

    await waitFor(() =>
      expect(rpcMock).toHaveBeenCalledWith('coo_approve_rent_requests', {
        p_request_ids: ['r600', 'r400'],
        p_comment: null,
      }),
    );
    // The over-budget request was never offered to the server.
    const sent = rpcMock.mock.calls.find(call => call[0] === 'coo_approve_rent_requests')?.[1] as {
      p_request_ids: string[];
    };
    expect(sent.p_request_ids).not.toContain('r500');
  });
});
