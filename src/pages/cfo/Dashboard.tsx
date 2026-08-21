import { useEffect } from 'react';
import { ArrowLeft } from 'lucide-react';
import { toast } from 'sonner';
import { useCurrency } from '@/hooks/useCurrency';
import { useIsMobile } from '@/hooks/use-mobile';
import { useHorizontalSwipe } from '@/hooks/useHorizontalSwipe';
import { executiveSidebarConfig } from '@/components/layout/executiveSidebarConfig';
import ExecutiveDashboardLayout from '@/components/layout/ExecutiveDashboardLayout';
import { ChannelBalanceTracker } from '@/components/cfo/ChannelBalanceTracker';
import { ErrorCorrectionAuditPanel } from '@/components/cfo/ErrorCorrectionAuditPanel';
import { PlatformVsWalletSummary } from '@/components/cfo/PlatformVsWalletSummary';
import { CFOROIRequests } from '@/components/cfo/CFOROIRequests';
import { CFOOverviewDashboard } from '@/components/cfo/CFOOverviewDashboard';
import { DirectCreditTool } from '@/components/cfo/DirectCreditTool';
import BudgetApprovalPanel from '@/components/cfo/BudgetApprovalPanel';
import { MerchantFloatRequestsPanel } from '@/components/cfo/MerchantFloatRequestsPanel';
import { MerchantFloatRequisitionPanel } from '@/components/financial-ops/MerchantFloatRequisitionPanel';
import { CFOPayoutsShareButton } from '@/components/cfo/CFOPayoutsShareButton';
import { RevenueExpenseDashboard } from '@/components/cfo/RevenueExpenseDashboard';
import RoiDisbursementReportPanel from '@/components/cfo/RoiDisbursementReportPanel';
import RentDisbursementReportPanel from '@/components/cfo/RentDisbursementReportPanel';
import MerchantFloatRequisitionReportPanel from '@/components/cfo/MerchantFloatRequisitionReportPanel';
import ExpenseReportPanel from '@/components/cfo/ExpenseReportPanel';
import CFOWeeklyReportPanel from '@/components/cfo/CFOWeeklyReportPanel';
import { CashflowForecastGraphs } from '@/components/cfo/CashflowForecastGraphs';
import { DirectorRequisitionsPanel } from '@/components/requisitions/DirectorRequisitionsPanel';

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
import { AgentPerformanceRankings } from '@/components/cfo/AgentPerformanceRankings';
import { AgentFloatManagement } from '@/components/cfo/AgentFloatManagement';
import { LedgerHealthPanel } from '@/components/cfo/LedgerHealthPanel';
import { FieldCashExposureCard } from '@/components/cfo/FieldCashExposureCard';
import { CFOAgentOpsFloatSender } from '@/components/cfo/CFOAgentOpsFloatSender';
import { CFOImpactKPIStrip } from '@/components/cfo/CFOImpactKPIStrip';
import { CFOWalletActivities } from '@/components/cfo/CFOWalletActivities';
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
        return <DirectorRequisitionsPanel />;
      case 'wallet-payout':
        return (
          <div className="space-y-4">
            <div className="rounded-xl border-2 border-primary/30 bg-primary/5 p-4">
              <button onClick={() => setActiveTab('overview')} className="flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground mb-3 transition-colors">
                <ArrowLeft className="h-4 w-4" />
                Back to Treasury
              </button>
              <div className="flex items-start justify-between gap-2 flex-wrap mb-1">
                <h1 className="text-xl font-bold flex items-center gap-2">💳 Pay Out to Any User's Wallet</h1>
                <CFOPayoutsShareButton />
              </div>
              <p className="text-sm text-muted-foreground mb-4">Search a user by name or phone number, enter the amount, and credit or debit their wallet instantly. Use “Share Payouts PDF” to send a list of everyone you've paid out via WhatsApp.</p>
              <DirectCreditTool />
            </div>
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
      case 'advances-analytics':
        return <AdvancesAnalyticsView context="cfo" />;
      case 'advances':
        return (
          <div className="space-y-6">
            <div>
              <h1 className="text-xl font-bold">💵 Advance Requests</h1>
              <p className="text-sm text-muted-foreground">
                Review, edit and approve agent &amp; business advance requests, then disburse in one step.
                Track what&apos;s been disbursed under <strong>Disbursed &amp; Repayments</strong>.
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
              <h1 className="text-xl font-bold">📋 Disbursed &amp; Repayments</h1>
              <p className="text-sm text-muted-foreground">
                Every disbursed advance and its repayment progress. Use this to track outstanding balances and recoveries.
              </p>
            </div>
            <div id="cfo-disbursed-advances" className="scroll-mt-24">
              <DisbursedAdvancesRegister />
            </div>
            <CFOAdvancesManager />
          </div>
        );
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
      <div {...(isMobile ? swipeHandlers : {})} className="min-h-[60vh]">
        {renderContent()}
      </div>
    </ExecutiveDashboardLayout>
  );
}
