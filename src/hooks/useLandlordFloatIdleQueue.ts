import { useCallback, useEffect, useRef, useState } from 'react';
import { supabase } from '@/integrations/supabase/client';

/**
 * Landlord float that is sitting in an agent's wallet with the landlord still
 * unpaid.
 *
 * Everything here goes through two SECURITY DEFINER RPCs. The underlying table,
 * `landlord_float_idle_alerts`, is REVOKEd from `authenticated` and must stay
 * that way — it is a money register, and the frontend never reads or writes
 * ledger state directly (`scripts/guard-frontend-ledger-writes.mjs`).
 *
 *   landlord_float_idle_queue(scope, limit)   read, wider audience
 *   landlord_float_idle_action(id, act, note) write, narrower
 *
 * The read returns `can_act` for the calling user so the UI does not have to
 * duplicate the role rules. It is a rendering hint only: both RPCs enforce
 * authorisation server-side regardless of what the client believes.
 */

export type IdleFloatScope = 'open' | 'backlog' | 'escalated' | 'resolved' | 'all';

export type IdleFloatAction = 'acknowledge' | 'note' | 'recall_now' | 'dismiss';

export interface IdleFloatRow {
  id: string;
  allocation_id: string;
  rent_request_id: string;
  agent_id: string | null;
  agent_name: string | null;
  agent_phone: string | null;
  landlord_name: string | null;
  tenant_name: string | null;
  tenant_phone: string | null;
  amount: number;
  rent_amount: number | null;
  funded_at: string;
  deadline_at: string;
  hours_outstanding: number;
  severity: 'reminder' | 'warning' | 'overdue';
  payout_attempted: boolean;
  outcome: string | null;
  plan_status: string | null;
  allocation_status: string | null;
  paid_out_amount: number;
  last_payout_status: string | null;
  last_payout_error: string | null;
  last_payout_at: string | null;
  payout_attempts: number | null;
  return_requested: boolean;
  /** False for anything funded before the recall rule went live. */
  in_scope_for_recall: boolean;
  acknowledged_at: string | null;
  acknowledged_by: string | null;
  review_note: string | null;
  reviewed_at: string | null;
  reviewed_by_name: string | null;
  resolved_at: string | null;
  created_at: string;
}

export interface IdleFloatSummary {
  open_count: number;
  open_amount: number;
  backlog_count: number;
  backlog_amount: number;
  escalated_count: number;
  escalated_amount: number;
  resolved_count: number;
  idle_total: number;
  oldest_funded_at: string | null;
}

const EMPTY_SUMMARY: IdleFloatSummary = {
  open_count: 0, open_amount: 0,
  backlog_count: 0, backlog_amount: 0,
  escalated_count: 0, escalated_amount: 0,
  resolved_count: 0, idle_total: 0,
  oldest_funded_at: null,
};

interface QueuePayload {
  as_of: string;
  scope: IdleFloatScope;
  go_live: string;
  can_act: boolean;
  summary: IdleFloatSummary;
  rows: IdleFloatRow[];
}

export interface UseLandlordFloatIdleQueue {
  scope: IdleFloatScope;
  setScope: (s: IdleFloatScope) => void;
  rows: IdleFloatRow[];
  summary: IdleFloatSummary;
  goLive: string | null;
  canAct: boolean;
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
  /** Resolves to null on success, or the reason it failed. */
  act: (alertId: string, action: IdleFloatAction, note: string) => Promise<string | null>;
  acting: string | null;
}

export function useLandlordFloatIdleQueue(
  initialScope: IdleFloatScope = 'open',
): UseLandlordFloatIdleQueue {
  const [scope, setScope] = useState<IdleFloatScope>(initialScope);
  const [rows, setRows] = useState<IdleFloatRow[]>([]);
  const [summary, setSummary] = useState<IdleFloatSummary>(EMPTY_SUMMARY);
  const [goLive, setGoLive] = useState<string | null>(null);
  const [canAct, setCanAct] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [acting, setActing] = useState<string | null>(null);

  // Switching tabs quickly fires overlapping reads. Without a sequence guard a
  // slow 'all' can land after a fast 'open' and paint the wrong list.
  const seqRef = useRef(0);
  const mountedRef = useRef(true);
  useEffect(() => () => { mountedRef.current = false; }, []);

  const load = useCallback(async (which: IdleFloatScope) => {
    const seq = ++seqRef.current;
    setLoading(true);
    const { data, error: rpcError } = await supabase.rpc(
      'landlord_float_idle_queue' as never,
      { p_scope: which, p_limit: 300 } as never,
    );
    if (!mountedRef.current || seq !== seqRef.current) return;

    if (rpcError) {
      setError(rpcError.message);
      setRows([]);
      setLoading(false);
      return;
    }

    const payload = (data ?? {}) as unknown as QueuePayload;
    setError(null);
    setRows(Array.isArray(payload.rows) ? payload.rows : []);
    setSummary(payload.summary ?? EMPTY_SUMMARY);
    setGoLive(payload.go_live ?? null);
    setCanAct(Boolean(payload.can_act));
    setLoading(false);
  }, []);

  useEffect(() => { void load(scope); }, [scope, load]);

  const refresh = useCallback(() => load(scope), [load, scope]);

  const act = useCallback(
    async (alertId: string, action: IdleFloatAction, note: string): Promise<string | null> => {
      setActing(alertId);
      const { data, error: rpcError } = await supabase.rpc(
        'landlord_float_idle_action' as never,
        { p_alert_id: alertId, p_action: action, p_note: note } as never,
      );
      setActing(null);

      if (rpcError) return rpcError.message;
      const res = data as unknown as { success?: boolean; error?: string } | null;
      if (res && res.success === false) return res.error || 'The action could not be saved.';

      await load(scope);
      return null;
    },
    [load, scope],
  );

  return { scope, setScope, rows, summary, goLive, canAct, loading, error, refresh, act, acting };
}
