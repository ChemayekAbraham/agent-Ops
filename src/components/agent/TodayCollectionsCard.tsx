import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { formatUGX } from '@/lib/rentCalculations';
import { Users, ChevronRight, AlertTriangle, CheckCircle2 } from 'lucide-react';
import { Badge } from '@/components/ui/badge';

interface Props {
  agentId: string;
  onViewTenants: () => void;
}

export function TodayCollectionsCard({ agentId, onViewTenants }: Props) {
  const { data, isLoading } = useQuery({
    queryKey: ['today-collections-summary', agentId],
    queryFn: async () => {
      // Get all active rent requests for this agent
      const { data: requests } = await supabase
        .from('rent_requests')
        .select('id, tenant_id, daily_repayment, total_repayment, amount_repaid, status')
        .eq('agent_id', agentId)
        .in('status', ['approved', 'disbursed', 'active', 'repaying', 'funded']);

      const allRequests = requests || [];
      if (allRequests.length === 0) return { owingCount: 0, totalDailyDue: 0, totalOwing: 0, topTenants: [] };

      // Get unique tenant IDs and fetch profiles
      const tenantIds = [...new Set(allRequests.map(r => r.tenant_id))];
      const { data: profiles } = await supabase
        .from('profiles')
        .select('id, full_name, phone')
        .in('id', tenantIds);

      const profileMap = new Map((profiles || []).map(p => [p.id, p]));
      const tenants = allRequests;
      
      // Group by tenant, calculate owing
      const tenantMap = new Map<string, { name: string; phone: string; dailyDue: number; totalOwing: number; }>();
      
      tenants.forEach((r: any) => {
        const owing = Math.max(0, (r.total_repayment || 0) - (r.amount_repaid || 0));
        if (owing <= 0) return;
        
        const existing = tenantMap.get(r.tenant_id);
        const profile = profileMap.get(r.tenant_id);
        if (existing) {
          existing.dailyDue += Number(r.daily_repayment || 0);
          existing.totalOwing += owing;
        } else {
          tenantMap.set(r.tenant_id, {
            name: profile?.full_name || 'Tenant',
            phone: profile?.phone || '',
            dailyDue: Number(r.daily_repayment || 0),
            totalOwing: owing,
          });
        }
      });

      // Sort by highest owing first, take top 3
      const sorted = Array.from(tenantMap.values()).sort((a, b) => b.totalOwing - a.totalOwing);
      const totalDailyDue = sorted.reduce((s, t) => s + t.dailyDue, 0);
      const totalOwing = sorted.reduce((s, t) => s + t.totalOwing, 0);

      return {
        owingCount: sorted.length,
        totalDailyDue,
        totalOwing,
        topTenants: sorted.slice(0, 3),
      };
    },
    staleTime: 300000,
    refetchOnWindowFocus: false,
  });

  if (isLoading) {
    return (
      <div className="rounded-xl border border-border/60 bg-card p-4 animate-pulse">
        <div className="h-4 w-32 bg-muted rounded mb-3" />
        <div className="h-6 w-24 bg-muted rounded" />
      </div>
    );
  }

  if (!data || data.owingCount === 0) {
    return (
      <div className="rounded-xl border border-success/30 bg-success/5 p-4 flex items-center gap-3">
        <div className="p-2 rounded-lg bg-success/15">
          <CheckCircle2 className="h-5 w-5 text-success" />
        </div>
        <div className="flex-1">
          <p className="text-sm font-semibold text-success">All clear!</p>
          <p className="text-[11px] text-muted-foreground">No outstanding collections today</p>
        </div>
      </div>
    );
  }

  return (
    <button
      onClick={onViewTenants}
      className="w-full rounded-xl border border-border/60 bg-card p-4 text-left touch-manipulation active:opacity-90 transition-all hover:border-primary/30"
    >
      {/* Header */}
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <div className="p-2 rounded-lg bg-destructive/10">
            <AlertTriangle className="h-4 w-4 text-destructive" />
          </div>
          <div>
            <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider">Collect Today</p>
            <p className="text-sm font-bold">{data.owingCount} tenant{data.owingCount !== 1 ? 's' : ''} pending</p>
          </div>
        </div>
        <div className="text-right flex items-center gap-1.5">
          <div>
            <p className="text-lg font-bold text-destructive font-mono">{formatUGX(data.totalDailyDue)}</p>
            <p className="text-[9px] text-muted-foreground">daily target</p>
          </div>
          <ChevronRight className="h-4 w-4 text-muted-foreground" />
        </div>
      </div>

      {/* Top 3 tenants preview */}
      <div className="space-y-1.5">
        {data.topTenants.map((t, i) => (
          <div key={i} className="flex items-center gap-2 px-2.5 py-2 rounded-lg bg-muted/40">
            <div className={`w-7 h-7 rounded-lg flex items-center justify-center text-[11px] font-bold ${
              i === 0 ? 'bg-destructive/15 text-destructive' : 'bg-muted text-muted-foreground'
            }`}>
              {t.name.charAt(0).toUpperCase()}
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-xs font-medium truncate">{t.name}</p>
            </div>
            <span className="text-xs font-bold text-destructive font-mono shrink-0">
              {formatUGX(t.totalOwing)}
            </span>
          </div>
        ))}
        {data.owingCount > 3 && (
          <p className="text-[10px] text-primary font-medium text-center pt-1">
            +{data.owingCount - 3} more → View all
          </p>
        )}
      </div>
    </button>
  );
}
