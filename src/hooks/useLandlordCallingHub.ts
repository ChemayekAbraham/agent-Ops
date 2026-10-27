import { useCallback, useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/hooks/useAuth';
import type {
  AwarenessChoice,
  ExplainedChoice,
  LandlordConsent,
} from '@/lib/awarenessCallLabels';

export type AwarenessAnswer = AwarenessChoice;
export type ExplainedAnswer = ExplainedChoice;

// ─── Types ────────────────────────────────────────────────────────────────────

export type LandlordHubScope = 'live_plans' | 'with_plans' | 'all';
export type LandlordHubTab = 'to_call' | 'call_back' | 'answered' | 'not_answered' | 'all';
export type LandlordHubSort = 'rent_plan_value' | 'last_called' | 'call_back_due' | 'name' | 'newest_registration';
export type LandlordHubVerifiedFilter = 'all' | 'verified' | 'unverified';

export type LandlordHubResult =
  | 'answered'
  | 'no_answer'
  | 'phone_off'
  | 'wrong_number'
  | 'call_back';

export type LandlordHubFeedbackCategory =
  | 'reached_ok'
  | 'confirmed_payout_number'
  | 'wants_more_tenants'
  | 'complaint'
  | 'payout_issue'
  | 'not_landlord'
  | 'wrong_number';

export type LandlordHubSeverity = 'normal' | 'high' | 'critical';

export interface LandlordHubListParams {
  scope?: LandlordHubScope;
  tab?: LandlordHubTab;
  search?: string;
  region?: string;
  district?: string;
  agent?: string;
  verified?: LandlordHubVerifiedFilter;
  sort?: LandlordHubSort;
  limit?: number;
  offset?: number;
}

export interface LandlordHubRow {
  landlord_key: string;
  landlord_id: string | null;
  user_id: string | null;
  landlord_name: string;
  phone: string;
  phone_masked: boolean;
  region: string | null;
  district: string | null;
  agent_id: string | null;
  agent_name: string | null;
  verified: boolean;
  verification_status: string | null;
  houses_count: number;
  live_rent_plans: number;
  rent_plan_value: number;
  last_call_at: string | null;
  last_result: string | null;
  last_caller_id: string | null;
  last_caller_name: string | null;
  call_back_due_at: string | null;
  call_back_overdue: boolean;
  being_called_by_id: string | null;
  being_called_by: string | null;
  being_called_since: string | null;
  hub_status: 'never_called' | 'answered' | 'not_answered' | 'call_back';
  needs_review: boolean;
  total_count: number;
}

export interface LandlordHubStats {
  calls_today: number;
  answered_today: number;
  answered_rate_pct: number;
  call_backs_due: number;
  call_backs_overdue: number;
  live_plan_landlords_total: number;
  live_plan_landlords_never_called: number;
  landlords_reached_this_week: number;
  week_start: string;
  kampala_today: string;
}

export interface LandlordHubHouse {
  id: string;
  title: string;
  address: string | null;
  region: string | null;
  district: string | null;
  village: string | null;
  house_category: string | null;
  number_of_rooms: number | null;
  monthly_rent: number;
  daily_rate: number;
  status: string;
  verified: boolean;
  caretaker_name: string | null;
  created_at: string | null;
}

export interface LandlordHubTenantPlan {
  rent_request_id: string;
  tenant_id: string | null;
  tenant_name: string;
  tenant_phone: string | null;
  status: string;
  rent_amount: number;
  daily_repayment: number;
  total_repayment: number;
  amount_repaid: number;
  outstanding: number;
  agent_id: string | null;
  agent_name: string | null;
  funded_at: string | null;
  created_at: string | null;
}

export interface LandlordHubPayout {
  id: string;
  source: 'landlord_payout' | 'float_allocation';
  amount: number;
  status: string | null;
  paid_at: string | null;
  rent_request_id: string | null;
  reference: string | null;
}

export interface LandlordHubCallHistoryItem {
  call_id: string;
  source: 'calling_hub' | 'awareness' | 'verification';
  called_at: string | null;
  dial_started_at: string | null;
  caller_id: string | null;
  caller_name: string | null;
  caller_team: string | null;
  phone_dialed: string | null;
  result: string;
  call_back_at: string | null;
  aware_30m: AwarenessAnswer | null;
  landlord_consent: LandlordConsent | null;
  aware_payout_otp: AwarenessAnswer | null;
  explained: ExplainedAnswer | null;
  feedback_category: LandlordHubFeedbackCategory | null;
  severity: LandlordHubSeverity | null;
  note: string | null;
  tenants_discussed: string[] | null;
  rent_request_id: string | null;
  is_amended: boolean;
  amended_at: string | null;
  amendment_reason: string | null;
}

export interface LandlordHubDetail {
  landlord_key: string;
  landlord_id: string | null;
  user_id: string | null;
  landlord_name: string;
  phones: string[];
  phone_masked: boolean;
  region: string | null;
  district: string | null;
  village: string | null;
  property_address: string | null;
  verified: boolean;
  verification_status: string | null;
  needs_review: boolean;
  registered_at: string | null;
  houses_count: number;
  live_rent_plans: number;
  rent_plan_value: number;
  registering_agent: {
    agent_id: string;
    full_name: string | null;
    phone: string | null;
  } | null;
  caretaker: {
    name: string | null;
    phone: string | null;
  } | null;
  payout_details: {
    mobile_money_number: string | null;
    mobile_money_name: string | null;
    verified_mobile_money_number: string | null;
    bank_name: string | null;
    bank_branch: string | null;
    account_number: string | null;
    bank_account_name: string | null;
    total_paid_out_ugx: number;
    last_payout_at: string | null;
  };
  houses: LandlordHubHouse[];
  tenants_and_plans: LandlordHubTenantPlan[];
  payouts: LandlordHubPayout[];
  call_history: LandlordHubCallHistoryItem[];
  active_dial: {
    dial_id: string;
    caller_id: string;
    caller_name: string;
    started_at: string;
    expires_at: string;
  } | null;
}

export interface LandlordHubDialResponse {
  dial_id: string;
  landlord_key: string;
  caller_id: string;
  caller_name: string;
  phone: string;
  started_at: string;
  expires_at: string;
  reused: boolean;
}

export interface LandlordHubStartedDial {
  dial_id: string | null;
  landlord_key: string;
  landlord_id?: string | null;
  landlord_name: string;
  phone: string;
  started_at: string;
  expires_at?: string | null;
}

export interface RecordLandlordHubCallInput {
  landlordKey: string;
  phoneDialed: string;
  dialStartedAt: string;
  result: LandlordHubResult;
  dialId?: string | null;
  landlordId?: string | null;
  landlordName?: string | null;
  callBackAt?: string | null;
  aware30m?: AwarenessAnswer | null;
  landlordConsent?: LandlordConsent | null;
  awarePayoutOtp?: AwarenessAnswer | null;
  explained?: ExplainedAnswer | null;
  feedbackCategory?: LandlordHubFeedbackCategory | null;
  severity?: LandlordHubSeverity | null;
  note?: string | null;
  tenantsDiscussed?: string[] | null;
}

export interface AmendLandlordHubCallInput {
  callId: string;
  landlordKey?: string;
  changes: Record<string, unknown>;
  reason: string;
}

// ─── Labels & Constants ───────────────────────────────────────────────────────

export const HUB_RESULT_OPTIONS: {
  value: LandlordHubResult;
  label: string;
  description: string;
}[] = [
  {
    value: 'answered',
    label: 'Answered',
    description: 'Landlord picked up and we spoke',
  },
  {
    value: 'no_answer',
    label: 'No answer',
    description: 'Phone rang out with no pickup',
  },
  {
    value: 'phone_off',
    label: 'Phone off',
    description: 'Switched off, out of network, or unreachable',
  },
  {
    value: 'wrong_number',
    label: 'Wrong number',
    description: 'Person reached is not this landlord or number is invalid',
  },
  {
    value: 'call_back',
    label: 'Call back',
    description: 'Asked to call back at a specific date and time',
  },
];

export const HUB_FEEDBACK_CATEGORIES: {
  value: LandlordHubFeedbackCategory;
  label: string;
}[] = [
  { value: 'reached_ok', label: 'Reached — all good' },
  { value: 'confirmed_payout_number', label: 'Confirmed payout number' },
  { value: 'wants_more_tenants', label: 'Wants more tenants' },
  { value: 'complaint', label: 'Complaint raised' },
  { value: 'payout_issue', label: 'Payout issue' },
  { value: 'not_landlord', label: 'Not the landlord' },
  { value: 'wrong_number', label: 'Wrong number' },
];

export const HUB_SEVERITY_OPTIONS: {
  value: LandlordHubSeverity;
  label: string;
  description: string;
}[] = [
  { value: 'normal', label: 'Normal', description: 'Routine call with no urgent issue' },
  { value: 'high', label: 'High', description: 'Needs follow-up by Landlord Ops' },
  { value: 'critical', label: 'Critical', description: 'Urgent payout or dispute issue' },
];

export const HUB_RESULT_LABELS: Record<string, string> = {
  answered: 'Answered',
  no_answer: 'No answer',
  phone_off: 'Phone off',
  wrong_number: 'Wrong number',
  call_back: 'Call back',
  engaged: 'Engaged',
  unreachable: 'Unreachable',
  busy: 'Busy',
  call_back_later: 'Call back',
  callback_booked: 'Call back',
  reached_ok: 'Reached — all good',
  confirmed_payout_number: 'Confirmed payout number',
  wants_more_tenants: 'Wants more tenants',
  complaint: 'Complaint raised',
  payout_issue: 'Payout issue',
};

export const HUB_CATEGORY_LABELS: Record<string, string> = {
  reached_ok: 'Reached — all good',
  confirmed_payout_number: 'Confirmed payout number',
  wants_more_tenants: 'Wants more tenants',
  complaint: 'Complaint raised',
  payout_issue: 'Payout issue',
  not_landlord: 'Not the landlord',
  wrong_number: 'Wrong number',
};

export const HUB_STATUS_LABELS: Record<string, string> = {
  never_called: 'Never called',
  answered: 'Answered',
  not_answered: 'Not answered',
  call_back: 'Call back',
};

export const HUB_NOTE_MIN_LENGTH = 20;

export function formatHubError(err: unknown): string {
  const raw =
    err instanceof Error
      ? err.message
      : typeof (err as { message?: unknown })?.message === 'string'
        ? (err as { message: string }).message
        : String(err ?? 'Something went wrong');
  // Strip internal prefix codes like "DIAL_IN_PROGRESS: " while keeping the server's clear sentence
  return raw.replace(/^[A-Z0-9_]+:\s*/, '').trim() || 'Could not complete that action.';
}

// ─── Feature Switch: landlord_hub_new (default ON for landlord_ops) ──────────

const HUB_SWITCH_LS_KEY = 'welile:landlord_hub_new';

function parseSwitchValue(val: unknown, fallback = true): boolean {
  if (typeof val === 'boolean') return val;
  if (val === 'false' || val === '0' || val === 0) return false;
  if (val === 'true' || val === '1' || val === 1) return true;
  if (val && typeof val === 'object') {
    const obj = val as Record<string, unknown>;
    if (typeof obj.enabled === 'boolean') return obj.enabled;
    if (typeof obj.landlord_ops === 'boolean') return obj.landlord_ops;
  }
  return fallback;
}

export function readLandlordHubNewLocalOverride(): boolean | null {
  try {
    const raw = localStorage.getItem(HUB_SWITCH_LS_KEY);
    if (raw === 'false' || raw === '0') return false;
    if (raw === 'true' || raw === '1') return true;
    return null;
  } catch {
    return null;
  }
}

export function setLandlordHubNewLocalOverride(enabled: boolean | null) {
  try {
    if (enabled === null) {
      localStorage.removeItem(HUB_SWITCH_LS_KEY);
    } else {
      localStorage.setItem(HUB_SWITCH_LS_KEY, enabled ? 'true' : 'false');
    }
  } catch {
    // ignore storage errors
  }
}

/**
 * Reads the `landlord_hub_new` setting from `system_config` (following the
 * existing app settings pattern in `useRentAccessLimitParams.ts`), defaulting
 * to `true` (on) for `landlord_ops`. Supports an instant local override for
 * emergency fallback or testing.
 */
export function useLandlordHubSwitch() {
  const [localOverride, setLocalOverrideState] = useState<boolean | null>(() =>
    readLandlordHubNewLocalOverride(),
  );

  const query = useQuery({
    queryKey: ['system-config', 'landlord_hub_new'],
    staleTime: 60_000,
    queryFn: async () => {
      try {
        const { data, error } = await supabase
          .from('system_config')
          .select('value')
          .eq('key', 'landlord_hub_new')
          .maybeSingle();
        if (error || !data) return true;
        return parseSwitchValue(data.value, true);
      } catch {
        return true;
      }
    },
  });

  const enabled = localOverride !== null ? localOverride : (query.data ?? true);

  const setEnabled = useCallback((next: boolean | null) => {
    setLandlordHubNewLocalOverride(next);
    setLocalOverrideState(next);
  }, []);

  return {
    enabled,
    isLoading: query.isLoading,
    setEnabled,
    refresh: query.refetch,
  };
}

// ─── Data Hooks ───────────────────────────────────────────────────────────────

export function useLandlordHubStats() {
  return useQuery({
    queryKey: ['landlord-hub-stats'],
    staleTime: 20_000,
    queryFn: async (): Promise<LandlordHubStats> => {
      const { data, error } = await (supabase.rpc as any)('landlord_hub_stats');
      if (error) throw new Error(formatHubError(error));
      const d = (data ?? {}) as Partial<LandlordHubStats>;
      return {
        calls_today: Number(d.calls_today ?? 0),
        answered_today: Number(d.answered_today ?? 0),
        answered_rate_pct: Number(d.answered_rate_pct ?? 0),
        call_backs_due: Number(d.call_backs_due ?? 0),
        call_backs_overdue: Number(d.call_backs_overdue ?? 0),
        live_plan_landlords_total: Number(d.live_plan_landlords_total ?? 0),
        live_plan_landlords_never_called: Number(d.live_plan_landlords_never_called ?? 0),
        landlords_reached_this_week: Number(d.landlords_reached_this_week ?? 0),
        week_start: String(d.week_start ?? ''),
        kampala_today: String(d.kampala_today ?? ''),
      };
    },
  });
}

export function useLandlordHubList(params: LandlordHubListParams) {
  const scope = params.scope ?? 'live_plans';
  const tab = params.tab ?? 'to_call';
  const search = params.search?.trim() || null;
  const region = params.region?.trim() || null;
  const district = params.district?.trim() || null;
  const agent = params.agent?.trim() || null;
  const verified =
    params.verified && params.verified !== 'all' ? params.verified : null;
  const sort = params.sort ?? (tab === 'call_back' ? 'call_back_due' : 'rent_plan_value');
  const limit = Math.min(Math.max(params.limit ?? 50, 1), 50);
  const offset = Math.max(params.offset ?? 0, 0);

  return useQuery({
    queryKey: [
      'landlord-hub-list',
      scope,
      tab,
      search,
      region,
      district,
      agent,
      verified,
      sort,
      limit,
      offset,
    ],
    staleTime: 15_000,
    queryFn: async (): Promise<{ rows: LandlordHubRow[]; totalCount: number }> => {
      const { data, error } = await (supabase.rpc as any)('landlord_hub_list', {
        p_scope: scope,
        p_tab: tab,
        p_search: search,
        p_region: region,
        p_district: district,
        p_agent: agent,
        p_verified: verified,
        p_sort: sort,
        p_limit: limit,
        p_offset: offset,
      });
      if (error) throw new Error(formatHubError(error));
      const list = Array.isArray(data) ? data : [];
      const rows: LandlordHubRow[] = list.map((r: any) => ({
        landlord_key: String(r.landlord_key ?? ''),
        landlord_id: r.landlord_id ?? null,
        user_id: r.user_id ?? null,
        landlord_name: String(r.landlord_name ?? 'Unnamed Landlord'),
        phone: String(r.phone ?? '—'),
        phone_masked: Boolean(r.phone_masked),
        region: r.region ?? null,
        district: r.district ?? null,
        agent_id: r.agent_id ?? null,
        agent_name: r.agent_name ?? null,
        verified: Boolean(r.verified),
        verification_status: r.verification_status ?? null,
        houses_count: Number(r.houses_count ?? 0),
        live_rent_plans: Number(r.live_rent_plans ?? 0),
        rent_plan_value: Number(r.rent_plan_value ?? 0),
        last_call_at: r.last_call_at ?? null,
        last_result: r.last_result ?? null,
        last_caller_id: r.last_caller_id ?? null,
        last_caller_name: r.last_caller_name ?? null,
        call_back_due_at: r.call_back_due_at ?? null,
        call_back_overdue: Boolean(r.call_back_overdue),
        being_called_by_id: r.being_called_by_id ?? null,
        being_called_by: r.being_called_by ?? null,
        being_called_since: r.being_called_since ?? null,
        hub_status: (r.hub_status ?? 'never_called') as LandlordHubRow['hub_status'],
        needs_review: Boolean(r.needs_review),
        total_count: Number(r.total_count ?? 0),
      }));
      const totalCount = rows.length > 0 ? rows[0].total_count : 0;
      return { rows, totalCount };
    },
  });
}

/**
 * Reads server-determined counts for each of the 5 tabs using `landlord_hub_list`
 * with `p_limit: 1` (the browser never computes counts or statuses itself).
 */
export function useLandlordHubTabCounts(
  params: Omit<LandlordHubListParams, 'tab' | 'limit' | 'offset' | 'sort'>,
) {
  const scope = params.scope ?? 'live_plans';
  const search = params.search?.trim() || null;
  const region = params.region?.trim() || null;
  const district = params.district?.trim() || null;
  const agent = params.agent?.trim() || null;
  const verified =
    params.verified && params.verified !== 'all' ? params.verified : null;

  return useQuery({
    queryKey: [
      'landlord-hub-tab-counts',
      scope,
      search,
      region,
      district,
      agent,
      verified,
    ],
    staleTime: 20_000,
    queryFn: async (): Promise<Record<LandlordHubTab, number>> => {
      const tabs: LandlordHubTab[] = [
        'to_call',
        'call_back',
        'answered',
        'not_answered',
        'all',
      ];
      const results = await Promise.all(
        tabs.map(async (t) => {
          const { data, error } = await (supabase.rpc as any)('landlord_hub_list', {
            p_scope: scope,
            p_tab: t,
            p_search: search,
            p_region: region,
            p_district: district,
            p_agent: agent,
            p_verified: verified,
            p_sort: 'rent_plan_value',
            p_limit: 1,
            p_offset: 0,
          });
          if (error) return [t, 0] as const;
          const rows = Array.isArray(data) ? data : [];
          const count = rows.length > 0 ? Number(rows[0].total_count ?? 0) : 0;
          return [t, count] as const;
        }),
      );
      return Object.fromEntries(results) as Record<LandlordHubTab, number>;
    },
  });
}

export function useLandlordHubDetail(landlordKey: string | null | undefined, enabled = true) {
  return useQuery({
    queryKey: ['landlord-hub-detail', landlordKey],
    enabled: Boolean(landlordKey) && enabled,
    staleTime: 15_000,
    queryFn: async (): Promise<LandlordHubDetail> => {
      const { data, error } = await (supabase.rpc as any)('landlord_hub_detail', {
        p_landlord_key: landlordKey,
      });
      if (error) throw new Error(formatHubError(error));
      const d = (data ?? {}) as any;
      return {
        landlord_key: String(d.landlord_key ?? landlordKey ?? ''),
        landlord_id: d.landlord_id ?? null,
        user_id: d.user_id ?? null,
        landlord_name: String(d.landlord_name ?? 'Unnamed Landlord'),
        phones: Array.isArray(d.phones) ? d.phones.map(String) : [],
        phone_masked: Boolean(d.phone_masked),
        region: d.region ?? null,
        district: d.district ?? null,
        village: d.village ?? null,
        property_address: d.property_address ?? null,
        verified: Boolean(d.verified),
        verification_status: d.verification_status ?? null,
        needs_review: Boolean(d.needs_review),
        registered_at: d.registered_at ?? null,
        houses_count: Number(d.houses_count ?? 0),
        live_rent_plans: Number(d.live_rent_plans ?? 0),
        rent_plan_value: Number(d.rent_plan_value ?? 0),
        registering_agent: d.registering_agent ?? null,
        caretaker: d.caretaker ?? null,
        payout_details: {
          mobile_money_number: d.payout_details?.mobile_money_number ?? null,
          mobile_money_name: d.payout_details?.mobile_money_name ?? null,
          verified_mobile_money_number: d.payout_details?.verified_mobile_money_number ?? null,
          bank_name: d.payout_details?.bank_name ?? null,
          bank_branch: d.payout_details?.bank_branch ?? null,
          account_number: d.payout_details?.account_number ?? null,
          bank_account_name: d.payout_details?.bank_account_name ?? null,
          total_paid_out_ugx: Number(d.payout_details?.total_paid_out_ugx ?? 0),
          last_payout_at: d.payout_details?.last_payout_at ?? null,
        },
        houses: Array.isArray(d.houses) ? d.houses : [],
        tenants_and_plans: Array.isArray(d.tenants_and_plans) ? d.tenants_and_plans : [],
        payouts: Array.isArray(d.payouts) ? d.payouts : [],
        call_history: Array.isArray(d.call_history) ? d.call_history : [],
        active_dial: d.active_dial ?? null,
      };
    },
  });
}

// ─── Started Dials ("Calls I started") & Return-from-Call Recovery ───────────

const STARTED_DIALS_LS_KEY = 'welile:landlord_hub_started_dials_v1';

function readLocalStartedDials(): LandlordHubStartedDial[] {
  try {
    const raw = localStorage.getItem(STARTED_DIALS_LS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    // Keep dials started in the last 24 hours
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    return parsed.filter(
      (item: any) =>
        item &&
        typeof item.landlord_key === 'string' &&
        typeof item.started_at === 'string' &&
        new Date(item.started_at).getTime() >= cutoff,
    );
  } catch {
    return [];
  }
}

function writeLocalStartedDials(dials: LandlordHubStartedDial[]) {
  try {
    localStorage.setItem(STARTED_DIALS_LS_KEY, JSON.stringify(dials.slice(0, 30)));
  } catch {
    // ignore storage errors
  }
}

export function rememberStartedDial(dial: LandlordHubStartedDial) {
  const existing = readLocalStartedDials().filter(
    (d) => !(d.landlord_key === dial.landlord_key && d.phone === dial.phone),
  );
  writeLocalStartedDials([dial, ...existing]);
}

export function removeStartedDial(landlordKey: string, dialId?: string | null) {
  const existing = readLocalStartedDials().filter((d) => {
    if (dialId && d.dial_id === dialId) return false;
    if (d.landlord_key === landlordKey) return false;
    return true;
  });
  writeLocalStartedDials(existing);
}

/**
 * Fetches unrecorded dials started by the signed-in officer from `landlord_call_dials`
 * and merges them with any locally remembered dials so "Calls I started" works
 * reliably across reloads and mobile dialer round-trips.
 */
export function useMyStartedDials() {
  const { user } = useAuth();
  const qc = useQueryClient();

  const query = useQuery({
    queryKey: ['landlord-hub-started-dials', user?.id],
    staleTime: 10_000,
    queryFn: async (): Promise<LandlordHubStartedDial[]> => {
      const local = readLocalStartedDials();
      if (!user?.id) return local;
      try {
        const cutoffIso = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
        const { data, error } = await supabase
          .from('landlord_call_dials' as any)
          .select('id, landlord_key, phone, started_at, expires_at, call_id')
          .eq('caller_id', user.id)
          .is('call_id', null)
          .gte('started_at', cutoffIso)
          .order('started_at', { ascending: false })
          .limit(20);

        if (error || !Array.isArray(data)) return local;

        const byKey = new Map<string, LandlordHubStartedDial>();
        for (const l of local) {
          byKey.set(l.landlord_key, l);
        }
        for (const row of data as any[]) {
          const prev = byKey.get(row.landlord_key);
          byKey.set(row.landlord_key, {
            dial_id: row.id,
            landlord_key: row.landlord_key,
            landlord_id: prev?.landlord_id ?? null,
            landlord_name: prev?.landlord_name || 'Landlord',
            phone: row.phone,
            started_at: row.started_at,
            expires_at: row.expires_at,
          });
        }
        return Array.from(byKey.values()).sort(
          (a, b) => new Date(b.started_at).getTime() - new Date(a.started_at).getTime(),
        );
      } catch {
        return local;
      }
    },
  });

  const dismissDial = useCallback(
    (landlordKey: string, dialId?: string | null) => {
      removeStartedDial(landlordKey, dialId);
      qc.invalidateQueries({ queryKey: ['landlord-hub-started-dials'] });
    },
    [qc],
  );

  return {
    dials: query.data ?? [],
    isLoading: query.isLoading,
    refetch: query.refetch,
    dismissDial,
  };
}

/**
 * Reuses the return-from-call idea in `src/hooks/useAwarenessCalls.ts`
 * (`visibilitychange`, `blur`, and `focus`) so when an officer taps Call (`tel:`),
 * goes to the phone dialer, and returns to Welile, the record form opens
 * automatically for that dial.
 */
export function useHubReturnFromCall(
  activeDial: LandlordHubStartedDial | null,
  onReturn: (dial: LandlordHubStartedDial) => void,
) {
  useEffect(() => {
    if (!activeDial) return;
    let leftApp = false;
    const dialSnapshot = activeDial;

    const onVisibility = () => {
      if (document.visibilityState === 'hidden') {
        leftApp = true;
      } else if (document.visibilityState === 'visible' && leftApp) {
        onReturn(dialSnapshot);
      }
    };
    const onBlur = () => {
      leftApp = true;
    };
    const onFocus = () => {
      if (leftApp) {
        onReturn(dialSnapshot);
      }
    };

    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('blur', onBlur);
    window.addEventListener('focus', onFocus);
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('blur', onBlur);
      window.removeEventListener('focus', onFocus);
    };
  }, [activeDial, onReturn]);
}

// ─── Mutations ────────────────────────────────────────────────────────────────

export function useLandlordHubStartDial() {
  const qc = useQueryClient();

  return useMutation({
    mutationFn: async (input: {
      landlordKey: string;
      phone: string;
      landlordName?: string;
      landlordId?: string | null;
    }): Promise<LandlordHubDialResponse> => {
      const { data, error } = await (supabase.rpc as any)('landlord_hub_start_dial', {
        p_landlord_key: input.landlordKey,
        p_phone: input.phone,
      });
      if (error) {
        throw new Error(formatHubError(error));
      }
      const d = (data ?? {}) as LandlordHubDialResponse;
      rememberStartedDial({
        dial_id: d.dial_id ?? null,
        landlord_key: d.landlord_key || input.landlordKey,
        landlord_id: input.landlordId ?? null,
        landlord_name: input.landlordName || 'Landlord',
        phone: d.phone || input.phone,
        started_at: d.started_at || new Date().toISOString(),
        expires_at: d.expires_at ?? null,
      });
      return d;
    },
    onSuccess: (_data, vars) => {
      qc.invalidateQueries({ queryKey: ['landlord-hub-started-dials'] });
      qc.invalidateQueries({ queryKey: ['landlord-hub-detail', vars.landlordKey] });
      qc.invalidateQueries({ queryKey: ['landlord-hub-list'] });
    },
  });
}

export function useLandlordHubRecordCall() {
  const qc = useQueryClient();

  return useMutation({
    mutationFn: async (input: RecordLandlordHubCallInput) => {
      const isAnswered = input.result === 'answered';
      const isCallBack = input.result === 'call_back';

      const { data, error } = await (supabase.rpc as any)('landlord_hub_record_call', {
        p_landlord_key: input.landlordKey,
        p_phone_dialed: input.phoneDialed,
        p_dial_started_at: input.dialStartedAt,
        p_result: input.result,
        p_dial_id: input.dialId ?? null,
        p_landlord_id: input.landlordId ?? null,
        p_landlord_name: input.landlordName ?? null,
        p_call_back_at: isCallBack ? (input.callBackAt ?? null) : null,
        p_aware_30m: isAnswered ? (input.aware30m ?? null) : null,
        p_landlord_consent: isAnswered ? (input.landlordConsent ?? null) : null,
        p_aware_payout_otp: isAnswered ? (input.awarePayoutOtp ?? null) : null,
        p_explained: isAnswered ? (input.explained ?? null) : null,
        p_feedback_category: isAnswered ? (input.feedbackCategory ?? null) : null,
        p_severity: isAnswered ? (input.severity ?? null) : null,
        p_note: input.note?.trim() ? input.note.trim() : null,
        p_tenants_discussed:
          input.tenantsDiscussed && input.tenantsDiscussed.length > 0
            ? input.tenantsDiscussed
            : null,
      });
      if (error) {
        throw new Error(formatHubError(error));
      }
      removeStartedDial(input.landlordKey, input.dialId);
      return data;
    },
    onSuccess: (_data, vars) => {
      qc.invalidateQueries({ queryKey: ['landlord-hub-list'] });
      qc.invalidateQueries({ queryKey: ['landlord-hub-tab-counts'] });
      qc.invalidateQueries({ queryKey: ['landlord-hub-stats'] });
      qc.invalidateQueries({ queryKey: ['landlord-hub-detail', vars.landlordKey] });
      qc.invalidateQueries({ queryKey: ['landlord-hub-started-dials'] });
      qc.invalidateQueries({ queryKey: ['staff-calling-detailed-report'] });
    },
  });
}

export function useLandlordHubAmendCall() {
  const qc = useQueryClient();

  return useMutation({
    mutationFn: async (input: AmendLandlordHubCallInput) => {
      const { data, error } = await (supabase.rpc as any)('landlord_hub_amend_call', {
        p_call_id: input.callId,
        p_changes: input.changes,
        p_reason: input.reason,
      });
      if (error) {
        throw new Error(formatHubError(error));
      }
      return data;
    },
    onSuccess: (_data, vars) => {
      qc.invalidateQueries({ queryKey: ['landlord-hub-list'] });
      qc.invalidateQueries({ queryKey: ['landlord-hub-tab-counts'] });
      qc.invalidateQueries({ queryKey: ['landlord-hub-stats'] });
      if (vars.landlordKey) {
        qc.invalidateQueries({ queryKey: ['landlord-hub-detail', vars.landlordKey] });
      } else {
        qc.invalidateQueries({ queryKey: ['landlord-hub-detail'] });
      }
      qc.invalidateQueries({ queryKey: ['staff-calling-detailed-report'] });
    },
  });
}
