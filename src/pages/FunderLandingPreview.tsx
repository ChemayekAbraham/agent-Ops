import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { motion, useReducedMotion } from 'framer-motion';
import { AlertTriangle, Crosshair, Home, Loader2, Search } from 'lucide-react';
import { toast } from 'sonner';
import { useAuth } from '@/hooks/useAuth';
import { useProfile } from '@/hooks/useProfile';
import { useWalletBalance } from '@/hooks/wallet/useWalletBalance';
import { useFunderSavedItems } from '@/hooks/useFunderSavedItems';
import { useEmptyHouseMapCells, type MapViewport } from '@/hooks/useEmptyHouseMapCells';
import { generateWelileAiId } from '@/lib/welileAiId';
import { formatDynamic, formatDynamicCompact, getDynamicCurrencySymbol } from '@/lib/currencyFormat';
import { sortFunderFeedEntries } from '@/lib/funderHouseSort';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import EmptyHouseDetailSheet from '@/components/agent/EmptyHouseDetailSheet';
import { SelfPortfolioPlanDetailSheet } from '@/components/partner/SelfPortfolioPlanDetailSheet';
import { FunderNewHouseCard } from '@/components/funder-new/FunderNewHouseCard';
import { FunderNewReviewDialog, FunderNewSelectionBar } from '@/components/funder-new/FunderNewSelectionPanel';
import { useFunderNewLocation } from '@/components/funder-new/useFunderNewLocation';
import {
  useFunderNewEmptyHouses,
  useFunderNewMarketSummary,
  useFunderNewReadyPlans,
} from '@/components/funder-new/useFunderNewOpportunities';
import type { FunderNewMapCell, FunderNewViewport } from '@/components/funder-new/FunderNewRouteMap';
import type {
  FunderNewCategory,
  FunderNewEmptyHouse,
  FunderNewFilters,
  FunderNewOrigin,
  FunderNewReadyPlan,
  FunderNewSelectionItem,
} from '@/components/funder-new/types';
import { amountRange, itemCoordinates, itemId, toSelectionItem } from '@/components/funder-new/utils';
import { straightLineDistance } from '@/components/funder-new/distance';
import { FunderPreviewMap } from '@/components/funder-preview/FunderPreviewMap';

const DEFAULT_RADIUS_KM = 25;
const SEARCH_DEBOUNCE_MS = 350;
const COUNT_UP_MS = 900;

type CategoryFilter = 'all' | FunderNewCategory;

interface FeedEntry {
  category: FunderNewCategory;
  item: FunderNewEmptyHouse | FunderNewReadyPlan;
}

/** Eases a number from 0 to `target` once, on first real value. Skipped under reduced motion. */
function useCountUp(target: number | null, disabled: boolean): number | null {
  const [value, setValue] = useState<number | null>(disabled ? target : null);
  const playedRef = useRef(false);
  useEffect(() => {
    if (target === null) return;
    if (disabled || playedRef.current) {
      setValue(target);
      return;
    }
    playedRef.current = true;
    let frame = 0;
    const start = performance.now();
    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / COUNT_UP_MS);
      const eased = 1 - Math.pow(1 - t, 3);
      setValue(Math.round(target * eased));
      if (t < 1) frame = window.requestAnimationFrame(tick);
    };
    frame = window.requestAnimationFrame(tick);
    return () => window.cancelAnimationFrame(frame);
  }, [target, disabled]);
  return value;
}

/**
 * Preview of the map-first funder landing (design direction B).
 *
 * Mounted at /dashboard/funder-preview only; /dashboard/funder is untouched.
 * Every figure is live: the pending total and house count come from
 * empty_house_opportunity_summary, the map from the per-tile map cells, and
 * the list from the same feeds as /dashboard/funder-new. No wallet figure is
 * shown on the landing; the balance is read only for the review step.
 */
