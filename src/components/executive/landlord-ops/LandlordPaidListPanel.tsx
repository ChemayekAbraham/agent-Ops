import { useState, type ReactNode } from 'react';
import { AlertTriangle, Loader2, MapPin, RefreshCw } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { useLandlordPaidList } from '@/hooks/useLandlordPaidLists';
import { PAID_LIST_HELP, paidListErrorMessage, type PaidListRow, type PaidListTab } from '@/lib/landlordPaidLists';
import { formatUgx } from '@/lib/landlordTenants';
import { CallButtons } from './LandlordTenantsSection';

/**
 * The "Paid & Repaying" and "Completed" tabs of Landlord Ops -> Landlords: one card per landlord with the tenant count, total rent,
 * total repaid, balance left and the agent, and the same Review and Edit buttons as the other tabs. Loaded from landlord_ops_paid_lists
 * (the server decides who is listed and every figure); search and paging are the Landlords page's own.
 */
export function LandlordPaidListPanel({
  tab, search, page, perPage = 20, onPageChange, onEdit, renderReview, className,
}: {
  tab: PaidListTab;
  /** the (debounced) text from the page's search box */
  search: string;
  page: number;
  perPage?: number;
  onPageChange: (page: number) => void;
  onEdit: (row: PaidListRow) => void;
  /** what the Review button opens under the card (the Tenants section is part of it) */
  renderReview: (row: PaidListRow) => ReactNode;
  className?: string;
}) {
  const { data, isLoading, isError, error, refetch, isFetching } = useLandlordPaidList({ tab, search, page, perPage });
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const rows = data?.rows ?? [];
  const total = data?.total ?? 0;
  const pages = Math.max(1, Math.ceil(total / perPage));
  const safePage = Math.min(page, pages);
  const searching = search.trim().length > 0;

  if (isLoading) {
    return (
      <div className="flex items-center gap-2 rounded-xl border bg-card px-4 py-8 text-sm text-muted-foreground" role="status">
        <Loader2 className="h-4 w-4 animate-spin" /> Loading landlords…
      </div>
    );
  }
  if (isError) {
    return (
      <div role="alert" className="space-y-2 rounded-xl border border-destructive/30 bg-destructive/5 px-4 py-4">
        <p className="flex items-start gap-2 text-sm text-destructive"><AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" /> {paidListErrorMessage(error)}</p>
        <Button type="button" size="sm" variant="outline" className="h-8 gap-1.5" onClick={() => void refetch()} disabled={isFetching}>
          <RefreshCw className={cn('h-3.5 w-3.5', isFetching && 'animate-spin')} /> Try again
        </Button>
      </div>
    );
  }

  return (
    <div className={cn('space-y-2', className)}>
      <p className="text-[11px] text-muted-foreground">{PAID_LIST_HELP[tab]}</p>

      {rows.length === 0 ? (
        <p className="rounded-xl border border-dashed px-4 py-8 text-center text-sm text-muted-foreground">
          {searching ? 'No landlords match this search.' : tab === 'paid_repaying' ? 'No landlords have tenants repaying right now.' : 'No landlords have fully paid-off tenants yet.'}
        </p>
      ) : (
        <ul className={cn('space-y-2', isFetching && 'opacity-70')}>
          {rows.map((row) => (
            <li key={row.landlord_id} className="rounded-xl border bg-card" data-testid="paid-list-row">
              <div className="space-y-2.5 px-3 py-3">
                <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-2">
                  <div className="min-w-0 space-y-0.5">
                    <p className="break-words text-sm font-bold leading-tight">{row.landlord_name}</p>
                    {row.landlord_phone && <CallButtons phone={row.landlord_phone} name={row.landlord_name} />}
                    <div className="flex flex-wrap items-center gap-1 pt-0.5">
                      {row.verified
                        ? <Badge variant="outline" className="border-0 bg-emerald-100 px-1.5 py-0 text-[9px] text-emerald-700">Verified</Badge>
                        : <Badge variant="outline" className="border-0 bg-red-100 px-1.5 py-0 text-[9px] font-semibold text-red-700">Not Verified</Badge>}
                      {(row.district || row.village) && (
                        <span className="inline-flex items-center gap-0.5 text-[10px] text-muted-foreground"><MapPin className="h-3 w-3" />{[row.village, row.district].filter(Boolean).join(', ')}</span>
                      )}
                    </div>
                  </div>
                  <div className="flex items-center gap-1.5">
                    <Button type="button" size="sm" className="h-8 text-xs" variant={expandedId === row.landlord_id ? 'secondary' : 'default'}
                      aria-expanded={expandedId === row.landlord_id}
                      onClick={() => setExpandedId(expandedId === row.landlord_id ? null : row.landlord_id)}>
                      {expandedId === row.landlord_id ? 'Close' : 'Review'}
                    </Button>
                    <Button type="button" size="sm" variant="outline" className="h-8 text-xs" onClick={() => onEdit(row)}>Edit</Button>
                  </div>
                </div>

                <dl className="grid grid-cols-2 gap-x-3 gap-y-1.5 text-xs sm:grid-cols-4">
                  <Figure label="Tenants" value={row.tenant_count.toLocaleString('en-US')} />
                  <Figure label="Total rent" value={formatUgx(row.total_rent)} />
                  <Figure label="Total repaid" value={formatUgx(row.total_repaid)} />
                  <Figure label="Balance left" value={formatUgx(row.balance_left)} strong />
                </dl>

                <div className="border-t pt-2 text-xs">
                  <p className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">Agent</p>
                  {row.agent_name || row.agent_phone ? (
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5">
                      <span className="font-medium">{row.agent_name || 'Unnamed agent'}</span>
                      {row.agent_phone && <CallButtons phone={row.agent_phone} name={row.agent_name || 'Agent'} />}
                    </div>
                  ) : (
                    <span className="text-muted-foreground">No agent on record</span>
                  )}
                </div>
              </div>
              {expandedId === row.landlord_id && <div className="border-t bg-muted/20 px-3 py-3">{renderReview(row)}</div>}
            </li>
          ))}
        </ul>
      )}

      {total > perPage && (
        <div className="flex items-center justify-between pt-1">
          <span className="text-xs text-muted-foreground">
            Showing {(safePage - 1) * perPage + 1}–{Math.min(safePage * perPage, total)} of {total.toLocaleString('en-US')}
          </span>
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" onClick={() => onPageChange(Math.max(1, safePage - 1))} disabled={safePage <= 1}>Previous</Button>
            <span className="text-xs text-muted-foreground">Page {safePage} of {pages}</span>
            <Button variant="outline" size="sm" onClick={() => onPageChange(Math.min(pages, safePage + 1))} disabled={safePage >= pages}>Next</Button>
          </div>
        </div>
      )}
    </div>
  );
}

function Figure({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div>
      <dt className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</dt>
      <dd className={cn('tabular-nums', strong && 'font-semibold')}>{value}</dd>
    </div>
  );
}
