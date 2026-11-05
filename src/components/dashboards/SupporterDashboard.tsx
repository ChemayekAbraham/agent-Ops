import calculatorIllustration from "@/assets/calculator-illustration.svg.asset.json";
import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { cn } from '@/lib/utils';
import { sortFunderHousesByCompleteness } from '@/lib/funderHouseSort';
import { useConfetti } from '@/components/Confetti';
import { useNavigate, useLocation } from 'react-router-dom';
import { User } from '@supabase/supabase-js';
import { supabase } from '@/integrations/supabase/client';
import { useOffline } from '@/contexts/OfflineContext';
import { Button } from '@/components/ui/button';
import { Bookmark, Calculator, BadgeCheck, MapPin, Wallet, CreditCard, TrendingUp, History, FileText, Receipt, Share2, Zap, Home, ScrollText, ChevronDown, ChevronUp } from 'lucide-react';
import { formatUGX as _formatUGX } from '@/lib/rentCalculations';
import { useToast } from '@/hooks/use-toast';
import { AppRole } from '@/hooks/useAuth';
import { ReactNode } from 'react';
import DashboardHeader from '@/components/DashboardHeader';

import { useProfile } from '@/hooks/useProfile';
import { UserAvatar } from '@/components/UserAvatar';
import { ProfileSummaryPopover } from '@/components/profile/ProfileSummaryPopover';
import { SupporterDashboardSkeleton } from '@/components/skeletons/DashboardSkeletons';
import { useWallet } from '@/hooks/useWallet';
import { useAvailableBalance } from '@/hooks/useAvailableBalance';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';

// Agreement
import { useSupporterAgreement } from '@/hooks/useSupporterAgreement';
import { useTrackSection } from '@/hooks/useTrackSection';
import { useFunderNudges } from '@/hooks/useFunderNudges';
import { userBehaviourTracker } from '@/lib/userBehaviourTracker';
import { 
  LockedOverlay,
  AgreementAcceptedBadge
} from '@/components/supporter/agreement';

import { hapticTap } from '@/lib/haptics';
// motion removed — static rendering for low-end devices

// Virtual Houses components
import { VirtualHouse } from '@/components/supporter/VirtualHouseCard';
import { RentCategory } from '@/components/supporter/RentCategoryFeed';
// FundingPoolCard removed from direct import
import { FunderNewHero } from '@/components/funder-new/FunderNewHero';
import { useFunderSavedItems } from '@/hooks/useFunderSavedItems';
import { useFunderBookedHouses } from '@/hooks/useFunderBookedHouses';
import { useFunderNewMarketSummary } from '@/components/funder-new/useFunderNewOpportunities';
import { useFunderNewLocation } from '@/components/funder-new/useFunderNewLocation';
import type { FunderNewEmptyHouse, FunderNewFilters, FunderNewOrigin } from '@/components/funder-new/types';
import type { FunderNewViewport } from '@/components/funder-new/FunderNewRouteMap';
import { toSelectionItem } from '@/components/funder-new/utils';
import { useSupportedTenants } from '@/hooks/useSupportedTenants';
import { useCurrency } from '@/hooks/useCurrency';

import { FunderApprovalBanner } from '@/components/supporter/FunderApprovalGate';

import { useFunderApprovalStatus } from '@/hooks/useFunderApprovalStatus';

import AiIdButton from '@/components/ai-id/AiIdButton';
import { NotificationBell } from '@/components/supporter/NotificationBell';
import { useInactivityLock } from '@/hooks/useInactivityLock';
import { WidgetErrorBoundary } from '@/components/shared/WidgetErrorBoundary';
import {
  WidgetCardSkeleton,
  ListSectionSkeleton,
} from '@/components/skeletons/SectionSkeletons';
import { lazyWithRetry, lazyNamed } from '@/lib/lazyWithRetry';
import { Suspense } from 'react';
import { useMountedOnce } from '@/hooks/useMountedOnce';
import { preloadWhenIdle } from '@/lib/idlePreload';

// Dialogs, sheets and the houses map are only needed after a tap, so none of
// their code (or the data they fetch) is part of opening the dashboard. Each one
// loads the first time it is opened; the likeliest ones are fetched at idle.
const loadHousesMap = () => import('@/components/funder-new/FunderNewMapSection');
const loadMapSheet = () => import('@/components/supporter/MapBottomSheet');
const loadCapitalOpportunities = () => import('@/components/supporter/FunderCapitalOpportunities');
const loadInvestmentsDrawer = () => import('@/components/supporter/InvestmentAccountsDrawer');
const loadInactivityLock = () => import('@/components/supporter/SupporterInactivityLock');
const PaymentPartnersDialog = lazyWithRetry(() => import('@/components/payments/PaymentPartnersDialog'));
const FunderWalletHubSection = lazyWithRetry(() => import('@/components/supporter/FunderWalletHubSection'));
const EmptyHouseDetailSheet = lazyWithRetry(() => import('@/components/agent/EmptyHouseDetailSheet'));
const InvestmentCalculator = lazyNamed(() => import('@/components/supporter/InvestmentCalculator'), 'InvestmentCalculator');
const SupporterAgreementModal = lazyNamed(() => import('@/components/supporter/agreement/SupporterAgreementModal'), 'SupporterAgreementModal');
const SupporterAgreementViewModal = lazyNamed(() => import('@/components/supporter/agreement/SupporterAgreementCard'), 'SupporterAgreementViewModal');
const VirtualHouseDetailsSheet = lazyNamed(() => import('@/components/supporter/VirtualHouseDetailsSheet'), 'VirtualHouseDetailsSheet');
const InvestmentPackageSheet = lazyNamed(() => import('@/components/supporter/InvestmentPackageSheet'), 'InvestmentPackageSheet');
const FunderSavedItemsDialog = lazyNamed(() => import('@/components/funder-new/FunderSavedItemsDialog'), 'FunderSavedItemsDialog');
const FunderNewReviewDialog = lazyNamed(() => import('@/components/funder-new/FunderNewSelectionPanel'), 'FunderNewReviewDialog');
const FunderActivationModal = lazyNamed(() => import('@/components/supporter/FunderActivationModal'), 'FunderActivationModal');
const FunderNewMapSection = lazyNamed(loadHousesMap, 'FunderNewMapSection');
const MapBottomSheet = lazyNamed(loadMapSheet, 'MapBottomSheet');
const FunderCapitalOpportunities = lazyNamed(loadCapitalOpportunities, 'FunderCapitalOpportunities');
const InvestmentAccountsDrawer = lazyNamed(loadInvestmentsDrawer, 'InvestmentAccountsDrawer');
const SupporterInactivityLock = lazyNamed(loadInactivityLock, 'SupporterInactivityLock');

