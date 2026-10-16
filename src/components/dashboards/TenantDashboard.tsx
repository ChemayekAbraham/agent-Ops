import { useState, useEffect, useRef, useCallback } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { toast as sonnerToast } from 'sonner';
import { User } from '@supabase/supabase-js';
import { supabase } from '@/integrations/supabase/client';
import { useOffline } from '@/contexts/OfflineContext';
import {
  WifiOff,
  RefreshCw,
  BadgeCheck,
  HandCoins,
  ArrowLeft,
  FileText,
} from 'lucide-react';
import { useBackGestureClose } from '@/hooks/useBackGestureClose';
import { FindAHouseCTA } from '@/components/tenant/FindAHouseCTA';
import { LendingOffersCard } from '@/components/vouch/borrower/LendingOffersCard';
import { MyLoanRequestsCard } from '@/components/vouch/borrower/MyLoanRequestsCard';
import { RentAccessGrowthBanner } from '@/components/tenant/RentAccessGrowthBanner';
import { TenantRentRequestCard } from '@/components/tenant/TenantRentRequestCard';
import { WidgetErrorBoundary } from '@/components/shared/WidgetErrorBoundary';

import { useToast } from '@/hooks/use-toast';
import { AppRole } from '@/hooks/useAuth';
import { ReactNode } from 'react';
import DashboardHeader from '@/components/DashboardHeader';
import { TenantInAppNotificationBell } from '@/components/tenant/TenantInAppNotificationBell';

import { useProfile } from '@/hooks/useProfile';
import { UserAvatar } from '@/components/UserAvatar';
import { ProfileSummaryPopover } from '@/components/profile/ProfileSummaryPopover';
import { TenantDashboardSkeleton } from '@/components/skeletons/DashboardSkeletons';
import { ListSectionSkeleton } from '@/components/skeletons/SectionSkeletons';
import { PayLandlordDialog } from '@/components/wallet/PayLandlordDialog';
import { FullScreenWalletSheet } from '@/components/wallet/FullScreenWalletSheet';
import { WalletDisclaimer } from '@/components/wallet/WalletDisclaimer';
import { useWallet } from '@/hooks/useWallet';
import { hapticTap } from '@/lib/haptics';
import AiIdButton from '@/components/ai-id/AiIdButton';


import { SubscriptionStatusCard } from '@/components/tenant/SubscriptionStatusCard';
import { RentPlanSummaryCard } from '@/components/tenant/RentPlanSummaryCard';
import { PaymentTimeline } from '@/components/tenant/PaymentTimeline';

import { RentRequestButton } from '@/components/tenant/RentRequestButton';
import RentRequestForm from '@/components/tenant/RentRequestForm';
import RentCalculator from '@/components/tenant/RentCalculator';
import { 
  TenantAgreementNotice, 
  TenantAgreementModal
} from '@/components/tenant/agreement';
import { useTenantAgreement } from '@/hooks/useTenantAgreement';
import { useTrackSection } from '@/hooks/useTrackSection';
import { userBehaviourTracker } from '@/lib/userBehaviourTracker';

import PaymentPartnersDialog from '@/components/payments/PaymentPartnersDialog';

import { MerchantCodePills } from '@/components/supporter/MerchantCodePills';
import { AgentDepositDialog } from '@/components/agent/AgentDepositDialog';
import { AvailableHousesSheet } from '@/components/tenant/AvailableHousesSheet';

import { SuggestedHousesCard } from '@/components/tenant/SuggestedHousesCard';

import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { ShareBreadDialog } from '@/components/tenant/ShareBreadDialog';
import {
  useBreadReceiptPrice,
} from '@/hooks/useBreadReceiptPrice';
import { WelileReceiptDialog } from '@/components/tenant/WelileReceiptDialog';
import { ClaimBreadDialog } from '@/components/tenant/ClaimBreadDialog';
import { ClaimRentDiscountDialog } from '@/components/tenant/ClaimRentDiscountDialog';
import { AddMonthlyRentDialog, getStoredMonthlyRent } from '@/components/tenant/AddMonthlyRentDialog';
import { useAvailableBalance } from '@/hooks/useAvailableBalance';
import { UnifiedWalletHeroCard } from '@/components/wallet/UnifiedWalletHeroCard';
import { FunderQuickActions } from '@/components/supporter/FunderQuickActions';


