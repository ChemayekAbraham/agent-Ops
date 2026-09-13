import { useEffect } from 'react';
import { ArrowLeft, ShieldCheck } from 'lucide-react';
import walletSecurityIllustration from '@/assets/undraw_wallet_diag.svg.asset.json';

import { toast } from 'sonner';
import { useCurrency } from '@/hooks/useCurrency';
import { useIsMobile } from '@/hooks/use-mobile';
import { useHorizontalSwipe } from '@/hooks/useHorizontalSwipe';
import { executiveSidebarConfig } from '@/components/layout/executiveSidebarConfig';
import { TenantOpsLandlordFloatTimeline } from '@/components/executive/TenantOpsLandlordFloatTimeline';
import ExecutiveDashboardLayout from '@/components/layout/ExecutiveDashboardLayout';
import { ChannelBalanceTracker } from '@/components/cfo/ChannelBalanceTracker';
import { ErrorCorrectionAuditPanel } from '@/components/cfo/ErrorCorrectionAuditPanel';
import { PlatformVsWalletSummary } from '@/components/cfo/PlatformVsWalletSummary';
import { CFOROIRequests } from '@/components/cfo/CFOROIRequests';
import { CFOOverviewDashboard } from '@/components/cfo/CFOOverviewDashboard';
import { DirectCreditTool } from '@/components/cfo/DirectCreditTool';
import { StandingOrdersPanel } from '@/components/cfo/StandingOrdersPanel';
import BudgetApprovalPanel from '@/components/cfo/BudgetApprovalPanel';
import CFOServiceCentreSpendApproval from '@/components/cfo/CFOServiceCentreSpendApproval';
import { MerchantFloatRequestsPanel } from '@/components/cfo/MerchantFloatRequestsPanel';
import { MerchantFloatRequisitionPanel } from '@/components/financial-ops/MerchantFloatRequisitionPanel';
import { CFOPayoutsShareButton } from '@/components/cfo/CFOPayoutsShareButton';
import { RevenueExpenseDashboard } from '@/components/cfo/RevenueExpenseDashboard';
import RoiDisbursementReportPanel from '@/components/cfo/RoiDisbursementReportPanel';
import RentDisbursementReportPanel from '@/components/cfo/RentDisbursementReportPanel';
import MerchantFloatRequisitionReportPanel from '@/components/cfo/MerchantFloatRequisitionReportPanel';
import EmployeeRequisitionReportPanel from '@/components/cfo/EmployeeRequisitionReportPanel';
import ExpenseReportPanel from '@/components/cfo/ExpenseReportPanel';
import CFOWeeklyReportPanel from '@/components/cfo/CFOWeeklyReportPanel';
import { CashflowForecastGraphs } from '@/components/cfo/CashflowForecastGraphs';
import { RequisitionsWorkspace } from '@/components/requisitions/RequisitionsWorkspace';

