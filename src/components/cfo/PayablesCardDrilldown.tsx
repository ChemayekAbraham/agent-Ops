import { useState } from 'react';
import { AlertTriangle, CheckCircle2, ChevronRight, TrendingDown } from 'lucide-react';

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
      <div className="w-full rounded-2xl border border-border/70 bg-card shadow-sm transition-shadow hover:shadow-md">
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="w-full text-left p-5 rounded-2xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <div className="flex items-start justify-between gap-3">
            <div className="h-8 w-8 rounded-lg flex items-center justify-center shrink-0 bg-rose-600">
              <TrendingDown className="h-4 w-4 text-rose-50" />
            </div>
            <span
              className="flex h-5 w-5 items-center justify-center rounded-full bg-muted/60 shrink-0"
              aria-hidden
            >
              <ChevronRight className="h-3 w-3 text-muted-foreground" />
            </span>
          </div>

          <p className="mt-4 text-[11px] font-medium text-muted-foreground truncate">
            Total Payables — authoritative
          </p>
          <p className="mt-1.5 text-[22px] leading-none sm:text-[26px] sm:leading-none font-bold tabular-nums tracking-tight text-foreground break-words">
            {money(t?.total)}
          </p>
          {failed ? (
            <span
              role="link"
              tabIndex={0}
              onClick={(e) => {
                e.stopPropagation();
                void total.refetch();
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.stopPropagation();
                  e.preventDefault();
                  void total.refetch();
                }
              }}
              className="mt-2.5 block text-[11px] text-destructive underline underline-offset-2"
            >
              Payables could not be loaded · tap to retry
            </span>
          ) : (
            <p className="mt-2.5 text-[11px] text-muted-foreground line-clamp-2">
              {t ? `${t.item_count ?? 0} open obligations · ` : ''}tap for breakdown &amp; forecast
            </p>
          )}

          <div className="mt-3 grid grid-cols-2 gap-2">
            <div className="rounded-lg border border-border/70 bg-muted/30 px-2.5 py-1.5">
              <p className="text-[10px] font-medium text-muted-foreground">Overdue</p>
              <p className="mt-0.5 text-xs font-semibold tabular-nums">{money(t?.overdue)}</p>
            </div>
            <div className="rounded-lg border border-border/70 bg-muted/30 px-2.5 py-1.5">
              <p className="text-[10px] font-medium text-muted-foreground">Due today</p>
              <p className="mt-0.5 text-xs font-semibold tabular-nums">{money(t?.due_today)}</p>
            </div>
          </div>
        </button>
      </div>



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
