import { useMemo, useState, useEffect } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ChevronDown, ArrowUpDown, SlidersHorizontal, Check } from 'lucide-react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { cn } from '@/lib/utils';
import { ServiceCenterState } from '@/hooks/useAgentServiceCenter';
import { ImageZoomLightbox } from '@/components/executive/landlord-ops/ImageZoomLightbox';

const PAGE = 10;

export type SortKey = 'newest' | 'oldest' | 'name' | 'amount';

const STATE_LABEL: Record<ServiceCenterState, string> = {
  verified: 'Verified',
  pending: 'Pending',
  rejected: 'Rejected',
};

const STATE_CLASS: Record<ServiceCenterState, string> = {
  verified: 'bg-success/15 text-success border-success/25',
  pending: 'bg-warning/15 text-warning border-warning/25',
  rejected: 'bg-destructive/15 text-destructive border-destructive/25',
};

export function StateBadge({ state }: { state: ServiceCenterState }) {
  return (
    <Badge variant="outline" className={cn('shrink-0 text-[10px]', STATE_CLASS[state])}>
      {STATE_LABEL[state]}
    </Badge>
  );
}

export interface EntityRow {
  id: string;
  state: ServiceCenterState;
  primary: string;
  secondary?: string | null;
  amountLabel?: string | null;
  amountValue?: number | null;
  createdAt?: string | null;
  details: { label: string; value: string }[];
  /** Raw pipeline status used by the detailed status filter (optional). */
  statusKey?: string | null;
  /** Human label for statusKey, shown in the filter menu and row badge. */
  statusLabel?: string | null;
  /** Optional photo URLs rendered as thumbnails inside the expanded row. */
  images?: string[];
  /** Optional progress bar (0-100) rendered inside the expanded row. */
  progressPercent?: number | null;
  progressLabel?: string | null;
}

/**
 * Mobile-first list with status filters, sorting, 10-per-page "load more" and an
 * inline detail drawer that opens directly below the tapped row.
 * All data is already in memory — no extra round trips.
 */
