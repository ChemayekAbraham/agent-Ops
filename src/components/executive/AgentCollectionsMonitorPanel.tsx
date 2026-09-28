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
import { Activity, RefreshCw, CheckCircle2, AlertTriangle, AlertOctagon, Info, ScrollText } from 'lucide-react';
import { format, parseISO, formatDistanceToNowStrict } from 'date-fns';

/**
 * Two things, and they answer different questions.
 *
 * THE ERROR LOG answers "what went wrong while an agent was trying to collect".
 * Events, with a timestamp, newest first. This is the part that catches a fault
 * on the day it starts. It draws on four places a collection fault shows up:
 *
 *   engine  — failures the agent's own device reported (insufficient float, a
 *             stalled network where the payment was NOT recorded, a structured
 *             rejection), plus float recorded as spent that never left the
 *             wallet — the signature of the 15–16 September gate failure.
 *   anomaly — the anomaly detector's own findings on collections that did post.
 *   app     — what the agent app crashed on. A chunk that will not load or an
 *             IndexedDB transaction closing mid-write is a collection that did
 *             not happen, even though no RPC was ever reached.
 *
 * THE HEALTH CHECKS answer "what is wrong with the data right now". Conditions,
 * not events. Every one was measured against production before it was written —
 * a monitor built from imagination is a monitor nobody trusts — and the ones
 * reading zero are kept deliberately, because a zero turning into a one is the
 * whole point.
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
 * sweep of 10–16 September left it untouched.
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

interface ErrorRow {
  occurred_at: string;
  source: 'engine' | 'anomaly' | 'app';
  severity: string;
  phase: string | null;
  error_code: string | null;
  message: string;
  agent_name: string | null;
  agent_phone: string | null;
  tenant_name: string | null;
  amount: number | null;
  rent_request_id: string | null;
  detail: string | null;
}

interface ErrorSummaryRow {
  source: string;
  severity: string;
  hits: number;
  newest: string | null;
}

const num = (v: unknown) => Number(v ?? 0) || 0;

const SEVERITY: Record<string, { icon: typeof Info; cls: string; label: string }> = {
  critical: { icon: AlertOctagon, cls: 'text-destructive', label: 'critical' },
  high: { icon: AlertTriangle, cls: 'text-orange-600 dark:text-orange-400', label: 'high' },
  error: { icon: AlertTriangle, cls: 'text-destructive', label: 'error' },
  medium: { icon: AlertTriangle, cls: 'text-amber-600 dark:text-amber-400', label: 'medium' },
  warning: { icon: AlertTriangle, cls: 'text-amber-600 dark:text-amber-400', label: 'warning' },
  info: { icon: Info, cls: 'text-muted-foreground', label: 'info' },
};
const sev = (s: string) => SEVERITY[s] ?? SEVERITY.info;

const SOURCES = [
  { key: null as string | null, label: 'All' },
  { key: 'engine', label: 'Engine' },
  { key: 'anomaly', label: 'Anomaly' },
  { key: 'app', label: 'Agent app' },
];

const SOURCE_TONE: Record<string, string> = {
  engine: 'border-destructive/40 text-destructive',
  anomaly: 'border-orange-500/40 text-orange-600 dark:text-orange-400',
  app: 'border-muted-foreground/30 text-muted-foreground',
};

const rpc = (fn: string, args: Record<string, unknown>) =>
  (supabase as never as {
    rpc: (f: string, a: Record<string, unknown>) => Promise<{ data: unknown; error: Error | null }>;
  }).rpc(fn, args);

export function AgentCollectionsMonitorPanel() {
  const [days, setDays] = useState<number>(14);
  const [open, setOpen] = useState<CheckRow | null>(null);
  const [source, setSource] = useState<string | null>(null);
  const [showAllErrors, setShowAllErrors] = useState(false);

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

  // Counted at source rather than from the log, which caps at 500 rows — a busy
  // day would otherwise under-report exactly when the panel matters most.
  const summary = useQuery({
    queryKey: ['agent-collections-error-summary', days],
    queryFn: async () => {
      const { data, error } = await rpc('agent_collections_error_summary', { p_days: days });
      if (error) throw error;
      return (data ?? []) as ErrorSummaryRow[];
    },
    refetchInterval: 2 * 60_000,
    staleTime: 30_000,
  });

  const errors = useQuery({
    queryKey: ['agent-collections-error-log', days, source],
    queryFn: async () => {
      const { data, error } = await rpc('agent_collections_error_log', {
        p_days: days, p_limit: 200, p_source: source,
      });
      if (error) throw error;
      return (data ?? []) as ErrorRow[];
    },
    refetchInterval: 2 * 60_000,
    staleTime: 30_000,
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

  const errorRows = useMemo(() => errors.data ?? [], [errors.data]);
  const visibleErrors = useMemo(
    () => (showAllErrors ? errorRows : errorRows.slice(0, 25)),
    [errorRows, showAllErrors],
  );
  const summaryRows = useMemo(
    () => [...(summary.data ?? [])].sort((a, b) => num(b.hits) - num(a.hits)),
    [summary.data],
  );
  const serious = useMemo(
    () => summaryRows.filter(r => r.severity === 'critical' || r.severity === 'error' || r.severity === 'high'),
    [summaryRows],
  );

  const refreshAll = () => {
    void refetch();
    void summary.refetch();
    void errors.refetch();
  };

  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between gap-2">
        <div>
          <CardTitle className="flex items-center gap-2">
            <Activity className="h-5 w-5 text-primary" />
            Agent Collections Monitor
          </CardTitle>
          <CardDescription>
            What went wrong while agents were collecting, and what is wrong with the data now.
            Every check is measured against production; a check reading zero is watching, not missing.
          </CardDescription>
        </div>
        <div className="flex items-center gap-1.5">
          {RANGES.map(d => (
            <Button key={d} size="sm" variant={days === d ? 'default' : 'outline'}
                    className="h-7 text-xs" onClick={() => setDays(d)}>
              {d}d
            </Button>
          ))}
          <Button size="sm" variant="ghost" className="h-7" onClick={refreshAll}>
            <RefreshCw className={`h-3.5 w-3.5 ${isFetching || errors.isFetching ? 'animate-spin' : ''}`} />
          </Button>
        </div>
      </CardHeader>

      <CardContent className="space-y-6">
        {/* ---------------- Error log ---------------- */}
        <section className="space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <ScrollText className="h-4 w-4 text-destructive" />
            <h3 className="text-sm font-semibold">Error log</h3>
            <span className="text-[11px] text-muted-foreground">
              faults as they happened, newest first
            </span>
            <div className="ml-auto flex flex-wrap gap-1">
              {SOURCES.map(s => (
                <Button
                  key={s.label}
                  size="sm"
                  variant={source === s.key ? 'default' : 'outline'}
                  className="h-6 px-2 text-[11px]"
                  onClick={() => { setSource(s.key); setShowAllErrors(false); }}
                >
                  {s.label}
                </Button>
              ))}
            </div>
          </div>

          {summaryRows.length > 0 && (
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              {summaryRows.slice(0, 4).map(r => {
                const S = sev(r.severity);
                return (
                  <div key={`${r.source}-${r.severity}`} className="rounded-lg border p-2.5">
                    <div className="flex items-center gap-1 text-[10px] uppercase tracking-wide text-muted-foreground">
                      <S.icon className={`h-3 w-3 ${S.cls}`} />
                      {r.source} · {r.severity}
                    </div>
                    <div className="mt-0.5 text-sm font-bold tabular-nums">{num(r.hits)}</div>
                    <div className="text-[10px] text-muted-foreground">
                      {r.newest ? `last ${formatDistanceToNowStrict(parseISO(r.newest))} ago` : '—'}
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          {errors.error && (
            <p className="text-sm text-destructive">Could not read the log: {(errors.error as Error).message}</p>
          )}

          {!errors.error && !errors.isLoading && errorRows.length === 0 && (
            <p className="flex items-center gap-2 rounded-lg border border-emerald-500/30 bg-emerald-500/5 p-3 text-sm text-emerald-700 dark:text-emerald-400">
              <CheckCircle2 className="h-4 w-4" /> No collection errors recorded in the last {days} days.
            </p>
          )}

          {visibleErrors.length > 0 && (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="text-xs">When</TableHead>
                    <TableHead className="text-xs">Source</TableHead>
                    <TableHead className="text-xs">What happened</TableHead>
                    <TableHead className="text-xs">Agent</TableHead>
                    <TableHead className="text-right text-xs">Amount</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {visibleErrors.map((r, i) => {
                    const S = sev(r.severity);
                    return (
                      <TableRow key={`${r.occurred_at}-${i}`}>
                        <TableCell className="whitespace-nowrap text-xs">
                          {format(parseISO(r.occurred_at), 'dd MMM HH:mm')}
                          <div className="text-[10px] text-muted-foreground">
                            {formatDistanceToNowStrict(parseISO(r.occurred_at))} ago
                          </div>
                        </TableCell>
                        <TableCell>
                          <Badge variant="outline" className={`px-1 py-0 text-[9px] ${SOURCE_TONE[r.source] ?? ''}`}>
                            {r.source}
                          </Badge>
                          <div className="mt-0.5 flex items-center gap-1 text-[10px] text-muted-foreground">
                            <S.icon className={`h-2.5 w-2.5 ${S.cls}`} />
                            {S.label}
                          </div>
                        </TableCell>
                        <TableCell className="max-w-[340px] text-xs">
                          <div className="font-medium">{r.message}</div>
                          {(r.error_code || r.detail) && (
                            <div className="truncate text-[10px] text-muted-foreground" title={r.detail ?? ''}>
                              {[r.error_code, r.phase, r.detail].filter(Boolean).join(' · ')}
                            </div>
                          )}
                        </TableCell>
                        <TableCell className="text-xs">
                          {r.agent_name || '—'}
                          {r.tenant_name && (
                            <div className="text-[10px] text-muted-foreground">for {r.tenant_name}</div>
                          )}
                        </TableCell>
                        <TableCell className="text-right text-xs tabular-nums">
                          {r.amount ? formatUGX(num(r.amount)) : '—'}
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </div>
          )}

          {errorRows.length > visibleErrors.length && (
            <Button variant="outline" size="sm" className="w-full" onClick={() => setShowAllErrors(true)}>
              Show all {errorRows.length}
            </Button>
          )}
          {serious.length > 0 && (
            <p className="text-[11px] text-muted-foreground">
              An <strong>engine</strong> row is a failure the collection path itself hit. An{' '}
              <strong>anomaly</strong> row is a collection that posted and then failed a rule. An{' '}
              <strong>agent app</strong> row is a crash on the agent&apos;s phone — no RPC was ever
              reached, so the collection simply did not happen.
            </p>
          )}
        </section>

        {/* ---------------- Health checks ---------------- */}
        <section className="space-y-3 border-t pt-4">
          <div className="flex items-center gap-2">
            <Activity className="h-4 w-4 text-primary" />
            <h3 className="text-sm font-semibold">Health checks</h3>
            <span className="text-[11px] text-muted-foreground">the state of the data right now</span>
          </div>

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
                  const S = sev(c.severity);
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
        </section>
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
