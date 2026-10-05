import { BikeLeaseDormancyBanner } from '@/components/agent/BikeLeaseDormancyBanner';
import { useState, useEffect, useRef, useMemo, Suspense } from 'react';
import { lazyWithRetry as lazy, lazyNamed } from '@/lib/lazyWithRetry';
import { useNavigate } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { User } from '@supabase/supabase-js';
import { supabase } from '@/integrations/supabase/client';
import { normalizeCashoutAgentConfig, buildQueueCategoryOrClause } from '@/lib/cashoutAgentConfig';

import AiIdButton from '@/components/ai-id/AiIdButton';
import { UnifiedWalletHeroCard } from '@/components/wallet/UnifiedWalletHeroCard';
import { useMerchantPayoutFloat } from '@/hooks/useMerchantFloat';
import { AgentRiskExposureCard } from '@/components/agent/AgentRiskExposureCard';
import TenantLocationCorrectionPopup from '@/components/agent/TenantLocationCorrectionPopup';
import { AgentCompanyDebtCard } from '@/components/agent/AgentCompanyDebtCard';
import { AgentMyAdvancesCard } from '@/components/agent/AgentMyAdvancesCard';
import { useCreditAccessLimit, formatCreditAmount } from '@/hooks/useCreditAccessLimit';
import { EarnedSinceLastWithdrawalCard } from '@/components/agent/EarnedSinceLastWithdrawalCard';
import { EarningsSummaryCard } from '@/components/agent/EarningsSummaryCard';


