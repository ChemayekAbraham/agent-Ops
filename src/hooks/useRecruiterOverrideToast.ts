import { useEffect } from 'react';
import { toast } from 'sonner';
import { supabase } from '@/integrations/supabase/client';
import { formatUGX } from '@/lib/rentCalculations';

const EVENT_LABELS: Record<string, string> = {
  house_listed_verified: 'an empty house your sub-agent listed was verified',
  landlord_verified: 'a landlord your sub-agent registered was verified',
  lc1_chairperson_verified: 'an LC1 chairperson your sub-agent registered was verified',
  tenant_landlord_funded: "your sub-agent's tenant got its landlord funded for the first time",
};

function describe(eventType: string) {
  return EVENT_LABELS[eventType] || 'your sub-agent completed a verified action';
}

/**
 * Watches `recruiter_override_events` for the current recruiting agent and shows
 * a clear success / error toast for each UGX 1,000 override payout.
 * Marks `toast_seen_at` so a toast never re-fires on reload.
 *
 * Fires on:
 *   - initial mount (catches payouts created while the app was closed)
 *   - realtime INSERT (catches payouts created while the dashboard is open)
 */
export function useRecruiterOverrideToast(agentId?: string | null) {
  useEffect(() => {
    if (!agentId) return;

    const showAndMark = async (row: any) => {
      if (!row || row.toast_seen_at) return;

      if (row.status === 'failed') {
        toast.error('Recruiter override could not be paid', {
          description:
            `We tried to pay your UGX ${formatUGX(Number(row.amount) || 1000)} override because ` +
            `${describe(row.event_type)}, but it failed. Our team has been notified.`,
          duration: 10_000,
        });
      } else {
        const amount = formatUGX(Number(row.amount) || 1000);
        toast.success('Recruiter override earned! 🎉', {
          description:
            `You earned UGX ${amount} because ${describe(row.event_type)}` +
            `${row.label ? ` (${row.label})` : ''}.\n` +
            `Breakdown: UGX ${amount} from Welile company funds → added to your withdrawable wallet.`,
          duration: 10_000,
        });
      }

      await supabase
        .from('recruiter_override_events')
        .update({ toast_seen_at: new Date().toISOString() })
        .eq('id', row.id);
    };

    // 1) Catch any unseen events on mount
    (async () => {
      const { data } = await supabase
        .from('recruiter_override_events')
        .select('id, amount, event_type, label, status, toast_seen_at')
        .eq('recruiter_id', agentId)
        .is('toast_seen_at', null)
        .order('occurred_at', { ascending: true })
        .limit(5);
      (data || []).forEach((row) => showAndMark(row));
    })();

    // 2) Realtime: catch payouts created while the dashboard is open
    const channel = supabase
      .channel(`recruiter-override-${agentId}`)
      .on(
        'postgres_changes',
        {
          event: 'INSERT',
          schema: 'public',
          table: 'recruiter_override_events',
          filter: `recruiter_id=eq.${agentId}`,
        },
        (payload) => showAndMark(payload.new),
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [agentId]);
}

export default useRecruiterOverrideToast;