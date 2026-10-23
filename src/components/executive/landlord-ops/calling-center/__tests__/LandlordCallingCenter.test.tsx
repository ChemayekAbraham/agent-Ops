import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, act, renderHook } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

// Spies for shared hooks
const useCcCallingHubSpy = vi.fn();
const callStartSpy = vi.fn();
const callEndSpy = vi.fn();
const callResetSpy = vi.fn();
const revealMutateAsyncSpy = vi.fn();
const recordQuickMutateSpy = vi.fn();
const pausedState = { paused: false, paused_at: null as string | null };

let mockRegistryEntry: any = {
  landlord_key: 'user:11111111-1111-1111-1111-111111111111',
  landlord_id: '22222222-2222-2222-2222-222222222222',
  user_id: '11111111-1111-1111-1111-111111111111',
  full_name: 'Hajji Musa Mukasa',
  phones: ['256772123456'],
  region: 'Central',
  district: 'Kampala',
  registering_agent_id: null,
  registering_agent_name: 'Agent Sarah',
  houses_count: 3,
  active_rent_plans: 2,
  total_paid_out_ugx: 1500000,
  last_payout_at: '2026-10-01T10:00:00Z',
  registered_at: '2026-01-15T09:00:00Z',
  verification_status: 'verified',
  last_called_at: '2026-10-10T12:00:00Z',
  last_call_outcome: 'reached_ok',
  last_caller_name: 'Caller Jane',
  needs_review: false,
  plan_rent_total: 1200000,
};

const stableVoiceCall = {
  state: 'idle',
  callId: null,
  muted: false,
  elapsed: 0,
  error: null,
  hangupCause: null,
  start: callStartSpy,
  end: callEndSpy,
  reset: callResetSpy,
  toggleMute: vi.fn(),
};

vi.mock('@/integrations/supabase/client', () => ({
  supabase: {
    from: vi.fn(() => ({
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      in: vi.fn().mockReturnThis(),
      or: vi.fn().mockReturnThis(),
      gte: vi.fn().mockReturnThis(),
      order: vi.fn().mockReturnThis(),
      limit: vi.fn().mockReturnThis(),
      maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
    })),
    rpc: vi.fn().mockResolvedValue({ data: [], error: null }),
    auth: {
      getSession: vi.fn().mockResolvedValue({ data: { session: null }, error: null }),
      getUser: vi.fn().mockResolvedValue({ data: { user: { id: 'staff-1' } }, error: null }),
      onAuthStateChange: vi.fn(() => ({ data: { subscription: { unsubscribe: vi.fn() } } })),
    },
  },
}));

const stableAuth = {
  user: { id: 'staff-1', email: 'ops@welile.com' },
  roles: ['landlord_ops', 'operations'],
};

vi.mock('@/hooks/useAuth', () => ({
  useAuth: () => stableAuth,
}));

vi.mock('@/hooks/useCrmVoiceCall', () => ({
  isTerminalCallState: (s: string) =>
    ['completed', 'cancelled', 'rejected', 'busy', 'no_answer', 'failed'].includes(s),
  useCrmVoiceCall: () => stableVoiceCall,
  useHumanCallingPaused: () => ({
    data: {
      paused: pausedState.paused,
      paused_at: pausedState.paused_at,
    },
    isLoading: false,
  }),
}));

const hubCache: Record<string, any> = {};