import { FinancialStatementsPanel } from '@/components/manager/FinancialStatementsPanel';
import { BufferAccountPanel } from '@/components/manager/BufferAccountPanel';
import { SupporterROITrigger } from '@/components/manager/SupporterROITrigger';
import { AgentCommissionPayoutsManager } from '@/components/manager/AgentCommissionPayoutsManager';
import { WithdrawalRequestsManager } from '@/components/manager/WithdrawalRequestsManager';
import { GeneralLedger } from '@/components/manager/GeneralLedger';
import { CFOPartnerPayoutProcessing } from '@/components/cfo/CFOPartnerPayoutProcessing';
import { RentDisbursementQueue } from '@/components/cfo/RentDisbursementQueue';
import { PromissoryBookingsPanel } from '@/components/cfo/PromissoryBookingsPanel';
import { BatchPayoutProcessor } from '@/components/cfo/BatchPayoutProcessor';
import { LandlordFloatAllocationsPanel } from '@/components/cfo/LandlordFloatAllocationsPanel';
import { WithdrawalHistoryStatement } from '@/components/financial-ops/WithdrawalHistoryStatement';
import { StaleWithdrawalHoldsPanel } from '@/components/cfo/StaleWithdrawalHoldsPanel';
import { PayoutReconciliationQueue } from '@/components/financial-ops/PayoutReconciliationQueue';
import { AutoPayoutHistory } from '@/components/cfo/AutoPayoutHistory';
import { DailyCashPositionReport } from '@/components/cfo/DailyCashPositionReport';
import { RentPipelineQueue } from '@/components/executive/RentPipelineQueue';
import { RejectedRequestsQueue } from '@/components/executive/RejectedRequestsQueue';
import { ListingBonusApprovalQueue } from '@/components/executive/ListingBonusApprovalQueue';
import { FinancialAgentsPanel } from '@/components/cfo/FinancialAgentsPanel';
import { PayrollPanel } from '@/components/cfo/PayrollPanel';
import CfoPayrollPanel from '@/hr/pay/CfoPayrollPanel';
import { CashoutAgentManager } from '@/components/cfo/CashoutAgentManager';
import { HouseListingCommissionReport } from '@/components/cfo/HouseListingCommissionReport';
import { CashoutAgentActivity } from '@/components/cfo/CashoutAgentActivity';
import { DeliveryPipelineTracker } from '@/components/cfo/DeliveryPipelineTracker';
import { AgentCashReconciliation } from '@/components/cfo/AgentCashReconciliation';
import { LandlordOpsPayoutReview } from '@/components/cfo/LandlordOpsPayoutReview';
import { CFOReceivablesTracker } from '@/components/cfo/CFOReceivablesTracker';
import { LedgerHub } from '@/components/ledgers/LedgerHub';
import { PendingPortfolioTopUps } from '@/components/cfo/PendingPortfolioTopUps';
import { AngelPoolManagementPanel } from '@/components/executive/AngelPoolManagementPanel';
import { WalletRetractionsFeed } from '@/components/cfo/WalletRetractionsFeed';
import { CFOAdvancesManager } from '@/components/cfo/CFOAdvancesManager';
import { CFOAdvanceRequestPayments } from '@/components/cfo/CFOAdvanceRequestPayments';
import { BikeLeaseApprovalQueue } from '@/components/executive/agent-ops/BikeLeaseApprovalQueue';
import { AdvancesAnalyticsView } from '@/components/advances/AdvancesAnalyticsView';
import { AllAdvancesReportPanel } from '@/components/advances/AllAdvancesReportPanel';
import { DisbursedAdvancesRegister } from '@/components/cfo/DisbursedAdvancesRegister';
import { BusinessAdvanceQueue } from '@/components/ops/BusinessAdvanceQueue';
import { ManagerApprovalAudit } from '@/components/cfo/ManagerApprovalAudit';
import { OpportunitySummaryForm } from '@/components/manager/OpportunitySummaryForm';
import { CFOAgentRequisitions } from '@/components/cfo/CFOAgentRequisitions';
import { EmployeeRequisitionLinksPanel } from '@/components/financial-ops/EmployeeRequisitionLinksPanel';
import { EmployeeRequisitionQueuePanel } from '@/components/financial-ops/EmployeeRequisitionQueuePanel';
import { RentCollectionsFeed } from '@/components/cfo/RentCollectionsFeed';
import { PaymentsByLocationPanel } from '@/components/cfo/PaymentsByLocationPanel';
import { TenantSelfRepaymentsPanel } from '@/components/reporting/TenantSelfRepaymentsPanel';
import { AgentPerformanceRankings } from '@/components/cfo/AgentPerformanceRankings';
import { AgentFloatManagement } from '@/components/cfo/AgentFloatManagement';
import { LedgerHealthPanel } from '@/components/cfo/LedgerHealthPanel';
import { FieldCashExposureCard } from '@/components/cfo/FieldCashExposureCard';
import { CFOAgentOpsFloatSender } from '@/components/cfo/CFOAgentOpsFloatSender';
import { CFOImpactKPIStrip } from '@/components/cfo/CFOImpactKPIStrip';
import { CFOWalletActivities } from '@/components/cfo/CFOWalletActivities';
import { RecentApprovalsByCategory } from '@/components/cfo/RecentApprovalsByCategory';
import { EarningsExplainer } from '@/components/shared/EarningsExplainer';
import { AgentAllocationTracesPanel } from '@/components/cfo/AgentAllocationTracesPanel';
import { PhantomCorrectionDriftPanel } from '@/components/cfo/PhantomCorrectionDriftPanel';
import { DuplicateRoiCreditsPanel } from '@/components/cfo/DuplicateRoiCreditsPanel';
import { FinanceMonitoringHealthPanel } from '@/components/cfo/FinanceMonitoringHealthPanel';
import { CFOUnfundingApprovals } from '@/components/cfo/CFOUnfundingApprovals';
import { CFOAllocationReturnApprovals } from '@/components/cfo/CFOAllocationReturnApprovals';
import { SmsDeliveryLogPanel } from '@/components/cfo/SmsDeliveryLogPanel';
import { SmsFailureAlertsPanel } from '@/components/cfo/SmsFailureAlertsPanel';
import { AlreadyFundedLandlordsPanel } from '@/components/cfo/AlreadyFundedLandlordsPanel';
import { CFOBreadcrumbHeader } from '@/components/cfo/CFOBreadcrumbHeader';
import { SwipeSensitivityControl } from '@/components/cfo/SwipeSensitivityControl';
import { SwipeOnboardingHint } from '@/components/cfo/SwipeOnboardingHint';
import { useSwipeSensitivity } from '@/hooks/useSwipeSensitivity';
import { usePersistedActiveTab } from '@/hooks/usePersistedActiveTab';
import { useCfoAdvanceDisbursementCount } from '@/hooks/useCfoAdvanceDisbursementCount';
import { CFOApprovalNotificationsBell } from '@/components/cfo/CFOApprovalNotificationsBell';
import { useCfoApprovalAuthority } from '@/hooks/useCfoApprovalAuthority';

