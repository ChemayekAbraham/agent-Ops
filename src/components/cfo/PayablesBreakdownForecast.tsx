import { useState } from 'react';
import { format } from 'date-fns';
import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Layers,
  Loader2,
  TrendingDown,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import { Progress } from '@/components/ui/progress';
import { formatUGX } from '@/lib/rentCalculations';
import PredictivePayablesForecast from '@/components/cfo/PredictivePayablesForecast';
import PayablesAccuracyPanel from '@/components/cfo/PayablesAccuracyPanel';
import { usePayablesBreakdown, usePayablesTotal } from '@/hooks/usePayables';

export function PayablesBreakdownForecast({ hideHeadline = false }: { hideHeadline?: boolean } = {}) {
  const [openCategory, setOpenCategory] = useState<string | null>(null);
  const [openProduct, setOpenProduct] = useState<string | null>(null);
  const total = usePayablesTotal();
  const breakdown = usePayablesBreakdown();

  const validation = breakdown.data?.validation;

  return (
    <div className="space-y-3 sm:space-y-4 max-w-full">
      {!hideHeadline && (
        <Card className="border-destructive/20 bg-destructive/5">
          <CardContent className="p-4 sm:p-5 space-y-3">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="text-[10px] sm:text-xs uppercase tracking-wider text-muted-foreground">
                  Total Payables — authoritative
                </p>
                <p className="text-2xl sm:text-3xl font-bold font-mono tabular-nums break-words">
                  {total.isLoading ? '—' : formatUGX(total.data?.total ?? 0)}
                </p>
                <p className="text-[10px] sm:text-xs text-muted-foreground">
                  {total.data?.item_count ?? 0} open obligations · single server-side definition
                </p>
              </div>
              <TrendingDown className="h-5 w-5 sm:h-6 sm:w-6 text-destructive shrink-0" />
            </div>

            <div className="grid grid-cols-2 gap-2">
              <div className="rounded-lg bg-background/70 px-2.5 py-1.5">
                <p className="text-[9px] sm:text-[10px] uppercase tracking-wider text-destructive">
                  Overdue
                </p>
                <p className="text-xs sm:text-sm font-bold font-mono tabular-nums">
                  {formatUGX(total.data?.overdue ?? 0)}
                </p>
              </div>
              <div className="rounded-lg bg-background/70 px-2.5 py-1.5">
                <p className="text-[9px] sm:text-[10px] uppercase tracking-wider text-muted-foreground">
                  Due today
                </p>
                <p className="text-xs sm:text-sm font-bold font-mono tabular-nums">
                  {formatUGX(total.data?.due_today ?? 0)}
                </p>
              </div>
            </div>

            {validation && (
              <div className="flex items-start gap-1.5 text-[10px] sm:text-xs">
                {validation.ties_out ? (
                  <>
                    <CheckCircle2 className="h-3.5 w-3.5 text-emerald-600 mt-px shrink-0" />
                    <span className="text-emerald-700">
                      Categories tie out exactly to the authoritative total
                    </span>
                  </>
                ) : (
                  <>
                    <AlertTriangle className="h-3.5 w-3.5 text-destructive mt-px shrink-0" />
                    <span className="text-destructive">
                      Category sum differs by {formatUGX(validation.difference)} — do not rely on
                      this breakdown
                    </span>
                  </>
                )}
              </div>
            )}
          </CardContent>
        </Card>
      )}

      <Card>
        <CardContent className="p-3 sm:p-4 space-y-2">
          <div className="flex items-center justify-between gap-2">
            <p className="text-[10px] sm:text-xs uppercase tracking-wider text-muted-foreground flex items-center gap-1.5">
              <Layers className="h-3 w-3 sm:h-3.5 sm:w-3.5" />
              Breakdown by payable source
            </p>
            {breakdown.data && (
              <span className="text-[10px] sm:text-xs font-mono tabular-nums text-muted-foreground">
                {formatUGX(breakdown.data.total)}
              </span>
            )}
          </div>

          {breakdown.isError && (
            <p className="text-[11px] sm:text-xs text-destructive">
              Could not load the breakdown: {(breakdown.error as Error)?.message}
            </p>
          )}

          {breakdown.isLoading && (
            <div className="flex justify-center py-8">
              <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
            </div>
          )}

          <div className="space-y-2">
            {breakdown.data?.categories.map((cat) => {
              const catOpen = openCategory === cat.key;
              const share =
                breakdown.data.total > 0 ? (cat.outstanding / breakdown.data.total) * 100 : 0;
              return (
                <div
                  key={cat.key}
                  className="rounded-xl border border-border/60 bg-card"
                >
                  <button
                    type="button"
                    onClick={() => setOpenCategory(catOpen ? null : cat.key)}
                    aria-expanded={catOpen}
                    className="w-full flex items-center justify-between gap-2 px-3 py-2.5 min-h-11 text-left hover:bg-muted/40 rounded-xl transition-colors"
                  >
                    <span className="flex items-center gap-1.5 min-w-0">
                      {catOpen ? (
                        <ChevronDown className="h-4 w-4 text-muted-foreground shrink-0" />
                      ) : (
                        <ChevronRight className="h-4 w-4 text-muted-foreground shrink-0" />
                      )}
                      <span className="min-w-0">
                        <span className="block text-xs sm:text-sm font-medium truncate">
                          {cat.label}
                        </span>
                        <span className="block text-[9px] sm:text-[10px] text-muted-foreground">
                          {cat.item_count} item{cat.item_count === 1 ? '' : 's'} · {share.toFixed(1)}%
                          of book
                        </span>
                      </span>
                    </span>
                    <span className="text-right shrink-0">
                      <span className="block text-xs sm:text-sm font-bold font-mono tabular-nums">
                        {formatUGX(cat.outstanding)}
                      </span>
                      <Progress value={share} className="h-1 w-16 sm:w-24 mt-1" />
                    </span>
                  </button>

                  {catOpen && (
                    <div className="px-2.5 pb-2.5 space-y-1.5">
                      {cat.products.length === 0 && (
                        <p className="text-[10px] sm:text-xs text-muted-foreground py-1">
                          No open payables in this category.
                        </p>
                      )}
                      {cat.products.map((prod) => {
                        const prodKey = `${cat.key}:${prod.key}`;
                        const prodOpen = openProduct === prodKey;
                        return (
                          <div key={prodKey} className="rounded-lg bg-muted/30">
                            <button
                              type="button"
                              onClick={() => setOpenProduct(prodOpen ? null : prodKey)}
                              aria-expanded={prodOpen}
                              className="w-full flex items-center justify-between gap-2 px-2.5 py-2 min-h-10 text-left"
                            >
                              <span className="flex items-center gap-1.5 min-w-0">
                                {prodOpen ? (
                                  <ChevronDown className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                                ) : (
                                  <ChevronRight className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                                )}
                                <span className="text-[11px] sm:text-xs truncate">{prod.label}</span>
                                <span className="text-[9px] sm:text-[10px] text-muted-foreground shrink-0">
                                  ({prod.item_count})
                                </span>
                              </span>
                              <span className="text-[11px] sm:text-xs font-mono tabular-nums font-semibold shrink-0">
                                {formatUGX(prod.outstanding)}
                              </span>
                            </button>

                            {prodOpen && (
                              <div className="px-2.5 pb-2.5 space-y-1.5">
                                <div className="flex flex-wrap gap-1.5 text-[9px] sm:text-[10px]">
                                  <Badge variant="outline" className="px-1.5 py-0">
                                    Scheduled {formatUGX(prod.scheduled_amount)}
                                  </Badge>
                                  <Badge variant="outline" className="px-1.5 py-0">
                                    Projected {formatUGX(prod.projected_amount)}
                                  </Badge>
                                  <Badge variant="outline" className="px-1.5 py-0">
                                    {prod.source}
                                  </Badge>
                                </div>
                                <div className="max-h-64 overflow-y-auto rounded-lg bg-background/70">
                                  {prod.items.map((item) => (
                                    <div
                                      key={item.item_id}
                                      className="flex items-center justify-between gap-2 px-2.5 py-1.5 border-b border-border/40 last:border-0"
                                    >
                                      <span className="min-w-0">
                                        <span className="block text-[10px] sm:text-xs truncate">
                                          {item.counterparty || 'Unnamed'}
                                        </span>
                                        <span className="block text-[9px] sm:text-[10px] text-muted-foreground">
                                          {item.due_date
                                            ? `${item.due_kind === 'scheduled' ? 'Due' : 'Est.'} ${format(new Date(item.due_date), 'dd MMM yyyy')}`
                                            : 'No date'}
                                          {item.status ? ` · ${item.status}` : ''}
                                        </span>
                                      </span>
                                      <span className="text-[10px] sm:text-xs font-mono tabular-nums shrink-0">
                                        {formatUGX(item.amount)}
                                      </span>
                                    </div>
                                  ))}
                                  {prod.item_count > prod.items.length && (
                                    <p className="px-2.5 py-1.5 text-[9px] sm:text-[10px] text-muted-foreground">
                                      Showing largest {prod.items.length} of {prod.item_count} items.
                                    </p>
                                  )}
                                </div>
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </CardContent>
      </Card>

      <PredictivePayablesForecast />
      <PayablesAccuracyPanel />
    </div>
  );
}
