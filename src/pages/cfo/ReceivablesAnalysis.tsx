import { useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { ArrowLeft, ChevronRight } from 'lucide-react';
import {
  ResponsiveContainer, LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend,
} from 'recharts';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { kampalaTodayYmd } from '@/lib/kampalaDays';
import { formatUGX } from '@/lib/rentCalculations';
import {
  useReceivablesBreakdown, useReceivablesPredictiveForecast, useTenantReceivablesByLocation,
  useTenantReceivableAccounts, type ForecastGranularity, type TenantReceivablesLevel,
  type ReceivableItem, type ReceivablesForecast,
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
const today = kampalaTodayYmd;
const daysBetween = (a: string, b: string) => Math.round((Date.parse(b) - Date.parse(a)) / 864e5);
const isTenantCat = (k: string) => /tenant/i.test(k);

type Crumb = { level: TenantReceivablesLevel; label: string; region?: string | null; districtId?: number | null; subcountyId?: number | null };

function Figure({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="min-w-0 py-3 sm:px-4 first:pl-0">
      <p className="text-[11px] uppercase tracking-normal text-muted-foreground">{label}</p>
      <p className="mt-1 text-base font-semibold tabular-nums whitespace-nowrap">{value}</p>
      {sub && <p className="text-[11px] text-muted-foreground">{sub}</p>}
    </div>
  );
}

function Section({ title, right, children }: { title: string; right?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="border-t border-border/60 pt-8">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-sm font-semibold tracking-normal">{title}</h2>
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
  const period = PERIODS.find((p) => p.key === periodKey) ?? PERIODS[2];
  const forecast = useReceivablesPredictiveForecast(period.g, period.n);
  const fc = forecast.data;
  const outstanding = cat === 'all' ? breakdown.data?.total ?? 0 : selectedCat?.outstanding ?? 0;
  const count = cat === 'all' ? cats.reduce((s, c) => s + c.item_count, 0) : selectedCat?.item_count ?? 0;
  const completeItems = (cat === 'all' ? cats : cats.filter(c => c.key === cat))
    .every(c => c.products.every(p => p.items.length === p.item_count));
  const dated = items.filter(i => i.due_date);
  const overdueAmt = cat === 'all' ? fc?.actual.overdue : completeItems
    ? dated.filter(i => i.due_date && i.due_date < t).reduce((s, i) => s + i.amount, 0) : undefined;
  const currentAmt = cat === 'all' ? fc?.actual.not_yet_due : completeItems && overdueAmt !== undefined
    ? Math.max(0, outstanding - overdueAmt) : undefined;

  // Full-book date-window totals; never derive full totals from the top-100 item sample.
  const ideal = useQuery({
    queryKey: ['receivables-analysis-ideal', period.g, period.n, fc?.as_at],
    enabled: !!fc,
    staleTime: 5 * 60 * 1000,
    queryFn: async () => {
      const periods = fc?.periods ?? [];
      const results: ReceivablesForecast[] = [];
      for (let start = 0; start < periods.length; start += 4) {
        const batch = await Promise.all(periods.slice(start, start + 4).map(async p => {
          const { data, error } = await supabase.rpc('get_receivables_forecast', {
            p_from: p.forecast_from, p_to: p.period_end,
          });
          if (error) throw error;
          return data as unknown as ReceivablesForecast;
        }));
        results.push(...batch);
      }
      return results;
    },
  });
  const dueSoon = useQuery({
    queryKey: ['receivables-analysis-due-soon', t], staleTime: 5 * 60 * 1000,
    queryFn: async () => {
      const end = new Date(Date.parse(t) + 6 * 864e5).toISOString().slice(0, 10);
      const { data, error } = await supabase.rpc('get_receivables_forecast', { p_from: t, p_to: end });
      if (error) throw error;
      return data as unknown as ReceivablesForecast;
    },
  });
  const dueSoonAmt = dueSoon.data?.products.filter(p => cat === 'all' || p.category_key === cat)
    .reduce((sum, p) => sum + p.total, 0);
  const streams = fc?.streams.filter(s => cat === 'all' || s.category_key === cat) ?? [];
  const hasBehaviour = streams.some(s => !s.insufficient_data);
  const proj = (fc?.periods ?? []).map((p, index) => {
    const sources = p.sources.filter(s => cat === 'all' || s.category_key === cat);
    const behaviour = hasBehaviour ? sources.filter(s => s.basis === 'modelled')
      .reduce((sum, s) => sum + s.runoff, 0) : null;
    const scheduled = ideal.data?.[index]?.products.filter(s => cat === 'all' || s.category_key === cat)
      .reduce((sum, s) => sum + s.total, 0) ?? null;
    return { label: p.label, start: p.forecast_from, end: p.period_end,
      behaviour, ideal: scheduled, gap: behaviour !== null && scheduled !== null ? scheduled - behaviour : null,
      quality: p.quality };
  });
  const behaviourTotal = hasBehaviour ? proj.reduce((sum, p) => sum + (p.behaviour ?? 0), 0) : null;
  const idealTotal = ideal.data ? proj.reduce((sum, p) => sum + (p.ideal ?? 0), 0) : null;
  const gapTotal = behaviourTotal !== null && idealTotal !== null ? idealTotal - behaviourTotal : null;
  const missingBehaviour = (fc?.scheduled_only_streams ?? []).filter(s => cat === 'all' || s.category_key === cat);

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
    setLocPage(0); setRecPage(0); setLocSearch('');
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
  const locationSelected = crumbs.length > 0 || !!village;
  const scopeLabel = [selectedCat?.label ?? 'All categories', ...crumbs.map(c => c.label), village].filter(Boolean).join(' / ');
  const scopedOutstanding = locationSelected ? (village ? records.data?.total : loc.data?.total) : outstanding;
  const scopedCount = locationSelected ? (village ? records.data?.item_count : loc.data?.item_count) : count;
  const money = (value: number | null | undefined) => value == null ? 'Unavailable' : formatUGX(value);


  return (
    <main className="min-h-screen bg-background">
      <div className="mx-auto max-w-7xl px-4 sm:px-8 py-8 space-y-10">
        <header className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <Link to="/cfo/dashboard" className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
              <ArrowLeft className="h-3 w-3" /> CFO dashboard
            </Link>
            <h1 className="mt-1 text-2xl font-semibold tracking-normal">Receivables Analysis</h1>
            <p className="text-xs text-muted-foreground">
              Read-only · as at {breakdown.data?.as_at?.slice(0, 10) ?? '—'} · UGX
            </p>
          </div>
          <div className="w-full sm:w-80">
            <p className="mb-1 text-[11px] uppercase tracking-normal text-muted-foreground">Receivable category</p>
            <Select value={cat} onValueChange={(v) => { setParam('cat', v === 'all' ? '' : v); setCrumbs([]); setVillage(null); }}>
              <SelectTrigger aria-label="Receivable category" className="rounded-md shadow-none"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All categories</SelectItem>
                {cats.map((c) => <SelectItem key={c.key} value={c.key}>{c.label}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
        </header>

        <p className="text-xs text-muted-foreground" aria-live="polite">{scopeLabel}</p>
        <section aria-label="Receivables summary" className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-5 gap-x-5 gap-y-2 border-y border-border/60 py-5">
          <Figure label="Total outstanding" value={breakdown.isLoading ? '—' : money(scopedOutstanding)} />
          <Figure label="Current" value={money(locationSelected ? undefined : currentAmt)} sub="Not yet due" />
          <Figure label="Overdue" value={money(locationSelected ? undefined : overdueAmt)} sub="Past due date" />
          <Figure label="Due soon" value={money(locationSelected ? undefined : dueSoonAmt)} sub="Today and the next 6 days · Kampala" />
          <Figure label="Accounts / obligations" value={scopedCount?.toLocaleString() ?? 'Unavailable'} />
        </section>

        <Section title="Products & services">
          {locationSelected ? (
            <div className="overflow-x-auto"><table className="w-full text-sm"><thead><tr className="border-b border-border text-muted-foreground"><th className="py-3 text-left">Product / service</th><th className="py-3 text-right">Outstanding</th><th className="py-3 text-right">Obligations</th></tr></thead><tbody>
              {(loc.data?.products ?? []).map(p => <tr key={p.key} className="border-b border-border/50"><td className="py-4">{p.label}</td><td className="py-4 text-right tabular-nums">{formatUGX(p.outstanding)}</td><td className="py-4 text-right">{p.item_count}</td></tr>)}
            </tbody></table>{(loc.isError || village) && <p className="py-3 text-xs text-muted-foreground">Product totals for this location are unavailable.</p>}</div>
          ) : breakdown.isLoading ? (
            <p className="text-sm text-muted-foreground">Loading…</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border text-left text-[11px] uppercase tracking-normal text-muted-foreground">
                    <th className="py-4">Product / service</th>
                    {cat === 'all' && <th className="py-4">Category</th>}
                    <th className="py-4 text-right">Accounts</th>
                    <th className="py-4 text-right">Outstanding</th>
                    <th className="py-4 text-right">% of total</th>
                  </tr>
                </thead>
                <tbody>
                  {(cat === 'all' ? cats : cats.filter((c) => c.key === cat)).flatMap((c) =>
                    c.products.map((p) => (
                      <tr key={`${c.key}-${p.label}`} className="border-b border-border/50">
                        <td className="py-4">{p.label}</td>
                        {cat === 'all' && <td className="py-4 text-muted-foreground">{c.label}</td>}
                        <td className="py-4 text-right tabular-nums">{p.item_count.toLocaleString()}</td>
                        <td className="py-4 text-right tabular-nums">{formatUGX(p.outstanding)}</td>
                        <td className="py-4 text-right tabular-nums text-muted-foreground">
                          {outstanding > 0 ? `${((p.outstanding / outstanding) * 100).toFixed(1)}%` : '—'}
                        </td>
                      </tr>
                    )),
                  )}
                  {(cat === 'all' ? cats : cats.filter((c) => c.key === cat)).every((c) => c.products.length === 0) && (
                    <tr><td colSpan={5} className="py-6 text-center text-muted-foreground">No products or services recorded for this category.</td></tr>
                  )}
                </tbody>
              </table>
            </div>
          )}
        </Section>

        <Section title="Where the balance comes from">
          {!locEnabled ? (
            <p className="text-sm text-muted-foreground">
              Location breakdown is unavailable for {selectedCat?.label}.
            </p>
          ) : (
            <>
              {cat === 'all' && <p className="mb-4 text-xs text-muted-foreground">Geographic coverage: tenant receivables only. Other categories are not mapped.</p>}
              {loc.isError && <p role="status" className="mb-4 text-sm text-muted-foreground">Location data could not be loaded. No location balances or forecasts are shown.</p>}
              <div className="mb-3 flex flex-wrap items-center gap-1 text-xs">
                <Button variant="ghost" size="sm" className="rounded-sm text-muted-foreground" onClick={() => { setCrumbs([]); setVillage(null); setLocPage(0); setLocSearch(''); }}>Country: Uganda</Button>
                {crumbs.map((c, i) => (
                  <span key={i} className="flex items-center gap-1">
                    <ChevronRight className="h-3 w-3 text-muted-foreground" />
                    <Button variant="ghost" size="sm" className="rounded-sm text-muted-foreground" onClick={() => { setCrumbs(crumbs.slice(0, i + 1)); setVillage(null); setLocPage(0); setLocSearch(''); }}>{c.label}</Button>
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
                  <thead className="text-[11px] uppercase tracking-normal text-muted-foreground">
                    <tr className="border-b border-border/60">
                      <th className="py-4 text-left font-medium">{LEVEL_LABEL[level]}</th>
                      <th className="py-4 text-right font-medium">Receivables</th>
                      <th className="py-4 text-right font-medium">Outstanding</th>
                      <th className="py-4 text-right font-medium">Scheduled</th>
                      <th className="py-4 text-right font-medium">% of total</th>
                      <th className="py-4 text-right font-medium">Average</th>
                      <th className="py-4" />
                    </tr>
                  </thead>
                  <tbody>
                    {loc.isLoading && <tr><td colSpan={7} className="py-6 text-center text-muted-foreground">Loading…</td></tr>}
                    {locRows.slice(locPage * PAGE, locPage * PAGE + PAGE).map((r) => (
                      <tr key={r.key ?? r.label} onClick={() => drill(r)} tabIndex={0} onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); drill(r); } }} className={`border-b border-border/40 cursor-pointer hover:bg-muted/40 ${village === r.label ? 'bg-muted/40' : ''}`}>
                        <td className="py-4">{r.label}{!r.fully_mapped && <span className="ml-2 text-[10px] text-warning">partly unmapped</span>}</td>
                        <td className="py-4 text-right tabular-nums">{r.item_count.toLocaleString()}</td>
                        <td className="py-4 text-right tabular-nums">{formatUGX(r.outstanding)}</td>
                        <td className="py-4 text-right tabular-nums">{formatUGX(r.scheduled_amount)}</td>
                        <td className="py-4 text-right tabular-nums">{locTotal ? ((r.outstanding / locTotal) * 100).toFixed(1) : '0.0'}%</td>
                        <td className="py-4 text-right tabular-nums">{formatUGX(r.item_count ? r.outstanding / r.item_count : 0)}</td>
                        <td className="py-4 text-right"><ChevronRight className="inline h-4 w-4 text-muted-foreground" /></td>
                      </tr>
                    ))}
                    {!loc.isLoading && !loc.isError && locRows.length === 0 && <tr><td colSpan={7} className="py-6 text-center text-muted-foreground">No receivables at this level.</td></tr>}
                  </tbody>
                </table>
              </div>
              <Pager page={locPage} pages={Math.ceil(locRows.length / PAGE)} set={setLocPage} />
              <p className="mt-2 text-[11px] text-muted-foreground">Country → Region → District → Sub-county → Village → Account</p>
            </>
          )}
        </Section>

        {village && (
          <Section title={`Underlying receivables · ${village}`} right={<Button size="sm" variant="ghost" onClick={() => setVillage(null)}>Close</Button>}>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="text-[11px] uppercase tracking-normal text-muted-foreground">
                  <tr className="border-b border-border/60">
                    <th className="py-4 text-left font-medium">Account</th>
                    <th className="py-4 text-left font-medium">Products</th>
                    <th className="py-4 text-right font-medium">Outstanding</th>
                    <th className="py-4 text-right font-medium">Overdue</th>
                    <th className="py-4 text-right font-medium">Next due</th>
                    <th className="py-4 text-right font-medium">Days outstanding</th>
                    <th className="py-4 text-left font-medium pl-4">District</th>
                    <th className="py-4 text-left font-medium">Sub-county</th>
                    <th className="py-4 text-left font-medium">Village</th>
                  </tr>
                </thead>
                <tbody>
                  {records.isLoading && <tr><td colSpan={9} className="py-6 text-center text-muted-foreground">Loading…</td></tr>}
                  {accounts.slice(recPage * PAGE, recPage * PAGE + PAGE).map((a) => {
                    const od = a.items.filter((i) => i.due_date && i.due_date < t).reduce((s, i) => s + i.amount, 0);
                    const oldest = a.items.map((i) => i.due_date).filter(Boolean).sort()[0] as string | undefined;
                    return (
                      <tr key={a.tenant_id} className="border-b border-border/40">
                        <td className="py-4">{a.tenant ?? '—'}<div className="text-[11px] text-muted-foreground">{a.phone ?? ''}</div></td>
                        <td className="py-4 text-xs text-muted-foreground">{[...new Set(a.items.map((i) => i.product))].join(', ')}</td>
                        <td className="py-4 text-right tabular-nums">{formatUGX(a.outstanding)}</td>
                        <td className={`py-2 text-right tabular-nums ${od > 0 ? 'text-destructive' : ''}`}>{formatUGX(od)}</td>
                        <td className="py-4 text-right tabular-nums">{a.next_due_date ?? '—'}</td>
                        <td className="py-4 text-right tabular-nums">{oldest && oldest < t ? daysBetween(oldest, t) : '—'}</td>
                        <td className="py-4 pl-4">{a.district ?? '—'}</td>
                        <td className="py-4">{a.subcounty ?? '—'}</td>
                        <td className="py-4">{a.village ?? '—'}</td>
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

        <Section title="Receivables Forecast" right={<div className="flex flex-wrap gap-1" aria-label="Forecast horizon">
          {PERIODS.map(p => <Button key={p.key} size="sm" variant={p.key === period.key ? 'soft' : 'outline'} aria-pressed={p.key === period.key} className="rounded-sm shadow-none text-xs" onClick={() => setParam('p', p.key)}>{p.label}</Button>)}
        </div>}>
          <p className="mb-5 text-xs text-muted-foreground">{scopeLabel} · {proj[0]?.start ?? '—'} to {proj[proj.length - 1]?.end ?? '—'} · Kampala calendar periods</p>
          {locationSelected ? <p className="py-8 text-sm text-muted-foreground">Historical collection behaviour and complete payment schedules are unavailable for this location. Category-wide forecasts are not substituted.</p>
            : forecast.isLoading || ideal.isLoading ? <p className="py-8 text-sm text-muted-foreground">Loading forecast comparison…</p>
            : forecast.isError || ideal.isError ? <p role="status" className="py-8 text-sm text-muted-foreground">Forecast comparison could not be loaded.</p> : <>
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 border-y border-border/60 py-4 mb-8 gap-x-8">
                <Figure label="Behaviour-Based Forecast" value={money(behaviourTotal)} sub="Historical collections · existing receivables" />
                <Figure label="Ideal Forecast" value={money(idealTotal)} sub="Recorded due dates and daily plan schedules" />
                <Figure label="Collection gap · ideal − behaviour" value={money(gapTotal)} sub={gapTotal !== null && gapTotal < 0 ? 'Behaviour exceeds scheduled collection' : 'Expected shortfall against schedule'} />
              </div>
              {missingBehaviour.length > 0 && <p className="mb-5 text-xs text-muted-foreground">Partial behaviour coverage: {missingBehaviour.map(s => s.product_label).join(', ')} lack sufficient collection history. Their scheduled amounts remain in Ideal; they are not presented as behaviour predictions.</p>}
              <div className="h-72 w-full" aria-label="Behaviour-Based and Ideal Forecast chart">
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={proj} margin={{ left: 12, right: 16, top: 8, bottom: 8 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" vertical={false} />
                    <XAxis dataKey="label" tick={{ fontSize: 11 }} stroke="hsl(var(--muted-foreground))" />
                    <YAxis width={68} tick={{ fontSize: 11 }} stroke="hsl(var(--muted-foreground))" tickFormatter={v => `UGX ${(v / 1e6).toFixed(0)}M`} />
                    <Tooltip formatter={(v: number) => formatUGX(v)} />
                    <Legend />
                    <Line type="linear" dataKey="ideal" name="Ideal Forecast" stroke="hsl(var(--muted-foreground))" strokeWidth={2} dot={false} connectNulls={false} />
                    <Line type="linear" dataKey="behaviour" name="Behaviour-Based Forecast" stroke="hsl(var(--primary))" strokeWidth={2} strokeDasharray="5 4" dot={false} connectNulls={false} />
                  </LineChart>
                </ResponsiveContainer>
              </div>
              <div className="mt-8 overflow-x-auto">
                <table className="w-full text-sm"><thead className="text-xs text-muted-foreground"><tr className="border-b border-border/60">
                  <th className="py-3 text-left font-medium">Period</th><th className="py-3 text-right font-medium">Behaviour-Based</th><th className="py-3 text-right font-medium">Ideal</th><th className="py-3 text-right font-medium">Collection gap</th><th className="py-3 text-right font-medium">Model confidence</th>
                </tr></thead><tbody>{proj.map(p => <tr key={p.start} className="border-b border-border/40"><td className="py-4">{p.label}<div className="text-xs text-muted-foreground">{p.start} – {p.end}</div></td><td className="py-4 text-right tabular-nums whitespace-nowrap">{money(p.behaviour)}</td><td className="py-4 text-right tabular-nums whitespace-nowrap">{money(p.ideal)}</td><td className="py-4 text-right tabular-nums whitespace-nowrap">{money(p.gap)}</td><td className="py-4 text-right capitalize text-muted-foreground">{hasBehaviour ? p.quality : 'Unavailable'}</td></tr>)}</tbody></table>
              </div>
              <p className="mt-4 text-xs text-muted-foreground">Existing receivables only; anticipated new business is excluded. Undated obligations are not assigned invented due dates. A partial current calendar period is included; the dates above define the forecast window.</p>
            </>}
        </Section>
      </div>
    </main>
  );
}
