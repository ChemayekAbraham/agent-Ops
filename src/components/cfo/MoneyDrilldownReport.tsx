import { useEffect, useState } from 'react';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { toast } from 'sonner';
import { supabase } from '@/integrations/supabase/client';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { formatUGX } from '@/lib/creditFeeCalculations';
import { CheckCircle2, AlertTriangle, Download, Loader2 } from 'lucide-react';

/** A preset opened from a card metric. `expected` is the figure shown on the card. */
export type DrilldownPreset = {
  label: string; from: string; to: string; status: string;
  expected?: { amount: number; count: number; basis: 'confirmed' | 'pending' };
};

export type DrillColumn = { head: string; cell: (r: any) => React.ReactNode; csv: (r: any) => unknown; className?: string };

export type DrillConfig = {
  title: string; description: string; rpc: string; kind: 'paid_out' | 'received'; payerParam: string; filename: string;
  personLabel: string; confirmedLabel: string;
  types: string[];
  statuses: { value: string; label: string }[];
  columns: DrillColumn[];
};

const SINCE = '2020-01-01';
export const kampalaDate = (d = new Date()) => d.toLocaleDateString('en-CA', { timeZone: 'Africa/Kampala' });
export const monthStart = () => kampalaDate().slice(0, 8) + '01';
export const allTime = () => ({ from: SINCE, to: kampalaDate() });
const sel = 'h-9 rounded-md border border-input bg-background px-2 text-sm';
const PAGE = 50;
const EXPORT_CHUNK = 1000;

const errText = (e: any) => {
  const m = String(e?.message ?? e ?? '');
  if (/not authorized/i.test(m)) return 'Only CFO, CEO and super admin accounts can open this report.';
  if (/timeout|canceling statement/i.test(m)) return 'The report took too long. Narrow the date range or add a filter, then try again.';
  if (/fetch|network/i.test(m)) return 'Network problem — check your connection and try again.';
  return `Could not load the report${m ? `: ${m}` : ''}.`;
};

