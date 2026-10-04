// FROZEN BACKUP of the Funder dashboard. Served at /dashboard/funders/bk.
//
// ┌──────────────────────────────────────────────────────────────────────┐
// │ THIS IS DELIBERATELY NOT THE CURRENT DASHBOARD. DO NOT "REFRESH" IT. │
// └──────────────────────────────────────────────────────────────────────┘
//
// Snapshot of src/components/dashboards/SupporterDashboard.tsx as it stood at
// commit 7bc380053a (18 September 2026) — BEFORE the redesign that landed in
// the 1197 commits synced on 21 September and cut the live file from 699 lines
// to 605. Preserving that pre-redesign state is the entire purpose of this
// file. It was taken on 21 September at the owner's request, explicitly ahead
// of syncing, so the old dashboard would survive the new one landing.
//
// It was once re-taken against the post-sync file by mistake, on the reasoning
// that a backup should match what is live. That reasoning is wrong here: a
// backup that tracks the thing it is backing up is not a backup. Reverted.
//
// Identical to SupporterDashboard.tsx at 7bc380053a except:
//   * the component and its props interface are renamed (…Backup) so both can
//     be imported into the same build
//   * console prefixes read [SupporterDashboard.backup] so the two are
//     distinguishable in logs
//
// Do NOT develop against this file — edits here are invisible to real funders,
// who are served by SupporterDashboard.tsx at /dashboard/funder.
//
// SCOPE — READ THIS BEFORE RELYING ON IT. This freezes the dashboard SHELL
// only. Every child component (PortfolioSummaryCards, VirtualHousesFeed,
// FunderWalletHubSection, the agreement modals, …), every hook (useWallet,
// useProfile, useSupporterAgreement, …) and every RPC it calls are SHARED with
// the live dashboard and are NOT frozen. All of them still resolved as at
// 21 September; if one is later deleted or changed, this file breaks or
// changes with it. It protects the page's own layout and composition, nothing
// deeper.
//
// To restore: copy this file over SupporterDashboard.tsx and undo the renames.
import calculatorIllustration from "@/assets/calculator-illustration.svg.asset.json";
import { useState, useEffect, useRef, useCallback } from 'react';
import { AngelSharesTab } from '@/components/supporter/AngelSharesTab';
import { useConfetti } from '@/components/Confetti';
import { useNavigate, useLocation } from 'react-router-dom';
import { User } from '@supabase/supabase-js';
import { supabase } from '@/integrations/supabase/client';
import { useOffline } from '@/contexts/OfflineContext';
import { Button } from '@/components/ui/button';
import { 
  CreditCard, Calculator, FileText, ChevronDown, BadgeCheck, Wallet, ChevronRight
} from 'lucide-react';
import { Collapsible, CollapsibleTrigger, CollapsibleContent } from '@/components/ui/collapsible';
import { Badge } from '@/components/ui/badge';
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
import { FullScreenWalletSheet } from '@/components/wallet/FullScreenWalletSheet';
import FunderWalletHubSection from '@/components/supporter/FunderWalletHubSection';
import PaymentPartnersDialog from '@/components/payments/PaymentPartnersDialog';
import { InvestmentCalculator } from '@/components/supporter/InvestmentCalculator';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';

// Agreement
import { useSupporterAgreement } from '@/hooks/useSupporterAgreement';
import { 
  SupporterAgreementModal, 
  LockedOverlay,
  AgreementAcceptedBadge
} from '@/components/supporter/agreement';
import { SupporterAgreementViewModal } from '@/components/supporter/agreement/SupporterAgreementCard';

// Menu drawer
import { SupporterMenuDrawer } from '@/components/supporter/SupporterMenuDrawer';
import { hapticTap } from '@/lib/haptics';
// motion removed — static rendering for low-end devices