export default function FunderLandingPreview() {
  const reduceMotion = useReducedMotion() ?? false;
  const { user } = useAuth();
  const { profile } = useProfile();
  const wallet = useWalletBalance(user?.id);
  const summary = useFunderNewMarketSummary();
  const location = useFunderNewLocation();
  const { saved, toggleSave } = useFunderSavedItems();

  const displayName =
    profile?.full_name?.trim() ||
    (user?.user_metadata?.full_name as string | undefined)?.trim() ||
    (user?.email || '').split('@')[0] ||
    'Funder';
  const initials =
    displayName
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((part) => part[0]?.toUpperCase() ?? '')
      .join('') || 'W';
  const welileId = user ? generateWelileAiId(user.id) : '';

  // The profile picture, if the user has one. A broken/stale URL falls back to
  // the initials rather than leaving an empty circle.
  const avatarUrl = profile?.avatar_url ?? null;
  const [avatarFailed, setAvatarFailed] = useState(false);
  useEffect(() => {
    setAvatarFailed(false);
  }, [avatarUrl]);



  // ── Filters ──────────────────────────────────────────────────────────────
  const [searchInput, setSearchInput] = useState('');
  const [filters, setFilters] = useState<FunderNewFilters>({
    search: '',
    location: '',
    amount: 'all',
    sort: 'recommended',
    rentMin: null,
    rentMax: null,
    radiusKm: 'all',
    withinFloat: false,
  });
  const [category, setCategory] = useState<CategoryFilter>('all');
  const [sortTouched, setSortTouched] = useState(false);

  useEffect(() => {
    const id = window.setTimeout(() => {
      setFilters((current) => (current.search === searchInput ? current : { ...current, search: searchInput }));
    }, SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(id);
  }, [searchInput]);

  const origin: FunderNewOrigin | null = useMemo(() => {
    const chosenRadius = filters.radiusKm === 'all' ? null : filters.radiusKm;
    if (location.coords) {
      return {
        lat: location.coords.lat,
        lng: location.coords.lng,
        source: 'device',
        radiusKm: chosenRadius ?? DEFAULT_RADIUS_KM,
        label: 'your location',
      };
    }
    return null;
  }, [location.coords, filters.radiusKm]);

  const deviceOrigin = location.coords ? { lat: location.coords.lat, lng: location.coords.lng } : null;

  // Nearest-first becomes the default once there is an origin, unless the funder chose a sort.
  useEffect(() => {
    if (!origin || sortTouched || filters.sort === 'nearest') return;
    setFilters((current) => ({ ...current, sort: 'nearest' }));
  }, [origin, sortTouched, filters.sort]);

  // ── Feed ────────────────────────────────────────────────────────────────
  const emptyQuery = useFunderNewEmptyHouses(filters, origin, category !== 'ready');
  const readyQuery = useFunderNewReadyPlans(filters, category !== 'empty');

  const entries = useMemo<FeedEntry[]>(() => {
    const empty =
      category === 'ready'
        ? []
        : (emptyQuery.data?.pages ?? []).flatMap((page) => page.items).map((item): FeedEntry => ({ category: 'empty', item }));
    const ready =
      category === 'empty'
        ? []
        : (readyQuery.data?.pages ?? []).flatMap((page) => page.items).map((item): FeedEntry => ({ category: 'ready', item }));
    return sortFunderFeedEntries([...empty, ...ready]);
  }, [category, emptyQuery.data, readyQuery.data]);

  const feedLoading =
    (category !== 'ready' && emptyQuery.isLoading) || (category !== 'empty' && readyQuery.isLoading);
  const feedError = (category !== 'ready' && emptyQuery.error) || (category !== 'empty' && readyQuery.error);
  const feedFetchingNext = emptyQuery.isFetchingNextPage || readyQuery.isFetchingNextPage;
  const feedHasNext =
    (category !== 'ready' && !!emptyQuery.hasNextPage) || (category !== 'empty' && !!readyQuery.hasNextPage);

  const fetchNextRef = useRef<() => void>(() => {});
  fetchNextRef.current = () => {
    if (category !== 'ready' && emptyQuery.hasNextPage && !emptyQuery.isFetchingNextPage) emptyQuery.fetchNextPage();
    if (category !== 'empty' && readyQuery.hasNextPage && !readyQuery.isFetchingNextPage) readyQuery.fetchNextPage();
  };

  // Load the next page before the funder reaches the end of the list.
  const sentinelRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const node = sentinelRef.current;
    if (!node || !feedHasNext) return;
    const observer = new IntersectionObserver(
      (observed) => {
        if (observed.some((entry) => entry.isIntersecting)) fetchNextRef.current();
      },
      { rootMargin: '600px 0px' },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [feedHasNext, entries.length]);

  // ── Map ─────────────────────────────────────────────────────────────────
  const [viewport, setViewport] = useState<FunderNewViewport | null>(null);
  const [recentreToken, setRecentreToken] = useState(0);

  const cellViewport = useMemo<MapViewport | null>(
    () =>
      viewport
        ? { minLat: viewport.minLat, minLng: viewport.minLng, maxLat: viewport.maxLat, maxLng: viewport.maxLng, zoom: viewport.zoom }
        : null,
    [viewport],
  );
  const range = amountRange(filters.amount);
  const cellQuery = useEmptyHouseMapCells(
    cellViewport,
    { search: filters.search.trim() || undefined, minRent: range.min, maxRent: range.max },
    category !== 'ready',
  );
  const cells = useMemo<FunderNewMapCell[]>(
    () =>
      (cellQuery.data?.cells ?? []).map((cell) => ({
        key: cell.key,
        count: cell.count,
        lat: cell.latitude,
        lng: cell.longitude,
        amount: cell.minRent,
        house: (cell.house as unknown as FunderNewEmptyHouse | null) ?? null,
      })),
    [cellQuery.data],
  );
  const housesInView = cellQuery.data?.housesInView ?? 0;
  const neededInView = useMemo(
    () => (cellQuery.data?.cells ?? []).reduce((sum, cell) => sum + (Number(cell.sumRent) || 0), 0),
    [cellQuery.data],
  );

  const handleViewport = useCallback((next: FunderNewViewport) => {
    setViewport(next);
  }, []);

  // ── Selection, detail, review ───────────────────────────────────────────
  const [selectedCategory, setSelectedCategory] = useState<FunderNewCategory | null>(null);
  const [selectedItems, setSelectedItems] = useState<FunderNewSelectionItem[]>([]);
  const [detailHouse, setDetailHouse] = useState<FunderNewEmptyHouse | null>(null);
  const [detailPlan, setDetailPlan] = useState<FunderNewReadyPlan | null>(null);
  const [reviewOpen, setReviewOpen] = useState(false);
  const availableBalance = wallet.isLoading || wallet.error ? null : wallet.withdrawable;

  const toggleSelect = useCallback((nextCategory: FunderNewCategory, item: FunderNewEmptyHouse | FunderNewReadyPlan) => {
    const next = toSelectionItem(nextCategory, item);
    setSelectedCategory((current) => (current && current !== nextCategory ? nextCategory : current ?? nextCategory));
    setSelectedItems((current) => {
      const sameCategory = current.filter((entry) => entry.category === nextCategory);
      const exists = sameCategory.some((entry) => entry.id === next.id);
      const nextList = exists ? sameCategory.filter((entry) => entry.id !== next.id) : [...sameCategory, next];
      if (nextList.length === 0) setSelectedCategory(null);
      return nextList;
    });
  }, []);

  const removeSelected = (item: FunderNewSelectionItem) => {
    setSelectedItems((current) => {
      const nextList = current.filter((entry) => !(entry.category === item.category && entry.id === item.id));
      if (nextList.length === 0) setSelectedCategory(null);
      return nextList;
    });
  };

  const openDetail = useCallback((entryCategory: FunderNewCategory, item: FunderNewEmptyHouse | FunderNewReadyPlan) => {
    if (entryCategory === 'empty') setDetailHouse(item as FunderNewEmptyHouse);
    else setDetailPlan(item as FunderNewReadyPlan);
  }, []);

  const openHouseFromMap = useCallback((house: FunderNewEmptyHouse) => setDetailHouse(house), []);

  const selectedEmptyIds = useMemo(
    () => selectedItems.filter((item) => item.category === 'empty').map((item) => item.id),
    [selectedItems],
  );

  // ── Pending total ───────────────────────────────────────────────────────
  const total = summary.data ? summary.data.totalRentNeeded : null;
  const animatedTotal = useCountUp(total, reduceMotion);
  const prefix = getDynamicCurrencySymbol();
  const totalFigure =
    animatedTotal === null
      ? ''
      : formatDynamic(animatedTotal).replace(prefix, '').replace(/^[^\d.,-]+/, '').trim();

  const locate = () => {
    if (location.coords) {
      location.refresh();
      setRecentreToken((value) => value + 1);
    } else {
      location.request();
    }
  };

  const toggleNearest = () => {
    setSortTouched(true);
    if (!origin) {
      location.request();
      return;
    }
    setFilters((current) => ({ ...current, sort: current.sort === 'nearest' ? 'recommended' : 'nearest' }));
  };

  const chipClass = (on: boolean) =>
    cn(
      'h-9 flex-none rounded-full px-3.5 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
      on ? 'bg-primary text-primary-foreground' : 'border border-border bg-card text-foreground hover:bg-muted',
    );

  const enter = (delay: number) =>
    reduceMotion
      ? {}
      : {
          initial: { opacity: 0, y: 14 },
          animate: { opacity: 1, y: 0 },
          transition: { duration: 0.45, delay, ease: [0.22, 1, 0.36, 1] as const },
        };

  return (
    <div className="min-h-screen bg-background font-['Outfit'] text-foreground">
      {/* ═══ MAP HERO ═══ */}
      <div className="sticky top-0 h-[clamp(440px,66svh,620px)] w-full">
        <FunderPreviewMap
          cells={cells}
          device={location.coords}
          activeId={detailHouse?.house_id ?? null}
          selectedIds={selectedEmptyIds}
          recentreToken={recentreToken}
          onViewportChange={handleViewport}
          onOpenHouse={openHouseFromMap}
        />


      </div>

      {/* Floating top bar — fixed so it stays above the houses sheet while the sheet slides over the map. */}
      <div className="pointer-events-none fixed inset-x-0 top-0 z-20 mx-auto max-w-3xl px-4 pt-[max(1rem,env(safe-area-inset-top))]">
        <motion.div className="pointer-events-auto flex items-center gap-2.5" {...enter(0)}>
          <Link
            to={welileId ? `/profile/${welileId}` : '/profile'}
            aria-label="Your profile"
            className="flex h-12 w-12 flex-none items-center justify-center overflow-hidden rounded-full border-[3px] border-white bg-primary text-[15px] font-bold text-primary-foreground shadow-lg"
          >
            {avatarUrl && !avatarFailed ? (
              <img
                src={avatarUrl}
                alt=""
                onError={() => setAvatarFailed(true)}
                className="h-full w-full object-cover"
              />
            ) : (
              initials
            )}
          </Link>

          <label className="relative flex h-12 min-w-0 flex-1 items-center gap-2.5 rounded-full bg-card px-4 text-muted-foreground shadow-lg">
            <Search className="h-[18px] w-[18px] flex-none" aria-hidden />
            <span className="sr-only">Search an area</span>
            <input
              type="search"
              value={searchInput}
              onChange={(event) => setSearchInput(event.target.value)}
              placeholder="Where should we look?"
              className="h-full w-full min-w-0 flex-1 bg-transparent text-base text-foreground outline-none placeholder:text-muted-foreground"
            />
          </label>
          <button
            type="button"
            onClick={locate}
            aria-label={location.coords ? 'Recentre on my location' : 'Use my location'}
            className="flex h-12 w-12 flex-none items-center justify-center rounded-full bg-card text-primary shadow-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            {location.status === 'locating' ? (
              <Loader2 className="h-5 w-5 animate-spin" aria-hidden />
            ) : (
              <Crosshair className="h-5 w-5" aria-hidden />
            )}
          </button>
        </motion.div>
      </div>

      {/* ═══ HOUSES SHEET ═══ */}
      <motion.section
        aria-label="Houses to fund"
        className="relative z-10 -mt-8 rounded-t-[30px] bg-background shadow-[0_-10px_30px_hsl(222_47%_11%/0.12)]"
        {...(reduceMotion
          ? {}
          : { initial: { y: 40, opacity: 0 }, animate: { y: 0, opacity: 1 }, transition: { duration: 0.5, delay: 0.15, ease: [0.22, 1, 0.36, 1] } })}
      >
        <div className="mx-auto max-w-3xl space-y-4 px-4 pb-36 pt-2.5">
          <div aria-hidden className="mx-auto h-1.5 w-11 rounded-full bg-border" />

          <motion.section
            aria-label="Amount needed to fund houses"
            aria-busy={summary.isLoading}
            className="rounded-3xl bg-primary px-5 py-5 text-primary-foreground shadow-[0_14px_30px_-12px_hsl(var(--primary)/0.6)]"
            {...enter(0.08)}
          >
            {summary.isError ? (
              <>
                <h2 className="text-[15px] font-semibold">Amount needed to fund houses</h2>
                <p className="mt-1.5 text-sm text-primary-foreground/90">
                  The live total is unavailable right now. Houses below still load.
                </p>
              </>
            ) : (
              <>
                <h2 className="text-[15px] font-semibold">Amount needed to fund houses:</h2>
                {total === null ? (
                  <div className="mt-2.5 space-y-2">
                    <Skeleton className="h-10 w-64 bg-primary-foreground/20" />
                    <Skeleton className="h-4 w-32 bg-primary-foreground/20" />
                  </div>
                ) : (
                  <>
                    <p className="mt-2 flex items-baseline gap-2 leading-none">
                      <span className="text-[17px] font-medium text-primary-foreground/80">{prefix}</span>
                      <span className="text-[clamp(28px,9.6vw,42px)] font-bold tabular-nums tracking-tight">
                        {totalFigure}
                      </span>
                      <span className="sr-only">{formatDynamic(total)}</span>
                    </p>
                    <p className="mt-2.5 text-sm font-medium">
                      over {(summary.data?.houseCount ?? 0).toLocaleString()}+ homes
                    </p>
                  </>
                )}
              </>
            )}
          </motion.section>

          <div className="space-y-0.5">
            <h1 className="text-xl font-bold tracking-tight">
              {cellQuery.data
                ? `${housesInView.toLocaleString()} ${housesInView === 1 ? 'house' : 'houses'} in this view`
                : 'Houses to fund'}
            </h1>
            <p className="text-sm text-muted-foreground">
              {cellQuery.data && neededInView > 0
                ? `${formatDynamicCompact(neededInView)} needed in this area · move the map to explore`
                : 'Move the map to explore other areas'}
            </p>
          </div>

          <div role="group" aria-label="Filters" className="-mx-4 flex gap-2 overflow-x-auto px-4 pb-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
            <button type="button" aria-pressed={category === 'all'} className={chipClass(category === 'all')} onClick={() => setCategory('all')}>
              All
            </button>
            <button type="button" aria-pressed={category === 'empty'} className={chipClass(category === 'empty')} onClick={() => setCategory('empty')}>
              Empty homes
            </button>
            <button type="button" aria-pressed={category === 'ready'} className={chipClass(category === 'ready')} onClick={() => setCategory('ready')}>
              Tenant ready
            </button>
            <button type="button" aria-pressed={filters.sort === 'nearest'} className={chipClass(filters.sort === 'nearest')} onClick={toggleNearest}>
              Nearest
            </button>
            <button
              type="button"
              aria-pressed={filters.amount === 'under_300k'}
              className={chipClass(filters.amount === 'under_300k')}
              onClick={() =>
                setFilters((current) => ({ ...current, amount: current.amount === 'under_300k' ? 'all' : 'under_300k' }))
              }
            >
              Under 300K
            </button>
          </div>

          {feedLoading ? (
            <div className="grid gap-4 sm:grid-cols-2">
              {[0, 1].map((key) => (
                <div key={key} className="overflow-hidden rounded-lg border bg-card">
                  <Skeleton className="aspect-[16/10] w-full rounded-none" />
                  <div className="space-y-3 p-4">
                    <Skeleton className="h-5 w-3/4" />
                    <Skeleton className="h-4 w-1/3" />
                    <Skeleton className="h-6 w-1/2" />
                    <Skeleton className="h-11 w-full" />
                  </div>
                </div>
              ))}
            </div>
          ) : feedError ? (
            <div className="flex items-start gap-3 rounded-2xl border bg-card p-4 text-sm">
              <AlertTriangle className="mt-0.5 h-4 w-4 flex-none text-warning" aria-hidden />
              <div className="flex-1 space-y-2">
                <p>Houses could not be loaded. Please check your connection and try again.</p>
                <Button
                  size="sm"
                  variant="soft"
                  onClick={() => {
                    emptyQuery.refetch();
                    readyQuery.refetch();
                  }}
                >
                  Try again
                </Button>
              </div>
            </div>
          ) : entries.length === 0 ? (
            <div className="flex flex-col items-center gap-2 rounded-2xl border border-dashed bg-card px-6 py-10 text-center">
              <Home className="h-8 w-8 text-primary/50" aria-hidden />
              <p className="font-semibold">No houses match these filters</p>
              <p className="text-sm text-muted-foreground">Try another area or clear a filter.</p>
            </div>
          ) : (
            <div className="grid grid-cols-[minmax(0,1fr)] gap-0 sm:grid-cols-2 sm:gap-4 [&>*]:min-w-0 [&>*]:[content-visibility:auto] [&>*]:[contain-intrinsic-block-size:auto_420px]">
              {entries.map((entry, index) => {
                const id = itemId(entry.category, entry.item);
                const coords = itemCoordinates(entry.item, entry.category);
                return (
                  <motion.div
                    key={`${entry.category}:${id}`}
                    {...(reduceMotion
                      ? {}
                      : {
                          initial: { opacity: 0, y: 18 },
                          whileInView: { opacity: 1, y: 0 },
                          viewport: { once: true, margin: '0px 0px -40px 0px' },
                          transition: { duration: 0.4, delay: (index % 2) * 0.06, ease: [0.22, 1, 0.36, 1] },
                        })}
                  >
                    <FunderNewHouseCard
                      category={entry.category}
                      item={entry.item}
                      saved={saved[entry.category].includes(id)}
                      selected={selectedItems.some((item) => item.category === entry.category && item.id === id)}
                      distance={coords ? straightLineDistance(deviceOrigin, coords) : null}
                      onSave={() => toggleSave(entry.category, id)}
                      onSelect={() => toggleSelect(entry.category, entry.item)}
                      onDetail={() => openDetail(entry.category, entry.item)}
                    />
                  </motion.div>
                );
              })}
            </div>
          )}

          {feedHasNext ? (
            <div ref={sentinelRef} className="flex justify-center py-4 text-sm text-muted-foreground">
              {feedFetchingNext ? <Loader2 className="h-5 w-5 animate-spin" aria-label="Loading more houses" /> : null}
            </div>
          ) : null}
        </div>
      </motion.section>

      <EmptyHouseDetailSheet
        house={detailHouse}
        open={!!detailHouse}
        onOpenChange={(open) => {
          if (!open) setDetailHouse(null);
        }}
        isPicked={detailHouse ? selectedEmptyIds.includes(detailHouse.house_id) : false}
        onTogglePick={(house) => toggleSelect('empty', house as FunderNewEmptyHouse)}
        isPartner
        onRelatedHouseClick={(house) => setDetailHouse(house as FunderNewEmptyHouse)}
        remaining={availableBalance ?? undefined}
      />
      <SelfPortfolioPlanDetailSheet
        plan={detailPlan}
        open={!!detailPlan}
        onOpenChange={(open) => {
          if (!open) setDetailPlan(null);
        }}
        isFunded={false}
        onFund={(plan) => {
          const cost = Number(plan.funding_amount || 0);
          const available = availableBalance ?? 0;
          if (available >= cost) {
            if (!selectedItems.some((item) => item.category === 'ready' && item.id === plan.rent_request_id)) {
              toggleSelect('ready', plan as FunderNewReadyPlan);
            }
            setDetailPlan(null);
            setReviewOpen(true);
          } else {
            toast.info(`Not enough balance. Deposit ${formatDynamic(cost - available)} to fund this tenant.`);
            setDetailPlan(null);
          }
        }}
      />
      <FunderNewReviewDialog
        open={reviewOpen}
        onOpenChange={setReviewOpen}
        items={selectedItems}
        available={availableBalance}
        walletLoading={wallet.isLoading}
        walletError={wallet.error}
        onRemove={removeSelected}
      />
      <FunderNewSelectionBar
        items={selectedItems}
        category={selectedCategory}
        onClear={() => {
          setSelectedItems([]);
          setSelectedCategory(null);
        }}
        onReview={() => setReviewOpen(true)}
      />
    </div>
  );
}
