import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { ShieldCheck, Users, BarChart3, MapPinned, Banknote, TrendingUp, Trophy } from 'lucide-react';
import { ResponsiveContainer, BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Cell } from 'recharts';

interface CoverageStats {
  total_profiles: number;
  with_score: number;
  coverage_pct: number;
  avg_score: number;
  avg_data_points: number;
  lender_ready: number;
  tier_distribution: Record<string, number>;
  agent_signals_7d: number;
  active_agents_7d: number;
  capture_rate_per_agent_7d: number;
  agent_tenant_health_pct?: number;
  active_agents_with_tenants?: number;
  generated_at: string;
}

const TIER_COLORS: Record<string, string> = {
  excellent: 'hsl(142 76% 36%)',
  good: 'hsl(160 60% 45%)',
  standard: 'hsl(217 91% 60%)',
  caution: 'hsl(38 92% 50%)',
  high_risk: 'hsl(0 84% 60%)',
  new: 'hsl(220 9% 46%)',
};

const TIER_ORDER = ['excellent', 'good', 'standard', 'caution', 'high_risk', 'new'];

function fmt(n: number): string {
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  return n.toLocaleString();
}

export function TrustCoverageSection() {
  const { data, isLoading } = useQuery({
    queryKey: ['trust-coverage-stats'],
    queryFn: async () => {
      const { data, error } = await supabase.rpc('get_trust_coverage_stats');
      if (error) throw error;
      return data as unknown as CoverageStats;
    },
    staleTime: 5 * 60 * 1000,
    refetchOnWindowFocus: false,
  });

  const tierData = TIER_ORDER.map(tier => ({
    tier: tier.replace('_', ' '),
    key: tier,
    count: data?.tier_distribution?.[tier] || 0,
  }));

  const kpis = [
    {
      label: 'Trust Coverage',
      value: data ? `${data.coverage_pct}%` : '—',
      sub: data ? `${fmt(data.with_score)} / ${fmt(data.total_profiles)} users` : '',
      icon: ShieldCheck,
      color: 'bg-emerald-500/10 text-emerald-600',
      target: '100%',
    },
    {
      label: 'Avg Trust Score',
      value: data ? Math.round(data.avg_score).toString() : '—',
      sub: 'platform-wide',
      icon: BarChart3,
      color: 'bg-blue-500/10 text-blue-600',
      target: 'climb MoM',
    },
    {
      label: 'Behavior Density',
      value: data ? data.avg_data_points.toFixed(1) : '—',
      sub: 'avg signals/user',
      icon: TrendingUp,
      color: 'bg-violet-500/10 text-violet-600',
      target: '≥ 6',
    },
    {
      label: 'Agent Capture (7d)',
      value: data ? data.capture_rate_per_agent_7d.toFixed(1) : '—',
      sub: data ? `${fmt(data.agent_signals_7d)} signals / ${fmt(data.active_agents_7d)} agents` : '',
      icon: MapPinned,
      color: 'bg-amber-500/10 text-amber-600',
      target: '≥ 70/agent/wk',
    },
    {
      label: 'Lender-Ready Users',
      value: data ? fmt(data.lender_ready) : '—',
      sub: 'score ≥ 60 & ≥ 5 signals',
      icon: Banknote,
      color: 'bg-rose-500/10 text-rose-600',
      target: 'grow MoM',
    },
    {
      label: 'Agent Tenant Health',
      value: data?.agent_tenant_health_pct != null ? `${data.agent_tenant_health_pct}%` : '—',
      sub: data?.active_agents_with_tenants ? `across ${fmt(data.active_agents_with_tenants)} agents` : 'tenants paying ≥50%',
      icon: Trophy,
      color: 'bg-emerald-500/10 text-emerald-700',
      target: '≥ 70%',
    },
  ];

  return (
    <div className="rounded-2xl border border-primary/30 bg-gradient-to-br from-primary/5 to-emerald-500/5 p-3 sm:p-4">
      <div className="flex items-center gap-2 mb-3">
        <ShieldCheck className="h-5 w-5 text-primary" />
        <h3 className="text-sm font-bold">Trust Coverage — Africa Mission</h3>
        <span className="ml-auto text-[10px] text-muted-foreground">
          Every user → a Welile Trust Score
        </span>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-2 sm:gap-3 mb-4">
        {kpis.map((k) => (
          <div key={k.label} className="rounded-xl border border-border bg-card p-3">
            <div className="flex items-start justify-between gap-2">
              <div className={`p-2 rounded-lg ${k.color}`}>
                <k.icon className="h-4 w-4" />
              </div>
              <span className="text-[9px] uppercase tracking-wide text-muted-foreground">
                {k.target}
              </span>
            </div>
            <p className="text-xs text-muted-foreground mt-2 truncate">{k.label}</p>
            {isLoading ? (
              <div className="h-6 w-16 bg-muted animate-pulse rounded mt-1" />
            ) : (
              <p className="text-xl font-bold mt-0.5">{k.value}</p>
            )}
            {k.sub && <p className="text-[10px] text-muted-foreground truncate">{k.sub}</p>}
          </div>
        ))}
      </div>

      <div className="rounded-xl border border-border bg-card p-3">
        <div className="flex items-center gap-2 mb-2">
          <Users className="h-4 w-4 text-primary" />
          <h4 className="text-xs font-semibold">Score Distribution by Tier</h4>
        </div>
        {isLoading ? (
          <div className="h-[180px] bg-muted/30 animate-pulse rounded" />
        ) : (
          <ResponsiveContainer width="100%" height={180}>
            <BarChart data={tierData}>
              <CartesianGrid strokeDasharray="3 3" className="stroke-border" />
              <XAxis dataKey="tier" className="text-xs capitalize" />
              <YAxis className="text-xs" />
              <Tooltip
                formatter={(v: any) => [Number(v).toLocaleString(), 'Users']}
                labelFormatter={(l) => `Tier: ${l}`}
              />
              <Bar dataKey="count" radius={[6, 6, 0, 0]}>
                {tierData.map((d) => (
                  <Cell key={d.key} fill={TIER_COLORS[d.key] || 'hsl(var(--primary))'} />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        )}
      </div>
    </div>
  );
}
