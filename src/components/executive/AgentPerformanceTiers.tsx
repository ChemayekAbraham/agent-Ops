import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { fetchAllAgentIds, batchedQuery } from '@/lib/supabaseBatchUtils';
import { Badge } from '@/components/ui/badge';
import { Trophy, Medal, Award, AlertTriangle } from 'lucide-react';

type Tier = 'gold' | 'silver' | 'bronze' | 'inactive';

interface AgentScore {
  id: string;
  name: string;
  tier: Tier;
  score: number;
  earnings: number;
  collections: number;
  visits: number;
  referrals: number;
}

const TIER_CONFIG: Record<Tier, { label: string; icon: any; color: string; bg: string }> = {
  gold:     { label: '🥇 Gold',   icon: Trophy,       color: 'text-amber-600',  bg: 'bg-amber-500/10' },
  silver:   { label: '🥈 Silver', icon: Medal,        color: 'text-muted-foreground',  bg: 'bg-slate-500/10' },
  bronze:   { label: '🥉 Bronze', icon: Award,        color: 'text-orange-600', bg: 'bg-orange-500/10' },
  inactive: { label: '⚠️ Inactive', icon: AlertTriangle, color: 'text-destructive', bg: 'bg-destructive/10' },
};

function getTier(score: number): Tier {
  if (score >= 70) return 'gold';
  if (score >= 40) return 'silver';
  if (score > 0) return 'bronze';
  return 'inactive';
}

export function AgentPerformanceTiers() {
  const { data: scores, isLoading } = useQuery({
    queryKey: ['agent-tier-scores'],
    queryFn: async () => {
      const ids = await fetchAllAgentIds();
      if (ids.length === 0) return [];

      const [profilesData, earningsData, collectionsData, visitsData, referralsData] = await Promise.all([
        batchedQuery<any>(ids, b => supabase.from('profiles').select('id, full_name').in('id', b)),
        batchedQuery<any>(ids, b => supabase.from('agent_earnings').select('agent_id, amount').in('agent_id', b)),
        batchedQuery<any>(ids, b => supabase.from('agent_collections').select('agent_id').is('reversed_at', null).in('agent_id', b)),
        batchedQuery<any>(ids, b => supabase.from('agent_visits').select('agent_id').in('agent_id', b)),
        batchedQuery<any>(ids, b => supabase.from('supporter_invites').select('created_by').in('created_by', b).eq('status', 'activated')),
      ]);

      const nameMap: Record<string, string> = {};
      profilesData.forEach((p: any) => { nameMap[p.id] = p.full_name; });

      const earningsMap: Record<string, number> = {};
      earningsData.forEach((e: any) => { earningsMap[e.agent_id] = (earningsMap[e.agent_id] || 0) + e.amount; });

      const collectionsMap: Record<string, number> = {};
      collectionsData.forEach((c: any) => { collectionsMap[c.agent_id] = (collectionsMap[c.agent_id] || 0) + 1; });

      const visitsMap: Record<string, number> = {};
      visitsData.forEach((v: any) => { visitsMap[v.agent_id] = (visitsMap[v.agent_id] || 0) + 1; });

      const referralsMap: Record<string, number> = {};
      referralsData.forEach((r: any) => {
        if (r.created_by) referralsMap[r.created_by] = (referralsMap[r.created_by] || 0) + 1;
      });

      return ids.map(id => {
        const earnings = earningsMap[id] || 0;
        const collections = collectionsMap[id] || 0;
        const visits = visitsMap[id] || 0;
        const referrals = referralsMap[id] || 0;

        // Score: weighted composite (0-100)
        const earningScore = Math.min(earnings / 50000, 1) * 30;     // max 30pts
        const collectionScore = Math.min(collections / 20, 1) * 25;   // max 25pts
        const visitScore = Math.min(visits / 15, 1) * 20;             // max 20pts
        const referralScore = Math.min(referrals / 10, 1) * 25;       // max 25pts
        const score = Math.round(earningScore + collectionScore + visitScore + referralScore);

        return {
          id,
          name: nameMap[id] || id.substring(0, 8),
          tier: getTier(score),
          score,
          earnings,
          collections,
          visits,
          referrals,
        } as AgentScore;
      });
    },
    staleTime: 600000,
  });

  const tierCounts = useMemo(() => {
    const counts: Record<Tier, number> = { gold: 0, silver: 0, bronze: 0, inactive: 0 };
    (scores || []).forEach(s => { counts[s.tier]++; });
    return counts;
  }, [scores]);

  const total = (scores || []).length;

  return (
    <div className="rounded-2xl border border-border bg-card p-4 space-y-3">
      <h3 className="text-sm font-semibold">📊 Agent Performance Tiers</h3>

      {isLoading ? (
        <p className="text-xs text-muted-foreground">Calculating scores...</p>
      ) : (
        <>
          <div className="grid grid-cols-4 gap-2">
            {(['gold', 'silver', 'bronze', 'inactive'] as Tier[]).map(tier => {
              const cfg = TIER_CONFIG[tier];
              const count = tierCounts[tier];
              const pct = total > 0 ? Math.round((count / total) * 100) : 0;
              return (
                <div key={tier} className={`rounded-xl p-3 text-center ${cfg.bg}`}>
                  <p className={`text-lg font-bold ${cfg.color}`}>{count}</p>
                  <p className="text-[10px] font-medium text-muted-foreground">{cfg.label}</p>
                  <p className="text-[10px] text-muted-foreground">{pct}%</p>
                </div>
              );
            })}
          </div>

          {/* Distribution bar */}
          <div className="h-2 rounded-full overflow-hidden flex bg-muted">
            {total > 0 && (['gold', 'silver', 'bronze', 'inactive'] as Tier[]).map(tier => {
              const pct = (tierCounts[tier] / total) * 100;
              const colors: Record<Tier, string> = {
                gold: 'bg-amber-500', silver: 'bg-slate-400', bronze: 'bg-orange-400', inactive: 'bg-destructive/60',
              };
              return pct > 0 ? <div key={tier} className={`${colors[tier]}`} style={{ width: `${pct}%` }} /> : null;
            })}
          </div>

          <p className="text-[10px] text-muted-foreground text-center">
            Scored on earnings (30%), collections (25%), referrals (25%), visits (20%)
          </p>
        </>
      )}
    </div>
  );
}