/** Starts downloading the houses map code as a finger reaches the hero card. */
const preloadHousesMapCode = () => {
  void loadHousesMap().catch(() => {});
  void loadMapSheet().catch(() => {});
  void loadCapitalOpportunities().catch(() => {});
};


interface SupporterDashboardProps {
  user: User;
  signOut: () => Promise<void>;
  currentRole: AppRole;
  availableRoles: AppRole[];
  onRoleChange: (role: AppRole) => void;
  addRoleComponent: ReactNode;
}

export default function SupporterDashboard({ 
  user, signOut, currentRole, availableRoles, onRoleChange, addRoleComponent 
}: SupporterDashboardProps) {
  // Track user presence and dwell time in Supporter dashboard
  useTrackSection('supporter-overview', 'supporter');
  // Personal nudge toasts about this partner's own portfolios and Returns.
  // Copy in src/lib/funderNudges/nudges.json; paced inside the hook.
  useFunderNudges(user?.id);

  const navigate = useNavigate();
  const location = useLocation();
  const { profile, loading: profileLoading } = useProfile();
  // Fallback chain while profile fetch is in flight (or RLS briefly hides
  // the row right after signup): use the auth user_metadata that the
  // signup form just wrote, then email local-part. Only show the generic
  // "Supporter" placeholder if we truly have nothing.
  const metaFullName = (user?.user_metadata?.full_name as string | undefined)?.trim() || '';
  const emailLocal = (user?.email || '').split('@')[0] || '';
  const displayFullName = profile?.full_name?.trim() || metaFullName || emailLocal;
  const displayFirstName = displayFullName ? displayFullName.split(' ')[0] : (profileLoading ? '' : 'Supporter');
  const { isOnline } = useOffline();
  const { count: supportedTenantCount } = useSupportedTenants();
  const [loading, setLoading] = useState(false);
  const [hasCachedData, setHasCachedData] = useState(() => {
    try { return !!localStorage.getItem(`supporter_houses_${user.id}`); } catch { return false; }
  });
  const [showPaymentPartners, setShowPaymentPartners] = useState(false);
  const [showAgreementModal, setShowAgreementModal] = useState(false);
  const [showViewAgreementModal, setShowViewAgreementModal] = useState(false);
  const [viewAgreementTab, setViewAgreementTab] = useState<'summary' | 'full'>('summary');
  const [localHasAccepted, setLocalHasAccepted] = useState<boolean | null>(null);
  const [justAccepted, setJustAccepted] = useState(false);
  const [showCalculator, setShowCalculator] = useState(false);
  const [showSavedItems, setShowSavedItems] = useState(false);
  const { count: bookmarkedCount } = useFunderSavedItems();
  // Saved Items holds both bookmarks and the houses booked for this Supporter.
  const { heldCount: bookedCount } = useFunderBookedHouses();
  const savedCount = bookmarkedCount + bookedCount;
  const [showMap, setShowMap] = useState(false);
  const [mapExpanded, setMapExpanded] = useState(false);
  const [mapExpandRequest, setMapExpandRequest] = useState(0);
  // The houses map and its "Houses to fund" sheet are no longer repeated on the
  // page: the hero card opens them full screen, and they unmount again on close.
  const [mapRequested, setMapRequested] = useState(false);
  const mapWasExpandedRef = useRef(false);
  const [mapFocus, setMapFocus] = useState<{ points: { lat: number; lng: number }[]; token: number } | null>(null);
  const handleListResultsFocus = useCallback((points: { lat: number; lng: number }[]) => {
    setMapFocus((prev) => ({ points, token: (prev?.token ?? 0) + 1 }));
  }, []);
  const openHousesMap = useCallback(() => {
    setMapRequested(true);
    setMapExpandRequest((n) => n + 1);
  }, []);
  const handleMapExpandedChange = useCallback((expanded: boolean) => {
    setMapExpanded(expanded);
    if (expanded) {
      mapWasExpandedRef.current = true;
    } else if (mapWasExpandedRef.current) {
      // Ignore the map's initial "not expanded" report on mount; only a real close unmounts it.
      mapWasExpandedRef.current = false;
      setMapRequested(false);
      setMapFocus(null);
      // The list resets with its sheet, so the map starts unfiltered next time too.
      setMapFilters((prev) => (prev.search || prev.location || prev.amount !== 'all' ? { ...prev, search: '', location: '', amount: 'all' } : prev));
    }
  }, []);
  // The floating search and the filter drawer drive the houses list; mirror them
  // onto the map so the pins match what the list shows.
  const handleListFiltersChange = useCallback((next: { search: string; location: string; amount: FunderNewFilters['amount'] }) => {
    setMapFilters((prev) =>
      prev.search === next.search && prev.location === next.location && prev.amount === next.amount
        ? prev
        : { ...prev, search: next.search, location: next.location, amount: next.amount },
    );
  }, []);

  useEffect(() => {
    if (mapExpanded) {
      document.body.dataset.mapExpanded = 'true';
    } else {
      delete document.body.dataset.mapExpanded;
    }
    return () => {
      delete document.body.dataset.mapExpanded;
    };
  }, [mapExpanded]);
  const marketSummary = useFunderNewMarketSummary();
  const mapLocation = useFunderNewLocation();
  const [mapSearchInput, setMapSearchInput] = useState('');
  const [mapFilters, setMapFilters] = useState<FunderNewFilters>({
    search: '',
    location: '',
    amount: 'all',
    sort: 'recommended',
    rentMin: null,
    rentMax: null,
    radiusKm: 'all',
    withinFloat: false,
  });
  const [mapArea, setMapArea] = useState<{ lat: number; lng: number; radiusKm: number } | null>(null);
  const [mapDetailHouse, setMapDetailHouse] = useState<FunderNewEmptyHouse | null>(null);
  const [mapFundItem, setMapFundItem] = useState<FunderNewEmptyHouse | null>(null);

  const mapOrigin: FunderNewOrigin | null = useMemo(() => {
    if (mapLocation.coords) {
      return {
        lat: mapLocation.coords.lat,
        lng: mapLocation.coords.lng,
        source: 'device',
        radiusKm: 25,
        label: 'your location',
      };
    }
    if (mapArea) {
      return {
        lat: mapArea.lat,
        lng: mapArea.lng,
        source: 'area',
        radiusKm: mapArea.radiusKm,
        label: 'this area',
      };
    }
    return null;
  }, [mapLocation.coords, mapArea]);

  const applyMapArea = useCallback((viewport: FunderNewViewport) => {
    setMapArea({ lat: viewport.lat, lng: viewport.lng, radiusKm: viewport.radiusKm });
  }, []);

  const handleMapSearchChange = useCallback((value: string) => {
    setMapSearchInput(value);
    setMapFilters((prev) => ({ ...prev, search: value }));
  }, []);
  const [selectedHouse, setSelectedHouse] = useState<VirtualHouse | null>(null);
  const [showHouseDetails, setShowHouseDetails] = useState(false);
  const [selectedPackageCategory, setSelectedPackageCategory] = useState<RentCategory | null>(null);
  const [showPackageSheet, setShowPackageSheet] = useState(false);
  const [showWallet, setShowWallet] = useState(false);
  const [showFunderHub, setShowFunderHub] = useState(false);
  const [showInvestments, setShowInvestments] = useState(false);
  const [capitalView, setCapitalView] = useState<'direct' | 'managed' | 'angel'>('direct');
  const [capitalFeedOrder, setCapitalFeedOrder] = useState<'rent' | 'houses'>('houses');
  const [investmentsTab, setInvestmentsTab] = useState<'accounts' | 'angel'>('accounts');
  const [focusPortfolioId, setFocusPortfolioId] = useState<string | null>(null);
  const { toast } = useToast();
  const { wallet, refreshWallet } = useWallet();
  const { fireSuccess, fireFirstFunding } = useConfetti();
  const [hasEverFunded, setHasEverFunded] = useState<boolean | null>(null);

  // Dynamic telemetry tracking across supporter sheets and drawers
  useEffect(() => {
    if (showWallet) {
      userBehaviourTracker.setSection('supporter-wallet', 'supporter');
    } else if (showFunderHub) {
      userBehaviourTracker.setSection('supporter-hub', 'supporter');
    } else if (showInvestments) {
      userBehaviourTracker.setSection('supporter-investments', 'supporter');
    } else if (showMap) {
      userBehaviourTracker.setSection('supporter-house-map', 'supporter');
    } else if (showPackageSheet) {
      userBehaviourTracker.setSection('supporter-packages', 'supporter');
    } else if (showHouseDetails) {
      userBehaviourTracker.setSection('supporter-house-details', 'supporter');
    } else if (showCalculator) {
      userBehaviourTracker.setSection('supporter-calculator', 'supporter');
    } else {
      userBehaviourTracker.setSection('supporter-overview', 'supporter');
    }
  }, [
    showWallet,
    showFunderHub,
    showInvestments,
    showMap,
    showPackageSheet,
    showHouseDetails,
    showCalculator,
  ]);

  // ─── Funder activation modal (self-registered + just approved + empty wallet) ───
  const { isSelfRegistered, verifiedAt } = useFunderApprovalStatus(user.id);
  const [showActivationModal, setShowActivationModal] = useState(false);
  const [highlightDeposit, setHighlightDeposit] = useState(false);
  const SNOOZE_KEY = `funder_activation_snooze_${user.id}`;

  // Strict ledger-derived available balance (never the wallets cache) for
  // the "wallet is empty" nag trigger. Keeps user-facing surfaces locked
  // to the same source of truth as the wallet card / withdraw flow.
  const { available: strictAvailable } = useAvailableBalance(user.id);
  const { formatAmount, formatAmountCompact } = useCurrency();

  useEffect(() => {
    if (!isSelfRegistered || !verifiedAt) return;
    const walletEmpty = strictAvailable === 0;
    if (!walletEmpty) return;
    try {
      const raw = localStorage.getItem(SNOOZE_KEY);
      const snoozeUntil = raw ? parseInt(raw, 10) : 0;
      if (snoozeUntil && Date.now() < snoozeUntil) return;
    } catch {}
    setShowActivationModal(true);
  }, [isSelfRegistered, verifiedAt, strictAvailable, SNOOZE_KEY]);

  const handleActivationDeposit = () => {
    setShowActivationModal(false);
    try { localStorage.removeItem(SNOOZE_KEY); } catch {}
    setTimeout(() => {
      const el = document.getElementById('funder-wallet-hero');
      if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
      setHighlightDeposit(true);
      setTimeout(() => setHighlightDeposit(false), 2500);
    }, 150);
  };

  const handleActivationSnooze = () => {
    try { localStorage.setItem(SNOOZE_KEY, String(Date.now() + 60 * 60 * 1000)); } catch {}
    setShowActivationModal(false);
  };

  // Local-first: read cache synchronously in useState init
  const [virtualHouses, setVirtualHouses] = useState<VirtualHouse[]>(() => {
    try {
      const raw = localStorage.getItem(`supporter_houses_${user.id}`);
      if (raw) return sortFunderHousesByCompleteness<VirtualHouse>(JSON.parse(raw).houses || []);
    } catch {}
    return [];
  });
  const [totalRentContributed, setTotalRentContributed] = useState(() => {
    try {
      const raw = localStorage.getItem(`supporter_houses_${user.id}`);
      if (raw) return JSON.parse(raw).totalRent || 0;
    } catch {}
    return 0;
  });
  const [totalRoiEarned, setTotalRoiEarned] = useState(0);

  // Agreement
  const { hasAccepted, acceptance, loading: agreementLoading, acceptAgreement } = useSupporterAgreement();
  const effectiveHasAccepted = localHasAccepted === true || hasAccepted === true;

  // Inactivity lock — only for users with active portfolios
  const hasActivePortfolios = totalRentContributed > 0;
  const { isLocked, unlock } = useInactivityLock({ enabled: hasActivePortfolios });

  const opportunitiesRefreshRef = useRef<(() => Promise<void>) | null>(null);

  // Show agreement modal on first load if not accepted
  useEffect(() => {
    if (hasAccepted === false && !agreementLoading && localHasAccepted !== true) {
      setShowAgreementModal(true);
    }
  }, [hasAccepted, agreementLoading, localHasAccepted]);

  const handleAcceptAgreement = async (): Promise<boolean> => {
    const success = await acceptAgreement();
    if (success) {
      setLocalHasAccepted(true);
      setJustAccepted(true);
      setShowAgreementModal(false);
      window.scrollTo({ top: 0, behavior: 'smooth' });
      toast({
        title: '🎉 Welcome to Welile Supporters!',
        description: 'Terms accepted.',
      });
      setTimeout(() => setJustAccepted(false), 5000);
    }
    return success;
  };

  // Cache already loaded synchronously in useState init above

  // Scroll to opportunities
  useEffect(() => {
    if (location.hash === '#opportunities') {
      // Opportunities now live in the full screen map sheet, so open it.
      const timer = setTimeout(openHousesMap, 100);
      return () => clearTimeout(timer);
    }
  }, [location.hash, openHousesMap]);

  // Listen for open-deposit event from OpportunitySummaryCard
  useEffect(() => {
    const handler = () => setShowPaymentPartners(true);
    window.addEventListener('open-deposit', handler);
    return () => window.removeEventListener('open-deposit', handler);
  }, []);

  // Deep-link entry: `?deposit=1` auto-opens the deposit flow once on mount
  // (used by the mobile bottom-nav Deposit FAB when navigating from another
  // page).
  useEffect(() => {
    try {
      const params = new URLSearchParams(window.location.search);
      if (params.get('deposit') === '1') {
        setShowPaymentPartners(true);
        params.delete('deposit');
        const qs = params.toString();
        window.history.replaceState(
          {},
          '',
          window.location.pathname + (qs ? `?${qs}` : '') + window.location.hash,
        );
      }
    } catch { /* ignore */ }
  }, []);

  // Fetch total contributions from ledger + investor_portfolios (bounded query)
  const fetchTotalContributed = useCallback(async () => {
    if (!user?.id) return;
    try {
      // Fetch from general_ledger (supporter_rent_fund entries)
      // Query portfolios by both investor_id and agent_id to cover all cases
      const [ledgerResult, portfolioByInvestor, portfolioByAgent] = await Promise.all([
        supabase
          .from('general_ledger')
          .select('amount')
          .eq('user_id', user.id)
          .eq('category', 'supporter_rent_fund')
          .eq('direction', 'cash_out')
          .limit(500),
        supabase
          .from('investor_portfolios')
          .select('id, investment_amount, total_roi_earned, roi_percentage')
          .eq('investor_id', user.id)
          .in('status', ['active', 'pending', 'pending_approval'])
          .limit(100),
        supabase
          .from('investor_portfolios')
          .select('id, investment_amount, total_roi_earned, roi_percentage')
          .eq('agent_id', user.id)
          .is('investor_id', null)
          .in('status', ['active', 'pending', 'pending_approval'])
          .limit(100),
      ]);

      // Merge portfolios (investor_id matches + agent_id with null investor_id)
      const allPortfolios = [
        ...(!portfolioByInvestor.error && portfolioByInvestor.data ? portfolioByInvestor.data : []),
        ...(!portfolioByAgent.error && portfolioByAgent.data ? portfolioByAgent.data : []),
      ];
      // Deduplicate by id
      const seen = new Set<string>();
      const portfolioResult = { data: allPortfolios.filter(p => { if (seen.has(p.id)) return false; seen.add(p.id); return true; }), error: null };

      const ledgerTotal = !ledgerResult.error && ledgerResult.data
        ? ledgerResult.data.reduce((sum, r) => sum + Number(r.amount), 0)
        : 0;

      const portfolioTotal = !portfolioResult.error && portfolioResult.data
        ? portfolioResult.data.reduce((sum, r) => sum + Number(r.investment_amount), 0)
        : 0;

      // Calculate expected monthly return from ROI% × capital
      const expectedMonthly = portfolioResult.data
        ? portfolioResult.data.reduce((sum, r) => sum + Number(r.investment_amount) * (Number(r.roi_percentage || 15) / 100), 0)
        : 0;
      setTotalRoiEarned(expectedMonthly);

      // Use portfolio total as source of truth — only actual investments
      // Ledger may include initial registration deposits which aren't investments
      setTotalRentContributed(portfolioTotal);
    } catch (err) {
      console.error('[SupporterDashboard] Failed to fetch contributions:', err);
    }
  }, [user?.id]);

  useEffect(() => { fetchTotalContributed(); }, [fetchTotalContributed]);

  // Auto-refresh when supporter contributes via Opportunity card or Categories
  useEffect(() => {
    const handler = () => { fetchTotalContributed(); refreshWallet(); };
    window.addEventListener('supporter-contribution-changed', handler);
    return () => window.removeEventListener('supporter-contribution-changed', handler);
  }, [fetchTotalContributed, refreshWallet]);

  const HOUSES_CACHE_TTL = 10 * 60 * 1000; // 10 minutes

  // Fetch funded houses — cache-first, lazy secondary data
  useEffect(() => {
    fetchMyHouses();
  }, [user.id]);

  const fetchMyHouses = async () => {
    // Always serve cache first
    if (hasCachedData) {
      setLoading(false);
      // Check TTL — skip network if fresh
      try {
        const cached = localStorage.getItem(`supporter_houses_${user.id}`);
        if (cached) {
          const { timestamp } = JSON.parse(cached);
          if (Date.now() - timestamp < HOUSES_CACHE_TTL) return;
        }
      } catch {}
    }

    if (!navigator.onLine) {
      setLoading(false);
      return;
    }

    if (!hasCachedData) setLoading(true);

    try {
      const { data, error } = await supabase
        .from('rent_requests')
        .select('id, rent_amount, duration_days, status, funded_at, updated_at, agent_id, request_city')
        .eq('supporter_id', user.id)
        .order('funded_at', { ascending: false })
        .limit(100);

      if (!error && data) {
        const houses: VirtualHouse[] = data.map(r => {
          const city = r.request_city || 'Uganda';

          let paymentHealth: 'green' | 'amber' | 'red' = 'green';
          if (r.status === 'funded' || r.status === 'disbursed') paymentHealth = 'amber';
          if (r.status === 'completed' || r.status === 'repaid') paymentHealth = 'green';
          if (r.status === 'defaulted' || r.status === 'overdue') paymentHealth = 'red';

          return {
            id: r.id,
            shortId: r.id.slice(0, 6).toUpperCase(),
            area: city,
            city,
            rentAmount: Number(r.rent_amount),
            paymentHealth,
            agentManaged: !!r.agent_id,
            updatedAt: r.updated_at || r.funded_at || new Date().toISOString(),
            status: r.status || 'funded',
            durationDays: r.duration_days,
          };
        });

        const totalRent = houses.reduce((sum, h) => sum + h.rentAmount, 0);
        setVirtualHouses(houses);
        setTotalRentContributed(prev => prev || totalRent); // fallback, prefer ledger
        setHasEverFunded(houses.length > 0);

        localStorage.setItem(`supporter_houses_${user.id}`, JSON.stringify({
          houses, totalRent, timestamp: Date.now(),
        }));
        setHasCachedData(true);
      }
    } catch (error) {
      console.error('[SupporterDashboard] Error:', error);
    }
    setLoading(false);
  };


  // Portfolio health
  const portfolioHealth = (() => {
    if (virtualHouses.length === 0) return 'stable' as const;
    const redCount = virtualHouses.filter(h => h.paymentHealth === 'red').length;
    if (redCount > 0) return 'at_risk' as const;
    const greenRatio = virtualHouses.filter(h => h.paymentHealth === 'green').length / virtualHouses.length;
    return greenRatio >= 0.8 ? 'growing' as const : 'stable' as const;
  })();

  const handleHouseTap = (id: string) => {
    const house = virtualHouses.find(h => h.id === id);
    if (house) {
      setSelectedHouse(house);
      setShowHouseDetails(true);
    }
  };

  if (loading && isOnline && !hasCachedData && false) {
    return <SupporterDashboardSkeleton />;
  }

  const handleRefresh = async () => {
    await Promise.all([
      fetchMyHouses(),
      opportunitiesRefreshRef.current?.()
    ]);
  };

  // Same dropdown menu as every other dashboard (DashboardHeader), with the
  // funder-specific actions from the old side drawer passed as menuItems.
  const supporterMenuItems = [
    { icon: CreditCard, label: 'Add Funds', onClick: () => setShowPaymentPartners(true) },
    { icon: Wallet, label: 'My Wallet', onClick: () => setShowFunderHub(true) },
    { icon: TrendingUp, label: 'My Portfolios', onClick: () => { setInvestmentsTab('accounts'); setShowInvestments(true); } },
    { icon: Home, label: 'Houses I Support', onClick: () => { setInvestmentsTab('accounts'); setShowInvestments(true); } },
    { icon: Bookmark, label: 'Saved Items', onClick: () => setShowSavedItems(true), badge: savedCount || undefined },
    { icon: Zap, label: 'Angel Pool', onClick: () => { setCapitalView('angel'); openHousesMap(); } },
    { icon: Calculator, label: 'Returns Calculator', onClick: () => setShowCalculator(true) },
    { icon: TrendingUp, label: 'Returns Analytics', onClick: () => navigate('/supporter-earnings') },
    { icon: History, label: 'History', onClick: () => navigate('/transactions') },
    { icon: FileText, label: 'Statement', onClick: () => navigate('/financial-statement') },
    { icon: Receipt, label: 'Receipts', onClick: () => navigate('/my-receipts') },
    { icon: Share2, label: 'Referrals', onClick: () => navigate('/referrals'), separator: true },
    { icon: ScrollText, label: 'Agreement', onClick: () => { setViewAgreementTab('summary'); setShowViewAgreementModal(true); } },
  ];

  // Mount each on-demand dialog the first time it is needed (see the lazy imports).
  const mountPayment = useMountedOnce(showPaymentPartners);
  const mountAgreement = useMountedOnce(showAgreementModal);
  const mountAgreementView = useMountedOnce(showViewAgreementModal);
  const mountHouseDetails = useMountedOnce(showHouseDetails);
  const mountMapDetail = useMountedOnce(!!mapDetailHouse);
  const mountMapFund = useMountedOnce(!!mapFundItem);
  const mountPackage = useMountedOnce(showPackageSheet);
  const mountHub = useMountedOnce(showFunderHub);
  const mountSaved = useMountedOnce(showSavedItems);
  const mountInvestments = useMountedOnce(showInvestments);
  const mountActivation = useMountedOnce(showActivationModal);

  // The houses map and the portfolio drawer are the likeliest next taps: fetch
  // their code once the page has settled. The inactivity lock is preloaded so it
  // appears at once when it fires.
  useEffect(() => {
    // The map is the page's main action, and its code also starts the Google Maps
    // key request, so it goes first; the rest can wait a little longer.
    const cancelMap = preloadWhenIdle([loadHousesMap, loadMapSheet, loadCapitalOpportunities], 800);
    const cancelRest = preloadWhenIdle(
      [loadInvestmentsDrawer, ...(hasActivePortfolios ? [loadInactivityLock] : [])],
      2500,
    );
    return () => { cancelMap(); cancelRest(); };
  }, [hasActivePortfolios]);

  return (
    <div className="h-dvh bg-background flex flex-col overflow-hidden">
      {/* Inactivity lock overlay */}
      {isLocked && (
        <Suspense fallback={<div className="fixed inset-0 z-[300] bg-background" aria-hidden="true" />}>
          <SupporterInactivityLock
            userEmail={user.email || ''}
            fullName={profile?.full_name}
            avatarUrl={profile?.avatar_url}
            onUnlock={unlock}
          />
        </Suspense>
      )}
      {!mapExpanded && (
        <DashboardHeader
          currentRole={currentRole}
          availableRoles={availableRoles}
          onRoleChange={onRoleChange}
          onSignOut={signOut}
          menuItems={supporterMenuItems}
          headerActions={<NotificationBell userId={user.id} />}
          compactInstallPrompt
        />
      )}

      <div className={cn("flex-1 min-h-0 overflow-y-auto overscroll-contain", !mapExpanded && "pb-nav")}>
        <main className="px-3 xs:px-4 py-3 xs:py-4 sm:py-5 space-y-3 sm:space-y-5 w-full min-w-0 max-w-lg mx-auto">
          {/* ═══ AIRBNB-STYLE PROFILE CARD ═══ */}
          {(() => {
            // The same market summary as the hero below (one shared request), not a
            // second copy fetched through the heavier portfolio hook.
            const s = marketSummary.data;
            const openHouses = s?.houseCount ?? 0;
            const rentNeeded = s?.totalRentNeeded ?? 0;
            const avgRent = s?.avgMonthlyRent ?? 0;
            return (
          <div className="rounded-2xl border border-border/40 bg-white p-5 shadow-[0_2px_16px_rgba(0,0,0,0.06)] dark:bg-card sm:p-6">
            <div className="flex items-start gap-5 sm:gap-6">
              {/* Left: Avatar + Name */}
              <div className="flex flex-col items-center text-center">
                <ProfileSummaryPopover
                  className="min-h-[72px] min-w-[72px] sm:min-h-[88px] sm:min-w-[88px]"
                  align="start"
                  avatarUrl={profile?.avatar_url}
                  fullName={displayFullName}
                  phone={(profile as any)?.phone}
                  email={(profile as any)?.email}
                  location={(profile as any)?.location}
                  verified={profile?.verified}
                  roleLabel="Funder"
                  triggerSize="lg"
                />
                <h1 className="mt-2 text-lg font-bold leading-tight sm:text-xl">{displayFirstName}</h1>
                <p className="text-[11px] text-muted-foreground font-medium">{(profile as any)?.location || 'Uganda'}</p>
              </div>

              {/* Right: Stats + action */}
              <div className="flex flex-1 flex-col items-end justify-between gap-2">
                <AiIdButton variant="compact" />
                <Button
                  variant="default"
                  size="default"
                  className="rounded-full px-6 text-sm font-semibold gap-2"
                  onClick={() => navigate('/dashboard/funder/portfolio')}
                >
                  <Wallet className="h-4 w-4" />
                  View portfolio
                </Button>
              </div>
            </div>

            {/* Bottom summary strip */}
            <div className="mt-4 flex items-center gap-4 border-t border-border/40 pt-3">
              <p className="text-[11px] font-medium leading-snug text-muted-foreground">
                <span className="font-bold text-green-600 dark:text-green-400">{openHouses.toLocaleString()}</span> {openHouses === 1 ? 'house' : 'houses'} waiting
                {avgRent > 0 && <> · avg <span className="font-bold text-foreground">{formatAmountCompact(avgRent)}</span>/mo</>}
              </p>
            </div>
          </div>
            );
          })()}

          {/* ═══ MARKET HERO (same section as /dashboard/funder-new) ═══ */}
          <FunderNewHero
            summary={marketSummary.data}
            isLoading={marketSummary.isLoading}
            hasError={marketSummary.isError}
            onHowItWorks={() => {}}
            onOpen={openHousesMap}
            onIntent={preloadHousesMapCode}
          />

          {/* ═══ MAP SECTION (Google Maps as in /dashboard/funder-new) ═══ */}
          {mapRequested && (
            <Suspense fallback={null}>
            <FunderNewMapSection
              filters={mapFilters}
              location={mapLocation}
              origin={mapOrigin}
              selectedIds={[]}
              savedIds={[]}
              activeId={null}
              heading="Search for houses to fund"
              headingClassName="text-base font-bold text-green-600 dark:text-green-400"
              onOpenHouse={(house) => setMapDetailHouse(house)}
              onApplyArea={applyMapArea}
              onAreaSearchChange={handleMapSearchChange}
              onExpandedChange={handleMapExpandedChange}
              expandRequest={mapExpandRequest}
              reserveTopForSearch
              focus={mapFocus}
            />
            </Suspense>
          )}

          {/* ═══ SECTION: OPPORTUNITIES ═══ */}
          {mapExpanded && (
            <Suspense fallback={null}>
            <MapBottomSheet
              defaultSnap="half"
              header={({ snap, setSnap }) => (
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <p className="text-[15px] font-bold text-foreground">
                      Houses to fund
                    </p>
                    <span className="rounded-full bg-primary/10 px-2 py-0.5 text-[11px] font-semibold text-primary">
                      {virtualHouses.length > 0 ? `${virtualHouses.length} waiting` : 'Waiting'}
                    </span>
                  </div>
                  <button
                    type="button"
                    onClick={() => setSnap(snap === 'full' ? 'half' : snap === 'half' ? 'collapsed' : 'half')}
                    className="flex items-center gap-1 rounded-full bg-muted px-3 py-1.5 text-xs font-semibold text-foreground touch-manipulation transition active:scale-95 hover:bg-muted/70"
                  >
                    <span>{snap === 'full' ? 'Show map' : snap === 'half' ? 'Minimize' : 'Expand'}</span>
                    {snap === 'collapsed' ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
                  </button>
                </div>
              )}
            >
              <div id="opportunities" className="relative space-y-2.5 pb-8">
                {!effectiveHasAccepted && <LockedOverlay onAcceptClick={() => setShowAgreementModal(true)} />}
                <WidgetErrorBoundary label="Capital opportunities">
                  {loading && virtualHouses.length === 0 ? (
                    <div className="space-y-3">
                      <WidgetCardSkeleton />
                      <WidgetCardSkeleton />
                    </div>
                  ) : (
                    <>
                      <FunderApprovalBanner className="mb-3" />
                      <Suspense fallback={<WidgetCardSkeleton />}>
                      <FunderCapitalOpportunities
                        searchOnMap
                        onListFiltersChange={handleListFiltersChange}
                        onListResultsFocus={handleListResultsFocus}
                        key={`${capitalView}-${capitalFeedOrder}`}
                        initialView={capitalView}
                        initialFeedOrder={capitalFeedOrder}
                        embedded
                      />
                      </Suspense>
                    </>
                  )}
                </WidgetErrorBoundary>
              </div>
            </MapBottomSheet>
            </Suspense>
          )}

        </main>
      </div>
      {mountPayment && (
      <Suspense fallback={null}>
      <PaymentPartnersDialog 
        open={showPaymentPartners} 
        onOpenChange={setShowPaymentPartners}
        dashboardType="supporter"
        title="Add Funds"
      />
      </Suspense>
      )}

      {mountAgreement && (
      <Suspense fallback={null}>
      <SupporterAgreementModal
        open={showAgreementModal}
        onOpenChange={setShowAgreementModal}
        onAccept={handleAcceptAgreement}
        loading={agreementLoading}
      />
      </Suspense>
      )}

      {mountAgreementView && (
      <Suspense fallback={null}>
      <SupporterAgreementViewModal
        open={showViewAgreementModal}
        onOpenChange={setShowViewAgreementModal}
        defaultTab={viewAgreementTab}
      />
      </Suspense>
      )}

      <Dialog open={showCalculator} onOpenChange={setShowCalculator}>
        <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto p-0 [&>button]:fixed [&>button]:right-4 [&>button]:top-4 [&>button]:z-[200] [&>button]:bg-background/90 [&>button]:shadow-md">
          <div className="flex items-center justify-center px-4 pt-6 pb-2">
            <img
              src={calculatorIllustration.url}
              alt="Earnings calculator"
              loading="lazy"
              className="h-28 w-auto sm:h-36"
            />
          </div>
          <DialogHeader className="p-4 pb-0 pt-0">
            <DialogTitle className="flex items-center gap-2 text-base font-bold">
              <Calculator className="h-4 w-4" />
              Earnings Calculator
            </DialogTitle>
          </DialogHeader>
          <div className="p-4 pt-2">
            <Suspense fallback={null}>
              <InvestmentCalculator />
            </Suspense>
          </div>
        </DialogContent>
      </Dialog>
      

      {mountHouseDetails && (
      <Suspense fallback={null}>
      <VirtualHouseDetailsSheet
        house={selectedHouse}
        open={showHouseDetails}
        onOpenChange={setShowHouseDetails}
      />
      </Suspense>
      )}

      {mountMapDetail && (
      <Suspense fallback={null}>
      <EmptyHouseDetailSheet
        house={mapDetailHouse as any}
        open={!!mapDetailHouse}
        onOpenChange={(open) => {
          if (!open) setMapDetailHouse(null);
        }}
        isPartner
        remaining={strictAvailable ?? undefined}
        onRelatedHouseClick={(h) => setMapDetailHouse(h as any)}
        onFund={(h: any) => {
          const cost = Number(h?.monthly_rent || 0);
          const avail = Number(strictAvailable ?? 0);
          setMapDetailHouse(null);
          if (avail < cost) {
            // Not enough balance: prompt a deposit / top-up.
            toast({
              title: 'Not enough balance',
              description: `Deposit ${_formatUGX(Math.ceil(cost - avail))} to fund this house.`,
            });
            setShowPaymentPartners(true);
            return;
          }
          // Enough balance: open the funding confirmation for this house.
          setMapFundItem(h as FunderNewEmptyHouse);
        }}
      />
      </Suspense>
      )}

      {mountMapFund && (
      <Suspense fallback={null}>
      <FunderNewReviewDialog
        open={!!mapFundItem}
        onOpenChange={(o) => { if (!o) setMapFundItem(null); }}
        items={mapFundItem ? [toSelectionItem('empty', mapFundItem)] : []}
        available={strictAvailable ?? null}
        walletLoading={false}
        walletError={null}
        onRemove={() => setMapFundItem(null)}
        onTopUp={() => { setMapFundItem(null); setShowPaymentPartners(true); }}
        onViewPortfolio={() => { setInvestmentsTab('accounts'); setShowInvestments(true); }}
        onFund={async (_total) => {
          if (!mapFundItem) return;
          try {
            const houseIds = [mapFundItem.house_id];
            const { data, error } = await supabase.rpc('agent_create_promissory_note_for_houses', {
              p_payload: {
                partner_name: (profile?.full_name || '').trim(),
                whatsapp_number: (profile?.phone || '').trim(),
                phone_number: (profile?.phone || '').trim() || null,
                email: (profile?.email || user.email || '').trim() || null,
                amount: Number(mapFundItem.monthly_rent || 0),
                contribution_type: 'once_off',
              },
              p_house_ids: houseIds,
            });
            if (error) throw error;
            const note = ((data ?? {}) as { note?: { id: string } }).note;
            if (!note) throw new Error('Booking was not created');
            const { error: fundErr } = await supabase.rpc('funder_fund_booked_houses', {
              p_house_ids: houseIds,
              p_idempotency_key: `fund-${note.id}`,
            });
            if (fundErr) throw fundErr;
            window.dispatchEvent(new Event('supporter-contribution-changed'));
            setMapFundItem(null);
            // Hand the outcome back so the confirmation dialog can turn into its
            // own success view; a toast alone disappears before it is read.
            return { submitted: true, reference: note.id };
          } catch (err: unknown) {
            toast({ title: 'Could not submit support', description: String((err as { message?: string })?.message || 'Please try again.'), variant: 'destructive' });
            throw err;
          }
        }}
      />
      </Suspense>
      )}

      {mountPackage && (
      <Suspense fallback={null}>
      <InvestmentPackageSheet
        open={showPackageSheet}
        onOpenChange={setShowPackageSheet}
        category={selectedPackageCategory}
        onAcceptAndDeposit={() => setShowPaymentPartners(true)}
      />
      </Suspense>
      )}

      {mountHub && (
      <Suspense fallback={null}>
      <FunderWalletHubSection open={showFunderHub} onOpenChange={setShowFunderHub} />
      </Suspense>
      )}

      {mountSaved && (
      <Suspense fallback={null}>
      <FunderSavedItemsDialog open={showSavedItems} onOpenChange={setShowSavedItems} />
      </Suspense>
      )}

      {mountInvestments && (
      <Suspense fallback={null}>
      <InvestmentAccountsDrawer
        open={showInvestments}
        onOpenChange={(o) => { setShowInvestments(o); if (!o) setFocusPortfolioId(null); }}
        defaultTab={investmentsTab}
        initialPortfolioId={focusPortfolioId}
      />
      </Suspense>
      )}

      {mountActivation && (
      <Suspense fallback={null}>
      <FunderActivationModal
        open={showActivationModal}
        onOpenChange={setShowActivationModal}
        onDepositClick={handleActivationDeposit}
        onSnooze={handleActivationSnooze}
      />
      </Suspense>
      )}


    </div>
  );
}
