import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { Button } from '@/components/ui/button';
import {
  History, Sparkles, CheckCircle2, XCircle, Clock, Banknote, TrendingUp,
  ShieldCheck, ShieldAlert, ShieldQuestion, ChevronDown, ChevronUp, CalendarClock, Home, User,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { TenantRelationshipBadge } from '@/components/rent/TenantRelationshipBadge';
import { getRentCycleLabel, RENT_CYCLE_BADGE_CLASSES } from '@/lib/rentCycleLabel';

interface Props {
  tenantId: string | null | undefined;
  /** Current request under review — excluded from the history list. */
  currentRequestId?: string | null;
}

interface HistoryPlan {
  id: string;
  created_at: string;
  approved_at: string | null;
  funded_at: string | null;
  starts_on: string | null;
  status: string | null;
  tenancy_status: string | null;
  tenancy_ended_at: string | null;
  tenancy_end_reason: string | null;
  rejected_reason: string | null;
  rejected_at_stage: string | null;
  rent_amount: number | null;
  total_repayment: number | null;
  amount_repaid: number | null;
  expected_to_date: number | null;
  daily_repayment: number | null;
  duration_days: number | null;
  repayment_frequency: string | null;
  registration_type: string | null;
  request_city: string | null;
  landlord_name: string | null;
  agent_name: string | null;
  payments_count: number;
  first_payment_at: string | null;
  last_payment_at: string | null;
}

interface TenantHistory {
  classification: 'new' | 'renewing';
  counts: {
    total_requests: number;
    approved_plans: number;
    funded_plans: number;
    completed_plans: number;
    active_plans: number;
    rejected_requests: number;
    cancelled_requests: number;
    ended_tenancies: number;
    payments_count: number;
  };
  totals: {
    rent_financed: number;
    obligation: number;
    repaid: number;
    outstanding_active: number;
    expected_to_date: number;
  };
  performance: {
    repayment_rate: number | null;
    assessment: 'good' | 'average' | 'poor' | null;
    first_payment_at: string | null;
    last_payment_at: string | null;
    first_request_at: string | null;
    last_request_at: string | null;
  };
  plans: HistoryPlan[];
}

const ugx = (n: number | null | undefined) => `UGX ${Math.round(Number(n) || 0).toLocaleString()}`;
const fmtDate = (d: string | null | undefined) =>
  d ? new Date(d).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : '—';

const STATUS_STYLE: Record<string, { label: string; className: string; Icon: typeof CheckCircle2 }> = {
  completed:             { label: 'Completed',            className: 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 border-emerald-500/30', Icon: CheckCircle2 },
  repaying:              { label: 'Repaying',             className: 'bg-sky-500/15 text-sky-700 dark:text-sky-300 border-sky-500/30',                 Icon: TrendingUp },
  funded:                { label: 'Funded',               className: 'bg-sky-500/15 text-sky-700 dark:text-sky-300 border-sky-500/30',                 Icon: Banknote },
  coo_approved:          { label: 'Approved · awaiting funding', className: 'bg-violet-500/15 text-violet-700 dark:text-violet-300 border-violet-500/30', Icon: ShieldCheck },
  rejected:              { label: 'Rejected',             className: 'bg-destructive/15 text-destructive border-destructive/30',                        Icon: XCircle },
  cancelled:             { label: 'Cancelled',            className: 'bg-muted text-muted-foreground border-border',                                     Icon: XCircle },
};
const statusStyle = (s: string | null) =>
  (s && STATUS_STYLE[s]) || { label: (s || 'in review').replace(/_/g, ' '), className: 'bg-amber-500/15 text-amber-700 dark:text-amber-300 border-amber-500/30', Icon: Clock };

const ASSESSMENT: Record<'good' | 'average' | 'poor', { label: string; className: string; Icon: typeof ShieldCheck; hint: string }> = {
  good:    { label: 'Good payer',    className: 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 border-emerald-500/30', Icon: ShieldCheck,   hint: 'Repaid at least 90% of what fell due on previous plans' },
  average: { label: 'Average payer', className: 'bg-amber-500/15 text-amber-700 dark:text-amber-300 border-amber-500/30',       Icon: ShieldQuestion, hint: 'Repaid 60–89% of what fell due on previous plans' },
  poor:    { label: 'Poor payer',    className: 'bg-destructive/15 text-destructive border-destructive/30',                      Icon: ShieldAlert,   hint: 'Repaid under 60% of what fell due on previous plans' },
};

/**
 * Tenant History / Relationship Summary for the rent-request review surfaces.
 *
 * One read-only RPC (`rent_pipeline_tenant_history`) returns the tenant's real
 * prior rent plans, payments and an on-track assessment. No business logic,
 * no writes — purely context for the officer deciding on the request.
 */
export function TenantPaymentHistoryCard({ tenantId, currentRequestId }: Props) {
  const [expanded, setExpanded] = useState(false);
  const { data, isLoading, error } = useQuery({
    queryKey: ['tenant-relationship-history', tenantId, currentRequestId],
    enabled: !!tenantId,
    staleTime: 60_000,
    queryFn: async (): Promise<TenantHistory> => {
      const { data, error } = await supabase.rpc('rent_pipeline_tenant_history', {
        p_tenant_id: tenantId as string,
        p_exclude_request_id: currentRequestId ?? undefined,
      });
      if (error) throw error;
      return data as unknown as TenantHistory;
    },
  });

  if (!tenantId) return null;
  if (isLoading) return <Skeleton className="h-24 w-full rounded-xl" />;
  if (error || !data) {
    return (
      <div className="rounded-xl border bg-muted/30 p-3 text-xs text-muted-foreground flex items-center gap-2">
        <History className="h-4 w-4" /> Tenant history is unavailable right now.
      </div>
    );
  }

  const { classification, counts, totals, performance, plans } = data;
  const renewing = classification === 'renewing';
  const priorRequestsWithoutPlan = !renewing && counts.total_requests > 0;

  // ── Genuinely new tenant ───────────────────────────────────────────────
  if (!renewing && counts.total_requests === 0) {
    return (
      <div className="rounded-xl border-2 border-blue-500/30 bg-blue-500/5 p-3 flex items-start gap-2.5">
        <Sparkles className="h-4 w-4 text-blue-600 mt-0.5 shrink-0" />
        <div className="text-xs min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <p className="font-bold text-blue-800 dark:text-blue-300">New tenant</p>
            <TenantRelationshipBadge relationship="new" />
          </div>
          <p className="text-muted-foreground mt-0.5">
            No previous rent history with us — this is the tenant's first rent request on the platform.
          </p>
        </div>
      </div>
    );
  }

  const assessment = performance.assessment ? ASSESSMENT[performance.assessment] : null;
  const visiblePlans = expanded ? plans : plans.slice(0, 4);

  return (
    <div className="rounded-xl border bg-muted/30 p-3 space-y-3">
      {/* Header */}
      <div className="flex items-start justify-between gap-2 flex-wrap">
        <div className="min-w-0">
          <h4 className="text-sm font-semibold flex items-center gap-1.5">
            <History className="h-4 w-4 text-primary" />
            Tenant history
          </h4>
          <p className="text-[11px] text-muted-foreground mt-0.5">
            {renewing
              ? `${counts.approved_plans} approved plan${counts.approved_plans === 1 ? '' : 's'} · ${counts.completed_plans} completed · ${counts.active_plans} active` +
                (counts.rejected_requests ? ` · ${counts.rejected_requests} rejected` : '')
              : `${counts.total_requests} previous request${counts.total_requests === 1 ? '' : 's'}, none approved yet`}
            {performance.first_request_at && ` · with us since ${fmtDate(performance.first_request_at)}`}
          </p>
        </div>
        <div className="flex items-center gap-1.5 flex-wrap">
          <TenantRelationshipBadge relationship={classification} approvedPlans={counts.approved_plans} showCycle={renewing} size="sm" />
          {assessment && (
            <span className={cn('inline-flex items-center gap-1 rounded-full border text-[10px] font-bold uppercase tracking-wide px-2 py-0.5', assessment.className)} title={assessment.hint}>
              <assessment.Icon className="h-3 w-3" />
              {assessment.label}
            </span>
          )}
        </div>
      </div>

      {/* Prior requests but never approved */}
      {priorRequestsWithoutPlan && (
        <div className="rounded-lg border border-blue-500/30 bg-blue-500/5 px-2.5 py-2 text-xs text-muted-foreground">
          Treated as a <b className="text-foreground">new tenant</b>: earlier requests never reached approval, so there is no repayment history to assess.
        </div>
      )}

      {/* Business summary */}
      {renewing && (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
          <Stat label="Rent financed" value={ugx(totals.rent_financed)} />
          <Stat label="Repaid to date" value={ugx(totals.repaid)} tone="text-emerald-600" />
          <Stat
            label="Still owing (active)"
            value={ugx(totals.outstanding_active)}
            tone={totals.outstanding_active > 0 ? 'text-amber-600' : 'text-muted-foreground'}
          />
          <Stat
            label="On-track rate"
            value={performance.repayment_rate == null ? '—' : `${Number(performance.repayment_rate).toFixed(0)}%`}
            tone={
              performance.assessment === 'good' ? 'text-emerald-600'
              : performance.assessment === 'average' ? 'text-amber-600'
              : performance.assessment === 'poor' ? 'text-destructive'
              : undefined
            }
            hint={`Repaid vs. what had fallen due (${ugx(totals.expected_to_date)})`}
          />
        </div>
      )}

      {renewing && (
        <div className="flex items-center gap-x-4 gap-y-1 flex-wrap text-[11px] text-muted-foreground">
          <span className="inline-flex items-center gap-1"><Banknote className="h-3 w-3" />{counts.payments_count} payment{counts.payments_count === 1 ? '' : 's'} recorded</span>
          {performance.last_payment_at && <span className="inline-flex items-center gap-1"><Clock className="h-3 w-3" />Last paid {fmtDate(performance.last_payment_at)}</span>}
          {counts.ended_tenancies > 0 && <span className="inline-flex items-center gap-1"><Home className="h-3 w-3" />{counts.ended_tenancies} tenanc{counts.ended_tenancies === 1 ? 'y' : 'ies'} ended</span>}
        </div>
      )}

      {/* Timeline */}
      <div className="space-y-1.5">
        <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Previous rent requests</p>
        <ol className="relative border-l border-border/70 ml-1.5 space-y-1.5">
          {visiblePlans.map(p => {
            const st = statusStyle(p.status);
            const cyc = getRentCycleLabel(p.repayment_frequency, p.duration_days);
            const funded = ['funded', 'repaying', 'completed'].includes(p.status || '');
            const repaid = Number(p.amount_repaid) || 0;
            const total = Number(p.total_repayment) || 0;
            const pct = total > 0 ? Math.min(100, Math.round((repaid / total) * 100)) : 0;
            return (
              <li key={p.id} className="relative pl-4">
                <span className={cn('absolute -left-[5px] top-3 h-2.5 w-2.5 rounded-full border-2 border-background', funded ? 'bg-primary' : 'bg-muted-foreground/40')} />
                <div className="rounded-lg bg-card border px-2.5 py-2 text-xs space-y-1.5">
                  <div className="flex items-start justify-between gap-2 flex-wrap">
                    <div className="min-w-0">
                      <p className="font-semibold">{ugx(p.rent_amount)} rent</p>
                      <p className="text-[10px] text-muted-foreground">
                        Requested {fmtDate(p.created_at)}
                        {p.funded_at && ` · Funded ${fmtDate(p.funded_at)}`}
                        {p.tenancy_ended_at && ` · Ended ${fmtDate(p.tenancy_ended_at)}`}
                      </p>
                    </div>
                    <div className="flex items-center gap-1 flex-wrap justify-end">
                      <span className={cn('inline-flex items-center gap-0.5 rounded-full border text-[9px] font-bold uppercase tracking-wide px-1.5 py-0.5', RENT_CYCLE_BADGE_CLASSES[cyc.tone])}>
                        <CalendarClock className="h-2.5 w-2.5" />{cyc.full}
                      </span>
                      <span className={cn('inline-flex items-center gap-0.5 rounded-full border text-[9px] font-bold uppercase tracking-wide px-1.5 py-0.5', st.className)}>
                        <st.Icon className="h-2.5 w-2.5" />{st.label}
                      </span>
                    </div>
                  </div>

                  {funded && (
                    <div className="space-y-1">
                      <div className="h-1.5 rounded-full bg-muted overflow-hidden">
                        <div className={cn('h-full rounded-full', pct >= 100 ? 'bg-emerald-500' : 'bg-primary')} style={{ width: `${pct}%` }} />
                      </div>
                      <div className="flex items-center justify-between gap-2 text-[10px] text-muted-foreground">
                        <span><b className="text-emerald-600">{ugx(repaid)}</b> repaid of {ugx(total)} ({pct}%)</span>
                        <span>{p.payments_count} payment{p.payments_count === 1 ? '' : 's'}{p.last_payment_at ? ` · last ${fmtDate(p.last_payment_at)}` : ''}</span>
                      </div>
                    </div>
                  )}

                  {p.status === 'rejected' && p.rejected_reason && (
                    <p className="text-[10px] text-destructive/90 line-clamp-2">Reason: {p.rejected_reason}</p>
                  )}

                  <div className="flex items-center gap-x-3 gap-y-0.5 flex-wrap text-[10px] text-muted-foreground">
                    {p.landlord_name && <span className="inline-flex items-center gap-1"><Home className="h-2.5 w-2.5" />{p.landlord_name}</span>}
                    {p.agent_name && <span className="inline-flex items-center gap-1"><User className="h-2.5 w-2.5" />{p.agent_name}</span>}
                    {p.request_city && <span>{p.request_city}</span>}
                    {p.registration_type === 'outstanding_balance' && <Badge variant="outline" className="text-[9px] px-1 py-0">Outstanding balance</Badge>}
                  </div>
                </div>
              </li>
            );
          })}
        </ol>
        {plans.length > 4 && (
          <Button type="button" variant="ghost" size="sm" className="h-7 w-full text-xs" onClick={() => setExpanded(v => !v)}>
            {expanded ? <><ChevronUp className="h-3.5 w-3.5 mr-1" />Show fewer</> : <><ChevronDown className="h-3.5 w-3.5 mr-1" />Show all {plans.length} requests</>}
          </Button>
        )}
      </div>
    </div>
  );
}

function Stat({ label, value, tone, hint }: { label: string; value: string; tone?: string; hint?: string }) {
  return (
    <div className="rounded-lg bg-card border p-2 min-w-0" title={hint}>
      <p className="text-[10px] text-muted-foreground truncate">{label}</p>
      <p className={cn('text-sm font-bold truncate', tone)}>{value}</p>
    </div>
  );
}

export default TenantPaymentHistoryCard;
