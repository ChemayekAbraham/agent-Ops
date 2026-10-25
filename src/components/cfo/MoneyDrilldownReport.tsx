import { useEffect, useState } from 'react';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { toast } from 'sonner';
import { supabase } from '@/integrations/supabase/client';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { formatUGX } from '@/lib/creditFeeCalculations';
import { CheckCircle2, AlertTriangle, Download, Loader2, ArrowRightLeft, Search } from 'lucide-react';

/** A preset opened from a card metric. `expected` is the figure shown on the card. */
export type DrilldownPreset = {
  label: string; from: string; to: string; status: string;
  /** Preselected type filter (source group for the credits report). */
  type?: string;
  expected?: { amount: number; count: number; basis: 'confirmed' | 'pending' };
};

export type DrillColumn = { head: string; cell: (r: any) => React.ReactNode; csv: (r: any) => unknown; className?: string };

export type DrillConfig = {
  title: string; description: string; rpc: string; kind: 'paid_out' | 'received' | 'credits'; payerParam: string; filename: string;
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
  const [projecting, setProjecting] = useState(false);

  useEffect(() => {
    if (!open) return;
    if (preset) {
      setFrom(preset.from); setTo(preset.to); setStatus(preset.status); setMethod(''); setType(preset.type ?? ''); setPerson('');
      setActive(preset);
      setParams({ from: preset.from, to: preset.to, status: preset.status, method: '', type: preset.type ?? '', person: '' });
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
    const range = {
      p_from: new Date(p.from + 'T00:00:00+03:00').toISOString(),
      p_to: new Date(end.toISOString().slice(0, 10) + 'T00:00:00+03:00').toISOString(),
    };
    if (config.kind === 'credits') {
      // Credits report: type is the friendly source group; no status or method filters.
      return { ...range, p_type: p.type || null, person: p.person.trim() || null };
    }
    return {
      ...range,
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
  // Next-7-days projection: average daily confirmed amount over the past 28 Kampala days × 7.
  // Read-only estimate from the same server totals aggregate; nothing is stored.
  const projQ = useQuery({
    queryKey: [config.kind, 'projection', type, method, person, kampalaDate()],
    enabled: open && projecting,
    queryFn: async () => {
      const today = kampalaDate();
      const start = new Date(today + 'T00:00:00Z'); start.setUTCDate(start.getUTCDate() - 28);
      const args: any = {
        p_kind: config.kind,
        p_from: new Date(start.toISOString().slice(0, 10) + 'T00:00:00+03:00').toISOString(),
        p_to: new Date(today + 'T00:00:00+03:00').toISOString(),
        p_type: type || null, p_person: person.trim() || null,
      };
      if (config.kind !== 'credits') { args.p_status = null; args.p_method = method || null; }
      const { data, error } = await (supabase.rpc as any)('get_cfo_money_drilldown_totals', args);
      if (error) throw error;
      const r = (data ?? [])[0] ?? {};
      const amt = Number(r.confirmed_amount ?? 0), cnt = Number(r.confirmed_count ?? 0);
      const days = Array.from({ length: 7 }, (_, i) => {
        const d = new Date(today + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + i + 1);
        return d.toISOString().slice(0, 10);
      });
      return { daily: amt / 28, dailyCount: cnt / 28, total: (amt / 28) * 7, count: Math.round((cnt / 28) * 7), days };
    },
  });

  const loading = q.isFetching || totalsQ.isFetching;
  const isPayout = config.kind === 'paid_out';

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className={isPayout ? 'w-[calc(100%-16px)] max-w-6xl max-h-[94vh] overflow-hidden flex flex-col gap-5 rounded-lg bg-card p-4 sm:p-5' : 'max-w-6xl max-h-[90vh] overflow-hidden flex flex-col'}>
        <DialogHeader className={isPayout ? 'relative pl-12 pr-10 text-left space-y-1' : undefined}>
          {isPayout && <div className="absolute left-0 top-0 flex h-9 w-9 items-center justify-center rounded-lg bg-primary/10 text-primary"><ArrowRightLeft className="h-5 w-5" aria-hidden="true" /></div>}
          <DialogTitle className={isPayout ? 'text-xl font-semibold leading-6 tracking-normal' : undefined}>{config.title}{active ? ` — ${active.label}` : ''}</DialogTitle>
          <DialogDescription className={isPayout ? 'text-[11px] leading-4' : undefined}>{config.description}</DialogDescription>
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
            const on = !projecting && from === rf && to === rt;
            return (
              <Button key={r.label} type="button" size="sm" variant={on ? 'default' : 'outline'} className={isPayout ? 'h-9 rounded-lg px-5 text-[11px] font-medium shadow-none' : undefined}
                onClick={() => { setProjecting(false); setFrom(rf); setTo(rt); setActive(null); setParams({ from: rf, to: rt, status, method, type, person }); }}>
                {r.label}
              </Button>
            );
          })}
          <Button type="button" size="sm" variant={projecting ? 'default' : 'outline'} className={isPayout ? 'h-9 rounded-lg px-5 text-[11px] font-medium shadow-none' : undefined} onClick={() => setProjecting(true)}>
            Next 7 days (projection)
          </Button>
        </div>

        {projecting && (
          <div className="rounded-md border bg-muted/40 p-3 text-sm space-y-2">
            {projQ.error ? <p className="text-destructive">{errText(projQ.error)}</p>
              : !projQ.data ? <p className="text-muted-foreground inline-flex items-center gap-1"><Loader2 className="h-3 w-3 animate-spin" /> Calculating projection…</p>
              : <>
                  <p>Projected next 7 days: <b className="text-primary">{formatUGX(projQ.data.total)}</b> · about {projQ.data.count.toLocaleString()} transactions</p>
                  <div className="grid grid-cols-2 sm:grid-cols-4 md:grid-cols-7 gap-2 text-xs">
                    {projQ.data.days.map(d => (
                      <div key={d} className="rounded border bg-background p-2">
                        <div className="text-muted-foreground">{d.slice(5)}</div>
                        <div className="font-medium">{formatUGX(projQ.data!.daily)}</div>
                      </div>
                    ))}
                  </div>
                  <p className="text-xs text-muted-foreground">Estimate based on the daily average of confirmed amounts over the past 28 days, using the Type{config.kind !== 'credits' ? ', Method' : ''} and name filters above. Not actual money movement.</p>
                </>}
          </div>
        )}

        <div className={isPayout ? 'grid grid-cols-2 gap-3 items-end md:grid-cols-[1fr_1fr_1fr_1.15fr_0.82fr] [&_label]:gap-1.5 [&_label]:text-[11px]' : 'grid grid-cols-2 md:grid-cols-5 gap-2 items-end'}>
          <label className="text-xs flex flex-col">Type
            <select className={isPayout ? `${sel} w-full rounded-lg bg-card text-xs` : sel} value={type} onChange={e => setType(e.target.value)}>
              <option value="">All</option>{config.types.map(t => <option key={t}>{t}</option>)}
            </select></label>
          {config.kind !== 'credits' && (<>
          <label className="text-xs flex flex-col">Method
            <select className={isPayout ? `${sel} w-full rounded-lg bg-card text-xs` : sel} value={method} onChange={e => setMethod(e.target.value)}>
              <option value="">All</option><option value="mobile_money">Mobile money</option>
              <option value="bank_transfer">Bank transfer</option><option value="cash">Cash</option>
            </select></label>
          <label className="text-xs flex flex-col">Status
            <select className={isPayout ? `${sel} w-full rounded-lg bg-card text-xs` : sel} value={status} onChange={e => setStatus(e.target.value)}>
              <option value="">All</option>{config.statuses.map(s => <option key={s.value} value={s.value}>{s.label}</option>)}
            </select></label>
          </>)}
          <label className={isPayout ? 'text-xs flex flex-col' : 'text-xs'}>{config.personLabel}<div className="relative">{isPayout && <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />}<Input className={isPayout ? 'h-9 rounded-lg bg-card pl-9 text-xs' : undefined} placeholder="Name or phone" value={person} onChange={e => setPerson(e.target.value)} /></div></label>
          <Button className={isPayout ? 'h-9 rounded-lg text-xs shadow-none col-span-2 md:col-span-1' : undefined} onClick={generate} disabled={loading}>
            {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : 'Generate'}
          </Button>
        </div>

        {params && (
          <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
            <span className={isPayout ? 'font-semibold text-[13px]' : undefined}>
              {totalsQ.error ? <span className="text-destructive">{errText(totalsQ.error)}</span>
                : !t ? <span className="text-muted-foreground inline-flex items-center gap-1"><Loader2 className="h-3 w-3 animate-spin" /> Calculating totals…</span>
                : <>
                    {matchCount.toLocaleString()} transactions · {config.confirmedLabel} <b className="text-primary">{formatUGX(t.confirmed)}</b>
                    {t.pending > 0 && <> · Pending <b>{formatUGX(t.pending)}</b></>}
                    {matchCount > rows.length && <span className="text-muted-foreground"> · showing {rows.length.toLocaleString()} (totals cover all)</span>}
                  </>}
            </span>
            <Button size="sm" variant="outline" className={isPayout ? 'h-9 rounded-lg text-[11px] shadow-none' : undefined} onClick={exportCsv} disabled={!rows.length || exporting}>
              {exporting ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : <Download className="h-4 w-4 mr-1" />} Export CSV
            </Button>
          </div>
        )}
        {recon && (
          <div className={`flex items-center gap-2 rounded-md px-3 py-2 text-xs ${recon.ok ? 'bg-muted text-foreground' : 'bg-destructive/10 text-destructive'}`}>
            {recon.ok ? <CheckCircle2 className="h-4 w-4 shrink-0" /> : <AlertTriangle className="h-4 w-4 shrink-0" />}{recon.text}
          </div>
        )}

        <div className={isPayout ? 'overflow-auto min-h-0 flex-1 border border-border rounded-lg' : 'overflow-auto flex-1 border rounded-md'}>
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
                <table className={isPayout ? 'w-full min-w-[1020px] text-[10px] leading-[14px]' : 'w-full text-xs'}>
                  <thead className={isPayout ? 'bg-muted/70 sticky top-0 z-10' : 'bg-muted sticky top-0'}>
                    <tr>{config.columns.map(c => <th key={c.head} className={isPayout ? 'text-left px-2.5 py-3 whitespace-nowrap font-semibold text-[9px]' : 'text-left p-2 whitespace-nowrap'}>{c.head}</th>)}</tr>
                  </thead>
                  <tbody>
                    {rows.map(r => (
                      <tr key={r.id} className={isPayout ? 'border-t border-border/70 align-middle hover:bg-muted/30' : 'border-t align-top'}>
                        {config.columns.map(c => <td key={c.head} className={`${isPayout ? 'px-2.5 py-3' : 'p-2'} ${c.className ?? ''}`}>{c.cell(r)}</td>)}
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
