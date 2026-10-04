import { useEffect, useState, useCallback } from 'react';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/hooks/useAuth';
import { formatUGX } from '@/lib/rentCalculations';
import { Clock, FileText, RefreshCw, AlertTriangle, Hourglass } from 'lucide-react';

/**
 * "Pending Receipt" panel for agents — surfaces their OWN deposit requests
 * that are linked to a MoMo TID / email receipt but have not yet been
 * credited as float. Shows submission time, link time, elapsed wait,
 * and any error hint (rejection_reason / auto_match_audit.last_error)
 * so the agent knows whether to wait, retry, or contact FinOps.
 */
interface PendingReceipt {
  id: string;
  amount: number;
  status: string;
  created_at: string;
  updated_at: string;
  transaction_id: string | null;
  rejection_reason: string | null;
  audit_flagged: boolean | null;
  auto_match_audit: any;
  deposit_purpose: string | null;
}

function timeAgo(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const m = Math.floor(ms / 60_000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m ago`;
  return `${Math.floor(h / 24)}d ago`;
}

function extractErrorHint(row: PendingReceipt): string | null {
  if (row.rejection_reason) return row.rejection_reason;
  const audit = row.auto_match_audit;
  if (audit && typeof audit === 'object') {
    if (typeof audit.last_error === 'string') return audit.last_error;
    if (Array.isArray(audit.attempts) && audit.attempts.length > 0) {
      const last = audit.attempts[audit.attempts.length - 1];
      if (last && typeof last.error === 'string') return last.error;
    }
  }
  return null;
}

export function AgentPendingReceiptPanel() {
  const { user } = useAuth();
  const [rows, setRows] = useState<PendingReceipt[]>([]);
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  const fetchRows = useCallback(async () => {
    if (!user) return;
    const { data, error } = await supabase
      .from('deposit_requests')
      .select('id, amount, status, created_at, updated_at, transaction_id, rejection_reason, audit_flagged, auto_match_audit, deposit_purpose')
      .eq('user_id', user.id)
      .eq('status', 'pending')
      .not('transaction_id', 'is', null)
      .order('created_at', { ascending: false })
      .limit(10);
    if (!error) setRows((data ?? []) as PendingReceipt[]);
  }, [user]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    fetchRows().finally(() => {
      if (!cancelled) setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [fetchRows]);

  // Realtime: any change on this agent's deposit_requests refreshes the list
  useEffect(() => {
    if (!user) return;
    const channel = supabase
      .channel(`agent-pending-receipt-${user.id}`)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'deposit_requests', filter: `user_id=eq.${user.id}` },
        () => fetchRows(),
      )
      .subscribe();
    return () => {
      supabase.removeChannel(channel);
    };
  }, [user, fetchRows]);

  // Ticker so elapsed-time labels stay live
  const [, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 30_000);
    return () => clearInterval(id);
  }, []);

  if (loading && rows.length === 0) return null;
  if (rows.length === 0) return null;

  const handleRefresh = async () => {
    setRefreshing(true);
    try {
      await fetchRows();
    } finally {
      setRefreshing(false);
    }
  };

  return (
    <Card className="border-amber-300/60 bg-amber-50/40 dark:bg-amber-950/10">
      <CardContent className="p-4 space-y-3">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <Hourglass className="h-4 w-4 text-amber-600" />
            <p className="text-sm font-semibold">Pending receipt</p>
            <Badge variant="secondary" className="text-[10px]">{rows.length}</Badge>
          </div>
          <Button
            variant="ghost"
            size="sm"
            className="h-7 px-2 text-xs"
            onClick={handleRefresh}
            disabled={refreshing}
          >
            <RefreshCw className={`h-3.5 w-3.5 mr-1 ${refreshing ? 'animate-spin' : ''}`} />
            Refresh
          </Button>
        </div>
        <p className="text-[11px] text-muted-foreground -mt-1">
          Linked to MoMo receipt — waiting to be credited to your float.
        </p>

        <div className="space-y-2">
          {rows.map((row) => {
            const errorHint = extractErrorHint(row);
            const linkedAt = row.updated_at && row.updated_at !== row.created_at ? row.updated_at : null;
            const waitMin = Math.floor((Date.now() - new Date(row.created_at).getTime()) / 60_000);
            const stale = waitMin >= 5;
            return (
              <div
                key={row.id}
                className="rounded-lg border bg-card p-3 space-y-2"
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="font-semibold text-sm tabular-nums">{formatUGX(Number(row.amount) || 0)}</p>
                    {row.transaction_id && (
                      <p className="text-[11px] text-muted-foreground font-mono truncate">
                        TID {row.transaction_id}
                      </p>
                    )}
                  </div>
                  <div className="text-right">
                    {row.audit_flagged ? (
                      <Badge variant="destructive" className="text-[10px]">Flagged</Badge>
                    ) : stale ? (
                      <Badge className="bg-amber-500 hover:bg-amber-500 text-white text-[10px]">Awaiting credit</Badge>
                    ) : (
                      <Badge variant="secondary" className="text-[10px]">Processing</Badge>
                    )}
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-2 text-[11px] text-muted-foreground">
                  <div className="flex items-center gap-1">
                    <FileText className="h-3 w-3" />
                    <span>Submitted {timeAgo(row.created_at)}</span>
                  </div>
                  <div className="flex items-center gap-1 justify-end">
                    <Clock className="h-3 w-3" />
                    <span>
                      {linkedAt ? `Linked ${timeAgo(linkedAt)}` : `Waiting ${waitMin}m`}
                    </span>
                  </div>
                </div>

                {errorHint && (
                  <div className="flex items-start gap-2 rounded-md bg-destructive/10 text-destructive p-2 text-[11px]">
                    <AlertTriangle className="h-3.5 w-3.5 mt-0.5 shrink-0" />
                    <span className="leading-snug break-words">{errorHint}</span>
                  </div>
                )}

                {!errorHint && stale && (
                  <p className="text-[11px] text-amber-700 dark:text-amber-400 leading-snug">
                    Receipt linked but credit hasn’t posted yet. The system auto-retries every minute.
                    If it stays here past 10 minutes, contact Financial Ops with the TID above.
                  </p>
                )}
              </div>
            );
          })}
        </div>
      </CardContent>
    </Card>
  );
}
