import { useState } from 'react';
import { ChevronDown, ChevronRight, Gauge, Loader2 } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import { formatUGX } from '@/lib/rentCalculations';
import { usePayablesForecastAccuracy } from '@/hooks/usePayables';

/**
 * Read-only back-test of the payables forecast. Replays the live model at past
 * origin dates and grades it against what was actually paid. No writes, no
 * stored snapshots.
 */
export default function PayablesAccuracyPanel() {
  const [open, setOpen] = useState(false);
  const q = usePayablesForecastAccuracy(8, 7, [1, 7, 30], open);
  const data = q.data;

  return (
    <Card className="max-w-full">
      <CardContent className="p-3 sm:p-4 space-y-3">
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
          className="w-full flex items-center justify-between gap-2 text-left"
        >
          <span className="min-w-0">
            <span className="text-[10px] sm:text-xs uppercase tracking-wider text-muted-foreground flex items-center gap-1.5">
              <Gauge className="h-3 w-3 sm:h-3.5 sm:w-3.5" />
              Forecast accuracy (back-tested)
            </span>
            <span className="block text-[9px] sm:text-[11px] text-muted-foreground">
              How closely past payables forecasts matched what was actually paid
            </span>
          </span>
          {open ? (
            <ChevronDown className="h-4 w-4 text-muted-foreground shrink-0" />
          ) : (
            <ChevronRight className="h-4 w-4 text-muted-foreground shrink-0" />
          )}
        </button>

        {open && (
          <>
            {q.isError && (
              <p className="text-[11px] sm:text-xs text-destructive">
                Could not run the back-test: {(q.error as Error)?.message}
              </p>
            )}

            {q.isLoading ? (
              <div className="flex justify-center py-8">
                <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
              </div>
            ) : data ? (
              <>
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                  {data.horizons.map((h) => (
                    <div key={h.horizon_days} className="rounded-xl bg-muted/40 px-2.5 py-2">
                      <p className="text-[9px] sm:text-[10px] uppercase tracking-wider text-muted-foreground">
                        Next {h.horizon_days} day{h.horizon_days === 1 ? '' : 's'}
                      </p>
                      <p className="text-sm sm:text-lg font-bold font-mono tabular-nums">
                        {h.accuracy_pct === null ? '—' : `${h.accuracy_pct.toFixed(1)}%`}
                      </p>
                      <p className="text-[9px] sm:text-[10px] text-muted-foreground">
                        {h.runs} replay{h.runs === 1 ? '' : 's'} ·{' '}
                        {h.bias_pct === null
                          ? 'no bias measured'
                          : `${h.bias_pct > 0 ? 'over' : 'under'}-forecast ${Math.abs(h.bias_pct).toFixed(1)}%`}
                      </p>
                      <div className="mt-1 flex flex-wrap gap-1">
                        <Badge variant="outline" className="text-[8px] px-1 py-0">
                          Forecast {formatUGX(h.total_forecast)}
                        </Badge>
                        <Badge variant="outline" className="text-[8px] px-1 py-0">
                          Actual {formatUGX(h.total_actual)}
                        </Badge>
                      </div>
                    </div>
                  ))}
                </div>

                {data.products.length > 0 && (
                  <div className="max-h-64 overflow-y-auto overflow-x-auto rounded-xl border border-border/60">
                    <table className="w-full min-w-[320px] text-[10px] sm:text-xs">
                      <thead className="bg-muted/50 sticky top-0 z-10">
                        <tr>
                          <th className="text-left px-2.5 py-1.5 font-medium">Payable type</th>
                          <th className="text-right px-2.5 py-1.5 font-medium">Horizon</th>
                          <th className="text-right px-2.5 py-1.5 font-medium">Accuracy</th>
                          <th className="text-right px-2.5 py-1.5 font-medium hidden sm:table-cell">
                            Forecast
                          </th>
                          <th className="text-right px-2.5 py-1.5 font-medium hidden sm:table-cell">
                            Actual
                          </th>
                        </tr>
                      </thead>
                      <tbody>
                        {data.products.map((p) => (
                          <tr
                            key={`${p.category_key}:${p.product_key}:${p.horizon_days}`}
                            className="border-t border-border/40"
                          >
                            <td className="px-2.5 py-1.5">
                              <span className="block truncate">{p.product_label}</span>
                              <span className="block text-[9px] text-muted-foreground truncate">
                                {p.category_label}
                              </span>
                            </td>
                            <td className="px-2.5 py-1.5 text-right whitespace-nowrap">
                              {p.horizon_days}d
                            </td>
                            <td className="px-2.5 py-1.5 text-right font-mono tabular-nums whitespace-nowrap">
                              {p.accuracy_pct === null ? '—' : `${p.accuracy_pct.toFixed(1)}%`}
                            </td>
                            <td className="px-2.5 py-1.5 text-right font-mono tabular-nums hidden sm:table-cell whitespace-nowrap">
                              {formatUGX(p.total_forecast)}
                            </td>
                            <td className="px-2.5 py-1.5 text-right font-mono tabular-nums hidden sm:table-cell whitespace-nowrap">
                              {formatUGX(p.total_actual)}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}

                <p className="text-[9px] sm:text-[10px] text-muted-foreground">
                  {data.meta.method_note} {data.meta.origins_used} origin date(s), every{' '}
                  {data.meta.step_days} day(s). Read-only: nothing is written and no forecast is
                  stored.
                </p>
              </>
            ) : null}
          </>
        )}
      </CardContent>
    </Card>
  );
}
