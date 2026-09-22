/**
 * Read-only tenant snapshot for the Call Centre reveal panel.
 *
 * Deliberately reuses the SAME sources and the SAME arithmetic as the Tenant Ops
 * → Missed Days tool (`MissedDaysTracker`): the authoritative
 * `v_tenant_daily_eligibility` view, `profiles` for names/phones and `wallets`
 * for balances. No new business rules are introduced here — if Missed Days shows
 * it, this shows the same number.
 */
import { useQuery } from '@tanstack/react-query';
import { differenceInDays, parseISO } from 'date-fns';
import { supabase } from '@/integrations/supabase/client';
import type { CcSubjectType } from '@/hooks/useCcCallingHub';
import { describePlanSchedule, isWeeklyPlan } from '@/lib/agentMonitoringSchedule';

/** Same repayment clock anchor fallback chain used by Missed Days. */
const startAnchor = (r: { disbursed_at?: string | null; funded_at?: string | null; created_at?: string | null }) =>
  r.disbursed_at || r.funded_at || r.created_at || null;

const DAY_MS = 86_400_000;

const isoDay = (d: Date) => {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};

const fromIsoDay = (iso: string) => {
  const [y, m, d] = iso.slice(0, 10).split('-').map(Number);
  return new Date(y, (m || 1) - 1, d || 1);
};

export interface CcSubjectSnapshot {
  tenant_id: string;
  rent_request_id: string;
  tenant_name: string;
  tenant_phone: string;
  agent_id: string;
  agent_name: string;
  agent_phone: string;
  daily_repayment: number;
  rent_amount: number;
  amount_repaid: number;
  total_repayment: number;
  outstanding_balance: number;
  expected_repaid: number;
  missed_days: number;
  missed_amount: number;
  days_since_disbursed: number;
  repayment_pct: number;
  tenant_wallet: number;
  agent_wallet: number;
  status: string | null;
  started_at: string | null;
  /** True when this plan repays weekly rather than daily. */
  is_weekly: boolean;
  /** UGX due per scheduled payment (weekly = daily figure x 7). */
  period_amount: number;
  /** Date (yyyy-MM-dd) of the earliest scheduled payment not yet fully paid. */
  current_due_date: string | null;
  /** UGX already paid towards that scheduled payment. */
  current_due_paid: number;
  /** That scheduled payment has been settled in full. */
  current_due_settled: boolean;
  /** Whole days since that payment's due date; 0 when nothing is overdue. */
  days_overdue: number;
  /** Whole scheduled payments left unpaid. */
  periods_overdue: number;
  /** Next scheduled payment date for weekly plans (yyyy-MM-dd). */
  next_due_date: string | null;
}


