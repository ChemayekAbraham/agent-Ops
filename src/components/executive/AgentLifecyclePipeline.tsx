import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { fetchAllAgentIds, batchedQuery } from '@/lib/supabaseBatchUtils';
import { Badge } from '@/components/ui/badge';
import { ArrowRight } from 'lucide-react';

interface StageInfo {
  key: string;
  label: string;
  emoji: string;
  color: string;
}

const STAGES: StageInfo[] = [
  { key: 'new',        label: 'New',        emoji: '🆕', color: 'bg-blue-500/10 text-blue-600' },
  { key: 'active',     label: 'Active',     emoji: '🟢', color: 'bg-green-500/10 text-green-600' },
  { key: 'top',        label: 'Top Earner',  emoji: '⭐', color: 'bg-amber-500/10 text-amber-600' },
  { key: 'idle',       label: 'Idle (7d+)',   emoji: '😴', color: 'bg-muted text-muted-foreground' },
  { key: 'dormant',    label: 'Dormant (30d+)', emoji: '🔴', color: 'bg-destructive/10 text-destructive' },
];

export function AgentLifecyclePipeline() {
  const { data: pipeline, isLoading } = useQuery({
    queryKey: ['agent-lifecycle-pipeline'],
    queryFn: async () => {
      const agentIds = await fetchAllAgentIds();
      if (agentIds.length === 0) return { new: 0, active: 0, top: 0, idle: 0, dormant: 0, total: 0 };

      const [profiles, earnings] = await Promise.all([
        batchedQuery<any>(agentIds, b => supabase.from('profiles').select('id, last_active_at, created_at').in('id', b)),
        batchedQuery<any>(agentIds, b => supabase.from('agent_earnings').select('agent_id, amount').in('agent_id', b)),
      ]);

      const earningsMap: Record<string, number> = {};
      (earnings || []).forEach(e => { earningsMap[e.agent_id] = (earningsMap[e.agent_id] || 0) + e.amount; });

      const now = Date.now();
      const DAY = 86400000;
      const counts = { new: 0, active: 0, top: 0, idle: 0, dormant: 0, total: agentIds.length };

      (profiles || []).forEach(p => {
        const createdDaysAgo = (now - new Date(p.created_at).getTime()) / DAY;
        const lastActiveDaysAgo = p.last_active_at
          ? (now - new Date(p.last_active_at).getTime()) / DAY
          : 999;
        const totalEarned = earningsMap[p.id] || 0;

        if (lastActiveDaysAgo > 30) counts.dormant++;
        else if (lastActiveDaysAgo > 7) counts.idle++;
        else if (totalEarned >= 20000) counts.top++;
        else if (createdDaysAgo <= 7) counts.new++;
        else counts.active++;
      });

      return counts;
    },
    staleTime: 600000,
  });

  return (
    <div className="rounded-2xl border border-border bg-card p-4 space-y-3">
      <h3 className="text-sm font-semibold">🔄 Agent Lifecycle Pipeline</h3>

      {isLoading ? (
        <p className="text-xs text-muted-foreground">Loading...</p>
      ) : (
        <>
          <div className="flex items-center gap-1 overflow-x-auto pb-1">
            {STAGES.map((stage, i) => {
              const count = pipeline?.[stage.key as keyof typeof pipeline] || 0;
              return (
                <div key={stage.key} className="flex items-center gap-1">
                  <div className={`rounded-xl px-3 py-2.5 text-center min-w-[80px] ${stage.color}`}>
                    <p className="text-xs">{stage.emoji}</p>
                    <p className="text-lg font-bold">{count}</p>
                    <p className="text-[10px] font-medium whitespace-nowrap">{stage.label}</p>
                  </div>
                  {i < STAGES.length - 1 && (
                    <ArrowRight className="h-3 w-3 text-muted-foreground shrink-0" />
                  )}
                </div>
              );
            })}
          </div>

          <div className="flex items-center justify-between text-xs text-muted-foreground">
            <span>Total: <strong className="text-foreground">{pipeline?.total || 0}</strong> agents</span>
            {(pipeline?.dormant || 0) > 0 && (
              <Badge variant="destructive" className="text-[10px]">
                {pipeline?.dormant} need attention
              </Badge>
            )}
          </div>
        </>
      )}
    </div>
  );
}
