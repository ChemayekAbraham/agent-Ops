import { useState } from 'react';
import { AlertTriangle, CheckCircle2, ChevronRight, TrendingUp } from 'lucide-react';

import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { formatUGX } from '@/lib/rentCalculations';
import { useReceivablesBreakdown, useReceivablesTotal } from '@/hooks/useReceivables';
import { ReceivablesBreakdownForecast } from '@/components/cfo/ReceivablesBreakdownForecast';

/**
 * The Receivables card on the CFO home page. Tapping it opens the full
 * Receivables Breakdown & Forecast sheet. Both the card headline and the sheet
 * read the same authoritative server-side receivables source, so they always
 * reconcile.
 */
export function ReceivablesCardDrilldown() {
  const [open, setOpen] = useState(false);
  const total = useReceivablesTotal();
  const breakdown = useReceivablesBreakdown();
  const validation = breakdown.data?.validation;

  return (
    <>
      <div className="w-full rounded-2xl border border-border/70 bg-card shadow-sm transition-shadow hover:shadow-md">
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="w-full text-left p-5 rounded-2xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <div className="flex items-start justify-between gap-3">
            <div className="h-8 w-8 rounded-lg flex items-center justify-center shrink-0 bg-emerald-600">
              <TrendingUp className="h-4 w-4 text-emerald-50" />
            </div>
            <span
              className="flex h-5 w-5 items-center justify-center rounded-full bg-muted/60 shrink-0"
              aria-hidden
            >
              <ChevronRight className="h-3 w-3 text-muted-foreground" />
            </span>
          </div>

          <p className="mt-4 text-[11px] font-medium text-muted-foreground truncate">
            Total Receivables — authoritative
          </p>
          <p className="mt-1.5 text-[22px] leading-none sm:text-[26px] sm:leading-none font-bold tabular-nums tracking-tight text-foreground">
            {total.isLoading ? '—' : formatUGX(total.data?.total ?? 0)}
          </p>
          <p className="mt-2.5 text-[11px] text-muted-foreground line-clamp-2">
            {total.data?.item_count ?? 0} open items · tap for breakdown &amp; forecast
          </p>

          {validation && (
            <p className="mt-2 flex items-center gap-1.5 text-[11px]">
              {validation.ties_out ? (
                <>
                  <CheckCircle2 className="h-3 w-3 shrink-0 text-emerald-600" />
                  <span className="text-muted-foreground">
                    Categories tie out exactly to the authoritative total
                  </span>
                </>
              ) : (
                <>
                  <AlertTriangle className="h-3 w-3 shrink-0 text-destructive" />
                  <span className="text-destructive">
                    Category sum differs by {formatUGX(validation.difference)}
                  </span>
                </>
              )}
            </p>
          )}
        </button>
      </div>


      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent
          side="center"
          className="overflow-y-auto overflow-x-hidden p-4 sm:p-6"
        >
          <SheetHeader className="text-left">
            <SheetTitle className="text-base sm:text-lg">
              Receivables Breakdown &amp; Forecast
            </SheetTitle>
          </SheetHeader>

          <div className="mt-3 space-y-3 sm:space-y-4 max-w-full">
            <div className="rounded-xl border border-primary/20 bg-primary/5 p-3 sm:p-4">
              <p className="text-[10px] uppercase tracking-wider text-muted-foreground">
                Total Receivables
              </p>
              <p className="text-xl sm:text-2xl font-bold font-mono tabular-nums break-words">
                {total.isLoading ? '—' : formatUGX(total.data?.total ?? 0)}
              </p>
              {validation && !validation.ties_out && (
                <p className="mt-1 flex items-start gap-1.5 text-[10px] sm:text-xs text-destructive">
                  <AlertTriangle className="h-3 w-3 mt-0.5 shrink-0" />
                  <span>
                    Discrepancy: categories sum to {formatUGX(validation.categories_total ?? 0)}, a
                    difference of {formatUGX(validation.difference)} against the authoritative total.
                    No figure has been adjusted to force a match.
                  </span>
                </p>
              )}
            </div>

            <ReceivablesBreakdownForecast hideHeadline />
          </div>
        </SheetContent>
      </Sheet>

    </>
  );
}
