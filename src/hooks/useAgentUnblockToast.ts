import { useRef } from 'react';
import { toast } from 'sonner';
import { supabase } from '@/integrations/supabase/client';
import { formatUGX } from '@/lib/rentCalculations';
import { usePolling } from '@/hooks/usePolling';

/**
 * Watches `agent_eligibility_unblock_events` for the current agent and shows a
 * celebratory toast the first time they cross the 20% threshold each day.
 * Marks `toast_seen_at` so the toast does not re-fire on every page load.
 *
 * Checks for today's unseen event on mount (catches events that happened
 * while the app was closed) and every 60s + on focus while the dashboard is
 * open. This used to be a Realtime INSERT listener, but the table is not in
 * the publication, so it never fired (doc 147).
 */
export function useAgentUnblockToast(agentId?: string | null) {
  // Event ids already toasted this session — guards the gap between showing
  // the toast and the toast_seen_at write landing.
  const shownRef = useRef<Set<string>>(new Set());

  usePolling(async () => {
    if (!agentId) return;
    const todayKampala = new Date(
      new Date().toLocaleString('en-US', { timeZone: 'Africa/Kampala' }),
    )
      .toISOString()
      .slice(0, 10);
    const { data: row } = await supabase
      .from('agent_eligibility_unblock_events')
      .select('id, paid_today, expected_daily, ratio_pct, active_count, toast_seen_at')
      .eq('agent_id', agentId)
      .eq('kampala_day', todayKampala)
      .is('toast_seen_at', null)
      .order('occurred_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (!row || row.toast_seen_at || shownRef.current.has(row.id)) return;
    shownRef.current.add(row.id);

    const pct = Math.round(Number(row.ratio_pct) || 0);
    toast.success("You're unblocked! 🎉", {
      description:
        `Collected UGX ${formatUGX(row.paid_today)} of UGX ${formatUGX(row.expected_daily)} ` +
        `today (${pct}%) across ${row.active_count} active rents. ` +
        `You can post new rent requests now.`,
      duration: 10_000,
    });
    await supabase
      .from('agent_eligibility_unblock_events')
      .update({ toast_seen_at: new Date().toISOString() })
      .eq('id', row.id);
  }, 60_000, { enabled: !!agentId, immediate: true });
}

export default useAgentUnblockToast;
