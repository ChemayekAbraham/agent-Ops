/**
 * Data seam for the Automated Call Centre Command Center.
 *
 * Every Command Center component reads from this file and nothing else. All
 * reads and writes are SECURITY DEFINER RPCs gated on crm / cto / super_admin
 * (voice_autocall_assert); the browser never writes call state. Recordings are
 * played from the private `voice-recordings` bucket through short-lived signed
 * URLs, which storage RLS also limits to those three roles.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/hooks/useAuth';
import {
  AUTOCALL_ROLES,
  type AutocallAudienceKind,
  type AutocallCategory,
  type AutocallJobStatus,
  type ScriptSteps,
} from '@/lib/voiceAutocall';

// The RPCs are newer than the generated types.
const rpc = supabase.rpc.bind(supabase) as unknown as <T>(fn: string, args?: Record<string, unknown>) => Promise<{ data: T; error: { message: string } | null }>;

async function call<T>(fn: string, args?: Record<string, unknown>): Promise<T> {
  const { data, error } = await rpc<T>(fn, args);
  if (error) throw new Error(error.message);
  return data;
}

const KEY = ['voice-autocall'] as const;
const LIVE_REFRESH_MS = 15_000;

// ───────────── types returned by the RPCs ─────────────

export interface AutocallTodayCounts {
  total: number;
  queued: number;
  live: number;
  completed: number;
  no_answer: number;
  failed: number;
  expired: number;
  opted_out: number;
  talk_seconds: number;
  cost: number;
}

export interface AutocallCategoryState {
  category: AutocallCategory;
  paused: boolean;
  pause_reason: string | null;
  paused_at: string | null;
  paused_by_name: string | null;
  active_campaigns: number;
  people_paused: number;
  today: AutocallTodayCounts;
}

export interface AutocallSystemStatus {
  last_tick_at: string | null;
  last_tick_result: Record<string, unknown> | null;
  balance_amount: number | null;
  balance_currency: string | null;
  balance_checked_at: string | null;
  low_balance: boolean;
  configured: boolean;
  channels: number | null;
  last_error: string | null;
  /** Calling from the app (CRM Call Centre, Tenant Ops) is paused; the line is the robot's. */
  human_calling_paused: boolean;
  human_calling_pause_reason: string | null;
  human_calling_paused_at: string | null;
}

export interface AutocallOverview {
  as_at: string;
  today: string;
  system: AutocallSystemStatus | null;
  categories: AutocallCategoryState[];
}

export interface AutocallScript {
  id: string;
  code: string | null;
  category: AutocallCategory;
  name: string;
  occasion: string;
  description: string | null;
  language: string;
  steps: ScriptSteps;
  version: number;
  is_active: boolean;
  updated_at: string;
  updated_by_name: string | null;
  used_by_campaigns: { id: string; name: string; status: string }[];
}

export interface AutocallScriptVersion {
  version: number;
  name: string;
  occasion: string;
  description: string | null;
  steps: ScriptSteps;
  saved_at: string;
  saved_by_name: string | null;
}

export interface AutocallRunSummary {
  run_date: string;
  built_at: string;
  audience: number;
  skipped_paused: number;
  expires_at: string;
  queued: number;
  live: number;
  completed: number;
  no_answer: number;
  failed: number;
  expired: number;
}

export type AutocallCampaignStatus = 'draft' | 'active' | 'paused' | 'completed' | 'archived';

export interface AutocallCampaign {
  id: string;
  code: string | null;
  category: AutocallCategory;
  name: string;
  description: string | null;
  script_id: string;
  script_name: string;
  script_version: number;
  audience_kind: AutocallAudienceKind;
  schedule_kind: 'daily' | 'once';
  start_at: string | null;
  window_start: string;
  window_end: string;
  days_of_week: number[];
  max_attempts: number;
  retry_minutes: number;
  record_calls: boolean;
  status: AutocallCampaignStatus;
  updated_at: string;
  updated_by_name: string | null;
  last_run: AutocallRunSummary | null;
}

export interface AutocallCampaignInput {
  id?: string | null;
  category: AutocallCategory;
  name: string;
  description?: string | null;
  scriptId: string;
  audienceKind: AutocallAudienceKind;
  scheduleKind: 'daily' | 'once';
  startAt?: string | null;
  windowStart: string; // "08:00"
  windowEnd: string;   // "10:00"
  daysOfWeek: number[]; // 1 = Mon … 6 = Sat (Sunday is refused by the server)
  maxAttempts?: number;
  retryMinutes?: number;
  recordCalls?: boolean;
}

export interface AutocallCallRow {
  id: string;
  category: AutocallCategory;
  campaign_id: string | null;
  campaign_name: string | null;
  script_name: string;
  script_version: number;
  person_id: string | null;
  person_name: string | null;
  phone_masked: string;
  status: AutocallJobStatus;
  outcome: string | null;
  attempts: number;
  max_attempts: number;
  next_attempt_at: string | null;
  last_attempt_at: string | null;
  answered_at: string | null;
  ended_at: string | null;
  duration_seconds: number;
  cost: number;
  currency: string | null;
  hangup_cause: string | null;
  failure_reason: string | null;
  has_recording: boolean;
  is_test: boolean;
  created_at: string;
}

