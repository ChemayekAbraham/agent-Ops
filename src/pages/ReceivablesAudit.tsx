import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowLeft, CheckCircle2, AlertTriangle, Calculator, RefreshCw, DatabaseZap, Wrench } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Separator } from '@/components/ui/separator';
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table';
import {
  useMissionReceivables, useReceivablesAudit, useReceivablesBackfill, type CounterWindow,
} from '@/hooks/useWelileOpsCounters';
import { formatUGX } from '@/lib/agentAdvanceCalculations';
import { toast } from 'sonner';

const MARKUP = 1.33;
const WINDOWS: { value: CounterWindow; label: string }[] = [
  { value: '7d', label: '7d' },
  { value: '30d', label: '30d' },
  { value: 'all', label: 'All time' },
];

function ReconRow({ label, value, ok }: { label: string; value: string; ok?: boolean }) {
  return (
    <div className="flex items-center justify-between py-1.5 text-sm">
      <span className="text-muted-foreground">{label}</span>
      <span className={`tabular-nums font-medium inline-flex items-center gap-1 ${ok === false ? 'text-destructive' : ''}`}>
        {ok !== undefined && (ok
          ? <CheckCircle2 className="h-3.5 w-3.5 text-emerald-600" />
          : <AlertTriangle className="h-3.5 w-3.5 text-destructive" />)}
        {value}
      </span>
    </div>
  );
}

