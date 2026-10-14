import { useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Textarea } from '@/components/ui/textarea';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { RefreshCw, Undo2, CheckCircle2 } from 'lucide-react';
import { toast } from 'sonner';
import { formatUGX } from '@/lib/rentCalculations';
import { useAuth } from '@/hooks/useAuth';

interface Row {
  source_table: string;
  requisition_id: string;
  requisition_code: string;
  receiver_id: string | null;
  receiver_name: string | null;
  title: string | null;
  amount: number;
  approved_at: string;
  payout_status: 'pending' | 'paid' | 'reversed' | 'reversing' | 'failed';
  credited_at: string | null;
  reversed_at: string | null;
  reversal_reason: string | null;
  error_message: string | null;
}

const STATUS: Record<Row['payout_status'], { label: string; variant: 'default' | 'secondary' | 'destructive' | 'outline' }> = {
  pending: { label: 'Pending', variant: 'secondary' },
  failed: { label: 'Pending (retry needed)', variant: 'destructive' },
  paid: { label: 'Paid', variant: 'default' },
  reversing: { label: 'Reversing…', variant: 'outline' },
  reversed: { label: 'Reversed', variant: 'outline' },
};

const SOURCE: Record<string, string> = {
  staff_requisitions: 'Staff',
  employee_requisitions: 'Employee',
  director_requisitions: 'Director',
};

