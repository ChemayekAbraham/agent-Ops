import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  QUESTION_30M_ACCESS,
  QUESTION_EXPLAINED,
  QUESTION_LANDLORD_CONSENT,
  QUESTION_PAYOUT_OTP,
} from '@/lib/awarenessCallLabels';
import { setLandlordHubNewLocalOverride } from '@/hooks/useLandlordCallingHub';

// ─── Spies & Mock State ──────────────────────────────────────────────────────

const rpcSpy = vi.fn();
const useCcCallingHubSpy = vi.fn();

const sampleRow1 = {
  landlord_key: 'll-101',
  landlord_id: '11111111-1111-1111-1111-111111111101',
  user_id: null,
  landlord_name: 'Hajji Musa Mukasa',
  phone: '0772123456',
  phone_masked: false,
  region: 'Central',
  district: 'Kampala',
  agent_id: 'aaaa1111-1111-1111-1111-111111111111',
  agent_name: 'Agent Sarah',
  verified: true,
  verification_status: 'verified',
  houses_count: 3,
  live_rent_plans: 2,
  rent_plan_value: 1450000,
  last_call_at: null,
  last_result: null,
  last_caller_id: null,
  last_caller_name: null,
  call_back_due_at: null,
  call_back_overdue: false,
  being_called_by_id: 'bbbb2222-2222-2222-2222-222222222222',
  being_called_by: 'Grace',
  being_called_since: '2026-10-27T09:15:00Z',
  hub_status: 'never_called',
  needs_review: true,
  total_count: 807,
};

const sampleRowCallback = {
  landlord_key: 'll-202',
  landlord_id: '22222222-2222-2222-2222-222222222202',
  user_id: null,
  landlord_name: 'Nalongo Rose',
  phone: '0753987654',
  phone_masked: false,
  region: 'Central',
  district: 'Wakiso',
  agent_id: null,
  agent_name: 'Agent Peter',
  verified: false,
  verification_status: 'pending',
  houses_count: 1,
  live_rent_plans: 1,
  rent_plan_value: 600000,
  last_call_at: '2026-10-26T10:00:00Z',
  last_result: 'call_back',
  last_caller_id: 'other-officer-id',
  last_caller_name: 'Winnie',
  call_back_due_at: '2026-10-27T07:00:00Z',
  call_back_overdue: true,
  being_called_by_id: null,
  being_called_by: null,
  being_called_since: null,
  hub_status: 'call_back',
  needs_review: false,
  total_count: 807,
};