function buildMockHub(subjectType: string) {
  if (!hubCache[subjectType]) {
    const countsObj = {
      to_call: 5,
      engaged: 2,
      unreachable: 2,
      parked: 0,
      callback: 1,
    };
    hubCache[subjectType] = {
      subjectType,
      cycle: {
        id: 'cycle-123',
        subject_type: subjectType,
        cycle_number: 1,
        title: `${subjectType} Round 1`,
        status: 'open',
        population_code: `${subjectType}s_all`,
        population_label: 'All',
        total_rows: 10,
        opened_at: '2026-10-01T00:00:00Z',
      },
      progress: {
        id: 'cycle-123',
        cycle_number: 1,
        title: `${subjectType} Round 1`,
        description: null,
        total_rows: 10,
        engaged_rows: 2,
        to_call_rows: 5,
        unreachable_rows: 2,
        callback_rows: 1,
        parked_rows: 0,
        pct_complete: 20,
      },
      counts: countsObj,
      totalCounts: countsObj,
      searchActive: false,
      populations: [{ code: 'landlords_registry_all', label: 'All Registered Landlords' }],
      sortOptions: [
        { key: 'plan_rent_total_desc', label: 'Highest Rent Plan Value', is_default: true, value_format: 'ugx' },
      ],
      filterOptions: [
        { key: 'region', label: 'Region', kind: 'value', choices: [{ value: 'Central', label: 'Central', count: 5 }] },
        { key: 'district', label: 'District', kind: 'value', choices: [{ value: 'Kampala', label: 'Kampala', count: 5 }] },
      ],
      filterOptionsLoading: false,
      filterOptionsError: null,
      activeFilters: {},
      activeFilterCount: 0,
      defaultSortKey: 'plan_rent_total_desc',
      effectiveSortKey: 'plan_rent_total_desc',
      rows: [
        {
          id: 'row-1',
          subject_type: subjectType,
          subject_id: '22222222-2222-2222-2222-222222222222',
          state: 'to_call',
          attempts_made: 0,
          last_attempt_at: null,
          next_retry_at: null,
          callback_due_at: null,
          park_reason: null,
          name: 'Hajji Musa Mukasa',
          linked_agent: 'Agent Sarah',
          district: 'Kampala',
          feedback_category: null,
          severity: null,
          routed_to: null,
          ticket_ref: null,
          ticket_status: null,
          fix_ticket_ref: null,
          booked_by: null,
          metric_value: 1200000,
          metric_date: null,
          metric_text: null,
          metric_label: 'Rent Plan Value',
          metric_format: 'ugx',
        },
      ],
      total: 1,
      pageFrom: 1,
      pageTo: 1,
      pageSize: 50,
      isLoading: false,
      isFetching: false,
      error: null,
      openAttempts: [],
      openCount: 0,
      wipBlocked: false,
      wipLimit: 5,
      categories: [
        { id: 'cat-1', code: 'reached_ok', label: 'Reached — All Good', locked: false, default_owner_role: null },
        { id: 'cat-2', code: 'confirmed_payout_number', label: 'Confirmed Payout Number', locked: false, default_owner_role: null },
      ],
      staffOptions: [],
      followups: [],
      followupsError: null,
      canManageCycles: true,
      outstanding: 8,
      reveal: {
        mutateAsync: revealMutateAsyncSpy,
        isPending: false,
      },
      recordQuick: {
        mutate: recordQuickMutateSpy,
        mutateAsync: vi.fn(),
        isPending: false,
      },
      voidAttempt: { mutate: vi.fn(), isPending: false, isSuccess: false },
      recordEngaged: { mutate: vi.fn(), isPending: false, isSuccess: false },
      recordCallback: { mutate: vi.fn(), isPending: false, isSuccess: false },
      openCycle: { mutate: vi.fn(), isPending: false },
      closeCycle: { mutate: vi.fn(), isPending: false },
      abandonCycle: { mutate: vi.fn(), isPending: false },
      completeFollowup: { mutate: vi.fn(), isPending: false },
      syncQueue: { mutate: vi.fn(), isPending: false },
      refetch: vi.fn(),
    };
  }
  return hubCache[subjectType];
}

vi.mock('@/hooks/useCcCallingHub', async (importOriginal) => {
  const actual = await importOriginal<any>();
  return {
    ...actual,
    useCcCallingHub: (subjectType: string, params: any) => {
      useCcCallingHubSpy(subjectType, params);
      return buildMockHub(subjectType);
    },
  };
});

const emptyArray: any[] = [];
const emptyQueryResult = { data: emptyArray, isLoading: false, isFetching: false, refetch: vi.fn() };
const noopMutation = { mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false };

vi.mock('@/hooks/useCallingConcerns', async (importOriginal) => {
  const actual = await importOriginal<any>();
  return {
    ...actual,
    useReceivedCalls: () => emptyQueryResult,
    useRecordReceivedCall: () => noopMutation,
    useUpdateReceivedCall: () => noopMutation,
    useForwardedConcerns: () => emptyQueryResult,
    useForwardConcern: () => noopMutation,
    useConcernEvents: () => emptyQueryResult,
    useConcernReviewers: () => emptyQueryResult,
    useConcernStaffOptions: () => emptyQueryResult,
    useCallerLookup: () => vi.fn(async () => emptyArray),
  };
});

vi.mock('@/hooks/useCcCallHistory', async (importOriginal) => {
  const actual = await importOriginal<any>();
  return {
    ...actual,
    useCcCallHistory: () => emptyQueryResult,
  };
});

vi.mock('@/hooks/useCcSubjectCallHistory', () => ({
  useCcSubjectCallHistory: () => emptyQueryResult,
}));

vi.mock('../useLandlordRegistryBatch', async (importOriginal) => {
  const actual = await importOriginal<any>();
  return {
    ...actual,
    fetchLandlordRegistryEntry: vi.fn(async () => mockRegistryEntry),
    useLandlordRegistryEntry: () => ({ data: mockRegistryEntry, isLoading: false }),
    useLandlordRegistryBatch: () => ({
      data: mockRegistryEntry
        ? {
            [mockRegistryEntry.landlord_id]: mockRegistryEntry,
            ...(mockRegistryEntry.user_id ? { [mockRegistryEntry.user_id]: mockRegistryEntry } : {}),
          }
        : {},
      isLoading: false,
    }),
    useLandlordSavedQueues: () => emptyQueryResult,
    useSaveLandlordQueue: () => noopMutation,
    useAssignLandlordCallers: () => noopMutation,
  };
});

