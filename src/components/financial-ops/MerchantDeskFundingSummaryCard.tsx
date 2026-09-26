import { useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { Landmark, Maximize2, AlertCircle, ArrowRight } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { formatUGX } from '@/lib/rentCalculations';
import {
  IMMACULATE_PRESET,
  TRACKER_MIN_DATE,
  useMerchantDeskFundingTracker,
  useMerchantDeskExternalFunding,
} from '@/hooks/useMerchantDeskFundingTracker';

function renderBalanceSummary(amount: number) {
  const isNegative = amount < 0;
  const absFormatted = formatUGX(Math.abs(amount));
  const amountWithUGX = absFormatted.includes('UGX') ? absFormatted : `UGX ${absFormatted}`;
  const label = isNegative ? "Merchant's own money in use" : 'Company money with desk';

  return (
    <div>
      <p className="text-[11px] text-muted-foreground font-medium">{label}</p>
      <p
        className={`text-sm sm:text-base font-bold font-mono tracking-tight ${
          isNegative
            ? 'text-rose-600 dark:text-rose-400'
            : 'text-emerald-600 dark:text-emerald-400'
        }`}
      >
        {amountWithUGX}
      </p>
    </div>
  );
}

export function MerchantDeskFundingSummaryCard() {
  const navigate = useNavigate();
  const todayStr = useMemo(() => new Date().toISOString().split('T')[0], []);

  const { data: trackerRows = [], isLoading: loadingTracker } = useMerchantDeskFundingTracker({
    agentIds: IMMACULATE_PRESET.agentIds,
    fromDate: TRACKER_MIN_DATE,
    toDate: todayStr,
  });

  const { data: transfers = [] } = useMerchantDeskExternalFunding(IMMACULATE_PRESET.agentIds);

  const unconfirmedCount = useMemo(() => {
    return transfers.filter((t) => t.status === 'suggested').length;
  }, [transfers]);

  const { confirmedBalance, suggestedBalance } = useMemo(() => {
    const allDesksRows = trackerRows.filter(
      (r) => r.desk_label === 'ALL DESKS' || r.agent_id === null
    );
    const rowsToUse = allDesksRows.length > 0 ? allDesksRows : trackerRows;
    const sorted = [...rowsToUse].sort((a, b) => (a.day > b.day ? 1 : -1));
    const latestRow = sorted[sorted.length - 1];

    return {
      confirmedBalance: latestRow ? Number(latestRow.running_confirmed ?? 0) : 0,
      suggestedBalance: latestRow ? Number(latestRow.running_with_suggested ?? 0) : 0,
    };
  }, [trackerRows]);

  return (
    <Card className="border border-border/80 shadow-xs bg-card overflow-hidden">
      <CardContent className="p-4 space-y-3.5">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <div className="p-1.5 rounded-md bg-primary/10 text-primary">
              <Landmark className="h-4 w-4" />
            </div>
            <div>
              <h3 className="text-sm font-semibold text-foreground leading-none">
                Merchant Desk Funding Tracker
              </h3>
              <p className="text-[11px] text-muted-foreground mt-0.5">
                Immaculate (both desks) · 01 Sep to today
              </p>
            </div>
          </div>

          <Button
            variant="outline"
            size="sm"
            onClick={() => navigate('/admin/financial-ops/merchant-desk-funding')}
            className="h-7 text-xs gap-1.5 font-medium border-primary/30 hover:bg-primary/5 hover:text-primary shrink-0"
          >
            <span>Open full screen</span>
            <Maximize2 className="h-3 w-3" />
          </Button>
        </div>

        {loadingTracker ? (
          <div className="py-3 text-center text-xs text-muted-foreground">
            Loading balances…
          </div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5 pt-1">
            <div className="p-2.5 rounded-md bg-muted/40 border border-muted/80">
              <span className="text-[10px] uppercase font-bold tracking-wider text-muted-foreground">
                Confirmed only
              </span>
              <div className="mt-1">{renderBalanceSummary(confirmedBalance)}</div>
            </div>

            <div className="p-2.5 rounded-md bg-muted/40 border border-muted/80">
              <div className="flex items-center justify-between">
                <span className="text-[10px] uppercase font-bold tracking-wider text-muted-foreground">
                  Incl. unconfirmed
                </span>
                {unconfirmedCount > 0 && (
                  <Badge
                    variant="outline"
                    className="text-[10px] px-1.5 py-0 h-4 border-amber-300 dark:border-amber-700 bg-amber-50 dark:bg-amber-950/40 text-amber-700 dark:text-amber-400 font-normal"
                  >
                    {unconfirmedCount} unconfirmed
                  </Badge>
                )}
              </div>
              <div className="mt-1">{renderBalanceSummary(suggestedBalance)}</div>
            </div>
          </div>
        )}

        <div className="flex items-center justify-between pt-1 border-t text-[11px] text-muted-foreground">
          <span className="truncate">
            {unconfirmedCount > 0
              ? `${unconfirmedCount} bank transfer${unconfirmedCount === 1 ? '' : 's'} awaiting confirmation`
              : 'All bank transfers confirmed'}
          </span>
          <button
            type="button"
            onClick={() => navigate('/admin/financial-ops/merchant-desk-funding')}
            className="text-primary hover:underline font-medium inline-flex items-center gap-0.5 shrink-0 ml-2"
          >
            View full tracker <ArrowRight className="h-3 w-3" />
          </button>
        </div>
      </CardContent>
    </Card>
  );
}