// Virtual Houses components
import { PortfolioSummaryCards } from '@/components/supporter/PortfolioSummaryCards';
import { VirtualHousesFeed } from '@/components/supporter/VirtualHousesFeed';
import { VirtualHouse } from '@/components/supporter/VirtualHouseCard';
import { VirtualHouseDetailsSheet } from '@/components/supporter/VirtualHouseDetailsSheet';
import { RentCategoryFeed, RentCategory } from '@/components/supporter/RentCategoryFeed';
import { CreditRequestsFeed } from '@/components/supporter/CreditRequestsFeed';
import { InvestmentPackageSheet } from '@/components/supporter/InvestmentPackageSheet';
// FundingPoolCard removed from direct import
import { FunderCapitalOpportunities } from '@/components/supporter/FunderCapitalOpportunities';
import { PartnerPortfolioSection } from '@/components/supporter/portfolio/PartnerPortfolioSection';
import { SupportedHouseReturnsSection } from '@/components/supporter/SupportedHouseReturnsSection';

import { PartnerPortfolioWalletCard } from '@/components/supporter/portfolio/PartnerPortfolioWalletCard';

import { useSupportedTenants } from '@/hooks/useSupportedTenants';

import { InvestmentAccountsDrawer } from '@/components/supporter/InvestmentAccountsDrawer';
import { FunderApprovalBanner } from '@/components/supporter/FunderApprovalGate';

import { FunderActivationModal } from '@/components/supporter/FunderActivationModal';
import { useFunderApprovalStatus } from '@/hooks/useFunderApprovalStatus';

import AiIdButton from '@/components/ai-id/AiIdButton';
import { NotificationBell } from '@/components/supporter/NotificationBell';
import { InviteAndEarnCard } from '@/components/shared/InviteAndEarnCard';
import { useInactivityLock } from '@/hooks/useInactivityLock';
import { SupporterInactivityLock } from '@/components/supporter/SupporterInactivityLock';
import { WidgetErrorBoundary } from '@/components/shared/WidgetErrorBoundary';
import {
  WidgetCardSkeleton,
  ListSectionSkeleton,
} from '@/components/skeletons/SectionSkeletons';
import { MissionBanner } from '@/components/mission/MissionBanner';


interface SupporterDashboardBackupProps {
  user: User;
  signOut: () => Promise<void>;
  currentRole: AppRole;
  availableRoles: AppRole[];
  onRoleChange: (role: AppRole) => void;
  addRoleComponent: ReactNode;
}

