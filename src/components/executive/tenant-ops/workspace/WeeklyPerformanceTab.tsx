/**
 * "Weekly Performance" tab — Tenant Ops Weekly Performance dashboard.
 *
 * Presentation only. Every figure comes from useTenantOpsWeeklyPerformance /
 * useTenantOpsWeeklyHistory (Prompt 1's weekly snapshot ledger) and
 * TenantSelfPaymentWeeklyTrend (Prompt 3). No client-side arithmetic beyond
 * formatting and delta-sign coloring.
 */
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Skeleton } from '@/components/ui/skeleton';
import { ArrowDown, ArrowUp, CalendarClock, ClipboardList, History, Minus } from 'lucide-react';
import { DrawerSection } from '@/components/ops/calling/CallDrawerUi';
import { WorkspaceEmptyState } from '@/components/executive/tenant-ops/workspace/WorkspaceEmptyState';
import { WorkspaceMobileRow } from '@/components/executive/tenant-ops/workspace/WorkspaceMobileRow';
import { TenantSelfPaymentWeeklyTrend } from '@/components/executive/tenant-ops/workspace/TenantSelfPaymentWeeklyTrend';
import {
  useTenantOpsWeeklyHistory,
  useTenantOpsWeeklyPerformance,
} from '@/hooks/useTenantOpsWeeklyPerformance';

const dayLabel = (iso: string) => {
  const [y, m, d] = iso.slice(0, 10).split('-').map(Number);
  return new Date(y, (m || 1) - 1, d || 1).toLocaleDateString('en-GB', { day: '2-digit', month: 'short' });
};

function DeltaLine({ value, suffix = '', invert = false }: { value: number; suffix?: string; invert?: boolean }) {
  const good = invert ? value < 0 : value > 0;
  const bad = invert ? value > 0 : value < 0;
  const tone = value === 0 ? 'text-muted-foreground' : good ? 'text-emerald-600' : bad ? 'text-destructive' : 'text-muted-foreground';
  const Icon = value > 0 ? ArrowUp : value < 0 ? ArrowDown : Minus;
  return (
    <p className={`mt-0.5 flex items-center gap-1 text-[11px] font-semibold ${tone}`}>
      <Icon className="h-3 w-3" />
      {value > 0 ? '+' : ''}
      {value}
      {suffix} vs last week
    </p>
  );
}

function SummaryStat({ label, value, delta, invert }: { label: string; value: string; delta: number; invert?: boolean }) {
  return (
    <div className="min-w-0 rounded-xl border border-border/60 bg-muted/40 p-2.5">
      <p className="break-words text-[10px] font-medium uppercase tracking-wide leading-tight text-muted-foreground">
        {label}
      </p>
      <p className="mt-1 text-sm font-bold leading-tight tabular-nums sm:text-base">{value}</p>
      <DeltaLine value={delta} invert={invert} />
    </div>
  );
}

export function WeeklyPerformanceTab() {
  const { data, isLoading } = useTenantOpsWeeklyPerformance();
  const { data: history, isLoading: historyLoading } = useTenantOpsWeeklyHistory(12);

  if (isLoading || !data) {
    return (
      <div className="space-y-3">
        <Skeleton className="h-32 w-full" />
        <Skeleton className="h-48 w-full" />
      </div>
    );
  }

  const { current, delta, week_start, week_end, is_current_week_open } = data;

  return (
    <div className="space-y-5">
      <p className="text-sm text-muted-foreground">
        The reporting week runs Wednesday to Tuesday. Showing{' '}
        <span className="font-semibold text-foreground">
          {dayLabel(week_start)} – {dayLabel(week_end)}
        </span>
        {is_current_week_open ? ' (in progress)' : ' (closed)'}, compared with the week before.
      </p>

      <DrawerSection title="Management Summary" icon={ClipboardList}>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5">
          <SummaryStat label="Active Tenants" value={String(current.total_active_tenants)} delta={delta.total_active_tenants} />
          <SummaryStat label="Paying Tenants" value={String(current.paying_tenants)} delta={delta.paying_tenants} />
          <SummaryStat label="Payment Rate" value={`${current.payment_rate_pct}%`} delta={delta.payment_rate_pct} />
          <SummaryStat label="New Tenants" value={String(current.new_tenants_added)} delta={delta.new_tenants_added} />
          <SummaryStat
            label="20+ Days No Payment"
            value={String(current.dormant_20_plus_count)}
            delta={delta.dormant_20_plus_count}
            invert
          />
        </div>
      </DrawerSection>

      <TenantSelfPaymentWeeklyTrend />

      <DrawerSection title="Historical Weekly Records" icon={History}>
        {historyLoading ? (
          <Skeleton className="h-40 w-full" />
        ) : !history || history.length === 0 ? (
          <WorkspaceEmptyState
            icon={CalendarClock}
            title="No closed weeks recorded yet"
            hint="A week's figures are frozen once it closes on Tuesday night — check back after the first full reporting week."
          />
        ) : (
          <>
            <div className="space-y-2 lg:hidden">
              {history.map((w) => (
                <WorkspaceMobileRow
                  key={w.week_start}
                  title={`${dayLabel(w.week_start)} – ${dayLabel(w.week_end)}`}
                  fields={[
                    { label: 'Active', value: w.total_active_tenants },
                    { label: 'Paying', value: w.paying_tenants },
                    { label: 'Rate', value: `${w.payment_rate_pct}%` },
                    { label: 'New', value: w.new_tenants_added },
                    { label: '20+ days', value: w.dormant_20_plus_count },
                    { label: 'Self-paid', value: w.self_payment_tenants },
                  ]}
                />
              ))}
            </div>

            <div className="hidden overflow-auto rounded-lg border lg:block">
              <Table>
                <TableHeader className="bg-muted/50">
                  <TableRow>
                    <TableHead className="text-xs">Week</TableHead>
                    <TableHead className="text-xs">Active Tenants</TableHead>
                    <TableHead className="text-xs">Paying Tenants</TableHead>
                    <TableHead className="text-xs">Payment Rate</TableHead>
                    <TableHead className="text-xs">New Tenants</TableHead>
                    <TableHead className="text-xs">20+ Days No Payment</TableHead>
                    <TableHead className="text-xs">Self-Paid via Merchant</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {history.map((w) => (
                    <TableRow key={w.week_start}>
                      <TableCell className="whitespace-nowrap text-xs font-medium">
                        {dayLabel(w.week_start)} – {dayLabel(w.week_end)}
                      </TableCell>
                      <TableCell className="text-xs">{w.total_active_tenants}</TableCell>
                      <TableCell className="text-xs">{w.paying_tenants}</TableCell>
                      <TableCell className="text-xs">{w.payment_rate_pct}%</TableCell>
                      <TableCell className="text-xs">{w.new_tenants_added}</TableCell>
                      <TableCell className="text-xs">{w.dormant_20_plus_count}</TableCell>
                      <TableCell className="text-xs">{w.self_payment_tenants}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </>
        )}
      </DrawerSection>
    </div>
  );
}

export default WeeklyPerformanceTab;
