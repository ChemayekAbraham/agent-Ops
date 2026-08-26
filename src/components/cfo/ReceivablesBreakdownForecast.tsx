import { useState } from 'react';
import { format } from 'date-fns';
import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Loader2,
  TrendingUp,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import { formatUGX } from '@/lib/rentCalculations';
import PredictiveReceivablesForecast from '@/components/cfo/PredictiveReceivablesForecast';
import ForecastAccuracyPanel from '@/components/cfo/ForecastAccuracyPanel';
import { useReceivablesBreakdown, useReceivablesTotal } from '@/hooks/useReceivables';


type PresetKey =
  | 'today'
  | 'tomorrow'
  | 'next_7'
  | 'next_month'
  | 'next_3m'
  | 'next_6m'
  | 'next_12m'
  | 'custom';

const PRESETS: { key: PresetKey; label: string }[] = [
  { key: 'today', label: 'Today' },
  { key: 'tomorrow', label: 'Tomorrow' },
  { key: 'next_7', label: 'Next 7 days' },
  { key: 'next_month', label: 'Next month' },
  { key: 'next_3m', label: 'Next 3 months' },
  { key: 'next_6m', label: 'Next 6 months' },
  { key: 'next_12m', label: 'Next 12 months' },
  { key: 'custom', label: 'Custom range' },
];

const iso = (d: Date) => format(d, 'yyyy-MM-dd');

function presetRange(preset: PresetKey): { from: string; to: string } {
  const today = new Date();
  switch (preset) {
    case 'today':
      return { from: iso(today), to: iso(today) };
    case 'tomorrow': {
      const t = addDays(today, 1);
      return { from: iso(t), to: iso(t) };
    }
    case 'next_7':
      return { from: iso(today), to: iso(addDays(today, 7)) };
    case 'next_month':
      return { from: iso(today), to: iso(addMonths(today, 1)) };
    case 'next_3m':
      return { from: iso(today), to: iso(addMonths(today, 3)) };
    case 'next_6m':
      return { from: iso(today), to: iso(addMonths(today, 6)) };
    case 'next_12m':
    default:
      return { from: iso(today), to: iso(addMonths(today, 12)) };
  }
}

