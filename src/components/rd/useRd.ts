import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { toast } from 'sonner';

// Untyped handle: the database enforces every rule; the UI only relays results.
export const db = supabase as any;

export const STAGES = ['intake', 'frame', 'build', 'prove', 'ship', 'adopt'] as const;
export const ALL_STAGES = [...STAGES, 'kill'] as const;
export const HORIZONS = ['now', 'next', 'later'] as const;
export const DOMAINS = ['product', 'model', 'payments', 'fraud', 'security', 'capital', 'field_ops', 'competitor'] as const;
export const DELAY_BUCKETS = ['real_constraint', 'our_process', 'our_uncertainty', 'our_thrash'] as const;
export const DECISIONS = ['ship', 'kill', 'pause', 'adopt'] as const;

export const STAGE_LABEL: Record<string, string> = {
  intake: 'Intake', frame: 'Frame', build: 'Build', prove: 'Prove', ship: 'Ship', adopt: 'Adopt', kill: 'Killed',
};
export const labelize = (s?: string | null) => (s ? s.replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase()) : '');

export type Mission = Record<string, any> & {
  id: string; title: string; stage: string; horizon: string; owner_id: string | null;
  deputy_id: string | null; domains: string[] | null; next_gate_on: string | null;
};
export type Person = { user_id: string; full_name: string | null; staff_ref: string | null; is_rd: boolean; is_lead: boolean };
export type Me = { can_read: boolean; is_contributor: boolean; is_lead: boolean; is_ceo: boolean; is_cfo: boolean };

const TZ = 'Africa/Kampala';
export function fmtDate(v?: string | null) {
  if (!v) return '—';
  const d = /^\d{4}-\d{2}-\d{2}$/.test(v) ? new Date(v + 'T12:00:00+03:00') : new Date(v);
  return d.toLocaleDateString('en-GB', { timeZone: TZ, day: '2-digit', month: 'short', year: 'numeric' });
}
export function fmtDateTime(v?: string | null) {
  if (!v) return '—';
  return new Date(v).toLocaleString('en-GB', { timeZone: TZ, day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

export function errMsg(e: any) {
  return e?.message || e?.error_description || String(e);
}
export function toastErr(e: any) {
  toast.error(errMsg(e));
}

async function unwrap<T>(p: PromiseLike<{ data: T; error: any }>): Promise<T> {
  const { data, error } = await p;
  if (error) throw error;
  return data;
}

export function useCurrentUserId() {
  return useQuery({
    queryKey: ['rd', 'uid'],
    queryFn: async () => (await supabase.auth.getUser()).data.user?.id ?? null,
    staleTime: Infinity,
  });
}

export function useRdMe() {
  return useQuery({
    queryKey: ['rd', 'me'],
    queryFn: async () => {
      const rows = await unwrap<Me[]>(db.rpc('rd_me'));
      return (Array.isArray(rows) ? rows[0] : rows) ?? { can_read: false, is_contributor: false, is_lead: false, is_ceo: false, is_cfo: false };
    },
    staleTime: 5 * 60_000,
  });
}

export function useRdPeople() {
  return useQuery({
    queryKey: ['rd', 'people'],
    queryFn: async () => (await unwrap<Person[]>(db.rpc('rd_people'))) ?? [],
    staleTime: 5 * 60_000,
  });
}

export function usePeopleMap() {
  const { data } = useRdPeople();
  const map = new Map<string, Person>();
  (data ?? []).forEach((p) => map.set(p.user_id, p));
  return (id?: string | null) => (id ? map.get(id)?.full_name || 'Unknown staff' : '—');
}

export function useMissions() {
  return useQuery({
    queryKey: ['rd', 'missions'],
    queryFn: async () => (await unwrap<Mission[]>(db.from('rd_missions').select('*').order('updated_at', { ascending: false }))) ?? [],
  });
}

export function useMission(id?: string) {
  return useQuery({
    queryKey: ['rd', 'mission', id],
    enabled: !!id,
    queryFn: async () => unwrap<Mission>(db.from('rd_missions').select('*').eq('id', id).single()),
  });
}

export function useSettings() {
  return useQuery({
    queryKey: ['rd', 'settings'],
    queryFn: async () => {
      const rows = await unwrap<any[]>(db.from('rd_settings').select('*').limit(1));
      return rows?.[0] ?? null;
    },
  });
}

export function useDecisions() {
  return useQuery({
    queryKey: ['rd', 'decisions'],
    queryFn: async () => (await unwrap<any[]>(db.from('rd_decisions').select('*').order('decided_at', { ascending: false }))) ?? [],
  });
}

export function useOpenP0() {
  return useQuery({
    queryKey: ['rd', 'p0'],
    queryFn: async () => {
      const [signals, risks] = await Promise.all([
        unwrap<any[]>(db.from('rd_signals').select('id,created_at').eq('severity', 'p0').eq('status', 'new')),
        unwrap<any[]>(db.from('rd_risk_items').select('id').eq('severity', 'p0').neq('status', 'closed')),
      ]);
      return { signals: signals ?? [], risks: risks ?? [] };
    },
  });
}

export function useLinked(missionId?: string) {
  return useQuery({
    queryKey: ['rd', 'linked', missionId],
    enabled: !!missionId,
    queryFn: async () => {
      const [signals, experiments, risks] = await Promise.all([
        unwrap<any[]>(db.from('rd_signals').select('*').eq('mission_id', missionId).order('created_at', { ascending: false })),
        unwrap<any[]>(db.from('rd_experiments').select('*').eq('mission_id', missionId).order('created_at', { ascending: false })),
        unwrap<any[]>(db.from('rd_risk_items').select('*').eq('blocks_mission_id', missionId).order('created_at', { ascending: false })),
      ]);
      return { signals: signals ?? [], experiments: experiments ?? [], risks: risks ?? [] };
    },
  });
}

export function useComments(missionId?: string) {
  return useQuery({
    queryKey: ['rd', 'comments', missionId],
    enabled: !!missionId,
    queryFn: async () => (await unwrap<any[]>(db.from('rd_comments').select('*').eq('mission_id', missionId).order('created_at', { ascending: true }))) ?? [],
  });
}

/** Generic mutation: runs fn, invalidates all rd queries, toasts the database's message verbatim on failure. */
export function useRdMutation<A>(fn: (a: A) => Promise<any>, successMsg?: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (a: A) => {
      const res = await fn(a);
      if (res && typeof res === 'object' && 'error' in res && res.error) throw res.error;
      return res;
    },
    onSuccess: () => {
      if (successMsg) toast.success(successMsg);
    },
    onError: (e) => toastErr(e),
    onSettled: () => qc.invalidateQueries({ queryKey: ['rd'] }),
  });
}
