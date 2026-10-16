import { AlertTriangle, GitBranch, RefreshCw, Wallet } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { useTenantOpsRentLifetime } from '@/hooks/useTenantOpsRentLifetime';
import { FUNNEL_LABEL, pct, stagePassRate, type RentLifetime } from '@/lib/rentLifetime';
import { formatUGX } from '@/lib/rentCalculations';
import { cn } from '@/lib/utils';

// Two all-time cards of the Tenant Ops summary. Every count and amount is what tenant_ops_rent_request_lifetime() returns; the page's date filter
// does not reach them (the hook takes no dates). Percentages are display only (pct of two server figures).

const n = (v: number) => v.toLocaleString('en-US');
const p = (v: number) => `${v}%`;

function AllTimeBadge() {
  return <Badge variant="outline" className="shrink-0 whitespace-nowrap text-xs font-medium" data-testid="lifetime-all-time-badge">All time</Badge>;
}

export function TenantOpsRentLifetimeCards() {
  const q = useTenantOpsRentLifetime();
  const failed = !!q.error && !q.isFetching;
  if (q.isLoading) {
    return (
      <div className="grid gap-3 lg:grid-cols-2" data-testid="lifetime-loading" aria-busy="true" aria-label="Loading all-time rent request figures">
        <Skeleton className="h-[380px] rounded-xl" />
        <Skeleton className="h-[380px] rounded-xl" />
      </div>
    );
  }
  if (failed || !q.data) {
    return (
      <Card className="border shadow-sm" data-testid="lifetime-error">
        <CardContent role="alert" className="flex flex-col gap-2 p-4">
          <p className="flex items-start gap-2 text-sm text-destructive"><AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />Could not load the all-time rent request figures.</p>
          <Button type="button" variant="outline" className="min-h-11 self-start" onClick={q.refetch}><RefreshCw className="mr-2 h-4 w-4" />Retry</Button>
        </CardContent>
      </Card>
    );
  }
  return (
    <div className="grid gap-3 lg:grid-cols-2" data-testid="lifetime-cards">
      <JourneyCard d={q.data} />
      <RepaymentCard d={q.data} />
    </div>
  );
}

