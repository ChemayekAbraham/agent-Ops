/**
 * Read-only location reconciliation report.
 *
 * Per operational table: total rows, rows resolved to an official Ugandan
 * administrative unit (ug_* id or exact dataset name match), rows still
 * unmatched, and the most frequent unmatched values — plus the same split for
 * records created since the reference-data rollout, which should be 100%.
 *
 * This panel NEVER writes: it only reads get_location_reconciliation_report().
 */
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ChevronDown, ChevronRight, Loader2, MapPinned, RefreshCw, AlertTriangle } from 'lucide-react';
import { supabase } from '@/integrations/supabase/client';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';

interface Row {
  table_label: string;
  scope_label: string;
  total_rows: number;
  resolved_rows: number;
  unmatched_rows: number;
  resolved_pct: number;
  new_total_rows: number;
  new_resolved_rows: number;
  top_unmatched: { value: string; rows: number }[] | null;
}

export function LocationReconciliationCard() {
  const [open, setOpen] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);

  const { data, isLoading, error, refetch, isFetching } = useQuery({
    queryKey: ['location-reconciliation-report'],
    enabled: open,
    staleTime: 5 * 60 * 1000,
    queryFn: async (): Promise<Row[]> => {
      const { data, error } = await supabase.rpc('get_location_reconciliation_report' as never, {} as never);
      if (error) throw error;
      return (data ?? []) as unknown as Row[];
    },
  });

  const nf = (n: number) => n.toLocaleString();

  return (
    <div className="rounded-xl border border-border bg-card">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center gap-2 p-3 text-left"
      >
        <MapPinned className="h-4 w-4 text-primary" />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold">Location reconciliation report</p>
          <p className="text-[11px] text-muted-foreground">
            Read-only — how many rows resolve to an official district / village
          </p>
        </div>
        {open ? <ChevronDown className="h-4 w-4 text-muted-foreground" /> : <ChevronRight className="h-4 w-4 text-muted-foreground" />}
      </button>

      {open && (
        <div className="space-y-2 border-t border-border p-3">
          <div className="flex items-center justify-between">
            <p className="text-[11px] text-muted-foreground">No data is changed by this report.</p>
            <Button size="sm" variant="outline" className="h-7 gap-1 text-xs" onClick={() => refetch()} disabled={isFetching}>
              <RefreshCw className={`h-3 w-3 ${isFetching ? 'animate-spin' : ''}`} /> Refresh
            </Button>
          </div>

          {isLoading ? (
            <p className="flex items-center gap-2 py-4 text-xs text-muted-foreground">
              <Loader2 className="h-3.5 w-3.5 animate-spin" /> Counting resolved locations…
            </p>
          ) : error ? (
            <p className="flex items-start gap-2 rounded-lg border border-destructive/40 bg-destructive/5 p-2 text-xs text-destructive">
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              {(error as Error).message}
            </p>
          ) : (data ?? []).length === 0 ? (
            <p className="py-4 text-xs text-muted-foreground">Nothing to reconcile.</p>
          ) : (
            <div className="space-y-2">
              {(data ?? []).map((r) => {
                const newOk = r.new_total_rows > 0 && r.new_resolved_rows === r.new_total_rows;
                const isOpen = expanded === r.table_label;
                return (
                  <div key={r.table_label} className="rounded-lg border border-border/70 bg-muted/20 p-2.5">
                    <div className="flex flex-wrap items-center gap-2">
                      <p className="min-w-0 flex-1 text-sm font-semibold">{r.table_label}</p>
                      <Badge variant={r.resolved_pct >= 95 ? 'default' : r.resolved_pct >= 50 ? 'secondary' : 'outline'}>
                        {r.resolved_pct}% resolved
                      </Badge>
                    </div>
                    <p className="text-[11px] text-muted-foreground">{r.scope_label}</p>
                    <div className="mt-1.5 grid grid-cols-3 gap-2 text-center">
                      <div><p className="text-sm font-bold">{nf(r.total_rows)}</p><p className="text-[10px] text-muted-foreground">total</p></div>
                      <div><p className="text-sm font-bold text-success">{nf(r.resolved_rows)}</p><p className="text-[10px] text-muted-foreground">official unit</p></div>
                      <div><p className="text-sm font-bold text-warning">{nf(r.unmatched_rows)}</p><p className="text-[10px] text-muted-foreground">unmatched</p></div>
                    </div>
                    <p className={`mt-1.5 text-[11px] ${newOk ? 'text-success' : r.new_total_rows === 0 ? 'text-muted-foreground' : 'text-warning'}`}>
                      Since rollout: {nf(r.new_resolved_rows)} / {nf(r.new_total_rows)} resolved
                      {r.new_total_rows === 0 ? ' (no new rows yet)' : newOk ? ' — fully resolved ✓' : ''}
                    </p>
                    {r.unmatched_rows > 0 && (
                      <>
                        <button
                          type="button"
                          onClick={() => setExpanded(isOpen ? null : r.table_label)}
                          className="mt-1 text-[11px] font-medium text-primary hover:underline"
                        >
                          {isOpen ? 'Hide' : 'Show'} most frequent unmatched values
                        </button>
                        {isOpen && (
                          <ul className="mt-1 space-y-0.5">
                            {(r.top_unmatched ?? []).map((u) => (
                              <li key={u.value} className="flex items-center justify-between gap-2 text-[11px]">
                                <span className="truncate">{u.value}</span>
                                <span className="shrink-0 text-muted-foreground">{nf(u.rows)} rows</span>
                              </li>
                            ))}
                          </ul>
                        )}
                      </>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export default LocationReconciliationCard;
