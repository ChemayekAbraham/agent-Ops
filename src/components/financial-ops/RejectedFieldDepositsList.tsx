import { useCallback, useEffect, useState } from 'react';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { formatUGX } from '@/lib/rentCalculations';
import { format } from 'date-fns';
import { toast } from 'sonner';
import { Loader2, RefreshCw, Inbox, RotateCcw, XCircle, User, Wallet } from 'lucide-react';
import { supabase } from '@/integrations/supabase/client';
import {
  channelLabel,
  reopenBatchAsFinOps,
  type DepositChannel,
} from '@/lib/fieldDepositBatches';
import { useFinOpsAutoRefresh } from '@/hooks/useFinOpsAutoRefresh';

/**
 * Rejected field-deposit batches with a "Reopen for review" action. Reopened
 * batches flip back to `pending_finops_verification` and re-appear in the
 * Field Deposits tab where they can be approved (or rejected again).
 */
type RejectedRow =
  | {
      kind: 'field';
      id: string;
      agent_id: string;
      agent_name: string | null;
      channel: DepositChannel;
      amount: number;
      proof_reference: string | null;
      rejection_reason: string | null;
      rejected_by_name: string | null;
      rejected_at: string | null;
    }
  | {
      kind: 'user';
      id: string;
      user_id: string;
      user_name: string | null;
      channel: string | null; // payment_method e.g. 'mtn','airtel','bank'
      amount: number;
      proof_reference: string | null; // tid
      rejection_reason: string | null;
      rejected_by_name: string | null;
      rejected_at: string | null;
      deposit_purpose: string | null;
    };

