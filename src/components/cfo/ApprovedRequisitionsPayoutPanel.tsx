import { useEffect, useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Textarea } from '@/components/ui/textarea';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Calendar } from '@/components/ui/calendar';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { CalendarIcon, CheckCircle2, Loader2, RefreshCw, Undo2 } from 'lucide-react';
import { format } from 'date-fns';
import { cn } from '@/lib/utils';
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

const STATUS: Record<Row['payout_status'], { label: string; variant: 'default' | 'secondary' | 'destructive' | 'outline' | 'successSolid' }> = {
  pending: { label: 'Pending', variant: 'secondary' },
  failed: { label: 'Pending (retry needed)', variant: 'destructive' },
  paid: { label: 'Paid', variant: 'successSolid' },
  reversing: { label: 'Reversing…', variant: 'outline' },
  reversed: { label: 'Reversed', variant: 'outline' },
};

const SOURCE: Record<string, string> = {
  staff_requisitions: 'Staff',
  employee_requisitions: 'Employee',
  director_requisitions: 'Director',
};

type Filter = 'all' | 'pending' | 'paid' | 'reversed';
const FILTERS: { id: Filter; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'pending', label: 'Pending' },
  { id: 'paid', label: 'Paid' },
  { id: 'reversed', label: 'Reversed' },
];

const dt = (s: string | null) => (s ? format(new Date(s), 'dd MMM, HH:mm') : '—');
const today = () => new Date().toISOString().slice(0, 10);

/**
 * Approved requisitions and whether their money has reached the receiver's wallet.
 * Status comes only from the server (`cfo_approved_requisitions`); Reverse goes through
 * the CFO-only `requisition-reverse` function, which uses the strict balance check.
 * Table layout mirrors CFOApprovedRentPayouts (Approved Rent Requests).
 */
