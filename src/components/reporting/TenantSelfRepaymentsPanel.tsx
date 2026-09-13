import { useMemo } from 'react';
import {
  Banknote,
  Download,
  PiggyBank,
  RefreshCw,
  Search,
  ShieldAlert,
  TrendingUp,
  Users,
} from 'lucide-react';
import { format } from 'date-fns';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { formatUGX } from '@/lib/rentCalculations';
import { cn } from '@/lib/utils';
import { useTenantSelfRepayments, type TenantSelfRepaymentRow } from '@/hooks/useTenantSelfRepayments';

type Audience = 'finance' | 'tenant-ops' | 'agent-ops';

interface Props {
  /** Controls the copy and which commission detail is emphasised. */
  audience?: Audience;
  title?: string;
  description?: string;
}

const AUDIENCE_COPY: Record<Audience, { title: string; description: string }> = {
  finance: {
    title: 'Tenant Self-Repayments',
    description:
      'Every tenant deposit that settled its own Rent Plan instalment from operational float, with the commission posted to the agent side.',
  },
  'tenant-ops': {
    title: 'Tenant Self-Repayments',
    description:
      'Tenants paying their own rent directly. Shows what was applied to the plan, what stayed in their float and the balance left.',
  },
  'agent-ops': {
    title: 'Tenant Self-Repayments (Agent Credit)',
    description:
      'Rent paid by tenants themselves. The agent still earns commission and these collections count double towards performance.',
  },
};

const OUTCOME_STYLES: Record<string, string> = {
  settled: 'bg-emerald-500/10 text-emerald-700 border-emerald-500/30',
  no_active_plan: 'bg-muted text-muted-foreground border-border',
  daily_amount_already_paid: 'bg-sky-500/10 text-sky-700 border-sky-500/30',
  insufficient_float: 'bg-amber-500/10 text-amber-700 border-amber-500/30',
  nothing_outstanding: 'bg-muted text-muted-foreground border-border',
};

const OUTCOME_LABELS: Record<string, string> = {
  settled: 'Settled',
  no_active_plan: 'No active plan',
  daily_amount_already_paid: 'Day already paid',
  insufficient_float: 'Float too low',
  nothing_outstanding: 'Nothing outstanding',
};

function outcomeLabel(outcome: string | null) {
  if (!outcome) return 'Unknown';
  return OUTCOME_LABELS[outcome] ?? outcome.replace(/_/g, ' ');
}

function keptLabel(bucket: string | null | undefined) {
  return bucket === 'withdrawable' ? 'Kept in wallet (withdrawable)' : 'Kept in float';
}

function toCsv(rows: TenantSelfRepaymentRow[]) {
  const header = [
    'Paid at',
    'Tenant',
    'Phone',
    'Deposited',
    'Applied to rent',
    'Kept in wallet',
    'Kept in bucket',
    'Outcome',
    'Current outstanding',
    'Plan status',
    'Agent',
    'Agent commission',
    'Parent commission',
    'Total commission',
    'Weight',
    'Tracking ID',
    'Reference',
  ];
  const escape = (value: unknown) => {
    const text = value === null || value === undefined ? '' : String(value);
    return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };
  const lines = rows.map(r =>
    [
      r.paid_at ? format(new Date(r.paid_at), 'yyyy-MM-dd HH:mm') : '',
      r.tenant_name ?? '',
      r.paid_from_phone ?? '',
      r.amount_deposited ?? 0,
      r.applied_amount ?? 0,
      r.float_kept ?? r.surplus_amount ?? 0,
      r.kept_bucket ?? 'float',
      outcomeLabel(r.outcome),
      r.outstanding_after ?? '',
      r.plan_status ?? '',
      r.agent_name ?? '',
      r.commission_agent ?? 0,
      r.commission_parent ?? 0,
      r.commission_total ?? 0,
      r.performance_weight ?? '',
      r.tracking_id ?? '',
      r.external_reference ?? '',
    ]
      .map(escape)
      .join(','),
  );
  return [header.join(','), ...lines].join('\n');
}

