import { useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { ArrowLeft, ChevronRight } from 'lucide-react';
import {
  ResponsiveContainer, LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend,
} from 'recharts';
import { formatUGX } from '@/lib/rentCalculations';
import {
  useReceivablesBreakdown, useReceivablesPredictiveForecast, useTenantReceivablesByLocation,
  useTenantReceivableAccounts, type ForecastGranularity, type TenantReceivablesLevel,
  type ReceivableItem,
} from '@/hooks/useReceivables';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';

/**
 * Read-only CFO Receivables Analysis. Every figure comes from the existing
 * authoritative receivables RPCs; nothing here writes data.
 */

const PERIODS: { key: string; label: string; g: ForecastGranularity; n: number }[] = [
  { key: '7d', label: 'Next 7 days', g: 'day', n: 7 },
  { key: '1m', label: '1 month', g: 'week', n: 5 },
  { key: '3m', label: '3 months', g: 'month', n: 3 },
  { key: '6m', label: '6 months', g: 'month', n: 6 },
  { key: '9m', label: '9 months', g: 'month', n: 9 },
  { key: '1y', label: '1 year', g: 'month', n: 12 },
  { key: '2y', label: '2 years', g: 'month', n: 24 },
];
const LEVELS: TenantReceivablesLevel[] = ['region', 'district', 'subcounty', 'village'];
const LEVEL_LABEL: Record<TenantReceivablesLevel, string> = {
  region: 'Region', district: 'District', subcounty: 'Sub-county', village: 'Village',
};
const PAGE = 15;
const today = () => new Date(Date.now() + 3 * 3600e3).toISOString().slice(0, 10);
const daysBetween = (a: string, b: string) => Math.round((Date.parse(b) - Date.parse(a)) / 864e5);
const isTenantCat = (k: string) => /tenant/i.test(k);

type Crumb = { level: TenantReceivablesLevel; label: string; region?: string | null; districtId?: number | null; subcountyId?: number | null };

function Figure({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="min-w-0 py-3 sm:px-4 first:pl-0">
      <p className="text-[11px] uppercase tracking-wider text-muted-foreground">{label}</p>
      <p className="mt-1 text-lg sm:text-xl font-semibold tabular-nums break-words">{value}</p>
      {sub && <p className="text-[11px] text-muted-foreground">{sub}</p>}
    </div>
  );
}

function Section({ title, right, children }: { title: string; right?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="border-t border-border/60 pt-6">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-sm font-semibold tracking-tight">{title}</h2>
        {right}
      </div>
      {children}
    </section>
  );
}

function Pager({ page, pages, set }: { page: number; pages: number; set: (n: number) => void }) {
  if (pages <= 1) return null;
  return (
    <div className="mt-3 flex items-center justify-end gap-2 text-xs text-muted-foreground">
      <Button size="sm" variant="ghost" disabled={page === 0} onClick={() => set(page - 1)}>Previous</Button>
      <span className="tabular-nums">{page + 1} / {pages}</span>
      <Button size="sm" variant="ghost" disabled={page >= pages - 1} onClick={() => set(page + 1)}>Next</Button>
    </div>
  );
}

const Insufficient = () => <span className="text-muted-foreground text-xs">Insufficient data</span>;

export default function ReceivablesAnalysis() {
  const [params, setParams] = useSearchParams();
  const cat = params.get('cat') ?? 'all';
  const periodKey = params.get('p') ?? '3m';
  const statusF = params.get('status') ?? 'all';
  const dueFrom = params.get('from') ?? '';
  const dueTo = params.get('to') ?? '';
  const setParam = (k: string, v: string) => {
    const n = new URLSearchParams(params);
    if (v) n.set(k, v); else n.delete(k);
    setParams(n, { replace: true });
  };

  const breakdown = useReceivablesBreakdown();
  const cats = breakdown.data?.categories ?? [];
  const selectedCat = cats.find((c) => c.key === cat);

  // ---------- Current position (from authoritative items) ----------
  const t = today();
  const items: (ReceivableItem & { product: string; category: string })[] = useMemo(() => {
    const src = cat === 'all' ? cats : cats.filter((c) => c.key === cat);
    return src.flatMap((c) => c.products.flatMap((p) => (p.items ?? []).map((i) => ({ ...i, product: p.label, category: c.label }))));
  }, [cats, cat]);
  const filteredItems = useMemo(() => items.filter((i) => {
    const overdue = !!i.due_date && i.due_date < t;
    if (statusF === 'overdue' && !overdue) return false;
    if (statusF === 'current' && overdue) return false;
    if (dueFrom && (!i.due_date || i.due_date < dueFrom)) return false;
    if (dueTo && (!i.due_date || i.due_date > dueTo)) return false;
    return true;
  }), [items, statusF, dueFrom, dueTo, t]);

  const outstanding = cat === 'all' ? breakdown.data?.total ?? 0 : selectedCat?.outstanding ?? 0;
  const count = cat === 'all' ? cats.reduce((s, c) => s + c.item_count, 0) : selectedCat?.item_count ?? 0;
  const dated = filteredItems.filter((i) => i.due_date);
  const overdueAmt = dated.filter((i) => i.due_date! < t).reduce((s, i) => s + i.amount, 0);
  const due7 = dated.filter((i) => i.due_date! >= t && daysBetween(t, i.due_date!) <= 7).reduce((s, i) => s + i.amount, 0);
  const hasDates = dated.length > 0;

  // ---------- Projection ----------
  const period = PERIODS.find((p) => p.key === periodKey) ?? PERIODS[2];
  const forecast = useReceivablesPredictiveForecast(period.g, period.n);
  const fc = forecast.data;
  const proj = useMemo(() => {
    if (!fc) return [];
    let bal = outstanding;
    return fc.periods.map((p) => {
      const amt = cat === 'all' ? p.forecast_amount
        : p.sources.filter((s) => s.category_key === cat).reduce((s, x) => s + x.amount, 0);
      bal = Math.max(0, bal - amt);
      return { label: p.label, start: p.period_start, collections: amt, balance: bal, quality: p.quality, low: p.low, high: p.high };
    });
  }, [fc, cat, outstanding]);
  const chartData = useMemo(() => [
    ...(fc?.history ?? []).slice(-Math.max(6, period.n)).map((h) => ({ label: h.label, actual: h.actual_amount })),
    ...proj.map((p) => ({ label: p.label, projected: p.quality === 'insufficient' ? null : p.collections })),
  ], [fc, proj, period.n]);
  const reliable = proj.filter((p) => p.quality !== 'insufficient');
  const totalExpected = reliable.reduce((s, p) => s + p.collections, 0);
  const peak = reliable.reduce<typeof proj[number] | null>((m, p) => (!m || p.collections > m.collections ? p : m), null);

  // ---------- Location drill (tenant receivables) ----------
  const [crumbs, setCrumbs] = useState<Crumb[]>([]);
  const [village, setVillage] = useState<string | null>(null);
  const [locSearch, setLocSearch] = useState('');
  const [locSort, setLocSort] = useState<'outstanding' | 'item_count' | 'label'>('outstanding');
  const [locPage, setLocPage] = useState(0);
  const [recPage, setRecPage] = useState(0);
  const last = crumbs[crumbs.length - 1];
  const level: TenantReceivablesLevel = last ? LEVELS[Math.min(LEVELS.indexOf(last.level) + 1, 3)] : 'region';
  const locFilters = { level, region: last?.region ?? null, districtId: last?.districtId ?? null, subcountyId: last?.subcountyId ?? null };
  const locEnabled = cat === 'all' || isTenantCat(cat);
  const loc = useTenantReceivablesByLocation(locFilters, locEnabled);
  const records = useTenantReceivableAccounts({ ...locFilters, groupLabel: village, limit: 500 }, locEnabled && !!village);

  const locRows = useMemo(() => {
    const rows = (loc.data?.rows ?? []).filter((r) => r.label.toLowerCase().includes(locSearch.toLowerCase()));
    return [...rows].sort((a, b) => locSort === 'label' ? a.label.localeCompare(b.label) : (b[locSort] as number) - (a[locSort] as number));
  }, [loc.data, locSearch, locSort]);
  const locTotal = loc.data?.total ?? 0;

  const drill = (r: (typeof locRows)[number]) => {
    setLocPage(0); setRecPage(0);
    if (level === 'village') { setVillage(r.label); return; }
    setVillage(null);
    setCrumbs([...crumbs, {
      level, label: r.label,
      region: level === 'region' ? r.region ?? r.label : last?.region ?? null,
      districtId: r.district_id ?? last?.districtId ?? null,
      subcountyId: r.subcounty_id ?? last?.subcountyId ?? null,
    }]);
  };

  const accounts = records.data?.accounts ?? [];
  const recPages = Math.ceil(accounts.length / PAGE);

  return (
    <main className="min-h-screen bg-background">
      <div className="mx-auto max-w-7xl px-4 sm:px-8 py-6 space-y-6">
        <header className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <Link to="/cfo/dashboard" className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
              <ArrowLeft className="h-3 w-3" /> CFO dashboard
            </Link>
            <h1 className="mt-1 text-xl font-semibold tracking-tight">Receivables Analysis</h1>
            <p className="text-xs text-muted-foreground">
              Read-only · as at {breakdown.data?.as_at?.slice(0, 10) ?? '—'} · UGX
            </p>
          </div>
          <div className="w-64">
            <p className="mb-1 text-[11px] uppercase tracking-wider text-muted-foreground">Receivable category</p>
            <Select value={cat} onValueChange={(v) => { setParam('cat', v === 'all' ? '' : v); setCrumbs([]); setVillage(null); }}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All categories</SelectItem>
                {cats.map((c) => <SelectItem key={c.key} value={c.key}>{c.label}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
        </header>

        {/* Filters */}
        <div className="flex flex-wrap items-end gap-3 text-xs">
          <div className="w-40">
            <p className="mb-1 text-muted-foreground">Status</p>
            <Select value={statusF} onValueChange={(v) => setParam('status', v === 'all' ? '' : v)}>
              <SelectTrigger className="h-8"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All</SelectItem>
                <SelectItem value="overdue">Overdue</SelectItem>
                <SelectItem value="current">Current / not yet due</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div>
            <p className="mb-1 text-muted-foreground">Due from</p>
            <Input type="date" className="h-8 w-40" value={dueFrom} onChange={(e) => setParam('from', e.target.value)} />
          </div>
          <div>
            <p className="mb-1 text-muted-foreground">Due to</p>
            <Input type="date" className="h-8 w-40" value={dueTo} onChange={(e) => setParam('to', e.target.value)} />
          </div>
          <p className="text-muted-foreground">Location filters: use the drill-down below (Country → Region → District → Sub-county → Village).</p>
        </div>

        {/* Current position */}
        <section className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 divide-y md:divide-y-0 lg:divide-x divide-border/60">
          <Figure label="Total outstanding" value={breakdown.isLoading ? '—' : formatUGX(outstanding)} sub={cat === 'all' ? 'All categories' : selectedCat?.label} />
          <Figure label="Current / not yet due" value={hasDates ? formatUGX(Math.max(0, outstanding - overdueAmt)) : 'Insufficient data'} />
          <Figure label="Overdue" value={hasDates ? formatUGX(overdueAmt) : 'Insufficient data'} sub={hasDates ? 'Past due date' : undefined} />
          <Figure label="Due in 7 days" value={hasDates ? formatUGX(due7) : 'Insufficient data'} />
          <Figure label="Collection rate" value="Insufficient data" sub="No originated-vs-collected figure per category yet" />
          <Figure label="Accounts / obligations" value={count.toLocaleString()} />
        </section>

        <Section title="Where the balance comes from">
          {!locEnabled ? (
            <p className="text-sm text-muted-foreground">
              Location data is only recorded for tenant receivables. {selectedCat?.label} has no location on record, so no location split is shown rather than a guessed one.
            </p>
          ) : (
            <>
              <div className="mb-3 flex flex-wrap items-center gap-1 text-xs">
                <button className="text-muted-foreground hover:text-foreground" onClick={() => { setCrumbs([]); setVillage(null); setLocPage(0); }}>Uganda</button>
                {crumbs.map((c, i) => (
                  <span key={i} className="flex items-center gap-1">
                    <ChevronRight className="h-3 w-3 text-muted-foreground" />
                    <button className="hover:text-foreground text-muted-foreground" onClick={() => { setCrumbs(crumbs.slice(0, i + 1)); setVillage(null); setLocPage(0); }}>{c.label}</button>
                  </span>
                ))}
                {village && <span className="flex items-center gap-1"><ChevronRight className="h-3 w-3 text-muted-foreground" /><span className="font-medium">{village}</span></span>}
                <span className="ml-auto flex items-center gap-2">
                  <Input placeholder={`Filter ${LEVEL_LABEL[level].toLowerCase()}…`} className="h-8 w-44" value={locSearch} onChange={(e) => { setLocSearch(e.target.value); setLocPage(0); }} />
                  <Select value={locSort} onValueChange={(v) => setLocSort(v as typeof locSort)}>
                    <SelectTrigger className="h-8 w-40"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="outstanding">Sort: outstanding</SelectItem>
                      <SelectItem value="item_count">Sort: count</SelectItem>
                      <SelectItem value="label">Sort: name</SelectItem>
                    </SelectContent>
                  </Select>
                </span>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="text-[11px] uppercase tracking-wider text-muted-foreground">
                    <tr className="border-b border-border/60">
                      <th className="py-2 text-left font-medium">{LEVEL_LABEL[level]}</th>
                      <th className="py-2 text-right font-medium">Receivables</th>
                      <th className="py-2 text-right font-medium">Outstanding</th>
                      <th className="py-2 text-right font-medium">Scheduled</th>
                      <th className="py-2 text-right font-medium">% of total</th>
                      <th className="py-2 text-right font-medium">Average</th>
                      <th className="py-2" />
                    </tr>
                  </thead>
                  <tbody>
                    {loc.isLoading && <tr><td colSpan={7} className="py-6 text-center text-muted-foreground">Loading…</td></tr>}
                    {locRows.slice(locPage * PAGE, locPage * PAGE + PAGE).map((r) => (
                      <tr key={r.key ?? r.label} onClick={() => drill(r)} className={`border-b border-border/40 cursor-pointer hover:bg-muted/40 ${village === r.label ? 'bg-muted/40' : ''}`}>
                        <td className="py-2">{r.label}{!r.fully_mapped && <span className="ml-2 text-[10px] text-warning">partly unmapped</span>}</td>
                        <td className="py-2 text-right tabular-nums">{r.item_count.toLocaleString()}</td>
                        <td className="py-2 text-right tabular-nums">{formatUGX(r.outstanding)}</td>
                        <td className="py-2 text-right tabular-nums">{formatUGX(r.scheduled_amount)}</td>
                        <td className="py-2 text-right tabular-nums">{locTotal ? ((r.outstanding / locTotal) * 100).toFixed(1) : '0.0'}%</td>
                        <td className="py-2 text-right tabular-nums">{formatUGX(r.item_count ? r.outstanding / r.item_count : 0)}</td>
                        <td className="py-2 text-right"><ChevronRight className="inline h-4 w-4 text-muted-foreground" /></td>
                      </tr>
                    ))}
                    {!loc.isLoading && locRows.length === 0 && <tr><td colSpan={7} className="py-6 text-center text-muted-foreground">No receivables at this level.</td></tr>}
                  </tbody>
                </table>
              </div>
              <Pager page={locPage} pages={Math.ceil(locRows.length / PAGE)} set={setLocPage} />
              <p className="mt-2 text-[11px] text-muted-foreground">Tenant receivables only. Overdue and collection performance per location are not recorded by location yet.</p>
            </>
          )}
        </Section>

        {village && (
          <Section title={`Underlying receivables · ${village}`} right={<Button size="sm" variant="ghost" onClick={() => setVillage(null)}>Close</Button>}>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="text-[11px] uppercase tracking-wider text-muted-foreground">
                  <tr className="border-b border-border/60">
                    <th className="py-2 text-left font-medium">Account</th>
                    <th className="py-2 text-left font-medium">Products</th>
                    <th className="py-2 text-right font-medium">Outstanding</th>
                    <th className="py-2 text-right font-medium">Overdue</th>
                    <th className="py-2 text-right font-medium">Next due</th>
                    <th className="py-2 text-right font-medium">Days outstanding</th>
                    <th className="py-2 text-left font-medium pl-4">District</th>
                    <th className="py-2 text-left font-medium">Sub-county</th>
                    <th className="py-2 text-left font-medium">Village</th>
                  </tr>
                </thead>
                <tbody>
                  {records.isLoading && <tr><td colSpan={9} className="py-6 text-center text-muted-foreground">Loading…</td></tr>}
                  {accounts.slice(recPage * PAGE, recPage * PAGE + PAGE).map((a) => {
                    const od = a.items.filter((i) => i.due_date && i.due_date < t).reduce((s, i) => s + i.amount, 0);
                    const oldest = a.items.map((i) => i.due_date).filter(Boolean).sort()[0] as string | undefined;
                    return (
                      <tr key={a.tenant_id} className="border-b border-border/40">
                        <td className="py-2">{a.tenant ?? '—'}<div className="text-[11px] text-muted-foreground">{a.phone ?? ''}</div></td>
                        <td className="py-2 text-xs text-muted-foreground">{[...new Set(a.items.map((i) => i.product))].join(', ')}</td>
                        <td className="py-2 text-right tabular-nums">{formatUGX(a.outstanding)}</td>
                        <td className={`py-2 text-right tabular-nums ${od > 0 ? 'text-destructive' : ''}`}>{formatUGX(od)}</td>
                        <td className="py-2 text-right tabular-nums">{a.next_due_date ?? '—'}</td>
                        <td className="py-2 text-right tabular-nums">{oldest && oldest < t ? daysBetween(oldest, t) : '—'}</td>
                        <td className="py-2 pl-4">{a.district ?? '—'}</td>
                        <td className="py-2">{a.subcounty ?? '—'}</td>
                        <td className="py-2">{a.village ?? '—'}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <Pager page={recPage} pages={recPages} set={setRecPage} />
            <p className="mt-2 text-[11px] text-muted-foreground">Original amount and amount collected per record are not returned by the receivables source yet.</p>
          </Section>
        )}

        <Section
          title="Receivables projection"
          right={
            <div className="flex flex-wrap gap-1">
              {PERIODS.map((p) => (
                <Button key={p.key} size="sm" variant={p.key === period.key ? 'secondary' : 'ghost'} className="h-7 text-xs" onClick={() => setParam('p', p.key)}>{p.label}</Button>
              ))}
            </div>
          }
        >
          {forecast.isLoading ? <p className="text-sm text-muted-foreground">Loading projection…</p> : forecast.isError ? <p className="text-sm text-destructive">Projection could not be loaded.</p> : (
            <>
              <section className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 lg:divide-x divide-border/60 mb-4">
                <Figure label="Expected collections" value={reliable.length ? formatUGX(totalExpected) : 'Insufficient data'} sub={period.label} />
                <Figure label="Expected outstanding" value={reliable.length ? formatUGX(proj[proj.length - 1]?.balance ?? 0) : 'Insufficient data'} sub="End of period, before new receivables" />
                <Figure label="Expected overdue" value="Insufficient data" />
                <Figure label="Peak collection period" value={peak?.label ?? '—'} />
                <Figure label="Expected no. of collections" value="Insufficient data" />
                <Figure label="Expected cash inflow" value={reliable.length ? formatUGX(totalExpected) : 'Insufficient data'} />
              </section>
              <div className="h-64">
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={chartData} margin={{ left: 8, right: 8 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" vertical={false} />
                    <XAxis dataKey="label" tick={{ fontSize: 10 }} stroke="hsl(var(--muted-foreground))" />
                    <YAxis tick={{ fontSize: 10 }} stroke="hsl(var(--muted-foreground))" tickFormatter={(v) => `${(v / 1e6).toFixed(1)}M`} />
                    <Tooltip formatter={(v: number) => formatUGX(v)} />
                    <Legend wrapperStyle={{ fontSize: 11 }} />
                    <Line type="monotone" dataKey="actual" name="Actual" stroke="hsl(var(--foreground))" strokeWidth={2} dot={false} connectNulls={false} />
                    <Line type="monotone" dataKey="projected" name="Projected" stroke="hsl(var(--primary))" strokeWidth={2} strokeDasharray="5 4" dot={false} />
                  </LineChart>
                </ResponsiveContainer>
              </div>
              <div className="mt-4 overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="text-[11px] uppercase tracking-wider text-muted-foreground">
                    <tr className="border-b border-border/60">
                      <th className="py-2 text-left font-medium">Period</th>
                      <th className="py-2 text-right font-medium">Expected collections</th>
                      <th className="py-2 text-right font-medium">Range</th>
                      <th className="py-2 text-right font-medium">Expected outstanding</th>
                      <th className="py-2 text-right font-medium">Confidence</th>
                    </tr>
                  </thead>
                  <tbody>
                    {proj.map((p) => (
                      <tr key={p.start} className="border-b border-border/40">
                        <td className="py-2">{p.label}</td>
                        <td className="py-2 text-right tabular-nums">{p.quality === 'insufficient' ? <Insufficient /> : formatUGX(p.collections)}</td>
                        <td className="py-2 text-right tabular-nums text-xs text-muted-foreground">{cat === 'all' && p.quality !== 'insufficient' ? `${formatUGX(p.low)} – ${formatUGX(p.high)}` : '—'}</td>
                        <td className="py-2 text-right tabular-nums">{p.quality === 'insufficient' ? <Insufficient /> : formatUGX(p.balance)}</td>
                        <td className={`py-2 text-right text-xs capitalize ${p.quality === 'low' ? 'text-warning' : 'text-muted-foreground'}`}>{p.quality}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p className="mt-3 text-[11px] text-muted-foreground">
                Actual = recorded collections. Projected = modelled from each business line's own collection history and schedules ({fc?.meta.method_note}). No growth rates are assumed. Long horizons beyond the recorded history are marked low confidence.
              </p>
            </>
          )}
        </Section>
      </div>
    </main>
  );
}
