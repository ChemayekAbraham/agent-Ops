import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import type { AwarenessCallResult, AwarenessSubject, AwarenessTeam } from '@/lib/awarenessCallLabels';
import { splitAnswerFilter } from '@/lib/awarenessMonitoringLabels';

/**
 * Readers for the Awareness Calls monitoring page. Every figure is worked out in SQL by the awareness_calls_* reports
 * (Kampala day buckets, people counted once, percentages); this layer only passes the page's filters through and types
 * the answers. Read-only.
 */

export interface AwarenessFilters {
  /** ISO start and end of the chosen dates (the same date picker as Tenant Ops Home). */
  startIso: string;
  endIso: string;
  team: AwarenessTeam | null;
  caller: string | null;
  subjectType: AwarenessSubject | null;
  result: AwarenessCallResult | null;
  /** `${field}:${answer}`, e.g. "aware_30m:heard" (see ANSWER_FILTER_OPTIONS). */
  answer: string | null;
  region: string | null;
  district: string | null;
  /** The Rent Plan's status now. */
  status: string | null;
}

export const EMPTY_AWARENESS_FILTERS = {
  team: null, caller: null, subjectType: null, result: null, answer: null, region: null, district: null, status: null,
} as const;

const anyDb = supabase as any;

/** How the Overview trend is grouped: Kampala days, or Monday-to-Sunday weeks (the first and last clipped to the dates chosen). */
export type AwarenessBucket = 'day' | 'week';
/** The outcome of a stage move on the "Requests without a call" tab: approved, or rejected at that stage. */
export type AwarenessOutcome = 'approved' | 'rejected';

/** Arguments of the report functions that take every filter (summary, by team, by caller, log). */
export function awarenessFilterArgs(f: AwarenessFilters) {
  const answer = splitAnswerFilter(f.answer);
  return {
    p_from: f.startIso,
    p_to: f.endIso,
    p_team: f.team,
    p_caller: f.caller,
    p_subject_type: f.subjectType,
    p_region: f.region,
    p_district: f.district,
    p_result: f.result,
    p_answer_field: answer?.field ?? null,
    p_answer: answer?.answer ?? null,
    p_status: f.status,
  };
}

/** Arguments of awareness_coverage_gaps, which only takes the dates, team, place and status. */
export function awarenessGapArgs(f: AwarenessFilters, outcome: AwarenessOutcome | null = null) {
  return {
    p_from: f.startIso, p_to: f.endIso, p_team: f.team, p_region: f.region, p_district: f.district, p_status: f.status,
    p_outcome: outcome,
  };
}

const filterKey = (f: AwarenessFilters) => [
  f.startIso, f.endIso, f.team, f.caller, f.subjectType, f.result, f.answer, f.region, f.district, f.status,
];
const gapKey = (f: AwarenessFilters) => [f.startIso, f.endIso, f.team, f.region, f.district, f.status];
const ROOT = ['tenantOps', 'awarenessCalls'] as const;

// ─── Result shapes ───────────────────────────────────────────────────────────

export interface AwarenessWindow { start_day: string; end_day: string; days: number; timezone: string }
export interface AnswerCounts { knew: number; heard: number; did_not_know: number }
export interface AnswerPcts extends AnswerCounts { knew_pct: number | null; heard_pct: number | null; did_not_know_pct: number | null }
export interface ExplainedCounts { yes: number; partly: number; no: number }
/** Landlord calls: whether the landlord consents to receive the rent through Welile. */
export interface ConsentCounts { consents: number; unsure: number; refuses: number }
export interface ConsentPcts extends ConsentCounts { consents_pct: number | null; unsure_pct: number | null; refuses_pct: number | null }

export interface AwarenessSummary {
  window: AwarenessWindow;
  basis: string;
  totals: {
    calls: number; answered: number; no_answer: number; phone_off: number; wrong_number: number; answered_pct: number | null;
    people_called: number; people_reached: number; rent_plans_called: number; callers: number;
    /** Answered calls by who was called; landlords are counted when they were asked the consent and payment code questions. */
    answered_tenant_agent?: number; answered_landlord?: number; answered_landlord_old_questions?: number;
  };
  aware_30m: AnswerPcts;
  /** Over answered tenant and agent calls only. */
  aware_merchant_codes: AnswerPcts;
  /** Over answered landlord calls that were asked these questions. */
  landlord_consent?: ConsentPcts;
  aware_payout_otp?: AnswerPcts;
  explained: ExplainedCounts & { yes_pct: number | null; partly_pct: number | null; no_pct: number | null };
  bucket?: AwarenessBucket;
  trend: { day: string; period_end?: string; calls: number; answered: number; people_called: number; people_reached: number; answered_pct: number | null }[];
}

export interface AwarenessTeamRow {
  team: AwarenessTeam; calls: number; answered: number; answered_pct: number | null; people_called: number; people_reached: number;
  rent_plans_called: number; callers: number; aware_30m: AnswerCounts; aware_merchant_codes: AnswerCounts;
  landlord_consent?: ConsentCounts; aware_payout_otp?: AnswerCounts; explained: ExplainedCounts;
}
export interface AwarenessByTeam { window: AwarenessWindow; rows: AwarenessTeamRow[] }

export interface AwarenessCallerRow {
  caller_id: string; caller_name: string; team: AwarenessTeam; calls: number; answered: number; answered_pct: number | null;
  people_called: number; people_reached: number; rent_plans_called: number;
  aware_30m: AnswerCounts; aware_merchant_codes: AnswerCounts; landlord_consent?: ConsentCounts; aware_payout_otp?: AnswerCounts;
  explained: ExplainedCounts; last_call_at: string | null;
}
export interface AwarenessByCaller { window: AwarenessWindow; total_callers: number; rows: AwarenessCallerRow[] }

