import { useMemo } from 'react';
import { formatDynamicCompact } from '@/lib/currencyFormat';
import { cn } from '@/lib/utils';
import {
  Globe2, TrendingUp, Users, Wallet, Activity, ShieldCheck,
  Building2, Banknote, Gauge, Server, AlertTriangle, ArrowUpRight,
} from 'lucide-react';

/**
 * COO "At Scale" vision view.
 *
 * A purely illustrative, read-only projection of how this same COO dashboard
 * would look once the platform reaches 40M+ users. All figures are modelled
 * projections (not live data) so executives can pressure-test the operating
 * model and command-centre layout at hyperscale.
 */

const SCALE_USERS = 40_200_000;

interface Kpi {
  label: string;
  value: string;
  delta: string;
  icon: typeof Users;
  tone: string;
}

function StatTile({ kpi }: { kpi: Kpi }) {
  const Icon = kpi.icon;
  return (
    <div className="rounded-2xl border border-border bg-card p-4 flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <div className={cn('h-9 w-9 rounded-xl flex items-center justify-center', kpi.tone)}>
          <Icon className="h-4.5 w-4.5" />
        </div>
        <span className="inline-flex items-center gap-0.5 text-[11px] font-semibold text-emerald-600">
          <ArrowUpRight className="h-3 w-3" /> {kpi.delta}
        </span>
      </div>
      <div>
        <p className="text-xl font-bold tracking-tight leading-none">{kpi.value}</p>
        <p className="text-[11px] text-muted-foreground mt-1">{kpi.label}</p>
      </div>
    </div>
  );
}