export function SubAgentEntityList({
  heading,
  emptyLabel,
  rows,
  showAmountSort = true,
  resetKey,
  renderRowAction,
  hideHeading = false,
  showStatusFilter = false,
}: {
  heading: string;
  emptyLabel: string;
  rows: EntityRow[];
  showAmountSort?: boolean;
  resetKey?: string;
  renderRowAction?: (row: EntityRow) => React.ReactNode;
  hideHeading?: boolean;
  /** Adds a second dropdown filtering by the detailed `statusKey` of each row. */
  showStatusFilter?: boolean;
}) {
  const [filter, setFilter] = useState<'all' | ServiceCenterState>('all');
  const [statusFilter, setStatusFilter] = useState<string>('all');
  const [sort, setSort] = useState<SortKey>('newest');
  const [visible, setVisible] = useState(PAGE);
  const [openId, setOpenId] = useState<string | null>(null);
  const [lightbox, setLightbox] = useState<{ images: string[]; startIndex: number; open: boolean }>({
    images: [],
    startIndex: 0,
    open: false,
  });

  useEffect(() => {
    setFilter('all');
    setStatusFilter('all');
    setSort('newest');
    setVisible(PAGE);
    setOpenId(null);
  }, [resetKey]);

  const counts = useMemo(() => ({
    all: rows.length,
    verified: rows.filter((r) => r.state === 'verified').length,
    pending: rows.filter((r) => r.state === 'pending').length,
    rejected: rows.filter((r) => r.state === 'rejected').length,
  }), [rows]);

  const statusOptions = useMemo(() => {
    if (!showStatusFilter) return [] as { key: string; label: string; count: number }[];
    const map = new Map<string, { key: string; label: string; count: number }>();
    rows.forEach((r) => {
      if (!r.statusKey) return;
      const existing = map.get(r.statusKey);
      if (existing) existing.count += 1;
      else map.set(r.statusKey, {
        key: r.statusKey,
        label: r.statusLabel ?? r.statusKey.replace(/_/g, ' '),
        count: 1,
      });
    });
    return [...map.values()].sort((a, b) => b.count - a.count);
  }, [rows, showStatusFilter]);

  const sorted = useMemo(() => {
    let list = filter === 'all' ? [...rows] : rows.filter((r) => r.state === filter);
    if (statusFilter !== 'all') list = list.filter((r) => r.statusKey === statusFilter);
    const time = (v?: string | null) => (v ? new Date(v).getTime() || 0 : 0);
    switch (sort) {
      case 'oldest': return list.sort((a, b) => time(a.createdAt) - time(b.createdAt));
      case 'name': return list.sort((a, b) => a.primary.localeCompare(b.primary));
      case 'amount': return list.sort((a, b) => (b.amountValue ?? 0) - (a.amountValue ?? 0));
      default: return list.sort((a, b) => time(b.createdAt) - time(a.createdAt));
    }
  }, [rows, filter, statusFilter, sort]);

  useEffect(() => { setVisible(PAGE); setOpenId(null); }, [filter, statusFilter, sort]);

  const chips: ('all' | ServiceCenterState)[] = ['all', 'verified', 'pending', 'rejected'];
  const sorts: { key: SortKey; label: string }[] = [
    { key: 'newest', label: 'Newest' },
    { key: 'oldest', label: 'Oldest' },
    { key: 'name', label: 'A–Z' },
    ...(showAmountSort ? [{ key: 'amount' as SortKey, label: 'Highest' }] : []),
  ];

  return (
    <section className="space-y-2">
      {!hideHeading && (
        <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          {heading} ({rows.length})
        </h3>
      )}

      {rows.length === 0 ? (
        <p className="rounded-xl border border-dashed border-border p-4 text-center text-xs text-muted-foreground">
          {emptyLabel}
        </p>
      ) : (
        <>
          <div className="flex items-center gap-1.5">
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="outline"
                  size="sm"
                  className={cn(
                    'h-8 min-w-0 flex-1 justify-start gap-1.5 rounded-full px-3 text-[11px] font-medium',
                    filter !== 'all' && 'border-primary/40 bg-primary/10 text-primary',
                  )}
                >
                  <SlidersHorizontal className="h-3.5 w-3.5 shrink-0" />
                  <span className="truncate">
                    {filter === 'all' ? 'All' : STATE_LABEL[filter]} · {counts[filter]}
                  </span>
                  <ChevronDown className="ml-auto h-3.5 w-3.5 shrink-0 opacity-60" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="min-w-[10rem]">
                {chips.map((c) => (
                  <DropdownMenuItem
                    key={c}
                    onSelect={() => setFilter(c)}
                    className="text-xs"
                  >
                    <span className="flex-1">{c === 'all' ? 'All' : STATE_LABEL[c]}</span>
                    <span className="ml-2 tabular-nums text-muted-foreground">{counts[c]}</span>
                    {filter === c && <Check className="ml-2 h-3.5 w-3.5 text-primary" />}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>

            {statusOptions.length > 0 && (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    variant="outline"
                    size="sm"
                    className={cn(
                      'h-8 min-w-0 flex-1 justify-start gap-1.5 rounded-full px-3 text-[11px] font-medium',
                      statusFilter !== 'all' && 'border-primary/40 bg-primary/10 text-primary',
                    )}
                  >
                    <span className="truncate">
                      {statusFilter === 'all'
                        ? 'Any stage'
                        : statusOptions.find((s) => s.key === statusFilter)?.label ?? statusFilter}
                    </span>
                    <ChevronDown className="ml-auto h-3.5 w-3.5 shrink-0 opacity-60" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start" className="max-h-[60vh] min-w-[11rem] overflow-y-auto">
                  <DropdownMenuItem onSelect={() => setStatusFilter('all')} className="text-xs">
                    <span className="flex-1">Any stage</span>
                    <span className="ml-2 tabular-nums text-muted-foreground">{rows.length}</span>
                    {statusFilter === 'all' && <Check className="ml-2 h-3.5 w-3.5 text-primary" />}
                  </DropdownMenuItem>
                  {statusOptions.map((s) => (
                    <DropdownMenuItem key={s.key} onSelect={() => setStatusFilter(s.key)} className="text-xs">
                      <span className="flex-1 capitalize">{s.label}</span>
                      <span className="ml-2 tabular-nums text-muted-foreground">{s.count}</span>
                      {statusFilter === s.key && <Check className="ml-2 h-3.5 w-3.5 text-primary" />}
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>
            )}

            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="outline"
                  size="sm"
                  className="h-8 shrink-0 gap-1.5 rounded-full px-3 text-[11px] font-medium"
                >
                  <ArrowUpDown className="h-3.5 w-3.5" />
                  {sorts.find((s) => s.key === sort)?.label}
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="min-w-[8rem]">
                {sorts.map((s) => (
                  <DropdownMenuItem key={s.key} onSelect={() => setSort(s.key)} className="text-xs">
                    <span className="flex-1">{s.label}</span>
                    {sort === s.key && <Check className="ml-2 h-3.5 w-3.5 text-primary" />}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          </div>

          {sorted.length === 0 ? (
            <p className="rounded-xl border border-dashed border-border p-4 text-center text-xs text-muted-foreground">
              Nothing in this status.
            </p>
          ) : (
            <ul className="divide-y divide-border/60 overflow-hidden rounded-xl border border-border/60">
              {sorted.slice(0, visible).map((r) => {
                const isOpen = openId === r.id;
                return (
                  <li key={r.id}>
                    <button
                      type="button"
                      onClick={() => setOpenId(isOpen ? null : r.id)}
                      className="flex w-full items-center gap-2 px-3 py-2.5 text-left active:bg-accent/60"
                      aria-expanded={isOpen}
                    >
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-sm font-medium text-foreground">{r.primary}</div>
                        {r.secondary && (
                          <div className="mt-0.5 truncate text-xs text-muted-foreground">{r.secondary}</div>
                        )}
                      </div>
                      {r.amountLabel && (
                        <span className="shrink-0 text-xs font-semibold text-foreground">{r.amountLabel}</span>
                      )}
                      <StateBadge state={r.state} />
                      <ChevronDown
                        className={cn('h-4 w-4 shrink-0 text-muted-foreground transition-transform', isOpen && 'rotate-180')}
                      />
                    </button>

                    {isOpen && (
                      <div className="space-y-2 border-t border-border/60 bg-muted/40 px-3 py-3">
                        {r.images && r.images.length > 0 && (
                          <div className="flex gap-2 overflow-x-auto pb-1">
                            {r.images.map((src, i) => (
                              <button
                                key={`${r.id}-img-${i}`}
                                type="button"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  setLightbox({ images: r.images ?? [], startIndex: i, open: true });
                                }}
                                className="relative shrink-0 overflow-hidden rounded-lg border border-border/60 transition hover:opacity-90 focus-visible:ring-2 focus-visible:ring-primary"
                                aria-label={`View ${r.primary} photo ${i + 1} in full`}
                              >
                                <img
                                  src={src}
                                  alt={`${r.primary} photo ${i + 1}`}
                                  loading="lazy"
                                  className="h-20 w-28 object-cover"
                                />
                                <div className="absolute inset-0 flex items-center justify-center bg-black/0 hover:bg-black/20 transition">
                                  <span className="sr-only">Open full photo</span>
                                </div>
                              </button>
                            ))}
                          </div>
                        )}
                        {typeof r.progressPercent === 'number' && (
                          <div className="space-y-1">
                            <div className="flex items-center justify-between text-[10px] text-muted-foreground">
                              <span>Repayment progress</span>
                              <span className="tabular-nums font-medium text-foreground">
                                {r.progressLabel ?? `${Math.round(r.progressPercent)}%`}
                              </span>
                            </div>
                            <div className="h-1.5 w-full overflow-hidden rounded-full bg-border">
                              <div
                                className="h-full rounded-full bg-success"
                                style={{ width: `${Math.min(100, Math.max(0, r.progressPercent))}%` }}
                              />
                            </div>
                          </div>
                        )}
                        <dl className="grid grid-cols-1 gap-x-4 gap-y-1.5 sm:grid-cols-2">
                          {r.details.map((d) => (
                            <div key={d.label} className="min-w-0">
                              <dt className="text-[10px] uppercase tracking-wide text-muted-foreground">{d.label}</dt>
                              <dd className="break-words text-xs font-medium text-foreground">{d.value}</dd>
                            </div>
                          ))}
                        </dl>
                        {renderRowAction?.(r)}
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          )}

          {sorted.length > visible && (
            <Button variant="outline" size="sm" className="w-full" onClick={() => setVisible((n) => n + PAGE)}>
              Load more ({sorted.length - visible} left)
            </Button>
          )}
        </>
      )}

      <ImageZoomLightbox
        images={lightbox.images}
        startIndex={lightbox.open ? lightbox.startIndex : null}
        open={lightbox.open}
        onClose={() => setLightbox((s) => ({ ...s, open: false }))}
        altPrefix="House"
      />
    </section>
  );
}