import { useCallback, useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { formatDynamic } from '@/lib/currencyFormat';
import { fetchAllPages } from '@/lib/fetchAllPages';
import { toast } from 'sonner';
import { ArrowUpDown, Bell, Bookmark, Calculator, Check, ChevronLeft, ChevronRight, GitCompareArrows, Home, Loader2, MapPin, Navigation as NavigationIcon, Plus, RefreshCw, ShieldCheck, TrendingUp, Wallet, X } from 'lucide-react';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Input } from '@/components/ui/input';

import { SelfPortfolioDeployDialog } from './SelfPortfolioDeployDialog';
import { SelfPortfolioPlanDetailSheet } from './SelfPortfolioPlanDetailSheet';
import { PlanShareButton } from './PlanShareButton';
import { SlotAmount } from './SlotAmount';
import {
  HighlightText,
  HouseSupportBar,
  HouseSupportCard,
  houseTitleLine,
  useVerifiedEmptyHouses,
  type SupportableHouse,
} from './SelfSupportHousesSection';
import { EmptyHouseDetailSheet } from '@/components/agent/EmptyHouseDetailSheet';
import DepositFlow from '@/components/payments/DepositFlow';

import { useEmptyHouseTotalRentNeeded } from '@/hooks/useEmptyHouseTotalRentNeeded';
import { HouseCompareDialog } from './HouseCompareDialog';
import { FundHouseTooltip } from './FundHouseTooltip';
import { HousePlacementTimeline } from './HousePlacementTimeline';
import { AFRICA_COUNTRIES, countryByCode, pointInCountry } from '@/lib/africaCountries';

const MIN_FUNDING = 50000;
const MONTHLY_ROI_RATE = 15;
const PLANS_PER_PAGE = 4;

type HouseSort =
  | 'return_desc'
  | 'rent_desc'
  | 'rent_asc'
  | 'rooms_desc'
  | 'nearest'
  | 'location_asc'
  | 'ready_first'
  | 'relevance'
  | 'newest';

const HOUSE_SORTS: { value: HouseSort; label: string }[] = [
  { value: 'rent_asc', label: 'Rent: low to high' },
  { value: 'rent_desc', label: 'Rent: high to low' },
  { value: 'nearest', label: 'Nearest first' },
  { value: 'location_asc', label: 'Location: A to Z' },
  { value: 'ready_first', label: 'Ready to fund first' },
  { value: 'relevance', label: 'Best match for my search' },
  { value: 'return_desc', label: 'Biggest monthly return' },
  { value: 'rooms_desc', label: 'Most rooms' },
  { value: 'newest', label: 'Newest listings first' },
];