export function ApprovedRequisitionsPayoutPanel() {
  const qc = useQueryClient();
  const { roles } = useAuth() as { roles?: string[] };
  const isCfo = (roles ?? []).includes('cfo');
  const [day, setDay] = useState(today());
  const from = day, to = day;
  const [filter, setFilter] = useState<Filter>('all');
  const [search, setSearch] = useState('');
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

  // Live payout status: refetch (debounced) when a requisition or its wallet credit changes.
  useEffect(() => {
    let t: ReturnType<typeof setTimeout> | undefined;
    const bump = () => {
      clearTimeout(t);
      t = setTimeout(() => qc.invalidateQueries({ queryKey: ['cfo-approved-requisitions'] }), 800);
    };
    const ch = supabase.channel('cfo-approved-requisitions-live');
    for (const table of ['requisition_wallet_credits', 'staff_requisitions', 'employee_requisitions', 'director_requisitions']) {
      ch.on('postgres_changes', { event: '*', schema: 'public', table }, bump);
    }
    ch.subscribe();
    return () => { clearTimeout(t); supabase.removeChannel(ch); };
  }, [qc]);

  const byStatus = (r: Row) =>
    filter === 'all' ? true
      : filter === 'pending' ? r.payout_status === 'pending' || r.payout_status === 'failed'
        : filter === 'reversed' ? r.payout_status === 'reversed' || r.payout_status === 'reversing'
          : r.payout_status === 'paid';

  const shown = useMemo(() => {
    const s = search.trim().toLowerCase();
    const list = rows.filter(byStatus);
    // eslint-disable-next-line react-hooks/exhaustive-deps
    return s ? list.filter(r => [r.requisition_code, r.receiver_name ?? '', r.title ?? '', SOURCE[r.source_table] ?? '', r.requisition_id]
      .some(v => v.toLowerCase().includes(s))) : list;
  }, [rows, filter, search]);

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

  const shownTotal = shown.reduce((a, r) => a + (Number(r.amount) || 0), 0);
  const selected = day ? new Date(`${day}T00:00:00`) : undefined;

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
      <div>
        <h1 className="flex items-center gap-2 text-xl font-bold"><CheckCircle2 className="h-5 w-5 text-primary" />Approved Requisitions</h1>
        <p className="text-sm text-muted-foreground">Staff, employee and director requisitions approved for payout. Pending until Financial Operations releases the money to the receiver's wallet, then Paid automatically.</p>
      </div>

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
        <CardHeader className="space-y-3 pb-3">
          <div className="flex flex-wrap items-center gap-2">
            {FILTERS.map(f => (
              <Button key={f.id} size="sm" variant={filter === f.id ? 'default' : 'outline'} onClick={() => setFilter(f.id)}>{f.label}</Button>
            ))}
            <span className="mx-1 h-5 w-px bg-border" />
            <Popover>
              <PopoverTrigger asChild>
                <Button size="sm" variant="outline" className={cn(!selected && 'text-muted-foreground')}>
                  <CalendarIcon className="mr-1 h-4 w-4" />{selected ? format(selected, 'dd MMM yyyy') : 'Pick a date'}
                </Button>
              </PopoverTrigger>
              <PopoverContent className="w-auto p-0" align="start">
                <Calendar
                  mode="single"
                  selected={selected}
                  onSelect={(d) => { if (d) setDay(format(d, 'yyyy-MM-dd')); }}
                  disabled={{ after: new Date(`${today()}T23:59:59`) }}
                  initialFocus
                  className="pointer-events-auto p-3"
                />
              </PopoverContent>
            </Popover>
            <Button size="sm" variant="ghost" onClick={() => refetch()} aria-label="Refresh">
              <RefreshCw className={`h-4 w-4 ${isFetching ? 'animate-spin' : ''}`} />
            </Button>
          </div>
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
            <Input placeholder="Search receiver, code or purpose" value={search} onChange={e => setSearch(e.target.value)} className="sm:max-w-sm" />
            <CardTitle className="text-sm font-medium text-muted-foreground sm:ml-auto">{shown.length} requisition{shown.length === 1 ? '' : 's'} · {formatUGX(shownTotal)}</CardTitle>
          </div>
        </CardHeader>
        <CardContent className="p-0">
          {error ? (
            <p className="py-10 text-center text-sm text-destructive">{(error as Error).message}</p>
          ) : isLoading ? (
            <div className="flex justify-center py-10"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>
          ) : shown.length === 0 ? (
            <p className="py-10 text-center text-sm text-muted-foreground">No approved requisitions for this selection.</p>
          ) : (
            <div className="overflow-x-auto">
              <Table className="[&_th]:px-2 [&_td]:px-2">
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-10">#</TableHead>
                    <TableHead>Code</TableHead>
                    <TableHead>Receiver</TableHead>
                    <TableHead>Purpose</TableHead>
                    <TableHead className="text-right">Amount</TableHead>
                    <TableHead>Approved</TableHead>
                    <TableHead>In wallet</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead className="w-0" />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {shown.map((r, i) => {
                    const s = STATUS[r.payout_status] ?? STATUS.pending;
                    return (
                      <TableRow key={`${r.source_table}:${r.requisition_id}`}>
                        <TableCell className="text-muted-foreground">{i + 1}</TableCell>
                        <TableCell className="whitespace-nowrap font-mono text-xs">{r.requisition_code}<div className="text-muted-foreground">{SOURCE[r.source_table]}</div></TableCell>
                        <TableCell className="max-w-[130px] truncate font-medium" title={r.receiver_name ?? ''}>{r.receiver_name ?? '—'}</TableCell>
                        <TableCell className="max-w-[150px] truncate" title={r.title ?? ''}>{r.title ?? '—'}</TableCell>
                        <TableCell className="whitespace-nowrap text-right font-semibold tabular-nums">{formatUGX(Number(r.amount))}</TableCell>
                        <TableCell className="whitespace-nowrap text-xs">{dt(r.approved_at)}</TableCell>
                        <TableCell className="whitespace-nowrap text-xs">{dt(r.credited_at)}</TableCell>
                        <TableCell>
                          <Badge variant={s.variant}>{s.label}</Badge>
                          {r.payout_status === 'reversed' && r.reversal_reason && (
                            <div className="mt-1 max-w-[200px] text-xs text-muted-foreground">{dt(r.reversed_at)} · {r.reversal_reason}</div>
                          )}
                        </TableCell>
                        <TableCell className="whitespace-nowrap text-right">
                          {r.payout_status === 'paid' && isCfo && (
                            <Button size="sm" variant="destructive" onClick={() => { setTarget(r); setReason(''); }}>
                              <Undo2 className="mr-1 h-3.5 w-3.5" /> Reverse
                            </Button>
                          )}
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </div>
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
