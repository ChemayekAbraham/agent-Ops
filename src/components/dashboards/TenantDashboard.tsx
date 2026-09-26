import { useState, useEffect, useRef, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { toast as sonnerToast } from 'sonner';
import { User } from '@supabase/supabase-js';
import { supabase } from '@/integrations/supabase/client';
import { useOffline } from '@/contexts/OfflineContext';
import { 
  WifiOff,
  RefreshCw,
  BadgeCheck,
} from 'lucide-react';
import { FindAHouseCTA } from '@/components/tenant/FindAHouseCTA';
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
import { RentDiscountCarousel } from '@/components/tenant/RentDiscountCarousel';
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
  const navigate = useNavigate();
  const { profile } = useProfile();
  const { isOnline } = useOffline();
  const { wallet, refreshWallet } = useWallet();
  const { toast } = useToast();
  const { isAccepted: hasAcceptedTerms, isLoading: agreementLoading, acceptAgreement } = useTenantAgreement();

  // Local-first: read cache synchronously for instant paint
  const [rentRequests, setRentRequests] = useState<RentRequest[]>(() => {
    try {
      const raw = localStorage.getItem(`tenant_dashboard_${user.id}`);
      if (raw) return JSON.parse(raw).rentRequests || [];
    } catch {}
    return [];
  });
  const [repayments, setRepayments] = useState<Repayment[]>(() => {
    try {
      const raw = localStorage.getItem(`tenant_dashboard_${user.id}`);
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
  const rentCarouselRef = useRef<HTMLDivElement | null>(null);
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
    if (!navigator.onLine) {
      setLoading(false);
      return;
    }
    
    (async () => {
      try {
        const { data: requests } = await supabase
          .from('rent_requests')
          .select('*')
          .eq('tenant_id', user.id)
          .order('created_at', { ascending: false });
        
        const newRentRequests = requests || [];
        const newRepayments: Repayment[] = [];
        
        setRentRequests(newRentRequests);
        setRepayments(newRepayments);
        
        localStorage.setItem(`tenant_dashboard_${user.id}`, JSON.stringify({
          rentRequests: newRentRequests,
          repayments: newRepayments,
          timestamp: Date.now()
        }));
      } catch (error) {
        console.error('[TenantDashboard] Error fetching data:', error);
      }
      setLoading(false);
    })();
  }, [user.id]);

  const fetchData = async () => {
    if (!navigator.onLine) return;
    try {
      const { data: requests } = await supabase
        .from('rent_requests')
        .select('*')
        .eq('tenant_id', user.id)
        .order('created_at', { ascending: false });
      
      const newRentRequests = requests || [];
      setRentRequests(newRentRequests);
      setRepayments([]);
      
      localStorage.setItem(`tenant_dashboard_${user.id}`, JSON.stringify({
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
  if (showFullSkeleton) {
    return <TenantDashboardSkeleton />;
  }
  const dataLoading = loading && !hasCachedData;

  const handleRefresh = async () => {
    await Promise.all([fetchData(), refreshWallet()]);
  };

  const handleViewWallet = () => { hapticTap(); setShowWallet(true); };

  const menuItems: never[] = [];

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
        headerActions={<TenantInAppNotificationBell tenantId={user.id} />}
      />

      {/* Scrollable content area */}
      <div className="flex-1 overflow-y-auto pb-nav">
        <main className="px-4 py-6 space-y-6 animate-fade-in max-w-lg mx-auto flex flex-col min-h-full">
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

          <RentAccessGrowthBanner />




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





          {/* Wallet hero card — replaces the previous bread hero on tenant dashboard */}
          <div id="tenant-wallet-hero">
            <UnifiedWalletHeroCard
              balance={wallet?.balance ?? 0}
              role="tenant"
              onOpenWallet={() => setShowWallet(true)}
              quickActions={
                <FunderQuickActions
                  variant="hero"
                  availableBalance={wallet?.balance ?? 0}
                  onChanged={() => { refreshWallet(); }}
                />
              }
            />
          </div>

          {/* Outstanding balance / daily-charge status */}
          <WidgetErrorBoundary label="Subscription status">
            <SubscriptionStatusCard userId={user.id} />
          </WidgetErrorBoundary>

          {/* Available houses — surfaced near the top of home so tenants find them first */}
          <div className="grid grid-cols-2 gap-3">
            <WidgetErrorBoundary label="Find a house">
              <FindAHouseCTA onClick={() => { hapticTap(); navigate('/find-a-house'); }} />
            </WidgetErrorBoundary>
            <WidgetErrorBoundary label="Request rent as tenant">
              <TenantRentRequestCard userId={user.id} />
            </WidgetErrorBoundary>
          </div>

          {/* Rent Plan summary — rent limit, usage, behaviour score */}
          <WidgetErrorBoundary label="Rent plan summary">
            <RentPlanSummaryCard onViewDetails={() => navigate('/dashboard/rent-plan')} />
          </WidgetErrorBoundary>

          {/* Recent payment activity timeline */}
          <WidgetErrorBoundary label="Payment timeline">
            <PaymentTimeline />
          </WidgetErrorBoundary>

          <WidgetErrorBoundary label="Suggested houses">
            <SuggestedHousesCard userId={user.id} onViewAll={goToAllHouses} />
          </WidgetErrorBoundary>

          {/* Apply your Rent Fees discount to rent — horizontally scrollable rentals */}
          <div ref={rentCarouselRef} id="rent-discount-carousel">
            <RentDiscountCarousel
              discountPct={
                breadPrice.basePrice > 0
                  ? Math.max(0, (breadPrice.basePrice - breadPrice.reducedPrice) / breadPrice.basePrice)
                  : 0
              }
            />
          </div>


        </main>
      </div>

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
