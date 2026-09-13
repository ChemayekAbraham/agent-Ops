import { useCallback, useEffect, useState } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/hooks/useAuth';

export type AutoPayoutFrequency = 'daily' | 'weekly' | 'monthly';

export interface AutoPayout {
  id: string;
  recipient_id: string;
  amount: number;
  description: string | null;
  frequency: AutoPayoutFrequency;
  day_of_week: number | null;
  day_of_month: number | null;
  status: 'active' | 'paused' | 'pending_approval' | 'cancelled';
  next_run_at: string | null;
  last_run_at: string | null;
  last_error: string | null;
  runs_completed: number;
  recipientName?: string;
}

/**
 * Recurring ("automatic") wallet transfers from the withdrawable bucket.
 *
 * All writes go through SECURITY DEFINER RPCs — this hook never touches
 * wallets or the ledger. The scheduled runner sends the money through the
 * same `wallet-transfer` edge function an interactive transfer uses.
 */
export function useAutoPayouts() {
  const { user } = useAuth();
  const [schedules, setSchedules] = useState<AutoPayout[]>([]);
  const [cap, setCap] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);

  const refresh = useCallback(async () => {
    if (!user?.id) return;
    setLoading(true);
    try {
      const [{ data: rows }, { data: config }] = await Promise.all([
        supabase
          .from('wallet_transfer_schedules')
          .select(
            'id, recipient_id, amount, description, frequency, day_of_week, day_of_month, status, next_run_at, last_run_at, last_error, runs_completed',
          )
          .eq('user_id', user.id)
          .neq('status', 'cancelled')
          .order('created_at', { ascending: false }),
        supabase.from('wallet_transfer_schedule_config').select('auto_approval_cap').maybeSingle(),
      ]);

      const list = ((rows ?? []) as any[]).map((r) => ({
        ...r,
        amount: Number(r.amount) || 0,
        runs_completed: Number(r.runs_completed) || 0,
      })) as AutoPayout[];

      const ids = Array.from(new Set(list.map((s) => s.recipient_id)));
      if (ids.length) {
        const { data: people } = await supabase
          .from('profiles')
          .select('id, full_name, phone')
          .in('id', ids);
        const byId = new Map((people ?? []).map((p: any) => [p.id, p.full_name || p.phone || 'Welile user']));
        list.forEach((s) => {
          s.recipientName = byId.get(s.recipient_id) as string | undefined;
        });
      }

      setSchedules(list);
      setCap(config ? Number((config as any).auto_approval_cap) : null);
    } finally {
      setLoading(false);
    }
  }, [user?.id]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const create = useCallback(
    async (input: {
      recipientId: string;
      amount: number;
      frequency: AutoPayoutFrequency;
      dayOfWeek?: number;
      dayOfMonth?: number;
      description?: string;
    }) => {
      const { data, error } = await (supabase.rpc as any)('create_wallet_transfer_schedule', {
        p_recipient_id: input.recipientId,
        p_amount: input.amount,
        p_frequency: input.frequency,
        p_day_of_week: input.frequency === 'weekly' ? (input.dayOfWeek ?? 1) : null,
        p_day_of_month: input.frequency === 'monthly' ? (input.dayOfMonth ?? 1) : null,
        p_description: input.description ?? null,
      });
      if (error) throw new Error(error.message);
      await refresh();
      return data as AutoPayout;
    },
    [refresh],
  );

  const setState = useCallback(
    async (id: string, state: 'active' | 'paused' | 'cancelled') => {
      const { error } = await (supabase.rpc as any)('set_wallet_transfer_schedule_state', {
        p_schedule_id: id,
        p_state: state,
      });
      if (error) throw new Error(error.message);
      await refresh();
    },
    [refresh],
  );

  return { schedules, cap, loading, refresh, create, setState };
}
