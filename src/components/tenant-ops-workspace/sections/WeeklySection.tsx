/**
 * Presentation only. The weekly-performance card and history table below
 * reuse the EXISTING hooks (useTenantOpsWeeklyPerformance/
 * useTenantOpsWeeklyHistory) and the existing frozen weekly snapshot,
 * completely unchanged — nothing here recomputes anything they already
 * provide. The Portfolio quality panel is our own new read-model
 * (tops_portfolio_quality), additive alongside it.
 *
 * Note: the existing weekly RPCs are gated to operations/coo/ceo/super_admin
 * (plus manager/cto, not part of this workspace's six roles) — a
 * tenant_ops- or cfo-only viewer will see this card fail to load. This is a
 * property of the existing, unmodified function (see build log).
 */
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { formatUGX } from '@/lib/rentCalculations';
import { useTenantOpsWeeklyPerformance, useTenantOpsWeeklyHistory } from '@/hooks/useTenantOpsWeeklyPerformance';
import { usePortfolioQuality } from '@/hooks/tenantOpsWorkspace/usePortfolioQuality';

const pct = (v: number | null) => (v == null ? '—' : `${Math.round(v * 1000) / 10}%`);
const monthLabel = (iso: string) => new Date(iso).toLocaleDateString('en-GB', { month: 'short', year: 'numeric' });

export default function WeeklySection() {
  const weekly = useTenantOpsWeeklyPerformance();
  const history = useTenantOpsWeeklyHistory(12);
  const quality = usePortfolioQuality(null);

  return (
    <div className="space-y-4">
      <Card className="border shadow-sm">
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-semibold">This week</CardTitle>
          {weekly.error && (
            <p className="text-[11px] text-destructive">
              Could not load — this card needs the operations/coo/ceo/super_admin role on the existing weekly RPC.
            </p>
          )}
        </CardHeader>
        <CardContent>
          {weekly.data && (
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <div>
                <p className="text-xs text-muted-foreground">Active tenants</p>
                <p className="text-sm font-semibold">{weekly.data.current.total_active_tenants}</p>
              </div>
              <div>
                <p className="text-xs text-muted-foreground">Paying</p>
                <p className="text-sm font-semibold">{weekly.data.current.paying_tenants}</p>
              </div>
              <div>
                <p className="text-xs text-muted-foreground">Payment rate</p>
                <p className="text-sm font-semibold">{weekly.data.current.payment_rate_pct}%</p>
              </div>
              <div>
                <p className="text-xs text-muted-foreground">Dormant 20+ days</p>
                <p className="text-sm font-semibold">{weekly.data.current.dormant_20_plus_count}</p>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      <Card className="border shadow-sm">
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-semibold">Weekly history</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="overflow-auto rounded-lg border">
            <Table>
              <TableHeader className="bg-muted/50">
                <TableRow>
                  <TableHead className="text-xs">Week</TableHead>
                  <TableHead className="text-xs">Active</TableHead>
                  <TableHead className="text-xs">Paying</TableHead>
                  <TableHead className="text-xs">Payment rate</TableHead>
                  <TableHead className="text-xs">Dormant 20+</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {(history.data ?? []).map((row) => (
                  <TableRow key={row.week_start}>
                    <TableCell className="text-xs">{row.week_start}</TableCell>
                    <TableCell className="text-xs">{row.total_active_tenants}</TableCell>
                    <TableCell className="text-xs">{row.paying_tenants}</TableCell>
                    <TableCell className="text-xs">{row.payment_rate_pct}%</TableCell>
                    <TableCell className="text-xs">{row.dormant_20_plus_count}</TableCell>
                  </TableRow>
                ))}
                {(history.data ?? []).length === 0 && (
                  <TableRow>
                    <TableCell colSpan={5} className="text-center text-xs text-muted-foreground">
                      {history.isLoading ? 'Loading…' : 'No history yet.'}
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>

      <Card className="border shadow-sm">
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-semibold">Portfolio at risk</CardTitle>
          {quality.data && (
            <p className="text-[11px] text-muted-foreground">
              Total outstanding: {formatUGX(quality.data.par.total_outstanding_ugx)} — a plan touched by pause, renewal
              or reopen counts as at-risk here regardless of its current status.
            </p>
          )}
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-3 gap-3">
            {(['days_7', 'days_14', 'days_30'] as const).map((key) => (
              <div key={key} className="rounded-lg border p-3">
                <p className="text-xs text-muted-foreground">PAR @ {key.replace('days_', '')} days</p>
                <p className="text-lg font-semibold">{quality.data ? pct(quality.data.par[key].rate) : '…'}</p>
                <p className="text-[11px] text-muted-foreground">
                  {quality.data ? formatUGX(quality.data.par[key].at_risk_ugx) : ''}
                </p>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>

      <Card className="border shadow-sm">
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-semibold">By funding month</CardTitle>
          <p className="text-[11px] text-muted-foreground">
            Repayment rate at day 14/30/term, completion rate, and repeat rate — each cohort is every plan funded that
            month.
          </p>
        </CardHeader>
        <CardContent>
          <div className="overflow-auto rounded-lg border">
            <Table>
              <TableHeader className="bg-muted/50">
                <TableRow>
                  <TableHead className="text-xs">Funded</TableHead>
                  <TableHead className="text-xs">Plans</TableHead>
                  <TableHead className="text-xs">Day 14</TableHead>
                  <TableHead className="text-xs">Day 30</TableHead>
                  <TableHead className="text-xs">At term</TableHead>
                  <TableHead className="text-xs">Completion</TableHead>
                  <TableHead className="text-xs">Repeat</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {(quality.data?.by_funding_month ?? []).map((row) => (
                  <TableRow key={row.funding_month}>
                    <TableCell className="text-xs">{monthLabel(row.funding_month)}</TableCell>
                    <TableCell className="text-xs">{row.plan_count}</TableCell>
                    <TableCell className="text-xs">{pct(row.repayment_rate_day14)}</TableCell>
                    <TableCell className="text-xs">{pct(row.repayment_rate_day30)}</TableCell>
                    <TableCell className="text-xs">
                      {pct(row.repayment_rate_at_term)}
                      <Badge variant="outline" className="ml-1 text-[10px]">{row.term_elapsed_plan_count} elapsed</Badge>
                    </TableCell>
                    <TableCell className="text-xs">{pct(row.completion_rate)}</TableCell>
                    <TableCell className="text-xs">{pct(row.repeat_rate)}</TableCell>
                  </TableRow>
                ))}
                {(quality.data?.by_funding_month ?? []).length === 0 && (
                  <TableRow>
                    <TableCell colSpan={7} className="text-center text-xs text-muted-foreground">
                      {quality.isLoading ? 'Loading…' : 'No cohorts yet.'}
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
