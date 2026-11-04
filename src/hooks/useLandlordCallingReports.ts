/**
 * Read-only hooks for the Landlord Calling Center Reports tab.
 *
 * Every figure comes directly from a server-side `SECURITY DEFINER` RPC
 * (`landlord_cc_*`, gated by `_landlord_cc_staff_ok()`):
 *   1. `landlord_cc_daily_summary(p_from, p_to)`
 *   2. `landlord_cc_weekly_report(p_week_start)`
 *   3. `landlord_cc_coverage(p_as_at)`
 *   4. `landlord_cc_staff_performance(p_from, p_to)`
 *   5. `landlord_cc_landlord_call_log(p_from, p_to, p_limit, p_offset)`
 *   6. `landlord_cc_concerns_report(p_from, p_to)`
 *   7. `landlord_cc_round_report(p_cycle_id)`
 *
 * The browser never computes or re-derives any report figure.
 */
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';

export interface LandlordDailySummaryRow {
  kampala_day: string;
  staff_id: string | null;
  staff_name: string;
  total_calls: number;
  engaged_calls: number;
  reached_calls: number;
  unreachable_calls: number;
  callback_calls: number;
  made_calls: number;
  received_calls: number;
}

export interface LandlordWeeklyTotals {
  total_calls: number;
  engaged_calls: number;
  reached_calls: number;
  unreachable_calls: number;
  callback_calls: number;
  made_calls: number;
  received_calls: number;
  forwarded_total: number;
  forwarded_from_made: number;
  forwarded_from_received: number;
  solved_here_total: number;
}

export interface LandlordWeeklyStaffCallRow {
  staff_id: string | null;
  staff_name: string;
  total_calls: number;
  engaged_calls: number;
  reached_calls: number;
  unreachable_calls: number;
  callback_calls: number;
  made_calls: number;
  received_calls: number;
  per_day: number[];
}

export interface LandlordWeeklyForwardedRecipientRow {
  recipient_id: string | null;
  recipient_name: string;
  total_forwarded: number;
  from_made: number;
  from_received: number;
  per_day: number[];
}

export interface LandlordWeeklySolvedStaffRow {
  staff_id: string | null;
  staff_name: string;
  total_solved: number;
  from_made: number;
  from_received: number;
  per_day: number[];
}

export interface LandlordWeeklyPerDayRow {
  kampala_day: string;
  total_calls: number;
  engaged_calls: number;
  reached_calls: number;
  unreachable_calls: number;
  callback_calls: number;
  made_calls: number;
  received_calls: number;
  forwarded_total: number;
  forwarded_from_made: number;
  forwarded_from_received: number;
  solved_here_total: number;
}

export interface LandlordWeeklySourceRow {
  source: string;
  calls: number;
  reached_calls: number;
}

export interface LandlordWeeklyReportData {
  week_start: string;
  week_end: string;
  day_keys: string[];
  totals: LandlordWeeklyTotals;
  staff_calls: LandlordWeeklyStaffCallRow[];
  forwarded_by_recipient: LandlordWeeklyForwardedRecipientRow[];
  solved_here_by_staff: LandlordWeeklySolvedStaffRow[];
  per_day: LandlordWeeklyPerDayRow[];
  by_source: LandlordWeeklySourceRow[];
}

export interface LandlordCoverageRow {
  region: string;
  district: string;
  registry_total: number;
  ever_reached: number;
  reached_this_round: number;
  reached_this_month: number;
  never_called: number;
  called_but_unreached: number;
  needs_review_count: number;
  active_rent_plans_count: number;
}

export interface LandlordStaffPerformanceRow {
  staff_id: string | null;
  staff_name: string;
  total_calls: number;
  engaged_calls: number;
  reached_calls: number;
  unreachable_calls: number;
  callback_calls: number;
  unique_landlords: number;
  reach_rate_pct: number;
  active_hours: number;
  calls_per_active_hour: number;
  followups_owed: number;
  followups_overdue: number;
}

