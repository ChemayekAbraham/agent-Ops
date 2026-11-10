import { createPortal } from 'react-dom';
import { Suspense, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { AlertTriangle, Clock, Filter, Home, ListFilter, Loader2, Search, X } from 'lucide-react';
import { Switch } from '@/components/ui/switch';
import { cn } from '@/lib/utils';
import { Input } from '@/components/ui/input';
import { useDebouncedValue } from '@/hooks/useDebouncedValue';
import { toast } from 'sonner';
import { formatDynamic } from '@/lib/currencyFormat';
import { lazyWithRetry } from '@/lib/lazyWithRetry';
import { useMountedOnce } from '@/hooks/useMountedOnce';
import { useAuth } from '@/hooks/useAuth';
import { FEATURE_FUNDERS_BOARD_TAGS, useFeaturePreview } from '@/hooks/useFeaturePreview';
import { useProfile } from '@/hooks/useProfile';
import { supabase } from '@/integrations/supabase/client';
import { useWalletBalance } from '@/hooks/wallet/useWalletBalance';
import { Button } from '@/components/ui/button';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Skeleton } from '@/components/ui/skeleton';
import EmptyHouseDetailSheet from '@/components/agent/EmptyHouseDetailSheet';
import { SelfPortfolioPlanDetailSheet } from '@/components/partner/SelfPortfolioPlanDetailSheet';
import { FunderNewHouseCard } from '@/components/funder-new/FunderNewHouseCard';
import { FunderNewReviewDialog, FunderNewSelectionBar } from '@/components/funder-new/FunderNewSelectionPanel';
import { FunderNewFilterDrawer } from '@/components/funder-new/FunderNewFilterDrawer';
import { useFunderNewLocation, type FunderNewLocationController } from '@/components/funder-new/useFunderNewLocation';
import {
  useFunderNewEmptyHouses,
  useFunderNewMarketSummary,
  useFunderNewReadyPlans,
} from '@/components/funder-new/useFunderNewOpportunities';
import type {
  FunderNewCategory,
  FunderNewEmptyHouse,
  FunderNewFilters,
  FunderNewOrigin,
  FunderNewReadyPlan,
  FunderNewSelectionItem,
  FunderNewSort,
  FunderNewDistance,
} from '@/components/funder-new/types';
import { countActiveFunderFilters, itemAmount, itemCoordinates, itemId, placeCase, sortLabel, toSelectionItem } from '@/components/funder-new/utils';
import { straightLineDistance } from '@/components/funder-new/distance';
import { sortFunderFeedEntries } from '@/lib/funderHouseSort';
import { useQuery } from '@tanstack/react-query';
import { fetchBoardItemTags, type BoardTag } from '@/lib/fundersBoard';
import { orderFeedByBoardTag, withinRadius } from '@/components/funder-new/feedOrder';
import { useFunderSavedItems } from '@/hooks/useFunderSavedItems';

export interface FeedEntry {
  category: FunderNewCategory;
  item: FunderNewEmptyHouse | FunderNewReadyPlan;
}

/**
 * Everything the listing already works out, handed to an alternative layout
 * (the funder V3 screen) through the `view` prop. Read-only values and the
 * section's own handlers: a view only arranges them, it computes nothing.
 */
export interface FunderListingsViewApi {
  /** E59: funders board tags are on for this viewer (switch or preview row). */
  boardTagsOn: boolean;
  /** E65: the card's tag (Verified, Booked, Funded, Pending verification, Empty house); null while tags are off. */
  boardTagOf: (entry: FeedEntry) => BoardTag | null;
  /** Totals for the header ("16 ready to fund · 783 houses"): Rent Plans ready to fund, and empty houses. */
  readyTotal: number;
  emptyTotal: number;
  /** Drop a chosen distance limit (back to every house in Uganda). */
  clearRadius: () => void;
  searchInput: string;
  setSearchInput: (value: string) => void;
  filters: FunderNewFilters;
  activeFilterCount: number;
  openFilters: () => void;
  effectiveSort: FunderNewSort;
  origin: FunderNewOrigin | null;
  changeSort: (value: FunderNewSort) => void;
  items: FeedEntry[];
  filteredTotal: number;
  remaining: number;
  feedLoading: boolean;
  feedError: boolean;
  feedFetching: boolean;
  feedFetchingNext: boolean;
  feedHasNext: boolean;
  refetchFeed: () => void;
  fetchNextFeed: () => void;
  withinFloatApplied: boolean;
  isSaved: (category: FunderNewCategory, id: string) => boolean;
  isSelected: (category: FunderNewCategory, id: string) => boolean;
  distanceFor: (entry: FeedEntry) => FunderNewDistance | null;
  toggleSave: (category: FunderNewCategory, id: string) => void;
  toggleSelect: (category: FunderNewCategory, item: FunderNewEmptyHouse | FunderNewReadyPlan) => void;
  openDetail: (category: FunderNewCategory, item: FunderNewEmptyHouse | FunderNewReadyPlan) => void;
  location: FunderNewLocationController;
}

