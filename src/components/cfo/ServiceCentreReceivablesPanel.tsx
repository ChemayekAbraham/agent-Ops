import { useMemo, useState } from 'react';
import { AlertTriangle, Building2, ChevronRight, Loader2, Search } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { format } from 'date-fns';
import { formatUGX } from '@/lib/rentCalculations';
import {
  useServiceCentreReceivablesSummary,
  type SCReceivablesSummaryRow,
} from '@/hooks/useServiceCentre360';

/**
 * Read-only COO / CFO view of Service Centre receivables: money put into each
 * centre, the charge on top, the daily amount owed and how Agent Ops split that
 * daily amount between the agents attached to the centre.
 */
export function ServiceCentreReceivablesPanel() {
  const { data, isLoading, isError } = useServiceCentreReceivablesSummary();
  const [q, setQ] = useState('');
  const [row, setRow] = useState<SCReceivablesSummaryRow | null>(null);

  const rows = useMemo(() => {
    const term = q.trim().toLowerCase();
    const all = data?.rows ?? [];
    if (!term) return all;
    return all.filter((r) =>
      [r.centre_agent_name, r.location_name, ...r.splits.map((s) => s.agent_name)]
        .filter(Boolean)
        .some((v) => String(v).toLowerCase().includes(term)),
    );
  }, [data, q]);

  const t = data?.totals;

  return (
    <>
      <Card className="rounded-2xl shadow-sm">
        <CardHeader className="pb-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <CardTitle className="flex items-center gap-2.5 text-sm">
              <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-primary/10">
                <Building2 className="h-4 w-4 text-primary" />
              </span>
              Service Centre receivables
            </CardTitle>
            {t && (
              <Badge variant="outline" className="border-0 bg-primary/10 text-[10px] text-primary">
                {t.centres} active
              </Badge>
            )}
          </div>
        </CardHeader>
        <CardContent className="space-y-3">
          {isLoading ? (
            <div className="flex justify-center py-8">
              <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
            </div>
          ) : isError ? (
            <div className="flex flex-col items-center gap-2 py-8 text-center">
              <AlertTriangle className="h-5 w-5 text-muted-foreground/60" />
              <p className="text-xs text-muted-foreground">
                Service centre receivables could not be loaded.
              </p>
            </div>
          ) : (
            <>
              <div className="grid grid-cols-2 gap-2 lg:grid-cols-4">
                <Stat label="Put into centres" value={formatUGX(Number(t?.principal ?? 0))} />
                <Stat label="Total repayable" value={formatUGX(Number(t?.total_repayable ?? 0))} />
                <Stat label="Charge receivable" value={formatUGX(Number(t?.recoverable ?? 0))} tone="text-amber-600" />
                <Stat label="Due today" value={formatUGX(Number(t?.due_daily ?? 0))} tone="text-primary" />
              </div>

              {Number(t?.unallocated_daily ?? 0) > 0 && (
                <div className="flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 p-2.5">
                  <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-600" />
                  <p className="text-[11px] text-amber-700 dark:text-amber-500">
                    {formatUGX(Number(t?.unallocated_daily))} per day is not yet shared between agents — Agent Ops
                    still has to distribute it.
                  </p>
                </div>
              )}

              <div className="relative">
                <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
                <Input
                  value={q}
                  onChange={(e) => setQ(e.target.value)}
                  placeholder="Search centre, location or agent…"
                  className="h-9 pl-8 text-xs"
                />
              </div>

              {rows.length === 0 ? (
                <div className="flex flex-col items-center gap-2 py-8 text-center">
                  <Building2 className="h-5 w-5 text-muted-foreground/50" />
                  <p className="text-xs text-muted-foreground">
                    No active service centre receivables.
                  </p>
                </div>
              ) : (
                <div className="space-y-1.5">
                  {rows.map((r) => (
                    <button
                      key={r.receivable_id}
                      type="button"
                      onClick={() => setRow(r)}
                      className="flex w-full items-center gap-2.5 rounded-lg border border-border p-2.5 text-left transition-colors hover:border-primary/40 hover:bg-muted/50"
                    >
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-xs font-medium">{r.centre_agent_name}</span>
                        <span className="block truncate text-[10px] text-muted-foreground">
                          {r.location_name || 'No location'} · {r.agent_count} agent{r.agent_count === 1 ? '' : 's'} ·
                          day {r.days_elapsed}/{r.duration_days}
                        </span>
                      </span>
                      <span className="shrink-0 text-right">
                        <span className="block font-mono text-xs font-bold tabular-nums">
                          {formatUGX(Number(r.daily_amount))}
                        </span>
                        <span className="block text-[10px] text-muted-foreground">per day</span>
                      </span>
                      <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />
                    </button>
                  ))}
                </div>
              )}
            </>
          )}
        </CardContent>
      </Card>

      <Dialog open={!!row} onOpenChange={(o) => !o && setRow(null)}>
        <DialogContent className="max-h-[85vh] w-[calc(100vw-1.5rem)] max-w-[calc(100vw-1.5rem)] overflow-y-auto p-4 sm:max-w-lg sm:p-6">
          <DialogHeader className="text-left">
            <DialogTitle className="text-base">{row?.centre_agent_name}</DialogTitle>
          </DialogHeader>
          {row && (
            <div className="space-y-3">
              <div className="grid grid-cols-2 gap-2">
                <Stat label="Put into centre" value={formatUGX(Number(row.principal_amount))} />
                <Stat
                  label={row.mode === 'markup' ? `Mark-up ${Number(row.markup_percent ?? 0)}%` : 'Flat charge'}
                  value={formatUGX(Number(row.recoverable_amount))}
                  tone="text-amber-600"
                />
                <Stat label="Total repayable" value={formatUGX(Number(row.total_repayable))} />
                <Stat label="Per day" value={formatUGX(Number(row.daily_amount))} tone="text-primary" />
                <Stat label="Duration" value={`${row.duration_value} ${row.duration_unit} (${row.duration_days}d)`} />
                <Stat label="Expected so far" value={formatUGX(Number(row.expected_to_date))} />
              </div>
              <p className="text-[11px] text-muted-foreground">
                {format(new Date(row.start_date), 'dd MMM yyyy')} → {format(new Date(row.end_date), 'dd MMM yyyy')}
              </p>

              <div className="space-y-1.5">
                <p className="text-[11px] font-medium text-muted-foreground">Who pays it</p>
                {row.splits.length === 0 ? (
                  <p className="text-[11px] text-muted-foreground">Not yet distributed between agents.</p>
                ) : (
                  row.splits.map((s) => (
                    <div key={s.agent_id} className="flex items-center gap-2 rounded-lg bg-muted/40 p-2">
                      <span className="min-w-0 flex-1 truncate text-xs">{s.agent_name}</span>
                      <span className="shrink-0 text-[10px] text-muted-foreground">
                        {Number(s.share_percent)}%
                      </span>
                      <span className="w-24 shrink-0 text-right font-mono text-xs tabular-nums">
                        {formatUGX(Number(s.daily_amount))}
                      </span>
                    </div>
                  ))
                )}
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}

function Stat({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <div className="rounded-xl border border-border bg-card p-3">
      <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">{label}</p>
      <p className={`mt-1 font-mono text-sm font-bold tabular-nums ${tone ?? ''}`}>{value}</p>
    </div>
  );
}
