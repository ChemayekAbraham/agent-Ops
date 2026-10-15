import { useEffect, useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Calendar } from '@/components/ui/calendar';
import { cn } from '@/lib/utils';
import { format } from 'date-fns';
import jsPDF from 'jspdf';
import autoTable from 'jspdf-autotable';
import { toast } from 'sonner';
import { Banknote, CalendarIcon, CheckCircle, Clock, Download, Loader2, X } from 'lucide-react';

/**
 * Read-only list of rent requests that reached the CFO payout stage.
 * Pending = fully approved, money not yet sent to the agent's wallet (float).
 * Paid    = the agent's float was funded (`funded_at` is stamped by
 *           fund-agent-landlord-float). Status flips live via realtime.
 */
interface Row {
  id: string;
  status: string;
  rent_amount: number;
  tenant_id: string | null;
  agent_id: string | null;
  landlord_id: string | null;
  coo_reviewed_at: string | null;
  cfo_reviewed_at: string | null;
  funded_at: string | null;
  created_at: string;
  payout_transaction_reference: string | null;
}

type Tab = 'pending' | 'paid';
type Range = 'today' | 'yesterday' | 'last_week' | 'this_month' | null;

const fmt = (n: number) => `UGX ${Math.round(Number(n) || 0).toLocaleString('en-US')}`;
const PAID_STATUSES = ['funded', 'repaying', 'completed', 'disbursed'];
const DAY = 24 * 3600 * 1000;
const kampalaDayStartUtc = (d: Date) => {
  const k = new Date(d.getTime() + 3 * 3600 * 1000);
  return new Date(Date.UTC(k.getUTCFullYear(), k.getUTCMonth(), k.getUTCDate()) - 3 * 3600 * 1000);
};
const latin = (s: string) => s.normalize('NFKD').replace(/[^\x20-\xFF]/g, '');

