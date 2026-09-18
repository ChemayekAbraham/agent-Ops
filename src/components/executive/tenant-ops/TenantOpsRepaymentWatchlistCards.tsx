import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { AlertTriangle, CalendarX2, CalendarClock, TrendingUp, ChevronRight } from 'lucide-react';
import { formatUGX } from '@/lib/rentCalculations';
import { cn } from '@/lib/utils';
import {
  useTenantOpsRepaymentWatchlist,
  type WatchlistAgentRow,
  type WatchlistBucketKey,
} from '@/hooks/useTenantOpsRepaymentWatchlist';
import type { TenantOpsActionKey, TenantOpsViewKey } from './tenantOpsNav';

/**
 * Four agent-level repayment breakdowns for Tenant Ops → Classic → Home,
 * matching the "Active tenants by agent" bar-card language. All numbers are
 * aggregated server-side; clicking a row opens the existing Classic view.
 */
interface CardSpec {
  key: WatchlistBucketKey;
  title: string;
  hint: string;
  amountLabel: string;
  icon: typeof AlertTriangle;
  tone: string;
  bar: string;
  view: TenantOpsViewKey | TenantOpsActionKey;
  meta: (row: WatchlistAgentRow) => string | null;
}

const CARDS: CardSpec[] = [
  {
    key: 'overdue',
    title: 'Active tenants — overdue Rent Plans',
    hint: 'Past their scheduled end date with a balance still owing.',
    amountLabel: 'behind',
    icon: AlertTriangle,
    tone: 'text-destructive',
    bar: 'bg-destructive',
    view: 'backlog-analysis',
    meta: (r) => (r.max_days_past_end != null ? `up to ${r.max_days_past_end}d past end` : null),
  },
  {
    key: 'daily_behind',
    title: 'Daily payers behind (7+ days)',
    hint: 'Still inside their term but no payment for more than 7 days.',
    amountLabel: 'owed',
    icon: CalendarX2,
    tone: 'text-warning',
    bar: 'bg-warning',
    view: 'missed',
    meta: (r) => (r.avg_days_since_pay != null ? `avg ${r.avg_days_since_pay}d since payment` : null),
  },
  {
    key: 'weekly_behind',
    title: 'Weekly payers behind (14+ days)',
    hint: 'Weekly plans inside their term with no payment for over 14 days.',
    amountLabel: 'owed',
    icon: CalendarClock,
    tone: 'text-warning',
    bar: 'bg-warning',
    view: 'missed',
    meta: (r) => (r.avg_days_since_pay != null ? `avg ${r.avg_days_since_pay}d since payment` : null),
  },
  {
    key: 'advance',
    title: 'Active tenants — paid in advance',
    hint: 'Daily and weekly plans ahead of their expected schedule.',
    amountLabel: 'ahead',
    icon: TrendingUp,
    tone: 'text-success',
    bar: 'bg-success',
    view: 'daily',
    meta: () => null,
  },
];

export function TenantOpsRepaymentWatchlistCards({
  onNavigate,
  className,
}: {
  onNavigate: (view: TenantOpsViewKey | TenantOpsActionKey) => void;
  className?: string;
}) {
  const { data, isLoading } = useTenantOpsRepaymentWatchlist();

  return (
    <div className={cn('grid gap-3 md:grid-cols-2 xl:grid-cols-4', className)}>
      {CARDS.map((spec) => {
        const bucket = data?.buckets?.[spec.key];
        const agents = bucket?.agents ?? [];
        const top = agents.slice(0, 6);
        const max = top.reduce((m, a) => Math.max(m, a.tenants), 0);
        const Icon = spec.icon;
        return (
          <Card key={spec.key} className="flex flex-col border shadow-sm">
            <CardHeader className="pb-2 px-3 sm:px-4">
              <CardTitle className="flex items-start gap-2 text-sm font-semibold leading-snug">
                <Icon className={cn('mt-0.5 h-4 w-4 shrink-0', spec.tone)} />
                <span className="min-w-0 break-words">{spec.title}</span>
              </CardTitle>
              <p className="text-[11px] leading-snug text-muted-foreground">{spec.hint}</p>
            </CardHeader>
            <CardContent className="flex flex-1 flex-col px-3 sm:px-4 pb-3">
              {isLoading ? (
                <div className="h-[200px] w-full animate-pulse rounded-xl bg-muted" />
              ) : (
                <>
                  <div className="flex items-end justify-between gap-2">
                    <p className={cn('text-2xl font-bold tabular-nums leading-none', spec.tone)}>
                      {(bucket?.tenants ?? 0).toLocaleString('en-US')}
                    </p>
                    <p className="text-right text-[11px] font-semibold text-muted-foreground">
                      {formatUGX(bucket?.amount ?? 0)}
                      <span className="block font-normal">{spec.amountLabel}</span>
                    </p>
                  </div>

                  <div className="mt-3 flex-1 space-y-2">
                    {top.length === 0 ? (
                      <p className="py-6 text-center text-xs text-muted-foreground">Nothing here right now</p>
                    ) : (
                      top.map((a) => {
                        const meta = spec.meta(a);
                        return (
                          <button
                            key={`${spec.key}-${a.agent_id ?? 'unassigned'}`}
                            type="button"
                            onClick={() => onNavigate(spec.view)}
                            className="group w-full space-y-1 rounded-md px-1 py-0.5 text-left transition-colors hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60"
                          >
                            <div className="flex items-center justify-between gap-2 text-[11px]">
                              <span className="min-w-0 truncate font-medium text-foreground">{a.label}</span>
                              <span className="shrink-0 font-bold tabular-nums text-foreground">
                                {a.tenants.toLocaleString('en-US')}
                              </span>
                            </div>
                            <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
                              <div
                                className={cn('h-full rounded-full', spec.bar)}
                                style={{ width: max > 0 ? `${Math.max(3, (a.tenants / max) * 100)}%` : '0%' }}
                              />
                            </div>
                            <div className="flex items-center justify-between gap-2 text-[10px] text-muted-foreground">
                              <span className="truncate">{meta ?? ''}</span>
                              <span className="shrink-0 tabular-nums">{formatUGX(a.amount)}</span>
                            </div>
                          </button>
                        );
                      })
                    )}
                    {agents.length > top.length && (
                      <p className="pt-1 text-[10px] text-muted-foreground">+{agents.length - top.length} more agents</p>
                    )}
                  </div>

                  <button
                    type="button"
                    onClick={() => onNavigate(spec.view)}
                    className="mt-2 inline-flex items-center gap-1 self-start text-[11px] font-bold text-primary hover:underline"
                  >
                    Open details
                    <ChevronRight className="h-3.5 w-3.5" />
                  </button>
                </>
              )}
            </CardContent>
          </Card>
        );
      })}
    </div>
  );
}
