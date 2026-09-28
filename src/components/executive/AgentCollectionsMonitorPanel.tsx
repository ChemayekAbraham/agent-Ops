import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { formatUGX } from '@/lib/rentCalculations';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import {
  Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { Activity, RefreshCw, CheckCircle2, AlertTriangle, AlertOctagon, Info } from 'lucide-react';
import { format, parseISO } from 'date-fns';

/**
 * Health checks over the agent collection path.
 *
 * Every check here fires on real production data — measured before it was
 * written, because a monitor built from imagination is a monitor nobody trusts.
 * Checks that currently return zero are kept deliberately: their value is that
 * they are watching, and a zero turning into a one is the whole point.
 *
 * WHAT IS DELIBERATELY ABSENT. "Collected more than today's bill" looks like
 * the obvious over-collection test and it is wrong — it fires 734 times in 14
 * days and every one is a tenant clearing arrears, which is the behaviour we
 * want. It would bury the real findings. The honest over-collection test is per
 * PLAN: `plan_overpaid`, where a tenant has repaid more than the Rent Plan was
 * ever worth.
 *
 * TWO CHECKS WATCH THE PLAN BALANCE, NOT THE RECEIPT BOOK, and they are the
 * ones that explain a leaderboard figure looking too big.
 * `rent_requests.amount_repaid` is a column with fifteen writers, so no
 * reader-side reversal filter can reach it — which is why the 72-function
 * sweep of 10–16 September left it untouched:
 *
 *   - `plan_balance_holds_reversed` — reversed money still inside a tenant's
 *     balance. 25 of these match live + reversed to the shilling.
 *   - `plan_balance_unbacked` — balance above every cash record we hold. Ships
 *     as info: mostly historical, and partly legitimate settlement that neither
 *     `agent_collections` nor `repayments` records.
 */

const RANGES = [7, 14, 30] as const;

interface CheckRow {
  check_key: string;
  label: string;
  severity: 'critical' | 'high' | 'medium' | 'info';
  hits: number;
  exposure_ugx: number;
  oldest: string | null;
  newest: string | null;
  guidance: string;
}

interface DetailRow {
  collection_id: string | null;
  occurred_at: string;
  agent_name: string | null;
  agent_phone: string | null;
  tenant_name: string | null;
  rent_request_id: string | null;
  amount: number;
  detail: string | null;
}

const num = (v: unknown) => Number(v ?? 0) || 0;

const SEVERITY: Record<CheckRow['severity'], { icon: typeof Info; cls: string; label: string }> = {
  critical: { icon: AlertOctagon, cls: 'text-destructive', label: 'critical' },
  high: { icon: AlertTriangle, cls: 'text-orange-600 dark:text-orange-400', label: 'high' },
  medium: { icon: AlertTriangle, cls: 'text-amber-600 dark:text-amber-400', label: 'medium' },
  info: { icon: Info, cls: 'text-muted-foreground', label: 'info' },
};

const rpc = (fn: string, args: Record<string, unknown>) =>
  (supabase as never as {
    rpc: (f: string, a: Record<string, unknown>) => Promise<{ data: unknown; error: Error | null }>;
  }).rpc(fn, args);

export function AgentCollectionsMonitorPanel() {
  const [days, setDays] = useState<number>(14);
  const [open, setOpen] = useState<CheckRow | null>(null);

  const { data, isLoading, isFetching, error, refetch } = useQuery({
    queryKey: ['agent-collections-monitor', days],
    queryFn: async () => {
      const { data, error } = await rpc('agent_collections_monitor', { p_days: days });
      if (error) throw error;
      return (data ?? []) as CheckRow[];
    },
    refetchInterval: 5 * 60_000,
    staleTime: 60_000,
  });

  const detail = useQuery({
    queryKey: ['agent-collections-monitor-detail', open?.check_key, days],
    enabled: !!open && num(open?.hits) > 0,
    queryFn: async () => {
      const { data, error } = await rpc('agent_collections_monitor_detail', {
        p_check_key: open!.check_key, p_days: days, p_limit: 100,
      });
      if (error) throw error;
      return (data ?? []) as DetailRow[];
    },
  });

  const checks = useMemo(() => data ?? [], [data]);
  const firing = useMemo(() => checks.filter(c => num(c.hits) > 0), [checks]);
  const clean = useMemo(() => checks.filter(c => num(c.hits) === 0), [checks]);
  const needsAction = useMemo(
    () => firing.filter(c => c.severity === 'critical' || c.severity === 'high'),
    [firing],
  );

  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between gap-2">
        <div>
          <CardTitle className="flex items-center gap-2">
            <Activity className="h-5 w-5 text-primary" />
            Agent Collections Monitor
          </CardTitle>
          <CardDescription>
            Faults in the collection path, so they can be repaired while still small. Every check
            is measured against production; a check reading zero is watching, not missing.
          </CardDescription>
        </div>
        <div className="flex items-center gap-1.5">
          {RANGES.map(d => (
            <Button key={d} size="sm" variant={days === d ? 'default' : 'outline'}
                    className="h-7 text-xs" onClick={() => setDays(d)}>
              {d}d
            </Button>
          ))}
          <Button size="sm" variant="ghost" className="h-7" onClick={() => void refetch()}>
            <RefreshCw className={`h-3.5 w-3.5 ${isFetching ? 'animate-spin' : ''}`} />
          </Button>
        </div>
      </CardHeader>

      <CardContent className="space-y-4">
        {error && <p className="text-sm text-destructive">Could not run the checks: {(error as Error).message}</p>}

        {!error && !isLoading && (
          <div className={`rounded-lg border p-3 ${needsAction.length ? 'border-destructive/40 bg-destructive/5' : 'border-emerald-500/30 bg-emerald-500/5'}`}>
            {needsAction.length ? (
              <p className="text-sm">
                <strong className="text-destructive">{needsAction.length} check{needsAction.length > 1 ? 's' : ''} needing attention</strong>
                {' — '}{needsAction.map(c => c.label).join(' · ')}
              </p>
            ) : (
              <p className="flex items-center gap-2 text-sm text-emerald-700 dark:text-emerald-400">
                <CheckCircle2 className="h-4 w-4" /> No critical or high-severity faults in the last {days} days.
              </p>
            )}
          </div>
        )}

        {firing.length > 0 && (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="text-xs">Check</TableHead>
                <TableHead className="text-right text-xs">Hits</TableHead>
                <TableHead className="text-right text-xs">Exposure</TableHead>
                <TableHead className="text-xs">Most recent</TableHead>
                <TableHead className="text-xs">What to do</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {firing.map(c => {
                const S = SEVERITY[c.severity] ?? SEVERITY.info;
                const Icon = S.icon;
                return (
                  <TableRow
                    key={c.check_key}
                    className="cursor-pointer hover:bg-muted/50"
                    onClick={() => setOpen(c)}
                  >
                    <TableCell>
                      <div className="flex items-center gap-1.5 font-medium">
                        <Icon className={`h-3.5 w-3.5 ${S.cls}`} />
                        {c.label}
                      </div>
                      <Badge variant="outline" className="mt-0.5 px-1 py-0 text-[9px]">{S.label}</Badge>
                    </TableCell>
                    <TableCell className="text-right tabular-nums font-semibold">{num(c.hits)}</TableCell>
                    <TableCell className="text-right tabular-nums">{formatUGX(num(c.exposure_ugx))}</TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {c.newest ? format(parseISO(c.newest), 'dd MMM HH:mm') : '—'}
                    </TableCell>
                    <TableCell className="max-w-[320px] text-xs text-muted-foreground">{c.guidance}</TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        )}

        {clean.length > 0 && (
          <div>
            <p className="mb-1.5 text-xs font-medium text-muted-foreground">Clean</p>
            <div className="flex flex-wrap gap-1.5">
              {clean.map(c => (
                <Badge key={c.check_key} variant="outline" className="gap-1 text-[10px] font-normal">
                  <CheckCircle2 className="h-3 w-3 text-emerald-600" />
                  {c.label}
                </Badge>
              ))}
            </div>
          </div>
        )}
      </CardContent>

      <Dialog open={!!open} onOpenChange={o => !o && setOpen(null)}>
        <DialogContent className="max-w-3xl">
          <DialogHeader>
            <DialogTitle>{open?.label}</DialogTitle>
            <DialogDescription>{open?.guidance}</DialogDescription>
          </DialogHeader>
          {detail.isLoading && <p className="py-6 text-center text-sm text-muted-foreground">Loading…</p>}
          {detail.data && detail.data.length > 0 && (
            <div className="max-h-[55vh] overflow-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="text-xs">When</TableHead>
                    <TableHead className="text-xs">Agent</TableHead>
                    <TableHead className="text-xs">Tenant</TableHead>
                    <TableHead className="text-right text-xs">Amount</TableHead>
                    <TableHead className="text-xs">Detail</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {detail.data.map((r, i) => (
                    <TableRow key={`${r.collection_id ?? r.rent_request_id}-${i}`}>
                      <TableCell className="text-xs">{format(parseISO(r.occurred_at), 'dd MMM HH:mm')}</TableCell>
                      <TableCell className="text-xs">
                        {r.agent_name || '—'}
                        {r.agent_phone && <div className="text-muted-foreground">{r.agent_phone}</div>}
                      </TableCell>
                      <TableCell className="text-xs">{r.tenant_name || '—'}</TableCell>
                      <TableCell className="text-right text-xs tabular-nums">{formatUGX(num(r.amount))}</TableCell>
                      <TableCell className="max-w-[240px] truncate text-xs text-muted-foreground" title={r.detail ?? ''}>
                        {r.detail || '—'}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
          {detail.data && detail.data.length === 0 && !detail.isLoading && (
            <p className="py-6 text-center text-sm text-muted-foreground">No rows to show.</p>
          )}
        </DialogContent>
      </Dialog>
    </Card>
  );
}

export default AgentCollectionsMonitorPanel;