export function CFOApprovedRentPayouts() {
  const queryClient = useQueryClient();
  const [tab, setTab] = useState<Tab>('pending');
  const [search, setSearch] = useState('');
  const [date, setDate] = useState<Date | undefined>();
  const [range, setRange] = useState<Range>(null);

  const bounds = useMemo((): [Date, Date] | null => {
    const now = new Date();
    const today = kampalaDayStartUtc(now);
    if (date) { const s = kampalaDayStartUtc(new Date(date.getTime() + 12 * 3600 * 1000)); return [s, new Date(s.getTime() + DAY)]; }
    if (range === 'today') return [today, new Date(today.getTime() + DAY)];
    if (range === 'yesterday') return [new Date(today.getTime() - DAY), today];
    if (range === 'last_week') return [new Date(today.getTime() - 6 * DAY), new Date(today.getTime() + DAY)];
    if (range === 'this_month') {
      const k = new Date(now.getTime() + 3 * 3600 * 1000);
      return [new Date(Date.UTC(k.getUTCFullYear(), k.getUTCMonth(), 1) - 3 * 3600 * 1000),
              new Date(Date.UTC(k.getUTCFullYear(), k.getUTCMonth() + 1, 1) - 3 * 3600 * 1000)];
    }
    return null;
  }, [date, range]);

  const { data: rows = [], isLoading } = useQuery({
    queryKey: ['cfo-approved-rent-payouts', tab, bounds?.[0]?.toISOString() ?? null],
    queryFn: async () => {
      // Paid = Financial Operations has disbursed the landlord payout
      // (landlord_payouts.finops_disbursed_at). CFO approval/funding alone stays Pending.
      const cols = 'id, status, rent_amount, tenant_id, agent_id, landlord_id, coo_reviewed_at, cfo_reviewed_at, funded_at, created_at, payout_transaction_reference';
      const lookbackStart = bounds ? new Date(bounds[0].getTime() - 60 * DAY).toISOString() : null;
      const queries = [
        (() => {
          let q = supabase.from('rent_requests').select(cols).eq('status', 'coo_approved')
            .order('coo_reviewed_at', { ascending: false, nullsFirst: false }).limit(1000);
          return q;
        })(),
        (() => {
          let q = supabase.from('rent_requests').select(cols).in('status', PAID_STATUSES).not('funded_at', 'is', null)
            .order('funded_at', { ascending: false }).limit(bounds ? 1000 : 500);
          if (lookbackStart) q = q.gte('funded_at', lookbackStart);
          return q;
        })(),
      ];
      const [a, b] = await Promise.all(queries);
      if (a.error) throw a.error;
      if (b.error) throw b.error;
      const funded = (b.data || []) as Row[];
      const paidAt = new Map<string, string>();
      const ids = funded.map(r => r.id);
      for (let i = 0; i < ids.length; i += 200) {
        const { data, error } = await supabase.from('landlord_payouts')
          .select('rent_request_id, finops_disbursed_at')
          .in('rent_request_id', ids.slice(i, i + 200))
          .not('finops_disbursed_at', 'is', null);
        if (error) throw error;
        (data || []).forEach((p: any) => {
          const prev = paidAt.get(p.rent_request_id);
          if (!prev || p.finops_disbursed_at > prev) paidAt.set(p.rent_request_id, p.finops_disbursed_at);
        });
      }
      const inB = (s: string | null) => !bounds || (!!s && new Date(s) >= bounds[0] && new Date(s) < bounds[1]);
      if (tab === 'paid') {
        return funded.filter(r => paidAt.has(r.id))
          .map(r => ({ ...r, paid_at: paidAt.get(r.id)! }))
          .filter(r => inB(r.paid_at))
          .sort((x, y) => (y.paid_at > x.paid_at ? 1 : -1));
      }
      const pending = [...((a.data || []) as Row[]), ...funded.filter(r => !paidAt.has(r.id))]
        .map(r => ({ ...r, paid_at: null }))
        .filter(r => inB(r.coo_reviewed_at));
      return pending.sort((x, y) => ((y.coo_reviewed_at || '') > (x.coo_reviewed_at || '') ? 1 : -1));
    },
  });

  const userIds = useMemo(() => [...new Set(rows.flatMap(r => [r.tenant_id, r.agent_id]).filter(Boolean) as string[])], [rows]);
  const landlordIds = useMemo(() => [...new Set(rows.map(r => r.landlord_id).filter(Boolean) as string[])], [rows]);
  const { data: names = new Map<string, string>() } = useQuery({
    queryKey: ['cfo-approved-rent-names', userIds.join(','), landlordIds.join(',')],
    enabled: userIds.length + landlordIds.length > 0,
    queryFn: async () => {
      const m = new Map<string, string>();
      for (let i = 0; i < userIds.length; i += 200) {
        const { data } = await supabase.from('profiles').select('id, full_name').in('id', userIds.slice(i, i + 200));
        (data || []).forEach((p: any) => m.set(p.id, p.full_name || '—'));
      }
      for (let i = 0; i < landlordIds.length; i += 200) {
        const { data } = await supabase.from('landlords').select('id, name').in('id', landlordIds.slice(i, i + 200));
        (data || []).forEach((l: any) => m.set(l.id, l.name || '—'));
      }
      return m;
    },
  });
  const nm = (id: string | null) => (id && names.get(id)) || '—';

  useEffect(() => {
    const ch = supabase.channel('cfo-approved-rent-payouts-live')
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'rent_requests' },
        () => queryClient.invalidateQueries({ queryKey: ['cfo-approved-rent-payouts'] }))
      .subscribe();
    return () => { supabase.removeChannel(ch); };
  }, [queryClient]);

  const filtered = useMemo(() => {
    const s = search.trim().toLowerCase();
    if (!s) return rows;
    return rows.filter(r => [nm(r.tenant_id), nm(r.agent_id), nm(r.landlord_id), r.payout_transaction_reference || '', r.id]
      .some(v => v.toLowerCase().includes(s)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, search, names]);
  const total = filtered.reduce((a, r) => a + Number(r.rent_amount || 0), 0);
  const when = (s: string | null) => (s ? format(new Date(s), 'dd MMM yyyy, HH:mm') : '—');

  const downloadPdf = () => {
    const doc = new jsPDF({ orientation: 'landscape', unit: 'pt', format: 'a4' });
    doc.setFontSize(14); doc.text('Approved Rent Payouts to Agent Wallets', 40, 40);
    doc.setFontSize(9);
    doc.text(`Filter: ${tab === 'pending' ? 'Pending' : 'Approved'}${range ? ` · Period: ${range.replace('_', ' ')}` : ''}${date ? ` · Date: ${format(date, 'dd MMM yyyy')}` : ''} · ${filtered.length} rows · Total ${fmt(total)} · Generated ${format(new Date(), 'dd MMM yyyy HH:mm')}`, 40, 56);
    autoTable(doc, {
      startY: 70, styles: { fontSize: 8 },
      head: [['#', 'Tenant', 'Agent', 'Landlord', 'Rent amount', 'Approved', 'Paid', 'Reference', 'Status']],
      body: filtered.map((r, i) => [i + 1, latin(nm(r.tenant_id)), latin(nm(r.agent_id)), latin(nm(r.landlord_id)), fmt(r.rent_amount),
        when(r.coo_reviewed_at), when(r.funded_at), latin(r.payout_transaction_reference || '—'), r.funded_at ? 'Paid' : 'Pending']),
      didDrawPage: () => { doc.setFontSize(8); doc.text(`Page ${doc.getNumberOfPages()}`, doc.internal.pageSize.getWidth() - 70, doc.internal.pageSize.getHeight() - 20); },
    });
    doc.save(`approved-rent-payouts-${format(new Date(), 'yyyyMMdd-HHmm')}.pdf`);
    toast.success('PDF downloaded');
  };

  const RANGES: { id: Exclude<Range, null>; label: string }[] = [
    { id: 'today', label: 'Today' }, { id: 'yesterday', label: 'Yesterday' }, { id: 'last_week', label: 'Last week' }, { id: 'this_month', label: 'This month' },
  ];

  return (
    <div className="space-y-4">
      <div>
        <h1 className="flex items-center gap-2 text-xl font-bold"><Banknote className="h-5 w-5 text-primary" />Approved Rent Requests</h1>
        <p className="text-sm text-muted-foreground">Rent requests approved for payout. Pending until Financial Operations sends the money to the agent's wallet, then Paid automatically.</p>
      </div>
      <Card>
        <CardHeader className="space-y-3 pb-3">
          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" variant={tab === 'pending' ? 'default' : 'outline'} onClick={() => setTab('pending')}><Clock className="mr-1 h-4 w-4" />Pending</Button>
            <Button size="sm" variant={tab === 'paid' ? 'default' : 'outline'} onClick={() => setTab('paid')}><CheckCircle className="mr-1 h-4 w-4" />Approved</Button>
            <span className="mx-1 h-5 w-px bg-border" />
            {RANGES.map(r => (
              <Button key={r.id} size="sm" variant={range === r.id ? 'secondary' : 'ghost'} onClick={() => { setDate(undefined); setRange(range === r.id ? null : r.id); }}>{r.label}</Button>
            ))}
            <Popover>
              <PopoverTrigger asChild>
                <Button size="sm" variant="outline" className={cn(!date && 'text-muted-foreground')}><CalendarIcon className="mr-1 h-4 w-4" />{date ? format(date, 'dd MMM yyyy') : 'Pick a date'}</Button>
              </PopoverTrigger>
              <PopoverContent className="w-auto p-0" align="start">
                <Calendar mode="single" selected={date} onSelect={d => { setRange(null); setDate(d); }} initialFocus className="pointer-events-auto p-3" />
              </PopoverContent>
            </Popover>
            {date && <Button size="sm" variant="ghost" onClick={() => setDate(undefined)}><X className="mr-1 h-4 w-4" />Clear date</Button>}
          </div>
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
            <Input placeholder="Search tenant, agent, landlord or reference" value={search} onChange={e => setSearch(e.target.value)} className="sm:max-w-sm" />
            <Button size="sm" variant="outline" onClick={downloadPdf} disabled={filtered.length === 0}><Download className="mr-1 h-4 w-4" />Download PDF</Button>
            <CardTitle className="text-sm font-medium text-muted-foreground sm:ml-auto">{filtered.length} request{filtered.length === 1 ? '' : 's'} · {fmt(total)}</CardTitle>
          </div>
        </CardHeader>
        <CardContent className="p-0">
          {isLoading ? (
            <div className="flex justify-center py-10"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>
          ) : filtered.length === 0 ? (
            <p className="py-10 text-center text-sm text-muted-foreground">No {tab === 'pending' ? 'pending' : 'approved'} rent requests for this selection.</p>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-10">#</TableHead>
                    <TableHead>Tenant</TableHead>
                    <TableHead>Agent</TableHead>
                    <TableHead>Landlord</TableHead>
                    <TableHead className="text-right">Rent amount</TableHead>
                    <TableHead>Approved</TableHead>
                    <TableHead>Paid to agent wallet</TableHead>
                    <TableHead>Reference</TableHead>
                    <TableHead>Status</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filtered.map((r, i) => (
                    <TableRow key={r.id}>
                      <TableCell className="text-muted-foreground">{i + 1}</TableCell>
                      <TableCell className="font-medium">{nm(r.tenant_id)}</TableCell>
                      <TableCell>{nm(r.agent_id)}</TableCell>
                      <TableCell>{nm(r.landlord_id)}</TableCell>
                      <TableCell className="text-right font-semibold tabular-nums">{fmt(r.rent_amount)}</TableCell>
                      <TableCell className="whitespace-nowrap text-xs">{when(r.coo_reviewed_at)}</TableCell>
                      <TableCell className="whitespace-nowrap text-xs">{when(r.funded_at)}</TableCell>
                      <TableCell className="font-mono text-xs">{r.payout_transaction_reference || '—'}</TableCell>
                      <TableCell>
                        {r.funded_at
                          ? <Badge className="bg-success/15 text-success hover:bg-success/15">Paid</Badge>
                          : <Badge className="bg-warning/15 text-warning hover:bg-warning/15">Pending</Badge>}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

export default CFOApprovedRentPayouts;