interface TenantDashboardProps {
  user: User;
  signOut: () => Promise<void>;
  currentRole: AppRole;
  availableRoles: AppRole[];
  onRoleChange: (role: AppRole) => void;
  addRoleComponent: ReactNode;
}

interface RentRequest {
  id: string;
  rent_amount: number;
  duration_days: number;
  total_repayment: number;
  daily_repayment: number;
  status: string;
  created_at: string;
  disbursed_at: string | null;
  agent_verified?: boolean | null;
  manager_verified?: boolean | null;
  supporter_id?: string | null;
  funded_at?: string | null;
  fund_recipient_type?: string | null;
  fund_recipient_name?: string | null;
  fund_routed_at?: string | null;
}

interface Repayment {
  id: string;
  amount: number;
  payment_date: string;
  created_at: string;
  rent_request_id: string;
}

export default function TenantDashboard({ user, signOut, currentRole, availableRoles, onRoleChange, addRoleComponent }: TenantDashboardProps) {
  const uid = user?.id ?? "";
  const navigate = useNavigate();
  const { profile } = useProfile();
  const { isOnline } = useOffline();
  const { wallet, refreshWallet } = useWallet();
  const { toast } = useToast();
  const { isAccepted: hasAcceptedTerms, isLoading: agreementLoading, acceptAgreement } = useTenantAgreement();

  // Track user presence and dwell time in Tenant dashboard
  useTrackSection('tenant-overview', 'tenant');

  // Local-first: read cache synchronously for instant paint
  const [rentRequests, setRentRequests] = useState<RentRequest[]>(() => {
    try {
      const raw = localStorage.getItem(`tenant_dashboard_${uid}`);
      if (raw) return JSON.parse(raw).rentRequests || [];
    } catch {}
    return [];
  });
  const [repayments, setRepayments] = useState<Repayment[]>(() => {
    try {
      const raw = localStorage.getItem(`tenant_dashboard_${uid}`);
      if (raw) return JSON.parse(raw).repayments || [];
    } catch {}
    return [];
  });
  const hasCachedData = rentRequests.length > 0;
  const [loading, setLoading] = useState(!hasCachedData);

  // Dialog states
  const [showWallet, setShowWallet] = useState(false);
  const [showPayLandlord, setShowPayLandlord] = useState(false);
  const [showPaymentPartners, setShowPaymentPartners] = useState(false);
  const [showAgreementModal, setShowAgreementModal] = useState(false);
  const [isAcceptingAgreement, setIsAcceptingAgreement] = useState(false);
  
  const [showCalculator, setShowCalculator] = useState(false);
  const [showRequestForm, setShowRequestForm] = useState(false);
  const [depositOpen, setDepositOpen] = useState(false);
  // Global "open deposit" entry: triggered from the mobile bottom-nav Deposit
  // FAB and from `?deposit=1` deep-links so users can reach the deposit flow
  // in one tap from anywhere.
  useEffect(() => {
    const handler = () => setDepositOpen(true);
    window.addEventListener('open-deposit', handler);
    return () => window.removeEventListener('open-deposit', handler);
  }, []);
  useEffect(() => {
    try {
      const params = new URLSearchParams(window.location.search);
      if (params.get('deposit') === '1') {
        setDepositOpen(true);
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
  const [housesOpen, setHousesOpen] = useState(false);
  const [loanOffersOpen, setLoanOffersOpen] = useState(false);
  useBackGestureClose(loanOffersOpen, () => setLoanOffersOpen(false));

  const [searchParams, setSearchParams] = useSearchParams();
  const tabParam = searchParams.get('tab');
  const initialTab: 'home' | 'rent-plan' =
    tabParam === 'rent-plan' ? 'rent-plan' : 'home';
  const [activeTab, setActiveTab] = useState<'home' | 'rent-plan'>(initialTab);

  // Sync activeTab when query param ?tab changes
  useEffect(() => {
    const currentTab = searchParams.get('tab');
    if (currentTab === 'rent-plan') {
      setActiveTab('rent-plan');
    } else {
      setActiveTab('home');
    }
  }, [searchParams]);

  // Sync activeTab when top-right menu triggers tab switch event
  useEffect(() => {
    const handleTabEvent = (e: CustomEvent<string>) => {
      if (e.detail === 'rent-plan') {
        setActiveTab('rent-plan');
      } else if (e.detail === 'home') {
        setActiveTab('home');
      }
    };
    window.addEventListener('tenant-tab-change' as any, handleTabEvent);
    return () => window.removeEventListener('tenant-tab-change' as any, handleTabEvent);
  }, []);

  useBackGestureClose(activeTab !== 'home', () => {
    setActiveTab('home');
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      next.delete('tab');
      return next;
    }, { replace: true });
  });

  // Dynamic telemetry tracking across tenant sheets and modals
  useEffect(() => {
    if (showWallet) {
      userBehaviourTracker.setSection('tenant-wallet', 'tenant');
    } else if (showRequestForm) {
      userBehaviourTracker.setSection('tenant-request-advance', 'tenant');
    } else if (showPayLandlord) {
      userBehaviourTracker.setSection('tenant-pay-landlord', 'tenant');
    } else if (showPaymentPartners) {
      userBehaviourTracker.setSection('tenant-payment-partners', 'tenant');
    } else if (depositOpen) {
      userBehaviourTracker.setSection('tenant-deposit', 'tenant');
    } else if (housesOpen) {
      userBehaviourTracker.setSection('tenant-available-houses', 'tenant');
    } else if (showCalculator) {
      userBehaviourTracker.setSection('tenant-calculator', 'tenant');
    } else if (activeTab === 'rent-plan') {
      userBehaviourTracker.setSection('tenant-rent-plan', 'tenant');
    } else {
      userBehaviourTracker.setSection('tenant-overview', 'tenant');
    }
  }, [
    showWallet,
    showRequestForm,
    showPayLandlord,
    showPaymentPartners,
    depositOpen,
    housesOpen,
    showCalculator,
    activeTab,
  ]);

  const housesTriggerRef = useRef<HTMLElement | null>(null);
  const goToAllHouses = useCallback(() => {
    hapticTap();
    setHousesOpen(false);
    navigate('/find-a-house');
  }, [navigate]);
  const handleHousesOpenChange = useCallback((next: boolean) => {
    setHousesOpen(next);
    if (!next) {
      const el = housesTriggerRef.current;
      housesTriggerRef.current = null;
      if (el && typeof el.focus === 'function') {
        // Wait for Radix to fully tear down its focus trap (Escape and
        // overlay-click close paths still hold it for a tick) before
        // restoring focus to the exact triggering card.
        const restore = () => { try { el.focus({ preventScroll: false }); } catch { /* ignore */ } };
        requestAnimationFrame(() => requestAnimationFrame(restore));
        // Belt-and-braces fallback in case the element was momentarily
        // detached during the sheet's exit animation.
        setTimeout(restore, 120);
      }
    }
  }, []);
  const [shareBreadOpen, setShareBreadOpen] = useState(false);
  const [receiptDialogOpen, setReceiptDialogOpen] = useState(false);
  const [claimBreadOpen, setClaimBreadOpen] = useState(false);
  const [claimRentDiscountOpen, setClaimRentDiscountOpen] = useState(false);
  const [addRentOpen, setAddRentOpen] = useState(false);
  const [savedMonthlyRent, setSavedMonthlyRent] = useState<number | null>(() => getStoredMonthlyRent());
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key === 'welile.tenant.monthlyRent') setSavedMonthlyRent(getStoredMonthlyRent());
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);
  const { available: withdrawableAvailable } = useAvailableBalance();
  const breadPrice = useBreadReceiptPrice();
  // Surface a tiny toast when a price sync round-trip completes.
  const wasSyncingRef = useRef(false);
  useEffect(() => {
    if (wasSyncingRef.current && !breadPrice.syncing) {
      sonnerToast.success('Bread price updated', { duration: 1800 });
    }
    wasSyncingRef.current = breadPrice.syncing;
  }, [breadPrice.syncing]);


  const handleAcceptAgreement = async () => {
    setIsAcceptingAgreement(true);
    try {
      return await acceptAgreement();
    } finally {
      setIsAcceptingAgreement(false);
    }
  };

  // Background fetch — never blocks UI if cache exists
  useEffect(() => {
    if (!uid || !navigator.onLine) {
      setLoading(false);
      return;
    }
    
    (async () => {
      try {
        const { data: requests } = await supabase
          .from('rent_requests')
          .select('*')
          .eq('tenant_id', uid)
          .order('created_at', { ascending: false });
        
        const newRentRequests = requests || [];
        const newRepayments: Repayment[] = [];
        
        setRentRequests(newRentRequests);
        setRepayments(newRepayments);
        
        localStorage.setItem(`tenant_dashboard_${uid}`, JSON.stringify({
          rentRequests: newRentRequests,
          repayments: newRepayments,
          timestamp: Date.now()
        }));
      } catch (error) {
        console.error('[TenantDashboard] Error fetching data:', error);
      }
      setLoading(false);
    })();
  }, [uid]);

  const fetchData = async () => {
    if (!uid || !navigator.onLine) return;
    try {
      const { data: requests } = await supabase
        .from('rent_requests')
        .select('*')
        .eq('tenant_id', uid)
        .order('created_at', { ascending: false });
      
      const newRentRequests = requests || [];
      setRentRequests(newRentRequests);
      setRepayments([]);
      
      localStorage.setItem(`tenant_dashboard_${uid}`, JSON.stringify({
        rentRequests: newRentRequests,
        repayments: [],
        timestamp: Date.now()
      }));
    } catch (error) {
      console.error('[TenantDashboard] Error fetching data:', error);
    }
  };

  // Progressive rendering: header + skeleton placeholders render immediately;
  // individual widgets reveal as their data arrives. The legacy full-page
  // skeleton is kept for the rare empty-cache *offline* case only.
  const showFullSkeleton = loading && !hasCachedData && !isOnline;
  if (showFullSkeleton || !uid) {
    return <TenantDashboardSkeleton />;
  }
  const dataLoading = loading && !hasCachedData;

  const handleRefresh = async () => {
    await Promise.all([fetchData(), refreshWallet()]);
  };

  const handleViewWallet = () => { hapticTap(); setShowWallet(true); };

  // Menu (header ☰) entries. The loan-offers surface lives here instead of the
  // home feed, so the menu is its single entry point — no duplicated card.
  const menuItems = [
    {
      icon: HandCoins,
      label: 'Loan offers',
      onClick: () => { hapticTap(); setLoanOffersOpen(true); },
    },
  ];

  // Most relevant rent request for the process tracker — the active one
  // (mirrors RepaymentSection's own selection) falling back to the most
  // recent request overall so new/rejected tenants still see a tracker.
  const currentRentRequest =
    rentRequests.find((r) => !['completed', 'rejected'].includes(r.status)) || rentRequests[0];

  return (
    <div className="h-[100dvh] bg-background flex flex-col overflow-hidden">
      <DashboardHeader
        currentRole={currentRole}
        availableRoles={availableRoles}
        onRoleChange={onRoleChange}
        onSignOut={signOut}
        menuItems={menuItems}
        headerActions={<TenantInAppNotificationBell tenantId={uid} />}
      />

      {/* Scrollable content area */}
      <div className="flex-1 overflow-y-auto pb-nav">
        <main className="px-4 py-6 space-y-6 animate-fade-in max-w-lg mx-auto flex flex-col min-h-full">
          {/* Sub-screen Navigation Header (When rent-plan tab is active) */}
          {activeTab !== 'home' && (
            <div className="flex items-center justify-between pb-1 pt-0.5">
              <button
                type="button"
                onClick={() => {
                  hapticTap();
                  setActiveTab('home');
                  setSearchParams((prev) => {
                    const next = new URLSearchParams(prev);
                    next.delete('tab');
                    return next;
                  }, { replace: true });
                }}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-muted/80 hover:bg-muted text-xs font-semibold text-foreground transition-colors touch-manipulation shadow-xs"
              >
                <ArrowLeft className="h-3.5 w-3.5" />
                <span>Back to Home</span>
              </button>
              <span className="text-xs font-bold text-muted-foreground uppercase tracking-wider">
                {activeTab === 'rent-plan' ? 'Your Rent Plan' : 'Tenant Hub'}
              </span>
            </div>
          )}

          {activeTab === 'home' && (
            <>
              {/* Offline Notice */}
              {!isOnline && (
                <div className="animate-fade-in flex items-center gap-2.5 px-3 py-2 rounded-xl bg-warning/10 border border-warning/20">
                  <WifiOff className="h-3.5 w-3.5 text-warning shrink-0" />
                  <p className="text-xs text-warning flex-1">You're offline — data may be outdated</p>
                  <Button size="sm" variant="ghost" className="h-7 w-7 p-0" onClick={() => window.location.reload()}>
                    <RefreshCw className="h-3 w-3" />
                  </Button>
                </div>
              )}

              {/* Terms Acceptance Notice */}
              <TenantAgreementNotice onAcceptClick={() => setShowAgreementModal(true)} />

              {/* Profile Row */}
              <div className="animate-fade-in flex items-center gap-3">
                <ProfileSummaryPopover
                  avatarUrl={profile?.avatar_url}
                  fullName={profile?.full_name}
                  phone={(profile as any)?.phone}
                  email={(profile as any)?.email}
                  location={(profile as any)?.location}
                  verified={profile?.verified}
                  roleLabel="Tenant"
                  triggerSize="md"
                />
                <div className="flex-1 min-w-0">
                  <p className="text-[11px] text-muted-foreground font-medium">Welcome back</p>
                  <h1 className="font-bold text-lg leading-tight flex items-center gap-1.5 flex-wrap">
                    <span className="break-words">{profile?.full_name || 'Welcome'}</span>
                    {profile?.verified ? (
                      <BadgeCheck className="h-4 w-4 text-primary fill-primary/20 shrink-0" />
                    ) : (
                      <BadgeCheck className="h-4 w-4 text-muted-foreground/30 shrink-0" />
                    )}
                  </h1>
                </div>
                <AiIdButton variant="compact" />
              </div>

              <WidgetErrorBoundary label="My loan requests">
                <MyLoanRequestsCard userId={uid} />
              </WidgetErrorBoundary>

              {/* Outstanding balance / daily-charge status */}
              <WidgetErrorBoundary label="Subscription status">
                <SubscriptionStatusCard userId={uid} />
              </WidgetErrorBoundary>

              {/* Rent actions — request rent first, then browse available houses */}
              <div className="flex flex-col gap-3">
                <WidgetErrorBoundary label="Request rent as tenant">
                  <TenantRentRequestCard userId={uid} />
                </WidgetErrorBoundary>
                <WidgetErrorBoundary label="Find a house">
                  <FindAHouseCTA onClick={() => { hapticTap(); navigate('/find-a-house'); }} />
                </WidgetErrorBoundary>
              </div>

              {/* Recent payment activity timeline */}
              <WidgetErrorBoundary label="Payment timeline">
                <PaymentTimeline />
              </WidgetErrorBoundary>

              <WidgetErrorBoundary label="Suggested houses">
                <SuggestedHousesCard userId={uid} onViewAll={goToAllHouses} />
              </WidgetErrorBoundary>

              <RentAccessGrowthBanner />
            </>
          )}

          {/* === YOUR RENT PLAN TAB === Rent limit, usage, and behaviour score */}
          {activeTab === 'rent-plan' && (
            <div className="space-y-4 pb-24 animate-in fade-in duration-200">
              <div className="flex items-center justify-between">
                <div>
                  <h2 className="text-base sm:text-lg font-bold text-foreground">Your Rent Plan</h2>
                  <p className="text-xs text-muted-foreground">Rent limit, usage, and payment behaviour score</p>
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => { hapticTap(); navigate('/dashboard/rent-plan'); }}
                  className="h-9 px-3 text-xs font-bold rounded-xl gap-1.5"
                >
                  <FileText className="h-3.5 w-3.5 text-primary" />
                  Full Details
                </Button>
              </div>

              <WidgetErrorBoundary label="Rent plan summary">
                <RentPlanSummaryCard onViewDetails={() => navigate('/dashboard/rent-plan')} />
              </WidgetErrorBoundary>
            </div>
          )}
        </main>
      </div>

      {/* Loan offers — opened from the header ☰ menu, full page */}
      {loanOffersOpen && (
        <div className="fixed inset-0 z-[110] bg-background flex flex-col animate-fade-in">
          <header className="flex items-start gap-1 border-b border-border/60 bg-background px-2 py-2">
            <Button
              variant="ghost"
              size="icon"
              className="mt-0.5 h-9 w-9 shrink-0"
              aria-label="Back to dashboard"
              onClick={() => { hapticTap(); setLoanOffersOpen(false); }}
            >
              <ArrowLeft className="h-5 w-5" />
            </Button>
            <div className="min-w-0 py-0.5">
              <p className="flex items-center gap-1.5 text-sm font-bold leading-tight">
                <HandCoins className="h-4 w-4 shrink-0 text-primary" /> Loan offers for you
              </p>
              <p className="text-[11px] text-muted-foreground">
                Active offers from lending agents — request one that fits you.
              </p>
            </div>
          </header>
          <div className="flex-1 overflow-y-auto px-4 py-4 pb-nav">
            <div className="mx-auto max-w-lg">
              <WidgetErrorBoundary label="Loan offers">
                <LendingOffersCard userId={uid} showHeader={false} />
              </WidgetErrorBoundary>
            </div>
          </div>
        </div>
      )}

      {/* Full-screen wallet sheet */}
      <FullScreenWalletSheet open={showWallet} onOpenChange={setShowWallet} />

      {/* Share Welile Rent Fees dialog */}
      <ShareBreadDialog
        open={shareBreadOpen}
        onOpenChange={setShareBreadOpen}
        availableBalance={withdrawableAvailable}
        onTopUp={() => setShowWallet(true)}
      />

      {/* Welile Receipt — primary bread tap action (5% discount, works offline) */}
      <WelileReceiptDialog
        open={receiptDialogOpen}
        onOpenChange={setReceiptDialogOpen}
      />

      {/* Claim discounted bread at a nearby seller */}
      <ClaimBreadDialog
        open={claimBreadOpen}
        onOpenChange={setClaimBreadOpen}
        reducedPrice={breadPrice.reducedPrice}
        basePrice={breadPrice.basePrice}
        freeBreads={breadPrice.freeBreads}
        hasReceipt={breadPrice.hasReceipt}
      />

      {/* Claim Welile rent discount with a subscribed landlord or from the Landlord Float */}
      <ClaimRentDiscountDialog
        open={claimRentDiscountOpen}
        onOpenChange={setClaimRentDiscountOpen}
        monthlyRent={savedMonthlyRent}
        discountPct={
          breadPrice.basePrice > 0
            ? Math.max(0, (breadPrice.basePrice - breadPrice.reducedPrice) / breadPrice.basePrice)
            : 0
        }
      />

      {/* Add monthly rent — applies the same bread discount to rent */}
      <AddMonthlyRentDialog
        open={addRentOpen}
        onOpenChange={setAddRentOpen}
        discountPct={
          breadPrice.basePrice > 0
            ? Math.max(0, (breadPrice.basePrice - breadPrice.reducedPrice) / breadPrice.basePrice)
            : 0
        }
        onSaved={(rent) => setSavedMonthlyRent(rent)}
      />

      {/* Dialogs */}
      <PayLandlordDialog open={showPayLandlord} onOpenChange={setShowPayLandlord} />
      <PaymentPartnersDialog 
        open={showPaymentPartners} 
        onOpenChange={setShowPaymentPartners}
        dashboardType="tenant"
        title="Pay Rent via Mobile Money"
      />
      <TenantAgreementModal
        isOpen={showAgreementModal}
        onClose={() => setShowAgreementModal(false)}
        onAccept={handleAcceptAgreement}
        isAccepting={isAcceptingAgreement}
      />
      <AgentDepositDialog open={depositOpen} onOpenChange={setDepositOpen} />
      <AvailableHousesSheet open={housesOpen} onOpenChange={handleHousesOpenChange} />

      {/* Fixed footer navigation */}
      
    </div>
  );
}
