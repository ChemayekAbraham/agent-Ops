import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, Home, ListFilter, Loader2, Search, X } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { useDebouncedValue } from '@/hooks/useDebouncedValue';
import { toast } from 'sonner';
import { formatDynamic } from '@/lib/currencyFormat';
import DepositFlow from '@/components/payments/DepositFlow';
import { useAuth } from '@/hooks/useAuth';
import { useWalletBalance } from '@/hooks/wallet/useWalletBalance';
import { Button } from '@/components/ui/button';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Skeleton } from '@/components/ui/skeleton';
import EmptyHouseDetailSheet from '@/components/agent/EmptyHouseDetailSheet';
import { SelfPortfolioPlanDetailSheet } from '@/components/partner/SelfPortfolioPlanDetailSheet';
import { FunderNewHouseCard } from '@/components/funder-new/FunderNewHouseCard';
import { FunderNewReviewDialog, FunderNewSelectionBar } from '@/components/funder-new/FunderNewSelectionPanel';
import { FunderNewFilterDrawer } from '@/components/funder-new/FunderNewFilterDrawer';
import { useFunderNewLocation } from '@/components/funder-new/useFunderNewLocation';
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
} from '@/components/funder-new/types';
import { itemAmount, itemCoordinates, itemId, placeCase, sortLabel, toSelectionItem } from '@/components/funder-new/utils';
import { straightLineDistance } from '@/components/funder-new/distance';

/** Same saved-homes storage as /dashboard/funder-new, so saves carry over. */
const SAVED_KEY = 'rentflow:funder-new:saved:v1';

interface SavedState {
  empty: string[];
  ready: string[];
}

const DEFAULT_SAVED: SavedState = { empty: [], ready: [] };

function readSaved(): SavedState {
  try {
    const raw = window.localStorage.getItem(SAVED_KEY);
    if (!raw) return DEFAULT_SAVED;
    const parsed = JSON.parse(raw) as Partial<SavedState>;
    return {
      empty: Array.isArray(parsed.empty) ? parsed.empty.filter((id): id is string => typeof id === 'string') : [],
      ready: Array.isArray(parsed.ready) ? parsed.ready.filter((id): id is string => typeof id === 'string') : [],
    };
  } catch {
    return DEFAULT_SAVED;
  }
}

function saveSaved(value: SavedState) {
  try {
    window.localStorage.setItem(SAVED_KEY, JSON.stringify(value));
  } catch {
    // Route-scoped browsing aid only.
  }
}

interface FeedEntry {
  category: FunderNewCategory;
  item: FunderNewEmptyHouse | FunderNewReadyPlan;
}

/**
 * Single combined listing for /dashboard/funder — the exact cards, filters and
 * data of /dashboard/funder-new, with Rent Plans first and empty houses below.
 * There are no tabs: one feed, one list.
 */
