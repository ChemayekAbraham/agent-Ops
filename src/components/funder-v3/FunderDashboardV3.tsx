import calculatorIllustration from '@/assets/calculator-illustration.svg.asset.json';
import { Suspense, useCallback, useEffect, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useLocation, useNavigate } from 'react-router-dom';
import type { User } from '@supabase/supabase-js';
import { Bookmark, Calculator, CreditCard, FileText, History, Home, Receipt, ScrollText, Share2, TrendingUp, Wallet, Zap } from 'lucide-react';
import DashboardHeader from '@/components/DashboardHeader';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { ProfileSummaryPopover } from '@/components/profile/ProfileSummaryPopover';
import AiIdButton from '@/components/ai-id/AiIdButton';
import { NotificationBell } from '@/components/supporter/NotificationBell';
import { FunderApprovalBanner } from '@/components/supporter/FunderApprovalGate';
import { LockedOverlay } from '@/components/supporter/agreement';
import { WidgetErrorBoundary } from '@/components/shared/WidgetErrorBoundary';
import type { AppRole } from '@/hooks/useAuth';
import { useProfile } from '@/hooks/useProfile';
import { useToast } from '@/hooks/use-toast';
import { useWallet } from '@/hooks/useWallet';
import { useAvailableBalance } from '@/hooks/useAvailableBalance';
import { useSupporterAgreement } from '@/hooks/useSupporterAgreement';
import { useTrackSection } from '@/hooks/useTrackSection';
import { useFunderNudges } from '@/hooks/useFunderNudges';
import { useFunderSavedItems } from '@/hooks/useFunderSavedItems';
import { useFunderBookedHouses } from '@/hooks/useFunderBookedHouses';
import { useFunderApprovalStatus } from '@/hooks/useFunderApprovalStatus';
import { useInactivityLock } from '@/hooks/useInactivityLock';
import { useCurrency } from '@/hooks/useCurrency';
import { useMountedOnce } from '@/hooks/useMountedOnce';
import { useFunderEmptyHousesAllowed } from '@/hooks/useFunderEmptyHousesSwitch';
import { userBehaviourTracker } from '@/lib/userBehaviourTracker';
import { lazyNamed, lazyWithRetry } from '@/lib/lazyWithRetry';
import { preloadWhenIdle } from '@/lib/idlePreload';
import { useFunderNewMarketSummary } from '@/components/funder-new/useFunderNewOpportunities';
import { FunderV3Home } from './FunderV3Home';
import { useFunderV3PortfolioActivity } from './useFunderV3PortfolioActivity';
import './funderV3.css';

// Everything behind a tap loads on demand, as on the live dashboard.
const loadListings = () => import('@/components/supporter/FunderHouseListingsSection');
const loadScreen = () => import('./FunderV3HousesScreen');
const loadMap = () => import('./FunderV3Map');
const loadInvestmentsDrawer = () => import('@/components/supporter/InvestmentAccountsDrawer');
const loadInactivityLock = () => import('@/components/supporter/SupporterInactivityLock');
const FunderHouseListingsSection = lazyNamed(loadListings, 'FunderHouseListingsSection');
const FunderV3HousesScreen = lazyNamed(loadScreen, 'FunderV3HousesScreen');
const FunderV3Map = lazyNamed(loadMap, 'FunderV3Map');
const PaymentPartnersDialog = lazyWithRetry(() => import('@/components/payments/PaymentPartnersDialog'));
const FunderWalletHubSection = lazyWithRetry(() => import('@/components/supporter/FunderWalletHubSection'));
const InvestmentCalculator = lazyNamed(() => import('@/components/supporter/InvestmentCalculator'), 'InvestmentCalculator');
const SupporterAgreementModal = lazyNamed(() => import('@/components/supporter/agreement/SupporterAgreementModal'), 'SupporterAgreementModal');
const SupporterAgreementViewModal = lazyNamed(() => import('@/components/supporter/agreement/SupporterAgreementCard'), 'SupporterAgreementViewModal');
const FunderSavedItemsDialog = lazyNamed(() => import('@/components/funder-new/FunderSavedItemsDialog'), 'FunderSavedItemsDialog');
const FunderActivationModal = lazyNamed(() => import('@/components/supporter/FunderActivationModal'), 'FunderActivationModal');
const FunderCapitalOpportunities = lazyNamed(() => import('@/components/supporter/FunderCapitalOpportunities'), 'FunderCapitalOpportunities');
const InvestmentAccountsDrawer = lazyNamed(loadInvestmentsDrawer, 'InvestmentAccountsDrawer');
const SupporterInactivityLock = lazyNamed(loadInactivityLock, 'SupporterInactivityLock');

