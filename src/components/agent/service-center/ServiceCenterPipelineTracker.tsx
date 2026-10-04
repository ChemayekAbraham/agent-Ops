import { useMemo, useState } from 'react';
import {
  Check, ChevronDown, ChevronLeft, ChevronRight, CircleDot, Route, Search, SlidersHorizontal, XCircle,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { cn } from '@/lib/utils';
import { formatUGX } from '@/lib/rentCalculations';
import {
  RENT_PIPELINE_STAGES,
  RENT_PIPELINE_TERMINAL,
  RENT_STATUS_FILTERS,
  pipelineStageIndex,
  pipelineStageLabel,
} from '@/lib/rentPipelineStages';
import {
  SERVICE_CENTER_PAGE_SIZE,
  ServiceCenterPipelineItem,
  useServiceCenterPipeline,
} from '@/hooks/useServiceCenterPipeline';
import { ServiceCenterTenantPayments } from './ServiceCenterTenantPayments';

const dateLabel = (v?: string | null) =>
  v
    ? new Date(v).toLocaleDateString('en-GB', {
        day: '2-digit', month: 'short', year: 'numeric', timeZone: 'Africa/Kampala',
      })
    : null;

function stageTimestamps(item: ServiceCenterPipelineItem): Record<string, string | null> {
  return {
    pending: item.created_at,
    service_center_review: item.service_center_reviewed_at,
    agent_ops_approved: item.agent_ops_reviewed_at,
    tenant_ops_approved: item.tenant_ops_reviewed_at,
    landlord_ops_approved: item.landlord_ops_reviewed_at,
    coo_approved: item.approved_at,
    funded: item.funded_at,
    repaying: null,
    completed: null,
  };
}

function StatusBadge({ status }: { status: string }) {
  const terminal = !!RENT_PIPELINE_TERMINAL[status];
  const done = ['funded', 'repaying', 'completed', 'fully_repaid', 'disbursed'].includes(status);
  return (
    <Badge
      variant="outline"
      className={cn(
        'shrink-0 text-[10px]',
        terminal && 'border-destructive/30 bg-destructive/10 text-destructive',
        done && 'border-success/30 bg-success/10 text-success',
        !terminal && !done && 'border-warning/30 bg-warning/10 text-warning',
      )}
    >
      {pipelineStageLabel(status)}
    </Badge>
  );
}

function StageTimeline({ item }: { item: ServiceCenterPipelineItem }) {
  const current = pipelineStageIndex(item.status);
  const stamps = stageTimestamps(item);
  const terminalLabel = RENT_PIPELINE_TERMINAL[item.status];

  return (
    <ol className="space-y-1.5">
      {RENT_PIPELINE_STAGES.map((s, i) => {
        const reached = current >= 0 && i <= current;
        const isCurrent = i === current;
        const at = dateLabel(stamps[s.key]);
        return (
          <li key={s.key} className="flex items-center gap-2">
            <span
              className={cn(
                'flex h-4 w-4 shrink-0 items-center justify-center rounded-full border',
                reached ? 'border-success bg-success/15 text-success' : 'border-border text-muted-foreground',
              )}
            >
              {reached ? <Check className="h-2.5 w-2.5" /> : <CircleDot className="h-2 w-2" />}
            </span>
            <span className={cn('flex-1 text-xs', isCurrent ? 'font-semibold text-foreground' : reached ? 'text-foreground' : 'text-muted-foreground')}>
              {s.label}
            </span>
            {at && reached && <span className="shrink-0 text-[10px] text-muted-foreground">{at}</span>}
          </li>
        );
      })}
      {terminalLabel && (
        <li className="flex items-center gap-2">
          <span className="flex h-4 w-4 shrink-0 items-center justify-center rounded-full border border-destructive bg-destructive/10 text-destructive">
            <XCircle className="h-2.5 w-2.5" />
          </span>
          <span className="flex-1 text-xs font-semibold text-destructive">{terminalLabel}</span>
        </li>
      )}
    </ol>
  );
}

/**
 * Follow-up view for a Service Center manager: every rent request their
 * sub-agents posted, filterable by status and paged server-side, with the
 * stage each tenant has reached and their payment history.
 */
export function ServiceCenterPipelineTracker() {
  const [statuses, setStatuses] = useState<string[]>([]);
  const [page, setPage] = useState(0);
  const [search, setSearch] = useState('');
  const [openId, setOpenId] = useState<string | null>(null);

  const { data, isLoading, error } = useServiceCenterPipeline({ statuses, page, search });

  const counts = data?.status_counts ?? {};
  const total = data?.total ?? 0;
  const pageSize = data?.limit ?? SERVICE_CENTER_PAGE_SIZE;
  const pages = Math.max(1, Math.ceil(total / pageSize));

  const filterLabel = useMemo(() => {
    if (statuses.length === 0) return 'All statuses';
    if (statuses.length === 1) return pipelineStageLabel(statuses[0]);
    return `${statuses.length} statuses`;
  }, [statuses]);

  const toggle = (key: string) => {
    setPage(0);
    setOpenId(null);
    setStatuses((prev) => (prev.includes(key) ? prev.filter((k) => k !== key) : [...prev, key]));
  };

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <Route className="h-4 w-4 text-primary" />
        <span className="text-sm font-semibold text-foreground">Sub-agent rent requests</span>
        <Badge variant="outline" className="text-[10px]">{total}</Badge>
      </div>

      <div className="relative">
        <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          value={search}
          onChange={(e) => { setSearch(e.target.value); setPage(0); setOpenId(null); }}
          placeholder="Search tenant, phone or sub-agent"
          className="pl-9"
        />
      </div>

      <div className="flex items-center gap-1.5">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="outline"
              size="sm"
              className={cn(
                'h-8 min-w-0 flex-1 justify-start gap-1.5 rounded-full px-3 text-[11px] font-medium',
                statuses.length > 0 && 'border-primary/40 bg-primary/10 text-primary',
              )}
            >
              <SlidersHorizontal className="h-3.5 w-3.5 shrink-0" />
              <span className="truncate">{filterLabel}</span>
              <ChevronDown className="ml-auto h-3.5 w-3.5 shrink-0 opacity-60" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="max-h-[60vh] min-w-[13rem] overflow-y-auto">
            <DropdownMenuItem
              onSelect={(e) => { e.preventDefault(); setStatuses([]); setPage(0); }}
              className="text-xs"
            >
              <span className="flex-1">All statuses</span>
              {statuses.length === 0 && <Check className="ml-2 h-3.5 w-3.5 text-primary" />}
            </DropdownMenuItem>
            {RENT_STATUS_FILTERS.map((s) => (
              <DropdownMenuItem
                key={s.key}
                onSelect={(e) => { e.preventDefault(); toggle(s.key); }}
                className="text-xs"
              >
                <span className="flex-1">{s.label}</span>
                <span className="ml-2 tabular-nums text-muted-foreground">{counts[s.key] ?? 0}</span>
                {statuses.includes(s.key) && <Check className="ml-2 h-3.5 w-3.5 text-primary" />}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>

        {statuses.length > 0 && (
          <Button
            size="sm"
            variant="ghost"
            className="h-8 shrink-0 rounded-full px-3 text-[11px]"
            onClick={() => { setStatuses([]); setPage(0); }}
          >
            Clear
          </Button>
        )}
      </div>

      {isLoading ? (
        <div className="space-y-2">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-16 w-full rounded-xl" />)}</div>
      ) : error ? (
        <Card><CardContent className="p-6 text-sm text-destructive">
          Could not load the follow-up list. Please try again.
        </CardContent></Card>
      ) : total === 0 ? (
        <Card><CardContent className="p-6 text-center text-sm text-muted-foreground">
          {statuses.length || search.trim()
            ? 'Nothing matches this filter.'
            : 'Your sub-agents have not posted any rent requests yet.'}
        </CardContent></Card>
      ) : (
        <ul className="divide-y divide-border/60 overflow-hidden rounded-xl border border-border/60">
          {(data?.items ?? []).map((item) => {
            const isOpen = openId === item.id;
            const progress = item.total_repayment
              ? Math.min(100, ((item.amount_repaid ?? 0) / Number(item.total_repayment)) * 100)
              : null;
            return (
              <li key={item.id}>
                <button
                  type="button"
                  onClick={() => setOpenId(isOpen ? null : item.id)}
                  className="flex w-full items-center gap-2 px-3 py-2.5 text-left active:bg-accent/60"
                  aria-expanded={isOpen}
                >
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-medium text-foreground">
                      {item.tenant_name ?? 'Tenant'}
                    </div>
                    <div className="mt-0.5 truncate text-xs text-muted-foreground">
                      {[item.agent_name ? `by ${item.agent_name}` : null, item.request_city]
                        .filter(Boolean).join(' · ')}
                    </div>
                  </div>
                  <span className="shrink-0 text-xs font-semibold text-foreground">
                    {formatUGX(Number(item.rent_amount || 0))}
                  </span>
                  <StatusBadge status={item.status} />
                  <ChevronDown
                    className={cn('h-4 w-4 shrink-0 text-muted-foreground transition-transform', isOpen && 'rotate-180')}
                  />
                </button>

                {isOpen && (
                  <div className="space-y-3 border-t border-border/60 bg-muted/40 px-3 py-3">
                    <dl className="grid grid-cols-2 gap-x-4 gap-y-1.5">
                      {[
                        { label: 'Tenant phone', value: item.tenant_phone || '—' },
                        { label: 'Sub-agent', value: item.agent_name || '—' },
                        { label: 'Daily amount', value: item.daily_repayment ? formatUGX(Number(item.daily_repayment)) : '—' },
                        { label: 'Plan total', value: item.total_repayment ? formatUGX(Number(item.total_repayment)) : '—' },
                        { label: 'Repaid so far', value: formatUGX(Number(item.amount_repaid ?? 0)) },
                        { label: 'Duration', value: item.duration_days ? `${item.duration_days} days` : '—' },
                        { label: 'Vetted by you', value: item.is_mine_to_vet ? 'Yes' : 'No' },
                        { label: 'Submitted', value: dateLabel(item.created_at) ?? '—' },
                      ].map((d) => (
                        <div key={d.label} className="min-w-0">
                          <dt className="text-[10px] uppercase tracking-wide text-muted-foreground">{d.label}</dt>
                          <dd className="break-words text-xs font-medium text-foreground">{d.value}</dd>
                        </div>
                      ))}
                    </dl>

                    {typeof progress === 'number' && (
                      <div className="space-y-1">
                        <div className="flex items-center justify-between text-[10px] text-muted-foreground">
                          <span>Repayment progress</span>
                          <span className="tabular-nums font-medium text-foreground">
                            {formatUGX(Number(item.amount_repaid ?? 0))} of {formatUGX(Number(item.total_repayment))}
                          </span>
                        </div>
                        <div className="h-1.5 w-full overflow-hidden rounded-full bg-border">
                          <div className="h-full rounded-full bg-success" style={{ width: `${progress}%` }} />
                        </div>
                      </div>
                    )}

                    <div className="space-y-2">
                      <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                        Progress
                      </p>
                      <StageTimeline item={item} />
                    </div>

                    {[
                      { label: 'Your note', value: item.service_center_comment },
                      { label: 'Agent operations', value: item.agent_ops_comment },
                      { label: 'Tenant operations', value: item.tenant_ops_comment },
                      { label: 'Landlord operations', value: item.landlord_ops_comment },
                      { label: 'Executive', value: item.approval_comment },
                    ].filter((n) => !!n.value).map((n) => (
                      <p key={n.label} className="text-xs text-muted-foreground">
                        <span className="font-medium text-foreground">{n.label}:</span> {n.value}
                      </p>
                    ))}

                    <ServiceCenterTenantPayments rentRequestId={item.id} />
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}

      {pages > 1 && (
        <div className="flex items-center justify-between gap-2">
          <Button
            size="sm"
            variant="outline"
            disabled={page === 0}
            onClick={() => { setPage((n) => Math.max(0, n - 1)); setOpenId(null); }}
          >
            <ChevronLeft className="h-4 w-4" /> Previous
          </Button>
          <span className="text-xs text-muted-foreground">Page {page + 1} of {pages}</span>
          <Button
            size="sm"
            variant="outline"
            disabled={page + 1 >= pages}
            onClick={() => { setPage((n) => n + 1); setOpenId(null); }}
          >
            Next <ChevronRight className="h-4 w-4" />
          </Button>
        </div>
      )}
    </div>
  );
}