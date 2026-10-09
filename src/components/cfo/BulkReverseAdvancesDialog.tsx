import { safeUUID } from '@/lib/safeUUID';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { toast } from 'sonner';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import { Progress } from '@/components/ui/progress';
import { ScrollArea } from '@/components/ui/scroll-area';
import { formatUGX } from '@/lib/agentAdvanceCalculations';
import { Checkbox } from '@/components/ui/checkbox';
import { Undo2, Loader2, Download } from 'lucide-react';

/** Server-calculated plan for one advance — never derived on the client. */
export interface BulkPlanRow {
  advance_id: string;
  agent_id: string;
  agent_name: string | null;
  agent_phone: string | null;
  already_reversed: boolean;
  approved_today: boolean;
  has_request: boolean;
  principal: number;
  disbursed_amount: number;
  clawback_posted_amount: number;
  amount_to_reverse: number;
  withdrawable: number;
  recoverable_now: number;
  shortfall: number;
}

interface ExecResult {
  advance_id: string;
  agent_name?: string | null;
  outcome: 'reversed' | 'partial_recovery' | 'skipped' | 'error';
  recovered?: number;
  /** Amount actually debited from the wallet on this run (returns to available funds). */
  returned_to_available?: number;
  shortfall?: number;
  disbursed?: number;
  outstanding_after?: number;
  message?: string;
}


interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Explicit selection. When omitted, today's un-reversed advances are used. */
  advanceIds?: string[] | null;
  onSuccess?: () => void;
}

const CHUNK = 25;

/**
 * Bulk reversal of disbursed agent advances.
 *
 * Every figure shown (Disbursed / Already recovered / To reverse / Recoverable
 * now / Shortfall) comes from `advance_reversal_plan_batch` — the authoritative
 * approval, disbursement and ledger records. The CFO never types an amount.
 * Execution is chunked through the `bulk-reverse-agent-advances` function, which
 * runs the same CFO Direct Debit clawback + `reverse_agent_advance` pair the
 * single-advance dialog uses, sharing one clawback group id for the batch.
 */