export function COOScaleVisionView() {
  const kpis = useMemo<Kpi[]>(() => [
    { label: 'Active users', value: '40.2M', delta: '+3.1% MoM', icon: Users, tone: 'bg-blue-500/10 text-blue-600' },
    { label: 'Daily rent collected', value: formatDynamicCompact(28_500_000_000), delta: '+4.6%', icon: Banknote, tone: 'bg-emerald-500/10 text-emerald-600' },
    { label: 'Assets under management', value: formatDynamicCompact(6_400_000_000_000), delta: '+2.2%', icon: Wallet, tone: 'bg-primary/10 text-primary' },
    { label: 'Field agents online', value: '184,300', delta: '+1.4%', icon: Activity, tone: 'bg-purple-500/10 text-purple-600' },
    { label: 'Tenants placed today', value: '52,910', delta: '+6.8%', icon: Building2, tone: 'bg-cyan-500/10 text-cyan-600' },
    { label: 'Collection rate', value: '97.3%', delta: '+0.4pp', icon: Gauge, tone: 'bg-amber-500/10 text-amber-600' },
    { label: 'Trust score (avg)', value: '742', delta: '+11 pts', icon: ShieldCheck, tone: 'bg-teal-500/10 text-teal-600' },
    { label: 'Capital deployed', value: formatDynamicCompact(1_120_000_000_000), delta: '+3.0%', icon: TrendingUp, tone: 'bg-indigo-500/10 text-indigo-600' },
  ], []);

  const regions = useMemo(() => [
    { name: 'Central (Kampala)', users: 11_800_000, collection: 98.1, agents: 52_400 },
    { name: 'Eastern', users: 8_300_000, collection: 96.4, agents: 38_900 },
    { name: 'Western', users: 9_100_000, collection: 97.0, agents: 41_200 },
    { name: 'Northern', users: 6_500_000, collection: 95.2, agents: 28_700 },
    { name: 'Diaspora & Cross-border', users: 4_500_000, collection: 99.0, agents: 23_100 },
  ], []);

  const ops = useMemo(() => [
    { label: 'Rent approvals in queue', value: '12,480', sub: 'SLA: 4h • on track', tone: 'text-emerald-600' },
    { label: 'Withdrawals awaiting sign-off', value: formatDynamicCompact(940_000_000), sub: '3,210 requests', tone: 'text-amber-600' },
    { label: 'Flagged risk events (24h)', value: '218', sub: 'Auto-held • 0.0005%', tone: 'text-red-600' },
    { label: 'Partner capital pending', value: formatDynamicCompact(310_000_000_000), sub: '1,140 top-ups', tone: 'text-indigo-600' },
  ], []);

  return (
    <div className="space-y-5">
      {/* Hero banner */}
      <div className="rounded-2xl border border-primary/20 bg-gradient-to-br from-primary/10 via-primary/5 to-transparent p-5">
        <div className="flex items-start gap-3">
          <div className="h-11 w-11 rounded-xl bg-primary/15 flex items-center justify-center shrink-0">
            <Globe2 className="h-5 w-5 text-primary" />
          </div>
          <div className="min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <h1 className="text-lg font-bold">COO Command Centre — At Scale</h1>
              <span className="text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-full bg-primary/15 text-primary">
                Vision
              </span>
            </div>
            <p className="text-sm text-muted-foreground mt-1">
              How this dashboard operates at <strong className="text-foreground">{SCALE_USERS.toLocaleString()}+</strong> users.
              Figures below are modelled projections, not live data — a planning lens for operating Welile at hyperscale.
            </p>
          </div>
        </div>
      </div>

      {/* KPI grid */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-2.5">
        {kpis.map((k) => <StatTile key={k.label} kpi={k} />)}
      </div>

      {/* Operations command row */}
      <div>
        <p className="text-xs font-bold uppercase tracking-widest text-muted-foreground mb-3 px-0.5">
          Live Operations (projected)
        </p>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-2.5">
          {ops.map((o) => (
            <div key={o.label} className="rounded-2xl border border-border bg-card p-4">
              <p className="text-[11px] text-muted-foreground">{o.label}</p>
              <p className={cn('text-lg font-bold mt-1', o.tone)}>{o.value}</p>
              <p className="text-[11px] text-muted-foreground mt-0.5">{o.sub}</p>
            </div>
          ))}
        </div>
      </div>

      {/* Regional breakdown */}
      <div>
        <p className="text-xs font-bold uppercase tracking-widest text-muted-foreground mb-3 px-0.5">
          Regional Performance (projected)
        </p>
        <div className="rounded-2xl border border-border bg-card overflow-hidden">
          <div className="grid grid-cols-12 gap-2 px-4 py-2.5 border-b border-border bg-muted/40 text-[10px] font-bold uppercase tracking-wider text-muted-foreground">
            <span className="col-span-5">Region</span>
            <span className="col-span-3 text-right">Users</span>
            <span className="col-span-2 text-right">Agents</span>
            <span className="col-span-2 text-right">Collection</span>
          </div>
          {regions.map((r) => (
            <div key={r.name} className="grid grid-cols-12 gap-2 px-4 py-3 border-b border-border last:border-0 items-center text-sm">
              <span className="col-span-5 font-medium truncate">{r.name}</span>
              <span className="col-span-3 text-right tabular-nums">{(r.users / 1_000_000).toFixed(1)}M</span>
              <span className="col-span-2 text-right tabular-nums text-muted-foreground">{(r.agents / 1000).toFixed(1)}k</span>
              <span className={cn('col-span-2 text-right tabular-nums font-semibold', r.collection >= 97 ? 'text-emerald-600' : 'text-amber-600')}>
                {r.collection}%
              </span>
            </div>
          ))}
        </div>
      </div>

      {/* Infrastructure / resilience */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
        <div className="rounded-2xl border border-border bg-card p-4 space-y-3">
          <div className="flex items-center gap-2">
            <Server className="h-4 w-4 text-primary" />
            <p className="text-sm font-bold">Platform resilience</p>
          </div>
          {[
            { label: 'Uptime (90d)', value: '99.98%' },
            { label: 'Peak concurrent users', value: '2.1M' },
            { label: 'Ledger writes / sec', value: '48,000' },
            { label: 'p95 API latency', value: '210ms' },
          ].map((m) => (
            <div key={m.label} className="flex items-center justify-between text-sm">
              <span className="text-muted-foreground">{m.label}</span>
              <span className="font-semibold tabular-nums">{m.value}</span>
            </div>
          ))}
        </div>
        <div className="rounded-2xl border border-amber-500/30 bg-amber-500/5 p-4 space-y-2">
          <div className="flex items-center gap-2">
            <AlertTriangle className="h-4 w-4 text-amber-600" />
            <p className="text-sm font-bold">Why this matters at 40M+</p>
          </div>
          <ul className="text-[13px] text-muted-foreground space-y-1.5 list-disc pl-4">
            <li>Approvals shift from manual review to <strong className="text-foreground">policy + exception</strong> queues.</li>
            <li>Solvency and float coverage become <strong className="text-foreground">real-time, regional</strong> not daily.</li>
            <li>Field operations are steered by <strong className="text-foreground">trust-score automation</strong>, not headcount.</li>
            <li>The COO manages <strong className="text-foreground">SLAs and risk thresholds</strong>, not individual transactions.</li>
          </ul>
        </div>
      </div>

      <p className="text-[11px] text-muted-foreground text-center pt-1">
        Projection model · not connected to live ledger · for strategic planning only.
      </p>
    </div>
  );
}

export default COOScaleVisionView;