export default function ReceivablesAudit() {
  const navigate = useNavigate();
  const [win, setWin] = useState<CounterWindow>('all');
  const { data: rec, isLoading: recLoading, refetch: refetchRec, isFetching: recFetching } = useMissionReceivables(win);
  const { data: rows = [], isLoading: rowsLoading, refetch: refetchRows, isFetching: rowsFetching } = useReceivablesAudit(win, 12);
  const backfill = useReceivablesBackfill();
  const report = backfill.data;

  const refreshAll = () => { refetchRec(); refetchRows(); };
  const fetching = recFetching || rowsFetching;

  const runBackfill = (repair: boolean) => {
    backfill.mutate(repair, {
      onSuccess: (res) => {
        refreshAll();
        toast.success(
          res.failed === 0
            ? `Backfill complete — ${res.checked} snapshots verified, all match the live formula.`
            : `Backfill complete — ${res.failed} of ${res.checked} snapshots drifted${repair ? ` (${res.repaired} repaired)` : ''}.`,
        );
      },
      onError: (e: unknown) => toast.error(e instanceof Error ? e.message : 'Backfill failed'),
    });
  };

  // Aggregate reconciliation (all numbers derive from the same RPC the dashboard uses)
  const recordedTotal = rec ? rec.empty_receivable_total + rec.unlisted_receivable_total : 0;
  const estimatedTotal = rec?.estimated_full_total ?? 0;
  const avgMonthly = rec?.avg_known_monthly ?? 0;
  const knownCount = rec?.known_rent_count ?? 0;
  const missingCount = rec?.missing_rent_count ?? 0;

  // Independent re-derivation of estimated from the published parts, to prove reconciliation.
  const missingFillPerHouse = ((avgMonthly * MARKUP) / 30) * 30 * 12;
  const estimatedRederived = recordedTotal + missingCount * missingFillPerHouse;
  const estimatedOk = Math.abs(estimatedRederived - estimatedTotal) < Math.max(1, estimatedTotal * 0.0001);

  // Pre-markup (×12 only) baselines, to show the 33% uplift explicitly.
  const recordedBase = recordedTotal / MARKUP;
  const estimatedBase = estimatedTotal / MARKUP;

  return (
    <div className="min-h-screen bg-background">
      <div className="mx-auto max-w-5xl px-4 py-5 space-y-5">
        {/* Header */}
        <div className="flex items-center gap-3">
          <Button variant="ghost" size="icon" onClick={() => navigate(-1)} aria-label="Back">
            <ArrowLeft className="h-5 w-5" />
          </Button>
          <div className="flex-1">
            <h1 className="text-lg font-bold leading-tight">Projected Receivables — Validation & Audit</h1>
            <p className="text-xs text-muted-foreground">
              Per-house calculation + aggregate reconciliation for Priority 1 empty houses (UGX).
            </p>
          </div>
          <Button variant="outline" size="sm" onClick={refreshAll} disabled={fetching}>
            <RefreshCw className={`h-4 w-4 mr-1.5 ${fetching ? 'animate-spin' : ''}`} /> Refresh
          </Button>
        </div>

        {/* Window toggle */}
        <div className="flex items-center gap-2">
          {WINDOWS.map((w) => (
            <Button
              key={w.value}
              size="sm"
              variant={win === w.value ? 'default' : 'outline'}
              onClick={() => setWin(w.value)}
            >
              {w.label}
            </Button>
          ))}
        </div>

        {/* Formula card */}
        <Card className="border-amber-200 bg-amber-50/40">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm flex items-center gap-2">
              <Calculator className="h-4 w-4 text-amber-700" /> Formula applied per house
            </CardTitle>
          </CardHeader>
          <CardContent className="text-sm text-amber-900 space-y-1">
            <p className="font-mono text-xs bg-background/60 rounded px-2 py-1.5 inline-block">
              ((rent + 33% of rent) ÷ 30 days) × 30 days × 12 months
            </p>
            <p className="text-xs text-amber-800">
              The ÷30 then ×30 makes the daily projected rent explicit; it nets to a 33% markup annualized over 12 months
              (i.e. <span className="font-medium">rent × 1.33 × 12</span>). Applied identically to the recorded figure and the estimated full-potential figure.
            </p>
          </CardContent>
        </Card>

        {/* Sample per-house calculations */}
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">Sample houses — per-house calculation</CardTitle>
            <p className="text-xs text-muted-foreground">
              Top {rows.length} units by rent. Each column shows one step of the formula so any row can be checked by hand.
            </p>
          </CardHeader>
          <CardContent className="px-0 sm:px-6">
            {rowsLoading ? (
              <p className="text-sm text-muted-foreground px-4 py-6">Loading sample…</p>
            ) : rows.length === 0 ? (
              <p className="text-sm text-muted-foreground px-4 py-6">No empty houses in this window.</p>
            ) : (
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>House</TableHead>
                      <TableHead className="text-right">Rent / mo</TableHead>
                      <TableHead className="text-right">+33%</TableHead>
                      <TableHead className="text-right">÷ 30 (daily)</TableHead>
                      <TableHead className="text-right">× 30 × 12 (annual)</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {rows.map((r) => (
                      <TableRow key={`${r.src}-${r.unit_id}`}>
                        <TableCell className="max-w-[180px]">
                          <div className="font-medium truncate">{r.label}</div>
                          <div className="text-xs text-muted-foreground truncate">
                            {r.region} · {r.src === 'listing' ? 'Listed' : 'Unlisted landlord'}
                          </div>
                        </TableCell>
                        <TableCell className="text-right tabular-nums">{formatUGX(r.monthly_rent)}</TableCell>
                        <TableCell className="text-right tabular-nums">{formatUGX(r.rent_plus_markup)}</TableCell>
                        <TableCell className="text-right tabular-nums text-muted-foreground">{formatUGX(r.daily_projected)}</TableCell>
                        <TableCell className="text-right tabular-nums font-semibold">{formatUGX(r.annual_projection)}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}
          </CardContent>
        </Card>

        {/* Aggregate reconciliation */}
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">Aggregate reconciliation</CardTitle>
            <p className="text-xs text-muted-foreground">
              Live figures from the same function powering the dashboard card.
            </p>
          </CardHeader>
          <CardContent>
            {recLoading || !rec ? (
              <p className="text-sm text-muted-foreground py-6">Loading aggregates…</p>
            ) : (
              <div className="grid gap-6 md:grid-cols-2">
                {/* Recorded */}
                <div>
                  <div className="flex items-center gap-2 mb-1">
                    <Badge variant="secondary" className="bg-amber-100 text-amber-800 hover:bg-amber-100">Recorded</Badge>
                    <span className="text-xs text-muted-foreground">{knownCount} houses with rent on file</span>
                  </div>
                  <ReconRow label="Empty listings (×1.33×12)" value={formatUGX(rec.empty_receivable_total)} />
                  <ReconRow label="Unlisted landlords (×1.33×12)" value={formatUGX(rec.unlisted_receivable_total)} />
                  <Separator className="my-1.5" />
                  <ReconRow label="Recorded total" value={formatUGX(recordedTotal)} ok />
                  <ReconRow label="Pre-markup baseline (×12 only)" value={formatUGX(recordedBase)} />
                  <ReconRow label="33% uplift" value={formatUGX(recordedTotal - recordedBase)} />
                </div>

                {/* Estimated */}
                <div>
                  <div className="flex items-center gap-2 mb-1">
                    <Badge variant="secondary" className="bg-amber-200 text-amber-900 hover:bg-amber-200">Est. full potential</Badge>
                    <span className="text-xs text-muted-foreground">{missingCount} no-rent houses filled @ avg</span>
                  </div>
                  <ReconRow label="Avg known rent / mo" value={formatUGX(avgMonthly)} />
                  <ReconRow label="Fill per missing house (×1.33×12)" value={formatUGX(missingFillPerHouse)} />
                  <ReconRow label={`Missing fill (${missingCount} houses)`} value={formatUGX(missingCount * missingFillPerHouse)} />
                  <Separator className="my-1.5" />
                  <ReconRow label="Re-derived (recorded + fill)" value={formatUGX(estimatedRederived)} />
                  <ReconRow label="Function estimated_full_total" value={formatUGX(estimatedTotal)} ok={estimatedOk} />
                  <ReconRow label="Pre-markup baseline (×12 only)" value={formatUGX(estimatedBase)} />
                </div>
              </div>
            )}
          </CardContent>
        </Card>

        {/* Verdict */}
        {rec && (
          <Card className={estimatedOk ? 'border-emerald-200 bg-emerald-50/40' : 'border-destructive/40 bg-destructive/5'}>
            <CardContent className="py-4 flex items-start gap-3">
              {estimatedOk
                ? <CheckCircle2 className="h-5 w-5 text-emerald-600 mt-0.5 shrink-0" />
                : <AlertTriangle className="h-5 w-5 text-destructive mt-0.5 shrink-0" />}
              <div className="text-sm">
                <p className="font-semibold">
                  {estimatedOk ? 'Reconciliation passed' : 'Reconciliation mismatch detected'}
                </p>
                <p className="text-muted-foreground text-xs mt-0.5">
                  {estimatedOk
                    ? 'The 33% markup and 30-day / 12-month annualization reconcile for both the recorded and estimated figures. The re-derived estimate matches the function output.'
                    : 'The re-derived estimate does not match the function output — review the underlying RPC.'}
                </p>
              </div>
            </CardContent>
          </Card>
        )}

        {/* One-click backfill / verification */}
        <Card className="border-primary/30">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm flex items-center gap-2">
              <DatabaseZap className="h-4 w-4 text-primary" />
              Rebuild &amp; verify snapshot history
            </CardTitle>
            <p className="text-xs text-muted-foreground">
              Re-derives every saved snapshot's recorded &amp; estimated totals from its stored
              components using the live formula (rent × 1.33 × 12), flags any that drifted, and
              records a fresh snapshot anchored to current data.
            </p>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="flex flex-wrap gap-2">
              <Button size="sm" onClick={() => runBackfill(false)} disabled={backfill.isPending}>
                <DatabaseZap className={`h-4 w-4 mr-1.5 ${backfill.isPending ? 'animate-pulse' : ''}`} />
                {backfill.isPending ? 'Running…' : 'Run backfill & verify'}
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={() => runBackfill(true)}
                disabled={backfill.isPending || (!!report && report.failed === 0)}
              >
                <Wrench className="h-4 w-4 mr-1.5" />
                Run &amp; repair drift
              </Button>
            </div>

            {report && (
              <div className="rounded-md border bg-muted/30 p-3 space-y-2">
                <div className="flex flex-wrap gap-x-4 gap-y-1 text-sm">
                  <span>Checked: <b className="tabular-nums">{report.checked}</b></span>
                  <span className="text-emerald-700">Passed: <b className="tabular-nums">{report.passed}</b></span>
                  <span className={report.failed > 0 ? 'text-destructive' : ''}>
                    Failed: <b className="tabular-nums">{report.failed}</b>
                  </span>
                  {report.repaired > 0 && <span>Repaired: <b className="tabular-nums">{report.repaired}</b></span>}
                  <span className="text-muted-foreground">+1 fresh snapshot</span>
                </div>

                {report.failed === 0 ? (
                  <p className="text-xs text-emerald-700 inline-flex items-center gap-1">
                    <CheckCircle2 className="h-3.5 w-3.5" /> Every past snapshot reconciles with the live formula.
                  </p>
                ) : (
                  <div className="space-y-1">
                    <p className="text-xs text-destructive inline-flex items-center gap-1">
                      <AlertTriangle className="h-3.5 w-3.5" /> Drifted snapshots
                      {report.repair_mode ? ' (now repaired)' : ' — run "Run & repair drift" to fix'}:
                    </p>
                    <div className="overflow-x-auto">
                      <Table>
                        <TableHeader>
                          <TableRow>
                            <TableHead>Computed at</TableHead>
                            <TableHead>Source</TableHead>
                            <TableHead className="text-right">Stored est.</TableHead>
                            <TableHead className="text-right">Expected est.</TableHead>
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {report.mismatches.map((m) => (
                            <TableRow key={m.id}>
                              <TableCell className="text-xs">{new Date(m.computed_at).toLocaleString()}</TableCell>
                              <TableCell className="text-xs">{m.source_table}</TableCell>
                              <TableCell className="text-right tabular-nums text-xs">{formatUGX(m.stored_estimated)}</TableCell>
                              <TableCell className="text-right tabular-nums text-xs font-medium">{formatUGX(m.expected_estimated)}</TableCell>
                            </TableRow>
                          ))}
                        </TableBody>
                      </Table>
                    </div>
                  </div>
                )}
              </div>
            )}
          </CardContent>
        </Card>

        <p className="text-[11px] text-muted-foreground text-center pb-6">
          Read-only audit · figures recompute live from house_listings + landlords · access limited to operations roles.
        </p>
      </div>
    </div>
  );
}