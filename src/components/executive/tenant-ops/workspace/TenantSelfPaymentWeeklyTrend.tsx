/**
 * "Tenant Self-Payments via Merchant" — week-on-week trend section.
 *
 * Presentation only. Every figure comes from useTenantOpsWeeklyPerformance
 * (self_payment_tenants / self_payment_increase_pct), which is itself a read
 * over the frozen tenant_ops_weekly_metrics ledger — no new calculation here.
 * The detailed attempt-by-attempt list already exists at
 * TenantSelfRepaymentsPanel.tsx; this section is the trend headline that
 * sits alongside it, not a replacement for it.
 *
 * Styled like the rest of Tenant Ops -> Classic's small metric cards
 * (TenantOpsHome.tsx's "Collected" hero tile): Card + semantic color tokens,
 * a rounded pill for the week-on-week change.
 */
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Users } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useTenantOpsWeeklyPerformance } from '@/hooks/useTenantOpsWeeklyPerformance';

export function TenantSelfPaymentWeeklyTrend() {
  const { data, isLoading } = useTenantOpsWeeklyPerformance();

  if (isLoading || !data) {
    return <Skeleton className="h-28 w-full" />;
  }

  const { current, previous, delta } = data;
  const rate = delta.self_payment_increase_pct;
  const rose = delta.self_payment_tenants > 0;
  const fell = delta.self_payment_tenants < 0;

  return (
    <Card className="border-primary/20 bg-gradient-to-br from-primary/[0.06] via-card to-card shadow-sm">
      <CardHeader className="px-3 pb-2 sm:px-4">
        <CardTitle className="flex items-center gap-2 text-sm font-semibold">
          <Users className="h-4 w-4 text-primary" />
          Tenant Self-Payments via Merchant
        </CardTitle>
      </CardHeader>
      <CardContent className="px-3 pb-3 sm:px-4">
        <div className="flex flex-wrap items-end gap-3">
          <div>
            <p className="text-2xl font-bold leading-none tabular-nums">{current.self_payment_tenants}</p>
            <p className="mt-1 text-[11px] text-muted-foreground">tenants paid themselves via a merchant this week</p>
          </div>
          <span
            className={cn(
              'rounded-full px-2.5 py-1 text-[11px] font-semibold',
              rose ? 'bg-success/10 text-success' : fell ? 'bg-destructive/10 text-destructive' : 'bg-muted text-muted-foreground',
            )}
          >
            {delta.self_payment_tenants > 0 ? '+' : ''}
            {delta.self_payment_tenants}
            {rate !== null ? ` (${rate > 0 ? '+' : ''}${rate}%)` : ''} vs last week ({previous.self_payment_tenants})
          </span>
        </div>
      </CardContent>
    </Card>
  );
}
