/**
 * Presentation only — every figure and every row comes from a tops_ RPC,
 * server-paginated and server-sorted (p_limit/p_offset/p_sort/p_dir). Never
 * fetch a page and sort it in the browser.
 */
import { useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { formatUGX } from '@/lib/rentCalculations';
import { useCollectionsDueToday } from '@/hooks/tenantOpsWorkspace/useCollectionsDueToday';
import { useArrearsAgeing, type ArrearsBucket } from '@/hooks/tenantOpsWorkspace/useArrearsAgeing';
import { useCollectionsMovement } from '@/hooks/tenantOpsWorkspace/useCollectionsMovement';
import { useNeverBilled } from '@/hooks/tenantOpsWorkspace/useNeverBilled';
import { useWorkItemsByRentRequestIds, type WorkItemBadge } from '@/hooks/tenantOpsWorkspace/useWorkItemsByRentRequestIds';
import { TenantDrawer } from '../tenant/TenantDrawer';

const BUCKET_BADGE_CLASS: Record<string, string> = {
  critical: 'bg-destructive/10 text-destructive',
  at_risk: 'bg-warning/10 text-warning',
  watch: 'bg-muted text-foreground',
  new: 'bg-primary/10 text-primary',
};

/** Our own work-item bucket/assignment badge — informational only, never changes this row's order. */
function WorkItemBadgeChip({ workItem }: { workItem: WorkItemBadge | undefined }) {
  if (!workItem) return null;
  return (
    <Badge variant="outline" className={`text-[10px] capitalize ${BUCKET_BADGE_CLASS[workItem.bucket]}`}>
      {workItem.bucket.replace('_', ' ')}{workItem.assignedTo ? ' · assigned' : ''}
    </Badge>
  );
}

const PAGE_SIZE = 20;
const BUCKETS: ArrearsBucket[] = ['1-7', '8-14', '15-30', '30+'];

const dayLabel = (iso: string | null | undefined) =>
  iso ? new Date(iso).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }) : '—';

const todayIso = () => new Date().toISOString().slice(0, 10);
const daysAgoIso = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);

function QuickActions({ workItem }: { rentRequestId: string; workItem?: WorkItemBadge }) {
  return (
    <div className="flex flex-wrap items-center gap-1">
      <WorkItemBadgeChip workItem={workItem} />
      <Button asChild variant="ghost" size="sm" className="h-7 px-2 text-[10px]">
        <a
          href="/executive-hub?tab=tenant-ops&mode=classic&view=collect-rent"
          target="_blank"
          rel="noopener noreferrer"
          onClick={(e) => e.stopPropagation()}
        >
          Collect
        </a>
      </Button>
      <Button asChild variant="ghost" size="sm" className="h-7 px-2 text-[10px]">
        <a
          href="/executive-hub?tab=tenant-ops&mode=classic&view=calling-hub"
          target="_blank"
          rel="noopener noreferrer"
          onClick={(e) => e.stopPropagation()}
        >
          Call
        </a>
      </Button>
    </div>
  );
}

function PagerFooter({
  page,
  totalRows,
  onPage,
}: {
  page: number;
  totalRows: number;
  onPage: (page: number) => void;
}) {
  const pageCount = Math.max(1, Math.ceil(totalRows / PAGE_SIZE));
  return (
    <div className="flex items-center justify-between pt-2">
      <Button variant="outline" size="sm" disabled={page === 0} onClick={() => onPage(page - 1)}>
        Previous
      </Button>
      <p className="text-xs text-muted-foreground">
        Page {page + 1} of {pageCount} ({totalRows} total)
      </p>
      <Button variant="outline" size="sm" disabled={page >= pageCount - 1} onClick={() => onPage(page + 1)}>
        Next
      </Button>
    </div>
  );
}

