import { useEffect, useMemo, useState, useCallback, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { motion, AnimatePresence } from 'framer-motion';
import { MapPin, Home, ArrowRight, X, AlertCircle, RefreshCw, Check, Wallet, TrendingUp, CalendarIcon, Lock, SlidersHorizontal, ChevronDown, ChevronLeft, ChevronRight } from 'lucide-react';
import { format, addMonths } from 'date-fns';
import { Calendar } from '@/components/ui/calendar';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { cn } from '@/lib/utils';
import { supabase } from '@/integrations/supabase/client';
import { formatUGX } from '@/lib/rentCalculations';
import { calcFunderEarnings, sumFunderEarnings } from '@/lib/funderEarnings';
import { FunderEarningsAssumptions } from './FunderEarningsAssumptions';
import { FunderEarningsBreakdown } from './FunderEarningsBreakdown';
import { useWallet } from '@/hooks/useWallet';
import { useAuth } from '@/hooks/useAuth';
import { Button } from '@/components/ui/button';
import { FunderTopUpDialog } from './FunderTopUpDialog';
import { FunderSelectionConfirmDialog } from './FunderSelectionConfirmDialog';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { toast } from 'sonner';
import { hapticTap } from '@/lib/haptics';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { MoveInOfferBadge } from '@/components/house/MoveInOfferBadge';
import { ShareHouseButton } from '@/components/tenant/ShareHouseButton';

interface House {
  id: string;
  title: string;
  region: string;
  district: string | null;
  address: string | null;
  house_category: string;
  number_of_rooms: number;
  daily_rate: number;
  monthly_rent: number;
  image_urls: string[] | null;
  short_code: string | null;
  created_at: string;
}

const CATEGORIES = [
  { value: 'all', label: 'All Types' },
  { value: 'single_room', label: 'Single Room' },
  { value: 'double_room', label: 'Double Room' },
  { value: 'bedsitter', label: 'Bedsitter' },
  { value: 'one_bedroom', label: '1 Bedroom' },
  { value: 'two_bedroom', label: '2 Bedrooms' },
  { value: 'three_bedroom', label: '3 Bedrooms' },
  { value: 'studio', label: 'Studio' },
  { value: 'shop', label: 'Shop / Lock-up Shop' },
  { value: 'market_stall', label: 'Market Stall' },
  { value: 'kiosk', label: 'Kiosk / Container' },
  { value: 'salon_workshop', label: 'Salon / Workshop' },
  { value: 'office_space', label: 'Office Space' },
  { value: 'warehouse_store', label: 'Warehouse / Store' },
  { value: 'commercial_premises', label: 'Other Commercial Premises' },
];

const REGIONS = [
  'All Regions', 'Central', 'Eastern', 'Northern', 'Western',
  'Kampala', 'Wakiso', 'Mukono', 'Jinja', 'Mbale',
  'Mbarara', 'Gulu', 'Lira', 'Fort Portal', 'Masaka',
  'Entebbe', 'Nansana', 'Kira', 'Bweyogerere',
];

const ROOMS = [
  { value: 'all', label: 'Any rooms' },
  { value: '1', label: '1 room' },
  { value: '2', label: '2 rooms' },
  { value: '3', label: '3 rooms' },
  { value: '4+', label: '4+ rooms' },
];

const SORTS = [
  { value: 'newest', label: 'Newest' },
  { value: 'earn_desc', label: 'Earnings: High to Low' },
  { value: 'earn_asc', label: 'Earnings: Low to High' },
  { value: 'price_asc', label: 'Price: Low to High' },
  { value: 'price_desc', label: 'Price: High to Low' },
  { value: 'rooms_desc', label: 'Most rooms' },
];

// Minimum projected monthly earning (15% of rent) filters
const MIN_MONTHLY_EARN = [
  { value: 'all', label: 'Any monthly earning' },
  { value: '5000', label: 'Monthly 5k+' },
  { value: '10000', label: 'Monthly 10k+' },
  { value: '15000', label: 'Monthly 15k+' },
  { value: '30000', label: 'Monthly 30k+' },
  { value: '50000', label: 'Monthly 50k+' },
];

// Minimum projected 12-month earning filters
const MIN_ANNUAL_EARN = [
  { value: 'all', label: 'Any 12-month earning' },
  { value: '100000', label: '12-month 100k+' },
  { value: '250000', label: '12-month 250k+' },
  { value: '500000', label: '12-month 500k+' },
  { value: '1000000', label: '12-month 1M+' },
];

function HouseCardSkeleton() {
  return (
    <div className="rounded-2xl border border-border/60 bg-card overflow-hidden">
      <div className="h-36 bg-muted/60 animate-pulse" />
      <div className="p-3 space-y-2">
        <div className="h-4 w-3/4 rounded-md bg-muted/60 animate-pulse" />
        <div className="h-3 w-1/2 rounded-md bg-muted/60 animate-pulse" />
        <div className="h-4 w-1/3 rounded-md bg-muted/60 animate-pulse" />
      </div>
    </div>
  );
}

function ListingSkeleton() {
  return (
    <div className="space-y-3" aria-busy="true" aria-label="Loading houses">
      <div className="h-10 rounded-xl bg-muted/60 animate-pulse" />
      <div className="flex flex-wrap items-center gap-2">
        <div className="h-9 w-[130px] rounded-lg bg-muted/60 animate-pulse" />
        <div className="h-9 w-[130px] rounded-lg bg-muted/60 animate-pulse" />
        <div className="h-9 w-[132px] rounded-lg bg-muted/60 animate-pulse" />
        <div className="h-9 w-[150px] rounded-lg bg-muted/60 animate-pulse" />
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        {Array.from({ length: 6 }).map((_, i) => (
          <HouseCardSkeleton key={i} />
        ))}
      </div>
    </div>
  );
}

export function FunderDirectHouseListing() {
  const navigate = useNavigate();
  const { wallet } = useWallet();
  const walletBalance = wallet?.balance ?? 0;
  const { user } = useAuth();
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [showTopUp, setShowTopUp] = useState(false);
  const [showConfirm, setShowConfirm] = useState(false);
  // Once confirmed the selection is locked so it can't change while funding
  const [selectionLocked, setSelectionLocked] = useState(false);
  // Tenant move-in / start date the earnings projection is anchored on
  const [moveInDate, setMoveInDate] = useState<Date>(() => new Date());
  // House whose repayment details modal is open ("View repayment terms")
  const [detailsHouse, setDetailsHouse] = useState<House | null>(null);
  const [houses, setHouses] = useState<House[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(true);
  const [totalMatch, setTotalMatch] = useState<number | null>(null);
  const [countLoading, setCountLoading] = useState(false);
  const mountedRef = useRef(true);
  const countTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);



  const PAGE_SIZE = 100;
  const CARDS_PER_PAGE = 4;

  const [search, setSearch] = useState('');
  const [region, setRegion] = useState('all');
  const [category, setCategory] = useState('all');
  const [rooms, setRooms] = useState('all');
  const [sortBy, setSortBy] = useState('newest');
  const [minMonthlyEarn, setMinMonthlyEarn] = useState('all');
  const [minAnnualEarn, setMinAnnualEarn] = useState('all');
  // Draft filter values — only committed to the applied state on "Apply filters"
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [draftRegion, setDraftRegion] = useState('all');
  const [draftCategory, setDraftCategory] = useState('all');
  const [draftRooms, setDraftRooms] = useState('all');
  const [draftSortBy, setDraftSortBy] = useState('newest');
  const [draftMinMonthlyEarn, setDraftMinMonthlyEarn] = useState('all');
  const [draftMinAnnualEarn, setDraftMinAnnualEarn] = useState('all');
  const [page, setPage] = useState(1);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const fetchHouses = useCallback(async (isRetry = false, append = false) => {
    if (isRetry) {
      setError(false);
      setLoading(true);
    }
    if (append) setLoadingMore(true);
    const offset = append ? (houses?.length ?? 0) : 0;
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { data, error: sbError } = await (supabase as any)
        .from('house_listings')
        .select(
          'id, title, region, district, address, house_category, number_of_rooms, daily_rate, monthly_rent, image_urls, short_code, created_at'
        )
        .eq('status', 'available')
        .eq('is_hidden', false)
        .eq('verified', true)
        .is('tenant_id', null)
        .not('image_urls', 'is', null)
        .neq('image_urls', '{}')
        .order('created_at', { ascending: false })
        .range(offset, offset + PAGE_SIZE - 1);

      if (sbError) throw sbError;

      if (!mountedRef.current) return;
      const rows = ((data as House[]) || []).filter(
        (h) =>
          Array.isArray(h.image_urls) &&
          h.image_urls.some((u) => typeof u === 'string' && u.trim().length > 0)
      );
      setHasMore(((data as House[]) || []).length === PAGE_SIZE);
      setHouses((prev) => (append && prev ? [...prev, ...rows] : rows));
      setError(false);
    } catch (err) {
      console.error('[FunderDirectHouseListing] fetch error:', err);
      if (!mountedRef.current) return;
      if (!append) setError(true);
      toast.error('Couldn’t load houses', {
        description: 'Please check your connection and try again.',
      });
    } finally {
      if (mountedRef.current) {
        setLoading(false);
        setLoadingMore(false);
      }
    }
  }, [houses]);

  const fetchMatchCount = useCallback(async () => {
    setCountLoading(true);
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let query = (supabase as any)
        .from('house_listings')
        .select('*', { count: 'exact', head: true })
        .eq('status', 'available')
        .eq('is_hidden', false)
        .eq('verified', true)
        .is('tenant_id', null)
        .not('image_urls', 'is', null)
        .neq('image_urls', '{}');

      const q = search.trim();
      if (q) {
        const like = `%${q}%`;
        query = query.or(
          `title.ilike.${like},region.ilike.${like},district.ilike.${like},address.ilike.${like},short_code.ilike.${like}`
        );
      }

      if (region !== 'all') {
        const r = region.toLowerCase();
        query = query.or(`region.ilike.${r},district.ilike.${r}`);
      }

      if (category !== 'all') {
        query = query.eq('house_category', category);
      }

      if (rooms !== 'all') {
        if (rooms === '4+') {
          query = query.gte('number_of_rooms', 4);
        } else {
          query = query.eq('number_of_rooms', parseInt(rooms, 10));
        }
      }

      const { count, error: sbError } = await query;
      if (sbError) throw sbError;
      if (!mountedRef.current) return;
      setTotalMatch(count ?? null);
    } catch (err) {
      console.error('[FunderDirectHouseListing] count error:', err);
    } finally {
      if (mountedRef.current) setCountLoading(false);
    }
  }, [search, region, category, rooms]);

  useEffect(() => {
    fetchHouses();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (countTimerRef.current) clearTimeout(countTimerRef.current);
    countTimerRef.current = setTimeout(() => {
      fetchMatchCount();
    }, 150);
    return () => {
      if (countTimerRef.current) clearTimeout(countTimerRef.current);
    };
  }, [fetchMatchCount]);

  // Reset pagination whenever search or filters change so results start from page 1
  useEffect(() => {
    setPage(1);
  }, [search, region, category, rooms, sortBy, minMonthlyEarn, minAnnualEarn]);


  const filtered = useMemo(() => {
    if (!houses) return [];
    let result = [...houses];

    const q = search.trim().toLowerCase();
    if (q) {
      result = result.filter(
        (h) =>
          h.title.toLowerCase().includes(q) ||
          h.region.toLowerCase().includes(q) ||
          (h.district || '').toLowerCase().includes(q) ||
          (h.address || '').toLowerCase().includes(q) ||
          (h.short_code || '').toLowerCase().includes(q)
      );
    }

    if (region !== 'all') {
      const r = region.toLowerCase();
      result = result.filter(
        (h) =>
          h.region.toLowerCase() === r || (h.district || '').toLowerCase() === r
      );
    }

    if (category !== 'all') {
      result = result.filter((h) => h.house_category === category);
    }

    if (rooms !== 'all') {
      if (rooms === '4+') {
        result = result.filter((h) => h.number_of_rooms >= 4);
      } else {
        const n = parseInt(rooms, 10);
        result = result.filter((h) => h.number_of_rooms === n);
      }
    }

    // Projected-earnings filters (15% of monthly rent, anchored on move-in date)
    if (minMonthlyEarn !== 'all') {
      const min = Number(minMonthlyEarn);
      result = result.filter((h) => calcFunderEarnings(h.monthly_rent, moveInDate).monthly >= min);
    }
    if (minAnnualEarn !== 'all') {
      const min = Number(minAnnualEarn);
      result = result.filter((h) => calcFunderEarnings(h.monthly_rent, moveInDate).annual >= min);
    }

    result.sort((a, b) => {
      if (sortBy === 'newest') {
        return (
          new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
        );
      }
      if (sortBy === 'earn_desc') {
        return (
          calcFunderEarnings(b.monthly_rent, moveInDate).monthly -
          calcFunderEarnings(a.monthly_rent, moveInDate).monthly
        );
      }
      if (sortBy === 'earn_asc') {
        return (
          calcFunderEarnings(a.monthly_rent, moveInDate).monthly -
          calcFunderEarnings(b.monthly_rent, moveInDate).monthly
        );
      }
      if (sortBy === 'price_asc') return a.daily_rate - b.daily_rate;
      if (sortBy === 'price_desc') return b.daily_rate - a.daily_rate;
      if (sortBy === 'rooms_desc') return b.number_of_rooms - a.number_of_rooms;
      return 0;
    });

    return result;
  }, [houses, search, region, category, rooms, sortBy, minMonthlyEarn, minAnnualEarn, moveInDate]);

  const totalPages = Math.max(1, Math.ceil(filtered.length / CARDS_PER_PAGE));
  const safePage = Math.min(page, totalPages);
  const paginatedHouses = useMemo(() => {
    const start = (safePage - 1) * CARDS_PER_PAGE;
    return filtered.slice(start, start + CARDS_PER_PAGE);
  }, [filtered, safePage]);
  const showingStart = filtered.length === 0 ? 0 : (safePage - 1) * CARDS_PER_PAGE + 1;
  const showingEnd = Math.min(safePage * CARDS_PER_PAGE, filtered.length);

  const openHouse = (house: House) => {
    hapticTap();
    navigate(`/house/${house.short_code || house.id}`, { state: { from: 'funder' } });
  };

  const toggleSelect = (id: string) => {
    hapticTap();
    if (selectionLocked) {
      toast.info('Selection locked', {
        description: 'Unlock your selection to add or remove houses.',
      });
      return;
    }
    setSelectedIds((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]
    );
    if (!selectedIds.includes(id)) {
      trackFunnelStep('funder_house_selected', id, { source: 'funder_direct_listing' });
    }
  };

  const goExplore = () => {
    hapticTap();
    navigate('/find-a-house', { state: { from: 'funder' } });
  };

  const clearFilters = () => {
    setRegion('all');
    setCategory('all');
    setRooms('all');
    setSortBy('newest');
    setMinMonthlyEarn('all');
    setMinAnnualEarn('all');
    setPage(1);
  };

  const goToPage = (nextPage: number) => {
    hapticTap();
    const clamped = Math.max(1, Math.min(nextPage, totalPages));
    setPage(clamped);
    containerRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  /**
   * Best-effort funnel tracking. Each step of the funder journey
   * (view repayment terms → select house → lock selection → start funding)
   * emits a `system_events` row so the funnel report can measure drop-off.
   */
  const trackFunnelStep = useCallback(
    async (
      eventType:
        | 'funder_house_repayment_terms_viewed'
        | 'funder_house_selected'
        | 'funder_selection_locked'
        | 'funder_funding_started',
      houseId?: string,
      metadata?: Record<string, unknown>,
    ) => {
      if (!user?.id) return;
      try {
        await supabase.from('system_events').insert({
          event_type: eventType,
          user_id: user.id,
          related_entity_type: houseId ? 'house_listing' : 'funder_selection',
          related_entity_id: houseId ?? null,
          metadata: { source: 'funder_direct_listing', ...(metadata || {}) },
        } as any);
      } catch (err) {
        // Best-effort tracking; don't block the UI
        console.error('[FunderDirectHouseListing] track funnel error:', err);
      }
    },
    [user?.id]
  );

  const trackRepaymentTermsView = useCallback(
    (house: House) => {
      void trackFunnelStep('funder_house_repayment_terms_viewed', house.id, {
        monthly_rent: house.monthly_rent,
        daily_rate: house.daily_rate,
      });
    },
    [trackFunnelStep]
  );

  const activeFilterChips = [
    region !== 'all' && {
      label: region,
      onRemove: () => { setRegion('all'); setDraftRegion('all'); },
    },
    category !== 'all' && {
      label: CATEGORIES.find((c) => c.value === category)?.label || category,
      onRemove: () => { setCategory('all'); setDraftCategory('all'); },
    },
    rooms !== 'all' && {
      label: ROOMS.find((r) => r.value === rooms)?.label || rooms,
      onRemove: () => { setRooms('all'); setDraftRooms('all'); },
    },
    minMonthlyEarn !== 'all' && {
      label: MIN_MONTHLY_EARN.find((m) => m.value === minMonthlyEarn)?.label || minMonthlyEarn,
      onRemove: () => { setMinMonthlyEarn('all'); setDraftMinMonthlyEarn('all'); },
    },
    minAnnualEarn !== 'all' && {
      label: MIN_ANNUAL_EARN.find((m) => m.value === minAnnualEarn)?.label || minAnnualEarn,
      onRemove: () => { setMinAnnualEarn('all'); setDraftMinAnnualEarn('all'); },
    },
  ].filter(Boolean) as { label: string; onRemove: () => void }[];

  const activeFilterCount = activeFilterChips.length;

  const openFilters = () => {
    setDraftRegion(region);
    setDraftCategory(category);
    setDraftRooms(rooms);
    setDraftSortBy(sortBy);
    setDraftMinMonthlyEarn(minMonthlyEarn);
    setDraftMinAnnualEarn(minAnnualEarn);
    setFiltersOpen(true);
  };

  const applyDraftFilters = () => {
    hapticTap();
    setRegion(draftRegion);
    setCategory(draftCategory);
    setRooms(draftRooms);
    setSortBy(draftSortBy);
    setMinMonthlyEarn(draftMinMonthlyEarn);
    setMinAnnualEarn(draftMinAnnualEarn);
    setFiltersOpen(false);
  };

  const clearDraftFilters = () => {
    setDraftRegion('all');
    setDraftCategory('all');
    setDraftRooms('all');
    setDraftSortBy('newest');
    setDraftMinMonthlyEarn('all');
    setDraftMinAnnualEarn('all');
  };

  const selectedHouses = (houses ?? []).filter((h) => selectedIds.includes(h.id));
  const earningsFilterActive = minMonthlyEarn !== 'all' || minAnnualEarn !== 'all';
  const selectionTotals = sumFunderEarnings(selectedHouses.map((h) => h.monthly_rent), moveInDate);
  const shortfall = Math.max(0, selectionTotals.capital - walletBalance);

  if (loading) {
    return <ListingSkeleton />;
  }

  if (error && houses === null) {
    return (
      <div className="rounded-2xl border border-border/60 bg-card p-6 text-center space-y-3">
        <div className="mx-auto w-12 h-12 rounded-full bg-destructive/10 flex items-center justify-center">
          <AlertCircle className="h-6 w-6 text-destructive" />
        </div>
        <div className="space-y-1">
          <p className="text-sm font-semibold text-foreground">Couldn’t load houses</p>
          <p className="text-[11px] text-muted-foreground">
            Something went wrong while fetching the available houses. Please try again.
          </p>
        </div>
        <button
          type="button"
          onClick={() => fetchHouses(true)}
          className="inline-flex items-center gap-1.5 text-xs font-semibold text-primary hover:text-primary/80 touch-manipulation"
        >
          <RefreshCw className="h-3.5 w-3.5" />
          Try again
        </button>
      </div>
    );
  }

  return (
    <div ref={containerRef} className="space-y-3">
      {/* Filter toggle + live count */}
      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          variant={filtersOpen ? 'default' : 'outline'}
          size="sm"
          onClick={() => (filtersOpen ? setFiltersOpen(false) : openFilters())}
          aria-expanded={filtersOpen}
          aria-controls="funder-house-filters"
          className="h-9 gap-1.5 text-xs"
        >
          <SlidersHorizontal className="h-3.5 w-3.5" />
          Filters
          {activeFilterCount > 0 && (
            <span className="ml-0.5 inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-primary/15 px-1 text-[10px] font-bold text-primary">
              {activeFilterCount}
            </span>
          )}
          <ChevronDown className={cn('h-3.5 w-3.5 transition-transform', filtersOpen && 'rotate-180')} />
        </Button>

        <div className="ml-auto flex items-center gap-1.5 rounded-full border border-border bg-card px-3 py-1.5 text-xs font-semibold text-foreground">
          {countLoading && (
            <RefreshCw className="h-3 w-3 animate-spin text-muted-foreground" />
          )}
          <span aria-live="polite" aria-atomic="true">
            {(earningsFilterActive ? filtered.length : (totalMatch ?? filtered.length)).toLocaleString()}{' '}
            {(earningsFilterActive ? filtered.length : (totalMatch ?? filtered.length)) === 1 ? 'house' : 'houses'} found
          </span>
        </div>
      </div>

      {/* Collapsible filter panel */}
      <AnimatePresence initial={false}>
        {filtersOpen && (
          <motion.div
            id="funder-house-filters"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.2 }}
            className="overflow-hidden"
          >
            <div className="rounded-2xl border border-border/60 bg-card p-3 space-y-3">
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                <Select value={draftRegion} onValueChange={setDraftRegion}>
                  <SelectTrigger className="h-9 text-xs" aria-label="Filter by region">
                    <SelectValue placeholder="Region" />
                  </SelectTrigger>
                  <SelectContent>
                    {REGIONS.map((r) => (
                      <SelectItem
                        key={r === 'All Regions' ? 'all' : r}
                        value={r === 'All Regions' ? 'all' : r}
                        className="text-xs"
                      >
                        {r}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>

                <Select value={draftCategory} onValueChange={setDraftCategory}>
                  <SelectTrigger className="h-9 text-xs" aria-label="Filter by house type">
                    <SelectValue placeholder="Type" />
                  </SelectTrigger>
                  <SelectContent>
                    {CATEGORIES.map((c) => (
                      <SelectItem key={c.value} value={c.value} className="text-xs">
                        {c.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>

                <Select value={draftRooms} onValueChange={setDraftRooms}>
                  <SelectTrigger className="h-9 text-xs" aria-label="Filter by number of rooms">
                    <SelectValue placeholder="Rooms" />
                  </SelectTrigger>
                  <SelectContent>
                    {ROOMS.map((r) => (
                      <SelectItem key={r.value} value={r.value} className="text-xs">
                        {r.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>

                <Select value={draftSortBy} onValueChange={setDraftSortBy}>
                  <SelectTrigger className="h-9 text-xs" aria-label="Sort houses">
                    <SelectValue placeholder="Sort" />
                  </SelectTrigger>
                  <SelectContent>
                    {SORTS.map((s) => (
                      <SelectItem key={s.value} value={s.value} className="text-xs">
                        {s.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>

                <Select value={draftMinMonthlyEarn} onValueChange={setDraftMinMonthlyEarn}>
                  <SelectTrigger className="h-9 text-xs" aria-label="Filter by projected monthly earning">
                    <SelectValue placeholder="Monthly earning" />
                  </SelectTrigger>
                  <SelectContent>
                    {MIN_MONTHLY_EARN.map((m) => (
                      <SelectItem key={m.value} value={m.value} className="text-xs">
                        {m.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>

                <Select value={draftMinAnnualEarn} onValueChange={setDraftMinAnnualEarn}>
                  <SelectTrigger className="h-9 text-xs" aria-label="Filter by projected 12-month earning">
                    <SelectValue placeholder="12-month earning" />
                  </SelectTrigger>
                  <SelectContent>
                    {MIN_ANNUAL_EARN.map((m) => (
                      <SelectItem key={m.value} value={m.value} className="text-xs">
                        {m.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="flex items-center justify-end gap-2">
                <Button type="button" variant="ghost" size="sm" onClick={clearDraftFilters} className="h-9 text-xs">
                  Clear
                </Button>
                <Button type="button" size="sm" onClick={applyDraftFilters} className="h-9 text-xs">
                  Apply filters
                </Button>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Move-in date anchor for the earnings projection */}
      <div className="flex flex-wrap items-center gap-2 rounded-2xl border border-primary/20 bg-primary/5 px-3 py-2.5">
        <div className="min-w-0">
          <p className="text-[9px] font-semibold uppercase tracking-widest text-muted-foreground">
            Tenant move-in date
          </p>
          <p className="text-[10px] text-muted-foreground">
            Earnings run {format(moveInDate, 'd MMM yyyy')} → {format(addMonths(moveInDate, 12), 'd MMM yyyy')} ({selectionTotals.daysInTerm} days)
          </p>
        </div>
        <Popover>
          <PopoverTrigger asChild>
            <Button
              variant="outline"
              className={cn('ml-auto h-9 rounded-xl justify-start text-left text-xs font-semibold gap-2')}
              aria-label="Pick the tenant move-in date"
            >
              <CalendarIcon className="h-3.5 w-3.5" />
              {format(moveInDate, 'd MMM yyyy')}
            </Button>
          </PopoverTrigger>
          <PopoverContent className="w-auto p-0" align="end">
            <Calendar
              mode="single"
              selected={moveInDate}
              onSelect={(d) => d && setMoveInDate(d)}
              initialFocus
              className={cn('p-3 pointer-events-auto')}
            />
          </PopoverContent>
        </Popover>
      </div>

      {/* How the projections are calculated */}
      <FunderEarningsAssumptions
        startDate={moveInDate}
        endDate={addMonths(moveInDate, 12)}
        daysInTerm={selectionTotals.daysInTerm}
      />

      {/* Active filter chips */}
      <AnimatePresence>
        {activeFilterChips.length > 0 && (
          <motion.div
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: 'auto' }}
            exit={{ opacity: 0, height: 0 }}
            className="flex flex-wrap items-center gap-2 overflow-hidden"
          >
            <span className="text-[10px] text-muted-foreground font-medium">Active:</span>
            {activeFilterChips.map((f, i) => (
              <Badge key={i} variant="secondary" className="text-[10px] gap-1 pr-1">
                {f.label}
                <button
                  type="button"
                  onClick={f.onRemove}
                  className="ml-0.5 rounded-full hover:bg-muted p-0.5"
                  aria-label={`Remove ${f.label} filter`}
                >
                  <X className="h-3 w-3" />
                </button>
              </Badge>
            ))}
            <button
              type="button"
              onClick={clearFilters}
              className="text-[10px] text-primary font-semibold ml-auto"
            >
              Clear all
            </button>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Results header */}
      <div className="flex items-center justify-between">
        <p className="text-[11px] text-muted-foreground">
          Showing {showingStart.toLocaleString()}–{showingEnd.toLocaleString()} of {(totalMatch ?? filtered.length).toLocaleString()}
        </p>
        <button
          type="button"
          onClick={goExplore}
          className="text-[11px] text-primary font-semibold flex items-center gap-0.5 touch-manipulation"
        >
          See all <ArrowRight className="h-3 w-3" />
        </button>
      </div>


      {/* Grid */}
      {filtered.length === 0 ? (
        <div className="rounded-xl border border-dashed border-border bg-muted/30 p-6 text-center">
          <Home className="h-8 w-8 text-muted-foreground/40 mx-auto mb-2" />
          <p className="text-sm font-semibold text-foreground">No houses match your filters</p>
          <p className="text-[11px] text-muted-foreground mt-1">
            Try adjusting your search or filters.
          </p>
          <button
            type="button"
            onClick={clearFilters}
            className="mt-3 text-xs text-primary font-semibold"
          >
            Clear filters
          </button>
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          {paginatedHouses.map((house) => {
            const earn = calcFunderEarnings(house.monthly_rent, moveInDate);
            const selected = selectedIds.includes(house.id);
            return (
            <motion.div
              key={house.id}
              layout
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              role="button"
              tabIndex={0}
              onClick={() => openHouse(house)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') openHouse(house);
              }}
              className={`rounded-2xl border bg-card overflow-hidden shadow-sm hover:shadow-md active:scale-[0.98] transition-all cursor-pointer text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-background ${
                selected ? 'border-primary ring-2 ring-primary/30' : 'border-border/60'
              }`}
              aria-label={`View details for ${house.title}`}
            >
              <div className="relative w-full h-36 bg-muted">
                {house.image_urls?.[0] ? (
                  <img
                    src={house.image_urls[0]}
                    alt={house.title}
                    className="w-full h-full object-cover"
                    loading="lazy"
                  />
                ) : (
                  <div className="w-full h-full flex items-center justify-center">
                    <Home className="h-8 w-8 text-muted-foreground/30" />
                  </div>
                )}
                <span className="absolute top-2 left-2 px-1.5 py-0.5 rounded-full bg-background/85 backdrop-blur text-[9px] font-bold text-foreground">
                  {house.number_of_rooms} rm
                </span>
                <span
                  className="absolute top-2 right-2"
                  onClick={(e) => e.stopPropagation()}
                  role="presentation"
                >
                  <ShareHouseButton
                    listingId={house.id}
                    title={house.title}
                    region={house.region}
                    dailyRate={house.daily_rate}
                    shortCode={house.short_code}
                    mode="share"
                    address={house.address}
                    monthlyRent={house.monthly_rent}
                    rooms={house.number_of_rooms}
                    category={house.house_category}
                  />
                </span>
              </div>
              <div className="p-3 space-y-1">
                <p className="font-semibold text-sm truncate">{house.title}</p>
                <div className="flex items-center gap-1 text-[10px] text-muted-foreground">
                  <MapPin className="h-3 w-3 shrink-0" />
                  <span className="truncate">
                    {house.region}
                    {house.district ? `, ${house.district}` : ''}
                  </span>
                </div>
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    trackRepaymentTermsView(house);
                    setDetailsHouse(house);
                  }}
                  className="text-[10px] font-semibold text-primary hover:underline touch-manipulation"
                >
                  View repayment terms
                </button>

                {/* Funder earning projection — 15% of monthly rent */}
                {earn.capital > 0 && (
                  <div className="mt-2 rounded-xl border border-primary/20 bg-primary/5 p-2.5 space-y-1.5">
                    <div className="flex items-center justify-between">
                      <span className="flex items-center gap-1 text-[9px] font-semibold uppercase tracking-widest text-muted-foreground">
                        <TrendingUp className="h-3 w-3 text-primary" /> You earn
                      </span>
                      <span className="text-[9px] font-semibold text-muted-foreground">
                        15% / month
                      </span>
                    </div>
                    <p className="text-base font-black text-primary leading-none">
                      {formatUGX(earn.monthly)}
                      <span className="text-[9px] font-normal text-muted-foreground"> /month</span>
                    </p>
                    <div className="grid grid-cols-3 gap-1 pt-0.5">
                      {[
                        { label: 'Daily', value: earn.daily },
                        { label: 'Weekly', value: earn.weekly },
                        { label: '12 months', value: earn.annual },
                      ].map((m) => (
                        <div key={m.label} className="text-center">
                          <p className="text-[10px] font-black text-foreground leading-tight">
                            {formatUGX(m.value)}
                          </p>
                          <p className="text-[8px] text-muted-foreground font-medium">{m.label}</p>
                        </div>
                      ))}
                    </div>
                    <p className="text-[9px] text-muted-foreground">
                      Capital needed {formatUGX(earn.capital)} · from {format(earn.startDate, 'd MMM')} over {earn.daysInTerm} days
                    </p>
                    <FunderEarningsBreakdown earn={earn} />
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        toggleSelect(house.id);
                      }}
                      aria-pressed={selected}
                      className={`w-full h-9 rounded-xl text-[11px] font-bold inline-flex items-center justify-center gap-1.5 transition-colors touch-manipulation ${
                        selected
                          ? 'bg-primary text-primary-foreground'
                          : 'border border-primary/40 text-primary hover:bg-primary/10'
                      }`}
                    >
                      {selected ? (<><Check className="h-3.5 w-3.5" /> Selected</>) : 'Select to earn'}
                    </button>
                  </div>
                )}
              </div>
            </motion.div>
            );
          })}
        </div>
      )}

      {/* Pagination */}
      {filtered.length > CARDS_PER_PAGE && (
        <div className="flex items-center justify-center gap-1.5 pt-1">
          <button
            type="button"
            onClick={() => goToPage(safePage - 1)}
            disabled={safePage <= 1}
            aria-label="Previous page"
            className="inline-flex h-8 w-8 items-center justify-center rounded-lg border border-border bg-card text-foreground hover:bg-muted disabled:opacity-40 disabled:cursor-not-allowed touch-manipulation"
          >
            <ChevronLeft className="h-4 w-4" />
          </button>

          {Array.from({ length: totalPages }, (_, i) => i + 1)
            .filter((p) => {
              if (totalPages <= 5) return true;
              if (p === 1 || p === totalPages) return true;
              return Math.abs(p - safePage) <= 1;
            })
            .map((p, idx, arr) => {
              const showGap = idx > 0 && p - arr[idx - 1] > 1;
              return (
                <div key={`page-${p}`} className="flex items-center gap-1.5">
                  {showGap && <span className="text-[10px] text-muted-foreground px-1">…</span>}
                  <button
                    type="button"
                    onClick={() => goToPage(p)}
                    aria-label={`Page ${p}`}
                    aria-current={p === safePage ? 'page' : undefined}
                    className={`inline-flex h-8 min-w-8 items-center justify-center rounded-lg text-xs font-semibold touch-manipulation ${
                      p === safePage
                        ? 'bg-primary text-primary-foreground'
                        : 'border border-border bg-card text-foreground hover:bg-muted'
                    }`}
                  >
                    {p}
                  </button>
                </div>
              );
            })}

          <button
            type="button"
            onClick={() => goToPage(safePage + 1)}
            disabled={safePage >= totalPages}
            aria-label="Next page"
            className="inline-flex h-8 w-8 items-center justify-center rounded-lg border border-border bg-card text-foreground hover:bg-muted disabled:opacity-40 disabled:cursor-not-allowed touch-manipulation"
          >
            <ChevronRight className="h-4 w-4" />
          </button>
        </div>
      )}

      {hasMore && filtered.length > 0 && (
        <div className="flex justify-center pt-2">
          <button
            type="button"
            onClick={() => fetchHouses(false, true)}
            disabled={loadingMore}
            className="inline-flex items-center gap-1.5 rounded-full border border-border bg-card px-4 py-2 text-xs font-semibold text-foreground hover:bg-muted disabled:opacity-60 touch-manipulation"
          >
            {loadingMore ? (
              <>
                <RefreshCw className="h-3.5 w-3.5 animate-spin" />
                Loading…
              </>
            ) : (
              <>Load more houses</>
            )}
          </button>
        </div>
      )}

      {/* Persistent earnings summary for the current selection */}
      <AnimatePresence>
        {selectedHouses.length > 0 && (
          <motion.div
            initial={{ y: 80, opacity: 0 }}
            animate={{ y: 0, opacity: 1 }}
            exit={{ y: 80, opacity: 0 }}
            transition={{ type: 'spring', stiffness: 380, damping: 32 }}
            className="fixed inset-x-3 bottom-20 z-40 rounded-2xl border border-primary/30 bg-card/95 backdrop-blur shadow-2xl p-3.5 space-y-3 max-w-xl mx-auto"
          >
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="text-[9px] font-semibold uppercase tracking-widest text-muted-foreground">
                  {selectionLocked ? 'Locked · ' : ''}
                  {selectedHouses.length} {selectedHouses.length === 1 ? 'house' : 'houses'} selected
                </p>
                <p className="text-xl font-black text-primary leading-tight">
                  {formatUGX(selectionTotals.monthly)}
                  <span className="text-[10px] font-normal text-muted-foreground"> /month</span>
                </p>
              </div>
              <button
                type="button"
                onClick={() => {
                  hapticTap();
                  if (selectionLocked) {
                    setSelectionLocked(false);
                    return;
                  }
                  setSelectedIds([]);
                }}
                className="text-[10px] font-semibold text-muted-foreground hover:text-foreground shrink-0"
              >
                {selectionLocked ? 'Unlock' : 'Clear'}
              </button>
            </div>

            <div className="grid grid-cols-3 gap-2">
              {[
                { label: 'Daily', value: selectionTotals.daily },
                { label: 'Weekly', value: selectionTotals.weekly },
                { label: '12 months', value: selectionTotals.annual },
              ].map((m) => (
                <div key={m.label} className="rounded-xl bg-muted/40 py-1.5 text-center">
                  <p className="text-[11px] font-black text-foreground leading-tight">
                    {formatUGX(m.value)}
                  </p>
                  <p className="text-[8px] text-muted-foreground font-medium">{m.label}</p>
                </div>
              ))}
            </div>

            <p className="text-[9px] text-muted-foreground text-center">
              From move-in {format(selectionTotals.startDate, 'd MMM yyyy')} · {selectionTotals.daysInTerm} days to {format(selectionTotals.endDate, 'd MMM yyyy')}
            </p>

            <div className="flex items-center justify-between text-[10px] text-muted-foreground">
              <span>Capital to landlords</span>
              <span className="font-bold text-foreground">{formatUGX(selectionTotals.capital)}</span>
            </div>
            <div className="flex items-center justify-between text-[10px] text-muted-foreground">
              <span>Wallet balance</span>
              <span className="font-bold text-foreground">{formatUGX(walletBalance)}</span>
            </div>

            <Button
              onClick={() => {
                hapticTap();
                if (selectionLocked) {
                  setShowTopUp(true);
                } else {
                  setShowConfirm(true);
                }
              }}
              className="w-full h-11 rounded-xl text-xs font-bold gap-2 uppercase tracking-wide"
            >
              {selectionLocked ? <Wallet className="h-4 w-4" /> : <Lock className="h-4 w-4" />}
              {selectionLocked
                ? shortfall > 0
                  ? `Add ${formatUGX(shortfall)} to wallet`
                  : 'Reserve funds for these houses'
                : 'Review & lock selection'}
            </Button>
            <p className="text-[9px] text-muted-foreground/80 text-center leading-relaxed">
              You earn 15% of each house's monthly rent while the tenant repays.
            </p>
          </motion.div>
        )}
      </AnimatePresence>

      <FunderSelectionConfirmDialog
        open={showConfirm}
        onOpenChange={setShowConfirm}
        houses={selectedHouses.map((h) => ({
          id: h.id,
          title: h.title,
          region: h.region,
          district: h.district,
          monthly_rent: h.monthly_rent,
        }))}
        totals={selectionTotals}
        walletBalance={walletBalance}
        onConfirm={() => {
          hapticTap();
          setSelectionLocked(true);
          setShowConfirm(false);
          setShowTopUp(true);
          trackFunnelStep('funder_selection_locked', undefined, {
            house_count: selectedHouses.length,
            capital: selectionTotals.capital,
            monthly_earning: selectionTotals.monthly,
          });
          trackFunnelStep('funder_funding_started', undefined, {
            house_count: selectedHouses.length,
            capital: selectionTotals.capital,
          });
          toast.success('Selection locked', {
            description: `${formatUGX(selectionTotals.capital)} to reserve for ${selectedHouses.length} ${
              selectedHouses.length === 1 ? 'house' : 'houses'
            }.`,
          });
        }}
      />

      <FunderTopUpDialog
        open={showTopUp}
        onOpenChange={setShowTopUp}
        houseCount={selectedHouses.length}
        capitalRequired={selectionTotals.capital}
        monthlyEarning={selectionTotals.monthly}
        walletBalance={walletBalance}
      />

      {/* Repayment details — opened from "View repayment terms" on a house card */}
      <Dialog open={!!detailsHouse} onOpenChange={(o) => !o && setDetailsHouse(null)}>
        <DialogContent className="max-w-sm rounded-2xl">
          <DialogHeader>
            <DialogTitle className="text-base">{detailsHouse?.title}</DialogTitle>
            <DialogDescription className="text-xs">
              How the tenant repays for this house.
            </DialogDescription>
          </DialogHeader>
          {detailsHouse && (
            <div className="space-y-3">
              <div className="rounded-xl border border-border/60 bg-muted/30 p-3">
                <p className="text-[9px] font-semibold uppercase tracking-widest text-muted-foreground">
                  Tenant daily repayment
                </p>
                <p className="text-xl font-black text-success leading-tight">
                  {formatUGX(detailsHouse.daily_rate)}
                  <span className="text-[10px] font-normal text-muted-foreground"> /day</span>
                </p>
                <p className="text-[10px] text-muted-foreground mt-1">
                  Monthly rent {formatUGX(detailsHouse.monthly_rent)}
                </p>
              </div>
              <MoveInOfferBadge />
              <p className="text-[10px] leading-relaxed text-muted-foreground">
                The tenant repays daily. Your earnings accrue as those repayments come in.
              </p>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
