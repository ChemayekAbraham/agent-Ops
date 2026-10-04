import { useEffect, useRef, useState } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/hooks/useAuth';

export interface CommissionEvent {
  amount: number;
  repaymentAmount: number;
  businessName?: string;
  advanceId: string;
  ts: number;
}

/**
 * Subscribes the current agent to realtime business_advance_repayments
 * and emits a celebration event when their tenant makes a payment.
 * Pure realtime — no DB query on each render.
 */
export function useBusinessAdvanceCommissionListener() {
  const { user } = useAuth();
  const [event, setEvent] = useState<CommissionEvent | null>(null);
  const businessNameCache = useRef<Map<string, string>>(new Map());

  useEffect(() => {
    if (!user?.id) return;

    const channel = supabase
      .channel(`business-advance-commission-${user.id}`)
      .on(
        'postgres_changes',
        {
          event: 'INSERT',
          schema: 'public',
          table: 'business_advance_repayments',
          filter: `agent_id=eq.${user.id}`,
        },
        async (payload) => {
          const row: any = payload.new;
          const commission = Number(row.agent_commission || 0);
          if (commission <= 0) return;

          let businessName = businessNameCache.current.get(row.advance_id);
          if (!businessName) {
            const { data } = await supabase
              .from('business_advances')
              .select('business_name')
              .eq('id', row.advance_id)
              .maybeSingle();
            businessName = data?.business_name || 'Business advance';
            businessNameCache.current.set(row.advance_id, businessName);
          }

          setEvent({
            amount: commission,
            repaymentAmount: Number(row.amount),
            businessName,
            advanceId: row.advance_id,
            ts: Date.now(),
          });
        }
      )
      .subscribe();

    return () => { supabase.removeChannel(channel); };
  }, [user?.id]);

  return { event, dismiss: () => setEvent(null) };
}
