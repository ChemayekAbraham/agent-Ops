import {
  Activity, AlertCircle, AlertTriangle, ArrowRightLeft, Archive, BookOpen, CalendarClock, ClipboardList, FileText, Gauge,
  HandCoins, Home as HomeIcon, Mail, MessageSquare, Receipt, ReceiptText, Scale, ScanLine, ScrollText, Search, Shield,
  ShieldAlert, ShieldCheck, Sparkles, Store, TrendingUp, Wallet, WifiOff, type LucideIcon,
} from 'lucide-react';
import { finopsPath } from '@/lib/financialOpsRoutes';

/**
 * The Financial Ops menu, grouped the way the mobile app groups it (Overview & planning, Money in, Withdrawals & payouts,
 * Merchant agents, Records & audit). Every entry points at a tool or view the Command Center already opens through its
 * `?tool=` / `?view=` links, so nothing here renders a panel itself.
 *
 * The one exception is Email Transactions: it opens the default /admin/financial-ops page, exactly as it is today.
 */
export type FinOpsMenuEntry = {
  /** Command Center tool id, or view id when `kind` is 'view'. 'email_tx' goes to the default page instead. */
  id: string;
  kind: 'tool' | 'view' | 'default';
  label: string;
  desc: string;
  icon: LucideIcon;
};

export type FinOpsMenuGroup = { title: string; entries: FinOpsMenuEntry[] };