/** Read-only drill-down. Totals come from a separate server aggregate over the full filtered set; rows are paged. */
export function MoneyDrilldownReport({ open, onOpenChange, preset, config }: {
  open: boolean; onOpenChange: (o: boolean) => void; preset?: DrilldownPreset | null; config: DrillConfig;
}) {
  const [from, setFrom] = useState(kampalaDate());
  const [to, setTo] = useState(kampalaDate());
  const [status, setStatus] = useState('');
  const [method, setMethod] = useState('');
  const [type, setType] = useState('');
  const [person, setPerson] = useState('');
  const [params, setParams] = useState<Record<string, string> | null>(null);
  const [active, setActive] = useState<DrilldownPreset | null>(null);
  const [exporting, setExporting] = useState(false);

  useEffect(() => {
    if (!open) return;
    if (preset) {
      setFrom(preset.from); setTo(preset.to); setStatus(preset.status); setMethod(''); setType(''); setPerson('');
      setActive(preset);
      setParams({ from: preset.from, to: preset.to, status: preset.status, method: '', type: '', person: '' });
    } else {
      const t = kampalaDate();
      setFrom(t); setTo(t); setActive(null);
      setParams({ from: t, to: t, status, method, type, person });
    }
  }, [open, preset]);

  const generate = () => { setActive(null); setParams({ from, to, status, method, type, person }); };

  const filterArgs = () => {
    const p = params!;
    const end = new Date(p.to + 'T00:00:00Z'); end.setUTCDate(end.getUTCDate() + 1);
    return {
      p_from: new Date(p.from + 'T00:00:00+03:00').toISOString(),
      p_to: new Date(end.toISOString().slice(0, 10) + 'T00:00:00+03:00').toISOString(),
      p_status: p.status || null, p_method: p.method || null, p_type: p.type || null,
      person: p.person.trim() || null,
    };
  };
  const fetchPage = async (offset: number, limit: number) => {
    const { person: who, ...a } = filterArgs();
    const { data, error } = await (supabase.rpc as any)(config.rpc, { ...a, [config.payerParam]: who, p_offset: offset, p_limit: limit });
    if (error) throw error;
    return (data ?? []) as any[];
  };

  const totalsQ = useQuery({
    queryKey: [config.kind, 'totals', params],
    enabled: open && !!params,
    queryFn: async () => {
      const { person: who, ...a } = filterArgs();
      const { data, error } = await (supabase.rpc as any)('get_cfo_money_drilldown_totals', { p_kind: config.kind, ...a, p_person: who });
      if (error) throw error;
      const r = (data ?? [])[0] ?? {};
      return {
        count: Number(r.match_count ?? 0), confirmedCount: Number(r.confirmed_count ?? 0), pendingCount: Number(r.pending_count ?? 0),
        confirmed: Number(r.confirmed_amount ?? 0), pending: Number(r.pending_amount ?? 0),
      };
    },
  });

  const q = useInfiniteQuery({
    queryKey: [config.rpc, 'pages', params],
    enabled: open && !!params,
    initialPageParam: 0,
    queryFn: ({ pageParam }) => fetchPage(pageParam as number, PAGE),
    getNextPageParam: (last, all) => (last.length < PAGE ? undefined : all.length * PAGE),
  });
  const rows = q.data?.pages.flat() ?? [];
  const t = totalsQ.data;
  const matchCount = t?.count ?? 0;

  let recon: { ok: boolean; text: string } | null = null;
  if (active?.expected && t) {
    const e = active.expected;
    const got = e.basis === 'pending' ? t.pending : t.confirmed;
    const gotCount = e.basis === 'pending' ? t.pendingCount : t.confirmedCount;
    const ok = Math.round(got) === Math.round(e.amount) && gotCount === e.count;
    recon = { ok, text: ok
      ? `Reconciles to the card: ${formatUGX(e.amount)} across ${e.count.toLocaleString()} transactions.`
      : `Does not match the card (card ${formatUGX(e.amount)} / ${e.count.toLocaleString()}; report ${formatUGX(got)} / ${gotCount.toLocaleString()}). The figures may have changed since the card loaded — refresh and try again.` };
  }

  const exportCsv = async () => {
    setExporting(true);
    try {
      const all: any[] = [];
      for (let off = 0; ; off += EXPORT_CHUNK) {
        const chunk = await fetchPage(off, EXPORT_CHUNK);
        all.push(...chunk);
        if (chunk.length < EXPORT_CHUNK) break;
      }
      const esc = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""')}"`;
      const lines = all.map(r => config.columns.map(c => esc(c.csv(r))).join(','));
      const blob = new Blob([[config.columns.map(c => esc(c.head)).join(','), ...lines].join('\n')], { type: 'text/csv' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `${config.filename}_${params?.from}_${params?.to}.csv`;
      a.click();
      URL.revokeObjectURL(a.href);
    } catch (e) {
      toast.error(errText(e));
    } finally { setExporting(false); }
  };
  const loading = q.isFetching || totalsQ.isFetching;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-6xl max-h-[90vh] overflow-hidden flex flex-col">
        <DialogHeader>
          <DialogTitle>{config.title}{active ? ` — ${active.label}` : ''}</DialogTitle>
          <DialogDescription>{config.description}</DialogDescription>
        </DialogHeader>

        <div className="flex flex-wrap gap-2">
          {[
            { label: 'Today', f: 0, t: 0 },
            { label: 'Yesterday', f: 1, t: 1 },
            { label: 'Last 7 days', f: 6, t: 0 },
            { label: 'This month', f: -1, t: 0 },
          ].map(r => {
            const ago = (k: number) => { const dt = new Date(); dt.setDate(dt.getDate() - k); return kampalaDate(dt); };
            const rf = r.f === -1 ? monthStart() : ago(r.f);
            const rt = ago(r.t);
            const on = from === rf && to === rt;
            return (
              <Button key={r.label} type="button" size="sm" variant={on ? 'default' : 'outline'}
                onClick={() => { setFrom(rf); setTo(rt); setActive(null); setParams({ from: rf, to: rt, status, method, type, person }); }}>
                {r.label}
              </Button>
            );
          })}
        </div>

        <div className="grid grid-cols-2 md:grid-cols-5 gap-2 items-end">
          <label className="text-xs flex flex-col">Type
            <select className={sel} value={type} onChange={e => setType(e.target.value)}>
              <option value="">All</option>{config.types.map(t => <option key={t}>{t}</option>)}
            </select></label>
          <label className="text-xs flex flex-col">Method
            <select className={sel} value={method} onChange={e => setMethod(e.target.value)}>
              <option value="">All</option><option value="mobile_money">Mobile money</option>
              <option value="bank_transfer">Bank transfer</option><option value="cash">Cash</option>
            </select></label>
          <label className="text-xs flex flex-col">Status
            <select className={sel} value={status} onChange={e => setStatus(e.target.value)}>
              <option value="">All</option>{config.statuses.map(s => <option key={s.value} value={s.value}>{s.label}</option>)}
            </select></label>
          <label className="text-xs">{config.personLabel}<Input placeholder="Name or phone" value={person} onChange={e => setPerson(e.target.value)} /></label>
          <Button onClick={generate} disabled={loading}>
            {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Generate'}
          </Button>
        </div>

        {params && (
          <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
            <span>
              {totalsQ.error ? <span className="text-destructive">{errText(totalsQ.error)}</span>
                : !t ? <span className="text-muted-foreground inline-flex items-center gap-1"><Loader2 className="h-3 w-3 animate-spin" /> Calculating totals…</span>
                : <>
                    {matchCount.toLocaleString()} transactions · {config.confirmedLabel} <b className="text-primary">{formatUGX(t.confirmed)}</b>
                    {t.pending > 0 && <> · Pending <b>{formatUGX(t.pending)}</b></>}
                    {matchCount > rows.length && <span className="text-muted-foreground"> · showing {rows.length.toLocaleString()} (totals cover all)</span>}
                  </>}
            </span>
            <Button size="sm" variant="outline" onClick={exportCsv} disabled={!rows.length || exporting}>
              {exporting ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : <Download className="h-4 w-4 mr-1" />} Export CSV
            </Button>
          </div>
        )}
        {recon && (
          <div className={`flex items-center gap-2 rounded-md px-3 py-2 text-xs ${recon.ok ? 'bg-muted text-foreground' : 'bg-destructive/10 text-destructive'}`}>
            {recon.ok ? <CheckCircle2 className="h-4 w-4 shrink-0" /> : <AlertTriangle className="h-4 w-4 shrink-0" />}{recon.text}
          </div>
        )}

        <div className="overflow-auto flex-1 border rounded-md">
          {!params ? <p className="p-6 text-sm text-muted-foreground">Choose filters and tap Generate.</p>
            : q.error && !rows.length ? (
              <div className="p-6 text-sm text-destructive space-y-2">
                <p>{errText(q.error)}</p>
                <Button size="sm" variant="outline" onClick={() => { q.refetch(); totalsQ.refetch(); }}>Try again</Button>
              </div>
            )
            : q.isLoading ? <p className="p-6 text-sm text-muted-foreground inline-flex items-center gap-2"><Loader2 className="h-4 w-4 animate-spin" /> Loading first {PAGE} transactions…</p>
            : !rows.length ? <p className="p-6 text-sm text-muted-foreground">No transactions match these filters.</p>
            : (
              <>
                <table className="w-full text-xs">
                  <thead className="bg-muted sticky top-0">
                    <tr>{config.columns.map(c => <th key={c.head} className="text-left p-2 whitespace-nowrap">{c.head}</th>)}</tr>
                  </thead>
                  <tbody>
                    {rows.map(r => (
                      <tr key={r.id} className="border-t align-top">
                        {config.columns.map(c => <td key={c.head} className={`p-2 ${c.className ?? ''}`}>{c.cell(r)}</td>)}
                      </tr>
                    ))}
                  </tbody>
                </table>
                {q.hasNextPage && (
                  <div className="p-3 flex justify-center">
                    <Button size="sm" variant="outline" onClick={() => q.fetchNextPage()} disabled={q.isFetchingNextPage}>
                      {q.isFetchingNextPage ? <Loader2 className="h-4 w-4 animate-spin" /> : `Load ${PAGE} more`}
                    </Button>
                  </div>
                )}
                {q.error && rows.length > 0 && <p className="p-3 text-xs text-destructive text-center">{errText(q.error)}</p>}
              </>
            )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
