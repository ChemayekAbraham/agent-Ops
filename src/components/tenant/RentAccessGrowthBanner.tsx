import { TrendingUp, CalendarCheck } from 'lucide-react';
import { useRentAccessLimitParams } from '@/hooks/useRentAccessLimitParams';
import { formatUGX } from '@/lib/rentCalculations';
import { useRentAccessPromoTracking } from '@/hooks/useRentAccessPromoTracking';
import { Button } from '@/components/ui/button';
import { Share2 } from 'lucide-react';
import { buildTenantAccessLimitWhatsAppUrl } from '@/lib/accessLimitMessaging';
import { useTenantRentAccessProgress } from '@/hooks/useTenantRentAccessProgress';
import { Progress } from '@/components/ui/progress';

/**
 * Major marketing banner on the tenant dashboard: tenants can grow their
 * rent access up to the configured maximum (UGX 30,000,000) by paying daily.
 */
export function RentAccessGrowthBanner({ onPayToday, userId }: { onPayToday?: () => void; userId?: string }) {
  const { params } = useRentAccessLimitParams();
  const progress = useTenantRentAccessProgress(userId);
  const { trackClick } = useRentAccessPromoTracking('tenant_dashboard');
  return (
    <section
      aria-label="Rent access growth"
      onClick={trackClick}
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
          <p className="text-sm text-destructive">Missed days reduce your limit by {formatUGX(params.missed_decrement_ugx)}/day.</p>
          {progress.data ? <div className="space-y-2 pt-2"><p className="text-sm font-medium">Your limit: {formatUGX(progress.data.limit)} of {formatUGX(progress.data.maxLimit)}</p><Progress value={progress.data.percent} variant="success" aria-label="Rent Access Limit progress" /></div> : <p role="status" className="text-sm text-muted-foreground">{progress.isFetching ? 'Loading your current limit…' : 'Current limit unavailable'}</p>}
          <div className="flex flex-wrap gap-2 pt-2">
            <Button className="min-h-11 whitespace-normal" onClick={onPayToday ?? (() => window.dispatchEvent(new Event('open-deposit')))}>Pay Today &amp; Grow Limit</Button>
            <Button asChild variant="outline" className="min-h-11"><a href={buildTenantAccessLimitWhatsAppUrl()} target="_blank" rel="noopener noreferrer"><Share2 className="h-4 w-4" /> Share on WhatsApp</a></Button>
          </div>
        </div>
      </div>
    </section>
  );
}
