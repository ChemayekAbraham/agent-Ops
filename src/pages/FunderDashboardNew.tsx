import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, Calculator, Fingerprint, HelpCircle, Home, ListFilter, Loader2, Search, SlidersHorizontal, Wallet, X } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { AppRole, useAuth } from '@/hooks/useAuth';
import { useProfile } from '@/hooks/useProfile';
import DashboardHeader from '@/components/DashboardHeader';
import { UserAvatar } from '@/components/UserAvatar';
import { NotificationBell } from '@/components/supporter/NotificationBell';
import { roleToSlug } from '@/lib/roleRoutes';
import { generateWelileAiId } from '@/lib/welileAiId';
import { useWalletBalance } from '@/hooks/wallet/useWalletBalance';
import { Button } from '@/components/ui/button';
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
import { itemAmount, itemId, placeCase, sortLabel, toSelectionItem } from '@/components/funder-new/utils';
import { ROAD_TIME_UNAVAILABLE_REASON, straightLineDistance } from '@/components/funder-new/distance';
import { itemCoordinates } from '@/components/funder-new/utils';
import { FunderNewFilterDrawer } from '@/components/funder-new/FunderNewFilterDrawer';

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
  const { user, roles, signOut, switchRole } = useAuth();
  const { profile } = useProfile();
  const wallet = useWalletBalance(user?.id);

  const metaFullName = (user?.user_metadata?.full_name as string | undefined)?.trim() || '';
  const emailLocal = (user?.email || '').split('@')[0] || '';
  const displayName = profile?.full_name?.trim() || metaFullName || emailLocal || 'Funder';
  const welileId = user ? generateWelileAiId(user.id) : '';

  // Same role-switch behavior as /dashboard/funder: switch then let the
  // persona URL render the matching dashboard.
  const handleRoleSwitch = (newRole: AppRole) => {
    if (!roles.includes(newRole)) return;
    switchRole(newRole);
    navigate(roleToSlug(newRole), { replace: true });
  };
  const summary = useFunderNewMarketSummary();
  const location = useFunderNewLocation();

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
  const [filtersOpen, setFiltersOpen] = useState(false);


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

  /**
   * Single combined feed: every empty house first, then every tenant-ready
   * Rent Plan. Both reads run together; there is no tab switch.
   */
  const emptyQuery = useFunderNewEmptyHouses(filters, origin, true);
  const readyQuery = useFunderNewReadyPlans(filters, true);

  const emptyItems = useMemo(
    () => (emptyQuery.data?.pages ?? []).flatMap((page) => page.items),
    [emptyQuery.data],
  );
  const readyItems = useMemo(() => (readyQuery.data?.pages ?? []).flatMap((page) => page.items), [readyQuery.data]);

  interface FeedEntry {
    category: FunderNewCategory;
    item: FunderNewEmptyHouse | FunderNewReadyPlan;
  }

  /** Houses first, Rent Plans last. Each entry carries its own category. */
  const loadedItems = useMemo<FeedEntry[]>(
    () => [
      ...emptyItems.map((item): FeedEntry => ({ category: 'empty', item })),
      ...readyItems.map((item): FeedEntry => ({ category: 'ready', item })),
    ],
    [emptyItems, readyItems],
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

  const filteredTotal = (emptyQuery.data?.pages?.[0]?.total ?? 0) + (readyQuery.data?.pages?.[0]?.total ?? 0);

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
    const found = items.find((entry) => itemId(entry.category, entry.item) === id);
    if (found) openDetail(found.category, found.item);
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
      {/* Same top bar as /dashboard/funder — logo + role switcher */}
      <DashboardHeader
        currentRole="supporter"
        availableRoles={roles}
        onRoleChange={handleRoleSwitch}
        onSignOut={signOut}
        headerActions={user ? <NotificationBell userId={user.id} /> : undefined}
        compactInstallPrompt
      />

      {/* Identity strip — avatar, name, Welile ID */}
      <section className="border-b bg-background/95 backdrop-blur">
        <div className="mx-auto flex max-w-7xl items-center gap-4 px-4 py-4 sm:px-6 lg:px-8">
          <UserAvatar
            avatarUrl={profile?.avatar_url}
            fullName={displayName}
            size="lg"
            className="ring-2 ring-primary/20"
          />
          <div className="min-w-0 flex-1">
            <h1 className="truncate text-xl font-semibold tracking-tight">{displayName}</h1>
            {welileId && (
              <button
                type="button"
                onClick={() => navigate(`/profile/${welileId}`)}
                className="mt-1 inline-flex items-center gap-1.5 rounded-full border border-primary/20 bg-primary/10 px-2.5 py-0.5 font-mono text-[11px] font-medium text-primary transition-colors hover:bg-primary/20"
                title="Open my Welile Trust Profile"
              >
                <Fingerprint className="h-3 w-3" aria-hidden />
                {welileId}
              </button>
            )}
          </div>
        </div>
      </section>

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

            <Button
              variant="outline"
              className="relative h-11 min-w-0 basis-[calc(50%-0.25rem)] rounded-xl text-sm sm:flex-none sm:basis-auto"
              onClick={() => setFiltersOpen(true)}
            >
              <ListFilter className="h-4 w-4" aria-hidden />
              Filters
              {filtersActive ? (
                <span className="absolute right-2 top-2 h-2 w-2 rounded-full bg-primary" aria-hidden />
              ) : null}
            </Button>

            <Button
              variant="soft"
              className="h-11 min-w-0 basis-[calc(50%-0.25rem)] rounded-xl text-sm sm:flex-none sm:basis-auto"
              onClick={() => setCalculatorOpen(true)}
            >
              <Calculator className="h-4 w-4" aria-hidden />
              Calculator
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
            {feedLoading ? (
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

          {/* Listings — houses first, then Rent Plans */}
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
                Nothing has been replaced with a zero. Check your connection and try again.
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