export function TenantSelfRepaymentsPanel({ audience = 'finance', title, description }: Props) {
  const copy = AUDIENCE_COPY[audience];
  const { filters, setFilters, rows, total, totals, isLoading, isFetching, error, refetch } =
    useTenantSelfRepayments();

  const pageCount = Math.max(1, Math.ceil(total / filters.pageSize));
  const kpis = useMemo(
    () => [
      {
        label: 'Applied to Rent Plans',
        value: formatUGX(totals.total_applied),
        icon: Banknote,
        tone: 'text-emerald-600',
        ring: 'from-emerald-500/15 to-emerald-500/0',
      },
      {
        label: 'Kept in tenant wallets',
        value: formatUGX(totals.total_surplus),
        icon: PiggyBank,
        tone: 'text-sky-600',
        ring: 'from-sky-500/15 to-sky-500/0',
      },
      {
        label: 'Agent commission paid',
        value: formatUGX(totals.total_commission),
        icon: TrendingUp,
        tone: 'text-violet-600',
        ring: 'from-violet-500/15 to-violet-500/0',
      },
      {
        label: 'Settled / not applied',
        value: `${totals.settled_count} / ${totals.refused_count}`,
        icon: Users,
        tone: 'text-amber-600',
        ring: 'from-amber-500/15 to-amber-500/0',
      },
    ],
    [totals],
  );

  const handleExport = () => {
    const blob = new Blob([toCsv(rows)], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `tenant-self-repayments-${format(new Date(), 'yyyy-MM-dd')}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="space-y-4">
      <div className="rounded-xl border bg-gradient-to-r from-primary/10 via-primary/5 to-transparent p-4 sm:p-5">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <h2 className="text-lg font-bold sm:text-xl">{title ?? copy.title}</h2>
            <p className="mt-1 max-w-3xl text-sm text-muted-foreground">{description ?? copy.description}</p>
          </div>
          <div className="flex shrink-0 gap-2">
            <Button variant="outline" size="sm" onClick={() => refetch()} disabled={isFetching}>
              <RefreshCw className={cn('mr-2 h-4 w-4', isFetching && 'animate-spin')} />
              Refresh
            </Button>
            <Button variant="outline" size="sm" onClick={handleExport} disabled={!rows.length}>
              <Download className="mr-2 h-4 w-4" />
              CSV
            </Button>
          </div>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {kpis.map(kpi => (
          <Card key={kpi.label} className="relative overflow-hidden">
            <div className={cn('pointer-events-none absolute inset-0 bg-gradient-to-br', kpi.ring)} />
            <CardContent className="relative p-4">
              <div className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
                <kpi.icon className={cn('h-4 w-4', kpi.tone)} />
                <span className="truncate">{kpi.label}</span>
              </div>
              <p className="mt-2 font-mono text-base font-bold sm:text-lg">
                {isLoading ? <Skeleton className="h-6 w-24" /> : kpi.value}
              </p>
            </CardContent>
          </Card>
        ))}
      </div>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm font-semibold">Payments</CardTitle>
          <div className="mt-2 flex flex-col gap-2 sm:flex-row sm:items-center">
            <div className="relative flex-1">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={filters.search}
                onChange={e => setFilters({ search: e.target.value })}
                placeholder="Search tenant, agent, phone, reference…"
                className="pl-9"
              />
            </div>
            <Select value={String(filters.days)} onValueChange={v => setFilters({ days: Number(v) })}>
              <SelectTrigger className="sm:w-40"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="1">Today</SelectItem>
                <SelectItem value="7">Last 7 days</SelectItem>
                <SelectItem value="30">Last 30 days</SelectItem>
                <SelectItem value="90">Last 90 days</SelectItem>
                <SelectItem value="365">Last 12 months</SelectItem>
              </SelectContent>
            </Select>
            <Select value={filters.outcome} onValueChange={v => setFilters({ outcome: v })}>
              <SelectTrigger className="sm:w-48"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All outcomes</SelectItem>
                <SelectItem value="settled">Settled</SelectItem>
                <SelectItem value="daily_amount_already_paid">Day already paid</SelectItem>
                <SelectItem value="no_active_plan">No active plan</SelectItem>
                <SelectItem value="insufficient_float">Float too low</SelectItem>
                <SelectItem value="nothing_outstanding">Nothing outstanding</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </CardHeader>
        <CardContent className="p-0">
          {error ? (
            <div className="flex flex-col items-center gap-2 p-10 text-center">
              <ShieldAlert className="h-8 w-8 text-destructive" />
              <p className="text-sm font-medium">Could not load tenant self-repayments</p>
              <p className="max-w-md text-xs text-muted-foreground">{error.message}</p>
              <Button size="sm" variant="outline" onClick={() => refetch()}>Try again</Button>
            </div>
          ) : isLoading ? (
            <div className="space-y-2 p-4">
              {Array.from({ length: 6 }).map((_, i) => <Skeleton key={i} className="h-10 w-full" />)}
            </div>
          ) : !rows.length ? (
            <div className="p-10 text-center">
              <PiggyBank className="mx-auto mb-3 h-10 w-10 text-muted-foreground/30" />
              <p className="text-sm font-medium text-muted-foreground">No tenant self-repayments in this period</p>
              <p className="mt-1 text-xs text-muted-foreground/70">
                Rows appear as soon as a tenant deposit settles their own Rent Plan instalment.
              </p>
            </div>
          ) : (
            <>
              {/* Mobile list */}
              <div className="divide-y sm:hidden">
                {rows.map(r => (
                  <div key={r.attempt_id} className="space-y-2 p-4">
                    <div className="flex items-start justify-between gap-2">
                      <div>
                        <p className="font-medium">{r.tenant_name ?? 'Unknown tenant'}</p>
                        <p className="text-xs text-muted-foreground">
                          {r.paid_at ? format(new Date(r.paid_at), 'dd MMM yyyy HH:mm') : '—'}
                        </p>
                      </div>
                      <Badge variant="outline" className={cn('shrink-0', OUTCOME_STYLES[r.outcome ?? ''] ?? '')}>
                        {outcomeLabel(r.outcome)}
                      </Badge>
                    </div>
                    <div className="grid grid-cols-2 gap-2 text-xs">
                      <div>
                        <p className="text-muted-foreground">Applied</p>
                        <p className="font-mono font-semibold">{formatUGX(Number(r.applied_amount) || 0)}</p>
                      </div>
                      <div>
                        <p className="text-muted-foreground">{keptLabel(r.kept_bucket)}</p>
                        <p className="font-mono">{formatUGX(Number(r.float_kept ?? r.surplus_amount) || 0)}</p>
                      </div>
                      <div>
                        <p className="text-muted-foreground" title="Live balance on the plan today, not at the time of this payment">
                          Current outstanding
                        </p>
                        <p className="font-mono">{formatUGX(Number(r.outstanding_after) || 0)}</p>
                      </div>
                      <div>
                        <p className="text-muted-foreground">Agent</p>
                        <p className="truncate">{r.agent_name ?? '—'}</p>
                      </div>
                      <div>
                        <p className="text-muted-foreground">Commission</p>
                        <p className="font-mono">{formatUGX(Number(r.commission_total) || 0)}</p>
                      </div>
                      <div>
                        <p className="text-muted-foreground">Weight</p>
                        <p className="font-mono">×{r.performance_weight ?? 1}</p>
                      </div>
                    </div>
                  </div>
                ))}
              </div>

              {/* Desktop table */}
              <div className="hidden overflow-x-auto sm:block">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="w-10">#</TableHead>
                      <TableHead>Paid at</TableHead>
                      <TableHead>Tenant</TableHead>
                      <TableHead className="text-right">Deposited</TableHead>
                      <TableHead className="text-right">Applied</TableHead>
                      <TableHead className="text-right">Kept in wallet</TableHead>
                      <TableHead className="text-right" title="Live balance on the plan today, not at the time of this payment">
                        Current outstanding
                      </TableHead>
                      <TableHead>Outcome</TableHead>
                      <TableHead>Agent</TableHead>
                      <TableHead className="text-right">Commission</TableHead>
                      <TableHead className="text-right">Weight</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {rows.map((r, i) => (
                      <TableRow key={r.attempt_id}>
                        <TableCell className="text-xs text-muted-foreground">
                          {filters.page * filters.pageSize + i + 1}
                        </TableCell>
                        <TableCell className="whitespace-nowrap text-xs">
                          {r.paid_at ? format(new Date(r.paid_at), 'dd MMM HH:mm') : '—'}
                        </TableCell>
                        <TableCell>
                          <div className="font-medium">{r.tenant_name ?? 'Unknown'}</div>
                          <div className="text-xs text-muted-foreground">{r.paid_from_phone ?? r.provider ?? '—'}</div>
                        </TableCell>
                        <TableCell className="text-right font-mono text-xs">
                          {formatUGX(Number(r.amount_deposited) || 0)}
                        </TableCell>
                        <TableCell className="text-right font-mono text-xs font-semibold text-emerald-700">
                          {formatUGX(Number(r.applied_amount) || 0)}
                        </TableCell>
                        <TableCell className="text-right font-mono text-xs">
                          {formatUGX(Number(r.float_kept ?? r.surplus_amount) || 0)}
                          {r.kept_bucket === 'withdrawable' && (
                            <div className="text-[10px] text-muted-foreground">withdrawable</div>
                          )}
                        </TableCell>
                        <TableCell className="text-right font-mono text-xs">
                          {formatUGX(Number(r.outstanding_after) || 0)}
                        </TableCell>
                        <TableCell>
                          <Badge variant="outline" className={cn('text-xs', OUTCOME_STYLES[r.outcome ?? ''] ?? '')}>
                            {outcomeLabel(r.outcome)}
                          </Badge>
                        </TableCell>
                        <TableCell className="text-xs">
                          <div>{r.agent_name ?? '—'}</div>
                          {Number(r.commission_parent) > 0 && (
                            <div className="text-[11px] text-muted-foreground">
                              parent share {formatUGX(Number(r.commission_parent))}
                            </div>
                          )}
                        </TableCell>
                        <TableCell className="text-right font-mono text-xs">
                          {formatUGX(Number(r.commission_total) || 0)}
                        </TableCell>
                        <TableCell className="text-right font-mono text-xs">×{r.performance_weight ?? 1}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>

              <div className="flex flex-col gap-2 border-t p-3 text-xs text-muted-foreground sm:flex-row sm:items-center sm:justify-between">
                <span>
                  Showing {rows.length} of {total} payments · page {filters.page + 1} of {pageCount}
                </span>
                <div className="flex gap-2">
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={filters.page === 0}
                    onClick={() => setFilters({ page: filters.page - 1 })}
                  >
                    Previous
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={filters.page + 1 >= pageCount}
                    onClick={() => setFilters({ page: filters.page + 1 })}
                  >
                    Next
                  </Button>
                </div>
              </div>
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

export default TenantSelfRepaymentsPanel;
