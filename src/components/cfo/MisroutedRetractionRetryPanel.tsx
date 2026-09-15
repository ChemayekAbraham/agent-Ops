import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useToast } from '@/hooks/use-toast';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Loader2, RotateCcw, AlertTriangle, CheckCircle2 } from 'lucide-react';
import { format } from 'date-fns';
import { CfoApprovalGate } from '@/components/cfo/CfoApprovalGate';

/**
 * MisroutedRetractionRetryPanel
 *
 * Lists recent CFO Direct Debits (wallet retractions / balance corrections)
 * that were posted with `recipient_type = 'operational_wallet'` and therefore
 * landed on the user's Float bucket instead of their Withdrawable balance —
 * the exact bug that left LWEGABA ENOCK EUGINE's wallet unchanged.
 *
 * Provides a single "Retry with correct recipient" button that re-posts the
 * SAME debit with `recipient_type: 'user'`, so it actually reduces the
 * recipient's Withdrawable balance. The original mis-routed entry is left
 * in place for audit; the retry's reason carries the original ref id.
 *
 * Scope: last 7 days of `cfo_direct_debit` audit_log rows where
 *   metadata.recipient_type = 'operational_wallet'
 *   AND metadata.wallet_category = 'system_balance_correction'
 * (i.e. retractions / balance corrections — NOT legitimate float reductions
 * like agent float reversals).
 */

interface MisroutedRow {
  id: string;
  created_at: string;
  metadata: {
    amount?: number;
    target_user_id?: string;
    target_name?: string;
    reference_id?: string;
    reason?: string;
    category_label?: string;
    wallet_category?: string;
    recipient_type?: string;
    retry_of_audit_id?: string;
  } | null;
}

