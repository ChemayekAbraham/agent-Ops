import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { motion, useReducedMotion } from 'framer-motion';
import { AlertTriangle, Crosshair, Home, Loader2, Search } from 'lucide-react';
import { toast } from 'sonner';
import { useAuth } from '@/hooks/useAuth';
import type { AppRole } from '@/hooks/useAuth';
import { useProfile } from '@/hooks/useProfile';
import DashboardHeader from '@/components/DashboardHeader';
import BottomRoleSwitcher from '@/components/BottomRoleSwitcher';
import { NotificationBell } from '@/components/supporter/NotificationBell';
import { roleToSlug } from '@/lib/roleRoutes';
import { roleDashboardRoutes } from '@/components/layout/executiveSidebarConfig';
import { supabase } from '@/integrations/supabase/client';
import { FunderNewFilterChips } from '@/components/funder-new/FunderNewFilterChips';
import { itemAmount } from '@/components/funder-new/utils';
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

type CategoryFilter = 'all' | FunderNewCategory;

interface FeedEntry {
  category: FunderNewCategory;
  item: FunderNewEmptyHouse | FunderNewReadyPlan;
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
  const navigate = useNavigate();
  const { user, roles, signOut, switchRole } = useAuth();
  const { profile } = useProfile();
  const wallet = useWalletBalance(user?.id);
  const summary = useFunderNewMarketSummary();
  const location = useFunderNewLocation();
  const { saved, toggleSave } = useFunderSavedItems();

  // Same role-switch behavior as /dashboard/funder: switch, then let the
  // persona URL render the matching dashboard.
  const handleRoleSwitch = useCallback(
    (newRole: AppRole) => {
      if (!roles.includes(newRole)) return;
      switchRole(newRole);
      const targetRoute = roleDashboardRoutes[newRole] || roleToSlug(newRole);
      navigate(targetRoute, { replace: true });
    },
    [roles, switchRole, navigate],
  );

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

  // The avatars bucket is private, so the stored public-style URL returns
  // 404. Swap it for a short-lived signed URL that works in an <img> tag.
  const [signedAvatarUrl, setSignedAvatarUrl] = useState<string | null>(null);
  useEffect(() => {
    setSignedAvatarUrl(null);
    if (!avatarUrl) return;
    const match = avatarUrl.match(/\/object\/public\/avatars\/([^?]+)/);
    if (!match) {
      setSignedAvatarUrl(avatarUrl);
      return;
    }
    let cancelled = false;
    supabase.storage
      .from('avatars')
      .createSignedUrl(match[1], 60 * 60)
      .then(({ data, error }) => {
        if (cancelled) return;
        setSignedAvatarUrl(error || !data ? avatarUrl : data.signedUrl);
      });
    return () => {
      cancelled = true;
    };
  }, [avatarUrl]);