function JourneyCard({ d }: { d: RentLifetime }) {
  const o = d.outcomes;
  return (
    <Card className="border shadow-sm" data-testid="lifetime-journey">
      <CardHeader className="pb-2 px-3 sm:px-4">
        <CardTitle className="flex items-center justify-between gap-2 text-sm font-semibold">
          <span className="flex min-w-0 items-center gap-2"><GitBranch className="h-4 w-4 shrink-0 text-primary" />Rent request journey</span>
          <AllTimeBadge />
        </CardTitle>
        <p className="text-xs text-muted-foreground">Requests that cleared each stage or a later one, since the start.</p>
      </CardHeader>
      <CardContent className="space-y-3 px-3 sm:px-4 pb-3">
        <div className="overflow-x-auto">
          <table className="w-full text-sm" data-testid="lifetime-funnel">
            <thead>
              <tr className="text-left text-xs text-muted-foreground">
                <th className="py-1 pr-2 font-medium">Stage</th>
                <th className="px-2 py-1 text-right font-medium">Requests</th>
                <th className="px-2 py-1 text-right font-medium">Of submitted</th>
                <th className="py-1 pl-2 text-right font-medium">Of previous</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              <tr data-testid="lifetime-row-submitted">
                <td className="py-2 pr-2 font-medium text-foreground">Submitted</td>
                <td className="px-2 py-2 text-right font-bold tabular-nums text-foreground">{n(d.submitted)}</td>
                <td className="px-2 py-2 text-right tabular-nums text-muted-foreground">{d.submitted > 0 ? '100%' : p(0)}</td>
                <td className="py-2 pl-2 text-right text-muted-foreground">None</td>
              </tr>
              {d.stage_funnel.map((row, i) => (
                <tr key={row.stage} data-testid={`lifetime-row-${row.stage}`}>
                  <td className="py-2 pr-2 text-foreground">{FUNNEL_LABEL[row.stage]}</td>
                  <td className="px-2 py-2 text-right font-bold tabular-nums text-foreground">{n(row.count)}</td>
                  <td className="px-2 py-2 text-right tabular-nums text-muted-foreground" data-testid={`lifetime-of-submitted-${row.stage}`}>{p(pct(row.count, d.submitted))}</td>
                  <td className="py-2 pl-2 text-right tabular-nums text-muted-foreground" data-testid={`lifetime-of-previous-${row.stage}`}>{p(stagePassRate(d.stage_funnel, i, d.submitted))}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <dl className="grid grid-cols-2 gap-2 border-t border-border pt-3 sm:grid-cols-5" data-testid="lifetime-outcomes">
          {([
            ['Waiting at Service Centre', o.waiting_service_centre],
            ['Pending', o.pending],
            ['Rejected', o.rejected],
            ['Withdrawn by agent', o.deleted_by_agent],
            ['Cancelled', o.cancelled],
          ] as const).map(([label, v]) => (
            <div key={label}>
              <dt className="text-xs text-muted-foreground">{label}</dt>
              <dd className="text-sm font-bold tabular-nums text-foreground">{n(v)}</dd>
            </div>
          ))}
        </dl>
      </CardContent>
    </Card>
  );
}

const BUCKETS = [
  { key: 'full', label: 'Paid in full', bar: 'bg-primary' },
  { key: 'partial', label: 'Partly paid', bar: 'bg-primary/50' },
  { key: 'never_paid', label: 'Never paid (30+ days)', bar: 'bg-destructive' },
  { key: 'too_early', label: 'Too early', bar: 'bg-muted-foreground/40' },
] as const;

function RepaymentCard({ d }: { d: RentLifetime }) {
  return (
    <Card className="border shadow-sm" data-testid="lifetime-repayment">
      <CardHeader className="pb-2 px-3 sm:px-4">
        <CardTitle className="flex items-center justify-between gap-2 text-sm font-semibold">
          <span className="flex min-w-0 items-center gap-2"><Wallet className="h-4 w-4 shrink-0 text-primary" />Financed: repayment outcome</span>
          <AllTimeBadge />
        </CardTitle>
        <p className="text-xs text-muted-foreground">Rent Plans where the landlord has been paid: {n(d.financed)} in all.</p>
      </CardHeader>
      <CardContent className="space-y-3 px-3 sm:px-4 pb-3">
        <div className="flex h-3 w-full overflow-hidden rounded-full bg-muted" role="img" aria-label="Share of financed Rent Plans by repayment outcome" data-testid="lifetime-bar">
          {BUCKETS.map((b) => (
            <div key={b.key} className={cn('h-full', b.bar)} style={{ width: `${pct(d.repayment[b.key], d.financed)}%` }} data-testid={`lifetime-bar-${b.key}`} />
          ))}
        </div>
        <ul className="divide-y divide-border" data-testid="lifetime-buckets">
          {BUCKETS.map((b) => (
            <li key={b.key} className="flex items-center justify-between gap-2 py-2" data-testid={`lifetime-bucket-${b.key}`}>
              <span className="flex items-center gap-2 text-sm text-foreground"><span className={cn('h-2.5 w-2.5 rounded-full', b.bar)} aria-hidden="true" />{b.label}</span>
              <span className="text-right">
                <span className="text-sm font-bold tabular-nums text-foreground">{n(d.repayment[b.key])}</span>
                <span className="ml-2 text-xs tabular-nums text-muted-foreground">{p(pct(d.repayment[b.key], d.financed))}</span>
              </span>
            </li>
          ))}
        </ul>
        <dl className="space-y-2 border-t border-border pt-3">
          <div className="flex items-center justify-between gap-2" data-testid="lifetime-funded-not-financed">
            <dt className="text-sm text-foreground">Funded but not yet financed</dt>
            <dd className="text-sm font-bold tabular-nums text-foreground">{n(d.funded_not_financed)}</dd>
          </div>
          <div className="flex items-center justify-between gap-2" data-testid="lifetime-recovered">
            <dt className="text-sm text-foreground">Money recovered</dt>
            <dd className="text-right">
              <span className="text-sm font-bold tabular-nums text-foreground">{p(pct(d.money.amount_repaid, d.money.total_repayment))}</span>
              <span className="block text-xs tabular-nums text-muted-foreground">{formatUGX(d.money.amount_repaid)} of {formatUGX(d.money.total_repayment)}</span>
            </dd>
          </div>
          {d.financed_now_closed > 0 && (
            <p className="text-xs text-muted-foreground" data-testid="lifetime-closed-note">
              {n(d.financed_now_closed)} of the financed Rent Plans are now rejected, cancelled or withdrawn; they are counted in the rows above.
            </p>
          )}
        </dl>
      </CardContent>
    </Card>
  );
}
