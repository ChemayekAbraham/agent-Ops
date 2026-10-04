import { useEffect, useRef } from 'react';
import { supabase } from '@/integrations/supabase/client';

/**
 * Subscribes to realtime changes on tables that drive the proxy-agent
 * funder management UI (FunderManagementSheet / FunderDetailView).
 *
 * Pass an `agentId` to scope to a single proxy agent (listens for any
 * proxy_agent_assignments changes for that agent). Pass a `beneficiaryId`
 * to also listen for portfolio / ROI / withdrawal activity for one funder.
 *
 * `onChange` is debounced (250ms) so a burst of events triggers a single
 * refetch rather than hammering the DB.
 */
export function useFunderAccountsRealtime(opts: {
  agentId?: string;
  beneficiaryId?: string;
  onChange: () => void;
  enabled?: boolean;
}) {
  const { agentId, beneficiaryId, onChange, enabled = true } = opts;
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  useEffect(() => {
    if (!enabled) return;
    if (!agentId && !beneficiaryId) return;

    let timer: ReturnType<typeof setTimeout> | null = null;
    const trigger = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => onChangeRef.current(), 250);
    };

    const channelName = `funder-rt-${agentId ?? 'any'}-${beneficiaryId ?? 'any'}`;
    const channel = supabase.channel(channelName);

    if (agentId) {
      channel.on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'proxy_agent_assignments', filter: `agent_id=eq.${agentId}` },
        trigger,
      );
    }

    if (beneficiaryId) {
      channel
        .on(
          'postgres_changes',
          { event: '*', schema: 'public', table: 'investor_portfolios', filter: `investor_id=eq.${beneficiaryId}` },
          trigger,
        )
        .on(
          'postgres_changes',
          { event: '*', schema: 'public', table: 'supporter_roi_payments', filter: `supporter_id=eq.${beneficiaryId}` },
          trigger,
        )
        .on(
          'postgres_changes',
          { event: '*', schema: 'public', table: 'withdrawal_requests', filter: `proxy_partner_id=eq.${beneficiaryId}` },
          trigger,
        );
      // (No `wallets` listener: wallets is a view, which Realtime cannot
      // replicate, so it never fired — doc 147.)
    }

    channel.subscribe();

    return () => {
      if (timer) clearTimeout(timer);
      supabase.removeChannel(channel);
    };
  }, [agentId, beneficiaryId, enabled]);
}