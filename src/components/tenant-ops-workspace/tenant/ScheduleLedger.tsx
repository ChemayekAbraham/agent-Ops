/** Presentation only — every figure comes straight from tops_plan_schedule_ledger(), paged server-side. */
import { useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { formatUGX } from '@/lib/rentCalculations';
import {
  usePlanScheduleLedger,
  type PlanScheduleLedgerRow,
} from '@/hooks/tenantOpsWorkspace/usePlanScheduleLedger';

const PAGE_SIZE = 20;

const dayLabel = (iso: string | null | undefined) =>
  iso ? new Date(iso).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }) : '—';

function settledBySummary(row: PlanScheduleLedgerRow): string {
  if (!row.settled_by || row.settled_by.length === 0) return '—';
  return row.settled_by.map((s) => `${s.channel} · ${dayLabel(s.date)}`).join(', ');
}

/**
 * Mobile row, same shape as the existing Classic workspace mobile row
 * (title, corner badge, stacked label/value fields) — copied into this new
 * file rather than importing/modifying src/components/executive/tenant-ops/
 * workspace/WorkspaceMobileRow.tsx, which docs/TOPS_RULES.md rule 8 marks
 * read-only.
 */
function LedgerMobileRow({ row }: { row: PlanScheduleLedgerRow }) {
  return (
    <div className="rounded-lg border p-3">
      <div className="flex items-center justify-between gap-2">
        <p className="text-sm font-medium">{dayLabel(row.due_date)}</p>
        {row.never_billed && (
          <Badge variant="outline" className="text-[10px]">
            Never billed
          </Badge>
        )}
      </div>
      <dl className="mt-2 space-y-1 text-xs">
        <div className="flex justify-between">
          <dt className="text-muted-foreground">Amount due</dt>
          <dd className="font-medium tabular-nums">{formatUGX(row.amount_ugx)}</dd>
        </div>
        <div className="flex justify-between">
          <dt className="text-muted-foreground">Settled</dt>
          <dd className="font-medium tabular-nums">{formatUGX(row.settled_ugx)}</dd>
        </div>
        <div className="flex justify-between">
          <dt className="text-muted-foreground">Running arrears</dt>
          <dd className="font-medium tabular-nums">{formatUGX(row.running_arrears_ugx)}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Settled by</dt>
          <dd className="mt-0.5">{settledBySummary(row)}</dd>
        </div>
      </dl>
    </div>
  );
}

export interface ScheduleLedgerProps {
  rentRequestId: string;
}

export default function ScheduleLedger({ rentRequestId }: ScheduleLedgerProps) {
  const [page, setPage] = useState(0);
  const { data, isLoading, error } = usePlanScheduleLedger(rentRequestId, PAGE_SIZE, page * PAGE_SIZE);

  const pageRows = data?.rows ?? [];
  const totalRowCount = data?.totalRowCount ?? 0;
  const pageCount = Math.max(1, Math.ceil(totalRowCount / PAGE_SIZE));

  if (isLoading) {
    return (
      <Card className="border shadow-sm">
        <CardContent className="py-8 text-center text-sm text-muted-foreground">Loading schedule…</CardContent>
      </Card>
    );
  }

  if (error) {
    return (
      <Card className="border shadow-sm">
        <CardContent className="py-8 text-center text-sm text-destructive">
          Could not load this plan's schedule.
        </CardContent>
      </Card>
    );
  }

  if (totalRowCount === 0) {
    return (
      <Card className="border shadow-sm">
        <CardContent className="py-8 text-center text-sm text-muted-foreground">
          No instalments for this plan yet.
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="border shadow-sm">
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-semibold">Schedule</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="space-y-2 lg:hidden">
          {pageRows.map((row) => (
            <LedgerMobileRow key={row.seq} row={row} />
          ))}
        </div>

        <div className="hidden overflow-auto rounded-lg border lg:block">
          <Table>
            <TableHeader className="bg-muted/50">
              <TableRow>
                <TableHead className="text-xs">Due date</TableHead>
                <TableHead className="text-xs">Amount due</TableHead>
                <TableHead className="text-xs">Settled</TableHead>
                <TableHead className="text-xs">Settled by</TableHead>
                <TableHead className="text-xs">Running arrears</TableHead>
                <TableHead className="text-xs">Never billed</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {pageRows.map((row) => (
                <TableRow key={row.seq}>
                  <TableCell className="text-xs">{dayLabel(row.due_date)}</TableCell>
                  <TableCell className="text-xs tabular-nums">{formatUGX(row.amount_ugx)}</TableCell>
                  <TableCell className="text-xs tabular-nums">{formatUGX(row.settled_ugx)}</TableCell>
                  <TableCell className="text-xs">{settledBySummary(row)}</TableCell>
                  <TableCell className="text-xs tabular-nums">{formatUGX(row.running_arrears_ugx)}</TableCell>
                  <TableCell className="text-xs">
                    {row.never_billed ? (
                      <Badge variant="outline" className="text-[10px]">
                        Yes
                      </Badge>
                    ) : (
                      '—'
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>

        {pageCount > 1 && (
          <div className="flex items-center justify-between pt-1">
            <Button variant="outline" size="sm" disabled={page === 0} onClick={() => setPage((p) => Math.max(0, p - 1))}>
              Previous
            </Button>
            <p className="text-xs text-muted-foreground">
              Page {page + 1} of {pageCount}
            </p>
            <Button
              variant="outline"
              size="sm"
              disabled={page >= pageCount - 1}
              onClick={() => setPage((p) => Math.min(pageCount - 1, p + 1))}
            >
              Next
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
