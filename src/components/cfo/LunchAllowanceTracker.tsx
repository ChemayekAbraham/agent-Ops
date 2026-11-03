import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Loader2, Utensils, RefreshCw, Download, MoreVertical, Undo2 } from 'lucide-react';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@/components/ui/alert-dialog';
import { Textarea } from '@/components/ui/textarea';
import { toast } from 'sonner';
import jsPDF from 'jspdf';
import autoTable from 'jspdf-autotable';
import { formatUGX } from '@/lib/agentAdvanceCalculations';

interface Row {
  id: string;
  target_user_id: string;
  amount: number;
  operation: string;
  created_at: string;
  created_by: string | null;
  reference_id: string | null;
  evidence: string | null;
  metadata?: any;
}

/** Tracker of Lunch Allowance payments made through CFO Send Money. */
export function LunchAllowanceTracker() {
  const [to, setTo] = useState('');
  const [search, setSearch] = useState('');
  const [reversing, setReversing] = useState<Row | null>(null);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);

  const { data, isLoading, refetch, isFetching } = useQuery({
    queryKey: ['cfo-lunch-allowance'],
    staleTime: 60_000,
    queryFn: async () => {
      const { data: rows, error } = await supabase
        .from('platform_wallet_corrections')
        .select('id,target_user_id,amount,operation,created_at,created_by,reference_id,evidence,metadata')
        .ilike('metadata->>category_label', '%lunch allowance%')
        .order('created_at', { ascending: false })
        .limit(1000);
      if (error) throw error;
      // Automated lunch allowance payouts post straight to the ledger (no
      // platform_wallet_corrections row), so read their user wallet legs too.
      const { data: autoRows, error: autoErr } = await supabase
        .from('general_ledger')
        .select('id,user_id,amount,created_at')
        .eq('category', 'wallet_deposit')
        .ilike('description', '%automated%')
        .ilike('description', '%lunch allowance%')
        .order('created_at', { ascending: false })
        .limit(1000);
      if (autoErr) throw autoErr;
      const automated: Row[] = (autoRows ?? []).map((r: any) => ({
        id: r.id,
        target_user_id: r.user_id,
        amount: r.amount,
        operation: 'credit',
        created_at: r.created_at,
        created_by: null,
        reference_id: 'Automated',
        evidence: null,
      }));
      const list = [...((rows ?? []) as Row[]), ...automated].sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
      const ids = [...new Set(list.flatMap((r) => [r.target_user_id, r.created_by]).filter(Boolean))] as string[];
      const names: Record<string, string> = {};
      if (ids.length) {
        const { data: profs } = await supabase.from('profiles').select('id,full_name').in('id', ids);
        (profs ?? []).forEach((p: any) => { names[p.id] = p.full_name || 'Unknown'; });
      }
      return { list, names };
    },
  });

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return (data?.list ?? []).filter((r) => {
      const d = r.created_at.slice(0, 10);
      if (to && d > to) return false;
      if (q && !(data?.names[r.target_user_id] ?? '').toLowerCase().includes(q)) return false;
      return true;
    });
  }, [data, to, search]);

  const reversedIds = useMemo(() => {
    const set = new Set<string>();
    (data?.list ?? []).forEach((r) => {
      const m = String(r.metadata?.sub_category ?? '').match(/^lunch_allowance_reversal:(.+)$/);
      if (r.operation === 'debit' && m) set.add(m[1]);
    });
    return set;
  }, [data]);

  const submitReversal = async () => {
    if (!reversing || reason.trim().length < 10) return;
    setBusy(true);
    try {
      const { data: res, error } = await supabase.functions.invoke('cfo-direct-credit', {
        body: {
          target_user_id: reversing.target_user_id,
          amount: Number(reversing.amount),
          reason: `Lunch allowance reversal — ${reason.trim()}`,
          operation: 'debit',
          wallet_category: 'wallet_transfer',
          platform_category: 'wallet_transfer',
          financial_impact: 'neutral',
          category_label: 'Lunch allowance reversal',
          recipient_type: 'user',
          sub_category: `lunch_allowance_reversal:${reversing.id}`,
        },
      });
      if (error) throw new Error((error as any)?.message || 'Reversal failed');
      if ((res as any)?.error) throw new Error((res as any).error);
      toast.success('Lunch allowance returned to the company');
      setReversing(null); setReason('');
      refetch();
    } catch (e: any) {
      toast.error(e?.message ?? 'Reversal failed');
    } finally { setBusy(false); }
  };

  const signed = (r: Row) => (r.operation === 'debit' ? -1 : 1) * Number(r.amount);
  const total = filtered.reduce((s, r) => s + signed(r), 0);
  const monthKey = new Date().toISOString().slice(0, 7);
  const thisMonth = (data?.list ?? []).filter((r) => r.created_at.startsWith(monthKey)).reduce((s, r) => s + signed(r), 0);

  const perStaff = useMemo(() => {
    const m = new Map<string, { total: number; count: number; last: string }>();
    filtered.forEach((r) => {
      const e = m.get(r.target_user_id) ?? { total: 0, count: 0, last: r.created_at };
      e.total += signed(r); e.count += 1; if (r.created_at > e.last) e.last = r.created_at;
      m.set(r.target_user_id, e);
    });
    return [...m.entries()].sort((a, b) => b[1].total - a[1].total);
  }, [filtered]);

  const fmtDate = (s: string) => new Date(s).toLocaleString('en-GB', { timeZone: 'Africa/Kampala', dateStyle: 'medium', timeStyle: 'short' });

  const downloadPdf = () => {
    const doc = new jsPDF();
    const n = (id: string | null) => (id ? data?.names[id] ?? 'Unknown' : 'System');
    doc.setFontSize(14);
    doc.text('Welile - Lunch Allowance', 14, 16);
    doc.setFontSize(9);
    const range = to ? `Up to ${to}` : 'All time';
    doc.text(`Period: ${range}${search ? ` | Staff: ${search}` : ''} | Generated ${fmtDate(new Date().toISOString())}`, 14, 22);
    doc.text(`Total: ${formatUGX(total)} | Staff paid: ${perStaff.length} | Payments: ${filtered.length}`, 14, 27);
    autoTable(doc, {
      startY: 32,
      head: [['Staff member', 'Payments', 'Last payment', 'Total']],
      body: perStaff.map(([id, s]) => [n(id), String(s.count), fmtDate(s.last), formatUGX(s.total)]),
      styles: { fontSize: 8 },
    });
    autoTable(doc, {
      startY: (doc as any).lastAutoTable.finalY + 8,
      head: [['Date', 'Staff member', 'Reference', 'Sent by', 'Amount']],
      body: filtered.map((r) => [fmtDate(r.created_at), n(r.target_user_id), r.reference_id ?? '', n(r.created_by), formatUGX(signed(r)) + (r.operation === 'debit' ? ' (reversed)' : '')]),
      styles: { fontSize: 8 },
    });
    doc.save(`lunch-allowance-${new Date().toISOString().slice(0, 10)}.pdf`);
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Utensils className="h-5 w-5 text-primary" />
          <h2 className="text-lg font-semibold">Lunch Allowance</h2>
        </div>
        <div className="flex gap-2">
        <Button variant="outline" size="sm" onClick={downloadPdf} disabled={isLoading || filtered.length === 0}>
          <Download className="h-4 w-4 mr-1" /> Download PDF
        </Button>
        <Button variant="outline" size="sm" onClick={() => refetch()} disabled={isFetching}>
          <RefreshCw className={`h-4 w-4 mr-1 ${isFetching ? 'animate-spin' : ''}`} /> Refresh
        </Button>
        </div>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <Card><CardContent className="p-4"><p className="text-xs text-muted-foreground">Total (filtered)</p><p className="text-xl font-bold">{formatUGX(total)}</p></CardContent></Card>
        <Card><CardContent className="p-4"><p className="text-xs text-muted-foreground">This month</p><p className="text-xl font-bold">{formatUGX(thisMonth)}</p></CardContent></Card>
        <Card><CardContent className="p-4"><p className="text-xs text-muted-foreground">Staff paid · payments</p><p className="text-xl font-bold">{perStaff.length} · {filtered.length}</p></CardContent></Card>
      </div>

      <div className="flex flex-wrap gap-2">
        <Input placeholder="Search staff name" value={search} onChange={(e) => setSearch(e.target.value)} className="w-full sm:w-56" />
        <Input type="date" value={to} onChange={(e) => setTo(e.target.value)} className="w-40" aria-label="To" />
        {(to || search) && <Button variant="ghost" size="sm" onClick={() => { setTo(''); setSearch(''); }}>Clear</Button>}
      </div>

      {isLoading ? (
        <div className="flex justify-center py-10"><Loader2 className="h-6 w-6 animate-spin text-primary" /></div>
      ) : (
        <>
          <Card>
            <CardHeader className="pb-2"><CardTitle className="text-sm">By staff member</CardTitle></CardHeader>
            <CardContent className="divide-y divide-border">
              {perStaff.length === 0 && <p className="text-sm text-muted-foreground py-3">No lunch allowance payments found.</p>}
              {perStaff.map(([id, s]) => (
                <div key={id} className="flex items-center justify-between py-2 gap-2">
                  <div className="min-w-0">
                    <p className="text-sm font-medium truncate">{data?.names[id] ?? 'Unknown'}</p>
                    <p className="text-xs text-muted-foreground">{s.count} payment{s.count === 1 ? '' : 's'} · last {fmtDate(s.last)}</p>
                  </div>
                  <p className="text-sm font-semibold shrink-0">{formatUGX(s.total)}</p>
                </div>
              ))}
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-2"><CardTitle className="text-sm">All payments</CardTitle></CardHeader>
            <CardContent className="divide-y divide-border">
              {filtered.map((r) => (
                <div key={r.id} className="flex items-start justify-between py-2 gap-2">
                  <div className="min-w-0">
                    <p className="text-sm font-medium truncate">{data?.names[r.target_user_id] ?? 'Unknown'}</p>
                    <p className="text-xs text-muted-foreground">{fmtDate(r.created_at)} · {r.reference_id} · sent by {r.created_by ? data?.names[r.created_by] ?? 'Unknown' : 'System'}</p>
                  </div>
                  <div className="text-right shrink-0">
                    <p className="text-sm font-semibold">{formatUGX(signed(r))}</p>
                    {r.operation === 'debit' && <Badge variant="destructive" className="text-[10px]">Reversed</Badge>}
                    {r.operation !== 'debit' && reversedIds.has(r.id) && <Badge variant="secondary" className="text-[10px]">Returned</Badge>}
                  </div>
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button variant="ghost" size="icon" className="h-8 w-8 shrink-0" aria-label="Actions"><MoreVertical className="h-4 w-4" /></Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      <DropdownMenuItem
                        disabled={r.operation === 'debit' || reversedIds.has(r.id)}
                        onClick={() => { setReversing(r); setReason(''); }}
                        className="text-destructive"
                      >
                        <Undo2 className="h-4 w-4 mr-2" /> Reverse to company
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>
              ))}
            </CardContent>
          </Card>
        </>
      )}

      <AlertDialog open={!!reversing} onOpenChange={(o) => { if (!o && !busy) setReversing(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Reverse lunch allowance?</AlertDialogTitle>
            <AlertDialogDescription>
              {reversing && <>{formatUGX(Number(reversing.amount))} will be taken back from {data?.names[reversing.target_user_id] ?? 'this staff member'}'s wallet and returned to the company.</>}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <Textarea placeholder="Reason (at least 10 characters)" value={reason} onChange={(e) => setReason(e.target.value)} />
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={busy || reason.trim().length < 10}
              onClick={(e) => { e.preventDefault(); submitReversal(); }}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Reverse'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
