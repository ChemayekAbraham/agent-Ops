import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/hooks/useAuth';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { formatUGX } from '@/lib/rentCalculations';
import { History, Smartphone } from 'lucide-react';

const RESPONSE_STYLES: Record<string, { label: string; className: string }> = {
  accepted: { label: 'Accepted', className: 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-400' },
  ignored: { label: 'Ignored', className: 'bg-muted text-muted-foreground' },
  superseded: { label: 'Claimed by other', className: 'bg-amber-500/15 text-amber-700 dark:text-amber-500' },
  expired: { label: 'Expired', className: 'bg-red-500/15 text-red-600 dark:text-red-400' },
  pending: { label: 'Pending', className: 'bg-primary/15 text-primary' },
};

/**
 * The merchant agent's own dispatch alert history — a complete audit trail of
 * every withdrawal they were notified about, the channel, and the outcome.
 */
export function MerchantDispatchHistory() {
  const { user } = useAuth();

  const { data: rows = [], isLoading } = useQuery({
    queryKey: ['merchant-dispatch-history', user?.id],
    enabled: !!user?.id,
    staleTime: 30_000,
    queryFn: async () => {
      const { data } = await supabase
        .from('withdrawal_notification_log')
        .select('id, withdrawal_id, amount, channel, response, dispatch_round, created_at, claimed_at')
        .eq('recipient_id', user!.id)
        .eq('channel', 'push')
        .order('created_at', { ascending: false })
        .limit(50);
      return data ?? [];
    },
  });

  return (
    <Card className="rounded-2xl p-4">
      <div className="mb-3 flex items-center gap-2">
        <History className="h-4 w-4 text-primary" />
        <h3 className="text-sm font-bold">Dispatch history</h3>
      </div>

      {isLoading ? (
        <p className="py-6 text-center text-sm text-muted-foreground">Loading…</p>
      ) : rows.length === 0 ? (
        <p className="py-6 text-center text-sm text-muted-foreground">
          No withdrawal alerts yet. Stay online to receive requests.
        </p>
      ) : (
        <ul className="space-y-2">
          {rows.map((r) => {
            const resp = RESPONSE_STYLES[(r.response as string) ?? 'pending'] ?? RESPONSE_STYLES.pending;
            return (
              <li
                key={r.id}
                className="flex items-center justify-between gap-3 rounded-xl border border-border p-2.5"
              >
                <div className="min-w-0">
                  <p className="text-sm font-semibold tabular-nums">
                    {formatUGX(Number(r.amount) || 0)}
                  </p>
                  <p className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
                    <Smartphone className="h-3 w-3" /> Push
                    {r.dispatch_round ? ` · round ${r.dispatch_round}` : ''} ·{' '}
                    {new Date(r.created_at as string).toLocaleString('en-UG', {
                      timeZone: 'Africa/Kampala',
                      month: 'short',
                      day: 'numeric',
                      hour: '2-digit',
                      minute: '2-digit',
                    })}
                  </p>
                </div>
                <Badge className={resp.className} variant="secondary">
                  {resp.label}
                </Badge>
              </li>
            );
          })}
        </ul>
      )}
    </Card>
  );
}

export default MerchantDispatchHistory;