export interface AutocallCallFilters {
  category?: AutocallCategory | null;
  campaignId?: string | null;
  status?: AutocallJobStatus | null;
  outcome?: string | null;
  from?: string | null; // YYYY-MM-DD, Kampala
  to?: string | null;
  search?: string | null;
  limit?: number;
  offset?: number;
}

export interface AutocallCallDetail {
  call: AutocallCallRow & {
    script_id: string;
    script_snapshot: ScriptSteps;
    variables: Record<string, string>;
    expires_at: string;
    recording_path: string | null;
    requested_by_name: string | null;
  };
  responses: {
    attempt: number;
    step: string;
    digits: string | null;
    outcome: string | null;
    recording_path: string | null;
    at: string;
  }[];
  events: { attempt: number; kind: string; step: string | null; payload: Record<string, string>; at: string }[];
}

export interface AutocallPause {
  id: string;
  person_id: string | null;
  person_name: string | null;
  phone_masked: string | null;
  category: AutocallCategory | null; // null = every category
  reason: string;
  source: 'staff' | 'ivr_opt_out';
  paused_until: string | null;
  created_at: string;
  created_by_name: string | null;
  lifted_at: string | null;
  lifted_by_name: string | null;
  active: boolean;
}

// ───────────── access ─────────────

/** UI-side check only, for hiding the menu item. The server enforces it. */
export function useCanUseAutocall(): boolean {
  const { roles } = useAuth();
  return (roles ?? []).some((r) => (AUTOCALL_ROLES as readonly string[]).includes(r));
}

// ───────────── reads ─────────────

export function useAutocallOverview() {
  return useQuery({
    queryKey: [...KEY, 'overview'],
    queryFn: () => call<AutocallOverview>('voice_autocall_overview'),
    refetchInterval: LIVE_REFRESH_MS,
  });
}

export function useAutocallCampaigns(category?: AutocallCategory | null) {
  return useQuery({
    queryKey: [...KEY, 'campaigns', category ?? 'all'],
    queryFn: () => call<AutocallCampaign[]>('voice_autocall_campaigns_list', { p_category: category ?? null }),
    refetchInterval: LIVE_REFRESH_MS,
  });
}

export function useAutocallScripts(category?: AutocallCategory | null, includeInactive = true) {
  return useQuery({
    queryKey: [...KEY, 'scripts', category ?? 'all', includeInactive],
    queryFn: () =>
      call<AutocallScript[]>('voice_autocall_scripts_list', {
        p_category: category ?? null,
        p_include_inactive: includeInactive,
      }),
  });
}

export function useAutocallScriptVersions(scriptId: string | null | undefined) {
  return useQuery({
    queryKey: [...KEY, 'script-versions', scriptId],
    enabled: Boolean(scriptId),
    queryFn: () => call<AutocallScriptVersion[]>('voice_autocall_script_versions', { p_script_id: scriptId }),
  });
}

export function useAutocallCalls(filters: AutocallCallFilters) {
  return useQuery({
    queryKey: [...KEY, 'calls', filters],
    queryFn: () =>
      call<{ total: number; rows: AutocallCallRow[] }>('voice_autocall_calls_feed', {
        p_category: filters.category ?? null,
        p_campaign_id: filters.campaignId ?? null,
        p_status: filters.status ?? null,
        p_outcome: filters.outcome ?? null,
        p_from: filters.from ?? null,
        p_to: filters.to ?? null,
        p_search: filters.search?.trim() || null,
        p_limit: filters.limit ?? 50,
        p_offset: filters.offset ?? 0,
      }),
    refetchInterval: LIVE_REFRESH_MS,
    placeholderData: (prev) => prev,
  });
}

export function useAutocallCallDetail(jobId: string | null | undefined) {
  return useQuery({
    queryKey: [...KEY, 'call', jobId],
    enabled: Boolean(jobId),
    queryFn: () => call<AutocallCallDetail>('voice_autocall_call_detail', { p_job_id: jobId }),
    refetchInterval: (q) => {
      const s = q.state.data?.call.status;
      return s === 'queued' || s === 'dialing' || s === 'in_progress' ? 5_000 : false;
    },
  });
}

export function useAutocallPauses(category?: AutocallCategory | null, includeLifted = false, search?: string) {
  return useQuery({
    queryKey: [...KEY, 'pauses', category ?? 'all', includeLifted, search ?? ''],
    queryFn: () =>
      call<AutocallPause[]>('voice_autocall_pauses_list', {
        p_category: category ?? null,
        p_include_lifted: includeLifted,
        p_search: search?.trim() || null,
      }),
  });
}