const sampleDetail = {
  landlord_key: 'll-101',
  landlord_id: '11111111-1111-1111-1111-111111111101',
  user_id: null,
  landlord_name: 'Hajji Musa Mukasa',
  phones: ['0772123456', '0701112233'],
  phone_masked: false,
  region: 'Central',
  district: 'Kampala',
  village: 'Ntinda',
  property_address: 'Plot 14 Ntinda Road',
  verified: true,
  verification_status: 'verified',
  needs_review: true,
  registered_at: '2026-01-10T08:00:00Z',
  houses_count: 2,
  live_rent_plans: 2,
  rent_plan_value: 1450000,
  registering_agent: {
    agent_id: 'aaaa1111-1111-1111-1111-111111111111',
    full_name: 'Agent Sarah',
    phone: '0782000111',
  },
  caretaker: {
    name: 'Caretaker John',
    phone: '0779555444',
  },
  payout_details: {
    mobile_money_number: '0772123456',
    mobile_money_name: 'MUSA MUKASA',
    verified_mobile_money_number: '0772123456',
    bank_name: 'Stanbic Bank',
    bank_branch: 'Ntinda',
    account_number: '9030012345678',
    bank_account_name: 'Musa Mukasa',
    total_paid_out_ugx: 2800000,
    last_payout_at: '2026-10-15T12:00:00Z',
  },
  houses: [
    {
      id: 'house-1',
      title: 'Ntinda Double Room Block',
      address: 'Plot 14 Ntinda',
      region: 'Central',
      district: 'Kampala',
      village: 'Ntinda',
      house_category: 'double_room',
      number_of_rooms: 2,
      monthly_rent: 750000,
      daily_rate: 28000,
      status: 'occupied',
      verified: true,
      caretaker_name: 'Caretaker John',
      created_at: '2026-02-01T10:00:00Z',
    },
  ],
  tenants_and_plans: [
    {
      rent_request_id: 'rr-501',
      tenant_id: 'ten-501',
      tenant_name: 'Kato Brian',
      tenant_phone: '0775111222',
      status: 'disbursed',
      rent_amount: 850000,
      daily_repayment: 33000,
      total_repayment: 990000,
      amount_repaid: 450000,
      outstanding: 540000,
      agent_id: 'aaaa1111-1111-1111-1111-111111111111',
      agent_name: 'Agent Sarah',
      funded_at: '2026-10-01T10:00:00Z',
      created_at: '2026-09-29T10:00:00Z',
    },
  ],
  payouts: [
    {
      id: 'pay-1',
      source: 'landlord_payout',
      amount: 850000,
      status: 'completed',
      paid_at: '2026-10-15T12:00:00Z',
      rent_request_id: 'rr-501',
      reference: 'MOMO-88991',
    },
  ],
  call_history: [
    {
      call_id: 'call-901',
      source: 'calling_hub',
      called_at: new Date().toISOString(),
      dial_started_at: new Date().toISOString(),
      caller_id: 'staff-1',
      caller_name: 'Janehephzibar Gimono',
      caller_team: 'landlord_ops',
      phone_dialed: '0772123456',
      result: 'answered',
      call_back_at: null,
      aware_30m: 'knew',
      landlord_consent: 'consents',
      aware_payout_otp: 'knew',
      explained: 'yes',
      feedback_category: 'confirmed_payout_number',
      severity: 'normal',
      note: 'Landlord confirmed 0772123456 is active and tenant Kato Brian is in the house.',
      tenants_discussed: ['rr-501'],
      rent_request_id: null,
      is_amended: false,
      amended_at: null,
      amendment_reason: null,
    },
  ],
  active_dial: null,
};

const sampleStats = {
  calls_today: 18,
  answered_today: 12,
  answered_rate_pct: 66.7,
  call_backs_due: 4,
  call_backs_overdue: 2,
  live_plan_landlords_total: 807,
  live_plan_landlords_never_called: 277,
  landlords_reached_this_week: 64,
  week_start: '2026-10-21',
  kampala_today: '2026-10-27',
};

let startDialError: { message: string } | null = null;
let systemConfigValue: unknown = true;

vi.mock('@/integrations/supabase/client', () => ({
  supabase: {
    from: vi.fn((table: string) => ({
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      is: vi.fn().mockReturnThis(),
      in: vi.fn().mockReturnThis(),
      or: vi.fn().mockReturnThis(),
      gte: vi.fn().mockReturnThis(),
      order: vi.fn().mockReturnThis(),
      limit: vi.fn().mockResolvedValue({ data: [], error: null }),
      maybeSingle: vi.fn().mockImplementation(async () => {
        if (table === 'system_config') {
          return { data: { value: systemConfigValue }, error: null };
        }
        return { data: null, error: null };
      }),
    })),
    rpc: (...args: any[]) => rpcSpy(...args),
    auth: {
      getSession: vi.fn().mockResolvedValue({ data: { session: null }, error: null }),
      getUser: vi.fn().mockResolvedValue({ data: { user: { id: 'staff-1' } }, error: null }),
      onAuthStateChange: vi.fn(() => ({ data: { subscription: { unsubscribe: vi.fn() } } })),
    },
  },
}));

vi.mock('@/hooks/useAuth', () => ({
  useAuth: () => ({
    user: { id: 'staff-1', email: 'jane@welile.com' },
    roles: ['landlord_ops', 'operations'],
  }),
}));

vi.mock('@/hooks/useCrmVoiceCall', () => ({
  isTerminalCallState: (s: string) =>
    ['completed', 'cancelled', 'rejected', 'busy', 'no_answer', 'failed'].includes(s),
  useCrmVoiceCall: () => ({
    state: 'idle',
    callId: null,
    muted: false,
    elapsed: 0,
    error: null,
    hangupCause: null,
    start: vi.fn(),
    end: vi.fn(),
    reset: vi.fn(),
    toggleMute: vi.fn(),
  }),
  useHumanCallingPaused: () => ({
    data: { paused: false, paused_at: null },
    isLoading: false,
  }),
}));

