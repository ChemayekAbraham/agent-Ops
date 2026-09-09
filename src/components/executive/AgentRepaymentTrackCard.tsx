import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { TrendingUp, TrendingDown, ShieldCheck, Clock, AlertTriangle } from 'lucide-react';

interface Props {
  agentId: string | null | undefined;
  /** Current request under review — excluded from the history list. */
  currentRequestId?: string | null;
}

interface PriorPlan {
  id: string;
  tenant_id: string;
  tenant_name?: string | null;
  rent_amount: number | null;
  total_repayment: number | null;
  amount_repaid: number | null;
  duration_days: number | null;
  daily_repayment: number | null;
  status: string | null;
  created_at: string;
  funded_at: string | null;
}

const ugx = (n: number) => `UGX ${Math.round(n || 0).toLocaleString()}`;

const fmt = (d: string | null) =>
  d ? new Date(d).toLocaleDateString('en-UG', { day: 'numeric', month: 'short', year: '2-digit' }) : '—';

function pctRepaid(plan: PriorPlan): number {
  const total = Number(plan.total_repayment) || 0;
  const repaid = Number(plan.amount_repaid) || 0;
  return total > 0 ? Math.min(100, Math.round((repaid / total) * 100)) : 0;
}

function daysToPay(plan: PriorPlan): string {
  if (!plan.funded_at) return '—';
  const start = new Date(plan.funded_at).getTime();
  const now = Date.now();
  const elapsed = Math.round((now - start) / (1000 * 60 * 60 * 24));
  const planned = Number(plan.duration_days) || 0;
  if (['completed', 'closed'].includes(plan.status || '')) {
    return elapsed > 0 ? `${elapsed}d` : `${planned}d`;
  }
  return `${elapsed}d / ${planned}d`;
}

function StatusPill({ status }: { status: string | null }) {
  const s = (status || 'unknown').toLowerCase();
  const cfg: Record<string, { label: string; className: string }> = {
    completed: { label: 'Completed', className: 'bg-emerald-100 text-emerald-700 border-emerald-200' },
    closed:    { label: 'Closed',    className: 'bg-emerald-100 text-emerald-700 border-emerald-200' },
    repaying:  { label: 'Repaying',  className: 'bg-blue-100 text-blue-700 border-blue-200' },
    funded:    { label: 'Funded',    className: 'bg-cyan-100 text-cyan-700 border-cyan-200' },
    rejected:  { label: 'Rejected',  className: 'bg-red-100 text-red-700 border-red-200' },
    defaulted: { label: 'Defaulted', className: 'bg-red-100 text-red-700 border-red-200' },
    overdue:   { label: 'Overdue',   className: 'bg-amber-100 text-amber-700 border-amber-200' },
  };
  const { label, className } = cfg[s] ?? {
    label: s.replace(/_/g, ' '),
    className: 'bg-muted text-muted-foreground border-border',
  };
  return (
    <span className={`inline-flex items-center rounded-full border px-1.5 py-0.5 text-[9px] font-semibold capitalize ${className}`}>
      {label}
    </span>
  );
}

/**
 * Read-only context strip for the officer's rent-request review sheet.
 *
 * Shows the submitting agent's track record across ALL their previous tenants:
 * - Completion rate %, total repaid, total obligation, active plan count
 * - Per-plan rows: tenant name, date, rent amount, elapsed / planned days,
 *   amount repaid vs total, status pill, colour-coded repayment progress bar
 *
 * No business logic, no writes.
 */
