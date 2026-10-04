import { useMemo, useState } from 'react';
import { format, parseISO } from 'date-fns';
import ExecutiveDashboardLayout from '@/components/layout/ExecutiveDashboardLayout';
import COOReportPage from '@/components/coo/COOReportPage';
import { useSystemOverviewData } from '@/components/coo/useCOOReportData';
import { usePersistedActiveTab } from '@/hooks/usePersistedActiveTab';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Activity, Users, UserCheck, Banknote, CalendarClock, TrendingUp, Target, Gauge,
} from 'lucide-react';

const ugx = (n: number) => `UGX ${new Intl.NumberFormat('en-UG').format(Math.round(n || 0))}`;

const DEFAULT_DAILY_TARGET = 12_000_000;

/**
 * COO → Reports → System Overview
 *
 * ALL-TIME view (deliberately unwindowed) backed by `get_coo_system_overview`.
 * The active-tenant figure reuses the unified active-book status list shared
 * with the Tenants Report and the Agent Daily Performance report — it is not
 * redefined here. The other four report pages keep their 30-day windows.
 */
export default function SystemOverviewReportPage() {
  const [, setActiveTab] = usePersistedActiveTab('coo');
  const { data, isLoading, refetch } = useSystemOverviewData();
  const [targetInput, setTargetInput] = useState<string>(String(DEFAULT_DAILY_TARGET));

  const s = data ?? {
    total_tenants_ever: 0,
    active_tenants_now: 0,
    total_paid_to_landlords: 0,
    first_operation_date: null as string | null,
    days_in_operation: 0,
    avg_daily_paid: 0,
  };

  const dailyTarget = Math.max(0, Number(targetInput.replace(/[^0-9.]/g, '')) || 0);
  const days = Math.max(s.days_in_operation, 1);

  const { expectedTotal, variancePct, varianceSeverity } = useMemo(() => {
    const expected = dailyTarget * days;
    if (expected <= 0) return { expectedTotal: 0, variancePct: 0, varianceSeverity: 'neutral' as const };
    const pct = ((s.total_paid_to_landlords - expected) / expected) * 100;
    const abs = Math.abs(pct);
    const severity = abs <= 10 ? ('success' as const) : abs <= 25 ? ('warning' as const) : ('destructive' as const);
    return { expectedTotal: expected, variancePct: pct, varianceSeverity: severity };
  }, [dailyTarget, days, s.total_paid_to_landlords]);

  const activeRatio = s.total_tenants_ever > 0
    ? `${Math.round((s.active_tenants_now / s.total_tenants_ever) * 100)}% of ${s.total_tenants_ever} all-time`
    : 'No tenants yet';

  const liveSince = s.first_operation_date
    ? format(parseISO(s.first_operation_date), 'd MMM yyyy')
    : '—';

  return (
    <ExecutiveDashboardLayout role="coo" activeTab="reports-system-overview" onTabChange={setActiveTab}>
      <div className="mb-3 rounded-lg border bg-card p-3 sm:p-4">
        <Label htmlFor="daily-target" className="text-xs text-muted-foreground">
          Expected daily payout target (UGX)
        </Label>
        <div className="mt-1.5 flex flex-col gap-2 sm:flex-row sm:items-center sm:gap-4">
          <Input
            id="daily-target"
            type="number"
            min={0}
            step={100000}
            inputMode="numeric"
            value={targetInput}
            onChange={(e) => setTargetInput(e.target.value)}
            className="h-10 sm:max-w-[220px]"
          />
          <p className="text-xs text-muted-foreground">
            Expected total over {s.days_in_operation} day{s.days_in_operation === 1 ? '' : 's'}:{' '}
            <span className="font-semibold text-foreground">{ugx(expectedTotal)}</span>
            {' · '}Actual: <span className="font-semibold text-foreground">{ugx(s.total_paid_to_landlords)}</span>
          </p>
        </div>
      </div>

      <COOReportPage
        title="System Overview Report"
        description="All-time platform position — every tenant ever onboarded, the live active book, and total capital routed to landlords since day one."
        icon={Activity}
        loading={isLoading}
        onGenerate={async () => { await refetch(); }}
        statusOptions={[]}
        activityTypeOptions={[]}
        departmentOptions={['Operations']}
        kpis={[
          { label: 'Total tenants (all-time)', value: String(s.total_tenants_ever), sub: 'Distinct tenants on Rent Plans', icon: Users, severity: 'info' },
          { label: 'Active tenants (now)', value: String(s.active_tenants_now), sub: activeRatio, icon: UserCheck, severity: 'success' },
          { label: 'Paid to landlords (all-time)', value: ugx(s.total_paid_to_landlords), sub: 'Completed + awaiting receipt', icon: Banknote, severity: 'success' },
          { label: 'System live since', value: liveSince, sub: `${s.days_in_operation} day${s.days_in_operation === 1 ? '' : 's'} in operation`, icon: CalendarClock, severity: 'neutral' },
          { label: 'Actual avg daily payout', value: ugx(s.avg_daily_paid), sub: 'All-time paid ÷ days live', icon: TrendingUp, severity: 'info' },
          { label: 'Expected daily target', value: ugx(dailyTarget), sub: `Expected total ${ugx(expectedTotal)}`, icon: Target, severity: 'neutral' },
          {
            label: 'Variance vs target',
            value: expectedTotal > 0 ? `${variancePct >= 0 ? '+' : ''}${variancePct.toFixed(1)}%` : '—',
            sub: expectedTotal > 0 ? `${ugx(s.total_paid_to_landlords - expectedTotal)} vs expected` : 'Set a target above',
            icon: Gauge,
            severity: varianceSeverity,
          },
        ]}
        charts={[
          {
            kind: 'bar',
            title: 'All-time paid to landlords vs expected at target (UGX)',
            seriesKeys: ['value'],
            data: [
              { label: 'Actual paid', value: Math.round(s.total_paid_to_landlords) },
              { label: 'Expected at target', value: Math.round(expectedTotal) },
            ],
          },
          {
            kind: 'bar',
            title: 'Tenant book (all-time vs active now)',
            seriesKeys: ['value'],
            data: [
              { label: 'All-time tenants', value: s.total_tenants_ever },
              { label: 'Active now', value: s.active_tenants_now },
            ],
          },
        ]}
        activities={[]}
        insights={[
          { kind: 'trend', title: `${s.active_tenants_now} tenants on the active book`, body: `Out of ${s.total_tenants_ever} tenants ever onboarded — the same active-book definition used by the Tenants Report and Agent Daily Performance report.` },
          { kind: 'trend', title: `${ugx(s.total_paid_to_landlords)} routed to landlords`, body: `Since ${liveSince}, averaging ${ugx(s.avg_daily_paid)} per day across ${s.days_in_operation} days.` },
          {
            kind: varianceSeverity === 'success' ? 'trend' : 'priority',
            title: expectedTotal > 0 ? `Running ${variancePct >= 0 ? 'ahead' : 'behind'} target by ${Math.abs(variancePct).toFixed(1)}%` : 'No target set',
            body: expectedTotal > 0
              ? `At ${ugx(dailyTarget)}/day the platform should have disbursed ${ugx(expectedTotal)}; actual is ${ugx(s.total_paid_to_landlords)}.`
              : 'Enter an expected daily payout target to compute variance.',
          },
          { kind: 'action', title: 'All-time view', body: 'This page is deliberately unwindowed. The Partner, Agent, Tenant and Financial Ops reports remain on their 30-day windows.' },
        ]}
      />
    </ExecutiveDashboardLayout>
  );
}