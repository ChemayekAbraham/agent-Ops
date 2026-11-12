import { useSelfSupportFeePolicy } from '@/hooks/useSelfSupportFeePolicy';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, Bookmark, Calculator, Fingerprint, HelpCircle, Home, ListFilter, Loader2, SlidersHorizontal, Wallet, X } from 'lucide-react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { AppRole, useAuth } from '@/hooks/useAuth';
import { FEATURE_FUNDERS_BOARD_TAGS, useFeaturePreview } from '@/hooks/useFeaturePreview';
import { useProfile } from '@/hooks/useProfile';
import DashboardHeader from '@/components/DashboardHeader';
import { UserAvatar } from '@/components/UserAvatar';
import { NotificationBell } from '@/components/supporter/NotificationBell';
import { roleToSlug } from '@/lib/roleRoutes';
import { roleDashboardRoutes } from '@/components/layout/executiveSidebarConfig';
import { generateWelileAiId } from '@/lib/welileAiId';
import { useWalletBalance } from '@/hooks/wallet/useWalletBalance';
import { useFunderFloatAvailable } from '@/components/funder-preview/useFunderPreviewSupport';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Skeleton } from '@/components/ui/skeleton';
import EmptyHouseDetailSheet from '@/components/agent/EmptyHouseDetailSheet';
import { SelfPortfolioPlanDetailSheet } from '@/components/partner/SelfPortfolioPlanDetailSheet';
import { FunderNewHero } from '@/components/funder-new/FunderNewHero';
import { FunderNewMapSection } from '@/components/funder-new/FunderNewMapSection';
import { FunderNewHouseCard } from '@/components/funder-new/FunderNewHouseCard';
import { CoSupportWaitingSection } from '@/components/co-support/CoSupportWaitingSection';
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
import { itemAmount, itemId, placeCase, readyPlanPlace, readyPlanTitle, sortLabel, toSelectionItem } from '@/components/funder-new/utils';
import { useRentPlanFundChoice } from '@/components/supporter/FunderFundChooser';
import { straightLineDistance } from '@/components/funder-new/distance';
import { itemCoordinates } from '@/components/funder-new/utils';
import { FunderNewFilterDrawer } from '@/components/funder-new/FunderNewFilterDrawer';

import { toast } from 'sonner';
import { supabase } from '@/integrations/supabase/client';
import type { FunderFundResult } from '@/components/funder-new/FunderNewSelectionPanel';
import { sortFunderFeedEntries } from '@/lib/funderHouseSort';
import { useFunderSavedItems } from '@/hooks/useFunderSavedItems';
import { FunderSavedItemsDialog } from '@/components/funder-new/FunderSavedItemsDialog';
export { sortFunderFeedEntries } from '@/lib/funderHouseSort';

/** Default search radius applied when an origin exists. */
const DEFAULT_RADIUS_KM = 25;
const SEARCH_DEBOUNCE_MS = 350;