export function AgentRepaymentTrackCard({ agentId, currentRequestId }: Props) {
  const { data, isLoading } = useQuery({
    queryKey: ['agent-repayment-track', agentId, currentRequestId],
    enabled: !!agentId,
    staleTime: 120_000,
    queryFn: async () => {
      const { data: rrs, error } = await supabase
        .from('rent_requests')
        .select('id, tenant_id, rent_amount, total_repayment, amount_repaid, duration_days, daily_repayment, status, created_at, funded_at')
        .eq('agent_id', agentId as string)
        .in('status', ['funded', 'repaying', 'completed', 'closed', 'rejected', 'defaulted', 'overdue'])
        .order('created_at', { ascending: false })
        .limit(50);
      if (error) throw error;

      const plans = ((rrs || []) as PriorPlan[]).filter((r) => r.id !== currentRequestId);

      const tenantIds = [...new Set(plans.map((p) => p.tenant_id).filter(Boolean))];
      if (tenantIds.length === 0) return plans;

      const { data: profiles } = await supabase
        .from('profiles')
        .select('id, full_name')
        .in('id', tenantIds);

      const nameMap = new Map((profiles || []).map((p: any) => [p.id, p.full_name]));
      return plans.map((p) => ({ ...p, tenant_name: nameMap.get(p.tenant_id) || 'Unknown Tenant' }));
    },
  });

  if (!agentId) return null;

  if (isLoading) {
    return <Skeleton className="h-24 w-full rounded-xl" />;
  }

  const plans = (data || []) as PriorPlan[];
  const completed = plans.filter((p) => ['completed', 'closed'].includes(p.status || ''));
  const active    = plans.filter((p) => ['funded', 'repaying'].includes(p.status || ''));
  const problem   = plans.filter((p) => ['overdue', 'defaulted'].includes(p.status || ''));

  const totalObligation = plans.reduce((s, p) => s + (Number(p.total_repayment) || 0), 0);
  const totalRepaid     = plans.reduce((s, p) => s + (Number(p.amount_repaid)   || 0), 0);
  const completionRate  = plans.length > 0 ? Math.round((completed.length / plans.length) * 100) : 0;

  if (plans.length === 0) {
    return (
      <div className="rounded-xl border-2 border-violet-500/30 bg-violet-500/5 p-3 flex items-start gap-2">
        <ShieldCheck className="h-4 w-4 text-violet-600 mt-0.5 shrink-0" />
        <div className="text-xs">
          <p className="font-bold text-violet-800 dark:text-violet-300">First-time submission</p>
          <p className="text-muted-foreground mt-0.5">
            This agent has no previously funded rent plans on the platform.
          </p>
        </div>
      </div>
    );
  }

  const trackIcon =
    completionRate >= 80 ? (
      <TrendingUp className="h-4 w-4 text-emerald-600" />
    ) : completionRate >= 50 ? (
      <Clock className="h-4 w-4 text-amber-600" />
    ) : (
      <TrendingDown className="h-4 w-4 text-red-600" />
    );

  const trackColor =
    completionRate >= 80 ? 'text-emerald-600' : completionRate >= 50 ? 'text-amber-600' : 'text-red-600';

  return (
    <div className="rounded-xl border bg-muted/30 p-3 space-y-3">
      {/* Header */}
      <div className="flex items-center justify-between gap-2">
        <h4 className="text-sm font-semibold flex items-center gap-1.5">
          {trackIcon}
          Agent Repayment Track Record
        </h4>
        <Badge variant="secondary" className="text-[10px]">
          {plans.length} previous {plans.length === 1 ? 'plan' : 'plans'}
        </Badge>
      </div>

      {/* Summary stats */}
      <div className="grid grid-cols-4 gap-2 text-center">
        <div className="rounded-lg bg-card border p-2">
          <p className="text-[10px] text-muted-foreground">Completed</p>
          <p className={`text-sm font-bold ${trackColor}`}>{completionRate}%</p>
          <p className="text-[9px] text-muted-foreground">{completed.length}/{plans.length}</p>
        </div>
        <div className="rounded-lg bg-card border p-2">
          <p className="text-[10px] text-muted-foreground">Total Repaid</p>
          <p className="text-sm font-bold text-emerald-600">{ugx(totalRepaid)}</p>
        </div>
        <div className="rounded-lg bg-card border p-2">
          <p className="text-[10px] text-muted-foreground">Obligation</p>
          <p className="text-sm font-bold">{ugx(totalObligation)}</p>
        </div>
        <div className="rounded-lg bg-card border p-2">
          <p className="text-[10px] text-muted-foreground">Active</p>
          <p className={`text-sm font-bold ${
            problem.length > 0 ? 'text-red-600' : active.length > 0 ? 'text-blue-600' : 'text-muted-foreground'
          }`}>
            {active.length}
          </p>
          {problem.length > 0 && (
            <p className="text-[9px] text-red-500 flex items-center justify-center gap-0.5">
              <AlertTriangle className="h-2.5 w-2.5" />{problem.length} overdue
            </p>
          )}
        </div>
      </div>

      {/* Per-plan rows */}
      <div className="space-y-1">
        {plans.slice(0, 6).map((p) => {
          const pct = pctRepaid(p);
          return (
            <div key={p.id} className="rounded-lg bg-card border px-2 py-2 space-y-1.5">
              <div className="flex items-center justify-between gap-2 text-xs">
                <div className="min-w-0">
                  <p className="font-medium truncate">{p.tenant_name}</p>
                  <p className="text-[10px] text-muted-foreground">
                    {fmt(p.created_at)} · {ugx(Number(p.rent_amount) || 0)} rent ·{' '}
                    <span className="font-medium">{daysToPay(p)}</span>
                  </p>
                </div>
                <div className="flex items-center gap-1.5 shrink-0">
                  <div className="text-right">
                    <p className="font-semibold text-emerald-600">{ugx(Number(p.amount_repaid) || 0)}</p>
                    <p className="text-[10px] text-muted-foreground">of {ugx(Number(p.total_repayment) || 0)}</p>
                  </div>
                  <StatusPill status={p.status} />
                </div>
              </div>
              {/* Repayment progress bar */}
              <div className="w-full h-1 rounded-full bg-muted overflow-hidden">
                <div
                  className={`h-full rounded-full transition-all ${
                    pct >= 100
                      ? 'bg-emerald-500'
                      : pct >= 60
                      ? 'bg-blue-500'
                      : pct >= 30
                      ? 'bg-amber-500'
                      : 'bg-red-400'
                  }`}
                  style={{ width: `${pct}%` }}
                />
              </div>
            </div>
          );
        })}
        {plans.length > 6 && (
          <p className="text-[10px] text-muted-foreground text-center">
            +{plans.length - 6} older {plans.length - 6 === 1 ? 'plan' : 'plans'}
          </p>
        )}
      </div>
    </div>
  );
}

export default AgentRepaymentTrackCard;
