import { TrendingUp, CalendarCheck } from 'lucide-react';
import { useRentAccessLimitParams } from '@/hooks/useRentAccessLimitParams';
import { formatUGX } from '@/lib/rentCalculations';

/**
 * Major marketing banner on the tenant dashboard: tenants can grow their
 * rent access up to the configured maximum (UGX 30,000,000) by paying daily.
 */
export function RentAccessGrowthBanner() {
  const { params } = useRentAccessLimitParams();
  return (
    <section
      aria-label="Rent access growth"
      className="animate-fade-in relative overflow-hidden rounded-2xl border border-primary/30 bg-gradient-to-br from-primary/15 via-primary/5 to-background p-4 shadow-sm"
    >
      <div className="flex items-start gap-3">
        <div className="shrink-0 rounded-xl bg-primary/15 p-2.5">
          <TrendingUp className="h-6 w-6 text-primary" />
        </div>
        <div className="min-w-0 space-y-1">
          <p className="text-xs font-semibold uppercase tracking-wide text-primary">Grow your rent access</p>
          <h2 className="text-lg font-bold leading-tight text-foreground">
            Access rent of up to {formatUGX(params.max_limit_ugx)}
          </h2>
          <p className="text-sm text-muted-foreground">
            The more you pay daily, the more you qualify for. Every day you pay raises your rent access limit.
          </p>
          <p className="flex items-center gap-1.5 pt-1 text-xs font-medium text-foreground">
            <CalendarCheck className="h-3.5 w-3.5 text-primary" />
            +{formatUGX(params.paid_increment_ugx)} added for each day you pay
          </p>
        </div>
      </div>
    </section>
  );
}
