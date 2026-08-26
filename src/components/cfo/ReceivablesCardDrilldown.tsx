import { useState } from 'react';
import { AlertTriangle, CheckCircle2, ChevronRight, TrendingUp } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
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
      <Card
        role="button"
        tabIndex={0}
        onClick={() => setOpen(true)}
        onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && setOpen(true)}
        className="border-primary/20 bg-primary/5 cursor-pointer transition-colors hover:border-primary/50 focus:outline-none focus:ring-2 focus:ring-ring"
      >
        <CardContent className="p-4 space-y-2">
          <div className="flex items-start justify-between gap-3">
            <div>
              <p className="text-[10px] uppercase tracking-wider text-muted-foreground">
                Total Receivables — authoritative
              </p>
              <p className="text-2xl font-bold font-mono">
                {total.isLoading ? '—' : formatUGX(total.data?.total ?? 0)}
              </p>
              <p className="text-[10px] text-muted-foreground">
                {total.data?.item_count ?? 0} open items · tap for breakdown &amp; forecast
              </p>
            </div>
            <span className="flex items-center gap-1 shrink-0">
              <TrendingUp className="h-5 w-5 text-primary" />
              <ChevronRight className="h-4 w-4 text-muted-foreground" />
            </span>
          </div>

          {validation && (
            <div className="flex items-center gap-1.5 text-[10px]">
              {validation.ties_out ? (
                <>
                  <CheckCircle2 className="h-3 w-3 text-emerald-600" />
                  <span className="text-emerald-700">
                    Categories tie out exactly to the authoritative total
                  </span>
                </>
              ) : (
                <>
                  <AlertTriangle className="h-3 w-3 text-destructive" />
                  <span className="text-destructive">
                    Category sum differs by {formatUGX(validation.difference)}
                  </span>
                </>
              )}
            </div>
          )}
        </CardContent>
      </Card>

      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent side="right" className="w-full sm:max-w-3xl lg:max-w-5xl xl:max-w-6xl overflow-y-auto">
          <SheetHeader>
            <SheetTitle className="text-base">Receivables Breakdown &amp; Forecast</SheetTitle>
          </SheetHeader>

          <div className="mt-3 space-y-3">
            <div className="rounded-lg border border-primary/20 bg-primary/5 p-3">
              <p className="text-[10px] uppercase tracking-wider text-muted-foreground">
                Total Receivables
              </p>
              <p className="text-xl font-bold font-mono">
                {total.isLoading ? '—' : formatUGX(total.data?.total ?? 0)}
              </p>
              {validation && !validation.ties_out && (
                <p className="mt-1 flex items-center gap-1.5 text-[10px] text-destructive">
                  <AlertTriangle className="h-3 w-3" />
                  Discrepancy: categories sum to {formatUGX(validation.categories_total ?? 0)}, a
                  difference of {formatUGX(validation.difference)} against the authoritative total.
                  No figure has been adjusted to force a match.
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
