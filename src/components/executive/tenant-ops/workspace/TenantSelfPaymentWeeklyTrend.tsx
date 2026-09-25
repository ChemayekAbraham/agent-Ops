/**
 * "Tenant Self-Payments via Merchant" — week-on-week trend section.
 *
 * Presentation only. Every figure comes from useTenantOpsWeeklyPerformance
 * (self_payment_tenants / self_payment_increase_pct), which is itself a read
 * over the frozen tenant_ops_weekly_metrics ledger — no new calculation here.
 * The detailed attempt-by-attempt list already exists at
 * TenantSelfRepaymentsPanel.tsx; this section is the trend headline that
 * sits alongside it, not a replacement for it.
 */
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { ArrowDown, ArrowUp, Minus, Users } from 'lucide-react';
import { useTenantOpsWeeklyPerformance } from '@/hooks/useTenantOpsWeeklyPerformance';

export function TenantSelfPaymentWeeklyTrend() {
  const { data, isLoading } = useTenantOpsWeeklyPerformance();

  if (isLoading || !data) {
    return <Skeleton className="h-28 w-full" />;
  }

  const { current, previous, delta } = data;
  const rate = delta.self_payment_increase_pct;
  const trendTone =
    delta.self_payment_tenants > 0 ? 'text-emerald-600' : delta.self_payment_tenants < 0 ? 'text-destructive' : 'text-muted-foreground';
  const TrendIcon = delta.self_payment_tenants > 0 ? ArrowUp : delta.self_payment_tenants < 0 ? ArrowDown : Minus;

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-sm font-semibold">
          <Users className="h-4 w-4 text-primary" />
          Tenant Self-Payments via Merchant
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div className="flex flex-wrap items-end gap-4">
          <div>
            <p className="text-[11px] text-muted-foreground">This week</p>
            <p className="text-2xl font-bold tabular-nums">{current.self_payment_tenants}</p>
            <p className="text-[11px] text-muted-foreground">tenants paid themselves via a merchant</p>
          </div>
          <div className={`flex items-center gap-1 text-sm font-semibold ${trendTone}`}>
            <TrendIcon className="h-3.5 w-3.5" />
            {delta.self_payment_tenants > 0 ? '+' : ''}
            {delta.self_payment_tenants}
            {rate !== null && (
              <span className="text-xs font-medium">
                ({rate > 0 ? '+' : ''}
                {rate}%)
              </span>
            )}
            <span className="text-xs font-normal text-muted-foreground">vs last week ({previous.self_payment_tenants})</span>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
