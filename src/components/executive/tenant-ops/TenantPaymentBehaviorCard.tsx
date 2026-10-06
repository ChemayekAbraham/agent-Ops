import { ArrowRight, HandCoins, TrendingDown, TrendingUp } from 'lucide-react';
import { cn } from '@/lib/utils';
import { formatUGX } from '@/lib/rentCalculations';
import { usePaymentBehaviorSummary } from '@/hooks/tenantOpsWorkspace/usePaymentBehavior';

/**
 * Tenant Ops Home -> Executive summary card: how many paying tenants paid themselves rather than
 * through an agent, for the range Home is showing. Read-only; every figure comes from
 * tops_payment_behaviour_summary and the card opens the Payment Behavior tab of the Tenant
 * Operations Workspace on the same range.
 */
export function TenantPaymentBehaviorCard({
  startIso, endIso, phrase, onOpen,
}: { startIso: string; endIso: string; phrase: string; onOpen: () => void }) {
  const { data, isLoading, isError } = usePaymentBehaviorSummary({ startIso, endIso });
  const t = data?.tenants;
  const p = data?.payments;
  const change = t?.self_payers_pct_change_pp ?? null;
  const pctText = (n: number | null | undefined) => (n === null || n === undefined ? '—' : `${n.toFixed(1)}%`);

  return (
    <button
      type="button"
      onClick={onOpen}
      aria-label="Open Tenant Payment Behavior"
      className="group col-span-2 flex flex-col rounded-2xl border border-primary/30 bg-gradient-to-br from-primary/10 via-card to-card p-3.5 text-left shadow-sm transition-all hover:border-primary/50 hover:shadow-md active:scale-[0.99] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60 sm:col-span-3 sm:flex-row sm:items-center sm:gap-4 sm:p-4 xl:col-span-4"
    >
      <div className="flex min-w-0 flex-1 items-center gap-2.5">
        <div className="shrink-0 rounded-xl bg-primary/10 p-2 text-primary"><HandCoins className="h-4 w-4" /></div>
        <div className="min-w-0">
          <p className="text-[10px] font-semibold uppercase leading-tight tracking-wider text-muted-foreground">Tenant payment behavior</p>
          <div className="mt-1 flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
            <p className="text-xl font-bold leading-none tabular-nums" data-testid="pb-card-pct">{isLoading ? '—' : isError ? '—' : pctText(t?.self_payers_pct)}</p>
            <p className="text-[11px] leading-snug text-muted-foreground">of paying tenants paid themselves {phrase}</p>
            {change !== null && (
              <span className={cn('inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-semibold',
                change > 0 ? 'bg-success/10 text-success' : change < 0 ? 'bg-destructive/10 text-destructive' : 'bg-muted text-muted-foreground')}>
                {change >= 0 ? <TrendingUp className="h-3 w-3" /> : <TrendingDown className="h-3 w-3" />}
                {change > 0 ? '+' : ''}{change.toFixed(1)} pts vs before
              </span>
            )}
          </div>
        </div>
      </div>
      <p className="mt-2 shrink-0 text-[11px] leading-snug text-muted-foreground sm:mt-0 sm:max-w-[45%] sm:text-right">
        {isLoading || !t || !p
          ? 'Loading…'
          : `${t.self_payers.toLocaleString('en-US')} of ${t.paying.toLocaleString('en-US')} tenants · ${formatUGX(p.self.ugx)} self-paid (${pctText(p.self_share_pct)} of the money) · agents ${formatUGX(p.agent.ugx)}`}
      </p>
      <ArrowRight className="hidden h-4 w-4 shrink-0 text-primary transition-transform group-hover:translate-x-0.5 sm:block" />
    </button>
  );
}