const dt = (s: string | null) => (s ? new Date(s).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' }) : '—');
const firstOfMonth = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`; };
const today = () => new Date().toISOString().slice(0, 10);

/**
 * Approved requisitions and whether their money has reached the receiver's wallet.
 * Status comes only from the server (`cfo_approved_requisitions`); Reverse goes through
 * the CFO-only `requisition-reverse` function, which uses the strict balance check.
 */
export function ApprovedRequisitionsPayoutPanel() {
  const qc = useQueryClient();
  const { roles } = useAuth() as { roles?: string[] };
  const isCfo = (roles ?? []).includes('cfo');
  const [from, setFrom] = useState(firstOfMonth());
  const [to, setTo] = useState(today());
  const [filter, setFilter] = useState<'all' | 'pending' | 'paid' | 'reversed'>('all');
  const [target, setTarget] = useState<Row | null>(null);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);

  const range = useMemo(() => ({
    p_from: new Date(`${from}T00:00:00`).toISOString(),
    p_to: new Date(new Date(`${to}T00:00:00`).getTime() + 86_400_000).toISOString(),
  }), [from, to]);

  const { data: rows = [], isLoading, isFetching, refetch, error } = useQuery({
    queryKey: ['cfo-approved-requisitions', range],
    refetchInterval: 30_000,
    queryFn: async (): Promise<Row[]> => {
      const { data, error } = await (supabase as any).rpc('cfo_approved_requisitions', range);
      if (error) throw new Error(error.message);
      return (data ?? []) as Row[];
    },
  });

  const shown = rows.filter((r) =>
    filter === 'all' ? true
      : filter === 'pending' ? r.payout_status === 'pending' || r.payout_status === 'failed'
        : filter === 'reversed' ? r.payout_status === 'reversed' || r.payout_status === 'reversing'
          : r.payout_status === 'paid');

  const totals = useMemo(() => {
    const t = { pending: 0, paid: 0, reversed: 0, pendingN: 0, paidN: 0, reversedN: 0 };
    for (const r of rows) {
      const a = Number(r.amount) || 0;
      if (r.payout_status === 'paid') { t.paid += a; t.paidN++; }
      else if (r.payout_status === 'reversed' || r.payout_status === 'reversing') { t.reversed += a; t.reversedN++; }
      else { t.pending += a; t.pendingN++; }
    }
    return t;
  }, [rows]);

  async function confirmReverse() {
    if (!target) return;
    if (reason.trim().length < 10) { toast.error('Please give a reason of at least 10 characters.'); return; }
    setBusy(true);
    try {
      const { data, error } = await supabase.functions.invoke('requisition-reverse', {
        body: { source_table: target.source_table, requisition_id: target.requisition_id, reason: reason.trim() },
      });
      const msg = (data as any)?.error ?? (error ? await (error as any)?.context?.json?.().then((j: any) => j?.error).catch(() => null) ?? error.message : null);
      if (msg) throw new Error(msg);
      toast.success(`${formatUGX(Number(target.amount))} taken back from ${target.receiver_name ?? 'the receiver'}.`);
      setTarget(null); setReason('');
      await qc.invalidateQueries({ queryKey: ['cfo-approved-requisitions'] });
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-3">
        <Card><CardContent className="p-4">
          <p className="text-xs text-muted-foreground">Pending — not yet in wallet</p>
          <p className="text-xl font-bold">{formatUGX(totals.pending)}</p>
          <p className="text-xs text-muted-foreground">{totals.pendingN} requisitions</p>
        </CardContent></Card>
        <Card><CardContent className="p-4">
          <p className="text-xs text-muted-foreground">Paid — in receiver's wallet</p>
          <p className="text-xl font-bold text-primary">{formatUGX(totals.paid)}</p>
          <p className="text-xs text-muted-foreground">{totals.paidN} requisitions</p>
        </CardContent></Card>
        <Card><CardContent className="p-4">
          <p className="text-xs text-muted-foreground">Reversed</p>
          <p className="text-xl font-bold">{formatUGX(totals.reversed)}</p>
          <p className="text-xs text-muted-foreground">{totals.reversedN} requisitions</p>
        </CardContent></Card>
      </div>

      <Card>
        <CardHeader className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <CardTitle className="flex items-center gap-2 text-base"><CheckCircle2 className="h-4 w-4" /> Approved Requisitions</CardTitle>
          <div className="flex flex-wrap items-center gap-2">
            <Input type="date" value={from} max={to} onChange={(e) => setFrom(e.target.value)} className="h-9 w-[150px]" />
            <Input type="date" value={to} min={from} onChange={(e) => setTo(e.target.value)} className="h-9 w-[150px]" />
            {(['all', 'pending', 'paid', 'reversed'] as const).map((f) => (
              <Button key={f} size="sm" variant={filter === f ? 'default' : 'outline'} onClick={() => setFilter(f)} className="capitalize">{f}</Button>
            ))}
            <Button size="sm" variant="ghost" onClick={() => refetch()} aria-label="Refresh">
              <RefreshCw className={`h-4 w-4 ${isFetching ? 'animate-spin' : ''}`} />
            </Button>
          </div>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          {error ? <p className="text-sm text-destructive">{(error as Error).message}</p>
            : isLoading ? <p className="text-sm text-muted-foreground">Loading…</p>
              : shown.length === 0 ? <p className="text-sm text-muted-foreground">No approved requisitions in this period.</p>
                : (
                  <table className="w-full min-w-[820px] text-sm">
                    <thead className="text-left text-xs text-muted-foreground">
                      <tr className="border-b">
                        <th className="py-2 pr-3">Code</th><th className="pr-3">Receiver</th><th className="pr-3">Purpose</th>
                        <th className="pr-3 text-right">Amount</th><th className="pr-3">Approved</th>
                        <th className="pr-3">Status</th><th className="pr-3">In wallet</th><th />
                      </tr>
                    </thead>
                    <tbody>
                      {shown.map((r) => {
                        const s = STATUS[r.payout_status] ?? STATUS.pending;
                        return (
                          <tr key={`${r.source_table}:${r.requisition_id}`} className="border-b last:border-0 align-top">
                            <td className="py-2 pr-3 font-mono text-xs">{r.requisition_code}<div className="text-muted-foreground">{SOURCE[r.source_table]}</div></td>
                            <td className="pr-3">{r.receiver_name ?? '—'}</td>
                            <td className="pr-3 max-w-[220px] truncate" title={r.title ?? ''}>{r.title ?? '—'}</td>
                            <td className="pr-3 text-right font-semibold">{formatUGX(Number(r.amount))}</td>
                            <td className="pr-3 text-xs">{dt(r.approved_at)}</td>
                            <td className="pr-3">
                              <Badge variant={s.variant}>{s.label}</Badge>
                              {r.payout_status === 'reversed' && r.reversal_reason && (
                                <div className="mt-1 text-xs text-muted-foreground max-w-[200px]">{dt(r.reversed_at)} · {r.reversal_reason}</div>
                              )}
                            </td>
                            <td className="pr-3 text-xs">{dt(r.credited_at)}</td>
                            <td className="text-right">
                              {r.payout_status === 'paid' && isCfo && (
                                <Button size="sm" variant="outline" onClick={() => { setTarget(r); setReason(''); }}>
                                  <Undo2 className="mr-1 h-3.5 w-3.5" /> Reverse
                                </Button>
                              )}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                )}
        </CardContent>
      </Card>

      <Dialog open={!!target} onOpenChange={(o) => { if (!o && !busy) setTarget(null); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Reverse this payment?</DialogTitle>
            <DialogDescription>
              {target && <>{formatUGX(Number(target.amount))} will be taken out of {target.receiver_name ?? 'the receiver'}'s withdrawable balance and returned to the company. If they have already withdrawn it, the reversal will be refused.</>}
            </DialogDescription>
          </DialogHeader>
          <Textarea value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Reason for reversal (at least 10 characters)" rows={3} />
          <DialogFooter>
            <Button variant="outline" onClick={() => setTarget(null)} disabled={busy}>Cancel</Button>
            <Button variant="destructive" onClick={confirmReverse} disabled={busy || reason.trim().length < 10}>
              {busy ? 'Reversing…' : 'Reverse money'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

export default ApprovedRequisitionsPayoutPanel;