export interface LandlordCallLogRow {
  call_id: string;
  called_at: string;
  kampala_day: string;
  landlord_key: string | null;
  landlord_name: string;
  phone: string;
  phone_masked: boolean;
  caller_id: string | null;
  caller_name: string;
  source: string;
  direction: string;
  outcome: string;
  is_reached: boolean;
  category_code: string;
  category_label: string;
  note: string | null;
  total_count: number;
}

export interface LandlordConcernsTotals {
  total_concerns: number;
  open_concerns: number;
  completed_concerns: number;
  overdue_concerns: number;
  avg_resolution_hours: number | null;
}

export interface LandlordConcernsByCategoryRow {
  category_code: string;
  category_label: string;
  total_count: number;
  open_count: number;
  completed_count: number;
  overdue_count: number;
  avg_age_hours: number | null;
}

export interface LandlordConcernsByTeamRow {
  team_name: string;
  recipient_name: string;
  total_count: number;
  open_count: number;
  completed_count: number;
  overdue_count: number;
  avg_age_hours: number | null;
}

export interface LandlordConcernsByAgeBucketRow {
  bucket_key: string;
  bucket_label: string;
  total_count: number;
  open_count: number;
  overdue_count: number;
}

export interface LandlordConcernItemRow {
  concern_id: string;
  source_kind: string;
  title: string;
  context: string | null;
  priority: string;
  status: string;
  landlord_name: string;
  forwarded_by_name: string;
  recipient_name: string;
  team_name: string;
  category_code: string;
  category_label: string;
  created_at: string;
  due_at: string | null;
  completed_at: string | null;
  outcome: string | null;
  age_hours: number;
  is_overdue: boolean;
}

export interface LandlordConcernsReportData {
  totals: LandlordConcernsTotals;
  by_category: LandlordConcernsByCategoryRow[];
  by_team: LandlordConcernsByTeamRow[];
  by_age_bucket: LandlordConcernsByAgeBucketRow[];
  rows: LandlordConcernItemRow[];
}

export interface LandlordRoundCycleMeta {
  id: string;
  cycle_no: number;
  title: string;
  description: string | null;
  opened_at: string;
  opened_by: string | null;
  opened_by_name: string;
  closed_at: string | null;
  abandoned_reason: string | null;
  retry_after_days: number | null;
  attempt_cap: number | null;
}

export interface LandlordRoundTotals {
  total_rows: number;
  reached_count: number;
  engaged_count: number;
  callback_count: number;
  parked_count: number;
  outstanding_count: number;
  to_call_count: number;
  unreachable_count: number;
  closed_count: number;
  total_attempts: number;
}

export interface LandlordRoundCallerRow {
  caller_id: string | null;
  caller_name: string;
  attempts_count: number;
  engaged_count: number;
  callback_count: number;
  unreached_count: number;
}

export interface LandlordRoundReportData {
  cycle: LandlordRoundCycleMeta | null;
  totals: LandlordRoundTotals;
  by_state: Array<{ state: string; row_count: number }>;
  by_caller: LandlordRoundCallerRow[];
  by_park_reason: Array<{ park_reason: string; row_count: number }>;
}

/**
 * Returns the Wednesday (yyyy-MM-dd) starting the Wednesday-Tuesday week
 * containing the given yyyy-MM-dd date string.
 */
export function getWednesdayWeekStart(ymd: string): string {
  const [y, m, d] = ymd.split('-').map(Number);
  const dt = new Date(Date.UTC(y, (m || 1) - 1, d || 1));
  const dow = dt.getUTCDay(); // 0=Sun..3=Wed..6=Sat
  const offset = (dow - 3 + 7) % 7;
  dt.setUTCDate(dt.getUTCDate() - offset);
  return dt.toISOString().slice(0, 10);
}

/**
 * Shifts a yyyy-MM-dd date string by `days` calendar days.
 */
export function shiftYmdDays(ymd: string, days: number): string {
  const [y, m, d] = ymd.split('-').map(Number);
  const dt = new Date(Date.UTC(y, (m || 1) - 1, d || 1));
  dt.setUTCDate(dt.getUTCDate() + days);
  return dt.toISOString().slice(0, 10);
}