/**
 * Single combined listing for /dashboard/funder — the exact cards, filters and
 * data of /dashboard/funder-new, with Rent Plans first and empty houses below.
 * There are no tabs: one feed, one list.
 */
// The top-up dialog is only needed after a tap; keep its (large) code out of opening the list.
const DepositFlow = lazyWithRetry(() => import('@/components/payments/DepositFlow'));

export type FunderListMapFilters = Pick<FunderNewFilters, 'search' | 'location' | 'amount'>;

export function FunderHouseListingsSection({
  searchOnMap = false,
  onFiltersChange,
  onResultsFocus,
  onResultCountChange,
  view,
}: {
  /** Optional alternative layout (funder V3). Replaces the search, list and paging markup only; data, filters and every dialog stay here. */
  view?: (api: FunderListingsViewApi) => ReactNode;
  searchOnMap?: boolean;
  /** Reports the search, district and amount the list is using, so a map on the same screen can match it. */
  onFiltersChange?: (filters: FunderListMapFilters) => void;
  /** With a search typed, reports where the matching empty houses are so the map can move to them. */
  onResultsFocus?: (points: { lat: number; lng: number }[]) => void;
  onResultCountChange?: (count: number) => void;
} = {}) {
  const { user } = useAuth();
  const boardTagsOn = useFeaturePreview(FEATURE_FUNDERS_BOARD_TAGS);
  const { profile } = useProfile();
  const wallet = useWalletBalance(user?.id);
  const location = useFunderNewLocation();
  const summary = useFunderNewMarketSummary();

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
  const [sortTouched, setSortTouched] = useState(false);
  const { saved, toggleSave } = useFunderSavedItems();
  const [selectedCategory, setSelectedCategory] = useState<FunderNewCategory | null>(null);
  const [selectedItems, setSelectedItems] = useState<FunderNewSelectionItem[]>([]);
  const [detailHouse, setDetailHouse] = useState<FunderNewEmptyHouse | null>(null);
  const [detailPlan, setDetailPlan] = useState<FunderNewReadyPlan | null>(null);
  const [reviewOpen, setReviewOpen] = useState(false);
  const [filtersOpen, setFiltersOpen] = useState(false);
  // Top-up launched from the detail sheet's Fund button when the balance
  // doesn't cover the house's rent — the deposit opens with the shortfall.
  const [topUpAmount, setTopUpAmount] = useState<number | null>(null);
  const mountDeposit = useMountedOnce(topUpAmount !== null);

  // Quick search bar next to the Filters button. Debounced so the listing
  // queries don't refetch on every keystroke. The same text feeds BOTH the
  // empty-house read (server-side fuzzy match on house type, district,
  // village, sub-county) and the rent-plan read (client-side match), so a
  // search unions both sets; empty houses are matched first and rent plans
  // act as the fallback when no empty house matches.
  const [searchInput, setSearchInput] = useState('');
  const debouncedSearch = useDebouncedValue(searchInput, 300);
  useEffect(() => {
    setFilters((current) =>
      current.search === debouncedSearch ? current : { ...current, search: debouncedSearch },
    );
  }, [debouncedSearch]);

  useEffect(() => {
    onFiltersChange?.({ search: filters.search, location: filters.location, amount: filters.amount });
  }, [filters.search, filters.location, filters.amount, onFiltersChange]);

  /**
   * Single origin for distance labels and the nearest-first sort: the device
   * position. There is no map area picker on this dashboard.
   */
  const origin: FunderNewOrigin | null = useMemo(() => {
    const chosenRadius = filters.radiusKm === 'all' ? null : filters.radiusKm;
    if (location.coords) {
      return {
        lat: location.coords.lat,
        lng: location.coords.lng,
        source: 'device',
        // "All distances" means no cut-off: nearest-first ordering only.
        radiusKm: chosenRadius,
        label: 'your location',
      };
    }
    return null;
  }, [location.coords, filters.radiusKm]);

  /** Distance labels always measure from the real device position. */
  const deviceOrigin = location.coords ? { lat: location.coords.lat, lng: location.coords.lng } : null;

  // Nearest-first becomes the default the moment an origin exists, unless the
  // user has already chosen a sort themselves.
  const appliedOriginRef = useRef(false);
  useEffect(() => {
    if (!origin || sortTouched || appliedOriginRef.current) return;
    appliedOriginRef.current = true;
    setFilters((current) => ({ ...current, sort: 'nearest' }));
  }, [origin, sortTouched]);

  // By default the list shows only Rent Plans with a verified tenant. Houses
  // still pending verification are opt-in from the Filters drawer.
  const [includePending, setIncludePending] = useState(false);
  const emptyQuery = useFunderNewEmptyHouses(filters, origin, includePending);
  const readyQuery = useFunderNewReadyPlans(filters, true);

  // Verified Rent Plans are a short list (tens, not thousands), so load all of
  // them up front instead of making the funder scroll for the next page.
  useEffect(() => {
    if (includePending) return;
    if (readyQuery.hasNextPage && !readyQuery.isFetchingNextPage && !readyQuery.isError) {
      void readyQuery.fetchNextPage();
    }
  }, [includePending, readyQuery.hasNextPage, readyQuery.isFetchingNextPage, readyQuery.isError, readyQuery.fetchNextPage]);

  // A switched-off query keeps its last results cached, so ignore them unless
  // pending houses are switched on.
  const emptyItems = useMemo(
    () => (includePending ? (emptyQuery.data?.pages ?? []).flatMap((page) => page.items) : []),
    [emptyQuery.data, includePending],
  );
  const readyItems = useMemo(
    () => (readyQuery.data?.pages ?? []).flatMap((page) => page.items),
    [readyQuery.data],
  );

  // Like a maps app, a search moves the map to what it found. Only the first
  // page of matches is used, and only when the set of places actually changes.
  const focusSignatureRef = useRef('');
  useEffect(() => {
    if (!onResultsFocus) return;
    if (!filters.search.trim()) {
      focusSignatureRef.current = '';
      return;
    }
    if (emptyQuery.isFetching) return;
    const points = emptyItems
      .slice(0, 12)
      .map((house) => {
        const record = house as unknown as Record<string, unknown>;
        return { lat: Number(record.latitude), lng: Number(record.longitude) };
      })
      .filter((point) => Number.isFinite(point.lat) && Number.isFinite(point.lng) && (point.lat !== 0 || point.lng !== 0));
    const signature = `${filters.search.trim()}|${points.map((point) => `${point.lat.toFixed(4)},${point.lng.toFixed(4)}`).join(';')}`;
    if (points.length === 0 || signature === focusSignatureRef.current) return;
    focusSignatureRef.current = signature;
    onResultsFocus(points);
  }, [emptyItems, emptyQuery.isFetching, filters.search, onResultsFocus]);

  // E65: each rent request's tag on the funders board (Verified, Booked, Funded,
  // Pending verification). Under 'funder-new' so a demote refreshes it too.
  const boardTagsQuery = useQuery({
    queryKey: ['funder-new', 'board-tags'],
    queryFn: fetchBoardItemTags,
    enabled: boardTagsOn,
    staleTime: 60_000,
  });
  const boardTagOf = useCallback(
    (entry: FeedEntry): BoardTag | null => {
      if (!boardTagsOn) return null;
      if (entry.category === 'empty') return 'empty_house';
      return boardTagsQuery.data?.get(itemId('ready', entry.item)) ?? 'verified';
    },
    [boardTagsOn, boardTagsQuery.data],
  );
  const kmOf = useCallback(
    (entry: FeedEntry): number | null => {
      const coords = itemCoordinates(entry.item, entry.category);
      return coords ? straightLineDistance(deviceOrigin, coords)?.km ?? null : null;
    },
    // deviceOrigin is rebuilt each render; its numbers are what matter.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [deviceOrigin?.lat, deviceOrigin?.lng],
  );
  const orderSort: FunderNewSort = filters.sort === 'nearest' && !origin ? 'recommended' : filters.sort;

  /**
   * Rent Plans first, empty houses below — one list, no tabs. With the E65 tags
   * on: tag group first (Verified, Booked, Funded, Pending verification, Empty
   * houses), then the chosen sort inside each group.
   */
  const loadedItems = useMemo<FeedEntry[]>(() => {
    const base = sortFunderFeedEntries([
      ...readyItems.map((item): FeedEntry => ({ category: 'ready', item })),
      ...emptyItems.map((item): FeedEntry => ({ category: 'empty', item })),
    ]);
    if (!boardTagsOn) return base;
    return orderFeedByBoardTag(base, (entry) => boardTagOf(entry) ?? 'empty_house', orderSort, kmOf);
  }, [readyItems, emptyItems, boardTagsOn, boardTagOf, orderSort, kmOf]);

  const feedLoading = (includePending && emptyQuery.isLoading) || readyQuery.isLoading;
  const feedError = (includePending && emptyQuery.error) || readyQuery.error;
  const feedFetching = (includePending && emptyQuery.isFetching) || readyQuery.isFetching;
  const feedFetchingNext = (includePending && emptyQuery.isFetchingNextPage) || readyQuery.isFetchingNextPage;
  const feedHasNext = (includePending && !!emptyQuery.hasNextPage) || !!readyQuery.hasNextPage;
  const refetchFeed = () => {
    if (includePending) emptyQuery.refetch();
    readyQuery.refetch();
  };
  const fetchNextFeed = () => {
    if (includePending && emptyQuery.hasNextPage && !emptyQuery.isFetchingNextPage) emptyQuery.fetchNextPage();
    if (readyQuery.hasNextPage && !readyQuery.isFetchingNextPage) readyQuery.fetchNextPage();
  };

  const readyTotal = readyQuery.data?.pages?.[0]?.total ?? 0;
  const emptyTotal = includePending ? (emptyQuery.data?.pages?.[0]?.total ?? 0) : 0;
  const filteredTotal = readyTotal + emptyTotal;

  // Support is funded from operational float only, never from withdrawable money.
  const availableBalance = wallet.isLoading || wallet.error ? null : wallet.floatBalance;

  /**
   * District chip lists every district in the whole market (from the summary
   * service), not just the page of homes currently loaded. Any district found
   * on loaded homes but missing from the summary is merged in so the select
   * never hides the active filter value.
   */
  const districtOptions = useMemo(() => {
    const counts = new Map<string, { label: string; count: number }>();
    (summary.data?.districts ?? []).forEach((item) => {
      counts.set(item.value, { label: item.label, count: item.count });
    });
    loadedItems.forEach(({ item }) => {
      const raw = (item as unknown as Record<string, unknown>).district;
      const value = typeof raw === 'string' ? raw.trim() : '';
      if (!value || counts.has(value)) return;
      counts.set(value, { label: placeCase(value) || value, count: 0 });
    });
    return [...counts.entries()]
      .map(([value, meta]) => ({ value, label: meta.label, count: meta.count }))
      .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
  }, [summary.data, loadedItems]);

  /**
   * The within-balance chip is applied to the homes already loaded, because the
   * read service has no balance parameter. The chip row says so.
   */
  const radiusKm = origin?.radiusKm ?? null;
  const items = useMemo(() => {
    let list = loadedItems;
    // A chosen distance limit: the empty-house read applies it on the server;
    // the Rent Plan read has no radius, so loaded plans are measured here.
    if (radiusKm !== null) list = list.filter((entry) => entry.category === 'empty' || withinRadius(kmOf(entry), radiusKm));
    if (!filters.withinFloat || availableBalance === null) return list;
    return list.filter((entry) => {
      const amount = itemAmount(entry.category, entry.item);
      return amount > 0 && amount <= availableBalance;
    });
  }, [loadedItems, filters.withinFloat, availableBalance, radiusKm, kmOf]);

  // Report every house that matches, not just the page loaded so far. The
  // within-balance filter only runs on loaded homes, so it reports those.
  const matchingCount = filters.withinFloat && availableBalance !== null
    ? items.length
    : Math.max(filteredTotal, items.length);
  useEffect(() => {
    onResultCountChange?.(matchingCount);
  }, [matchingCount, onResultCountChange]);

  // Keep loading the next page as the funder nears the end of the list, so the
  // whole market is reachable by scrolling. The button stays as a fallback.
  const loadMoreRef = useRef<HTMLDivElement | null>(null);
  const fetchNextFeedRef = useRef<() => void>(() => {});
  fetchNextFeedRef.current = fetchNextFeed;
  useEffect(() => {
    const node = loadMoreRef.current;
    if (!node || typeof IntersectionObserver === 'undefined') return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) fetchNextFeedRef.current();
      },
      { rootMargin: '800px 0px' },
    );
    observer.observe(node);
    return () => observer.disconnect();
  });

  const effectiveSort: FunderNewSort = filters.sort === 'nearest' && !origin ? 'recommended' : filters.sort;

  // How many filters the funder has actually switched on. The Filters button
  // badges this number and turns purple while it is above zero.
  const activeFilterCount = countActiveFunderFilters(filters) + (includePending ? 1 : 0);
  const filtersActive = activeFilterCount > 0;

  const resetFilters = () => {
    setIncludePending(false);
    setFilters((current) => ({
      search: '',
      location: '',
      amount: 'all',
      sort: current.sort,
      rentMin: null,
      rentMax: null,
      radiusKm: 'all',
      withinFloat: false,
    }));
  };

  const changeSort = (value: FunderNewSort) => {
    setSortTouched(true);
    setFilters((current) => ({ ...current, sort: value }));
  };

  const toggleSelect = useCallback((category: FunderNewCategory, item: FunderNewEmptyHouse | FunderNewReadyPlan) => {
    const next = toSelectionItem(category, item);
    setSelectedCategory((current) => (current && current !== category ? category : current ?? category));
    setSelectedItems((current) => {
      const sameCategory = current.filter((entry) => entry.category === category);
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

  const openDetail = useCallback((category: FunderNewCategory, item: FunderNewEmptyHouse | FunderNewReadyPlan) => {
    if (category === 'empty') {
      setDetailHouse(item as FunderNewEmptyHouse);
      return;
    }
    setDetailPlan(item as FunderNewReadyPlan);
  }, []);

  const remaining = Math.max(0, filteredTotal - items.length);

  const viewApi: FunderListingsViewApi | null = view
    ? {
        boardTagsOn,
        boardTagOf,
        readyTotal,
        emptyTotal,
        clearRadius: () => setFilters((current) => ({ ...current, radiusKm: 'all' })),
        searchInput,
        setSearchInput,
        filters,
        activeFilterCount,
        openFilters: () => setFiltersOpen(true),
        effectiveSort,
        origin,
        changeSort,
        items,
        filteredTotal,
        remaining,
        feedLoading,
        feedError: !!feedError,
        feedFetching,
        feedFetchingNext,
        feedHasNext,
        refetchFeed,
        fetchNextFeed,
        withinFloatApplied: filters.withinFloat && availableBalance !== null,
        isSaved: (category, id) => saved[category].includes(id),
        isSelected: (category, id) => selectedItems.some((selected) => selected.category === category && selected.id === id),
        distanceFor: (entry) => {
          const coords = itemCoordinates(entry.item, entry.category);
          return coords ? straightLineDistance(deviceOrigin, coords) : null;
        },
        toggleSave,
        toggleSelect,
        openDetail,
        location,
      }
    : null;

  return (
    <section className="space-y-3">
      {viewApi ? view!(viewApi) : (<>
      {/* On the full screen map the search floats at the top, like a maps app. */}
      {searchOnMap && typeof document !== 'undefined' && createPortal(
        <div
          className="fn-map-search-float pointer-events-none fixed inset-x-0 top-0 z-[90] mx-auto max-w-lg px-3 pt-[max(0.75rem,env(safe-area-inset-top))]"
          // This bar renders in a portal but is still a React child of the bottom
          // sheet, so its presses would otherwise reach the sheet's drag handlers.
          onMouseDown={(event) => event.stopPropagation()}
          onPointerDown={(event) => event.stopPropagation()}
          onTouchStart={(event) => event.stopPropagation()}
          onTouchMove={(event) => event.stopPropagation()}
          onTouchEnd={(event) => event.stopPropagation()}
        >
          <div className="pointer-events-auto mx-auto flex h-12 w-full max-w-lg items-center gap-2 rounded-full bg-card pl-4 pr-1.5 shadow-[0_2px_10px_rgba(0,0,0,0.25)] ring-1 ring-black/5">
            <Search className="h-5 w-5 shrink-0 text-muted-foreground" aria-hidden />
            <input
              value={searchInput}
              onChange={(event) => setSearchInput(event.target.value)}
              placeholder="Search house type or location…"
              aria-label="Search houses and rent plans by type or location"
              autoComplete="off"
              autoCorrect="off"
              spellCheck={false}
              className="min-w-0 flex-1 bg-transparent text-[15px] text-foreground outline-none placeholder:text-muted-foreground"
            />
            {searchInput ? (
              <button
                type="button"
                aria-label="Clear search"
                onClick={() => setSearchInput('')}
                className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-muted-foreground hover:bg-muted hover:text-foreground"
              >
                <X className="h-4 w-4" aria-hidden />
              </button>
            ) : null}
            <button
              type="button"
              aria-label={filtersActive ? `Filters, ${activeFilterCount} applied` : 'Filters'}
              onClick={() => setFiltersOpen(true)}
              className={`relative flex h-9 w-9 shrink-0 items-center justify-center rounded-full hover:bg-muted ${filtersActive ? 'text-primary' : 'text-muted-foreground'}`}
            >
              <Filter className="h-5 w-5" aria-hidden />
              {filtersActive ? (
                <span className="absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-primary px-1 text-[10px] font-bold leading-none text-primary-foreground" aria-hidden>
                  {activeFilterCount}
                </span>
              ) : null}
            </button>
          </div>
        </div>,
        document.body,
      )}
      {!searchOnMap && (
      <>
      {/* Search + compact filters row */}
      <div className="flex flex-wrap gap-2 rounded-2xl bg-card p-2.5 sm:p-3 sm:shadow-sm">
        <div className="relative min-w-0 flex-1">
          <Search
            className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
            aria-hidden
          />
          <Input
            value={searchInput}
            onChange={(event) => setSearchInput(event.target.value)}
            placeholder="Search house type or location…"
            aria-label="Search houses and rent plans by type or location"
            className="h-11 rounded-xl pl-9 pr-9 text-sm"
          />
          {searchInput ? (
            <button
              type="button"
              aria-label="Clear search"
              onClick={() => setSearchInput('')}
              className="absolute right-2 top-1/2 -translate-y-1/2 rounded-full p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
            >
              <X className="h-4 w-4" aria-hidden />
            </button>
          ) : null}
        </div>
        <Button
          variant="outline"
          aria-label={filtersActive ? `Filters, ${activeFilterCount} applied` : 'Filters'}
          className={`relative h-11 w-11 shrink-0 justify-center rounded-xl p-0 text-sm md:w-auto md:justify-start md:px-4 ${
            filtersActive ? 'border-primary text-primary md:border-primary' : 'border-transparent md:border-input'
          }`}
          onClick={() => setFiltersOpen(true)}
        >
          {/* Phones: funnel icon only. Tablets and up: the original labelled button. */}
          <Filter className="h-4 w-4 md:hidden" aria-hidden />
          <ListFilter className="hidden h-4 w-4 md:block" aria-hidden />
          <span className="hidden md:inline">Filters</span>
          {filtersActive ? (
            <>
              {/* Phones: the count rides on the corner of the icon button. */}
              <span
                className="absolute -right-1 -top-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-primary px-1 text-[10px] font-bold leading-none text-primary-foreground md:hidden"
                aria-hidden
              >
                {activeFilterCount}
              </span>
              {/* Tablet and up: the count sits beside the label. */}
              <span
                className="ml-1.5 hidden h-4 min-w-4 items-center justify-center rounded-full bg-primary/10 px-1 text-[10px] font-bold leading-none text-primary md:inline-flex"
                aria-hidden
              >
                {activeFilterCount}
              </span>
            </>
          ) : null}
        </Button>
      </div>
      </>
      )}

      {filters.withinFloat && availableBalance !== null ? (
        <p className="px-1 text-xs text-muted-foreground">
          Within-balance is applied to the homes already loaded, because the read service has no balance filter.
        </p>
      ) : null}

      {/* Applied context: what is loaded, and by which order */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
        <span className="rounded-full bg-primary/10 px-3 py-1 text-xs font-semibold text-primary">{sortLabel(effectiveSort)}</span>
        {origin && origin.radiusKm !== null ? (
          <span>Within {origin.radiusKm} km of {origin.label}</span>
        ) : effectiveSort === 'nearest' && origin ? (
          <span>Closest to {origin.label} first</span>
        ) : null}
        {filters.sort === 'nearest' && !origin ? <span>Nearest needs your location</span> : null}
      </div>

      {/* Listings — Rent Plans first, then empty houses */}
      {feedLoading ? (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {Array.from({ length: 6 }).map((_, index) => (
            <Skeleton key={index} className="h-40 rounded-2xl" />
          ))}
        </div>
      ) : feedError ? (
        <Alert variant="warning" className="rounded-2xl border-warning/40 bg-warning/10">
          <AlertTriangle className="h-4 w-4" />
          <AlertTitle>These homes could not be loaded</AlertTitle>
          <AlertDescription>
            Check your connection and try again.
            <Button variant="link" className="h-auto px-1 py-0" onClick={refetchFeed}>
              Retry
            </Button>
          </AlertDescription>
        </Alert>
      ) : items.length === 0 ? (
        <div className="rounded-2xl border bg-primary/5 p-8 text-center">
          <ListFilter className="mx-auto h-8 w-8 text-primary/60" aria-hidden />
          <p className="mt-3 text-sm font-semibold">
            {origin && origin.radiusKm !== null
              ? `No homes within ${origin.radiusKm} km of ${origin.label}`
              : 'No homes match yet'}
          </p>
          <p className="mt-1 text-xs text-muted-foreground">
            {origin && origin.radiusKm !== null
              ? 'Widen the search to look further out.'
              : 'Try a different district, amount, or clear your filters.'}
          </p>
          {origin && origin.radiusKm !== null ? (
            <Button variant="soft" className="mt-4 h-11 rounded-xl" onClick={() => setFilters((current) => ({ ...current, radiusKm: 'all' }))}>
              Search the whole market
            </Button>
          ) : null}
        </div>
      ) : (
        <div className="space-y-4">
          <div
            className={
              feedFetching && !feedFetchingNext
                ? 'grid gap-0 opacity-70 transition-opacity sm:grid-cols-2 sm:gap-3'
                : 'grid gap-0 sm:grid-cols-2 sm:gap-3'
            }
          >
            {items.map((entry) => {
              const id = itemId(entry.category, entry.item);
              const coords = itemCoordinates(entry.item, entry.category);
              return (
                <FunderNewHouseCard
                  key={`${entry.category}:${id}`}
                  category={entry.category}
                  item={entry.item}
                  saved={saved[entry.category].includes(id)}
                  selected={selectedItems.some(
                    (selected) => selected.category === entry.category && selected.id === id,
                  )}
                  distance={coords ? straightLineDistance(deviceOrigin, coords) : null}
                  onSave={() => toggleSave(entry.category, id)}
                  onSelect={() => toggleSelect(entry.category, entry.item)}
                  onDetail={() => openDetail(entry.category, entry.item)}
                  boardTagsOn={boardTagsOn}
                  boardTag={boardTagOf(entry)}
                />
              );
            })}
          </div>

          {feedHasNext ? (
            <div ref={loadMoreRef} className="flex justify-center">
              <Button
                variant="default"
                className="h-11 rounded-md px-6"
                onClick={fetchNextFeed}
                disabled={feedFetchingNext}
              >
                {feedFetchingNext ? (
                  <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
                ) : (
                  <Home className="h-4 w-4" aria-hidden />
                )}
                {feedFetchingNext
                  ? 'Loading'
                  : `Show more homes${remaining > 0 ? ` (${remaining.toLocaleString()} left)` : ''}`}
              </Button>
            </div>
          ) : null}
        </div>
      )}
      </>)}

      {/* The drawer is a portal, so its place in this tree does not move it on screen. */}
      <FunderNewFilterDrawer
        open={filtersOpen}
        onOpenChange={setFiltersOpen}
        filters={filters}
        districts={districtOptions}
        supportsSort
        hasOrigin={!!origin}
        availableBalance={availableBalance}
        floatBalance={wallet.isLoading || wallet.error ? null : wallet.floatBalance}
        resultCount={
          filters.withinFloat && availableBalance !== null ? items.length : filteredTotal
        }
        resultCounting={feedLoading || feedFetching}
        onChange={(next) => setFilters((current) => ({ ...current, ...next }))}
        onSortChange={changeSort}
        onReset={resetFilters}
        extraFilters={
          <label
            className={cn(
              'flex cursor-pointer items-center gap-3 rounded-xl border p-4 transition-colors',
              includePending ? 'border-primary bg-primary/10' : 'border-border bg-card',
            )}
          >
            <span className="flex h-10 w-10 flex-none items-center justify-center rounded-full bg-primary/15 text-primary">
              <Clock className="h-5 w-5" aria-hidden />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block text-sm font-semibold">Include houses pending verification</span>
              <span className="block text-xs text-muted-foreground">
                By default only Rent Plans with a verified tenant are shown.
              </span>
            </span>
            <Switch checked={includePending} onCheckedChange={setIncludePending} />
          </label>
        }
      />

      <EmptyHouseDetailSheet
        house={detailHouse}
        open={!!detailHouse}
        onOpenChange={(open) => {
          if (!open) setDetailHouse(null);
        }}
        isPicked={detailHouse ? selectedItems.some((i) => i.category === 'empty' && i.id === detailHouse.house_id) : false}
        onTogglePick={(house) => toggleSelect('empty', house as FunderNewEmptyHouse)}
        isPartner
        onRelatedHouseClick={(h) => setDetailHouse(h as any)}
        remaining={availableBalance ?? undefined}
        onFund={(house) => {
          const cost = Number(house.monthly_rent || 0);
          const avail = availableBalance ?? 0;
          if (avail >= cost) {
            // Enough balance: select the house and open the funding review.
            if (!selectedItems.some((i) => i.category === 'empty' && i.id === house.house_id)) {
              toggleSelect('empty', house as FunderNewEmptyHouse);
            }
            setDetailHouse(null);
            setReviewOpen(true);
          } else {
            // Not enough balance: open the deposit sheet with the exact shortfall.
            toast.info(`Not enough balance. Deposit ${formatDynamic(cost - avail)} to fund this house.`);
            setDetailHouse(null);
            setTopUpAmount(Math.ceil(cost - avail));
          }
        }}
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
          const avail = availableBalance ?? 0;
          if (avail >= cost) {
            // Enough balance: select the plan and open the funding review.
            if (!selectedItems.some((i) => i.category === 'ready' && i.id === plan.rent_request_id)) {
              toggleSelect('ready', plan as FunderNewReadyPlan);
            }
            setDetailPlan(null);
            setReviewOpen(true);
          } else {
            // Not enough balance: open the deposit sheet with the exact shortfall.
            toast.info(`Not enough balance. Deposit ${formatDynamic(cost - avail)} to fund this tenant.`);
            setDetailPlan(null);
            setTopUpAmount(Math.ceil(cost - avail));
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
        onFund={async (total, shortfall) => {
          if (shortfall > 0) {
            // Not enough balance: open the deposit sheet with the exact shortfall.
            toast.info(`Not enough balance. Deposit ${formatDynamic(shortfall)} to fund this plan.`);
            setReviewOpen(false);
            setTopUpAmount(Math.ceil(shortfall));
            return;
          }
          const ids = selectedItems.map((i) => i.id);
          if (ids.length === 0) return;
          const category = selectedItems[0].category;
          try {
            let reference: string | null = null;
            if (category === 'empty') {
              // Same path as the map screen: book the homes, then submit them
              // for the usual approval. Money only moves once approved.
              const { data, error } = await supabase.rpc('agent_create_promissory_note_for_houses', {
                p_payload: {
                  partner_name: (profile?.full_name || '').trim(),
                  whatsapp_number: (profile?.phone || '').trim(),
                  phone_number: (profile?.phone || '').trim() || null,
                  email: (profile?.email || user?.email || '').trim() || null,
                  amount: Number(total || 0),
                  contribution_type: 'once_off',
                },
                p_house_ids: ids,
              });
              if (error) throw error;
              const note = ((data ?? {}) as { note?: { id: string } }).note;
              if (!note) throw new Error('Booking was not created');
              const { error: fundErr } = await supabase.rpc('funder_fund_booked_houses', {
                p_house_ids: ids,
                p_idempotency_key: `fund-${note.id}`,
              });
              if (fundErr) throw fundErr;
              reference = note.id;
            } else {
              // Ready tenants: same path as the Rent Plan support dialog.
              const { error: claimError } = await supabase.rpc('partner_self_claim_plans', {
                p_rent_request_ids: ids,
              });
              if (claimError) throw claimError;
              const { data, error } = await supabase.rpc('funder_support_tenant_direct', {
                p_rent_request_ids: ids,
                p_promised_deposit_date: null,
              });
              if (error) throw error;
              const payload = (data ?? {}) as { commitment_id?: string; portfolio_id?: string };
              reference = payload.commitment_id ?? payload.portfolio_id ?? null;
            }
            setSelectedItems([]);
            setSelectedCategory(null);
            window.dispatchEvent(new Event('supporter-contribution-changed'));
            return { submitted: true, reference };
          } catch (err: unknown) {
            toast.error(String((err as { message?: string })?.message || 'Could not submit support'));
            throw err;
          }
        }}
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
      {mountDeposit && (
        <Suspense fallback={null}>
          <DepositFlow
            open={topUpAmount !== null}
            onOpenChange={(open) => {
              if (!open) setTopUpAmount(null);
            }}
            defaultAmount={topUpAmount ?? undefined}
          />
        </Suspense>
      )}
    </section>
  );
}