import { TenantCallingCenter } from '@/components/executive/tenant-ops/calling-center/TenantCallingCenter';
import { LandlordCallingCenter } from '../LandlordCallingCenter';
import { useLandlordCallCenterDialer } from '../useLandlordCallCenterDialer';

function renderWithProviders(ui: React.ReactElement) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>{ui}</MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('LandlordCallingCenter & TenantCallingCenter isolation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sessionStorage.clear();
    pausedState.paused = false;
    pausedState.paused_at = null;
    revealMutateAsyncSpy.mockResolvedValue({
      phone: '0772123456',
      attemptId: 'attempt-999',
    });
    mockRegistryEntry = {
      landlord_key: 'user:11111111-1111-1111-1111-111111111111',
      landlord_id: '22222222-2222-2222-2222-222222222222',
      user_id: '11111111-1111-1111-1111-111111111111',
      full_name: 'Hajji Musa Mukasa',
      phones: ['256772123456'],
      region: 'Central',
      district: 'Kampala',
      registering_agent_id: null,
      registering_agent_name: 'Agent Sarah',
      houses_count: 3,
      active_rent_plans: 2,
      total_paid_out_ugx: 1500000,
      last_payout_at: '2026-10-01T10:00:00Z',
      registered_at: '2026-01-15T09:00:00Z',
      verification_status: 'verified',
      last_called_at: '2026-10-10T12:00:00Z',
      last_call_outcome: 'reached_ok',
      last_caller_name: 'Caller Jane',
      needs_review: false,
      plan_rent_total: 1200000,
    };
  });

  it('1. renders TenantCallingCenter unchanged and calls useCcCallingHub with "tenant"', () => {
    renderWithProviders(<TenantCallingCenter />);
    expect(screen.getByText(/Tenant Calling Center/i)).toBeInTheDocument();
    expect(useCcCallingHubSpy).toHaveBeenCalledWith(
      'tenant',
      expect.any(Object),
    );
  });

  it('2. renders LandlordCallingCenter with all 8 tabs and calls useCcCallingHub with "landlord"', () => {
    renderWithProviders(<LandlordCallingCenter />);
    expect(screen.getByText('Landlord Calling Center')).toBeInTheDocument();
    expect(useCcCallingHubSpy).toHaveBeenCalledWith(
      'landlord',
      expect.any(Object),
    );

    // Verify all 8 required tabs are rendered
    expect(screen.getByRole('tab', { name: /Overview/i })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /Work Queue/i })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /Live Call/i })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /Received Calls/i })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /Issues Review/i })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /History/i })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /Reports/i })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /Settings/i })).toBeInTheDocument();
  });

  it('3. useLandlordCallCenterDialer passes role "landlord" (never "tenant") when user_id exists, and offers handset/WhatsApp only when user_id is null', async () => {
    const hub = buildMockHub('landlord') as any;
    const sampleRow = hub.rows[0];

    const { result } = renderHook(() => useLandlordCallCenterDialer(hub));

    await act(async () => {
      await result.current.dial(sampleRow);
    });

    expect(callStartSpy).toHaveBeenCalledTimes(1);
    const startArg = callStartSpy.mock.calls[0][0];
    expect(startArg.role).toBe('landlord');
    expect(startArg.role).not.toBe('tenant');
    expect(startArg.calleeId).toBe('11111111-1111-1111-1111-111111111111');

    // Now test when the landlord registry row has no user_id (handset / WhatsApp only)
    callStartSpy.mockClear();
    mockRegistryEntry = {
      ...mockRegistryEntry,
      user_id: null,
    };

    const { result: resultNoUser } = renderHook(() => useLandlordCallCenterDialer(hub));
    await act(async () => {
      await resultNoUser.current.dial(sampleRow);
    });

    expect(callStartSpy).not.toHaveBeenCalled();
    expect(resultNoUser.current.current?.handsetOnly).toBe(true);
    expect(resultNoUser.current.current?.userId).toBeNull();
  });

  it('4. paused state (crm_human_calling_paused) hides in-app call buttons and shows CallingPausedNotice', () => {
    pausedState.paused = true;
    pausedState.paused_at = new Date().toISOString();
    renderWithProviders(<LandlordCallingCenter />);

    // CallingPausedNotice is shown
    expect(screen.getAllByText(/Calling from the app is paused/i).length).toBeGreaterThan(0);

    // In-app call buttons ("Start Calling" / "Dial Next Landlord") are hidden
    expect(screen.queryByRole('button', { name: /Start Calling/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Dial Next Landlord/i })).not.toBeInTheDocument();
  });
});