export function useLandlordDailySummary(from: string, to: string, enabled = true) {
  return useQuery({
    queryKey: ['landlord-cc-report', 'daily-summary', from, to],
    enabled: enabled && Boolean(from && to),
    staleTime: 30_000,
    queryFn: async (): Promise<LandlordDailySummaryRow[]> => {
      const { data, error } = await (supabase.rpc as any)('landlord_cc_daily_summary', {
        p_from: from,
        p_to: to,
      });
      if (error) throw error;
      return ((data ?? []) as any[]).map((r) => ({
        kampala_day: String(r.kampala_day),
        staff_id: r.staff_id ?? null,
        staff_name: String(r.staff_name ?? 'Call centre officer'),
        total_calls: Number(r.total_calls ?? 0),
        engaged_calls: Number(r.engaged_calls ?? 0),
        reached_calls: Number(r.reached_calls ?? 0),
        unreachable_calls: Number(r.unreachable_calls ?? 0),
        callback_calls: Number(r.callback_calls ?? 0),
        made_calls: Number(r.made_calls ?? 0),
        received_calls: Number(r.received_calls ?? 0),
      }));
    },
  });
}

export function useLandlordWeeklyReport(weekStart: string, enabled = true) {
  return useQuery({
    queryKey: ['landlord-cc-report', 'weekly-report', weekStart],
    enabled: enabled && Boolean(weekStart),
    staleTime: 30_000,
    queryFn: async (): Promise<LandlordWeeklyReportData> => {
      const { data, error } = await (supabase.rpc as any)('landlord_cc_weekly_report', {
        p_week_start: weekStart,
      });
      if (error) throw error;
      const raw = (data ?? {}) as any;
      return {
        week_start: String(raw.week_start ?? weekStart),
        week_end: String(raw.week_end ?? shiftYmdDays(weekStart, 6)),
        day_keys: Array.isArray(raw.day_keys) ? raw.day_keys.map(String) : [],
        totals: {
          total_calls: Number(raw.totals?.total_calls ?? 0),
          engaged_calls: Number(raw.totals?.engaged_calls ?? 0),
          reached_calls: Number(raw.totals?.reached_calls ?? 0),
          unreachable_calls: Number(raw.totals?.unreachable_calls ?? 0),
          callback_calls: Number(raw.totals?.callback_calls ?? 0),
          made_calls: Number(raw.totals?.made_calls ?? 0),
          received_calls: Number(raw.totals?.received_calls ?? 0),
          forwarded_total: Number(raw.totals?.forwarded_total ?? 0),
          forwarded_from_made: Number(raw.totals?.forwarded_from_made ?? 0),
          forwarded_from_received: Number(raw.totals?.forwarded_from_received ?? 0),
          solved_here_total: Number(raw.totals?.solved_here_total ?? 0),
        },
        staff_calls: Array.isArray(raw.staff_calls) ? raw.staff_calls : [],
        forwarded_by_recipient: Array.isArray(raw.forwarded_by_recipient)
          ? raw.forwarded_by_recipient
          : [],
        solved_here_by_staff: Array.isArray(raw.solved_here_by_staff)
          ? raw.solved_here_by_staff
          : [],
        per_day: Array.isArray(raw.per_day) ? raw.per_day : [],
        by_source: Array.isArray(raw.by_source) ? raw.by_source : [],
      };
    },
  });
}

export function useLandlordCoverage(asAtIso?: string, enabled = true) {
  return useQuery({
    queryKey: ['landlord-cc-report', 'coverage', asAtIso ?? 'now'],
    enabled,
    staleTime: 45_000,
    queryFn: async (): Promise<LandlordCoverageRow[]> => {
      const { data, error } = await (supabase.rpc as any)('landlord_cc_coverage', {
        p_as_at: asAtIso ?? new Date().toISOString(),
      });
      if (error) throw error;
      return ((data ?? []) as any[]).map((r) => ({
        region: String(r.region ?? 'Unspecified'),
        district: String(r.district ?? 'Unspecified'),
        registry_total: Number(r.registry_total ?? 0),
        ever_reached: Number(r.ever_reached ?? 0),
        reached_this_round: Number(r.reached_this_round ?? 0),
        reached_this_month: Number(r.reached_this_month ?? 0),
        never_called: Number(r.never_called ?? 0),
        called_but_unreached: Number(r.called_but_unreached ?? 0),
        needs_review_count: Number(r.needs_review_count ?? 0),
        active_rent_plans_count: Number(r.active_rent_plans_count ?? 0),
      }));
    },
  });
}