export function ReceivablesBreakdownForecast({ hideHeadline = false }: { hideHeadline?: boolean } = {}) {
  const [openCategory, setOpenCategory] = useState<string | null>(null);
  const [openProduct, setOpenProduct] = useState<string | null>(null);
  const total = useReceivablesTotal();
  const breakdown = useReceivablesBreakdown();


  const validation = breakdown.data?.validation;

  return (
    <div className="space-y-3">
      {/* Headline */}
      {!hideHeadline && (
      <Card className="border-primary/20 bg-primary/5">
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
                {total.data?.item_count ?? 0} open items · single server-side definition
                (v_receivables_lines)
              </p>
            </div>
            <TrendingUp className="h-5 w-5 text-primary shrink-0" />
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
                    Category sum differs by {formatUGX(validation.difference)} — do not rely on this
                    breakdown
                  </span>
                </>
              )}
            </div>
          )}
        </CardContent>
      </Card>
      )}

      {/* Categories with drill-down */}
      <Card>
        <CardContent className="p-3 space-y-1.5">
          <p className="text-[10px] uppercase tracking-wider text-muted-foreground">
            Breakdown by category
          </p>

          {breakdown.isLoading && (
            <div className="flex justify-center py-6">
              <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
            </div>
          )}

          {breakdown.data?.categories.map((cat) => {
            const catOpen = openCategory === cat.key;
            const share = breakdown.data.total > 0 ? (cat.outstanding / breakdown.data.total) * 100 : 0;
            return (
              <div key={cat.key} className="rounded-lg border border-border/60">
                <button
                  type="button"
                  onClick={() => setOpenCategory(catOpen ? null : cat.key)}
                  className="w-full flex items-center justify-between gap-2 px-2.5 py-2 text-left hover:bg-muted/40 rounded-lg"
                >
                  <span className="flex items-center gap-1.5 min-w-0">
                    {catOpen ? (
                      <ChevronDown className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                    ) : (
                      <ChevronRight className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                    )}
                    <span className="text-xs font-medium truncate">{cat.label}</span>
                    <Badge variant="secondary" className="text-[9px] px-1 py-0">
                      {cat.item_count}
                    </Badge>
                  </span>
                  <span className="text-right shrink-0">
                    <span className="block text-xs font-bold font-mono">
                      {formatUGX(cat.outstanding)}
                    </span>
                    <span className="block text-[9px] text-muted-foreground">
                      {share.toFixed(1)}%
                    </span>
                  </span>
                </button>

                {catOpen && (
                  <div className="px-2.5 pb-2 space-y-1">
                    {cat.products.length === 0 && (
                      <p className="text-[10px] text-muted-foreground py-1">
                        No open receivables in this category.
                      </p>
                    )}
                    {cat.products.map((prod) => {
                      const prodKey = `${cat.key}:${prod.key}`;
                      const prodOpen = openProduct === prodKey;
                      return (
                        <div key={prodKey} className="rounded-md bg-muted/30">
                          <button
                            type="button"
                            onClick={() => setOpenProduct(prodOpen ? null : prodKey)}
                            className="w-full flex items-center justify-between gap-2 px-2 py-1.5 text-left"
                          >
                            <span className="flex items-center gap-1.5 min-w-0">
                              {prodOpen ? (
                                <ChevronDown className="h-3 w-3 text-muted-foreground shrink-0" />
                              ) : (
                                <ChevronRight className="h-3 w-3 text-muted-foreground shrink-0" />
                              )}
                              <span className="text-[11px] truncate">{prod.label}</span>
                              <span className="text-[9px] text-muted-foreground">
                                ({prod.item_count})
                              </span>
                            </span>
                            <span className="text-[11px] font-mono font-semibold shrink-0">
                              {formatUGX(prod.outstanding)}
                            </span>
                          </button>

                          {prodOpen && (
                            <div className="px-2 pb-2 space-y-1">
                              <div className="flex flex-wrap gap-1.5 text-[9px]">
                                <Badge variant="outline" className="px-1 py-0">
                                  Scheduled {formatUGX(prod.scheduled_amount)}
                                </Badge>
                                <Badge variant="outline" className="px-1 py-0">
                                  Projected {formatUGX(prod.projected_amount)}
                                </Badge>
                                <Badge variant="outline" className="px-1 py-0">
                                  {prod.source}
                                </Badge>
                              </div>
                              <div className="max-h-56 overflow-y-auto rounded bg-background/70">
                                {prod.items.map((item) => (
                                  <div
                                    key={item.item_id}
                                    className="flex items-center justify-between gap-2 px-2 py-1 border-b border-border/40 last:border-0"
                                  >
                                    <span className="min-w-0">
                                      <span className="block text-[10px] truncate">
                                        {item.counterparty || 'Unnamed'}
                                      </span>
                                      <span className="block text-[9px] text-muted-foreground">
                                        {item.due_date
                                          ? `${item.due_kind === 'scheduled' ? 'Due' : 'Est.'} ${format(new Date(item.due_date), 'dd MMM yyyy')}`
                                          : 'No date'}
                                        {item.status ? ` · ${item.status}` : ''}
                                      </span>
                                    </span>
                                    <span className="text-[10px] font-mono shrink-0">
                                      {formatUGX(item.amount)}
                                    </span>
                                  </div>
                                ))}
                                {prod.item_count > prod.items.length && (
                                  <p className="px-2 py-1 text-[9px] text-muted-foreground">
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
        </CardContent>
      </Card>


      {/* Predictive, data-driven forecast (separate from the scheduled window above) */}
      <PredictiveReceivablesForecast />

      {/* Proof: how the same model performed against actual collections */}
      <ForecastAccuracyPanel />
    </div>
  );
}