/** Signed playback URL for a recording path (valid for 10 minutes). */
export function useAutocallRecordingUrl(path: string | null | undefined) {
  return useQuery({
    queryKey: [...KEY, 'recording', path],
    enabled: Boolean(path),
    staleTime: 8 * 60_000,
    queryFn: async () => {
      const { data, error } = await supabase.storage.from('voice-recordings').createSignedUrl(path!, 600);
      if (error) throw new Error(error.message);
      return data.signedUrl;
    },
  });
}

// ───────────── writes ─────────────

function useAutocallMutation<TVars, TResult = unknown>(fn: (v: TVars) => Promise<TResult>) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: () => qc.invalidateQueries({ queryKey: KEY }),
  });
}

/** Pause or resume one category, or every category when `category` is null. */
export function useSetCategoryPaused() {
  return useAutocallMutation((v: { category: AutocallCategory | null; paused: boolean; reason?: string }) =>
    call<void>('voice_autocall_set_category_paused', {
      p_category: v.category,
      p_paused: v.paused,
      p_reason: v.reason ?? null,
    }),
  );
}

/** Stop automated calls to one person: all categories (category null) or one; optionally until a date. */
export function usePausePerson() {
  return useAutocallMutation(
    (v: { personId: string; category?: AutocallCategory | null; reason: string; until?: string | null }) =>
      call<string>('voice_autocall_pause_person', {
        p_person_id: v.personId,
        p_category: v.category ?? null,
        p_reason: v.reason,
        p_until: v.until ?? null,
        p_phone: null,
      }),
  );
}

export function useLiftPause() {
  return useAutocallMutation((pauseId: string) => call<void>('voice_autocall_lift_pause', { p_pause_id: pauseId }));
}

/** Create (id omitted) or edit a script. Each save becomes a new version. */
export function useSaveScript() {
  return useAutocallMutation(
    (v: { id?: string | null; category: AutocallCategory; name: string; occasion: string; description?: string | null; steps: ScriptSteps }) =>
      call<{ id: string; version: number }>('voice_autocall_script_save', {
        p_id: v.id ?? null,
        p_category: v.category,
        p_name: v.name,
        p_occasion: v.occasion,
        p_description: v.description ?? null,
        p_steps: v.steps,
      }),
  );
}

export function useSetScriptActive() {
  return useAutocallMutation((v: { id: string; active: boolean }) =>
    call<void>('voice_autocall_script_set_active', { p_id: v.id, p_active: v.active }),
  );
}

export function useSaveCampaign() {
  return useAutocallMutation((v: AutocallCampaignInput) =>
    call<string>('voice_autocall_campaign_save', {
      p_id: v.id ?? null,
      p_category: v.category,
      p_name: v.name,
      p_description: v.description ?? null,
      p_script_id: v.scriptId,
      p_audience_kind: v.audienceKind,
      p_schedule_kind: v.scheduleKind,
      p_start_at: v.scheduleKind === 'once' ? v.startAt ?? null : null,
      p_window_start: v.windowStart,
      p_window_end: v.windowEnd,
      p_days_of_week: v.daysOfWeek,
      p_max_attempts: v.maxAttempts ?? 3,
      p_retry_minutes: v.retryMinutes ?? 120,
      p_record_calls: v.recordCalls ?? true,
    }),
  );
}

/** Start / resume ('active'), pause ('paused') or remove ('archived') a campaign. */
export function useSetCampaignStatus() {
  return useAutocallMutation((v: { id: string; status: 'active' | 'paused' | 'archived'; cancelQueued?: boolean }) =>
    call<void>('voice_autocall_campaign_set_status', {
      p_id: v.id,
      p_status: v.status,
      p_cancel_queued: v.cancelQueued ?? false,
    }),
  );
}

export function useAddPeopleToCampaign() {
  return useAutocallMutation((v: { campaignId: string; personIds: string[] }) =>
    call<number>('voice_autocall_add_people', { p_campaign_id: v.campaignId, p_person_ids: v.personIds }),
  );
}

/** Ring a staff phone (yours by default) with a script within the next minute. */
export function useTestCall() {
  return useAutocallMutation((v: { scriptId: string; personId?: string | null }) =>
    call<string>('voice_autocall_test_call', { p_script_id: v.scriptId, p_person_id: v.personId ?? null }),
  );
}

export function useCancelCall() {
  return useAutocallMutation((jobId: string) => call<void>('voice_autocall_cancel_job', { p_job_id: jobId }));
}

/** Pause or resume calling from the app (CRM Call Centre and Tenant Ops) on the shared line. */
export function useSetHumanCallingPaused() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: { paused: boolean; reason?: string }) =>
      call<void>('voice_autocall_set_human_calling_paused', { p_paused: v.paused, p_reason: v.reason ?? null }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: KEY });
      qc.invalidateQueries({ queryKey: ['crm-human-calling-paused'] });
    },
  });
}
