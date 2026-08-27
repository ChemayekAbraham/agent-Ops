import { useState } from 'react';
import { AlertTriangle, CheckCircle2, ChevronRight, TrendingDown } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { formatUGX } from '@/lib/rentCalculations';
import { usePayablesBreakdown, usePayablesTotal } from '@/hooks/usePayables';
import { PayablesBreakdownForecast } from '@/components/cfo/PayablesBreakdownForecast';

/**
 * The Payables card on the CFO home page. Tapping it opens the full Payables
 * Breakdown & Forecast sheet. Card and sheet read the same authoritative
 * server-side payables source, so they always reconcile.
 */
export function PayablesCardDrilldown() {
  const [open, setOpen] = useState(false);
  const total = usePayablesTotal();
  const breakdown = usePayablesBreakdown(open);
  const validation = breakdown.data?.validation;

  // Never fall back to zero: an unresolved / failed load shows a dash (and a
  // retry affordance), so a real UGX 0 can be trusted as a real UGX 0.
  const t = total.data;
  const pending = !t && (total.isPending || total.isFetching);
  const failed = !t && total.isError;
  const money = (v: number | undefined) => (t ? formatUGX(Number(v ?? 0)) : pending ? '…' : '—');

  return (
    <>
      <Card
        role="button"
        tabIndex={0}
        onClick={() => setOpen(true)}
        onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && setOpen(true)}
        className="border-destructive/20 bg-destructive/5 cursor-pointer transition-colors hover:border-destructive/50 focus:outline-none focus:ring-2 focus:ring-ring"
      >
        <CardContent className="p-4 space-y-2">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="text-[10px] uppercase tracking-wider text-muted-foreground">
                Total Payables — authoritative
              </p>
              <p className="text-2xl font-bold font-mono tabular-nums break-words">
                {money(t?.total)}
              </p>
              {failed ? (
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    void total.refetch();
                  }}
                  className="text-[10px] text-destructive underline underline-offset-2"
                >
                  Payables could not be loaded · tap to retry
                </button>
              ) : (
                <p className="text-[10px] text-muted-foreground">
                  {t ? `${t.item_count ?? 0} open obligations · ` : ''}tap for breakdown &amp;
                  forecast
                </p>
              )}
            </div>
            <span className="flex items-center gap-1 shrink-0">
              <TrendingDown className="h-5 w-5 text-destructive" />
              <ChevronRight className="h-4 w-4 text-muted-foreground" />
            </span>
          </div>

          <div className="grid grid-cols-2 gap-2">
            <div className="rounded-lg bg-background/70 px-2 py-1">
              <p className="text-[9px] uppercase tracking-wider text-destructive">Overdue</p>
              <p className="text-xs font-bold font-mono tabular-nums">{money(t?.overdue)}</p>
            </div>
            <div className="rounded-lg bg-background/70 px-2 py-1">
              <p className="text-[9px] uppercase tracking-wider text-muted-foreground">Due today</p>
              <p className="text-xs font-bold font-mono tabular-nums">{money(t?.due_today)}</p>
            </div>
          </div>
        </CardContent>
      </Card>


      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent
          side="center"
          className="overflow-y-auto overflow-x-hidden p-4 sm:p-6"
        >
          <SheetHeader className="text-left">
            <SheetTitle className="text-base sm:text-lg">
              Payables Breakdown &amp; Forecast
            </SheetTitle>
          </SheetHeader>

          <div className="mt-3 space-y-3 sm:space-y-4 max-w-full">
            <div className="rounded-xl border border-destructive/20 bg-destructive/5 p-3 sm:p-4">
              <p className="text-[10px] uppercase tracking-wider text-muted-foreground">
                Total Payables
              </p>
              <p className="text-xl sm:text-2xl font-bold font-mono tabular-nums break-words">
                {money(t?.total)}
              </p>
              <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-[10px] sm:text-xs text-muted-foreground">
                <span>
                  Overdue{' '}
                  <span className="font-mono tabular-nums text-destructive">
                    {money(t?.overdue)}
                  </span>
                </span>
                <span>
                  Due today{' '}
                  <span className="font-mono tabular-nums text-foreground">
                    {money(t?.due_today)}
                  </span>
                </span>
              </div>

              {validation &&
                (validation.ties_out ? (
                  <p className="mt-1 flex items-start gap-1.5 text-[10px] sm:text-xs text-emerald-700">
                    <CheckCircle2 className="h-3 w-3 mt-0.5 shrink-0" />
                    <span>Categories tie out exactly to the authoritative total.</span>
                  </p>
                ) : (
                  <p className="mt-1 flex items-start gap-1.5 text-[10px] sm:text-xs text-destructive">
                    <AlertTriangle className="h-3 w-3 mt-0.5 shrink-0" />
                    <span>
                      Discrepancy: categories sum to {formatUGX(validation.categories_total ?? 0)}, a
                      difference of {formatUGX(validation.difference)} against the authoritative
                      total. No figure has been adjusted to force a match.
                    </span>
                  </p>
                ))}
            </div>

            <PayablesBreakdownForecast hideHeadline />
          </div>
        </SheetContent>
      </Sheet>
    </>
  );
}