// Ordered, swipeable tab ids derived from the CFO sidebar (route items excluded).
const CFO_TAB_SEQUENCE = (executiveSidebarConfig.cfo ?? [])
  .flatMap((section) => section.items)
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
  const advanceDisbursementCount = useCfoAdvanceDisbursementCount();
  const { canApprove: canApproveAsCfo, loading: cfoApprovalLoading } = useCfoApprovalAuthority();

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
      case 'requisitions':
        return <RequisitionsWorkspace manualStage="cfo" />;

      case 'wallet-payout':
        return (
          <div className="space-y-5">
            <DirectCreditTool />

            <RecentApprovalsByCategory />

            {/* ── Security assurance card ── */}
            <div className="rounded-2xl border border-border/60 bg-card p-5 sm:p-6 shadow-sm">
              <div className="flex flex-col sm:flex-row items-center gap-5">
                <div className="flex-1 min-w-0 text-center sm:text-left">
                  <div className="flex items-center justify-center sm:justify-start gap-2 mb-1.5">
                    <ShieldCheck className="h-5 w-5 text-emerald-600 shrink-0" />
                    <h2 className="text-lg font-bold tracking-tight">Secure. Accurate. Instant.</h2>
                  </div>
                  <p className="text-sm text-muted-foreground leading-relaxed max-w-2xl">
                    Every payout is logged, traceable and reconciled against the general ledger, and
                    protected with enterprise-grade security.
                  </p>
                </div>
                <img
                  src={walletSecurityIllustration.url}
                  alt="Secure wallet payout illustration"
                  loading="lazy"
                  className="h-28 w-auto sm:h-32 shrink-0 select-none pointer-events-none"
                />
              </div>
            </div>
          </div>
        );

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
              </div>
            </div>
            <StandingOrdersPanel />
          </div>
        );
      case 'roi-requests':
        return <CFOROIRequests />;
      case 'rent-payouts':
        return (
          <div className="space-y-4">
            <h1 className="text-xl font-bold">💰 Rent Payout Authorization</h1>
            <p className="text-sm text-muted-foreground">
              Approve rent payouts to landlords. Enter the transaction reference to confirm disbursement.
              For landlords without a Rent Money wallet, select "Cash Payout" as the method.
            </p>
            <RentPipelineQueue stage="coo_approved" />
            <RejectedRequestsQueue stageFilter="coo_approved" title="Rejected at CFO" />
          </div>
        );
      case 'statements':
        return <FinancialStatementsPanel />;
      case 'weekly-report':
        return <CFOWeeklyReportPanel />;
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
        return (
          <div className="space-y-4">
            <div>
              <h1 className="text-xl font-bold">🏠 Landlord Payout Float</h1>
              <p className="text-sm text-muted-foreground">
                Fund agents' Landlord Payout Float from COO-approved rent requests.
                Each disbursement earmarks money for a specific tenant's landlord —
                the agent then pays the landlord via MoMo (gated by landlord OTP and Financial Ops sign-off).
              </p>
            </div>
            <CFOAllocationReturnApprovals />
            <RentDisbursementQueue locationProvisionsOnly />
            <PromissoryBookingsPanel />
            <BatchPayoutProcessor />
            <LandlordFloatAllocationsPanel />
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
      case 'unfunding-approvals':
        return (
          <div className="space-y-6">
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
                Applications approved by the COO. Releasing one sends the money into the ordering agent's own wallet and starts daily recovery. Files you have already released stay listed here and open read-only.
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
      case 'advances-analytics':
        return <AdvancesAnalyticsView context="cfo" />;
      case 'advances':
        return (
          <div className="space-y-6">
            <div>
              <h1 className="text-xl font-bold">💵 Advance Requests</h1>
              <p className="text-sm text-muted-foreground">
                Review, edit and approve agent &amp; business advance requests, then disburse in one step.
                Track what&apos;s been disbursed under <strong>Disbursed Advances</strong> and repayments under <strong>Advance Repayments</strong>.
              </p>
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
      case 'advance-repayments':
        return <CFOAdvancesManager />;
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
      case 'employee-requisition-report':
        return <EmployeeRequisitionReportPanel />;
      case 'expense-report':
        return <ExpenseReportPanel />;
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
        return <CFOOverviewDashboard onTabChange={setActiveTab} />;
    }
  };

  return (
    <ExecutiveDashboardLayout
      role="cfo"
      activeTab={activeTab}
      onTabChange={setActiveTab}
      badges={{ advances: advanceDisbursementCount }}
      headerActions={<CFOApprovalNotificationsBell onJump={setActiveTab} />}
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
      {!cfoApprovalLoading && !canApproveAsCfo && (
        <div className="mb-4 rounded-lg border border-amber-500/40 bg-amber-500/10 px-4 py-3">
          <p className="text-sm font-semibold text-amber-800 dark:text-amber-300">
            View only for approvals
          </p>
          <p className="mt-0.5 text-xs text-amber-800/90 dark:text-amber-200/90">
            You can open every report and queue here, but approving, rejecting or releasing a
            request is reserved for the designated CFO approver. Attempts are refused by the
            backend, not just hidden here.
          </p>
        </div>
      )}
      <div {...(isMobile ? swipeHandlers : {})} className="min-h-[60vh]">
        {renderContent()}
      </div>
    </ExecutiveDashboardLayout>
  );
}
