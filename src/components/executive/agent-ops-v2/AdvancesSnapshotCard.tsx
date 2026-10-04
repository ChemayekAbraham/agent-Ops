import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  ArrowRight,
  BarChart3,
  ClipboardList,
  Loader2,
  Wallet,
  AlertTriangle,
  Banknote,
  Activity,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { formatUGX } from '@/lib/rentCalculations';
import type { DateRange } from './AgentOpsHomeView';

interface AdvancesSnapshotCardProps {
  range: DateRange;
  onOpenSection: (key: string) => void;
}

function rangeStartIso(range: DateRange): string {
  const now = Date.now();
  const ms = range === '24h' ? 24 * 3600e3 : range === '7d' ? 7 * 86400e3 : 30 * 86400e3;
  return new Date(now - ms).toISOString();
}

function kampalaToday(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Kampala' }).format(new Date());
}

export function AdvancesSnapshotCard({ range, onOpenSection }: AdvancesSnapshotCardProps) {
  const since = rangeStartIso(range);

  const { data, isLoading } = useQuery({
    queryKey: ['agent-ops-advances-snapshot', range],
    staleTime: 60_000,
    refetchInterval: 120_000,
    queryFn: async () => {
      const today = kampalaToday();
      const [pending, awaitingCfo, active, issued, collected] = await Promise.all([
        supabase
          .from('agent_advance_requests')
          .select('id, principal')
          .eq('status', 'pending'),
        supabase
          .from('agent_advance_requests')
          .select('id', { count: 'exact', head: true })
          .eq('status', 'agent_ops_approved'),
        supabase
          .from('agent_advances')
          .select('agent_id, outstanding_balance, arrears_balance, status')
          .in('status', ['active', 'overdue']),
        supabase
          .from('agent_advances')
          .select('principal')
          .gte('issued_at', since),
        supabase
          .from('agent_advance_ledger')
          .select('amount_deducted')
          .eq('date', today)
          .gt('amount_deducted', 0),
      ]);

      const pendingRows = (pending.data ?? []) as Array<{ principal: number | null }>;
      const activeRows = (active.data ?? []) as Array<{
        agent_id: string;
        outstanding_balance: number | null;
        arrears_balance: number | null;
        status: string;
      }>;
      const issuedRows = (issued.data ?? []) as Array<{ principal: number | null }>;
      const collectedRows = (collected.data ?? []) as Array<{ amount_deducted: number | null }>;

      const inArrears = activeRows.filter((r) => Number(r.arrears_balance ?? 0) > 0);

      return {
        pendingCount: pendingRows.length,
        pendingValue: pendingRows.reduce((s, r) => s + Number(r.principal ?? 0), 0),
        awaitingCfoCount: awaitingCfo.count ?? 0,
        activeCount: activeRows.length,
        activeAgents: new Set(activeRows.map((r) => r.agent_id)).size,
        outstanding: activeRows.reduce((s, r) => s + Number(r.outstanding_balance ?? 0), 0),
        overdueCount: activeRows.filter((r) => r.status === 'overdue').length,
        arrearsCount: inArrears.length,
        arrearsValue: inArrears.reduce((s, r) => s + Number(r.arrears_balance ?? 0), 0),
        issuedCount: issuedRows.length,
        issuedValue: issuedRows.reduce((s, r) => s + Number(r.principal ?? 0), 0),
        collectedToday: collectedRows.reduce((s, r) => s + Number(r.amount_deducted ?? 0), 0),
        collectedTodayCount: collectedRows.length,
      };
    },
  });

  const rangeLabel = range === '24h' ? 'last 24h' : range === '7d' ? 'last 7 days' : 'last 30 days';
  const pendingCount = data?.pendingCount ?? 0;

  const stats: Array<{
    label: string;
    value: string;
    sub?: string;
    icon: React.ComponentType<{ className?: string }>;
    tone: 'primary' | 'amber' | 'rose' | 'emerald';
    onClick?: () => void;
  }> = [
    {
      label: 'Pending requests',
      value: pendingCount.toLocaleString(),
      sub: `${formatUGX(data?.pendingValue ?? 0)} requested`,
      icon: ClipboardList,
      tone: 'amber',
      onClick: () => onOpenSection('advance-requests'),
    },
    {
      label: 'Active advances',
      value: (data?.activeCount ?? 0).toLocaleString(),
      sub: `${(data?.activeAgents ?? 0).toLocaleString()} agents · ${(data?.overdueCount ?? 0).toLocaleString()} overdue`,
      icon: Activity,
      tone: 'primary',
      onClick: () => onOpenSection('active-advances'),
    },
    {
      label: 'Outstanding exposure',
      value: formatUGX(data?.outstanding ?? 0),
      sub: `${formatUGX(data?.issuedValue ?? 0)} disbursed · ${rangeLabel}`,
      icon: Wallet,
      tone: 'primary',
      onClick: () => onOpenSection('advances-analytics'),
    },
    {
      label: 'In arrears',
      value: (data?.arrearsCount ?? 0).toLocaleString(),
      sub: `${formatUGX(data?.arrearsValue ?? 0)} behind schedule`,
      icon: AlertTriangle,
      tone: 'rose',
      onClick: () => onOpenSection('advance-repayments'),
    },
    {
      label: 'Recovered today',
      value: formatUGX(data?.collectedToday ?? 0),
      sub: `${(data?.collectedTodayCount ?? 0).toLocaleString()} deductions`,
      icon: Banknote,
      tone: 'emerald',
      onClick: () => onOpenSection('advance-repayments'),
    },
    {
      label: 'Awaiting CFO',
      value: (data?.awaitingCfoCount ?? 0).toLocaleString(),
      sub: 'Approved by Agent Ops',
      icon: ClipboardList,
      tone: 'amber',
      onClick: () => onOpenSection('advance-requests'),
    },
  ];

  const TONES: Record<string, string> = {
    primary: 'bg-primary/10 text-primary',
    amber: 'bg-amber-500/10 text-amber-600 dark:text-amber-400',
    rose: 'bg-rose-500/10 text-rose-600 dark:text-rose-400',
    emerald: 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400',
  };

  return (
    <Card className="rounded-2xl border-border/50 p-3 sm:p-4">
      <div className="flex items-start justify-between gap-2 mb-3">
        <div className="min-w-0">
          <h3 className="text-sm font-semibold text-foreground">Agent Advances</h3>
          <p className="text-[11px] text-muted-foreground">
            Requests, exposure and recovery · {rangeLabel}
          </p>
        </div>
        {isLoading && <Loader2 className="h-4 w-4 animate-spin text-muted-foreground shrink-0" />}
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 mb-3">
        <Button
          onClick={() => onOpenSection('advance-requests')}
          className="justify-between h-11 rounded-xl"
        >
          <span className="flex items-center gap-2">
            <ClipboardList className="h-4 w-4" />
            Advance Requests
            <Badge
              variant="secondary"
              className={cn(
                'ml-1 h-5 px-1.5 text-[10px] font-bold',
                pendingCount > 0
                  ? 'bg-rose-500 text-white border-transparent'
                  : 'bg-muted text-muted-foreground',
              )}
            >
              {isLoading ? '…' : `${pendingCount} pending`}
            </Badge>
          </span>
          <ArrowRight className="h-4 w-4" />
        </Button>
        <Button
          variant="outline"
          onClick={() => onOpenSection('advances-analytics')}
          className="justify-between h-11 rounded-xl"
        >
          <span className="flex items-center gap-2">
            <BarChart3 className="h-4 w-4" />
            Advances Overview
          </span>
          <ArrowRight className="h-4 w-4" />
        </Button>
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-3 gap-2">
        {stats.map((s) => (
          <button
            key={s.label}
            type="button"
            onClick={s.onClick}
            className="text-left rounded-xl border border-border/50 bg-muted/30 p-2.5 hover:border-primary/30 hover:bg-muted/50 transition-colors active:scale-[0.98] touch-manipulation"
          >
            <div className="flex items-center gap-1.5 mb-1">
              <span className={cn('h-6 w-6 rounded-lg flex items-center justify-center shrink-0', TONES[s.tone])}>
                <s.icon className="h-3.5 w-3.5" />
              </span>
              <span className="text-[10px] font-medium text-muted-foreground line-clamp-1">{s.label}</span>
            </div>
            <p className="text-base sm:text-lg font-bold tabular-nums text-foreground leading-tight">
              {isLoading ? '—' : s.value}
            </p>
            {s.sub && <p className="text-[10px] text-muted-foreground line-clamp-1">{s.sub}</p>}
          </button>
        ))}
      </div>
    </Card>
  );
}
