import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, Calculator, HelpCircle, Info, ListFilter, Loader2, Search, SlidersHorizontal, Wallet, X } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '@/hooks/useAuth';
import { useWalletBalance } from '@/hooks/wallet/useWalletBalance';
import { Button } from '@/components/ui/button';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Skeleton } from '@/components/ui/skeleton';
import EmptyHouseDetailSheet from '@/components/agent/EmptyHouseDetailSheet';
import { SelfPortfolioPlanDetailSheet } from '@/components/partner/SelfPortfolioPlanDetailSheet';
import { FunderNewHero } from '@/components/funder-new/FunderNewHero';
import { FunderNewMapSection } from '@/components/funder-new/FunderNewMapSection';
import { FunderNewHouseCard } from '@/components/funder-new/FunderNewHouseCard';
import { FunderNewCalculatorDialog } from '@/components/funder-new/FunderNewCalculatorDialog';
import { FunderNewHowItWorksDialog } from '@/components/funder-new/FunderNewHowItWorksDialog';
import { FunderNewReviewDialog, FunderNewSelectionBar } from '@/components/funder-new/FunderNewSelectionPanel';
import { useFunderNewLocation } from '@/components/funder-new/useFunderNewLocation';
import {
  useFunderNewEmptyHouses,
  useFunderNewMarketSummary,
  useFunderNewReadyPlans,
} from '@/components/funder-new/useFunderNewOpportunities';
import type { FunderNewViewport } from '@/components/funder-new/FunderNewRouteMap';
import type {
  AmountBucket,
  FunderNewCategory,
  FunderNewEmptyHouse,
  FunderNewFilters,
  FunderNewOrigin,
  FunderNewReadyPlan,
  FunderNewSelectionItem,
  FunderNewSort,
} from '@/components/funder-new/types';
import { itemId, sortLabel, toSelectionItem } from '@/components/funder-new/utils';
import { ROAD_TIME_UNAVAILABLE_REASON, straightLineDistance } from '@/components/funder-new/distance';
import { itemCoordinates } from '@/components/funder-new/utils';
import { formatDynamic } from '@/lib/currencyFormat';

const SAVED_KEY = 'rentflow:funder-new:saved:v1';
/** Default search radius applied when an origin exists. */
const DEFAULT_RADIUS_KM = 25;
const SEARCH_DEBOUNCE_MS = 350;

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