export function useLandlordStaffPerformance(from: string, to: string, enabled = true) {
  return useQuery({
    queryKey: ['landlord-cc-report', 'staff-performance', from, to],
    enabled: enabled && Boolean(from && to),
    staleTime: 30_000,
    queryFn: async (): Promise<LandlordStaffPerformanceRow[]> => {
      const { data, error } = await (supabase.rpc as any)('landlord_cc_staff_performance', {
        p_from: from,
        p_to: to,
      });
      if (error) throw error;
      return ((data ?? []) as any[]).map((r) => ({
        staff_id: r.staff_id ?? null,
        staff_name: String(r.staff_name ?? 'Call centre officer'),
        total_calls: Number(r.total_calls ?? 0),
        engaged_calls: Number(r.engaged_calls ?? 0),
        reached_calls: Number(r.reached_calls ?? 0),
        unreachable_calls: Number(r.unreachable_calls ?? 0),
        callback_calls: Number(r.callback_calls ?? 0),
        unique_landlords: Number(r.unique_landlords ?? 0),
        reach_rate_pct: Number(r.reach_rate_pct ?? 0),
        active_hours: Number(r.active_hours ?? 0),
        calls_per_active_hour: Number(r.calls_per_active_hour ?? 0),
        followups_owed: Number(r.followups_owed ?? 0),
        followups_overdue: Number(r.followups_overdue ?? 0),
      }));
    },
  });
}

export function useLandlordCallLog(
  from: string,
  to: string,
  limit = 50,
  offset = 0,
  enabled = true,
) {
  return useQuery({
    queryKey: ['landlord-cc-report', 'call-log', from, to, limit, offset],
    enabled: enabled && Boolean(from && to),
    staleTime: 20_000,
    queryFn: async (): Promise<{ rows: LandlordCallLogRow[]; totalCount: number }> => {
      const { data, error } = await (supabase.rpc as any)('landlord_cc_landlord_call_log', {
        p_from: from,
        p_to: to,
        p_limit: limit,
        p_offset: offset,
      });
      if (error) throw error;
      const rows: LandlordCallLogRow[] = ((data ?? []) as any[]).map((r) => ({
        call_id: String(r.call_id),
        called_at: String(r.called_at),
        kampala_day: String(r.kampala_day),
        landlord_key: r.landlord_key ?? null,
        landlord_name: String(r.landlord_name ?? 'Unnamed Landlord'),
        phone: String(r.phone ?? '—'),
        phone_masked: Boolean(r.phone_masked),
        caller_id: r.caller_id ?? null,
        caller_name: String(r.caller_name ?? 'Call centre officer'),
        source: String(r.source ?? 'calling_center'),
        direction: String(r.direction ?? 'made'),
        outcome: String(r.outcome ?? 'called'),
        is_reached: Boolean(r.is_reached),
        category_code: String(r.category_code ?? 'general'),
        category_label: String(r.category_label ?? 'Call recorded'),
        note: r.note ?? null,
        total_count: Number(r.total_count ?? 0),
      }));
      return {
        rows,
        totalCount: rows.length > 0 ? rows[0].total_count : 0,
      };
    },
  });
}

/**
 * Paged fetcher that retrieves all pages of `landlord_cc_landlord_call_log`
 * without any silent 1,000 or 5,000 row truncation cap.
 */