/** Haversine distance between two lat/lng points in kilometres. */
function distanceKm(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLng = ((lng2 - lng1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLng / 2) *
      Math.sin(dLng / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

export type FeedOrder = 'rent' | 'houses';

/** One recorded "balance now covers your saved houses" alert. */
interface HouseBalanceAlert {
  ids: string[];
  at: number;
  // 'ready' (default) = balance became enough; 'dismissed' = highlight cleared
  // by the partner; 'funded' = partner opened the funding confirmation.
  kind?: 'ready' | 'dismissed' | 'funded';
}

const timeAgo = (at: number) => {
  const s = Math.max(1, Math.floor((Date.now() - at) / 1000));
  if (s < 60) return 'just now';
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} hr ago`;
  const d = Math.floor(h / 24);
  return `${d} day${d === 1 ? '' : 's'} ago`;
};



interface FundablePlan {
  rent_request_id: string;
  funding_amount: number;
  duration_days: number | null;
  daily_repayment: number | null;
  request_city: string | null;
  house_category: string | null;
  projected_end_date: string | null;
  repayment_cadence: string | null;
  tenant_first_name: string | null;
  tenant_full_name: string | null;
  tenant_location: string | null;
  tenant_avatar_url: string | null;
  tenant_has_photo?: boolean | null;
  landlord_name: string | null;
  landlord_phone: string | null;
  lc1_chairperson_name: string | null;
  house_image_urls: string[] | null;
  held_by: string | null;
  hold_expires_at: string | null;
  request_latitude?: number | string | null;
  request_longitude?: number | string | null;
  proxy_agent_phone: string | null;
}

/**
 * Self Portfolio Management — Phase Two
 * Partner funds approved rent plans straight from their operational float.
 * Privacy: tenant first name only, landlord name shown, no contact details ever leave the server.
 */
export function SelfPortfolioFundingCard({
  partnerId,
  feedOrder,
  onFeedOrderChange,
}: {
  partnerId: string;
  feedOrder: FeedOrder;
  onFeedOrderChange: (value: FeedOrder) => void;
}) {
  const [selected, setSelected] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [deployOpen, setDeployOpen] = useState(false);
  const [detailPlan, setDetailPlan] = useState<FundablePlan | null>(null);
  const [page, setPage] = useState(0);
  const [houseSelected, setHouseSelected] = useState<string[]>([]);
  const [detailHouse, setDetailHouse] = useState<SupportableHouse | null>(null);
  // Short code arriving from a branded /s/<code> share link (?share=<code>).
  const [sharedPlanId, setSharedPlanId] = useState<string | null>(null);
  const [houseSort, setHouseSort] = useState<HouseSort>('rent_asc');
  const [houseDistrict, setHouseDistrict] = useState<string>('all');
  // Neighborhood (sub-county) quick filter — set via chips, pairs with district.
  const [houseSubCounty, setHouseSubCounty] = useState<string>('all');
  const [houseSearch, setHouseSearch] = useState('');
  const [houseWithinFloat, setHouseWithinFloat] = useState(false);
  // Show only saved houses whose current balance is enough to fund them.
  const [showSavedReadyOnly, setShowSavedReadyOnly] = useState(false);
  // Rent range filter (UGX). Empty string = no bound.
  const [houseRentMin, setHouseRentMin] = useState('');
  const [houseRentMax, setHouseRentMax] = useState('');
  // Funding status filter: every house is fundable, but the funder's float may
  // not cover it yet — "ready" fits within float, "topup" needs a top-up first.
  type HouseFundingStatus = 'all' | 'ready' | 'topup';
  const [houseFundingStatus, setHouseFundingStatus] = useState<HouseFundingStatus>('all');
  // Country filter (Africa-wide): narrows both the map/heatmap viewport and the cards.
  const [houseCountry, setHouseCountry] = useState<string>('all');
  // Listing age ceiling in days ('all' = any age).
  const [houseListingAge, setHouseListingAge] = useState<string>('all');
  // Reference point for the "Nearest first" sort, taken from the last house selected on the map.
  const [referencePoint, setReferencePoint] = useState<{ lat: number; lng: number } | null>(null);
  // The funder's own device location, used for the distance / travel-time labels
  // on each house card when no map house has been tapped yet.
  const [userPoint, setUserPoint] = useState<{ lat: number; lng: number } | null>(null);
  // Radius filter (km) around the funder's own location, falling back to the
  // last house tapped on the map when device location is unavailable.
  const [houseRadiusKm, setHouseRadiusKm] = useState<string>('all');

  useEffect(() => {
    if (!('geolocation' in navigator)) return;
    let cancelled = false;
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        if (cancelled) return;
        setUserPoint({ lat: pos.coords.latitude, lng: pos.coords.longitude });
      },
      () => {
        /* location off or refused — cards simply omit the distance labels */
      },
      { enableHighAccuracy: false, timeout: 8000, maximumAge: 5 * 60 * 1000 },
    );
    return () => {
      cancelled = true;
    };
  }, []);
  // Side-by-side comparison picks (in-session only; never touches funding).
  const [compareIds, setCompareIds] = useState<string[]>([]);
  const [compareOpen, setCompareOpen] = useState(false);
  // Top-up launched from a picked house card: deposit opens with the exact shortfall.
  const [topUpAmount, setTopUpAmount] = useState<number | null>(null);
  const [flashHouseId, setFlashHouseId] = useState<string | null>(null);
  // A changing key asks HouseSupportBar to open its confirm dialog (used by
  // the balance-ready notification's "Fund this house" action).
  const [fundConfirmKey, setFundConfirmKey] = useState<string | null>(null);
  // Bumped after a house funding is submitted so the placement timeline
  // immediately picks up the newly funded house.
  const [placementRefresh, setPlacementRefresh] = useState(0);
  // Houses that just became fundable stay highlighted until the partner
  // dismisses the highlight or funds them. Persisted so it survives reloads.
  const fundableKey = `psm-house-fundable-${partnerId}`;
  const [fundableIds, setFundableIds] = useState<string[]>(() => {
    try {
      const parsed = JSON.parse(window.localStorage.getItem(fundableKey) ?? '[]');
      return Array.isArray(parsed) ? parsed.filter((x) => typeof x === 'string') : [];
    } catch {
      return [];
    }
  });
  const persistFundable = useCallback(
    (next: string[]) => {
      setFundableIds(next);
      try {
        if (next.length) window.localStorage.setItem(fundableKey, JSON.stringify(next));
        else window.localStorage.removeItem(fundableKey);
      } catch {
        /* storage unavailable — highlight just won't persist */
      }
    },
    [fundableKey],
  );
  const alertsKey = `psm-house-alerts-${partnerId}`;
  const [houseAlerts, setHouseAlerts] = useState<HouseBalanceAlert[]>(() => {
    try {
      const raw = window.localStorage.getItem(alertsKey);
      if (!raw) return [];
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed)
        ? parsed.filter(
            (a): a is HouseBalanceAlert =>
              !!a && Array.isArray(a.ids) && typeof a.at === 'number',
          )
        : [];
    } catch {
      return [];
    }
  });
  const [alertsOpen, setAlertsOpen] = useState(false);
  const persistAlerts = useCallback(
    (next: HouseBalanceAlert[]) => {
      setHouseAlerts(next);
      try {
        window.localStorage.setItem(alertsKey, JSON.stringify(next));
      } catch {
        /* storage unavailable — history just won't persist */
      }
    },
    [alertsKey],
  );
  // Record what the partner did with a highlighted saved house so the action
  // can be reviewed later in the same alert history.
  const recordAlertAction = useCallback(
    (houseId: string, kind: 'dismissed' | 'funded') => {
      setHouseAlerts((prev) => {
        const next = [{ ids: [houseId], at: Date.now(), kind }, ...prev].slice(0, 20);
        try {
          window.localStorage.setItem(alertsKey, JSON.stringify(next));
        } catch {
          /* storage unavailable — history just won't persist */
        }
        return next;
      });
    },
    [alertsKey],
  );


  // Picked houses survive reloads until the partner funds or removes them.
  const selectionKey = `psm-house-selection-${partnerId}`;
  const [selectionRestored, setSelectionRestored] = useState(false);
  useEffect(() => {
    try {
      const saved = JSON.parse(window.localStorage.getItem(selectionKey) ?? '[]');
      if (Array.isArray(saved)) setHouseSelected(saved.filter((x) => typeof x === 'string'));
    } catch {
      /* ignore corrupt cache */
    }
    setSelectionRestored(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectionKey]);
  useEffect(() => {
    try {
      window.localStorage.setItem(selectionKey, JSON.stringify(houseSelected));
    } catch {
      /* storage full or unavailable — selection still works in-session */
    }
  }, [selectionKey, houseSelected]);


  // Cached so returning to this tab paints instantly; refreshes happen silently.
  const plansQuery = useQuery({
    queryKey: ['psm-fundable-plans'],
    queryFn: async () => {
      const { items, total, meta } = await fetchAllPages<FundablePlan, { available: number }>({
        pageSize: 100,
        concurrency: 8,
        fetchPage: async (offset, limit) => {
          const { data, error } = await supabase.rpc('partner_self_list_fundable_plans', {
            p_limit: limit,
            p_offset: offset,
          });
          if (error) throw error;
          const payload = (data ?? {}) as {
            plans?: FundablePlan[];
            total?: number;
            available_balance?: number;
          };
          const batch = payload.plans ?? [];
          return {
            items: batch,
            total: Number(payload.total ?? batch.length),
            meta: { available: Number(payload.available_balance ?? 0) },
          };
        },
      });

      return {
        plans: items,
        total,
        available: meta?.available ?? 0,
      };

    },
    staleTime: 5 * 60 * 1000,
    gcTime: 30 * 60 * 1000,
    refetchOnWindowFocus: false,
  });

  const fundedQuery = useQuery({
    queryKey: ['psm-self-portfolio', partnerId],
    enabled: !!partnerId,
    queryFn: async () => {
      const { data } = await supabase.rpc('partner_self_portfolio', { p_partner_id: partnerId });
      const payload = (data ?? {}) as {
        lines?: { rent_request_id: string; status?: string; principal?: number }[];
        commitments?: {
          id?: string;
          status?: string;
          next_payout_at?: string | null;
          monthly_rate?: number;
          created_at?: string;
          committed_amount?: number;
          kind?: 'rent' | 'houses' | 'unknown';
          portfolio_code?: string | null;
        }[];
        totals?: { total_earned?: number; total_paid?: number; active?: number };
      };

      // Newest active portfolio per kind. Rent-plan capital may only top up a
      // rent portfolio, house capital only a house portfolio — the flows differ.
      const activeCommitments = (payload.commitments ?? [])
        .filter((c) => c.status === 'active')
        .sort((a, b) => String(b.created_at ?? '').localeCompare(String(a.created_at ?? '')));

      const rentCommitment = activeCommitments.find((c) => c.kind === 'rent') ?? null;
      const houseCommitment = activeCommitments.find((c) => c.kind === 'houses') ?? null;

      return {
        fundedIds: (payload.lines ?? []).map((l) => l.rent_request_id),
        activeCommitmentId: rentCommitment?.id ?? null,
        houseCommitment: houseCommitment
          ? {
              id: String(houseCommitment.id),
              committed_amount: Number(houseCommitment.committed_amount ?? 0),
              portfolio_code: houseCommitment.portfolio_code ?? null,
            }
          : null,
      };
    },
    staleTime: 5 * 60 * 1000,
    gcTime: 30 * 60 * 1000,
    refetchOnWindowFocus: false,
  });

  const housesQuery = useVerifiedEmptyHouses();
  const rentNeededQuery = useEmptyHouseTotalRentNeeded();

  const plans = plansQuery.data?.plans ?? [];

  // The map reads houses straight from the database per viewport, so it can show
  // houses this page has not loaded. Anything it surfaces is registered here so
  // selection totals, saved-for-later and funding stay accurate.
  const [discoveredHouses, setDiscoveredHouses] = useState<Record<string, SupportableHouse>>({});
  const registerDiscoveredHouses = useCallback((found: SupportableHouse[]) => {
    setDiscoveredHouses((prev) => {
      let changed = false;
      const next = { ...prev };
      for (const house of found) {
        if (!next[house.house_id]) {
          next[house.house_id] = house;
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, []);

  const houses = useMemo(() => {
    const fetched = housesQuery.data?.houses ?? [];
    const seen = new Set(fetched.map((h) => h.house_id));
    const extra = Object.values(discoveredHouses).filter((h) => !seen.has(h.house_id));
    return extra.length ? [...fetched, ...extra] : fetched;
  }, [housesQuery.data, discoveredHouses]);

  // Drop picked houses that are no longer listed (already funded by someone else).
  useEffect(() => {
    if (!housesQuery.data) return;
    const ids = new Set(houses.map((h) => h.house_id));
    setHouseSelected((prev) => {
      const next = prev.filter((id) => ids.has(id));
      return next.length === prev.length ? prev : next;
    });
    setCompareIds((prev) => {
      const next = prev.filter((id) => ids.has(id));
      return next.length === prev.length ? prev : next;
    });
  }, [housesQuery.data, houses]);
  const available = plansQuery.data?.available ?? 0;
  const marketRentNeeded = rentNeededQuery.data?.totalRentNeeded ?? 0;
  const fundedIds = fundedQuery.data?.fundedIds ?? [];
  const activeCommitmentId = fundedQuery.data?.activeCommitmentId ?? null;
  const activeHouseCommitment = fundedQuery.data?.houseCommitment ?? null;

  
  // Only the very first load blocks the card; refetches keep the cards on screen.
  const loading = (plansQuery.isLoading && !plansQuery.data) || (housesQuery.isLoading && !housesQuery.data);


  const load = useCallback(async () => {
    await Promise.all([plansQuery.refetch(), housesQuery.refetch()]);
    setPage(0);
  }, [plansQuery, housesQuery]);

  const loadFunded = useCallback(async () => {
    await fundedQuery.refetch();
  }, [fundedQuery]);


  // Resolve ?share=<code> to the plan it points at, then clean the URL.
  useEffect(() => {
    const code = new URLSearchParams(window.location.search).get('share');
    if (!code || !/^[A-Za-z0-9]{4,12}$/.test(code)) return;
    let cancelled = false;
    (async () => {
      const { data } = await supabase.rpc('resolve_short_link', { p_code: code }).maybeSingle();
      const planId = ((data as any)?.target_params ?? {})?.plan;
      if (!cancelled && planId) setSharedPlanId(String(planId));
      const url = new URL(window.location.href);
      url.searchParams.delete('share');
      window.history.replaceState({}, '', `${url.pathname}${url.search}${url.hash}`);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Bring the shared plan into view on its page and open its details sheet.
  useEffect(() => {
    if (!sharedPlanId || plans.length === 0) return;
    const index = plans.findIndex((p) => p.rent_request_id === sharedPlanId);
    if (index < 0) return;
    // Plans sit after the houses in the merged feed.
    setPage(Math.floor((houses.length + index) / PLANS_PER_PAGE));

    setDetailPlan(plans[index]);
    setSharedPlanId(null);
    window.setTimeout(() => {
      document
        .querySelector(`[data-plan-id="${sharedPlanId}"]`)
        ?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }, 250);
  }, [sharedPlanId, plans, houses]);

  const total = useMemo(
    () =>
      plans
        .filter((p) => selected.includes(p.rent_request_id))
        .reduce((sum, p) => sum + Number(p.funding_amount || 0), 0),
    [plans, selected],
  );

  const houseTotal = useMemo(
    () =>
      houses
        .filter((h) => houseSelected.includes(h.house_id))
        .reduce((sum, h) => sum + Number(h.monthly_rent || 0), 0),
    [houses, houseSelected],
  );

  // Both lists draw from the same operational float.
  const remaining = Math.max(0, available - total - houseTotal);
  const overBudget = total + houseTotal > available;

  // "Saved for later": picked houses the current float cannot cover yet. They
  // stay visible with the exact top-up each one still needs.
  const savedForLater = useMemo(
    () =>
      houses.filter(
        (h) => houseSelected.includes(h.house_id) && Number(h.monthly_rent || 0) > remaining,
      ),
    [houses, houseSelected, remaining],
  );

  // Picked houses whose highlight is still on: they became fundable and have
  // not been dismissed or funded yet.
  const fundableNow = useMemo(
    () =>
      houses.filter(
        (h) => fundableIds.includes(h.house_id) && houseSelected.includes(h.house_id),
      ),
    [houses, fundableIds, houseSelected],
  );

  // Selected house objects passed to the confirmation dialog so it can show
  // the title, rent amount, and location for each house being funded.
  const selectedHouseObjects = useMemo(
    () => houses.filter((h) => houseSelected.includes(h.house_id)),
    [houses, houseSelected],
  );

  // Compare picks that are still listed (drop houses funded by someone else).
  const compareHouses = useMemo(
    () => compareIds.map((id) => houses.find((h) => h.house_id === id)).filter((h): h is SupportableHouse => !!h),
    [compareIds, houses],
  );

  const toggleCompare = useCallback(
    (id: string) => {
      setCompareIds((prev) => {
        if (prev.includes(id)) return prev.filter((x) => x !== id);
        if (prev.length >= 3) {
          toast.info('You can compare up to 3 houses at a time. Remove one first.');
          return prev;
        }
        return [...prev, id];
      });
    },
    [],
  );

  // Funding (or unpicking) a highlighted house clears its highlight. Wait for
  // the persisted selection to be restored first, or a fresh page load would
  // wipe the highlight before the picks are read back.
  useEffect(() => {
    if (!selectionRestored) return;
    const next = fundableIds.filter((id) => houseSelected.includes(id));
    if (next.length !== fundableIds.length) persistFundable(next);
  }, [houseSelected, fundableIds, persistFundable, selectionRestored]);

  // Jump to a picked house: switch to the houses feed, clear any filters that
  // could hide it, open its page, scroll it into view and flash it.
  const jumpToHouse = useCallback(
    (target: string) => {
      if (!target) return;
      setHouseDistrict('all');
      setHouseWithinFloat(false);
      setHouseSort('return_desc');
      setFlashHouseId(target);
      // Index against the default (return high→low) order we just reset to, so
      // the page math matches the next render's feed.
      const sorted = [...houses].sort(
        (a, b) =>
          Number(b.partner_monthly_return ?? b.monthly_rent * (MONTHLY_ROI_RATE / 100)) -
          Number(a.partner_monthly_return ?? a.monthly_rent * (MONTHLY_ROI_RATE / 100)),
      );
      const index = sorted.findIndex((h) => h.house_id === target);
      if (index >= 0) setPage(Math.floor(index / PLANS_PER_PAGE));
      window.setTimeout(() => {
        document
          .querySelector(`[data-house-id="${target}"]`)
          ?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }, 450);
      window.setTimeout(() => setFlashHouseId(null), 6000);
    },
    [houses, onFeedOrderChange],
  );

  // Notify once when the balance grows enough to fund the saved picks. A
  // persisted flag remembers "some picks were short" across reloads, so a
  // funder who tops up and comes back later still gets the good news — and a
  // funder who only ever picks affordable houses is never disturbed. Every
  // alert is also recorded in a local history so it can be reviewed after the
  // toast is dismissed.
  const shortFlagKey = `psm-house-short-${partnerId}`;
  useEffect(() => {
    if (!plansQuery.data || !housesQuery.data) return;
    if (savedForLater.length > 0) {
      try {
        window.localStorage.setItem(shortFlagKey, '1');
      } catch {
        /* storage unavailable — notification simply won't persist */
      }
      return;
    }
    if (houseSelected.length === 0) return;
    let wasShort: string | null = null;
    try {
      wasShort = window.localStorage.getItem(shortFlagKey);
    } catch {
      /* ignore */
    }
    if (wasShort !== '1') return;
    try {
      window.localStorage.removeItem(shortFlagKey);
    } catch {
      /* ignore */
    }
    // Record the alert in history first so it survives dismissing the toast.
    setHouseAlerts((prev) => {
      const next = [{ ids: [...houseSelected], at: Date.now() }, ...prev].slice(0, 20);
      try {
        window.localStorage.setItem(alertsKey, JSON.stringify(next));
      } catch {
        /* storage unavailable — history just won't persist */
      }
      return next;
    });
    // Pin the highlight on the newly fundable houses until dismissed or funded.
    persistFundable([...houseSelected]);
    // Email the funder the same news: which saved houses are now fundable and
    // what they are estimated to earn each month. Fire-and-forget — the email
    // must never block or break the in-app alert.
    void (async () => {
      try {
        const {
          data: { user },
        } = await supabase.auth.getUser();
        if (!user?.email) return;
        const ready = houses.filter((h) => houseSelected.includes(h.house_id));
        if (ready.length === 0) return;
        const lines = ready.map((h) => {
          const rent = Number(h.monthly_rent || 0);
          return {
            title: houseTitleLine(h),
            district: h.district || '',
            monthly_rent: rent,
            monthly_earning: Math.round((rent * MONTHLY_ROI_RATE) / 100),
          };
        });
        const firstReturn = new Date();
        firstReturn.setMonth(firstReturn.getMonth() + 1);
        firstReturn.setDate(Math.min(firstReturn.getDate(), 28));
        await supabase.functions.invoke('send-transactional-email', {
          body: {
            templateName: 'funder-saved-house-fundable',
            recipientEmail: user.email,
            idempotencyKey: `saved-fundable-${partnerId}-${Date.now()}`,
            templateData: {
              partner_name:
                (user.user_metadata as { full_name?: string } | undefined)?.full_name || 'Partner',
              houses: lines,
              total_needed: lines.reduce((sum, l) => sum + l.monthly_rent, 0),
              total_monthly_earning: lines.reduce((sum, l) => sum + l.monthly_earning, 0),
              return_rate: MONTHLY_ROI_RATE,
              first_return_date: firstReturn.toLocaleDateString('en-GB', {
                day: 'numeric',
                month: 'short',
                year: 'numeric',
              }),
            },
          },
        });
      } catch (e) {
        console.warn('[SelfPortfolioFundingCard] saved-fundable email failed', e);
      }
    })();
    toast.success(
      houseSelected.length === 1
        ? 'Your balance now covers your saved house.'
        : `Your balance now covers your ${houseSelected.length} saved houses.`,
      {
        description: 'Tap the button below to review and confirm the funding right away.',
        duration: 12000,
        action: {
          label: houseSelected.length === 1 ? 'Fund this house' : 'Fund these houses',
          onClick: () => {
            jumpToHouse(houseSelected[0]);
            // Unique key so every notification re-opens the confirm dialog.
            setFundConfirmKey(`${Date.now()}`);
          },
        },
      },
    );
  }, [
    savedForLater.length,
    houseSelected.length,
    plansQuery.data,
    housesQuery.data,
    shortFlagKey,
    alertsKey,
    jumpToHouse,
    persistFundable,
    houses,
    partnerId,
  ]);

  // The dashboard switch intentionally separates ready-tenant Rent Plans from
  // vacant houses so supporters always know which funding path they are using.
  type FeedItem =
    | { kind: 'plan'; id: string; plan: FundablePlan }
    | { kind: 'house'; id: string; house: SupportableHouse };

  const normalizedSearch = useMemo(() => houseSearch.trim().toLocaleLowerCase(), [houseSearch]);
  const rentMinBound = useMemo(() => Number(houseRentMin), [houseRentMin]);
  const rentMaxBound = useMemo(() => Number(houseRentMax), [houseRentMax]);
  const selectedCountry = useMemo(
    () => (houseCountry === 'all' ? null : countryByCode(houseCountry)),
    [houseCountry],
  );

  // The country picker only offers countries that actually have listings —
  // derived from each house's GPS point so the list always matches the map.
  const listedCountries = useMemo(() => {
    const counts = new Map<string, number>();
    houses.forEach((h) => {
      const lat = Number(h.latitude);
      const lng = Number(h.longitude);
      if (!Number.isFinite(lat) || !Number.isFinite(lng) || (lat === 0 && lng === 0)) return;
      const match = AFRICA_COUNTRIES.find((c) => pointInCountry(c, lat, lng));
      if (match) counts.set(match.code, (counts.get(match.code) ?? 0) + 1);
    });
    return AFRICA_COUNTRIES
      .filter((c) => counts.has(c.code))
      .map((c) => ({ ...c, listings: counts.get(c.code) ?? 0 }));
  }, [houses]);
  const listingAgeDays = useMemo(
    () => (houseListingAge === 'all' ? null : Number(houseListingAge)),
    [houseListingAge],
  );
  const listedAfter = useMemo(
    () => (listingAgeDays ? Date.now() - listingAgeDays * 24 * 60 * 60 * 1000 : null),
    [listingAgeDays],
  );

  // Shared filter predicate used by location-chip counts and the main feed.
  const matchesBaseFilters = useCallback(
    (h: SupportableHouse) => {
      if (normalizedSearch) {
        const matchesSearch = [
          houseTitleLine(h),
          h.title,
          h.house_category,
          h.district,
          h.sub_county,
          h.village,
          h.region,
        ].some((value) => value?.toLocaleLowerCase().includes(normalizedSearch));
        if (!matchesSearch) return false;
      }
      const rent = Number(h.monthly_rent || 0);
      if (houseRentMin.trim() !== '' && Number.isFinite(rentMinBound) && rent < rentMinBound) return false;
      if (houseRentMax.trim() !== '' && Number.isFinite(rentMaxBound) && rent > rentMaxBound) return false;
      if (houseFundingStatus === 'ready' && rent > remaining) return false;
      if (houseFundingStatus === 'topup' && rent <= remaining) return false;
      if (houseWithinFloat && rent > remaining) return false;
      if (showSavedReadyOnly && (!houseSelected.includes(h.house_id) || rent > remaining)) return false;
      if (selectedCountry && !pointInCountry(selectedCountry, h.latitude, h.longitude)) return false;
      if (listedAfter !== null) {
        const listedAt = h.created_at ? new Date(h.created_at).getTime() : NaN;
        if (!Number.isFinite(listedAt) || listedAt < listedAfter) return false;
      }
      return true;
    },
    [
      normalizedSearch,
      selectedCountry,
      listedAfter,
      houseRentMin,
      houseRentMax,
      houseFundingStatus,
      houseWithinFloat,
      showSavedReadyOnly,
      houseSelected,
      remaining,
      rentMinBound,
      rentMaxBound,
    ],
  );

  // District filter options with counts — scoped to current sub-county and all other active filters.
  const houseDistricts = useMemo(() => {
    const map = new Map<string, { label: string; count: number }>();
    for (const h of houses) {
      if (!matchesBaseFilters(h)) continue;
      if (houseSubCounty !== 'all' && (h.sub_county ?? '').trim().toLowerCase() !== houseSubCounty) continue;
      const raw = (h.district ?? '').trim();
      if (!raw) continue;
      const key = raw.toLowerCase();
      const existing = map.get(key);
      if (existing) {
        existing.count += 1;
      } else {
        map.set(key, { label: raw, count: 1 });
      }
    }
    return [...map.entries()].sort((a, b) => a[1].label.localeCompare(b[1].label));
  }, [houses, matchesBaseFilters, houseSubCounty]);

  // Neighborhood filter options with counts — scoped to the selected district and all other active filters.
  const houseSubCounties = useMemo(() => {
    const map = new Map<string, { label: string; count: number }>();
    for (const h of houses) {
      if (!matchesBaseFilters(h)) continue;
      if (houseDistrict !== 'all' && (h.district ?? '').trim().toLowerCase() !== houseDistrict) continue;
      const raw = (h.sub_county ?? '').trim();
      if (!raw) continue;
      const key = raw.toLowerCase();
      const existing = map.get(key);
      if (existing) {
        existing.count += 1;
      } else {
        map.set(key, { label: raw, count: 1 });
      }
    }
    return [...map.entries()].sort((a, b) => a[1].label.localeCompare(b[1].label));
  }, [houses, matchesBaseFilters, houseDistrict]);

  // Changing district can invalidate a neighborhood chip choice.
  useEffect(() => {
    if (houseSubCounty !== 'all' && !houseSubCounties.some(([key]) => key === houseSubCounty)) {
      setHouseSubCounty('all');
    }
  }, [houseDistrict, houseSubCounties, houseSubCounty]);

  const feed = useMemo<FeedItem[]>(() => {
    const planItems: FeedItem[] = plans.map((plan) => ({
      kind: 'plan',
      id: plan.rent_request_id,
      plan,
    }));
    let visibleHouses = houses.filter((h) => matchesBaseFilters(h));
    if (houseDistrict !== 'all') {
      visibleHouses = visibleHouses.filter(
        (h) => (h.district ?? '').trim().toLowerCase() === houseDistrict,
      );
    }
    if (houseSubCounty !== 'all') {
      visibleHouses = visibleHouses.filter(
        (h) => (h.sub_county ?? '').trim().toLowerCase() === houseSubCounty,
      );
    }
    if (houseRadiusKm !== 'all') {
      const maxKm = Number(houseRadiusKm);
      const origin = userPoint ?? referencePoint;
      if (origin && Number.isFinite(maxKm)) {
        visibleHouses = visibleHouses.filter((h) => {
          const lat = Number(h.latitude);
          const lng = Number(h.longitude);
          if (!Number.isFinite(lat) || !Number.isFinite(lng)) return false;
          return distanceKm(origin.lat, origin.lng, lat, lng) <= maxKm;
        });
      }
    }
    visibleHouses = [...visibleHouses].sort((a, b) => {
      const rentA = Number(a.monthly_rent || 0);
      const rentB = Number(b.monthly_rent || 0);
      const distanceTo = (h: SupportableHouse) => {
        const lat = Number(h.latitude);
        const lng = Number(h.longitude);
        if (referencePoint && Number.isFinite(lat) && Number.isFinite(lng)) {
          return distanceKm(referencePoint.lat, referencePoint.lng, lat, lng);
        }
        return h.distance_km ?? Infinity;
      };
      const distA = distanceTo(a);
      const distB = distanceTo(b);
      const locationLabel = (h: SupportableHouse) =>
        [h.district, h.sub_county, h.village]
          .map((v) => (v ?? '').trim())
          .filter(Boolean)
          .join(', ')
          .toLocaleLowerCase();
      // Ready to fund now (rent covered by available balance) sorts ahead of top-up needed.
      const readyRank = (rent: number) => (rent <= remaining ? 0 : 1);
      // Relevance: earlier and more field matches for the search term rank higher.
      const relevanceScore = (h: SupportableHouse) => {
        if (!normalizedSearch) return 0;
        const fields = [houseTitleLine(h), h.title, h.district, h.sub_county, h.village, h.house_category];
        let score = 0;
        for (const field of fields) {
          const value = (field ?? '').toLocaleLowerCase();
          if (!value) continue;
          const at = value.indexOf(normalizedSearch);
          if (at === 0) score += 3;
          else if (at > 0) score += 1;
        }
        return score;
      };
      switch (houseSort) {
        case 'nearest':
          if (distA !== distB) return distA - distB;
          return rentA - rentB;
        case 'rent_asc':
          if (rentA !== rentB) return rentA - rentB;
          return distA - distB;
        case 'rent_desc':
          return rentB - rentA;
        case 'rooms_desc':
          return Number(b.number_of_rooms || 0) - Number(a.number_of_rooms || 0);
        case 'location_asc': {
          const cmp = locationLabel(a).localeCompare(locationLabel(b));
          if (cmp !== 0) return cmp;
          return rentA - rentB;
        }
        case 'ready_first': {
          const cmp = readyRank(rentA) - readyRank(rentB);
          if (cmp !== 0) return cmp;
          return rentA - rentB;
        }
        case 'relevance': {
          const cmp = relevanceScore(b) - relevanceScore(a);
          if (cmp !== 0) return cmp;
          return rentA - rentB;
        }
        case 'newest': {
          const cmp = String(b.created_at ?? '').localeCompare(String(a.created_at ?? ''));
          if (cmp !== 0) return cmp;
          return rentA - rentB;
        }
        case 'return_desc':
        default:
          return (
            Number(b.partner_monthly_return ?? b.monthly_rent * (MONTHLY_ROI_RATE / 100)) -
            Number(a.partner_monthly_return ?? a.monthly_rent * (MONTHLY_ROI_RATE / 100))
          );
      }
    });
    const houseItems: FeedItem[] = visibleHouses.map((house) => ({
      kind: 'house',
      id: house.house_id,
      house,
    }));
    // One merged list: empty houses first, then rent plans with ready tenants.
    return [...houseItems, ...planItems];
  }, [
    plans,
    houses,
    houseSort,
    referencePoint,
    userPoint,
    houseRadiusKm,
    houseDistrict,
    houseSubCounty,
    matchesBaseFilters,
    normalizedSearch,
    remaining,
  ]);

  const resetFilters = useCallback(() => {
    setHouseSort('rent_asc');
    setHouseDistrict('all');
    setHouseSubCounty('all');
    setHouseSearch('');
    setHouseRentMin('');
    setHouseRentMax('');
    setHouseFundingStatus('all');
    setHouseWithinFloat(false);
    setShowSavedReadyOnly(false);
    setHouseCountry('all');
    setHouseListingAge('all');
    setHouseRadiusKm('all');
    setReferencePoint(null);
  }, []);

  useEffect(() => {
    setPage(0);
  }, [houseSort, houseDistrict, houseSubCounty, houseSearch, houseRentMin, houseRentMax, houseFundingStatus, houseWithinFloat, showSavedReadyOnly, houseCountry, houseListingAge, houseRadiusKm, feedOrder]);

  const pageCount = Math.max(1, Math.ceil(feed.length / PLANS_PER_PAGE));
  const pageStart = page * PLANS_PER_PAGE;
  const pageItems = feed.slice(pageStart, pageStart + PLANS_PER_PAGE);
  const visibleMapHouses = pageItems.flatMap((item) => (item.kind === 'house' ? [item.house] : []));
  const searchableMapHouses = feed.flatMap((item) => (item.kind === 'house' ? [item.house] : []));

  useEffect(() => {
    setPage((current) => Math.min(current, pageCount - 1));
  }, [pageCount]);

  const toggle = (id: string) => {
    if (selected.includes(id)) {
      setSelected((prev) => prev.filter((x) => x !== id));
      return;
    }
    if (houseSelected.length > 0) {
      toast.error('You can fund either rent plans or houses in one submission — not both. Clear your selected houses first.');
      return;
    }
    const plan = plans.find((p) => p.rent_request_id === id);
    const cost = Number(plan?.funding_amount || 0);
    if (cost > remaining) {
      toast.error(
        `Not enough operational float. This plan needs ${formatDynamic(cost)} and you have ${formatDynamic(remaining)} left to fund.`,
      );
      return;
    }
    setSelected((prev) => [...prev, id]);
  };

  const toggleHouse = (id: string) => {
    if (houseSelected.includes(id)) {
      setHouseSelected((prev) => prev.filter((x) => x !== id));
      return;
    }
    if (selected.length > 0) {
      toast.error('You can fund either rent plans or houses in one submission — not both. Clear your selected rent plans first.');
      return;
    }
    const house = houses.find((h) => h.house_id === id);
    const cost = Number(house?.monthly_rent || 0);
    setHouseSelected((prev) => [...prev, id]);
    if (cost > remaining) {
      // Keep the house picked — it stays selected until the partner tops up
      // their float or removes it themselves.
      toast.info(`House saved for you. Add ${formatDynamic(cost - remaining)} to your balance to fund it.`, {
        description: 'It stays picked while you top up your wallet.',
        duration: 7000,
      });
    }
  };



  const openDeploy = () => {
    if (total < MIN_FUNDING) {
      toast.error(`Minimum funding is ${formatDynamic(MIN_FUNDING)}.`);
      return;
    }
    if (total > available) {
      toast.error('Your operational float is not enough for this selection.');
      return;
    }
    setDeployOpen(true);
  };

  const handleDeployed = async () => {
    setSelected([]);
    await Promise.all([load(), loadFunded()]);
  };

  if (loading) {
    return (
      <div className="space-y-3">
        <Skeleton className="h-24 w-full rounded-2xl" />
        <Skeleton className="h-24 w-full rounded-2xl" />
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {feedOrder === 'houses' && houses.length > 0 && (
        <div className="flex items-center justify-between px-1">
          <div>
            <p className="text-[15px] font-bold text-foreground">
              houses <span className="text-xs font-normal text-muted-foreground">ⓘ</span>
            </p>
            <p className="text-[11px] text-muted-foreground">
              {feed.length.toLocaleString()} available · {formatDynamic(available)} to fund
            </p>
          </div>
        </div>
      )}


      <Card className="p-3 sm:p-4 rounded-xl sm:rounded-2xl">
        <div className="flex items-center justify-between gap-3">
          <div>
            <p className="text-[11px] font-semibold text-muted-foreground">Available to fund</p>
            <p className="text-base sm:text-lg font-black text-foreground">{formatDynamic(available)}</p>
            <p className="text-[10px] text-muted-foreground mt-0.5">
              Minimum {formatDynamic(MIN_FUNDING)} per plan
            </p>
            <p className="hidden sm:block text-[10px] font-semibold text-muted-foreground mt-0.5">
              You can only select plans up to your operational float —{' '}
              {formatDynamic(remaining)} left to fund
            </p>
            <p className="text-[10px] font-semibold text-primary mt-1">
              {formatDynamic(marketRentNeeded)} rent needed by  houses
            </p>
          </div>
          <Button variant="ghost" size="sm" onClick={() => void load()} disabled={busy}>
            <RefreshCw className="h-4 w-4" />
          </Button>
        </div>
      </Card>
      {feedOrder !== 'houses' && (
        <p className="text-[11px] font-semibold text-muted-foreground px-1">
          {plans.length} rent request{plans.length === 1 ? '' : 's'} · {houses.length} house
          {houses.length === 1 ? '' : 's'}
        </p>
      )}

      {feedOrder === 'houses' && houses.length > 0 && (
        <div className="flex items-center gap-2 overflow-x-auto pb-1 px-1 [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden" aria-label="Filter houses">
          {/* Sort chip */}
          <Select value={houseSort} onValueChange={(v) => setHouseSort(v as HouseSort)}>
            <SelectTrigger className="h-8 w-auto min-w-0 flex-none rounded-full border-border bg-background px-3 text-[11px] font-semibold shadow-none" aria-label="Sort">
              <ArrowUpDown className="h-3 w-3 mr-1 flex-none" aria-hidden />
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {HOUSE_SORTS.map((s) => (
                <SelectItem key={s.value} value={s.value}>
                  {s.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {/* District chip */}
          <Select value={houseDistrict} onValueChange={setHouseDistrict}>
            <SelectTrigger className="h-8 w-auto min-w-0 flex-none rounded-full border-border bg-background px-3 text-[11px] font-semibold shadow-none" aria-label="District">
              <MapPin className="h-3 w-3 mr-1 flex-none" aria-hidden />
              <SelectValue placeholder="All districts" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">
                All districts ({houseDistricts.reduce((sum, [, { count }]) => sum + count, 0)})
              </SelectItem>
              {houseDistricts.map(([key, { label, count }]) => (
                <SelectItem key={key} value={key}>
                  {label} ({count})
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {/* Country chip */}
          <Select value={houseCountry} onValueChange={setHouseCountry}>
            <SelectTrigger className="h-8 w-auto min-w-0 flex-none rounded-full border-border bg-background px-3 text-[11px] font-semibold shadow-none" aria-label="Country">
              <SelectValue placeholder="All countries" />
            </SelectTrigger>
            <SelectContent className="max-h-72">
              <SelectItem value="all">All of Africa</SelectItem>
              {listedCountries.map((c) => (
                <SelectItem key={c.code} value={c.code}>
                  {c.name} ({c.listings})
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {/* Listing age chip */}
          <Select value={houseListingAge} onValueChange={setHouseListingAge}>
            <SelectTrigger className="h-8 w-auto min-w-0 flex-none rounded-full border-border bg-background px-3 text-[11px] font-semibold shadow-none" aria-label="Listing age">
              <SelectValue placeholder="Any age" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">Any listing age</SelectItem>
              <SelectItem value="7">Last 7 days</SelectItem>
              <SelectItem value="30">Last 30 days</SelectItem>
              <SelectItem value="90">Last 3 months</SelectItem>
              <SelectItem value="365">Last year</SelectItem>
            </SelectContent>
          </Select>
          {/* Funding status chip */}
          <Select value={houseFundingStatus} onValueChange={(v) => setHouseFundingStatus(v as HouseFundingStatus)}>
            <SelectTrigger className="h-8 w-auto min-w-0 flex-none rounded-full border-border bg-background px-3 text-[11px] font-semibold shadow-none" aria-label="Funding status">
              <SelectValue placeholder="Any status" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">Any status</SelectItem>
              <SelectItem value="ready">Ready to fund</SelectItem>
              <SelectItem value="topup">Needs top-up</SelectItem>
            </SelectContent>
          </Select>
          {/* Distance chip */}
          <Select value={houseRadiusKm} onValueChange={setHouseRadiusKm}>
            <SelectTrigger className="h-8 w-auto min-w-0 flex-none rounded-full border-border bg-background px-3 text-[11px] font-semibold shadow-none" aria-label="Distance">
              <SelectValue placeholder="Any distance" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">Any distance</SelectItem>
              <SelectItem value="1">1 km</SelectItem>
              <SelectItem value="2">2 km</SelectItem>
              <SelectItem value="5">5 km</SelectItem>
              <SelectItem value="10">10 km</SelectItem>
              <SelectItem value="25">25 km</SelectItem>
              <SelectItem value="50">50 km</SelectItem>
            </SelectContent>
          </Select>
          {/* Within float toggle chip */}
          <button
            type="button"
            onClick={() => setHouseWithinFloat((v) => !v)}
            className={`h-8 flex-none rounded-full border px-3 text-[11px] font-semibold transition-colors ${
              houseWithinFloat
                ? 'border-primary bg-primary text-primary-foreground'
                : 'border-border bg-background text-foreground hover:bg-muted'
            }`}
          >
            Within float
          </button>
          {/* Reset chip */}
          {(houseDistrict !== 'all' || houseSubCounty !== 'all' || houseSearch || houseWithinFloat || showSavedReadyOnly || houseSort !== 'rent_asc' || houseRentMin || houseRentMax || houseFundingStatus !== 'all' || houseCountry !== 'all' || houseListingAge !== 'all' || houseRadiusKm !== 'all') && (
            <button
              type="button"
              onClick={resetFilters}
              className="h-8 flex-none rounded-full border border-destructive/30 bg-destructive/5 px-3 text-[11px] font-semibold text-destructive transition-colors hover:bg-destructive/10"
            >
              <X className="h-3 w-3 mr-1 inline" aria-hidden />
              Reset
            </button>
          )}
        </div>
      )}



      {feedOrder === 'houses' && houses.length > 0 && (houseDistricts.length > 0 || houseSubCounties.length > 0) && (
        <div className="space-y-1.5 px-1" aria-label="Quick location filters">
          {houseDistricts.length > 0 && (
            <div className="flex items-center gap-1.5 overflow-x-auto pb-0.5" role="group" aria-label="District quick filters">
              <MapPin className="h-3.5 w-3.5 flex-none text-muted-foreground" aria-hidden />
              <button
                type="button"
                aria-pressed={houseDistrict === 'all'}
                onClick={() => setHouseDistrict('all')}
                className={`h-8 flex-none rounded-full border px-3 text-xs font-semibold transition-colors ${
                  houseDistrict === 'all'
                    ? 'border-primary bg-primary text-primary-foreground'
                    : 'border-border bg-background text-foreground hover:bg-muted'
                }`}
              >
                All districts
                <span className="ml-1 opacity-70">
                  ({houseDistricts.reduce((sum, [, { count }]) => sum + count, 0)})
                </span>
              </button>
              {houseDistricts.map(([key, { label, count }]) => (
                <button
                  key={key}
                  type="button"
                  aria-pressed={houseDistrict === key}
                  onClick={() => setHouseDistrict(houseDistrict === key ? 'all' : key)}
                  className={`h-8 flex-none rounded-full border px-3 text-xs font-semibold transition-colors ${
                    houseDistrict === key
                      ? 'border-primary bg-primary text-primary-foreground'
                      : 'border-border bg-background text-foreground hover:bg-muted'
                  }`}
                >
                  {label}
                  <span className="ml-1 opacity-70">({count})</span>
                </button>
              ))}
            </div>
          )}
          {houseSubCounties.length > 0 && (
            <div className="flex items-center gap-1.5 overflow-x-auto pb-0.5" role="group" aria-label="Neighborhood quick filters">
              <NavigationIcon className="h-3.5 w-3.5 flex-none text-muted-foreground" aria-hidden />
              <button
                type="button"
                aria-pressed={houseSubCounty === 'all'}
                onClick={() => setHouseSubCounty('all')}
                className={`h-8 flex-none rounded-full border px-3 text-xs font-semibold transition-colors ${
                  houseSubCounty === 'all'
                    ? 'border-primary bg-primary text-primary-foreground'
                    : 'border-border bg-background text-foreground hover:bg-muted'
                }`}
              >
                All neighborhoods
                <span className="ml-1 opacity-70">
                  ({houseSubCounties.reduce((sum, [, { count }]) => sum + count, 0)})
                </span>
              </button>
              {houseSubCounties.map(([key, { label, count }]) => (
                <button
                  key={key}
                  type="button"
                  aria-pressed={houseSubCounty === key}
                  onClick={() => setHouseSubCounty(houseSubCounty === key ? 'all' : key)}
                  className={`h-8 flex-none rounded-full border px-3 text-xs font-semibold transition-colors ${
                    houseSubCounty === key
                      ? 'border-primary bg-primary text-primary-foreground'
                      : 'border-border bg-background text-foreground hover:bg-muted'
                  }`}
                >
                  {label}
                  <span className="ml-1 opacity-70">({count})</span>
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      {feedOrder === 'houses' && alertsOpen && houseAlerts.length > 0 && (
        <Card className="p-3 sm:p-4 rounded-xl sm:rounded-2xl border-border" aria-label="Balance alert history">
          <div className="flex items-center justify-between gap-2 px-0.5">
            <p className="text-xs font-black text-foreground">Balance alerts</p>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-7 text-[11px]"
              onClick={() => {
                persistAlerts([]);
                setAlertsOpen(false);
              }}
            >
              Clear all
            </Button>
          </div>
          <div className="mt-2 space-y-2">
            {houseAlerts.map((alert, i) => {
              const firstKnown = alert.ids
                .map((id) => houses.find((h) => h.house_id === id))
                .find((h): h is SupportableHouse => !!h);
              return (
                <div
                  key={`${alert.at}-${i}`}
                  className="flex items-center gap-2.5 rounded-xl border border-border bg-background p-2"
                >
                  {alert.kind === 'funded' ? (
                    <ShieldCheck className="h-3.5 w-3.5 flex-none text-success" aria-hidden />
                  ) : alert.kind === 'dismissed' ? (
                    <X className="h-3.5 w-3.5 flex-none text-muted-foreground" aria-hidden />
                  ) : (
                    <Bell className="h-3.5 w-3.5 flex-none text-primary" aria-hidden />
                  )}
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-xs font-bold leading-tight">
                      {alert.kind === 'funded'
                        ? 'You started funding this saved house'
                        : alert.kind === 'dismissed'
                          ? 'You dismissed the ready-to-fund highlight'
                          : alert.ids.length === 1
                            ? '1 saved house became fundable'
                            : `${alert.ids.length} saved houses became fundable`}
                    </p>
                    <p className="mt-0.5 truncate text-[10px] text-muted-foreground">
                      {firstKnown ? houseTitleLine(firstKnown) : 'House no longer listed'} ·{' '}
                      {timeAgo(alert.at)}
                    </p>
                  </div>
                  {firstKnown && (
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="h-7 flex-none text-[11px]"
                      onClick={() => {
                        setAlertsOpen(false);
                        jumpToHouse(firstKnown.house_id);
                      }}
                    >
                      View
                    </Button>
                  )}
                </div>
              );
            })}
          </div>
        </Card>
      )}


      {feedOrder === 'houses' && (savedForLater.length > 0 || fundableNow.length > 0) && (
        <Card className="p-3 sm:p-4 rounded-xl sm:rounded-2xl border-primary/30 bg-primary/5">
          <div className="flex items-center gap-1.5 px-0.5">
            <Bookmark className="h-3.5 w-3.5 text-primary" aria-hidden />
            <p className="text-xs font-black text-foreground">Saved for later</p>
            <span className="text-[10px] font-semibold text-muted-foreground">
              {savedForLater.length > 0
                ? `· ${savedForLater.length} ${savedForLater.length === 1 ? 'house' : 'houses'} waiting on a top-up`
                : ''}
              {fundableNow.length > 0
                ? `${savedForLater.length > 0 ? ' ' : '· '}${fundableNow.length} ready to fund now`
                : ''}
            </span>
          </div>

          {fundableNow.length > 0 && (
            <div className="mt-2 space-y-2">
              {fundableNow.map((h) => {
                const img = (h.image_urls ?? []).filter(Boolean)[0];
                return (
                  <div
                    key={`fundable-${h.house_id}`}
                    className="flex items-center gap-2.5 rounded-xl border-2 border-success/70 bg-success/10 p-2 shadow-sm"
                  >
                    {img ? (
                      <img
                        src={img}
                        alt={houseTitleLine(h)}
                        loading="lazy"
                        decoding="async"
                        className="h-11 w-11 flex-none rounded-lg object-cover"
                      />
                    ) : (
                      <div className="flex h-11 w-11 flex-none items-center justify-center rounded-lg bg-muted">
                        <Home className="h-4 w-4 text-muted-foreground" />
                      </div>
                    )}
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-xs font-bold leading-tight">
                        <HighlightText text={houseTitleLine(h)} query={houseSearch} />
                      </p>
                      <p className="mt-0.5 truncate text-[10px] font-semibold text-success">
                        Your balance now covers it — ready to fund
                      </p>
                    </div>
                    <FundHouseTooltip>
                      <Button
                        size="sm"
                        disabled={busy}
                        onClick={() => {
                          recordAlertAction(h.house_id, 'funded');
                          jumpToHouse(h.house_id);
                          setFundConfirmKey(`${Date.now()}`);
                        }}
                        aria-label={`Fund ${houseTitleLine(h)} now`}
                        className="h-8 flex-none rounded-lg px-2.5 text-[11px] font-bold"
                      >
                        <ShieldCheck className="mr-1 h-3 w-3" aria-hidden />
                        Fund now
                      </Button>
                    </FundHouseTooltip>
                    <button
                      type="button"
                      onClick={() => {
                        recordAlertAction(h.house_id, 'dismissed');
                        persistFundable(fundableIds.filter((id) => id !== h.house_id));
                      }}
                      aria-label={`Dismiss highlight for ${houseTitleLine(h)}`}
                      className="flex h-7 w-7 flex-none items-center justify-center rounded-lg text-muted-foreground hover:bg-background hover:text-foreground"
                    >
                      <X className="h-3.5 w-3.5" aria-hidden />
                    </button>
                  </div>
                );
              })}
            </div>
          )}

          <div className="mt-2 space-y-2">
            {savedForLater.map((h) => {
              const topUpNeeded = Math.max(0, Number(h.monthly_rent || 0) - remaining);
              const img = (h.image_urls ?? []).filter(Boolean)[0];
              return (
                <div
                  key={`saved-${h.house_id}`}
                  className="flex items-center gap-2.5 rounded-xl border border-border bg-background p-2"
                >
                  {img ? (
                    <img
                      src={img}
                      alt={houseTitleLine(h)}
                      loading="lazy"
                      decoding="async"
                      className="h-11 w-11 flex-none rounded-lg object-cover"
                    />
                  ) : (
                    <div className="flex h-11 w-11 flex-none items-center justify-center rounded-lg bg-muted">
                      <Home className="h-4 w-4 text-muted-foreground" />
                    </div>
                  )}
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-xs font-bold leading-tight">
                      <HighlightText text={houseTitleLine(h)} query={houseSearch} />
                    </p>
                    <p className="mt-0.5 truncate text-[10px] font-semibold text-primary">
                      Top up {formatDynamic(topUpNeeded)} to fund it
                    </p>
                  </div>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={busy}
                    onClick={() => setTopUpAmount(Math.max(0, Math.round(topUpNeeded)))}
                    aria-label={`Top up ${formatDynamic(topUpNeeded)} to fund ${houseTitleLine(h)}`}
                    className="h-8 flex-none rounded-lg border-primary/40 px-2.5 text-[11px] font-bold text-primary"
                  >
                    <Wallet className="mr-1 h-3 w-3" aria-hidden />
                    Top up
                  </Button>
                </div>
              );
            })}
          </div>
        </Card>
      )}

      {feed.length === 0 && feedOrder === 'houses' && houses.length > 0 && (
        <Card className="p-6 rounded-2xl text-center space-y-3">
          <Home className="h-8 w-8 mx-auto text-muted-foreground" />
          <div className="space-y-1">
            <p className="text-sm font-semibold">No houses match your filters</p>
            <p className="text-xs text-muted-foreground leading-relaxed">
              {houseSearch
                ? `We could not find any houses matching "${houseSearch}". Try a different name, district, or neighborhood.`
                : showSavedReadyOnly
                  ? 'You have no saved houses that your current balance can fund. Reset to see all houses, or top up your balance.'
                  : selectedCountry
                    ? `No empty houses in ${selectedCountry.name} match the other filters yet. Choose "All of Africa" or widen your filters.`
                    : houseListingAge !== 'all'
                      ? 'No empty houses were listed in that period. Try a longer listing age.'
                      : houseRadiusKm !== 'all'
                        ? `No empty houses with known GPS are within ${houseRadiusKm} km of your location. Try a wider distance.`
                        : houseDistrict !== 'all' || houseSubCounty !== 'all'
                    ? 'No empty houses in this area match the other filters. Try a different location or widen your search.'
                    : houseFundingStatus !== 'all' || houseWithinFloat
                      ? 'No houses match the funding-status filter. Reset to see every available house.'
                      : `No houses match the current rent range or sort filters. Reset to see all ${houses.length.toLocaleString()} houses again.`}
            </p>
          </div>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="rounded-full text-xs font-bold"
            onClick={resetFilters}
          >
            <X className="h-3.5 w-3.5 mr-1" aria-hidden />
            Reset filters
          </Button>
        </Card>
      )}

      {feed.length === 0 && !(feedOrder === 'houses' && houses.length > 0) && (
        <Card className="p-6 rounded-2xl text-center">
          <Wallet className="h-6 w-6 mx-auto text-muted-foreground mb-2" />
          <p className="text-sm font-semibold">Nothing awaiting money right now</p>
          <p className="text-xs text-muted-foreground mt-1">
            Rent requests appear here after approval, and verified empty houses appear as soon as they are listed.
          </p>
        </Card>
      )}





      <div className={feedOrder === 'houses' ? 'grid gap-3 sm:grid-cols-2' : 'space-y-3'}>
      {pageItems.map((item, i) => {
        const globalIndex = pageStart + i;
        const prevKind = globalIndex > 0 ? feed[globalIndex - 1].kind : null;
        const groupHeader =
          globalIndex > 0 && prevKind !== item.kind ? (
            <div key={`hr-${item.kind}`} className="flex items-center gap-2 px-1 pt-2">
              <span className="h-px flex-1 bg-border" />
              <span className="text-[10px] font-black uppercase tracking-wider text-muted-foreground">
                {item.kind === 'house' ? 'Houses' : 'Rent requests'}
              </span>
              <span className="h-px flex-1 bg-border" />
            </div>
          ) : null;

        if (item.kind === 'house') {
          return (
            <div key={`house-${item.id}`} className="relative min-w-0 space-y-3">
              {groupHeader}
              <HouseSupportCard
                house={item.house}
                isSelected={houseSelected.includes(item.id)}
                remaining={remaining}
                busy={busy}
                onToggle={toggleHouse}
                onOpenDetail={setDetailHouse}
                 onTopUp={(shortfall) => setTopUpAmount(Math.max(0, Math.round(shortfall)))}
                 flash={flashHouseId === item.id || fundableIds.includes(item.id)}
                searchQuery={houseSearch}
                origin={referencePoint ?? userPoint}
                />
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  toggleCompare(item.id);
                }}
                aria-pressed={compareIds.includes(item.id)}
                aria-label={`${compareIds.includes(item.id) ? 'Remove' : 'Add'} ${houseTitleLine(item.house)} ${compareIds.includes(item.id) ? 'from' : 'to'} comparison`}
                className={`absolute right-2 top-2 z-10 flex h-9 w-9 items-center justify-center rounded-full shadow-sm transition-colors ${
                  compareIds.includes(item.id)
                    ? 'bg-primary text-primary-foreground'
                    : 'bg-background/90 text-muted-foreground hover:text-foreground'
                }`}
              >
                <GitCompareArrows className="h-4 w-4" aria-hidden />
              </button>
            </div>
          );
        }

        return (
          <div key={`plan-${item.id}`} className="space-y-3">
            {groupHeader}
            {(() => {
        const plan = item.plan;

        const isFunded = fundedIds.includes(plan.rent_request_id);
        const heldByOther = !!plan.held_by && plan.held_by !== partnerId;
        const isSelected = selected.includes(plan.rent_request_id);
        const unaffordable = !isSelected && Number(plan.funding_amount || 0) > remaining;
        const images = (plan.house_image_urls ?? []).filter(Boolean);
        const monthlyRoi = Math.round((Number(plan.funding_amount || 0) * MONTHLY_ROI_RATE) / 100);
        const planMonths = plan.duration_days ? Math.max(1, Math.round(Number(plan.duration_days) / 30)) : 1;
        const totalReturn = monthlyRoi * planMonths;
        const prettyName = (raw?: string | null) =>
          (raw ?? '')
            .replace(/[_-]/g, ' ')
            .replace(/\b\w/g, (c) => c.toUpperCase()) || 'Rental home';
        const titleLine = `${prettyName(plan.house_category)}${plan.request_city ? ` in ${prettyName(plan.request_city)}` : ''}`;
        const village = plan.tenant_location?.split(',')[0]?.trim();
        const district = plan.request_city?.split(',')[0]?.trim();
        const addressLine = [village, district, 'Uganda'].filter(Boolean).join(', ');

        return (
          <Card
            key={plan.rent_request_id}
            data-plan-id={plan.rent_request_id}
            role="button"
            tabIndex={0}
            onClick={() => setDetailPlan(plan)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                setDetailPlan(plan);
              }
            }}
            className={`relative overflow-hidden rounded-2xl p-0 transition-all cursor-pointer border ${isSelected ? 'ring-2 ring-primary bg-primary/5 border-primary' : 'border-primary/30 hover:border-primary/60'}`}
          >
            <div className="flex flex-col">
              {/* Photo */}
              <div className="relative aspect-[16/10] sm:aspect-[4/3] w-full shrink-0 overflow-hidden bg-muted">
                {images.length > 0 ? (
                  <img src={images[0]} alt={titleLine} loading="lazy" decoding="async" className="h-full w-full object-cover" />
                ) : (
                  <div className="flex h-full w-full items-center justify-center">
                    <Home className="h-7 w-7 text-muted-foreground" />
                  </div>
                )}
                {/* Card-type badge: this row is a tenant rent plan. */}
                <span className="absolute left-1.5 top-1.5 rounded-full bg-primary px-2 py-0.5 text-[9px] font-bold uppercase tracking-wide text-primary-foreground shadow-sm">
                  Rent plan
                </span>
                {images.length > 1 && (
                  <span className="absolute bottom-1.5 right-1.5 rounded-full bg-background/85 px-1.5 py-0.5 text-[9px] font-bold backdrop-blur">
                    +{images.length - 1}
                  </span>
                )}
              </div>

              {/* Details */}
              <div className="min-w-0 flex-1 p-4">
                <p className="truncate text-sm font-bold leading-tight sm:text-base">{titleLine}</p>
                <p className="mt-0.5 flex items-start gap-1 text-[11px] leading-snug text-muted-foreground">
                  <MapPin className="mt-0.5 h-3 w-3 flex-none" />
                  <span className="line-clamp-2">{addressLine || 'Uganda'}</span>
                </p>

                {/* KPI chips */}
                <div className="mt-2 flex flex-wrap items-center gap-1.5">
                  <span className="rounded-full bg-primary/10 px-2 py-0.5 text-[10px] font-bold text-primary">
                    {MONTHLY_ROI_RATE}% / month
                  </span>
                  {plan.duration_days ? (
                    <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] font-semibold text-muted-foreground">
                      {plan.duration_days} days
                    </span>
                  ) : null}
                  {isFunded ? (
                    <Badge variant="secondary" className="rounded-full text-[10px] font-semibold">Funded by you</Badge>
                  ) : heldByOther ? (
                    <Badge variant="secondary" className="rounded-full text-[10px] font-semibold">On hold</Badge>
                  ) : null}
                </div>

                {/* Price row + action */}
                <div className="mt-2 flex items-end justify-between gap-2">
                  <div className="min-w-0">
                    <p className="truncate text-base font-black leading-none sm:text-lg">
                      {formatDynamic(plan.funding_amount)}
                    </p>
                  </div>

                  <div className="flex shrink-0 items-center gap-1.5">
                    <PlanShareButton plan={plan} />
                    {!isFunded && (
                      <Button
                        size="icon"
                        variant={isSelected ? 'secondary' : 'default'}
                        disabled={heldByOther || busy}
                        onClick={(e) => {
                          e.stopPropagation();
                          toggle(plan.rent_request_id);
                        }}
                        aria-label={`${isSelected ? 'Remove' : 'Select'} plan for ${plan.tenant_full_name ?? plan.tenant_first_name ?? 'tenant'}`}
                        className="h-10 w-10 shrink-0 rounded-full shadow-sm"
                      >
                        {isSelected ? <Check className="h-5 w-5" /> : <Plus className="h-5 w-5" />}
                      </Button>
                    )}
                  </div>
                </div>

                {/* Earnings breakdown: monthly amount, timeframe, total return */}
                <div className="mt-2.5 grid grid-cols-3 gap-1.5 rounded-xl bg-primary/5 px-2.5 py-2">
                  <div className="min-w-0">
                    <p className="text-[9px] font-semibold uppercase tracking-wide text-muted-foreground">You earn</p>
                    <p className="truncate text-xs font-black text-primary sm:text-sm">{formatDynamic(monthlyRoi)}</p>
                    <p className="text-[9px] text-muted-foreground">per month</p>
                  </div>
                  <div className="min-w-0">
                    <p className="text-[9px] font-semibold uppercase tracking-wide text-muted-foreground">For</p>
                    <p className="truncate text-xs font-black sm:text-sm">{planMonths} {planMonths === 1 ? 'month' : 'months'}</p>
                    <p className="text-[9px] text-muted-foreground">{plan.duration_days ? `${plan.duration_days} days` : 'plan term'}</p>
                  </div>
                  <div className="min-w-0">
                    <p className="text-[9px] font-semibold uppercase tracking-wide text-muted-foreground">Total return</p>
                    <p className="truncate text-xs font-black text-primary sm:text-sm">{formatDynamic(totalReturn)}</p>
                    <p className="text-[9px] text-muted-foreground">by plan end</p>
                  </div>
                </div>

                <p className="mt-1.5 flex items-start gap-1 text-[10px] leading-snug text-muted-foreground">
                  <Calculator className="mt-0.5 h-3 w-3 flex-none" />
                  <span>
                    Monthly earnings = {formatDynamic(plan.funding_amount)} × {MONTHLY_ROI_RATE}%.
                    Total payout = {formatDynamic(monthlyRoi)} × {planMonths} {planMonths === 1 ? 'month' : 'months'}.
                  </span>
                </p>

                {unaffordable && !heldByOther && (
                  <p className="mt-1.5 text-[10px] font-semibold text-muted-foreground">
                    Add {formatDynamic(Number(plan.funding_amount) - remaining)} to your balance to include this plan.
                  </p>
                )}
              </div>
            </div>
          </Card>
        );
            })()}
          </div>
        );
      })}
      </div>

      {feed.length > PLANS_PER_PAGE && (
        <div className="flex items-center justify-between gap-2 px-1 pt-1">
          <Button
            variant="outline"
            size="sm"
            className="h-8 text-[11px]"
            disabled={page === 0}
            onClick={() => setPage((p) => Math.max(0, p - 1))}
          >
            <ChevronLeft className="h-3.5 w-3.5" />
            <span className="ml-1">Previous</span>
          </Button>
          <p className="text-[11px] font-semibold text-muted-foreground">
            {pageStart + 1}–{Math.min(pageStart + PLANS_PER_PAGE, feed.length)} of {feed.length} · Page {page + 1} of {pageCount}
          </p>
          <Button
            variant="outline"
            size="sm"
            className="h-8 text-[11px]"
            disabled={page >= pageCount - 1}
            onClick={() => setPage((p) => p + 1)}
          >
            <span className="mr-1">Next</span>
            <ChevronRight className="h-3.5 w-3.5" />
          </Button>
        </div>
      )}


      {selected.length > 0 && (
        <Card className="mt-3 rounded-2xl border-primary/25 bg-background/95 p-3 sm:p-4 shadow-xl backdrop-blur-md">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="min-w-0">
              <p className="text-[11px] font-semibold text-muted-foreground">
                {selected.length} plan{selected.length > 1 ? 's' : ''} selected
              </p>
              <SlotAmount
                value={total}
                className="text-xl sm:text-2xl font-black leading-none text-primary"
              />
            </div>
            <Button
              onClick={openDeploy}
              disabled={busy || total < MIN_FUNDING || overBudget}
              className="shrink-0 w-full sm:w-auto"
            >
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <ShieldCheck className="h-4 w-4" />}
              <span className="ml-2">{activeCommitmentId ? 'Deploy or top up' : 'Fund now'}</span>
            </Button>
          </div>

          <div className="mt-3 flex flex-col gap-1.5 rounded-xl border border-primary/20 bg-primary/5 px-3 py-2 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex items-center gap-2 text-[11px] font-semibold text-muted-foreground">
              <TrendingUp className="h-3.5 w-3.5 text-primary shrink-0" />
              <span>Projected returns · {MONTHLY_ROI_RATE}% monthly</span>
            </div>
            <SlotAmount
              value={Math.round((total * MONTHLY_ROI_RATE) / 100)}
              className="text-sm sm:text-base font-black leading-none text-primary"
            />
          </div>

          {overBudget ? (
            <p className="mt-2 text-[10px] font-semibold text-destructive">
              This selection is {formatDynamic(total - available)} more than your operational
              float of {formatDynamic(available)}. Remove a plan or add funds.
            </p>
          ) : (
            <p className="mt-2 text-[10px] text-muted-foreground">
              {formatDynamic(remaining)} of your operational float still unused · returns
              start the day you deploy.
            </p>
          )}
        </Card>
      )}

      {partnerId && (
        <HousePlacementTimeline partnerId={partnerId} refreshKey={placementRefresh} />
      )}

      {houseSelected.length > 0 && (
        <HouseSupportBar
          selectedCount={houseSelected.length}
          total={houseTotal}
          available={Math.max(0, available - total)}
          busy={busy}
          setBusy={setBusy}
          selectedIds={houseSelected}
          selectedHouses={selectedHouseObjects}
          activeHouseCommitment={activeHouseCommitment}
          confirmRequestKey={fundConfirmKey}

          onSubmitted={async (outcome) => {
            setHouseSelected([]);
            setDiscoveredHouses({});
            await housesQuery.refetch();
            if (outcome === 'submitted') {
              setPlacementRefresh((k) => k + 1);
              await loadFunded();
              // Refresh the market totals (rent still needed) shown above the list.
              window.dispatchEvent(new CustomEvent('supporter-contribution-changed'));
            }
          }}
        />
      )}

      <EmptyHouseDetailSheet
        house={detailHouse}
        open={!!detailHouse}
        onOpenChange={(v) => !v && setDetailHouse(null)}
        isPartner
        remaining={remaining}
        isPicked={!!detailHouse && houseSelected.includes(detailHouse.house_id)}
        onTogglePick={(h) => toggleHouse(h.house_id)}
      />


      <HouseCompareDialog
        open={compareOpen && compareHouses.length >= 2}
        onOpenChange={setCompareOpen}
        houses={compareHouses}
        remaining={remaining}
        busy={busy}
        onFundHouse={(house) => {
          setCompareOpen(false);
          if (!houseSelected.includes(house.house_id)) toggleHouse(house.house_id);
        }}
        onRemove={(houseId) => setCompareIds((prev) => prev.filter((x) => x !== houseId))}
        searchQuery={houseSearch}
      />

      <SelfPortfolioDeployDialog
        open={deployOpen}
        onOpenChange={setDeployOpen}
        activeCommitmentId={activeCommitmentId}
        selectedIds={selected}
        total={total}
        onDeployed={handleDeployed}
      />

      <SelfPortfolioPlanDetailSheet
        plan={detailPlan}
        open={!!detailPlan}
        onOpenChange={(v) => !v && setDetailPlan(null)}
        isFunded={!!detailPlan && fundedIds.includes(detailPlan.rent_request_id)}
      />

      <DepositFlow
        open={topUpAmount !== null}
        onOpenChange={(v) => {
          if (!v) setTopUpAmount(null);
        }}
        defaultAmount={topUpAmount ?? undefined}
      />
    </div>
  );
}