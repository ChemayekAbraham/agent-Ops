import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Slider } from '@/components/ui/slider';
import { Button } from '@/components/ui/button';
import { Loader2 } from 'lucide-react';
import { CartesianGrid, Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { formatUGX } from '@/lib/businessAdvanceCalculations';
import { runScenario, SCENARIO_PRESETS, type ScenarioInputs } from '@/lib/valuationModel';

type Key = keyof typeof SCENARIO_PRESETS;
const LABELS: Record<Key, string> = { conservative: 'Conservative', base: 'Base', high: 'High growth' };
const FALLBACK_UGX_PER_USD = 3700;
let UGX_PER_USD = FALLBACK_UGX_PER_USD;
const COLORS: Record<Key, string> = { conservative: 'hsl(var(--muted-foreground))', base: 'hsl(var(--primary))', high: 'hsl(var(--accent-foreground))' };
type Metric = 'valuation' | 'stake' | 'stakeValue';
const METRICS: { id: Metric; label: string }[] = [
  { id: 'valuation', label: 'Company value' },
  { id: 'stake', label: 'Ownership %' },
  { id: 'stakeValue', label: 'Value of your stake' },
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
  const [inputs, setInputs] = useState<Record<Key, ScenarioInputs>>({ ...SCENARIO_PRESETS });
  const [metric, setMetric] = useState<Metric>('valuation');
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
  const fmtAxis = (v: number) => (metric === 'stake' ? `${v.toFixed(0)}%` : fmt(v));

  if (base.isLoading) return <div className="flex justify-center p-10"><Loader2 className="h-6 w-6 animate-spin" /></div>;
  if (base.error) return <p className="p-6 text-destructive">Could not load the latest figures.</p>;
  const b = base.data!;

  const set = (k: Key, f: keyof ScenarioInputs, v: number) =>
    setInputs((s) => ({ ...s, [k]: { ...s[k], [f]: v } }));

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-xl font-bold">Valuation Model</h2>
          <p className="text-sm text-muted-foreground max-w-2xl">
            Starts from live fee income (access + registration fees on funded Rent Plans). Adjust each scenario; nothing is saved.
            Before any new rounds, existing holders own 92% (8% is the Angel Pool). {fx.data
              ? <>Live rate: US$1 = UGX {Math.round(UGX_PER_USD).toLocaleString()}, last updated {new Date(fx.data.at).toLocaleString('en-GB', { timeZone: 'Africa/Kampala', dateStyle: 'medium', timeStyle: 'short' })} (Kampala).</>
              : fx.isLoading ? 'Loading live exchange rate…'
              : <>Live rate unavailable; using a fixed US$1 = UGX {FALLBACK_UGX_PER_USD.toLocaleString()}.</>}
          </p>
        </div>
        <div className="flex shrink-0 rounded-lg border border-border p-1">
          {(['UGX', 'USD'] as const).map((c) => (
            <Button key={c} size="sm" variant={currency === c ? 'default' : 'ghost'} className="px-3" onClick={() => setCurrency(c)}>{c}</Button>
          ))}
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
          <CardTitle className="text-base">How the scenarios play out over time</CardTitle>
          <div className="flex flex-wrap gap-2 pt-2">
            {METRICS.map((m) => (
              <Button key={m.id} size="sm" variant={metric === m.id ? 'default' : 'outline'} onClick={() => setMetric(m.id)}>{m.label}</Button>
            ))}
            <span className="mx-1 w-px bg-border" />
            {(Object.keys(LABELS) as Key[]).map((k) => (
              <Button key={k} size="sm" variant={hidden.includes(k) ? 'ghost' : 'secondary'}
                onClick={() => setHidden((h) => (h.includes(k) ? h.filter((x) => x !== k) : [...h, k]))}>
                <span className="mr-2 inline-block h-2 w-2 rounded-full" style={{ background: COLORS[k] }} />{LABELS[k]}
              </Button>
            ))}
          </div>
        </CardHeader>
        <CardContent>
          <div className="h-72 w-full">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={chartData} margin={{ top: 8, right: 16, left: 0, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                <XAxis dataKey="year" tick={{ fontSize: 12 }} />
                <YAxis tick={{ fontSize: 12 }} tickFormatter={fmtAxis} width={70} domain={metric === 'stake' ? [0, 100] : [0, 'auto']} />
                <Tooltip
                  formatter={(v: number, n: string) => [metric === 'stake' ? `${v.toFixed(1)}%` : `${fmt(v)} (${fmtOther(v)})`, LABELS[n as Key] ?? n]}
                  contentStyle={{ background: 'hsl(var(--popover))', border: '1px solid hsl(var(--border))', borderRadius: 8, fontSize: 12 }}
                />
                <Legend formatter={(n: string) => LABELS[n as Key] ?? n} />
                {(Object.keys(LABELS) as Key[]).filter((k) => !hidden.includes(k)).map((k) => (
                  <Line key={k} type="monotone" dataKey={k} stroke={COLORS[k]} strokeWidth={2.5} dot={{ r: 3 }} activeDot={{ r: 6 }} />
                ))}
              </LineChart>
            </ResponsiveContainer>
          </div>
          <p className="text-xs text-muted-foreground mt-2">Move any slider below and the lines redraw instantly. Hover a point for exact figures.</p>
        </CardContent>
      </Card>

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
              <table className="w-full text-xs">
                <thead><tr className="text-muted-foreground text-left"><th>Year</th><th>Revenue</th><th>Value</th><th>Your stake</th></tr></thead>
                <tbody>
                  {r.rows.map((y) => (
                    <tr key={y.year} className="border-t border-border">
                      <td className="py-1">{y.year}</td>
                      <td>{fmt(y.revenue)}</td>
                      <td>{fmt(y.valuation)}</td>
                      <td>{y.founderStakePct.toFixed(1)}% · {fmt(y.stakeValue)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
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