export function BulkReverseAdvancesDialog({ open, onOpenChange, advanceIds, onSuccess }: Props) {
  const [reason, setReason] = useState('');
  const [confirmCount, setConfirmCount] = useState('');
  const [debitAuthorized, setDebitAuthorized] = useState(false);
  const [running, setRunning] = useState(false);
  const [done, setDone] = useState(0);
  const [planLoaded, setPlanLoaded] = useState(0);
  const [planTotal, setPlanTotal] = useState(0);
  const [results, setResults] = useState<ExecResult[] | null>(null);
  const groupIdRef = useRef<string | null>(null);

  const explicitIds = advanceIds && advanceIds.length > 0 ? advanceIds : null;

  /**
   * The plan is loaded in 25-advance slices. `advance_reversal_plan_batch`
   * recomputes each agent's strict withdrawable balance, so asking for ~200
   * advances in one round trip exceeds the 8s statement timeout for the
   * authenticated role — that timeout was what left this dialog empty (and the
   * Reverse button permanently disabled) instead of showing the preview.
   */
  const { data: planRows, isLoading, isError, error, refetch } = useQuery({
    queryKey: ['advance-reversal-plan-batch', explicitIds ?? 'today'],
    enabled: open,
    retry: 0,
    queryFn: async (): Promise<BulkPlanRow[]> => {
      let ids = explicitIds;
      if (!ids) {
        // Today's un-reversed advances, Kampala day boundary (UTC+3, no DST).
        const shifted = new Date(Date.now() + 3 * 60 * 60 * 1000);
        const dayStart = new Date(
          Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate()) - 3 * 60 * 60 * 1000,
        );
        const { data: list, error: listError } = await supabase
          .from('agent_advances')
          .select('id')
          .is('reversed_at', null)
          .gte('issued_at', dayStart.toISOString());
        if (listError) throw listError;
        ids = (list ?? []).map((r) => r.id as string);
      }
      setPlanTotal(ids.length);
      setPlanLoaded(0);
      const out: BulkPlanRow[] = [];
      for (let i = 0; i < ids.length; i += CHUNK) {
        const slice = ids.slice(i, i + CHUNK);
        const { data, error: rpcError } = await supabase.rpc('advance_reversal_plan_batch', {
          p_advance_ids: slice,
          p_today_only: false,
        });
        if (rpcError) throw rpcError;
        out.push(...(((data as any)?.rows ?? []) as BulkPlanRow[]));
        setPlanLoaded(Math.min(ids.length, i + slice.length));
      }
      return out;
    },
  });

  const rows: BulkPlanRow[] = useMemo(() => {
    const all = ((planRows ?? []) as BulkPlanRow[]).map((r) => ({
      ...r,
      principal: Number(r.principal || 0),
      disbursed_amount: Number(r.disbursed_amount || 0),
      clawback_posted_amount: Number(r.clawback_posted_amount || 0),
      amount_to_reverse: Number(r.amount_to_reverse || 0),
      withdrawable: Number(r.withdrawable || 0),
      recoverable_now: Number(r.recoverable_now || 0),
      shortfall: Number(r.shortfall || 0),
    }));
    return all;
  }, [planRows]);


  const eligible = useMemo(
    () => rows.filter((r) => !r.already_reversed && r.approved_today && r.has_request),
    [rows],
  );
  const blocked = rows.length - eligible.length;

  const totals = useMemo(
    () => ({
      count: eligible.length,
      disbursed: eligible.reduce((s, r) => s + r.disbursed_amount, 0),
      toReverse: eligible.reduce((s, r) => s + r.amount_to_reverse, 0),
      recoverable: eligible.reduce((s, r) => s + r.recoverable_now, 0),
      shortfall: eligible.reduce((s, r) => s + r.shortfall, 0),
    }),
    [eligible],
  );

  useEffect(() => {
    if (open) {
      setReason('');
      setConfirmCount('');
      setDebitAuthorized(false);
      setResults(null);
      setDone(0);
      groupIdRef.current = null;
    }
  }, [open]);

  const canRun =
    !running &&
    !isLoading &&
    !isError &&
    eligible.length > 0 &&
    reason.trim().length >= 10 &&
    debitAuthorized &&
    confirmCount.trim() === String(eligible.length);


  const run = async () => {
    if (!canRun) return;
    setRunning(true);
    setResults(null);
    setDone(0);
    const groupId = groupIdRef.current ?? safeUUID();
    groupIdRef.current = groupId;
    const collected: ExecResult[] = [];

    try {
      for (let i = 0; i < eligible.length; i += CHUNK) {
        const chunk = eligible.slice(i, i + CHUNK).map((r) => r.advance_id);
        const { data: res, error } = await supabase.functions.invoke('bulk-reverse-agent-advances', {
          body: { advance_ids: chunk, reason: reason.trim(), clawback_group_id: groupId },
        });
        if (error) throw new Error((error as any)?.message || 'Bulk reversal failed');
        if ((res as any)?.error) throw new Error((res as any).error);
        collected.push(...(((res as any)?.results ?? []) as ExecResult[]));
        setDone(Math.min(eligible.length, i + chunk.length));
        setResults([...collected]);
      }

      const reversed = collected.filter((r) => r.outcome === 'reversed');
      const partial = collected.filter((r) => r.outcome === 'partial_recovery');
      const returnedToTreasury = collected.reduce((s, r) => s + Number(r.returned_to_available || 0), 0);
      const short = collected.reduce((s, r) => s + Number(r.shortfall || 0), 0);
      const errors = collected.filter((r) => r.outcome === 'error').length;
      toast.success(
        `${reversed.length} advance${reversed.length === 1 ? '' : 's'} fully reversed. ` +
          `${formatUGX(returnedToTreasury)} returned to Money We Can Use` +
          (partial.length > 0
            ? `. ${partial.length} kept active with ${formatUGX(short)} still outstanding for future recovery`
            : short > 0
              ? `, ${formatUGX(short)} still outstanding`
              : '') +
          (errors > 0 ? `. ${errors} failed — see the list.` : '.'),
      );

      onSuccess?.();
      refetch();
    } catch (e: any) {
      setResults([...collected]);
      toast.error(e.message || 'Bulk reversal failed');
      onSuccess?.();
      refetch();
    } finally {
      setRunning(false);
    }
  };

  const exportShortfalls = () => {
    const list = (results ?? []).filter((r) => Number(r.shortfall || 0) > 0 || r.outcome === 'error');
    const header =
      'Agent,Advance ID,Outcome,Disbursed (UGX),Recovered (UGX),Returned to available (UGX),Shortfall (UGX),Note';
    const lines = list.map((r) =>
      [
        `"${(r.agent_name || 'Unknown').replace(/"/g, '""')}"`,
        r.advance_id,
        r.outcome,
        Number(r.disbursed || 0),
        Number(r.recovered || 0),
        Number(r.returned_to_available || 0),
        Number(r.shortfall || 0),
        `"${(r.message || '').replace(/"/g, '""')}"`,
      ].join(','),
    );
    const blob = new Blob([[header, ...lines].join('\n')], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `advance-reversal-shortfalls-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const resultSummary = useMemo(() => {
    const list = results ?? [];
    return {
      reversed: list.filter((r) => r.outcome === 'reversed').length,
      partial: list.filter((r) => r.outcome === 'partial_recovery').length,
      skipped: list.filter((r) => r.outcome === 'skipped').length,
      failed: list.filter((r) => r.outcome === 'error').length,
      recovered: list.reduce((s, r) => s + Number(r.recovered || 0), 0),
      returnedToAvailable: list.reduce((s, r) => s + Number(r.returned_to_available || 0), 0),
      shortfall: list.reduce((s, r) => s + Number(r.shortfall || 0), 0),
    };
  }, [results]);


  return (
    <Dialog open={open} onOpenChange={(o) => { if (!running) onOpenChange(o); }}>
      <DialogContent className="max-w-2xl max-h-[90vh] flex flex-col">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-base">
            <Undo2 className="h-4 w-4 text-destructive" />
            Reverse {explicitIds ? 'selected advances' : 'recently disbursed advances'}
          </DialogTitle>
          <DialogDescription className="text-xs">
            Amounts are calculated from each advance&apos;s approval, disbursement and recovery records.
            Deductions stop, requests return to Waiting for Approval, and wallets are never driven negative.
          </DialogDescription>
        </DialogHeader>

        <div className="flex-1 overflow-y-auto space-y-4 pr-1">
          {isLoading ? (
            <div className="flex flex-col items-center gap-2 py-10">
              <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
              <p className="text-[11px] text-muted-foreground">
                Building the reversal preview{planTotal > 0 ? ` — ${planLoaded} of ${planTotal} advances` : ''}…
              </p>
            </div>
          ) : isError ? (
            <div className="rounded-lg border border-destructive/40 bg-destructive/5 p-4 space-y-2">
              <p className="text-xs font-semibold text-destructive">The reversal preview could not be loaded</p>
              <p className="text-[11px] text-muted-foreground">
                {(error as any)?.message || 'Unknown error'}
              </p>
              <Button size="sm" variant="outline" className="h-7 text-[11px]" onClick={() => refetch()}>
                Try again
              </Button>
            </div>
          ) : (

            <>
              <div className="grid grid-cols-2 sm:grid-cols-5 gap-2 text-center">
                <div className="rounded-lg border p-2">
                  <p className="text-[10px] text-muted-foreground">Advances</p>
                  <p className="text-sm font-bold">{totals.count}</p>
                </div>
                <div className="rounded-lg border p-2">
                  <p className="text-[10px] text-muted-foreground">Disbursed</p>
                  <p className="text-xs font-bold">{formatUGX(totals.disbursed)}</p>
                </div>
                <div className="rounded-lg border border-destructive/40 bg-destructive/5 p-2">
                  <p className="text-[10px] text-muted-foreground">To reverse</p>
                  <p className="text-xs font-bold text-destructive">{formatUGX(totals.toReverse)}</p>
                </div>
                <div className="rounded-lg border p-2">
                  <p className="text-[10px] text-muted-foreground">Recoverable now</p>
                  <p className="text-xs font-bold text-emerald-600">{formatUGX(totals.recoverable)}</p>
                </div>
                <div className="rounded-lg border p-2">
                  <p className="text-[10px] text-muted-foreground">Shortfall</p>
                  <p className="text-xs font-bold text-amber-600">{formatUGX(totals.shortfall)}</p>
                </div>
              </div>

              {blocked > 0 && (
                <p className="text-[11px] text-muted-foreground">
                  {blocked} advance{blocked === 1 ? '' : 's'} in this set cannot be reversed (already reversed,
                  outside the same-day window, or without an originating request) and will be skipped.
                </p>
              )}

              <div className="rounded-md border">
                <ScrollArea className="h-[240px]">
                  <table className="w-full text-[11px]">
                    <thead className="sticky top-0 bg-muted/60">
                      <tr>
                        <th className="text-left p-2">Agent</th>
                        <th className="text-right p-2">Disbursed</th>
                        <th className="text-right p-2">To reverse</th>
                        <th className="text-right p-2">Recoverable</th>
                        <th className="text-right p-2">Shortfall</th>
                        <th className="text-right p-2">Result</th>
                      </tr>
                    </thead>
                    <tbody>
                      {rows.map((r) => {
                        const res = (results ?? []).find((x) => x.advance_id === r.advance_id);
                        const blockedRow = r.already_reversed || !r.approved_today || !r.has_request;
                        return (
                          <tr key={r.advance_id} className="border-t">
                            <td className="p-2">
                              <p className="font-medium truncate max-w-[150px]">{r.agent_name || 'Unknown'}</p>
                              <p className="text-[10px] text-muted-foreground">{r.agent_phone || '—'}</p>
                            </td>
                            <td className="p-2 text-right font-mono">{formatUGX(r.disbursed_amount)}</td>
                            <td className="p-2 text-right font-mono">{formatUGX(r.amount_to_reverse)}</td>
                            <td className="p-2 text-right font-mono text-emerald-600">{formatUGX(r.recoverable_now)}</td>
                            <td className="p-2 text-right font-mono text-amber-600">{formatUGX(r.shortfall)}</td>
                            <td className="p-2 text-right">
                              {res ? (
                                <Badge
                                  variant={
                                    res.outcome === 'reversed'
                                      ? 'default'
                                      : res.outcome === 'error'
                                        ? 'destructive'
                                        : 'secondary'
                                  }
                                  className="text-[9px]"
                                >
                                  {res.outcome === 'partial_recovery' ? 'kept outstanding' : res.outcome}
                                </Badge>
                              ) : blockedRow ? (

                                <Badge variant="outline" className="text-[9px]">skipped</Badge>
                              ) : (
                                <span className="text-muted-foreground">—</span>
                              )}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </ScrollArea>
              </div>

              {running && (
                <div className="space-y-1">
                  <Progress value={eligible.length ? (done / eligible.length) * 100 : 0} className="h-2" />
                  <p className="text-[11px] text-muted-foreground">
                    Reversing {done} of {eligible.length}… keep this window open.
                  </p>
                </div>
              )}

              {results && !running && (
                <div className="rounded-lg border bg-muted/40 p-3 text-xs space-y-1">
                  <p className="font-semibold">Batch result</p>
                  <div className="flex justify-between"><span className="text-muted-foreground">Advances reversed</span><span className="font-semibold">{resultSummary.reversed}</span></div>
                  <div className="flex justify-between"><span className="text-muted-foreground">Wallet funds clawed back this run</span><span className="font-semibold text-emerald-600">{formatUGX(resultSummary.returnedToAvailable)}</span></div>
                  <div className="flex justify-between"><span className="text-muted-foreground">Returned to Money We Can Use</span><span className="font-semibold text-emerald-600">{formatUGX(resultSummary.returnedToAvailable)}</span></div>
                  <div className="flex justify-between"><span className="text-muted-foreground">Outstanding shortfall (recovers from future earnings)</span><span className="font-semibold text-amber-600">{formatUGX(resultSummary.shortfall)}</span></div>
                  <div className="h-px bg-border my-1" />
                  <div className="flex justify-between"><span className="text-muted-foreground">Kept outstanding (partial/no recovery)</span><span className="font-semibold text-amber-600">{resultSummary.partial}</span></div>
                  <div className="flex justify-between"><span className="text-muted-foreground">Skipped</span><span className="font-semibold">{resultSummary.skipped}</span></div>
                  <div className="flex justify-between"><span className="text-muted-foreground">Failed</span><span className="font-semibold text-destructive">{resultSummary.failed}</span></div>


                  <Button variant="outline" size="sm" className="h-7 text-[11px] mt-2 gap-1" onClick={exportShortfalls}>
                    <Download className="h-3 w-3" /> Export shortfalls & failures
                  </Button>
                </div>
              )}

              {!results && (
                <>
                  <div>
                    <Label className="text-xs font-semibold">Reason (required, min 10 chars — applied to every advance)</Label>
                    <Textarea
                      value={reason}
                      onChange={(e) => setReason(e.target.value)}
                      placeholder="e.g. Batch auto-credited without COO approval, reversing entire batch"
                      className="mt-1 min-h-[64px]"
                      disabled={running}
                    />
                  </div>
                  <div className="rounded-lg border border-destructive/40 bg-destructive/5 p-3">
                    <div className="flex items-start gap-2">
                      <Checkbox
                        id="authorize-direct-debit"
                        checked={debitAuthorized}
                        onCheckedChange={(v) => setDebitAuthorized(v === true)}
                        disabled={running}
                        className="mt-0.5"
                      />
                      <Label htmlFor="authorize-direct-debit" className="text-[11px] leading-relaxed font-normal">
                        As CFO I authorize the Direct Debit clawback of{' '}
                        <span className="font-semibold">{formatUGX(totals.recoverable)}</span> from{' '}
                        {totals.count} agent wallet{totals.count === 1 ? '' : 's'}
                        {totals.shortfall > 0 ? (
                          <>
                            , leaving <span className="font-semibold">{formatUGX(totals.shortfall)}</span> outstanding
                            for recovery from future earnings
                          </>
                        ) : null}
                        . Wallets are never driven negative.
                      </Label>
                    </div>
                  </div>
                  <div>

                    <Label className="text-xs font-semibold">
                      Type {eligible.length} to confirm the batch size
                    </Label>
                    <Input
                      value={confirmCount}
                      onChange={(e) => setConfirmCount(e.target.value)}
                      placeholder={String(eligible.length)}
                      className="mt-1 h-8 text-sm"
                      disabled={running}
                    />
                  </div>
                </>
              )}
            </>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={running}>
            {results ? 'Close' : 'Keep advances'}
          </Button>
          {!results && (
            <Button variant="destructive" onClick={run} disabled={!canRun}>
              {running ? (<><Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" /> Reversing…</>) : `Reverse ${eligible.length} advance${eligible.length === 1 ? '' : 's'}`}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
