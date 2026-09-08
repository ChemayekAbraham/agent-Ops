import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import {
  Activity, ShieldCheck, MapPin, Gauge, TrendingUp, Timer,
  Clock, Users, Banknote, AlertTriangle, Radar, Globe,
} from 'lucide-react';

type Health = 'good' | 'watch' | 'risk' | 'neutral';

interface GrowthQuality {
  as_at: string;
  window_days: number;
  behavior: {
    signals_today: number; signals_yesterday: number; signals_window: number;
    signals_per_day: number; distinct_actors: number;
    trust_scored_users: number; total_users: number;
    trust_coverage_pct: number; verified_pct: number;
    gps_signals_today: number; cities_window: number; cities_all_time: number;
  };
  capital: {
    capital_deployed: number; plans_funded: number; plans_active: number;
    collected_window: number; book_outstanding: number; arrears: number;
    arrears_rate: number; fees_window: number; fee_yield_pct: number;
    capital_per_plan: number; avg_trust_score: number;
    bands: { tier: string; plans: number; expected: number; repaid: number; arrears: number; arrears_rate: number }[];
  };
  tempo: {
    median_fund_hours: number; queue_count: number; queue_oldest_hours: number;
    expected_today: number; collected_today: number;
    collection_rate_today: number; collecting_agents_today: number;
  };
}

const healthStyles: Record<Health, string> = {
  good: 'border-emerald-500/40 bg-emerald-500/5',
  watch: 'border-amber-500/40 bg-amber-500/5',
  risk: 'border-destructive/40 bg-destructive/5',
  neutral: 'border-border bg-card',
};

const healthText: Record<Health, string> = {
  good: 'text-emerald-600',
  watch: 'text-amber-600',
  risk: 'text-destructive',
  neutral: 'text-muted-foreground',
};

const ugx = (n: number) => {
  const v = Number(n || 0);
  if (v >= 1e9) return `UGX ${(v / 1e9).toFixed(2)}B`;
  if (v >= 1e6) return `UGX ${(v / 1e6).toFixed(1)}M`;
  if (v >= 1e3) return `UGX ${(v / 1e3).toFixed(0)}K`;
  return `UGX ${v.toLocaleString()}`;
};
const num = (n: number) => Number(n || 0).toLocaleString();

function Metric({
  label, value, note, icon: Icon, health = 'neutral',
}: { label: string; value: string; note?: string; icon: typeof Activity; health?: Health }) {
  return (
    <div className={cn('rounded-2xl border p-3 sm:p-4 min-w-0', healthStyles[health])}>
      <div className="flex items-center gap-2 min-w-0">
        <Icon className={cn('h-4 w-4 shrink-0', healthText[health])} />
        <p className="min-w-0 text-xs font-medium text-muted-foreground leading-tight line-clamp-2">{label}</p>
      </div>
      <p className="mt-2 text-xl sm:text-2xl font-bold tracking-tight tabular-nums break-words">{value}</p>
      {note && <p className="mt-1 text-xs text-muted-foreground leading-snug">{note}</p>}
    </div>
  );
}

function Lens({
  title, subtitle, icon: Icon, verdict, children,
}: { title: string; subtitle: string; icon: typeof Activity; verdict?: { health: Health; text: string }; children: React.ReactNode }) {
  return (
    <section className="rounded-3xl border border-border bg-card/50 p-3 sm:p-4 space-y-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="flex items-start gap-2 min-w-0">
          <div className="p-2 rounded-xl bg-primary/10 text-primary shrink-0">
            <Icon className="h-4 w-4" />
          </div>
          <div className="min-w-0">
            <h3 className="text-sm font-semibold leading-tight">{title}</h3>
            <p className="text-xs text-muted-foreground leading-snug">{subtitle}</p>
          </div>
        </div>
        {verdict && (
          <span className={cn('rounded-full border px-2.5 py-1 text-xs font-medium', healthStyles[verdict.health], healthText[verdict.health])}>
            {verdict.text}
          </span>
        )}
      </div>
      {children}
    </section>
  );
}

