import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { ChevronLeft, ChevronRight, Receipt } from 'lucide-react';
import { useState } from 'react';
import { formatUGX } from '@/lib/rentCalculations';
import {
  SERVICE_CENTER_PAGE_SIZE,
  useServiceCenterTenantPayments,
} from '@/hooks/useServiceCenterPipeline';

const stamp = (v: string) =>
  new Date(v).toLocaleString('en-GB', {
    day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit',
    timeZone: 'Africa/Kampala',
  });

const METHOD_LABEL: Record<string, string> = {
  mobile_money: 'Mobile money',
  cash: 'Cash',
  in_app_wallet: 'Wallet',
};

/** Postgrest errors are plain objects, so String(err) yields "[object Object]". */
function describeError(err: unknown): string {
  if (!err) return 'Unknown error';
  if (err instanceof Error && err.message) return err.message;
  if (typeof err === 'string') return err;
  if (typeof err === 'object') {
    const e = err as Record<string, unknown>;
    const parts = [e.message, e.details, e.hint]
      .filter((p): p is string => typeof p === 'string' && p.trim().length > 0);
    const code = typeof e.code === 'string' && e.code ? ` (${e.code})` : '';
    if (parts.length) return `${parts.join(' — ')}${code}`;
    try {
      return JSON.stringify(err);
    } catch {
      return 'Unknown error';
    }
  }
  return String(err);
}

/** Paged payment history for a single tenant rent plan. */
export function ServiceCenterTenantPayments({ rentRequestId }: { rentRequestId: string }) {
  const [page, setPage] = useState(0);
  const { data, isLoading, error } = useServiceCenterTenantPayments(rentRequestId, page);

  const pageSize = data?.limit ?? SERVICE_CENTER_PAGE_SIZE;
  const total = data?.total ?? 0;
  const pages = Math.max(1, Math.ceil(total / pageSize));

  if (isLoading) {
    return <div className="space-y-2">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-9 w-full rounded-lg" />)}</div>;
  }

  if (error) {
    return (
      <div className="rounded-lg border border-destructive/40 bg-destructive/5 p-2.5">
        <p className="text-xs font-semibold text-destructive">Could not load payment history</p>
        <p className="mt-1 break-words text-[11px] text-destructive/90">
          {describeError(error)}
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <span className="inline-flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
          <Receipt className="h-3.5 w-3.5" /> Payment history
        </span>
        <span className="text-[11px] text-muted-foreground">
          {total} payment{total === 1 ? '' : 's'} · {formatUGX(Number(data?.total_amount ?? 0))}
        </span>
      </div>

      {total === 0 ? (
        <p className="rounded-lg border border-dashed border-border p-3 text-center text-xs text-muted-foreground">
          No payments recorded for this tenant yet.
        </p>
      ) : (
        <ul className="divide-y divide-border/60 overflow-hidden rounded-lg border border-border/60 bg-background">
          {(data?.items ?? []).map((p) => (
            <li key={`${p.source}-${p.id}`} className="flex items-center gap-2 px-2.5 py-2">
              <div className="min-w-0 flex-1">
                <div className="truncate text-xs font-medium text-foreground">{stamp(p.paid_at)}</div>
                <div className="truncate text-[11px] text-muted-foreground">
                  {[
                    p.method ? METHOD_LABEL[p.method] ?? p.method.replace(/_/g, ' ') : null,
                    p.collected_by ? `by ${p.collected_by}` : null,
                    p.reference,
                  ].filter(Boolean).join(' · ') || (p.source === 'repayment' ? 'Recorded repayment' : 'Field collection')}
                </div>
              </div>
              <Badge variant="outline" className="shrink-0 text-[10px]">
                {p.source === 'repayment' ? 'Repayment' : 'Collection'}
              </Badge>
              <span className="shrink-0 text-xs font-bold tabular-nums text-foreground">
                {formatUGX(Number(p.amount || 0))}
              </span>
            </li>
          ))}
        </ul>
      )}

      {pages > 1 && (
        <div className="flex items-center justify-between gap-2">
          <Button
            size="sm"
            variant="outline"
            className="h-7 px-2 text-[11px]"
            disabled={page === 0}
            onClick={() => setPage((n) => Math.max(0, n - 1))}
          >
            <ChevronLeft className="h-3.5 w-3.5" /> Previous
          </Button>
          <span className="text-[11px] text-muted-foreground">Page {page + 1} of {pages}</span>
          <Button
            size="sm"
            variant="outline"
            className="h-7 px-2 text-[11px]"
            disabled={page + 1 >= pages}
            onClick={() => setPage((n) => n + 1)}
          >
            Next <ChevronRight className="h-3.5 w-3.5" />
          </Button>
        </div>
      )}
    </div>
  );
}