export function FunderHouseListingsSection() {
  const { user } = useAuth();
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
  const [saved, setSaved] = useState<SavedState>(() => readSaved());
  const [selectedCategory, setSelectedCategory] = useState<FunderNewCategory | null>(null);
  const [selectedItems, setSelectedItems] = useState<FunderNewSelectionItem[]>([]);
  const [detailHouse, setDetailHouse] = useState<FunderNewEmptyHouse | null>(null);
  const [detailPlan, setDetailPlan] = useState<FunderNewReadyPlan | null>(null);
  const [reviewOpen, setReviewOpen] = useState(false);
  const [filtersOpen, setFiltersOpen] = useState(false);
  // Top-up launched from the detail sheet's Fund button when the balance
  // doesn't cover the house's rent — the deposit opens with the shortfall.
  const [topUpAmount, setTopUpAmount] = useState<number | null>(null);

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
    saveSaved(saved);
  }, [saved]);

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
        radiusKm: chosenRadius ?? 25,
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

  const emptyQuery = useFunderNewEmptyHouses(filters, origin, true);
  const readyQuery = useFunderNewReadyPlans(filters, true);

  const emptyItems = useMemo(
    () => (emptyQuery.data?.pages ?? []).flatMap((page) => page.items),
    [emptyQuery.data],
  );
  const readyItems = useMemo(
    () => (readyQuery.data?.pages ?? []).flatMap((page) => page.items),
    [readyQuery.data],
  );

  /** Rent Plans first, empty houses below — one list, no tabs. */
  const loadedItems = useMemo<FeedEntry[]>(
    () => [
      ...readyItems.map((item): FeedEntry => ({ category: 'ready', item })),
      ...emptyItems.map((item): FeedEntry => ({ category: 'empty', item })),
    ],
    [readyItems, emptyItems],
  );

  const feedLoading = emptyQuery.isLoading || readyQuery.isLoading;
  const feedError = emptyQuery.error || readyQuery.error;
  const feedFetching = emptyQuery.isFetching || readyQuery.isFetching;
  const feedFetchingNext = emptyQuery.isFetchingNextPage || readyQuery.isFetchingNextPage;
  const feedHasNext = !!emptyQuery.hasNextPage || !!readyQuery.hasNextPage;
  const refetchFeed = () => {
    emptyQuery.refetch();
    readyQuery.refetch();
  };
  const fetchNextFeed = () => {
    if (emptyQuery.hasNextPage && !emptyQuery.isFetchingNextPage) emptyQuery.fetchNextPage();
    if (readyQuery.hasNextPage && !readyQuery.isFetchingNextPage) readyQuery.fetchNextPage();
  };

  const filteredTotal = (readyQuery.data?.pages?.[0]?.total ?? 0) + (emptyQuery.data?.pages?.[0]?.total ?? 0);

  const availableBalance = wallet.isLoading || wallet.error ? null : wallet.withdrawable;

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
  const items = useMemo(() => {
    if (!filters.withinFloat || availableBalance === null) return loadedItems;
    return loadedItems.filter((entry) => {
      const amount = itemAmount(entry.category, entry.item);
      return amount > 0 && amount <= availableBalance;
    });
  }, [loadedItems, filters.withinFloat, availableBalance]);

  const effectiveSort: FunderNewSort = filters.sort === 'nearest' && !origin ? 'recommended' : filters.sort;

  const filtersActive =
    filters.search.trim() !== '' ||
    filters.location.trim() !== '' ||
    filters.amount !== 'all' ||
    filters.rentMin !== null ||
    filters.rentMax !== null ||
    filters.radiusKm !== 'all' ||
    filters.withinFloat;

  const resetFilters = () => {
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

  const toggleSave = (category: FunderNewCategory, id: string) => {
    setSaved((current) => {
      const list = current[category];
      const nextList = list.includes(id) ? list.filter((savedId) => savedId !== id) : [...list, id];
      return { ...current, [category]: nextList };
    });
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

  return (
    <section className="space-y-3">
      {/* Search + compact filters row */}
      <div className="flex flex-wrap gap-2 rounded-2xl border bg-card p-2.5 shadow-sm sm:p-3">
        <div className="relative min-w-0 flex-1 basis-full sm:basis-auto">
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
          className="relative h-11 min-w-0 rounded-xl text-sm sm:flex-none"
          onClick={() => setFiltersOpen(true)}
        >
          <ListFilter className="h-4 w-4" aria-hidden />
          Filters
          {filtersActive ? (
            <span className="absolute right-2 top-2 h-2 w-2 rounded-full bg-primary" aria-hidden />
          ) : null}
        </Button>
      </div>

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
      />

      {filters.withinFloat && availableBalance !== null ? (
        <p className="px-1 text-xs text-muted-foreground">
          Within-balance is applied to the homes already loaded, because the read service has no balance filter.
        </p>
      ) : null}

      {/* Applied context: what is loaded, and by which order */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
        <span className="font-medium text-foreground">{sortLabel(effectiveSort)}</span>
        {effectiveSort === 'nearest' && origin ? (
          <span>
            Within {origin.radiusKm} km of {origin.label}
          </span>
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
            {effectiveSort === 'nearest' && origin
              ? `No homes within ${origin.radiusKm} km of ${origin.label}`
              : 'No homes match yet'}
          </p>
          <p className="mt-1 text-xs text-muted-foreground">
            {effectiveSort === 'nearest' && origin
              ? 'Widen the search to look further out.'
              : 'Try a different district, amount, or clear your filters.'}
          </p>
          {effectiveSort === 'nearest' && origin ? (
            <Button variant="soft" className="mt-4 h-11 rounded-xl" onClick={() => changeSort('recommended')}>
              Search the whole market
            </Button>
          ) : null}
        </div>
      ) : (
        <div className="space-y-4">
          <div
            className={
              feedFetching && !feedFetchingNext
                ? 'grid gap-0 opacity-70 transition-opacity sm:grid-cols-2 sm:gap-3 lg:grid-cols-3'
                : 'grid gap-0 sm:grid-cols-2 sm:gap-3 lg:grid-cols-3'
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
                />
              );
            })}
          </div>

          {feedHasNext ? (
            <div className="flex justify-center">
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
      <DepositFlow
        open={topUpAmount !== null}
        onOpenChange={(open) => {
          if (!open) setTopUpAmount(null);
        }}
        defaultAmount={topUpAmount ?? undefined}
      />
    </section>
  );
}
