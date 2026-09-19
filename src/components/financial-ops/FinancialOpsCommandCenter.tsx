import { Component, useEffect, useState, lazy, Suspense, type ComponentType, type ReactNode } from 'react';
// Eagerly imported: only what's needed on the Home view.
import { WalletOverviewCard } from './WalletOverviewCard';
import { MomoFeedSilenceAlert } from './MomoFeedSilenceAlert';
import { IftttDiagnosticsPanel } from './IftttDiagnosticsPanel';
import { MerchantPhoneChecklist } from './MerchantPhoneChecklist';
import { PhoneMoneyCard } from './PhoneMoneyCard';
import { MoneyWithAgentsCard } from './MoneyWithAgentsCard';
import { MerchantAgentFloatAllocationPanel } from './MerchantAgentFloatAllocationPanel';
import { MerchantBalanceDisputesPanel } from './MerchantBalanceDisputesPanel';
import { PhonePlatformReconciliationCard } from './PhonePlatformReconciliationCard';
import { AutoCreditSuccessRateTile } from './AutoCreditSuccessRateTile';

// Everything below is code-split — a panel's JS is only fetched when its
// tool/view is opened. Keeps /admin/financial-ops first paint fast.
const lz = (
  loader: () => Promise<Record<string, any>>,
  name: string,
): ComponentType<any> => lazy(async () => {
  // A stale/aborted chunk fetch can resolve to an undefined module namespace
  // (seen on mobile after a redeploy). Retry once before failing, and accept
  // either the named export or a default export.
  let m: Record<string, any> | undefined;
  try {
    m = await loader();
  } catch {
    m = undefined;
  }
  let C = m?.[name] ?? m?.default;
  if (!C) {
    m = await loader();
    C = m?.[name] ?? m?.default;
  }
  if (!C) throw new Error(`Panel "${name}" failed to load. Please reload the app.`);
  return { default: C };
}) as unknown as ComponentType<any>;

const PanelFallback = () => (
  <div className="flex items-center justify-center py-12 text-sm text-muted-foreground">
    Loading…
  </div>
);

/**
 * Local boundary for a single tool panel.
 *
 * Without this, a failed lazy chunk (stale cache, flaky mobile connection) or a
 * render error inside a panel bubbles to the app-level boundary, which remounts
 * this command centre — silently resetting `activeTool` and dumping the operator
 * back on Overview with no explanation. Keeping the failure local shows the real
 * reason and offers a retry that re-attempts the chunk.
 */
class ToolErrorBoundary extends Component<
  { toolKey: string; children: ReactNode },
  { message: string | null }
