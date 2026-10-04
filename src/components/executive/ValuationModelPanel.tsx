import { useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Slider } from '@/components/ui/slider';
import { Button } from '@/components/ui/button';
import { Files, Loader2, RefreshCw, Share2 } from 'lucide-react';
import { shareValuationComparisonPdf as rawCmp, shareValuationPdf as rawOne } from '@/lib/valuationPdf';
import { toast } from 'sonner';
import { useIsMobile } from '@/hooks/use-mobile';

async function notify(fn: () => Promise<'shared' | 'downloaded'>) {
  try {
    const r = await fn();
    if (r === 'downloaded') toast.success('PDF ready — save or share it from your phone or downloads.');
  } catch {
    toast.error('Could not create the PDF. Please try again.');
  }
}
const shareValuationPdf = (d: Parameters<typeof rawOne>[0]) => notify(() => rawOne(d));
const shareValuationComparisonPdf = (d: Parameters<typeof rawCmp>[0]) => notify(() => rawCmp(d));
import { CartesianGrid, Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { formatUGX } from '@/lib/businessAdvanceCalculations';
import { runScenario, SCENARIO_PRESETS, type ScenarioInputs } from '@/lib/valuationModel';

const RATE_PROVIDER = 'exchangerate-api.com';

type Key = keyof typeof SCENARIO_PRESETS;
const LABELS: Record<Key, string> = { conservative: 'Conservative', base: 'Base', high: 'High growth' };
const FALLBACK_UGX_PER_USD = 3700;
let UGX_PER_USD = FALLBACK_UGX_PER_USD;
const COLORS: Record<Key, string> = { conservative: 'hsl(var(--muted-foreground))', base: 'hsl(var(--primary))', high: 'hsl(var(--accent-foreground))' };
type Metric = 'valuation' | 'stake' | 'stakeValue';
const METRICS: { id: Metric; label: string }[] = [
  { id: 'valuation', label: 'Company value' },
  { id: 'stake', label: 'Ownership %' },
  { id: 'stakeValue', label: 'Stake value' },
];

interface Baseline {
  fees_30d: number; fees_prev_30d: number; fees_all_time: number; rent_30d: number;
  users: number; users_30d: number; plans_funded: number;
}

const usd = (ugx: number) => {
  const v = ugx / UGX_PER_USD;
  return v >= 1e6 ? `US$${(v / 1e6).toFixed(2)}M` : `US$${Math.round(v / 1000)}K`;
};
const compact = (n: number) =>
  n >= 1e9 ? `UGX ${(n / 1e9).toFixed(2)}B` : n >= 1e6 ? `UGX ${(n / 1e6).toFixed(1)}M` : formatUGX(n);

export function ValuationModelPanel() {
  const base = useQuery({
    queryKey: ['ceo-valuation-baseline'],
    queryFn: async () => {
      const { data, error } = await supabase.rpc('ceo_valuation_baseline');
      if (error) throw error;
      return data as unknown as Baseline;
    },
  });
  const fx = useQuery({
    queryKey: ['ugx-usd-live-rate'],
    staleTime: 30 * 60 * 1000,
    queryFn: async () => {
      const res = await fetch('https://api.exchangerate-api.com/v4/latest/USD');
      if (!res.ok) throw new Error('rate');
      const j = await res.json();
      const rate = Number(j?.rates?.UGX);
      if (!rate) throw new Error('rate');
      const at = j.time_last_updated ? new Date(j.time_last_updated * 1000) : new Date();
      return { rate, at: at.toISOString() };
    },
  });
  UGX_PER_USD = fx.data?.rate ?? FALLBACK_UGX_PER_USD;
  const hist = useQuery({
    queryKey: ['ugx-usd-rate-history'],
    staleTime: 6 * 60 * 60 * 1000,
    queryFn: async () => {
      const days = Array.from({ length: 13 }, (_, i) => 90 - i * 7.5).map((d) => Math.round(d)).filter((d) => d > 0);
      const out = await Promise.all(days.map(async (d) => {
        const dt = new Date(Date.now() - d * 86400000).toISOString().slice(0, 10);
        try {
          const r = await fetch(`https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@${dt}/v1/currencies/usd.json`);
          if (!r.ok) return null;
          const j = await r.json();
          const rate = Number(j?.usd?.ugx);
          return rate ? { date: dt, rate } : null;
        } catch { return null; }
      }));
      return out.filter(Boolean) as { date: string; rate: number }[];
    },
  });
  const histData = useMemo(() => {
    const pts = (hist.data ?? []).map((p) => ({ label: new Date(p.date).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }), rate: p.rate }));
    if (pts.length && fx.data) pts.push({ label: 'Today', rate: fx.data.rate });
    return pts;
  }, [hist.data, fx.data]);
  const queryClient = useQueryClient();
  const refreshRate = () => queryClient.invalidateQueries({ queryKey: ['ugx-usd-live-rate'] });
  const [inputs, setInputs] = useState<Record<Key, ScenarioInputs>>({ ...SCENARIO_PRESETS });
  const [metric, setMetric] = useState<Metric>('valuation');
  const isMobile = useIsMobile();
  const [currency, setCurrency] = useState<'UGX' | 'USD'>('UGX');
  const [hidden, setHidden] = useState<Key[]>([]);
  const [monthly, setMonthly] = useState<number | null>(null);
  const monthlyRev = monthly ?? Number(base.data?.fees_30d ?? 0);

  const results = useMemo(
    () => (Object.keys(inputs) as Key[]).map((k) => ({ k, r: runScenario(monthlyRev, inputs[k]) })),
    [inputs, monthlyRev],
  );

  const chartData = useMemo(() => {
    const pts = [0, 1, 2, 3].map((year) => ({ year: year === 0 ? 'Today' : `Year ${year}` } as Record<string, number | string>));
    results.forEach(({ k, r }) => {
      const d = Math.min(Math.max(inputs[k].dilutionPct, 0), 90) / 100;
      const todayStake = 92 * (1 - d);
      const todayValue = r.todayPreMoney + r.todayRaise;
      const val = (m: Metric, i: number) => {
        if (i === 0) return m === 'valuation' ? todayValue : m === 'stake' ? todayStake : (todayValue * todayStake) / 100;
        const y = r.rows[i - 1];
        return m === 'valuation' ? y.valuation : m === 'stake' ? y.founderStakePct : y.stakeValue;
      };
      pts.forEach((p, i) => { p[k] = val(metric, i); });
    });
    return pts;
  }, [results, inputs, metric]);
  const fmt = (v: number) => (currency === 'USD' ? usd(v) : compact(v));
  const fmtOther = (v: number) => (currency === 'USD' ? compact(v) : usd(v));
  const fmtAxis = (v: number) => (metric === 'stake' ? `${v.toFixed(0)}%` : isMobile ? fmt(v).replace(/^UGX /, '').replace(/^US\$/, '$').replace(/\.\d+/, '') : fmt(v));

  if (base.isLoading) return <div className="flex justify-center p-10"><Loader2 className="h-6 w-6 animate-spin" /></div>;
  if (base.error) return <p className="p-6 text-destructive">Could not load the latest figures.</p>;
  const b = base.data!;

  const set = (k: Key, f: keyof ScenarioInputs, v: number) =>
    setInputs((s) => ({ ...s, [k]: { ...s[k], [f]: v } }));

  const rateNote = fx.data
    ? `Rate US$1 = UGX ${Math.round(UGX_PER_USD).toLocaleString()} (source: ${RATE_PROVIDER}).`
    : `Fixed rate US$1 = UGX ${FALLBACK_UGX_PER_USD.toLocaleString()}.`;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-xl font-bold">Valuation Model</h2>
          <p className="text-sm text-muted-foreground max-w-2xl">
            Starts from live fee income (access + registration fees on funded Rent Plans). Adjust each scenario; nothing is saved.
            Before any new rounds, existing holders own 92% (8% is the Angel Pool). {fx.data
              ? <>Live rate: US$1 = UGX {Math.round(UGX_PER_USD).toLocaleString()} (source: {RATE_PROVIDER}), last updated {new Date(fx.data.at).toLocaleString('en-GB', { timeZone: 'Africa/Kampala', dateStyle: 'medium', timeStyle: 'short' })} (Kampala).</>
              : fx.isLoading ? 'Loading live exchange rate…'
              : <>Live rate unavailable from {RATE_PROVIDER}; using a fixed US$1 = UGX {FALLBACK_UGX_PER_USD.toLocaleString()}.</>}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Button size="sm" variant="outline" className="gap-2" onClick={refreshRate} disabled={fx.isFetching} title={`Refresh the rate from ${RATE_PROVIDER}`}>
            <RefreshCw className={`h-4 w-4${fx.isFetching ? ' animate-spin' : ''}`} />
            {fx.isFetching ? 'Refreshing…' : 'Refresh rate'}
          </Button>
          <div className="flex rounded-lg border border-border p-1">
            {(['UGX', 'USD'] as const).map((c) => (
              <Button key={c} size="sm" variant={currency === c ? 'default' : 'ghost'} className="px-3" onClick={() => setCurrency(c)}>{c}</Button>
            ))}
          </div>
        </div>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        {[
          ['Fees, last 30 days', fmt(Number(b.fees_30d))],
          ['Fees, prior 30 days', fmt(Number(b.fees_prev_30d))],
          ['Yearly pace', fmt(Number(b.fees_30d) * 12)],
          ['Users / Rent Plans', `${Number(b.users).toLocaleString()} / ${Number(b.plans_funded).toLocaleString()}`],
        ].map(([l, v]) => (
          <Card key={l}><CardContent className="p-4"><p className="text-xs text-muted-foreground">{l}</p><p className="text-lg font-bold">{v}</p></CardContent></Card>
        ))}
      </div>

      <Card>
        <CardContent className="p-4 space-y-2">
          <div className="flex justify-between text-sm">
            <span>Starting monthly revenue</span>
            <span className="font-semibold">{currency === 'USD' ? usd(monthlyRev) : formatUGX(monthlyRev)}</span>
          </div>
          <Slider value={[monthlyRev]} min={0} max={Math.max(Number(b.fees_30d) * 3, 1_000_000)} step={500_000} onValueChange={([v]) => setMonthly(v)} />
          {monthly !== null && <Button variant="ghost" size="sm" onClick={() => setMonthly(null)}>Reset to live figure</Button>}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">UGX per US$1 — last 90 days</CardTitle>
          <p className="text-xs text-muted-foreground">Daily closing rates sampled weekly (source: currency-api via jsDelivr), plus today's live rate from {RATE_PROVIDER}.</p>
        </CardHeader>
        <CardContent className="h-56">
          {hist.isLoading ? (
            <div className="flex h-full items-center justify-center"><Loader2 className="h-5 w-5 animate-spin" /></div>
          ) : !histData.length ? (
            <p className="text-sm text-muted-foreground">Rate history is unavailable right now.</p>
          ) : (
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={histData}>
                <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                <XAxis dataKey="label" tick={{ fontSize: 11 }} />
                <YAxis domain={['auto', 'auto']} tick={{ fontSize: 11 }} width={50} />
                <Tooltip formatter={(v: number) => [`UGX ${Math.round(v).toLocaleString()}`, 'US$1']} />
                <Line type="monotone" dataKey="rate" stroke="hsl(var(--primary))" strokeWidth={2} dot={{ r: 2 }} />
              </LineChart>
            </ResponsiveContainer>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">How the scenarios play out over time</CardTitle>
          <div className="grid grid-cols-3 sm:flex sm:flex-wrap gap-2 pt-2">
            {METRICS.map((m) => (
              <Button key={m.id} size="sm" className="h-10 sm:h-9 px-1 text-xs sm:text-sm whitespace-normal leading-tight" variant={metric === m.id ? 'default' : 'outline'} onClick={() => setMetric(m.id)}>{m.label}</Button>
            ))}
            </div>
          <div className="grid grid-cols-3 sm:flex sm:flex-wrap gap-2">
            {(Object.keys(LABELS) as Key[]).map((k) => (
              <Button key={k} size="sm" className="h-10 sm:h-9 px-1 text-xs sm:text-sm" variant={hidden.includes(k) ? 'ghost' : 'secondary'}
                onClick={() => setHidden((h) => (h.includes(k) ? h.filter((x) => x !== k) : [...h, k]))}>
                <span className="mr-1 sm:mr-2 inline-block h-2 w-2 shrink-0 rounded-full" style={{ background: COLORS[k] }} />{LABELS[k]}
              </Button>
            ))}
          </div>
          </CardHeader>
        <CardContent>
          <div className="h-64 sm:h-72 w-full">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={chartData} margin={{ top: 8, right: isMobile ? 8 : 16, left: 0, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                <XAxis dataKey="year" tick={{ fontSize: 12 }} />
                <YAxis tick={{ fontSize: 12 }} tickFormatter={fmtAxis} width={isMobile ? 44 : 70} domain={metric === 'stake' ? [0, 100] : [0, 'auto']} />
                <Tooltip
                  formatter={(v: number, n: string) => [metric === 'stake' ? `${v.toFixed(1)}%` : `${fmt(v)} (${fmtOther(v)})`, LABELS[n as Key] ?? n]}
                  contentStyle={{ background: 'hsl(var(--popover))', border: '1px solid hsl(var(--border))', borderRadius: 8, fontSize: 12 }}
                />
                {!isMobile && <Legend formatter={(n: string) => LABELS[n as Key] ?? n} />}
                {(Object.keys(LABELS) as Key[]).filter((k) => !hidden.includes(k)).map((k) => (
                  <Line key={k} type="monotone" dataKey={k} stroke={COLORS[k]} strokeWidth={2.5} dot={{ r: 3 }} activeDot={{ r: 6 }} />
                ))}
              </LineChart>
            </ResponsiveContainer>
          </div>
          <p className="text-xs text-muted-foreground mt-2">Move any slider below and the lines redraw instantly. Hover a point for exact figures.</p>
        </CardContent>
      </Card>

      <Card className="md:hidden">
        <CardHeader className="pb-2"><CardTitle className="text-base">Scenarios at a glance</CardTitle></CardHeader>
        <CardContent className="px-3 pb-3">
          <table className="w-full text-xs">
            <thead><tr className="text-muted-foreground text-right"><th className="text-left font-medium"> </th>{results.map(({ k }) => <th key={k} className="font-medium pb-1" style={{ color: COLORS[k] }}>{LABELS[k].replace(' growth', '')}</th>)}</tr></thead>
            <tbody className="[&_td]:py-1.5 [&_td]:text-right [&_tr]:border-t [&_tr]:border-border">
              <tr><td className="text-left text-muted-foreground">Value today</td>{results.map(({ k, r }) => <td key={k} className="font-semibold">{fmt(r.todayPreMoney)}</td>)}</tr>
              <tr><td className="text-left text-muted-foreground">Raise</td>{results.map(({ k, r }) => <td key={k}>{fmt(r.todayRaise)}</td>)}</tr>
              <tr><td className="text-left text-muted-foreground">Year 3 value</td>{results.map(({ k, r }) => <td key={k}>{fmt(r.rows[r.rows.length - 1].valuation)}</td>)}</tr>
              <tr><td className="text-left text-muted-foreground">Year 3 stake</td>{results.map(({ k, r }) => <td key={k}>{r.rows[r.rows.length - 1].founderStakePct.toFixed(1)}%</td>)}</tr>
            </tbody>
          </table>
        </CardContent>
      </Card>

      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-semibold text-muted-foreground">Scenario comparison</h3>
        <Button size="sm" variant="outline" className="gap-2" onClick={() => shareValuationComparisonPdf({
          scenarios: results.map(({ k, r }) => ({ label: LABELS[k], inputs: inputs[k], result: r })),
          monthlyRevenue: monthlyRev, ugxPerUsd: UGX_PER_USD, rateNote,
        })}>
          <Files className="h-4 w-4" /> All three scenarios as one PDF
        </Button>
      </div>
      <div className="grid md:grid-cols-3 gap-4">
        {results.map(({ k, r }) => (
          <Card key={k}>
            <CardHeader className="pb-2"><CardTitle className="text-base">{LABELS[k]}</CardTitle></CardHeader>
            <CardContent className="space-y-4">
              {([
                ['monthlyGrowthPct', 'Monthly revenue growth', 0, 30, 0.5, '%'],
                ['multiple', 'Revenue multiple', 2, 40, 1, '×'],
                ['dilutionPct', 'Equity sold per round', 5, 40, 1, '%'],
              ] as const).map(([f, l, min, max, step, u]) => (
                <div key={f} className="space-y-1">
                  <div className="flex justify-between text-xs"><span>{l}</span><span className="font-semibold">{inputs[k][f]}{u}</span></div>
                  <Slider value={[inputs[k][f]]} min={min} max={max} step={step} onValueChange={([v]) => set(k, f, v)} />
                </div>
              ))}
              <div className="rounded-lg bg-primary/5 p-3">
                <p className="text-xs text-muted-foreground">Value today (before new money)</p>
                <p className="text-xl font-bold text-primary">{fmt(r.todayPreMoney)}</p>
                <p className="text-xs text-muted-foreground">{fmtOther(r.todayPreMoney)} · raise {fmt(r.todayRaise)} for {inputs[k].dilutionPct}%</p>
              </div>
              <Button size="sm" variant="outline" className="w-full gap-2 h-10 sm:h-9" onClick={() => shareValuationPdf({
                scenarioLabel: LABELS[k], inputs: inputs[k], result: r, monthlyRevenue: monthlyRev, ugxPerUsd: UGX_PER_USD, rateNote,
              })}>
                <Share2 className="h-4 w-4" /> Share as PDF
              </Button>
              <div className="space-y-2">
                {r.rows.map((y) => (
                  <div key={y.year} className="rounded-lg border border-border p-2 text-xs">
                    <div className="flex justify-between font-semibold"><span>Year {y.year}</span><span>{fmt(y.valuation)}</span></div>
                    <div className="flex justify-between text-muted-foreground"><span>Revenue</span><span>{fmt(y.revenue)}</span></div>
                    <div className="flex justify-between text-muted-foreground"><span>Your stake</span><span>{y.founderStakePct.toFixed(1)}% · {fmt(y.stakeValue)}</span></div>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>
        ))}
      </div>
      <p className="text-xs text-muted-foreground">
        One round a year: the first today, the next in years 1 and 2. "Your stake" is the combined stake of existing holders after those rounds.
        These are estimates from the sliders, not a forecast or advice.
      </p>
    </div>
  );
}
