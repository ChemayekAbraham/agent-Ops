import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { AlertTriangle, BookOpen, RefreshCw } from 'lucide-react';
import { formatDistanceToNowStrict, format } from 'date-fns';
import { Button } from '@/components/ui/button';

const SILENCE_THRESHOLD_MS = 2 * 60 * 60 * 1000; // 2 hours

/**
 * Surfaces a loud FinOps banner when no MoMo receipt email (MTN / Airtel) has
 * been ingested for more than 2 hours — the signal that the SMS -> Gmail
 * forwarder on the merchant phone has stopped, so deposits will not auto-credit.
 */
export function MomoFeedSilenceAlert() {
  const { data, isLoading, refetch, isFetching } = useQuery({
    queryKey: ['momo-feed-silence'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('gmail_transactions')
        .select('internal_date, created_at, channel, transaction_id, amount')
        .in('channel', ['mtn_momo', 'airtel_money'])
        .order('internal_date', { ascending: false, nullsFirst: false })
        .limit(1);
      if (error) throw error;
      const row = data?.[0];
      const ts = row?.internal_date ?? row?.created_at ?? null;
      return { lastAt: ts ? new Date(ts) : null, row: row ?? null };
    },
    refetchInterval: 5 * 60 * 1000,
    staleTime: 60_000,
  });

  if (isLoading || !data) return null;

  const { lastAt, row } = data;
  const silentMs = lastAt ? Date.now() - lastAt.getTime() : Number.POSITIVE_INFINITY;
  if (silentMs < SILENCE_THRESHOLD_MS) return null;

  return (
    <div
      role="alert"
      className="rounded-xl border border-destructive/40 bg-destructive/5 p-4 space-y-2"
    >
      <div className="flex items-start gap-3">
        <AlertTriangle className="h-5 w-5 text-destructive shrink-0 mt-0.5" />
        <div className="flex-1 min-w-0">
          <p className="text-sm font-semibold text-destructive">
            MoMo feed silent{lastAt ? ` for ${formatDistanceToNowStrict(lastAt)}` : ''}
          </p>
          <p className="text-xs text-muted-foreground mt-1">
            {lastAt ? (
              <>
                Last MoMo receipt email arrived{' '}
                <span className="font-medium text-foreground">
                  {format(lastAt, 'dd MMM yyyy HH:mm')}
                </span>
                {row?.transaction_id ? ` (TID ${row.transaction_id})` : ''}.
              </>
            ) : (
              'No MoMo receipt email has ever been ingested.'
            )}{' '}
            Agent float deposits will not auto-credit until the SMS forwarder on the
            merchant phone resumes.
          </p>
          <div className="flex flex-wrap items-center gap-2 pt-2">
            <Button asChild size="sm" variant="outline" className="h-8 text-xs">
              <a href="/MOMO_FEED_RUNBOOK.md" target="_blank" rel="noopener noreferrer">
                <BookOpen className="h-3.5 w-3.5 mr-1.5" />
                Open runbook
              </a>
            </Button>
            <Button
              size="sm"
              variant="ghost"
              className="h-8 text-xs"
              onClick={() => refetch()}
              disabled={isFetching}
            >
              <RefreshCw className={`h-3.5 w-3.5 mr-1.5 ${isFetching ? 'animate-spin' : ''}`} />
              Re-check
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}