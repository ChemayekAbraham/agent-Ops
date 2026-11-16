import { useEffect, useState, Suspense } from 'react';
import { lazyWithRetry as lazy } from '@/lib/lazyWithRetry';
import { ArrowLeft, ArrowRight, ClipboardCheck, ShieldCheck, Sparkles, CalendarClock, Plus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
const SpecialAdvancesPanel = lazy(() => import('@/components/cfo/special-advances/SpecialAdvancesPanel'));
const PaidByCategory = lazy(() => import('@/components/cfo/PaidByCategory'));
const ReceivedByCategory = lazy(() => import('@/components/cfo/ReceivedByCategory'));
const TenantRepaymentTracker = lazy(() => import('@/components/cfo/tenant-repayments/TenantRepaymentTracker'));

import { toast } from 'sonner';
import { useCurrency } from '@/hooks/useCurrency';
import { useIsMobile } from '@/hooks/use-mobile';
import { useHorizontalSwipe } from '@/hooks/useHorizontalSwipe';
import { executiveSidebarConfig } from '@/components/layout/executiveSidebarConfig';
const TenantOpsLandlordFloatTimeline = lazy(() => import('@/components/executive/TenantOpsLandlordFloatTimeline').then((m) => ({ default: m.TenantOpsLandlordFloatTimeline })));
import ExecutiveDashboardLayout from '@/components/layout/ExecutiveDashboardLayout';
import { ChannelBalanceTracker } from '@/components/cfo/ChannelBalanceTracker';
const ErrorCorrectionAuditPanel = lazy(() => import('@/components/cfo/ErrorCorrectionAuditPanel').then((m) => ({ default: m.ErrorCorrectionAuditPanel })));
const RedemptionApprovalsPanel = lazy(() => import('@/components/cfo/RedemptionApprovalsPanel').then((m) => ({ default: m.RedemptionApprovalsPanel })));
const CompoundRequestApprovalsPanel = lazy(() => import('@/components/cfo/CompoundRequestApprovalsPanel').then((m) => ({ default: m.CompoundRequestApprovalsPanel })));
const PartnerReturnPolicyCard = lazy(() => import('@/components/cfo/PartnerReturnPolicyCard').then((m) => ({ default: m.PartnerReturnPolicyCard })));
const PartnerRateApprovalsPanel = lazy(() => import('@/components/cfo/PartnerRateApprovalsPanel').then((m) => ({ default: m.PartnerRateApprovalsPanel })));
const CorrectionCenterPanel = lazy(() => import('@/components/cfo/CorrectionCenterPanel').then((m) => ({ default: m.CorrectionCenterPanel })));
import { PlatformVsWalletSummary } from '@/components/cfo/PlatformVsWalletSummary';
const CFOROIRequests = lazy(() => import('@/components/cfo/CFOROIRequests').then((m) => ({ default: m.CFOROIRequests })));
const CFOOverviewDashboard = lazy(() => import('@/components/cfo/CFOOverviewDashboard').then((m) => ({ default: m.CFOOverviewDashboard })));
const DirectCreditTool = lazy(() => import('@/components/cfo/DirectCreditTool').then((m) => ({ default: m.DirectCreditTool })));
const LunchAllowanceTracker = lazy(() => import('@/components/cfo/LunchAllowanceTracker').then((m) => ({ default: m.LunchAllowanceTracker })));
const StandingOrdersPanel = lazy(() => import('@/components/cfo/StandingOrdersPanel').then((m) => ({ default: m.StandingOrdersPanel })));
const AddStandingOrderDialog = lazy(() => import('@/components/cfo/AddStandingOrderDialog').then((m) => ({ default: m.AddStandingOrderDialog })));
const BudgetApprovalPanel = lazy(() => import('@/components/cfo/BudgetApprovalPanel'));
const CFOServiceCentreSpendApproval = lazy(() => import('@/components/cfo/CFOServiceCentreSpendApproval'));
const MerchantFloatRequestsPanel = lazy(() => import('@/components/cfo/MerchantFloatRequestsPanel').then((m) => ({ default: m.MerchantFloatRequestsPanel })));
const MerchantFloatRequisitionPanel = lazy(() => import('@/components/financial-ops/MerchantFloatRequisitionPanel').then((m) => ({ default: m.MerchantFloatRequisitionPanel })));
const CFOWelileHomesDisbursementDesk = lazy(() => import('@/components/cfo/CFOWelileHomesDisbursementDesk').then((m) => ({ default: m.CFOWelileHomesDisbursementDesk })));
const WhHistoricalDisbursementsPanel = lazy(() => import('@/components/welile-homes/historical/WhHistoricalDisbursementsPanel').then((m) => ({ default: m.WhHistoricalDisbursementsPanel })));
const CFOSignagesDesk = lazy(() => import('@/components/cfo/CFOSignagesDesk').then((m) => ({ default: m.CFOSignagesDesk })));
const CFOPayoutsShareButton = lazy(() => import('@/components/cfo/CFOPayoutsShareButton').then((m) => ({ default: m.CFOPayoutsShareButton })));
const RevenueExpenseDashboard = lazy(() => import('@/components/cfo/RevenueExpenseDashboard').then((m) => ({ default: m.RevenueExpenseDashboard })));
const RoiDisbursementReportPanel = lazy(() => import('@/components/cfo/RoiDisbursementReportPanel'));
const RentDisbursementReportPanel = lazy(() => import('@/components/cfo/RentDisbursementReportPanel'));
const MerchantFloatRequisitionReportPanel = lazy(() => import('@/components/cfo/MerchantFloatRequisitionReportPanel'));
const EmployeeRequisitionReportPanel = lazy(() => import('@/components/cfo/EmployeeRequisitionReportPanel'));
const ApprovedRequisitionsPayoutPanel = lazy(() => import('@/components/cfo/ApprovedRequisitionsPayoutPanel'));
const ExpenseReportPanel = lazy(() => import('@/components/cfo/ExpenseReportPanel'));
const SmsOtpCostsPanel = lazy(() => import('@/components/cfo/SmsOtpCostsPanel'));
const CFOWeeklyReportPanel = lazy(() => import('@/components/cfo/CFOWeeklyReportPanel'));
const AccountingHealthPanel = lazy(() => import('@/components/cfo/AccountingHealthPanel'));
const CashflowForecastGraphs = lazy(() => import('@/components/cfo/CashflowForecastGraphs').then((m) => ({ default: m.CashflowForecastGraphs })));
const PartnerReceiptsPanel = lazy(() => import('@/components/shared/PartnerReceiptsPanel').then((m) => ({ default: m.PartnerReceiptsPanel })));
const RequisitionsWorkspace = lazy(() => import('@/components/requisitions/RequisitionsWorkspace').then((m) => ({ default: m.RequisitionsWorkspace })));

const FinancialStatementsPanel = lazy(() => import('@/components/manager/FinancialStatementsPanel').then((m) => ({ default: m.FinancialStatementsPanel })));
const BufferAccountPanel = lazy(() => import('@/components/manager/BufferAccountPanel').then((m) => ({ default: m.BufferAccountPanel })));
const SupporterROITrigger = lazy(() => import('@/components/manager/SupporterROITrigger').then((m) => ({ default: m.SupporterROITrigger })));
const AgentCommissionPayoutsManager = lazy(() => import('@/components/manager/AgentCommissionPayoutsManager').then((m) => ({ default: m.AgentCommissionPayoutsManager })));
const WithdrawalRequestsManager = lazy(() => import('@/components/manager/WithdrawalRequestsManager').then((m) => ({ default: m.WithdrawalRequestsManager })));
const GeneralLedger = lazy(() => import('@/components/manager/GeneralLedger').then((m) => ({ default: m.GeneralLedger })));
const CFOPartnerPayoutProcessing = lazy(() => import('@/components/cfo/CFOPartnerPayoutProcessing').then((m) => ({ default: m.CFOPartnerPayoutProcessing })));
const CFOApprovedRentPayouts = lazy(() => import('@/components/cfo/CFOApprovedRentPayouts').then((m) => ({ default: m.CFOApprovedRentPayouts })));


const CfoLandlordPayoutFloatPanel = lazy(() => import('@/components/cfo/CfoLandlordPayoutFloatPanel'));
const CfoTenantBalanceChangesPage = lazy(() => import('@/components/cfo/CfoTenantBalanceChangesPage'));
const CfoGeneralPayoutActivityPage = lazy(() => import('@/components/cfo/CfoGeneralPayoutActivityPage'));
const WithdrawalHistoryStatement = lazy(() => import('@/components/financial-ops/WithdrawalHistoryStatement').then((m) => ({ default: m.WithdrawalHistoryStatement })));
const StaleWithdrawalHoldsPanel = lazy(() => import('@/components/cfo/StaleWithdrawalHoldsPanel').then((m) => ({ default: m.StaleWithdrawalHoldsPanel })));
const PayoutReconciliationQueue = lazy(() => import('@/components/financial-ops/PayoutReconciliationQueue').then((m) => ({ default: m.PayoutReconciliationQueue })));
const AutoPayoutHistory = lazy(() => import('@/components/cfo/AutoPayoutHistory').then((m) => ({ default: m.AutoPayoutHistory })));
const DailyCashPositionReport = lazy(() => import('@/components/cfo/DailyCashPositionReport').then((m) => ({ default: m.DailyCashPositionReport })));
const RentPipelineQueue = lazy(() => import('@/components/executive/RentPipelineQueue').then((m) => ({ default: m.RentPipelineQueue })));
const RejectedRequestsQueue = lazy(() => import('@/components/executive/RejectedRequestsQueue').then((m) => ({ default: m.RejectedRequestsQueue })));
import { ListingBonusApprovalQueue } from '@/components/executive/ListingBonusApprovalQueue';
const FinancialAgentsPanel = lazy(() => import('@/components/cfo/FinancialAgentsPanel').then((m) => ({ default: m.FinancialAgentsPanel })));
const PayrollPanel = lazy(() => import('@/components/cfo/PayrollPanel').then((m) => ({ default: m.PayrollPanel })));
const CfoPayrollPanel = lazy(() => import('@/hr/pay/CfoPayrollPanel'));
const CfoPayrollHistoryPanel = lazy(() => import('@/components/cfo/CfoPayrollHistoryPanel'));
const ApprovalsInbox = lazy(() => import('@/hr/pay/Approvals').then((m) => ({ default: m.ApprovalsInbox })));
const AdvancesPanel = lazy(() => import('@/hr/pay/Advances').then((m) => ({ default: m.AdvancesPanel })));
const CashoutAgentManager = lazy(() => import('@/components/cfo/CashoutAgentManager').then((m) => ({ default: m.CashoutAgentManager })));
const HouseListingCommissionReport = lazy(() => import('@/components/cfo/HouseListingCommissionReport').then((m) => ({ default: m.HouseListingCommissionReport })));
const CashoutAgentActivity = lazy(() => import('@/components/cfo/CashoutAgentActivity').then((m) => ({ default: m.CashoutAgentActivity })));
const DeliveryPipelineTracker = lazy(() => import('@/components/cfo/DeliveryPipelineTracker').then((m) => ({ default: m.DeliveryPipelineTracker })));
const AgentCashReconciliation = lazy(() => import('@/components/cfo/AgentCashReconciliation').then((m) => ({ default: m.AgentCashReconciliation })));
const LandlordOpsPayoutReview = lazy(() => import('@/components/cfo/LandlordOpsPayoutReview').then((m) => ({ default: m.LandlordOpsPayoutReview })));
import { CFOReceivablesTracker } from '@/components/cfo/CFOReceivablesTracker';
const LedgerHub = lazy(() => import('@/components/ledgers/LedgerHub').then((m) => ({ default: m.LedgerHub })));
const PendingPortfolioTopUps = lazy(() => import('@/components/cfo/PendingPortfolioTopUps').then((m) => ({ default: m.PendingPortfolioTopUps })));
const AngelPoolManagementPanel = lazy(() => import('@/components/executive/AngelPoolManagementPanel').then((m) => ({ default: m.AngelPoolManagementPanel })));
const WalletRetractionsFeed = lazy(() => import('@/components/cfo/WalletRetractionsFeed').then((m) => ({ default: m.WalletRetractionsFeed })));
const CFOAdvancesManager = lazy(() => import('@/components/cfo/CFOAdvancesManager').then((m) => ({ default: m.CFOAdvancesManager })));
const CFOAdvanceRequestPayments = lazy(() => import('@/components/cfo/CFOAdvanceRequestPayments').then((m) => ({ default: m.CFOAdvanceRequestPayments })));
const BikeLeaseApprovalQueue = lazy(() => import('@/components/executive/agent-ops/BikeLeaseApprovalQueue').then((m) => ({ default: m.BikeLeaseApprovalQueue })));
const BoutiqueOrderApprovalQueue = lazy(() => import('@/components/executive/agent-ops/BoutiqueOrderApprovalQueue').then((m) => ({ default: m.BoutiqueOrderApprovalQueue })));
const SmartphoneOrderApprovalQueue = lazy(() => import('@/components/executive/agent-ops/SmartphoneOrderApprovalQueue').then((m) => ({ default: m.SmartphoneOrderApprovalQueue })));
const AdvancesAnalyticsView = lazy(() => import('@/components/advances/AdvancesAnalyticsView').then((m) => ({ default: m.AdvancesAnalyticsView })));
const AllAdvancesReportPanel = lazy(() => import('@/components/advances/AllAdvancesReportPanel').then((m) => ({ default: m.AllAdvancesReportPanel })));
const DisbursedAdvancesRegister = lazy(() => import('@/components/cfo/DisbursedAdvancesRegister').then((m) => ({ default: m.DisbursedAdvancesRegister })));
const BusinessAdvanceQueue = lazy(() => import('@/components/ops/BusinessAdvanceQueue').then((m) => ({ default: m.BusinessAdvanceQueue })));
const ManagerApprovalAudit = lazy(() => import('@/components/cfo/ManagerApprovalAudit').then((m) => ({ default: m.ManagerApprovalAudit })));
const OpportunitySummaryForm = lazy(() => import('@/components/manager/OpportunitySummaryForm').then((m) => ({ default: m.OpportunitySummaryForm })));
const CFOAgentRequisitions = lazy(() => import('@/components/cfo/CFOAgentRequisitions').then((m) => ({ default: m.CFOAgentRequisitions })));
const EmployeeRequisitionLinksPanel = lazy(() => import('@/components/financial-ops/EmployeeRequisitionLinksPanel').then((m) => ({ default: m.EmployeeRequisitionLinksPanel })));
const EmployeeRequisitionQueuePanel = lazy(() => import('@/components/financial-ops/EmployeeRequisitionQueuePanel').then((m) => ({ default: m.EmployeeRequisitionQueuePanel })));
const NationalIdUnlinkQueuePanel = lazy(() => import('@/components/financial-ops/NationalIdUnlinkQueuePanel').then((m) => ({ default: m.NationalIdUnlinkQueuePanel })));

const RentCollectionsFeed = lazy(() => import('@/components/cfo/RentCollectionsFeed').then((m) => ({ default: m.RentCollectionsFeed })));
const PaymentsByLocationPanel = lazy(() => import('@/components/cfo/PaymentsByLocationPanel').then((m) => ({ default: m.PaymentsByLocationPanel })));
const TenantSelfRepaymentsPanel = lazy(() => import('@/components/reporting/TenantSelfRepaymentsPanel').then((m) => ({ default: m.TenantSelfRepaymentsPanel })));
const AgentPerformanceRankings = lazy(() => import('@/components/cfo/AgentPerformanceRankings').then((m) => ({ default: m.AgentPerformanceRankings })));
const AgentFloatManagement = lazy(() => import('@/components/cfo/AgentFloatManagement').then((m) => ({ default: m.AgentFloatManagement })));
const LedgerHealthPanel = lazy(() => import('@/components/cfo/LedgerHealthPanel').then((m) => ({ default: m.LedgerHealthPanel })));
const FieldCashExposureCard = lazy(() => import('@/components/cfo/FieldCashExposureCard').then((m) => ({ default: m.FieldCashExposureCard })));
const CFOAgentOpsFloatSender = lazy(() => import('@/components/cfo/CFOAgentOpsFloatSender').then((m) => ({ default: m.CFOAgentOpsFloatSender })));
const CFOImpactKPIStrip = lazy(() => import('@/components/cfo/CFOImpactKPIStrip').then((m) => ({ default: m.CFOImpactKPIStrip })));
const CFOWalletActivities = lazy(() => import('@/components/cfo/CFOWalletActivities').then((m) => ({ default: m.CFOWalletActivities })));
import { RecentApprovalsByCategory } from '@/components/cfo/RecentApprovalsByCategory';
const EarningsExplainer = lazy(() => import('@/components/shared/EarningsExplainer').then((m) => ({ default: m.EarningsExplainer })));
const AgentAllocationTracesPanel = lazy(() => import('@/components/cfo/AgentAllocationTracesPanel').then((m) => ({ default: m.AgentAllocationTracesPanel })));
const PhantomCorrectionDriftPanel = lazy(() => import('@/components/cfo/PhantomCorrectionDriftPanel').then((m) => ({ default: m.PhantomCorrectionDriftPanel })));
const DuplicateRoiCreditsPanel = lazy(() => import('@/components/cfo/DuplicateRoiCreditsPanel').then((m) => ({ default: m.DuplicateRoiCreditsPanel })));
const FinanceMonitoringHealthPanel = lazy(() => import('@/components/cfo/FinanceMonitoringHealthPanel').then((m) => ({ default: m.FinanceMonitoringHealthPanel })));
const CFOUnfundingApprovals = lazy(() => import('@/components/cfo/CFOUnfundingApprovals').then((m) => ({ default: m.CFOUnfundingApprovals })));
const CFOAllocationReturnApprovals = lazy(() => import('@/components/cfo/CFOAllocationReturnApprovals').then((m) => ({ default: m.CFOAllocationReturnApprovals })));
const LandlordFloatIdleQueue = lazy(() => import('@/components/shared/LandlordFloatIdleQueue').then((m) => ({ default: m.LandlordFloatIdleQueue })));
const SmsDeliveryLogPanel = lazy(() => import('@/components/cfo/SmsDeliveryLogPanel').then((m) => ({ default: m.SmsDeliveryLogPanel })));
const SmsFailureAlertsPanel = lazy(() => import('@/components/cfo/SmsFailureAlertsPanel').then((m) => ({ default: m.SmsFailureAlertsPanel })));
const AlreadyFundedLandlordsPanel = lazy(() => import('@/components/cfo/AlreadyFundedLandlordsPanel').then((m) => ({ default: m.AlreadyFundedLandlordsPanel })));
import { CFOBreadcrumbHeader } from '@/components/cfo/CFOBreadcrumbHeader';
import { SwipeSensitivityControl } from '@/components/cfo/SwipeSensitivityControl';
import { SwipeOnboardingHint } from '@/components/cfo/SwipeOnboardingHint';
import { useSwipeSensitivity } from '@/hooks/useSwipeSensitivity';
import { usePersistedActiveTab } from '@/hooks/usePersistedActiveTab';
import { useCfoAdvanceDisbursementCount } from '@/hooks/useCfoAdvanceDisbursementCount';
import { CFOApprovalNotificationsBell } from '@/components/cfo/CFOApprovalNotificationsBell';
const StatutoryConsentList = lazy(() => import('@/components/cfo/StatutoryConsentList').then((m) => ({ default: m.StatutoryConsentList })));
const LandlordFloatBudgetPanel = lazy(() => import('@/components/cfo/LandlordFloatBudgetPanel').then((m) => ({ default: m.LandlordFloatBudgetPanel })));
// Lazy: keeps the register (and its on-demand xlsx import) out of the main CFO bundle.
const AssetRegisterPanel = lazy(() => import('@/components/cfo/assets/AssetRegisterPanel'));

// Ordered, swipeable tab ids derived from the CFO sidebar (route items excluded).
// A parent that only discloses children (e.g. Agent Products) is not itself a
// destination — its children are the tabs.
const CFO_TAB_SEQUENCE = (executiveSidebarConfig.cfo ?? [])
  .flatMap((section) => section.items)
  .flatMap((item) => (item.children?.length ? item.children : [item]))
  .filter((item) => !item.route);
const CFO_TAB_IDS = CFO_TAB_SEQUENCE.map((i) => i.id);
const CFO_TAB_LABELS: Record<string, string> = Object.fromEntries(
  CFO_TAB_SEQUENCE.map((i) => [i.id, i.label]),
);

export default function CFODashboardPage() {
  const { currency, setCurrency, getCurrencyByCode } = useCurrency();
  const [activeTab, setActiveTab] = usePersistedActiveTab('cfo', 'overview', CFO_TAB_IDS);
  const isMobile = useIsMobile();
  const { threshold: swipeThreshold, setThreshold: setSwipeThreshold } = useSwipeSensitivity('cfo');
  const advanceDisbursementCount = useCfoAdvanceDisbursementCount(activeTab === 'advances');
  const [addStandingOrderOpen, setAddStandingOrderOpen] = useState(false);


  const goToOffset = (delta: number) => {
    const current = CFO_TAB_IDS.indexOf(activeTab);
    const idx = current === -1 ? 0 : current;
    const next = idx + delta;
    if (next < 0 || next >= CFO_TAB_IDS.length) return;
    const nextId = CFO_TAB_IDS[next];
    setActiveTab(nextId);
    document.querySelector('main')?.scrollTo({ top: 0, behavior: 'auto' });
    toast.dismiss();
    toast(CFO_TAB_LABELS[nextId], {
      description: `${next + 1} of ${CFO_TAB_IDS.length}`,
      duration: 1200,
    });
  };

  const swipeHandlers = useHorizontalSwipe({
    onSwipeLeft: () => goToOffset(1),
    onSwipeRight: () => goToOffset(-1),
    threshold: swipeThreshold,
  });

  // Keyboard navigation between sections for keyboard + screen-reader users
  // (Alt+Arrow to move, Alt+Home to jump to the overview). Alt avoids clashing
  // with normal typing, scrolling, and native control arrow keys.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (!e.altKey || e.ctrlKey || e.metaKey) return;
      if (e.key === 'ArrowRight') {
        e.preventDefault();
        goToOffset(1);
      } else if (e.key === 'ArrowLeft') {
        e.preventDefault();
        goToOffset(-1);
      } else if (e.key === 'Home') {
        e.preventDefault();
        setActiveTab('overview');
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  });

  const currentTabIndex = CFO_TAB_IDS.indexOf(activeTab);
  const sectionPosition = {
    index: (currentTabIndex === -1 ? 0 : currentTabIndex) + 1,
    total: CFO_TAB_IDS.length,
  };

  // Force UGX on CFO dashboard — financial reporting must always be in base currency
  useEffect(() => {
    if (currency.code !== 'UGX') {
      const ugx = getCurrencyByCode('UGX');
      if (ugx) setCurrency(ugx);
    }
  }, []);

  // Advance Requests must never be the CFO's landing page. If a previous
  // session persisted 'advances' AND the current URL has no explicit
  // ?section=, bounce back to the overview so the CFO sees the full picture
  // (portfolio stats, treasury, agent advances chart) on login.
  useEffect(() => {
    if (activeTab !== 'advances') return;
    const url = new URL(window.location.href);
    if (url.searchParams.get('section') === 'advances') return;
    setActiveTab('overview');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const renderContent = () => {
    switch (activeTab) {
      case 'asset-register':
        return (
          <Suspense fallback={<div className="py-16 text-center text-xs text-muted-foreground">Loading asset register…</div>}>
            <AssetRegisterPanel />
          </Suspense>
        );
      case 'landlord-float-budget':
        return <LandlordFloatBudgetPanel />;
      case 'redemption-approvals':
        return <RedemptionApprovalsPanel />;
      case 'compound-requests':
        return <CompoundRequestApprovalsPanel />;
      case 'lunch-allowance':
        return <LunchAllowanceTracker />;
      case 'cash-position':
        return <CFOOverviewDashboard cashPositionOnly onTabChange={setActiveTab} />;
      case 'requisitions':
        return <RequisitionsWorkspace manualStage="cfo" />;

      case 'wallet-payout':
        return (
          <div className="space-y-5">
            <DirectCreditTool />

            {/* Quick jump to Standing Orders & General Payout Activity */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="flex items-center justify-between gap-3.5 p-5 rounded-3xl border border-border/70 bg-gradient-to-r from-card via-card to-card/60 shadow-xs">
                <div className="flex items-center gap-3.5 min-w-0">
                  <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-primary/10 text-primary ring-1 ring-primary/25 shadow-xs">
                    <CalendarClock className="h-5 w-5" />
                  </div>
                  <div className="min-w-0">
                    <p className="text-sm font-bold text-foreground truncate">Scheduled Standing Orders</p>
                    <p className="text-xs text-muted-foreground mt-0.5 line-clamp-1">
                      Manage recurring wallet schedules, monthly rules &amp; health checks.
                    </p>
                  </div>
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  className="h-9 rounded-xl gap-1.5 border-border/70 shadow-xs hover:bg-muted font-semibold shrink-0"
                  onClick={() => setActiveTab('standing-orders')}
                >
                  Manage
                  <ArrowRight className="h-4 w-4" />
                </Button>
              </div>

              <div className="flex items-center justify-between gap-3.5 p-5 rounded-3xl border border-border/70 bg-gradient-to-r from-card via-card to-card/60 shadow-xs">
                <div className="flex items-center gap-3.5 min-w-0">
                  <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-emerald-500/10 text-emerald-600 ring-1 ring-emerald-500/25 shadow-xs">
                    <ClipboardCheck className="h-5 w-5" />
                  </div>
                  <div className="min-w-0">
                    <p className="text-sm font-bold text-foreground truncate">General Payout Activity</p>
                    <p className="text-xs text-muted-foreground mt-0.5 line-clamp-1">
                      View past disbursements, approvals, category reports, and PDF statements.
                    </p>
                  </div>
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  className="h-9 rounded-xl gap-1.5 border-border/70 shadow-xs hover:bg-muted font-semibold shrink-0"
                  onClick={() => setActiveTab('general-payout-activity')}
                >
                  Activity
                  <ArrowRight className="h-4 w-4" />
                </Button>
              </div>
            </div>
          </div>
        );

      case 'general-payout-activity':
        return <CfoGeneralPayoutActivityPage />;

      case 'standing-orders':
        return (
          <div className="space-y-4">
            <div className="rounded-2xl border border-border/80 bg-gradient-to-r from-card via-card to-muted/20 p-5 sm:p-6 shadow-sm">
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
                <div className="space-y-1 max-w-3xl">
                  <div className="flex items-center gap-2">
                    <span className="text-xl">🔁</span>
                    <h1 className="text-xl sm:text-2xl font-bold tracking-tight text-foreground">
                      Standing Orders &amp; Automated Payouts
                    </h1>
                  </div>
                  <p className="text-xs sm:text-sm text-muted-foreground leading-relaxed">
                    Automated recurring payouts scheduled from "Send Money". Health monitoring flags orders with deleted/missing target accounts, cron failures, or stalled execution schedules so you can pause or resolve leaks immediately.
                  </p>
                </div>
                <Button
                  onClick={() => setAddStandingOrderOpen(true)}
                  className="h-11 px-5 rounded-xl font-semibold gap-2 bg-primary text-primary-foreground shadow-sm hover:bg-primary/90 shrink-0 self-start sm:self-center"
                >
                  <Plus className="h-4 w-4" />
                  Add Standing Order
                </Button>
              </div>
            </div>
            <StandingOrdersPanel />
            <AddStandingOrderDialog
              open={addStandingOrderOpen}
              onOpenChange={setAddStandingOrderOpen}
            />
          </div>
        );
      case 'approved-rent-payouts':
        return <CFOApprovedRentPayouts />;
      case 'roi-requests':
        // Partner Returns: the CEO-only switch (read-only for everyone else) and the CFO rate queue.
        return (
          <div className="space-y-6">
            <PartnerReturnPolicyCard />
            <PartnerRateApprovalsPanel />
            <CFOROIRequests />
          </div>
        );
      case 'rent-payouts':
        return (
          <div className="space-y-5">
            <div className="rounded-xl border border-border/70 bg-card p-4 sm:p-5 shadow-xs">
              <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
                <div className="space-y-1">
                  <div className="flex items-center gap-2">
                    <Badge variant="outline" className="text-[11px] font-semibold tracking-wide uppercase px-2 py-0.5 border-primary/30 text-primary bg-primary/5">
                      CFO Office · Treasury &amp; Disbursements
                    </Badge>
                  </div>
                  <h1 className="text-xl sm:text-2xl font-bold tracking-tight text-foreground flex items-center gap-2">
                    Rent Payout Authorization
                  </h1>
                  <p className="text-xs sm:text-sm text-muted-foreground max-w-2xl">
                    Final desk authorization for COO-approved Rent Plans. Verify funder matching, review landlord payout details, or return requests for operational corrections before disbursement.
                  </p>
                </div>
              </div>
            </div>
            <RentPipelineQueue stage="coo_approved" initialViewMode="table" />
            <RejectedRequestsQueue stageFilter="coo_approved" title="Rejected at CFO" />
          </div>
        );
      case 'statements':
        return <FinancialStatementsPanel />;
      case 'weekly-report':
        return <CFOWeeklyReportPanel />;
      case 'accounting-health':
        return <AccountingHealthPanel />;
      case 'department-budgets':
        return (
          <div className="space-y-4">
            <div>
              <h1 className="text-xl font-bold">Department Budgets &amp; CFO Approval</h1>
              <p className="text-sm text-muted-foreground">
                Review department submissions, trim or reject lines, manage budget cycles and track Budget vs Actual.
              </p>
            </div>
            <BudgetApprovalPanel />
          </div>
        );
      case 'service-centre-spend':
        return (
          <div className="space-y-4">
            <div>
              <h1 className="text-xl font-bold">Service Centre Spend Approval</h1>
              <p className="text-sm text-muted-foreground">
                Service centres vetted by the COO arrive here with the reason and the money to be spent.
              </p>
            </div>
            <CFOServiceCentreSpendApproval />
          </div>
        );

      case 'allocation-traces':
        return <AgentAllocationTracesPanel />;
      case 'solvency':
        return (
          <div className="space-y-6">
            <BufferAccountPanel />
            <SupporterROITrigger />
          </div>
        );
      case 'reconciliation':
        return (
          <div className="space-y-6">
            <FinanceMonitoringHealthPanel />
            <DuplicateRoiCreditsPanel />
            <PhantomCorrectionDriftPanel />
          </div>
        );
      case 'ledger':
        return <GeneralLedger />;
      case 'commissions':
        return <AgentCommissionPayoutsManager />;
      case 'house-listing-commission':
        return <HouseListingCommissionReport />;
      case 'withdrawals':
        return (
          <div className="space-y-6">
            <WithdrawalRequestsManager />
            <CFOPartnerPayoutProcessing />
          </div>
        );
      case 'withdrawal-history':
        return <WithdrawalHistoryStatement />;
      case 'withdrawal-reconciliation':
        return (
          <div className="space-y-6">
            {/* PHASE 8: incomplete/unsafe payouts always visible to CFO. */}
            <PayoutReconciliationQueue />
            <StaleWithdrawalHoldsPanel />
          </div>
        );
      case 'financial-agents':
        return <FinancialAgentsPanel />;
      case 'cashout-agents':
        return <CashoutAgentManager />;
      case 'agent-activity':
        return <CashoutAgentActivity />;
      case 'payroll':
        return <PayrollPanel />;
      case 'payroll-release':
        return <CfoPayrollPanel />;
      case 'cfo-pay-advances':
        return <AdvancesPanel />;
      case 'partner-receipts':
        return <PartnerReceiptsPanel />;
      case 'cfo-payroll-history':
        return <CfoPayrollHistoryPanel />;
      case 'cfo-pay-approvals':
        return <ApprovalsInbox />;
      case 'delivery-pipeline':
        return <DeliveryPipelineTracker />;
      case 'cash-reconciliation':
        return <AgentCashReconciliation />;
      case 'landlord-payouts':
        return (
          <div className="space-y-4">
            <h1 className="text-xl font-bold">🏠 Agent Landlord Payout Verification</h1>
            <p className="text-sm text-muted-foreground">
              Review and sign off on agent-to-landlord MoMo payouts after Landlord Ops approval.
            </p>
            <LandlordOpsPayoutReview reviewRole="cfo" />
          </div>
        );
      case 'landlord-payout-float':
        return <CfoLandlordPayoutFloatPanel />;
      case 'tenant-balance-changes':
        return <CfoTenantBalanceChangesPage />;
      case 'welile-homes-payouts':
        return (
          <div className="space-y-4">
            <CFOWelileHomesDisbursementDesk />
            <WhHistoricalDisbursementsPanel mode="readonly" offSystem />
          </div>
        );
      case 'signages':
      case 'cfo-signages':
        return (
          <div className="space-y-4">
            <CFOSignagesDesk />
          </div>
        );
      case 'already-funded-landlords':
        return (
          <div className="space-y-4">
            <div>
              <h1 className="text-xl font-bold">🏛️ Already Funded Landlords</h1>
              <p className="text-sm text-muted-foreground">
                Landlords whose rent has already been disbursed by the CFO and is now either with the agent
                (awaiting MoMo payout) or already forwarded to the landlord. Tracks funded, repaying, and completed rent requests.
              </p>
            </div>
            <AlreadyFundedLandlordsPanel />
          </div>
        );
      case 'advanced-ledgers':
        return <LedgerHub />;
      case 'partner-topups':
        return (
          <div className="space-y-4">
            <h1 className="text-xl font-bold">📊 Partner Top-ups</h1>
            <p className="text-sm text-muted-foreground">Pending portfolio top-up requests awaiting verification.</p>
            <PendingPortfolioTopUps />
          </div>
        );
      case 'angel-pool':
        return <AngelPoolManagementPanel userRole="cfo" />;
      case 'retractions':
        return <WalletRetractionsFeed />;
      case 'error-corrections':
        return <ErrorCorrectionAuditPanel />;
      case 'corrections-approvals':
        return <CorrectionCenterPanel />;
      case 'unfunding-approvals':
        return (
          <div className="space-y-6">
            <LandlordFloatIdleQueue />
            <CFOAllocationReturnApprovals />
            <CFOUnfundingApprovals />
          </div>
        );
      case 'bike-leases':
      case 'agent-products-motorbikes':
        return (
          <div className="space-y-4">
            <div>
              <h1 className="text-xl font-bold">Welile Motorbikes</h1>
              <p className="text-sm text-muted-foreground">
                Applications approved by the COO. Releasing one pays the assigned supplier and starts the agent's daily recovery. Files you have already released stay listed here and open read-only, with what was paid out and what the books carry.
              </p>
            </div>
            <BikeLeaseApprovalQueue stage="cfo" />
          </div>
        );
      case 'agent-products-smartphones':
        return (
          <div className="space-y-4">
            <div>
              <h1 className="text-xl font-bold">Welile Smartphones</h1>
              <p className="text-sm text-muted-foreground">
                Applications approved by the COO. Releasing one pays the assigned supplier and starts the agent's daily recovery. Files you have already released stay listed here and open read-only.
              </p>
            </div>
            <SmartphoneOrderApprovalQueue stage="cfo" />
          </div>
        );
      case 'agent-products-boutique':
        return (
          <div className="space-y-4">
            <div>
              <h1 className="text-xl font-bold">Agent Boutique</h1>
              <p className="text-sm text-muted-foreground">
                Boutique orders approved by the COO. Your approval is final and issues the item to the agent; repayment follows the order's existing plan. Orders issued in the last 30 days stay listed here.
              </p>
            </div>
            <BoutiqueOrderApprovalQueue stage="cfo" />
          </div>
        );
      case 'advances-analytics':
        return <AdvancesAnalyticsView context="cfo" />;
      case 'advances':
        return (
          <div className="space-y-6">
            <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-4">
              <div>
                <h1 className="text-xl font-bold">💵 Advance Requests</h1>
                <p className="text-sm text-muted-foreground">
                  Review, edit and approve agent &amp; business advance requests, then disburse in one step.
                  Track what&apos;s been disbursed under <strong>Disbursed Advances</strong> and repayments under <strong>Advance Repayments</strong>.
                </p>
              </div>
              <Button
                variant="outline"
                size="sm"
                onClick={() => setActiveTab('special-advances')}
                className="gap-1.5 shrink-0"
              >
                <Sparkles className="h-4 w-4 text-primary" /> Special Advance
              </Button>
            </div>
            <CFOAdvanceRequestPayments onViewDisbursed={() => setActiveTab('advances-disbursed')} />
            <div className="pt-4 border-t">
              <h2 className="text-base font-semibold mb-2">🏪 Business Advance Requests</h2>
              <BusinessAdvanceQueue stage="cfo" />
            </div>
          </div>
        );
      case 'advances-report':
        return (
          <div className="space-y-4">
            <div>
              <h1 className="text-xl font-bold">📋 All Advances Report</h1>
              <p className="text-sm text-muted-foreground">
                Unified read-only view of every advance requested, approved, rejected, or disbursed across the platform.
              </p>
            </div>
            <AllAdvancesReportPanel />
          </div>
        );
      case 'advances-disbursed':
        return (
          <div className="space-y-6">
            <div>
              <h1 className="text-xl font-bold">Disbursed Advances</h1>
              <p className="text-sm text-muted-foreground">
                Every advance disbursed to an agent wallet. View, filter, cancel or reverse disbursed advances and open any row for the full disbursement detail.
              </p>
            </div>
            <div id="cfo-disbursed-advances" className="scroll-mt-24">
              <DisbursedAdvancesRegister />
            </div>
          </div>
        );
      case 'tenant-repayment-tracker':
        return (
          <Suspense fallback={<p className="py-6 text-center text-xs text-muted-foreground">Loading...</p>}>
            <TenantRepaymentTracker />
          </Suspense>
        );
      case 'special-advances':
        return (
          <div className="space-y-6">
            <div className="rounded-2xl border border-border/80 bg-gradient-to-r from-card via-card to-muted/20 p-5 sm:p-6 shadow-sm">
              <div className="flex items-center gap-2">
                <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary/10 text-primary">
                  <Sparkles className="h-4 w-4" />
                </span>
                <h1 className="text-xl sm:text-2xl font-bold tracking-tight text-foreground">
                  Special Advances
                </h1>
              </div>
            </div>

            <Suspense fallback={<p className="py-6 text-center text-xs text-muted-foreground">Loading...</p>}>
              <SpecialAdvancesPanel />
            </Suspense>
          </div>
        );
      case 'advance-repayments':
        return <CFOAdvancesManager />;
      case 'statutory-consent-list':
        return <StatutoryConsentList />;
      case 'landlord-float-timeline':
        return <TenantOpsLandlordFloatTimeline />;
      case 'approval-audit':
        return <ManagerApprovalAudit />;
      case 'agent-requisitions':
        return <CFOAgentRequisitions />;
      case 'employee-requisition-links':
        return (
          <div className="space-y-4">
            <div>
              <h1 className="text-xl font-bold">🔗 Employee Requisition Links</h1>
              <p className="text-sm text-muted-foreground">
                Generate secure, shareable links so employees can submit financial requisitions without a Welile account.
                Copy or send via WhatsApp — revoke anytime.
              </p>
            </div>
            <EmployeeRequisitionLinksPanel />
          </div>
        );
      case 'national-id-unlink-requests':
        return (
          <div className="space-y-4">
            <div>
              <h1 className="text-xl font-bold">🆔 National ID Removal Requests</h1>
              <p className="text-sm text-muted-foreground">
                Approve or refuse requests from ID holders to take someone off their National ID.
              </p>
            </div>
            <NationalIdUnlinkQueuePanel />
          </div>
        );
      case 'employee-requisitions':

        return (
          <div className="space-y-4">
            <div>
              <h1 className="text-xl font-bold">📥 Employee Requisitions</h1>
              <p className="text-sm text-muted-foreground">
                Review, approve or reject requisitions submitted through shareable public links.
              </p>
            </div>
            <EmployeeRequisitionQueuePanel />
          </div>
        );
      case 'rent-collections':
        return <RentCollectionsFeed />;
      case 'payments-by-location':
        return <PaymentsByLocationPanel />;
      case 'tenant-self-repayments':
        return <TenantSelfRepaymentsPanel audience="finance" />;
      case 'agent-rankings':
        return <AgentPerformanceRankings />;
      case 'float-management':
        return (
          <div className="space-y-6">
            <CFOAgentOpsFloatSender />
            <AgentFloatManagement />
            <FieldCashExposureCard />
          </div>
        );
      case 'merchant-float':
        return (
          <div className="space-y-4">
            <div>
              <h1 className="text-xl font-bold">🏪 Merchant Float Requests</h1>
              <p className="text-sm text-muted-foreground">
                Cash-out merchant agents requesting operational float top-ups. Fund their Float
                bucket via the Agent Float Allocation category or reject with a reason.
              </p>
            </div>
            <MerchantFloatRequestsPanel />
          </div>
        );
      case 'merchant-float-requisitions':
        return <MerchantFloatRequisitionPanel mode="cfo" />;
      case 'ledger-health':
        return <LedgerHealthPanel />;
      case 'cashflow-forecast':
        return <CashflowForecastGraphs />;
      case 'capital-opportunities':
        return (
          <div className="space-y-4">
            <div>
              <h1 className="text-xl font-bold">📈 Capital Opportunities</h1>
              <p className="text-sm text-muted-foreground">
                Edit the total rent demand and opportunity summary shown to funders.
              </p>
            </div>
            <OpportunitySummaryForm />
          </div>
        );
      case 'revenue-expenses':
        return <RevenueExpenseDashboard />;
      case 'roi-disbursement-report':
        return <RoiDisbursementReportPanel />;
      case 'rent-disbursement-report':
        return <RentDisbursementReportPanel />;
      case 'merchant-requisition-report':
        return <MerchantFloatRequisitionReportPanel />;
      case 'approved-requisitions':
        return <ApprovedRequisitionsPayoutPanel />;
      case 'employee-requisition-report':
        return <EmployeeRequisitionReportPanel />;
      case 'expense-report':
        return <ExpenseReportPanel />;
      case 'paid-by-category':
        return (
          <Suspense fallback={<div className="py-16 text-center text-xs text-muted-foreground">Loading Money Out report…</div>}>
            <PaidByCategory />
          </Suspense>
        );
      case 'received-by-category':
        return (
          <Suspense fallback={<div className="py-16 text-center text-xs text-muted-foreground">Loading Money In report…</div>}>
            <ReceivedByCategory />
          </Suspense>
        );
      case 'sms-otp-costs':
        return <SmsOtpCostsPanel />;
      case 'payout-reports':
        return (
          <div className="space-y-6">
            <div className="flex items-start justify-between gap-2 flex-wrap">
              <div>
                <h1 className="text-xl font-bold">💸 Payout Reports</h1>
                <p className="text-sm text-muted-foreground">
                  Consolidated view of every payout — user wallet withdrawals, mobile money and bank
                  disbursements, and automated payouts — with daily cash position and search.
                </p>
              </div>
              <CFOPayoutsShareButton />
            </div>
            <DailyCashPositionReport />
            <AutoPayoutHistory />
            <WithdrawalHistoryStatement />
          </div>
        );
      case 'platform-impact':
        return (
          <div className="space-y-4">
            <div>
              <h2 className="text-xl font-semibold">Platform Impact</h2>
              <p className="text-sm text-muted-foreground">
                People and partners actively using Welile. Tap any tile for the underlying records.
              </p>
            </div>
            <CFOImpactKPIStrip />
          </div>
        );
      case 'wallet-activities':
        return <CFOWalletActivities />;
      case 'earnings-explainer':
        return <EarningsExplainer role="cfo" />;
      case 'sms-log':
        return (
          <div className="space-y-6">
            <SmsFailureAlertsPanel />
            <SmsDeliveryLogPanel />
          </div>
        );
      default:
        // Home no longer carries the Cash Position band — it has its own page.
        return <CFOOverviewDashboard onTabChange={setActiveTab} showCashPosition={false} />;
    }
  };

  return (
    <ExecutiveDashboardLayout
      role="cfo"
      activeTab={activeTab}
      onTabChange={setActiveTab}
      badges={{ advances: advanceDisbursementCount }}
      headerActions={<CFOApprovalNotificationsBell onJump={setActiveTab} />}
      fillHeight={activeTab === 'overview'}
    >
      <CFOBreadcrumbHeader
        activeTab={activeTab}
        onJump={setActiveTab}
        position={sectionPosition}
        onPrev={() => goToOffset(-1)}
        onNext={() => goToOffset(1)}
        actions={
          isMobile ? (
            <SwipeSensitivityControl threshold={swipeThreshold} onChange={setSwipeThreshold} />
          ) : undefined
        }
      />
      <SwipeOnboardingHint enabled={isMobile} />
      <div {...(isMobile ? swipeHandlers : {})} className={activeTab === 'overview' ? 'flex min-h-[60vh] flex-1 flex-col' : 'min-h-[60vh]'}>
        <Suspense fallback={<p role="status" className="py-12 text-center text-sm text-muted-foreground">Loading section…</p>}>{renderContent()}</Suspense>
      </div>
    </ExecutiveDashboardLayout>
  );
}
