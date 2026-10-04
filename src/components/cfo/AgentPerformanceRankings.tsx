import { useState, useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Badge } from '@/components/ui/badge';
import { Progress } from '@/components/ui/progress';
import { CompactAmount } from '@/components/ui/CompactAmount';
import { Loader2, Trophy, TrendingUp, Users, Target } from 'lucide-react';
import { subDays, startOfMonth } from 'date-fns';
import { AgentDetailDialog } from '@/components/executive/AgentDetailDialog';

interface AgentRank {
  agentId: string;
  name: string;
  totalCollected: number;
  totalDue: number;
  collectionRate: number;
  tenantCount: number;
  requestCount: number;
}

interface Props {
  compact?: boolean;
}

export function AgentPerformanceRankings({ compact = false }: Props) {
  const [period, setPeriod] = useState<'week' | 'month' | 'all'>('month');
  const [openAgentId, setOpenAgentId] = useState<string | null>(null);

  const dateFrom = useMemo(() => {
    if (period === 'week') return subDays(new Date(), 7).toISOString();
    if (period === 'month') return startOfMonth(new Date()).toISOString();
    return undefined;
  }, [period]);

  const { data: rankings, isLoading } = useQuery({
    queryKey: ['agent-performance-rankings', dateFrom],
    queryFn: async () => {
      let query = supabase
        .from('rent_requests')
        .select('id, agent_id, tenant_id, total_repayment, amount_repaid, status, created_at')
        .not('agent_id', 'is', null);

      if (dateFrom) {
        query = query.gte('created_at', dateFrom);
      }

      const { data: requests } = await query.limit(1000);
      if (!requests?.length) return [];

      // Aggregate by agent
      const agentMap = new Map<string, { totalCollected: number; totalDue: number; tenants: Set<string>; count: number }>();

      for (const rr of requests) {
        if (!rr.agent_id) continue;
        const existing = agentMap.get(rr.agent_id) || { totalCollected: 0, totalDue: 0, tenants: new Set<string>(), count: 0 };
        existing.totalCollected += rr.amount_repaid || 0;
        existing.totalDue += rr.total_repayment || 0;
        existing.tenants.add(rr.tenant_id);
        existing.count += 1;
        agentMap.set(rr.agent_id, existing);
      }

      // Resolve names
      const agentIds = [...agentMap.keys()];
      const { data: profiles } = await supabase
        .from('profiles')
        .select('id, full_name')
        .in('id', agentIds);

      const nameMap = new Map((profiles || []).map(p => [p.id, p.full_name || 'Unknown']));

      const ranked: AgentRank[] = agentIds.map(id => {
        const d = agentMap.get(id)!;
        return {
          agentId: id,
          name: nameMap.get(id) || 'Unknown',
          totalCollected: d.totalCollected,
          totalDue: d.totalDue,
          collectionRate: d.totalDue > 0 ? Math.round((d.totalCollected / d.totalDue) * 100) : 0,
          tenantCount: d.tenants.size,
          requestCount: d.count,
        };
      });

      return ranked.sort((a, b) => b.totalCollected - a.totalCollected);
    },
  });

  const medals = ['🥇', '🥈', '🥉'];
  const displayList = compact ? (rankings || []).slice(0, 5) : (rankings || []);

  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between">
          <CardTitle className="text-sm flex items-center gap-2">
            <Trophy className="h-4 w-4 text-yellow-500" />
            {compact ? 'Top Agents' : 'Agent Performance Rankings'}
          </CardTitle>
          {!compact && (
            <Select value={period} onValueChange={(v: 'week' | 'month' | 'all') => setPeriod(v)}>
              <SelectTrigger className="w-[130px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="week">This Week</SelectItem>
                <SelectItem value="month">This Month</SelectItem>
                <SelectItem value="all">All Time</SelectItem>
              </SelectContent>
            </Select>
          )}
        </div>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <div className="flex items-center justify-center py-6">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          </div>
        ) : displayList.length === 0 ? (
          <p className="text-sm text-muted-foreground text-center py-6">No agent data found.</p>
        ) : (
          <div className="space-y-3">
            {displayList.map((agent, idx) => (
              <div
                key={agent.agentId}
                onClick={() => setOpenAgentId(agent.agentId)}
                className="flex items-center gap-3 p-3 rounded-xl bg-muted/30 hover:bg-muted/50 transition-colors cursor-pointer"
              >
                {/* Rank */}
                <div className="w-8 text-center text-lg font-bold shrink-0">
                  {idx < 3 ? medals[idx] : <span className="text-sm text-muted-foreground">#{idx + 1}</span>}
                </div>

                {/* Info */}
                <div className="flex-1 min-w-0 space-y-1">
                  <div className="flex items-center justify-between">
                    <p className="text-sm font-semibold truncate">{agent.name}</p>
                    <CompactAmount value={agent.totalCollected} className="text-sm font-bold text-primary" />
                  </div>
                  <div className="flex items-center gap-3 text-xs text-muted-foreground">
                    <span className="flex items-center gap-1">
                      <Users className="h-3 w-3" /> {agent.tenantCount} tenants
                    </span>
                    <span className="flex items-center gap-1">
                      <Target className="h-3 w-3" /> {agent.requestCount} requests
                    </span>
                  </div>
                  <div className="flex items-center gap-2">
                    <Progress value={agent.collectionRate} className="h-1.5 flex-1" />
                    <Badge variant={agent.collectionRate >= 80 ? 'default' : agent.collectionRate >= 50 ? 'secondary' : 'destructive'} className="text-[10px] px-1.5">
                      {agent.collectionRate}%
                    </Badge>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </CardContent>
      <AgentDetailDialog
        agentId={openAgentId}
        open={!!openAgentId}
        onOpenChange={(o) => !o && setOpenAgentId(null)}
      />
    </Card>
  );
}
