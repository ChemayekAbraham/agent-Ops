/**
 * Shared data layer for the Call Centre hub (tenant / landlord / agent).
 *
 * Rules encoded here:
 *  - The queue is assembled ENTIRELY server-side by cc_call_queue_page. There is
 *    no client-side stitching of names, agents, feedback or tickets, and no
 *    client-side sorting, searching or paging.
 *  - Phone numbers are NEVER selected from a table. A number is only produced by
 *    cc_reveal_phone(attempt_id) after an attempt row exists.
 *  - Every outcome is written by an RPC. The client performs no direct writes to
 *    cc_feedback, cc_cycle_rows or cc_call_attempts (beyond opening an attempt).
 *  - No trigger rule is duplicated client-side. The WIP guard, attempt cap and
 *    locked-category rejection all come back from the database as messages
 *    written to be read by staff; we surface them verbatim.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/hooks/useAuth';

export type CcSubjectType = 'tenant' | 'landlord' | 'agent';
export type CcRowState = 'to_call' | 'engaged' | 'unreachable' | 'callback' | 'parked' | 'closed';
export type CcOutcome = 'engaged' | 'no_answer' | 'phone_off' | 'wrong_number' | 'refused' | 'callback_booked';
export type CcSeverity = 'normal' | 'high' | 'critical';
export type CcMetricFormat = 'ugx' | 'days' | 'date' | 'number' | 'text';

export const QUICK_OUTCOMES: { value: Exclude<CcOutcome, 'engaged' | 'callback_booked'>; label: string }[] = [
  { value: 'no_answer', label: 'No answer' },
  { value: 'phone_off', label: 'Phone off' },
  { value: 'wrong_number', label: 'Wrong number' },
  { value: 'refused', label: 'Refused' },
];

/**
 * The open-attempt limit is never hardcoded on the client. It lives on
 * cc_call_cycles.wip_limit, which the DB guard reads too. Until it loads the
 * client must not block reveals — the DB guard is the authority.
 */

/** Minimum characters the engaged note must carry (mirrors the DB guard). */
export const CC_NOTE_MIN_LENGTH = 20;
export const CC_PAGE_SIZE = 50;

export interface CcRow {
  id: string;
  subject_type: CcSubjectType;
  subject_id: string;
  state: CcRowState;
  attempts_made: number;
  last_attempt_at: string | null;
  next_retry_at: string | null;
  callback_due_at: string | null;
  park_reason: string | null;
  name: string;
  linked_agent: string | null;
  district: string | null;
  feedback_category: string | null;
  severity: CcSeverity | null;
  routed_to: string | null;
  ticket_ref: string | null;
  ticket_status: string | null;
  fix_ticket_ref: string | null;
  booked_by: string | null;
  /** Server-selected sort metric for the active sort key. */
  metric_value: number | null;
  metric_date: string | null;
  metric_text: string | null;
  metric_label: string;
  metric_format: CcMetricFormat;
}

export interface CcOpenAttempt {
  id: string;
  cycle_row_id: string;
  attempt_no: number;
  revealed_at: string;
  subject_type: CcSubjectType;
  name: string;
  /**
   * The attempt's cycle has been closed, so there is no call left to make —
   * only bookkeeping to clear. It still counts against the WIP limit, which is
   * why it must be shown and voidable rather than hidden.
   */
  stale: boolean;
}

export interface CcCategory {
  id: string;
  code: string;
  label: string;
  locked: boolean;
  default_owner_role: string | null;
}

export interface CcSortOption {
  key: string;
  label: string;
  is_default: boolean;
  value_format: CcMetricFormat;
}

export type CcFilterKind = 'bucket' | 'value';

export interface CcFilterChoice {
  value: string;
  label: string;
  /** Only present for 'value' filters, taken from cc_filter_values.row_count. */
  count: number | null;
}

export interface CcFilterOption {
  key: string;
  label: string;
  kind: CcFilterKind;
  choices: CcFilterChoice[];
}

/** filter key -> selected value. An absent/empty key means "no filter". */
export type CcFilterSelection = Record<string, string>;

/**
 * Turn anything thrown by Supabase into text a human can act on.
 *
 * A PostgrestError is a plain object, not an Error, so `String(e)` renders it
 * as "[object Object]" and the real reason ("Record the outcome of your open
 * calls before revealing another number.") never reaches the operator.
 * This never returns "[object Object]" for any input.
 */