export default function FunderDashboardNew() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const wallet = useWalletBalance(user?.id);
  const summary = useFunderNewMarketSummary();
  const location = useFunderNewLocation();

  const [tab, setTab] = useState<FunderNewCategory>('empty');
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

  const [sortTouched, setSortTouched] = useState(false);
  const [area, setArea] = useState<{ lat: number; lng: number; radiusKm: number } | null>(null);
  const [saved, setSaved] = useState<SavedState>(() => readSaved());
  const [selectedCategory, setSelectedCategory] = useState<FunderNewCategory | null>(null);
  const [selectedItems, setSelectedItems] = useState<FunderNewSelectionItem[]>([]);
  const [detailHouse, setDetailHouse] = useState<FunderNewEmptyHouse | null>(null);
  const [detailPlan, setDetailPlan] = useState<FunderNewReadyPlan | null>(null);
  const [reviewOpen, setReviewOpen] = useState(false);
  const [calculatorOpen, setCalculatorOpen] = useState(false);
  const [howOpen, setHowOpen] = useState(false);

  useEffect(() => {
    saveSaved(saved);
  }, [saved]);

  // Debounced text search; typing never fires a request per keystroke.
  useEffect(() => {
    const id = window.setTimeout(() => {
      setFilters((current) => (current.search === searchInput ? current : { ...current, search: searchInput }));
    }, SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(id);
  }, [searchInput]);

  /**
   * The single origin used for ordering and distance. The device position always
   * wins over a manually chosen area, and an area is never called "your
   * location".
   */
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
    if (area) {
      return {
        lat: area.lat,
        lng: area.lng,
        source: 'area',
        radiusKm: chosenRadius ?? area.radiusKm,
        label: 'this area',
      };
    }
    return null;
  }, [location.coords, area, filters.radiusKm]);


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

  const emptyQuery = useFunderNewEmptyHouses(filters, origin, tab === 'empty');
  const readyQuery = useFunderNewReadyPlans(filters, tab === 'ready');

  const emptyItems = useMemo(
    () => (emptyQuery.data?.pages ?? []).flatMap((page) => page.items),
    [emptyQuery.data],
  );
  const readyItems = useMemo(() => (readyQuery.data?.pages ?? []).flatMap((page) => page.items), [readyQuery.data]);

  const activeQuery = tab === 'empty' ? emptyQuery : readyQuery;
  const loadedItems: Array<FunderNewEmptyHouse | FunderNewReadyPlan> = tab === 'empty' ? emptyItems : readyItems;
  const filteredTotal = activeQuery.data?.pages?.[0]?.total ?? 0;
  const readyLimitation = readyQuery.data?.pages?.[0]?.limitation ?? null;

  const availableBalance = wallet.isLoading || wallet.error ? null : wallet.withdrawable;

  /** Districts present in the homes already loaded, used by the district chip. */
  const districtOptions = useMemo(() => {
    const counts = new Map<string, { label: string; count: number }>();
    loadedItems.forEach((item) => {
      const raw = (item as Record<string, unknown>).district;
      const value = typeof raw === 'string' ? raw.trim() : '';
      if (!value) return;
      const existing = counts.get(value);
      if (existing) existing.count += 1;
      else counts.set(value, { label: placeCase(value) || value, count: 1 });
    });
    return [...counts.entries()]
      .map(([value, meta]) => ({ value, label: meta.label, count: meta.count }))
      .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
  }, [loadedItems]);

  /**
   * The within-balance chip is applied to the homes already loaded, because the
   * read service has no balance parameter. The chip row says so.
   */
  const items = useMemo(() => {
    if (!filters.withinFloat || availableBalance === null) return loadedItems;
    return loadedItems.filter((item) => {
      const amount = itemAmount(item, tab);
      return amount > 0 && amount <= availableBalance;
    });
  }, [loadedItems, filters.withinFloat, availableBalance, tab]);

  const effectiveSort: FunderNewSort = filters.sort === 'nearest' && !origin ? 'recommended' : filters.sort;

  const activeSelectedIds = useMemo(
    () => selectedItems.filter((item) => item.category === tab).map((item) => item.id),
    [selectedItems, tab],
  );
  const selectedEmptyIds = useMemo(
    () => selectedItems.filter((item) => item.category === 'empty').map((item) => item.id),
    [selectedItems],
  );

  const filtersActive =
    filters.search.trim() !== '' ||
    filters.location.trim() !== '' ||
    filters.amount !== 'all' ||
    filters.rentMin !== null ||
    filters.rentMax !== null ||
    filters.radiusKm !== 'all' ||
    filters.withinFloat;

  const resetFilters = () => {
    setSearchInput('');
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

  const openDetailById = (id: string) => {
    const found = items.find((item) => itemId(tab, item) === id);
    if (found) openDetail(tab, found);
  };

  /** Applying a map area changes the list; simply panning does not. */
  const applyArea = useCallback((viewport: FunderNewViewport) => {
    setArea({ lat: viewport.lat, lng: viewport.lng, radiusKm: viewport.radiusKm });
  }, []);

  const changeSort = (value: FunderNewSort) => {
    setSortTouched(true);
    setFilters((current) => ({ ...current, sort: value }));
  };

  const selectRecommended = (houses: FunderNewEmptyHouse[], replaceExisting: boolean) => {
    setCalculatorOpen(false);
    setSelectedCategory('empty');
    setSelectedItems((current) => {
      const base = replaceExisting ? [] : current.filter((entry) => entry.category === 'empty');
      const merged = new Map(base.map((entry) => [entry.id, entry]));
      houses.forEach((house) => merged.set(house.house_id, toSelectionItem('empty', house)));
      return [...merged.values()];
    });
  };

  const remaining = Math.max(0, filteredTotal - items.length);
  const activeId = detailHouse?.house_id ?? null;

  return (
    <div className="min-h-screen bg-background pb-32 text-foreground">
      {/* Existing top header — unchanged */}
      <header className="border-b bg-background/95 backdrop-blur">
        <div className="mx-auto flex max-w-7xl flex-col gap-4 px-4 py-4 sm:px-6 lg:px-8">
          <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
            <div className="min-w-0">
              <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                RentFlow Insights review
              </p>
              <h1 className="mt-1 text-2xl font-semibold tracking-tight">Find a home to support</h1>
              <p className="mt-1 text-sm text-muted-foreground">
                {user?.user_metadata?.full_name
                  ? `${user.user_metadata.full_name}, review live homes without changing the current dashboard.`
                  : 'Review live homes without changing the current dashboard.'}
              </p>
            </div>
            <div className="grid gap-2 sm:flex sm:items-center">
              <div className="rounded-xl border bg-card px-4 py-2">
                <p className="flex items-center gap-2 text-xs text-muted-foreground">
                  <Wallet className="h-3.5 w-3.5" /> Available balance
                </p>
                <p className="text-sm font-semibold">
                  {wallet.error ? 'Unavailable' : wallet.isLoading ? 'Loading…' : formatDynamic(wallet.withdrawable)}
                </p>
              </div>
              <Button variant="outline" className="rounded-xl" onClick={() => navigate('/dashboard/funder')}>
                Current dashboard
              </Button>
            </div>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-7xl space-y-5 px-4 py-5 sm:space-y-6 sm:px-6 lg:px-8">
        <FunderNewHero
          summary={summary.data}
          isLoading={summary.isLoading}
          hasError={!!summary.error}
          onHowItWorks={() => setHowOpen(true)}
        />

        <FunderNewMapSection
          filters={filters}
          location={location}
          origin={origin}
          selectedIds={selectedEmptyIds}
          savedIds={saved.empty}
          activeId={activeId}
          onOpenHouse={(house) => openDetail('empty', house)}
          onApplyArea={applyArea}
          onAreaSearchChange={setSearchInput}
        />

        {/* Compact filters + calculator, directly under the map */}
        <section className="space-y-3">
          <div className="flex flex-wrap gap-2 rounded-2xl border bg-card p-2.5 shadow-sm sm:p-3">
            <label className="relative min-w-0 flex-1 basis-full sm:basis-64">
              <span className="sr-only">Search homes</span>
              <Search
                className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
                aria-hidden
              />
              <Input
                value={searchInput}
                onChange={(event) => setSearchInput(event.target.value)}
                placeholder="Search area or house type"
                className="h-11 rounded-xl pl-9 text-sm"
              />
            </label>

            <Input
              value={filters.location}
              onChange={(event) => setFilters({ ...filters, location: event.target.value })}
              placeholder="District"
              aria-label="Filter by district"
              className="h-11 min-w-0 basis-[calc(50%-0.25rem)] rounded-xl text-sm sm:flex-1 sm:basis-auto sm:max-w-[9.5rem]"
            />

            <Select
              value={filters.amount}
              onValueChange={(value: AmountBucket) => setFilters({ ...filters, amount: value })}
            >
              <SelectTrigger className="h-11 min-w-0 basis-[calc(50%-0.25rem)] rounded-xl text-sm sm:flex-1 sm:basis-auto sm:max-w-[11rem]" aria-label="Filter by amount">
                <SlidersHorizontal className="mr-1.5 h-4 w-4 text-muted-foreground" aria-hidden />
                <SelectValue placeholder="Any amount" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">Any amount</SelectItem>
                <SelectItem value="under_300k">Under UGX 300,000</SelectItem>
                <SelectItem value="300k_600k">UGX 300,000–600,000</SelectItem>
                <SelectItem value="over_600k">Above UGX 600,000</SelectItem>
              </SelectContent>
            </Select>

            {tab === 'empty' ? (
              <Select value={filters.sort} onValueChange={(value) => changeSort(value as FunderNewSort)}>
                <SelectTrigger className="h-11 min-w-0 basis-[calc(50%-0.25rem)] rounded-xl text-sm sm:flex-1 sm:basis-auto sm:max-w-[10.5rem]" aria-label="Sort homes">
                  <SelectValue placeholder="Sort" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="nearest" disabled={!origin}>
                    Nearest first
                  </SelectItem>
                  <SelectItem value="rent_low">Lowest amount</SelectItem>
                  <SelectItem value="rent_high">Highest amount</SelectItem>
                  <SelectItem value="newest">Newest first</SelectItem>
                  <SelectItem value="recommended">Recommended</SelectItem>
                </SelectContent>
              </Select>
            ) : null}

            <Button
              variant="soft"
              className="h-11 min-w-0 basis-[calc(50%-0.25rem)] rounded-xl text-sm sm:flex-none sm:basis-auto"
              onClick={() => setCalculatorOpen(true)}
            >
              <Calculator className="h-4 w-4" aria-hidden />
              Calculator
            </Button>

            {filtersActive ? (
              <Button
                variant="ghost"
                className="h-11 min-w-0 basis-full rounded-xl text-sm sm:flex-none sm:basis-auto"
                onClick={() => {
                  setSearchInput('');
                  setFilters({ search: '', location: '', amount: 'all', sort: filters.sort });
                }}
              >
                <X className="h-4 w-4" aria-hidden />
                Clear
              </Button>
            ) : null}
          </div>

          <Tabs value={tab} onValueChange={(value) => setTab(value as FunderNewCategory)}>
            <TabsList className="h-auto w-full flex-wrap justify-start gap-1 rounded-xl p-1 sm:w-fit">
              <TabsTrigger value="empty" className="rounded-lg px-4 py-2 text-sm">
                Empty homes
              </TabsTrigger>
              <TabsTrigger value="ready" className="rounded-lg px-4 py-2 text-sm">
                Tenant ready
              </TabsTrigger>
            </TabsList>
          </Tabs>

          {/* Applied context: what is loaded, and by which order */}
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
            <span className="font-medium text-foreground">
              {tab === 'empty' ? sortLabel(effectiveSort) : 'Order from the tenant-ready service'}
            </span>
            {activeQuery.isLoading ? (
              <span>Loading…</span>
            ) : (
              <span>
                Showing {items.length} of {filteredTotal.toLocaleString()} matching{' '}
                {filteredTotal === 1 ? 'home' : 'homes'}
              </span>
            )}
            {effectiveSort === 'nearest' && origin ? (
              <span>
                Within {origin.radiusKm} km of {origin.label}
              </span>
            ) : null}
            {filters.sort === 'nearest' && !origin ? <span>Nearest needs your location</span> : null}
          </div>

          {tab === 'ready' ? (
            <p className="flex items-start gap-2 rounded-xl bg-muted/50 px-3 py-2 text-xs text-muted-foreground">
              <Info className="mt-0.5 h-3.5 w-3.5 flex-none" aria-hidden />
              <span>
                Tenant-ready homes cannot be ordered by distance: the read service supports district and amount only, so
                this list is not a nearest-first search. Distances are still shown where a home has a map pin.
                {readyLimitation ? ` ${readyLimitation}` : ''}
              </span>
            </p>
          ) : null}

          {/* Listings */}
          {activeQuery.isLoading ? (
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {Array.from({ length: 6 }).map((_, index) => (
                <Skeleton key={index} className="h-40 rounded-2xl" />
              ))}
            </div>
          ) : activeQuery.error ? (
            <Alert variant="warning" className="rounded-2xl border-warning/40 bg-warning/10">
              <AlertTriangle className="h-4 w-4" />
              <AlertTitle>These homes could not be loaded</AlertTitle>
              <AlertDescription>
                Nothing has been replaced with a zero. Check your connection and try again.
                <Button variant="link" className="h-auto px-1 py-0" onClick={() => activeQuery.refetch()}>
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
                  ? 'Nothing nearby is being described as near you. Widen the search to look further out.'
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
                  activeQuery.isFetching && !activeQuery.isFetchingNextPage
                    ? 'grid gap-0 opacity-70 transition-opacity sm:grid-cols-2 sm:gap-3 lg:grid-cols-3'
                    : 'grid gap-0 sm:grid-cols-2 sm:gap-3 lg:grid-cols-3'
                }
              >
                {items.map((item) => {
                  const id = itemId(tab, item);
                  const coords = itemCoordinates(item, tab);
                  return (
                    <FunderNewHouseCard
                      key={id}
                      category={tab}
                      item={item}
                      saved={saved[tab].includes(id)}
                      selected={selectedCategory === tab && activeSelectedIds.includes(id)}
                      distance={coords ? straightLineDistance(deviceOrigin, coords) : null}
                      onSave={() => toggleSave(tab, id)}
                      onSelect={() => toggleSelect(tab, item)}
                      onDetail={() => openDetail(tab, item)}
                    />
                  );
                })}
              </div>

              {activeQuery.hasNextPage ? (
                <div className="flex justify-center">
                  <Button
                    variant="outline"
                    className="h-11 rounded-full px-6"
                    onClick={() => activeQuery.fetchNextPage()}
                    disabled={activeQuery.isFetchingNextPage}
                  >
                    {activeQuery.isFetchingNextPage ? (
                      <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
                    ) : null}
                    {activeQuery.isFetchingNextPage
                      ? 'Loading'
                      : `Show more homes${remaining > 0 ? ` (${remaining.toLocaleString()} left)` : ''}`}
                  </Button>
                </div>
              ) : null}

              {deviceOrigin ? (
                <p className="text-center text-xs text-muted-foreground">{ROAD_TIME_UNAVAILABLE_REASON}</p>
              ) : null}
            </div>
          )}
        </section>
      </main>

      <EmptyHouseDetailSheet
        house={detailHouse}
        open={!!detailHouse}
        onOpenChange={(open) => {
          if (!open) setDetailHouse(null);
        }}
        isPicked={
          detailHouse
            ? selectedItems.some((item) => item.category === 'empty' && item.id === detailHouse.house_id)
            : false
        }
        onTogglePick={(house) => toggleSelect('empty', house as FunderNewEmptyHouse)}
        isPartner
        remaining={availableBalance ?? undefined}
      />
      <SelfPortfolioPlanDetailSheet
        plan={detailPlan}
        open={!!detailPlan}
        onOpenChange={(open) => {
          if (!open) setDetailPlan(null);
        }}
        isFunded={false}
      />
      <FunderNewCalculatorDialog
        open={calculatorOpen}
        onOpenChange={setCalculatorOpen}
        filters={filters}
        origin={origin}
        onOpenHouse={(id) => {
          setCalculatorOpen(false);
          openDetailById(id);
        }}
        onSelectRecommended={selectRecommended}
        hasExistingSelection={selectedItems.length > 0}
      />
      <FunderNewHowItWorksDialog open={howOpen} onOpenChange={setHowOpen} />
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
