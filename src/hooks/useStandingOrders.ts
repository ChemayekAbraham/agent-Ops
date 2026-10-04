import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { logStandingOrderAction } from '@/lib/standingOrderAudit';

export type StandingOrderHealth = 'ok' | 'failing' | 'orphaned' | 'stalled';

export interface StandingOrderRow {
  id: string;
  target_user_id: string;
  target_name: string | null;
  target_phone: string | null;
  target_missing: boolean;
  amount: number;
  category_id: string;
  sub_category: string | null;
  reason: string;
  frequency: string;
  day_of_month: number | null;
  day_of_week: number | null;
  interval_days: number | null;
  enabled: boolean;
  created_at: string;
  next_run_at: string | null;
  last_run_at: string | null;
  last_run_status: string | null;
  last_run_error: string | null;
  consecutive_failures: number;
  health: StandingOrderHealth;
}

// A standing order whose next_run_at has drifted this far into the past with
// no failure on record either was never picked up by the daily sweep, or the
// "already paid this cycle" skip path silently stopped advancing it.
const STALLED_THRESHOLD_MS = 36 * 60 * 60 * 1000;

export function useStandingOrders() {
  return useQuery({
    queryKey: ['cfo-standing-orders'],
    queryFn: async (): Promise<StandingOrderRow[]> => {
      const { data: orders, error } = await supabase
        .from('scheduled_payouts')
        .select('*')
        .order('created_at', { ascending: false });
      if (error) throw error;
      const rows = orders ?? [];
      if (!rows.length) return [];

      const targetIds = Array.from(new Set(rows.map((r) => r.target_user_id).filter(Boolean)));
      const { data: profiles } = await supabase
        .from('profiles')
        .select('id, full_name, phone')
        .in('id', targetIds);
      const profileMap = new Map((profiles ?? []).map((p) => [p.id, p]));

      const orderIds = rows.map((r) => r.id);
      const { data: runs } = await supabase
        .from('scheduled_payout_runs')
        .select('scheduled_payout_id, status, error_message, ran_at')
        .in('scheduled_payout_id', orderIds)
        .order('ran_at', { ascending: false });

      const runsByOrder = new Map<string, NonNullable<typeof runs>>();
      (runs ?? []).forEach((run) => {
        if (!run.scheduled_payout_id) return;
        const list = runsByOrder.get(run.scheduled_payout_id) ?? [];
        list.push(run);
        runsByOrder.set(run.scheduled_payout_id, list);
      });

      const now = Date.now();

      return rows.map((r): StandingOrderRow => {
        const profile = profileMap.get(r.target_user_id);
        const targetMissing = !profile;
        const orderRuns = runsByOrder.get(r.id) ?? [];
        const latest = orderRuns[0] as { status: string; error_message: string | null; ran_at: string } | undefined;

        let consecutiveFailures = 0;
        for (const run of orderRuns) {
          if (run.status === 'failed') consecutiveFailures++;
          else break;
        }

        const overdueMs = r.next_run_at ? now - new Date(r.next_run_at).getTime() : 0;

        let health: StandingOrderHealth = 'ok';
        if (targetMissing) health = 'orphaned';
        else if (consecutiveFailures > 0) health = 'failing';
        else if (r.enabled && overdueMs > STALLED_THRESHOLD_MS) health = 'stalled';

        return {
          id: r.id,
          target_user_id: r.target_user_id,
          target_name: profile?.full_name ?? null,
          target_phone: profile?.phone ?? null,
          target_missing: targetMissing,
          amount: r.amount,
          category_id: r.category_id,
          sub_category: r.sub_category,
          reason: r.reason,
          frequency: r.frequency,
          day_of_month: r.day_of_month,
          day_of_week: r.day_of_week,
          interval_days: r.interval_days,
          enabled: r.enabled,
          created_at: r.created_at,
          next_run_at: r.next_run_at,
          last_run_at: r.last_run_at,
          last_run_status: latest?.status ?? null,
          last_run_error: latest?.error_message ?? null,
          consecutive_failures: consecutiveFailures,
          health,
        };
      });
    },
    staleTime: 30_000,
  });
}

export function useSetStandingOrderEnabled() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ order, enabled }: { order: StandingOrderRow; enabled: boolean }) => {
      const { error } = await supabase
        .from('scheduled_payouts')
        .update({ enabled, updated_at: new Date().toISOString() })
        .eq('id', order.id);
      if (error) throw error;

      await logStandingOrderAction({
        scheduledPayoutId: order.id,
        action: enabled ? 'resume' : 'pause',
        targetUserId: order.target_user_id,
        recipientName: order.target_name,
        amount: order.amount,
        reason: order.reason,
      });
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['cfo-standing-orders'] }),
  });
}