import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { 
  UserPlus,
  Menu,
  WifiOff,
  RefreshCw,
  BadgeCheck,
  Home,
  TrendingUp,
  Banknote,
  FileText,
  Users,
  Sparkles,
  ArrowDownLeft,
  ArrowUpRight,
  Building2,
  Briefcase,
  UserCog,
  Send,
  CheckCircle2,
  XCircle,
  ChevronDown,
  ChevronUp,
  X,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { toast } from 'sonner';
import { Info, UsersRound } from 'lucide-react';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { Wallet, Landmark, LayoutDashboard, ChevronRight } from 'lucide-react';
import { HandCoins, Receipt } from 'lucide-react';
import { ShieldCheck } from 'lucide-react';
import { Trophy } from 'lucide-react';
import { ShoppingBag, Smartphone, Bike, Store } from 'lucide-react';
import SmartphoneOrderStatus from '@/components/merchandise/SmartphoneOrderStatus';
import MerchandiseRepaymentPortfolio from '@/components/merchandise/MerchandiseRepaymentPortfolio';
import { useMerchandiseOrderLock } from '@/hooks/useMerchandiseOrderLock';
import SmartphoneOrderDialog from '@/components/merchandise/SmartphoneOrderDialog';
import SpiroBikeOrderDialog from '@/components/merchandise/SpiroBikeOrderDialog';



import spiroBikeAsset from '@/assets/spiro-bike.jpg.asset.json';
import smartphonePromoAsset from '@/assets/smartphone-promo.jpg.asset.json';
import { formatUGX } from '@/lib/rentCalculations';
import { AppRole } from '@/hooks/useAuth';
import { ReactNode } from 'react';
import DashboardHeader from '@/components/DashboardHeader';

import { useProfile } from '@/hooks/useProfile';
import { useMyProxyAgentStatus } from '@/hooks/useProxyAgentApproval';

import { UserAvatar } from '@/components/UserAvatar';
import { ProfileSummaryPopover } from '@/components/profile/ProfileSummaryPopover';
import { SubAgentsPanel } from '@/components/agent/SubAgentsPanel';
import { MyParentAgentCard } from '@/components/agent/MyParentAgentCard';
import NationalIdGroupCard from '@/components/agent/NationalIdGroupCard';
import { ParentAgentDialog, useMyParentAgent } from '@/components/agent/ParentAgentDialog';
import NationalIdGroupSheet from '@/components/national-id/NationalIdGroupSheet';
import { ServiceCenterQualificationCard } from '@/components/agent/ServiceCenterQualificationCard';
import { LastWeekWinnerOverlay } from '@/components/agent/LastWeekWinnerOverlay';
import { WeeklyChampionTeamDialog } from '@/components/agent/WeeklyChampionTeamDialog';
import { WeeklyStreakDialog, WeeklyCollectionStreakCard } from '@/components/agent/WeeklyCollectionStreak';
import { SubAgentInviteLinkDialog } from '@/components/agent/SubAgentInviteLinkDialog';
import { TenantInviteLinkDialog } from '@/components/agent/TenantInviteLinkDialog';
import SavedRentDraftsPanel from '@/components/agent/SavedRentDraftsPanel';
import { useBusinessAdvanceCommissionListener } from '@/hooks/useBusinessAdvanceCommissionListener';
import { useAgentUnblockToast } from '@/hooks/useAgentUnblockToast';
import { useRecruiterOverrideToast } from '@/hooks/useRecruiterOverrideToast';
import { useAgentEarnings } from '@/hooks/useAgentEarnings';
import { AgentDashboardSkeleton } from '@/components/skeletons/DashboardSkeletons';
import { WalletHeroSkeleton, MetricRowSkeleton, ListSectionSkeleton } from '@/components/skeletons/SectionSkeletons';


import { hapticTap } from '@/lib/haptics';
import { useListingDaytimeGuard } from '@/hooks/useListingDaytimeGuard';
import AgentFrozenGate from '@/components/agent/AgentFrozenGate';
import { OperatingLocationGate } from '@/components/location/OperatingLocationGate';
import { AgentAgreementBanner } from '@/components/agent/agreement';
import { AgentPaymentEditAlert } from '@/components/agent/AgentPaymentEditAlert';
import { AgentRejectedLandlordsPanel } from '@/components/agent/AgentRejectedLandlordsPanel';
import { AgentDeadTenantsBanner } from '@/components/agent/AgentDeadTenantsBanner';
import { AgentOverdueCallDrive } from '@/components/agent/AgentOverdueCallDrive';
import { AgentReturnedInactivationsPanel } from '@/components/agent/AgentReturnedInactivationsPanel';
import { VerificationChecklist } from '@/components/shared/VerificationChecklist';
import { useOffline } from '@/contexts/OfflineContext';
import { OfflineBanner } from '@/components/OfflineBanner';
import { PendingDraftsBanner } from '@/components/agent/PendingDraftsBanner';
import { DashboardDataErrorBanner } from '@/components/dashboards/DashboardDataErrorBanner';
import { useOfflineAgentDashboard } from '@/hooks/useOfflineAgentDashboard';
import { useWallet } from '@/hooks/useWallet';
import { useAgentBalances } from '@/hooks/useAgentBalances';
import { usePayoutsUiEnabled } from '@/hooks/usePayoutsUiEnabled';
import { useAgentLandlordFloat } from '@/hooks/useAgentLandlordFloat';
import { useAgentDashboardRealtime } from '@/hooks/useAgentDashboardRealtime';
import { AgentHubTabs, type AgentHubTab } from '@/components/agent/AgentHubTabs';
import { useHorizontalSwipe } from '@/hooks/useHorizontalSwipe';
import { useAgentHasRepayingTenant } from '@/hooks/useAgentHasRepayingTenant';
import { AgentActionInsights } from '@/components/agent/AgentActionInsights';
import { AgentArrearsCard } from '@/components/agent/AgentArrearsCard';
import { AgentExpiredCyclesCard } from '@/components/agent/AgentExpiredCyclesCard';
import { AgentLandlordFloatCard } from '@/components/agent/AgentLandlordFloatCard';
import { useTrackSection } from '@/hooks/useTrackSection';
import { userBehaviourTracker } from '@/lib/userBehaviourTracker';
import { AgentConvertToFloatCard } from '@/components/agent/AgentConvertToFloatCard';
import { ReceiptNumberCheckDialog } from '@/components/agent/ReceiptNumberCheckDialog';
import { AgentPendingReceiptPanel } from '@/components/agent/AgentPendingReceiptPanel';
import { AgentTenantHealthCard } from '@/components/agent/AgentTenantHealthCard';
import { AgentVouchHighlightCard } from '@/components/agent/AgentVouchHighlightCard';
import type { LandlordFloatAllocation } from '@/hooks/useLandlordFloatAllocations';
import { isLandlordReceiptConfirmationEffective, usePendingLandlordReceipts } from '@/hooks/usePendingLandlordReceipts';

import { AgentNotificationBell } from '@/components/agent/AgentNotificationBell';
import { DeviceSessionIndicator } from '@/components/agent/DeviceSessionIndicator';
import { CreditVerificationButton } from '@/components/agent/CreditVerificationButton';
import { AgentRequestPipelineView, type PipelineTab } from '@/components/agent/AgentRequestPipelineView';
import { useAgentPipelineCounts } from '@/hooks/useAgentPipelineCounts';

import { getDuplicateEntries, isFieldCollectStorageUnavailable, onFieldCollectStorageUnavailable } from '@/lib/fieldCollectStore';
import { FileWarning } from 'lucide-react';
import { FieldCollectDailyTotals } from '@/components/agent/FieldCollectDailyTotals';
import { FieldCollectCard } from '@/components/agent/FieldCollectCard';
import { FieldDepositQueueCard } from '@/components/agent/FieldDepositQueueCard';

import { AgentRatingCard } from '@/components/agent/AgentRatingCard';
import { AgentCollectionLeagueCard } from '@/components/agent/AgentCollectionLeagueCard';
import { RecruitSubAgentCTA } from '@/components/agent/RecruitSubAgentCTA';
import { ApprovedRentRequestsWidget } from '@/components/rent/ApprovedRentRequestsWidget';
import { RecentAutoCharges } from '@/components/wallet/RecentAutoCharges';
import { StuckDepositsRepairPanel } from '@/components/wallet/StuckDepositsRepairPanel';
import { AgentTenantRentRequestsList } from '@/components/agent/AgentTenantRentRequestsList';

import { ShareRentRecorderCard } from '@/components/agent/ShareRentRecorderCard';
import { TodayCollectionsCard } from '@/components/agent/TodayCollectionsCard';
import { AgentPriorityGrid } from '@/components/agent/AgentPriorityGrid';
import { MERCHANT_RESTRICTION_MESSAGE, useIsMerchantAgent } from '@/hooks/useIsMerchantAgent';
import { MerchantDashboardHome } from '@/components/agent/MerchantDashboardHome';
import { AgentTenantInlineList } from '@/components/agent/AgentTenantInlineList';
import { AgentCapacityShareInline } from '@/components/agent/AgentCapacityShareInline';
import { AgentDailyCardEmailPrompt } from '@/components/agent/AgentDailyCardEmailPrompt';
import { useIsFinancialAgent } from '@/hooks/useIsFinancialAgent';

// PDF form generators
// New Phase 1 components
import { AgentDailyOpsCard } from '@/components/agent/AgentDailyOpsCard';
import { AgentCashDepositCodesPanel } from '@/components/agent/AgentCashDepositCodesPanel';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { MissionBanner } from '@/components/mission/MissionBanner';
import { MERCHANT_QUEUE_STATUSES } from '@/lib/merchantPayoutQueue';

// Lazy-loaded modals/sheets — code-split so their JS only downloads when opened.
const FullScreenWalletSheet = lazyNamed(() => import('@/components/wallet/FullScreenWalletSheet'), 'FullScreenWalletSheet');
const DepositFlow = lazy(() => import('@/components/payments/DepositFlow'));
const WithdrawFlow = lazy(() => import('@/components/payments/WithdrawFlow'));
const SendMoneyDialog = lazyNamed(() => import('@/components/wallet/SendMoneyDialog'), 'SendMoneyDialog');
const CollectFromReferenceDialog = lazyNamed(() => import('@/components/agent/CollectFromReferenceDialog'), 'CollectFromReferenceDialog');
const AgentMenuDrawer = lazyNamed(() => import('@/components/agent/AgentMenuDrawer'), 'AgentMenuDrawer');
const RentPosterDialog = lazy(() => import('@/components/agent/RentPosterDialog'));
const RegFormActionDialog = lazy(() => import('@/components/agent/RegFormActionDialog'));
const AgentDepositDialog = lazyNamed(() => import('@/components/agent/AgentDepositDialog'), 'AgentDepositDialog');
const AgentRentRequestDialog = lazy(() => import('@/components/agent/AgentRentRequestDialog'));
const BusinessAdvanceRequestDialog = lazy(() => import('@/components/agent/BusinessAdvanceRequestDialog'));
const CommissionCelebrationModal = lazyNamed(() => import('@/components/agent/CommissionCelebrationModal'), 'CommissionCelebrationModal');
const EarningsRankSystemSheet = lazyNamed(() => import('@/components/agent/EarningsRankSystemSheet'), 'EarningsRankSystemSheet');
const AgentManagedPropertyDialog = lazyNamed(() => import('@/components/agent/AgentManagedPropertyDialog'), 'AgentManagedPropertyDialog');
const AgentManagedPropertiesSheet = lazyNamed(() => import('@/components/agent/AgentManagedPropertiesSheet'), 'AgentManagedPropertiesSheet');
const AgentLandlordPayoutDialog = lazyNamed(() => import('@/components/agent/AgentLandlordPayoutDialog'), 'AgentLandlordPayoutDialog');
const AgentLandlordPayoutFlow = lazyNamed(() => import('@/components/agent/AgentLandlordPayoutFlow'), 'AgentLandlordPayoutFlow');
const AgentFloatPayoutWizard = lazyNamed(() => import('@/components/agent/AgentFloatPayoutWizard'), 'AgentFloatPayoutWizard');
const AgentLandlordFloatAllocationsDialog = lazyNamed(() => import('@/components/agent/AgentLandlordFloatAllocationsDialog'), 'AgentLandlordFloatAllocationsDialog');
const LandlordRecoveryLedger = lazyNamed(() => import('@/components/agent/LandlordRecoveryLedger'), 'LandlordRecoveryLedger');
const FloatPayoutStatusTracker = lazyNamed(() => import('@/components/agent/FloatPayoutStatusTracker'), 'FloatPayoutStatusTracker');
const LandlordPayoutOtpAuditSheet = lazyNamed(() => import('@/components/agent/LandlordPayoutOtpAuditSheet'), 'LandlordPayoutOtpAuditSheet');
const FloatTransactionHistory = lazyNamed(() => import('@/components/agent/FloatTransactionHistory'), 'FloatTransactionHistory');
const AgentMyRentRequestsSheet = lazyNamed(() => import('@/components/agent/AgentMyRentRequestsSheet'), 'AgentMyRentRequestsSheet');
const AgentTenantsSheet = lazyNamed(() => import('@/components/agent/AgentTenantsSheet'), 'AgentTenantsSheet');
const FieldCollectReconciliationSheet = lazyNamed(() => import('@/components/agent/FieldCollectReconciliationSheet'), 'FieldCollectReconciliationSheet');
const AgentManagedUsersSheet = lazyNamed(() => import('@/components/agent/AgentManagedUsersSheet'), 'AgentManagedUsersSheet');
const AgentTopUpTenantDialog = lazyNamed(() => import('@/components/agent/AgentTopUpTenantDialog'), 'AgentTopUpTenantDialog');
const AgentInvestForPartnerDialog = lazyNamed(() => import('@/components/agent/AgentInvestForPartnerDialog'), 'AgentInvestForPartnerDialog');
const ProxyInvestmentHistorySheet = lazyNamed(() => import('@/components/agent/ProxyInvestmentHistorySheet'), 'ProxyInvestmentHistorySheet');
const AgentReceiptDialog = lazyNamed(() => import('@/components/agent/AgentReceiptDialog'), 'AgentReceiptDialog');
const AgentLandlordMapSheet = lazyNamed(() => import('@/components/agent/AgentLandlordMapSheet'), 'AgentLandlordMapSheet');
const RentalFinderSheet = lazyNamed(() => import('@/components/agent/RentalFinderSheet'), 'RentalFinderSheet');
const ListEmptyHouseDialog = lazyNamed(() => import('@/components/agent/ListEmptyHouseDialog'), 'ListEmptyHouseDialog');
const AgentListingsSheet = lazyNamed(() => import('@/components/agent/AgentListingsSheet'), 'AgentListingsSheet');
const AgentVisitPaymentWizard = lazyNamed(() => import('@/components/agent/AgentVisitPaymentWizard'), 'AgentVisitPaymentWizard');
const GeneratePaymentTokenDialog = lazyNamed(() => import('@/components/agent/GeneratePaymentTokenDialog'), 'GeneratePaymentTokenDialog');
const RecordAgentCollectionDialog = lazyNamed(() => import('@/components/agent/RecordAgentCollectionDialog'), 'RecordAgentCollectionDialog');
const AgentDepositCashDialog = lazyNamed(() => import('@/components/agent/AgentDepositCashDialog'), 'AgentDepositCashDialog');
const NearbyTenantsSheet = lazyNamed(() => import('@/components/agent/NearbyTenantsSheet'), 'NearbyTenantsSheet');
const AgentWelileHomesSheet = lazyNamed(() => import('@/components/agent/AgentWelileHomesSheet'), 'AgentWelileHomesSheet');
const MySubAgentsSheet = lazyNamed(() => import('@/components/agent/MySubAgentsSheet'), 'MySubAgentsSheet');
const MyLandlordsSheet = lazyNamed(() => import('@/components/agent/MyLandlordsSheet'), 'MyLandlordsSheet');
const QuickShareSubAgentSheet = lazyNamed(() => import('@/components/agent/QuickShareSubAgentSheet'), 'QuickShareSubAgentSheet');
const ShareLandlordLinkDialog = lazyNamed(() => import('@/components/agent/ShareLandlordLinkDialog'), 'ShareLandlordLinkDialog');
const FunderManagementSheet = lazyNamed(() => import('@/components/agent/FunderManagementSheet'), 'FunderManagementSheet');
const AgentPartnerDashboardSheet = lazyNamed(() => import('@/components/agent/AgentPartnerDashboardSheet'), 'AgentPartnerDashboardSheet');
const FinancialAgentSection = lazyNamed(() => import('@/components/agent/FinancialAgentSection'), 'FinancialAgentSection');
const LendingAgentPortal = lazy(() => import('@/components/vouch/agent/LendingAgentPortal'));
const BorrowLoanSheet = lazy(() => import('@/components/vouch/borrower/BorrowLoanSheet'));
const AgentAdvanceRequestForm = lazyNamed(() => import('@/components/agent/AgentAdvanceRequestForm'), 'AgentAdvanceRequestForm');
const CreditAccessCard = lazyNamed(() => import('@/components/CreditAccessCard'), 'CreditAccessCard');
const AgentCashPayoutsTab = lazyNamed(() => import('@/components/agent/AgentCashPayoutsTab'), 'AgentCashPayoutsTab');

// Renders a lazy modal only while `when` is truthy, so its chunk stays
// unloaded and it is absent from the render tree until first opened.
function LazyModal({ when, children }: { when: unknown; children: ReactNode }) {
  if (!when) return null;
  return <Suspense fallback={null}>{children}</Suspense>;
}

interface AgentDashboardProps {
  user: User;
  signOut: () => Promise<void>;
  currentRole: AppRole;
  availableRoles: AppRole[];
  onRoleChange: (role: AppRole) => void;
  addRoleComponent: ReactNode;
}

export default function AgentDashboard({ user, signOut, currentRole, availableRoles, onRoleChange, addRoleComponent }: AgentDashboardProps) {
  // Behaviour telemetry tracking
  useTrackSection('agent-overview', 'agent');

  // Proxy Agent shortcut is only surfaced to database-approved proxy agents.
  const { data: proxyStatus } = useMyProxyAgentStatus(user?.id);
  const isApprovedProxyAgent = proxyStatus?.status === 'approved';

  // ── DEV/QA: deliberate crash switch to verify DashboardErrorBoundary fallback.
  // Trigger by visiting /dashboard/agent?crash=1 (render-time throw)
  // or ?crash=effect (post-mount throw inside a useEffect).
  // Safe to leave in: only fires when the query param is explicitly set.
  const [qaCrashAfterMount, setQaCrashAfterMount] = useState(false);
  if (qaCrashAfterMount) {
    throw new Error('[AgentDashboard] Deliberate post-mount crash for ErrorBoundary QA (mode=effect)');
  }
  if (typeof window !== 'undefined') {
    const crashMode = new URLSearchParams(window.location.search).get('crash');
    if (crashMode && crashMode !== 'effect') {
      throw new Error(`[AgentDashboard] Deliberate crash for ErrorBoundary QA (mode=${crashMode})`);
    }
  }
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { profile, loading: profileLoading } = useProfile();
  const { data: hasRepayingTenant, isLoading: repayingTenantLoading } = useAgentHasRepayingTenant(user?.id);
  // Celebratory toast the moment the agent crosses today's 50% eligibility
  // threshold (fires once per Kampala day, on mount or via realtime).
  useAgentUnblockToast(user?.id);
  // Success / error toast when a UGX 2,000 recruiter override payout is created
  // for this agent (a verified sub-agent listing / landlord / LC1 chairperson).
  useRecruiterOverrideToast(user?.id);
  const { refreshEarnings, totalEarnings } = useAgentEarnings();
  const { wallet, refreshWallet, loading: walletLoading } = useWallet();
  const { commissionBalance, withdrawableBalance, otherBalance, refetch: refreshBalances, isLoading: balancesLoading } = useAgentBalances();
  const { floatBalance: walletFloatBalance } = useAgentBalances();
  // CFO-allocated pool used only by Pay Landlord. Wallet cards must keep
  // showing wallet/rent-collection float, not this separate payout pool.
  // The card shows SPENDABLE landlord float, not the gross balance. The gross
  // figure still counts money ring-fenced by a verified payout and money already
  // on its way back to the pool after a 24-hour recall — measured 2026-10-05,
  // two agents were being shown 250,000 and 200,000 they could not spend a
  // shilling of, because every allocation behind it was `return_pending`.
  const {
    availableBalance: landlordPayoutFloat,
    reservedBalance: landlordFloatReserved,
    isLoading: floatLoading,
  } = useAgentLandlordFloat();
  const { isOnline } = useOffline();

  // Instant mobile dashboard refresh: one debounced channel listens for any
  // agent-scoped commission, wallet movement, or float change and re-pulls
  // the headline numbers so the agent sees money arrive without reloading.
  useAgentDashboardRealtime({
    agentId: user?.id,
    onChange: () => {
      void refreshWallet();
      void refreshBalances();
      void refreshEarnings();
    },
  });

  // Live sub-agent leaderboard rank for the current agent (same source as
  // /dashboard/agents/leaderboard). Defaults to weekly to match the leaderboard
  // landing period.
  const { data: mySubagentRank } = useQuery({
    queryKey: ['agent-dashboard-my-subagent-rank', user?.id],
    enabled: !!user?.id,
    queryFn: async () => {
      const { data, error } = await supabase.rpc('get_my_subagent_rank', {
        p_period: 'weekly',
      });
      if (error) throw error;
      return (data?.[0] as { rank: number; active_count: number; total_subagents: number; active_rate: number } | null) ?? null;
    },
  });
  
  const { 
    stats, 
    isLoading: loading, 
    refreshData: refreshOfflineData, 
    hasLoadedOnce,
    loadError,
  } = useOfflineAgentDashboard();
  
  const { tenantsCount, referralCount, subAgentCount } = stats;
  
  const [depositOpen, setDepositOpen] = useState(false);
  // Global "open deposit" entry: triggered from the mobile bottom-nav Deposit
  // FAB and from `?deposit=1` deep-links so the agent can reach the deposit
  // flow in one tap from anywhere in the app.
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

  const [subAgentLinkOpen, setSubAgentLinkOpen] = useState(false);
  const [tenantInviteOpen, setTenantInviteOpen] = useState(false);
  const { isMerchantAgent: isMerchantAgentEarly } = useIsMerchantAgent();
  // Weekly Listing Mission promo dialog removed — campaign expired.
  const [rentRequestOpen, setRentRequestOpen] = useState(false);

  // Deep link & event support for opening the Post Rent Request modal
  useEffect(() => {
    const handler = () => setRentRequestOpen(true);
    window.addEventListener('open-rent-request', handler);
    return () => window.removeEventListener('open-rent-request', handler);
  }, []);
  useEffect(() => {
    try {
      const params = new URLSearchParams(window.location.search);
      if (
        params.get('action') === 'rent-request' ||
        params.get('action') === 'post-rent-request' ||
        params.get('rent_request') === '1' ||
        params.get('rent-request') === '1'
      ) {
        setRentRequestOpen(true);
        params.delete('action');
        params.delete('rent_request');
        params.delete('rent-request');
        const qs = params.toString();
        window.history.replaceState(
          {},
          '',
          window.location.pathname + (qs ? `?${qs}` : '') + window.location.hash,
        );
      }
    } catch { /* ignore */ }
  }, []);
  const [showWallet, setShowWallet] = useState(false);
  const [parentAgentOpen, setParentAgentOpen] = useState(false);
  const [nationalIdGroupOpen, setNationalIdGroupOpen] = useState(false);
  const { data: parentAgentInfo } = useMyParentAgent(user?.id);
  const [walletScrollTarget, setWalletScrollTarget] = useState<'statement' | null>(null);
  const [earningsRankOpen, setEarningsRankOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [managedPropertyOpen, setManagedPropertyOpen] = useState(false);
  const [managedPropertiesSheetOpen, setManagedPropertiesSheetOpen] = useState(false);
  const [payoutDialogOpen, setPayoutDialogOpen] = useState(false);
  const [payoutProperty, setPayoutProperty] = useState<any>(null);
  const [myRentRequestsOpen, setMyRentRequestsOpen] = useState(false);
  
  const [topUpTenantOpen, setTopUpTenantOpen] = useState(false);
  const [businessAdvanceOpen, setBusinessAdvanceOpen] = useState(false);
  const { event: commissionEvent, dismiss: dismissCommission } = useBusinessAdvanceCommissionListener();
  // Agent's personal advance credit limit — drives the prominent Money-tab promo.
  const { limit: advanceLimit } = useCreditAccessLimit(user?.id);
  const [tenantsSheetOpen, setTenantsSheetOpen] = useState(false);
  const [welileHomesOpen, setWelileHomesOpen] = useState(false);
  // When an agent taps a specific tenant in the inline list, open the sheet
  // straight into that tenant's profile (payments + outstanding balance).
  const [tenantProfileId, setTenantProfileId] = useState<string | undefined>(undefined);
  // When opening the submissions sheet via the global "open-submissions" event
  // (fired from registration success screens), remember which view/tab to land on.
  const [submissionsView, setSubmissionsView] = useState<'tenants' | 'pipeline' | undefined>(undefined);
  const [submissionsTab, setSubmissionsTab] = useState<'submitted' | 'approved' | 'rejected' | 'landlords' | undefined>(undefined);
  const [submissionsHighlightId, setSubmissionsHighlightId] = useState<string | undefined>(undefined);
  const [pipelineTab, setPipelineTab] = useState<PipelineTab>('submitted');
  const [submissionsExpanded, setSubmissionsExpanded] = useState(false);
  const [phoneOpen, setPhoneOpen] = useState(false);
  const { repaying: smartphoneRepaying } = useMerchandiseOrderLock(user?.id);


  const [bikeOpen, setBikeOpen] = useState(false);
  const [bikeAmount, setBikeAmount] = useState('');
  const [orderingBike, setOrderingBike] = useState(false);


  const { submittedCount, approvedCount, rejectedCount, isLoading: countsLoading } = useAgentPipelineCounts();
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail as { tab?: 'submitted' | 'approved' | 'rejected' | 'landlords'; recordId?: string } | undefined;
      setSubmissionsView('pipeline');
      setSubmissionsTab(detail?.tab ?? 'submitted');
      setSubmissionsHighlightId(detail?.recordId ?? undefined);
      setTenantsSheetOpen(true);
    };
    window.addEventListener('open-submissions', handler);
    return () => window.removeEventListener('open-submissions', handler);
  }, []);
  // Deep-link support: opening /dashboard/agent?submission=<id>&type=tenant|landlord
  // jumps straight to that record in the submissions sheet, so the copyable
  // link an agent shares after registering actually lands on the record.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const recordId = params.get('submission');
    if (!recordId) return;
    const type = params.get('type');
    setSubmissionsView('pipeline');
    setSubmissionsTab(type === 'landlord' ? 'landlords' : 'submitted');
    setSubmissionsHighlightId(recordId);
    setTenantsSheetOpen(true);
    // Strip the params so a refresh / back doesn't re-trigger the sheet.
    params.delete('submission');
    params.delete('type');
    const qs = params.toString();
    window.history.replaceState({}, '', window.location.pathname + (qs ? `?${qs}` : ''));
  }, []);
  const [reconcileOpen, setReconcileOpen] = useState(false);
  const [duplicateCount, setDuplicateCount] = useState(0);

  // Poll local IndexedDB for duplicate entries needing reconciliation
  useEffect(() => {
    // ── DEV/QA: post-mount crash to verify ErrorBoundary catches effect errors.
    if (typeof window !== 'undefined') {
      const crashMode = new URLSearchParams(window.location.search).get('crash');
      if (crashMode === 'effect') {
        // Flip flag so the next render throws — Error Boundaries only catch
        // errors thrown during render/lifecycle, not async setTimeout throws.
        setTimeout(() => setQaCrashAfterMount(true), 50);
      }
    }
    if (!user?.id) return;
    let alive = true;
    const tick = async () => {
      try {
        const dups = await getDuplicateEntries(user.id);
        if (alive) setDuplicateCount(dups.length);
      } catch { /* ignore */ }
    };
    tick();
    if (isFieldCollectStorageUnavailable()) return () => { alive = false; };
    const iv = window.setInterval(tick, 5000);
    const offUnavailable = onFieldCollectStorageUnavailable(() => window.clearInterval(iv));
    return () => { alive = false; window.clearInterval(iv); offUnavailable(); };
  }, [user?.id, reconcileOpen]);
  const [investForPartnerOpen, setInvestForPartnerOpen] = useState(false);
  const [proxyHistoryOpen, setProxyHistoryOpen] = useState(false);
  const [receiptOpen, setReceiptOpen] = useState(false);
  const [landlordMapOpen, setLandlordMapOpen] = useState(false);
  const [rentalFinderOpen, setRentalFinderOpen] = useState(false);
  const [listHouseOpen, setListHouseOpen] = useState(false);
  const [listHouseFromPromo, setListHouseFromPromo] = useState(false);
  const guardListingHours = useListingDaytimeGuard();
  const [myListingsOpen, setMyListingsOpen] = useState(false);
  const [myListingsVacantOnly, setMyListingsVacantOnly] = useState(false);

  // Phase 1: Agent Operations dialogs
  const [visitDialogOpen, setVisitDialogOpen] = useState(false);
  const [tokenDialogOpen, setTokenDialogOpen] = useState(false);
  const [recordCollectionOpen, setRecordCollectionOpen] = useState(false);
  const [depositCashOpen, setDepositCashOpen] = useState(false);
  const [nearbyTenantsOpen, setNearbyTenantsOpen] = useState(false);
  const [applyingToSell, setApplyingToSell] = useState(false);
  const [creditOpen, setCreditOpen] = useState(false);
  const [subAgentsSheetOpen, setSubAgentsSheetOpen] = useState(false);
  const [landlordsSheetOpen, setLandlordsSheetOpen] = useState(false);
  const [managedUsersOpen, setManagedUsersOpen] = useState(false);
  const [shareLinkOpen, setShareLinkOpen] = useState(false);
  const [funderSheetOpen, setFunderSheetOpen] = useState(false);
  const [partnerDashboardOpen, setPartnerDashboardOpen] = useState(false);
  const [cashPayoutsOpen, setCashPayoutsOpen] = useState(false);
  const [landlordPayoutFlowOpen, setLandlordPayoutFlowOpen] = useState(false);
  const [floatPayoutOpen, setFloatPayoutOpen] = useState(false);
  const [floatAllocationsOpen, setFloatAllocationsOpen] = useState(false);
  const [selectedFloatAllocation, setSelectedFloatAllocation] = useState<LandlordFloatAllocation | null>(null);
  const [recoveryLedgerOpen, setRecoveryLedgerOpen] = useState(false);
  const [payoutStatusOpen, setPayoutStatusOpen] = useState(false);
  const [otpAuditOpen, setOtpAuditOpen] = useState(false);
  // Standalone landlord-receipt confirmation, reachable any time from the
  // Money tab (not only right after a payout dialog).
  const [receiptCheckOpen, setReceiptCheckOpen] = useState(false);
  // Landlord payments already paid out but still missing the landlord's receipt
  // number. The dialog is a hard lock: it opens on load and stays open (the
  // dialog itself refuses to close) until every payout has its receipt filed.
  const { pendingCount: pendingReceiptCount } = usePendingLandlordReceipts();
  useEffect(() => {
    if (pendingReceiptCount < 1) return;
    setReceiptCheckOpen(true);
  }, [pendingReceiptCount]);
  const [floatHistoryOpen, setFloatHistoryOpen] = useState(false);
  const [requisitionOpen, setRequisitionOpen] = useState(false);
  const [rentPosterOpen, setRentPosterOpen] = useState(false);
  const [regFormKind, setRegFormKind] = useState<'landlord' | 'tenant' | null>(null);
  const [advanceRequestOpen, setAdvanceRequestOpen] = useState(false);
  const [advanceGuideOpen, setAdvanceGuideOpen] = useState(false);
  const [shareLandlordOpen, setShareLandlordOpen] = useState(false);
  const [lendingAgentOpen, setLendingAgentOpen] = useState(false);
  const [borrowOpen, setBorrowOpen] = useState(false);
  const [activeTab, setActiveTab] = useState<AgentHubTab>('home');

  // Dynamic telemetry tracking across agent tabs, sheets, and drawers
  useEffect(() => {
    if (showWallet) {
      userBehaviourTracker.setSection('agent-wallet', 'agent');
    } else if (tenantsSheetOpen) {
      userBehaviourTracker.setSection('agent-my-tenants', 'agent');
    } else if (managedPropertiesSheetOpen) {
      userBehaviourTracker.setSection('agent-managed-properties', 'agent');
    } else if (myRentRequestsOpen || rentRequestOpen) {
      userBehaviourTracker.setSection('agent-rent-requests', 'agent');
    } else if (businessAdvanceOpen) {
      userBehaviourTracker.setSection('agent-shopping-advance', 'agent');
    } else if (phoneOpen) {
      userBehaviourTracker.setSection('agent-smartphones', 'agent');
    } else if (bikeOpen) {
      userBehaviourTracker.setSection('agent-motor-bikes', 'agent');
    } else if (depositOpen || depositCashOpen) {
      userBehaviourTracker.setSection('agent-cash-deposit', 'agent');
    } else if (subAgentsSheetOpen || subAgentLinkOpen) {
      userBehaviourTracker.setSection('agent-subagents', 'agent');
    } else if (welileHomesOpen) {
      userBehaviourTracker.setSection('agent-welile-homes', 'agent');
    } else if (floatAllocationsOpen || floatPayoutOpen) {
      userBehaviourTracker.setSection('agent-landlord-float', 'agent');
    } else if (cashPayoutsOpen) {
      userBehaviourTracker.setSection('agent-cash-payouts', 'agent');
    } else if (landlordPayoutFlowOpen) {
      userBehaviourTracker.setSection('agent-landlord-payout', 'agent');
    } else if (recordCollectionOpen) {
      userBehaviourTracker.setSection('agent-record-collection', 'agent');
    } else if (receiptCheckOpen || receiptOpen) {
      userBehaviourTracker.setSection('agent-receipts', 'agent');
    } else if (recoveryLedgerOpen) {
      userBehaviourTracker.setSection('agent-recovery-ledger', 'agent');
    } else if (regFormKind === 'landlord') {
      userBehaviourTracker.setSection('agent-register-landlord', 'agent');
    } else if (regFormKind === 'tenant') {
      userBehaviourTracker.setSection('agent-register-tenant', 'agent');
    } else if (rentalFinderOpen || myListingsOpen || listHouseOpen) {
      userBehaviourTracker.setSection('agent-house-listings', 'agent');
    } else if (landlordsSheetOpen) {
      userBehaviourTracker.setSection('agent-my-landlords', 'agent');
    } else if (tokenDialogOpen) {
      userBehaviourTracker.setSection('agent-token-dialog', 'agent');
    } else if (visitDialogOpen) {
      userBehaviourTracker.setSection('agent-visit-dialog', 'agent');
    } else if (nearbyTenantsOpen) {
      userBehaviourTracker.setSection('agent-nearby-tenants', 'agent');
    } else if (payoutStatusOpen) {
      userBehaviourTracker.setSection('agent-payout-status', 'agent');
    } else if (payoutDialogOpen) {
      userBehaviourTracker.setSection('agent-payout-dialog', 'agent');
    } else if (lendingAgentOpen || borrowOpen) {
      userBehaviourTracker.setSection('agent-peer-lending', 'agent');
    } else if (investForPartnerOpen) {
      userBehaviourTracker.setSection('agent-invest-partner', 'agent');
    } else if (requisitionOpen) {
      userBehaviourTracker.setSection('agent-requisitions', 'agent');
    } else if (rentPosterOpen) {
      userBehaviourTracker.setSection('agent-rent-poster', 'agent');
    } else {
      // Dynamic tracking of active hub tab (home -> overview, money, tenants, grow, subagents -> service-center)
      const tabName = activeTab === 'home' ? 'overview' : activeTab === 'subagents' ? 'service-center' : activeTab;
      userBehaviourTracker.setSection(`agent-${tabName}`, 'agent');
    }
  }, [
    activeTab,
    showWallet,
    tenantsSheetOpen,
    managedPropertiesSheetOpen,
    myRentRequestsOpen,
    rentRequestOpen,
    businessAdvanceOpen,
    phoneOpen,
    bikeOpen,
    depositOpen,
    depositCashOpen,
    subAgentsSheetOpen,
    subAgentLinkOpen,
    welileHomesOpen,
    floatAllocationsOpen,
    floatPayoutOpen,
    cashPayoutsOpen,
    landlordPayoutFlowOpen,
    recordCollectionOpen,
    receiptCheckOpen,
    receiptOpen,
    recoveryLedgerOpen,
    regFormKind,
    rentalFinderOpen,
    myListingsOpen,
    listHouseOpen,
    landlordsSheetOpen,
    tokenDialogOpen,
    visitDialogOpen,
    nearbyTenantsOpen,
    payoutStatusOpen,
    payoutDialogOpen,
    lendingAgentOpen,
    borrowOpen,
    investForPartnerOpen,
    requisitionOpen,
    rentPosterOpen,
  ]);
  const [slideDirection, setSlideDirection] = useState<'left' | 'right' | null>(null);

  // Deep-link: a "new cash-out to claim" push notification opens the app at
  // /dashboard/agent?section=cash-payouts — auto-open the Merchant Payouts sheet.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get('section') === 'cash-payouts') {
      setCashPayoutsOpen(true);
    }
  }, []);

  // Horizontal swipe → switch hub tabs (mobile gesture)
  // Merchant Agents don't get a "tenants" tab, so it's excluded from the swipe
  // order to keep left/right gestures aligned with the visible tabs. Computed
  // lazily inside the swipe callbacks because `isCashoutAgent` resolves later.
  const getTabOrder = (): AgentHubTab[] =>
    isCashoutAgent
      ? ['home']
      : ['home', 'money', 'tenants', 'grow', 'subagents'];
  const swipeHandlers = useHorizontalSwipe({
    onSwipeLeft: () => {
      const order = getTabOrder();
      const i = order.indexOf(activeTab);
      if (i < order.length - 1) { hapticTap(); setSlideDirection('left'); setActiveTab(order[i + 1]); }
    },
    onSwipeRight: () => {
      const order = getTabOrder();
      const i = order.indexOf(activeTab);
      if (i > 0) { hapticTap(); setSlideDirection('right'); setActiveTab(order[i - 1]); }
    },
  });

  const tabAnimClass = slideDirection === 'left'
    ? 'animate-slide-in-right'
    : slideDirection === 'right'
      ? 'animate-slide-in-left'
      : 'animate-in fade-in duration-200';

  // Announce tab changes to screen readers when triggered by swipe gestures
  const [tabAnnounce, setTabAnnounce] = useState('');
  useEffect(() => {
    if (slideDirection) {
      const labelMap: Record<AgentHubTab, string> = {
        home: 'Home',
        money: 'Money',
        tenants: 'Tenants',
        grow: 'Grow',
        subagents: 'Sub Agents',
      };
      setTabAnnounce(`Switched to ${labelMap[activeTab]} section`);
      setSlideDirection(null);
    }
  }, [activeTab]);

  const [showQuickDeposit, setShowQuickDeposit] = useState(false);
  const [showQuickWithdraw, setShowQuickWithdraw] = useState(false);
  const [showQuickTransfer, setShowQuickTransfer] = useState(false);
  const [collectFromRefOpen, setCollectFromRefOpen] = useState(false);
  const { enabled: payoutsUiEnabled } = usePayoutsUiEnabled();

  const { isFinancialAgent } = useIsFinancialAgent();
  const realWithdrawableBalance = Math.max(0, withdrawableBalance);
  // Check if this agent is a CFO-assigned cashout agent
  const { data: isCashoutAgent } = useQuery({
    queryKey: ['is-cashout-agent', user.id],
    queryFn: async () => {
      const { supabase } = await import('@/integrations/supabase/client');
      const { data, error } = await supabase
        .from('cashout_agents')
        .select('*')
        .eq('agent_id', user.id)
        .eq('is_active', true)
        .maybeSingle();
      // Shares the ['is-cashout-agent', user.id] cache entry with
      // AgentCashPayoutsTab — a swallowed transient error here would
      // overwrite that entry with null and flicker an in-progress claim out
      // of "Claimed by you" there. Throw so a network blip retries instead.
      if (error) throw error;
      return data;
    },
    retry: 2,
  });

  // Pending (unclaimed) merchant payouts + the commission this agent would earn
  // if they claimed and processed them all. Drives the notification badge that
  // sits on top of the "Merchant Payouts" button. 0.5% commission per payout,
  // matching approve-withdrawal.
  const CASHOUT_QUEUE_STATUSES = MERCHANT_QUEUE_STATUSES as unknown as string[];
  const CLAIM_WINDOW_MS = 15 * 60 * 1000;
  const COMMISSION_RATE = 0.005;
  // Mirror the exact filters the Merchant Payouts sheet uses so the badge
  // count can NEVER exceed the number of rows the agent actually sees when
  // they open the queue. Without these filters the badge was counting rows
  // in categories this agent is not authorized to process (and rows from
  // frozen accounts), so users saw "4 unclaimed" and then 0 inside.
  const merchantAgentConfig = useMemo(
    () => (isCashoutAgent ? normalizeCashoutAgentConfig((isCashoutAgent as any).config, isCashoutAgent as any) : null),
    [isCashoutAgent],
  );
  const merchantCategoryOrClause = useMemo(
    () => buildQueueCategoryOrClause(merchantAgentConfig),
    [merchantAgentConfig],
  );
  const { data: pendingEarnings, dataUpdatedAt: pendingUpdatedAt, isFetching: pendingFetching } = useQuery({
    queryKey: ['cashout-pending-earnings', user.id, merchantCategoryOrClause],
    enabled: !!isCashoutAgent && !!merchantAgentConfig,
    staleTime: 30_000,
    refetchInterval: 60_000,
    refetchOnWindowFocus: true,
    queryFn: async () => {
      const { supabase } = await import('@/integrations/supabase/client');
      const cutoffIso = new Date(Date.now() - CLAIM_WINDOW_MS).toISOString();
      // Fetch frozen user ids inline (cheap, cached implicitly by staleTime).
      const { data: frozenRows } = await supabase
        .from('profiles')
        .select('id')
        .eq('is_frozen', true)
        .limit(5000);
      const frozenUserIds = (frozenRows || []).map((r: any) => r.id);
      // Available = unclaimed OR a claim that has expired (>15 min).
      let q = supabase
        .from('withdrawal_requests')
        .select('amount')
        .in('status', CASHOUT_QUEUE_STATUSES)
        .is('processed_at', null)
        .is('fin_ops_reference', null)
        .or(`assigned_cashout_agent_id.is.null,dispatched_at.lt.${cutoffIso}`);
      if (merchantCategoryOrClause) q = q.or(merchantCategoryOrClause);
      if (frozenUserIds.length) {
        const list = `(${frozenUserIds.join(',')})`;
        q = q.not('user_id', 'in', list);
        q = q.or(`linked_party.is.null,linked_party.not.in.${list}`);
      }
      const { data, error } = await q.limit(2000);
      if (error) return { count: 0, totalCommission: 0 };
      const rows = data || [];
      const totalCommission = rows.reduce(
        (sum, r) => sum + Math.round(Number(r.amount || 0) * COMMISSION_RATE),
        0,
      );
      return { count: rows.length, totalCommission };
    },
  });

  // One-time onboarding banner shown the first time an agent becomes a Merchant Agent
  const merchantOnboardKey = `merchant-agent-onboarded:${user.id}`;
  const [showMerchantOnboard, setShowMerchantOnboard] = useState(false);
  useEffect(() => {
    if (isCashoutAgent && typeof window !== 'undefined') {
      setShowMerchantOnboard(localStorage.getItem(merchantOnboardKey) !== '1');
    }
  }, [isCashoutAgent, merchantOnboardKey]);
  const dismissMerchantOnboard = () => {
    try { localStorage.setItem(merchantOnboardKey, '1'); } catch { /* ignore */ }
    setShowMerchantOnboard(false);
  };

  // ── Merchant Agent restriction ───────────────────────────────────────────
  // A Merchant Agent (active row in `cashout_agents`) is SOLELY a payout
  // operator. They must NOT perform tenant operations (invite / pay / repay /
  // post rent requests), landlord operations (payouts / registration) or list
  // empty houses. `isMerchant` hides those surfaces; `guardMerchant()` blocks
  // any action that still gets triggered and shows a friendly explanation.
  const isMerchant = !!isCashoutAgent;
  const visibleAgentFloatBalance = walletFloatBalance;
  // Authoritative merchant payout float — the SAME figure `reserve_merchant_float`
  // enforces (wallet float bucket minus live claim reservations). Read-only RPC.
  const { data: merchantFloat } = useMerchantPayoutFloat(isMerchant);
  const merchantReservedFloat = isMerchant
    ? Math.max(0, Number(merchantFloat?.ownReservedFloat ?? 0))
    : 0;
  const guardMerchant = () => {
    if (!isMerchant) return false;
    import('sonner').then(({ toast }) => toast.error(MERCHANT_RESTRICTION_MESSAGE));
    return true;
  };

  // Merchant Agents are locked to the Home tab. If the active tab ever lands on
  // an operational section (e.g. it was set before the role resolved), snap back.
  useEffect(() => {
    if (isMerchant && activeTab !== 'home') {
      setSlideDirection(null);
      setActiveTab('home');
    }
  }, [isMerchant, activeTab]);

  // Live "updated …" indicator for the Merchant Payouts earnings total.
  // Re-render every 15s so the relative timestamp stays fresh.
  const [nowTick, setNowTick] = useState(Date.now());
  useEffect(() => {
    if (!isCashoutAgent) return;
    const id = setInterval(() => setNowTick(Date.now()), 15_000);
    return () => clearInterval(id);
  }, [isCashoutAgent]);
  const pendingUpdatedLabel = (() => {
    if (!pendingUpdatedAt) return null;
    const secs = Math.max(0, Math.round((nowTick - pendingUpdatedAt) / 1000));
    if (secs < 10) return 'updated just now';
    if (secs < 60) return `updated ${secs}s ago`;
    const mins = Math.round(secs / 60);
    if (mins < 60) return `updated ${mins}m ago`;
    const hrs = Math.round(mins / 60);
    return `updated ${hrs}h ago`;
  })();

  // Guided click: scroll to and briefly highlight the Merchant Payouts button
  const merchantBtnRef = useRef<HTMLButtonElement>(null);
  const merchantCloseBtnRef = useRef<HTMLButtonElement>(null);
  const [highlightMerchant, setHighlightMerchant] = useState(false);
  const guideToMerchantButton = () => {
    hapticTap();
    const previousFocus = document.activeElement as HTMLElement | null;
    merchantBtnRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    setHighlightMerchant(true);
    window.setTimeout(() => {
      setHighlightMerchant(false);
      // Restore focus to the banner close button or last focused element
      (previousFocus && document.contains(previousFocus)
        ? previousFocus
        : merchantCloseBtnRef.current
      )?.focus();
    }, 2200);
    // Move keyboard focus to the button after smooth-scroll settles
    window.setTimeout(() => merchantBtnRef.current?.focus(), 600);
  };

  const handleShareLandlordSignup = () => {
    hapticTap();
    setShareLandlordOpen(true);
  };

  const handleApplyToSell = async () => {
    setApplyingToSell(true);
    try {
      const { supabase } = await import('@/integrations/supabase/client');
      const { error } = await supabase
        .from('profiles')
        .update({ seller_application_status: 'pending' })
        .eq('id', user.id);
      if (error) throw error;
      const { toast } = await import('sonner');
      toast.success('Application submitted! A manager will review your request.');
    } catch (err) {
      const { toast } = await import('sonner');
      toast.error('Failed to submit application');
    } finally {
      setApplyingToSell(false);
    }
  };

  // Progressive rendering: header + cached/empty widgets paint immediately;
  // skeleton placeholders fill data-bound regions until the snapshot lands.
  // We only fall back to the full-page skeleton if the user is OFFLINE with
  // no cache (nothing else can render anyway).
  const showFullSkeleton = loading && !isOnline && !hasLoadedOnce;
  if (showFullSkeleton) {
    return <AgentDashboardSkeleton />;
  }
  const dataLoading = loading && !hasLoadedOnce;
  const moneyTabLoading = walletLoading || balancesLoading || floatLoading;

  const handleRefresh = async () => {
    await Promise.all([refreshOfflineData(), refreshEarnings(), refreshWallet(), refreshBalances()]);
  };

  // Route the side-menu Deposit entry to the same flow used by the hero
  // wallet card so agents have ONE deposit experience, not two. The hero
  // flow defaults to Operational Float (collected rent cash) and still
  // lets the agent switch to Personal Deposit through the existing
  // confirmation gate inside the form.
  const handleDeposit = () => { hapticTap(); setShowQuickDeposit(true); };
  // Direct sub-agent account creation was removed (it auto-created accounts and
  // spammed users). Recruiting now happens only via the shareable invite link.
  const handleInviteSubAgent = () => { hapticTap(); setShareLinkOpen(true); };

  // Registration form handlers — open a choice dialog offering both an explicit
  // Download and a Share on WhatsApp action (not share-only).
  const handleDownloadLandlordForm = () => {
    hapticTap();
    setMenuOpen(false);
    setRegFormKind('landlord');
  };

  const handleDownloadTenantForm = () => {
    hapticTap();
    setMenuOpen(false);
    setRegFormKind('tenant');
  };

  const handleViewWallet = () => { hapticTap(); setShowWallet(true); };
  const handleOpenMenu = () => { hapticTap(); setMenuOpen(true); };




  // Spiro bike ordering now runs through SpiroBikeOrderDialog (fixed base price
  // plus a period-based access fee) and is reviewed by Agent Ops.


  const menuItems = [
    { icon: Store, label: 'Service Center', onClick: () => { hapticTap(); navigate('/agent/service-center'); } },
    { icon: ShoppingBag, label: 'Buy Merchandise', onClick: () => { hapticTap(); navigate('/merchandise'); } },
  ];

  const quickActions = [] as any[];

  return (
    <AgentFrozenGate>
    <OperatingLocationGate />
    <div className="agent-dashboard-shell h-[100dvh] bg-background flex flex-col overflow-hidden">
      <OfflineBanner />
      <PendingDraftsBanner />
      <DashboardDataErrorBanner
        message={loadError}
        hasCachedData={hasLoadedOnce}
        onRetry={handleRefresh}
      />
      
      <BikeLeaseDormancyBanner />
      <DashboardHeader
        currentRole={currentRole}
        availableRoles={availableRoles}
        onRoleChange={onRoleChange}
        onSignOut={signOut}
        menuItems={menuItems}
      />

      <div className="agent-dashboard-scroll flex-1 overflow-y-auto overflow-x-hidden pb-nav">
        <main className="agent-dashboard-main w-full min-w-0 px-4 pt-5 pb-16 space-y-5 max-w-lg mx-auto">
        {/* Offline Notice */}
        {!isOnline && (
          <div className="flex items-center gap-2.5 px-3 py-2 rounded-xl bg-warning/10 border border-warning/20">
            <WifiOff className="h-3.5 w-3.5 text-warning shrink-0" />
            <p className="text-xs text-warning flex-1">You're offline — data may be outdated</p>
            <Button size="sm" variant="ghost" className="h-7 w-7 p-0" onClick={() => window.location.reload()}>
              <RefreshCw className="h-3 w-3" />
            </Button>
          </div>
        )}

        <AgentAgreementBanner />
        <MissionBanner dashboardRole="agent" />
        <AgentPaymentEditAlert agentId={user.id} />
        {!isMerchant && <AgentReturnedInactivationsPanel />}

        {/* Landlord verification rejections — edit & resubmit, or dismiss */}
        <AgentRejectedLandlordsPanel />

        {/* Linked-but-uncredited deposits — surfaces stuck float receipts */}
        <AgentPendingReceiptPanel />

        {/* Profile + Name + AI ID */}
        {profileLoading && !profile ? (
          <div className="flex flex-col gap-2">
            <div className="flex items-center gap-3">
              <Skeleton className="h-11 w-11 rounded-full shrink-0" />
              <div className="flex-1 min-w-0 space-y-2">
                <Skeleton className="h-5 w-40" />
                <Skeleton className="h-3 w-24" />
              </div>
              <div className="hidden sm:flex items-center gap-2">
                <Skeleton className="h-8 w-8 rounded-lg" />
                <Skeleton className="h-8 w-8 rounded-lg" />
              </div>
            </div>
            <div className="flex sm:hidden justify-end gap-2">
              <Skeleton className="h-8 w-8 rounded-lg" />
              <Skeleton className="h-8 w-8 rounded-lg" />
            </div>
          </div>
        ) : (
          <div className="flex flex-col gap-2">
            <div className="flex items-center gap-3">
              <ProfileSummaryPopover
                avatarUrl={profile?.avatar_url}
                fullName={profile?.full_name}
                phone={(profile as any)?.phone}
                email={(profile as any)?.email}
                location={(profile as any)?.territory ?? (profile as any)?.location}
                verified={profile?.verified}
                roleLabel="Welile Agent"
                triggerSize="lg"
              />
              <div className="flex-1 min-w-0">
                <h1 className="font-bold text-xl leading-tight flex items-center gap-1.5 flex-wrap">
                  <span className="break-words">{profile?.full_name || 'Agent'}</span>
                  {profile?.verified && (
                    <BadgeCheck className="h-4 w-4 text-primary fill-primary/20 shrink-0" />
                  )}
                </h1>
                <p className="text-xs text-muted-foreground mt-0.5">Welile Agent{profile?.territory ? ` · ${profile.territory}` : ''}</p>
                <div className="mt-1.5">
                  <AiIdButton variant="compact" />
                </div>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <AgentNotificationBell userId={user.id} />
              </div>
            </div>
          </div>
        )}

        {/* Active devices / multi-session indicator + performance pill */}
        <div className="flex items-center justify-between -mt-2 gap-2">
          {mySubagentRank ? (
            <button
              type="button"
              onClick={() => { hapticTap(); navigate('/dashboard/agents/leaderboard'); }}
              className="inline-flex w-fit items-center gap-1 rounded-full bg-primary px-2.5 py-1 text-xs font-bold text-primary-foreground shadow-sm transition-colors hover:bg-primary/90"
            >
              <Trophy className="h-3 w-3" />
              Top Performer #{mySubagentRank.rank}
            </button>
          ) : (
            <span />
          )}
          <DeviceSessionIndicator userId={user.id} />
        </div>

        {/* Wallet Hero Card — always visible */}
        {wallet ? (
          <UnifiedWalletHeroCard
          balance={
            isMerchant
              ? realWithdrawableBalance
              : Math.max(0, visibleAgentFloatBalance - merchantReservedFloat) +
                realWithdrawableBalance
          }
          role="agent"
          // Merchant Agents never see the generic operational-float box here —
          // it's company custody money, not theirs to Deposit/Withdraw/Transfer
          // via this card's action buttons, and MerchantFloatAvailableCard
          // (rendered on their Home tab) is the single, correctly-guardrailed
          // place that explains and displays it ("Company cash in your hands").
          // Showing it in both places invited exactly that confusion.
          floatBalance={isMerchant ? undefined : visibleAgentFloatBalance}
          floatReserved={isMerchant ? undefined : merchantReservedFloat}
          floatCaption={undefined}
          commissionBalance={commissionBalance}
          withdrawableBalance={realWithdrawableBalance}
          otherBalance={otherBalance}
          onOpenWallet={() => setShowWallet(true)}
          onViewStatement={() => { setWalletScrollTarget('statement'); setShowWallet(true); }}
          quickActions={
            <div className="flex items-center gap-2.5">
              <button
                onClick={() => { hapticTap(); setShowQuickDeposit(true); }}
                className="flex-1 flex items-center justify-center gap-1.5 py-2.5 rounded-xl border border-white/20 hover:bg-white/10 active:scale-95 transition-all min-h-[44px]"
                style={{ WebkitTapHighlightColor: 'transparent' }}
              >
                <ArrowDownLeft className="h-4 w-4 text-white" />
                <span className="text-[11px] font-bold text-white uppercase tracking-wider">Deposit</span>
              </button>
              <button
                onClick={() => {
                  hapticTap();
                  if (payoutsUiEnabled) setShowQuickWithdraw(true);
                  else toast.info('Withdrawals are temporarily disabled.');
                }}
                disabled={!payoutsUiEnabled}
                aria-disabled={!payoutsUiEnabled}
                title={payoutsUiEnabled ? undefined : 'Withdrawals are temporarily disabled'}
                className={`flex-1 flex items-center justify-center gap-1.5 py-2.5 rounded-xl border min-h-[44px] ${payoutsUiEnabled ? 'border-white/20 hover:bg-white/10 active:scale-95 transition-all' : 'border-white/10 bg-white/5 opacity-50 cursor-not-allowed'}`}
                style={{ WebkitTapHighlightColor: 'transparent' }}
              >
                <ArrowUpRight className="h-4 w-4 text-white" />
                <span className="text-[11px] font-bold text-white uppercase tracking-wider">Withdraw</span>
              </button>
              <button
                onClick={() => { hapticTap(); setShowQuickTransfer(true); }}
                className="flex-1 flex items-center justify-center gap-1.5 py-2.5 rounded-xl border border-white/20 hover:bg-white/10 active:scale-95 transition-all min-h-[44px]"
                style={{ WebkitTapHighlightColor: 'transparent' }}
              >
                <Send className="h-4 w-4 text-white" />
                <span className="text-[11px] font-bold text-white uppercase tracking-wider">Transfer</span>
              </button>
            </div>
          }
          />
        ) : (
          // Wallet still loading — show the skeleton AND a tappable Deposit
          // strip so the agent never feels like the dashboard is "frozen".
          // Without this, the hero Deposit button doesn't exist for the
          // first ~1–3s after the dashboard mounts and taps appear to do
          // nothing, which is the most common "deposit button is broken"
          // complaint.
          <div className="space-y-3">
            <WalletHeroSkeleton />
            <div className="flex items-center gap-2.5 px-1">
              <button
                onClick={() => { hapticTap(); setShowQuickDeposit(true); }}
                className="flex-1 flex items-center justify-center gap-1.5 py-2.5 rounded-xl border border-border bg-muted/40 hover:bg-muted active:scale-95 transition-all min-h-[44px]"
                style={{ WebkitTapHighlightColor: 'transparent' }}
              >
                <ArrowDownLeft className="h-4 w-4 text-muted-foreground" />
                <span className="text-[11px] font-bold text-muted-foreground uppercase tracking-wider">Deposit</span>
              </button>
              <button
                onClick={() => {
                  hapticTap();
                  if (payoutsUiEnabled) setShowQuickWithdraw(true);
                  else toast.info('Withdrawals are temporarily disabled.');
                }}
                disabled={!payoutsUiEnabled}
                aria-disabled={!payoutsUiEnabled}
                title={payoutsUiEnabled ? undefined : 'Withdrawals are temporarily disabled'}
                className={`flex-1 flex items-center justify-center gap-1.5 py-2.5 rounded-xl border border-border min-h-[44px] ${payoutsUiEnabled ? 'bg-muted/40 hover:bg-muted active:scale-95 transition-all' : 'bg-muted/40 opacity-50 cursor-not-allowed'}`}
                style={{ WebkitTapHighlightColor: 'transparent' }}
              >
                <ArrowUpRight className="h-4 w-4 text-muted-foreground" />
                <span className="text-[11px] font-bold text-muted-foreground uppercase tracking-wider">Withdraw</span>
              </button>
              <button
                onClick={() => { hapticTap(); setShowQuickTransfer(true); }}
                className="flex-1 flex items-center justify-center gap-1.5 py-2.5 rounded-xl border border-border bg-muted/40 hover:bg-muted active:scale-95 transition-all min-h-[44px]"
                style={{ WebkitTapHighlightColor: 'transparent' }}
              >
                <Send className="h-4 w-4 text-muted-foreground" />
                <span className="text-[11px] font-bold text-muted-foreground uppercase tracking-wider">Transfer</span>
              </button>
            </div>
          </div>
        )}

        {/* Live cash-with-agent deposit codes targeting this agent */}
        <AgentCashDepositCodesPanel />

        {/* Aggressive overdue field-chase (Faith) — banner+modal when book due/overdue.
            Kill-switch: src/lib/agentOverdueChaseFlag.ts. Merchant agents skipped. */}
        {!isMerchant && user?.id && <AgentOverdueChase agentId={user.id} />}

        {/* Tab Navigation — scrolls with the dashboard so the Service Center / Proxy Agents buttons never float */}
        <div className="-mx-4 px-4 py-2 bg-background border-b border-border/40 overflow-x-auto overflow-y-hidden scrollbar-hide">
          <AgentHubTabs
            active={activeTab}
            restricted={isMerchant}
            onChange={(tab) => {
              // Merchant Agents are locked to Home only.
              if (isMerchant && tab !== 'home') { guardMerchant(); return; }
              // Tapping the "Service Center" icon opens the Agent Service Center page.
              if (tab === 'subagents') { navigate('/agent/service-center'); return; }
              setSlideDirection(null);
              setActiveTab(tab);
            }}
            onProxyAgentsClick={isApprovedProxyAgent ? () => navigate('/dashboard/agent/proxy') : undefined}
          />
        </div>

        {/* Screen-reader live region announces the active hub tab after a swipe gesture */}
        <div role="status" aria-live="polite" aria-atomic="true" className="sr-only">
          {tabAnnounce}
        </div>

        {/* Swipe surface — left/right gestures navigate adjacent hub tabs */}
        <div {...swipeHandlers} className="touch-pan-y">
        {/* === HOME TAB === Most-used actions, at-a-glance */}
        {activeTab === 'home' && isMerchant && isCashoutAgent && (
          <div className={cn("space-y-4", tabAnimClass)}>
            <MerchantDashboardHome
              agentId={user.id}
              cashoutAgentId={(isCashoutAgent as any)?.id ?? null}
              withdrawableBalance={realWithdrawableBalance}
              floatBalance={visibleAgentFloatBalance}
              pendingCount={pendingEarnings?.count ?? 0}
              pendingCommission={pendingEarnings?.totalCommission ?? 0}
              handlesCash={!!isCashoutAgent.handles_cash}
              onOpenCashPayouts={() => setCashPayoutsOpen(true)}
              onDeposit={() => setShowQuickDeposit(true)}
              onWithdraw={() => setShowQuickWithdraw(true)}
              onTransfer={() => setShowQuickTransfer(true)}
              onViewWallet={() => { setWalletScrollTarget(null); setShowWallet(true); }}
              onViewStatement={() => { setWalletScrollTarget('statement'); setShowWallet(true); }}
            />
          </div>
        )}
        {activeTab === 'home' && !isMerchant && (
          <div className={cn("space-y-4", tabAnimClass)}>
            {/* Collection League — weekly team competition (active agents only) */}
            {!isMerchant && (repayingTenantLoading || hasRepayingTenant) && <AgentCollectionLeagueCard />}

            {/* Free Service Center qualification — permanent milestone tracker */}
            {!isMerchant && (
              <>
              <LastWeekWinnerOverlay />
              <WeeklyChampionTeamDialog />
              <TenantLocationCorrectionPopup agentId={user.id} />
              <WeeklyStreakDialog />
              <ServiceCenterQualificationCard agentId={user.id} />
              </>
            )}

            {/* Merchant Agent invites moved to CTO dashboard → "Merchant Invites" tab */}

            {/*

             * Minimalist home: priorities lead → today's total → urgent alerts →
             * secondary shortcuts → single "Grow" button. Everything else
             * (advances, lending, sub-agents, partners, etc.) lives behind the
             * "Grow" button via AgentMenuDrawer so no functionality is lost.
             */}

            {/* 0b) MERCHANT AGENT — highest prominence, full-bleed gradient CTA */}
            {isCashoutAgent && showMerchantOnboard && (
              <div className="w-full rounded-2xl border border-primary/30 bg-primary/5 p-4 relative animate-fade-in">
                <button
                  ref={merchantCloseBtnRef}
                  onClick={dismissMerchantOnboard}
                  aria-label="Dismiss"
                  className="absolute top-3 right-3 p-1 rounded-md text-muted-foreground hover:text-foreground hover:bg-muted/60 transition-colors touch-manipulation"
                >
                  <X className="h-4 w-4" />
                </button>
                <div className="flex items-start gap-3 pr-6">
                  <div className="p-2 rounded-lg bg-primary/10 shrink-0">
                    <Sparkles className="h-5 w-5 text-primary" />
                  </div>
                  <div className="min-w-0">
                    <p className="font-semibold text-sm text-foreground">You're now a Merchant Agent!</p>
                    <p className="text-xs text-muted-foreground mt-1 leading-relaxed">
                      Use the highlighted <span className="font-medium text-foreground">Merchant Payouts</span> button
                      below to process MoMo, bank{isCashoutAgent.handles_cash ? ', and cash' : ''} payouts for customers.
                      Tap it any time to get started.
                    </p>
                    <button
                      onClick={guideToMerchantButton}
                      className="mt-3 text-xs font-semibold text-primary hover:underline"
                    >
                      Show me where →
                    </button>
                  </div>
                </div>
              </div>
            )}

            {isCashoutAgent && (
              <button
                ref={merchantBtnRef}
                onClick={() => { hapticTap(); setCashPayoutsOpen(true); }}
                className={cn(
                  "w-full flex items-center gap-2.5 sm:gap-4 p-3.5 sm:p-5 rounded-2xl border border-warning/60 bg-warning bg-gradient-to-br from-warning to-amber-600 shadow-lg shadow-warning/20 touch-manipulation active:scale-[0.97] transition-all min-h-[72px] relative overflow-hidden",
                  highlightMerchant && "ring-4 ring-primary ring-offset-2 ring-offset-background animate-pulse scale-[1.02]"
                )}
                style={{ WebkitTapHighlightColor: 'transparent' }}
              >
                {/* subtle shimmer strip */}
                <div className="absolute inset-0 -translate-x-full animate-[shimmer_2.5s_infinite] bg-gradient-to-r from-transparent via-white/20 to-transparent pointer-events-none" />
                <div className="p-2 sm:p-3 rounded-xl bg-white/20 shrink-0">
                  <Banknote className="h-5 w-5 sm:h-6 sm:w-6 text-white" />
                </div>
                <div className="flex-1 text-left min-w-0 relative">
                  <p className="font-bold text-sm sm:text-base text-white truncate">Merchant Payouts</p>
                  <p className="text-xs text-white/80 truncate">
                    {pendingEarnings && pendingEarnings.count > 0
                      ? `${pendingEarnings.count} unclaimed ${pendingEarnings.count === 1 ? 'request' : 'requests'} waiting`
                      : `MoMo · Bank${isCashoutAgent.handles_cash ? ' · Cash' : ''}`}
                  </p>
                </div>
                <span className="text-base font-bold text-white shrink-0 relative">Open →</span>
            </button>
            )}


            {/* 1) Priorities first — Collect Rent · Add Tenant · List House */}
            <AgentPriorityGrid
              agentId={user.id}
              restricted={isMerchant}
              onOpenNewTenant={() => { if (guardMerchant()) return; setRentRequestOpen(true); }}
              onOpenListHouse={() => {
                if (guardMerchant()) return;
                if (!guardListingHours()) return;
                hapticTap();
                setListHouseFromPromo(false);
                setListHouseOpen(true);
              }}
            />

            {isFinancialAgent && (
              <Card className="border-primary/30 bg-primary/5 shadow-sm">
                <CardContent className="flex items-center gap-3 p-4 sm:p-5">
                  <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl bg-primary text-primary-foreground shadow-sm">
                    <FileText className="h-6 w-6" strokeWidth={2.2} />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <p className="text-sm font-bold text-foreground">Post an Operations Requisition</p>
                      <Badge variant="secondary" className="text-[10px]">Financial Agent</Badge>
                    </div>
                    <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                      Request operational funds and send them to the CFO for review.
                    </p>
                  </div>
                  <Button
                    type="button"
                    size="sm"
                    className="shrink-0 gap-1.5 font-semibold"
                    onClick={() => { hapticTap(); setRequisitionOpen(true); }}
                  >
                    <Send className="h-4 w-4" />
                    Post
                  </Button>
                </CardContent>
              </Card>
            )}


            {/* 2) Today's collected total — single most useful at-a-glance number */}
            {!isMerchant && <FieldCollectDailyTotals live />}

            {/* 4) Live rating — today vs target + 7-day capacity tier */}
            {!isMerchant && <AgentRatingCard agentId={user.id} />}

            {/* 2b) Earnings summary — available rewards + lifetime total */}
            {!isMerchant && (
              <>
                <EarningsSummaryCard />

                {/* Products being repaid — plan + pay button per product */}
                <MerchandiseRepaymentPortfolio userId={user.id} />


                {/* Merchandise store shortcut */}
                <button
                  type="button"
                  onClick={() => { hapticTap(); navigate('/merchandise'); }}
                  className="w-full flex items-center justify-between gap-3 px-4 py-3 rounded-2xl border border-primary/25 bg-primary/5 hover:bg-primary/10 transition-colors text-left touch-manipulation min-h-[56px]"
                  style={{ WebkitTapHighlightColor: 'transparent' }}
                >
                  <div className="flex items-center gap-3 min-w-0">
                    <ShoppingBag className="h-5 w-5 text-primary shrink-0" />
                    <div className="min-w-0">
                      <div className="text-sm font-semibold text-foreground">Buy Merchandise</div>
                      <div className="text-[11px] text-muted-foreground truncate">
                        Order branded gear — paid off from your wallet
                      </div>
                    </div>
                  </div>
                  <span className="text-xs font-medium text-primary shrink-0">Shop →</span>
                </button>

                {/* Order a Welile Smartphone */}
                <Card className="border-primary/30 bg-primary/5">
                  <CardContent className="p-4 flex items-center gap-3">
                    <img
                      src={smartphonePromoAsset.url}
                      alt="Welile Smartphone"
                      loading="lazy"
                      className="h-11 w-11 rounded-xl object-cover shrink-0 border border-primary/20"
                    />
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-bold leading-tight">Order a Welile Smartphone</p>
                      <p className="text-[11px] text-muted-foreground mt-0.5">
                        Get a company smartphone on credit. Choose how much can be deducted from your wallet.
                      </p>
                    </div>
                    <Button
                      size="sm"
                      className="h-8 text-xs gap-1 shrink-0"
                      disabled={smartphoneRepaying}
                      title={smartphoneRepaying ? 'You have a smartphone still being repaid' : undefined}
                      onClick={() => setPhoneOpen(true)}
                    >
                      {smartphoneRepaying ? 'In repayment' : 'Order'}
                    </Button>

                  </CardContent>
                </Card>

                {/* Smartphone order status */}
                <SmartphoneOrderStatus userId={user.id} onRequestNewOrder={() => setPhoneOpen(true)} />

                {/* Order a Welile Spiro Bike */}
                <Card className="border-primary/30 bg-primary/5">
                  <CardContent className="p-4 flex items-center gap-3">
                    <img
                      src={spiroBikeAsset.url}
                      alt="Welile Spiro electric bike"
                      loading="lazy"
                      className="h-11 w-11 rounded-xl object-cover shrink-0 border border-primary/20"
                    />
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-bold leading-tight">Order a Welile Spiro Bike</p>
                      <p className="text-[11px] text-muted-foreground mt-0.5">
                        Ride green, earn faster — get your Spiro Electric Bike with flexible daily payments!
                      </p>
                    </div>
                    <Button size="sm" className="h-8 text-xs gap-1 shrink-0" onClick={() => { setBikeAmount(''); setBikeOpen(true); }}>
                      Order
                    </Button>
                  </CardContent>
                </Card>

                {/* Spiro bike order status */}
                <SmartphoneOrderStatus
                  userId={user.id}
                  itemName="Welile Spiro Bike"
                  title="Spiro bike order status"
                  onRequestNewOrder={() => { setBikeAmount(''); setBikeOpen(true); }}
                />
              </>
            )}

            {/* 3) Urgent: duplicates that need reconciliation */}
            {duplicateCount > 0 && (
              <button
                type="button"
                onClick={() => setReconcileOpen(true)}
                className="w-full flex items-center justify-between gap-3 px-4 py-3 rounded-2xl border border-warning/30 bg-warning/10 hover:bg-warning/20 transition-colors text-left touch-manipulation min-h-[56px]"
                style={{ WebkitTapHighlightColor: 'transparent' }}
              >
                <div className="flex items-center gap-3 min-w-0">
                  <FileWarning className="h-5 w-5 text-warning shrink-0" />
                  <div className="min-w-0">
                    <div className="text-sm font-semibold text-foreground">
                      {duplicateCount} receipt{duplicateCount === 1 ? '' : 's'} need a check
                    </div>
                    <div className="text-[11px] text-muted-foreground truncate">
                      Tap to review
                    </div>
                  </div>
                </div>
                <span className="text-xs font-medium text-warning shrink-0">Review →</span>
              </button>
            )}

            {/* 5) Secondary shortcuts — collected receipt helper + my listed houses */}
            {!isMerchant && (
              <>
                <button
                  type="button"
                  onClick={() => { hapticTap(); setMyListingsVacantOnly(false); setMyListingsOpen(true); }}
                  aria-label="View my listed houses"
                  title="View my listed houses"
                  className="w-full flex items-center justify-between gap-3 px-4 py-2.5 rounded-xl border border-border/60 bg-card hover:bg-accent/40 active:scale-[0.99] transition-all text-left touch-manipulation min-h-[44px] focus:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-background"
                  style={{ WebkitTapHighlightColor: 'transparent' }}
                >
                  <span className="flex items-center gap-2 text-sm font-semibold text-foreground">
                    <Home className="h-4 w-4 text-muted-foreground" />
                    My listed houses
                  </span>
                  <span className="text-xs font-medium text-primary">View →</span>
                </button>

                {/*
                 * Collect from a receipt / reference: paste a MoMo TID or bank ref
                 * captured in the field and we auto-build the per-tenant breakdown.
                 */}
                <button
                  type="button"
                  onClick={() => { hapticTap(); setCollectFromRefOpen(true); }}
                  className="w-full flex items-center justify-between gap-3 px-4 py-2.5 rounded-xl border border-border/60 bg-card hover:bg-accent/40 active:scale-[0.99] transition-all text-left touch-manipulation min-h-[44px] focus:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-background"
                  style={{ WebkitTapHighlightColor: 'transparent' }}
                >
                  <span className="flex items-center gap-2 text-sm font-semibold text-foreground">
                    <FileText className="h-4 w-4 text-muted-foreground" />
                    Collect from a receipt
                  </span>
                  <span className="text-xs font-medium text-primary">Open →</span>
                </button>
              </>
            )}

          </div>
        )}

        {/* === MONEY TAB === Wallet, advances, payouts, recovery */}
        {activeTab === 'money' && (
          <div className={cn("space-y-5", tabAnimClass)}>
            {/* Prominent Agent Advance promo — high-visibility entry point so
                agents always see the cash they can access instantly. */}
            <div className="relative w-full overflow-hidden rounded-3xl border border-primary/30 bg-gradient-to-br from-card via-card to-primary/10 p-5 text-card-foreground shadow-lg ring-1 ring-primary/20">
              <div className="relative">
                <div className="flex items-center gap-2">
                  <div className="rounded-full bg-primary/15 p-1.5 text-primary">
                    <Briefcase className="h-4 w-4" strokeWidth={2.2} />
                  </div>
                  <span className="text-[10px] font-bold uppercase tracking-widest text-primary dark:text-white">Agent Advance</span>
                </div>
                <p className="mt-3 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground dark:text-white">You can access now</p>
                <p className="mt-1 text-3xl font-black leading-none text-primary dark:text-white whitespace-pre-line">
                  {formatCreditAmount(advanceLimit?.totalLimit || 30000)}
                </p>
                <div className="mt-2 inline-flex items-center gap-1.5 rounded-full bg-primary/10 px-2.5 py-1 text-[11px] font-bold text-primary dark:text-white">
                  <TrendingUp className="h-3.5 w-3.5" strokeWidth={2.4} />
                  Grow up to UGX 30,000,000 as you perform better
                </div>
                <p className="mt-2 text-[13px] font-medium text-foreground dark:text-white leading-snug">
                  Cash straight to your wallet · repay over up to 12 months. Clear it early to unlock a bigger advance.
                </p>
                <div className="mt-3 flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    onClick={() => { hapticTap(); setAdvanceRequestOpen(true); }}
                    className="inline-flex items-center gap-1.5 rounded-full bg-primary px-3.5 py-1.5 text-xs font-bold text-primary-foreground shadow-sm active:scale-[0.97] transition-transform touch-manipulation"
                    style={{ WebkitTapHighlightColor: 'transparent' }}
                  >
                    Request advance <ChevronRight className="h-3.5 w-3.5" />
                  </button>
                  <button
                    type="button"
                    onClick={() => { hapticTap(); setAdvanceGuideOpen(true); }}
                    className="inline-flex items-center gap-1.5 rounded-full border border-primary/40 bg-primary/5 px-3.5 py-1.5 text-xs font-bold text-primary dark:text-white active:scale-[0.97] transition-transform touch-manipulation"
                    style={{ WebkitTapHighlightColor: 'transparent' }}
                  >
                    <Sparkles className="h-3.5 w-3.5" /> How to increase my limit
                  </button>
                </div>
              </div>
            </div>

            {/* Quick-access money cards: 4 clear destinations */}
            {moneyTabLoading ? (
              <MetricRowSkeleton count={4} />
            ) : (
              <div className="grid grid-cols-2 gap-3">
                {[
                  {
                    key: 'landlord',
                    label: 'Landlord Float',
                    sub: landlordFloatReserved > 0
                      ? `${formatUGX(landlordFloatReserved)} reserved or being returned`
                      : 'CFO funds for landlord payouts',
                    amount: landlordPayoutFloat,
                    icon: Landmark,
                    tone: 'text-[#9234EA]',
                    ring: 'ring-[#9234EA]/30',
                    bg: 'bg-[#9234EA]/10',
                    onClick: () => { hapticTap(); setFloatAllocationsOpen(true); },
                  },
                ].filter((c) => !(isMerchant && c.key === 'landlord')).map((c) => {
                  const Icon = c.icon;
                  return (
                    <button
                      key={c.key}
                      onClick={c.onClick}
                      className={cn(
                        'flex flex-col items-start gap-2 p-4 rounded-2xl bg-card border border-border/60 ring-1 w-full col-span-2',
                        c.ring,
                        'active:scale-[0.97] transition-all touch-manipulation text-left min-h-[112px]',
                      )}
                      style={{ WebkitTapHighlightColor: 'transparent' }}
                    >
                      <div className="flex w-full items-center justify-between">
                        <div className={cn('p-2 rounded-xl', c.bg)}>
                          <Icon className={cn('h-5 w-5', c.tone)} strokeWidth={2.2} />
                        </div>
                        <ChevronRight className="h-4 w-4 text-muted-foreground" />
                      </div>
                      <div className="w-full">
                        <p className="text-[13px] font-bold text-foreground leading-tight">{c.label}</p>
                        {c.amount !== null ? (
                          <p className={cn('text-base font-extrabold mt-0.5 truncate', c.tone)}>
                            {formatUGX(c.amount)}
                          </p>
                        ) : (
                          <p className="text-base font-extrabold mt-0.5 text-foreground">Open →</p>
                        )}
                        <p className="text-[10px] text-muted-foreground leading-snug mt-0.5">{c.sub}</p>
                      </div>
                    </button>
                  );
                })}
              </div>
            )}

            <AgentConvertToFloatCard />

            <AgentCompanyDebtCard onViewBreakdown={() => { hapticTap(); setTenantsSheetOpen(true); }} />
            <AgentMyAdvancesCard />
            <AgentRiskExposureCard />
            <EarnedSinceLastWithdrawalCard />
            {!isMerchant && (
            <AgentLandlordFloatCard
              onPayLandlord={() => { hapticTap(); setFloatAllocationsOpen(true); }}
              onOpenRecovery={() => { hapticTap(); setRecoveryLedgerOpen(true); }}
              onOpenHistory={() => { hapticTap(); setFloatHistoryOpen(true); }}
              onOpenStatusTracker={() => { hapticTap(); setPayoutStatusOpen(true); }}
              onOpenOtpAudit={() => { hapticTap(); setOtpAuditOpen(true); }}
            />
            )}
            {!isMerchant && isLandlordReceiptConfirmationEffective() && (
              <button
                onClick={() => { hapticTap(); setReceiptCheckOpen(true); }}
                className="w-full flex items-center gap-3 p-4 rounded-2xl bg-card border border-border/60 ring-1 ring-[#9234EA]/30 active:scale-[0.98] transition-all touch-manipulation"
                style={{ WebkitTapHighlightColor: 'transparent' }}
              >
                <div className="p-2.5 rounded-xl bg-[#9234EA]/10">
                  <Receipt className="h-5 w-5 text-[#9234EA]" strokeWidth={2.2} />
                </div>
                <div className="flex-1 text-left">
                  <div className="font-bold text-sm text-foreground">Confirm landlord payment</div>
                  <div className="text-[11px] text-muted-foreground">
                    Enter the receipt number the landlord received by SMS to confirm the landlord float payment
                  </div>
                </div>
                <ChevronRight className="h-4 w-4 text-muted-foreground" />
              </button>
            )}
            <button
              onClick={() => { hapticTap(); setBusinessAdvanceOpen(true); }}
              className="w-full flex items-center gap-3 p-4 rounded-2xl bg-gradient-to-r from-primary/15 via-primary/10 to-primary/5 ring-1 ring-primary/30 active:scale-[0.98] transition-all touch-manipulation"
              style={{ WebkitTapHighlightColor: 'transparent' }}
            >
              <div className="p-2.5 rounded-xl bg-primary text-primary-foreground shadow-md">
                <Briefcase className="h-5 w-5" strokeWidth={2.2} />
              </div>
              <div className="flex-1 text-left">
                <div className="font-bold text-sm text-foreground">Business Advance</div>
                <div className="text-[11px] text-muted-foreground">Request advance for tenant's business · Earn 4% on every repayment</div>
              </div>
              <span className="text-xs font-bold text-primary">→</span>
            </button>
            <button
              onClick={() => { hapticTap(); setLendingAgentOpen(true); }}
              className="w-full flex items-center gap-3 p-4 rounded-2xl bg-gradient-to-r from-emerald-500/15 via-emerald-500/10 to-primary/5 ring-1 ring-emerald-500/30 active:scale-[0.98] transition-all touch-manipulation"
              style={{ WebkitTapHighlightColor: 'transparent' }}
            >
              <div className="p-2.5 rounded-xl bg-emerald-600 text-white shadow-md">
                <Banknote className="h-5 w-5" strokeWidth={2.2} />
              </div>
              <div className="flex-1 text-left">
                <div className="font-bold text-sm text-foreground">Lending Agent</div>
                <div className="text-[11px] text-muted-foreground">Lend to Welile users from your wallet · Earn interest</div>
                <div className="mt-1 inline-flex items-center gap-1 rounded-md bg-emerald-600/15 px-1.5 py-0.5 text-[10px] font-bold text-emerald-700">
                  <ShieldCheck className="h-3 w-3" strokeWidth={2.4} />
                  Principal 100% protected by Welile
                </div>
              </div>
              <span className="text-xs font-bold text-emerald-700">→</span>
            </button>
            <button
              onClick={() => { hapticTap(); setBorrowOpen(true); }}
              className="w-full flex items-center gap-3 p-4 rounded-2xl bg-gradient-to-r from-primary/15 via-primary/10 to-emerald-500/5 ring-1 ring-primary/30 active:scale-[0.98] transition-all touch-manipulation"
              style={{ WebkitTapHighlightColor: 'transparent' }}
            >
              <div className="p-2.5 rounded-xl bg-primary text-white shadow-md">
                <HandCoins className="h-5 w-5" strokeWidth={2.2} />
              </div>
              <div className="flex-1 text-left">
                <div className="font-bold text-sm text-foreground">Borrow a Loan</div>
                <div className="text-[11px] text-muted-foreground">Browse lending agents' offers · Request a loan</div>
              </div>
              <span className="text-xs font-bold text-primary">→</span>
            </button>
            <RecentAutoCharges />
            <StuckDepositsRepairPanel agentId={user.id} />
          </div>
        )}

        {/* === TENANTS TAB === Clean tenant list with big tap targets.
            Never rendered for Merchant Agents (tenant operations disabled). */}
        {activeTab === 'tenants' && !isMerchant && (
          <div className={cn("space-y-4 pb-24", tabAnimClass)}>
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
              <h2 className="text-base sm:text-lg font-bold text-foreground">My Tenants</h2>
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  variant="outline"
                  onClick={() => { hapticTap(); setWelileHomesOpen(true); }}
                  className="h-9 sm:h-11 px-2.5 sm:px-3 text-xs sm:text-sm font-bold rounded-xl gap-1.5"
                >
                  <Home className="h-3.5 w-3.5 sm:h-4 sm:w-4" />
                  Welile Homes
                </Button>
                <Button
                  onClick={() => { hapticTap(); setRentRequestOpen(true); }}
                  className="h-9 sm:h-11 px-3 sm:px-4 text-xs sm:text-sm font-bold rounded-xl gap-1.5 bg-primary text-primary-foreground hover:bg-primary/90 dark:text-white"
                >
                  <UserPlus className="h-3.5 w-3.5 sm:h-4 sm:w-4" />
                  Add Tenant
                </Button>
              </div>
            </div>
            <AgentDailyCardEmailPrompt />
            <AgentCapacityShareInline />
            <AgentDeadTenantsBanner agentId={user.id} />
            {/* Overdue tenants: forces a call on every app open, emails the list daily. */}
            <AgentOverdueCallDrive agentId={user.id} />
            {/* Unpaid days to recover. Renders nothing when nobody is behind. */}
            <AgentArrearsCard agentId={user.id} />
            {/* Rent Plans past their end date that still owe. These carry no
                pinned day, so they appear nowhere under today's target. */}
            <AgentExpiredCyclesCard agentId={user.id} />
            <div
              className={cn(
                "-mx-4 px-3 sm:px-4 bg-background border-b border-border/40",
                submissionsExpanded && "pb-2.5"
              )}
            >
              <button
                onClick={() => setSubmissionsExpanded((v) => !v)}
                className="w-full flex items-center justify-between py-2 text-left"
                style={{ touchAction: 'manipulation' }}
              >
                <h3 className="text-[11px] sm:text-sm font-bold uppercase tracking-wide text-muted-foreground">
                  Submissions
                </h3>
                <div className="flex items-center gap-1.5">
                  {!submissionsExpanded && (
                    <div className="flex items-center gap-1">
                      {submittedCount > 0 && (
                        <span className="h-4 px-1 rounded-full bg-amber-500 text-white text-[9px] font-bold flex items-center justify-center">
                          {submittedCount}
                        </span>
                      )}
                      {approvedCount > 0 && (
                        <span className="h-4 px-1 rounded-full bg-emerald-600 text-white text-[9px] font-bold flex items-center justify-center">
                          {approvedCount}
                        </span>
                      )}
                      {rejectedCount > 0 && (
                        <span className="h-4 px-1 rounded-full bg-destructive text-destructive-foreground text-[9px] font-bold flex items-center justify-center">
                          {rejectedCount}
                        </span>
                      )}
                    </div>
                  )}
                  {submissionsExpanded ? (
                    <ChevronUp className="h-3.5 w-3.5 text-muted-foreground" />
                  ) : (
                    <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
                  )}
                </div>
              </button>

              {submissionsExpanded && (
                <div className="mt-1">
                  <AgentRequestPipelineView initialTab="submitted" activeTab={pipelineTab} onTabChange={setPipelineTab} />
                </div>
              )}
            </div>
            <h3 className="text-[11px] sm:text-sm font-bold uppercase tracking-wide text-muted-foreground">My Tenants</h3>
            <AgentTenantInlineList
              onOpenTenantSheet={(tenantId) => { setTenantProfileId(tenantId); setTenantsSheetOpen(true); }}
              onAddTenant={() => setRentRequestOpen(true)}
            />
          </div>
        )}

        {/* === GROW TAB === Share, recruit, partners */}
        {activeTab === 'grow' && (
          <div className={cn("space-y-5", tabAnimClass)}>
            {/* Leaderboard CTA — draws agents into the recruitment competition */}
            <button
              onClick={() => { hapticTap(); navigate('/dashboard/agents/leaderboard'); }}
              className="w-full flex items-center gap-3.5 p-4 rounded-2xl text-left text-white shadow-sm active:scale-[0.98] transition-transform touch-manipulation"
              style={{ background: 'linear-gradient(135deg, #9334EB, #6D28D9)', WebkitTapHighlightColor: 'transparent' }}
            >
              <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-white/20">
                <Trophy className="h-5.5 w-5.5" strokeWidth={2.2} style={{ color: '#FACC15' }} />
              </div>
              <div className="min-w-0 flex-1">
                <p className="font-bold text-[15px] leading-tight">Agent Leaderboard</p>
                <p className="text-[12px] text-white/85 leading-snug mt-0.5">
                  See your rank, invite more sub-agents & climb to the top.
                </p>
              </div>
              <ChevronRight className="h-5 w-5 shrink-0 text-white/80" />
            </button>
            <WeeklyCollectionStreakCard />
            <div className="grid grid-cols-2 gap-2.5">
              {[
                { icon: Building2, label: 'Share Landlord', onClick: handleShareLandlordSignup },
                { icon: UserPlus, label: 'Invite & Earn', onClick: () => navigate('/referrals') },
                ...(parentAgentInfo?.parent_agent_id
                  ? [{ icon: UsersRound, label: 'My Parent Agent', onClick: () => setParentAgentOpen(true) }]
                  : []),
                { icon: ShieldCheck, label: 'My National ID', onClick: () => setNationalIdGroupOpen(true) },
                { icon: Menu, label: 'All Menu', onClick: handleOpenMenu },
              ].map((a) => (
                <button
                  key={a.label}
                  onClick={() => { hapticTap(); a.onClick(); }}
                  className="flex items-center gap-3 p-3.5 rounded-2xl bg-card border border-border/60 active:scale-[0.97] transition-all min-h-[64px] text-left touch-manipulation"
                  style={{ WebkitTapHighlightColor: 'transparent' }}
                >
                  <div className="p-2 rounded-xl bg-accent text-accent-foreground shrink-0">
                    <a.icon className="h-4.5 w-4.5" strokeWidth={2.2} />
                  </div>
                  <span className="font-semibold text-[13px] text-foreground truncate">{a.label}</span>
                </button>
              ))}
            </div>
            <ShareRentRecorderCard />
          </div>
        )}

        {/* === SUB AGENTS TAB === Team management */}
        {activeTab === 'subagents' && (
          <div className={cn("space-y-5", tabAnimClass)}>
            <MyParentAgentCard agentId={user.id} />
            <NationalIdGroupCard />
            <SubAgentsPanel agentId={user.id} onInviteSubAgent={handleInviteSubAgent} />
          </div>
        )}

        </div>
        </main>
      </div>

      <LazyModal when={nationalIdGroupOpen}>
      <NationalIdGroupSheet open={nationalIdGroupOpen} onOpenChange={setNationalIdGroupOpen} />
      </LazyModal>
      <LazyModal when={parentAgentOpen}>
      <ParentAgentDialog
        open={parentAgentOpen}
        onOpenChange={setParentAgentOpen}
        agentId={user?.id}
      />
      </LazyModal>
      <LazyModal when={showWallet}>
      <FullScreenWalletSheet
        open={showWallet}
        onOpenChange={(o) => { setShowWallet(o); if (!o) setWalletScrollTarget(null); }}
        scrollTarget={walletScrollTarget}
      />
      </LazyModal>
      <LazyModal when={showQuickDeposit}>
      <DepositFlow
        open={showQuickDeposit}
        onOpenChange={setShowQuickDeposit}
        allowedPurposes={['personal_deposit', 'operational_float']}
        defaultPurpose="operational_float"
        requirePurposeChoice
      />
      </LazyModal>
      <LazyModal when={showQuickWithdraw}>
      <WithdrawFlow open={showQuickWithdraw} onOpenChange={setShowQuickWithdraw} availableBalance={realWithdrawableBalance} />
      </LazyModal>
      <LazyModal when={showQuickTransfer}>
      <SendMoneyDialog open={showQuickTransfer} onOpenChange={setShowQuickTransfer} />
      </LazyModal>

      <LazyModal when={collectFromRefOpen}>
      <CollectFromReferenceDialog
        open={collectFromRefOpen}
        onOpenChange={setCollectFromRefOpen}
        agentId={user.id}
      />
      </LazyModal>
      
      <LazyModal when={menuOpen}>
      <AgentMenuDrawer
        open={menuOpen}
        onOpenChange={setMenuOpen}
        restricted={isMerchant}
        onDeposit={handleDeposit}
        onPostRentRequest={() => setRentRequestOpen(true)}
        onInviteSubAgent={handleInviteSubAgent}
        onInviteTenant={() => { setMenuOpen(false); setTenantInviteOpen(true); }}
        onOpenEarningsRank={() => setEarningsRankOpen(true)}
        onManageProperty={() => { setMenuOpen(false); setManagedPropertyOpen(true); }}
        onViewManagedProperties={() => { setMenuOpen(false); setManagedPropertiesSheetOpen(true); }}
        onViewMyRentRequests={() => { setMenuOpen(false); setMyRentRequestsOpen(true); }}
        onTopUpTenant={() => {
          // Disabled — Pay Rent / Collect Rent flow removed.
          setMenuOpen(false);
        }}
        onViewTenants={() => { setMenuOpen(false); setTenantsSheetOpen(true); }}
        onViewCreditAccess={() => { setMenuOpen(false); setCreditOpen(true); }}
        onFundPartner={() => { setMenuOpen(false); setInvestForPartnerOpen(true); }}
        onViewProxyHistory={() => { setMenuOpen(false); setProxyHistoryOpen(true); }}
        onIssueReceipt={() => { setMenuOpen(false); setReceiptOpen(true); }}
        onViewLandlordMap={() => { setMenuOpen(false); setLandlordMapOpen(true); }}
        onFindRentals={() => { setMenuOpen(false); setRentalFinderOpen(true); }}
        onListEmptyHouse={() => {
          setMenuOpen(false);
          if (!guardListingHours()) return;
          setListHouseFromPromo(false);
          setListHouseOpen(true);
        }}
        onViewMyListings={() => { setMenuOpen(false); setMyListingsVacantOnly(false); setMyListingsOpen(true); }}
        onViewSubAgents={() => { setMenuOpen(false); setSubAgentsSheetOpen(true); }}
        onViewLandlords={() => { setMenuOpen(false); setLandlordsSheetOpen(true); }}
        onShareSubAgentLink={() => { setMenuOpen(false); setShareLinkOpen(true); }}
        onManageFunders={() => { setMenuOpen(false); setFunderSheetOpen(true); }}
        onOpenPartnerDashboard={() => { setMenuOpen(false); setPartnerDashboardOpen(true); }}
        onOpenRequisition={() => { setMenuOpen(false); setRequisitionOpen(true); }}
        isFinancialAgent={isFinancialAgent}
        onInviteFunder={async () => {
          setMenuOpen(false);
          try {
            const { toast } = await import('sonner');
            toast.info('Generating short link...');
            const { createShortLink } = await import('@/lib/createShortLink');
            const funderLink = await createShortLink(user.id, '/funder-onboarding', { ref: user.id });
            const shareText = `Join Welile as a funder and start earning! Sign up here: ${funderLink}`;
            if (navigator.share) {
              navigator.share({ title: 'Become a Welile Funder', text: shareText, url: funderLink }).catch(() => {});
            } else {
              await navigator.clipboard.writeText(funderLink);
              toast.success('Funder signup link copied!');
            }
          } catch (err: any) {
            const { toast } = await import('sonner');
            toast.error(err.message || 'Failed to generate link');
          }
        }}
        onInviteAngelPartner={async () => {
          setMenuOpen(false);
          try {
            const { toast } = await import('sonner');
            toast.info('Generating short link...');
            const { createShortLink } = await import('@/lib/createShortLink');
            const investorLink = await createShortLink(user.id, '/funder-onboarding', { ref: user.id, role: 'supporter' });
            const shareText = `🦄 Join the Welile Angel Pool — back Africa's rent-tech revolution! Own equity in a high-growth platform. Sign up here: ${investorLink}`;
            if (navigator.share) {
              navigator.share({ title: 'Back the Welile Angel Pool', text: shareText, url: investorLink }).catch(() => {});
            } else {
              await navigator.clipboard.writeText(investorLink);
              toast.success('Angel investor signup link copied!');
            }
          } catch (err: any) {
            const { toast } = await import('sonner');
            toast.error(err.message || 'Failed to generate link');
          }
        }}
        onShareTenantForm={async () => {
          setMenuOpen(false);
          try {
            const { toast } = await import('sonner');
            toast.info('Generating shareable link...');
            const { supabase } = await import('@/integrations/supabase/client');
            const { data, error } = await supabase.functions.invoke('generate-tenant-form-token', {});
            if (error || data?.error) throw new Error(data?.error || error?.message || 'Failed to generate link');
            const { createShortLink } = await import('@/lib/createShortLink');
            const tenantFormLink = await createShortLink(user.id, '/register-tenant', { agent: user.id, token: data.token });
            const shareText = `Register as a Welile tenant using this form: ${tenantFormLink}`;
            if (navigator.share) {
              navigator.share({ title: 'Tenant Registration', text: shareText, url: tenantFormLink }).catch(() => {});
            } else {
              await navigator.clipboard.writeText(tenantFormLink);
              toast.success('Tenant registration link copied!');
            }
          } catch (err: any) {
            const { toast } = await import('sonner');
            toast.error(err.message || 'Failed to generate link');
          }
        }}
        onSharePartnerForm={async () => {
          setMenuOpen(false);
          try {
            const { toast } = await import('sonner');
            toast.info('Generating partner form link...');
            const { supabase } = await import('@/integrations/supabase/client');
            const { data, error } = await supabase.functions.invoke('generate-tenant-form-token', {});
            if (error || data?.error) throw new Error(data?.error || error?.message || 'Failed to generate link');
            const { createShortLink } = await import('@/lib/createShortLink');
            const partnerFormLink = await createShortLink(user.id, '/register-partner', { agent: user.id, token: data.token });
            const shareText = `🤝 Partner with Welile and earn 15% monthly ROI! Register here: ${partnerFormLink}`;
            if (navigator.share) {
              navigator.share({ title: 'Partner Registration', text: shareText, url: partnerFormLink }).catch(() => {});
            } else {
              await navigator.clipboard.writeText(partnerFormLink);
              toast.success('Partner registration link copied!');
            }
          } catch (err: any) {
            const { toast } = await import('sonner');
            toast.error(err.message || 'Failed to generate link');
          }
        }}
        onShareLandlordSignup={() => {
          setMenuOpen(false);
          handleShareLandlordSignup();
        }}
        onRequestAdvance={() => {
          setMenuOpen(false);
          setAdvanceRequestOpen(true);
        }}
        onDownloadLandlordForm={handleDownloadLandlordForm}
        onDownloadTenantForm={handleDownloadTenantForm}
        onOpenRentPoster={() => {
          setMenuOpen(false);
          setRentPosterOpen(true);
        }}
      />
      </LazyModal>

      <LazyModal when={rentPosterOpen}>
      <RentPosterDialog open={rentPosterOpen} onOpenChange={setRentPosterOpen} />
      </LazyModal>

      <LazyModal when={regFormKind !== null}>
      <RegFormActionDialog
        open={regFormKind !== null}
        onOpenChange={(o) => { if (!o) setRegFormKind(null); }}
        form={regFormKind}
      />
      </LazyModal>

      {/* Existing Dialogs */}
      <LazyModal when={depositOpen}>
      <AgentDepositDialog open={depositOpen} onOpenChange={setDepositOpen} />
      </LazyModal>
      <SubAgentInviteLinkDialog
        open={subAgentLinkOpen}
        onOpenChange={setSubAgentLinkOpen}
      />
      <LazyModal when={tenantInviteOpen}>
      <TenantInviteLinkDialog
        open={tenantInviteOpen}
        onOpenChange={setTenantInviteOpen}
      />
      </LazyModal>
      <LazyModal when={rentRequestOpen}>
      <AgentRentRequestDialog 
        open={rentRequestOpen} 
        onOpenChange={setRentRequestOpen} 
        onSuccess={() => setRentRequestOpen(false)}
      />
      </LazyModal>
      <LazyModal when={businessAdvanceOpen}>
      <BusinessAdvanceRequestDialog
        open={businessAdvanceOpen}
        onOpenChange={setBusinessAdvanceOpen}
        onSuccess={() => refreshOfflineData()}
      />
      </LazyModal>
      <LazyModal when={!!commissionEvent}>
      <CommissionCelebrationModal
        open={!!commissionEvent}
        onClose={dismissCommission}
        amount={commissionEvent?.amount || 0}
        businessName={commissionEvent?.businessName}
        repaymentAmount={commissionEvent?.repaymentAmount}
      />
      </LazyModal>
      <LazyModal when={earningsRankOpen}>
      <EarningsRankSystemSheet open={earningsRankOpen} onOpenChange={setEarningsRankOpen} />
      </LazyModal>
      <LazyModal when={managedPropertyOpen}>
      <AgentManagedPropertyDialog open={managedPropertyOpen} onOpenChange={setManagedPropertyOpen} onSuccess={refreshOfflineData} />
      </LazyModal>
      <LazyModal when={managedPropertiesSheetOpen}>
      <AgentManagedPropertiesSheet open={managedPropertiesSheetOpen} onOpenChange={setManagedPropertiesSheetOpen} onRequestPayout={(p) => { setPayoutProperty(p); setPayoutDialogOpen(true); }} />
      </LazyModal>
      <LazyModal when={payoutDialogOpen}>
      <AgentLandlordPayoutDialog open={payoutDialogOpen} onOpenChange={setPayoutDialogOpen} property={payoutProperty} />
      </LazyModal>
      <LazyModal when={landlordPayoutFlowOpen}>
      <AgentLandlordPayoutFlow open={landlordPayoutFlowOpen} onOpenChange={setLandlordPayoutFlowOpen} />
      </LazyModal>
      <LazyModal when={floatPayoutOpen}>
      <AgentFloatPayoutWizard
        open={floatPayoutOpen}
        onOpenChange={(o) => { setFloatPayoutOpen(o); if (!o) setSelectedFloatAllocation(null); }}
        allocation={selectedFloatAllocation}
        onDone={() => {
          // Same deferred-open pattern as the list → wizard hand-off below —
          // opening the list dialog in the same tick the wizard closes steals
          // focus/pointer state from the closing Radix dialog.
          setTimeout(() => setFloatAllocationsOpen(true), 250);
        }}
      />
      </LazyModal>
      <LazyModal when={floatAllocationsOpen}>
      <AgentLandlordFloatAllocationsDialog
        open={floatAllocationsOpen}
        onOpenChange={setFloatAllocationsOpen}
        onSelectAllocation={(allocation) => {
          setFloatAllocationsOpen(false);
          setSelectedFloatAllocation(allocation);
          // Defer opening the payout wizard until the allocations dialog has
          // fully closed. Opening a second Radix dialog in the same tick steals
          // focus/pointer state from the closing one, which makes the wizard
          // flash open and immediately close.
          setTimeout(() => setFloatPayoutOpen(true), 250);
        }}
      />
      </LazyModal>
      <LazyModal when={recoveryLedgerOpen}>
      <LandlordRecoveryLedger open={recoveryLedgerOpen} onOpenChange={setRecoveryLedgerOpen} />
      </LazyModal>
      <LazyModal when={payoutStatusOpen}>
      <FloatPayoutStatusTracker open={payoutStatusOpen} onOpenChange={setPayoutStatusOpen} />
      </LazyModal>
      <LazyModal when={otpAuditOpen}>
      <LandlordPayoutOtpAuditSheet open={otpAuditOpen} onOpenChange={setOtpAuditOpen} />
      </LazyModal>
      <LazyModal when={receiptCheckOpen && isLandlordReceiptConfirmationEffective()}>
      <ReceiptNumberCheckDialog open={receiptCheckOpen} onOpenChange={setReceiptCheckOpen} />
      </LazyModal>
      <LazyModal when={floatHistoryOpen}>
      <FloatTransactionHistory open={floatHistoryOpen} onOpenChange={setFloatHistoryOpen} />
      </LazyModal>
      <CreditVerificationButton />
      <LazyModal when={myRentRequestsOpen}>
      <AgentMyRentRequestsSheet open={myRentRequestsOpen} onOpenChange={setMyRentRequestsOpen} />
      </LazyModal>
      <LazyModal when={tenantsSheetOpen}>
      <AgentTenantsSheet
        open={tenantsSheetOpen}
        onOpenChange={(o) => {
          setTenantsSheetOpen(o);
          if (!o) {
            // Reset so normal "My tenants" opens default to the tenants view.
            setSubmissionsView(undefined);
            setSubmissionsTab(undefined);
            setSubmissionsHighlightId(undefined);
            setTenantProfileId(undefined);
          }
        }}
        initialView={submissionsView}
        initialPipelineTab={submissionsTab}
        initialHighlightId={submissionsHighlightId}
        initialProfileTenantId={tenantProfileId}
      />
      </LazyModal>
      <LazyModal when={reconcileOpen}>
      <FieldCollectReconciliationSheet open={reconcileOpen} onOpenChange={setReconcileOpen} />
      </LazyModal>
      <LazyModal when={managedUsersOpen}>
      <AgentManagedUsersSheet open={managedUsersOpen} onOpenChange={setManagedUsersOpen} agentId={user.id} />
      </LazyModal>
      <LazyModal when={topUpTenantOpen}>
      <AgentTopUpTenantDialog open={topUpTenantOpen} onOpenChange={setTopUpTenantOpen} onSuccess={refreshOfflineData} />
      </LazyModal>
      <LazyModal when={investForPartnerOpen}>
      <AgentInvestForPartnerDialog open={investForPartnerOpen} onOpenChange={setInvestForPartnerOpen} onSuccess={() => { refreshOfflineData(); refreshWallet(); }} />
      </LazyModal>
      <LazyModal when={proxyHistoryOpen}>
      <ProxyInvestmentHistorySheet open={proxyHistoryOpen} onOpenChange={setProxyHistoryOpen} />
      </LazyModal>
      <LazyModal when={receiptOpen}>
      <AgentReceiptDialog open={receiptOpen} onOpenChange={setReceiptOpen} />
      </LazyModal>
      <LazyModal when={landlordMapOpen}>
      <AgentLandlordMapSheet open={landlordMapOpen} onOpenChange={setLandlordMapOpen} />
      </LazyModal>
      <LazyModal when={rentalFinderOpen}>
      <RentalFinderSheet open={rentalFinderOpen} onOpenChange={setRentalFinderOpen} />
      </LazyModal>
      <LazyModal when={listHouseOpen}>
      <ListEmptyHouseDialog
        open={listHouseOpen}
        onOpenChange={(open) => {
          setListHouseOpen(open);
          if (!open) setListHouseFromPromo(false);
        }}
        onSuccess={refreshOfflineData}
        fromPromoBanner={listHouseFromPromo}
      />
      </LazyModal>
      <LazyModal when={myListingsOpen}>
      <AgentListingsSheet
        open={myListingsOpen}
        onOpenChange={(open) => {
          setMyListingsOpen(open);
          if (!open) setMyListingsVacantOnly(false);
        }}
        vacantOnly={myListingsVacantOnly}
        onListHouse={() => {
          if (!guardListingHours()) return;
          setListHouseFromPromo(false);
          setListHouseOpen(true);
        }}
      />
      </LazyModal>

      {/* Phase 1: Agent Operations Dialogs */}
      <LazyModal when={visitDialogOpen}>
      <AgentVisitPaymentWizard open={visitDialogOpen} onOpenChange={setVisitDialogOpen} onSuccess={refreshOfflineData} />
      </LazyModal>
      <LazyModal when={tokenDialogOpen}>
      <GeneratePaymentTokenDialog open={tokenDialogOpen} onOpenChange={setTokenDialogOpen} />
      </LazyModal>
      <LazyModal when={recordCollectionOpen}>
      <RecordAgentCollectionDialog open={recordCollectionOpen} onOpenChange={setRecordCollectionOpen} />
      </LazyModal>
      <LazyModal when={depositCashOpen}>
      <AgentDepositCashDialog open={depositCashOpen} onOpenChange={setDepositCashOpen} />
      </LazyModal>
      <LazyModal when={nearbyTenantsOpen}>
      <NearbyTenantsSheet open={nearbyTenantsOpen} onOpenChange={setNearbyTenantsOpen} />
      </LazyModal>
      <LazyModal when={welileHomesOpen}>
      <AgentWelileHomesSheet open={welileHomesOpen} onOpenChange={setWelileHomesOpen} />
      </LazyModal>
      <LazyModal when={subAgentsSheetOpen}>
      <MySubAgentsSheet open={subAgentsSheetOpen} onOpenChange={setSubAgentsSheetOpen} />
      </LazyModal>
      <LazyModal when={landlordsSheetOpen}>
      <MyLandlordsSheet open={landlordsSheetOpen} onOpenChange={setLandlordsSheetOpen} />
      </LazyModal>
      <LazyModal when={shareLinkOpen}>
      <QuickShareSubAgentSheet open={shareLinkOpen} onOpenChange={setShareLinkOpen} />
      </LazyModal>
      <LazyModal when={shareLandlordOpen}>
      <ShareLandlordLinkDialog open={shareLandlordOpen} onOpenChange={setShareLandlordOpen} />
      </LazyModal>
      <LazyModal when={funderSheetOpen}>
      <FunderManagementSheet open={funderSheetOpen} onOpenChange={setFunderSheetOpen} />
      </LazyModal>
      <LazyModal when={partnerDashboardOpen}>
      <AgentPartnerDashboardSheet open={partnerDashboardOpen} onOpenChange={setPartnerDashboardOpen} />
      </LazyModal>
      <LazyModal when={requisitionOpen}>
      <FinancialAgentSection open={requisitionOpen} onOpenChange={setRequisitionOpen} />
      </LazyModal>
      <LazyModal when={lendingAgentOpen}>
      <LendingAgentPortal open={lendingAgentOpen} onOpenChange={setLendingAgentOpen} />
      </LazyModal>
      <LazyModal when={borrowOpen}>
      <BorrowLoanSheet
        open={borrowOpen}
        onOpenChange={setBorrowOpen}
        onOpenLendingPortal={() => {
          setBorrowOpen(false);
          setLendingAgentOpen(true);
        }}
      />
      </LazyModal>

      {/* Rent Fee Available (Credit Access) — opened from All Menu → Earnings */}
      {creditOpen && (
      <Dialog open={creditOpen} onOpenChange={setCreditOpen}>
        <DialogContent className="w-[calc(100vw-1rem)] sm:w-full max-w-lg p-0 gap-0 max-h-[90vh] flex flex-col overflow-hidden">
          <DialogHeader className="p-4 pb-3 border-b shrink-0">
            <DialogTitle className="flex items-center gap-2 text-base sm:text-lg pr-6">
              <TrendingUp className="h-5 w-5 text-primary shrink-0" />
              <span className="truncate">Rent Fee Available</span>
            </DialogTitle>
          </DialogHeader>
          <div className="overflow-y-auto p-4">
            <Suspense fallback={null}><CreditAccessCard userId={user.id} /></Suspense>
          </div>
        </DialogContent>
      </Dialog>
      )}

      {/* Cash Payouts Dialog - only rendered for cashout agents */}
      {cashPayoutsOpen && (
      <Dialog open={cashPayoutsOpen} onOpenChange={setCashPayoutsOpen}>
        <DialogContent className="w-[calc(100vw-1rem)] sm:w-full max-w-lg p-0 gap-0 max-h-[90vh] sm:max-h-[85vh] flex flex-col overflow-hidden">
          <DialogHeader className="p-4 pb-3 border-b shrink-0">
            <DialogTitle className="flex items-center gap-2 text-base sm:text-lg pr-6">
              <Banknote className="h-5 w-5 text-orange-500 shrink-0" />
              <span className="truncate">Cash, Mobile Money & Bank Payouts</span>
            </DialogTitle>
          </DialogHeader>
          <div className="flex-1 overflow-y-auto overflow-x-hidden p-3 sm:p-4">
            <Suspense fallback={null}><AgentCashPayoutsTab /></Suspense>
          </div>
        </DialogContent>
      </Dialog>
      )}

      <LazyModal when={advanceRequestOpen}>
      <AgentAdvanceRequestForm open={advanceRequestOpen} onOpenChange={setAdvanceRequestOpen} />
      </LazyModal>

      <Dialog open={advanceGuideOpen} onOpenChange={setAdvanceGuideOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <TrendingUp className="h-5 w-5 text-primary" />
              Grow your advance limit
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-4 text-sm">
            <p className="text-muted-foreground">
              Your advance limit grows with your track record — top-performing agents can
              access up to <span className="font-bold text-primary">UGX 30,000,000</span>.
              Do these consistently to unlock more:
            </p>
            <ul className="space-y-3">
              <li className="flex gap-3">
                <span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-primary/10 text-xs font-bold text-primary">1</span>
                <span><span className="font-semibold text-foreground">Repay on time.</span> Clear each advance on or before its due date — early repayment unlocks a bigger limit fastest.</span>
              </li>
              <li className="flex gap-3">
                <span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-primary/10 text-xs font-bold text-primary">2</span>
                <span><span className="font-semibold text-foreground">Collect rent steadily.</span> Consistent daily collections and funded tenants raise your Welile trust score.</span>
              </li>
              <li className="flex gap-3">
                <span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-primary/10 text-xs font-bold text-primary">3</span>
                <span><span className="font-semibold text-foreground">Grow your book.</span> Onboard more tenants, list houses and keep them paying to prove sustained volume.</span>
              </li>
              <li className="flex gap-3">
                <span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-primary/10 text-xs font-bold text-primary">4</span>
                <span><span className="font-semibold text-foreground">Complete verification.</span> A verified ID and profile increase the limit we can safely extend to you.</span>
              </li>
            </ul>
            <Button
              className="w-full"
              onClick={() => { setAdvanceGuideOpen(false); setAdvanceRequestOpen(true); }}
            >
              Request an advance
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* Smartphone order dialog */}
      <SmartphoneOrderDialog open={phoneOpen} onOpenChange={setPhoneOpen} userId={user?.id} />


      {/* Spiro bike lease order dialog */}
      <SpiroBikeOrderDialog open={bikeOpen} onOpenChange={setBikeOpen} userId={user?.id} />


    </div>
    </AgentFrozenGate>
  );
}