export async function fetchAllLandlordCallLogPages(
  from: string,
  to: string,
  pageSize = 500,
): Promise<LandlordCallLogRow[]> {
  const all: LandlordCallLogRow[] = [];
  let offset = 0;
  let expectedTotal: number | null = null;

  while (true) {
    const { data, error } = await (supabase.rpc as any)('landlord_cc_landlord_call_log', {
      p_from: from,
      p_to: to,
      p_limit: pageSize,
      p_offset: offset,
    });
    if (error) throw error;
    const batch: LandlordCallLogRow[] = ((data ?? []) as any[]).map((r) => ({
      call_id: String(r.call_id),
      called_at: String(r.called_at),
      kampala_day: String(r.kampala_day),
      landlord_key: r.landlord_key ?? null,
      landlord_name: String(r.landlord_name ?? 'Unnamed Landlord'),
      phone: String(r.phone ?? '—'),
      phone_masked: Boolean(r.phone_masked),
      caller_id: r.caller_id ?? null,
      caller_name: String(r.caller_name ?? 'Call centre officer'),
      source: String(r.source ?? 'calling_center'),
      direction: String(r.direction ?? 'made'),
      outcome: String(r.outcome ?? 'called'),
      is_reached: Boolean(r.is_reached),
      category_code: String(r.category_code ?? 'general'),
      category_label: String(r.category_label ?? 'Call recorded'),
      note: r.note ?? null,
      total_count: Number(r.total_count ?? 0),
    }));

    if (batch.length === 0) break;
    if (expectedTotal === null) expectedTotal = batch[0].total_count;
    all.push(...batch);
    offset += batch.length;
    if (batch.length < pageSize || (expectedTotal !== null && all.length >= expectedTotal)) {
      break;
    }
  }

  return all;
}

export function useLandlordConcernsReport(from: string, to: string, enabled = true) {
  return useQuery({
    queryKey: ['landlord-cc-report', 'concerns-report', from, to],
    enabled: enabled && Boolean(from && to),
    staleTime: 30_000,
    queryFn: async (): Promise<LandlordConcernsReportData> => {
      const { data, error } = await (supabase.rpc as any)('landlord_cc_concerns_report', {
        p_from: from,
        p_to: to,
      });
      if (error) throw error;
      const raw = (data ?? {}) as any;
      return {
        totals: {
          total_concerns: Number(raw.totals?.total_concerns ?? 0),
          open_concerns: Number(raw.totals?.open_concerns ?? 0),
          completed_concerns: Number(raw.totals?.completed_concerns ?? 0),
          overdue_concerns: Number(raw.totals?.overdue_concerns ?? 0),
          avg_resolution_hours:
            raw.totals?.avg_resolution_hours != null
              ? Number(raw.totals.avg_resolution_hours)
              : null,
        },
        by_category: Array.isArray(raw.by_category) ? raw.by_category : [],
        by_team: Array.isArray(raw.by_team) ? raw.by_team : [],
        by_age_bucket: Array.isArray(raw.by_age_bucket) ? raw.by_age_bucket : [],
        rows: Array.isArray(raw.rows) ? raw.rows : [],
      };
    },
  });
}

export function useLandlordRoundReport(cycleId: string | null, enabled = true) {
  return useQuery({
    queryKey: ['landlord-cc-report', 'round-report', cycleId ?? 'latest'],
    enabled,
    staleTime: 30_000,
    queryFn: async (): Promise<LandlordRoundReportData> => {
      const { data, error } = await (supabase.rpc as any)('landlord_cc_round_report', {
        p_cycle_id: cycleId,
      });
      if (error) throw error;
      const raw = (data ?? {}) as any;
      return {
        cycle: raw.cycle ?? null,
        totals: {
          total_rows: Number(raw.totals?.total_rows ?? 0),
          reached_count: Number(raw.totals?.reached_count ?? 0),
          engaged_count: Number(raw.totals?.engaged_count ?? 0),
          callback_count: Number(raw.totals?.callback_count ?? 0),
          parked_count: Number(raw.totals?.parked_count ?? 0),
          outstanding_count: Number(raw.totals?.outstanding_count ?? 0),
          to_call_count: Number(raw.totals?.to_call_count ?? 0),
          unreachable_count: Number(raw.totals?.unreachable_count ?? 0),
          closed_count: Number(raw.totals?.closed_count ?? 0),
          total_attempts: Number(raw.totals?.total_attempts ?? 0),
        },
        by_state: Array.isArray(raw.by_state) ? raw.by_state : [],
        by_caller: Array.isArray(raw.by_caller) ? raw.by_caller : [],
        by_park_reason: Array.isArray(raw.by_park_reason) ? raw.by_park_reason : [],
      };
    },
  });
}
