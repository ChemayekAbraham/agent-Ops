import { useEffect, useRef } from 'react';
import { supabase } from '@/integrations/supabase/client';

interface Options {
  /** Active agent user id. Hook is a no-op when undefined. */
  agentId: string | undefined;
  /** Called (debounced) when any agent-scoped event arrives. */
  onChange: () => void;
  /** Debounce window in ms. Defaults to 600ms — coalesces bursts of
   *  ledger/commission rows from a single transaction into one refresh. */
  debounceMs?: number;
}

/**
 * Single combined realtime channel for the agent dashboard.
 *
 * Subscribes to the three tables that matter for instant "money moved"
 * feedback on mobile:
 *   • `agent_earnings`     — new commission / bonus rows
 *   • `wallet_transactions` — incoming or outgoing wallet activity
 *   • `agent_landlord_float` — float top-ups / payouts that change the
 *     headline float bucket
 *
 * All events are filtered to the current agent so we do not pay per-row
 * fan-out for the whole platform — important for the 40M-user budget set
 * by the Cloud Cost Optimization rule.
 *
 * Events are debounced (600ms by default) before invoking `onChange`,
 * so a single approve-deposit edge function that writes 3-4 ledger rows
 * only triggers ONE dashboard refetch cycle.
 *
 * The hook teardown removes the channel; safe to call from React.StrictMode.
 */
export function useAgentDashboardRealtime({ agentId, onChange, debounceMs = 600 }: Options) {
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  useEffect(() => {
    if (!agentId) return;

    let timer: number | null = null;
    const fire = () => {
      if (timer != null) window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        timer = null;
        try { onChangeRef.current(); } catch (e) { console.warn('[agent-realtime] onChange threw', e); }
      }, debounceMs);
    };

    const channel = supabase
      .channel(`agent-dashboard-${agentId}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'agent_earnings', filter: `agent_id=eq.${agentId}` }, fire)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'wallet_transactions', filter: `sender_id=eq.${agentId}` }, fire)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'wallet_transactions', filter: `recipient_id=eq.${agentId}` }, fire)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'agent_landlord_float', filter: `agent_id=eq.${agentId}` }, fire)
      .subscribe();

    return () => {
      if (timer != null) window.clearTimeout(timer);
      supabase.removeChannel(channel);
    };
  }, [agentId, debounceMs]);
}

export default useAgentDashboardRealtime;