export const ccErrorText = (e: unknown): string => {
  if (e == null) return 'Something went wrong.';
  if (typeof e === 'string') return e || 'Something went wrong.';
  if (typeof e !== 'object') return String(e);

  const o = e as { message?: unknown; details?: unknown; hint?: unknown; code?: unknown; error_description?: unknown };
  const parts: string[] = [];
  const message = typeof o.message === 'string' ? o.message.trim() : '';
  const description = typeof o.error_description === 'string' ? o.error_description.trim() : '';
  const head = message || description;
  if (head) parts.push(head);

  const details = typeof o.details === 'string' ? o.details.trim() : '';
  if (details && details !== head) parts.push(details);

  const hint = typeof o.hint === 'string' ? o.hint.trim() : '';
  if (hint && hint !== head) parts.push(hint);

  // A code alone is still more useful than nothing when there is no message.
  if (!head && o.code != null) parts.push(`Error ${String(o.code)}`);

  if (parts.length) return parts.join(' — ');

  if (e instanceof Error) return e.message || e.name || 'Something went wrong.';

  try {
    const json = JSON.stringify(e);
    if (json && json !== '{}') return json;
  } catch {
    /* circular or non-serialisable — fall through */
  }
  return 'Something went wrong.';
};

const err = ccErrorText;


/** cc_* RPCs are newer than the generated types in some environments. */
const rpc = (fn: string, args?: Record<string, unknown>) =>
  (supabase.rpc as unknown as (n: string, a?: Record<string, unknown>) => Promise<{ data: unknown; error: unknown }>)(
    fn,
    args,
  );

/** Strips empty selections so an untouched dropdown never reaches the server. */
const cleanFilters = (f: CcFilterSelection | undefined): CcFilterSelection => {
  const out: CcFilterSelection = {};
  for (const [k, v] of Object.entries(f ?? {})) if (v) out[k] = v;
  return out;
};

