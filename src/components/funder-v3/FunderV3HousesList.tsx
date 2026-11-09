import { forwardRef, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { AlertTriangle, Home, ListFilter, Loader2 } from 'lucide-react';
import type { FunderListingsViewApi, FeedEntry } from '@/components/supporter/FunderHouseListingsSection';
import { itemId, sortLabel } from '@/components/funder-new/utils';
import { FunderV3HouseCard } from './FunderV3HouseCard';

/** Above this many loaded cards the list renders only the rows near the screen. */
export const VIRTUALIZE_ABOVE = 60;

/** Column count for a list of this width. Matches the container-query grid below. */
export function columnsForWidth(width: number): number {
  if (width >= 1100) return 3;
  if (width >= 560) return 2;
  return 1;
}

export function cardIdOf(entry: Pick<FeedEntry, 'category' | 'item'>): string {
  return `${entry.category}:${itemId(entry.category, entry.item)}`;
}

export interface FunderV3HousesListHandle {
  /** Brings a card into view (rendering it first when the list is virtualized). Returns false if it is not loaded. */
  scrollToCard: (cardId: string) => boolean;
}

interface Props {
  api: FunderListingsViewApi;
  /** The element that scrolls this list (sheet body or list pane). */
  scrollRef: RefObject<HTMLElement | null>;
  highlightedId: string | null;
  /** Part of the scroller covered at the top (the pinned map): scrolling to a card keeps clear of it. */
  scrollPaddingTop?: number;
  onHoverCard?: (cardId: string | null) => void;
  reducedMotion?: boolean;
}

/**
 * Funder V3 list body. Every word, number and button comes from the listing
 * section's API (the same data, filters and paging as the live list): this
 * file only lays it out. "Show more" paging is unchanged; past 60 cards the
 * rows are windowed so a long scroll stays light on phones.
 */
export const FunderV3HousesList = forwardRef<FunderV3HousesListHandle, Props>(function FunderV3HousesList(
  { api, scrollRef, highlightedId, scrollPaddingTop = 0, onHoverCard, reducedMotion = false },
  ref,
) {
  const {
    items,
    feedLoading,
    feedError,
    refetchFeed,
    feedFetching,
    feedFetchingNext,
    feedHasNext,
    fetchNextFeed,
    remaining,
    effectiveSort,
    origin,
    filters,
    changeSort,
    withinFloatApplied,
  } = api;

  const listRef = useRef<HTMLDivElement | null>(null);
  const [columns, setColumns] = useState(1);
  const [scrollMargin, setScrollMargin] = useState(0);
  const virtual = items.length > VIRTUALIZE_ABOVE;

  // Column count and the list's offset inside its scroller, kept live.
  useLayoutEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const measure = () => {
      setColumns(columnsForWidth(list.clientWidth));
      const scroller = scrollRef.current;
      if (scroller) {
        const offset = list.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop;
        setScrollMargin(Math.max(0, Math.round(offset)));
      }
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(list);
    return () => observer.disconnect();
  }, [scrollRef, virtual, feedLoading]);

  const rows = useMemo(() => {
    if (!virtual) return [] as FeedEntry[][];
    const out: FeedEntry[][] = [];
    for (let index = 0; index < items.length; index += columns) out.push(items.slice(index, index + columns));
    return out;
  }, [items, columns, virtual]);

  const virtualizer = useVirtualizer({
    count: virtual ? rows.length : 0,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 430,
    overscan: 4,
    scrollMargin,
    scrollPaddingStart: scrollPaddingTop,
    enabled: virtual,
  });

  const scrollToCard = useCallback(
    (cardId: string) => {
      const index = items.findIndex((entry) => cardIdOf(entry) === cardId);
      if (index < 0) return false;
      const behavior: ScrollBehavior = reducedMotion ? 'auto' : 'smooth';
      if (virtual) {
        virtualizer.scrollToIndex(Math.floor(index / columns), { align: 'center' });
        return true;
      }
      const node = listRef.current?.querySelector<HTMLElement>(`[data-card-id="${CSS.escape(cardId)}"]`);
      node?.scrollIntoView({ block: 'center', behavior });
      return true;
    },
    [items, virtual, virtualizer, columns, reducedMotion],
  );

  useImperativeHandle(ref, () => ({ scrollToCard }), [scrollToCard]);

  // Re-measure when the column count changes (rows change height).
  useEffect(() => {
    if (virtual) virtualizer.measure();
  }, [columns, virtual, virtualizer]);

  const renderCard = (entry: FeedEntry, index: number) => {
    const id = itemId(entry.category, entry.item);
    const cardId = cardIdOf(entry);
    return (
      <FunderV3HouseCard
        key={cardId}
        cardId={cardId}
        category={entry.category}
        item={entry.item}
        saved={api.isSaved(entry.category, id)}
        selected={api.isSelected(entry.category, id)}
        distance={api.distanceFor(entry)}
        onSave={() => api.toggleSave(entry.category, id)}
        onSelect={() => api.toggleSelect(entry.category, entry.item)}
        onDetail={() => api.openDetail(entry.category, entry.item)}
        priority={index === 0}
        highlighted={highlightedId === cardId}
        onHoverChange={onHoverCard && entry.category === 'empty' ? (hovering) => onHoverCard(hovering ? cardId : null) : undefined}
      />
    );
  };

  return (
    <div className="flex flex-col gap-3" data-testid="fv3-list">
      {withinFloatApplied ? (
        <p className="px-1 fv3-t-xs text-muted-foreground">
          Within-balance is applied to the homes already loaded, because the read service has no balance filter.
        </p>
      ) : null}

      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 fv3-t-xs text-muted-foreground">
        <span className="rounded-full bg-primary/10 px-3 py-1 font-semibold text-primary">{sortLabel(effectiveSort)}</span>
        {effectiveSort === 'nearest' && origin ? (
          <span>
            Within {origin.radiusKm} km of {origin.label}
          </span>
        ) : null}
        {filters.sort === 'nearest' && !origin ? <span>Nearest needs your location</span> : null}
      </div>

      <div ref={listRef} className="@container">
        {feedLoading ? (
          <div className="grid grid-cols-1 gap-3 @[560px]:grid-cols-2 @[1100px]:grid-cols-3" aria-busy="true" aria-label="Loading homes">
            {Array.from({ length: 4 }).map((_, index) => (
              <div key={index} className="overflow-hidden rounded-2xl border border-border/60 bg-card">
                <div className="fv3-photo fv3-skeleton" />
                <div className="space-y-2 p-4">
                  <div className="fv3-skeleton h-4 w-3/4 rounded" />
                  <div className="fv3-skeleton h-5 w-1/3 rounded" />
                  <div className="fv3-skeleton h-11 w-full rounded-xl" />
                </div>
              </div>
            ))}
          </div>
        ) : feedError ? (
          <div role="alert" className="flex gap-3 rounded-2xl border border-warning/40 bg-warning/10 p-4 fv3-t-sm">
            <AlertTriangle className="mt-0.5 h-4 w-4 flex-none" aria-hidden />
            <div>
              <p className="font-semibold">These homes could not be loaded</p>
              <p className="mt-0.5 text-muted-foreground">
                Check your connection and try again.
                <button type="button" onClick={refetchFeed} className="ml-1 font-semibold text-primary underline-offset-2 hover:underline">
                  Retry
                </button>
              </p>
            </div>
          </div>
        ) : items.length === 0 ? (
          <div className="rounded-2xl border bg-primary/5 p-8 text-center">
            <ListFilter className="mx-auto h-8 w-8 text-primary/60" aria-hidden />
            <p className="mt-3 fv3-t-sm font-semibold">
              {effectiveSort === 'nearest' && origin ? `No homes within ${origin.radiusKm} km of ${origin.label}` : 'No homes match yet'}
            </p>
            <p className="mt-1 fv3-t-xs text-muted-foreground">
              {effectiveSort === 'nearest' && origin ? 'Widen the search to look further out.' : 'Try a different district, amount, or clear your filters.'}
            </p>
            {effectiveSort === 'nearest' && origin ? (
              <button
                type="button"
                onClick={() => changeSort('recommended')}
                className="fv3-tap mt-4 h-11 rounded-xl bg-primary/10 px-4 fv3-t-sm font-semibold text-primary hover:bg-primary/15"
              >
                Search the whole market
              </button>
            ) : null}
          </div>
        ) : virtual ? (
          <div
            className={feedFetching && !feedFetchingNext ? 'relative opacity-70 transition-opacity' : 'relative'}
            style={{ height: virtualizer.getTotalSize() }}
          >
            {virtualizer.getVirtualItems().map((row) => (
              <div
                key={row.key}
                data-index={row.index}
                ref={virtualizer.measureElement}
                className="absolute left-0 right-0 grid gap-3 pb-3"
                style={{
                  transform: `translateY(${row.start - scrollMargin}px)`,
                  gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`,
                }}
              >
                {rows[row.index]?.map((entry, offset) => renderCard(entry, row.index * columns + offset))}
              </div>
            ))}
          </div>
        ) : (
          <div
            className={
              feedFetching && !feedFetchingNext
                ? 'grid grid-cols-1 gap-3 opacity-70 transition-opacity @[560px]:grid-cols-2 @[1100px]:grid-cols-3'
                : 'grid grid-cols-1 gap-3 @[560px]:grid-cols-2 @[1100px]:grid-cols-3'
            }
          >
            {items.map((entry, index) => renderCard(entry, index))}
          </div>
        )}
      </div>

      {!feedLoading && !feedError && items.length > 0 && feedHasNext ? (
        <div className="flex justify-center pt-1">
          <button
            type="button"
            onClick={fetchNextFeed}
            disabled={feedFetchingNext}
            data-testid="fv3-show-more"
            className="fv3-tap inline-flex h-11 items-center gap-2 rounded-xl bg-primary px-6 fv3-t-sm font-semibold text-primary-foreground shadow-sm transition-colors hover:bg-primary/90 disabled:opacity-70"
          >
            {feedFetchingNext ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <Home className="h-4 w-4" aria-hidden />}
            {feedFetchingNext ? 'Loading' : `Show more homes${remaining > 0 ? ` (${remaining.toLocaleString()} left)` : ''}`}
          </button>
        </div>
      ) : null}
    </div>
  );
});

export default FunderV3HousesList;