export interface AwarenessStageRow {
  stage: string; label: string; team: AwarenessTeam; passed: number; with_call: number; without_call: number; covered_pct: number | null;
  rejected?: number;
}
export interface AwarenessGapRow {
  rent_request_id: string; plan_code: string; stage: string; stage_label: string; team: AwarenessTeam; outcome?: AwarenessOutcome;
  passed_at: string; passed_day: string; passed_by: string | null; passed_by_name: string | null; current_status: string;
  tenant_id: string | null; tenant_name: string | null; tenant_phone: string | null;
  landlord_name: string | null; landlord_phone: string | null; agent_id: string | null; agent_name: string | null;
  calls_at_other_stages: number;
}
export interface AwarenessGaps {
  window: AwarenessWindow;
  tracking_started: string | null;
  basis: string;
  totals: { passed: number; with_call: number; without_call: number; covered_pct: number | null; rejected?: number };
  by_stage: AwarenessStageRow[];
  total: number; limit: number; offset: number;
  rows: AwarenessGapRow[];
}

export interface AwarenessLogRow {
  id: string; rent_request_id: string; plan_code: string; subject_type: AwarenessSubject; subject_name: string; subject_phone: string;
  caller_id: string; caller_name: string; caller_team: AwarenessTeam; pipeline_stage: string; current_status: string; region: string | null;
  call_result: AwarenessCallResult; aware_30m: string | null; aware_merchant_codes: string | null;
  landlord_consent?: string | null; aware_payout_otp?: string | null; explained: string | null;
  note: string | null; day: string; dial_started_at: string; recorded_at: string;
}
export interface AwarenessLog { window: AwarenessWindow; total: number; limit: number; offset: number; rows: AwarenessLogRow[] }

export interface AwarenessOptions {
  callers: { id: string; name: string; team: AwarenessTeam; calls: number }[];
  regions: string[];
  districts: { region: string; district: string }[];
  statuses: string[];
}

// ─── Hooks ───────────────────────────────────────────────────────────────────

function useReport<T>(name: string, key: unknown[], run: () => Promise<T>, enabled = true) {
  return useQuery({
    queryKey: [...ROOT, name, ...key],
    queryFn: run,
    enabled,
    staleTime: 60_000,
    retry: false,
    placeholderData: keepPreviousData,
  });
}

async function rpc<T>(fn: string, args: Record<string, unknown>): Promise<T> {
  const { data, error } = await anyDb.rpc(fn, args);
  if (error) throw error;
  return data as T;
}

export const useAwarenessSummary = (f: AwarenessFilters, bucket: AwarenessBucket = 'day') =>
  useReport('summary', [...filterKey(f), bucket],
    () => rpc<AwarenessSummary>('awareness_calls_summary', { ...awarenessFilterArgs(f), p_bucket: bucket }));

export const useAwarenessByTeam = (f: AwarenessFilters) =>
  useReport('by-team', filterKey(f), () => rpc<AwarenessByTeam>('awareness_calls_by_team', awarenessFilterArgs(f)));

export const useAwarenessByCaller = (f: AwarenessFilters, enabled = true) =>
  useReport('by-caller', filterKey(f), () => rpc<AwarenessByCaller>('awareness_calls_by_caller', { ...awarenessFilterArgs(f), p_limit: 200 }), enabled);

export const useAwarenessGaps = (
  f: AwarenessFilters, page: { limit: number; offset: number }, enabled = true, outcome: AwarenessOutcome | null = null,
) =>
  useReport('gaps', [...gapKey(f), page.limit, page.offset, outcome],
    () => rpc<AwarenessGaps>('awareness_coverage_gaps', { ...awarenessGapArgs(f, outcome), p_limit: page.limit, p_offset: page.offset }), enabled);

export const useAwarenessLog = (f: AwarenessFilters, page: { limit: number; offset: number }, enabled = true) =>
  useReport('log', [...filterKey(f), page.limit, page.offset],
    () => rpc<AwarenessLog>('awareness_calls_log', { ...awarenessFilterArgs(f), p_limit: page.limit, p_offset: page.offset }), enabled);

export function useAwarenessOptions() {
  return useQuery({
    queryKey: [...ROOT, 'options'],
    queryFn: () => rpc<AwarenessOptions>('awareness_calls_options', {}),
    staleTime: 5 * 60_000,
    retry: false,
  });
}

/** Page size the log asks for when it is exported (the report's own maximum). */
const EXPORT_PAGE = 200;
/** Safety ceiling for one export: 20,000 calls. */
const EXPORT_MAX_PAGES = 100;

/** Every call matching the filters, read page by page, for the CSV and Excel exports. */
export async function fetchAllAwarenessLog(f: AwarenessFilters): Promise<{ rows: AwarenessLogRow[]; total: number; truncated: boolean }> {
  const rows: AwarenessLogRow[] = [];
  let total = 0;
  for (let page = 0; page < EXPORT_MAX_PAGES; page += 1) {
    const res = await rpc<AwarenessLog>('awareness_calls_log', { ...awarenessFilterArgs(f), p_limit: EXPORT_PAGE, p_offset: page * EXPORT_PAGE });
    total = res.total;
    rows.push(...res.rows);
    if (!res.rows.length || rows.length >= total) break;
  }
  return { rows, total, truncated: rows.length < total };
}