export function RejectedFieldDepositsList() {
  const autoRefresh = useFinOpsAutoRefresh();
  const [rows, setRows] = useState<RejectedRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [confirmRow, setConfirmRow] = useState<RejectedRow | null>(null);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async (silent = false) => {
    if (!silent) setRefreshing(true);
    try {
      const [batchRes, userRes] = await Promise.all([
        supabase
          .from('field_deposit_batches')
          .select(
            'id, agent_id, channel, declared_total, proof_reference, rejection_reason, finops_verified_by, finops_verified_at',
          )
          .eq('status', 'rejected')
          .order('finops_verified_at', { ascending: false })
          .limit(100),
        supabase
          .from('deposit_requests')
          .select(
            'id, user_id, amount, provider, transaction_id, rejection_reason, processed_by, rejected_at, deposit_purpose',
          )
          .eq('status', 'rejected')
          .order('rejected_at', { ascending: false })
          .limit(100),
      ]);
      if (batchRes.error) throw batchRes.error;
      if (userRes.error) throw userRes.error;
      const batchList = (batchRes.data ?? []) as any[];
      const userList = (userRes.data ?? []) as any[];
      const ids = Array.from(
        new Set([
          ...batchList.map((r) => r.agent_id).filter(Boolean),
          ...batchList.map((r) => r.finops_verified_by).filter(Boolean),
          ...userList.map((r) => r.user_id).filter(Boolean),
          ...userList.map((r) => r.processed_by).filter(Boolean),
        ]),
      );
      const nameMap = new Map<string, string | null>();
      if (ids.length > 0) {
        const { data: profs } = await supabase
          .from('profiles')
          .select('id, full_name')
          .in('id', ids);
        for (const p of (profs ?? []) as any[]) nameMap.set(p.id, p.full_name ?? null);
      }
      const fieldRows: RejectedRow[] = batchList.map((r) => ({
        kind: 'field' as const,
        id: r.id,
        agent_id: r.agent_id,
        agent_name: nameMap.get(r.agent_id) ?? null,
        channel: r.channel as DepositChannel,
        amount: Number(r.declared_total ?? 0),
        proof_reference: r.proof_reference ?? null,
        rejection_reason: r.rejection_reason ?? null,
        rejected_by_name: r.finops_verified_by ? (nameMap.get(r.finops_verified_by) ?? null) : null,
        rejected_at: r.finops_verified_at ?? null,
      }));
      const userRows: RejectedRow[] = userList.map((r) => ({
        kind: 'user' as const,
        id: r.id,
        user_id: r.user_id,
        user_name: nameMap.get(r.user_id) ?? null,
        channel: r.provider ?? null,
        amount: Number(r.amount ?? 0),
        proof_reference: r.transaction_id ?? null,
        rejection_reason: r.rejection_reason ?? null,
        rejected_by_name: r.processed_by ? (nameMap.get(r.processed_by) ?? null) : null,
        rejected_at: r.rejected_at ?? null,
        deposit_purpose: r.deposit_purpose ?? null,
      }));
      const merged = [...fieldRows, ...userRows].sort((a, b) => {
        const ta = a.rejected_at ? new Date(a.rejected_at).getTime() : 0;
        const tb = b.rejected_at ? new Date(b.rejected_at).getTime() : 0;
        return tb - ta;
      });
      setRows(merged);
    } catch (e: any) {
      if (!silent) toast.error(e?.message ?? 'Failed to load rejected deposits');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    load();
    if (!autoRefresh) return;
    const id = setInterval(() => load(true), 30000);
    return () => clearInterval(id);
  }, [load, autoRefresh]);

  const handleReopen = async () => {
    if (!confirmRow) return;
    setBusy(true);
    try {
      if (confirmRow.kind === 'field') {
        await reopenBatchAsFinOps(confirmRow.id, note.trim());
        toast.success('Reopened — batch is back in the Field Deposits queue.');
      } else {
        const { data, error } = await supabase.functions.invoke('approve-deposit', {
          body: {
            deposit_request_id: confirmRow.id,
            action: 'reopen',
            rejection_reason: note.trim() || 'Reopened for re-review',
          },
        });
        if (error) throw error;
        if (data && (data as any).error) throw new Error((data as any).error);
        toast.success('Reopened — deposit is back in the User Deposits queue.');
      }
      setConfirmRow(null);
      setNote('');
      load(true);
    } catch (e: any) {
      toast.error(e?.message ?? 'Reopen failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs sm:text-sm text-muted-foreground">
          Rejected field-deposit batches. Reopen to put a batch back in the
          Field Deposits queue for re-review &amp; approval.
        </p>
        <Button
          variant="outline"
          size="sm"
          onClick={() => load()}
          disabled={refreshing}
          className="gap-1.5"
        >
          {refreshing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
          Refresh
        </Button>
      </div>

      {loading ? (
        <Card><CardContent className="p-6 flex items-center justify-center text-sm text-muted-foreground gap-2">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading…
        </CardContent></Card>
      ) : rows.length === 0 ? (
        <Card><CardContent className="p-8 text-center space-y-1.5">
          <Inbox className="h-8 w-8 text-muted-foreground mx-auto" />
          <div className="text-sm font-medium">No rejected deposits</div>
          <div className="text-xs text-muted-foreground">
            Rejected batches will appear here for re-review.
          </div>
        </CardContent></Card>
      ) : (
        <div className="space-y-2">
          {rows.map((r) => (
            <Card key={`${r.kind}:${r.id}`} className="border-destructive/20">
              <CardContent className="p-3 sm:p-4 space-y-2.5">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-semibold text-sm truncate">
                        {r.kind === 'field'
                          ? (r.agent_name ?? r.agent_id.slice(0, 8))
                          : (r.user_name ?? r.user_id.slice(0, 8))}
                      </span>
                      <Badge variant="outline" className="text-[10px] gap-1">
                        {r.kind === 'field' ? <Wallet className="h-3 w-3" /> : <User className="h-3 w-3" />}
                        {r.kind === 'field' ? 'Field deposit' : 'User deposit'}
                      </Badge>
                      {r.channel && (
                        <Badge variant="outline" className="text-[10px]">
                          {r.kind === 'field'
                            ? channelLabel(r.channel as DepositChannel)
                            : (r.channel ?? '').toUpperCase()}
                        </Badge>
                      )}
                      <Badge variant="destructive" className="text-[10px] gap-1">
                        <XCircle className="h-3 w-3" /> Rejected
                      </Badge>
                    </div>
                    <div className="text-xs text-muted-foreground mt-0.5 font-mono">
                      {r.kind === 'field' ? 'Ref' : 'TID'}: {r.proof_reference ?? '—'}
                    </div>
                    {r.kind === 'user' && r.deposit_purpose && (
                      <div className="text-[11px] text-muted-foreground mt-0.5">
                        Purpose: <span className="text-foreground">{r.deposit_purpose.replace(/_/g, ' ')}</span>
                      </div>
                    )}
                  </div>
                  <div className="font-mono font-semibold text-sm whitespace-nowrap">
                    {formatUGX(r.amount)}
                  </div>
                </div>

                {r.rejection_reason && (
                  <div className="rounded-md bg-destructive/5 border border-destructive/20 px-2.5 py-1.5">
                    <div className="text-[10px] uppercase tracking-wide text-destructive/80 font-semibold">
                      Rejection reason
                    </div>
                    <div className="text-xs text-foreground mt-0.5">{r.rejection_reason}</div>
                  </div>
                )}

                <div className="flex items-center justify-between gap-2 text-[11px] text-muted-foreground">
                  <span>
                    Rejected by {r.rejected_by_name ?? '—'}
                    {r.rejected_at ? ` · ${format(new Date(r.rejected_at), 'MMM d, HH:mm')}` : ''}
                  </span>
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-7 px-2.5 gap-1.5 text-xs"
                    onClick={() => { setConfirmRow(r); setNote(''); }}
                  >
                    <RotateCcw className="h-3.5 w-3.5" />
                    Reopen for review
                  </Button>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      <AlertDialog open={confirmRow !== null} onOpenChange={(o) => { if (!o && !busy) setConfirmRow(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Reopen this rejected {confirmRow?.kind === 'field' ? 'batch' : 'deposit'}?
            </AlertDialogTitle>
            <AlertDialogDescription>
              {confirmRow?.kind === 'field' ? (
                <>The batch will move back to <span className="font-semibold">Pending Finance review</span> in the Field Deposits queue. You can then approve it (which will credit the agent&apos;s float and post commission) or reject it again.</>
              ) : (
                <>The deposit will move back to <span className="font-semibold">Pending</span> in the User Deposits queue, where you can re-verify the TID and approve (crediting the user&apos;s wallet) or reject again.</>
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div className="space-y-1.5">
            <Label className="text-xs">Note (optional, audited)</Label>
            <Textarea
              rows={2}
              placeholder="Why are you reopening? e.g. proof now found in MTN portal"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              disabled={busy}
            />
          </div>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={handleReopen} disabled={busy}>
              {busy ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <RotateCcw className="h-4 w-4 mr-2" />}
              Reopen
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}