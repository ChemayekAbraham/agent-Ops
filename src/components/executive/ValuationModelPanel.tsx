import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Slider } from '@/components/ui/slider';
import { Button } from '@/components/ui/button';
import { Loader2 } from 'lucide-react';
import { formatUGX } from '@/lib/businessAdvanceCalculations';
import { runScenario, SCENARIO_PRESETS, type ScenarioInputs } from '@/lib/valuationModel';

type Key = keyof typeof SCENARIO_PRESETS;
const LABELS: Record<Key, string> = { conservative: 'Conservative', base: 'Base', high: 'High growth' };
const UGX_PER_USD = 3700;

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
  const [inputs, setInputs] = useState<Record<Key, ScenarioInputs>>({ ...SCENARIO_PRESETS });
  const [monthly, setMonthly] = useState<number | null>(null);
  const monthlyRev = monthly ?? Number(base.data?.fees_30d ?? 0);

  const results = useMemo(
    () => (Object.keys(inputs) as Key[]).map((k) => ({ k, r: runScenario(monthlyRev, inputs[k]) })),
    [inputs, monthlyRev],
  );

  if (base.isLoading) return <div className="flex justify-center p-10"><Loader2 className="h-6 w-6 animate-spin" /></div>;
  if (base.error) return <p className="p-6 text-destructive">Could not load the latest figures.</p>;
  const b = base.data!;

  const set = (k: Key, f: keyof ScenarioInputs, v: number) =>
    setInputs((s) => ({ ...s, [k]: { ...s[k], [f]: v } }));

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-xl font-bold">Valuation Model</h2>
        <p className="text-sm text-muted-foreground">
          Starts from live fee income (access + registration fees on funded Rent Plans). Adjust each scenario; nothing is saved.
          Before any new rounds, existing holders own 92% (8% is the Angel Pool). US$1 = UGX {UGX_PER_USD.toLocaleString()} for display.
        </p>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        {[
          ['Fees, last 30 days', compact(Number(b.fees_30d))],
          ['Fees, prior 30 days', compact(Number(b.fees_prev_30d))],
          ['Yearly pace', compact(Number(b.fees_30d) * 12)],
          ['Users / Rent Plans', `${Number(b.users).toLocaleString()} / ${Number(b.plans_funded).toLocaleString()}`],
        ].map(([l, v]) => (
          <Card key={l}><CardContent className="p-4"><p className="text-xs text-muted-foreground">{l}</p><p className="text-lg font-bold">{v}</p></CardContent></Card>
        ))}
      </div>

      <Card>
        <CardContent className="p-4 space-y-2">
          <div className="flex justify-between text-sm">
            <span>Starting monthly revenue</span>
            <span className="font-semibold">{formatUGX(monthlyRev)}</span>
          </div>
          <Slider value={[monthlyRev]} min={0} max={Math.max(Number(b.fees_30d) * 3, 1_000_000)} step={500_000} onValueChange={([v]) => setMonthly(v)} />
          {monthly !== null && <Button variant="ghost" size="sm" onClick={() => setMonthly(null)}>Reset to live figure</Button>}
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
                <p className="text-xl font-bold text-primary">{usd(r.todayPreMoney)}</p>
                <p className="text-xs text-muted-foreground">{compact(r.todayPreMoney)} · raise {usd(r.todayRaise)} for {inputs[k].dilutionPct}%</p>
              </div>
              <table className="w-full text-xs">
                <thead><tr className="text-muted-foreground text-left"><th>Year</th><th>Revenue</th><th>Value</th><th>Your stake</th></tr></thead>
                <tbody>
                  {r.rows.map((y) => (
                    <tr key={y.year} className="border-t border-border">
                      <td className="py-1">{y.year}</td>
                      <td>{compact(y.revenue)}</td>
                      <td>{usd(y.valuation)}</td>
                      <td>{y.founderStakePct.toFixed(1)}% · {usd(y.stakeValue)}</td>
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
