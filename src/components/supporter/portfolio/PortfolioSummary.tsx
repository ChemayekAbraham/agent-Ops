import { formatUGX } from '@/lib/rentCalculations';

interface Props {
  totalDeployed: number;
  activeCount: number;
}

/**
 * Deliberately minimal: it answers only "how much capital is deployed" and
 * "how many active portfolios do I have". Earnings metrics live on the cards
 * and in the portfolio detail flow.
 */
export function PortfolioSummary({ totalDeployed, activeCount }: Props) {
  return (
    <div className="rounded-2xl border border-border/60 bg-card p-4 space-y-3">
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs font-semibold text-muted-foreground">Your capital is working</p>
        <span className="flex items-center gap-1.5 text-[10px] font-semibold text-success shrink-0">
          <span className="w-1.5 h-1.5 rounded-full bg-success" />
          Capital working
        </span>
      </div>

      <div>
        <p className="text-2xl xs:text-[26px] font-bold tracking-tight text-foreground break-words leading-tight">
          {formatUGX(totalDeployed)}
        </p>
        <p className="text-[11px] text-muted-foreground mt-0.5">Currently supporting</p>
      </div>

      <div className="pt-2 border-t border-border/40">
        <p className="text-lg font-bold text-foreground leading-none">{activeCount}</p>
        <p className="text-[11px] text-muted-foreground mt-0.5">
          Active portfolio{activeCount === 1 ? '' : 's'}
        </p>
      </div>
    </div>
  );
}