export function MisroutedRetractionRetryPanel() {
  const { toast } = useToast();
  const qc = useQueryClient();
  const [retryingId, setRetryingId] = useState<string | null>(null);

  // 1. Pull misrouted debits (last 7 days).
  // 2. Pull audit_logs that retried any of them (so we can hide already-fixed rows).
  const { data, isLoading, refetch } = useQuery({
    queryKey: ['cfo-misrouted-retractions'],
    queryFn: async () => {
      const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
      const { data: rows, error } = await supabase
        .from('audit_logs')
        .select('id, created_at, metadata')
        .eq('action_type', 'cfo_direct_debit')
        .gte('created_at', since)
        .order('created_at', { ascending: false })
        .limit(200);
      if (error) throw error;

      const misrouted = (rows ?? []).filter((r: any) => {
        const m = r.metadata ?? {};
        return (
          m.recipient_type === 'operational_wallet' &&
          m.wallet_category === 'system_balance_correction' &&
          !m.retry_of_audit_id // not itself a retry row
        );
      }) as MisroutedRow[];

      // Already-fixed = there exists a later cfo_direct_debit whose
      // metadata.retry_of_audit_id == this row's id.
      const retriedIds = new Set(
        (rows ?? [])
          .map((r: any) => r.metadata?.retry_of_audit_id)
          .filter(Boolean) as string[],
      );

      return misrouted.map((r) => ({ ...r, alreadyRetried: retriedIds.has(r.id) }));
    },
    staleTime: 30_000,
  });

  const retry = useMutation({
    mutationFn: async (row: MisroutedRow) => {
      const m = row.metadata ?? {};
      const amount = Number(m.amount ?? 0);
      const targetUserId = m.target_user_id;
      if (!targetUserId || !amount || amount <= 0) {
        throw new Error('Missing target_user_id or amount in original audit row.');
      }
      const originalReason = (m.reason || 'Wallet correction').trim();
      const newReason = `Re-routed retraction (was Float, now Withdrawable). Original ref: ${
        m.reference_id ?? row.id
      }. ${originalReason}`.slice(0, 480);

      const { data, error } = await supabase.functions.invoke('cfo-direct-credit', {
        body: {
          target_user_id: targetUserId,
          amount,
          operation: 'debit',
          recipient_type: 'user', // ← the whole point of this retry
          category: 'wallet_retraction',
          wallet_category: 'system_balance_correction',
          platform_category: 'system_balance_correction',
          reason: newReason,
          metadata: {
            retry_of_audit_id: row.id,
            original_reference_id: m.reference_id ?? null,
            original_recipient_type: 'operational_wallet',
          },
        },
      });
      if (error) throw error;
      return data;
    },
    onMutate: (row) => setRetryingId(row.id),
    onSuccess: () => {
      toast({
        title: '✅ Retraction re-routed',
        description: "Re-posted with recipient_type='user'. The user's withdrawable balance has been reduced.",
      });
      qc.invalidateQueries({ queryKey: ['cfo-misrouted-retractions'] });
      qc.invalidateQueries({ queryKey: ['cfo-wallet-deductions'] });
      void refetch();
    },
    onError: (e: any) => {
      toast({
        title: 'Retry failed',
        description: e?.message ?? 'Could not re-route the retraction.',
        variant: 'destructive',
      });
    },
    onSettled: () => setRetryingId(null),
  });

  if (isLoading) {
    return (
      <Card>
        <CardContent className="flex items-center justify-center py-6">
          <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
        </CardContent>
      </Card>
    );
  }

  const rows = data ?? [];
  const pending = rows.filter((r) => !r.alreadyRetried);

  if (rows.length === 0) {
    return null; // nothing to surface — keep the dashboard quiet
  }

  return (
    <Card className="border-amber-300">
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-semibold flex items-center gap-2 text-amber-900">
          <AlertTriangle className="h-4 w-4" />
          Mis-routed Retractions (last 7 days)
          <Badge variant="outline" className="ml-1 text-[10px] border-amber-300 text-amber-800">
            {pending.length} need retry
          </Badge>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-2">
        <p className="text-[11px] text-muted-foreground -mt-1">
          These debits were posted with <code className="text-[10px]">recipient_type=operational_wallet</code>, so they
          landed on Float instead of the user's Withdrawable balance. One click re-posts the same debit with the
          correct recipient.
        </p>
        {rows.map((row) => {
          const m = row.metadata ?? {};
          const amount = Number(m.amount ?? 0);
          const fixed = row.alreadyRetried;
          return (
            <div
              key={row.id}
              className={`flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 rounded-md border p-2.5 text-xs ${
                fixed ? 'border-emerald-200 bg-emerald-50/50' : 'border-amber-200 bg-amber-50/40'
              }`}
            >
              <div className="min-w-0">
                <div className="font-medium truncate">
                  {m.target_name || m.target_user_id || 'Unknown user'}
                </div>
                <div className="text-muted-foreground text-[10px] mt-0.5">
                  UGX {amount.toLocaleString()} · {format(new Date(row.created_at), 'dd MMM, HH:mm')}
                  {m.reference_id ? ` · ${m.reference_id}` : ''}
                </div>
                {m.reason && (
                  <div className="text-[10px] text-muted-foreground/80 mt-0.5 line-clamp-1">
                    “{m.reason}”
                  </div>
                )}
              </div>
              <div className="shrink-0">
                {fixed ? (
                  <Badge variant="outline" className="border-emerald-300 text-emerald-700 gap-1">
                    <CheckCircle2 className="h-3 w-3" />
                    Already retried
                  </Badge>
                ) : (
                  <CfoApprovalGate>
                  <Button
                    size="sm"
                    variant="default"
                    className="bg-amber-600 hover:bg-amber-700 text-white gap-1.5 h-8"
                    disabled={retry.isPending && retryingId === row.id}
                    onClick={() => retry.mutate(row)}
                    title="Re-post this debit with recipient_type='user' so it actually reduces the user's withdrawable balance."
                  >
                    {retry.isPending && retryingId === row.id ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <RotateCcw className="h-3.5 w-3.5" />
                    )}
                    Retry with correct recipient
                  </Button>
                  </CfoApprovalGate>
                )}
              </div>
            </div>
          );
        })}
      </CardContent>
    </Card>
  );
}