export const FINOPS_MENU_GROUPS: FinOpsMenuGroup[] = [
  {
    title: 'Overview & planning',
    entries: [
      { id: 'ops', kind: 'tool', label: 'Ops Center', desc: 'Automation and monitoring of the money feeds.', icon: Gauge },
      { id: 'wallet_buckets', kind: 'tool', label: 'Wallet Buckets', desc: 'Withdrawable, float, landlord and merchant buckets, who holds them and the money we actually hold.', icon: Wallet },
      { id: 'wallet_breakdown', kind: 'tool', label: 'Wallet Breakdown', desc: 'Every wallet by name, phone or balance, with its withdrawable, float, advance and locked amounts.', icon: Wallet },
      { id: 'liquidity_forecast', kind: 'tool', label: 'Liquidity Forecast', desc: 'What is withdrawable now, and the ROI due each coming day, so you can pre-fund payouts.', icon: CalendarClock },
      { id: 'reports', kind: 'tool', label: 'Reports', desc: 'Daily wallet financial summary: money in and paid out by source, with the PDF and Excel files.', icon: FileText },
      { id: 'float_to_withdrawable', kind: 'tool', label: 'Float to Withdrawable', desc: "Reclassify a user's Operational Float into their Withdrawable balance.", icon: ArrowRightLeft },
      { id: 'bridge_health', kind: 'tool', label: 'Deposit Bridge Health', desc: 'Reliability of the queue between Financial Ops and the wallet ledger: pending, retries, dead letters, gap alerts.', icon: Activity },
      { id: 'opportunities', kind: 'tool', label: 'Capital Opportunities', desc: 'Investment summaries supporters see on their dashboard.', icon: TrendingUp },
    ],
  },
  {
    title: 'Money in',
    entries: [
      { id: 'email_tx', kind: 'default', label: 'Email Transactions', desc: 'Live MTN, Airtel and bank money in and out, read from Gmail receipts.', icon: Mail },
      { id: 'deposits', kind: 'view', label: 'User Deposits', desc: 'Every user deposit request still pending, even when no Gmail receipt has matched it yet.', icon: ReceiptText },
      { id: 'offline_collections', kind: 'view', label: 'Offline Collections', desc: 'Rent collections agents captured offline and submitted with proof.', icon: WifiOff },
      { id: 'cash_codes', kind: 'tool', label: 'Cash Deposit Codes', desc: 'Recent cash deposits: awaiting their 4-digit code, verified, banked or still cash at hand.', icon: Receipt },
      { id: 'auto_credit_review', kind: 'tool', label: 'Auto-Credit Review', desc: 'Deposits credited by best-guess name matching, with the match audit, to catch a wrong user.', icon: AlertTriangle },
      { id: 'manual_float_credit', kind: 'tool', label: 'Manual Float Credit', desc: "Credit an agent's float from a TID the feed missed. The TID is locked so it cannot double-credit.", icon: Wallet },
      { id: 'topup_audit', kind: 'tool', label: 'Top-Up Audit Log', desc: 'Each partnership top-up with its fund source, recipient routing and both ledger legs.', icon: ScrollText },
      { id: 'momo_sms_template', kind: 'tool', label: 'MoMo Thank-You SMS', desc: 'The message sent to anyone who pays Welile by mobile money: edit the wording.', icon: MessageSquare },
    ],
  },
  {
    title: 'Withdrawals & payouts',
    entries: [
      { id: 'withdrawals', kind: 'tool', label: 'Withdrawal Approvals', desc: 'Review payout requests and release withdrawable funds.', icon: Receipt },
      { id: 'queue', kind: 'tool', label: 'Approval Queue', desc: 'Pending approvals waiting on Financial Ops.', icon: ClipboardList },
      { id: 'withdrawal_history', kind: 'tool', label: 'Withdrawal History', desc: 'Every withdrawal in order, with the balance before and after.', icon: Receipt },
      { id: 'stale_withdrawal_holds', kind: 'tool', label: 'Stale Withdrawal Holds', desc: "Withdrawals stuck without a payout or rejection, each hiding a user's real balance.", icon: AlertTriangle },
      { id: 'unverified_withdrawals', kind: 'tool', label: 'Unverified Withdrawals', desc: 'Requests hidden from merchants until the owner finishes ID verification: call and help them.', icon: ShieldAlert },
      { id: 'payout_verification', kind: 'tool', label: 'Verify Payout Numbers', desc: 'Call each holder and confirm the mobile money number or bank account is theirs. Nobody is paid until you verify.', icon: ShieldCheck },
      { id: 'funded_tenants', kind: 'tool', label: 'Funded Landlords & Tenants', desc: 'Landlord payouts that have been funded, by day, landlord and agent.', icon: HomeIcon },
      { id: 'proxy_diagnostics', kind: 'tool', label: 'Proxy Withdrawal Diagnostics', desc: "Why each pending proxy withdrawal hasn't auto-settled: capacity, proxy balance, assignment.", icon: AlertCircle },
    ],
  },
  {
    title: 'Merchant agents',
    entries: [
      { id: 'merchant_agents', kind: 'tool', label: 'Merchant Agents', desc: 'The cash-out agents who pay users out: assign, edit how they may pay, remove.', icon: Store },
      { id: 'merchant_float', kind: 'tool', label: 'Merchant Float', desc: 'Fund or reject merchant agent operational float requests.', icon: HandCoins },
      { id: 'merchant_float_requisition', kind: 'tool', label: 'Merchant Float Requisition', desc: 'Raise a funding requisition for the merchant network and send it to the CFO for approval.', icon: HandCoins },
      { id: 'merchant_float_allocation', kind: 'tool', label: 'Float Allocation Report', desc: 'Rank merchant agents by verified payout reliability: who to give more float, who to cut back.', icon: TrendingUp },
      { id: 'merchant_claims', kind: 'tool', label: 'Merchant Claims Log', desc: 'Every withdrawal a merchant agent claimed, in progress and completed, with its audit trail.', icon: Receipt },
      { id: 'cashout_settlement', kind: 'tool', label: 'Cash-Out Settlement Timeline', desc: "Each cash-out with the merchant's reimbursement and 0.5% commission, and the ledger rows behind it.", icon: ArrowRightLeft },
      { id: 'employee_requisition_queue', kind: 'tool', label: 'Manual Requisition Review', desc: 'Review shareable-link requisitions through the COO and CFO approval stages.', icon: ClipboardList },
      { id: 'employee_requisition_links', kind: 'tool', label: 'Manual Requisition Links', desc: 'Secure links for requisitions outside My Space: create one, send it, revoke it.', icon: FileText },
      { id: 'requisitions', kind: 'tool', label: 'Fund Requisitions', desc: 'Agent fund requests.', icon: FileText },
    ],
  },
  {
    title: 'Records & audit',
    entries: [
      { id: 'user_statements', kind: 'tool', label: 'User Wallet Statements', desc: 'Search a user and read their withdrawable, float, landlord float and advance statements.', icon: ReceiptText },
      { id: 'earnings_explainer', kind: 'tool', label: 'How Did They Earn?', desc: "Search a user and see where every UGX in their wallet came from, grouped by source.", icon: Sparkles },
      { id: 'partner_receipts', kind: 'tool', label: 'Partner Receipts', desc: 'Issue numbered digital receipts for money partners hand in, search them, and send corrections to the CFO.', icon: Receipt },
      { id: 'receipt_archive', kind: 'tool', label: 'Receipt Archive', desc: 'Permanent record of every payout receipt: search it, see who funded it, open its link.', icon: Archive },
      { id: 'search', kind: 'tool', label: 'Transaction Search', desc: 'Find any ledger entry by transaction ID, reference, phone, name or description.', icon: Search },
      { id: 'ledgers', kind: 'tool', label: 'Ledger', desc: 'Full record of all wallet activity.', icon: BookOpen },
      { id: 'audit', kind: 'tool', label: 'Audit Trail', desc: 'The latest actions on the platform and who took them.', icon: Shield },
      { id: 'recon', kind: 'tool', label: 'Reconciliation', desc: 'Phone money against platform money, wallet-ledger drift, and payouts not fully recorded.', icon: Scale },
      { id: 'recon_review', kind: 'tool', label: 'Reconciliation Review', desc: 'Paste receipts or bank references and see which matched a deposit, which did not, and why.', icon: ScanLine },
      { id: 'withdrawal_notif_log', kind: 'tool', label: 'Withdrawal Notification Log', desc: 'Every withdrawal alert email, searchable by recipient, amount and date.', icon: MessageSquare },
      { id: 'sms_delivery_log', kind: 'tool', label: 'SMS Delivery Log', desc: 'Every claim and payout SMS with its provider, retries and failure reason.', icon: MessageSquare },
      { id: 'mismatch_metrics', kind: 'tool', label: 'Provider Mismatch Metrics', desc: 'How often operators verify a deposit on the wrong provider channel.', icon: AlertTriangle },
    ],
  },
];

export const FINOPS_MENU_TOTAL = FINOPS_MENU_GROUPS.reduce((n, g) => n + g.entries.length, 0);

/** Where a menu entry goes: every tool and view has its own real URL; Email Transactions included. */
export function finopsEntryHref(e: FinOpsMenuEntry): string {
  return finopsPath(e.id);
}