const preloadHousesCode = () => {
  void loadListings().catch(() => {});
  void loadScreen().catch(() => {});
  void loadMap().catch(() => {});
};

export interface FunderDashboardV3Props {
  user: User;
  signOut: () => Promise<void>;
  currentRole: AppRole;
  availableRoles: AppRole[];
  onRoleChange: (role: AppRole) => void;
  addRoleComponent: ReactNode;
}

/**
 * Funder (Partner) dashboard, V3 presentation. Shown only to viewers with the
 * `funders_ui_v3` preview switch on (and at /dashboard/funder-v3 for review).
 *
 * The data side is the live dashboard's: the same hooks, the same listing
 * section (data, filters, funding dialogs) through its `view` prop, the same
 * dialogs. Only the layout is new.
 */
export default function FunderDashboardV3({ user, signOut, currentRole, availableRoles, onRoleChange }: FunderDashboardV3Props) {
  useTrackSection('supporter-overview', 'supporter');
  useFunderNudges(user?.id);

  const navigate = useNavigate();
  const location = useLocation();
  const { toast } = useToast();
  const { profile, loading: profileLoading } = useProfile();
  const metaFullName = (user?.user_metadata?.full_name as string | undefined)?.trim() || '';
  const emailLocal = (user?.email || '').split('@')[0] || '';
  const displayFullName = profile?.full_name?.trim() || metaFullName || emailLocal;
  const displayFirstName = displayFullName ? displayFullName.split(' ')[0] : (profileLoading ? '' : 'Supporter');

  const { refreshWallet } = useWallet();
  const { available: strictAvailable } = useAvailableBalance(user.id);
  const { formatAmountCompact } = useCurrency();
  const marketSummary = useFunderNewMarketSummary();
  const emptyHousesAllowed = useFunderEmptyHousesAllowed();
  const portfolio = useFunderV3PortfolioActivity(user);

  const [housesOpen, setHousesOpen] = useState(false);
  const [mapFocus, setMapFocus] = useState<{ points: { lat: number; lng: number }[]; token: number } | null>(null);
  const [showPaymentPartners, setShowPaymentPartners] = useState(false);
  const [showAgreementModal, setShowAgreementModal] = useState(false);
  const [showViewAgreementModal, setShowViewAgreementModal] = useState(false);
  const [viewAgreementTab, setViewAgreementTab] = useState<'summary' | 'full'>('summary');
  const [localHasAccepted, setLocalHasAccepted] = useState<boolean | null>(null);
  const [showCalculator, setShowCalculator] = useState(false);
  const [showSavedItems, setShowSavedItems] = useState(false);
  const [showFunderHub, setShowFunderHub] = useState(false);
  const [showInvestments, setShowInvestments] = useState(false);
  const [showAngelPool, setShowAngelPool] = useState(false);
  const [investmentsTab, setInvestmentsTab] = useState<'accounts' | 'angel'>('accounts');
  const [focusPortfolioId, setFocusPortfolioId] = useState<string | null>(null);

  const { count: bookmarkedCount } = useFunderSavedItems();
  const { heldCount: bookedCount } = useFunderBookedHouses();
  const savedCount = bookmarkedCount + bookedCount;

  const openHouses = useCallback(() => setHousesOpen(true), []);
  const closeHouses = useCallback(() => {
    setHousesOpen(false);
    setMapFocus(null);
  }, []);
  const handleListResultsFocus = useCallback((points: { lat: number; lng: number }[]) => {
    setMapFocus((prev) => ({ points, token: (prev?.token ?? 0) + 1 }));
  }, []);

  // Same telemetry sections as the live dashboard.
  useEffect(() => {
    if (showFunderHub) userBehaviourTracker.setSection('supporter-hub', 'supporter');
    else if (showInvestments) userBehaviourTracker.setSection('supporter-investments', 'supporter');
    else if (showCalculator) userBehaviourTracker.setSection('supporter-calculator', 'supporter');
    else userBehaviourTracker.setSection('supporter-overview', 'supporter');
  }, [showFunderHub, showInvestments, showCalculator]);

  // ─── Funder activation modal (self-registered + just approved + empty wallet) — as live ───
  const { isSelfRegistered, verifiedAt } = useFunderApprovalStatus(user.id);
  const [showActivationModal, setShowActivationModal] = useState(false);
  const SNOOZE_KEY = `funder_activation_snooze_${user.id}`;
  useEffect(() => {
    if (!isSelfRegistered || !verifiedAt) return;
    if (strictAvailable !== 0) return;
    try {
      const raw = localStorage.getItem(SNOOZE_KEY);
      const snoozeUntil = raw ? parseInt(raw, 10) : 0;
      if (snoozeUntil && Date.now() < snoozeUntil) return;
    } catch { /* storage unavailable */ }
    setShowActivationModal(true);
  }, [isSelfRegistered, verifiedAt, strictAvailable, SNOOZE_KEY]);
  const handleActivationDeposit = () => {
    setShowActivationModal(false);
    try { localStorage.removeItem(SNOOZE_KEY); } catch { /* storage unavailable */ }
    setShowPaymentPartners(true);
  };
  const handleActivationSnooze = () => {
    try { localStorage.setItem(SNOOZE_KEY, String(Date.now() + 60 * 60 * 1000)); } catch { /* storage unavailable */ }
    setShowActivationModal(false);
  };

  // ─── Agreement — as live ───
  const { hasAccepted, loading: agreementLoading, acceptAgreement } = useSupporterAgreement();
  const effectiveHasAccepted = localHasAccepted === true || hasAccepted === true;
  useEffect(() => {
    if (hasAccepted === false && !agreementLoading && localHasAccepted !== true) setShowAgreementModal(true);
  }, [hasAccepted, agreementLoading, localHasAccepted]);
  const handleAcceptAgreement = async (): Promise<boolean> => {
    const success = await acceptAgreement();
    if (success) {
      setLocalHasAccepted(true);
      setShowAgreementModal(false);
      window.scrollTo({ top: 0, behavior: 'smooth' });
      toast({ title: '🎉 Welcome to Welile Supporters!', description: 'Terms accepted.' });
    }
    return success;
  };

  // ─── Inactivity lock — only for users with active portfolios (same read as live) ───
  const { isLocked, unlock } = useInactivityLock({ enabled: portfolio.hasActivePortfolios });

  // #opportunities opens the houses screen, as it opens the map on the live dashboard.
  useEffect(() => {
    if (location.hash === '#opportunities') {
      const timer = setTimeout(openHouses, 100);
      return () => clearTimeout(timer);
    }
  }, [location.hash, openHouses]);

  useEffect(() => {
    const handler = () => setShowPaymentPartners(true);
    window.addEventListener('open-deposit', handler);
    return () => window.removeEventListener('open-deposit', handler);
  }, []);

  // `?deposit=1` deep link — as live.
  useEffect(() => {
    try {
      const params = new URLSearchParams(window.location.search);
      if (params.get('deposit') === '1') {
        setShowPaymentPartners(true);
        params.delete('deposit');
        const qs = params.toString();
        window.history.replaceState({}, '', window.location.pathname + (qs ? `?${qs}` : '') + window.location.hash);
      }
    } catch { /* ignore */ }
  }, []);

  const { fetchTotalContributed } = portfolio;
  useEffect(() => {
    const handler = () => { void fetchTotalContributed(); refreshWallet(); };
    window.addEventListener('supporter-contribution-changed', handler);
    return () => window.removeEventListener('supporter-contribution-changed', handler);
  }, [fetchTotalContributed, refreshWallet]);

  useEffect(() => {
    const cancelHouses = preloadWhenIdle([loadListings, loadScreen, loadMap], 800);
    const cancelRest = preloadWhenIdle([loadInvestmentsDrawer, ...(portfolio.hasActivePortfolios ? [loadInactivityLock] : [])], 2500);
    return () => { cancelHouses(); cancelRest(); };
  }, [portfolio.hasActivePortfolios]);

  // Same menu as the live dashboard.
  const menuItems = [
    { icon: CreditCard, label: 'Add Funds', onClick: () => setShowPaymentPartners(true) },
    { icon: Wallet, label: 'My Wallet', onClick: () => setShowFunderHub(true) },
    { icon: TrendingUp, label: 'My Portfolios', onClick: () => { setInvestmentsTab('accounts'); setShowInvestments(true); } },
    { icon: Home, label: 'Houses I Support', onClick: () => { setInvestmentsTab('accounts'); setShowInvestments(true); } },
    { icon: Bookmark, label: 'Saved Items', onClick: () => setShowSavedItems(true), badge: savedCount || undefined },
    { icon: Zap, label: 'Angel Pool', onClick: () => setShowAngelPool(true) },
    { icon: Calculator, label: 'Returns Calculator', onClick: () => setShowCalculator(true) },
    { icon: TrendingUp, label: 'Returns Analytics', onClick: () => navigate('/supporter-earnings') },
    { icon: History, label: 'History', onClick: () => navigate('/transactions') },
    { icon: FileText, label: 'Statement', onClick: () => navigate('/financial-statement') },
    { icon: Receipt, label: 'Receipts', onClick: () => navigate('/my-receipts') },
    { icon: Share2, label: 'Referrals', onClick: () => navigate('/referrals'), separator: true },
    { icon: ScrollText, label: 'Agreement', onClick: () => { setViewAgreementTab('summary'); setShowViewAgreementModal(true); } },
  ];

  const mountPayment = useMountedOnce(showPaymentPartners);
  const mountAgreement = useMountedOnce(showAgreementModal);
  const mountAgreementView = useMountedOnce(showViewAgreementModal);
  const mountHub = useMountedOnce(showFunderHub);
  const mountSaved = useMountedOnce(showSavedItems);
  const mountInvestments = useMountedOnce(showInvestments);
  const mountActivation = useMountedOnce(showActivationModal);
  const mountAngel = useMountedOnce(showAngelPool);

  const s = marketSummary.data;
  const openHouseCount = s?.houseCount ?? 0;
  const avgRent = s?.avgMonthlyRent ?? 0;

  return (
    <div className="flex h-dvh flex-col overflow-hidden bg-background">
      {isLocked && (
        <Suspense fallback={<div className="fixed inset-0 z-[300] bg-background" aria-hidden="true" />}>
          <SupporterInactivityLock userEmail={user.email || ''} fullName={profile?.full_name} avatarUrl={profile?.avatar_url} onUnlock={unlock} />
        </Suspense>
      )}
      {!housesOpen && (
        <DashboardHeader
          currentRole={currentRole}
          availableRoles={availableRoles}
          onRoleChange={onRoleChange}
          onSignOut={signOut}
          menuItems={menuItems}
          headerActions={<NotificationBell userId={user.id} />}
          compactInstallPrompt
        />
      )}

      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain pb-nav">
        <FunderV3Home
          avatar={
            <ProfileSummaryPopover
              className="min-h-[72px] min-w-[72px] sm:min-h-[88px] sm:min-w-[88px]"
              align="start"
              avatarUrl={profile?.avatar_url}
              fullName={displayFullName}
              phone={(profile as { phone?: string } | null)?.phone}
              email={(profile as { email?: string } | null)?.email}
              location={(profile as { location?: string } | null)?.location}
              verified={profile?.verified}
              roleLabel="Funder"
              triggerSize="lg"
            />
          }
          aiId={<AiIdButton variant="compact" />}
          firstName={displayFirstName}
          locationLabel={(profile as { location?: string } | null)?.location || 'Uganda'}
          openHouses={openHouseCount}
          avgRentLabel={avgRent > 0 ? formatAmountCompact(avgRent) : null}
          onViewPortfolio={() => navigate('/dashboard/funder/portfolio')}
          summary={marketSummary.data}
          summaryLoading={marketSummary.isLoading}
          summaryError={marketSummary.isError}
          emptyHousesAllowed={emptyHousesAllowed}
          onOpenHouses={openHouses}
          onIntent={preloadHousesCode}
        />
      </div>

      {housesOpen && (
        <WidgetErrorBoundary label="Capital opportunities">
          <Suspense fallback={<div className="fv3-screen fixed inset-0 z-[70] bg-background" aria-busy="true" />}>
            <FunderHouseListingsSection
              onResultsFocus={handleListResultsFocus}
              view={(api) =>
                createPortal(
                  <Suspense fallback={<div className="fv3-screen fixed inset-0 z-[70] bg-background" aria-busy="true" />}>
                    <FunderV3HousesScreen
                      api={api}
                      onClose={closeHouses}
                      listLoadingOverride={portfolio.loading && portfolio.virtualHouses.length === 0}
                      listTop={<FunderApprovalBanner />}
                      listOverlay={!effectiveHasAccepted ? <LockedOverlay onAcceptClick={() => setShowAgreementModal(true)} /> : null}
                      renderMap={(mapProps) => (
                        <FunderV3Map filters={api.filters} location={api.location} focus={mapFocus} {...mapProps} />
                      )}
                    />
                  </Suspense>,
                  document.body,
                )
              }
            />
          </Suspense>
        </WidgetErrorBoundary>
      )}

      {mountPayment && (
        <Suspense fallback={null}>
          <PaymentPartnersDialog open={showPaymentPartners} onOpenChange={setShowPaymentPartners} dashboardType="supporter" title="Add Funds" />
        </Suspense>
      )}

      {mountAgreement && (
        <Suspense fallback={null}>
          <SupporterAgreementModal open={showAgreementModal} onOpenChange={setShowAgreementModal} onAccept={handleAcceptAgreement} loading={agreementLoading} />
        </Suspense>
      )}

      {mountAgreementView && (
        <Suspense fallback={null}>
          <SupporterAgreementViewModal open={showViewAgreementModal} onOpenChange={setShowViewAgreementModal} defaultTab={viewAgreementTab} />
        </Suspense>
      )}

      <Dialog open={showCalculator} onOpenChange={setShowCalculator}>
        <DialogContent className="max-h-[90dvh] max-w-lg overflow-y-auto p-0 [&>button]:fixed [&>button]:right-4 [&>button]:top-4 [&>button]:z-[200] [&>button]:bg-background/90 [&>button]:shadow-md">
          <div className="flex items-center justify-center px-4 pb-2 pt-6">
            <img src={calculatorIllustration.url} alt="Earnings calculator" loading="lazy" decoding="async" width={144} height={144} className="h-28 w-auto sm:h-36" />
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

      {mountAngel && (
        <Dialog open={showAngelPool} onOpenChange={setShowAngelPool}>
          <DialogContent className="max-h-[90dvh] max-w-lg overflow-y-auto p-4">
            <DialogHeader className="sr-only">
              <DialogTitle>Angel Pool</DialogTitle>
            </DialogHeader>
            <Suspense fallback={null}>
              <FunderCapitalOpportunities initialView="angel" embedded />
            </Suspense>
          </DialogContent>
        </Dialog>
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
          <FunderActivationModal open={showActivationModal} onOpenChange={setShowActivationModal} onDepositClick={handleActivationDeposit} onSnooze={handleActivationSnooze} />
        </Suspense>
      )}
    </div>
  );
}