export function CEOGrowthQuality() {
  const [days, setDays] = useState(30);

  const { data, isLoading, error } = useQuery<GrowthQuality>({
    queryKey: ['ceo-growth-quality', days],
    queryFn: async () => {
      const { data, error } = await supabase.rpc('get_ceo_growth_quality' as never, { p_days: days } as never);
      if (error) throw error;
      return data as unknown as GrowthQuality;
    },
    staleTime: 300000,
  });

  if (error) return null;

  if (isLoading || !data) {
    return (
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-2 sm:gap-3">
        {Array.from({ length: 8 }).map((_, i) => (
          <div key={i} className="h-24 rounded-2xl border border-border bg-muted/40 animate-pulse" />
        ))}
      </div>
    );
  }

  const b = data.behavior;
  const c = data.capital;
  const t = data.tempo;

  const signalTrend = b.signals_yesterday > 0
    ? Math.round(((b.signals_today - b.signals_yesterday) / b.signals_yesterday) * 100)
    : 0;

  const behaviorHealth: Health = b.trust_coverage_pct >= 60 ? 'good' : b.trust_coverage_pct >= 30 ? 'watch' : 'risk';
  const capitalHealth: Health = c.arrears_rate <= 10 ? 'good' : c.arrears_rate <= 25 ? 'watch' : 'risk';
  const tempoHealth: Health = t.collection_rate_today >= 80 ? 'good' : t.collection_rate_today >= 40 ? 'watch' : 'risk';

  const bandHealth = (rate: number): Health => (rate <= 10 ? 'good' : rate <= 25 ? 'watch' : 'risk');

  return (
    <div className="space-y-4">
      {/* Narrative header */}
      <div className="rounded-3xl border border-border bg-gradient-to-br from-primary/10 via-card to-card p-4 sm:p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="text-xs uppercase tracking-widest text-muted-foreground">Growth quality</p>
            <h2 className="text-lg sm:text-xl font-bold leading-tight mt-0.5">
              Turning Africa's behaviour into data, and data into financial value
            </h2>
            <p className="text-xs text-muted-foreground mt-1">
              Leading indicators first. Last {data.window_days} days · as at{' '}
              {new Date(data.as_at).toLocaleString('en-GB', { timeZone: 'Africa/Kampala', hour12: false })} Kampala
            </p>
          </div>
          <div className="flex gap-1.5">
            {[7, 30, 90].map((d) => (
              <Button
                key={d}
                size="sm"
                variant={days === d ? 'default' : 'outline'}
                onClick={() => setDays(d)}
                className="h-8 px-3 text-xs"
              >
                {d}d
              </Button>
            ))}
          </div>
        </div>
        <div className="mt-4 grid grid-cols-1 sm:grid-cols-3 gap-2 sm:gap-3">
          {[
            { label: 'Behaviour → data velocity', health: behaviorHealth, line: `${num(b.signals_today)} signals today · ${b.trust_coverage_pct}% of users scored` },
            { label: 'Capital efficiency per unit of trust', health: capitalHealth, line: `${c.arrears_rate}% arrears on ${ugx(c.book_outstanding)} book` },
            { label: 'Operational tempo', health: tempoHealth, line: `${t.collection_rate_today}% of today collected · ${t.median_fund_hours}h to fund` },
          ].map((v) => (
            <div key={v.label} className={cn('rounded-2xl border p-3', healthStyles[v.health])}>
              <p className="text-xs font-semibold leading-tight">{v.label}</p>
              <p className={cn('text-xs mt-1 font-medium leading-snug', healthText[v.health])}>{v.line}</p>
            </div>
          ))}
        </div>
      </div>

      {/* Lens 1 */}
      <Lens
        title="1 · Behaviour-to-data velocity"
        subtitle="Is real behaviour being converted into structured data, fast?"
        icon={Radar}
        verdict={{ health: behaviorHealth, text: `${b.trust_coverage_pct}% trust coverage` }}
      >
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-2 sm:gap-3">
          <Metric
            label="Signals captured today" value={num(b.signals_today)} icon={Activity}
            health={signalTrend >= 0 ? 'good' : 'watch'}
            note={`${signalTrend >= 0 ? '↑' : '↓'} ${Math.abs(signalTrend)}% vs yesterday (${num(b.signals_yesterday)})`}
          />
          <Metric
            label="Signal density" value={`${num(b.signals_per_day)}/day`} icon={Gauge}
            note={`${num(b.signals_window)} over ${data.window_days}d · ${num(b.distinct_actors)} distinct people`}
          />
          <Metric
            label="Trust score coverage" value={`${b.trust_coverage_pct}%`} icon={ShieldCheck}
            health={behaviorHealth}
            note={`${num(b.trust_scored_users)} of ${num(b.total_users)} people scored`}
          />
          <Metric
            label="Verified identities" value={`${b.verified_pct}%`} icon={Users}
            health={b.verified_pct >= 50 ? 'good' : b.verified_pct >= 20 ? 'watch' : 'risk'}
            note="Share of people with a verified profile"
          />
          <Metric
            label="Location signals today" value={num(b.gps_signals_today)} icon={MapPin}
            health={b.gps_signals_today > 0 ? 'good' : 'risk'}
            note="Agent visits + venue check-ins with GPS"
          />
          <Metric
            label="Places active" value={num(b.cities_window)} icon={Globe}
            note={`${num(b.cities_all_time)} places all time`}
          />
        </div>
      </Lens>

      {/* Lens 2 */}
      <Lens
        title="2 · Capital efficiency per unit of trust"
        subtitle="Is growth profitable, or just loud?"
        icon={Banknote}
        verdict={{ health: capitalHealth, text: `${c.arrears_rate}% arrears` }}
      >
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-2 sm:gap-3">
          <Metric label="Capital deployed" value={ugx(c.capital_deployed)} icon={Banknote}
            note={`${num(c.plans_funded)} plans funded · ${ugx(c.capital_per_plan)} each`} />
          <Metric label="Collected in window" value={ugx(c.collected_window)} icon={TrendingUp}
            note={`${num(c.plans_active)} plans currently repaying`} />
          <Metric label="Arrears" value={ugx(c.arrears)} icon={AlertTriangle} health={capitalHealth}
            note={`${c.arrears_rate}% of ${ugx(c.book_outstanding)} outstanding`} />
          <Metric label="Fee yield on capital" value={`${c.fee_yield_pct}%`} icon={Gauge}
            health={c.fee_yield_pct >= 20 ? 'good' : c.fee_yield_pct >= 10 ? 'watch' : 'risk'}
            note={`${ugx(c.fees_window)} fees on money deployed`} />
          <Metric label="Average trust of the book" value={num(c.avg_trust_score)} icon={ShieldCheck}
            note="Mean trust score of funded tenants" />
        </div>

        {c.bands.length > 0 && (
          <div className="rounded-2xl border border-border bg-background overflow-hidden">
            <p className="px-3 py-2 text-xs font-semibold border-b border-border">Arrears by trust band</p>
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead className="text-muted-foreground">
                  <tr className="border-b border-border">
                    <th className="text-left font-medium px-3 py-2">Band</th>
                    <th className="text-right font-medium px-3 py-2">Plans</th>
                    <th className="text-right font-medium px-3 py-2">Expected</th>
                    <th className="text-right font-medium px-3 py-2">Repaid</th>
                    <th className="text-right font-medium px-3 py-2">Arrears</th>
                    <th className="text-right font-medium px-3 py-2">Rate</th>
                  </tr>
                </thead>
                <tbody>
                  {c.bands.map((band) => (
                    <tr key={band.tier} className="border-b border-border/50 last:border-0">
                      <td className="px-3 py-2 font-medium">{band.tier}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{num(band.plans)}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{ugx(band.expected)}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{ugx(band.repaid)}</td>
                      <td className="px-3 py-2 text-right tabular-nums">{ugx(band.arrears)}</td>
                      <td className={cn('px-3 py-2 text-right tabular-nums font-semibold', healthText[bandHealth(band.arrears_rate)])}>
                        {band.arrears_rate}%
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </Lens>

      {/* Lens 3 */}
      <Lens
        title="3 · Operational tempo"
        subtitle="Ops break before demand does — watch the clock, not the totals."
        icon={Timer}
        verdict={{ health: tempoHealth, text: `${t.collection_rate_today}% collected today` }}
      >
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-2 sm:gap-3">
          <Metric label="Request to landlord payout" value={`${t.median_fund_hours}h`} icon={Timer}
            health={t.median_fund_hours <= 48 ? 'good' : t.median_fund_hours <= 120 ? 'watch' : 'risk'}
            note="Median time from request to funding" />
          <Metric label="Waiting for a decision" value={num(t.queue_count)} icon={Clock}
            health={t.queue_oldest_hours <= 48 ? 'good' : t.queue_oldest_hours <= 120 ? 'watch' : 'risk'}
            note={`Oldest has waited ${t.queue_oldest_hours}h`} />
          <Metric label="Collected today" value={ugx(t.collected_today)} icon={TrendingUp} health={tempoHealth}
            note={`Against ${ugx(t.expected_today)} expected`} />
          <Metric label="Collectors active today" value={num(t.collecting_agents_today)} icon={Users}
            health={t.collecting_agents_today > 0 ? 'good' : 'risk'}
            note="Agents who banked at least one payment" />
        </div>
      </Lens>
    </div>
  );
}
