/**
 * Shared data layer for the Call Centre hub (tenant / landlord / agent).
 *
 * Rules encoded here:
 *  - Phone numbers are NEVER fetched with the roster. A number is only read
 *    after a cc_call_attempts row exists (reveal-then-show).
 *  - No trigger rule is duplicated client-side. The WIP guard, attempt cap and
 *    locked-category rejection all come back from the database as messages
 *    written to be read by staff; we surface them verbatim.
 */
import { useCallback, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/hooks/useAuth';

export type CcSubjectType = 'tenant' | 'landlord' | 'agent';
export type CcRowState = 'to_call' | 'engaged' | 'unreachable' | 'callback' | 'parked' | 'closed';
export type CcOutcome = 'engaged' | 'no_answer' | 'phone_off' | 'wrong_number' | 'refused' | 'callback_booked';
export type CcSeverity = 'low' | 'medium' | 'high' | 'critical';

export const QUICK_OUTCOMES: { value: Exclude<CcOutcome, 'engaged' | 'callback_booked'>; label: string }[] = [
  { value: 'no_answer', label: 'No answer' },
  { value: 'phone_off', label: 'Phone off' },
  { value: 'wrong_number', label: 'Wrong number' },
  { value: 'refused', label: 'Refused' },
];

export const OPEN_ATTEMPT_LIMIT = 3;

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
  priority_value: number | null;
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
}

export interface CcOpenAttempt {
  id: string;
  cycle_row_id: string;
  attempt_no: number;
  revealed_at: string;
  subject_id: string;
  subject_type: CcSubjectType;
  name: string;
}

export interface CcCategory {
  id: string;
  code: string;
  label: string;
  locked: boolean;
  default_owner_role: string | null;
}

const err = (e: unknown) => (e instanceof Error ? e.message : String(e));