export function useCcCallingHub(
  subjectType: CcSubjectType,
  view: {
    state: CcRowState;
    sortKey: string | null;
    search: string;
    page: number;
    filters?: CcFilterSelection;
  },
) {
  const { user, roles } = useAuth();
  const qc = useQueryClient();
  const [outstanding, setOutstanding] = useState<Record<string, unknown>[] | null>(null);

  /** Only non-empty selections are sent; the key set is a stable query key. */
  const activeFilters = useMemo(() => cleanFilters(view.filters), [view.filters]);
  const filtersArg = useMemo(
    () => (Object.keys(activeFilters).length ? activeFilters : null),
    [activeFilters],
  );
  const filtersKey = useMemo(
    () =>
      Object.keys(activeFilters)
        .sort()
        .map((k) => `${k}=${activeFilters[k]}`)
        .join('&'),
    [activeFilters],
  );
  const activeFilterCount = Object.keys(activeFilters).length;


  const canManageCycles = useMemo(
    () => ['operations', 'hr', 'super_admin'].some((r) => (roles || []).includes(r as never)),
    [roles],
  );

  /* ---------------------------------------------------------------- cycle */
  const cycleQ = useQuery({
    queryKey: ['cc-cycle', subjectType],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('cc_call_cycles')
        .select('id, cycle_no, opened_at, attempt_cap, retry_after_days, wip_limit')
        .eq('subject_type', subjectType)
        .is('closed_at', null)
        .order('cycle_no', { ascending: false })
        .limit(1)
        .maybeSingle();
      if (error) throw new Error(err(error));
      return data;
    },
    staleTime: 30_000,
  });
  const cycleId = cycleQ.data?.id ?? null;

  const progressQ = useQuery({
    queryKey: ['cc-cycle-progress', cycleId],
    enabled: !!cycleId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from('v_cc_cycle_progress')
        .select('*')
        .eq('cycle_id', cycleId!)
        .maybeSingle();
      if (error) throw new Error(err(error));
      return data as Record<string, number | string | null> | null;
    },
    staleTime: 15_000,
  });

  const populationsQ = useQuery({
    queryKey: ['cc-populations', subjectType],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('cc_cycle_populations')
        .select('id, code, label, source_view, active')
        .eq('subject_type', subjectType)
        .eq('active', true)
        .order('label');
      if (error) throw new Error(err(error));
      return data ?? [];
    },
    staleTime: 300_000,
  });

  /* ----------------------------------------------------------- sort options */
  const sortOptionsQ = useQuery({
    queryKey: ['cc-sort-options', subjectType],
    queryFn: async (): Promise<CcSortOption[]> => {
      const { data, error } = await supabase
        .from('cc_sort_options')
        .select('key, label, is_default, value_format, sort_order')
        .eq('subject_type', subjectType)
        .eq('active', true)
        .order('sort_order', { ascending: true });
      if (error) throw new Error(err(error));
      return (data ?? []).map((o) => ({
        key: o.key as string,
        label: o.label as string,
        is_default: !!o.is_default,
        value_format: (o.value_format as CcMetricFormat) ?? 'number',
      }));
    },
    staleTime: 300_000,
  });

  const defaultSortKey = useMemo(
    () => sortOptionsQ.data?.find((o) => o.is_default)?.key ?? sortOptionsQ.data?.[0]?.key ?? null,
    [sortOptionsQ.data],
  );
  const effectiveSortKey = view.sortKey ?? defaultSortKey;

  /* --------------------------------------------------------- filter config */
  /**
   * Fully config-driven: the filter keys, labels, buckets and distinct values
   * all come from the database. Nothing about a filter is known client-side.
   */
  const filterOptionsQ = useQuery({
    queryKey: ['cc-filter-options', subjectType],
    queryFn: async (): Promise<CcFilterOption[]> => {
      const { data: defs, error: dErr } = await supabase
        .from('cc_filter_options')
        .select('key, label, kind, sort_order')
        .eq('subject_type', subjectType)
        .eq('active', true)
        .order('sort_order', { ascending: true });
      if (dErr) throw new Error(err(dErr));

      const rows = (defs ?? []) as Record<string, unknown>[];
      const bucketKeys = rows.filter((d) => d.kind === 'bucket').map((d) => String(d.key));

      let buckets: Record<string, unknown>[] = [];
      if (bucketKeys.length) {
        const { data: bData, error: bErr } = await supabase
          .from('cc_filter_buckets')
          .select('filter_key, bucket_key, label, sort_order')
          .eq('subject_type', subjectType)
          .in('filter_key', bucketKeys)
          .order('sort_order', { ascending: true });
        if (bErr) throw new Error(err(bErr));
        buckets = (bData ?? []) as Record<string, unknown>[];
      }

      const out: CcFilterOption[] = [];
      for (const d of rows) {
        const key = String(d.key);
        const kind = (d.kind === 'bucket' ? 'bucket' : 'value') as CcFilterKind;
        let choices: CcFilterChoice[] = [];
        if (kind === 'bucket') {
          choices = buckets
            .filter((b) => String(b.filter_key) === key)
            .map((b) => ({ value: String(b.bucket_key), label: String(b.label), count: null }));
        } else {
          const { data: vData, error: vErr } = await rpc('cc_filter_values', {
            p_subject_type: subjectType,
            p_filter_key: key,
          });
          if (vErr) throw new Error(err(vErr));
          choices = ((vData ?? []) as Record<string, unknown>[])
            .filter((v) => v.value !== null && v.value !== undefined && String(v.value) !== '')
            .map((v) => ({
              value: String(v.value),
              label: String(v.value),
              count: v.row_count === null || v.row_count === undefined ? null : Number(v.row_count),
            }));
        }
        out.push({ key, label: String(d.label), kind, choices });
      }
      return out;
    },
    staleTime: 120_000,
  });

  /* --------------------------------------------------------- queue (server) */
  const queueQ = useQuery({
    queryKey: ['cc-queue', subjectType, view.state, effectiveSortKey, view.search, view.page, filtersKey],
    enabled: !!cycleId,
    queryFn: async (): Promise<{ rows: CcRow[]; total: number }> => {
      const { data, error } = await rpc('cc_call_queue_page', {
        p_subject_type: subjectType,
        p_state: view.state,
        p_sort_key: effectiveSortKey,
        p_search: view.search.trim() || null,
        p_limit: CC_PAGE_SIZE,
        p_offset: view.page * CC_PAGE_SIZE,
        p_filters: filtersArg,
      });
      if (error) throw new Error(err(error));

      const list = (data ?? []) as Record<string, unknown>[];
      const rows: CcRow[] = list.map((r) => ({
        id: String(r.cycle_row_id),
        subject_type: subjectType,
        subject_id: String(r.subject_id),
        state: r.state as CcRowState,
        attempts_made: Number(r.attempts_made ?? 0),
        last_attempt_at: (r.last_attempt_at as string) ?? null,
        next_retry_at: (r.next_retry_at as string) ?? null,
        callback_due_at: (r.callback_due_at as string) ?? null,
        park_reason: (r.park_reason as string) ?? null,
        name: (r.name as string) || 'Unnamed',
        linked_agent: (r.linked_agent_name as string) ?? null,
        district: (r.district as string) ?? null,
        feedback_category: (r.feedback_category as string) ?? null,
        severity: (r.severity as CcSeverity) ?? null,
        routed_to: (r.routed_to_name as string) ?? null,
        ticket_ref: (r.ticket_ref as string) ?? null,
        ticket_status: (r.task_status as string) ?? null,
        fix_ticket_ref: (r.fix_ticket_ref as string) ?? null,
        booked_by: (r.booked_by_name as string) ?? null,
        metric_value: r.metric_value === null || r.metric_value === undefined ? null : Number(r.metric_value),
        metric_date: (r.metric_date as string) ?? null,
        metric_text: (r.metric_text as string) ?? null,
        metric_label: (r.metric_label as string) || 'Metric',
        metric_format: ((r.metric_format as CcMetricFormat) ?? 'number') as CcMetricFormat,
      }));
      const total = list.length ? Number(list[0].total_count ?? 0) : 0;
      return { rows, total };
    },
    staleTime: 15_000,
  });

  /* ---------------------------------------------------------- state counts */
  /**
   * Search-aware on purpose: the queue page only lists the active state, so a
   * name that sits in another state used to return an empty list with no clue
   * where it went. With the search applied here the tab badges say which state
   * the match is in. With no search the counts are the plain per-state totals.
   */
  const countsQ = useQuery({
    queryKey: ['cc-state-counts', subjectType, filtersKey, view.search],
    queryFn: async (): Promise<Record<string, number>> => {
      const { data, error } = await rpc('cc_state_counts', {
        p_subject_type: subjectType,
        p_filters: filtersArg,
        p_search: view.search.trim() || null,
      });
      if (error) throw new Error(err(error));

      const out: Record<string, number> = {};
      for (const r of (data ?? []) as Record<string, unknown>[]) {
        out[String(r.state)] = Number(r.row_count ?? 0);
      }
      return out;
    },
    staleTime: 15_000,
  });


  /**
   * Search-free per-state totals for the roster. The overview stat cards must
   * always describe the whole cycle population, so they can never be reduced by
   * whatever an officer happens to be typing in the search box. Only fetched
   * while a search is active — otherwise the plain counts already are the
   * totals and a second round trip would buy nothing.
   */
  const searchActive = view.search.trim().length > 0;
  const totalCountsQ = useQuery({
    queryKey: ['cc-state-counts', subjectType, filtersKey, ''],
    enabled: searchActive,
    queryFn: async (): Promise<Record<string, number>> => {
      const { data, error } = await rpc('cc_state_counts', {
        p_subject_type: subjectType,
        p_filters: filtersArg,
        p_search: null,
      });
      if (error) throw new Error(err(error));
      const out: Record<string, number> = {};
      for (const r of (data ?? []) as Record<string, unknown>[]) {
        out[String(r.state)] = Number(r.row_count ?? 0);
      }
      return out;
    },
    staleTime: 15_000,
  });

  /* ------------------------------------------------------- open attempts */
  const openAttemptsQ = useQuery({
    queryKey: ['cc-open-attempts', user?.id],
    enabled: !!user?.id,
    queryFn: async (): Promise<CcOpenAttempt[]> => {
      const { data, error } = await rpc('cc_my_open_attempts');
      if (error) throw new Error(err(error));
      return ((data ?? []) as Record<string, unknown>[]).map((a) => ({
        id: String(a.attempt_id),
        cycle_row_id: String(a.cycle_row_id),
        attempt_no: Number(a.attempt_no ?? 1),
        revealed_at: (a.revealed_at as string) ?? new Date().toISOString(),
        subject_type: a.subject_type as CcSubjectType,
        name: (a.name as string) || 'Unnamed',
        stale: a.stale === true,
      }));
    },
    staleTime: 5_000,
  });

  const openCount = openAttemptsQ.data?.length ?? 0;
  /** Per-cycle work-in-progress cap, set by ops. Null until the cycle loads. */
  const wipLimit: number | null =
    typeof cycleQ.data?.wip_limit === 'number' ? cycleQ.data.wip_limit : null;
  /**
   * Holding calls with pending feedback no longer blocks opening another call.
   * The open-attempt figure stays visible (and `wipLimit` stays readable for the
   * configuration read-out), but it never gates dialling — matching the DB
   * trigger, which no longer refuses on the open-attempt count either. Recording
   * feedback is still required to move a roster row.
   */
  const wipBlocked = false;


  /* ------------------------------------------------------------ reference */
  const categoriesQ = useQuery({
    queryKey: ['cc-categories', subjectType],
    queryFn: async (): Promise<CcCategory[]> => {
      const { data, error } = await supabase
        .from('cc_feedback_categories')
        .select('id, code, label, locked, default_owner_role, applies_to, active')
        .eq('active', true)
        .contains('applies_to', [subjectType])
        .order('label');
      if (error) throw new Error(err(error));
      return (data ?? []) as CcCategory[];
    },
    staleTime: 300_000,
  });

  /**
   * Routing-target picker only — NOT roster assembly. hr_staff carries no name
   * column and its user_id points at auth.users, so the display name is read
   * from profiles.full_name. No phone column is selected, and this list is
   * never joined onto a queue row.
   */
  const staffQ = useQuery({
    queryKey: ['cc-staff-options'],
    queryFn: async () => {
      const { data: staff, error } = await supabase
        .from('hr_staff')
        .select('id, user_id')
        .eq('active', true)
        .limit(1000);
      if (error) throw new Error(err(error));
      const ids = [...new Set((staff ?? []).map((s) => s.user_id).filter(Boolean))] as string[];
      if (!ids.length) return [];
      const { data: profs, error: pErr } = await supabase.from('profiles').select('id, full_name').in('id', ids);
      if (pErr) throw new Error(err(pErr));
      return (staff ?? [])
        .map((s) => ({
          id: s.id as string,
          name: (profs ?? []).find((p) => p.id === s.user_id)?.full_name || 'Unnamed staff',
        }))
        .sort((a, b) => a.name.localeCompare(b.name));
    },
    staleTime: 300_000,
  });



  const myStaffQ = useQuery({
    queryKey: ['cc-my-staff', user?.id],
    enabled: !!user?.id,
    queryFn: async () => {
      const { data, error } = await supabase.from('hr_staff').select('id').eq('user_id', user!.id).maybeSingle();
      if (error) throw new Error(err(error));
      return data?.id ?? null;
    },
    staleTime: 300_000,
  });

  const followupsQ = useQuery({
    queryKey: ['cc-followups', myStaffQ.data],
    enabled: !!myStaffQ.data,
    queryFn: async () => {
      const { data, error } = await supabase
        .from('cc_followups')
        .select('id, reason, due_at, created_at, subject_type, subject_id, ticket:hr_tickets(ref)')
        .eq('owed_by_staff_id', myStaffQ.data!)
        .is('completed_at', null)
        .order('due_at', { ascending: true });
      if (error) throw new Error(err(error));
      return (data ?? []) as unknown[];
    },
    staleTime: 15_000,
  });

  /**
   * Scoped to this hook's own `subjectType`: every query key here already
   * starts with `[key, subjectType, ...]`, so prefix-matching on just the
   * subject type still catches every tab/sort/search/page/filter variant for
   * that subject — the only thing it no longer touches is the *other* two
   * subject types' queues, which this mutation never affected anyway. Purely
   * narrows the blast radius of a background refetch; changes no data.
   */
  const invalidate = useCallback(() => {
    qc.invalidateQueries({ queryKey: ['cc-queue', subjectType] });
    qc.invalidateQueries({ queryKey: ['cc-state-counts', subjectType] });
    qc.invalidateQueries({ queryKey: ['cc-open-attempts'] });
    qc.invalidateQueries({ queryKey: ['cc-cycle-progress'] });
    qc.invalidateQueries({ queryKey: ['cc-followups'] });
  }, [qc, subjectType]);

  /* ----------------------------------------------------------- mutations */
  /**
   * Opens the attempt row FIRST, then asks the server for the number.
   * The number is never read from a table.
   *
   * There is no reveal limit. If this officer already has an unrecorded
   * attempt open on the same roster row, that row is reused instead of
   * opening another one — so the number can be revealed again and again while
   * the subject keeps its current call status, and only recording an outcome
   * moves it on.
   */
  const reveal = useMutation({
    mutationFn: async (row: { id: string }) => {
      const { data: existing } = await supabase
        .from('cc_call_attempts')
        .select('id, attempt_no')
        .eq('cycle_row_id', row.id)
        .eq('caller_id', user!.id)
        .is('recorded_at', null)
        .order('revealed_at', { ascending: false })
        .limit(1)
        .maybeSingle();

      let attemptId = (existing as { id?: string } | null)?.id ?? null;

      if (!attemptId) {
        const { data: attempt, error } = await supabase
          .from('cc_call_attempts')
          .insert({
            cycle_row_id: row.id,
            caller_id: user!.id,
            revealed_at: new Date().toISOString(),
            source: 'self_reported',
          } as never)
          .select('id, attempt_no')
          .single();
        if (error) throw new Error(err(error));
        attemptId = attempt.id as string;
      }

      const { data: phone, error: pErr } = await rpc('cc_reveal_phone', { p_attempt_id: attemptId });
      if (pErr) throw new Error(err(pErr));
      return { attemptId, phone: (phone as string) ?? null };
    },
    onSuccess: invalidate,
  });


  const recordQuick = useMutation({
    mutationFn: async (v: { attemptId: string; outcome: CcOutcome }) => {
      const { error } = await rpc('cc_record_unreached', { p_attempt_id: v.attemptId, p_outcome: v.outcome });
      if (error) throw new Error(err(error));
    },
    onSuccess: invalidate,
  });

  /**
   * Clears an attempt without claiming a call was made. The server records it
   * as refused with no channel and stores the reason. This is the only way out
   * of an attempt stranded on a closed cycle, so the WIP guard cannot deadlock.
   */
  const voidAttempt = useMutation({
    mutationFn: async (v: { attemptId: string; reason: string }) => {
      const { error } = await rpc('cc_void_attempt', { p_attempt_id: v.attemptId, p_reason: v.reason });
      if (error) throw new Error(err(error));
    },
    onSuccess: invalidate,
  });

  const recordEngaged = useMutation({
    mutationFn: async (v: {
      attemptId: string;
      categoryId: string;
      severity: CcSeverity;
      note: string;
      routedToStaffId: string | null;
      consent: boolean;
    }) => {
      const { error } = await rpc('cc_record_engaged', {
        p_attempt_id: v.attemptId,
        p_category_id: v.categoryId,
        p_severity: v.severity,
        p_note: v.note,
        p_routed_to_staff_id: v.routedToStaffId,
        p_consent: v.consent,
      });
      if (error) throw new Error(err(error));
    },
    onSuccess: invalidate,
  });

  const recordCallback = useMutation({
    mutationFn: async (v: { attemptId: string; dueAt: string }) => {
      const { error } = await rpc('cc_record_callback', { p_attempt_id: v.attemptId, p_due_at: v.dueAt });
      if (error) throw new Error(err(error));
    },
    onSuccess: invalidate,
  });

  const openCycle = useMutation({
    mutationFn: async (v: { populationCode: string; limit: number | null; title: string; description?: string | null }) => {
      const { data, error } = await rpc('cc_open_cycle', {
        p_subject_type: subjectType,
        p_population_code: v.populationCode,
        p_limit: v.limit,
        p_title: v.title,
        p_description: v.description ?? null,
      });
      if (error) throw new Error(err(error));
      return data as string;
    },
    onSuccess: () => {
      setOutstanding(null);
      qc.invalidateQueries({ queryKey: ['cc-cycle', subjectType] });
      invalidate();
    },
  });

  const closeCycle = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await rpc('cc_close_cycle', { p_cycle_id: id });
      if (error) {
        const { data, error: oErr } = await rpc('cc_cycle_outstanding', { p_cycle_id: id });
        if (oErr) throw new Error(err(error));
        setOutstanding((data as Record<string, unknown>[]) ?? []);
        throw new Error(err(error));
      }
      setOutstanding(null);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['cc-cycle', subjectType] });
      invalidate();
    },
  });

  /** Destructive: ends the cycle without requiring the roster to be worked. */
  const abandonCycle = useMutation({
    mutationFn: async (v: { cycleId: string; reason: string }) => {
      const { error } = await rpc('cc_abandon_cycle', { p_cycle_id: v.cycleId, p_reason: v.reason });
      if (error) throw new Error(err(error));
    },
    onSuccess: () => {
      setOutstanding(null);
      qc.invalidateQueries({ queryKey: ['cc-cycle', subjectType] });
      invalidate();
    },
  });

  const completeFollowup = useMutation({
    mutationFn: async (v: { id: string; note: string }) => {
      const { error } = await rpc('cc_complete_followup', { p_followup_id: v.id, p_note: v.note });
      if (error) throw new Error(err(error));
    },
    onSuccess: invalidate,
  });

  /**
   * Bring the open cycle up to date with the population it was opened on.
   *
   * The roster is a snapshot taken at open time, so anyone who became eligible
   * afterwards had no row and was invisible to the queue and to search. This
   * only ever INSERTS missing rows as `to_call`; existing rows, their state,
   * attempts, notes and history are untouched, and the unique key on
   * (cycle, subject) makes a duplicate impossible. Subjects who are no longer
   * eligible keep their rows — nothing is removed.
   */
  const syncQueue = useMutation({
    mutationFn: async (): Promise<number> => {
      const { data, error } = await rpc('cc_topup_cycle', { p_subject_type: subjectType });
      if (error) throw new Error(err(error));
      return Number(data ?? 0);
    },
    onSuccess: (added) => {
      if (added > 0) {
        qc.invalidateQueries({ queryKey: ['cc-cycle-progress', cycleId] });
        invalidate();
      }
    },
  });

  /**
   * Run it once per cycle per session as the hub loads, so an operator never
   * has to remember to. Failures are silent: a stale roster is a worse outcome
   * than a missing badge, but it must never block the queue from rendering.
   */
  const syncedCycleRef = useRef<string | null>(null);
  useEffect(() => {
    if (!cycleId || syncedCycleRef.current === cycleId) return;
    syncedCycleRef.current = cycleId;
    syncQueue.mutate(undefined, { onError: () => undefined });
    // syncQueue is a stable mutation object from react-query
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cycleId]);


  const shape = (c: Record<string, number>) => ({
    to_call: c.to_call ?? 0,
    engaged: c.engaged ?? 0,
    unreachable: c.unreachable ?? 0,
    parked: c.parked ?? 0,
    callback: c.callback ?? 0,
  });

  /** Search-aware: says which status a searched name is sitting in. */
  const counts = useMemo(() => shape(countsQ.data ?? {}), [countsQ.data]);
  /** Roster-wide, never narrowed by search — for the overview stat cards. */
  const totalCounts = useMemo(
    () => (searchActive ? shape(totalCountsQ.data ?? countsQ.data ?? {}) : shape(countsQ.data ?? {})),
    [searchActive, totalCountsQ.data, countsQ.data],
  );

  const total = queueQ.data?.total ?? 0;
  const pageFrom = total === 0 ? 0 : view.page * CC_PAGE_SIZE + 1;
  const pageTo = Math.min(total, (view.page + 1) * CC_PAGE_SIZE);

  return {
    subjectType,
    cycle: cycleQ.data ?? null,
    progress: progressQ.data ?? null,
    counts,
    totalCounts,
    searchActive,
    populations: populationsQ.data ?? [],
    sortOptions: sortOptionsQ.data ?? [],
    filterOptions: filterOptionsQ.data ?? [],
    filterOptionsLoading: filterOptionsQ.isLoading,
    filterOptionsError: filterOptionsQ.error ? err(filterOptionsQ.error) : null,
    activeFilters,
    activeFilterCount,

    defaultSortKey,
    effectiveSortKey,
    rows: queueQ.data?.rows ?? [],
    total,
    pageFrom,
    pageTo,
    pageSize: CC_PAGE_SIZE,
    isLoading: cycleQ.isLoading || queueQ.isLoading,
    isFetching: queueQ.isFetching,
    error: queueQ.error ? err(queueQ.error) : null,
    openAttempts: openAttemptsQ.data ?? [],
    openCount,
    wipBlocked,
    wipLimit,
    categories: categoriesQ.data ?? [],
    staffOptions: staffQ.data ?? [],
    followups: followupsQ.data ?? [],
    followupsError: followupsQ.error ? err(followupsQ.error) : null,

    canManageCycles,
    outstanding,
    reveal,
    recordQuick,
    voidAttempt,
    recordEngaged,
    recordCallback,
    openCycle,
    closeCycle,
    abandonCycle,
    completeFollowup,
    syncQueue,

    refetch: invalidate,
  };
}

export type CcCallingHub = ReturnType<typeof useCcCallingHub>;