  // The app top bar is sticky, so the map and the floating search bar have to
  // sit below it. Measure its real height (safe-area + content) once mounted.
  const rootRef = useRef<HTMLDivElement | null>(null);
  const [headerH, setHeaderH] = useState(0);
  useEffect(() => {
    const el = rootRef.current?.querySelector('header');
    if (!el) return;
    const measure = () => setHeaderH(el.getBoundingClientRect().height);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // Frosted top bar: once the houses sheet scrolls up under the fixed top
  // bar, the bar gets a glass background so the list reads through it.
  const [barFrosted, setBarFrosted] = useState(false);
  const sheetTopRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const sentinel = sheetTopRef.current;
    if (!sentinel) return;
    const observer = new IntersectionObserver(
      ([entry]) => setBarFrosted(!entry.isIntersecting),
      // Trigger when the sheet top reaches the bottom edge of the top bar
      // (app header + 48px bar + a small margin).
      { rootMargin: `-${headerH + 60}px 0px 0px 0px`, threshold: 0 },
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [headerH]);



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

  const availableBalance = wallet.isLoading || wallet.error ? null : wallet.withdrawable;
  const entries = useMemo<FeedEntry[]>(() => {
    const empty =
      category === 'ready'
        ? []
        : (emptyQuery.data?.pages ?? []).flatMap((page) => page.items).map((item): FeedEntry => ({ category: 'empty', item }));
    const ready =
      category === 'empty'
        ? []
        : (readyQuery.data?.pages ?? []).flatMap((page) => page.items).map((item): FeedEntry => ({ category: 'ready', item }));
    // Re-apply every chosen filter to the loaded rows: the Rent Plan read
    // service ignores district/distance/sort, so without this those choices
    // look like they do nothing. Presentation only.
    const rec = (e: FeedEntry) => e.item as unknown as Record<string, unknown>;
    const place = filters.location.trim().toLowerCase();
    const radius = filters.radiusKm === 'all' ? null : filters.radiusKm;
    const filtered = [...empty, ...ready].filter((entry) => {
      const r = rec(entry);
      const amount = itemAmount(entry.category, entry.item);
      if (place) {
        const where = ['district', 'city', 'area', 'location', 'region']
          .map((k) => (typeof r[k] === 'string' ? (r[k] as string).toLowerCase() : ''))
          .join(' ');
        if (!where.includes(place)) return false;
      }
      if (filters.rentMin !== null && amount < filters.rentMin) return false;
      if (filters.rentMax !== null && amount > filters.rentMax) return false;
      if (radius !== null) {
        const d = Number(r.distance_km);
        if (!Number.isFinite(d) || r.distance_km === null || d > radius) return false;
      }
      if (filters.withinFloat && availableBalance !== null && !(amount > 0 && amount <= availableBalance)) return false;
      return true;
    });
    const amt = (e: FeedEntry) => itemAmount(e.category, e.item);
    switch (filters.sort) {
      case 'rent_low':
        return filtered.sort((a, b) => amt(a) - amt(b));
      case 'rent_high':
        return filtered.sort((a, b) => amt(b) - amt(a));
      case 'nearest': {
        const d = (e: FeedEntry) => {
          const n = Number(rec(e).distance_km);
          return rec(e).distance_km == null || !Number.isFinite(n) ? Infinity : n;
        };
        return filtered.sort((a, b) => d(a) - d(b));
      }
      case 'newest': {
        const t = (e: FeedEntry) => Date.parse(String(rec(e).created_at ?? '')) || 0;
        return filtered.sort((a, b) => t(b) - t(a));
      }
      default:
        return sortFunderFeedEntries(filtered);
    }
  }, [category, emptyQuery.data, readyQuery.data, filters, availableBalance]);

  const districtOptions = useMemo(
    () => (summary.data?.districts ?? []).map((d) => ({ value: d.value, label: d.label, count: d.count })),
    [summary.data],
  );

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
  const prefix = getDynamicCurrencySymbol();
  const totalFigure =
    total === null
      ? ''
      : formatDynamic(total).replace(prefix, '').replace(/^[^\d.,-]+/, '').trim();

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
    <div ref={rootRef} className="min-h-screen bg-background font-['Outfit'] text-foreground">
      {/* ═══ APP CHROME: top bar with the logo, role switcher and notification bell ═══ */}
      <DashboardHeader
        currentRole="supporter"
        availableRoles={roles}
        onRoleChange={handleRoleSwitch}
        onSignOut={signOut}
        headerActions={user ? <NotificationBell userId={user.id} /> : undefined}
        compactInstallPrompt
      />

      {/* ═══ MAP HERO ═══ */}
      <div className="sticky h-[clamp(440px,66svh,620px)] w-full" style={{ top: headerH }}>
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
      <div
        className={cn(
          'pointer-events-none fixed inset-x-0 z-20 mx-auto max-w-3xl px-4 pt-3 transition-colors duration-300',
          barFrosted && 'bg-background/85 pb-3 shadow-[0_8px_24px_-12px_hsl(222_47%_11%/0.25)] backdrop-blur-2xl backdrop-saturate-150',
        )}
        style={{ top: headerH }}
      >
        <motion.div className="pointer-events-auto flex items-center gap-2.5" {...enter(0)}>
          <Link
            to={welileId ? `/profile/${welileId}` : '/profile'}
            aria-label="Your profile"
            className="flex h-12 w-12 flex-none items-center justify-center overflow-hidden rounded-full border-[3px] border-white bg-primary text-[15px] font-bold text-primary-foreground shadow-lg"
          >
            {signedAvatarUrl && !avatarFailed ? (
              <img
                src={signedAvatarUrl}
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
          <div ref={sheetTopRef} aria-hidden className="h-px" />
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
            <p className="text-sm text-muted-foreground">
              {cellQuery.data && neededInView > 0
                ? `${formatDynamicCompact(neededInView)} needed in this area · move the map to explore`
                : 'Move the map to explore other areas'}
            </p>
          </div>

          <FunderNewFilterChips
            filters={filters}
            districts={districtOptions}
            supportsSort
            hasOrigin={!!origin}
            availableBalance={availableBalance}
            floatBalance={wallet.isLoading || wallet.error ? null : wallet.floatBalance}
            onChange={(next) => setFilters((current) => ({ ...current, ...next }))}
            onSortChange={(sort) => {
              setSortTouched(true);
              if (sort === 'nearest' && !origin) location.request();
              setFilters((current) => ({ ...current, sort }));
            }}
          />

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

      {/* Bottom role pill — the same Tenant / Agent / Partner / Owner switcher as the rest of the app. */}
      <BottomRoleSwitcher currentRole="supporter" onRoleChange={handleRoleSwitch} />
    </div>
  );
}