export function useCcSubjectSnapshot(subjectType: CcSubjectType, subjectId: string | null) {
  const enabled = subjectType === 'tenant' && !!subjectId;

  return useQuery({
    queryKey: ['cc-subject-snapshot', subjectType, subjectId],
    enabled,
    staleTime: 60_000,
    queryFn: async (): Promise<CcSubjectSnapshot | null> => {
      const { data: plans, error } = await supabase
        .from('v_tenant_daily_eligibility')
        .select(
          'rent_request_id, tenant_id, agent_id, daily_repayment, rent_amount, amount_repaid, total_repayment, start_at, status',
        )
        .eq('tenant_id', subjectId as string);
      if (error) throw error;
      if (!plans?.length) return null;

      // Same tie-break as Missed Days: the plan carrying the largest balance.
      const rows = plans.map((r: Record<string, unknown>) => {
        const total = Number(r.total_repayment || 0);
        const repaid = Number(r.amount_repaid || 0);
        return { raw: r, outstanding: total - repaid };
      });
      rows.sort((a, b) => b.outstanding - a.outstanding);
      const r = rows[0].raw as Record<string, unknown>;

      const tenantId = String(r.tenant_id);
      const agentId = r.agent_id ? String(r.agent_id) : '';
      const ids = [tenantId, agentId].filter(Boolean);
      const planId = String(r.rent_request_id);

      const [{ data: profiles }, { data: wallets }, { data: planRow }] = await Promise.all([
        supabase.from('profiles').select('id, full_name, phone').in('id', ids),
        supabase.from('wallets').select('user_id, balance').in('user_id', ids),
        supabase
          .from('rent_requests')
          .select('id, repayment_frequency, repayment_starts_on, created_at')
          .eq('id', planId)
          .maybeSingle(),
      ]);

      const profileOf = (id: string) => (profiles || []).find((p) => p.id === id);
      const walletOf = (id: string) => Number((wallets || []).find((w) => w.user_id === id)?.balance || 0);

      const dailyRepayment = Number(r.daily_repayment || 0);
      const totalRepayment = Number(r.total_repayment || 0);
      const amountRepaid = Number(r.amount_repaid || 0);
      const anchor = startAnchor({ disbursed_at: (r.start_at as string) ?? null });
      const today = new Date();
      const startedAt = anchor ? parseISO(anchor) : today;
      const daysSinceDisbursed = Math.max(1, differenceInDays(today, startedAt));
      const expectedRepaid = Math.min(dailyRepayment * daysSinceDisbursed, totalRepayment);
      const missedDays =
        dailyRepayment > 0 ? Math.max(0, Math.round((expectedRepaid - amountRepaid) / dailyRepayment)) : 0;

      /*
       * Weekly plans are billed one instalment per week, so their overdue
       * position must be read off the weekly due date — never off the whole plan
       * balance. `describePlanSchedule` is the same schedule law Agent
       * Monitoring already uses (mem://business-model/weekly-plans-daily-eligibility):
       * instalment 1 falls on `repayment_starts_on`, then every 7 days, and a
       * weekly obligation is the stored per-period figure.
       */
      const weekly = isWeeklyPlan({ repayment_frequency: (planRow?.repayment_frequency as string) ?? null });
      const scheduleStartIso =
        (planRow?.repayment_starts_on as string | null) ||
        (anchor ? isoDay(startedAt) : isoDay(today));
      const schedule = describePlanSchedule(
        {
          daily_repayment: dailyRepayment,
          total_repayment: totalRepayment,
          amount_repaid: amountRepaid,
          repayment_frequency: (planRow?.repayment_frequency as string) ?? null,
          repayment_starts_on: scheduleStartIso,
          created_at: (planRow?.created_at as string) || scheduleStartIso,
        },
        today,
      );

      const periodAmount = schedule.periodAmount;
      const periodDays = weekly ? 7 : 1;
      // The earliest scheduled payment not yet settled in full.
      const settledPeriods = periodAmount > 0 ? Math.floor(amountRepaid / periodAmount) : 0;
      const totalPeriods = periodAmount > 0 ? Math.ceil(totalRepayment / periodAmount) : 0;
      const scheduleStart = fromIsoDay(scheduleStartIso);
      const dueIndex = totalPeriods > 0 ? Math.min(settledPeriods, Math.max(0, totalPeriods - 1)) : 0;
      const currentDue =
        periodAmount > 0 && schedule.outstandingPlan > 0
          ? new Date(scheduleStart.getTime() + dueIndex * periodDays * DAY_MS)
          : null;
      const currentDuePaid = periodAmount > 0 ? Math.max(0, amountRepaid - settledPeriods * periodAmount) : 0;
      const currentDueSettled = schedule.outstandingPlan <= 0;
      const todayStart = fromIsoDay(isoDay(today));
      const daysOverdue =
        currentDue && !currentDueSettled && currentDue.getTime() <= todayStart.getTime()
          ? Math.max(0, Math.round((todayStart.getTime() - currentDue.getTime()) / DAY_MS))
          : 0;
      const periodsOverdue =
        periodAmount > 0 && schedule.arrears > 0 ? Math.ceil(schedule.arrears / periodAmount) : 0;

      return {
        tenant_id: tenantId,
        rent_request_id: planId,
        tenant_name: profileOf(tenantId)?.full_name || 'Unknown',
        tenant_phone: profileOf(tenantId)?.phone || '',
        agent_id: agentId,
        agent_name: (agentId && profileOf(agentId)?.full_name) || '—',
        agent_phone: (agentId && profileOf(agentId)?.phone) || '',
        daily_repayment: dailyRepayment,
        rent_amount: Number(r.rent_amount || 0),
        amount_repaid: amountRepaid,
        total_repayment: totalRepayment,
        outstanding_balance: totalRepayment - amountRepaid,
        expected_repaid: weekly ? schedule.scheduledToDate : expectedRepaid,
        missed_days: weekly ? daysOverdue : missedDays,
        missed_amount: weekly ? schedule.arrears : dailyRepayment * missedDays,
        days_since_disbursed: daysSinceDisbursed,
        repayment_pct: totalRepayment > 0 ? Math.round((amountRepaid / totalRepayment) * 100) : 0,
        tenant_wallet: walletOf(tenantId),
        agent_wallet: agentId ? walletOf(agentId) : 0,
        status: (r.status as string) ?? null,
        started_at: anchor,
        is_weekly: weekly,
        period_amount: periodAmount,
        current_due_date: currentDue ? isoDay(currentDue) : null,
        current_due_paid: currentDuePaid,
        current_due_settled: currentDueSettled,
        days_overdue: daysOverdue,
        periods_overdue: periodsOverdue,
        next_due_date: schedule.nextDueDate,
      };
    },

  });
}
