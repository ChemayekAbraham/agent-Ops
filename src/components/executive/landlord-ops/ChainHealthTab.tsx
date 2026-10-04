import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { Badge } from '@/components/ui/badge';
import { Progress } from '@/components/ui/progress';
import {
  MapPin, Users, Building2, UserCheck, Link2, AlertTriangle, CheckCircle2, Image,
} from 'lucide-react';

interface ChainHealth {
  total_properties: number;
  with_gps: number;
  without_gps: number;
  with_landlord: number;
  without_landlord: number;
  with_agent: number;
  without_agent: number;
  with_tenant: number;
  fully_linked: number;
  missing_photos: number;
  unverified: number;
}

export function ChainHealthTab() {
  const { data, isLoading } = useQuery({
    queryKey: ['chain-health'],
    queryFn: async () => {
      const { data, error } = await supabase.rpc('get_chain_health_summary');
      if (error) throw error;
      return (data as any)?.[0] as ChainHealth | undefined;
    },
    staleTime: 30000,
  });

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-12">
        <div className="h-6 w-6 border-2 border-primary border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  if (!data) return <p className="text-center py-8 text-muted-foreground">No data available</p>;

  const total = data.total_properties || 1;
  const chainScore = Math.round((data.fully_linked / total) * 100);

  const metrics = [
    {
      label: 'GPS Captured',
      icon: MapPin,
      good: data.with_gps,
      bad: data.without_gps,
      color: 'text-emerald-600',
      bgColor: 'bg-emerald-500/10',
      badColor: 'bg-red-500/10 text-red-700',
    },
    {
      label: 'Linked to Landlord',
      icon: Building2,
      good: data.with_landlord,
      bad: data.without_landlord,
      color: 'text-blue-600',
      bgColor: 'bg-blue-500/10',
      badColor: 'bg-red-500/10 text-red-700',
    },
    {
      label: 'Linked to Agent',
      icon: Users,
      good: data.with_agent,
      bad: data.without_agent,
      color: 'text-indigo-600',
      bgColor: 'bg-indigo-500/10',
      badColor: 'bg-amber-500/10 text-amber-700',
    },
    {
      label: 'Has Tenant',
      icon: UserCheck,
      good: data.with_tenant,
      bad: total - data.with_tenant,
      color: 'text-green-600',
      bgColor: 'bg-green-500/10',
      badColor: 'bg-muted text-muted-foreground',
    },
    {
      label: 'Has Photos',
      icon: Image,
      good: total - data.missing_photos,
      bad: data.missing_photos,
      color: 'text-purple-600',
      bgColor: 'bg-purple-500/10',
      badColor: 'bg-amber-500/10 text-amber-700',
    },
  ];

  return (
    <div className="space-y-4">
      {/* Overall Chain Score */}
      <div className={`rounded-2xl border-2 p-4 ${
        chainScore >= 80 ? 'border-green-400/60 bg-green-50 dark:bg-green-950/20' :
        chainScore >= 50 ? 'border-amber-400/60 bg-amber-50 dark:bg-amber-950/20' :
        'border-red-400/60 bg-red-50 dark:bg-red-950/20'
      }`}>
        <div className="flex items-center gap-3 mb-3">
          <div className={`p-2 rounded-xl shrink-0 ${
            chainScore >= 80 ? 'bg-green-500/20' : chainScore >= 50 ? 'bg-amber-500/20' : 'bg-red-500/20'
          }`}>
            <Link2 className={`h-5 w-5 ${
              chainScore >= 80 ? 'text-green-600' : chainScore >= 50 ? 'text-amber-600' : 'text-red-600'
            }`} />
          </div>
          <div className="flex-1">
            <p className="font-bold text-lg">
              Chain Health: {chainScore}%
            </p>
            <p className="text-xs text-muted-foreground">
              {data.fully_linked} of {data.total_properties} properties fully linked (Agent → Landlord → GPS → ready for tenant)
            </p>
          </div>
          <div className="text-right">
            {chainScore >= 80 ? (
              <Badge className="bg-green-500/20 text-green-700 border-0">✅ Healthy</Badge>
            ) : chainScore >= 50 ? (
              <Badge className="bg-amber-500/20 text-amber-700 border-0">⚠️ Needs Work</Badge>
            ) : (
              <Badge className="bg-red-500/20 text-red-700 border-0 animate-pulse">🚨 Critical</Badge>
            )}
          </div>
        </div>
        <Progress value={chainScore} className="h-2" />
      </div>

      {/* Hard Block Notice */}
      <div className="rounded-xl border border-border bg-card p-3 flex items-start gap-3">
        <AlertTriangle className="h-5 w-5 text-amber-500 shrink-0 mt-0.5" />
        <div>
          <p className="text-sm font-semibold">Enforcement Rules Active</p>
          <p className="text-xs text-muted-foreground mt-0.5">
            🔒 <strong>Hard block:</strong> Tenants cannot be assigned to properties missing GPS coordinates, a linked landlord, or a linked agent.
          </p>
          <p className="text-xs text-muted-foreground mt-0.5">
            ⚠️ <strong>Soft warning:</strong> Properties missing photos or verification are flagged but not blocked.
          </p>
        </div>
      </div>

      {/* Metric Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
        {metrics.map(m => {
          const pct = Math.round((m.good / total) * 100);
          return (
            <div key={m.label} className="rounded-xl border border-border bg-card p-3 space-y-2">
              <div className="flex items-center gap-2">
                <div className={`p-1.5 rounded-lg ${m.bgColor}`}>
                  <m.icon className={`h-4 w-4 ${m.color}`} />
                </div>
                <span className="text-sm font-semibold flex-1">{m.label}</span>
                <span className="text-lg font-bold">{pct}%</span>
              </div>
              <Progress value={pct} className="h-1.5" />
              <div className="flex justify-between text-[10px]">
                <span className="text-green-600">✅ {m.good} linked</span>
                {m.bad > 0 && <span className={m.badColor + ' px-1.5 py-0.5 rounded-full font-medium'}>❌ {m.bad} missing</span>}
              </div>
            </div>
          );
        })}
      </div>

      {/* Unverified Warning */}
      {data.unverified > 0 && (
        <div className="rounded-xl border border-amber-300/50 bg-amber-50 dark:bg-amber-950/20 p-3 flex items-center gap-3">
          <CheckCircle2 className="h-5 w-5 text-amber-500 shrink-0" />
          <p className="text-sm">
            <strong>{data.unverified}</strong> properties still unverified — switch to the <strong>Verify</strong> tab to review.
          </p>
        </div>
      )}
    </div>
  );
}