const hubMockCache: Record<string, any> = {};

function getStableMockHub(subjectType: string) {
  if (!hubMockCache[subjectType]) {
    const counts = { to_call: 5, engaged: 2, unreachable: 1, parked: 0, callback: 1 };
    hubMockCache[subjectType] = {
      subjectType,
      cycle: {
        id: 'cycle-1',
        subject_type: subjectType,
        cycle_number: 1,
        title: 'Round 1',
        status: 'open',
        population_code: `${subjectType}s_all`,
        population_label: 'All',
        total_rows: 9,
        opened_at: '2026-10-01T00:00:00Z',
      },
      progress: {
        id: 'cycle-1',
        cycle_number: 1,
        title: 'Round 1',
        description: null,
        total_rows: 9,
        engaged_rows: 2,
        to_call_rows: 5,
        unreachable_rows: 1,
        callback_rows: 1,
        parked_rows: 0,
        pct_complete: 22,
      },
      counts,
      totalCounts: counts,
      searchActive: false,
      populations: [{ code: 'all', label: 'All' }],
      sortOptions: [{ key: 'default', label: 'Default', is_default: true, value_format: 'ugx' }],
      filterOptions: [],
      filterOptionsLoading: false,
      filterOptionsError: null,
      activeFilters: {},
      activeFilterCount: 0,
      defaultSortKey: 'default',
      effectiveSortKey: 'default',
      rows: [],
      total: 0,
      pageFrom: 0,
      pageTo: 0,
      pageSize: 50,
      isLoading: false,
      isFetching: false,
      error: null,
      openAttempts: [],
      openCount: 0,
      wipBlocked: false,
      wipLimit: 5,
      categories: [],
      staffOptions: [],
      followups: [],
      followupsError: null,
      canManageCycles: true,
      outstanding: 7,
      reveal: { mutateAsync: vi.fn(), isPending: false },
      recordQuick: { mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false },
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
  return hubMockCache[subjectType];
}

vi.mock('@/hooks/useCcCallingHub', async (importOriginal) => {
  const actual = await importOriginal<any>();
  return {
    ...actual,
    useCcCallingHub: (subjectType: string, params: any) => {
      useCcCallingHubSpy(subjectType, params);
      return getStableMockHub(subjectType);
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

vi.mock('@/components/executive/landlord-ops/calling-center/useLandlordRegistryBatch', async (importOriginal) => {
  const actual = await importOriginal<any>();
  return {
    ...actual,
    fetchLandlordRegistryEntry: vi.fn(async () => null),
    useLandlordRegistryEntry: () => ({ data: null, isLoading: false }),
    useLandlordRegistryBatch: () => ({ data: {}, isLoading: false }),
    useLandlordSavedQueues: () => emptyQueryResult,
    useSaveLandlordQueue: () => noopMutation,
    useAssignLandlordCallers: () => noopMutation,
  };
});

import { LandlordCallingHub } from '../LandlordCallingHub';
import { LandlordCallingHubRecordDialog } from '../LandlordCallingHubRecordDialog';
import CallingHubRoute from '@/pages/landlord-ops/calling/CallingHub';
import { TenantCallingCenter } from '@/components/executive/tenant-ops/calling-center/TenantCallingCenter';
import { LandlordCallingCenter } from '@/components/executive/landlord-ops/calling-center/LandlordCallingCenter';

function renderWithClient(ui: React.ReactElement) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>{ui}</MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('LandlordCallingHub (Prompt 3 replacement)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    sessionStorage.clear();
    startDialError = null;
    systemConfigValue = true;
    setLandlordHubNewLocalOverride(null);

    rpcSpy.mockImplementation(async (fnName: string, args?: any) => {
      if (fnName === 'landlord_hub_stats') {
        return { data: sampleStats, error: null };
      }
      if (fnName === 'landlord_hub_list') {
        if (args?.p_tab === 'call_back') {
          return { data: [sampleRowCallback], error: null };
        }
        return { data: [sampleRow1, sampleRowCallback], error: null };
      }
      if (fnName === 'landlord_hub_detail') {
        return { data: sampleDetail, error: null };
      }
      if (fnName === 'landlord_hub_start_dial') {
        if (startDialError) {
          return { data: null, error: startDialError };
        }
        return {
          data: {
            dial_id: 'dial-777',
            landlord_key: args?.p_landlord_key || 'll-101',
            caller_id: 'staff-1',
            caller_name: 'Janehephzibar Gimono',
            phone: args?.p_phone || '0772123456',
            started_at: '2026-10-27T10:00:00Z',
            expires_at: '2026-10-27T10:20:00Z',
            reused: false,
          },
          error: null,
        };
      }
      if (fnName === 'landlord_hub_record_call') {
        return {
          data: {
            id: 'call-new-1',
            landlord_key: args?.p_landlord_key,
            result: args?.p_result,
            already_recorded: false,
          },
          error: null,
        };
      }
      if (fnName === 'landlord_hub_amend_call') {
        return {
          data: {
            amendment_id: 'amend-1',
            call_id: args?.p_call_id,
          },
          error: null,
        };
      }
      if (fnName === 'confirm_landlord_payout_number') {
        return { data: { ok: true }, error: null };
      }
      return { data: [], error: null };
    });
  });

  it('1. renders top stats strip, scope switch, tabs with counts, paging line, and landlord rows with badges', async () => {
    renderWithClient(<LandlordCallingHub />);

    expect(await screen.findByText('Hajji Musa Mukasa')).toBeInTheDocument();
    expect(screen.getByTestId('hub-showing-line')).toHaveTextContent(
      'Showing 1 to 50 of 807',
    );

    // Top stats strip
    expect(screen.getByTestId('hub-stat-calls-today')).toHaveTextContent('18');
    expect(screen.getByTestId('hub-stat-answered-rate')).toHaveTextContent('66.7%');
    expect(screen.getByTestId('hub-stat-callbacks-due')).toHaveTextContent('4');
    expect(screen.getByTestId('hub-stat-callbacks-due')).toHaveTextContent('2 overdue');
    expect(screen.getByTestId('hub-stat-never-called')).toHaveTextContent('277');

    // Row badges: "Being called by Grace", "Needs review", overdue call-back badge
    expect(screen.getByTestId('hub-row-being-called-ll-101')).toHaveTextContent(
      'Being called by Grace',
    );
    expect(screen.getByTestId('hub-row-needs-review-ll-101')).toHaveTextContent(
      'Needs review',
    );
    expect(screen.getByTestId('hub-row-callback-badge-ll-202')).toHaveTextContent(
      /Overdue/i,
    );

    // Clicking a stat filters the view
    fireEvent.click(screen.getByTestId('hub-stat-callbacks-due'));
    await waitFor(() => {
      expect(rpcSpy).toHaveBeenCalledWith(
        'landlord_hub_list',
        expect.objectContaining({
          p_tab: 'call_back',
          p_sort: 'call_back_due',
        }),
      );
    });

    // "Take over" button appears on another officer's call back
    expect(await screen.findByTestId('hub-row-takeover-ll-202')).toBeInTheDocument();
  });

  it('2. applies scope, search, region, district, agent, verified filters and sort through landlord_hub_list', async () => {
    renderWithClient(<LandlordCallingHub />);
    await screen.findByText('Hajji Musa Mukasa');

    // Switch scope to With Rent Plans
    fireEvent.click(screen.getByTestId('hub-scope-with_plans'));
    await waitFor(() => {
      expect(rpcSpy).toHaveBeenCalledWith(
        'landlord_hub_list',
        expect.objectContaining({ p_scope: 'with_plans' }),
      );
    });

    // Open filters panel and filter by district + verified
    fireEvent.click(screen.getByTestId('hub-filters-toggle'));
    fireEvent.change(screen.getByTestId('hub-filter-district'), {
      target: { value: 'Wakiso' },
    });
    fireEvent.click(screen.getByTestId('hub-filter-verified-verified'));

    await waitFor(() => {
      expect(rpcSpy).toHaveBeenCalledWith(
        'landlord_hub_list',
        expect.objectContaining({
          p_district: 'Wakiso',
          p_verified: 'verified',
        }),
      );
    });
  });

  it('3. opens the Landlord Card showing payout numbers, caretaker, houses, tenants & Rent Plans, payouts, and call history', async () => {
    renderWithClient(<LandlordCallingHub />);
    const row = await screen.findByTestId('hub-row-ll-101');
    fireEvent.click(row);

    expect(await screen.findByTestId('landlord-hub-card')).toBeInTheDocument();
    expect(await screen.findByText('Caretaker John')).toBeInTheDocument();
    expect(screen.getByText('Ntinda Double Room Block')).toBeInTheDocument();
    expect(screen.getByText('Kato Brian')).toBeInTheDocument();
    expect(screen.getByText(/MOMO-88991/i)).toBeInTheDocument();
    expect(
      screen.getByText(
        /Landlord confirmed 0772123456 is active and tenant Kato Brian is in the house/i,
      ),
    ).toBeInTheDocument();

    // Tap tenant Rent Plan to open its detail modal
    fireEvent.click(screen.getByTestId('hub-tenant-plan-rr-501'));
    expect(await screen.findByTestId('hub-tenant-plan-dialog')).toBeInTheDocument();
    expect(screen.getByText(/Open in Rent Plans Pipeline/i)).toBeInTheDocument();
  });

  it('4. shows colleague name and timestamp when landlord_hub_start_dial is refused', async () => {
    startDialError = {
      message: 'DIAL_IN_PROGRESS: Being called by Grace since 09:15 (active until 09:35)',
    };

    renderWithClient(<LandlordCallingHub />);
    const callBtn = await screen.findByTestId('hub-row-call-ll-101');
    fireEvent.click(callBtn);

    const refusalBanner = await screen.findByTestId('hub-dial-refusal-banner');
    expect(refusalBanner).toHaveTextContent(
      'Being called by Grace since 09:15 (active until 09:35)',
    );
  });

  it('5. opens the record dialog automatically on return from call (blur + focus / visibilitychange)', async () => {
    renderWithClient(<LandlordCallingHub />);
    const callBtn = await screen.findByTestId('hub-row-call-ll-101');
    fireEvent.click(callBtn);

    await waitFor(() => {
      expect(rpcSpy).toHaveBeenCalledWith('landlord_hub_start_dial', {
        p_landlord_key: 'll-101',
        p_phone: '0772123456',
      });
    });

    // Simulate leaving to the phone dialer and returning to the browser
    act(() => {
      window.dispatchEvent(new Event('blur'));
      window.dispatchEvent(new Event('focus'));
    });

    expect(await screen.findByTestId('hub-record-dialog')).toBeInTheDocument();
    expect(screen.getByText(/Record call · Hajji Musa Mukasa/i)).toBeInTheDocument();
  });

  it('6. validates each result path of the stepped record form (answered requires 4 imported awareness questions + category + 20-char note; call_back requires future time)', async () => {
    const onOpenChange = vi.fn();
    renderWithClient(
      <LandlordCallingHubRecordDialog
        open={true}
        onOpenChange={onOpenChange}
        landlordKey="ll-101"
        landlordId="11111111-1111-1111-1111-111111111101"
        landlordName="Hajji Musa Mukasa"
        phone="0772123456"
        dialId="dial-777"
        dialStartedAt="2026-10-27T10:00:00Z"
        tenantPlans={sampleDetail.tenants_and_plans as any}
      />,
    );

    const saveBtn = screen.getByTestId('hub-record-save');
    expect(saveBtn).toBeDisabled();

    // Path A: Unanswered result ('no_answer') is immediately valid
    fireEvent.click(screen.getByTestId('hub-result-no_answer'));
    expect(saveBtn).not.toBeDisabled();

    // Path B: 'call_back' requires a future timestamp
    fireEvent.click(screen.getByTestId('hub-result-call_back'));
    expect(saveBtn).not.toBeDisabled(); // default preset is +1h in the future

    // Set a past date -> Save becomes disabled and warning is shown
    fireEvent.change(screen.getByTestId('hub-callback-input'), {
      target: { value: '2020-01-01T09:00' },
    });
    expect(screen.getByTestId('hub-callback-future-warning')).toBeInTheDocument();
    expect(saveBtn).toBeDisabled();

    // Click quick preset "Tomorrow 9:00" -> Save becomes enabled again
    fireEvent.click(screen.getByTestId('hub-callback-preset-tomorrow'));
    expect(saveBtn).not.toBeDisabled();

    // Path C: 'answered' requires all 4 awareness questions (exact wording from awarenessCallLabels.ts), category, severity, and >=20 char note
    fireEvent.click(screen.getByTestId('hub-result-answered'));
    expect(screen.getByText(new RegExp(QUESTION_30M_ACCESS.slice(0, 30)))).toBeInTheDocument();
    expect(
      screen.getByText(new RegExp(QUESTION_LANDLORD_CONSENT.slice(0, 30))),
    ).toBeInTheDocument();
    expect(screen.getByText(new RegExp(QUESTION_PAYOUT_OTP.slice(0, 30)))).toBeInTheDocument();
    expect(screen.getByText(new RegExp(QUESTION_EXPLAINED.slice(0, 25)))).toBeInTheDocument();
    expect(saveBtn).toBeDisabled();

    // Answer all 4 awareness questions
    fireEvent.click(screen.getByTestId('hub-q-aware30m-knew'));
    fireEvent.click(screen.getByTestId('hub-q-consent-consents'));
    fireEvent.click(screen.getByTestId('hub-q-otp-knew'));
    fireEvent.click(screen.getByTestId('hub-q-explained-yes'));
    expect(saveBtn).toBeDisabled(); // Still missing category and 20-char note

    // Select feedback category
    fireEvent.click(screen.getByTestId('hub-category-confirmed_payout_number'));
    expect(saveBtn).toBeDisabled(); // Note is still empty

    // Enter a short note (< 20 chars)
    fireEvent.change(screen.getByTestId('hub-note-input'), {
      target: { value: 'Too short note' },
    });
    expect(screen.getByTestId('hub-note-counter')).toHaveTextContent('14 / 20 min');
    expect(saveBtn).toBeDisabled();

    // Enter a valid 20+ char note and select tenant discussed
    fireEvent.change(screen.getByTestId('hub-note-input'), {
      target: {
        value: 'Landlord confirmed payout number 0772123456 and tenant Kato Brian.',
      },
    });
    fireEvent.click(screen.getByTestId('hub-tenant-check-rr-501'));
    expect(saveBtn).not.toBeDisabled();

    // Save the answered call
    fireEvent.click(saveBtn);
    await waitFor(() => {
      expect(rpcSpy).toHaveBeenCalledWith(
        'landlord_hub_record_call',
        expect.objectContaining({
          p_landlord_key: 'll-101',
          p_phone_dialed: '0772123456',
          p_result: 'answered',
          p_aware_30m: 'knew',
          p_landlord_consent: 'consents',
          p_aware_payout_otp: 'knew',
          p_explained: 'yes',
          p_feedback_category: 'confirmed_payout_number',
          p_severity: 'normal',
          p_tenants_discussed: ['rr-501'],
        }),
      );
    });
  });

  it('7. switches between the new LandlordCallingHub (default on) and the legacy shared hub via landlord_hub_new', async () => {
    const { unmount } = renderWithClient(<CallingHubRoute />);
    expect(await screen.findByTestId('landlord-calling-hub')).toBeInTheDocument();
    unmount();

    // Flip the switch off -> renders legacy shared CallingHub with subjectType="landlord"
    setLandlordHubNewLocalOverride(false);
    renderWithClient(<CallingHubRoute />);
    expect(useCcCallingHubSpy).toHaveBeenCalledWith('landlord', expect.any(Object));
  });

  it('8. leaves TenantCallingCenter and LandlordCallingCenter completely unchanged', () => {
    const { unmount } = renderWithClient(<TenantCallingCenter />);
    expect(screen.getByText(/Tenant Calling Center/i)).toBeInTheDocument();
    expect(useCcCallingHubSpy).toHaveBeenCalledWith('tenant', expect.any(Object));
    unmount();

    renderWithClient(<LandlordCallingCenter />);
    expect(screen.getByText('Landlord Calling Center')).toBeInTheDocument();
    expect(useCcCallingHubSpy).toHaveBeenCalledWith('landlord', expect.any(Object));
  });
});
