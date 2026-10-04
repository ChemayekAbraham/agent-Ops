import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { formatUGX } from '@/lib/rentCalculations';
import { Loader2, Building2, ArrowRight, HelpCircle } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useAgentCompanyExposure } from '@/hooks/useAgentCompanyExposure';

interface Props {
  onViewBreakdown?: () => void;
}

/**
 * "Owed to Welile" — what the company has paid out for this agent's tenants
 * and is still waiting to recover. Read-only summary, no writes.
 */
export function AgentCompanyDebtCard({ onViewBreakdown }: Props) {
  const x = useAgentCompanyExposure();

  if (x.isLoading) {
    return (
      <Card>
        <CardContent className="flex justify-center py-6">
          <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
        </CardContent>
      </Card>
    );
  }

  // Hide if there's nothing to show — agent has no tenants, no debt, no advance.
  if (
    x.tenantCount === 0 &&
    x.totalOwed === 0 &&
    x.lifetimeDisbursed === 0
  ) {
    return null;
  }

  const hasDebt = x.totalOwed > 0;

  return (
    <Card className={cn(hasDebt && 'border-destructive/40')}>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm flex items-center gap-2">
          <Building2 className="h-4 w-4 text-primary" /> My Tenants — Money Summary
          <TooltipProvider delayDuration={200}>
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  className="ml-auto text-muted-foreground hover:text-foreground"
                  aria-label="What is this?"
                >
                  <HelpCircle className="h-3.5 w-3.5" />
                </button>
              </TooltipTrigger>
              <TooltipContent side="top" className="max-w-[260px] text-xs">
                Left: total cash Welile disbursed to landlords for your tenants.
                Middle: total your tenants have repaid so far (rent + fees).
                Right: what's still outstanding on active cycles.
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
          <Stat
            label="Welile paid out"
            sub="for my tenants"
            value={x.lifetimeDisbursed}
          />
          <Stat
            label="Collected so far"
            sub="rent + fees"
            value={x.lifetimeRepaid}
            tone="positive"
          />
          <Stat
            label="Outstanding"
            sub={x.activeCycleCount ? `${x.activeCycleCount} active` : 'all settled'}
            value={x.outstandingCycles}
            tone={x.outstandingCycles > 0 ? 'danger' : 'muted'}
          />
        </div>

        {(x.subscriptionDebt > 0 || x.advanceBalance > 0) && (
          <div className="mt-3 pt-3 border-t border-dashed space-y-1.5 text-xs">
            {x.subscriptionDebt > 0 && (
              <Row label="Subscription debt (guarantor)" value={x.subscriptionDebt} danger />
            )}
            {x.advanceBalance > 0 && (
              <Row label="Personal advance (wallet)" value={x.advanceBalance} danger />
            )}
          </div>
        )}

        {onViewBreakdown && x.tenantCount > 0 && (
          <Button
            variant="outline"
            size="sm"
            onClick={onViewBreakdown}
            className="w-full mt-3 h-9 text-xs"
          >
            View tenant breakdown
            <ArrowRight className="h-3.5 w-3.5 ml-1" />
          </Button>
        )}
      </CardContent>
    </Card>
  );
}

function Stat({
  label,
  sub,
  value,
  tone = 'default',
}: {
  label: string;
  sub?: string;
  value: number;
  tone?: 'default' | 'positive' | 'danger' | 'muted';
}) {
  return (
    <div className="rounded-md border bg-muted/30 p-2.5 flex flex-col gap-0.5 min-w-0">
      <span className="text-[10px] uppercase tracking-wide text-muted-foreground leading-tight">
        {label}
      </span>
      <span
        className={cn(
          'font-bold text-sm sm:text-base tabular-nums truncate',
          tone === 'positive' && 'text-emerald-600',
          tone === 'danger' && 'text-destructive',
          tone === 'muted' && 'text-muted-foreground',
        )}
      >
        {formatUGX(value)}
      </span>
      {sub && (
        <span className="text-[10px] text-muted-foreground leading-tight">{sub}</span>
      )}
    </div>
  );
}

function Row({
  label,
  value,
  danger,
  positive,
}: {
  label: string;
  value: number;
  danger?: boolean;
  positive?: boolean;
}) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="text-muted-foreground">{label}</span>
      <span
        className={cn(
          'font-semibold tabular-nums',
          danger && 'text-destructive',
          positive && 'text-emerald-600',
        )}
      >
        {formatUGX(value)}
      </span>
    </div>
  );
}