export function useCcCallingHub(subjectType: CcSubjectType) {
  const { user, roles } = useAuth();
  const qc = useQueryClient();
  const [outstanding, setOutstanding] = useState<Record<string, unknown>[] | null>(null);

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
        .select('id, cycle_no, opened_at, attempt_cap, retry_after_days')
        .eq('subject_type', subjectType)
        .is('closed_at', null)
        .order('cycle_no', { ascending: false })
        .limit(1)
        .maybeSingle();
      if (error) throw error;
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
      if (error) throw error;
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
      if (error) throw error;
      return data ?? [];
    },
    staleTime: 300_000,
  });

  /* ----------------------------------------------------------------- rows */
  const rowsQ = useQuery({
    queryKey: ['cc-rows', cycleId],
    enabled: !!cycleId,
    queryFn: async (): Promise<CcRow[]> => {
      const { data: rows, error } = await supabase
        .from('cc_cycle_rows')
        .select(
          'id, subject_type, subject_id, state, attempts_made, last_attempt_at, next_retry_at, callback_due_at, park_reason, priority_value',
        )
        .eq('cycle_id', cycleId!)
        .neq('state', 'closed')
        .order('priority_value', { ascending: false, nullsFirst: false })
        .limit(2000);
      if (error) throw error;
      const base = rows ?? [];
      if (!base.length) return [];

      const rowIds = base.map((r) => r.id);
      const subjectIds = [...new Set(base.map((r) => r.subject_id))];

      // NOTE: `phone` is intentionally absent from this select.
      const { data: profs } = await supabase
        .from('profiles')
        .select('id, full_name, district, managing_agent_id')
        .in('id', subjectIds);

      const agentIds = [...new Set((profs ?? []).map((p) => p.managing_agent_id).filter(Boolean))] as string[];

      const [{ data: attempts }, { data: feedback }, { data: followups }] = await Promise.all([
        supabase
          .from('cc_call_attempts')
          .select('id, cycle_row_id, caller_id, outcome, recorded_at')
          .in('cycle_row_id', rowIds)
          .order('created_at', { ascending: false }),
        supabase
          .from('cc_feedback')
          .select(
            'id, severity, created_at, routed_to_actual, routed_to_expected, category:cc_feedback_categories(label), ticket:hr_tickets(ref, task:hr_tasks(status)), attempt:cc_call_attempts!inner(cycle_row_id)',
          )
          .in('attempt.cycle_row_id', rowIds)
          .order('created_at', { ascending: false }),
        supabase
          .from('cc_followups')
          .select('cycle_row_id, ticket:hr_tickets(ref)')
          .in('cycle_row_id', rowIds),
      ]);

      const callerIds = [...new Set((attempts ?? []).map((a) => a.caller_id).filter(Boolean))] as string[];
      const staffIds = [
        ...new Set(
          (feedback ?? []).flatMap((f: any) => [f.routed_to_actual, f.routed_to_expected]).filter(Boolean),
        ),
      ] as string[];

      const [{ data: agentProfs }, { data: callerProfs }, { data: staffRows }] = await Promise.all([
        agentIds.length
          ? supabase.from('profiles').select('id, full_name').in('id', agentIds)
          : Promise.resolve({ data: [] as any[] }),
        callerIds.length
          ? supabase.from('profiles').select('id, full_name').in('id', callerIds)
          : Promise.resolve({ data: [] as any[] }),
        staffIds.length
          ? supabase.from('hr_staff').select('id, user_id').in('id', staffIds)
          : Promise.resolve({ data: [] as any[] }),
      ]);

      const staffUserIds = [...new Set((staffRows ?? []).map((s: any) => s.user_id).filter(Boolean))] as string[];
      const { data: staffProfs } = staffUserIds.length
        ? await supabase.from('profiles').select('id, full_name').in('id', staffUserIds)
        : { data: [] as any[] };

      const nameOf = (list: any[] | null, id: string | null | undefined) =>
        (id && (list ?? []).find((p) => p.id === id)?.full_name) || null;
      const staffName = (staffId: string | null) => {
        const s = (staffRows ?? []).find((x: any) => x.id === staffId);
        return s ? nameOf(staffProfs as any[], s.user_id) : null;
      };

      const feedbackByRow = new Map<string, any>();
      for (const f of (feedback ?? []) as any[]) {
        const rid = f.attempt?.cycle_row_id;
        if (rid && !feedbackByRow.has(rid)) feedbackByRow.set(rid, f);
      }
      const bookedByRow = new Map<string, string | null>();
      for (const a of (attempts ?? []) as any[]) {
        if (a.outcome === 'callback_booked' && !bookedByRow.has(a.cycle_row_id)) {
          bookedByRow.set(a.cycle_row_id, nameOf(callerProfs as any[], a.caller_id));
        }
      }
      const fixTicketByRow = new Map<string, string | null>();
      for (const f of (followups ?? []) as any[]) {
        if (f.cycle_row_id && !fixTicketByRow.has(f.cycle_row_id)) {
          fixTicketByRow.set(f.cycle_row_id, f.ticket?.ref ?? null);
        }
      }

      return base.map((r) => {
        const prof = (profs ?? []).find((p) => p.id === r.subject_id);
        const fb = feedbackByRow.get(r.id);
        return {
          id: r.id,
          subject_type: r.subject_type as CcSubjectType,
          subject_id: r.subject_id,
          state: r.state as CcRowState,
          attempts_made: r.attempts_made ?? 0,
          last_attempt_at: r.last_attempt_at,
          next_retry_at: r.next_retry_at,
          callback_due_at: r.callback_due_at,
          park_reason: r.park_reason,
          priority_value: r.priority_value === null ? null : Number(r.priority_value),
          name: prof?.full_name || 'Unnamed',
          linked_agent: nameOf(agentProfs as any[], prof?.managing_agent_id),
          district: prof?.district ?? null,
          feedback_category: fb?.category?.label ?? null,
          severity: (fb?.severity as CcSeverity) ?? null,
          routed_to: fb ? staffName(fb.routed_to_actual ?? fb.routed_to_expected) : null,
          ticket_ref: fb?.ticket?.ref ?? null,
          ticket_status: fb?.ticket?.task?.status ?? null,
          fix_ticket_ref: fixTicketByRow.get(r.id) ?? null,
          booked_by: bookedByRow.get(r.id) ?? null,
        };
      });
    },
    staleTime: 15_000,
  });

  /* ------------------------------------------------------- open attempts */
  const openAttemptsQ = useQuery({
    queryKey: ['cc-open-attempts', user?.id, subjectType],
    enabled: !!user?.id,
    queryFn: async (): Promise<CcOpenAttempt[]> => {
      const { data, error } = await supabase
        .from('cc_call_attempts')
        .select('id, cycle_row_id, attempt_no, revealed_at, row:cc_cycle_rows!inner(subject_id, subject_type)')
        .eq('caller_id', user!.id)
        .is('recorded_at', null)
        .order('revealed_at', { ascending: true });
      if (error) throw error;
      const list = (data ?? []) as any[];
      const ids = [...new Set(list.map((a) => a.row?.subject_id).filter(Boolean))];
      const { data: profs } = ids.length
        ? await supabase.from('profiles').select('id, full_name').in('id', ids)
        : { data: [] as any[] };
      return list.map((a) => ({
        id: a.id,
        cycle_row_id: a.cycle_row_id,
        attempt_no: a.attempt_no,
        revealed_at: a.revealed_at,
        subject_id: a.row?.subject_id,
        subject_type: a.row?.subject_type,
        name: (profs ?? []).find((p: any) => p.id === a.row?.subject_id)?.full_name || 'Unnamed',
      }));
    },
    staleTime: 5_000,
  });

  const openCount = openAttemptsQ.data?.length ?? 0;
  const wipBlocked = openCount >= OPEN_ATTEMPT_LIMIT;

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
      if (error) throw error;
      return (data ?? []) as CcCategory[];
    },
    staleTime: 300_000,
  });

  const staffQ = useQuery({
    queryKey: ['cc-staff-options'],
    queryFn: async () => {
      const { data, error } = await supabase.from('hr_staff').select('id, user_id').eq('active', true).limit(1000);
      if (error) throw error;
      const ids = [...new Set((data ?? []).map((s: any) => s.user_id).filter(Boolean))];
      const { data: profs } = ids.length
        ? await supabase.from('profiles').select('id, full_name').in('id', ids)
        : { data: [] as any[] };
      return (data ?? [])
        .map((s: any) => ({
          id: s.id as string,
          name: (profs ?? []).find((p: any) => p.id === s.user_id)?.full_name || 'Unnamed staff',
        }))
        .sort((a, b) => a.name.localeCompare(b.name));
    },
    staleTime: 300_000,
  });

  const myStaffQ = useQuery({
    queryKey: ['cc-my-staff', user?.id],
    enabled: !!user?.id,
    queryFn: async () => {
      const { data } = await supabase.from('hr_staff').select('id').eq('user_id', user!.id).maybeSingle();
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
      if (error) throw error;
      return (data ?? []) as any[];
    },
    staleTime: 15_000,
  });

  const invalidate = useCallback(() => {
    qc.invalidateQueries({ queryKey: ['cc-rows'] });
    qc.invalidateQueries({ queryKey: ['cc-open-attempts'] });
    qc.invalidateQueries({ queryKey: ['cc-cycle-progress'] });
    qc.invalidateQueries({ queryKey: ['cc-followups'] });
  }, [qc]);

  /* ----------------------------------------------------------- mutations */
  /** Creates the attempt row FIRST, then reads the number. */
  const reveal = useMutation({
    mutationFn: async (row: { id: string; subject_id: string }) => {
      const { data: attempt, error } = await supabase
        .from('cc_call_attempts')
        .insert({
          cycle_row_id: row.id,
          caller_id: user!.id,
          revealed_at: new Date().toISOString(),
          source: 'calling_hub',
        })
        .select('id, attempt_no')
        .single();
      if (error) throw new Error(err(error));
      const { data: prof, error: pErr } = await supabase
        .from('profiles')
        .select('phone')
        .eq('id', row.subject_id)
        .maybeSingle();
      if (pErr) throw new Error(err(pErr));
      return { attemptId: attempt.id as string, phone: (prof?.phone as string) ?? null };
    },
    onSuccess: invalidate,
  });

  const recordQuick = useMutation({
    mutationFn: async (v: { attemptId: string; outcome: CcOutcome }) => {
      const { error } = await supabase
        .from('cc_call_attempts')
        .update({ recorded_at: new Date().toISOString(), outcome: v.outcome, channel: 'phone' })
        .eq('id', v.attemptId);
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
      // Feedback first: an engaged attempt must already carry its feedback row.
      const { error: fErr } = await supabase.from('cc_feedback').insert({
        attempt_id: v.attemptId,
        category_id: v.categoryId,
        severity: v.severity,
        note: v.note,
        routed_to_actual: v.routedToStaffId,
        consent_to_contact: v.consent,
      });
      if (fErr) throw new Error(err(fErr));
      const { error } = await supabase
        .from('cc_call_attempts')
        .update({ recorded_at: new Date().toISOString(), outcome: 'engaged', channel: 'phone' })
        .eq('id', v.attemptId);
      if (error) throw new Error(err(error));
    },
    onSuccess: invalidate,
  });

  const recordCallback = useMutation({
    mutationFn: async (v: { attemptId: string; cycleRowId: string; dueAt: string }) => {
      const { error } = await supabase
        .from('cc_call_attempts')
        .update({ recorded_at: new Date().toISOString(), outcome: 'callback_booked', channel: 'phone' })
        .eq('id', v.attemptId);
      if (error) throw new Error(err(error));
      const { error: rErr } = await supabase
        .from('cc_cycle_rows')
        .update({ callback_due_at: v.dueAt })
        .eq('id', v.cycleRowId);
      if (rErr) throw new Error(err(rErr));
    },
    onSuccess: invalidate,
  });

  const openCycle = useMutation({
    mutationFn: async (v: { populationCode: string; limit: number | null }) => {
      const { data, error } = await supabase.rpc('cc_open_cycle', {
        p_subject_type: subjectType,
        p_population_code: v.populationCode,
        p_limit: v.limit,
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
      const { error } = await supabase.rpc('cc_close_cycle', { p_cycle_id: id });
      if (error) {
        const { data } = await supabase.rpc('cc_cycle_outstanding', { p_cycle_id: id });
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

  const completeFollowup = useMutation({
    mutationFn: async (v: { id: string; note: string }) => {
      const { error } = await supabase.rpc('cc_complete_followup', { p_followup_id: v.id, p_note: v.note });
      if (error) throw new Error(err(error));
    },
    onSuccess: invalidate,
  });

  const counts = useMemo(() => {
    const p = progressQ.data;
    return {
      to_call: Number(p?.to_call_rows ?? 0),
      engaged: Number(p?.engaged_rows ?? 0),
      unreachable: Number(p?.unreachable_rows ?? 0),
      parked: Number(p?.parked_rows ?? 0),
      callback: Number(p?.callback_rows ?? 0),
    };
  }, [progressQ.data]);

  return {
    subjectType,
    cycle: cycleQ.data ?? null,
    progress: progressQ.data ?? null,
    counts,
    populations: populationsQ.data ?? [],
    rows: rowsQ.data ?? [],
    isLoading: cycleQ.isLoading || rowsQ.isLoading,
    openAttempts: openAttemptsQ.data ?? [],
    openCount,
    wipBlocked,
    categories: categoriesQ.data ?? [],
    staffOptions: staffQ.data ?? [],
    followups: followupsQ.data ?? [],
    canManageCycles,
    outstanding,
    reveal,
    recordQuick,
    recordEngaged,
    recordCallback,
    openCycle,
    closeCycle,
    completeFollowup,
    refetch: invalidate,
  };
}

export type CcCallingHub = ReturnType<typeof useCcCallingHub>;