> {
  state = { message: null as string | null };

  static getDerivedStateFromError(err: Error) {
    return { message: err?.message || 'Unknown error' };
  }

  componentDidCatch(err: Error) {
    // A user running an outdated cached bundle sees failures like
    // `can't access property "XPanel" of undefined` (old loader) or chunk
    // import errors. Recover automatically once per session, then stop so we
    // never loop.
    const msg = err?.message || '';
    const stale =
      /of undefined|chunk|dynamically imported module|Importing a module script failed|failed to load/i.test(
        msg,
      );
    if (!stale) return;
    try {
      if (sessionStorage.getItem('finops-panel-recovered') === '1') return;
      sessionStorage.setItem('finops-panel-recovered', '1');
    } catch {
      return;
    }
    window.location.reload();
  }

  componentDidUpdate(prev: { toolKey: string }) {
    if (prev.toolKey !== this.props.toolKey && this.state.message) {
      this.setState({ message: null });
    }
  }

  render() {
    if (this.state.message) {
      const chunky = /chunk|dynamically imported module|Importing a module script failed/i.test(
        this.state.message,
      );
      return (
        <div className="rounded-xl border border-destructive/30 bg-destructive/5 p-4 space-y-3">
          <p className="text-sm font-semibold text-foreground">
            This panel could not be opened
          </p>
          <p className="text-xs text-muted-foreground break-words">
            {chunky
              ? 'The panel could not be downloaded — usually an outdated cached version of the app or a dropped connection.'
              : this.state.message}
          </p>
          <div className="flex flex-wrap gap-2">
            <button
              onClick={() => this.setState({ message: null })}
              className="h-9 px-3 rounded-md bg-primary text-primary-foreground text-xs font-semibold"
            >
              Try again
            </button>
            <button
              onClick={() => window.location.reload()}
              className="h-9 px-3 rounded-md border border-border text-xs font-semibold"
            >
              Reload the app
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

const ApprovalQueue = lz(() => import('./ApprovalQueue'), 'ApprovalQueue');
const TransactionSearch = lz(() => import('./TransactionSearch'), 'TransactionSearch');
const ReconciliationDashboard = lz(() => import('./ReconciliationDashboard'), 'ReconciliationDashboard');
const PayoutReconciliationQueue = lz(() => import('./PayoutReconciliationQueue'), 'PayoutReconciliationQueue');
const MerchantFloatTruthPanel = lz(() => import('./MerchantFloatTruthPanel'), 'MerchantFloatTruthPanel');
const AuditFeed = lz(() => import('./AuditFeed'), 'AuditFeed');
const ScaleDashboard = lz(() => import('./ScaleDashboard'), 'ScaleDashboard');
const FinOpsWithdrawalVerification = lz(() => import('./FinOpsWithdrawalVerification'), 'FinOpsWithdrawalVerification');
const EmailPayoutAutoMatchPanel = lz(() => import('./EmailPayoutAutoMatchPanel'), 'EmailPayoutAutoMatchPanel');
const LandlordPayoutsQueue = lz(() => import('./LandlordPayoutsQueue'), 'LandlordPayoutsQueue');
const LedgerHub = lz(() => import('@/components/ledgers/LedgerHub'), 'LedgerHub');
const PendingWalletOperationsWidget = lz(() => import('@/components/manager/PendingWalletOperationsWidget'), 'PendingWalletOperationsWidget');
const OfflineSubmissionsQueue = lz(() => import('./OfflineSubmissionsQueue'), 'OfflineSubmissionsQueue');
const VerifyDepositsHub = lz(() => import('./VerifyDepositsHub'), 'VerifyDepositsHub');
const MismatchMetricsPanel = lz(() => import('./MismatchMetricsPanel'), 'MismatchMetricsPanel');
const ReconciliationReviewScreen = lz(() => import('./ReconciliationReviewScreen'), 'ReconciliationReviewScreen');
const WithdrawalHistoryStatement = lz(() => import('./WithdrawalHistoryStatement'), 'WithdrawalHistoryStatement');
const PortfolioTopUpVerification = lz(() => import('./PortfolioTopUpVerification'), 'PortfolioTopUpVerification');
const PartnershipTopupAuditLog = lz(() => import('./PartnershipTopupAuditLog'), 'PartnershipTopupAuditLog');
const WalletBucketsPanel = lz(() => import('./WalletBucketsPanel'), 'WalletBucketsPanel');
const WalletBreakdownReadOnly = lz(() => import('./WalletBreakdownReadOnly'), 'WalletBreakdownReadOnly');
const FinOpsWalletMovePanel = lz(() => import('./FinOpsWalletMovePanel'), 'FinOpsWalletMovePanel');
const EmailTransactionsPanel = lz(() => import('./EmailTransactionsPanel'), 'EmailTransactionsPanel');
const BulkBankPayoutPanel = lz(() => import('./BulkBankPayoutPanel'), 'BulkBankPayoutPanel');
const FundedTenantsList = lz(() => import('./FundedTenantsList'), 'FundedTenantsList');
const AutoCreditReviewPanel = lz(() => import('./AutoCreditReviewPanel'), 'AutoCreditReviewPanel');
const ProxyWithdrawalDiagnosticsPanel = lz(() => import('./ProxyWithdrawalDiagnosticsPanel'), 'ProxyWithdrawalDiagnosticsPanel');
const FloatToWithdrawablePanel = lz(() => import('./FloatToWithdrawablePanel'), 'FloatToWithdrawablePanel');
const MomoSignupSmsTemplatePanel = lz(() => import('./MomoSignupSmsTemplatePanel'), 'MomoSignupSmsTemplatePanel');
const CashDepositCodesPanel = lz(() => import('./CashDepositCodesPanel'), 'CashDepositCodesPanel');
const ManualFloatCreditPanel = lz(() => import('./ManualFloatCreditPanel'), 'ManualFloatCreditPanel');
const UserWalletStatementsPanel = lz(() => import('./UserWalletStatementsPanel'), 'UserWalletStatementsPanel');
const WithdrawalNotificationLogPanel = lz(() => import('./WithdrawalNotificationLogPanel'), 'WithdrawalNotificationLogPanel');
const SmsDeliveryLogPanel = lz(() => import('./SmsDeliveryLogPanel'), 'SmsDeliveryLogPanel');
const CashoutSettlementTimeline = lz(() => import('./CashoutSettlementTimeline'), 'CashoutSettlementTimeline');
const MerchantClaimsLog = lz(() => import('./MerchantClaimsLog'), 'MerchantClaimsLog');
const CashoutAgentManager = lz(() => import('@/components/cfo/CashoutAgentManager'), 'CashoutAgentManager');
const MerchantFloatRequestsPanel = lz(() => import('@/components/cfo/MerchantFloatRequestsPanel'), 'MerchantFloatRequestsPanel');
const MerchantFloatRequisitionPanel = lz(() => import('./MerchantFloatRequisitionPanel'), 'MerchantFloatRequisitionPanel');
const ReceiptArchivePanel = lz(() => import('@/components/shared/ReceiptArchivePanel'), 'ReceiptArchivePanel');
const EarningsExplainer = lz(() => import('@/components/shared/EarningsExplainer'), 'EarningsExplainer');
const DepositBridgeHealthPanel = lz(() => import('@/components/bridge/DepositBridgeHealthPanel'), 'DepositBridgeHealthPanel');
const OpportunitySummaryForm = lz(() => import('@/components/manager/OpportunitySummaryForm'), 'OpportunitySummaryForm');
const AgentRequisitionForm = lz(() => import('./AgentRequisitionForm'), 'AgentRequisitionForm');
const EmployeeRequisitionLinksPanel = lz(() => import('./EmployeeRequisitionLinksPanel'), 'EmployeeRequisitionLinksPanel');
const ManualRequisitionQueuePanel = lz(() => import('./ManualRequisitionQueuePanel'), 'ManualRequisitionQueuePanel');
const FinancialOpsPulseStrip = lz(() => import('./FinancialOpsPulseStrip'), 'FinancialOpsPulseStrip');
const LiquidityForecastPanel = lz(() => import('./LiquidityForecastPanel'), 'LiquidityForecastPanel');
const DailyWalletReportsPanel = lz(() => import('./DailyWalletReportsPanel'), 'DailyWalletReportsPanel');
const StaleWithdrawalHoldsPanel = lz(() => import('@/components/cfo/StaleWithdrawalHoldsPanel'), 'StaleWithdrawalHoldsPanel');
const PayoutVerificationPanel = lazy(() => import('./PayoutVerificationPanel'));
const UnverifiedWithdrawalsPanel = lazy(() => import('./UnverifiedWithdrawalsPanel'));
const PayoutVerificationCallout = lazy(() => import('./PayoutVerificationCallout'));
import { 
  ShieldCheck, ShieldAlert, Banknote, ArrowLeft, ChevronDown, ChevronUp, ChevronRight, Menu, X,
  ClipboardList, Search, Scale, Shield, Gauge, BookOpen, TrendingUp, FileText,
  WifiOff, MoreHorizontal, AlertTriangle, AlertCircle, ScanLine, Receipt, Mail, Home as HomeIcon,
  ArrowRightLeft, ScrollText, KeyRound, ReceiptText
  , Bell, HandCoins, MessageSquare
  , Store, Archive, Activity, CheckCircle2, Sparkles, PanelLeftClose, PanelLeftOpen, Wallet, CalendarClock,
  Smartphone
} from 'lucide-react';
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from '@/components/ui/sheet';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';

type View = 'home' | 'deposits' | 'offline_collections';
type Tool =
  | null
  | 'ops' | 'queue' | 'search' | 'recon' | 'ledgers' | 'audit'
  | 'withdrawals' | 'opportunities' | 'requisitions'
  | 'mismatch_metrics' | 'recon_review' | 'withdrawal_history' | 'wallet_breakdown'
  | 'email_tx' | 'funded_tenants' | 'auto_credit_review' | 'proxy_diagnostics'
  | 'topup_audit'
  | 'float_to_withdrawable' | 'momo_sms_template' | 'cash_codes' | 'user_statements'
  | 'withdrawal_notif_log' | 'cashout_settlement' | 'merchant_claims' | 'sms_delivery_log'
  | 'merchant_agents' | 'merchant_float' | 'merchant_float_requisition' | 'merchant_float_allocation' | 'receipt_archive'
  | 'employee_requisition_links' | 'employee_requisition_queue'
  | 'bridge_health' | 'manual_float_credit'
  | 'earnings_explainer'
  | 'liquidity_forecast'
  | 'reports'
  | 'stale_withdrawal_holds'
  | 'wallet_buckets'
  | 'payout_verification'
  | 'unverified_withdrawals';
// Extend Tool type via union above; add new tools:


/**
 * Items hidden behind the "More" button. Per CFO mandate the dashboard
 * surfaces ONLY the two most-used actions (Verify Deposits, Withdrawals)
 * and tucks the rest in here so the home view stays minimalist.
 */
type MoreAction =
  | { kind: 'tool'; id: Exclude<Tool, null>; label: string; desc: string; icon: typeof Gauge }
  | { kind: 'view'; id: Exclude<View, 'home'>; label: string; desc: string; icon: typeof Gauge };

const moreActions: MoreAction[] = [
  { kind: 'tool', id: 'payout_verification', label: 'Verify Payout Numbers', desc: 'Call each holder and confirm the mobile money number or bank account is theirs and matches their National ID. Nobody is paid until you verify.', icon: ShieldCheck },
  { kind: 'tool', id: 'unverified_withdrawals', label: 'Unverified Withdrawals', desc: 'Open withdrawal requests hidden from merchant agents because the owner has not finished ID verification — call them and help them verify.', icon: ShieldAlert },
  { kind: 'tool', id: 'liquidity_forecast', label: 'Liquidity Forecast', desc: 'Withdrawable across all wallets today + ROI due per day for the next 7–60 days, so you can pre-fund before payouts.', icon: CalendarClock },
  { kind: 'tool', id: 'reports', label: 'Reports', desc: 'Daily Wallet Financial Summary Reports — auto-generated at 00:00 EAT from the ledger. View, filter, regenerate & download PDF/Excel/CSV.', icon: FileText },
  { kind: 'tool', id: 'earnings_explainer', label: 'How Did They Earn?', desc: 'Plain-English breakdown of every UGX that landed in a user\u2019s wallet — grouped by source (commissions, deposits, ROI, payroll, corrections) with counts and samples.', icon: Sparkles },
  { kind: 'tool', id: 'bridge_health', label: 'Deposit Bridge Health', desc: 'Reliability of the queue between Financial Ops and the wallet ledger — pending, retries, DLQ, gap alerts', icon: Activity },
  { kind: 'tool', id: 'manual_float_credit', label: 'Manual Float Credit', desc: 'Credit an agent\u2019s float wallet from a MoMo SMS — TID, amount, date/time & depositor. TID is locked so late feeds cannot double-credit.', icon: Wallet },
  { kind: 'tool', id: 'receipt_archive', label: 'Receipt Archive', desc: 'Permanent record of every payout receipt — searchable, one URL per receipt', icon: Archive },
  { kind: 'tool', id: 'merchant_agents', label: 'Merchant Agents', desc: 'Manage cash-out (merchant) agents — same module as the CFO Dashboard', icon: Store },
  { kind: 'tool', id: 'merchant_float', label: 'Merchant Float', desc: 'Fund or reject merchant agent operational float requests', icon: HandCoins },
  { kind: 'tool', id: 'merchant_float_requisition', label: 'Merchant Float Requisition', desc: 'Raise a merchant float funding requisition and send it to the CFO for approval', icon: HandCoins },
  { kind: 'tool', id: 'merchant_float_allocation', label: 'Float Allocation Report', desc: 'Rank merchant agents by measured withdrawal reliability & float efficiency — who to give more float, who to cut back', icon: TrendingUp },
  { kind: 'tool', id: 'user_statements', label: 'User Wallet Statements', desc: 'Search a user — see withdrawable, float, landlord float & advance statements + full profile', icon: ReceiptText },
  { kind: 'tool', id: 'wallet_buckets', label: 'Wallet Buckets', desc: 'Withdrawable, float & advance bucket balances per wallet — spot drift and open the bucket ledger', icon: Wallet },
  { kind: 'tool', id: 'email_tx', label: 'Email Transactions', desc: 'Live transactions extracted from connected Gmail', icon: Mail },
  { kind: 'tool', id: 'auto_credit_review', label: 'Auto-Credit Review', desc: 'Confirm or reverse best-guess auto-credited deposits', icon: AlertTriangle },
  { kind: 'view', id: 'offline_collections', label: 'Offline Collections', desc: 'Drafts agents submitted with proof', icon: WifiOff },
  { kind: 'view', id: 'deposits', label: 'User Deposits', desc: 'Live queue of every pending user deposit request (TID, name, phone, amount) plus Gmail-matched verification', icon: ReceiptText },
  { kind: 'tool', id: 'funded_tenants', label: 'Funded Landlords & Tenants', desc: 'Tenants whose landlords have been paid — share to agent on WhatsApp', icon: HomeIcon },
  { kind: 'tool', id: 'stale_withdrawal_holds', label: 'Stale Withdrawal Holds', desc: 'Withdrawal requests stuck without a payout or rejection — each one hides a user’s real balance until it’s settled or cancelled.', icon: AlertTriangle },
  { kind: 'tool', id: 'withdrawal_history', label: 'Withdrawal History', desc: 'Statement of every withdrawal — balance before & after', icon: Receipt },
  { kind: 'tool', id: 'withdrawal_notif_log', label: 'Withdrawal Notification Log', desc: 'Every merchant withdrawal-alert email — search by recipient, amount & date', icon: Bell },
  { kind: 'tool', id: 'sms_delivery_log', label: 'SMS Delivery Log', desc: 'Delivery-status audit of every claim & payout SMS — provider response, retries & failures', icon: MessageSquare },
  { kind: 'tool', id: 'cashout_settlement', label: 'Cash-Out Settlement Timeline', desc: 'Each withdrawal with the merchant principal reimbursement & 0.5% commission in one ledger trail', icon: ArrowRightLeft },
  { kind: 'tool', id: 'topup_audit', label: 'Top-Up Audit Log', desc: 'Each partnership top-up: fund source, recipient routing & both ledger legs', icon: ScrollText },
  { kind: 'tool', id: 'ledgers', label: 'Ledger', desc: 'Full record of all wallet activity', icon: BookOpen },
  { kind: 'tool', id: 'ops', label: 'Ops Center', desc: 'Automation & monitoring', icon: Gauge },
  { kind: 'tool', id: 'queue', label: 'Approval Queue', desc: 'Pending approvals', icon: ClipboardList },
  { kind: 'tool', id: 'search', label: 'Transaction Search', desc: 'Find any transaction', icon: Search },
  { kind: 'tool', id: 'recon', label: 'Reconciliation', desc: 'Wallet-ledger drift', icon: Scale },
  { kind: 'tool', id: 'recon_review', label: 'Reconciliation Review', desc: 'Match receipts/refs — see what failed and why', icon: ScanLine },
  { kind: 'tool', id: 'audit', label: 'Audit Trail', desc: 'Action history', icon: Shield },
  { kind: 'tool', id: 'opportunities', label: 'Capital Opportunities', desc: 'Investment summaries', icon: TrendingUp },
  { kind: 'tool', id: 'requisitions', label: 'Fund Requisitions', desc: 'Agent fund requests', icon: FileText },
  { kind: 'tool', id: 'employee_requisition_queue', label: 'Manual Requisition Review', desc: 'Review shareable-link requisitions through COO and CFO approval stages', icon: ClipboardList },
  { kind: 'tool', id: 'employee_requisition_links', label: 'Manual Requisition Links', desc: 'Generate and share secure links for requisitions outside My Space', icon: FileText },
  { kind: 'tool', id: 'mismatch_metrics', label: 'Mismatch Metrics', desc: 'Operator provider-mismatch attempts', icon: AlertTriangle },
  { kind: 'tool', id: 'proxy_diagnostics', label: 'Proxy Withdrawal Diagnostics', desc: 'Why each pending proxy withdrawal isn\u2019t auto-settling', icon: AlertCircle },
  { kind: 'tool', id: 'float_to_withdrawable', label: 'Float \u2192 Withdrawable', desc: 'Reclassify a user\u2019s Operational Float into their Withdrawable balance', icon: ArrowRightLeft },
  { kind: 'tool', id: 'momo_sms_template', label: 'MoMo Thank-You SMS', desc: 'Edit the thank-you + signup SMS sent to MTN/Airtel senders', icon: Mail },
];

import { useAuth } from '@/hooks/useAuth';
import { useSearchParams } from 'react-router-dom';

const WALLET_BREAKDOWN_KEY = 'finops_wallet_breakdown_open_v2';
const IFTTT_DIAGNOSTICS_KEY = 'finops_ifttt_diagnostics_open_v1';
const MERCHANT_PHONE_CHECKLIST_KEY = 'finops_merchant_phone_checklist_open_v1';

function getStoredAccordionOpen(key: string, userId?: string): boolean {
  if (typeof window === 'undefined' || !userId) return false;
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return false;
    const map = JSON.parse(raw) as Record<string, boolean>;
    return !!map[userId];
  } catch {
    return false;
  }
}

function setStoredAccordionOpen(key: string, userId: string, open: boolean) {
  if (typeof window === 'undefined' || !userId) return;
  try {
    const raw = localStorage.getItem(key);
    const map = raw ? (JSON.parse(raw) as Record<string, boolean>) : {};
    map[userId] = open;
    localStorage.setItem(key, JSON.stringify(map));
  } catch { /* noop */ }
}

const getStoredOpen = (userId?: string) => getStoredAccordionOpen(WALLET_BREAKDOWN_KEY, userId);
const setStoredOpen = (userId: string, open: boolean) => setStoredAccordionOpen(WALLET_BREAKDOWN_KEY, userId, open);

export function FinancialOpsCommandCenter({ requirePaymentRef }: { requirePaymentRef?: boolean } = {}) {
  const { user } = useAuth();
  const userId = user?.id;
  // The URL is the single source of truth for which panel is open.
  //
  // Previously this lived in component state with a sessionStorage backup. On
  // devices where sessionStorage is unavailable (iOS private browsing, some
  // in-app/embedded browsers, storage-partitioned WebViews) any remount — a
  // recovered error, a failed chunk, a pull-to-refresh reload — silently reset
  // the state and dumped the operator back on Overview, which reads exactly
  // like "navigation is disabled on my account". Query params survive all of
  // those, need no storage permission, and make panels linkable.
  const [searchParams, setSearchParams] = useSearchParams();
  const activeTool = (searchParams.get('tool') as Tool) || null;
  const view = ((searchParams.get('view') as View) || 'home') as View;

  const setActiveTool = (t: Tool) => {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      if (t) next.set('tool', String(t));
      else next.delete('tool');
      next.delete('view');
      return next;
    }, { replace: true });
  };

  const setView = (v: View) => {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      next.delete('tool');
      if (v && v !== 'home') next.set('view', v);
      else next.delete('view');
      return next;
    }, { replace: true });
  };
  const [moreSheet, setMoreSheet] = useState(false);
  const [mobileDrawerOpen, setMobileDrawerOpen] = useState(false);
  const [focusBucket, setFocusBucket] = useState<'float' | 'withdrawable' | null>(null);
  const [walletBreakdownOpen, setWalletBreakdownOpen] = useState(() => getStoredOpen(userId));
  const [iftttDiagnosticsOpen, setIftttDiagnosticsOpen] = useState(() => getStoredAccordionOpen(IFTTT_DIAGNOSTICS_KEY, userId));
  const [merchantChecklistOpen, setMerchantChecklistOpen] = useState(() => getStoredAccordionOpen(MERCHANT_PHONE_CHECKLIST_KEY, userId));
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => {
    if (typeof window === 'undefined') return false;
    return localStorage.getItem('finops_sidebar_collapsed') === '1';
  });
  useEffect(() => {
    if (typeof window !== 'undefined') {
      localStorage.setItem('finops_sidebar_collapsed', sidebarCollapsed ? '1' : '0');
    }
  }, [sidebarCollapsed]);

  const openTool = (t: Tool) => {
    setActiveTool(t);
    setMoreSheet(false);
    setMobileDrawerOpen(false);
  };

  // Navigation scroll handling — whenever we switch into a tool or sub-view,
  // reset scroll to the top so the target view (e.g. Merchant Claims) is fully
  // visible and never left behind a floating widget or half-scrolled overlay.
  useEffect(() => {
    if (typeof window !== 'undefined') {
      window.scrollTo({ top: 0, behavior: 'auto' });
    }
  }, [activeTool, view]);

  // Persist expand/collapse per user across sessions
  useEffect(() => {
    if (userId) setStoredOpen(userId, walletBreakdownOpen);
  }, [walletBreakdownOpen, userId]);

  useEffect(() => {
    if (userId) setStoredAccordionOpen(IFTTT_DIAGNOSTICS_KEY, userId, iftttDiagnosticsOpen);
  }, [iftttDiagnosticsOpen, userId]);

  useEffect(() => {
    if (userId) setStoredAccordionOpen(MERCHANT_PHONE_CHECKLIST_KEY, userId, merchantChecklistOpen);
  }, [merchantChecklistOpen, userId]);

  const openMoreAction = (a: MoreAction) => {
    if (a.kind === 'tool') {
      openTool(a.id);
    } else {
      setView(a.id);
      setMoreSheet(false);
      setMobileDrawerOpen(false);
    }
  };

  // Shared back button — bigger tap target, consistent label & spacing.
  const SubBack = ({ onClick }: { onClick: () => void }) => (
    <button
      onClick={onClick}
      className="inline-flex items-center gap-2 text-sm font-medium text-muted-foreground hover:text-foreground transition-colors h-10 -ml-2 px-2 rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
    >
      <ArrowLeft className="h-4 w-4" /> Back to Financial Ops
    </button>
  );

  // Sub-view: Verify Deposits (unified — user TIDs + field/agent cash)
  let content: JSX.Element;
  if (view === 'deposits') {
    content = (
      <div className="space-y-5">
        <SubBack onClick={() => setView('home')} />
        <Suspense fallback={<PanelFallback />}> <VerifyDepositsHub /> </Suspense>
      </div>
    );
  } else if (view === 'offline_collections') {
    content = (
      <div className="space-y-5">
        <SubBack onClick={() => setView('home')} />
        <Suspense fallback={<PanelFallback />}> <OfflineSubmissionsQueue /> </Suspense>
      </div>
    );
  } else if (activeTool) {
    content = (
      <div className="space-y-5 pb-24 sm:pb-16">
        <SubBack onClick={() => setActiveTool(null)} />
        <ToolErrorBoundary toolKey={String(activeTool)}>
        <Suspense fallback={<PanelFallback />}>
        {activeTool === 'ops' && <ScaleDashboard />}
        {activeTool === 'email_tx' && <EmailTransactionsPanel />}
        {activeTool === 'auto_credit_review' && <AutoCreditReviewPanel />}
        {activeTool === 'queue' && <ApprovalQueue />}
        {activeTool === 'search' && <TransactionSearch />}
        {activeTool === 'recon' && (
          <div className="space-y-6">
            {/* 7-day cash flow context for the operator. */}
            <ReconciliationDashboard />
            <div className="mt-6 pt-6 border-t border-border space-y-2">
              <h3 className="text-base sm:text-lg font-bold text-foreground">
                Payout Discrepancy & Ledger Gap Queue
              </h3>
              <p className="text-xs text-muted-foreground mb-4">
                Completed payouts where customer deductions or settlement legs require reconciliation.
              </p>
              <PayoutReconciliationQueue />
            </div>
          </div>
        )}
        {activeTool === 'recon_review' && (
          <ReconciliationReviewScreen
            onCreateNewAllocation={() => setView('deposits')}
          />
        )}
        {activeTool === 'wallet_buckets' && (
          <WalletBucketsPanel onOpenTool={(t) => setActiveTool(t as any)} />
        )}
        {activeTool === 'wallet_breakdown' && (
          <div className="space-y-8">
            <FinOpsWalletMovePanel />
            <WalletBreakdownReadOnly />
          </div>
        )}
        {activeTool === 'ledgers' && <LedgerHub />}
        {activeTool === 'audit' && <AuditFeed />}
        {activeTool === 'withdrawals' && (
          <>
            <div>
              <h2 className="text-xl sm:text-2xl font-bold flex items-center gap-2.5">
                <Banknote className="h-6 w-6 text-destructive" />
                Withdrawals & Payouts
              </h2>
              <p className="text-sm text-muted-foreground mt-1">
                Cash-out requests waiting for a decision.
              </p>
            </div>
            {/* Core withdrawal verification queue given first priority and breathing space */}
            <FinOpsWithdrawalVerification />
            <LandlordPayoutsQueue />
            {/* PHASE 10: stored merchant float vs ledger-derived float */}
            <MerchantFloatTruthPanel />
            <EmailPayoutAutoMatchPanel />
            <BulkBankPayoutPanel />
            <PendingWalletOperationsWidget requirePaymentRef={requirePaymentRef} />
            {/* Portfolio top-ups parked at status='awaiting_verification' */}
            <div>
              <h3 className="text-base sm:text-lg font-bold mt-4 mb-2">
                Portfolio Top-Ups Awaiting Verification
              </h3>
              <PortfolioTopUpVerification />
            </div>
          </>
        )}
        {activeTool === 'opportunities' && (
          <OpportunitySummaryForm onClose={() => setActiveTool(null)} />
        )}
        {activeTool === 'requisitions' && (
          <div className="max-w-2xl w-full">
            <AgentRequisitionForm />
          </div>
        )}
        {activeTool === 'employee_requisition_links' && (
          <div className="space-y-2">
            <h2 className="text-lg font-bold">Employee Requisition Links</h2>
            <p className="text-sm text-muted-foreground">
              Generate secure links for requisitions outside My Space. Each submission starts with COO review and then moves to CFO for final approval.
            </p>
            <EmployeeRequisitionLinksPanel />
          </div>
        )}
        {activeTool === 'employee_requisition_queue' && (
          <div className="space-y-2">
            <h2 className="text-lg font-bold">Manual Requisition Review</h2>
            <p className="text-sm text-muted-foreground">
              Manual-link submissions move from COO review to CFO final approval. CFO approval is the only stage that can credit a wallet.
            </p>
            <ManualRequisitionQueuePanel stage="cfo" />
          </div>
        )}
        {activeTool === 'mismatch_metrics' && <MismatchMetricsPanel />}
        {activeTool === 'bridge_health' && <DepositBridgeHealthPanel />}
        {activeTool === 'payout_verification' && <PayoutVerificationPanel />}
        {activeTool === 'unverified_withdrawals' && <UnverifiedWithdrawalsPanel />}
        {activeTool === 'stale_withdrawal_holds' && <StaleWithdrawalHoldsPanel />}
        {activeTool === 'withdrawal_history' && <WithdrawalHistoryStatement />}
        {activeTool === 'funded_tenants' && <FundedTenantsList />}
        {activeTool === 'proxy_diagnostics' && <ProxyWithdrawalDiagnosticsPanel />}
        {activeTool === 'float_to_withdrawable' && <FloatToWithdrawablePanel />}
        {activeTool === 'topup_audit' && <PartnershipTopupAuditLog />}
        {activeTool === 'momo_sms_template' && <MomoSignupSmsTemplatePanel />}
        {activeTool === 'cash_codes' && (
          <CashDepositCodesPanel fullScreen onClose={() => setActiveTool(null)} />
        )}
        {activeTool === 'manual_float_credit' && <ManualFloatCreditPanel />}
        {activeTool === 'user_statements' && <UserWalletStatementsPanel />}
        {activeTool === 'earnings_explainer' && <EarningsExplainer role="finops" />}
        {activeTool === 'liquidity_forecast' && <LiquidityForecastPanel onOpenTool={(t) => setActiveTool(t as any)} />}
        {activeTool === 'reports' && <DailyWalletReportsPanel />}
        {activeTool === 'withdrawal_notif_log' && <WithdrawalNotificationLogPanel />}
        {activeTool === 'sms_delivery_log' && <SmsDeliveryLogPanel />}
        {activeTool === 'cashout_settlement' && <CashoutSettlementTimeline />}
        {activeTool === 'merchant_claims' && <MerchantClaimsLog />}
        {activeTool === 'merchant_agents' && <CashoutAgentManager />}
        {activeTool === 'receipt_archive' && <ReceiptArchivePanel />}
        {activeTool === 'merchant_float' && (
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
        )}
        {activeTool === 'merchant_float_requisition' && <MerchantFloatRequisitionPanel mode="finops" />}
        {activeTool === 'merchant_float_allocation' && <MerchantAgentFloatAllocationPanel />}
        </Suspense>
        </ToolErrorBoundary>
      </div>
    );
  } else {
    content = (
      <FinOpsHome
        onView={setView}
        onOpenTool={openTool}
        onOpenMore={() => setMoreSheet(true)}
        onFocusBucket={setFocusBucket}
        walletBreakdownOpen={walletBreakdownOpen}
        setWalletBreakdownOpen={(v) => {
          setWalletBreakdownOpen(v);
          if (userId) setStoredOpen(userId, v);
        }}
        focusBucket={focusBucket}
        onClearFocus={() => setFocusBucket(null)}
        moreSheet={moreSheet}
        setMoreSheet={setMoreSheet}
        openMoreAction={openMoreAction}
        onOpenMobileDrawer={() => setMobileDrawerOpen(true)}
      />
    );
  }

  const activeId: string | null = activeTool ?? (view !== 'home' ? view : null);

  // Email Transactions is opened as a full-screen workspace that covers the
  // Financial Ops sidebar/menu so the operator has the whole laptop or
  // smartphone screen for the inbox-style list.
  const emailTxFullscreen = activeTool === 'email_tx';

  // Consolidated 4-tier sidebar structure for fast, intuitive scanning.
  const sidebarGroups: { title: string; items: MoreAction[] }[] = [
    {
      title: 'Daily Operations',
      items: moreActions.filter(a => [
        'payout_verification', 'unverified_withdrawals', 'email_tx', 'deposits', 'stale_withdrawal_holds', 'cash_codes', 'auto_credit_review', 'merchant_float'
      ].includes(a.id as string)),
    },
    {
      title: 'Balances & Reconciliation',
      items: moreActions.filter(a => [
        'wallet_buckets', 'recon', 'recon_review', 'mismatch_metrics', 'reports', 'liquidity_forecast', 'float_to_withdrawable'
      ].includes(a.id as string)),
    },
    {
      title: 'Merchant Network & Cash-Out',
      items: moreActions.filter(a => [
        'merchant_agents', 'cashout_settlement', 'merchant_claims', 'merchant_float_allocation', 'merchant_float_requisition',
        'withdrawal_history', 'withdrawal_notif_log', 'proxy_diagnostics'
      ].includes(a.id as string)),
    },
    {
      title: 'Ledger & Audit',
      items: moreActions.filter(a => [
        'ledgers', 'audit', 'topup_audit', 'sms_delivery_log', 'user_statements', 'receipt_archive',
        'earnings_explainer', 'bridge_health', 'manual_float_credit', 'offline_collections', 'funded_tenants',
        'momo_sms_template', 'ops', 'queue', 'search', 'opportunities', 'requisitions',
        'employee_requisition_queue', 'employee_requisition_links'
      ].includes(a.id as string)),
    },
  ];
  const [sidebarQuery, setSidebarQuery] = useState('');
  const q = sidebarQuery.trim().toLowerCase();
  // Sidebar attention badges (stale withdrawal holds). Same lightweight
  // count query FinOpsHome uses — React Query dedupes by key.
  const { data: sidebarStaleHolds } = useQuery({
    queryKey: ['finops-stale-withdrawal-hold-count'],
    queryFn: async () => {
      const { data, error } = await supabase.rpc('get_stale_withdrawal_hold_count' as any);
      if (error) throw error;
      return { count: Number((data as any)?.count ?? 0) };
    },
    staleTime: 60_000,
  });
  const badgeCounts: Partial<Record<string, number>> = sidebarStaleHolds?.count
    ? { stale_withdrawal_holds: sidebarStaleHolds.count }
    : {};
  const filteredGroups = q
    ? sidebarGroups
        .map(g => ({ ...g, items: g.items.filter(i => i.label.toLowerCase().includes(q) || i.desc.toLowerCase().includes(q)) }))
        .filter(g => g.items.length > 0)
    : sidebarGroups;

  return (
    <div className={emailTxFullscreen ? 'min-w-0' : 'flex gap-6 items-start min-w-0'}>
      {/* Mobile Drawer Navigation (Slide-out menu on mobile & tablet) */}
      <Sheet open={mobileDrawerOpen} onOpenChange={setMobileDrawerOpen}>
        <SheetContent side="left" className="w-[85vw] max-w-sm p-0 flex flex-col overflow-hidden bg-card border-r border-border">
          <SheetHeader className="px-4 pt-4 pb-3 border-b border-border bg-gradient-to-br from-primary/5 via-card to-card text-left">
            <div className="flex items-center gap-2.5">
              <div className="h-8 w-8 rounded-lg bg-primary/10 flex items-center justify-center shrink-0">
                <Sparkles className="h-4 w-4 text-primary" />
              </div>
              <div className="min-w-0 flex-1">
                <SheetTitle className="text-sm font-bold text-foreground leading-tight">Financial Ops</SheetTitle>
                <SheetDescription className="text-[11px] text-muted-foreground leading-none mt-0.5">Command Center Tools</SheetDescription>
              </div>
            </div>
            {/* Drawer search */}
            <div className="mt-3 relative">
              <Search className="h-3.5 w-3.5 text-muted-foreground absolute left-2.5 top-1/2 -translate-y-1/2 pointer-events-none" />
              <input
                type="text"
                value={sidebarQuery}
                onChange={(e) => setSidebarQuery(e.target.value)}
                placeholder="Search 35+ tools…"
                className="w-full h-8 pl-8 pr-2.5 rounded-md bg-background border border-border text-xs placeholder:text-muted-foreground/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 focus-visible:border-primary/40"
              />
            </div>
          </SheetHeader>

          {/* Overview button */}
          <div className="px-2 pt-2">
            <button
              onClick={() => { setActiveTool(null); setView('home'); setMobileDrawerOpen(false); }}
              className={`w-full flex items-center gap-2.5 px-3 py-2 rounded-lg text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary ${
                activeId === null ? 'bg-primary/10 text-primary font-semibold' : 'text-foreground hover:bg-muted/60'
              }`}
            >
              <HomeIcon className={`h-4 w-4 shrink-0 ${activeId === null ? 'text-primary' : 'text-muted-foreground'}`} />
              <span className="text-sm">Overview</span>
            </button>
          </div>

          {/* Grouped tools in drawer */}
          <nav className="flex-1 overflow-y-auto px-2 pb-4 pt-1 scrollbar-thin">
            {filteredGroups.length === 0 && (
              <p className="px-3 py-6 text-center text-xs text-muted-foreground">
                No tools match "{sidebarQuery}"
              </p>
            )}
            {filteredGroups.map((group) => (
              <div key={group.title} className="mt-3 first:mt-2">
                <p className="px-2.5 mb-1 text-[10px] font-bold uppercase tracking-wider text-muted-foreground/80">
                  {group.title}
                </p>
                <div className="flex flex-col gap-0.5">
                  {group.items.map((a) => {
                    const isActive = activeId === a.id;
                    const badgeCount = badgeCounts[a.id as string];
                    return (
                      <button
                        key={`m-${a.kind}-${a.id}`}
                        onClick={() => openMoreAction(a)}
                        className={`w-full flex items-center gap-2.5 px-3 py-2 rounded-lg text-left transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary relative ${
                          isActive
                            ? 'bg-primary/10 text-primary font-semibold'
                            : 'text-foreground/85 hover:bg-muted/60 hover:text-foreground'
                        }`}
                      >
                        <a.icon className={`h-4 w-4 shrink-0 transition-colors ${
                          isActive ? 'text-primary' : 'text-muted-foreground'
                        }`} />
                        <span className="text-sm truncate flex-1">{a.label}</span>
                        {!!badgeCount && (
                          <span className="shrink-0 rounded-full bg-amber-500/15 text-amber-700 dark:text-amber-400 text-[10px] font-bold px-1.5 py-0.5 tabular-nums">
                            {badgeCount}
                          </span>
                        )}
                      </button>
                    );
                  })}
                </div>
              </div>
            ))}
          </nav>

          {/* Live indicator footer */}
          <div className="border-t border-border px-3 py-2.5 bg-muted/20">
            <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
              <span className="relative flex h-1.5 w-1.5">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-primary opacity-75" />
                <span className="relative inline-flex rounded-full h-1.5 w-1.5 bg-primary" />
              </span>
              <span className="font-medium">Live · syncing ledger</span>
            </div>
          </div>
        </SheetContent>
      </Sheet>

      {/* Persistent sidebar (desktop) — hidden when Email Transactions is open full-screen */}
      {!emailTxFullscreen && (
      <aside className={`hidden lg:flex ${sidebarCollapsed ? 'w-14' : 'w-64 xl:w-72'} shrink-0 self-stretch min-h-[calc(100vh-2rem)] flex-col rounded-2xl border border-border bg-card overflow-hidden transition-[width] duration-200 shadow-xs`}>
        {/* Sidebar header */}
        <div className={`${sidebarCollapsed ? 'px-2 py-3' : 'px-4 pt-4 pb-3'} border-b border-border bg-gradient-to-br from-primary/5 via-card to-card`}>
          <div className={`flex items-center ${sidebarCollapsed ? 'justify-center' : 'justify-between'} gap-2`}>
            <div className={`flex items-center gap-2 min-w-0 ${sidebarCollapsed ? 'hidden' : ''}`}>
              <div className="h-8 w-8 rounded-lg bg-primary/10 flex items-center justify-center shrink-0">
                <Sparkles className="h-4 w-4 text-primary" />
              </div>
              <div className="min-w-0">
                <p className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground leading-none">Financial Ops</p>
                <p className="text-sm font-semibold text-foreground mt-1 leading-none">Command Center</p>
              </div>
            </div>
            <button
              onClick={() => setSidebarCollapsed(!sidebarCollapsed)}
              className="h-7 w-7 rounded-md flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-muted/60 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
              title={sidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
              aria-label={sidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
            >
              {sidebarCollapsed ? <PanelLeftOpen className="h-4 w-4" /> : <PanelLeftClose className="h-4 w-4" />}
            </button>
          </div>
          {/* Search — hidden when collapsed */}
          {!sidebarCollapsed && (
            <div className="mt-3 relative">
              <Search className="h-3.5 w-3.5 text-muted-foreground absolute left-2.5 top-1/2 -translate-y-1/2 pointer-events-none" />
              <input
                type="text"
                value={sidebarQuery}
                onChange={(e) => setSidebarQuery(e.target.value)}
                placeholder="Search tools…"
                className="w-full h-8 pl-8 pr-2.5 rounded-md bg-background border border-border text-xs placeholder:text-muted-foreground/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 focus-visible:border-primary/40"
              />
            </div>
          )}
        </div>

        {/* Home shortcut */}
        <div className={`${sidebarCollapsed ? 'px-1.5' : 'px-2'} pt-2`}>
          <button
            onClick={() => { setActiveTool(null); setView('home'); }}
            className={`w-full flex items-center ${sidebarCollapsed ? 'justify-center px-0' : 'gap-2.5 px-2.5'} py-2 rounded-lg text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary ${
              activeId === null
                ? 'bg-primary/10 text-primary font-semibold'
                : 'text-foreground hover:bg-muted/60'
            }`}
            title="Overview"
          >
            <HomeIcon className={`h-4 w-4 shrink-0 ${activeId === null ? 'text-primary' : 'text-muted-foreground'}`} />
            {!sidebarCollapsed && <span className="text-[13px] font-semibold">Overview</span>}
          </button>
        </div>

        {/* Grouped navigation */}
        <nav className={`flex-1 overflow-y-auto ${sidebarCollapsed ? 'px-1.5' : 'px-2'} pb-3 pt-1 scrollbar-thin`}>
          {!sidebarCollapsed && filteredGroups.length === 0 && (
            <p className="px-2.5 py-6 text-center text-xs text-muted-foreground">
              No tools match "{sidebarQuery}"
            </p>
          )}
          {(sidebarCollapsed ? sidebarGroups : filteredGroups).map((group, gi) => (
            <div key={group.title} className={`mt-3 first:mt-2 ${sidebarCollapsed && gi > 0 ? 'pt-2 border-t border-border/60' : ''}`}>
              {!sidebarCollapsed && (
                <p className="px-2.5 mb-1 text-[10px] font-bold uppercase tracking-wider text-muted-foreground/80">
                  {group.title}
                </p>
              )}
              <div className="flex flex-col gap-0.5">
                {group.items.map((a) => {
                  const isActive = activeId === a.id;
                  const badgeCount = badgeCounts[a.id as string];
                  return (
                    <button
                      key={`${a.kind}-${a.id}`}
                      onClick={() => openMoreAction(a)}
                      className={`group w-full flex items-center ${sidebarCollapsed ? 'justify-center px-0 py-2' : 'gap-2.5 px-2.5 py-1.5'} rounded-md text-left transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary relative ${
                        isActive
                          ? 'bg-primary/10 text-primary font-semibold'
                          : 'text-foreground/85 hover:bg-muted/60 hover:text-foreground'
                      }`}
                      title={sidebarCollapsed ? `${a.label}${badgeCount ? ` (${badgeCount})` : ''}` : a.desc}
                    >
                      {isActive && !sidebarCollapsed && (
                        <span className="absolute left-0 top-1.5 bottom-1.5 w-0.5 rounded-r-full bg-primary" />
                      )}
                      <span className="relative shrink-0">
                        <a.icon className={`h-3.5 w-3.5 transition-colors ${
                          isActive ? 'text-primary' : 'text-muted-foreground group-hover:text-foreground'
                        }`} />
                        {!!badgeCount && sidebarCollapsed && (
                          <span className="absolute -top-1.5 -right-1.5 h-3.5 min-w-[0.875rem] px-0.5 rounded-full bg-amber-500 text-[9px] font-bold text-white flex items-center justify-center leading-none">
                            {badgeCount > 9 ? '9+' : badgeCount}
                          </span>
                        )}
                      </span>
                      {!sidebarCollapsed && (
                        <span className="text-[13px] leading-tight truncate flex-1">{a.label}</span>
                      )}
                      {!!badgeCount && !sidebarCollapsed && (
                        <span className="shrink-0 rounded-full bg-amber-500/15 text-amber-700 dark:text-amber-400 text-[10px] font-bold px-1.5 py-0.5 tabular-nums">
                          {badgeCount}
                        </span>
                      )}
                    </button>
                  );
                })}
              </div>
            </div>
          ))}
        </nav>

        {/* Footer status pill */}
        <div className={`border-t border-border ${sidebarCollapsed ? 'px-2 py-2 flex justify-center' : 'px-3 py-2.5'} bg-muted/20`}>
          <div className={`flex items-center gap-2 text-[11px] text-muted-foreground ${sidebarCollapsed ? 'justify-center' : ''}`}>
            <span className="relative flex h-1.5 w-1.5">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-primary opacity-75" />
              <span className="relative inline-flex rounded-full h-1.5 w-1.5 bg-primary" />
            </span>
            {!sidebarCollapsed && <span className="font-medium">Live · syncing ledger</span>}
          </div>
        </div>
      </aside>
      )}

      {/* Main content — full width when Email Transactions is open */}
      <div className={emailTxFullscreen ? 'w-full min-w-0' : 'flex-1 min-w-0'}>
        {/* Mobile quick navigation trigger bar */}
        {!emailTxFullscreen && (
          <div className="lg:hidden mb-4 flex items-center justify-between gap-2 p-2 rounded-xl border border-border/80 bg-card/90 backdrop-blur shadow-xs">
            <button
              type="button"
              onClick={() => setMobileDrawerOpen(true)}
              className="h-8 px-2.5 rounded-lg bg-primary/10 hover:bg-primary/20 text-primary flex items-center gap-1.5 text-xs font-semibold transition-colors shrink-0"
              aria-label="Open Financial Operations menu"
            >
              <Menu className="h-4 w-4" />
              <span>Tools Menu ({moreActions.length})</span>
              {!!sidebarStaleHolds?.count && (
                <span className="h-2 w-2 rounded-full bg-amber-500 animate-pulse" />
              )}
            </button>
            <div className="min-w-0 text-right pr-1">
              <p className="text-[10px] uppercase font-bold tracking-wider text-muted-foreground truncate">
                {activeTool ? 'Active Tool' : view === 'home' ? 'Current' : 'Queue'}
              </p>
              <p className="text-xs font-bold text-foreground truncate max-w-[150px]">
                {activeTool ? moreActions.find(a => a.id === activeTool)?.label || String(activeTool) : view === 'home' ? 'Overview' : view}
              </p>
            </div>
          </div>
        )}
        {content}

        {!activeTool && view === 'home' && (
          <div className="mt-6 space-y-4">
            <MomoFeedSilenceAlert />

            {/* IFTTT Diagnostics Accordion — collapsed by default */}
            <div className="rounded-2xl border border-border bg-card overflow-hidden shadow-2xs">
              <button
                type="button"
                onClick={() => setIftttDiagnosticsOpen(!iftttDiagnosticsOpen)}
                className="w-full flex items-center justify-between gap-3 px-5 py-4 text-left hover:bg-muted/30 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
                aria-expanded={iftttDiagnosticsOpen}
              >
                <div className="flex items-center gap-3 min-w-0">
                  <div className="h-9 w-9 rounded-xl bg-primary/10 border border-primary/20 flex items-center justify-center shrink-0">
                    <Activity className="h-4.5 w-4.5 text-primary" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <h2 className="text-base font-bold tracking-tight text-foreground">IFTTT Live Webhook Diagnostics</h2>
                      <span className="hidden sm:inline-flex items-center rounded-md bg-muted px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wider text-muted-foreground">
                        Automation
                      </span>
                    </div>
                    <p className="text-xs text-muted-foreground mt-0.5 truncate">
                      SMS forwarding health, last received webhooks & payload inspection.
                    </p>
                  </div>
                </div>
                {iftttDiagnosticsOpen ? (
                  <ChevronUp className="h-5 w-5 text-muted-foreground shrink-0" />
                ) : (
                  <ChevronDown className="h-5 w-5 text-muted-foreground shrink-0" />
                )}
              </button>
              {iftttDiagnosticsOpen && (
                <div className="p-4 border-t border-border bg-muted/5">
                  <IftttDiagnosticsPanel />
                </div>
              )}
            </div>

            {/* Merchant Phone Checklist Accordion — collapsed by default */}
            <div className="rounded-2xl border border-border bg-card overflow-hidden shadow-2xs">
              <button
                type="button"
                onClick={() => setMerchantChecklistOpen(!merchantChecklistOpen)}
                className="w-full flex items-center justify-between gap-3 px-5 py-4 text-left hover:bg-muted/30 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
                aria-expanded={merchantChecklistOpen}
              >
                <div className="flex items-center gap-3 min-w-0">
                  <div className="h-9 w-9 rounded-xl bg-amber-500/10 border border-amber-500/20 flex items-center justify-center shrink-0">
                    <Smartphone className="h-4.5 w-4.5 text-amber-600 dark:text-amber-400" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <h2 className="text-base font-bold tracking-tight text-foreground">Merchant Operational Phone Setup</h2>
                      <span className="hidden sm:inline-flex items-center rounded-md bg-amber-500/10 border border-amber-500/20 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wider text-amber-600 dark:text-amber-400">
                        Checklist
                      </span>
                    </div>
                    <p className="text-xs text-muted-foreground mt-0.5 truncate">
                      Required background permissions, battery optimizations & SMS automation steps.
                    </p>
                  </div>
                </div>
                {merchantChecklistOpen ? (
                  <ChevronUp className="h-5 w-5 text-muted-foreground shrink-0" />
                ) : (
                  <ChevronDown className="h-5 w-5 text-muted-foreground shrink-0" />
                )}
              </button>
              {merchantChecklistOpen && (
                <div className="p-4 border-t border-border bg-muted/5">
                  <MerchantPhoneChecklist />
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════
// Precision FinOps — professional home view
// ═══════════════════════════════════════════════════════════════════

interface FinOpsHomeProps {
  onView: (v: View) => void;
  onOpenTool: (t: Tool) => void;
  onOpenMore: () => void;
  onFocusBucket: (b: 'float' | 'withdrawable' | null) => void;
  walletBreakdownOpen: boolean;
  setWalletBreakdownOpen: (v: boolean) => void;
  focusBucket: 'float' | 'withdrawable' | null;
  onClearFocus: () => void;
  moreSheet: boolean;
  setMoreSheet: (v: boolean) => void;
  openMoreAction: (a: MoreAction) => void;
  onOpenMobileDrawer?: () => void;
}

function FinOpsHome({
  onView, onOpenTool, onOpenMore, onFocusBucket,
  walletBreakdownOpen, setWalletBreakdownOpen, focusBucket, onClearFocus,
  moreSheet, setMoreSheet, openMoreAction, onOpenMobileDrawer,
}: FinOpsHomeProps) {
  const qc = useQueryClient();
  const [exploreQuery, setExploreQuery] = useState('');

  const { data: totals, isLoading: totalsLoading } = useQuery({
    queryKey: ['finops-wallet-overview'],
    queryFn: async () => {
      const { data, error } = await supabase.rpc('get_wallet_totals');
      if (error) throw error;
      const d = data as any;
      return {
        totalBalance: Number(d.total_balance ?? 0),
        walletCount: Number(d.total_wallets ?? 0),
        activeWallets: Number(d.active_wallets ?? 0),
        totalFloat: Number(d.total_float ?? 0),
        totalWithdrawable: Number(d.total_withdrawable ?? 0),
      };
    },
    staleTime: 60_000,
  });

  const { data: queues } = useQuery({
    queryKey: ['finops-wallet-overview-queues'],
    queryFn: async () => {
      const userDeposits = await supabase
        .from('deposit_requests')
        .select('id', { count: 'exact', head: true })
        .eq('status', 'pending');
      const fieldDeposits = await supabase
        .from('field_deposit_batches')
        .select('id', { count: 'exact', head: true })
        .eq('status', 'pending_finops_verification');
      const withdrawals = await supabase
        .from('withdrawal_requests')
        .select('id', { count: 'exact', head: true })
        .eq('status', 'pending');
      const claims = await supabase
        .from('withdrawal_requests')
        .select('id', { count: 'exact', head: true })
        .in('status', ['claimed', 'processing']);
      return {
        depositsPending: (userDeposits.count ?? 0) + (fieldDeposits.count ?? 0),
        payoutsPending: withdrawals.count ?? 0,
        activeClaims: claims.count ?? 0,
      };
    },
    staleTime: 15_000,
  });

  // Broadly-visible count so a stale withdrawal hold can't sit unnoticed for
  // months again — anyone who can see Financial Ops can see this number, even
  // if they're not personally authorized to settle/cancel one (that stays
  // gated inside StaleWithdrawalHoldsPanel itself).
  const { data: staleHolds } = useQuery({
    queryKey: ['finops-stale-withdrawal-hold-count'],
    queryFn: async () => {
      const { data, error } = await supabase.rpc('get_stale_withdrawal_hold_count' as any);
      if (error) throw error;
      const d = data as any;
      return {
        count: Number(d?.count ?? 0),
        criticalCount: Number(d?.critical_count ?? 0),
        oldestAgeDays: Number(d?.oldest_age_days ?? 0),
      };
    },
    staleTime: 60_000,
  });
  const badgeCounts: Partial<Record<string, number>> = staleHolds?.count
    ? { stale_withdrawal_holds: staleHolds.count }
    : {};

  const refreshAll = () => {
    qc.invalidateQueries({ queryKey: ['finops-wallet-overview'] });
    qc.invalidateQueries({ queryKey: ['finops-wallet-overview-queues'] });
  };

  const eq = exploreQuery.trim().toLowerCase();
  const filteredMoreActions = eq
    ? moreActions.filter(a => a.label.toLowerCase().includes(eq) || a.desc.toLowerCase().includes(eq))
    : moreActions;

  return (
    <div className="space-y-6">
      {/* Header row */}
      <div className="flex items-start sm:items-center justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-xl sm:text-3xl font-black tracking-tight text-foreground">Financial Operations</h1>
          <p className="text-xs sm:text-sm text-muted-foreground mt-0.5 sm:mt-1">
            Verify deposits, approve withdrawals and keep the platform balanced.
          </p>
        </div>
        <div className="flex items-center gap-2 shrink-0 flex-wrap">
          {onOpenMobileDrawer && (
            <button
              type="button"
              onClick={onOpenMobileDrawer}
              className="lg:hidden inline-flex items-center gap-1.5 rounded-full border border-primary/30 bg-primary/10 px-2.5 py-1 text-xs font-semibold text-primary hover:bg-primary/20 transition-colors"
            >
              <Menu className="h-3.5 w-3.5" /> All Tools
            </button>
          )}
          <span className="inline-flex items-center gap-1.5 rounded-full border border-primary/30 bg-primary/10 px-2.5 py-1 text-[11px] font-semibold uppercase tracking-wider text-primary">
            <span className="h-1.5 w-1.5 rounded-full bg-primary animate-pulse" /> Live
          </span>
          <button
            onClick={refreshAll}
            className="inline-flex items-center gap-1.5 rounded-full border border-border bg-card px-2.5 sm:px-3 py-1 text-xs font-semibold text-primary hover:bg-primary/5 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary shadow-2xs"
          >
            <ArrowRightLeft className="h-3.5 w-3.5" /> Refresh
          </button>
        </div>
      </div>

      {/* Verified payout destinations — nobody is paid to an unverified number */}
      <PayoutVerificationCallout onOpen={() => onOpenTool('payout_verification')} />

      {/* Above-the-fold highest frequency daily operations */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5 gap-3">
        <MajorActionButton
          onClick={() => onOpenTool('cash_codes')}
          icon={KeyRound}
          tone="amber"
          title="Cash Deposit Codes"
          desc="Read pending codes back to depositors — codes expire in 2 min."
        />
        <MajorActionButton
          onClick={() => onOpenTool('email_tx')}
          icon={Mail}
          tone="blue"
          title="Email Transactions"
          desc="Live transaction inbox extracted from Gmail."
        />
        <MajorActionButton
          onClick={() => onOpenTool('wallet_buckets')}
          icon={Wallet}
          tone="primary"
          title="Wallet Buckets"
          desc="Withdrawable, float & advance balances per wallet — spot drift, open the ledger."
        />
        <MajorActionButton
          onClick={() => onOpenTool('withdrawals')}
          icon={Banknote}
          tone="blue"
          title="Payout Queue"
          desc={`${queues?.payoutsPending ?? 0} withdrawal${(queues?.payoutsPending ?? 0) === 1 ? '' : 's'} pending payout.`}
          badgeCount={queues?.payoutsPending}
        />
        <MajorActionButton
          onClick={() => onOpenTool('merchant_float')}
          icon={HandCoins}
          tone="amber"
          title="Merchant Float"
          desc={`${queues?.activeClaims ?? 0} active claim${(queues?.activeClaims ?? 0) === 1 ? '' : 's'} & float requests.`}
          badgeCount={queues?.activeClaims}
        />
      </div>

      {/* Wallet Breakdown — collapsed by default; expand to search every wallet */}
      <div className="rounded-2xl border border-border bg-card overflow-hidden shadow-2xs">
        <button
          type="button"
          onClick={() => setWalletBreakdownOpen(!walletBreakdownOpen)}
          className="w-full flex items-center justify-between gap-3 px-5 py-4 text-left hover:bg-muted/30 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
        >
          <div className="flex items-center gap-3 min-w-0">
            <div className="h-9 w-9 rounded-xl bg-primary/10 border border-primary/20 flex items-center justify-center shrink-0">
              <Search className="h-4.5 w-4.5 text-primary" />
            </div>
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <h2 className="text-base font-bold tracking-tight text-foreground">Wallet Breakdown</h2>
                <span className="hidden sm:inline-flex items-center rounded-md bg-muted px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wider text-muted-foreground">
                  Read Only
                </span>
              </div>
              <p className="text-xs text-muted-foreground mt-0.5 truncate">
                Search every wallet by name, phone, or balance range.
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <span className="text-xs font-medium text-muted-foreground hidden sm:inline">
              {walletBreakdownOpen ? 'Collapse' : 'Expand search'}
            </span>
            {walletBreakdownOpen ? (
              <ChevronUp className="h-5 w-5 text-muted-foreground shrink-0" />
            ) : (
              <ChevronDown className="h-5 w-5 text-muted-foreground shrink-0" />
            )}
          </div>
        </button>
        {walletBreakdownOpen && (
          <div className="px-4 pb-4 border-t border-border bg-muted/5">
            <WalletBreakdownReadOnly
              focusBucket={focusBucket}
              onClearFocus={onClearFocus}
            />
          </div>
        )}
      </div>

      {/* Hero + Phone Money */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 items-stretch">
        <div className="min-w-0 h-full">
          <WalletOverviewCard
            onOpenReconciliation={() => onOpenTool('recon')}
            onOpenBreakdown={() => onOpenTool('wallet_breakdown')}
            onDrillBucket={(bucket) => onFocusBucket(bucket)}
          />
        </div>
        <div className="min-w-0 h-full">
          <PhoneMoneyCard />
        </div>
      </div>

      {/* Company money sitting with merchant agents — directly below ACTUAL MONEY */}
      <MoneyWithAgentsCard onOpenTimeline={() => onOpenTool('cashout_settlement')} />

      {/* Performance, Disputes & Verification */}
      <div className="space-y-4">
        {/* Who to give more float, who to cut back — measured from real withdrawals */}
        <MerchantAgentFloatAllocationPanel compact onOpenFull={() => onOpenTool('merchant_float_allocation')} />

        {/* Merchant agents reporting a wrong balance — fix it right here */}
        <MerchantBalanceDisputesPanel />

        <AutoCreditSuccessRateTile onClick={() => onOpenTool('auto_credit_review')} />
      </div>

      {/* Flagship action tiles */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <ActionStatTile
          onClick={() => onView('deposits')}
          icon={ShieldCheck}
          tone="primary"
          count={queues?.depositsPending ?? 0}
          countLabel="Pending Verification"
          title="Verify Deposits"
          desc="User top-ups & agent field cash — one place."
        />
        <ActionStatTile
          onClick={() => onOpenTool('withdrawals')}
          icon={Banknote}
          tone="secondary"
          count={queues?.payoutsPending ?? 0}
          countLabel="Payout Requests"
          title="Withdrawal Approvals"
          desc="Review and release user withdrawable funds."
        />
        <ActionStatTile
          onClick={() => onOpenTool('merchant_claims')}
          icon={HandCoins}
          tone="tertiary"
          count={queues?.activeClaims ?? 0}
          countLabel="Active Claims"
          title="Merchant Claims"
          desc="Operational settlements for cash-out agents."
        />
      </div>

      {/* Pulse strip — dense KPI row (kept for operators) */}
      <FinancialOpsPulseStrip
        onSelect={(key) => {
          switch (key) {
            case 'deposits': onView('deposits'); break;
            case 'cash_out':
            case 'wallet_ops':
            case 'invest_wd': onOpenTool('withdrawals'); break;
            case 'today': onOpenTool('audit'); break;
          }
        }}
      />

      {/* Quick-access footer row */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 pt-2 border-t border-border">
        <QuickTile icon={Activity} label="Bridge Health" desc="API connectivity status." onClick={() => onOpenTool('bridge_health')} />
        <QuickTile icon={Archive} label="Receipt Archive" desc="Every payout receipt." onClick={() => onOpenTool('receipt_archive')} />
        <QuickTile icon={ArrowRightLeft} label="Cash-Out Timeline" desc="Agent settlement flow." onClick={() => onOpenTool('cashout_settlement')} />
        <QuickTile icon={MoreHorizontal} label="Explore Tools" desc="Audit & review logs." onClick={onOpenMore} />
      </div>

      {/* "More" Sheet */}
      <Sheet open={moreSheet} onOpenChange={setMoreSheet}>
        <SheetContent
          side="right"
          className="w-full sm:max-w-md p-0 flex flex-col overflow-hidden"
        >
          <SheetHeader className="px-5 pt-5 pb-3 border-b border-border bg-gradient-to-br from-primary/5 via-card to-card text-left">
            <SheetTitle>Explore Tools</SheetTitle>
            <SheetDescription>Everything beyond verifying deposits and approving withdrawals</SheetDescription>
            <div className="mt-3 relative">
              <Search className="h-3.5 w-3.5 text-muted-foreground absolute left-2.5 top-1/2 -translate-y-1/2 pointer-events-none" />
              <input
                type="text"
                value={exploreQuery}
                onChange={(e) => setExploreQuery(e.target.value)}
                placeholder="Search 35+ tools…"
                className="w-full h-8 pl-8 pr-2.5 rounded-md bg-background border border-border text-xs placeholder:text-muted-foreground/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 focus-visible:border-primary/40"
              />
            </div>
          </SheetHeader>
          <div className="flex-1 overflow-y-auto overflow-x-hidden px-3 py-3 min-w-0">
            {filteredMoreActions.length === 0 && (
              <p className="px-3 py-8 text-center text-xs text-muted-foreground">
                No tools match "{exploreQuery}"
              </p>
            )}
            {filteredMoreActions.map(a => {
              const badgeCount = badgeCounts[a.id as string];
              return (
                <button
                  key={`${a.kind}-${a.id}`}
                  onClick={() => openMoreAction(a)}
                  className="w-full max-w-full flex items-center gap-3 p-3 rounded-xl hover:bg-primary/5 border border-transparent hover:border-primary/20 transition-colors text-left overflow-hidden focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
                >
                  <div className="h-9 w-9 rounded-lg bg-primary/10 flex items-center justify-center shrink-0">
                    <a.icon className="h-4.5 w-4.5 text-primary" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <span className="font-medium text-sm flex items-center gap-1.5 break-words">
                      {a.label}
                      {!!badgeCount && (
                        <span className="shrink-0 rounded-full bg-amber-500/15 text-amber-700 dark:text-amber-400 text-[10px] font-bold px-1.5 py-0.5 tabular-nums">
                          {badgeCount}
                        </span>
                      )}
                    </span>
                    <span className="text-[11px] text-muted-foreground block break-words">{a.desc}</span>
                  </div>
                </button>
              );
            })}
          </div>
        </SheetContent>
      </Sheet>
    </div>
  );
}

function ActionStatTile({
  onClick, icon: Icon, tone, count, countLabel, title, desc,
}: {
  onClick: () => void;
  icon: typeof ShieldCheck;
  tone: 'primary' | 'secondary' | 'tertiary';
  count: number;
  countLabel: string;
  title: string;
  desc: string;
}) {
  const toneClass =
    tone === 'primary'
      ? 'bg-primary/15 text-primary border-primary/25'
      : tone === 'secondary'
      ? 'bg-purple-500/15 text-purple-600 dark:text-purple-400 border-purple-500/25'
      : 'bg-amber-500/15 text-amber-600 dark:text-amber-400 border-amber-500/25';

  const gradientBg =
    tone === 'primary'
      ? 'bg-gradient-to-br from-primary/8 via-card to-card hover:border-primary/50'
      : tone === 'secondary'
      ? 'bg-gradient-to-br from-purple-500/8 via-card to-card hover:border-purple-500/50'
      : 'bg-gradient-to-br from-amber-500/8 via-card to-card hover:border-amber-500/50';

  return (
    <button
      onClick={onClick}
      className={`group relative text-left rounded-xl sm:rounded-2xl border border-border/80 p-4 sm:p-5 hover:shadow-md hover:-translate-y-0.5 transition-all min-h-[140px] sm:min-h-[160px] flex flex-col justify-between focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary shadow-2xs ${gradientBg}`}
    >
      <div className="flex items-start justify-between gap-3 w-full">
        <div className={`h-10 w-10 sm:h-11 sm:w-11 rounded-xl flex items-center justify-center shrink-0 border ${toneClass}`}>
          <Icon className="h-5 w-5" />
        </div>
        <div className="text-right">
          <p className="text-2xl sm:text-4xl font-black tabular-nums leading-none text-foreground tracking-tight">
            {count.toLocaleString()}
          </p>
          <p className="mt-1 text-[9px] sm:text-[10px] font-bold uppercase tracking-widest text-muted-foreground">
            {countLabel}
          </p>
        </div>
      </div>
      <div className="mt-3 sm:mt-4">
        <p className="font-bold text-sm sm:text-base tracking-tight text-foreground group-hover:text-primary transition-colors flex items-center justify-between">
          <span>{title}</span>
          <ChevronRight className="h-4 w-4 text-muted-foreground/60 group-hover:text-foreground group-hover:translate-x-0.5 transition-transform" />
        </p>
        <p className="text-xs text-muted-foreground mt-0.5 leading-relaxed line-clamp-2">{desc}</p>
      </div>
    </button>
  );
}

function QuickTile({
  icon: Icon, label, desc, onClick,
}: {
  icon: typeof Activity;
  label: string;
  desc: string;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className="group text-left rounded-xl border border-border/80 bg-card p-3.5 hover:border-primary/40 hover:bg-primary/5 hover:shadow-xs transition-all min-w-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary flex items-start gap-3"
    >
      <div className="h-8.5 w-8.5 rounded-lg bg-primary/10 border border-primary/20 flex items-center justify-center shrink-0">
        <Icon className="h-4 w-4 text-primary" />
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center justify-between gap-1">
          <p className="text-xs sm:text-sm font-semibold truncate text-foreground group-hover:text-primary transition-colors">{label}</p>
          <ChevronRight className="h-3.5 w-3.5 text-muted-foreground/40 group-hover:text-foreground group-hover:translate-x-0.5 transition-all shrink-0" />
        </div>
        <p className="text-[11px] text-muted-foreground truncate mt-0.5">{desc}</p>
      </div>
    </button>
  );
}

function MajorActionButton({
  onClick, icon: Icon, tone, title, desc, badgeCount,
}: {
  onClick: () => void;
  icon: typeof KeyRound;
  tone: 'amber' | 'blue' | 'primary' | 'rose';
  title: string;
  desc: string;
  badgeCount?: number;
}) {
  const toneBadge =
    tone === 'amber'
      ? 'bg-amber-500/10 text-amber-600 dark:text-amber-400 border-amber-500/25'
      : tone === 'primary'
      ? 'bg-primary/10 text-primary border-primary/25'
      : tone === 'rose'
      ? 'bg-rose-500/10 text-rose-600 dark:text-rose-400 border-rose-500/25'
      : 'bg-sky-500/10 text-sky-600 dark:text-sky-400 border-sky-500/25';

  const accentBorder =
    tone === 'amber'
      ? 'hover:border-amber-500/50'
      : tone === 'primary'
      ? 'hover:border-primary/50'
      : tone === 'rose'
      ? 'hover:border-rose-500/50'
      : 'hover:border-sky-500/50';

  return (
    <button
      onClick={onClick}
      className={`group relative text-left rounded-xl sm:rounded-2xl border border-border/80 bg-card p-3.5 sm:p-5 transition-all duration-200 hover:shadow-md hover:-translate-y-0.5 flex flex-col justify-between focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary min-h-[105px] sm:min-h-[128px] shadow-2xs ${accentBorder}`}
    >
      <div className="flex items-start justify-between gap-2.5 w-full">
        <div className={`h-9 w-9 sm:h-10 sm:w-10 rounded-xl flex items-center justify-center shrink-0 border ${toneBadge}`}>
          <Icon className="h-4.5 w-4.5 sm:h-5 sm:w-5" />
        </div>
        <div className="flex items-center gap-1.5">
          {typeof badgeCount === 'number' && badgeCount > 0 && (
            <span className={`inline-flex items-center justify-center min-w-[20px] h-5 px-1.5 rounded-full text-[11px] font-bold tabular-nums border ${
              tone === 'amber' ? 'bg-amber-500/15 text-amber-600 dark:text-amber-400 border-amber-500/30' :
              tone === 'primary' ? 'bg-primary/15 text-primary border-primary/30' :
              tone === 'rose' ? 'bg-rose-500/15 text-rose-600 dark:text-rose-400 border-rose-500/30' :
              'bg-sky-500/15 text-sky-600 dark:text-sky-400 border-sky-500/30'
            }`}>
              {badgeCount}
            </span>
          )}
          <div className="h-6 w-6 rounded-full flex items-center justify-center text-muted-foreground/60 group-hover:text-foreground group-hover:bg-muted/80 transition-colors">
            <ChevronRight className="h-4 w-4 transition-transform group-hover:translate-x-0.5" />
          </div>
        </div>
      </div>
      <div className="mt-3">
        <p className="font-bold text-sm sm:text-base tracking-tight text-foreground group-hover:text-primary transition-colors line-clamp-1">{title}</p>
        <p className="text-xs text-muted-foreground mt-0.5 sm:mt-1 leading-relaxed line-clamp-2">{desc}</p>
      </div>
    </button>
  );
}