export default function FunderDashboardNew() {
  // Agent Care: partner amounts use pay(rent) (= rent while the switch is off).
  const { pay: partnerPay } = useSelfSupportFeePolicy();
  const navigate = useNavigate();
  const { user, roles, signOut, switchRole } = useAuth();
  const boardTagsOn = useFeaturePreview(FEATURE_FUNDERS_BOARD_TAGS);
  const { profile } = useProfile();
  const wallet = useWalletBalance(user?.id);
  const floatAvail = useFunderFloatAvailable(user?.id);

  const metaFullName = (user?.user_metadata?.full_name as string | undefined)?.trim() || '';
  const emailLocal = (user?.email || '').split('@')[0] || '';
  const displayName = profile?.full_name?.trim() || metaFullName || emailLocal || 'Funder';
  const welileId = user ? generateWelileAiId(user.id) : '';

  // Same role-switch behavior as /dashboard/funder: switch then let the
  // persona URL render the matching dashboard.
  const handleRoleSwitch = (newRole: AppRole) => {
    if (!roles.includes(newRole)) return;
    switchRole(newRole);
    const targetRoute = roleDashboardRoutes[newRole] || roleToSlug(newRole);
    navigate(targetRoute, { replace: true });
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
  const { saved, toggleSave, count: savedCount } = useFunderSavedItems();
  const [savedOpen, setSavedOpen] = useState(false);
  const [selectedCategory, setSelectedCategory] = useState<FunderNewCategory | null>(null);
  const [selectedItems, setSelectedItems] = useState<FunderNewSelectionItem[]>([]);
  const [detailHouse, setDetailHouse] = useState<FunderNewEmptyHouse | null>(null);
  const [detailPlan, setDetailPlan] = useState<FunderNewReadyPlan | null>(null);
  const [reviewOpen, setReviewOpen] = useState(false);
  const [calculatorOpen, setCalculatorOpen] = useState(false);
  const [howOpen, setHowOpen] = useState(false);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const fundInflight = useRef<{ key: string; task: Promise<FunderFundResult> } | null>(null);


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
    () => sortFunderFeedEntries([
      ...emptyItems.map((item): FeedEntry => ({ category: 'empty', item })),
      ...readyItems.map((item): FeedEntry => ({ category: 'ready', item })),
    ]),
    [emptyItems, readyItems],
  );

  const feedLoading = emptyQuery.isLoading || readyQuery.isLoading;

  // Shared link: ?plan=<category>:<id> opens that home's Support Plan once, if it is in the loaded list.
  const [searchParams] = useSearchParams();
  const sharedPlanHandled = useRef(false);
  useEffect(() => {
    if (sharedPlanHandled.current || feedLoading) return;
    const raw = searchParams.get('plan');
    if (!raw) { sharedPlanHandled.current = true; return; }
    sharedPlanHandled.current = true;
    const sep = raw.indexOf(':');
    const category = sep >= 1 ? raw.slice(0, sep) : '';
    const id = sep >= 1 ? raw.slice(sep + 1) : raw;
    if (!id) return;
    // Match by category:id when a category is given, otherwise by id alone
    // across every loaded category (public share links carry no category).
    const found = category
      ? loadedItems.find((e) => e.category === category && itemId(e.category, e.item) === id)
      : loadedItems.find((e) => itemId(e.category, e.item) === id);
    if (!found) return;
    if (found.category === 'ready') {
      setDetailPlan(found.item as FunderNewReadyPlan);
      return;
    }
    setSelectedCategory(found.category);
    setSelectedItems([toSelectionItem(found.category, found.item, partnerPay)]);
    setReviewOpen(true);
  }, [feedLoading, loadedItems, searchParams]);
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

  const availableBalance = floatAvail.isLoading || floatAvail.isError ? null : (floatAvail.data ?? null);

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


  const fundChoice = useRentPlanFundChoice();

  const toggleSelect = useCallback((category: FunderNewCategory, item: FunderNewEmptyHouse | FunderNewReadyPlan) => {
    const next = toSelectionItem(category, item, partnerPay);
    setSelectedCategory((current) => (current && current !== category ? category : current ?? category));
    setSelectedItems((current) => {
      const sameCategory = current.filter((entry) => entry.category === category);
      const exists = sameCategory.some((entry) => entry.id === next.id);
      const nextList = exists ? sameCategory.filter((entry) => entry.id !== next.id) : [...sameCategory, next];
      if (nextList.length === 0) setSelectedCategory(null);
      return nextList;
    });
  }, [partnerPay]);

  const requestFund = useCallback((category: FunderNewCategory, item: FunderNewEmptyHouse | FunderNewReadyPlan) => {
    if (category !== 'ready') {
      toggleSelect(category, item);
      return;
    }
    const plan = item as FunderNewReadyPlan;
    const already = selectedItems.some((entry) => entry.category === 'ready' && entry.id === plan.rent_request_id);
    if (already) {
      toggleSelect(category, item);
      return;
    }
    fundChoice.ask({
      rentRequestId: plan.rent_request_id,
      title: readyPlanTitle(plan),
      place: readyPlanPlace(plan),
      landlordName: plan.landlord_name,
      rentAmount: Number(plan.funding_amount || 0),
    }, () => toggleSelect('ready', plan));
  }, [fundChoice, selectedItems, toggleSelect]);

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
      houses.forEach((house) => merged.set(house.house_id, toSelectionItem('empty', house, partnerPay)));
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
        menuItems={[{ icon: Bookmark, label: 'Saved Items', onClick: () => setSavedOpen(true), badge: savedCount || undefined }]}
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
        <CoSupportWaitingSection />
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

        {/* Independent "How it works" row, directly below the map */}
        <div className="flex">
          <Button
            variant="outline"
            onClick={() => setHowOpen(true)}
            className="h-11 w-fit shrink-0 rounded-full px-4"
          >
            <HelpCircle className="h-4 w-4" aria-hidden />
            How it works
          </Button>
        </div>


        {/* Compact filters + calculator, directly under the map */}
        <section className="space-y-3">
          <div className="flex flex-wrap gap-2 rounded-2xl border bg-card p-2.5 shadow-sm sm:p-3">

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
                      onSelect={() => requestFund(entry.category, entry.item)}
                      onDetail={() => openDetail(entry.category, entry.item)}
                      boardTagsOn={boardTagsOn}
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
                <p className="text-center text-xs text-muted-foreground">
                  {"Turning\u00a0Rent\u00a0into a financial asset..."}
                </p>
              ) : null}
            </div>
          )}
        </section>
      </main>

      <FunderSavedItemsDialog open={savedOpen} onOpenChange={setSavedOpen} />
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
        onRelatedHouseClick={(h) => setDetailHouse(h as any)}
        remaining={availableBalance ?? undefined}
      />
      {fundChoice.chooser}
      <SelfPortfolioPlanDetailSheet
        plan={detailPlan}
        open={!!detailPlan}
        onOpenChange={(open) => {
          if (!open) setDetailPlan(null);
        }}
        isFunded={false}
        onFund={(plan) => {
          setDetailPlan(null);
          fundChoice.ask({
            rentRequestId: plan.rent_request_id,
            title: plan.house_category ? plan.house_category.replace(/-/g, ' ') : 'Rent Plan',
            place: plan.tenant_location || plan.request_city || '',
            landlordName: plan.landlord_name,
            rentAmount: Number(plan.funding_amount || 0),
          }, () => {
            setSelectedCategory('ready');
            setSelectedItems((current) => {
              const ready = current.filter((entry) => entry.category === 'ready');
              if (ready.some((entry) => entry.id === plan.rent_request_id)) return ready;
              return [...ready, toSelectionItem('ready', plan as FunderNewReadyPlan, partnerPay)];
            });
            setReviewOpen(true);
          });
        }}
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
        walletLoading={floatAvail.isLoading}
        walletError={floatAvail.error}
        onRemove={removeSelected}
        onFund={async (total) => {
          const ids = selectedItems.map((item) => item.id);
          if (ids.length === 0) return;
          const key = [...ids].sort().join(',');
          if (fundInflight.current?.key === key) return fundInflight.current.task;

          const task = (async (): Promise<FunderFundResult> => {
            const category = selectedItems[0].category;
            const landlordNames = selectedItems
              .map((item) => item.landlordName)
              .filter((name): name is string => !!name && name.trim().length > 0);
            const rentRequestIds = category === 'ready' ? ids : [];
            try {
              let reference: string | null = null;
              let releasedToAgent = false;
              if (category === 'empty') {
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
                const { error: claimError } = await supabase.rpc('partner_self_claim_plans', {
                  p_rent_request_ids: ids,
                });
                if (claimError) throw claimError;
                const { data, error } = await supabase.rpc('funder_support_tenant_direct', {
                  p_rent_request_ids: ids,
                  p_promised_deposit_date: null,
                });
                if (error) throw error;
                const payload = (data ?? {}) as {
                  commitment_id?: string;
                  portfolio_id?: string;
                  landlord_float_released?: boolean;
                };
                reference = payload.commitment_id ?? payload.portfolio_id ?? null;
                releasedToAgent = payload.landlord_float_released === true;
              }
              setSelectedItems([]);
              setSelectedCategory(null);
              window.dispatchEvent(new Event('supporter-contribution-changed'));
              return {
                submitted: true,
                reference,
                releasedToAgent,
                supportKind: category === 'empty' ? 'house' : 'rent',
                landlordNames,
                rentRequestIds,
              };
            } catch (err: unknown) {
              const raw = String((err as { message?: string })?.message || 'Could not submit support');
              const message = raw.includes('NO_AGENT_ASSIGNED')
                ? 'This Rent Plan has no assigned agent, so it cannot be funded.'
                : raw;
              toast.error(message);
              throw err;
            }
          })();

          fundInflight.current = { key, task };
          try {
            return await task;
          } finally {
            if (fundInflight.current?.task === task) fundInflight.current = null;
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
    </div>
  );
}