export default function SupporterDashboardBackup({ 
  user, signOut, currentRole, availableRoles, onRoleChange, addRoleComponent 
}: SupporterDashboardBackupProps) {
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
  const [menuOpen, setMenuOpen] = useState(false);
  const [selectedHouse, setSelectedHouse] = useState<VirtualHouse | null>(null);
  const [showHouseDetails, setShowHouseDetails] = useState(false);
  const [selectedPackageCategory, setSelectedPackageCategory] = useState<RentCategory | null>(null);
  const [showPackageSheet, setShowPackageSheet] = useState(false);
  const [showWallet, setShowWallet] = useState(false);
  const [showFunderHub, setShowFunderHub] = useState(false);
  const [showInvestments, setShowInvestments] = useState(false);
  const [investmentsTab, setInvestmentsTab] = useState<'accounts' | 'angel'>('accounts');
  const [focusPortfolioId, setFocusPortfolioId] = useState<string | null>(null);
  const { toast } = useToast();
  const { wallet, refreshWallet } = useWallet();
  const { fireSuccess, fireFirstFunding } = useConfetti();
  const [hasEverFunded, setHasEverFunded] = useState<boolean | null>(null);

  // ─── Funder activation modal (self-registered + just approved + empty wallet) ───
  const { isSelfRegistered, verifiedAt } = useFunderApprovalStatus(user.id);
  const [showActivationModal, setShowActivationModal] = useState(false);
  const [highlightDeposit, setHighlightDeposit] = useState(false);
  const SNOOZE_KEY = `funder_activation_snooze_${user.id}`;

  // Strict ledger-derived available balance (never the wallets cache) for
  // the "wallet is empty" nag trigger. Keeps user-facing surfaces locked
  // to the same source of truth as the wallet card / withdraw flow.
  const { available: strictAvailable } = useAvailableBalance(user.id);

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
      if (raw) return JSON.parse(raw).houses || [];
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
      setTimeout(() => {
        const el = document.getElementById('opportunities');
        if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }, 100);
    }
  }, [location.hash]);

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
      console.error('[SupporterDashboard.backup] Failed to fetch contributions:', err);
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
      console.error('[SupporterDashboard.backup] Error:', error);
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

  const menuItems = [
    { icon: CreditCard, label: 'Add Funding', onClick: () => setShowPaymentPartners(true) },
  ];

  return (
    <div className="h-dvh bg-background flex flex-col overflow-hidden">
      {/* Inactivity lock overlay */}
      {isLocked && (
        <SupporterInactivityLock
          userEmail={user.email || ''}
          fullName={profile?.full_name}
          avatarUrl={profile?.avatar_url}
          onUnlock={unlock}
        />
      )}
      <DashboardHeader
        currentRole={currentRole}
        availableRoles={availableRoles}
        onRoleChange={onRoleChange}
        onSignOut={signOut}
        menuItems={menuItems}
        headerActions={<NotificationBell userId={user.id} />}
      />

      <div className="flex-1 min-h-0 overflow-y-auto pb-nav overscroll-contain">
        <main className="px-3 xs:px-4 py-4 xs:py-5 space-y-5 max-w-lg mx-auto">
          <MissionBanner dashboardRole="supporter" />



          <WidgetErrorBoundary label="Portfolio card">
            <PartnerPortfolioWalletCard
              onAddCard={() => {
                hapticTap();
                const el = document.getElementById('opportunities');
                if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
              }}
              onPortfolios={() => { hapticTap(); setInvestmentsTab('accounts'); setShowInvestments(true); }}
              onCalculator={() => { hapticTap(); setShowCalculator(true); }}
              onMore={() => { hapticTap(); setShowFunderHub(true); }}
            />
          </WidgetErrorBoundary>


          <WidgetErrorBoundary label="Your portfolio">
            <PartnerPortfolioSection
              onViewPortfolios={(portfolioId) => {
                hapticTap();
                if (portfolioId) setFocusPortfolioId(portfolioId);
                setInvestmentsTab('accounts');
                setShowInvestments(true);
              }}
              onExploreOpportunities={() => {
                const el = document.getElementById('opportunities');
                if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
              }}
            />
          </WidgetErrorBoundary>

          <WidgetErrorBoundary label="Houses you support">
            <SupportedHouseReturnsSection />
          </WidgetErrorBoundary>




          {/* ═══ SECTION: OPPORTUNITIES ═══ */}
          <div id="opportunities" className="relative scroll-mt-4 space-y-4">
            <div className="flex items-center gap-2 px-1">
              <div className="w-1 h-5 rounded-full bg-primary" />
              <h2 className="text-sm font-black text-foreground tracking-tight">Capital Opportunities</h2>
            </div>
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
                  <FunderCapitalOpportunities />
                </>
              )}
            </WidgetErrorBoundary>
          </div>

          {/* ═══ MY FUNDED HOUSES (collapsible) ═══ */}
          {virtualHouses.length > 0 && (
            <div id="my-houses" className="space-y-3 scroll-mt-4">
              <div className="flex items-center gap-2 px-1">
                <div className="w-1 h-5 rounded-full bg-success" />
                <h2 className="text-sm font-black text-foreground tracking-tight">My Houses</h2>
              </div>
              <Collapsible defaultOpen>
                <CollapsibleTrigger asChild>
                  <button className="w-full flex items-center justify-between px-4 py-3 rounded-2xl bg-card border border-border/60 shadow-sm hover:bg-accent/30 transition-colors touch-manipulation active:scale-[0.98]">
                    <div className="flex items-center gap-2.5">
                      <div className="w-9 h-9 rounded-xl bg-primary/10 flex items-center justify-center">
                        <span className="text-lg">🏘️</span>
                      </div>
                      <div className="text-left">
                        <span className="font-bold text-sm text-foreground">{virtualHouses.length} Properties</span>
                        <p className="text-[10px] text-muted-foreground">Your funded portfolio</p>
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      <Badge variant="secondary" className="text-[10px] px-2 py-0.5">
                        {virtualHouses.length}
                      </Badge>
                      <ChevronDown className="h-4 w-4 text-muted-foreground transition-transform duration-200 [[data-state=open]>&]:rotate-180" />
                    </div>
                  </button>
                </CollapsibleTrigger>
                <CollapsibleContent>
                  <div className="pt-3">
                    <WidgetErrorBoundary label="My houses">
                      <VirtualHousesFeed
                        houses={virtualHouses}
                        loading={loading}
                        onHouseTap={handleHouseTap}
                      />
                    </WidgetErrorBoundary>
                  </div>
                </CollapsibleContent>
              </Collapsible>
            </div>
          )}

          {/* Houses on Welile / Available Now moved inside
              "Support Tenants Directly" in Capital Opportunities. */}

        </main>
      </div>
      <SupporterMenuDrawer
        open={menuOpen}
        onOpenChange={setMenuOpen}
        onAddInvestment={() => setShowPaymentPartners(true)}
        onOpenCalculator={() => setShowCalculator(true)}
        onViewAgreement={() => { setViewAgreementTab('summary'); setShowViewAgreementModal(true); }}
        showCreditRequests
        isLocked={!effectiveHasAccepted}
        onLockedClick={() => setShowAgreementModal(true)}
        onFundCategory={(cat) => {
          if (!effectiveHasAccepted) {
            setShowAgreementModal(true);
            return;
          }
          setSelectedPackageCategory(cat);
          setShowPackageSheet(true);
        }}
        onRefreshRef={opportunitiesRefreshRef}
      />

      {/* Invite & Earn */}
      <InviteAndEarnCard variant="supporter" compact />

      <PaymentPartnersDialog 
        open={showPaymentPartners} 
        onOpenChange={setShowPaymentPartners}
        dashboardType="supporter"
        title="Add Funds"
      />
      
      <SupporterAgreementModal
        open={showAgreementModal}
        onOpenChange={setShowAgreementModal}
        onAccept={handleAcceptAgreement}
        loading={agreementLoading}
      />
      
      <SupporterAgreementViewModal
        open={showViewAgreementModal}
        onOpenChange={setShowViewAgreementModal}
        defaultTab={viewAgreementTab}
      />
      
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
            <InvestmentCalculator />
          </div>
        </DialogContent>
      </Dialog>
      

      <VirtualHouseDetailsSheet
        house={selectedHouse}
        open={showHouseDetails}
        onOpenChange={setShowHouseDetails}
      />
      
      <InvestmentPackageSheet
        open={showPackageSheet}
        onOpenChange={setShowPackageSheet}
        category={selectedPackageCategory}
        onAcceptAndDeposit={() => setShowPaymentPartners(true)}
      />

      <FunderWalletHubSection open={showFunderHub} onOpenChange={setShowFunderHub} />
      <InvestmentAccountsDrawer
        open={showInvestments}
        onOpenChange={(o) => { setShowInvestments(o); if (!o) setFocusPortfolioId(null); }}
        defaultTab={investmentsTab}
        initialPortfolioId={focusPortfolioId}
      />

      <FunderActivationModal
        open={showActivationModal}
        onOpenChange={setShowActivationModal}
        onDepositClick={handleActivationDeposit}
        onSnooze={handleActivationSnooze}
      />

    </div>
  );
}