export default function CollectionsSection() {
  const [searchParams, setSearchParams] = useSearchParams();
  const initialTab = searchParams.get('tab') ?? 'due-today';
  const initialBucket = (searchParams.get('bucket') as ArrearsBucket | null) ?? null;

  const [tab, setTab] = useState(initialTab);
  const [asAt, setAsAt] = useState(todayIso());
  const [bucket, setBucket] = useState<ArrearsBucket | null>(initialBucket);
  const [page, setPage] = useState(0);
  const [openTenant, setOpenTenant] = useState<string | null>(null);

  const changeTab = (next: string) => {
    setTab(next);
    setPage(0);
    setSearchParams({ section: 'collections', tab: next });
  };

  const dueToday = useCollectionsDueToday({ asAt, limit: PAGE_SIZE, offset: page * PAGE_SIZE });
  const arrears = useArrearsAgeing({ asAt, bucket, limit: PAGE_SIZE, offset: page * PAGE_SIZE });
  const movement = useCollectionsMovement({ from: daysAgoIso(7), to: asAt, limit: PAGE_SIZE, offset: page * PAGE_SIZE });
  const neverBilled = useNeverBilled({ asAt, limit: PAGE_SIZE, offset: page * PAGE_SIZE });

  const bucketSummary = arrears.data?.summary ?? {};

  const visibleRentRequestIds =
    tab === 'due-today'
      ? (dueToday.data?.rows ?? []).map((r) => r.rent_request_id)
      : tab === 'arrears'
        ? (arrears.data?.rows ?? []).map((r) => r.rent_request_id)
        : tab === 'movement'
          ? (movement.data?.rows ?? []).map((r) => r.rent_request_id)
          : (neverBilled.data?.rows ?? []).map((r) => r.rent_request_id);
  const { data: workItems } = useWorkItemsByRentRequestIds(visibleRentRequestIds);

  return (
    <div className="space-y-4">
      <Card className="border shadow-sm">
        <CardContent className="flex flex-wrap items-center gap-3 py-3">
          <label className="flex items-center gap-2 text-xs text-muted-foreground">
            As at
            <Input
              type="date"
              value={asAt}
              onChange={(e) => {
                setAsAt(e.target.value);
                setPage(0);
              }}
              className="h-8 w-40"
            />
          </label>
          <p className="text-[11px] text-muted-foreground">
            Movement compares this date to 7 days before it.
          </p>
        </CardContent>
      </Card>

      <Tabs value={tab} onValueChange={changeTab}>
        <TabsList>
          <TabsTrigger value="due-today">Due today</TabsTrigger>
          <TabsTrigger value="arrears">Arrears ageing</TabsTrigger>
          <TabsTrigger value="movement">Movement</TabsTrigger>
          <TabsTrigger value="never-billed">Never billed</TabsTrigger>
        </TabsList>
      </Tabs>

      {tab === 'due-today' && (
        <Card className="border shadow-sm">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-semibold">Due today</CardTitle>
            {dueToday.data && (
              <div className="flex flex-wrap gap-3 pt-1 text-xs text-muted-foreground">
                <span>Billed: <strong className="text-foreground">{formatUGX(dueToday.data.summary.billed_ugx)}</strong></span>
                <span>Paid: <strong className="text-foreground">{formatUGX(dueToday.data.summary.paid_ugx)}</strong></span>
                <span>Unpaid: <strong className="text-foreground">{formatUGX(dueToday.data.summary.unpaid_ugx)}</strong></span>
                <span>Coverage (capped): <strong className="text-foreground">{dueToday.data.summary.coverage_pct ?? '—'}%</strong></span>
              </div>
            )}
          </CardHeader>
          <CardContent>
            <div className="overflow-auto rounded-lg border">
              <Table>
                <TableHeader className="bg-muted/50">
                  <TableRow>
                    <TableHead className="text-xs">Tenant</TableHead>
                    <TableHead className="text-xs">Agent</TableHead>
                    <TableHead className="text-xs">Expected</TableHead>
                    <TableHead className="text-xs">Paid</TableHead>
                    <TableHead className="text-xs">Unpaid</TableHead>
                    <TableHead className="text-xs">Status</TableHead>
                    <TableHead className="text-xs">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {(dueToday.data?.rows ?? []).map((row) => (
                    <TableRow key={row.rent_request_id} className="cursor-pointer" onClick={() => setOpenTenant(row.rent_request_id)}>
                      <TableCell className="text-xs">{row.tenant_name ?? '—'}</TableCell>
                      <TableCell className="text-xs">{row.agent_name ?? '—'}</TableCell>
                      <TableCell className="text-xs">{formatUGX(row.expected_ugx)}</TableCell>
                      <TableCell className="text-xs">{formatUGX(row.paid_ugx)}</TableCell>
                      <TableCell className="text-xs">{formatUGX(row.unpaid_ugx)}</TableCell>
                      <TableCell className="text-xs">
                        <Badge variant="outline" className="text-[10px] capitalize">{row.status}</Badge>
                      </TableCell>
                      <TableCell><QuickActions rentRequestId={row.rent_request_id} workItem={workItems?.get(row.rent_request_id)} /></TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
            <PagerFooter page={page} totalRows={dueToday.data?.total_row_count ?? 0} onPage={setPage} />
          </CardContent>
        </Card>
      )}

      {tab === 'arrears' && (
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            {BUCKETS.map((b) => (
              <button
                key={b}
                type="button"
                onClick={() => {
                  setBucket(bucket === b ? null : b);
                  setPage(0);
                }}
                className={`rounded-lg border p-3 text-left ${bucket === b ? 'border-primary bg-primary/5' : ''}`}
              >
                <p className="text-xs text-muted-foreground">{b} days</p>
                <p className="text-sm font-semibold">{formatUGX(bucketSummary[b]?.arrears_ugx ?? 0)}</p>
                <p className="text-[10px] text-muted-foreground">{bucketSummary[b]?.count ?? 0} plans</p>
              </button>
            ))}
          </div>
          <Card className="border shadow-sm">
            <CardContent className="pt-4">
              <div className="overflow-auto rounded-lg border">
                <Table>
                  <TableHeader className="bg-muted/50">
                    <TableRow>
                      <TableHead className="text-xs">Tenant</TableHead>
                      <TableHead className="text-xs">Agent</TableHead>
                      <TableHead className="text-xs">Arrears</TableHead>
                      <TableHead className="text-xs">Oldest due</TableHead>
                      <TableHead className="text-xs">Age</TableHead>
                      <TableHead className="text-xs">Bucket</TableHead>
                      <TableHead className="text-xs">Actions</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {(arrears.data?.rows ?? []).map((row) => (
                      <TableRow key={row.rent_request_id} className="cursor-pointer" onClick={() => setOpenTenant(row.rent_request_id)}>
                        <TableCell className="text-xs">{row.tenant_name ?? '—'}</TableCell>
                        <TableCell className="text-xs">{row.agent_name ?? '—'}</TableCell>
                        <TableCell className="text-xs">{formatUGX(row.arrears_ugx)}</TableCell>
                        <TableCell className="text-xs">{dayLabel(row.oldest_due_date)}</TableCell>
                        <TableCell className="text-xs">{row.age_days}d</TableCell>
                        <TableCell className="text-xs"><Badge variant="outline" className="text-[10px]">{row.bucket}</Badge></TableCell>
                        <TableCell><QuickActions rentRequestId={row.rent_request_id} workItem={workItems?.get(row.rent_request_id)} /></TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
              <PagerFooter page={page} totalRows={arrears.data?.total_row_count ?? 0} onPage={setPage} />
            </CardContent>
          </Card>
        </div>
      )}

      {tab === 'movement' && (
        <Card className="border shadow-sm">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-semibold">Movement (last 7 days)</CardTitle>
            {movement.data && (
              <div className="flex flex-wrap gap-3 pt-1 text-xs text-muted-foreground">
                <span>Rolled in: <strong className="text-foreground">{movement.data.summary.rolled_in?.count ?? 0}</strong></span>
                <span>Recovered: <strong className="text-foreground">{movement.data.summary.recovered?.count ?? 0}</strong></span>
                <span>Completed: <strong className="text-foreground">{movement.data.summary.completed?.count ?? 0}</strong></span>
              </div>
            )}
          </CardHeader>
          <CardContent>
            <div className="overflow-auto rounded-lg border">
              <Table>
                <TableHeader className="bg-muted/50">
                  <TableRow>
                    <TableHead className="text-xs">Tenant</TableHead>
                    <TableHead className="text-xs">Agent</TableHead>
                    <TableHead className="text-xs">Movement</TableHead>
                    <TableHead className="text-xs">Amount</TableHead>
                    <TableHead className="text-xs">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {(movement.data?.rows ?? []).map((row, i) => (
                    <TableRow key={`${row.rent_request_id}-${i}`} className="cursor-pointer" onClick={() => setOpenTenant(row.rent_request_id)}>
                      <TableCell className="text-xs">{row.tenant_name ?? '—'}</TableCell>
                      <TableCell className="text-xs">{row.agent_name ?? '—'}</TableCell>
                      <TableCell className="text-xs"><Badge variant="outline" className="text-[10px]">{row.movement_type.replace('_', ' ')}</Badge></TableCell>
                      <TableCell className="text-xs">{formatUGX(row.amount_ugx)}</TableCell>
                      <TableCell><QuickActions rentRequestId={row.rent_request_id} workItem={workItems?.get(row.rent_request_id)} /></TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
            <PagerFooter page={page} totalRows={movement.data?.total_row_count ?? 0} onPage={setPage} />
          </CardContent>
        </Card>
      )}

      {tab === 'never-billed' && (
        <Card className="border shadow-sm">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-semibold">Never billed</CardTitle>
            {neverBilled.data && (
              <p className="pt-1 text-xs text-muted-foreground">{neverBilled.data.explanation}</p>
            )}
          </CardHeader>
          <CardContent>
            <div className="overflow-auto rounded-lg border">
              <Table>
                <TableHeader className="bg-muted/50">
                  <TableRow>
                    <TableHead className="text-xs">Tenant</TableHead>
                    <TableHead className="text-xs">Agent</TableHead>
                    <TableHead className="text-xs">Arrears (never billed)</TableHead>
                    <TableHead className="text-xs">Earliest due</TableHead>
                    <TableHead className="text-xs">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {(neverBilled.data?.rows ?? []).map((row) => (
                    <TableRow key={row.rent_request_id} className="cursor-pointer" onClick={() => setOpenTenant(row.rent_request_id)}>
                      <TableCell className="text-xs">{row.tenant_name ?? '—'}</TableCell>
                      <TableCell className="text-xs">{row.agent_name ?? '—'}</TableCell>
                      <TableCell className="text-xs">{formatUGX(row.never_billed_arrears_ugx)}</TableCell>
                      <TableCell className="text-xs">{dayLabel(row.earliest_due_date)}</TableCell>
                      <TableCell><QuickActions rentRequestId={row.rent_request_id} workItem={workItems?.get(row.rent_request_id)} /></TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
            <PagerFooter page={page} totalRows={neverBilled.data?.total_row_count ?? 0} onPage={setPage} />
          </CardContent>
        </Card>
      )}

      <TenantDrawer rentRequestId={openTenant} onOpenChange={(open) => !open && setOpenTenant(null)} />
    </div>
  );
}
