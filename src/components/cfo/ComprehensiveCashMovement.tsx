import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { format, startOfDay, startOfWeek, startOfMonth, startOfYear, subDays, subYears, addDays, addWeeks, addMonths, differenceInCalendarDays } from 'date-fns';
import { Loader2, RefreshCw, Calendar, FileSpreadsheet, FileText, ArrowUpRight, ArrowDownRight, ArrowDownLeft, ExternalLink, X, Filter, ChevronDown, ChevronUp, ChevronRight, Search } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '@/components/ui/table';
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from '@/components/ui/sheet';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Input } from '@/components/ui/input';
import { Checkbox } from '@/components/ui/checkbox';
import { Collapsible, CollapsibleTrigger, CollapsibleContent } from '@/components/ui/collapsible';
import { Popover, PopoverTrigger, PopoverContent } from '@/components/ui/popover';
import { Calendar as CalendarPicker } from '@/components/ui/calendar';
import { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider } from '@/components/ui/tooltip';
import { Info, Users, ArrowLeftRight, Check, AlertTriangle, TrendingUp, MinusCircle, Share2, Image as ImageIcon, Download } from 'lucide-react';
import { Landmark, Wallet as WalletIcon, ArrowRight } from 'lucide-react';
import { BarChart, Bar, XAxis, YAxis, Tooltip as RechartsTooltip, ResponsiveContainer, CartesianGrid } from 'recharts';
import { cn } from '@/lib/utils';
import { toast } from 'sonner';
import { supabase } from '@/integrations/supabase/client';
import { formatDynamic as formatUGX } from '@/lib/currencyFormat';
import { CATEGORY_DESCRIPTIONS, LOCKED_CATEGORIES } from '@/lib/ledgerConstants';
import { downloadCsv } from '@/lib/csvExport';
import { useAuth } from '@/hooks/useAuth';
import jsPDF from 'jspdf';
import autoTable from 'jspdf-autotable';
import { Lock } from 'lucide-react';
import { HScrollHint, FOCUSABLE_COL_HEAD_CLASS, focusableColHeadProps } from './HScrollHint';

// ─────────────────────────────────────────────────────────────
// Canonical CFO category ordering. The CFO reads wallet movements
// in the same fixed order they appear on every other CFO report
// (LOCKED_CATEGORIES). Anything not in the canonical list is pushed
// to the end but still shown — we never silently drop a movement.
// ─────────────────────────────────────────────────────────────
const CFO_CATEGORY_RANK: Record<string, number> = Object.fromEntries(
  (LOCKED_CATEGORIES as readonly string[]).map((c, i) => [c, i]),
);
function cfoCategoryRank(category: string): number {
  return CFO_CATEGORY_RANK[category] ?? Number.MAX_SAFE_INTEGER;
}

// Roles allowed to drill into individual ledger entries and export raw movement data
const LEDGER_DETAIL_ROLES = new Set(['cfo', 'ceo', 'coo', 'super_admin', 'cto', 'manager']);

// ─────────────────────────────────────────────────────────────
// Periods & granularity
// ─────────────────────────────────────────────────────────────

type PeriodKey =
  | '24h' | 'today' | '7d' | '14d' | '30d' | '90d' | '120d' | '180d'
  | '1y' | 'ytd' | 'all';

const PERIODS: { value: PeriodKey; label: string }[] = [
  { value: '24h',    label: 'Rolling 24h' },
  { value: 'today',  label: 'Today' },
  { value: '7d',     label: '7 Days' },
  { value: '14d',    label: '14 Days' },
  { value: '30d',    label: '30 Days' },
  { value: '90d',    label: '3 Months' },
  { value: '120d',   label: '4 Months' },
  { value: '180d',   label: '6 Months' },
  { value: '1y',     label: '1 Year' },
  { value: 'ytd',    label: 'YTD' },
  { value: 'all',    label: 'All Time' },
];

type Granularity = 'daily' | 'weekly' | 'monthly';
const GRANULARITIES: { value: Granularity; label: string }[] = [
  { value: 'daily',   label: 'Daily' },
  { value: 'weekly',  label: 'Weekly' },
  { value: 'monthly', label: 'Monthly' },
];

// Every window except the explicit "Rolling 24h" option is CALENDAR-DAY
// aligned: its start is snapped to local midnight (startOfDay) so the CFO
// card reconciles exactly with the Tenant Ops dashboard, which counts rent
// "collected" per calendar day. "Rolling 24h" is the one deliberate rolling
// window and is labelled as such so it's never confused with "Today".
function periodRange(p: PeriodKey): { from: Date | null; to: Date } {
  const now = new Date();
  switch (p) {
    case '24h':   return { from: subDays(now, 1), to: now }; // rolling, intentional
    case 'today': return { from: startOfDay(now), to: now };
    case '7d':    return { from: startOfDay(subDays(now, 6)), to: now };
    case '14d':   return { from: startOfDay(subDays(now, 13)), to: now };
    case '30d':   return { from: startOfDay(subDays(now, 29)), to: now };
    case '90d':   return { from: startOfDay(subDays(now, 89)), to: now };
    case '120d':  return { from: startOfDay(subDays(now, 119)), to: now };
    case '180d':  return { from: startOfDay(subDays(now, 179)), to: now };
    case '1y':    return { from: startOfDay(subYears(now, 1)), to: now };
    case 'ytd':   return { from: startOfYear(now), to: now };
    case 'all':   return { from: null, to: now };
  }
}

function bucketKey(d: Date, g: Granularity): string {
  if (g === 'daily')   return format(startOfDay(d), 'yyyy-MM-dd');
  if (g === 'weekly')  return format(startOfWeek(d, { weekStartsOn: 1 }), "yyyy-'W'II");
  return format(startOfMonth(d), 'yyyy-MM');
}

// ─────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────

type LedgerRow = {
  id?: string;
  transaction_date: string;
  amount: number | string;
  direction: 'cash_in' | 'cash_out';
  category: string;
  ledger_scope: 'platform' | 'wallet' | 'bridge' | string;
  classification: string | null;
  reference_id?: string | null;
  description?: string | null;
  linked_party?: string | null;
  user_id?: string | null;
  transaction_group_id?: string | null;
  source_table?: string | null;
  source_id?: string | null;
};

type GroupKey = string; // `${category}|${ledger_scope}`

type Aggregate = {
  category: string;
  scope: string;
  cashIn: number;
  cashOut: number;
  net: number;
  count: number;
  buckets: Record<string, { in: number; out: number }>;
};

const SCOPE_LABEL: Record<string, string> = {
  platform: 'Company',
  wallet:   'User Wallets',
  bridge:   'Transfers',
};

const SCOPE_BADGE: Record<string, string> = {
  platform: 'bg-primary/10 text-primary border-primary/30',
  wallet:   'bg-amber-500/10 text-amber-600 border-amber-500/30',
  bridge:   'bg-purple-500/10 text-purple-600 border-purple-500/30',
};

function prettifyCategory(c: string): string {
  return c.replace(/_/g, ' ').replace(/\b\w/g, ch => ch.toUpperCase());
}

// ─────────────────────────────────────────────────────────────
// Friendly labels for the minimalist Wallet Money Movement panel.
// Maps raw ledger categories to plain-English descriptions of what
// physically moved in or out of a user/operational wallet.
// ─────────────────────────────────────────────────────────────
const WALLET_FLOW_LABEL_IN: Record<string, string> = {
  deposit: 'User & proxy-agent deposits',
  agent_float_deposit: 'Operational float deposits (agents)',
  landlord_float_deposit: 'Landlord float deposits (CFO)',
  rent_payment: 'Rent collected into agent float',
  partner_commission: 'Partner commissions credited',
  agent_commission: 'Agent commissions credited',
  business_advance_commission: 'Advance commissions credited',
  roi_payout: 'Returns paid to supporters',
  roi_wallet_credit: 'Returns paid to supporters',
  payroll: 'Payroll credited',
  payroll_growth: 'Payroll growth credited',
  tenant_placement_bonus: 'Tenant placement bonuses',
  system_balance_correction: 'Balance corrections (in)',
};
const WALLET_FLOW_LABEL_OUT: Record<string, string> = {
  // Withdrawals / cash leaving to EXTERNAL (not company)
  withdrawal: 'Personal wallet withdrawals',
  wallet_withdrawal: 'Personal wallet withdrawals',
  proxy_partner_withdrawal: 'Proxy partner withdrawals',
  agent_float_withdrawal: 'Agent float withdrawals',
  // Partner Ops sweeps & portfolio investments — money FROM wallet TO company
  partner_funding: 'Partner funding (proxy-agent wallet → company)',
  coo_proxy_investment: 'Partner Ops → Partner portfolio investment',
  proxy_investment_commission: 'Proxy investment commission swept',
  pending_portfolio_topup: 'Portfolio top-up (wallet → company)',
  // Angel Pool
  angel_pool_investment: 'Wallet → Angel Pool investment',
  // Advance auto-recovery (collected automatically from agent wallets → company)
  advance_recovery: 'Advance auto-recovery (wallet → company)',
  agent_repayment: 'Advance auto-recovery (agent wallet → company)',
  agent_advance_repayment: 'Advance auto-recovery (agent wallet → company)',
  salary_advance_repayment: 'Salary advance auto-recovery (wallet → company)',
  debt_recovery: 'Debt recovery (wallet → company)',
  // Float allocated / settled back to company
  agent_float_allocation: 'Rent payment for tenants (agent float → company)',
  agent_float_used_for_rent: 'Rent payment for tenants (agent float → company)',
  agent_float_settlement: 'Agent float settlement to company',
  agent_float_assignment: 'Agent float reassigned to company',
  agent_float_deposit: 'Agent float moved to company',
  // Rent repaid from wallet
  rent_repayment: 'Rent repaid from wallet (→ company)',
  tenant_repayment: 'Rent repaid from wallet (→ company)',
  tenant_repayment_collected: 'Rent collected by agent (→ company)',
  rent_payment_for_tenant: 'Rent payment for tenants (wallet → company)',
  // ROI reinvestment
  roi_reinvestment: 'ROI reinvestment (wallet → company)',
  // Commission used / adjusted
  agent_commission_used_for_rent: 'Commission used for rent (→ company)',
  agent_commission_earned: 'Agent commission adjustment (→ company)',
  // CFO direct debits / deductions
  wallet_deduction: 'CFO direct debit / wallet deduction',
  wallet_deduction_general_adjustment: 'CFO general adjustment debit',
  wallet_deduction_cash_payout_retraction: 'Cash payout retraction',
  // Transfers & deposits routed back
  wallet_transfer: 'Wallet-to-wallet transfer',
  wallet_deposit: 'Deposit routed to company',
  system_balance_correction: 'Balance corrections (out)',
};

// ─────────────────────────────────────────────────────────────
// Wallet → Company category groups (4 numbered buckets the CFO
// reads on the "From Wallets to Company" card).
// ─────────────────────────────────────────────────────────────
// Group 1 must reconcile EXACTLY with the "collected" figure on the Tenant
// Operations dashboard. That dashboard counts rent actually collected from
// tenants — the `rent_payment_for_tenant` leg (which mirrors `agent_collections`
// 1:1), plus the legacy `agent_float_used_for_rent` equivalent and the
// `tenant_repayment` / `rent_repayment` collection legs. It deliberately does
// NOT count agent float plumbing (assignment / settlement / allocation /
// commission-used-for-rent), which are float top-ups & reshuffles, not rent
// collected — including them previously inflated this group far above the
// dashboard's collected total.
const WALLET_TO_COMPANY_GROUP_1 = new Set([
  'rent_payment_for_tenant',
  'agent_float_used_for_rent',
  'rent_repayment',
  'tenant_repayment',
  'tenant_repayment_collected',
]);
const WALLET_TO_COMPANY_GROUP_2 = new Set([
  'partner_funding',
  'pending_portfolio_topup',
  'roi_reinvestment',
  'coo_proxy_investment',
  'proxy_investment_commission',
]);
const WALLET_TO_COMPANY_GROUP_3 = new Set([
  'advance_recovery',
  'agent_repayment',
  'agent_advance_repayment',
  'salary_advance_repayment',
  'debt_recovery',
]);
const WALLET_TO_COMPANY_GROUP_4 = new Set([
  'share_capital',
  'angel_pool_investment',
  'angel_pool_contribution',
  'angel_pool_topup',
]);
const WALLET_TO_COMPANY_GROUPS: { label: string; categories: Set<string>; color: string }[] = [
  { label: 'Rent payments for tenants (allocated by agents)', categories: WALLET_TO_COMPANY_GROUP_1, color: 'bg-emerald-500/10 text-emerald-600 border-emerald-500/20' },
  { label: 'Partner funding, top-ups, and reinvestments', categories: WALLET_TO_COMPANY_GROUP_2, color: 'bg-blue-500/10 text-blue-600 border-blue-500/20' },
  { label: 'Advance auto-recovery from agents who took Welile advances', categories: WALLET_TO_COMPANY_GROUP_3, color: 'bg-rose-500/10 text-rose-600 border-rose-500/20' },
  { label: 'Share capital (Angel Pool contributions)', categories: WALLET_TO_COMPANY_GROUP_4, color: 'bg-violet-500/10 text-violet-600 border-violet-500/20' },
];
// ─────────────────────────────────────────────────────────────
// Company → Wallets category groups (the numbered buckets the CFO
// reads on the "Company → Wallets" card). Every move of company money
// into a user/agent/employee wallet falls into one of these buckets;
// anything not mapped is shown under "Other" so nothing is dropped.
// ─────────────────────────────────────────────────────────────
// 1. Returns paid to supporters (or their proxy-agent wallets)
const COMPANY_TO_WALLETS_GROUP_1 = new Set([
  'roi_wallet_credit', 'roi_payout', 'roi_expense', 'supporter_platform_rewards', 'supporter_reward', 'investment_reward',
]);
// 2. Rent disbursed to landlords through agents' landlord-float wallets
const COMPANY_TO_WALLETS_GROUP_2 = new Set([
  'rent_disbursement', 'landlord_float_deposit', 'agent_landlord_float', 'landlord_float_allocation', 'landlord_payout',
]);
// 3. Advances disbursed to wallets of different users (especially agents)
const COMPANY_TO_WALLETS_GROUP_3 = new Set([
  'agent_advance_credit', 'business_advance_disbursement', 'business_advance_credit', 'credit_draw', 'credit_access_draw', 'employee_advance', 'salary_advance',
]);
// 4. Agent commissions & all other agent earnings (auto + manual)
const COMPANY_TO_WALLETS_GROUP_4 = new Set([
  'agent_commission_earned', 'agent_commission', 'agent_commission_payout', 'partner_commission', 'business_advance_commission',
  'referral_bonus', 'tenant_placement_bonus', 'recruiter_override', 'agent_incentive_bonus', 'agent_event_bonus',
]);
// 5. Marketing expenses sent to wallets by CFO
const COMPANY_TO_WALLETS_GROUP_5 = new Set(['marketing_expense']);
// 6. Operational expenses paid by CFO to different wallets
const COMPANY_TO_WALLETS_GROUP_6 = new Set(['general_admin_expense', 'operational_expenses']);
// 7. Payroll paid to employee wallets
const COMPANY_TO_WALLETS_GROUP_7 = new Set(['payroll_expense', 'payroll', 'salary_payment', 'salary_payout', 'payroll_growth']);
// 8. Tax payments paid to wallets
const COMPANY_TO_WALLETS_GROUP_8 = new Set(['tax_expense']);
// 9. Research & Development paid to wallets by CFO
const COMPANY_TO_WALLETS_GROUP_9 = new Set(['research_development_expense']);
// 10. Equipment & asset purchases paid to specific wallets by CFO
const COMPANY_TO_WALLETS_GROUP_10 = new Set(['equipment_expense']);
// 11. Agent float allocations & corrections by CFO to agent wallets
const COMPANY_TO_WALLETS_GROUP_11 = new Set([
  'agent_float_deposit', 'agent_float_assignment', 'agent_float_allocation', 'agent_float_settlement',
]);
// Wallet-leg categories that carry no economic meaning on their own. When a
// wallet cash_in leg uses one of these, the real purpose of the money lives on
// the paired platform cash_out leg, so we bucket by the platform category.
const GENERIC_WALLET_CATEGORIES = new Set([
  'wallet_deposit', 'wallet_credit', 'system_balance_correction', 'balance_correction', 'wallet_transfer',
]);
// Some disbursements (notably credit access draws & advances) post BOTH the
// wallet and platform legs under the generic `wallet_deposit` category, so the
// economic purpose can't be recovered from the category alone. In those cases
// the originating `source_table` tells us what really moved — map it back to the
// canonical category so the money lands in the correct Company → Wallets group
// instead of silently falling into "Other".
const SOURCE_TABLE_CATEGORY: Record<string, string> = {
  credit_access_draws: 'credit_access_draw',
  business_advances: 'business_advance_disbursement',
  agent_advances: 'agent_advance_credit',
};
const COMPANY_TO_WALLETS_GROUPS: { label: string; categories: Set<string>; color: string }[] = [
  { label: 'Returns paid to Supporters (and their proxy-agent wallets)', categories: COMPANY_TO_WALLETS_GROUP_1, color: 'bg-emerald-500/10 text-emerald-600 border-emerald-500/20' },
  { label: 'Rent disbursed to landlords via agent landlord-float wallets', categories: COMPANY_TO_WALLETS_GROUP_2, color: 'bg-blue-500/10 text-blue-600 border-blue-500/20' },
  { label: 'Advances disbursed to user wallets (especially agents)', categories: COMPANY_TO_WALLETS_GROUP_3, color: 'bg-rose-500/10 text-rose-600 border-rose-500/20' },
  { label: 'Agent commissions & all other agent earnings (auto + manual)', categories: COMPANY_TO_WALLETS_GROUP_4, color: 'bg-amber-500/10 text-amber-600 border-amber-500/20' },
  { label: 'Marketing expenses sent to wallets by CFO', categories: COMPANY_TO_WALLETS_GROUP_5, color: 'bg-pink-500/10 text-pink-600 border-pink-500/20' },
  { label: 'Operational expenses paid by CFO to wallets', categories: COMPANY_TO_WALLETS_GROUP_6, color: 'bg-slate-500/10 text-muted-foreground border-slate-500/20' },
  { label: 'Payroll paid to employee wallets', categories: COMPANY_TO_WALLETS_GROUP_7, color: 'bg-indigo-500/10 text-indigo-600 border-indigo-500/20' },
  { label: 'Tax payments paid to wallets', categories: COMPANY_TO_WALLETS_GROUP_8, color: 'bg-orange-500/10 text-orange-600 border-orange-500/20' },
  { label: 'Research & Development paid to wallets', categories: COMPANY_TO_WALLETS_GROUP_9, color: 'bg-cyan-500/10 text-cyan-600 border-cyan-500/20' },
  { label: 'Equipment & asset purchases paid to wallets', categories: COMPANY_TO_WALLETS_GROUP_10, color: 'bg-teal-500/10 text-teal-600 border-teal-500/20' },
  { label: 'Agent float allocations & corrections by CFO', categories: COMPANY_TO_WALLETS_GROUP_11, color: 'bg-violet-500/10 text-violet-600 border-violet-500/20' },
];
// Wallet-origin categories that are UNAMBIGUOUSLY money moving into the
// company ("money we have"), regardless of how the transaction group is
// paired. Agent rent allocations move agent operational float (a wallet
// cash_out) into the company — sometimes against a bridge rent-receivable
// leg, sometimes as a wallet-only float settlement with no platform/bridge
// cash_in leg at all. We must NEVER drop these: every agent rent allocation
// is company money and belongs on the "From Wallets to Company" card.
const ALWAYS_WALLET_TO_COMPANY = new Set<string>([
  // Rent collected for tenants out of agent float (Group 1). Mirror the
  // Tenant Ops dashboard "collected" definition exactly: only the rent
  // payment legs — never the float plumbing categories (assignment /
  // settlement / allocation / commission-used-for-rent).
  'rent_payment_for_tenant',
  'agent_float_used_for_rent',
  'rent_repayment',
  'tenant_repayment',
  'tenant_repayment_collected',
  // Advance auto-recovery pulled straight from agent wallets (Group 3)
  'advance_recovery',
  'agent_repayment',
  'agent_advance_repayment',
  'salary_advance_repayment',
  'debt_recovery',
]);
function friendlyWalletLabel(category: string, direction: 'cash_in' | 'cash_out'): string {
  const map = direction === 'cash_in' ? WALLET_FLOW_LABEL_IN : WALLET_FLOW_LABEL_OUT;
  return map[category] || prettifyCategory(category);
}

// Best-effort friendly label for a category when the direction is known
// (e.g. from a single movement row). Falls back to prettifyCategory.
function categoryFriendlyLabel(category: string, direction?: 'cash_in' | 'cash_out'): string {
  if (direction) return friendlyWalletLabel(category, direction);
  // Try outbound first (most categories are wallet→company), then inbound
  return WALLET_FLOW_LABEL_OUT[category] || WALLET_FLOW_LABEL_IN[category] || prettifyCategory(category);
}

// Determine the dominant direction in a list of movements so the category
// group header can pick the correct friendly label subtitle.
function dominantDirection(items: { direction: 'cash_in' | 'cash_out' }[]): 'cash_in' | 'cash_out' {
  let ins = 0;
  for (const i of items) if (i.direction === 'cash_in') ins++;
  return ins >= items.length / 2 ? 'cash_in' : 'cash_out';
}

// ─────────────────────────────────────────────────────────────
// Wallet-impact map — explains which wallet buckets move (or don't)
// when a Capital Inflows category posts. The Comprehensive view shows
// the PLATFORM cash_in leg only; the wallet effect is the *paired*
// movement on the related user/operational wallet (if any).
// ─────────────────────────────────────────────────────────────
type WalletImpact = {
  moves: { bucket: 'withdrawable_balance' | 'float_balance' | 'advance_balance' | 'portfolio_principal'; party: string; direction: '↑' | '↓'; note?: string }[];
  unchanged: ('withdrawable_balance' | 'float_balance' | 'advance_balance')[];
  summary: string;
};
const WALLET_IMPACT: Record<string, WalletImpact> = {
  partner_funding: {
    summary: 'Partner sweeps proxy-agent float into platform capital. No user withdrawable bucket moves.',
    moves: [
      { bucket: 'float_balance', party: 'Proxy agent', direction: '↓', note: 'Source of the swept capital' },
    ],
    unchanged: ['withdrawable_balance', 'advance_balance'],
  },
  pending_portfolio_topup: {
    summary: 'Supporter top-up parked on platform until CFO/COO clicks "Apply Top-up". No wallet bucket moves yet.',
    moves: [
      { bucket: 'portfolio_principal', party: 'Supporter (on merge)', direction: '↑', note: 'Only after Apply Top-up; ROI accrues from merge date' },
    ],
    unchanged: ['withdrawable_balance', 'float_balance', 'advance_balance'],
  },
  partner_commission: {
    summary: '2% instant commission to partner on a proxy-agent deposit. Credited as withdrawable cash.',
    moves: [
      { bucket: 'withdrawable_balance', party: 'Partner', direction: '↑' },
    ],
    unchanged: ['float_balance', 'advance_balance'],
  },
  deposit: {
    summary: 'User cash/MoMo deposit. Routes by recipient_type (Wallet Routing v2).',
    moves: [
      { bucket: 'withdrawable_balance', party: 'User (recipient_type=user)', direction: '↑' },
      { bucket: 'float_balance', party: 'Operational wallet (recipient_type=operational_wallet)', direction: '↑' },
    ],
    unchanged: ['advance_balance'],
  },
  rent_payment: {
    summary: 'Tenant rent collected by an agent. Platform recognizes revenue; agent commission posts separately.',
    moves: [
      { bucket: 'float_balance', party: 'Collecting agent', direction: '↑', note: 'Company money; not withdrawable' },
      { bucket: 'withdrawable_balance', party: 'Agent (10% commission, separate txn)', direction: '↑' },
    ],
    unchanged: ['advance_balance'],
  },
  roi_payout: {
    summary: 'Returns paid to supporter — credited as withdrawable cash on the supporter wallet.',
    moves: [
      { bucket: 'withdrawable_balance', party: 'Supporter', direction: '↑' },
    ],
    unchanged: ['float_balance', 'advance_balance'],
  },
};
const DEFAULT_WALLET_IMPACT: WalletImpact = {
  summary: 'Platform-scope cash_in leg. Wallet bucket impact depends on the paired transaction (recipient_type per Wallet Routing v2). No automatic withdrawable credit from this category alone.',
  moves: [],
  unchanged: ['withdrawable_balance', 'float_balance', 'advance_balance'],
};
function getWalletImpact(category: string): WalletImpact {
  return WALLET_IMPACT[category] || DEFAULT_WALLET_IMPACT;
}
function WalletImpactTooltipContent({ category }: { category: string }) {
  const impact = getWalletImpact(category);
  return (
    <div className="max-w-[300px] space-y-2 text-[11px]">
      <div className="font-semibold text-foreground">{prettifyCategory(category)} · Wallet Impact</div>
      <div className="text-muted-foreground leading-snug">{impact.summary}</div>
      {impact.moves.length > 0 && (
        <div className="space-y-1">
          <div className="text-[10px] uppercase tracking-wider text-muted-foreground">Buckets that move</div>
          {impact.moves.map((m, i) => (
            <div key={i} className="flex items-start gap-1.5">
              <span className={cn('font-mono font-semibold', m.direction === '↑' ? 'text-emerald-500' : 'text-rose-500')}>{m.direction}</span>
              <div className="flex-1">
                <div><span className="font-mono">{m.bucket}</span> <span className="text-muted-foreground">— {m.party}</span></div>
                {m.note && <div className="text-[10px] text-muted-foreground italic">{m.note}</div>}
              </div>
            </div>
          ))}
        </div>
      )}
      {impact.unchanged.length > 0 && (
        <div className="space-y-1 pt-1 border-t border-border">
          <div className="text-[10px] uppercase tracking-wider text-muted-foreground">Unchanged</div>
          <div className="flex flex-wrap gap-1">
            {impact.unchanged.map(b => (
              <span key={b} className="font-mono text-[10px] rounded bg-muted px-1 py-0.5 text-muted-foreground">{b}</span>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// Highlight occurrences of `query` inside `text` (case-insensitive). Used to
// surface drill-down search matches in the ledger table cells.
function escapeRegex(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
function Highlight({ text, query }: { text: string | null | undefined; query: string }) {
  const value = text ?? '';
  const q = query.trim();
  if (!q || !value) return <>{value}</>;
  const parts = value.split(new RegExp(`(${escapeRegex(q)})`, 'ig'));
  const lower = q.toLowerCase();
  return (
    <>
      {parts.map((part, i) =>
        part.toLowerCase() === lower
          ? <mark key={i} className="bg-primary/20 text-primary rounded-sm px-0.5">{part}</mark>
          : <span key={i}>{part}</span>
      )}
    </>
  );
}

// ─────────────────────────────────────────────────────────────
// Component
// ─────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────
// Treasury ⇄ Wallets — the headline movement report.
// Two flows the CFO cares about most, derived purely from the
// double-entry ledger (no extra DB reads beyond name resolution):
//   1. Company → Wallets : the CFO funding wallets out of "money we
//      have" (a wallet cash_in leg paired with a platform cash_out leg
//      in the same transaction group).
//   2. Wallets → Company : agents allocating money out of their wallets
//      back into "money we have" (a wallet cash_out leg paired with a
//      platform cash_in leg).
// Pure deposits / withdrawals (where both legs move the same direction)
// are intentionally excluded — they are not internal treasury transfers.
// ─────────────────────────────────────────────────────────────
type TreasuryFlowItem = { amount: number; category: string; party: string | null; date: string; count?: number };
function summarizeTreasuryFlow(
  items: TreasuryFlowItem[],
  groupDefs: { label: string; categories: Set<string>; color: string }[] = WALLET_TO_COMPANY_GROUPS,
) {
  const total = items.reduce((s, i) => s + i.amount, 0);
  const byCat = new Map<string, { amount: number; count: number }>();
  const byParty = new Map<string, { amount: number; count: number }>();
  const byGroup = new Map<string, { amount: number; count: number }>();
  for (const i of items) {
    const transferCount = i.count ?? 1;
    const c = byCat.get(i.category) || { amount: 0, count: 0 };
    c.amount += i.amount; c.count += transferCount; byCat.set(i.category, c);
    if (i.party) {
      const p = byParty.get(i.party) || { amount: 0, count: 0 };
      p.amount += i.amount; p.count += transferCount; byParty.set(i.party, p);
    }
    // Bucket into the provided numbered groups (Company → Wallets or Wallets → Company)
    for (const g of groupDefs) {
      if (g.categories.has(i.category)) {
        const existing = byGroup.get(g.label) || { amount: 0, count: 0 };
        existing.amount += i.amount; existing.count += transferCount; byGroup.set(g.label, existing);
        break;
      }
    }
  }
  return {
    total,
    count: items.reduce((sum, item) => sum + (item.count ?? 1), 0),
    // Ordered by the canonical CFO category sequence (LOCKED_CATEGORIES),
    // falling back to amount for any non-canonical categories so the CFO
    // always reads movements in a predictable, familiar order.
    cats: [...byCat.entries()].sort((a, b) => {
      const ra = cfoCategoryRank(a[0]);
      const rb = cfoCategoryRank(b[0]);
      if (ra !== rb) return ra - rb;
      return b[1].amount - a[1].amount;
    }),
    parties: [...byParty.entries()].sort((a, b) => b[1].amount - a[1].amount),
    groups: [...byGroup.entries()].sort((a, b) => b[1].amount - a[1].amount),
  };
}

// ─────────────────────────────────────────────────────────────
// Filterable drilldown for the "Other (not in groups 1–4)" bucket.
// Lets the CFO narrow the unmapped wallet-origin transactions by a
// date range and a user/wallet search so they can trace exactly where
// each uncategorized movement came from. Works on the raw flow items
// (not the pre-aggregated category totals) so individual transactions
// are visible per category.
// ─────────────────────────────────────────────────────────────
function OtherWalletOriginDrilldown({
  items,
  otherTotal,
  direction,
  initialNames,
}: {
  items: TreasuryFlowItem[];
  otherTotal: number;
  direction: 'cash_in' | 'cash_out';
  initialNames: Record<string, string>;
}) {
  const [open, setOpen] = useState(false);
  const [fromDate, setFromDate] = useState('');
  const [toDate, setToDate] = useState('');
  const [userQuery, setUserQuery] = useState('');
  const [names, setNames] = useState<Record<string, string>>(initialNames);

  useEffect(() => {
    setNames(prev => ({ ...initialNames, ...prev }));
  }, [initialNames]);

  // Resolve names for every party that appears in the "Other" bucket so the
  // user/wallet search can match on full names (not just ids).
  useEffect(() => {
    if (!open) return;
    const ids = Array.from(new Set(
      items.map(i => i.party).filter((id): id is string => !!id && !names[id]),
    ));
    if (!ids.length) return;
    let cancelled = false;
    (async () => {
      const { data } = await supabase.from('profiles').select('id, full_name').in('id', ids);
      if (cancelled || !data) return;
      const next: Record<string, string> = {};
      for (const p of data as { id: string; full_name: string | null }[]) {
        if (p.full_name) next[p.id] = p.full_name;
      }
      if (Object.keys(next).length) setNames(prev => ({ ...prev, ...next }));
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, items]);

  const nameOf = (id: string | null) => (id ? names[id] || `${id.slice(0, 8)}…` : 'Unknown wallet');

  const filtered = useMemo(() => {
    const q = userQuery.trim().toLowerCase();
    return items.filter(i => {
      const day = (i.date || '').slice(0, 10);
      if (fromDate && day < fromDate) return false;
      if (toDate && day > toDate) return false;
      if (q) {
        const id = (i.party || '').toLowerCase();
        const nm = (i.party ? names[i.party] || '' : '').toLowerCase();
        if (!id.includes(q) && !nm.includes(q)) return false;
      }
      return true;
    });
  }, [items, fromDate, toDate, userQuery, names]);

  const filteredTotal = filtered.reduce((s, i) => s + i.amount, 0);

  // Group filtered items by category, then keep the individual contributing
  // transactions so the CFO can see the user/wallet + date behind each.
  const byCategory = useMemo(() => {
    const map = new Map<string, { amount: number; items: TreasuryFlowItem[] }>();
    for (const i of filtered) {
      const c = map.get(i.category) || { amount: 0, items: [] };
      c.amount += i.amount; c.items.push(i); map.set(i.category, c);
    }
    return [...map.entries()]
      .map(([cat, v]) => ({
        cat,
        amount: v.amount,
        items: [...v.items].sort((a, b) => (b.date || '').localeCompare(a.date || '')),
      }))
      .sort((a, b) => b.amount - a.amount);
  }, [filtered]);

  const hasFilters = !!(fromDate || toDate || userQuery.trim());

  return (
    <Collapsible open={open} onOpenChange={setOpen} className="space-y-1">
      <CollapsibleTrigger asChild>
        <button type="button" className="w-full flex items-center justify-between gap-2 text-[12px] group">
          <span className="truncate text-muted-foreground italic group-hover:text-foreground transition-colors">Other (not in groups 1–4)</span>
          <span className="inline-flex items-center gap-1">
            <span className="font-mono font-medium shrink-0 text-muted-foreground">{formatUGX(otherTotal)}</span>
            <ChevronDown className="h-3 w-3 text-muted-foreground group-data-[state=open]:rotate-180 transition-transform" />
          </span>
        </button>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="pl-3 space-y-2 border-l-2 border-border pt-1">
          {/* Filters */}
          <div className="grid grid-cols-2 gap-1.5">
            <label className="space-y-0.5">
              <span className="text-[9px] uppercase tracking-wider text-muted-foreground">From</span>
              <Input type="date" value={fromDate} max={toDate || undefined} onChange={e => setFromDate(e.target.value)} className="h-7 text-[11px] px-2" />
            </label>
            <label className="space-y-0.5">
              <span className="text-[9px] uppercase tracking-wider text-muted-foreground">To</span>
              <Input type="date" value={toDate} min={fromDate || undefined} onChange={e => setToDate(e.target.value)} className="h-7 text-[11px] px-2" />
            </label>
          </div>
          <div className="relative">
            <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3 w-3 text-muted-foreground" />
            <Input
              value={userQuery}
              onChange={e => setUserQuery(e.target.value)}
              placeholder="Filter by user / wallet (name or id)"
              className="h-7 text-[11px] pl-7 pr-2"
            />
          </div>
          <div className="flex items-center justify-between gap-2">
            <span className="text-[10px] text-muted-foreground">
              {filtered.length.toLocaleString()} txn{filtered.length === 1 ? '' : 's'} · <span className="font-mono">{formatUGX(filteredTotal)}</span>
            </span>
            {hasFilters && (
              <button
                type="button"
                onClick={() => { setFromDate(''); setToDate(''); setUserQuery(''); }}
                className="text-[10px] text-primary hover:underline inline-flex items-center gap-0.5"
              >
                <X className="h-2.5 w-2.5" /> Clear
              </button>
            )}
          </div>

          {/* Per-category contributions with the individual transactions */}
          {byCategory.length === 0 ? (
            <p className="text-[11px] text-muted-foreground italic">No transactions match these filters.</p>
          ) : (
            <div className="space-y-2 max-h-64 overflow-y-auto pr-1">
              {byCategory.map(group => (
                <div key={group.cat} className="space-y-0.5">
                  <div className="flex items-center justify-between gap-2 text-[11px] font-medium">
                    <span className="truncate text-foreground/90">{friendlyWalletLabel(group.cat, direction)}</span>
                    <span className="font-mono shrink-0">{formatUGX(group.amount)}</span>
                  </div>
                  <div className="pl-2 space-y-0.5 border-l border-border/60">
                    {group.items.map((it, idx) => (
                      <div key={`${group.cat}-${idx}`} className="flex items-center justify-between gap-2 text-[10px] text-muted-foreground">
                        <span className="truncate">
                          {nameOf(it.party)}
                          <span className="opacity-60"> · {it.date ? format(new Date(it.date), 'dd MMM yyyy') : '—'}</span>
                        </span>
                        <span className="font-mono shrink-0">{formatUGX(it.amount)}</span>
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

// ─────────────────────────────────────────────────────────────
// Per-group drilldown for the "From Wallets to Company" card.
// Opens from any of the 4 numbered groups (or the headline) and shows
// the contributing transactions broken down PER PERIOD (day / week /
// month) so the CFO can trace exactly when each chunk of company money
// arrived. Also supports a user/wallet filter.
// ─────────────────────────────────────────────────────────────
function GroupPeriodDrilldown({
  open,
  onOpenChange,
  label,
  color,
  direction,
  items,
  initialNames,
  expectedTotal,
  expectedCount,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  label: string;
  color: string;
  direction: 'cash_in' | 'cash_out';
  items: TreasuryFlowItem[];
  initialNames: Record<string, string>;
  expectedTotal: number;
  expectedCount: number;
}) {
  const [gran, setGran] = useState<Granularity>('daily');
  const [userQuery, setUserQuery] = useState('');
  const [names, setNames] = useState<Record<string, string>>(initialNames);
  const [expanded, setExpanded] = useState<string | null>(null);

  useEffect(() => {
    setNames(prev => ({ ...initialNames, ...prev }));
  }, [initialNames]);

  // Resolve party names for every wallet in this group so the search and
  // the per-transaction rows show real names instead of raw ids.
  useEffect(() => {
    if (!open) return;
    const ids = Array.from(new Set(
      items.map(i => i.party).filter((id): id is string => !!id && !names[id]),
    ));
    if (!ids.length) return;
    let cancelled = false;
    (async () => {
      const { data } = await supabase.from('profiles').select('id, full_name').in('id', ids);
      if (cancelled || !data) return;
      const next: Record<string, string> = {};
      for (const p of data as { id: string; full_name: string | null }[]) {
        if (p.full_name) next[p.id] = p.full_name;
      }
      if (Object.keys(next).length) setNames(prev => ({ ...prev, ...next }));
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, items]);

  const nameOf = (id: string | null) => (id ? names[id] || `${id.slice(0, 8)}…` : 'Unknown wallet');

  const filtered = useMemo(() => {
    const q = userQuery.trim().toLowerCase();
    if (!q) return items;
    return items.filter(i => {
      const id = (i.party || '').toLowerCase();
      const nm = (i.party ? names[i.party] || '' : '').toLowerCase();
      return id.includes(q) || nm.includes(q);
    });
  }, [items, userQuery, names]);

  const total = filtered.reduce((s, i) => s + i.amount, 0);

  const totalMatches = Math.abs(total - expectedTotal) < 0.01;
  const countMatches = filtered.length === expectedCount;

  // Bucket transactions by the selected period granularity.
  const periods = useMemo(() => {
    const map = new Map<string, { key: string; label: string; sortKey: string; amount: number; items: TreasuryFlowItem[] }>();
    for (const i of filtered) {
      const d = i.date ? new Date(i.date) : null;
      let key: string; let lbl: string; let sk: string;
      if (!d || Number.isNaN(d.getTime())) {
        key = 'unknown'; lbl = 'Unknown date'; sk = '';
      } else if (gran === 'daily') {
        key = format(startOfDay(d), 'yyyy-MM-dd'); lbl = format(d, 'EEE, dd MMM yyyy'); sk = key;
      } else if (gran === 'weekly') {
        const w = startOfWeek(d, { weekStartsOn: 1 });
        key = format(w, 'yyyy-MM-dd'); lbl = `Week of ${format(w, 'dd MMM yyyy')}`; sk = key;
      } else {
        const m = startOfMonth(d);
        key = format(m, 'yyyy-MM'); lbl = format(m, 'MMMM yyyy'); sk = key;
      }
      const e = map.get(key) || { key, label: lbl, sortKey: sk, amount: 0, items: [] };
      e.amount += i.amount; e.items.push(i); map.set(key, e);
    }
    return [...map.values()]
      .map(p => ({ ...p, items: [...p.items].sort((a, b) => (b.date || '').localeCompare(a.date || '')) }))
      .sort((a, b) => b.sortKey.localeCompare(a.sortKey));
  }, [filtered, gran]);

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-full sm:max-w-lg flex flex-col gap-0 p-0">
        <SheetHeader className="p-4 pb-3 border-b border-border space-y-1">
          <SheetTitle className="text-base leading-snug pr-6">{label}</SheetTitle>
          <SheetDescription className="text-[12px]">
            {direction === 'cash_out'
              ? 'Money moving from wallets into company funds, broken down per period.'
              : 'Money moving from company funds into wallets, broken down per period.'}
          </SheetDescription>
        </SheetHeader>

        <div className="p-4 space-y-3 overflow-y-auto flex-1">
          {/* Headline total */}
          <div className={cn('rounded-xl border p-3', color)}>
            <p className="text-[10px] uppercase tracking-wider font-bold opacity-80">Total in this period</p>
            <p className="text-2xl font-bold font-mono tracking-tight">{formatUGX(total)}</p>
            <p className="text-[11px] opacity-80">{filtered.length.toLocaleString()} transaction{filtered.length === 1 ? '' : 's'} · {periods.length} period{periods.length === 1 ? '' : 's'}</p>

            {/* Reconciliation indicator */}
            {totalMatches && countMatches ? (
              <div className="mt-2 inline-flex items-center gap-1.5 rounded-lg bg-emerald-600/10 border border-emerald-500/20 px-2.5 py-1">
                <Check className="h-3.5 w-3.5 text-emerald-600" />
                <span className="text-[11px] font-semibold text-emerald-700">Reconciled — matches card breakdown</span>
              </div>
            ) : (
              <div className="mt-2 inline-flex flex-col gap-1 rounded-lg bg-amber-500/10 border border-amber-500/20 px-2.5 py-1.5">
                <div className="flex items-center gap-1.5">
                  <AlertTriangle className="h-3.5 w-3.5 text-amber-600" />
                  <span className="text-[11px] font-semibold text-amber-700">Does not match card breakdown</span>
                </div>
                <div className="text-[10px] text-amber-700/80 space-y-0.5">
                  {!totalMatches && (
                    <p>Total: card {formatUGX(expectedTotal)} vs drill {formatUGX(total)} (Δ {formatUGX(Math.abs(expectedTotal - total))})</p>
                  )}
                  {!countMatches && (
                    <p>Count: card {expectedCount.toLocaleString()} vs drill {filtered.length.toLocaleString()} (Δ {Math.abs(expectedCount - filtered.length).toLocaleString()})</p>
                  )}
                </div>
              </div>
            )}
          </div>

          {/* Granularity toggle */}
          <div className="flex items-center justify-between gap-2">
            <span className="text-[11px] uppercase tracking-wider text-muted-foreground font-semibold">Per period</span>
            <div className="inline-flex items-center gap-1 bg-muted rounded-lg p-0.5">
              {GRANULARITIES.map(g => (
                <button
                  key={g.value}
                  type="button"
                  onClick={() => setGran(g.value)}
                  className={cn(
                    'px-2 py-0.5 rounded-md text-[10px] font-semibold transition-colors',
                    gran === g.value ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground',
                  )}
                >
                  {g.label}
                </button>
              ))}
            </div>
          </div>

          {/* User / wallet filter */}
          <div className="relative">
            <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
            <Input
              value={userQuery}
              onChange={e => setUserQuery(e.target.value)}
              placeholder="Filter by user / wallet (name or id)"
              className="h-8 text-[12px] pl-7 pr-7"
            />
            {userQuery && (
              <button type="button" onClick={() => setUserQuery('')} className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground">
                <X className="h-3.5 w-3.5" />
              </button>
            )}
          </div>

          {/* Per-period rows, each expandable to its transactions */}
          {periods.length === 0 ? (
            <p className="text-[12px] text-muted-foreground italic">No transactions match this filter.</p>
          ) : (
            <div className="space-y-1.5">
              {periods.map(p => {
                const isOpen = expanded === p.key;
                const pct = total > 0 ? Math.round((p.amount / total) * 100) : 0;
                return (
                  <div key={p.key} className="rounded-lg border border-border overflow-hidden">
                    <button
                      type="button"
                      onClick={() => setExpanded(isOpen ? null : p.key)}
                      className="w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-muted/50 transition-colors"
                    >
                      <ChevronRight className={cn('h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform', isOpen && 'rotate-90')} />
                      <div className="min-w-0 flex-1">
                        <p className="text-[12px] font-semibold truncate">{p.label}</p>
                        <p className="text-[10px] text-muted-foreground">{p.items.length} txn{p.items.length === 1 ? '' : 's'} · {pct}% of total</p>
                      </div>
                      <span className="text-[13px] font-mono font-bold shrink-0">{formatUGX(p.amount)}</span>
                    </button>
                    {isOpen && (
                      <div className="border-t border-border bg-muted/20 px-3 py-2 space-y-1 max-h-60 overflow-y-auto">
                        {p.items.map((it, idx) => (
                          <div key={`${p.key}-${idx}`} className="flex items-center justify-between gap-2 text-[11px]">
                            <span className="truncate text-foreground/90">
                              {nameOf(it.party)}
                              <span className="text-muted-foreground"> · {friendlyWalletLabel(it.category, direction)}</span>
                              <span className="text-muted-foreground opacity-70"> · {it.date ? format(new Date(it.date), 'dd MMM HH:mm') : '—'}</span>
                            </span>
                            <span className="font-mono font-medium shrink-0">{formatUGX(it.amount)}</span>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}

function TreasuryWalletFlowSummary({
  rows,
  includeAdjustments,
  periodFrom,
  onDrill,
}: {
  rows: LedgerRow[];
  includeAdjustments: boolean;
  periodFrom: string | null;
  onDrill?: (direction: 'cash_in' | 'cash_out', scope: 'wallet') => void;
}) {
  const [names, setNames] = useState<Record<string, string>>({});
  const [groupDrill, setGroupDrill] = useState<
    { label: string; color: string; direction: 'cash_in' | 'cash_out'; items: TreasuryFlowItem[]; expectedTotal: number; expectedCount: number } | null
  >(null);
  // CFO toggle: hide today's movements so the cards show only settled/prior-day flow.
  const [excludeToday, setExcludeToday] = useState(false);
  // CFO date-range filter: limit cash movements to a chosen window (inclusive).
  const [dateFrom, setDateFrom] = useState<Date | undefined>(undefined);
  const [dateTo, setDateTo] = useState<Date | undefined>(undefined);
  // Compare the selected window against the immediately preceding equal-length window.
  const [compareEnabled, setCompareEnabled] = useState(false);

  const [summaryItems, setSummaryItems] = useState<{
    toWallets: TreasuryFlowItem[];
    toCompany: TreasuryFlowItem[];
  } | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const { data, error } = await supabase.rpc('get_cfo_treasury_wallet_flow_summary_json', {
        p_from: periodFrom,
        p_include_adjustments: includeAdjustments,
      });
      if (cancelled) return;
      if (error) {
        console.error('[CashMovement] treasury summary failed', error);
        setSummaryItems(null);
        return;
      }
      const next = { toWallets: [] as TreasuryFlowItem[], toCompany: [] as TreasuryFlowItem[] };
      for (const row of (Array.isArray(data) ? data : []) as Array<Record<string, unknown>>) {
        const item: TreasuryFlowItem = {
          amount: Number(row.amount) || 0,
          category: String(row.category || 'other'),
          party: row.party ? String(row.party) : null,
          date: String(row.transaction_date),
          count: Number(row.transfer_count) || 0,
        };
        if (row.flow_direction === 'to_wallets') next.toWallets.push(item);
        else next.toCompany.push(item);
      }
      setSummaryItems(next);
    })();
    return () => { cancelled = true; };
  }, [periodFrom, includeAdjustments]);

  const { toWallets, toCompany } = useMemo(() => {
    const groups = new Map<string, LedgerRow[]>();
    for (const r of rows) {
      if (!includeAdjustments && (r.classification === 'admin_correction' || r.category === 'system_balance_correction')) continue;
      const gid = r.transaction_group_id;
      if (!gid) continue;
      const arr = groups.get(gid) || [];
      arr.push(r);
      groups.set(gid, arr);
    }
    const toWallets: TreasuryFlowItem[] = [];
    const toCompany: TreasuryFlowItem[] = [];
    for (const legs of groups.values()) {
      const platformLegs = legs.filter(l => l.ledger_scope === 'platform');
      const walletLegs = legs.filter(l => l.ledger_scope === 'wallet');
      const bridgeLegs = legs.filter(l => l.ledger_scope === 'bridge');
      // Rent disbursed to landlords funds an agent landlord-float account,
      // which this ledger records as platform cash_out → bridge cash_in
      // (rent_receivable_created) with NO wallet leg. The landlord float IS the
      // destination "wallet" the CFO funds, so surface these in Company →
      // Wallets (bucket 2) even though there is no wallet-scope leg.
      if (!walletLegs.length) {
        for (const p of platformLegs) {
          if (p.direction !== 'cash_out') continue;
          if (!COMPANY_TO_WALLETS_GROUP_2.has(p.category)) continue;
          const amt = Number(p.amount) || 0;
          if (amt) toWallets.push({ amount: amt, category: p.category, party: p.user_id ?? null, date: p.transaction_date });
        }
        continue;
      }
      if (!platformLegs.length && !bridgeLegs.length) continue;
      const hasPlatformOut = platformLegs.some(p => p.direction === 'cash_out');
      const hasPlatformIn = platformLegs.some(p => p.direction === 'cash_in');
      // The wallet leg of a CFO manual disbursement (payroll, marketing,
      // operational, tax, R&D, equipment...) is posted with a generic
      // category like `wallet_deposit`, while the *economic purpose* lives on
      // the paired platform cash_out leg. To bucket those correctly we fall
      // back to the platform cash_out category whenever the wallet category is
      // uninformative; otherwise the meaningful wallet category wins.
      const platformOutCategory = platformLegs.find(p => p.direction === 'cash_out')?.category;
      // Rent allocations move agent float (wallet cash_out) into a rent
      // receivable (bridge cash_in: rent_receivable_created) rather than a
      // platform cash_in leg. Treat a bridge cash_in as "money into company"
      // so agent rent allocations are counted in the Wallets → Company flow.
      const hasBridgeIn = bridgeLegs.some(b => b.direction === 'cash_in');
      for (const w of walletLegs) {
        const amt = Number(w.amount) || 0;
        if (!amt) continue;
        // Rent allocations & advance recoveries are always company money,
        // even when the group has no platform/bridge cash_in leg (e.g. a
        // wallet-only agent float settlement). Never drop these.
        const isAlwaysToCompany = ALWAYS_WALLET_TO_COMPANY.has(w.category);
        if (w.direction === 'cash_in' && hasPlatformOut) {
          let bucketCategory = (GENERIC_WALLET_CATEGORIES.has(w.category) && platformOutCategory)
            ? platformOutCategory
            : w.category;
          // If the category is still generic (e.g. credit-draw / advance
          // disbursements post both legs as `wallet_deposit`), recover the real
          // purpose from the originating source table so it isn't lost to "Other".
          if (GENERIC_WALLET_CATEGORIES.has(bucketCategory) && w.source_table && SOURCE_TABLE_CATEGORY[w.source_table]) {
            bucketCategory = SOURCE_TABLE_CATEGORY[w.source_table];
          }
          toWallets.push({ amount: amt, category: bucketCategory, party: w.user_id ?? null, date: w.transaction_date });
        } else if (w.direction === 'cash_out' && (hasPlatformIn || hasBridgeIn || isAlwaysToCompany)) {
          // Exclude personal wallet withdrawals — they are wallet → external, not wallet → company
          if (w.category === 'wallet_withdrawal' || w.category === 'withdrawal') continue;
          toCompany.push({ amount: amt, category: w.category, party: w.user_id ?? null, date: w.transaction_date });
        }
      }
    }
    return { toWallets, toCompany };
  }, [rows, includeAdjustments]);

  // Date filters: optionally hide today, and/or restrict to a chosen [from, to] window.
  const todayKey = format(startOfDay(new Date()), 'yyyy-MM-dd');
  const fromKey = dateFrom ? format(startOfDay(dateFrom), 'yyyy-MM-dd') : null;
  const toKey = dateTo ? format(startOfDay(dateTo), 'yyyy-MM-dd') : null;
  const matchesDateFilter = useCallback((dateStr: string) => {
    const dayKey = format(startOfDay(new Date(dateStr)), 'yyyy-MM-dd');
    if (excludeToday && dayKey === todayKey) return false;
    if (fromKey && dayKey < fromKey) return false;
    if (toKey && dayKey > toKey) return false;
    return true;
  }, [excludeToday, todayKey, fromKey, toKey]);
  const effectiveToWallets = summaryItems?.toWallets ?? toWallets;
  const effectiveToCompany = summaryItems?.toCompany ?? toCompany;
  const filteredToWallets = useMemo(
    () => effectiveToWallets.filter(i => matchesDateFilter(i.date)),
    [effectiveToWallets, matchesDateFilter],
  );
  const filteredToCompany = useMemo(
    () => effectiveToCompany.filter(i => matchesDateFilter(i.date)),
    [effectiveToCompany, matchesDateFilter],
  );

  const inSummary = useMemo(() => summarizeTreasuryFlow(filteredToWallets, COMPANY_TO_WALLETS_GROUPS), [filteredToWallets]);
  const outSummary = useMemo(() => summarizeTreasuryFlow(filteredToCompany, WALLET_TO_COMPANY_GROUPS), [filteredToCompany]);
  const net = inSummary.total - outSummary.total;

  // ── Previous-period comparison ────────────────────────────────
  // Only meaningful when an explicit start date is chosen. The previous
  // window is the same number of days, immediately before the selected one.
  const effectiveFrom = dateFrom ? startOfDay(dateFrom) : null;
  const effectiveTo = dateTo ? startOfDay(dateTo) : startOfDay(new Date());
  const canCompare = !!effectiveFrom;
  const prevRange = useMemo(() => {
    if (!effectiveFrom) return null;
    const lengthDays = differenceInCalendarDays(effectiveTo, effectiveFrom) + 1;
    const prevTo = subDays(effectiveFrom, 1);
    const prevFrom = subDays(prevTo, lengthDays - 1);
    return { fromKey: format(prevFrom, 'yyyy-MM-dd'), toKey: format(prevTo, 'yyyy-MM-dd'), prevFrom, prevTo, lengthDays };
  }, [effectiveFrom, effectiveTo]);
  const inPrevRange = useCallback((dateStr: string) => {
    if (!prevRange) return false;
    const dayKey = format(startOfDay(new Date(dateStr)), 'yyyy-MM-dd');
    return dayKey >= prevRange.fromKey && dayKey <= prevRange.toKey;
  }, [prevRange]);
  const prevInSummary = useMemo(
    () => (compareEnabled && prevRange ? summarizeTreasuryFlow(effectiveToWallets.filter(i => inPrevRange(i.date)), COMPANY_TO_WALLETS_GROUPS) : null),
    [compareEnabled, prevRange, effectiveToWallets, inPrevRange],
  );
  const prevOutSummary = useMemo(
    () => (compareEnabled && prevRange ? summarizeTreasuryFlow(effectiveToCompany.filter(i => inPrevRange(i.date)), WALLET_TO_COMPANY_GROUPS) : null),
    [compareEnabled, prevRange, effectiveToCompany, inPrevRange],
  );

  // Resolve party names for the top movers shown on each card.
  useEffect(() => {
    const ids = Array.from(new Set(
      [...inSummary.parties.slice(0, 8), ...outSummary.parties.slice(0, 8)]
        .map(([id]) => id)
        .filter(id => id && !names[id]),
    ));
    if (!ids.length) return;
    let cancelled = false;
    (async () => {
      const { data } = await supabase.from('profiles').select('id, full_name').in('id', ids);
      if (cancelled || !data) return;
      const next: Record<string, string> = {};
      for (const p of data as { id: string; full_name: string | null }[]) {
        if (p.full_name) next[p.id] = p.full_name;
      }
      if (Object.keys(next).length) setNames(prev => ({ ...prev, ...next }));
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [inSummary.parties, outSummary.parties]);

  const nameOf = (id: string) => names[id] || `${id.slice(0, 8)}…`;

  const Flow = ({
    tone,
    icon,
    title,
    subtitle,
    summary,
    partyHeading,
    direction,
    rawItems,
    onGroupDrill,
    groupDefs,
    compareSummary,
  }: {
    tone: 'in' | 'out';
    icon: React.ReactNode;
    title: string;
    subtitle: string;
    summary: ReturnType<typeof summarizeTreasuryFlow>;
    partyHeading: string;
    direction: 'cash_in' | 'cash_out';
    rawItems: TreasuryFlowItem[];
    onGroupDrill?: (meta: { label: string; color: string; categories: Set<string>; expectedTotal: number; expectedCount: number }) => void;
    groupDefs?: { label: string; categories: Set<string>; color: string }[];
    compareSummary?: ReturnType<typeof summarizeTreasuryFlow> | null;
  }) => {
    const [groupView, setGroupView] = useState<'amount' | 'count' | 'pct'>('amount');
    const groups = groupDefs ?? (direction === 'cash_out' ? WALLET_TO_COMPANY_GROUPS : COMPANY_TO_WALLETS_GROUPS);
    const hasCompare = !!compareSummary;
    const compareTotal = compareSummary ? compareSummary.total : 0;
    const delta = hasCompare ? summary.total - compareTotal : 0;
    const deltaPct = hasCompare && compareTotal > 0
      ? Math.round((delta / compareTotal) * 100)
      : null;
    const prevGroupAmount = (label: string) => {
      const found = compareSummary?.groups.find(([l]) => l === label);
      return found ? found[1].amount : 0;
    };
    return (
      <div
        className={cn(
          'rounded-2xl border-2 p-4 space-y-3',
          tone === 'in'
            ? 'border-emerald-500/30 bg-emerald-500/[0.06]'
            : 'border-amber-500/30 bg-amber-500/[0.06]',
        )}
      >
        <div className="flex items-start gap-3">
          <div className={cn('p-2 rounded-xl shrink-0', tone === 'in' ? 'bg-emerald-500/15 text-emerald-600' : 'bg-amber-500/15 text-amber-600')}>
            {icon}
          </div>
          <div className="min-w-0 flex-1">
            <p className="text-[13px] font-semibold leading-tight">{title}</p>
            <p className="text-[11px] text-muted-foreground leading-snug mt-0.5">{subtitle}</p>
          </div>
        </div>
        <div>
          <p className={cn('text-2xl font-bold font-mono tracking-tight', tone === 'in' ? 'text-emerald-600' : 'text-amber-600')}>
            {formatUGX(summary.total)}
          </p>
          <p className="text-[11px] text-muted-foreground">{summary.count.toLocaleString()} transfer{summary.count === 1 ? '' : 's'}</p>
          {hasCompare && (
            <div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-[11px]">
              <span className={cn(
                'inline-flex items-center gap-0.5 font-semibold rounded-md px-1.5 py-0.5',
                delta >= 0 ? 'bg-emerald-500/15 text-emerald-600' : 'bg-rose-500/15 text-rose-600',
              )}>
                {delta >= 0 ? <ArrowUpRight className="h-3 w-3" /> : <ArrowDownRight className="h-3 w-3" />}
                {delta >= 0 ? '+' : '−'}{formatUGX(Math.abs(delta))}
                {deltaPct !== null && <span className="opacity-80">({delta >= 0 ? '+' : '−'}{Math.abs(deltaPct)}%)</span>}
              </span>
              <span className="text-muted-foreground">vs {formatUGX(compareTotal as number)} prev. period</span>
            </div>
          )}
        </div>

        {summary.cats.length > 0 && (
          <div className="space-y-1.5 pt-1 border-t border-border/60">
            {summary.groups.length > 0 ? (
              <>
                <div className="rounded-xl border border-border bg-card p-3 space-y-2.5">
                  <div className="flex items-center justify-between gap-2">
                    <p className="text-[11px] uppercase tracking-wider text-muted-foreground font-bold">
                      {direction === 'cash_out' ? 'Money coming from wallets into company' : 'Money sent from company into wallets'}
                    </p>
                    {/* Quick-toggle chips */}
                    <div className="inline-flex items-center gap-1 bg-muted rounded-lg p-0.5">
                      {(['amount', 'count', 'pct'] as const).map((mode) => (
                        <button
                          key={mode}
                          type="button"
                          onClick={() => setGroupView(mode)}
                          className={cn(
                            'px-2 py-0.5 rounded-md text-[10px] font-semibold transition-colors',
                            groupView === mode
                              ? 'bg-background text-foreground shadow-sm'
                              : 'text-muted-foreground hover:text-foreground'
                          )}
                        >
                          {mode === 'amount' ? 'Amount' : mode === 'count' ? 'Count' : 'Percent'}
                        </button>
                      ))}
                    </div>
                  </div>
                  <div className="space-y-2">
                    {groups.map((groupMeta, idx) => {
                      const label = groupMeta.label;
                      const found = summary.groups.find(([l]) => l === label);
                      const v = found ? found[1] : { amount: 0, count: 0 };
                      const isEmpty = v.amount === 0 && v.count === 0;
                      const pct = summary.total > 0 ? Math.round((v.amount / summary.total) * 100) : 0;
                      const mainValue = groupView === 'amount'
                        ? formatUGX(v.amount)
                        : groupView === 'count'
                          ? v.count.toLocaleString()
                          : `${pct}%`;
                      const subLine = groupView === 'amount'
                        ? `${v.count.toLocaleString()} transaction${v.count === 1 ? '' : 's'} · ${pct}% of total`
                        : groupView === 'count'
                          ? `${formatUGX(v.amount)} · ${pct}% of total`
                          : `${formatUGX(v.amount)} · ${v.count.toLocaleString()} transaction${v.count === 1 ? '' : 's'}`;
                      const prevAmt = hasCompare ? prevGroupAmount(label) : 0;
                      const groupDelta = v.amount - prevAmt;
                      const groupDeltaPct = prevAmt > 0 ? Math.round((groupDelta / prevAmt) * 100) : null;
                      return (
                        <button
                          key={label}
                          type="button"
                          disabled={isEmpty || !onGroupDrill}
                          onClick={() => onGroupDrill?.({ label, color: groupMeta.color, categories: groupMeta.categories, expectedTotal: v.amount, expectedCount: v.count })}
                          className={cn(
                            'w-full flex items-center gap-3 rounded-lg border px-3 py-2.5 text-left transition-all',
                            isEmpty
                              ? 'bg-muted/30 border-border opacity-60 cursor-default'
                              : cn(groupMeta?.color || 'bg-muted/50 border-border', 'hover:brightness-105 hover:shadow-sm cursor-pointer')
                          )}
                        >
                          <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-background font-bold text-sm shadow-sm">
                            {idx + 1}
                          </div>
                          <div className="min-w-0 flex-1">
                            <p className="text-[13px] font-semibold leading-snug">{label}</p>
                            <p className="text-[10px] opacity-80">{isEmpty ? 'No movements in this period' : `${subLine} · tap for per-period detail`}</p>
                            {hasCompare && (
                              <p className={cn(
                                'text-[10px] font-semibold mt-0.5 inline-flex items-center gap-0.5',
                                groupDelta >= 0 ? 'text-emerald-600' : 'text-rose-600',
                              )}>
                                {groupDelta >= 0 ? <ArrowUpRight className="h-2.5 w-2.5" /> : <ArrowDownRight className="h-2.5 w-2.5" />}
                                {groupDelta >= 0 ? '+' : '−'}{formatUGX(Math.abs(groupDelta))}
                                {groupDeltaPct !== null && <span className="opacity-80">({groupDelta >= 0 ? '+' : '−'}{Math.abs(groupDeltaPct)}%)</span>}
                                <span className="opacity-70 font-normal"> vs {formatUGX(prevAmt)} prev.</span>
                              </p>
                            )}
                          </div>
                          <div className="shrink-0 text-right flex items-center gap-1.5">
                            <p className="text-[15px] font-bold font-mono leading-tight">{mainValue}</p>
                            {!isEmpty && onGroupDrill && <ChevronRight className="h-4 w-4 opacity-60" />}
                          </div>
                        </button>
                      );
                    })}
                  </div>
                  {/* Expandable drilldown for uncategorized items */}
                  {(() => {
                    const groupedTotal = summary.groups.reduce((s, [, v]) => s + v.amount, 0);
                    const other = summary.total - groupedTotal;
                    if (other <= 0) return null;
                    const groupedCatSet = new Set(groups.flatMap(g => [...g.categories]));
                    const otherItems = rawItems.filter(i => !groupedCatSet.has(i.category));
                    return (
                      <OtherWalletOriginDrilldown
                        items={otherItems}
                        otherTotal={other}
                        direction={direction}
                        initialNames={names}
                      />
                    );
                  })()}
                </div>
                <div className="pt-1.5 border-t border-border/40">
                  <p className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold mb-1">
                    All types · CFO order
                  </p>
                  <div className="space-y-1 max-h-48 overflow-y-auto pr-1">
                    {summary.cats.map(([cat, v]) => (
                      <div key={cat} className="flex items-center justify-between gap-2 text-[11px]">
                        <span className="truncate text-muted-foreground">{friendlyWalletLabel(cat, direction)}</span>
                        <span className="font-mono font-medium shrink-0">{formatUGX(v.amount)}</span>
                      </div>
                    ))}
                  </div>
                </div>
              </>
            ) : (
              <>
                <p className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold">
                  By type · CFO order
                </p>
                <div className="space-y-1.5 max-h-72 overflow-y-auto pr-1">
                  {summary.cats.map(([cat, v]) => (
                    <div key={cat} className="flex items-center justify-between gap-2 text-[12px]">
                      <span className="truncate text-foreground/90">{friendlyWalletLabel(cat, direction)}</span>
                      <span className="font-mono font-medium shrink-0">{formatUGX(v.amount)}</span>
                    </div>
                  ))}
                </div>
              </>
            )}
          </div>
        )}

        {summary.parties.length > 0 && (
          <div className="space-y-1.5 pt-1 border-t border-border/60">
            <p className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold">{partyHeading}</p>
            {summary.parties.slice(0, 5).map(([id, v]) => (
              <div key={id} className="flex items-center justify-between gap-2 text-[12px]">
                <span className="truncate text-foreground/90">{nameOf(id)}</span>
                <span className="font-mono font-medium shrink-0">{formatUGX(v.amount)}</span>
              </div>
            ))}
          </div>
        )}

        {summary.count === 0 && (
          <p className="text-[12px] text-muted-foreground italic pt-1">No transfers in this period.</p>
        )}

        {onDrill && summary.count > 0 && (
          <button
            type="button"
            onClick={() => onDrill(direction, 'wallet')}
            className="text-[11px] font-medium text-primary inline-flex items-center gap-1 hover:underline"
          >
            See all transactions <ArrowRight className="h-3 w-3" />
          </button>
        )}
      </div>
    );
  };

  return (
    <>
    <section id="cm-treasury" className="space-y-3">
      <div className="flex items-center gap-2">
        <ArrowLeftRight className="h-4 w-4 text-primary" />
        <h4 className="text-sm font-semibold">Treasury ⇄ Wallets</h4>
      </div>
      <p className="text-[11px] text-muted-foreground -mt-1">
        The two movements that matter most: the CFO funding wallets out of company money, and agents
        allocating money out of their wallets back to the company.
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <label className="flex items-center gap-2 w-fit rounded-lg border border-border bg-muted/30 px-3 py-1.5 cursor-pointer select-none">
          <Checkbox checked={excludeToday} onCheckedChange={(c) => setExcludeToday(c === true)} />
          <span className="text-[11px] font-medium text-foreground/90">Exclude today's movements</span>
        </label>
        <Popover>
          <PopoverTrigger asChild>
            <Button
              variant="outline"
              size="sm"
              className={cn('h-8 justify-start text-[11px] font-medium gap-1.5', !dateFrom && 'text-muted-foreground')}
            >
              <Calendar className="h-3.5 w-3.5" />
              {dateFrom ? format(dateFrom, 'dd MMM yyyy') : 'From date'}
            </Button>
          </PopoverTrigger>
          <PopoverContent className="w-auto p-0" align="start">
            <CalendarPicker
              mode="single"
              selected={dateFrom}
              onSelect={setDateFrom}
              disabled={(d) => (dateTo ? d > dateTo : false)}
              initialFocus
              className={cn('p-3 pointer-events-auto')}
            />
          </PopoverContent>
        </Popover>
        <Popover>
          <PopoverTrigger asChild>
            <Button
              variant="outline"
              size="sm"
              className={cn('h-8 justify-start text-[11px] font-medium gap-1.5', !dateTo && 'text-muted-foreground')}
            >
              <Calendar className="h-3.5 w-3.5" />
              {dateTo ? format(dateTo, 'dd MMM yyyy') : 'To date'}
            </Button>
          </PopoverTrigger>
          <PopoverContent className="w-auto p-0" align="start">
            <CalendarPicker
              mode="single"
              selected={dateTo}
              onSelect={setDateTo}
              disabled={(d) => (dateFrom ? d < dateFrom : false)}
              initialFocus
              className={cn('p-3 pointer-events-auto')}
            />
          </PopoverContent>
        </Popover>
        {(dateFrom || dateTo) && (
          <Button
            variant="ghost"
            size="sm"
            className="h-8 text-[11px] gap-1"
            onClick={() => { setDateFrom(undefined); setDateTo(undefined); }}
          >
            <X className="h-3.5 w-3.5" /> Clear dates
          </Button>
        )}
        <div className="inline-flex items-center gap-1">
          {([
            { label: 'Last 7 days', from: startOfDay(subDays(new Date(), 6)) },
            { label: 'Last 30 days', from: startOfDay(subDays(new Date(), 29)) },
            { label: 'This month', from: startOfMonth(new Date()) },
          ] as const).map((preset) => (
            <Button
              key={preset.label}
              variant="secondary"
              size="sm"
              className="h-8 text-[11px]"
              onClick={() => { setExcludeToday(false); setDateFrom(preset.from); setDateTo(startOfDay(new Date())); }}
            >
              {preset.label}
            </Button>
          ))}
        </div>
        <label className={cn(
          'flex items-center gap-2 w-fit rounded-lg border px-3 py-1.5 select-none',
          canCompare ? 'border-border bg-muted/30 cursor-pointer' : 'border-border/50 bg-muted/10 opacity-50 cursor-not-allowed',
        )}>
          <Checkbox checked={compareEnabled} disabled={!canCompare} onCheckedChange={(c) => setCompareEnabled(c === true)} />
          <span className="text-[11px] font-medium text-foreground/90">Compare with previous period</span>
        </label>
      </div>
      {compareEnabled && canCompare && prevRange && (
        <p className="text-[11px] text-muted-foreground -mt-1">
          Comparing {format(effectiveFrom as Date, 'dd MMM')} – {format(effectiveTo, 'dd MMM yyyy')} against
          {' '}{format(prevRange.prevFrom, 'dd MMM')} – {format(prevRange.prevTo, 'dd MMM yyyy')} ({prevRange.lengthDays} days).
        </p>
      )}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
        <Flow
          tone="in"
          icon={<WalletIcon className="h-5 w-5" />}
          title="Company → Wallets"
          subtitle="Every move of company money into user & agent wallets — CFO transfers, auto payouts (ROI, commissions) and Financial Ops disbursements"
          summary={inSummary}
          partyHeading="Top recipients"
          direction="cash_in"
          rawItems={filteredToWallets}
          groupDefs={COMPANY_TO_WALLETS_GROUPS}
          compareSummary={prevInSummary}
          onGroupDrill={(meta) => setGroupDrill({
            label: meta.label,
            color: meta.color,
            direction: 'cash_in',
            items: filteredToWallets.filter(i => meta.categories.has(i.category)),
            expectedTotal: meta.expectedTotal,
            expectedCount: meta.expectedCount,
          })}
        />
        <Flow
          tone="out"
          icon={<Landmark className="h-5 w-5" />}
          title="From Wallets to Company"
          subtitle="All money that moved from any user's wallet into company funds — including rent payments for tenants allocated by agents, partner funding / top-ups / reinvestments from proxy-agent wallets, and advance auto-recovery from agents who took Welile advances"
          summary={outSummary}
          partyHeading="Top sources"
          direction="cash_out"
          rawItems={filteredToCompany}
          groupDefs={WALLET_TO_COMPANY_GROUPS}
          compareSummary={prevOutSummary}
          onGroupDrill={(meta) => setGroupDrill({
            label: meta.label,
            color: meta.color,
            direction: 'cash_out',
            items: filteredToCompany.filter(i => meta.categories.has(i.category)),
            expectedTotal: meta.expectedTotal,
            expectedCount: meta.expectedCount,
          })}
        />
      </div>
      <div className="flex items-center justify-between gap-2 rounded-xl border border-border bg-muted/30 px-3 py-2">
        <span className="text-[11px] font-medium text-muted-foreground inline-flex items-center gap-1.5">
          <span className="font-mono">Company → Wallets</span>
          <ArrowRight className="h-3 w-3" />
          <span className="font-mono">From Wallets to Company</span>
          = Net to wallets
        </span>
        <span className={cn('text-sm font-bold font-mono', net >= 0 ? 'text-emerald-600' : 'text-amber-600')}>
          {net >= 0 ? '+' : '−'}{formatUGX(Math.abs(net))}
        </span>
      </div>
    </section>
    {groupDrill && (
      <GroupPeriodDrilldown
        open={!!groupDrill}
        onOpenChange={(o) => { if (!o) setGroupDrill(null); }}
        label={groupDrill.label}
        color={groupDrill.color}
        direction={groupDrill.direction}
        items={groupDrill.items}
        initialNames={names}
        expectedTotal={groupDrill.expectedTotal}
        expectedCount={groupDrill.expectedCount}
      />
    )}
    </>
  );
}

// ─────────────────────────────────────────────────────────────
// Agent Allocation Breakdown — a chart showing how each agent's
// wallet distributes money into company funds, split by category and
// amount. Same source as the "Wallets → Company" flow above: a wallet
// cash_out leg paired with a platform cash_in leg in one transaction
// group. One horizontal stacked bar per agent; each segment is a
// category. Hover a segment for the exact amount.
// ─────────────────────────────────────────────────────────────
const ALLOCATION_CHART_PALETTE = [
  'hsl(var(--primary))',
  'hsl(38 92% 50%)',   // amber
  'hsl(160 84% 39%)',  // emerald
  'hsl(199 89% 48%)',  // sky
  'hsl(280 65% 60%)',  // violet
  'hsl(346 77% 58%)',  // rose
  'hsl(24 95% 53%)',   // orange
  'hsl(199 18% 46%)',  // slate
];

function AgentAllocationBreakdownChart({
  rows,
  includeAdjustments,
}: {
  rows: LedgerRow[];
  includeAdjustments: boolean;
}) {
  const [names, setNames] = useState<Record<string, string>>({});
  const [maxAgents, setMaxAgents] = useState<8 | 20>(8);

  // ── Chart-local filters ────────────────────────────────────
  const [dateFrom, setDateFrom] = useState<string>('');
  const [dateTo, setDateTo] = useState<string>('');
  const [selectedCategories, setSelectedCategories] = useState<Set<string>>(new Set());
  const [showFilters, setShowFilters] = useState<boolean>(false);

  const dateActive = !!(dateFrom || dateTo);
  const categoryActive = selectedCategories.size > 0;

  // Build per-agent, per-category allocation totals from paired
  // wallet-out / platform-in ledger legs, respecting local filters.
  const { perAgent, categories, allCategories } = useMemo(() => {
    const groups = new Map<string, LedgerRow[]>();
    for (const r of rows) {
      if (!includeAdjustments && (r.classification === 'admin_correction' || r.category === 'system_balance_correction')) continue;
      const gid = r.transaction_group_id;
      if (!gid) continue;
      const arr = groups.get(gid) || [];
      arr.push(r);
      groups.set(gid, arr);
    }
    // agentId -> { total, byCat: Map<category, amount> }
    const perAgent = new Map<string, { total: number; byCat: Map<string, number> }>();
    const catTotals = new Map<string, number>();
    const allCatTotals = new Map<string, number>();
    for (const legs of groups.values()) {
      const hasPlatformIn = legs.some(l => l.ledger_scope === 'platform' && l.direction === 'cash_in');
      if (!hasPlatformIn) continue;
      for (const w of legs) {
        if (w.ledger_scope !== 'wallet' || w.direction !== 'cash_out') continue;
        // Exclude personal wallet withdrawals — they are wallet → external, not wallet → company
        if (w.category === 'wallet_withdrawal' || w.category === 'withdrawal') continue;
        const amt = Number(w.amount) || 0;
        if (!amt || !w.user_id) continue;
        // Date filter
        const d = w.transaction_date.slice(0, 10);
        if (dateFrom && d < dateFrom) continue;
        if (dateTo && d > dateTo) continue;
        // Category filter (applied after collecting allCats so UI can show unselected ones too)
        allCatTotals.set(w.category, (allCatTotals.get(w.category) || 0) + amt);
        if (selectedCategories.size > 0 && !selectedCategories.has(w.category)) continue;
        const entry = perAgent.get(w.user_id) || { total: 0, byCat: new Map<string, number>() };
        entry.total += amt;
        entry.byCat.set(w.category, (entry.byCat.get(w.category) || 0) + amt);
        perAgent.set(w.user_id, entry);
        catTotals.set(w.category, (catTotals.get(w.category) || 0) + amt);
      }
    }
    const categories = [...catTotals.entries()].sort((a, b) => b[1] - a[1]).map(([c]) => c);
    const allCategories = [...allCatTotals.entries()].sort((a, b) => b[1] - a[1]).map(([c]) => c);
    return { perAgent, categories, allCategories };
  }, [rows, includeAdjustments, dateFrom, dateTo, selectedCategories]);

  const topAgents = useMemo(
    () => [...perAgent.entries()].sort((a, b) => b[1].total - a[1].total).slice(0, maxAgents),
    [perAgent, maxAgents],
  );

  // Resolve agent names.
  useEffect(() => {
    const ids = topAgents.map(([id]) => id).filter(id => !names[id]);
    if (!ids.length) return;
    let cancelled = false;
    (async () => {
      const { data } = await supabase.from('profiles').select('id, full_name').in('id', ids);
      if (cancelled || !data) return;
      const next: Record<string, string> = {};
      for (const p of data as { id: string; full_name: string | null }[]) {
        if (p.full_name) next[p.id] = p.full_name;
      }
      if (Object.keys(next).length) setNames(prev => ({ ...prev, ...next }));
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [topAgents]);

  const colorFor = useMemo(() => {
    const map: Record<string, string> = {};
    categories.forEach((c, i) => { map[c] = ALLOCATION_CHART_PALETTE[i % ALLOCATION_CHART_PALETTE.length]; });
    return map;
  }, [categories]);

  const chartData = useMemo(() => {
    return topAgents.map(([id, entry]) => {
      const row: Record<string, number | string> = {
        agent: names[id] || `${id.slice(0, 8)}…`,
        total: entry.total,
      };
      for (const c of categories) row[c] = entry.byCat.get(c) || 0;
      return row;
    });
  }, [topAgents, categories, names]);

  const totalAgents = perAgent.size;

  const toggleCategory = (c: string) => {
    setSelectedCategories(prev => {
      const next = new Set(prev);
      if (next.has(c)) next.delete(c); else next.add(c);
      return next;
    });
  };
  const clearFilters = () => {
    setDateFrom('');
    setDateTo('');
    setSelectedCategories(new Set());
  };

  if (totalAgents === 0 && !dateActive && !categoryActive) {
    return (
      <section id="cm-allocation-chart" className="space-y-2">
        <div className="flex items-center gap-2">
          <ArrowLeftRight className="h-4 w-4 text-primary" />
          <h4 className="text-sm font-semibold">Agent Allocation Breakdown</h4>
        </div>
        <div className="rounded-2xl border border-border bg-muted/20 p-6 text-center text-[12px] text-muted-foreground">
          No agent wallet allocations to company funds in this period.
        </div>
      </section>
    );
  }

  // ~38px per agent row + headroom for the legend/axis.
  const chartHeight = Math.max(180, topAgents.length * 40 + 60);

  return (
    <section id="cm-allocation-chart" className="space-y-3">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div className="flex items-center gap-2">
          <ArrowLeftRight className="h-4 w-4 text-primary" />
          <h4 className="text-sm font-semibold">Agent Allocation Breakdown</h4>
        </div>
        <div className="flex items-center gap-1.5">
          {(dateActive || categoryActive) && (
            <Button
              size="sm"
              variant="ghost"
              className="h-7 text-[11px] px-2 rounded-full"
              onClick={clearFilters}
            >
              Clear filters
            </Button>
          )}
          <Button
            size="sm"
            variant={showFilters ? 'default' : 'outline'}
            className="h-7 text-[11px] px-2.5 rounded-full"
            onClick={() => setShowFilters(v => !v)}
          >
            <Filter className="h-3 w-3 mr-1" />
            Filters
            {(dateActive || categoryActive) && (
              <span className="ml-1 inline-flex h-3.5 w-3.5 items-center justify-center rounded-full bg-primary-foreground text-[9px] font-bold text-primary">
                {(dateActive ? 1 : 0) + (categoryActive ? 1 : 0)}
              </span>
            )}
          </Button>
          {totalAgents > 8 && (
            <Button
              size="sm"
              variant="outline"
              className="h-7 text-[11px] px-2.5 rounded-full"
              onClick={() => setMaxAgents(v => (v === 8 ? 20 : 8))}
            >
              {maxAgents === 8 ? `Show top 20 of ${totalAgents}` : 'Show top 8'}
            </Button>
          )}
        </div>
      </div>
      <p className="text-[11px] text-muted-foreground -mt-1">
        How each agent's wallet distributes money into company funds, split by category and amount.
        Each bar is one agent; each colour is a category. Hover a segment for the exact amount.
      </p>

      {/* ── Filter panel ── */}
      {showFilters && (
        <div className="rounded-xl border border-border bg-muted/30 p-3 space-y-3">
          {/* Date range */}
          <div className="space-y-1.5">
            <div className="text-[11px] font-medium text-muted-foreground uppercase tracking-wider">Date range</div>
            <div className="flex items-center gap-2 flex-wrap">
              <input
                type="date"
                value={dateFrom}
                onChange={e => setDateFrom(e.target.value)}
                className="h-8 rounded-md border border-border bg-background px-2 text-[12px]"
                placeholder="From"
              />
              <span className="text-muted-foreground text-[12px]">→</span>
              <input
                type="date"
                value={dateTo}
                onChange={e => setDateTo(e.target.value)}
                className="h-8 rounded-md border border-border bg-background px-2 text-[12px]"
                placeholder="To"
              />
              {dateActive && (
                <Button variant="ghost" size="sm" className="h-7 text-[11px] px-2" onClick={() => { setDateFrom(''); setDateTo(''); }}>
                  Reset dates
                </Button>
              )}
            </div>
          </div>

          {/* Category toggles */}
          <div className="space-y-1.5">
            <div className="flex items-center justify-between">
              <div className="text-[11px] font-medium text-muted-foreground uppercase tracking-wider">Categories</div>
              {categoryActive && (
                <Button variant="ghost" size="sm" className="h-7 text-[11px] px-2" onClick={() => setSelectedCategories(new Set())}>
                  Reset categories
                </Button>
              )}
            </div>
            <div className="flex flex-wrap gap-1.5">
              {allCategories.map(c => {
                const active = selectedCategories.has(c);
                return (
                  <button
                    key={c}
                    onClick={() => toggleCategory(c)}
                    className={cn(
                      'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] transition-colors',
                      active
                        ? 'border-primary bg-primary/10 text-primary'
                        : 'border-border bg-background text-muted-foreground hover:bg-muted'
                    )}
                  >
                    <span
                      className="h-2 w-2 rounded-sm shrink-0"
                      style={{ backgroundColor: colorFor[c] || ALLOCATION_CHART_PALETTE[allCategories.indexOf(c) % ALLOCATION_CHART_PALETTE.length] }}
                    />
                    {friendlyWalletLabel(c, 'cash_out')}
                  </button>
                );
              })}
            </div>
          </div>
        </div>
      )}

      {/* Category legend with colour swatches + totals (only when not in filter panel) */}
      {!showFilters && (
        <div className="flex flex-wrap gap-x-3 gap-y-1">
          {categories.map(c => (
            <span key={c} className="inline-flex items-center gap-1.5 text-[11px] text-muted-foreground">
              <span className="h-2.5 w-2.5 rounded-sm shrink-0" style={{ backgroundColor: colorFor[c] }} />
              {friendlyWalletLabel(c, 'cash_out')}
            </span>
          ))}
        </div>
      )}

      {totalAgents === 0 ? (
        <div className="rounded-2xl border border-border bg-muted/20 p-6 text-center text-[12px] text-muted-foreground">
          No allocations match the current filters.
          <button onClick={clearFilters} className="ml-1 underline text-primary">Clear filters</button>
        </div>
      ) : (
        <div className="rounded-2xl border-2 border-border/60 bg-card p-3" style={{ height: chartHeight }}>
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={chartData} layout="vertical" margin={{ top: 4, right: 16, bottom: 4, left: 8 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" horizontal={false} />
              <XAxis
                type="number"
                tick={{ fontSize: 10 }}
                stroke="hsl(var(--muted-foreground))"
                tickFormatter={(v: number) => formatUGX(v)}
              />
              <YAxis
                type="category"
                dataKey="agent"
                width={110}
                tick={{ fontSize: 11 }}
                stroke="hsl(var(--muted-foreground))"
              />
              <RechartsTooltip
                formatter={(v: number, name: string) => [formatUGX(v), friendlyWalletLabel(name, 'cash_out')]}
                contentStyle={{
                  background: 'hsl(var(--popover))',
                  border: '1px solid hsl(var(--border))',
                  borderRadius: 8,
                  fontSize: 12,
                }}
              />
              {categories.map((c, i) => (
                <Bar
                  key={c}
                  dataKey={c}
                  stackId="alloc"
                  fill={colorFor[c]}
                  radius={i === categories.length - 1 ? [0, 4, 4, 0] : undefined}
                />
              ))}
            </BarChart>
          </ResponsiveContainer>
        </div>
      )}
    </section>
  );
}

// ─────────────────────────────────────────────────────────────
// Company → Wallets Breakdown — mirrors the Agent Allocation chart
// but for the INBOUND direction: how company money flows OUT to user
// & agent wallets, split by category. Source: a wallet cash_in leg
// paired with a platform cash_out leg in one transaction group (the
// CFO funding wallets, auto ROI/commission payouts, Financial Ops
// disbursements). One horizontal bar per category; bar length is the
// total moved. Click a category to see its top recipients.
// ─────────────────────────────────────────────────────────────
function CompanyToWalletBreakdownChart({
  rows,
  includeAdjustments,
}: {
  rows: LedgerRow[];
  includeAdjustments: boolean;
}) {
  const [names, setNames] = useState<Record<string, string>>({});
  const [expanded, setExpanded] = useState<string | null>(null);
  // Deep drill-down: a single recipient (or whole category) → every transaction.
  const [drill, setDrill] = useState<{ category: string; userId: string | 'ALL' } | null>(null);
  const [drillSearch, setDrillSearch] = useState('');
  const [drillDirection, setDrillDirection] = useState<'cash_in' | 'cash_out' | 'both'>('cash_in');
  const [drillDateFrom, setDrillDateFrom] = useState('');
  const [drillDateTo, setDrillDateTo] = useState('');

  // ── Chart-local filters ────────────────────────────────────
  const [dateFrom, setDateFrom] = useState<string>('');
  const [dateTo, setDateTo] = useState<string>('');
  const [showFilters, setShowFilters] = useState<boolean>(false);
  const [selectedCategories, setSelectedCategories] = useState<Set<string>>(new Set());
  const dateActive = !!(dateFrom || dateTo);
  const categoryFilterActive = selectedCategories.size > 0;

  // Presets — one-click common comparison sets. Only categories that actually
  // appear in the current period are applied (intersected with availableCategories).
  type Preset = { label: string; categories: string[] };
  const PRESETS: Preset[] = [
    { label: 'All', categories: [] }, // sentinel — means "no restriction"
    { label: 'Commissions', categories: ['agent_commission', 'partner_commission', 'business_advance_commission'] },
    { label: 'Returns & Payroll', categories: ['roi_payout', 'roi_wallet_credit', 'payroll', 'payroll_growth'] },
    { label: 'Deposits', categories: ['deposit', 'agent_float_deposit', 'landlord_float_deposit'] },
    { label: 'Partner flows', categories: ['partner_funding', 'coo_proxy_investment', 'proxy_investment_commission', 'pending_portfolio_topup'] },
    { label: 'Bonuses', categories: ['tenant_placement_bonus'] },
  ];
  const [activePreset, setActivePreset] = useState<string | null>(null);

  // Build per-category totals + per-category recipient breakdown from
  // paired wallet-in / platform-out ledger legs (Company → Wallets).
  const { catList, total, count, byCatRecipients, byCatRecipientRows, byCatRows, availableCategories } = useMemo(() => {
    const groups = new Map<string, LedgerRow[]>();
    for (const r of rows) {
      if (!includeAdjustments && (r.classification === 'admin_correction' || r.category === 'system_balance_correction')) continue;
      const gid = r.transaction_group_id;
      if (!gid) continue;
      const arr = groups.get(gid) || [];
      arr.push(r);
      groups.set(gid, arr);
    }
    const catTotals = new Map<string, { amount: number; count: number }>();
    const byCatRecipients = new Map<string, Map<string, number>>();
    const byCatRecipientRows = new Map<string, Map<string, LedgerRow[]>>();
    const byCatRows = new Map<string, LedgerRow[]>();
    const available = new Set<string>();
    let total = 0;
    let count = 0;
    for (const legs of groups.values()) {
      const hasPlatformOut = legs.some(l => l.ledger_scope === 'platform' && l.direction === 'cash_out');
      if (!hasPlatformOut) continue;
      for (const w of legs) {
        if (w.ledger_scope !== 'wallet' || w.direction !== 'cash_in') continue;
        const amt = Number(w.amount) || 0;
        if (!amt) continue;
        const d = w.transaction_date.slice(0, 10);
        if (dateFrom && d < dateFrom) continue;
        if (dateTo && d > dateTo) continue;
        available.add(w.category);
        if (categoryFilterActive && !selectedCategories.has(w.category)) continue;
        const c = catTotals.get(w.category) || { amount: 0, count: 0 };
        c.amount += amt; c.count += 1; catTotals.set(w.category, c);
        total += amt; count += 1;
        const allRows = byCatRows.get(w.category) || [];
        allRows.push(w); byCatRows.set(w.category, allRows);
        if (w.user_id) {
          const recs = byCatRecipients.get(w.category) || new Map<string, number>();
          recs.set(w.user_id, (recs.get(w.user_id) || 0) + amt);
          byCatRecipients.set(w.category, recs);
          const recRows = byCatRecipientRows.get(w.category) || new Map<string, LedgerRow[]>();
          const list = recRows.get(w.user_id) || [];
          list.push(w); recRows.set(w.user_id, list);
          byCatRecipientRows.set(w.category, recRows);
        }
      }
    }
    const catList = [...catTotals.entries()]
      .sort((a, b) => {
        const ra = cfoCategoryRank(a[0]);
        const rb = cfoCategoryRank(b[0]);
        if (ra !== rb) return ra - rb;
        return b[1].amount - a[1].amount;
      })
      .map(([category, v]) => ({ category, amount: v.amount, count: v.count }));
    return { catList, total, count, byCatRecipients, byCatRecipientRows, byCatRows, availableCategories: [...available].sort((a, b) => cfoCategoryRank(a) - cfoCategoryRank(b)) };
  }, [rows, includeAdjustments, dateFrom, dateTo, categoryFilterActive, selectedCategories]);

  // Resolve recipient names for the currently-expanded category.
  useEffect(() => {
    if (!expanded) return;
    const recs = byCatRecipients.get(expanded);
    if (!recs) return;
    const ids = [...recs.keys()].filter(id => id && !names[id]).slice(0, 12);
    if (!ids.length) return;
    let cancelled = false;
    (async () => {
      const { data } = await supabase.from('profiles').select('id, full_name').in('id', ids);
      if (cancelled || !data) return;
      const next: Record<string, string> = {};
      for (const p of data as { id: string; full_name: string | null }[]) {
        if (p.full_name) next[p.id] = p.full_name;
      }
      if (Object.keys(next).length) setNames(prev => ({ ...prev, ...next }));
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [expanded, byCatRecipients]);

  const nameOf = (id: string) => names[id] || `${id.slice(0, 8)}…`;

  // Rows powering the active drill-down (one recipient, or the whole category).
  const rawDrillRows = useMemo(() => {
    if (!drill) return [] as LedgerRow[];
    const baseList = drill.userId === 'ALL'
      ? (byCatRows.get(drill.category) || [])
      : (byCatRecipientRows.get(drill.category)?.get(drill.userId) || []);

    if (drillDirection === 'cash_in') {
      return [...baseList].sort((a, b) => (a.transaction_date < b.transaction_date ? 1 : -1));
    }

    // For cash_out or both, pull every leg that shares a transaction_group_id.
    const groupIds = new Set<string>(baseList.map(r => r.transaction_group_id).filter(Boolean) as string[]);
    const allLegs = rows.filter(r => {
      if (!r.transaction_group_id || !groupIds.has(r.transaction_group_id)) return false;
      // Respect date filters so drill-down matches the chart view
      const d = r.transaction_date.slice(0, 10);
      if (dateFrom && d < dateFrom) return false;
      if (dateTo && d > dateTo) return false;
      return true;
    });

    if (drillDirection === 'cash_out') {
      return allLegs
        .filter(r => r.direction === 'cash_out')
        .sort((a, b) => (a.transaction_date < b.transaction_date ? 1 : -1));
    }

    // both: deduplicate
    const seen = new Set<string>();
    const deduped: LedgerRow[] = [];
    for (const r of allLegs) {
      const key = r.id || `${r.transaction_group_id}-${r.ledger_scope}-${r.direction}-${r.user_id || 'none'}`;
      if (!seen.has(key)) { seen.add(key); deduped.push(r); }
    }
    return deduped.sort((a, b) => (a.transaction_date < b.transaction_date ? 1 : -1));
  }, [drill, byCatRows, byCatRecipientRows, rows, drillDirection, dateFrom, dateTo]);

  // Search-filtered drill rows (recipient, reference, description, timestamp, date range).
  const drillRows = useMemo(() => {
    let list = rawDrillRows;
    // Apply drill-down date range
    if (drillDateFrom || drillDateTo) {
      list = list.filter(r => {
        const d = r.transaction_date.slice(0, 10);
        if (drillDateFrom && d < drillDateFrom) return false;
        if (drillDateTo && d > drillDateTo) return false;
        return true;
      });
    }
    const q = drillSearch.trim().toLowerCase();
    if (!q) return list;
    return list.filter(r => {
      const recipient = (r.user_id ? nameOf(r.user_id) : '').toLowerCase();
      const ref = (r.reference_id || '').toLowerCase();
      const desc = (r.description || '').toLowerCase();
      const ts = format(new Date(r.transaction_date), 'd MMM yyyy HH:mm').toLowerCase();
      return recipient.includes(q) || ref.includes(q) || desc.includes(q) || ts.includes(q);
    });
  }, [rawDrillRows, drillSearch, names, drillDateFrom, drillDateTo]);

  const drillTotal = useMemo(() => {
    if (drillDirection === 'both') {
      // Avoid double-counting double-entry legs; show the economic amount (cash_in).
      return drillRows.filter(r => r.direction === 'cash_in').reduce((s, r) => s + (Number(r.amount) || 0), 0);
    }
    return drillRows.reduce((s, r) => s + (Number(r.amount) || 0), 0);
  }, [drillRows, drillDirection]);

  // Export the currently filtered drill-down rows to a PDF document.
  const exportDrillPdf = useCallback(() => {
    if (!drill || drillRows.length === 0) {
      toast.error('Nothing to export', { description: 'No transactions match the current filters.' });
      return;
    }
    const doc = new jsPDF({ orientation: 'landscape', unit: 'pt', format: 'a4' });
    const title = friendlyWalletLabel(drill.category, 'cash_in');
    const scope = drill.userId === 'ALL' ? 'All recipients' : nameOf(drill.userId);
    doc.setFontSize(14);
    doc.text(`${title}`, 40, 40);
    doc.setFontSize(9);
    doc.setTextColor(110);
    const metaLines = [
      `Category: ${drill.category}  ·  Recipient: ${scope}`,
      `Direction: ${drillDirection === 'cash_in' ? 'Cash In' : drillDirection === 'cash_out' ? 'Cash Out' : 'Both'}` +
        (drillSearch ? `  ·  Search: "${drillSearch}"` : '') +
        ((drillDateFrom || drillDateTo) ? `  ·  Dates: ${drillDateFrom || '…'} → ${drillDateTo || '…'}` : ''),
      `${drillRows.length.toLocaleString()} transaction(s)  ·  Total: ${formatUGX(drillTotal)}`,
      `Generated: ${format(new Date(), 'd MMM yyyy, HH:mm')}`,
    ];
    metaLines.forEach((line, i) => doc.text(line, 40, 58 + i * 13));
    autoTable(doc, {
      startY: 58 + metaLines.length * 13 + 6,
      head: [['Date', 'Recipient', 'Description', 'Scope · Dir', 'Reference', 'Amount']],
      body: drillRows.map(r => {
        const isCashIn = r.direction === 'cash_in';
        return [
          format(new Date(r.transaction_date), 'd MMM yyyy, HH:mm'),
          r.user_id ? nameOf(r.user_id) : '—',
          r.description || '—',
          `${r.ledger_scope === 'wallet' ? 'Wallet' : 'Platform'} · ${isCashIn ? 'In' : 'Out'}`,
          r.reference_id || '—',
          `${isCashIn ? '+' : '−'}${formatUGX(Number(r.amount) || 0)}`,
        ];
      }),
      styles: { fontSize: 7.5, cellPadding: 3, overflow: 'linebreak' },
      headStyles: { fillColor: [16, 185, 129], textColor: 255, fontStyle: 'bold' },
      columnStyles: {
        0: { cellWidth: 95 },
        1: { cellWidth: 110 },
        2: { cellWidth: 230 },
        3: { cellWidth: 70 },
        4: { cellWidth: 110 },
        5: { cellWidth: 90, halign: 'right' },
      },
      margin: { left: 40, right: 40 },
    });
    const safeCat = drill.category.replace(/[^a-z0-9]+/gi, '-');
    doc.save(`drilldown-${safeCat}-${format(new Date(), 'yyyyMMdd-HHmm')}.pdf`);
    toast.success('PDF exported', { description: `${drillRows.length.toLocaleString()} transaction(s) saved.` });
  }, [drill, drillRows, drillTotal, drillDirection, drillSearch, drillDateFrom, drillDateTo, names]);

  // Resolve any recipient names referenced by the open whole-category drill.
  useEffect(() => {
    if (!drill) return;
    const ids = [...new Set(drillRows.map(r => r.user_id).filter((id): id is string => !!id && !names[id]))].slice(0, 50);
    if (!ids.length) return;
    let cancelled = false;
    (async () => {
      const { data } = await supabase.from('profiles').select('id, full_name').in('id', ids);
      if (cancelled || !data) return;
      const next: Record<string, string> = {};
      for (const p of data as { id: string; full_name: string | null }[]) {
        if (p.full_name) next[p.id] = p.full_name;
      }
      if (Object.keys(next).length) setNames(prev => ({ ...prev, ...next }));
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [drill, drillRows]);

  const chartData = useMemo(
    () => catList.map(c => ({ name: friendlyWalletLabel(c.category, 'cash_in'), category: c.category, amount: c.amount })),
    [catList],
  );
  const chartHeight = Math.max(180, catList.length * 40 + 60);

  if (count === 0 && !dateActive) {
    return (
      <section id="cm-company-wallet-chart" className="space-y-2">
        <div className="flex items-center gap-2">
          <ArrowLeftRight className="h-4 w-4 text-emerald-600" />
          <h4 className="text-sm font-semibold">Company → Wallets Breakdown</h4>
        </div>
        <div className="rounded-2xl border border-border bg-muted/20 p-6 text-center text-[12px] text-muted-foreground">
          No company money moved into wallets in this period.
        </div>
      </section>
    );
  }

  return (
    <section id="cm-company-wallet-chart" className="space-y-3">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div className="flex items-center gap-2">
          <ArrowLeftRight className="h-4 w-4 text-emerald-600" />
          <h4 className="text-sm font-semibold">Company → Wallets Breakdown</h4>
        </div>
        <div className="flex items-center gap-1.5">
          {(dateActive || categoryFilterActive) && (
            <Button
              size="sm"
              variant="ghost"
              className="h-7 text-[11px] px-2 rounded-full"
              onClick={() => { setDateFrom(''); setDateTo(''); setSelectedCategories(new Set()); setActivePreset('All'); }}
            >
              Clear filters
            </Button>
          )}
          <Button
            size="sm"
            variant={showFilters ? 'default' : 'outline'}
            className="h-7 text-[11px] px-2.5 rounded-full"
            onClick={() => setShowFilters(v => !v)}
          >
            <Filter className="h-3 w-3 mr-1" />
            Filters
            {(dateActive || categoryFilterActive) && (
              <span className="ml-1 inline-flex h-3.5 w-3.5 items-center justify-center rounded-full bg-primary-foreground text-[9px] font-bold text-primary">{[dateActive, categoryFilterActive].filter(Boolean).length}</span>
            )}
          </Button>
        </div>
      </div>
      <p className="text-[11px] text-muted-foreground -mt-1">
        How each category moved company money into user &amp; agent wallets — every category that funds
        wallets, with the exact amount it moved. Tap a category to see who received it.
      </p>

      {showFilters && (
        <div className="rounded-xl border border-border bg-muted/30 p-3 space-y-3">
          {/* Date range */}
          <div className="space-y-1.5">
            <div className="text-[11px] font-medium text-muted-foreground uppercase tracking-wider">Date range</div>
            <div className="flex items-center gap-2 flex-wrap">
              <input
                type="date"
                value={dateFrom}
                onChange={e => setDateFrom(e.target.value)}
                className="h-8 rounded-md border border-border bg-background px-2 text-[12px]"
              />
              <span className="text-muted-foreground text-[12px]">→</span>
              <input
                type="date"
                value={dateTo}
                onChange={e => setDateTo(e.target.value)}
                className="h-8 rounded-md border border-border bg-background px-2 text-[12px]"
              />
            </div>
          </div>

          {/* Category filter */}
          {availableCategories.length > 0 && (
            <div className="space-y-2">
              {/* Presets */}
              <div className="space-y-1.5">
                <div className="text-[11px] font-medium text-muted-foreground uppercase tracking-wider">Presets</div>
                <div className="flex flex-wrap gap-1.5">
                  {PRESETS.map(preset => {
                    const isAll = preset.categories.length === 0;
                    const wouldApply = isAll ? availableCategories : preset.categories.filter(c => availableCategories.includes(c));
                    const hasAny = wouldApply.length > 0;
                    const isActive = activePreset === preset.label;
                    return (
                      <button
                        key={preset.label}
                        type="button"
                        disabled={!hasAny}
                        onClick={() => {
                          if (isAll) {
                            setSelectedCategories(new Set());
                            setActivePreset(preset.label);
                          } else {
                            setSelectedCategories(new Set(wouldApply));
                            setActivePreset(preset.label);
                          }
                        }}
                        className={cn(
                          'inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-[11px] transition-colors',
                          isActive
                            ? 'border-primary/40 bg-primary/10 text-primary'
                            : 'border-border bg-background text-muted-foreground hover:bg-muted/40',
                          !hasAny && 'opacity-40 cursor-not-allowed hover:bg-background'
                        )}
                      >
                        {isActive && <Check className="h-2.5 w-2.5" />}
                        {preset.label}
                        {!isAll && <span className="font-mono text-[9px] opacity-60">{wouldApply.length}</span>}
                      </button>
                    );
                  })}
                </div>
              </div>

              <div className="flex items-center justify-between pt-1">
                <div className="text-[11px] font-medium text-muted-foreground uppercase tracking-wider">Categories</div>
                <div className="flex items-center gap-1.5">
                  <button
                    type="button"
                    className="text-[10px] text-primary hover:underline"
                    onClick={() => { setSelectedCategories(new Set(availableCategories)); setActivePreset(null); }}
                  >
                    Select all
                  </button>
                  <span className="text-muted-foreground text-[10px]">|</span>
                  <button
                    type="button"
                    className="text-[10px] text-primary hover:underline"
                    onClick={() => { setSelectedCategories(new Set()); setActivePreset('All'); }}
                  >
                    Clear
                  </button>
                </div>
              </div>
              <div className="flex flex-wrap gap-1.5 max-h-[180px] overflow-y-auto pr-1">
                {availableCategories.map(cat => {
                  const checked = selectedCategories.has(cat);
                  return (
                    <label
                      key={cat}
                      className={cn(
                        'inline-flex items-center gap-1.5 cursor-pointer select-none rounded-full border px-2.5 py-1 text-[11px] transition-colors',
                        checked
                          ? 'border-primary/40 bg-primary/10 text-primary'
                          : 'border-border bg-background text-muted-foreground hover:bg-muted/40'
                      )}
                    >
                      <input
                        type="checkbox"
                        className="sr-only"
                        checked={checked}
                        onChange={() => {
                          const next = new Set(selectedCategories);
                          if (checked) next.delete(cat);
                          else next.add(cat);
                          setSelectedCategories(next);
                          setActivePreset(null);
                        }}
                      />
                      <span className={cn('h-2.5 w-2.5 rounded-full border', checked ? 'bg-primary border-primary' : 'border-muted-foreground/40')} />
                      <span className="truncate max-w-[200px]">{friendlyWalletLabel(cat, 'cash_in')}</span>
                      <span className="font-mono text-[9px] opacity-60">{cat}</span>
                    </label>
                  );
                })}
              </div>
              {categoryFilterActive && (
                <div className="text-[10px] text-muted-foreground">
                  Showing {selectedCategories.size} of {availableCategories.length} categories
                </div>
              )}
            </div>
          )}
        </div>
      )}

      <div className="flex items-center justify-between gap-2 rounded-xl border border-emerald-500/30 bg-emerald-500/[0.06] px-3 py-2">
        <span className="text-[11px] font-medium text-muted-foreground">
          Total to wallets · {count.toLocaleString()} transfer{count === 1 ? '' : 's'} · {catList.length} categor{catList.length === 1 ? 'y' : 'ies'}
        </span>
        <span className="text-sm font-bold font-mono text-emerald-600">{formatUGX(total)}</span>
      </div>

      {count === 0 ? (
        <div className="rounded-2xl border border-border bg-muted/20 p-6 text-center text-[12px] text-muted-foreground">
          No movements match the current filters.
        </div>
      ) : (
        <>
          <div className="rounded-2xl border-2 border-border/60 bg-card p-3" style={{ height: chartHeight }}>
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={chartData} layout="vertical" margin={{ top: 4, right: 16, bottom: 4, left: 8 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" horizontal={false} />
                <XAxis
                  type="number"
                  tick={{ fontSize: 10 }}
                  stroke="hsl(var(--muted-foreground))"
                  tickFormatter={(v: number) => formatUGX(v)}
                />
                <YAxis
                  type="category"
                  dataKey="name"
                  width={140}
                  tick={{ fontSize: 11 }}
                  stroke="hsl(var(--muted-foreground))"
                />
                <RechartsTooltip
                  formatter={(v: number) => [formatUGX(v), 'Moved to wallets']}
                  contentStyle={{
                    background: 'hsl(var(--popover))',
                    border: '1px solid hsl(var(--border))',
                    borderRadius: 8,
                    fontSize: 12,
                  }}
                />
                <Bar dataKey="amount" fill="hsl(160 84% 39%)" radius={[0, 4, 4, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>

          {/* Per-category detail list — expand for top recipients */}
          <div className="rounded-2xl border border-border bg-card divide-y divide-border/60">
            {catList.map(c => {
              const isOpen = expanded === c.category;
              const recs = byCatRecipients.get(c.category);
              const allRecs = recs ? [...recs.entries()].sort((a, b) => b[1] - a[1]) : [];
              const topRecs = allRecs.slice(0, 6);
              return (
                <div key={c.category}>
                  <button
                    type="button"
                    onClick={() => setExpanded(isOpen ? null : c.category)}
                    className="w-full flex items-center justify-between gap-2 px-3 py-2.5 text-left hover:bg-muted/40 transition-colors"
                  >
                    <span className="min-w-0 flex items-center gap-1.5">
                      {isOpen ? <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" /> : <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />}
                      <span className="min-w-0">
                        <span className="text-[13px] font-medium block truncate">{friendlyWalletLabel(c.category, 'cash_in')}</span>
                        <span className="text-[10px] text-muted-foreground font-mono block truncate">{c.category} · {c.count.toLocaleString()} transfer{c.count === 1 ? '' : 's'}</span>
                      </span>
                    </span>
                    <span className="font-mono font-semibold text-[13px] text-emerald-600 shrink-0">{formatUGX(c.amount)}</span>
                  </button>
                  {isOpen && (
                    <div className="px-3 pb-3 pt-0.5 space-y-1.5 bg-muted/20">
                      <div className="flex items-center justify-between pt-1.5">
                        <p className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold">
                          Top recipients{allRecs.length > topRecs.length ? ` (of ${allRecs.length})` : ''}
                        </p>
                        <button
                          type="button"
                          onClick={() => setDrill({ category: c.category, userId: 'ALL' })}
                          className="text-[10px] font-semibold text-primary hover:underline"
                        >
                          View all {c.count.toLocaleString()} transactions →
                        </button>
                      </div>
                      {topRecs.length > 0 ? topRecs.map(([id, amt]) => (
                        <button
                          key={id}
                          type="button"
                          onClick={() => setDrill({ category: c.category, userId: id })}
                          className="w-full flex items-center justify-between gap-2 text-[12px] rounded-md px-1.5 py-1 -mx-1.5 hover:bg-muted/60 transition-colors text-left"
                        >
                          <span className="truncate text-foreground/90 flex items-center gap-1.5">
                            <ChevronRight className="h-3 w-3 shrink-0 text-muted-foreground" />
                            {nameOf(id)}
                          </span>
                          <span className="font-mono font-medium shrink-0">{formatUGX(amt)}</span>
                        </button>
                      )) : (
                        <p className="text-[12px] text-muted-foreground italic">No identified recipients for this category.</p>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </>
      )}

      {/* ── Deep drill-down: every transaction behind a number ──────── */}
      <Sheet open={!!drill} onOpenChange={(o) => { if (!o) { setDrill(null); setDrillSearch(''); setDrillDirection('cash_in'); setDrillDateFrom(''); setDrillDateTo(''); } }}>
        <SheetContent side="right" className="w-full sm:max-w-lg flex flex-col p-0">
          {drill && (
            <>
              <SheetHeader className="px-4 pt-4 pb-3 border-b space-y-2">
                <SheetTitle className="flex items-center gap-2 text-base">
                  <ArrowLeftRight className="h-4 w-4 text-emerald-600" />
                  {friendlyWalletLabel(drill.category, 'cash_in')}
                </SheetTitle>
                <SheetDescription>
                  {drill.userId === 'ALL'
                    ? <>Every company → wallet transfer in <span className="font-mono">{drill.category}</span></>
                    : <>Transfers to <span className="font-semibold text-foreground">{nameOf(drill.userId)}</span> · <span className="font-mono">{drill.category}</span></>}
                </SheetDescription>

                {/* Search box */}
                <div className="relative pt-1">
                  <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
                  <Input
                    placeholder="Search recipient, reference, description, or date…"
                    value={drillSearch}
                    onChange={e => setDrillSearch(e.target.value)}
                    className="pl-8 h-8 text-[12px] rounded-md"
                  />
                  {drillSearch && (
                    <button
                      type="button"
                      onClick={() => setDrillSearch('')}
                      className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                    >
                      <X className="h-3 w-3" />
                    </button>
                  )}
                </div>

                {/* Advanced filter chips */}
                <div className="flex flex-col gap-1.5 pt-1">
                  {/* Date range */}
                  <div className="flex items-center gap-1.5 flex-wrap">
                    <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground shrink-0">Dates</span>
                    <input
                      type="date"
                      value={drillDateFrom}
                      onChange={e => setDrillDateFrom(e.target.value)}
                      className="h-7 rounded-md border border-border bg-background px-2 text-[11px]"
                    />
                    <span className="text-muted-foreground text-[11px]">→</span>
                    <input
                      type="date"
                      value={drillDateTo}
                      onChange={e => setDrillDateTo(e.target.value)}
                      className="h-7 rounded-md border border-border bg-background px-2 text-[11px]"
                    />
                    {(drillDateFrom || drillDateTo) && (
                      <button
                        type="button"
                        onClick={() => { setDrillDateFrom(''); setDrillDateTo(''); }}
                        className="text-[10px] text-primary hover:underline"
                      >
                        Clear dates
                      </button>
                    )}
                  </div>
                  {/* Direction */}
                  <div className="flex items-center gap-1.5 flex-wrap">
                    <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground shrink-0">Direction</span>
                    {(['cash_in', 'cash_out', 'both'] as const).map(dir => (
                      <button
                        key={dir}
                        type="button"
                        onClick={() => setDrillDirection(dir)}
                        className={cn(
                          'inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] transition-colors',
                          drillDirection === dir
                            ? 'border-primary/40 bg-primary/10 text-primary'
                            : 'border-border bg-background text-muted-foreground hover:bg-muted/40'
                        )}
                      >
                        {dir === 'cash_in' && <ArrowUpRight className="h-2.5 w-2.5" />}
                        {dir === 'cash_out' && <ArrowDownRight className="h-2.5 w-2.5" />}
                        {dir === 'both' && <ArrowLeftRight className="h-2.5 w-2.5" />}
                        {dir === 'cash_in' ? 'Cash In' : dir === 'cash_out' ? 'Cash Out' : 'Both'}
                      </button>
                    ))}
                  </div>
                  {/* Category — only when viewing ALL recipients */}
                  {drill.userId === 'ALL' && catList.length > 1 && (
                    <div className="flex items-center gap-1.5 flex-wrap">
                      <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground shrink-0">Category</span>
                      <div className="flex flex-wrap gap-1">
                        {catList.map(c => (
                          <button
                            key={c.category}
                            type="button"
                            onClick={() => { setDrill({ category: c.category, userId: 'ALL' }); setDrillSearch(''); }}
                            className={cn(
                              'inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] transition-colors max-w-[160px] truncate',
                              drill.category === c.category
                                ? 'border-primary/40 bg-primary/10 text-primary'
                                : 'border-border bg-background text-muted-foreground hover:bg-muted/40'
                            )}
                            title={friendlyWalletLabel(c.category, 'cash_in')}
                          >
                            {friendlyWalletLabel(c.category, 'cash_in')}
                          </button>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              </SheetHeader>
              <div className="px-4 py-3 border-b bg-muted/40 flex items-center justify-between">
                <span className="text-[11px] text-muted-foreground">
                  {drillSearch || drillDateFrom || drillDateTo
                    ? `${drillRows.length.toLocaleString()} of ${rawDrillRows.length.toLocaleString()} match${drillRows.length === 1 ? '' : 'es'}`
                    : `${drillRows.length.toLocaleString()} transaction${drillRows.length === 1 ? '' : 's'}`}
                  {drillDirection !== 'cash_in' && (
                    <span className="ml-1 font-medium text-foreground">
                      · {drillDirection === 'cash_out' ? 'Cash Out' : 'Both directions'}
                    </span>
                  )}
                  {(drillDateFrom || drillDateTo) && (
                    <span className="ml-1 font-medium text-foreground">
                      · {drillDateFrom || '…'} → {drillDateTo || '…'}
                    </span>
                  )}
                </span>
                <div className="flex items-center gap-2 shrink-0">
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={exportDrillPdf}
                    disabled={drillRows.length === 0}
                    className="h-7 gap-1 text-[11px]"
                  >
                    <FileText className="h-3.5 w-3.5" />
                    Export PDF
                  </Button>
                  <span className="text-sm font-bold font-mono text-emerald-600">{formatUGX(drillTotal)}</span>
                </div>
              </div>
              <ScrollArea className="flex-1">
                <ul className="divide-y divide-border/60">
                  {drillRows.map((r, i) => {
                    const ts = format(new Date(r.transaction_date), 'd MMM yyyy, HH:mm');
                    const isCashIn = r.direction === 'cash_in';
                    return (
                      <li key={r.id || i} className="px-4 py-2.5 space-y-1">
                        <div className="flex items-center justify-between gap-2">
                          <span className="text-[12px] font-medium text-foreground">
                            <Highlight text={ts} query={drillSearch} />
                          </span>
                          <span className={cn(
                            'text-[13px] font-mono font-semibold shrink-0',
                            isCashIn ? 'text-emerald-600' : 'text-rose-600'
                          )}>
                            {isCashIn ? '+' : '−'}{formatUGX(Number(r.amount) || 0)}
                          </span>
                        </div>
                        {drill.userId === 'ALL' && r.user_id && (
                          <p className="text-[11px] text-foreground/80 truncate">
                            <Highlight text={nameOf(r.user_id)} query={drillSearch} />
                          </p>
                        )}
                        {r.description && (
                          <p className="text-[11px] text-muted-foreground line-clamp-2">
                            <Highlight text={r.description} query={drillSearch} />
                          </p>
                        )}
                        <div className="flex items-center gap-2 flex-wrap">
                          {drillDirection !== 'cash_in' && (
                            <span className={cn(
                              'inline-flex items-center rounded px-1 py-0 text-[9px] font-medium border',
                              isCashIn
                                ? 'bg-emerald-500/10 text-emerald-600 border-emerald-500/20'
                                : 'bg-rose-500/10 text-rose-600 border-rose-500/20'
                            )}>
                              {r.ledger_scope === 'wallet' ? 'Wallet' : 'Platform'} · {isCashIn ? 'In' : 'Out'}
                            </span>
                          )}
                          {r.reference_id && (
                            <span className="text-[10px] font-mono text-muted-foreground">
                              Ref: <Highlight text={r.reference_id} query={drillSearch} />
                            </span>
                          )}
                          {r.transaction_group_id && (
                            <Link
                              to={`/ledger/${r.id || r.transaction_group_id}`}
                              className="inline-flex items-center gap-0.5 text-[10px] font-semibold text-primary hover:underline"
                            >
                              Open ledger entry <ExternalLink className="h-2.5 w-2.5" />
                            </Link>
                          )}
                        </div>
                      </li>
                    );
                  })}
                  {drillRows.length === 0 && (
                    <li className="px-4 py-8 text-center text-[12px] text-muted-foreground">
                      {drillSearch ? 'No transactions match your search.' : 'No transactions found.'}
                    </li>
                  )}
                </ul>
              </ScrollArea>
            </>
          )}
        </SheetContent>
      </Sheet>
    </section>
  );
}

// ─────────────────────────────────────────────────────────────
// Movement Timeline (strict CFO category order)
// A single, scan-able ledger of every cash movement in the period,
// grouped by category in the exact CFO sequence (LOCKED_CATEGORIES).
// Each row is a clear timeline entry: Date · Amount · Source →
// Destination. Source/destination are derived from the double-entry
// legs of each transaction group so the CFO can read, at a glance,
// where money came from and where it went.
// ─────────────────────────────────────────────────────────────
type TimelineMovement = {
  id: string;
  date: string;
  category: string;
  amount: number;
  sourceLabel: string;
  sourceParty: string | null;
  destLabel: string;
  destParty: string | null;
  reference: string | null;
  description: string | null;
  direction: 'cash_in' | 'cash_out';
  scope: string;
  raw: LedgerRow;
  groupId: string;
  groupLegs: LedgerRow[];
};

const COMPANY_LABEL = 'Company (money we have)';
const EXTERNAL_IN_LABEL = 'External (deposits / funding)';
const EXTERNAL_OUT_LABEL = 'External (payouts / withdrawals)';

type EndpointType = 'company' | 'external' | 'wallet';
function endpointType(label: string): EndpointType {
  if (label === COMPANY_LABEL) return 'company';
  if (label === EXTERNAL_IN_LABEL || label === EXTERNAL_OUT_LABEL) return 'external';
  return 'wallet';
}
const ENDPOINT_FILTER_OPTIONS: { value: EndpointType | 'all'; label: string }[] = [
  { value: 'all', label: 'Any' },
  { value: 'company', label: 'Company (money we have)' },
  { value: 'wallet', label: 'User / agent wallet' },
  { value: 'external', label: 'External' },
];

function DetailField({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="min-w-0">
      <dt className="text-[10px] uppercase tracking-wider text-muted-foreground">{label}</dt>
      <dd className={cn('text-foreground/90 truncate', mono && 'font-mono')}>{value}</dd>
    </div>
  );
}

function MovementTimeline({
  rows,
  includeAdjustments,
}: {
  rows: LedgerRow[];
  includeAdjustments: boolean;
}) {
  const [names, setNames] = useState<Record<string, string>>({});
  const [openCats, setOpenCats] = useState<Record<string, boolean>>({});
  const [limits, setLimits] = useState<Record<string, number>>({});
  const PER_CATEGORY_INITIAL = 8;
  const PER_CATEGORY_STEP = 25;

  // ── Filters (date range, CFO category, source, destination, name search) ──
  const [dateFrom, setDateFrom] = useState<string>('');
  const [dateTo, setDateTo] = useState<string>('');
  const [selectedCategories, setSelectedCategories] = useState<Set<string>>(new Set());
  const [sourceFilter, setSourceFilter] = useState<EndpointType | 'all'>('all');
  const [destFilter, setDestFilter] = useState<EndpointType | 'all'>('all');
  const [search, setSearch] = useState<string>('');
  const [catPopoverOpen, setCatPopoverOpen] = useState(false);

  // ── Category drill-down (full detail sheet) ──
  const [detailCat, setDetailCat] = useState<string | null>(null);
  const [detailSearch, setDetailSearch] = useState('');
  const [detailPage, setDetailPage] = useState(0);
  const [expandedRow, setExpandedRow] = useState<string | null>(null);
  const DETAIL_PAGE_SIZE = 50;

  const filtersActive =
    !!dateFrom || !!dateTo || selectedCategories.size > 0 ||
    sourceFilter !== 'all' || destFilter !== 'all' || !!search.trim();
  const clearFilters = () => {
    setDateFrom(''); setDateTo(''); setSelectedCategories(new Set());
    setSourceFilter('all'); setDestFilter('all'); setSearch('');
  };

  // Build one or more movements per transaction group from the
  // double-entry legs, deriving a human source → destination.
  const movements = useMemo(() => {
    const groups = new Map<string, LedgerRow[]>();
    for (const r of rows) {
      if (!includeAdjustments && (r.classification === 'admin_correction' || r.category === 'system_balance_correction')) continue;
      const gid = r.transaction_group_id || r.id || `${r.transaction_date}-${r.category}`;
      const arr = groups.get(gid) || [];
      arr.push(r);
      groups.set(gid, arr);
    }
    const out: TimelineMovement[] = [];
    for (const [gid, legs] of groups.entries()) {
      const walletLegs = legs.filter(l => l.ledger_scope === 'wallet');
      const platformLegs = legs.filter(l => l.ledger_scope === 'platform');
      const hasPlatformOut = platformLegs.some(p => p.direction === 'cash_out');
      const hasPlatformIn = platformLegs.some(p => p.direction === 'cash_in');
      const walletOutParty = walletLegs.find(w => w.direction === 'cash_out')?.user_id ?? null;
      const walletInParty = walletLegs.find(w => w.direction === 'cash_in')?.user_id ?? null;

      if (walletLegs.length) {
        // One movement per wallet leg — that is the bucket that physically moved.
        walletLegs.forEach((w, idx) => {
          const amt = Number(w.amount) || 0;
          if (!amt) return;
          let sourceLabel = COMPANY_LABEL, sourceParty: string | null = null;
          let destLabel = COMPANY_LABEL, destParty: string | null = null;
          if (w.direction === 'cash_in') {
            // Money landed in this wallet.
            destLabel = 'User / agent wallet'; destParty = w.user_id ?? null;
            if (hasPlatformOut) { sourceLabel = COMPANY_LABEL; sourceParty = null; }
            else if (walletOutParty) { sourceLabel = 'User / agent wallet'; sourceParty = walletOutParty; }
            else { sourceLabel = EXTERNAL_IN_LABEL; sourceParty = null; }
          } else {
            // Money left this wallet.
            sourceLabel = 'User / agent wallet'; sourceParty = w.user_id ?? null;
            if (hasPlatformIn) { destLabel = COMPANY_LABEL; destParty = null; }
            else if (walletInParty) { destLabel = 'User / agent wallet'; destParty = walletInParty; }
            else { destLabel = EXTERNAL_OUT_LABEL; destParty = null; }
          }
          out.push({
            id: w.id || `${gid}-w${idx}`,
            date: w.transaction_date,
            category: w.category,
            amount: amt,
            sourceLabel, sourceParty, destLabel, destParty,
            reference: w.reference_id ?? null,
            description: w.description ?? null,
            direction: w.direction,
            scope: w.ledger_scope,
            raw: w,
            groupId: gid,
            groupLegs: legs,
          });
        });
      } else if (platformLegs.length) {
        // Platform-only movement (money in/out of company, no wallet leg).
        platformLegs.forEach((p, idx) => {
          const amt = Number(p.amount) || 0;
          if (!amt) return;
          const isIn = p.direction === 'cash_in';
          out.push({
            id: p.id || `${gid}-p${idx}`,
            date: p.transaction_date,
            category: p.category,
            amount: amt,
            sourceLabel: isIn ? EXTERNAL_IN_LABEL : COMPANY_LABEL,
            sourceParty: null,
            destLabel: isIn ? COMPANY_LABEL : EXTERNAL_OUT_LABEL,
            destParty: null,
            reference: p.reference_id ?? null,
            description: p.description ?? null,
            direction: p.direction,
            scope: p.ledger_scope,
            raw: p,
            groupId: gid,
            groupLegs: legs,
          });
        });
      }
    }
    return out;
  }, [rows, includeAdjustments]);

  // Categories present in the data, in strict CFO order — drives the
  // category filter list so the CFO only sees categories that exist.
  const availableCategories = useMemo(() => {
    const set = new Set<string>();
    for (const m of movements) set.add(m.category);
    return [...set].sort((a, b) => {
      const ra = cfoCategoryRank(a), rb = cfoCategoryRank(b);
      if (ra !== rb) return ra - rb;
      return a.localeCompare(b);
    });
  }, [movements]);

  // Resolve names for ALL parties (capped) so the name search works
  // across every movement, not just the rows currently expanded.
  useEffect(() => {
    const ids = new Set<string>();
    for (const m of movements) {
      if (m.sourceParty && !names[m.sourceParty]) ids.add(m.sourceParty);
      if (m.destParty && !names[m.destParty]) ids.add(m.destParty);
    }
    const list = [...ids].slice(0, 500);
    if (!list.length) return;
    let cancelled = false;
    (async () => {
      const { data } = await supabase.from('profiles').select('id, full_name').in('id', list);
      if (cancelled || !data) return;
      const next: Record<string, string> = {};
      for (const p of data as { id: string; full_name: string | null }[]) {
        if (p.full_name) next[p.id] = p.full_name;
      }
      if (Object.keys(next).length) setNames(prev => ({ ...prev, ...next }));
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [movements]);

  // Apply all active filters to the flat movement list.
  const filteredMovements = useMemo(() => {
    const fromTs = dateFrom ? new Date(dateFrom + 'T00:00:00').getTime() : null;
    const toTs = dateTo ? new Date(dateTo + 'T23:59:59').getTime() : null;
    const q = search.trim().toLowerCase();
    return movements.filter(m => {
      if (selectedCategories.size > 0 && !selectedCategories.has(m.category)) return false;
      if (sourceFilter !== 'all' && endpointType(m.sourceLabel) !== sourceFilter) return false;
      if (destFilter !== 'all' && endpointType(m.destLabel) !== destFilter) return false;
      if (fromTs !== null || toTs !== null) {
        const t = new Date(m.date).getTime();
        if (fromTs !== null && t < fromTs) return false;
        if (toTs !== null && t > toTs) return false;
      }
      if (q) {
        const srcName = m.sourceParty ? (names[m.sourceParty] || m.sourceParty) : '';
        const dstName = m.destParty ? (names[m.destParty] || m.destParty) : '';
        const hay = [
          srcName, dstName, m.sourceLabel, m.destLabel,
          m.reference || '', m.description || '', m.category,
        ].join(' ').toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [movements, selectedCategories, sourceFilter, destFilter, dateFrom, dateTo, search, names]);

  // Group by category, then order categories by the strict CFO sequence.
  const categoryGroups = useMemo(() => {
    const byCat = new Map<string, { total: number; items: TimelineMovement[] }>();
    for (const m of filteredMovements) {
      const g = byCat.get(m.category) || { total: 0, items: [] };
      g.total += m.amount; g.items.push(m); byCat.set(m.category, g);
    }
    const groups = [...byCat.entries()].map(([category, g]) => ({
      category,
      total: g.total,
      count: g.items.length,
      items: g.items.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime()),
    }));
    groups.sort((a, b) => {
      const ra = cfoCategoryRank(a.category);
      const rb = cfoCategoryRank(b.category);
      if (ra !== rb) return ra - rb;
      return b.total - a.total;
    });
    return groups;
  }, [filteredMovements]);

  const grandTotal = useMemo(() => filteredMovements.reduce((s, m) => s + m.amount, 0), [filteredMovements]);

  const partyName = (id: string | null, fallbackLabel: string) =>
    id ? (names[id] || `${id.slice(0, 8)}…`) : fallbackLabel;

  const Endpoint = ({ label, party }: { label: string; party: string | null }) => {
    const isCompany = label === COMPANY_LABEL;
    const isExternal = label === EXTERNAL_IN_LABEL || label === EXTERNAL_OUT_LABEL;
    return (
      <span
        className={cn(
          'inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] max-w-[160px]',
          isCompany ? 'bg-primary/10 text-primary'
            : isExternal ? 'bg-muted text-muted-foreground'
            : 'bg-amber-500/10 text-amber-600',
        )}
      >
        {isCompany ? <Landmark className="h-3 w-3 shrink-0" />
          : isExternal ? <ExternalLink className="h-3 w-3 shrink-0" />
          : <WalletIcon className="h-3 w-3 shrink-0" />}
        <span className="truncate">{party ? partyName(party, label) : label}</span>
      </span>
    );
  };

  // ── Build the currently-filtered movement list for a given category ──
  const buildDetailRows = useCallback((cat: string): TimelineMovement[] => {
    const all = filteredMovements
      .filter(m => m.category === cat)
      .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
    const q = detailSearch.trim().toLowerCase();
    if (!q) return all;
    return all.filter(m => {
      const srcName = m.sourceParty ? (names[m.sourceParty] || m.sourceParty) : '';
      const dstName = m.destParty ? (names[m.destParty] || m.destParty) : '';
      return [
        srcName, dstName, m.sourceLabel, m.destLabel,
        m.reference || '', m.description || '', m.raw.source_table || '',
        String(m.raw.source_id || ''),
      ].join(' ').toLowerCase().includes(q);
    });
  }, [filteredMovements, detailSearch, names]);

  // CSV/PDF columns include the movement row plus every double-entry leg.
  const DETAIL_EXPORT_HEADERS = [
    'Date', 'Category', 'Amount (UGX)', 'Direction', 'Scope', 'Classification',
    'Source', 'Destination', 'Reference', 'Description', 'Source table', 'Source ID',
    'Txn group', 'Leg #', 'Leg scope', 'Leg category', 'Leg direction', 'Leg amount (UGX)',
  ];

  const buildDetailExportRows = useCallback((cat: string): (string | number)[][] => {
    const matched = buildDetailRows(cat);
    const out: (string | number)[][] = [];
    for (const m of matched) {
      const base = [
        format(new Date(m.date), 'yyyy-MM-dd HH:mm:ss'),
        prettifyCategory(m.category),
        Math.round(m.amount),
        m.direction === 'cash_in' ? 'Cash in' : 'Cash out',
        SCOPE_LABEL[m.scope] || m.scope,
        m.raw.classification || '',
        m.sourceParty ? partyName(m.sourceParty, m.sourceLabel) : m.sourceLabel,
        m.destParty ? partyName(m.destParty, m.destLabel) : m.destLabel,
        m.reference || '',
        m.description || '',
        m.raw.source_table || '',
        m.raw.source_id ? String(m.raw.source_id) : '',
        m.groupId,
      ];
      if (m.groupLegs.length === 0) {
        out.push([...base, '', '', '', '', '']);
      } else {
        m.groupLegs.forEach((leg, i) => {
          out.push([
            ...base,
            i + 1,
            SCOPE_LABEL[leg.ledger_scope] || leg.ledger_scope,
            prettifyCategory(leg.category),
            leg.direction === 'cash_in' ? 'Cash in' : 'Cash out',
            Math.round(Number(leg.amount) || 0),
          ]);
        });
      }
    }
    return out;
  }, [buildDetailRows, names]);

  const exportDetailCsv = useCallback((cat: string) => {
    const rows = buildDetailExportRows(cat);
    if (rows.length === 0) { toast.error('Nothing to export'); return; }
    downloadCsv(
      `welile-${cat}-detail-${format(new Date(), 'yyyy-MM-dd')}.csv`,
      DETAIL_EXPORT_HEADERS,
      rows,
    );
    toast.success('CSV exported');
  }, [buildDetailExportRows]);

  const exportDetailPdf = useCallback((cat: string) => {
    const matched = buildDetailRows(cat);
    const rows = buildDetailExportRows(cat);
    if (rows.length === 0) { toast.error('Nothing to export'); return; }
    const total = matched.reduce((s, m) => s + m.amount, 0);
    const doc = new jsPDF({ orientation: 'landscape', unit: 'pt', format: 'a4' });
    doc.setFont('helvetica', 'bold'); doc.setFontSize(14);
    doc.text(`Cash Movement Detail — ${prettifyCategory(cat)}`, 40, 36);
    doc.setFont('helvetica', 'normal'); doc.setFontSize(9); doc.setTextColor(110);
    doc.text(`Generated: ${format(new Date(), 'yyyy-MM-dd HH:mm')}  ·  Movements: ${matched.length.toLocaleString()}  ·  Total: ${formatUGX(total)}`, 40, 52);
    autoTable(doc, {
      startY: 64,
      head: [DETAIL_EXPORT_HEADERS],
      body: rows.map(r => r.map(c => (c === null || c === undefined ? '' : String(c)))),
      styles: { fontSize: 6, cellPadding: 2, overflow: 'linebreak', valign: 'top' },
      headStyles: { fillColor: [146, 52, 234], textColor: 255, fontStyle: 'bold', fontSize: 6 },
      alternateRowStyles: { fillColor: [250, 250, 252] },
      margin: { left: 20, right: 20, bottom: 30 },
    });
    doc.save(`welile-${cat}-detail-${format(new Date(), 'yyyy-MM-dd')}.pdf`);
    toast.success('PDF exported');
  }, [buildDetailRows, buildDetailExportRows]);

  return (
    <section id="cm-timeline" className="scroll-mt-24 space-y-3">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <ArrowLeftRight className="h-4 w-4 text-primary" />
          <h4 className="text-sm font-semibold">Movement Timeline · CFO order</h4>
        </div>
        <span className="text-[11px] text-muted-foreground font-mono">
          {filteredMovements.length.toLocaleString()}
          {filtersActive && <span className="opacity-70"> / {movements.length.toLocaleString()}</span>} moves · {formatUGX(grandTotal)}
        </span>
      </div>
      <p className="text-[11px] text-muted-foreground -mt-1">
        Every cash movement this period, grouped strictly in the CFO category order. Each entry shows
        the date, amount, and exactly where the money came from and where it went.
      </p>

      {/* ── Filters ───────────────────────────────────────────── */}
      <div className="rounded-lg border border-border bg-muted/20 p-2.5 space-y-2">
        {/* Name / wallet search */}
        <div className="relative">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search wallet or user name, reference, description…"
            className="h-8 pl-8 text-xs"
          />
        </div>
        <div className="grid grid-cols-2 lg:grid-cols-5 gap-2">
          {/* Date range */}
          <div className="flex flex-col gap-1">
            <label className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold">From</label>
            <Input type="date" value={dateFrom} onChange={(e) => setDateFrom(e.target.value)} className="h-8 text-xs" />
          </div>
          <div className="flex flex-col gap-1">
            <label className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold">To</label>
            <Input type="date" value={dateTo} onChange={(e) => setDateTo(e.target.value)} className="h-8 text-xs" />
          </div>
          {/* Source */}
          <div className="flex flex-col gap-1">
            <label className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold">Source</label>
            <select
              value={sourceFilter}
              onChange={(e) => setSourceFilter(e.target.value as EndpointType | 'all')}
              className="h-8 rounded-md border border-input bg-background px-2 text-xs"
            >
              {ENDPOINT_FILTER_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
          </div>
          {/* Destination */}
          <div className="flex flex-col gap-1">
            <label className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold">Destination</label>
            <select
              value={destFilter}
              onChange={(e) => setDestFilter(e.target.value as EndpointType | 'all')}
              className="h-8 rounded-md border border-input bg-background px-2 text-xs"
            >
              {ENDPOINT_FILTER_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
          </div>
          {/* CFO category multi-select */}
          <div className="flex flex-col gap-1">
            <label className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold">CFO category</label>
            <Popover open={catPopoverOpen} onOpenChange={setCatPopoverOpen}>
              <PopoverTrigger asChild>
                <Button variant="outline" className="h-8 justify-between text-xs font-normal px-2">
                  <span className="truncate">
                    {selectedCategories.size === 0 ? 'All categories' : `${selectedCategories.size} selected`}
                  </span>
                  <ChevronDown className="h-3.5 w-3.5 shrink-0 opacity-60" />
                </Button>
              </PopoverTrigger>
              <PopoverContent align="end" className="w-64 p-0">
                <div className="flex items-center justify-between px-3 py-2 border-b border-border">
                  <span className="text-[11px] font-semibold">Filter by category</span>
                  {selectedCategories.size > 0 && (
                    <button type="button" className="text-[10px] text-primary hover:underline"
                      onClick={() => setSelectedCategories(new Set())}>Clear</button>
                  )}
                </div>
                <div className="max-h-72 overflow-y-auto p-1">
                  {availableCategories.length === 0 && (
                    <div className="text-[11px] text-muted-foreground italic px-2 py-3 text-center">No categories.</div>
                  )}
                  {availableCategories.map(cat => {
                    const checked = selectedCategories.has(cat);
                    return (
                      <button
                        key={cat}
                        type="button"
                        onClick={() => setSelectedCategories(prev => {
                          const next = new Set(prev);
                          if (next.has(cat)) next.delete(cat); else next.add(cat);
                          return next;
                        })}
                        className="w-full flex items-center gap-2 px-2 py-1.5 rounded-md hover:bg-muted/60 text-left"
                      >
                        <Checkbox checked={checked} className="pointer-events-none" />
                        <span className="text-[12px] truncate">
                          <span className="font-medium">{prettifyCategory(cat)}</span>
                          <span className="text-muted-foreground ml-1">· {categoryFriendlyLabel(cat)}</span>
                        </span>
                      </button>
                    );
                  })}
                </div>
              </PopoverContent>
            </Popover>
          </div>
        </div>
        {filtersActive && (
          <div className="flex items-center justify-between gap-2 pt-0.5">
            <span className="text-[10px] text-muted-foreground">
              Showing {filteredMovements.length.toLocaleString()} of {movements.length.toLocaleString()} movements
            </span>
            <button type="button" onClick={clearFilters}
              className="inline-flex items-center gap-1 text-[11px] text-primary font-medium hover:underline">
              <X className="h-3 w-3" /> Clear filters
            </button>
          </div>
        )}
      </div>

      {categoryGroups.length === 0 && (
        <div className="text-[12px] text-muted-foreground italic rounded-lg border border-border p-4 text-center">
          {filtersActive ? 'No movements match these filters.' : 'No movements in this period.'}
        </div>
      )}

      <div className="space-y-2">
        {categoryGroups.map((g) => {
          // When any filter is active, auto-expand so matches are visible
          // (still allow manual collapse via explicit state).
          const isOpen = openCats[g.category] ?? (filtersActive || categoryGroups.length <= 3);
          const limit = limits[g.category] ?? PER_CATEGORY_INITIAL;
          const shown = g.items.slice(0, limit);
          return (
            <Collapsible
              key={g.category}
              open={isOpen}
              onOpenChange={(o) => setOpenCats(prev => ({ ...prev, [g.category]: o }))}
              className="rounded-lg border border-border bg-background overflow-hidden"
            >
              <div className="w-full flex items-center justify-between gap-2 px-3 py-2.5 hover:bg-muted/40 transition-colors">
                <CollapsibleTrigger className="flex items-center gap-2 min-w-0 flex-1 text-left">
                  <ChevronRight className={cn('h-4 w-4 shrink-0 text-muted-foreground transition-transform', isOpen && 'rotate-90')} />
                  <div className="min-w-0">
                    <span className="text-[13px] font-medium truncate block">{prettifyCategory(g.category)}</span>
                    <span className="text-[11px] text-muted-foreground truncate block">
                      {friendlyWalletLabel(g.category, dominantDirection(g.items))}
                    </span>
                  </div>
                  <Badge variant="outline" className="text-[10px] shrink-0">{g.count}</Badge>
                </CollapsibleTrigger>
                <div className="flex items-center gap-2 shrink-0">
                  <span className="font-mono text-[12px] font-semibold">{formatUGX(g.total)}</span>
                  <button
                    type="button"
                    onClick={() => { setDetailCat(g.category); setDetailSearch(''); setDetailPage(0); setExpandedRow(null); }}
                    className="inline-flex items-center gap-1 rounded-md border border-border bg-background px-2 py-1 text-[10px] font-medium text-primary hover:bg-muted transition-colors"
                  >
                    Details <ArrowRight className="h-3 w-3" />
                  </button>
                </div>
              </div>
              <CollapsibleContent>
                <div className="border-t border-border divide-y divide-border/40">
                  {shown.map((m) => (
                    <div key={m.id} className="px-3 py-2 flex items-start justify-between gap-3">
                      <div className="min-w-0 flex-1 space-y-1">
                        <div className="text-[11px] text-muted-foreground font-mono">
                          {format(new Date(m.date), 'dd MMM yyyy · HH:mm')}
                        </div>
                        <div className="flex items-center gap-1.5 flex-wrap">
                          <Endpoint label={m.sourceLabel} party={m.sourceParty} />
                          <ArrowRight className="h-3 w-3 text-muted-foreground shrink-0" />
                          <Endpoint label={m.destLabel} party={m.destParty} />
                        </div>
                        {m.description && (
                          <div className="text-[10px] text-muted-foreground truncate">{m.description}</div>
                        )}
                        {m.reference && (
                          <div className="text-[10px] text-muted-foreground/70 font-mono truncate">{m.reference}</div>
                        )}
                      </div>
                      <div className="font-mono text-[12px] font-semibold text-foreground shrink-0">
                        {formatUGX(m.amount)}
                      </div>
                    </div>
                  ))}
                  {g.items.length > limit && (
                    <button
                      type="button"
                      onClick={() => setLimits(prev => ({ ...prev, [g.category]: limit + PER_CATEGORY_STEP }))}
                      className="w-full text-[11px] text-primary font-medium py-2 hover:bg-muted/40 transition-colors"
                    >
                      Show {Math.min(PER_CATEGORY_STEP, g.items.length - limit)} more of {g.items.length.toLocaleString()}
                    </button>
                  )}
                </div>
              </CollapsibleContent>
            </Collapsible>
          );
        })}
      </div>

      {/* ── Category drill-down: every movement + full raw detail ── */}
      <Sheet open={!!detailCat} onOpenChange={(o) => { if (!o) setDetailCat(null); }}>
        <SheetContent side="right" className="w-full sm:max-w-2xl overflow-y-auto">
          {detailCat && (() => {
            const all = filteredMovements
              .filter(m => m.category === detailCat)
              .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
            const q = detailSearch.trim().toLowerCase();
            const matched = q
              ? all.filter(m => {
                  const srcName = m.sourceParty ? (names[m.sourceParty] || m.sourceParty) : '';
                  const dstName = m.destParty ? (names[m.destParty] || m.destParty) : '';
                  return [
                    srcName, dstName, m.sourceLabel, m.destLabel,
                    m.reference || '', m.description || '', m.raw.source_table || '',
                    String(m.raw.source_id || ''),
                  ].join(' ').toLowerCase().includes(q);
                })
              : all;
            const total = matched.reduce((s, m) => s + m.amount, 0);
            const totalPages = Math.max(1, Math.ceil(matched.length / DETAIL_PAGE_SIZE));
            const page = Math.min(detailPage, totalPages - 1);
            const slice = matched.slice(page * DETAIL_PAGE_SIZE, (page + 1) * DETAIL_PAGE_SIZE);
            return (
              <>
                <SheetHeader>
                  <SheetTitle className="flex items-center gap-2 flex-wrap">
                    <span className="truncate">
                      {categoryFriendlyLabel(detailCat, matched.length > 0 ? dominantDirection(matched) : undefined)}
                    </span>
                    <Badge variant="secondary" className="text-[10px]">{matched.length.toLocaleString()} movements</Badge>
                  </SheetTitle>
                  <SheetDescription>
                    <span className="font-mono text-[11px] text-muted-foreground block mb-0.5">{detailCat}</span>
                    {CATEGORY_DESCRIPTIONS[detailCat] || 'Every movement in this category, with full ledger detail. Tap a row to expand every field and its double-entry legs.'}
                  </SheetDescription>
                </SheetHeader>

                <div className="mt-3 rounded-lg border border-border bg-muted/30 p-3 flex items-center justify-between">
                  <span className="text-[11px] text-muted-foreground">Total in view</span>
                  <span className="font-mono text-sm font-semibold">{formatUGX(total)}</span>
                </div>

                <div className="mt-3 flex items-center gap-2">
                  <Button
                    size="sm" variant="outline"
                    className="h-8 flex-1 gap-1.5 text-xs"
                    disabled={matched.length === 0}
                    onClick={() => exportDetailCsv(detailCat)}
                  >
                    <FileSpreadsheet className="h-3.5 w-3.5" /> Export CSV
                  </Button>
                  <Button
                    size="sm" variant="outline"
                    className="h-8 flex-1 gap-1.5 text-xs"
                    disabled={matched.length === 0}
                    onClick={() => exportDetailPdf(detailCat)}
                  >
                    <FileText className="h-3.5 w-3.5" /> Export PDF
                  </Button>
                </div>
                <p className="mt-1 text-[10px] text-muted-foreground">
                  Exports every movement in view plus all double-entry ledger legs.
                </p>

                <div className="mt-3 relative">
                  <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
                  <Input
                    value={detailSearch}
                    onChange={(e) => { setDetailSearch(e.target.value); setDetailPage(0); }}
                    placeholder="Search name, reference, description, source…"
                    className="h-8 pl-8 text-xs"
                  />
                </div>

                <div className="mt-3 space-y-1.5 border-t border-border pt-2">
                  {slice.length === 0 && (
                    <div className="text-[11px] text-muted-foreground italic py-6 text-center">No movements match.</div>
                  )}
                  {slice.map((m) => {
                    const open = expandedRow === m.id;
                    return (
                      <div key={m.id} className="rounded-md border border-border/60 overflow-hidden">
                        <button
                          type="button"
                          onClick={() => setExpandedRow(open ? null : m.id)}
                          className="w-full flex items-start justify-between gap-3 px-2.5 py-2 text-left hover:bg-muted/40 transition-colors"
                        >
                          <div className="min-w-0 flex-1 space-y-1">
                            <div className="text-[11px] text-muted-foreground font-mono">
                              {format(new Date(m.date), 'dd MMM yyyy · HH:mm')}
                            </div>
                            <div className="flex items-center gap-1.5 flex-wrap">
                              <Endpoint label={m.sourceLabel} party={m.sourceParty} />
                              <ArrowRight className="h-3 w-3 text-muted-foreground shrink-0" />
                              <Endpoint label={m.destLabel} party={m.destParty} />
                            </div>
                          </div>
                          <div className="flex items-center gap-1.5 shrink-0">
                            <span className="font-mono text-[12px] font-semibold">{formatUGX(m.amount)}</span>
                            <ChevronDown className={cn('h-3.5 w-3.5 text-muted-foreground transition-transform', open && 'rotate-180')} />
                          </div>
                        </button>
                        {open && (
                          <div className="border-t border-border/60 bg-muted/20 px-2.5 py-2 space-y-2">
                            <dl className="grid grid-cols-2 gap-x-3 gap-y-1.5 text-[11px]">
                              <DetailField label="Date" value={format(new Date(m.date), 'dd MMM yyyy HH:mm:ss')} />
                              <DetailField label="Amount" value={formatUGX(m.amount)} mono />
                              <DetailField label="Category" value={categoryFriendlyLabel(m.category, m.direction)} />
                              <DetailField label="Direction" value={m.direction === 'cash_in' ? 'Cash in' : 'Cash out'} />
                              <DetailField label="Scope" value={SCOPE_LABEL[m.scope] || m.scope} />
                              <DetailField label="Classification" value={m.raw.classification || '—'} />
                              <DetailField label="Source" value={m.sourceParty ? partyName(m.sourceParty, m.sourceLabel) : m.sourceLabel} />
                              <DetailField label="Destination" value={m.destParty ? partyName(m.destParty, m.destLabel) : m.destLabel} />
                              <DetailField label="Reference" value={m.reference || '—'} mono />
                              <DetailField label="Source table" value={m.raw.source_table || '—'} mono />
                              <DetailField label="Source ID" value={m.raw.source_id ? String(m.raw.source_id) : '—'} mono />
                              <DetailField label="Txn group" value={m.groupId} mono />
                            </dl>
                            {m.description && (
                              <div className="text-[11px]">
                                <span className="text-muted-foreground">Description: </span>
                                <span className="text-foreground/90">{m.description}</span>
                              </div>
                            )}
                            {m.groupLegs.length > 0 && (
                              <div className="space-y-1 pt-1 border-t border-border/50">
                                <div className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold">
                                  Double-entry legs ({m.groupLegs.length})
                                </div>
                                {m.groupLegs.map((leg, i) => (
                                  <div key={leg.id || i} className="flex items-center justify-between gap-2 text-[11px]">
                                    <span className="truncate text-foreground/80">
                                      <span className={cn('font-mono mr-1', leg.direction === 'cash_in' ? 'text-success' : 'text-destructive')}>
                                        {leg.direction === 'cash_in' ? '+' : '−'}
                                      </span>
                                      {SCOPE_LABEL[leg.ledger_scope] || leg.ledger_scope} · {categoryFriendlyLabel(leg.category, leg.direction)}
                                    </span>
                                    <span className="font-mono shrink-0">{formatUGX(Number(leg.amount) || 0)}</span>
                                  </div>
                                ))}
                              </div>
                            )}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>

                {matched.length > DETAIL_PAGE_SIZE && (
                  <div className="mt-3 flex items-center justify-between gap-2 text-[10px]">
                    <div className="text-muted-foreground">
                      {page * DETAIL_PAGE_SIZE + 1}–{Math.min((page + 1) * DETAIL_PAGE_SIZE, matched.length)} of {matched.length.toLocaleString()}
                    </div>
                    <div className="flex gap-1">
                      <Button size="sm" variant="outline" className="h-6 px-2 text-[10px]"
                        disabled={page === 0} onClick={() => setDetailPage(p => Math.max(0, p - 1))}>‹ Prev</Button>
                      <Button size="sm" variant="outline" className="h-6 px-2 text-[10px]"
                        disabled={page >= totalPages - 1} onClick={() => setDetailPage(p => Math.min(totalPages - 1, p + 1))}>Next ›</Button>
                    </div>
                  </div>
                )}
              </>
            );
          })()}
        </SheetContent>
      </Sheet>
    </section>
  );
}

export function ComprehensiveCashMovement() {
  const { role, roles } = useAuth();
  const canViewLedgerDetail = useMemo(() => {
    if (role && LEDGER_DETAIL_ROLES.has(role)) return true;
    return (roles || []).some(r => LEDGER_DETAIL_ROLES.has(r));
  }, [role, roles]);

  const [period, setPeriod] = useState<PeriodKey>('30d');
  const [granularity, setGranularity] = useState<Granularity>('daily');
  const [includeAdjustments, setIncludeAdjustments] = useState(false);
  // Plain-English / "Simple" mode — hides accounting jargon, big tables,
  // and matrix views so a non-tech reader sees just the friendly summary.
  // Persisted; defaults to ON for phone-sized screens.
  const [simpleMode, setSimpleMode] = useState<boolean>(() => {
    if (typeof window === 'undefined') return true;
    const saved = window.localStorage.getItem('welile.cashMovement.simpleMode');
    if (saved === '1') return true;
    if (saved === '0') return false;
    return window.matchMedia?.('(max-width: 640px)').matches ?? true;
  });
  useEffect(() => {
    if (typeof window === 'undefined') return;
    window.localStorage.setItem('welile.cashMovement.simpleMode', simpleMode ? '1' : '0');
  }, [simpleMode]);
  const [scopeFilter, setScopeFilter] = useState<'all' | 'platform' | 'wallet' | 'bridge'>('all');
  const [directionQuickFilter, setDirectionQuickFilter] = useState<'all' | 'cash_in' | 'cash_out' | 'net_positive' | 'net_negative'>('all');
  // Persisted category quick filter — survives navigation, filter changes,
  // and reloads. `null` (no filter) is stored as an empty string so absence
  // is unambiguous. Pure UI state.
  const CATEGORY_QUICK_FILTER_STORAGE = 'welile-cm-category-quick-filter';
  const [categoryQuickFilter, setCategoryQuickFilter] = useState<string | null>(() => {
    if (typeof window === 'undefined') return null;
    try {
      const raw = window.localStorage.getItem(CATEGORY_QUICK_FILTER_STORAGE);
      return raw && raw.length > 0 ? raw : null;
    } catch {
      return null;
    }
  });
  useEffect(() => {
    try {
      window.localStorage.setItem(CATEGORY_QUICK_FILTER_STORAGE, categoryQuickFilter ?? '');
    } catch {
      /* ignore quota / privacy-mode errors */
    }
  }, [categoryQuickFilter]);
  // Controls how many categories the Top Categories widget surfaces.
  // Persisted in localStorage so the choice survives navigation, filter
  // changes, and reloads. Pure UI state — does not change aggregation
  // or table filters.
  const TOP_CATEGORIES_LIMIT_STORAGE = 'welile-cm-top-categories-limit';
  const [topCategoriesLimit, setTopCategoriesLimit] = useState<5 | 10>(() => {
    if (typeof window === 'undefined') return 5;
    try {
      const raw = window.localStorage.getItem(TOP_CATEGORIES_LIMIT_STORAGE);
      return raw === '10' ? 10 : 5;
    } catch {
      return 5;
    }
  });
  useEffect(() => {
    try {
      window.localStorage.setItem(TOP_CATEGORIES_LIMIT_STORAGE, String(topCategoriesLimit));
    } catch {
      /* ignore quota / privacy-mode errors */
    }
  }, [topCategoriesLimit]);
  // Page-level party filter — narrows totals and aggregates to a single
  // counterparty (resolved by user_id). `null` = everyone. Surfaced via the
  // big thumb-friendly Party button at the top of the page.
  const [partyQuickFilter, setPartyQuickFilter] = useState<string | null>(null);
  // Bottom-sheet open states for the thumb-friendly Date/Direction/Party
  // pickers. Each opens a full-width sheet that's easy to tap on a phone.
  const [dateSheetOpen, setDateSheetOpen] = useState(false);
  const [directionSheetOpen, setDirectionSheetOpen] = useState(false);
  const [partySheetOpen, setPartySheetOpen] = useState(false);
  const [partySearch, setPartySearch] = useState('');
  // "Tap to see details" — how many rows of the page-level transaction
  // drilldown list are currently rendered. Starts small for phone perf,
  // grows in chunks when the user taps "Show more".
  const [pageDrillVisible, setPageDrillVisible] = useState<number>(25);
  // Controls the page-level "Tap to see details" drilldown so the
  // three "See where this comes from" tile links can open it
  // programmatically and scroll it into view.
  const [pageDrillOpen, setPageDrillOpen] = useState<boolean>(false);
  const pageDrillRef = useRef<HTMLDivElement | null>(null);
  // Page-level quick search across the "Tap to see details" transaction
  // list. Matches reference_id, party name/UUID, description, category,
  // and amount (digits-only). Persisted so the filter survives navigation
  // and reloads. Debounced 200ms to keep typing snappy on large lists.
  const PAGE_SEARCH_STORAGE = 'welile-cm-page-search';
  const [pageSearch, setPageSearch] = useState<string>(() => {
    if (typeof window === 'undefined') return '';
    try { return window.localStorage.getItem(PAGE_SEARCH_STORAGE) || ''; } catch { return ''; }
  });
  const [debouncedPageSearch, setDebouncedPageSearch] = useState<string>(pageSearch);
  useEffect(() => {
    try { window.localStorage.setItem(PAGE_SEARCH_STORAGE, pageSearch); } catch { /* ignore */ }
    const t = window.setTimeout(() => setDebouncedPageSearch(pageSearch), 200);
    return () => window.clearTimeout(t);
  }, [pageSearch]);
  const openPageDrill = useCallback(
    (dir: 'all' | 'cash_in' | 'cash_out' | 'net_positive' | 'net_negative') => {
      setDirectionQuickFilter(dir);
      setPageDrillVisible(25);
      setPageDrillOpen(true);
      setTimeout(() => {
        pageDrillRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }, 60);
    },
    [],
  );
  const [loading, setLoading] = useState(false);
  const [rows, setRows] = useState<LedgerRow[]>([]);
  const [generatedAt, setGeneratedAt] = useState<Date | null>(null);
  const [autoRefresh, setAutoRefresh] = useState<boolean>(false);
  const [drill, setDrill] = useState<null | { category: string; scope: string; bucket: string | null; direction?: 'cash_in' | 'cash_out'; dateFrom?: string; dateTo?: string }>(null);
  const [partyNames, setPartyNames] = useState<Record<string, string>>({});
  const [drillQuery, setDrillQuery] = useState('');
  const [debouncedDrillQuery, setDebouncedDrillQuery] = useState('');
  const [drillPage, setDrillPage] = useState(0);
  const [drillPageSize, setDrillPageSize] = useState<number>(100);
  const [expandedCards, setExpandedCards] = useState<Set<string>>(new Set());
  // Drill date filter chips — narrow expanded transactions by a relative or custom range
  type DrillDatePreset = 'inherit' | '1d' | '2d' | '3d' | '5d' | '7d' | '30d' | 'custom';
  const [drillDatePreset, setDrillDatePreset] = useState<DrillDatePreset>('inherit');
  const [drillCustomFrom, setDrillCustomFrom] = useState<string>('');
  const [drillCustomTo, setDrillCustomTo] = useState<string>('');
  const effectiveDrillRange = useMemo<{ from?: string; to?: string }>(() => {
    if (drillDatePreset === 'inherit') return {};
    if (drillDatePreset === 'custom') {
      return { from: drillCustomFrom || undefined, to: drillCustomTo || undefined };
    }
    const days = parseInt(drillDatePreset, 10);
    const today = new Date();
    const from = new Date(today);
    from.setDate(today.getDate() - (days - 1));
    const fmt = (d: Date) => format(d, 'yyyy-MM-dd');
    return { from: fmt(from), to: fmt(today) };
  }, [drillDatePreset, drillCustomFrom, drillCustomTo]);

  // ── Capital Inflows callout (platform-scope cash_in for selected categories)
  const CAPITAL_INFLOW_DEFAULT = ['partner_funding', 'pending_portfolio_topup'];
  const CAPITAL_INFLOW_STORAGE = 'welile-capital-inflow-categories';
  const [capitalCategories, setCapitalCategories] = useState<Set<string>>(() => {
    try {
      const raw = localStorage.getItem(CAPITAL_INFLOW_STORAGE);
      if (raw) return new Set(JSON.parse(raw) as string[]);
    } catch {}
    return new Set(CAPITAL_INFLOW_DEFAULT);
  });
  const [capitalPickerOpen, setCapitalPickerOpen] = useState(false);
  useEffect(() => {
    try { localStorage.setItem(CAPITAL_INFLOW_STORAGE, JSON.stringify(Array.from(capitalCategories))); } catch {}
  }, [capitalCategories]);

  // Optional sub-range filter scoped to the Capital Inflows callout (and its
  // drill-downs). Dates are inclusive `yyyy-MM-dd` strings; empty means
  // "use the full loaded period".
  const [capitalFrom, setCapitalFrom] = useState<string>('');
  const [capitalTo, setCapitalTo] = useState<string>('');
  // Toggle: also surface the matching wallet-scope legs (cash_in/cash_out on
  // agent/partner wallets) that share a transaction_group_id with each
  // selected platform.cash_in entry. Off = pure platform-only inflow view.
  const [includeWalletLegs, setIncludeWalletLegs] = useState<boolean>(false);
  const capitalRangeActive = !!(capitalFrom || capitalTo);
  const inCapitalRange = (iso: string) => {
    if (!capitalRangeActive) return true;
    const d = iso.slice(0, 10);
    if (capitalFrom && d < capitalFrom) return false;
    if (capitalTo && d > capitalTo) return false;
    return true;
  };

  const generate = async () => {
    setLoading(true);
    try {
      const { from } = periodRange(period);
      // Keyset (cursor) pagination on transaction_date, de-duplicated by id.
      // OFFSET paging re-scanned and re-sorted the whole ledger on every page,
      // which grew quadratically and tripped the Postgres statement timeout
      // (HTTP 500) past ~20k rows. A `>= cursor` window walks the
      // (transaction_date, id) index instead. Rows that share the boundary
      // timestamp are carried over and de-duplicated, so no row is dropped or
      // counted twice.
      // Rows come from the staff-gated `get_cfo_cash_movement_rows` reporting
      // function instead of a direct REST read: the REST path re-evaluated the
      // ledger RLS policies per row (~3s per 1,000 rows) on top of the deep
      // OFFSET, so large periods returned HTTP 500. Same columns, same order,
      // same rows — only the transport changed.
      // The API caps every response at 1,000 rows, so the page size must match
      // that cap — a larger PAGE made the loop stop after the first response
      // and silently loaded only the first ~day of the period.
      const PAGE = 1000;
      const acc: LedgerRow[] = [];
      const seen = new Set<string>();
      let cursorDate: string | null = from ? from.toISOString() : null;
      let pages = 0;
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const { data, error } = await supabase.rpc('get_cfo_cash_movement_rows', {
          p_from: from ? from.toISOString() : null,
          p_after: cursorDate,
          p_limit: PAGE,
        } as any);
        if (error) throw error;
        const batch = (data || []) as unknown as LedgerRow[];
        let added = 0;
        for (const r of batch) {
          if (seen.has(r.id)) continue;
          seen.add(r.id);
          acc.push(r);
          added += 1;
        }
        if (batch.length < PAGE) break;
        // Nothing new on a full page means every row shares the cursor
        // timestamp — advance by 1ms to avoid an infinite loop.
        const last = batch[batch.length - 1];
        cursorDate = added === 0
          ? new Date(new Date(last.transaction_date).getTime() + 1).toISOString()
          : last.transaction_date;
        pages += 1;
        if (pages > 2000) break; // safety cap
      }
      setRows(acc);
      setGeneratedAt(new Date());
    } catch (err: any) {
      console.error('[CashMovement] load failed', err);
      toast.error('Failed to load ledger');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { generate(); /* eslint-disable-next-line */ }, [period]);

  // Auto-refresh every 60s when enabled (skip while a fetch is in flight,
  // and skip while a drill-down sheet is open to avoid disturbing the user).
  useEffect(() => {
    if (!autoRefresh) return;
    const id = window.setInterval(() => {
      if (!loading && !drill) generate();
    }, 60_000);
    return () => window.clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoRefresh, loading, drill, period]);

  // Reset search + pagination when opening a new drill
  useEffect(() => {
    setDrillQuery('');
    setDebouncedDrillQuery('');
    setDrillPage(0);
    setDrillDatePreset('inherit');
    setDrillCustomFrom('');
    setDrillCustomTo('');
  }, [drill?.category, drill?.scope, drill?.bucket]);
  useEffect(() => { setDrillPage(0); }, [debouncedDrillQuery, drillPageSize]);

  // Debounce the drill-down search so filtering doesn't run on every keystroke
  useEffect(() => {
    const t = setTimeout(() => setDebouncedDrillQuery(drillQuery), 200);
    return () => clearTimeout(t);
  }, [drillQuery]);

  // Drill-down filtered rows
  const drillRows = useMemo(() => {
    if (!drill) return [] as LedgerRow[];
    const effFrom = effectiveDrillRange.from ?? drill.dateFrom;
    const effTo = effectiveDrillRange.to ?? drill.dateTo;
    return rows.filter(r => {
      if (!includeAdjustments && (r.classification === 'admin_correction' || r.category === 'system_balance_correction')) return false;
      if (r.category !== drill.category || r.ledger_scope !== drill.scope) return false;
      if (drill.direction && r.direction !== drill.direction) return false;
      if (effFrom && r.transaction_date.slice(0, 10) < effFrom) return false;
      if (effTo && r.transaction_date.slice(0, 10) > effTo) return false;
      if (drill.bucket) {
        const bk = bucketKey(new Date(r.transaction_date), granularity);
        if (bk !== drill.bucket) return false;
      }
      return true;
    }).sort((a, b) => new Date(b.transaction_date).getTime() - new Date(a.transaction_date).getTime());
  }, [rows, drill, includeAdjustments, granularity, effectiveDrillRange]);

  // Apply search filter (reference id, transaction group, party name, user id, source table, linked party, description)
  const filteredDrillRows = useMemo(() => {
    const q = debouncedDrillQuery.trim().toLowerCase();
    if (!q) return drillRows;
    return drillRows.filter(r => {
      const name = r.user_id ? (partyNames[r.user_id] || '').toLowerCase() : '';
      return (
        (r.reference_id || '').toLowerCase().includes(q) ||
        (r.transaction_group_id || '').toLowerCase().includes(q) ||
        (r.user_id || '').toLowerCase().includes(q) ||
        (r.source_table || '').toLowerCase().includes(q) ||
        (r.source_id || '').toLowerCase().includes(q) ||
        (r.linked_party || '').toLowerCase().includes(q) ||
        (r.description || '').toLowerCase().includes(q) ||
        name.includes(q)
      );
    });
  }, [drillRows, debouncedDrillQuery, partyNames]);

  // Resolve user names for drill-down list
  useEffect(() => {
    const ids = Array.from(new Set(drillRows.map(r => r.user_id).filter((x): x is string => !!x && !partyNames[x])));
    if (ids.length === 0) return;
    let cancelled = false;
    (async () => {
      const { data } = await supabase.from('profiles').select('id, full_name, phone').in('id', ids.slice(0, 200));
      if (cancelled || !data) return;
      const next: Record<string, string> = {};
      for (const p of data as any[]) {
        next[p.id] = p.full_name || p.phone || p.id.slice(0, 8);
      }
      setPartyNames(prev => ({ ...prev, ...next }));
    })();
    return () => { cancelled = true; };
  }, [drillRows, partyNames]);

  // Aggregate
  const { aggregates, bucketLabels, totals } = useMemo(() => {
    const map = new Map<GroupKey, Aggregate>();
    const bucketSet = new Set<string>();
    let totIn = 0, totOut = 0;

    for (const r of rows) {
      if (!includeAdjustments && (r.classification === 'admin_correction' || r.category === 'system_balance_correction')) continue;
      if (scopeFilter !== 'all' && r.ledger_scope !== scopeFilter) continue;
      if (partyQuickFilter && r.user_id !== partyQuickFilter) continue;

      const amt = Number(r.amount) || 0;
      const key: GroupKey = `${r.category}|${r.ledger_scope}`;
      let a = map.get(key);
      if (!a) {
        a = { category: r.category, scope: r.ledger_scope, cashIn: 0, cashOut: 0, net: 0, count: 0, buckets: {} };
        map.set(key, a);
      }
      const bk = bucketKey(new Date(r.transaction_date), granularity);
      bucketSet.add(bk);
      const cell = a.buckets[bk] || { in: 0, out: 0 };
      if (r.direction === 'cash_in')  { a.cashIn  += amt; cell.in  += amt; totIn  += amt; }
      else                            { a.cashOut += amt; cell.out += amt; totOut += amt; }
      a.buckets[bk] = cell;
      a.count += 1;
      a.net = a.cashIn - a.cashOut;
    }

    const aggregates = Array.from(map.values()).sort((a, b) => (Math.abs(b.cashIn + b.cashOut) - Math.abs(a.cashIn + a.cashOut)));
    const bucketLabels = Array.from(bucketSet).sort();
    return { aggregates, bucketLabels, totals: { cashIn: totIn, cashOut: totOut, net: totIn - totOut } };
  }, [rows, granularity, includeAdjustments, scopeFilter, partyQuickFilter]);

  const filteredAggregates = useMemo(() => {
    return aggregates.filter(a => {
      if (directionQuickFilter === 'cash_in' && a.cashIn <= 0) return false;
      if (directionQuickFilter === 'cash_out' && a.cashOut <= 0) return false;
      if (directionQuickFilter === 'net_positive' && a.net <= 0) return false;
      if (directionQuickFilter === 'net_negative' && a.net >= 0) return false;
      if (categoryQuickFilter && a.category !== categoryQuickFilter) return false;
      return true;
    });
  }, [aggregates, directionQuickFilter, categoryQuickFilter]);

  const topCategoryChips = useMemo(() => {
    return aggregates
      .slice()
      .sort((a, b) => Math.abs(b.cashIn + b.cashOut) - Math.abs(a.cashIn + a.cashOut))
      .slice(0, 6)
      .map(a => a.category);
  }, [aggregates]);

  // Top Categories summary: merges per-category aggregates across ledger scopes
  // for the current filters and surfaces the biggest movers so users can tap
  // a chip to filter the Categories table without scrolling. Pure derivation.
  const topCategoriesSummary = useMemo(() => {
    const map = new Map<string, { category: string; cashIn: number; cashOut: number; count: number }>();
    for (const a of aggregates) {
      const cur = map.get(a.category) || { category: a.category, cashIn: 0, cashOut: 0, count: 0 };
      cur.cashIn += a.cashIn;
      cur.cashOut += a.cashOut;
      cur.count += a.count;
      map.set(a.category, cur);
    }
    const all = Array.from(map.values()).map(c => ({ ...c, total: c.cashIn + c.cashOut, net: c.cashIn - c.cashOut }));
    const grandTotal = all.reduce((s, c) => s + c.total, 0) || 1;
    return {
      top: all.sort((a, b) => b.total - a.total).slice(0, topCategoriesLimit).map(c => ({ ...c, share: c.total / grandTotal })),
      categoryCount: all.length,
    };
  }, [aggregates, topCategoriesLimit]);

  // Top parties for the thumb-friendly Party picker. Aggregates the loaded
  // ledger rows by `user_id` (ignoring rows without one), totalling cash flow
  // so the most-active counterparties surface first. Pure UI/derivation —
  // does not mutate any business state.
  const topParties = useMemo(() => {
    const map = new Map<string, { id: string; cashIn: number; cashOut: number; count: number }>();
    for (const r of rows) {
      if (!r.user_id) continue;
      if (!includeAdjustments && (r.classification === 'admin_correction' || r.category === 'system_balance_correction')) continue;
      const amt = Number(r.amount) || 0;
      const cur = map.get(r.user_id) || { id: r.user_id, cashIn: 0, cashOut: 0, count: 0 };
      if (r.direction === 'cash_in') cur.cashIn += amt; else cur.cashOut += amt;
      cur.count += 1;
      map.set(r.user_id, cur);
    }
    return Array.from(map.values()).sort((a, b) => (b.cashIn + b.cashOut) - (a.cashIn + a.cashOut));
  }, [rows, includeAdjustments]);

  // Resolve display names for the top parties (limit 50 so the picker is fast).
  useEffect(() => {
    const ids = topParties.slice(0, 50).map(p => p.id).filter(id => !partyNames[id]);
    if (ids.length === 0) return;
    let cancelled = false;
    (async () => {
      const { data } = await supabase.from('profiles').select('id, full_name, phone').in('id', ids);
      if (cancelled || !data) return;
      const next: Record<string, string> = {};
      for (const p of data as any[]) {
        next[p.id] = p.full_name || p.phone || p.id.slice(0, 8);
      }
      setPartyNames(prev => ({ ...prev, ...next }));
    })();
    return () => { cancelled = true; };
  }, [topParties, partyNames]);

  const partyLabel = partyQuickFilter
    ? (partyNames[partyQuickFilter] || `${partyQuickFilter.slice(0, 8)}…`)
    : 'Everyone';
  const directionLabel =
    directionQuickFilter === 'cash_in' ? 'Money In only' :
    directionQuickFilter === 'cash_out' ? 'Money Out only' :
    directionQuickFilter === 'net_positive' ? 'Net positive' :
    directionQuickFilter === 'net_negative' ? 'Net negative' :
    'In + Out';

  // ── Plain-language anomaly alerts ──────────────────────────────
  // Scans the loaded rows day-by-day within the selected period and
  // flags two kinds of unusual behavior in everyday language:
  //   1. SPIKES — a single day where Money In or Money Out is far
  //      above the period's typical daily level (>2σ above mean and
  //      >1.5× the mean, with a UGX 50K noise floor).
  //   2. GAPS — a day with NO money movement sandwiched between
  //      active days inside the selected window.
  // Honors `includeAdjustments`, `scopeFilter`, and `partyQuickFilter`
  // so it stays consistent with the numbers shown above. Purely
  // read-only — never mutates state, never writes to the ledger.
  const anomalyAlerts = useMemo(() => {
    const rng = periodRange(period);
    if (!rng.from) return [] as Array<{ kind: 'spike' | 'gap'; date: string; label: string; detail: string }>;
    const fromIso = rng.from.toISOString().slice(0, 10);
    const toIso = rng.to.toISOString().slice(0, 10);
    // Group by day
    const byDay = new Map<string, { in: number; out: number; count: number }>();
    for (const r of rows) {
      if (!includeAdjustments && (r.classification === 'admin_correction' || r.category === 'system_balance_correction')) continue;
      if (scopeFilter !== 'all' && r.ledger_scope !== scopeFilter) continue;
      if (partyQuickFilter && r.user_id !== partyQuickFilter) continue;
      const d = r.transaction_date.slice(0, 10);
      if (d < fromIso || d > toIso) continue;
      const amt = Number(r.amount) || 0;
      const cur = byDay.get(d) || { in: 0, out: 0, count: 0 };
      if (r.direction === 'cash_in') cur.in += amt; else cur.out += amt;
      cur.count += 1;
      byDay.set(d, cur);
    }
    // Build a full day series from fromIso → toIso
    const days: string[] = [];
    {
      const cur = new Date(fromIso + 'T00:00:00Z');
      const end = new Date(toIso + 'T00:00:00Z');
      while (cur.getTime() <= end.getTime()) {
        days.push(cur.toISOString().slice(0, 10));
        cur.setUTCDate(cur.getUTCDate() + 1);
      }
    }
    if (days.length < 3) return []; // not enough span to call anomalies

    const out: Array<{ kind: 'spike' | 'gap'; date: string; label: string; detail: string }> = [];
    const NOISE_FLOOR = 50_000;

    const stats = (vals: number[]) => {
      const n = vals.length || 1;
      const mean = vals.reduce((a, b) => a + b, 0) / n;
      const variance = vals.reduce((a, b) => a + (b - mean) ** 2, 0) / n;
      return { mean, std: Math.sqrt(variance) };
    };

    for (const metric of ['in', 'out'] as const) {
      const vals = days.map(d => (byDay.get(d)?.[metric] ?? 0));
      const { mean, std } = stats(vals);
      if (mean < NOISE_FLOOR) continue; // tiny period, skip
      const threshold = Math.max(mean + 2 * std, mean * 1.5, NOISE_FLOOR);
      days.forEach((d, i) => {
        const v = vals[i];
        if (v > threshold && v > 0) {
          const factor = mean > 0 ? (v / mean).toFixed(1) : '∞';
          out.push({
            kind: 'spike',
            date: d,
            label: metric === 'in'
              ? `Unusual Money In spike on ${format(new Date(d + 'T00:00:00'), 'EEE dd MMM')}`
              : `Unusual Money Out spike on ${format(new Date(d + 'T00:00:00'), 'EEE dd MMM')}`,
            detail: `${formatUGX(v)} — about ${factor}× the period's daily average of ${formatUGX(Math.round(mean))}.`,
          });
        }
      });
    }

    // Gaps: zero-activity day sandwiched between active days
    const activeDays = days.filter(d => {
      const e = byDay.get(d);
      return e && (e.in > 0 || e.out > 0);
    });
    if (activeDays.length >= 3) {
      const firstActiveIdx = days.indexOf(activeDays[0]);
      const lastActiveIdx = days.indexOf(activeDays[activeDays.length - 1]);
      // Find consecutive runs of inactive days strictly inside the active span
      let i = firstActiveIdx + 1;
      while (i < lastActiveIdx) {
        const e = byDay.get(days[i]);
        if (!e || (e.in === 0 && e.out === 0)) {
          let j = i;
          while (j < lastActiveIdx) {
            const ej = byDay.get(days[j]);
            if (ej && (ej.in > 0 || ej.out > 0)) break;
            j += 1;
          }
          const runLen = j - i;
          if (runLen >= 1) {
            out.push({
              kind: 'gap',
              date: days[i],
              label: runLen === 1
                ? `Quiet day on ${format(new Date(days[i] + 'T00:00:00'), 'EEE dd MMM')}`
                : `Quiet stretch · ${runLen} days from ${format(new Date(days[i] + 'T00:00:00'), 'dd MMM')}`,
              detail: runLen === 1
                ? 'No money moved in or out on this day, but the days around it were active.'
                : `No money moved on ${runLen} days in a row, between otherwise active days.`,
            });
          }
          i = j;
        } else {
          i += 1;
        }
      }
    }

    // Sort by date desc (newest first), cap to 5 to avoid overwhelm
    return out
      .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0))
      .slice(0, 5);
  }, [rows, period, includeAdjustments, scopeFilter, partyQuickFilter]);

  // ── Capital Inflows: platform-scope cash_in totals per category (from raw rows,
  // independent of scopeFilter so the callout always reflects true inbound capital.
  // Per-bucket totals follow the current `granularity` so the callout stays in sync
  // with the time-series matrix shown in the table below.
  const capitalInflow = useMemo(() => {
    const perCat = new Map<string, { total: number; count: number; buckets: Record<string, number>; groupIds: Set<string>; walletIn: number; walletOut: number; walletCount: number }>();
    const bucketSet = new Set<string>();
    for (const r of rows) {
      if (!includeAdjustments && (r.classification === 'admin_correction' || r.category === 'system_balance_correction')) continue;
      if (r.ledger_scope !== 'platform' || r.direction !== 'cash_in') continue;
      if (!inCapitalRange(r.transaction_date)) continue;
      const amt = Number(r.amount) || 0;
      const bk = bucketKey(new Date(r.transaction_date), granularity);
      bucketSet.add(bk);
      const cur = perCat.get(r.category) || { total: 0, count: 0, buckets: {}, groupIds: new Set<string>(), walletIn: 0, walletOut: 0, walletCount: 0 };
      cur.total += amt;
      cur.count += 1;
      cur.buckets[bk] = (cur.buckets[bk] || 0) + amt;
      if (r.transaction_group_id) cur.groupIds.add(r.transaction_group_id);
      perCat.set(r.category, cur);
    }

    // Second pass — fold in matching wallet-scope legs when toggle is on.
    // We pair by transaction_group_id (the canonical balanced-leg link).
    if (includeWalletLegs && perCat.size > 0) {
      // Build reverse index: group_id -> array of categories it belongs to
      const groupToCats = new Map<string, string[]>();
      for (const [cat, v] of perCat.entries()) {
        for (const gid of v.groupIds) {
          const arr = groupToCats.get(gid) || [];
          arr.push(cat);
          groupToCats.set(gid, arr);
        }
      }
      for (const r of rows) {
        if (!includeAdjustments && (r.classification === 'admin_correction' || r.category === 'system_balance_correction')) continue;
        if (r.ledger_scope !== 'wallet') continue;
        if (!r.transaction_group_id) continue;
        const cats = groupToCats.get(r.transaction_group_id);
        if (!cats) continue;
        const amt = Number(r.amount) || 0;
        for (const cat of cats) {
          const cur = perCat.get(cat)!;
          if (r.direction === 'cash_in') cur.walletIn += amt;
          else                            cur.walletOut += amt;
          cur.walletCount += 1;
        }
      }
    }

    const availableCategories = Array.from(perCat.entries())
      .map(([category, v]) => ({
        category,
        total: v.total,
        count: v.count,
        buckets: v.buckets,
        walletIn: v.walletIn,
        walletOut: v.walletOut,
        walletNet: v.walletIn - v.walletOut,
        walletCount: v.walletCount,
      }))
      .sort((a, b) => b.total - a.total);
    const selected = availableCategories.filter(c => capitalCategories.has(c.category));
    const total = selected.reduce((s, c) => s + c.total, 0);
    const entries = selected.reduce((s, c) => s + c.count, 0);
    const walletInTotal  = selected.reduce((s, c) => s + c.walletIn,  0);
    const walletOutTotal = selected.reduce((s, c) => s + c.walletOut, 0);
    const walletEntries  = selected.reduce((s, c) => s + c.walletCount, 0);
    const bucketLabels = Array.from(bucketSet).sort();
    const bucketTotals: Record<string, number> = {};
    for (const b of bucketLabels) {
      bucketTotals[b] = selected.reduce((s, c) => s + (c.buckets[b] || 0), 0);
    }
    const peakBucket = bucketLabels.reduce((max, b) => bucketTotals[b] > (bucketTotals[max] || 0) ? b : max, bucketLabels[0] || '');
    return {
      availableCategories, selected, total, entries,
      bucketLabels, bucketTotals, peakBucket,
      walletInTotal, walletOutTotal, walletEntries,
      walletNetTotal: walletInTotal - walletOutTotal,
    };
  }, [rows, includeAdjustments, capitalCategories, granularity, capitalFrom, capitalTo, includeWalletLegs]);

  const handleExport = () => {
    if (!canViewLedgerDetail) { toast.error('You do not have permission to export ledger data'); return; }
    if (!aggregates.length) { toast.error('Nothing to export'); return; }
    const headers = ['Category', 'Scope', 'Description', 'Cash In', 'Cash Out', 'Net', 'Entries', ...bucketLabels.flatMap(b => [`${b} In`, `${b} Out`])];
    const data = aggregates.map(a => {
      const base = [
        prettifyCategory(a.category),
        SCOPE_LABEL[a.scope] || a.scope,
        CATEGORY_DESCRIPTIONS[a.category] || '',
        a.cashIn,
        a.cashOut,
        a.net,
        a.count,
      ];
      const cells = bucketLabels.flatMap(b => {
        const c = a.buckets[b];
        return [c?.in ?? 0, c?.out ?? 0];
      });
      return [...base, ...cells];
    });
    downloadCsv(`welile-cash-movement-${period}-${granularity}-${format(new Date(), 'yyyy-MM-dd')}.csv`, headers, data);
    toast.success('CSV downloaded');
  };

  const handleExportPdf = () => {
    if (!canViewLedgerDetail) { toast.error('You do not have permission to export ledger data'); return; }
    if (!aggregates.length) { toast.error('Nothing to export'); return; }
    const doc = new jsPDF({ orientation: 'landscape', unit: 'pt', format: 'a4' });
    const pageW = doc.internal.pageSize.getWidth();
    const periodLabel = PERIODS.find(p => p.value === period)?.label || period;
    const granLabel = GRANULARITIES.find(g => g.value === granularity)?.label || granularity;

    doc.setFontSize(14); doc.setFont('helvetica', 'bold');
    doc.text('Welile · Comprehensive Cash Movement', 40, 36);
    doc.setFontSize(9); doc.setFont('helvetica', 'normal');
    doc.text(`Period: ${periodLabel}  ·  Bucket: ${granLabel}  ·  Scope: ${scopeFilter === 'all' ? 'All' : (SCOPE_LABEL[scopeFilter] || scopeFilter)}  ·  Adjustments: ${includeAdjustments ? 'Included' : 'Excluded'}`, 40, 52);
    doc.text(rangeLabel, 40, 66);
    doc.text(`Generated ${format(new Date(), 'dd MMM yyyy HH:mm')}  ·  ${rows.length.toLocaleString()} ledger entries`, 40, 80);

    // Totals strip
    autoTable(doc, {
      startY: 92,
      head: [['Total Cash In', 'Total Cash Out', 'Net Movement']],
      body: [[formatUGX(totals.cashIn), `(${formatUGX(totals.cashOut)})`, `${totals.net >= 0 ? '+' : ''}${formatUGX(totals.net)}`]],
      theme: 'grid',
      styles: { fontSize: 10, halign: 'right' },
      headStyles: { fillColor: [30, 30, 30], halign: 'right' },
      margin: { left: 40, right: 40 },
    });

    // Category breakdown
    autoTable(doc, {
      startY: (doc as any).lastAutoTable.finalY + 16,
      head: [['Category', 'Scope', 'Cash In', 'Cash Out', 'Net', 'Entries']],
      body: aggregates.map(a => [
        prettifyCategory(a.category),
        SCOPE_LABEL[a.scope] || a.scope,
        a.cashIn ? formatUGX(a.cashIn) : '—',
        a.cashOut ? `(${formatUGX(a.cashOut)})` : '—',
        `${a.net >= 0 ? '+' : ''}${formatUGX(a.net)}`,
        String(a.count),
      ]),
      theme: 'striped',
      styles: { fontSize: 8 },
      headStyles: { fillColor: [30, 30, 30] },
      columnStyles: { 2: { halign: 'right' }, 3: { halign: 'right' }, 4: { halign: 'right' }, 5: { halign: 'right' } },
      margin: { left: 40, right: 40 },
    });

    // Time-series net matrix (chunked across pages if many buckets)
    if (bucketLabels.length > 0) {
      const CHUNK = 12;
      for (let i = 0; i < bucketLabels.length; i += CHUNK) {
        const slice = bucketLabels.slice(i, i + CHUNK);
        doc.addPage();
        doc.setFontSize(11); doc.setFont('helvetica', 'bold');
        doc.text(`${granLabel} Net Movement by Category  (${i + 1}–${Math.min(i + CHUNK, bucketLabels.length)} of ${bucketLabels.length})`, 40, 36);
        autoTable(doc, {
          startY: 48,
          head: [['Category · Scope', ...slice]],
          body: aggregates.map(a => [
            `${prettifyCategory(a.category)} · ${SCOPE_LABEL[a.scope] || a.scope}`,
            ...slice.map(b => {
              const c = a.buckets[b];
              if (!c || (c.in === 0 && c.out === 0)) return '·';
              const net = (c.in || 0) - (c.out || 0);
              return `${net >= 0 ? '+' : ''}${formatUGX(net)}`;
            }),
          ]),
          theme: 'grid',
          styles: { fontSize: 7, cellPadding: 3 },
          headStyles: { fillColor: [30, 30, 30], fontSize: 7 },
          columnStyles: Object.fromEntries(slice.map((_, k) => [k + 1, { halign: 'right' }])) as any,
          margin: { left: 40, right: 40 },
        });
      }
    }

    // Footer page numbers
    const pageCount = doc.getNumberOfPages();
    for (let p = 1; p <= pageCount; p++) {
      doc.setPage(p);
      doc.setFontSize(8); doc.setFont('helvetica', 'normal');
      doc.text(`Welile Cash Movement · Page ${p} / ${pageCount}`, pageW - 40, doc.internal.pageSize.getHeight() - 16, { align: 'right' });
    }

    doc.save(`welile-cash-movement-${period}-${granularity}-${format(new Date(), 'yyyy-MM-dd')}.pdf`);
    toast.success('PDF downloaded');
  };

  const handleExportDrill = () => {
    if (!canViewLedgerDetail) { toast.error('You do not have permission to export ledger data'); return; }
    if (!drill || filteredDrillRows.length === 0) return;
    const headers = ['Date', 'Reference ID', 'Transaction Group', 'Direction', 'Amount', 'Linked Party', 'User ID', 'User Name', 'Source Table', 'Source ID', 'Classification', 'Description'];
    const data = filteredDrillRows.map(r => [
      format(new Date(r.transaction_date), 'yyyy-MM-dd HH:mm:ss'),
      r.reference_id || '',
      r.transaction_group_id || '',
      r.direction,
      Number(r.amount) || 0,
      r.linked_party || '',
      r.user_id || '',
      (r.user_id && partyNames[r.user_id]) || '',
      r.source_table || '',
      r.source_id || '',
      r.classification || '',
      (r.description || '').replace(/\s+/g, ' ').slice(0, 500),
    ]);
    const tag = `${drill.category}_${drill.scope}${drill.bucket ? '_' + drill.bucket : ''}`;
    downloadCsv(`welile-ledger-${tag}-${format(new Date(), 'yyyy-MM-dd')}.csv`, headers, data);
    toast.success('Ledger entries exported');
  };

  // PDF export of the currently filtered drill-down ledger entries
  const handleExportDrillPdf = () => {
    if (!canViewLedgerDetail) { toast.error('You do not have permission to export ledger data'); return; }
    if (!drill || filteredDrillRows.length === 0) return;
    const doc = new jsPDF({ orientation: 'landscape', unit: 'pt', format: 'a4' });
    const pageW = doc.internal.pageSize.getWidth();
    const pageH = doc.internal.pageSize.getHeight();
    const periodLabel = PERIODS.find(p => p.value === period)?.label || period;
    const granLabel = GRANULARITIES.find(g => g.value === granularity)?.label || granularity;

    let cIn = 0, cOut = 0;
    for (const r of filteredDrillRows) {
      const a = Number(r.amount) || 0;
      if (r.direction === 'cash_in') cIn += a; else cOut += a;
    }
    const net = cIn - cOut;

    doc.setFontSize(14); doc.setFont('helvetica', 'bold');
    doc.text('Welile · Ledger Drill-Down', 40, 36);
    doc.setFontSize(9); doc.setFont('helvetica', 'normal');
    doc.text(
      `Category: ${prettifyCategory(drill.category)}  ·  Scope: ${SCOPE_LABEL[drill.scope] || drill.scope}` +
      (drill.bucket ? `  ·  Bucket: ${drill.bucket}` : '') +
      `  ·  Period: ${periodLabel}  ·  Granularity: ${granLabel}`,
      40, 52,
    );
    if (debouncedDrillQuery) {
      doc.text(`Search filter: "${debouncedDrillQuery}"`, 40, 66);
    }
    doc.text(
      `Generated ${format(new Date(), 'dd MMM yyyy HH:mm')}  ·  ${filteredDrillRows.length.toLocaleString()} of ${drillRows.length.toLocaleString()} entries`,
      40, debouncedDrillQuery ? 80 : 66,
    );

    const startY = debouncedDrillQuery ? 92 : 78;
    autoTable(doc, {
      startY,
      head: [['Cash In', 'Cash Out', 'Net']],
      body: [[formatUGX(cIn), `(${formatUGX(cOut)})`, `${net >= 0 ? '+' : ''}${formatUGX(net)}`]],
      theme: 'grid',
      styles: { fontSize: 10, halign: 'right' },
      headStyles: { fillColor: [30, 30, 30], halign: 'right' },
      margin: { left: 40, right: 40 },
    });

    autoTable(doc, {
      startY: (doc as any).lastAutoTable.finalY + 16,
      head: [['Date', 'Reference / Tx', 'Party', 'Source', 'Dir', 'Amount']],
      body: filteredDrillRows.map(r => {
        const isIn = r.direction === 'cash_in';
        const amt = Number(r.amount) || 0;
        const partyName = (r.user_id && partyNames[r.user_id]) || (r.linked_party ? prettifyCategory(r.linked_party) : '—');
        const refLine = r.reference_id || (r.id ? r.id.slice(0, 8) + '…' : '—');
        const grp = r.transaction_group_id ? `\ngrp: ${r.transaction_group_id.slice(0, 8)}…` : '';
        const src = [r.source_table, r.source_id ? r.source_id.slice(0, 8) + '…' : ''].filter(Boolean).join(':') || '—';
        return [
          format(new Date(r.transaction_date), 'dd MMM yyyy HH:mm'),
          `${refLine}${grp}`,
          `${partyName}${r.user_id ? `\n${r.user_id.slice(0, 8)}…` : ''}`,
          src,
          isIn ? 'IN' : 'OUT',
          `${isIn ? '+' : '−'}${formatUGX(amt)}`,
        ];
      }),
      theme: 'striped',
      styles: { fontSize: 7, cellPadding: 3, overflow: 'linebreak' },
      headStyles: { fillColor: [30, 30, 30], fontSize: 7 },
      columnStyles: {
        0: { cellWidth: 90 },
        1: { cellWidth: 150 },
        2: { cellWidth: 160 },
        3: { cellWidth: 130 },
        4: { cellWidth: 30, halign: 'center' },
        5: { halign: 'right' },
      },
      margin: { left: 40, right: 40 },
    });

    const pageCount = doc.getNumberOfPages();
    for (let p = 1; p <= pageCount; p++) {
      doc.setPage(p);
      doc.setFontSize(8); doc.setFont('helvetica', 'normal');
      doc.text(`Welile Ledger Drill-Down · Page ${p} / ${pageCount}`, pageW - 40, pageH - 16, { align: 'right' });
    }

    const tag = `${drill.category}_${drill.scope}${drill.bucket ? '_' + drill.bucket : ''}`;
    doc.save(`welile-ledger-${tag}-${format(new Date(), 'yyyy-MM-dd')}.pdf`);
    toast.success('PDF downloaded');
  };

  // Export the full drill-down (raw ledger entries) for the currently selected
  // period, granularity, scope and adjustments toggle — bypassing any open drill.
  const handleExportAllEntries = () => {
    if (!canViewLedgerDetail) { toast.error('You do not have permission to export ledger data'); return; }
    const filtered = rows.filter(r => {
      if (!includeAdjustments && (r.classification === 'admin_correction' || r.category === 'system_balance_correction')) return false;
      if (scopeFilter !== 'all' && r.ledger_scope !== scopeFilter) return false;
      return true;
    });
    if (!filtered.length) { toast.error('Nothing to export'); return; }
    const headers = [
      'Date', 'Bucket', 'Category', 'Scope', 'Direction', 'Amount',
      'Reference ID', 'Transaction Group', 'Linked Party', 'User ID', 'User Name',
      'Source Table', 'Source ID', 'Classification', 'Description',
    ];
    const data = filtered
      .slice()
      .sort((a, b) => new Date(b.transaction_date).getTime() - new Date(a.transaction_date).getTime())
      .map(r => [
        format(new Date(r.transaction_date), 'yyyy-MM-dd HH:mm:ss'),
        bucketKey(new Date(r.transaction_date), granularity),
        prettifyCategory(r.category),
        SCOPE_LABEL[r.ledger_scope] || r.ledger_scope,
        r.direction,
        Number(r.amount) || 0,
        r.reference_id || '',
        r.transaction_group_id || '',
        r.linked_party || '',
        r.user_id || '',
        (r.user_id && partyNames[r.user_id]) || '',
        r.source_table || '',
        r.source_id || '',
        r.classification || '',
        (r.description || '').replace(/\s+/g, ' ').slice(0, 500),
      ]);
    downloadCsv(
      `welile-cash-movement-entries-${period}-${granularity}-${format(new Date(), 'yyyy-MM-dd')}.csv`,
      headers,
      data,
    );
    toast.success(`${filtered.length.toLocaleString()} ledger entries exported`);
  };

  const range = periodRange(period);
  const rangeLabel = range.from ? `${format(range.from, 'dd MMM yyyy')} → ${format(range.to, 'dd MMM yyyy')}` : `Inception → ${format(range.to, 'dd MMM yyyy')}`;

  // ────────────────────────────────────────────────────────────
  // Shareable plain-English summary export
  // ────────────────────────────────────────────────────────────
  // Renders the same headline narrative the user reads in Simple
  // mode (period, Money In, Money Out, Difference, top anomalies)
  // into a portrait canvas suitable for download/share. Pure render
  // — never touches the ledger or wallet state.
  const buildSummaryCanvas = useCallback((): HTMLCanvasElement => {
    const W = 1080;
    const H = 1350;
    const cvs = document.createElement('canvas');
    cvs.width = W; cvs.height = H;
    const ctx = cvs.getContext('2d')!;
    // Background
    const grad = ctx.createLinearGradient(0, 0, 0, H);
    grad.addColorStop(0, '#0b1220');
    grad.addColorStop(1, '#111827');
    ctx.fillStyle = grad; ctx.fillRect(0, 0, W, H);
    // Card
    const PAD = 56;
    ctx.fillStyle = '#0f172a';
    ctx.strokeStyle = 'rgba(255,255,255,0.08)';
    ctx.lineWidth = 2;
    const cardX = PAD, cardY = PAD, cardW = W - PAD * 2, cardH = H - PAD * 2;
    const r = 28;
    ctx.beginPath();
    ctx.moveTo(cardX + r, cardY);
    ctx.arcTo(cardX + cardW, cardY, cardX + cardW, cardY + cardH, r);
    ctx.arcTo(cardX + cardW, cardY + cardH, cardX, cardY + cardH, r);
    ctx.arcTo(cardX, cardY + cardH, cardX, cardY, r);
    ctx.arcTo(cardX, cardY, cardX + cardW, cardY, r);
    ctx.closePath();
    ctx.fill(); ctx.stroke();

    let y = cardY + 60;
    // Brand
    ctx.fillStyle = '#22d3ee';
    ctx.font = '600 22px system-ui, -apple-system, sans-serif';
    ctx.fillText('WELILE · CASH MOVEMENTS', cardX + 40, y);
    y += 18;
    ctx.fillStyle = 'rgba(255,255,255,0.55)';
    ctx.font = '400 18px system-ui, -apple-system, sans-serif';
    ctx.fillText(rangeLabel, cardX + 40, y + 16);
    y += 70;

    // Title
    ctx.fillStyle = '#f8fafc';
    ctx.font = '700 44px system-ui, -apple-system, sans-serif';
    ctx.fillText('Money In & Out', cardX + 40, y);
    y += 12;
    ctx.fillStyle = 'rgba(255,255,255,0.7)';
    ctx.font = '400 20px system-ui, -apple-system, sans-serif';
    const periodLbl = PERIODS.find(p => p.value === period)?.label || period;
    ctx.fillText(`Period: ${periodLbl}  ·  ${rangeLabel}`, cardX + 40, y + 24);
    y += 50;
    // Applied filters line — Direction + Party so the export matches
    // exactly what the on-screen totals are filtered by.
    const dirLbl =
      directionQuickFilter === 'cash_in' ? 'Money In only' :
      directionQuickFilter === 'cash_out' ? 'Money Out only' :
      directionQuickFilter === 'net_positive' ? 'Net positive' :
      directionQuickFilter === 'net_negative' ? 'Net negative' :
      'All directions';
    const partyLbl = partyQuickFilter
      ? (partyNames[partyQuickFilter] || `${partyQuickFilter.slice(0, 8)}…`)
      : 'Anyone';
    ctx.fillStyle = 'rgba(255,255,255,0.55)';
    ctx.font = '500 17px system-ui, -apple-system, sans-serif';
    ctx.fillText(`Filters · Direction: ${dirLbl}  ·  Party: ${partyLbl}`, cardX + 40, y + 24);
    y += 60;

    // Three big tiles
    const tileGap = 18;
    const tileW = (cardW - 80 - tileGap * 2) / 3;
    const tileH = 160;
    const drawTile = (i: number, label: string, value: string, color: string, bg: string) => {
      const x = cardX + 40 + i * (tileW + tileGap);
      ctx.fillStyle = bg;
      ctx.beginPath();
      ctx.moveTo(x + 16, y);
      ctx.arcTo(x + tileW, y, x + tileW, y + tileH, 16);
      ctx.arcTo(x + tileW, y + tileH, x, y + tileH, 16);
      ctx.arcTo(x, y + tileH, x, y, 16);
      ctx.arcTo(x, y, x + tileW, y, 16);
      ctx.closePath(); ctx.fill();
      ctx.fillStyle = 'rgba(255,255,255,0.65)';
      ctx.font = '600 18px system-ui, -apple-system, sans-serif';
      ctx.fillText(label, x + 20, y + 36);
      ctx.fillStyle = color;
      ctx.font = '700 34px ui-monospace, SFMono-Regular, Menlo, monospace';
      ctx.fillText(value, x + 20, y + 96);
    };
    drawTile(0, 'MONEY IN',    formatUGX(totals.cashIn),                       '#34d399', 'rgba(16, 185, 129, 0.12)');
    drawTile(1, 'MONEY OUT',   formatUGX(totals.cashOut),                      '#f87171', 'rgba(239, 68, 68, 0.12)');
    drawTile(2, 'DIFFERENCE',  `${totals.net >= 0 ? '+' : ''}${formatUGX(totals.net)}`,
             totals.net >= 0 ? '#34d399' : '#f87171',
             totals.net >= 0 ? 'rgba(16, 185, 129, 0.12)' : 'rgba(239, 68, 68, 0.12)');
    y += tileH + 40;

    // Plain English sentence (word-wrapped)
    const sentence = (totals.cashIn === 0 && totals.cashOut === 0)
      ? 'No money moved during this period.'
      : `${formatUGX(totals.cashIn)} came IN and ${formatUGX(totals.cashOut)} went OUT. ${
          totals.net > 0 ? `Welile gained ${formatUGX(totals.net)} overall.`
          : totals.net < 0 ? `Welile spent ${formatUGX(Math.abs(totals.net))} more than it received.`
          : 'Money in and out balanced exactly.'
        }`;
    ctx.fillStyle = '#e2e8f0';
    ctx.font = '500 26px system-ui, -apple-system, sans-serif';
    const wrap = (text: string, maxWidth: number) => {
      const words = text.split(' '); const lines: string[] = []; let cur = '';
      for (const w of words) {
        const test = cur ? cur + ' ' + w : w;
        if (ctx.measureText(test).width > maxWidth) { if (cur) lines.push(cur); cur = w; }
        else cur = test;
      }
      if (cur) lines.push(cur);
      return lines;
    };
    const lines = wrap(sentence, cardW - 80);
    for (const ln of lines) { ctx.fillText(ln, cardX + 40, y); y += 36; }
    y += 20;

    // Anomalies (top 3)
    if (anomalyAlerts.length > 0) {
      ctx.fillStyle = '#fbbf24';
      ctx.font = '700 22px system-ui, -apple-system, sans-serif';
      ctx.fillText(`HEADS UP · ${anomalyAlerts.length} unusual ${anomalyAlerts.length === 1 ? 'pattern' : 'patterns'}`, cardX + 40, y);
      y += 30;
      ctx.font = '500 20px system-ui, -apple-system, sans-serif';
      for (const a of anomalyAlerts.slice(0, 3)) {
        ctx.fillStyle = '#f1f5f9';
        const labelLines = wrap(`• ${a.label}`, cardW - 80);
        for (const ln of labelLines) { ctx.fillText(ln, cardX + 40, y); y += 26; }
        ctx.fillStyle = 'rgba(255,255,255,0.6)';
        ctx.font = '400 18px system-ui, -apple-system, sans-serif';
        const detailLines = wrap(a.detail, cardW - 100);
        for (const ln of detailLines) { ctx.fillText(ln, cardX + 56, y); y += 22; }
        ctx.font = '500 20px system-ui, -apple-system, sans-serif';
        y += 8;
        if (y > cardY + cardH - 120) break;
      }
    }

    // Footer
    ctx.fillStyle = 'rgba(255,255,255,0.45)';
    ctx.font = '400 16px system-ui, -apple-system, sans-serif';
    const stamp = `Generated ${format(new Date(), 'dd MMM yyyy · HH:mm')} · All amounts in UGX`;
    ctx.fillText(stamp, cardX + 40, cardY + cardH - 30);
    return cvs;
  }, [period, rangeLabel, totals, anomalyAlerts, directionQuickFilter, partyQuickFilter, partyNames]);

  const summaryFilename = (ext: string) =>
    `welile-cash-summary-${period}-${format(new Date(), 'yyyy-MM-dd-HHmm')}.${ext}`;

  const handleDownloadSummaryPng = useCallback(() => {
    try {
      const cvs = buildSummaryCanvas();
      cvs.toBlob((blob) => {
        if (!blob) { toast.error('Could not build image'); return; }
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url; a.download = summaryFilename('png');
        document.body.appendChild(a); a.click(); a.remove();
        URL.revokeObjectURL(url);
        toast.success('Summary image saved');
      }, 'image/png');
    } catch (e: any) {
      console.error('[CashMovement] summary png failed', e);
      toast.error('Could not save summary image');
    }
  }, [buildSummaryCanvas, period]);

  const handleDownloadSummaryPdf = useCallback(() => {
    try {
      const cvs = buildSummaryCanvas();
      const img = cvs.toDataURL('image/png');
      const doc = new jsPDF({ orientation: 'portrait', unit: 'pt', format: 'a4' });
      const pw = doc.internal.pageSize.getWidth();
      const ph = doc.internal.pageSize.getHeight();
      const ratio = cvs.height / cvs.width;
      const margin = 32;
      const imgW = pw - margin * 2;
      const imgH = Math.min(ph - margin * 2, imgW * ratio);
      doc.addImage(img, 'PNG', margin, margin, imgW, imgH);
      doc.save(summaryFilename('pdf'));
      toast.success('Summary PDF saved');
    } catch (e: any) {
      console.error('[CashMovement] summary pdf failed', e);
      toast.error('Could not save summary PDF');
    }
  }, [buildSummaryCanvas, period]);

  const handleShareSummary = useCallback(async () => {
    try {
      const cvs = buildSummaryCanvas();
      const blob: Blob | null = await new Promise(res => cvs.toBlob(res, 'image/png'));
      if (!blob) { toast.error('Could not build image'); return; }
      const file = new File([blob], summaryFilename('png'), { type: 'image/png' });
      const nav = navigator as Navigator & { canShare?: (d: ShareData) => boolean; share?: (d: ShareData) => Promise<void> };
      if (nav.canShare && nav.canShare({ files: [file] }) && nav.share) {
        await nav.share({
          files: [file],
          title: 'Welile · Cash Movements',
          text: `${PERIODS.find(p => p.value === period)?.label || period} · ${rangeLabel}`,
        });
        return;
      }
      // Fallback to download
      handleDownloadSummaryPng();
    } catch (e: any) {
      if (e?.name === 'AbortError') return; // user cancelled share sheet
      console.error('[CashMovement] share failed', e);
      toast.error('Sharing not supported — image saved instead');
      handleDownloadSummaryPng();
    }
  }, [buildSummaryCanvas, handleDownloadSummaryPng, period, rangeLabel]);

  return (
    <Card className="border-border/60 shadow-sm">
      <CardContent
        className={cn(
          'pt-6 pb-10 space-y-6 sm:space-y-4 px-4 sm:px-6',
          // ── Accessibility: ensure every interactive element inside the
          //    cash-movement panel shows a visible focus ring when reached
          //    via keyboard. Tailwind arbitrary variants apply the ring
          //    consistently to custom <button> elements and native inputs
          //    without touching each call site.
          '[&_button:focus-visible]:outline-none',
          '[&_button:focus-visible]:ring-2',
          '[&_button:focus-visible]:ring-ring',
          '[&_button:focus-visible]:ring-offset-2',
          '[&_button:focus-visible]:ring-offset-background',
          '[&_a:focus-visible]:outline-none',
          '[&_a:focus-visible]:ring-2',
          '[&_a:focus-visible]:ring-ring',
          '[&_a:focus-visible]:rounded-md',
          '[&_input:focus-visible]:outline-none',
          '[&_input:focus-visible]:ring-2',
          '[&_input:focus-visible]:ring-ring',
        )}
        aria-labelledby="cm-heading"
      >
        {/* Header */}
        <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-3">
          <div className="min-w-0">
           <h3 id="cm-heading" className="text-xl sm:text-base font-semibold tracking-tight leading-snug">
              Money In &amp; Out
            </h3>
           <p className="mt-1.5 text-[13px] sm:text-[11px] text-muted-foreground leading-relaxed">
              {simpleMode
                ? 'A simple picture of money flowing in and out of Welile, in plain English.'
                : 'All money flowing in and out of Welile — updated live from the books.'}
            </p>
          </div>
          <div className="flex items-center gap-2 flex-wrap shrink-0">
            <Badge variant="outline" className="text-[10px] font-normal">{rangeLabel}</Badge>
            <Button
              size="sm"
              variant={simpleMode ? 'default' : 'outline'}
              className="h-8 text-xs px-3 gap-1 rounded-full"
              onClick={() => setSimpleMode(v => !v)}
              title={simpleMode ? 'Switch to full detail view' : 'Switch to a simple, plain-English view'}
              aria-pressed={simpleMode}
            >
              {simpleMode ? 'Simple view' : 'Detailed view'}
            </Button>
          </div>
        </div>

        {/* ─── Sticky on-page navigator ────────────────────────────
            Quick anchors to the major sections of the page. Sticks
            to the top of the viewport while scrolling so users can
            jump between Glance, the totals, categories, and the
            transactions list without endless scrolling. The list of
            anchors adapts to Simple vs Detailed view (hides anchors
            for sections that aren't rendered). */}
        <nav
          aria-label="Jump to section"
          className="sticky top-0 z-30 -mx-4 sm:-mx-6 px-4 sm:px-6 py-2 sm:py-1.5 bg-card/95 backdrop-blur border-y border-border"
        >
          <div className="flex items-center gap-1.5 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
            <span className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold shrink-0 mr-1">
              Jump to:
            </span>
            {([
              { id: 'cm-treasury',     label: 'Treasury ⇄ Wallets', emoji: '🔁' },
              { id: 'cm-company-wallet-chart', label: 'Company → Wallets', emoji: '🏦' },
              { id: 'cm-allocation-chart', label: 'Allocation chart', emoji: '📊' },
              { id: 'cm-timeline',     label: 'Movement timeline', emoji: '🕒' },
              simpleMode ? { id: 'cm-glance',       label: 'Glance',       emoji: '👀' } : null,
              { id: 'cm-totals',       label: 'Money In / Out', emoji: '⇅' },
              !simpleMode ? { id: 'cm-inflows',    label: 'New money',     emoji: '⬆️' } : null,
              !simpleMode ? { id: 'cm-categories', label: 'Categories',    emoji: '📂' } : null,
              { id: 'cm-transactions', label: 'Transactions',  emoji: '🧾' },
            ].filter(Boolean) as Array<{ id: string; label: string; emoji: string }>).map(item => (
              <button
                key={item.id}
                type="button"
                onClick={() => {
                  const el = document.getElementById(item.id);
                  if (!el) return;
                  // Open the transactions collapsible automatically so the
                  // "Transactions" anchor lands on visible content, not on
                  // a closed trigger.
                  if (item.id === 'cm-transactions') setPageDrillOpen(true);
                  setTimeout(() => el.scrollIntoView({ behavior: 'smooth', block: 'start' }), 30);
                }}
                className="shrink-0 inline-flex items-center gap-1 rounded-full border border-border bg-background hover:bg-accent hover:text-accent-foreground px-2.5 py-1 text-[11px] font-medium transition-colors"
                aria-label={`Jump to ${item.label} section`}
              >
                <span aria-hidden="true">{item.emoji}</span>
                <span>{item.label}</span>
              </button>
            ))}
          </div>
        </nav>

        {/* ─── Treasury ⇄ Wallets headline report ──────────────────
            The primary view the CFO asked for: how the CFO moves money
            from company funds into wallets, and how agents allocate money
            out of their wallets back to the company. Shown first, above
            every other breakdown. */}
        <TreasuryWalletFlowSummary
          rows={rows}
          includeAdjustments={includeAdjustments}
          periodFrom={range.from?.toISOString() ?? null}
          onDrill={(direction) => {
            setScopeFilter('wallet');
            setDirectionQuickFilter(direction);
            setPageDrillOpen(true);
            setTimeout(() => {
              document.getElementById('cm-transactions')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
            }, 50);
          }}
        />

        {/* ─── Agent allocation breakdown chart ────────────────────
            Per-agent view of the Wallets → Company flow, split by
            category and amount as a horizontal stacked bar chart. */}
        {/* ─── Company → Wallets breakdown chart ───────────────────
            Per-category view of the Company → Wallets flow: how each
            category moved company money into user & agent wallets. */}
        <CompanyToWalletBreakdownChart
          rows={rows}
          includeAdjustments={includeAdjustments}
        />

        <AgentAllocationBreakdownChart
          rows={rows}
          includeAdjustments={includeAdjustments}
        />

        {/* ─── Movement Timeline (strict CFO category order) ───────
            Every cash movement in the period, grouped in the exact CFO
            category sequence, each shown as a clear timeline entry:
            Date · Amount · Source → Destination. */}
        <MovementTimeline
          rows={rows}
          includeAdjustments={includeAdjustments}
        />

        {/* ─── Thumb-friendly filter bar ──────────────────────────
            Three large tap targets (≥56px tall) for the filters non-tech
            users reach for most: Date, Direction, and Party. Each opens a
            full-width bottom sheet on phones so options are easy to scan
            and tap with a thumb. Existing chip rows below remain for
            power users and are unchanged. */}
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-2.5 sm:gap-2">
          {[
            {
              key: 'date' as const,
              icon: <Calendar className="h-5 w-5" />,
              label: 'Date',
              value: PERIODS.find(p => p.value === period)?.label || period,
              active: true,
              onClick: () => setDateSheetOpen(true),
            },
            {
              key: 'dir' as const,
              icon: <ArrowLeftRight className="h-5 w-5" />,
              label: 'Direction',
              value: directionLabel,
              active: directionQuickFilter !== 'all',
              onClick: () => setDirectionSheetOpen(true),
            },
            {
              key: 'party' as const,
              icon: <Users className="h-5 w-5" />,
              label: 'Party',
              value: partyLabel,
              active: !!partyQuickFilter,
              onClick: () => setPartySheetOpen(true),
            },
          ].map(btn => (
            <button
              key={btn.key}
              type="button"
              onClick={btn.onClick}
              className={cn(
                'w-full min-h-[60px] sm:min-h-[68px] rounded-xl border-2 px-4 py-3 sm:py-2.5 text-left',
                'flex flex-row sm:flex-col items-center sm:items-start justify-between sm:justify-start gap-3 sm:gap-1 transition-colors',
                'active:scale-[0.98] touch-manipulation',
                btn.active
                  ? 'border-primary bg-primary/10 hover:bg-primary/15'
                  : 'border-border bg-card hover:bg-muted/60',
              )}
              aria-label={`${btn.label} filter, currently ${btn.value}. Press to change.`}
              aria-haspopup="dialog"
              aria-pressed={btn.active}
            >
              <span className={cn(
                'flex items-center gap-2 text-[11px] sm:text-[10px] uppercase tracking-wide font-semibold shrink-0',
                btn.active ? 'text-primary' : 'text-muted-foreground',
              )}>
                {btn.icon}
                {btn.label}
              </span>
              <span className="text-sm font-semibold leading-snug truncate text-right sm:text-left">
                {btn.value}
              </span>
            </button>
          ))}
        </div>
        {(directionQuickFilter !== 'all' || partyQuickFilter) && (
          <button
            type="button"
            onClick={() => { setDirectionQuickFilter('all'); setPartyQuickFilter(null); }}
            className="-mt-2 text-[11px] text-muted-foreground hover:text-foreground inline-flex items-center gap-1"
          >
            <X className="h-3 w-3" /> Clear filters
          </button>
        )}

        {/* Secondary filters — stacked card on mobile with clear labels and
            full-width controls; on sm+ they keep the airy in-flow layout. */}
        <div className="rounded-xl border border-border bg-muted/20 sm:bg-transparent sm:border-0 sm:rounded-none p-3 sm:p-0 space-y-3 sm:space-y-2">
          {/* Period */}
          <div>
            <label className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground mb-1.5 flex items-center gap-1">
              <Calendar className="h-3.5 w-3.5" /> Show me
            </label>
            <div className="grid grid-cols-3 sm:flex sm:flex-wrap sm:gap-1.5 gap-1.5 sm:items-center">
              {PERIODS.map(p => (
                <Button
                  key={p.value}
                  size="sm"
                  variant={period === p.value ? 'default' : 'outline'}
                  className="text-xs h-9 sm:h-8 w-full sm:w-auto sm:shrink-0"
                  onClick={() => setPeriod(p.value)}
                >
                  {p.label}
                </Button>
              ))}
            </div>
          </div>

          {/* Group by */}
          <div>
            <label className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground mb-1.5 block">Group by</label>
            <div className="grid grid-cols-3 sm:flex sm:gap-1.5 gap-1.5 sm:overflow-x-auto sm:pb-1 sm:-mx-1 sm:px-1">
              {GRANULARITIES.map(g => (
                <Button
                  key={g.value}
                  size="sm"
                  variant={granularity === g.value ? 'default' : 'outline'}
                  className="text-xs h-9 sm:h-8 w-full sm:w-auto sm:shrink-0"
                  onClick={() => setGranularity(g.value)}
                >
                  {g.label}
                </Button>
              ))}
            </div>
          </div>

          {/* Where */}
          <div>
            <label className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground mb-1.5 block">Where</label>
            <div className="grid grid-cols-2 sm:flex sm:gap-1.5 gap-1.5 sm:overflow-x-auto sm:pb-1 sm:-mx-1 sm:px-1">
              {(['all','platform','wallet','bridge'] as const).map(s => (
                <Button
                  key={s}
                  size="sm"
                  variant={scopeFilter === s ? 'default' : 'outline'}
                  className="text-xs h-9 sm:h-8 w-full sm:w-auto sm:shrink-0"
                  onClick={() => setScopeFilter(s)}
                >
                  {s === 'all' ? 'Everywhere' : SCOPE_LABEL[s] || s}
                </Button>
              ))}
            </div>
            <Button
              size="sm"
              variant={includeAdjustments ? 'default' : 'outline'}
              className="text-xs h-9 sm:h-8 w-full sm:w-auto mt-2 sm:mt-1.5 sm:ml-0"
              onClick={() => setIncludeAdjustments(v => !v)}
            >
              {includeAdjustments ? '✓ Showing fixes' : 'Show fixes'}
            </Button>
          </div>
        </div>

        {/* Actions */}
        <div className="grid grid-cols-2 sm:flex sm:flex-wrap sm:items-center gap-2">
          <Button onClick={generate} disabled={loading} size="sm" className="gap-2 h-10 sm:h-8 w-full sm:w-auto col-span-2 sm:col-auto">
            {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
            {loading ? 'Loading…' : 'Reload'}
          </Button>
          <Button
            onClick={() => setAutoRefresh(v => !v)}
            variant={autoRefresh ? 'default' : 'outline'}
            size="sm"
            className="gap-2 h-10 sm:h-8 w-full sm:w-auto col-span-2 sm:col-auto"
            title={autoRefresh ? 'Auto-refresh every 60s — click to stop' : 'Refresh every 60 seconds'}
          >
            <RefreshCw className={cn('h-3.5 w-3.5', autoRefresh && 'animate-spin-slow')} />
            {autoRefresh ? 'Auto · 1m' : 'Auto-refresh'}
          </Button>
          <Button
            onClick={handleExport}
            variant="outline" size="sm" className="gap-2 h-10 sm:h-8 w-full sm:w-auto"
            disabled={!aggregates.length || !canViewLedgerDetail}
            title={!canViewLedgerDetail ? 'Only finance leaders can download these reports' : undefined}
          >
            {canViewLedgerDetail ? <FileSpreadsheet className="h-3.5 w-3.5" /> : <Lock className="h-3.5 w-3.5" />}
            <span className="hidden xs:inline">Download </span>CSV
          </Button>
          <Button
            onClick={handleExportPdf}
            variant="outline" size="sm" className="gap-2 h-10 sm:h-8 w-full sm:w-auto"
            disabled={!aggregates.length || !canViewLedgerDetail}
            title={!canViewLedgerDetail ? 'Only finance leaders can download these reports' : undefined}
          >
            {canViewLedgerDetail ? <FileText className="h-3.5 w-3.5" /> : <Lock className="h-3.5 w-3.5" />}
            <span className="hidden xs:inline">Download </span>PDF
          </Button>
          <Button
            onClick={handleExportAllEntries}
            variant="outline" size="sm" className="gap-2 h-10 sm:h-8 w-full sm:w-auto col-span-2 sm:col-auto"
            disabled={!rows.length || !canViewLedgerDetail}
            title={!canViewLedgerDetail
              ? 'Only finance leaders can download these reports'
              : 'Download every single transaction in this period'}
          >
            {canViewLedgerDetail ? <FileSpreadsheet className="h-3.5 w-3.5" /> : <Lock className="h-3.5 w-3.5" />}
            All transactions
          </Button>
          {!canViewLedgerDetail && (
            <span className="text-xs text-muted-foreground self-center ml-1 inline-flex items-center gap-1">
              <Lock className="h-3 w-3" /> Downloads locked
            </span>
          )}
          {generatedAt && (
            <span className="text-xs text-muted-foreground self-center sm:ml-1 w-full sm:w-auto">
              Updated {format(generatedAt, 'dd MMM HH:mm')} · {rows.length.toLocaleString()} transactions
            </span>
          )}
        </div>

        {/* ─── Page-level empty state ───────────────────────────────
            When the ledger query returned zero rows for the current
            period + scope, show a clear, friendly explanation with a
            couple of one-tap suggestions (widen period, drop scope
            filter, include adjustments). Skipped while loading the
            very first batch so users don't see a flash of "no data". */}
        {!loading && rows.length === 0 && generatedAt && (
          <div
            role="status"
            aria-live="polite"
            className="rounded-2xl border border-dashed border-border bg-muted/20 p-6 sm:p-8 text-center space-y-3"
          >
            <div className="mx-auto h-10 w-10 rounded-full bg-muted flex items-center justify-center">
              <Filter className="h-5 w-5 text-muted-foreground" />
            </div>
            <div>
              <div className="text-sm sm:text-base font-semibold text-foreground">
                No cash movements yet
              </div>
              <p className="mt-1 text-xs sm:text-[13px] text-muted-foreground max-w-md mx-auto leading-relaxed">
                Nothing posted to the ledger for{' '}
                <span className="font-medium text-foreground">
                  {PERIODS.find(p => p.value === period)?.label || period}
                </span>
                {scopeFilter !== 'all' && (
                  <> in the <span className="font-medium text-foreground">{scopeFilter}</span> scope</>
                )}
                . Try widening the period or clearing filters.
              </p>
            </div>
            <div className="flex flex-wrap gap-2 justify-center pt-1">
              {period !== '30d' && (
                <Button size="sm" variant="outline" className="h-8 text-xs" onClick={() => setPeriod('30d')}>
                  Try last 30 days
                </Button>
              )}
              {scopeFilter !== 'all' && (
                <Button size="sm" variant="outline" className="h-8 text-xs" onClick={() => setScopeFilter('all')}>
                  Clear scope filter
                </Button>
              )}
              {!includeAdjustments && (
                <Button size="sm" variant="outline" className="h-8 text-xs" onClick={() => setIncludeAdjustments(true)}>
                  Include adjustments
                </Button>
              )}
              <Button size="sm" variant="default" className="h-8 text-xs gap-1.5" onClick={generate}>
                <RefreshCw className="h-3.5 w-3.5" /> Reload
              </Button>
            </div>
          </div>
        )}

        {/* ─── Wallet Money Movement (minimalist) ───
            Primary view: money flowing INTO and OUT OF user/operational wallets
            in the selected period. Shown first by default. */}
        {!simpleMode && (
          <WalletMovementSummary rows={rows} includeAdjustments={includeAdjustments} period={period} />
        )}

        {/* Plain-English summary — one friendly sentence anyone can read.
            Shown only in Simple mode so non-tech / non-accounting users get
            the headline without scrolling through tables and matrices. */}
        {/* ─── Glance hero (Simple mode only) ─────────────────────
            For people who don't want to read details: one giant
            emoji verdict, one giant headline number, and three
            huge tap-targets to either jump to the relevant
            transactions or share the summary. Pure presentation —
            uses existing handlers (openPageDrill, handleShareSummary). */}
        {simpleMode && (
          (() => {
            const quiet = totals.cashIn === 0 && totals.cashOut === 0;
            const verdictWord = quiet ? 'Quiet' : totals.net > 0 ? 'Gained' : totals.net < 0 ? 'Spent more' : 'Balanced';
            const headlineNumber = quiet
              ? '—'
              : totals.net === 0
                ? formatUGX(0)
                : `${totals.net > 0 ? '+' : '−'}${formatUGX(Math.abs(totals.net))}`;
            const verdictColor =
              quiet ? 'text-muted-foreground'
              : totals.net > 0 ? 'text-success'
              : totals.net < 0 ? 'text-destructive'
              : 'text-foreground';
            return (
              <div
                id="cm-glance"
                className="scroll-mt-24 rounded-2xl border border-border bg-card p-5 sm:p-7 space-y-6"
              >
                <div className="space-y-2">
                  <div className="text-[11px] uppercase tracking-[0.18em] text-muted-foreground font-medium">
                    {verdictWord} · {PERIODS.find(p => p.value === period)?.label || period}
                  </div>
                  <div className={cn('font-mono font-semibold text-4xl sm:text-6xl tracking-tight break-all leading-none', verdictColor)}>
                    {headlineNumber}
                  </div>
                </div>
                <div className="grid grid-cols-3 gap-2 sm:gap-3">
                  <button
                    type="button"
                    onClick={() => openPageDrill('cash_in')}
                    className="group rounded-xl border border-border bg-card hover:bg-muted/40 active:scale-[0.99] transition px-3 py-3 sm:py-4 text-left"
                    aria-label="See money coming in"
                  >
                    <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-muted-foreground">
                      <ArrowUpRight className="h-3 w-3 text-success" /> In
                    </div>
                    <div className="mt-1 font-mono text-sm sm:text-lg font-semibold text-success truncate">
                      {formatUGX(totals.cashIn)}
                    </div>
                  </button>
                  <button
                    type="button"
                    onClick={() => openPageDrill('cash_out')}
                    className="group rounded-xl border border-border bg-card hover:bg-muted/40 active:scale-[0.99] transition px-3 py-3 sm:py-4 text-left"
                    aria-label="See money going out"
                  >
                    <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-muted-foreground">
                      <ArrowDownRight className="h-3 w-3 text-destructive" /> Out
                    </div>
                    <div className="mt-1 font-mono text-sm sm:text-lg font-semibold text-destructive truncate">
                      {formatUGX(totals.cashOut)}
                    </div>
                  </button>
                  <button
                    type="button"
                    onClick={handleShareSummary}
                    className="group rounded-xl border border-border bg-card hover:bg-muted/40 active:scale-[0.99] transition px-3 py-3 sm:py-4 text-left"
                    aria-label="Share this summary"
                  >
                    <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-muted-foreground">
                      <Share2 className="h-3 w-3" /> Share
                    </div>
                    <div className="mt-1 text-sm sm:text-base font-medium text-foreground">
                      Image · PDF
                    </div>
                  </button>
                </div>
              </div>
            );
          })()
        )}
        {/* ─── Tap-to-drill shortcuts (Simple mode) ───────────────
            Two big rows directly under the Glance hero that jump
            straight to the filtered transaction list (Money in or
            Money out) without scrolling. Shows live counts so users
            see how many entries they'll land on. */}
        {simpleMode && (() => {
          const inCount = rows.reduce((n, r) => n + (r.direction === 'cash_in' ? 1 : 0), 0);
          const outCount = rows.reduce((n, r) => n + (r.direction === 'cash_out' ? 1 : 0), 0);
          const shortcuts = [
            {
              key: 'in' as const,
              icon: <ArrowUpRight className="h-5 w-5 text-success" />,
              title: 'Money in',
              count: inCount,
              tone: 'border-success/30 bg-success/5 hover:bg-success/10',
              onClick: () => openPageDrill('cash_in'),
              ariaLabel: `See every Money-In transaction (${inCount.toLocaleString()})`,
            },
            {
              key: 'out' as const,
              icon: <ArrowDownRight className="h-5 w-5 text-destructive" />,
              title: 'Money out',
              count: outCount,
              tone: 'border-destructive/30 bg-destructive/5 hover:bg-destructive/10',
              onClick: () => openPageDrill('cash_out'),
              ariaLabel: `See every Money-Out transaction (${outCount.toLocaleString()})`,
            },
          ];
          return (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
              {shortcuts.map(s => (
                <button
                  key={s.key}
                  type="button"
                  onClick={s.onClick}
                  aria-label={s.ariaLabel}
                  className={cn(
                    'min-h-[72px] w-full rounded-xl border-2 px-4 py-3 text-left transition-colors',
                    'flex items-center gap-3 active:scale-[0.99] touch-manipulation',
                    s.tone,
                  )}
                >
                  <span className="shrink-0">{s.icon}</span>
                  <span className="flex-1 min-w-0">
                    <span className="block text-sm font-semibold text-foreground leading-tight">{s.title} transactions</span>
                    <span className="block text-[11px] text-muted-foreground mt-0.5">
                      {s.count.toLocaleString()} {s.count === 1 ? 'entry' : 'entries'}
                    </span>
                  </span>
                  <ChevronRight className="h-4 w-4 text-muted-foreground shrink-0" aria-hidden="true" />
                </button>
              ))}
            </div>
          );
        })()}
        {simpleMode && (
          <div className="rounded-xl border border-border bg-card p-4 sm:p-5 space-y-2">
            <div className="text-[10px] uppercase tracking-[0.18em] text-muted-foreground font-medium">
              In plain English · {PERIODS.find(p => p.value === period)?.label || period}
            </div>
            <p className="text-sm sm:text-[15px] leading-relaxed text-foreground">
              {totals.cashIn === 0 && totals.cashOut === 0 ? (
                <>No money moved during this period.</>
              ) : (
                <>
                  <span className="font-semibold text-success">{formatUGX(totals.cashIn)}</span>
                  {' came '}<span className="font-semibold">IN</span>{' and '}
                  <span className="font-semibold text-destructive">{formatUGX(totals.cashOut)}</span>
                  {' went '}<span className="font-semibold">OUT</span>{'. '}
                  {totals.net > 0 ? (
                    <>Welile <span className="font-semibold text-success">gained {formatUGX(totals.net)}</span> overall.</>
                  ) : totals.net < 0 ? (
                    <>Welile <span className="font-semibold text-destructive">spent {formatUGX(Math.abs(totals.net))}</span> more than it received.</>
                  ) : (
                    <>Money in and out balanced exactly.</>
                  )}
                </>
              )}
            </p>
            <p className="text-[11px] text-muted-foreground">
              Tap <span className="font-semibold">Detailed view</span> at the top for the full breakdown, tables, and downloads.
            </p>
          </div>
        )}

        {/* Totals strip (full ledger scope: platform + wallet) */}
        {/* ─── Applied filters chips ──────────────────────────────
            At-a-glance summary of what the totals below are filtered
            by (Date period, Direction, Party). The Date chip is
            informational; Direction & Party chips are clearable with
            the ✕. Purely presentational — read from existing state. */}
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-[10px] uppercase tracking-wide text-muted-foreground mr-0.5">
            Showing:
          </span>
          <span
            className="inline-flex items-center gap-1 rounded-full border border-border bg-muted px-2.5 py-1 text-[11px] font-medium text-foreground"
            title={`Date period: ${rangeLabel}`}
          >
            <Calendar className="h-3 w-3 text-muted-foreground" />
            <span className="text-muted-foreground">Date:</span>
            <span className="truncate max-w-[180px] sm:max-w-none">{PERIODS.find(p => p.value === period)?.label || period}</span>
          </span>
          {directionQuickFilter !== 'all' ? (
            <button
              type="button"
              onClick={() => setDirectionQuickFilter('all')}
              className="inline-flex items-center gap-1 rounded-full border border-primary/40 bg-primary/10 px-2.5 py-1 text-[11px] font-medium text-foreground hover:bg-primary/15"
              title="Clear direction filter"
            >
              {directionQuickFilter === 'cash_in' ? (
                <ArrowUpRight className="h-3 w-3 text-success" />
              ) : directionQuickFilter === 'cash_out' ? (
                <ArrowDownRight className="h-3 w-3 text-destructive" />
              ) : (
                <Filter className="h-3 w-3 text-muted-foreground" />
              )}
              <span className="text-muted-foreground">Direction:</span>
              <span>{directionLabel}</span>
              <X className="h-3 w-3 text-muted-foreground hover:text-foreground" />
            </button>
          ) : (
            <span className="inline-flex items-center gap-1 rounded-full border border-dashed border-border bg-transparent px-2.5 py-1 text-[11px] text-muted-foreground">
              <Filter className="h-3 w-3" />
              <span>Direction:</span>
              <span>All</span>
            </span>
          )}
          {partyQuickFilter ? (
            <button
              type="button"
              onClick={() => setPartyQuickFilter(null)}
              className="inline-flex items-center gap-1 rounded-full border border-primary/40 bg-primary/10 px-2.5 py-1 text-[11px] font-medium text-foreground hover:bg-primary/15"
              title="Clear party filter"
            >
              <Users className="h-3 w-3 text-muted-foreground" />
              <span className="text-muted-foreground">Party:</span>
              <span className="truncate max-w-[140px]">{partyLabel}</span>
              <X className="h-3 w-3 text-muted-foreground hover:text-foreground" />
            </button>
          ) : (
            <span className="inline-flex items-center gap-1 rounded-full border border-dashed border-border bg-transparent px-2.5 py-1 text-[11px] text-muted-foreground">
              <Users className="h-3 w-3" />
              <span>Party:</span>
              <span>Anyone</span>
            </span>
          )}
          {(directionQuickFilter !== 'all' || partyQuickFilter) && (
            <button
              type="button"
              onClick={() => { setDirectionQuickFilter('all'); setPartyQuickFilter(null); }}
              className="ml-auto text-[10px] font-semibold uppercase text-muted-foreground hover:text-foreground underline-offset-2 hover:underline"
              title="Clear Direction and Party filters"
            >
              Clear filters
            </button>
          )}
        </div>

        <div id="cm-totals" className="scroll-mt-24 grid grid-cols-1 sm:grid-cols-3 gap-2.5 sm:gap-2">
          {([
            {
              key: 'in' as const,
              label: 'Money In',
              icon: <ArrowUpRight className="h-3.5 w-3.5 text-success" />,
              value: formatUGX(totals.cashIn),
              valueClass: 'text-success',
              tone: 'bg-success/5 border-success/20',
              cta: 'See where this comes from',
              ariaLabel: 'See where Money In comes from — open the transaction list filtered to cash in',
              onClick: () => openPageDrill('cash_in'),
            },
            {
              key: 'out' as const,
              label: 'Money Out',
              icon: <ArrowDownRight className="h-3.5 w-3.5 text-destructive" />,
              value: formatUGX(totals.cashOut),
              valueClass: 'text-destructive',
              tone: 'bg-destructive/5 border-destructive/20',
              cta: 'See where this comes from',
              ariaLabel: 'See where Money Out comes from — open the transaction list filtered to cash out',
              onClick: () => openPageDrill('cash_out'),
            },
            {
              key: 'net' as const,
              label: 'Difference',
              icon: null,
              value: `${totals.net >= 0 ? '+' : ''}${formatUGX(totals.net)}`,
              valueClass: totals.net >= 0 ? 'text-success' : 'text-destructive',
              tone: totals.net >= 0 ? 'bg-success/5 border-success/20' : 'bg-destructive/5 border-destructive/20',
              cta: 'See where this comes from',
              ariaLabel: 'See where the Difference comes from — open the full transaction list',
              onClick: () => openPageDrill('all'),
            },
          ]).map(card => (
            <button
              key={card.key}
              type="button"
              onClick={card.onClick}
              aria-label={card.ariaLabel}
              className={cn(
                'min-h-[88px] w-full text-left rounded-xl border p-3 sm:p-3 flex flex-col gap-1',
                'transition-colors hover:bg-muted/30 active:scale-[0.99] touch-manipulation',
                card.tone,
              )}
            >
              <span className="flex items-center gap-1 text-[10px] uppercase tracking-wide text-muted-foreground leading-snug">
                {card.icon}
                {card.label}
              </span>
              <span className={cn('font-mono font-semibold text-base sm:text-base break-all leading-tight', card.valueClass)}>
                {card.value}
              </span>
              <span className="mt-auto text-[11px] font-medium text-muted-foreground inline-flex items-center gap-0.5">
                {card.cta} <ChevronRight className="h-3 w-3" aria-hidden="true" />
              </span>
            </button>
          ))}
        </div>

        {/* ─── Top Categories summary ───────────────────────────
            Shows the biggest categories for the current filters.
            Tapping a chip toggles `categoryQuickFilter`, filtering
            the Categories table below, and smooth-scrolls to it.
            Pure presentation — no ledger writes. */}
        {topCategoriesSummary.top.length > 0 && (
          <div className="rounded-xl border border-border bg-card p-3 sm:p-4 space-y-2.5">
            <div className="flex items-center justify-between gap-2">
              <div className="text-xs sm:text-sm font-semibold text-foreground inline-flex items-center gap-1.5">
                <span aria-hidden>🏷️</span> Top categories
                <span className="text-[10px] font-normal text-muted-foreground">
                  · {topCategoriesSummary.categoryCount} total
                </span>
              </div>
              <div className="flex items-center gap-2">
                <div
                  role="group"
                  aria-label="Number of top categories to show"
                  className="inline-flex rounded-md border border-border overflow-hidden"
                >
                  {[5, 10].map(n => {
                    const active = topCategoriesLimit === n;
                    const disabled = n === 10 && topCategoriesSummary.categoryCount <= 5;
                    return (
                      <button
                        key={n}
                        type="button"
                        onClick={() => setTopCategoriesLimit(n as 5 | 10)}
                        disabled={disabled}
                        aria-pressed={active}
                        className={cn(
                          'px-2 py-0.5 text-[11px] font-medium transition-colors',
                          active ? 'bg-primary text-primary-foreground' : 'bg-card text-muted-foreground hover:bg-muted',
                          disabled && 'opacity-40 cursor-not-allowed',
                        )}
                        title={disabled ? `Only ${topCategoriesSummary.categoryCount} categories available` : `Show top ${n}`}
                      >
                        Top {n}
                      </button>
                    );
                  })}
                </div>
                {(categoryQuickFilter || topCategoriesLimit !== 5) && (
                  <button
                    type="button"
                    onClick={() => {
                      setCategoryQuickFilter(null);
                      setTopCategoriesLimit(5);
                    }}
                    className="text-[11px] text-muted-foreground hover:text-foreground underline-offset-2 hover:underline inline-flex items-center gap-1"
                    aria-label="Reset filters: clear category filter and restore Top 5"
                    title="Reset to Top 5 and clear the active category filter"
                  >
                    <X className="h-3 w-3" /> Reset filters
                  </button>
                )}
              </div>
            </div>
            <div className="flex flex-wrap gap-1.5">
              {topCategoriesSummary.top.map(c => {
                const active = categoryQuickFilter === c.category;
                return (
                  <button
                    key={c.category}
                    type="button"
                    onClick={() => {
                      setCategoryQuickFilter(f => f === c.category ? null : c.category);
                      requestAnimationFrame(() => {
                        document.getElementById('cm-categories')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
                      });
                    }}
                    aria-pressed={active}
                    title={`${prettifyCategory(c.category)} · ${c.count} entr${c.count === 1 ? 'y' : 'ies'} · tap to filter the table`}
                    className={cn(
                      'group flex flex-col items-start gap-0.5 rounded-lg border px-2.5 py-1.5 text-left transition-all active:scale-[0.98]',
                      'min-w-[120px] max-w-full',
                      active
                        ? 'border-primary bg-primary/10 ring-1 ring-primary'
                        : 'border-border bg-muted/30 hover:bg-muted/60 hover:border-primary/40',
                    )}
                  >
                    <span className="text-[11px] font-medium truncate max-w-full">
                      {prettifyCategory(c.category)}
                    </span>
                    <span className="font-mono text-[11px] font-semibold text-foreground">
                      {formatUGX(c.total)}
                    </span>
                    <span className="text-[9px] uppercase tracking-wide text-muted-foreground">
                      {(c.share * 100).toFixed(0)}% · {c.count} entr{c.count === 1 ? 'y' : 'ies'}
                    </span>
                  </button>
                );
              })}
            </div>
            <div className="text-[10px] text-muted-foreground">
              Tap a category to filter the table below.
            </div>
          </div>
        )}

        {/* ─── Share / Download summary ───────────────────────────
            Exports the same plain-English summary (period, In, Out,
            Difference, any anomalies) as a portrait image, a PDF, or
            via the native share sheet on supported devices. Pure
            client-side render — never touches the ledger. */}
        <div className="rounded-xl border border-border bg-muted/30 p-2.5 flex flex-wrap items-center gap-2">
          <span className="text-[11px] text-muted-foreground inline-flex items-center gap-1 mr-1">
            <Share2 className="h-3.5 w-3.5" /> Share / save this summary
          </span>
          <Button
            type="button"
            size="sm"
            variant="default"
            className="h-9 gap-1.5"
            onClick={handleShareSummary}
            title="Share via your phone's share sheet (or save as image if not supported)"
          >
            <Share2 className="h-3.5 w-3.5" /> Share
          </Button>
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="h-9 gap-1.5"
            onClick={handleDownloadSummaryPng}
            title="Save the summary as a PNG image"
          >
            <ImageIcon className="h-3.5 w-3.5" /> Save image
          </Button>
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="h-9 gap-1.5"
            onClick={handleDownloadSummaryPdf}
            title="Download the summary as a PDF"
          >
            <Download className="h-3.5 w-3.5" /> PDF
          </Button>
        </div>

        {/* ─── Anomaly alerts (plain language) ───────────────────
            Surfaces unusual spikes and quiet gaps in the selected
            period so non-accounting readers notice them at a glance.
            Read-only — derived from `rows` in `anomalyAlerts`. */}
        {anomalyAlerts.length > 0 && (
          <div className="rounded-xl border-2 border-amber-500/40 bg-amber-500/5 p-3 space-y-2">
            <div className="flex items-center gap-2">
              <AlertTriangle className="h-4 w-4 text-amber-600 dark:text-amber-400 shrink-0" />
              <div className="text-sm font-semibold text-foreground">
                Heads up — {anomalyAlerts.length} unusual {anomalyAlerts.length === 1 ? 'pattern' : 'patterns'} in this period
              </div>
            </div>
            <ul className="space-y-1.5">
              {anomalyAlerts.map((a, idx) => (
                <li
                  key={`${a.kind}-${a.date}-${idx}`}
                  className="flex items-start gap-2 rounded-lg bg-card border border-border px-2.5 py-2"
                >
                  <div className={cn(
                    'mt-0.5 h-6 w-6 rounded-full flex items-center justify-center shrink-0',
                    a.kind === 'spike' ? 'bg-amber-500/15 text-amber-600 dark:text-amber-400' : 'bg-muted text-muted-foreground',
                  )}>
                    {a.kind === 'spike' ? <TrendingUp className="h-3.5 w-3.5" /> : <MinusCircle className="h-3.5 w-3.5" />}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="text-[12px] sm:text-sm font-semibold leading-tight">{a.label}</div>
                    <div className="text-[11px] text-muted-foreground leading-snug">{a.detail}</div>
                  </div>
                </li>
              ))}
            </ul>
            <p className="text-[10px] text-muted-foreground px-0.5">
              "Unusual" means a day that's far above the period's typical daily flow, or a quiet day sandwiched between busy ones. This is a hint, not an error.
            </p>
          </div>
        )}

        {/* ─── Tap to see details ──────────────────────────────────
            A simple, mobile-friendly list of individual cash-in /
            cash-out transactions for the current filters. Each row
            shows date, amount, category and party — no jargon, no
            tables, just a tappable list. Read-only view derived from
            the same `rows` everything else on the page uses. */}
        {(() => {
          const sq = debouncedPageSearch.trim().toLowerCase();
          const sqDigits = sq.replace(/[^0-9]/g, '');
          const pageDrillRows = rows
            .filter(r => {
              if (!includeAdjustments && (r.classification === 'admin_correction' || r.category === 'system_balance_correction')) return false;
              if (scopeFilter !== 'all' && r.ledger_scope !== scopeFilter) return false;
              if (partyQuickFilter && r.user_id !== partyQuickFilter) return false;
              if (directionQuickFilter === 'cash_in' && r.direction !== 'cash_in') return false;
              if (directionQuickFilter === 'cash_out' && r.direction !== 'cash_out') return false;
              if (sq) {
                const name = r.user_id ? (partyNames[r.user_id] || '') : '';
                const amtStr = String(Math.trunc(Number(r.amount) || 0));
                const hay = [
                  r.reference_id || '',
                  r.description || '',
                  prettifyCategory(r.category || ''),
                  r.linked_party ? prettifyCategory(r.linked_party) : '',
                  name,
                  r.user_id || '',
                  r.transaction_group_id || '',
                ].join(' ').toLowerCase();
                const textMatch = hay.includes(sq);
                const amountMatch = sqDigits.length > 0 && amtStr.includes(sqDigits);
                if (!textMatch && !amountMatch) return false;
              }
              return true;
            })
            .sort((a, b) => new Date(b.transaction_date).getTime() - new Date(a.transaction_date).getTime());
          const visible = pageDrillRows.slice(0, pageDrillVisible);
          const searchActive = sq.length > 0;
          return (
            <Collapsible
              open={pageDrillOpen || searchActive}
              onOpenChange={(o) => { setPageDrillOpen(o); if (o) setPageDrillVisible(25); }}
            >
              <div id="cm-transactions" ref={pageDrillRef} className="scroll-mt-24" />
              {/* Quick search — filter the list without opening details */}
              <div className="relative mb-2">
                <Search className="h-4 w-4 text-muted-foreground absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
                <input
                  id="cm-page-search"
                  type="search"
                  inputMode="search"
                  value={pageSearch}
                  onChange={(e) => setPageSearch(e.target.value)}
                  placeholder="Search reference, party or amount…"
                  aria-label="Search transactions by reference, party, or amount"
                  aria-controls="cm-transactions-list"
                  className="w-full h-10 pl-9 pr-9 rounded-lg border border-border bg-background text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/40 focus:border-primary/40"
                />
                {pageSearch && (
                  <button
                    type="button"
                    onClick={() => setPageSearch('')}
                    className="absolute right-2 top-1/2 -translate-y-1/2 h-7 w-7 inline-flex items-center justify-center rounded-md text-muted-foreground hover:text-foreground hover:bg-muted"
                    aria-label="Clear search query"
                  >
                    <X className="h-4 w-4" />
                  </button>
                )}
              </div>
              {searchActive && (
                <div className="text-[11px] text-muted-foreground mb-1.5 px-1" role="status" aria-live="polite">
                  {pageDrillRows.length.toLocaleString()} match{pageDrillRows.length === 1 ? '' : 'es'} for “{debouncedPageSearch}”
                </div>
              )}
              <CollapsibleTrigger asChild>
                <button
                  type="button"
                  className="w-full flex items-center justify-between gap-2 rounded-xl border-2 border-primary/30 bg-primary/5 hover:bg-primary/10 px-3 py-3 text-left transition-colors min-h-[56px]"
                  aria-label={`Show ${pageDrillRows.length.toLocaleString()} transaction${pageDrillRows.length === 1 ? '' : 's'} matching current filters`}
                  aria-expanded={pageDrillOpen || searchActive}
                  aria-controls="cm-transactions-list"
                >
                  <span className="flex items-center gap-2 text-sm font-semibold text-foreground">
                    <Filter className="h-4 w-4 text-primary" aria-hidden="true" />
                    Tap to see details
                    <Badge variant="secondary" className="ml-1 text-[10px]">
                      {pageDrillRows.length.toLocaleString()} {pageDrillRows.length === 1 ? 'transaction' : 'transactions'}
                    </Badge>
                  </span>
                  <ChevronDown className="h-4 w-4 text-muted-foreground shrink-0 transition-transform data-[state=open]:rotate-180" aria-hidden="true" />
                </button>
              </CollapsibleTrigger>
              <CollapsibleContent className="pt-2" id="cm-transactions-list" role="region" aria-label="Filtered transactions list">
                {pageDrillRows.length === 0 ? (
                  (() => {
                    const activeChips: { label: string; onClear: () => void }[] = [];
                    if (searchActive) activeChips.push({ label: `Search: "${debouncedPageSearch}"`, onClear: () => setPageSearch('') });
                    if (directionQuickFilter !== 'all') {
                      const lbl = directionQuickFilter === 'cash_in' ? 'Money in'
                        : directionQuickFilter === 'cash_out' ? 'Money out'
                        : directionQuickFilter === 'net_positive' ? 'Net positive'
                        : 'Net negative';
                      activeChips.push({ label: lbl, onClear: () => setDirectionQuickFilter('all') });
                    }
                    if (scopeFilter !== 'all') {
                      activeChips.push({ label: `Scope: ${scopeFilter}`, onClear: () => setScopeFilter('all') });
                    }
                    if (partyQuickFilter) {
                      const partyLabel = partyNames[partyQuickFilter] || `${partyQuickFilter.slice(0, 8)}…`;
                      activeChips.push({ label: `Party: ${partyLabel}`, onClear: () => setPartyQuickFilter(null) });
                    }
                    if (!includeAdjustments) {
                      // not really an active filter exclusion the user picked, skip
                    }
                    return (
                      <div
                        role="status"
                        aria-live="polite"
                        className="text-center py-8 px-4 border border-dashed border-border rounded-xl bg-muted/10 space-y-3"
                      >
                        <div className="mx-auto h-9 w-9 rounded-full bg-muted flex items-center justify-center">
                          <Search className="h-4 w-4 text-muted-foreground" />
                        </div>
                        <div className="text-sm font-semibold text-foreground">
                          No transactions match
                        </div>
                        <p className="text-xs text-muted-foreground max-w-sm mx-auto leading-relaxed">
                          {activeChips.length > 0
                            ? 'Try removing one of the filters below, or clear them all.'
                            : 'There are no transactions to show for this period. Try widening the date range above.'}
                        </p>
                        {activeChips.length > 0 && (
                          <>
                            <div className="flex flex-wrap justify-center gap-1.5 pt-1">
                              {activeChips.map((c, i) => (
                                <button
                                  key={i}
                                  type="button"
                                  onClick={c.onClear}
                                  className="inline-flex items-center gap-1 rounded-full border border-border bg-background px-2.5 py-1 text-[11px] text-foreground hover:bg-muted transition-colors"
                                  aria-label={`Remove filter ${c.label}`}
                                >
                                  {c.label}
                                  <X className="h-3 w-3 text-muted-foreground" />
                                </button>
                              ))}
                            </div>
                            <Button
                              size="sm"
                              variant="outline"
                              className="h-8 text-xs mt-1"
                              onClick={() => {
                                setPageSearch('');
                                setDirectionQuickFilter('all');
                                setScopeFilter('all');
                                setPartyQuickFilter(null);
                              }}
                            >
                              Clear all filters
                            </Button>
                          </>
                        )}
                      </div>
                    );
                  })()
                ) : (
                  <>
                    <ul className="divide-y divide-border rounded-xl border border-border bg-card overflow-hidden">
                      {visible.map(r => {
                        const isIn = r.direction === 'cash_in';
                        const name = r.user_id
                          ? (partyNames[r.user_id] || `${r.user_id.slice(0, 8)}…`)
                          : (r.linked_party ? prettifyCategory(r.linked_party) : '—');
                        return (
                          <li key={r.id} className="flex items-start gap-2 px-3 py-2.5 hover:bg-muted/40 transition-colors">
                            <div className={cn(
                              'mt-0.5 h-7 w-7 rounded-full flex items-center justify-center shrink-0',
                              isIn ? 'bg-success/15 text-success' : 'bg-destructive/15 text-destructive',
                            )}>
                              {isIn ? <ArrowUpRight className="h-4 w-4" /> : <ArrowDownRight className="h-4 w-4" />}
                            </div>
                            <div className="flex-1 min-w-0">
                              <div className="flex items-baseline justify-between gap-2">
                                <div className="text-sm font-semibold truncate">{name}</div>
                                <div className={cn(
                                  'font-mono text-sm font-semibold whitespace-nowrap',
                                  isIn ? 'text-success' : 'text-destructive',
                                )}>
                                  {isIn ? '+' : '−'}{formatUGX(Number(r.amount) || 0)}
                                </div>
                              </div>
                              <div className="flex items-center gap-2 text-[11px] text-muted-foreground flex-wrap">
                                <span>{format(new Date(r.transaction_date), 'dd MMM yyyy · HH:mm')}</span>
                                <span>·</span>
                                <span className="truncate">{prettifyCategory(r.category)}</span>
                              </div>
                            </div>
                          </li>
                        );
                      })}
                    </ul>
                    {pageDrillRows.length > visible.length ? (
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        className="w-full mt-2 h-10"
                        onClick={() => setPageDrillVisible(n => n + 50)}
                      >
                        Show 50 more · {(pageDrillRows.length - visible.length).toLocaleString()} left
                      </Button>
                    ) : (
                      <div className="text-[10px] text-muted-foreground text-center mt-2">
                        End of list · {pageDrillRows.length.toLocaleString()} {pageDrillRows.length === 1 ? 'transaction' : 'transactions'} shown
                      </div>
                    )}
                  </>
                )}
              </CollapsibleContent>
            </Collapsible>
          );
        })()}

        {/* "What this number means" — plain-language help that explains the
            three headline numbers without accounting jargon. Collapsible so it
            doesn't push real data down the page on small screens. */}
        <Collapsible defaultOpen={simpleMode}>
          <CollapsibleTrigger asChild>
            <button
              type="button"
              className="w-full flex items-center justify-between gap-2 rounded-lg border border-border bg-muted/30 hover:bg-muted/60 px-3 py-2 text-left transition-colors"
              aria-label="What do these numbers mean?"
            >
              <span className="flex items-center gap-1.5 text-[11px] sm:text-xs font-semibold text-foreground">
                <Info className="h-3.5 w-3.5 text-primary" />
                What do these numbers mean?
              </span>
              <ChevronDown className="h-3.5 w-3.5 text-muted-foreground shrink-0 transition-transform data-[state=open]:rotate-180" />
            </button>
          </CollapsibleTrigger>
          <CollapsibleContent className="pt-2">
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
              <div className="rounded-md border border-success/30 bg-success/5 p-2.5 space-y-1">
                <div className="flex items-center gap-1 text-[11px] font-semibold text-success">
                  <ArrowUpRight className="h-3 w-3" /> Money In
                </div>
                <p className="text-[11px] leading-snug text-foreground/90">
                  Cash that <span className="font-semibold">came into</span> Welile during this period — like deposits from users, rent collected by agents, and money landlords or partners sent us.
                </p>
                <p className="text-[10px] text-muted-foreground italic">
                  Think of it as: <span className="font-semibold">"What we received."</span>
                </p>
              </div>
              <div className="rounded-md border border-destructive/30 bg-destructive/5 p-2.5 space-y-1">
                <div className="flex items-center gap-1 text-[11px] font-semibold text-destructive">
                  <ArrowDownRight className="h-3 w-3" /> Money Out
                </div>
                <p className="text-[11px] leading-snug text-foreground/90">
                  Cash that <span className="font-semibold">left</span> Welile during this period — like withdrawals to users, payouts to landlords, partner commissions, and supplier payments.
                </p>
                <p className="text-[10px] text-muted-foreground italic">
                  Think of it as: <span className="font-semibold">"What we paid out."</span>
                </p>
              </div>
              <div className={cn(
                'rounded-md border p-2.5 space-y-1',
                totals.net >= 0 ? 'border-success/30 bg-success/5' : 'border-destructive/30 bg-destructive/5'
              )}>
                <div className={cn('flex items-center gap-1 text-[11px] font-semibold', totals.net >= 0 ? 'text-success' : 'text-destructive')}>
                  = Difference
                </div>
                <p className="text-[11px] leading-snug text-foreground/90">
                  Money In <span className="font-mono">−</span> Money Out. A <span className="text-success font-semibold">+ plus</span> means Welile gained money. A <span className="text-destructive font-semibold">− minus</span> means we paid out more than we received.
                </p>
                <p className="text-[10px] text-muted-foreground italic">
                  Think of it as: <span className="font-semibold">"Did we end up richer or lighter?"</span>
                </p>
              </div>
            </div>
            <p className="text-[10px] text-muted-foreground mt-2 px-0.5">
              All amounts are in <span className="font-semibold">UGX</span> and only count the period selected above ({PERIODS.find(p => p.value === period)?.label || period}). Transfers between Welile's own wallets cancel out and don't inflate these numbers.
            </p>
          </CollapsibleContent>
        </Collapsible>

        {/* Quick filter chips — power-user shortcuts, hidden in Simple view. */}
        {!simpleMode && (
        <div className="space-y-1.5">
          <div className="text-[11px] text-muted-foreground flex items-center gap-1">
            <Filter className="h-3.5 w-3.5" /> Quick find
          </div>
          <div className="flex gap-1.5 overflow-x-auto pb-1 -mx-1 px-1 snap-x">
            <Button
              size="sm"
              variant={directionQuickFilter === 'cash_in' ? 'default' : 'outline'}
              className="text-xs h-8 shrink-0 snap-start"
              onClick={() => setDirectionQuickFilter(f => f === 'cash_in' ? 'all' : 'cash_in')}
            >
              <ArrowUpRight className="h-3 w-3 mr-1" /> Money In
            </Button>
            <Button
              size="sm"
              variant={directionQuickFilter === 'cash_out' ? 'default' : 'outline'}
              className="text-xs h-8 shrink-0 snap-start"
              onClick={() => setDirectionQuickFilter(f => f === 'cash_out' ? 'all' : 'cash_out')}
            >
              <ArrowDownRight className="h-3 w-3 mr-1" /> Money Out
            </Button>
            <Button
              size="sm"
              variant={directionQuickFilter === 'net_positive' ? 'default' : 'outline'}
              className="text-xs h-8 shrink-0 snap-start"
              onClick={() => setDirectionQuickFilter(f => f === 'net_positive' ? 'all' : 'net_positive')}
            >
              Difference +
            </Button>
            <Button
              size="sm"
              variant={directionQuickFilter === 'net_negative' ? 'default' : 'outline'}
              className="text-xs h-8 shrink-0 snap-start"
              onClick={() => setDirectionQuickFilter(f => f === 'net_negative' ? 'all' : 'net_negative')}
            >
              Difference −
            </Button>
            {topCategoryChips.map(cat => (
              <Button
                key={cat}
                size="sm"
                variant={categoryQuickFilter === cat ? 'default' : 'outline'}
                className="text-xs h-8 shrink-0 snap-start"
                onClick={() => setCategoryQuickFilter(f => f === cat ? null : cat)}
              >
                {prettifyCategory(cat)}
              </Button>
            ))}
            {(directionQuickFilter !== 'all' || categoryQuickFilter) && (
              <Button
                size="sm"
                variant="ghost"
                className="text-xs h-8 shrink-0 snap-start text-muted-foreground"
                onClick={() => { setDirectionQuickFilter('all'); setCategoryQuickFilter(null); }}
              >
                <X className="h-3 w-3 mr-1" /> Clear
              </Button>
            )}
          </div>
          {filteredAggregates.length !== aggregates.length && (
            <div className="text-[10px] text-muted-foreground px-1">
              Showing {filteredAggregates.length} of {aggregates.length} types
            </div>
          )}
        </div>
        )}

        {/* Capital Inflows callout — new money into the company. Hidden in Simple view. */}
        {!simpleMode && (
        <div id="cm-inflows" className="scroll-mt-24 rounded-lg border-2 border-primary/30 bg-primary/5 p-2.5 sm:p-3 space-y-2">
          <div className="flex items-center justify-between gap-2 flex-wrap">
            <div className="flex items-center gap-2">
              <ArrowUpRight className="h-4 w-4 text-primary" />
              <div>
                <div className="text-[10px] uppercase tracking-wider text-muted-foreground">New money coming into Welile</div>
                <div className="font-mono text-lg font-bold text-primary break-all">{formatUGX(capitalInflow.total)}</div>
                <div className="text-[10px] text-muted-foreground">
                  {capitalInflow.selected.length} type{capitalInflow.selected.length === 1 ? '' : 's'} ·
                  {' '}{capitalInflow.entries.toLocaleString()} transaction{capitalInflow.entries === 1 ? '' : 's'} · {rangeLabel} ·
                  {' '}grouped {(GRANULARITIES.find(g => g.value === granularity)?.label || granularity).toLowerCase()}
                </div>
                {includeWalletLegs && (
                  <div className="text-[10px] mt-1 flex flex-wrap gap-x-3 gap-y-0.5">
                    <span className="text-muted-foreground">Matching wallet activity:</span>
                    <span><span className="text-muted-foreground">in</span> <span className="font-mono text-emerald-500">+{formatUGX(capitalInflow.walletInTotal)}</span></span>
                    <span><span className="text-muted-foreground">out</span> <span className="font-mono text-rose-500">−{formatUGX(capitalInflow.walletOutTotal)}</span></span>
                    <span><span className="text-muted-foreground">net</span> <span className={cn('font-mono', capitalInflow.walletNetTotal >= 0 ? 'text-emerald-500' : 'text-rose-500')}>{capitalInflow.walletNetTotal >= 0 ? '+' : '−'}{formatUGX(Math.abs(capitalInflow.walletNetTotal))}</span></span>
                    <span className="text-muted-foreground">· {capitalInflow.walletEntries.toLocaleString()} moves</span>
                  </div>
                )}
              </div>
            </div>
            <div className="flex items-center gap-1.5 flex-wrap">
              <label
                className={cn(
                  'inline-flex items-center gap-1.5 rounded-md border px-2 h-7 text-[11px] cursor-pointer transition-colors',
                  includeWalletLegs ? 'border-primary/50 bg-primary/15 text-primary' : 'border-border bg-background hover:bg-muted/50',
                )}
                title="Off: only Welile's own books. On: also show what changed in agent/partner wallets at the same time."
              >
                <Checkbox
                  checked={includeWalletLegs}
                  onCheckedChange={(v) => setIncludeWalletLegs(!!v)}
                  className="h-3.5 w-3.5"
                />
                <span>Show wallet matches</span>
              </label>
              <Button
                size="sm"
                variant="outline"
                className="text-xs h-7 gap-1"
                disabled={!capitalInflow.selected.length}
                onClick={() => {
                  if (!canViewLedgerDetail) { toast.error('You do not have permission to export ledger data'); return; }
                  if (!capitalInflow.selected.length) { toast.error('No categories selected'); return; }
                  const headers = ['Category', 'Description', 'Cash In (UGX)', 'Entries', ...capitalInflow.bucketLabels];
                  const data = capitalInflow.selected.map(c => [
                    prettifyCategory(c.category),
                    CATEGORY_DESCRIPTIONS[c.category] || '',
                    c.total,
                    c.count,
                    ...capitalInflow.bucketLabels.map(b => c.buckets[b] || 0),
                  ]);
                  // Totals row
                  data.push([
                    'TOTAL',
                    `${capitalInflow.selected.length} categories · ${rangeLabel}`,
                    capitalInflow.total,
                    capitalInflow.entries,
                    ...capitalInflow.bucketLabels.map(b => capitalInflow.bucketTotals[b] || 0),
                  ]);
                  downloadCsv(
                    `welile-capital-inflows-${period}-${granularity}-${format(new Date(), 'yyyy-MM-dd')}.csv`,
                    headers,
                    data,
                  );
                  toast.success('Capital Inflows CSV downloaded');
                }}
                title="Download the new-money-in totals as a spreadsheet"
              >
                <FileSpreadsheet className="h-3 w-3" />
                Download
              </Button>
              <Collapsible open={capitalPickerOpen} onOpenChange={setCapitalPickerOpen}>
                <CollapsibleTrigger asChild>
                  <Button size="sm" variant="outline" className="text-xs h-7">
                    {capitalPickerOpen ? 'Hide' : 'Pick types'}
                  </Button>
                </CollapsibleTrigger>
              </Collapsible>
            </div>
          </div>

          {/* Selected category chips with per-category totals */}
          {capitalInflow.selected.length > 0 && (
            <TooltipProvider delayDuration={150}>
              <div className="flex flex-wrap gap-1.5">
                {capitalInflow.selected.map(c => (
                  <Tooltip key={c.category}>
                    <TooltipTrigger asChild>
                      <button
                        type="button"
                        onClick={() => setDrill({
                          category: c.category,
                          scope: 'platform',
                          bucket: null,
                          direction: 'cash_in',
                          dateFrom: capitalFrom || undefined,
                          dateTo: capitalTo || undefined,
                        })}
                        className="inline-flex items-center gap-1 rounded-full border border-border bg-background hover:bg-primary/10 hover:border-primary/40 px-2 py-0.5 text-[11px] font-normal transition-colors"
                      >
                        <span className="font-medium">{prettifyCategory(c.category)}</span>
                        <span className="font-mono text-primary">{formatUGX(c.total)}</span>
                        <span className="text-muted-foreground">({c.count})</span>
                        {includeWalletLegs && (c.walletIn > 0 || c.walletOut > 0) && (
                          <span className="ml-1 inline-flex items-center gap-0.5 rounded bg-muted/60 px-1 text-[10px]">
                            <span className="text-muted-foreground">w:</span>
                            <span className="font-mono text-emerald-500">+{formatUGX(c.walletIn)}</span>
                            <span className="text-muted-foreground">/</span>
                            <span className="font-mono text-rose-500">−{formatUGX(c.walletOut)}</span>
                          </span>
                        )}
                        <Info className="h-3 w-3 text-muted-foreground" />
                        <ExternalLink className="h-3 w-3 text-muted-foreground" />
                      </button>
                    </TooltipTrigger>
                    <TooltipContent side="top" align="start" className="bg-popover border-border">
                      <WalletImpactTooltipContent category={c.category} />
                      <div className="mt-2 pt-1 border-t border-border text-[10px] text-muted-foreground">
                        Click to drill into Platform cash_in entries{capitalRangeActive ? ` · ${capitalFrom || '…'} → ${capitalTo || '…'}` : ''}
                      </div>
                    </TooltipContent>
                  </Tooltip>
                ))}
              </div>
            </TooltipProvider>
          )}

          {/* Per-bucket strip — synced to current granularity */}
          {capitalInflow.selected.length > 0 && capitalInflow.bucketLabels.length > 0 && (
            <div className="pt-2 border-t border-primary/20 space-y-1">
              <div className="text-[10px] uppercase tracking-wider text-muted-foreground flex items-center justify-between">
                <span>By {(GRANULARITIES.find(g => g.value === granularity)?.label || granularity).toLowerCase()}</span>
                {capitalInflow.peakBucket && (
                  <span>Best day: <span className="text-primary font-mono">{capitalInflow.peakBucket}</span> · {formatUGX(capitalInflow.bucketTotals[capitalInflow.peakBucket] || 0)}</span>
                )}
              </div>
              <div className="flex flex-wrap gap-1">
                {capitalInflow.bucketLabels.map(b => {
                  const val = capitalInflow.bucketTotals[b] || 0;
                  const isPeak = b === capitalInflow.peakBucket && val > 0;
                  return (
                    <div
                      key={b}
                      className={cn(
                        'rounded border px-1.5 py-0.5 text-[10px] font-mono',
                        val === 0
                          ? 'border-border bg-background text-muted-foreground/60'
                          : isPeak
                            ? 'border-primary/50 bg-primary/15 text-primary font-semibold'
                            : 'border-primary/20 bg-background text-foreground',
                      )}
                      title={`${b}: ${formatUGX(val)}`}
                    >
                      <span className="text-muted-foreground mr-1">{b}</span>
                      {val > 0 ? formatUGX(val) : '·'}
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          <Collapsible open={capitalPickerOpen} onOpenChange={setCapitalPickerOpen}>
            <CollapsibleContent className="space-y-2 pt-2 border-t border-primary/20">
              {/* Date sub-range filter — scopes Capital Inflows totals & drill-downs */}
              <div className="flex flex-wrap items-end gap-2 rounded-md border border-primary/20 bg-background/60 p-2">
                <div className="flex flex-col gap-0.5">
                  <label className="text-[10px] uppercase tracking-wider text-muted-foreground">From</label>
                  <Input
                    type="date"
                    value={capitalFrom}
                    max={capitalTo || undefined}
                    onChange={(e) => setCapitalFrom(e.target.value)}
                    className="h-7 text-[11px] w-[140px]"
                  />
                </div>
                <div className="flex flex-col gap-0.5">
                  <label className="text-[10px] uppercase tracking-wider text-muted-foreground">To</label>
                  <Input
                    type="date"
                    value={capitalTo}
                    min={capitalFrom || undefined}
                    onChange={(e) => setCapitalTo(e.target.value)}
                    className="h-7 text-[11px] w-[140px]"
                  />
                </div>
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-7 text-[11px] gap-1"
                  disabled={!capitalRangeActive}
                  onClick={() => { setCapitalFrom(''); setCapitalTo(''); }}
                  title="Clear sub-range and use the full loaded period"
                >
                  <X className="h-3 w-3" />
                  Clear
                </Button>
                <span className="text-[10px] text-muted-foreground ml-auto">
                  {capitalRangeActive
                    ? <>Filter active · totals & drill-downs scoped to <span className="font-mono text-primary">{capitalFrom || '…'} → {capitalTo || '…'}</span></>
                    : <>No sub-range · using full period ({rangeLabel})</>}
                </span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-[11px] text-muted-foreground">
                  Tick the types of money you want to count above. We remember your choice on this device.
                </span>
                <div className="flex gap-1">
                  <Button size="sm" variant="ghost" className="h-6 text-[11px]"
                    onClick={() => setCapitalCategories(new Set(capitalInflow.availableCategories.map(c => c.category)))}>
                    All
                  </Button>
                  <Button size="sm" variant="ghost" className="h-6 text-[11px]"
                    onClick={() => setCapitalCategories(new Set())}>None</Button>
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-6 text-[11px] gap-1 border-primary/40 text-primary hover:bg-primary/10"
                    onClick={() => {
                      setCapitalCategories(new Set(CAPITAL_INFLOW_DEFAULT));
                      toast.success('Reset to default categories: ' + CAPITAL_INFLOW_DEFAULT.map(prettifyCategory).join(', '));
                    }}
                    title={`Reset to default selection (${CAPITAL_INFLOW_DEFAULT.map(prettifyCategory).join(' + ')})`}
                  >
                    <RefreshCw className="h-3 w-3" />
                    Reset
                  </Button>
                </div>
              </div>
              {capitalInflow.availableCategories.length === 0 ? (
                <p className="text-[11px] text-muted-foreground">No new money came in during this period.</p>
              ) : (
                <TooltipProvider delayDuration={150}>
                  <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-1.5 max-h-64 overflow-y-auto">
                    {capitalInflow.availableCategories.map(c => {
                      const checked = capitalCategories.has(c.category);
                      return (
                        <label key={c.category}
                          className={cn(
                            'flex items-center gap-2 rounded border px-2 py-1.5 text-[11px] cursor-pointer',
                            checked ? 'border-primary/40 bg-primary/10' : 'border-border bg-background hover:bg-muted/50',
                          )}>
                          <Checkbox checked={checked} onCheckedChange={(v) => {
                            setCapitalCategories(prev => {
                              const next = new Set(prev);
                              if (v) next.add(c.category); else next.delete(c.category);
                              return next;
                            });
                          }} />
                          <span className="flex-1 truncate">{prettifyCategory(c.category)}</span>
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <button type="button" onClick={(e) => e.preventDefault()} className="text-muted-foreground hover:text-primary">
                                <Info className="h-3 w-3" />
                              </button>
                            </TooltipTrigger>
                            <TooltipContent side="left" className="bg-popover border-border">
                              <WalletImpactTooltipContent category={c.category} />
                            </TooltipContent>
                          </Tooltip>
                          <span className="font-mono text-muted-foreground">{formatUGX(c.total)}</span>
                        </label>
                      );
                    })}
                  </div>
                </TooltipProvider>
              )}
            </CollapsibleContent>
          </Collapsible>
        </div>
        )}

        {/* Category table — full breakdown, hidden in Simple view. */}
        {!simpleMode && (loading ? (
          <div className="py-12 text-center text-muted-foreground text-sm">
            <Loader2 className="h-6 w-6 animate-spin mx-auto mb-2" /> Loading ledger…
          </div>
        ) : filteredAggregates.length === 0 ? (
          <div className="py-12 text-center text-muted-foreground text-sm">No money moved in this period.</div>
        ) : (
          <div id="cm-categories" className="scroll-mt-24 border border-border rounded-lg overflow-hidden">
          <HScrollHint
            className="overflow-x-auto overscroll-x-contain [-webkit-overflow-scrolling:touch]"
            ariaLabel="Categories breakdown — scroll sideways on small screens to see all columns"
          >
            <Table className="min-w-[640px]">
              <TableHeader className="sticky top-0 z-10 bg-background shadow-[0_1px_0_0_hsl(var(--border))]">
                <TableRow>
                  <TableHead {...focusableColHeadProps} className={cn('w-[40%] min-w-[180px]', FOCUSABLE_COL_HEAD_CLASS)}>What kind of money</TableHead>
                  <TableHead {...focusableColHeadProps} className={cn('min-w-[110px]', FOCUSABLE_COL_HEAD_CLASS)}>Where</TableHead>
                  <TableHead {...focusableColHeadProps} className={cn('text-right min-w-[90px]', FOCUSABLE_COL_HEAD_CLASS)}>In</TableHead>
                  <TableHead {...focusableColHeadProps} className={cn('text-right min-w-[90px]', FOCUSABLE_COL_HEAD_CLASS)}>Out</TableHead>
                  <TableHead {...focusableColHeadProps} className={cn('text-right min-w-[100px]', FOCUSABLE_COL_HEAD_CLASS)}>Difference</TableHead>
                  <TableHead {...focusableColHeadProps} className={cn('text-right min-w-[60px]', FOCUSABLE_COL_HEAD_CLASS)}>Count</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filteredAggregates.map(a => (
                  <TableRow
                    key={`${a.category}|${a.scope}`}
                    className={cn(canViewLedgerDetail ? 'cursor-pointer hover:bg-muted/60' : 'cursor-default')}
                    onClick={() => {
                      if (!canViewLedgerDetail) { toast.error('Ledger drill-down restricted to finance leadership'); return; }
                      setDrill({ category: a.category, scope: a.scope, bucket: null });
                    }}
                  >
                    <TableCell>
                      <div className="font-medium text-sm">{prettifyCategory(a.category)}</div>
                      <div className="text-[10px] text-muted-foreground font-mono">{a.category}</div>
                      {CATEGORY_DESCRIPTIONS[a.category] && (
                        <div className="text-[11px] text-muted-foreground mt-0.5 max-w-md">{CATEGORY_DESCRIPTIONS[a.category]}</div>
                      )}
                    </TableCell>
                    <TableCell>
                      <Badge variant="outline" className={cn('text-[10px]', SCOPE_BADGE[a.scope])}>
                        {SCOPE_LABEL[a.scope] || a.scope}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-right font-mono text-success text-sm">{a.cashIn ? formatUGX(a.cashIn) : '—'}</TableCell>
                    <TableCell className="text-right font-mono text-destructive text-sm">{a.cashOut ? `(${formatUGX(a.cashOut)})` : '—'}</TableCell>
                    <TableCell className={cn('text-right font-mono text-sm font-semibold', a.net >= 0 ? 'text-success' : 'text-destructive')}>
                      {a.net >= 0 ? '+' : ''}{formatUGX(a.net)}
                    </TableCell>
                    <TableCell className="text-right text-xs text-muted-foreground">{a.count}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </HScrollHint>
          </div>
        ))}

        {/* Time-series matrix — hidden in Simple view. */}
        {!simpleMode && filteredAggregates.length > 0 && bucketLabels.length > 0 && (
          <div className="space-y-2">
            <h4 className="text-xs font-semibold text-primary uppercase tracking-wider">{granularity === 'daily' ? 'Daily' : granularity === 'weekly' ? 'Weekly' : 'Monthly'} difference by type</h4>
            <p className="text-[11px] text-muted-foreground">Money In minus Money Out for each {granularity === 'daily' ? 'day' : granularity === 'weekly' ? 'week' : 'month'}. Swipe sideways to see more.</p>
            <div className="border border-border rounded-lg overflow-auto max-h-[480px]">
              <Table>
                <TableHeader className="sticky top-0 bg-background z-10">
                  <TableRow>
                    <TableHead {...focusableColHeadProps} className={cn('min-w-[160px] sticky left-0 bg-background z-20', FOCUSABLE_COL_HEAD_CLASS)}>Type · Where</TableHead>
                    {bucketLabels.map(b => (
                      <TableHead key={b} {...focusableColHeadProps} className={cn('text-right whitespace-nowrap text-[10px]', FOCUSABLE_COL_HEAD_CLASS)}>{b}</TableHead>
                    ))}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filteredAggregates.map(a => (
                    <TableRow key={`ts-${a.category}|${a.scope}`}>
                      <TableCell
                        className={cn('sticky left-0 bg-background z-10', canViewLedgerDetail && 'cursor-pointer hover:text-primary')}
                        onClick={() => {
                          if (!canViewLedgerDetail) { toast.error('Ledger drill-down restricted to finance leadership'); return; }
                          setDrill({ category: a.category, scope: a.scope, bucket: null });
                        }}
                      >
                        <div className="text-xs font-medium">{prettifyCategory(a.category)}</div>
                        <div className="text-[10px] text-muted-foreground">{SCOPE_LABEL[a.scope] || a.scope}</div>
                      </TableCell>
                      {bucketLabels.map(b => {
                        const c = a.buckets[b];
                        const net = (c?.in || 0) - (c?.out || 0);
                        if (!c || (c.in === 0 && c.out === 0)) return <TableCell key={b} className="text-right text-muted-foreground/40 text-xs">·</TableCell>;
                        return (
                          <TableCell
                            key={b}
                            onClick={() => {
                              if (!canViewLedgerDetail) { toast.error('Ledger drill-down restricted to finance leadership'); return; }
                              setDrill({ category: a.category, scope: a.scope, bucket: b });
                            }}
                            className={cn('text-right font-mono text-[11px] whitespace-nowrap', canViewLedgerDetail && 'cursor-pointer hover:bg-primary/10 hover:underline', net >= 0 ? 'text-success' : 'text-destructive')}
                          >
                            {net >= 0 ? '+' : ''}{formatUGX(net)}
                          </TableCell>
                        );
                      })}
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </div>
        )}

        {/* Drill-down sheet */}
        <Sheet open={!!drill} onOpenChange={(o) => { if (!o) setDrill(null); }}>
          <SheetContent side="right" className="w-full sm:max-w-3xl overflow-y-auto p-3 sm:p-5">
            {drill && (
              <>
                <SheetHeader className="space-y-1">
                  <SheetTitle className="text-base flex items-center gap-2 flex-wrap">
                    {prettifyCategory(drill.category)}
                    <Badge variant="outline" className={cn('text-[10px]', SCOPE_BADGE[drill.scope])}>
                      {SCOPE_LABEL[drill.scope] || drill.scope}
                    </Badge>
                    {drill.bucket && <Badge variant="secondary" className="text-[10px]">{drill.bucket}</Badge>}
                  </SheetTitle>
                  <SheetDescription className="text-xs">
                    {CATEGORY_DESCRIPTIONS[drill.category] || 'Every transaction of this type, one by one.'}
                  </SheetDescription>
                </SheetHeader>

                {/* Summary */}
                <div className="grid grid-cols-3 gap-1.5 sm:gap-2 mt-4">
                  {(() => {
                    const cIn  = filteredDrillRows.filter(r => r.direction === 'cash_in').reduce((s, r) => s + (Number(r.amount) || 0), 0);
                    const cOut = filteredDrillRows.filter(r => r.direction === 'cash_out').reduce((s, r) => s + (Number(r.amount) || 0), 0);
                    const net  = cIn - cOut;
                    return (
                      <>
                        <div className="rounded border border-border bg-success/5 p-2">
                          <div className="text-[10px] uppercase text-muted-foreground">In</div>
                          <div className="font-mono text-success text-xs sm:text-sm font-semibold break-all">{formatUGX(cIn)}</div>
                        </div>
                        <div className="rounded border border-border bg-destructive/5 p-2">
                          <div className="text-[10px] uppercase text-muted-foreground">Out</div>
                          <div className="font-mono text-destructive text-xs sm:text-sm font-semibold break-all">{formatUGX(cOut)}</div>
                        </div>
                        <div className={cn('rounded border border-border p-2', net >= 0 ? 'bg-success/5' : 'bg-destructive/5')}>
                          <div className="text-[10px] uppercase text-muted-foreground">Difference</div>
                          <div className={cn('font-mono text-xs sm:text-sm font-semibold break-all', net >= 0 ? 'text-success' : 'text-destructive')}>
                            {net >= 0 ? '+' : ''}{formatUGX(net)}
                          </div>
                        </div>
                      </>
                    );
                  })()}
                </div>

                <div className="flex items-center justify-between mt-4 mb-2 gap-2 flex-wrap">
                  <div className="text-[11px] text-muted-foreground">
                    Showing {filteredDrillRows.length.toLocaleString()} of {drillRows.length.toLocaleString()} transaction{drillRows.length === 1 ? '' : 's'}
                    {drillQuery && <span className="ml-1 text-primary">· searching "{drillQuery}"</span>}
                  </div>
                  <div className="flex items-center gap-2">
                    <Button size="sm" variant="outline" className="gap-2 text-xs h-7" onClick={handleExportDrill} disabled={filteredDrillRows.length === 0}>
                      <FileSpreadsheet className="h-3.5 w-3.5" /> CSV
                    </Button>
                    <Button size="sm" variant="outline" className="gap-2 text-xs h-7" onClick={handleExportDrillPdf} disabled={filteredDrillRows.length === 0}>
                      <FileText className="h-3.5 w-3.5" /> PDF
                    </Button>
                  </div>
                </div>

                <div className="relative mb-2">
                  <Input
                    value={drillQuery}
                    onChange={(e) => setDrillQuery(e.target.value)}
                    placeholder="Search by name, reference, or transaction ID…"
                    className="h-8 text-xs pr-8"
                  />
                  {drillQuery && (
                    <button
                      type="button"
                      onClick={() => setDrillQuery('')}
                      aria-label="Clear search"
                      className="absolute right-1.5 top-1/2 -translate-y-1/2 p-1 rounded text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
                    >
                      <X className="h-3.5 w-3.5" />
                    </button>
                  )}
                </div>

                {/* Date filter chips — narrow drill-down by recent window or custom range */}
                <div className="flex flex-wrap items-center gap-1.5 mb-2">
                  <span className="text-[10px] uppercase tracking-wide text-muted-foreground mr-1">Date</span>
                  {([
                    { v: 'inherit', label: 'All' },
                    { v: '1d', label: 'Today' },
                    { v: '2d', label: '2d' },
                    { v: '3d', label: '3d' },
                    { v: '5d', label: '5d' },
                    { v: '7d', label: '7d' },
                    { v: '30d', label: '30d' },
                    { v: 'custom', label: 'Custom' },
                  ] as { v: DrillDatePreset; label: string }[]).map(opt => (
                    <button
                      key={opt.v}
                      type="button"
                      onClick={() => setDrillDatePreset(opt.v)}
                      className={cn(
                        'rounded-full border px-2 py-0.5 text-[11px] transition-colors',
                        drillDatePreset === opt.v
                          ? 'bg-primary text-primary-foreground border-primary'
                          : 'bg-background border-border hover:bg-muted'
                      )}
                    >
                      {opt.label}
                    </button>
                  ))}
                  {drillDatePreset === 'custom' && (
                    <div className="flex items-center gap-1 ml-1">
                      <Input
                        type="date"
                        value={drillCustomFrom}
                        onChange={(e) => setDrillCustomFrom(e.target.value)}
                        className="h-7 text-[11px] w-[130px]"
                      />
                      <span className="text-[11px] text-muted-foreground">→</span>
                      <Input
                        type="date"
                        value={drillCustomTo}
                        onChange={(e) => setDrillCustomTo(e.target.value)}
                        className="h-7 text-[11px] w-[130px]"
                      />
                    </div>
                  )}
                  {drillDatePreset !== 'inherit' && (effectiveDrillRange.from || effectiveDrillRange.to) && (
                    <span className="text-[10px] text-muted-foreground ml-1 font-mono">
                      {effectiveDrillRange.from || '…'} → {effectiveDrillRange.to || '…'}
                    </span>
                  )}
                </div>

                {filteredDrillRows.length === 0 ? (
                  <div className="py-12 px-4 text-center space-y-3 border border-dashed border-border rounded-lg bg-muted/10">
                    <div className="mx-auto h-9 w-9 rounded-full bg-muted flex items-center justify-center">
                      {drillQuery ? <Search className="h-4 w-4 text-muted-foreground" /> : <Filter className="h-4 w-4 text-muted-foreground" />}
                    </div>
                    <div className="text-sm font-semibold text-foreground">
                      {drillQuery ? 'No matches for your search' : 'Nothing to show here'}
                    </div>
                    <p className="text-xs text-muted-foreground max-w-sm mx-auto leading-relaxed">
                      {drillQuery
                        ? `Try a different reference, party, or amount — or clear the search to see all ${drillRows.length.toLocaleString()} entries.`
                        : 'There are no ledger entries for this category and date range. Try a wider drill date range above.'}
                    </p>
                    {drillQuery && (
                      <Button size="sm" variant="outline" className="h-8 text-xs" onClick={() => setDrillQuery('')}>
                        <X className="h-3.5 w-3.5 mr-1" /> Clear search
                      </Button>
                    )}
                  </div>
                ) : (
                  <div className="border border-border rounded-lg">
                    {/* Mobile: tappable card list (compact, no horizontal scroll) */}
                    <div className="block sm:hidden space-y-2 p-2">
                      {filteredDrillRows
                        .slice(drillPage * drillPageSize, drillPage * drillPageSize + drillPageSize)
                        .map((r, i) => {
                          const amt = Number(r.amount) || 0;
                          const isIn = r.direction === 'cash_in';
                          const name = r.user_id ? partyNames[r.user_id] : null;
                          const cardKey = r.id || `${r.reference_id}-${i}`;
                          const isExpanded = expandedCards.has(cardKey);
                          return (
                            <button
                              key={cardKey}
                              type="button"
                              onClick={() => {
                                setExpandedCards(prev => {
                                  const next = new Set(prev);
                                  if (next.has(cardKey)) next.delete(cardKey);
                                  else next.add(cardKey);
                                  return next;
                                });
                              }}
                              className="w-full text-left rounded-lg border border-border bg-card p-3 space-y-1.5 active:bg-muted/40 transition-colors"
                            >
                              <div className="flex items-center justify-between gap-2">
                                <div className="text-[11px] text-muted-foreground">{format(new Date(r.transaction_date), 'dd MMM yyyy · HH:mm')}</div>
                                <div className="flex items-center gap-1.5">
                                  <div className={cn('font-mono text-sm font-semibold', isIn ? 'text-success' : 'text-destructive')}>
                                    {isIn ? '+' : '−'}{formatUGX(amt)}
                                  </div>
                                  {isExpanded ? <ChevronUp className="h-3.5 w-3.5 text-muted-foreground" /> : <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />}
                                </div>
                              </div>
                              <div className="font-mono text-[11px]">
                                {r.id && canViewLedgerDetail ? (
                                  <Link
                                    to={`/cfo/ledger/${r.id}`}
                                    target="_blank"
                                    rel="noopener"
                                    onClick={(e) => e.stopPropagation()}
                                    className="text-primary hover:underline inline-flex items-center gap-1"
                                  >
                                    <Highlight text={r.reference_id || r.id.slice(0, 8) + '…'} query={debouncedDrillQuery} />
                                    <ExternalLink className="h-2.5 w-2.5" />
                                  </Link>
                                ) : (
                                  <Highlight text={r.reference_id || '—'} query={debouncedDrillQuery} />
                                )}
                              </div>
                              <div className="text-[11px]">
                                <Highlight text={name || (r.linked_party ? prettifyCategory(r.linked_party) : '—')} query={debouncedDrillQuery} />
                                {r.user_id && <span className="text-muted-foreground font-mono text-[10px] ml-1">· <Highlight text={r.user_id.slice(0, 8) + '…'} query={debouncedDrillQuery} /></span>}
                              </div>

                              {/* Expanded details */}
                              {isExpanded && (
                                <div className="pt-2 mt-1 border-t border-border space-y-1.5 animate-in fade-in slide-in-from-top-1 duration-200">
                                  <div className="flex items-center gap-2">
                                    <span className="text-[10px] uppercase tracking-wider text-muted-foreground w-16 shrink-0">Type</span>
                                    <span className="text-[11px] font-medium">{prettifyCategory(r.category)}</span>
                                  </div>
                                  <div className="flex items-center gap-2">
                                    <span className="text-[10px] uppercase tracking-wider text-muted-foreground w-16 shrink-0">Direction</span>
                                    <span className={cn('text-[11px] font-medium inline-flex items-center gap-1', isIn ? 'text-success' : 'text-destructive')}>
                                      {isIn ? <ArrowDownLeft className="h-3 w-3" /> : <ArrowUpRight className="h-3 w-3" />}
                                      {isIn ? 'Money In' : 'Money Out'}
                                    </span>
                                  </div>
                                  {r.description && (
                                    <div className="flex items-start gap-2">
                                      <span className="text-[10px] uppercase tracking-wider text-muted-foreground w-16 shrink-0 pt-0.5">Notes</span>
                                      <span className="text-[11px] text-muted-foreground leading-snug"><Highlight text={r.description} query={debouncedDrillQuery} /></span>
                                    </div>
                                  )}
                                  {r.transaction_group_id && (
                                    <div className="flex items-center gap-2">
                                      <span className="text-[10px] uppercase tracking-wider text-muted-foreground w-16 shrink-0">Group</span>
                                      <span className="text-[10px] font-mono text-muted-foreground">{r.transaction_group_id}</span>
                                    </div>
                                  )}
                                  {r.classification && r.classification !== 'production' && (
                                    <div className="flex items-center gap-2">
                                      <span className="text-[10px] uppercase tracking-wider text-muted-foreground w-16 shrink-0">Tag</span>
                                      <Badge variant="outline" className="text-[9px]">{r.classification}</Badge>
                                    </div>
                                  )}
                                  {r.source_table && (
                                    <div className="flex items-center gap-2">
                                      <span className="text-[10px] uppercase tracking-wider text-muted-foreground w-16 shrink-0">Source</span>
                                      <span className="text-[10px] text-muted-foreground">
                                        <Highlight text={r.source_table} query={debouncedDrillQuery} />
                                        {r.source_id && <>:<Highlight text={r.source_id} query={debouncedDrillQuery} /></>}
                                      </span>
                                    </div>
                                  )}
                                </div>
                              )}
                            </button>
                          );
                        })}
                    </div>
                    {/* Mobile hint: full-detail table is also available below via horizontal scroll */}
                    <div className="hidden">{/* legacy spacer removed */}</div>
                    <HScrollHint
                      className="overflow-x-auto overscroll-x-contain [-webkit-overflow-scrolling:touch] hidden sm:block"
                      ariaLabel="Transactions table — scroll sideways to see all columns"
                    >
                      <Table className="min-w-[720px]">
                      <TableHeader className="sticky top-0 z-10 bg-background shadow-[0_1px_0_0_hsl(var(--border))]">
                        <TableRow>
                          <TableHead {...focusableColHeadProps} className={cn('text-xs min-w-[120px]', FOCUSABLE_COL_HEAD_CLASS)}>Date</TableHead>
                          <TableHead {...focusableColHeadProps} className={cn('text-xs min-w-[200px]', FOCUSABLE_COL_HEAD_CLASS)}>Reference</TableHead>
                          <TableHead {...focusableColHeadProps} className={cn('text-xs min-w-[180px]', FOCUSABLE_COL_HEAD_CLASS)}>Who</TableHead>
                          <TableHead {...focusableColHeadProps} className={cn('text-xs text-right min-w-[120px]', FOCUSABLE_COL_HEAD_CLASS)}>Amount</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {filteredDrillRows
                          .slice(drillPage * drillPageSize, drillPage * drillPageSize + drillPageSize)
                          .map((r, i) => {
                          const amt = Number(r.amount) || 0;
                          const isIn = r.direction === 'cash_in';
                          const name = r.user_id ? partyNames[r.user_id] : null;
                          return (
                            <TableRow key={r.id || `${r.reference_id}-${i}`} className="group">
                              <TableCell className="text-[11px] whitespace-nowrap align-top">
                                <div>{format(new Date(r.transaction_date), 'dd MMM yyyy')}</div>
                                <div className="text-muted-foreground">{format(new Date(r.transaction_date), 'HH:mm:ss')}</div>
                              </TableCell>
                              <TableCell className="text-[11px] align-top">
                                <div className="font-mono flex items-center gap-1">
                                  {r.id && canViewLedgerDetail ? (
                                    <Link
                                      to={`/cfo/ledger/${r.id}`}
                                      target="_blank"
                                      rel="noopener"
                                      className="text-primary hover:underline inline-flex items-center gap-1"
                                      title="Open ledger entry detail in new tab"
                                    >
                                      <Highlight text={r.reference_id || (r.id.slice(0, 8) + '…')} query={debouncedDrillQuery} />
                                      <ExternalLink className="h-2.5 w-2.5 opacity-60 group-hover:opacity-100" />
                                    </Link>
                                  ) : (
                                    <Highlight text={r.reference_id || '—'} query={debouncedDrillQuery} />
                                  )}
                                </div>
                                {r.transaction_group_id && (
                                  <div className="text-[10px] text-muted-foreground font-mono">
                                    grp: <Highlight text={r.transaction_group_id} query={debouncedDrillQuery} />
                                  </div>
                                )}
                                {r.source_table && (
                                  <div className="text-[10px] text-muted-foreground">
                                    <Highlight text={r.source_table} query={debouncedDrillQuery} />
                                    {r.source_id && (
                                      <>:<Highlight text={r.source_id} query={debouncedDrillQuery} /></>
                                    )}
                                  </div>
                                )}
                                {r.description && (
                                  <div className="text-[10px] text-muted-foreground mt-0.5 line-clamp-2 max-w-[260px]">
                                    <Highlight text={r.description} query={debouncedDrillQuery} />
                                  </div>
                                )}
                                {r.classification && r.classification !== 'production' && (
                                  <Badge variant="outline" className="text-[9px] mt-0.5">{r.classification}</Badge>
                                )}
                              </TableCell>
                              <TableCell className="text-[11px] align-top">
                                <div>
                                  <Highlight
                                    text={name || (r.linked_party ? prettifyCategory(r.linked_party) : '—')}
                                    query={debouncedDrillQuery}
                                  />
                                </div>
                                {r.user_id && (
                                  <div className="text-[10px] text-muted-foreground font-mono">
                                    <Highlight text={r.user_id} query={debouncedDrillQuery} />
                                  </div>
                                )}
                              </TableCell>
                              <TableCell className={cn('text-right font-mono text-xs whitespace-nowrap align-top font-semibold', isIn ? 'text-success' : 'text-destructive')}>
                                {isIn ? '+' : '−'}{formatUGX(amt)}
                              </TableCell>
                            </TableRow>
                          );
                        })}
                      </TableBody>
                    </Table>
                    </HScrollHint>
                    {(() => {
                      const total = filteredDrillRows.length;
                      const totalPages = Math.max(1, Math.ceil(total / drillPageSize));
                      const page = Math.min(drillPage, totalPages - 1);
                      const start = page * drillPageSize;
                      const end = Math.min(start + drillPageSize, total);
                      return (
                        <div className="flex items-center justify-between gap-2 py-2 px-3 border-t border-border bg-muted/20">
                          <div className="text-[10px] text-muted-foreground">
                            Showing <span className="font-mono">{(start + 1).toLocaleString()}–{end.toLocaleString()}</span> of <span className="font-mono">{total.toLocaleString()}</span>
                          </div>
                          <div className="flex items-center gap-1">
                            <span className="text-[10px] text-muted-foreground mr-1">Per page:</span>
                            {[50, 100, 250, 500].map(size => (
                              <Button key={size} size="sm" variant={drillPageSize === size ? 'default' : 'outline'}
                                className="h-6 px-2 text-[10px]" onClick={() => setDrillPageSize(size)}>
                                {size}
                              </Button>
                            ))}
                            <Button size="sm" variant="outline" className="h-6 px-2 text-[10px] ml-2"
                              disabled={page === 0} onClick={() => setDrillPage(0)}>« First</Button>
                            <Button size="sm" variant="outline" className="h-6 px-2 text-[10px]"
                              disabled={page === 0} onClick={() => setDrillPage(p => Math.max(0, p - 1))}>‹ Prev</Button>
                            <span className="text-[10px] text-muted-foreground px-1 font-mono">{page + 1} / {totalPages}</span>
                            <Button size="sm" variant="outline" className="h-6 px-2 text-[10px]"
                              disabled={page >= totalPages - 1} onClick={() => setDrillPage(p => Math.min(totalPages - 1, p + 1))}>Next ›</Button>
                            <Button size="sm" variant="outline" className="h-6 px-2 text-[10px]"
                              disabled={page >= totalPages - 1} onClick={() => setDrillPage(totalPages - 1)}>Last »</Button>
                          </div>
                        </div>
                      );
                    })()}
                  </div>
                )}
              </>
            )}
          </SheetContent>
        </Sheet>

        {/* ─── Date picker sheet (thumb-friendly) ─── */}
        <Sheet open={dateSheetOpen} onOpenChange={setDateSheetOpen}>
          <SheetContent side="bottom" className="max-h-[85vh] overflow-y-auto rounded-t-2xl">
            <SheetHeader className="text-left">
              <SheetTitle className="flex items-center gap-2"><Calendar className="h-4 w-4" /> Pick a date range</SheetTitle>
              <SheetDescription className="text-xs">
                Currently showing: <span className="font-semibold">{rangeLabel}</span>
              </SheetDescription>
            </SheetHeader>
            <div className="mt-4 grid grid-cols-2 gap-2 pb-4">
              {PERIODS.map(p => {
                const selected = period === p.value;
                return (
                  <button
                    key={p.value}
                    type="button"
                    onClick={() => { setPeriod(p.value); setDateSheetOpen(false); }}
                    className={cn(
                      'min-h-[56px] rounded-xl border-2 px-3 py-2 text-left flex items-center justify-between gap-2 transition-colors active:scale-[0.98]',
                      selected ? 'border-primary bg-primary/10' : 'border-border hover:bg-muted/60',
                    )}
                  >
                    <span className="text-sm font-semibold">{p.label}</span>
                    {selected && <Check className="h-4 w-4 text-primary shrink-0" />}
                  </button>
                );
              })}
            </div>
          </SheetContent>
        </Sheet>

        {/* ─── Direction picker sheet (thumb-friendly) ─── */}
        <Sheet open={directionSheetOpen} onOpenChange={setDirectionSheetOpen}>
          <SheetContent side="bottom" className="max-h-[85vh] overflow-y-auto rounded-t-2xl">
            <SheetHeader className="text-left">
              <SheetTitle className="flex items-center gap-2"><ArrowLeftRight className="h-4 w-4" /> Show which direction?</SheetTitle>
              <SheetDescription className="text-xs">Narrow the page to money coming in, going out, or both.</SheetDescription>
            </SheetHeader>
            <div className="mt-4 grid grid-cols-1 gap-2 pb-4">
              {([
                { v: 'all',           label: 'In + Out',      hint: 'Everything (default)',                icon: <ArrowLeftRight className="h-5 w-5" /> },
                { v: 'cash_in',       label: 'Money In only', hint: 'Cash that came into Welile',         icon: <ArrowUpRight className="h-5 w-5 text-success" /> },
                { v: 'cash_out',      label: 'Money Out only',hint: 'Cash that left Welile',              icon: <ArrowDownRight className="h-5 w-5 text-destructive" /> },
                { v: 'net_positive',  label: 'Net positive',  hint: 'Categories where In beat Out',       icon: <ArrowUpRight className="h-5 w-5 text-success" /> },
                { v: 'net_negative',  label: 'Net negative',  hint: 'Categories where Out beat In',       icon: <ArrowDownRight className="h-5 w-5 text-destructive" /> },
              ] as const).map(opt => {
                const selected = directionQuickFilter === opt.v;
                return (
                  <button
                    key={opt.v}
                    type="button"
                    onClick={() => { setDirectionQuickFilter(opt.v); setDirectionSheetOpen(false); }}
                    className={cn(
                      'min-h-[60px] rounded-xl border-2 px-3 py-2 text-left flex items-center gap-3 transition-colors active:scale-[0.98]',
                      selected ? 'border-primary bg-primary/10' : 'border-border hover:bg-muted/60',
                    )}
                  >
                    {opt.icon}
                    <div className="flex-1 min-w-0">
                      <div className="text-sm font-semibold">{opt.label}</div>
                      <div className="text-[11px] text-muted-foreground">{opt.hint}</div>
                    </div>
                    {selected && <Check className="h-4 w-4 text-primary shrink-0" />}
                  </button>
                );
              })}
            </div>
          </SheetContent>
        </Sheet>

        {/* ─── Party picker sheet (thumb-friendly) ─── */}
        <Sheet open={partySheetOpen} onOpenChange={(o) => { setPartySheetOpen(o); if (!o) setPartySearch(''); }}>
          <SheetContent side="bottom" className="max-h-[85vh] overflow-y-auto rounded-t-2xl">
            <SheetHeader className="text-left">
              <SheetTitle className="flex items-center gap-2"><Users className="h-4 w-4" /> Pick a party</SheetTitle>
              <SheetDescription className="text-xs">
                Filter the page to a single counterparty. {topParties.length.toLocaleString()} found in this period.
              </SheetDescription>
            </SheetHeader>
            <div className="mt-3 sticky top-0 bg-background pb-2 z-10">
              <Input
                value={partySearch}
                onChange={(e) => setPartySearch(e.target.value)}
                placeholder="Search name or user id…"
                className="h-11 text-sm"
                inputMode="search"
              />
            </div>
            <div className="grid grid-cols-1 gap-2 pb-4">
              <button
                type="button"
                onClick={() => { setPartyQuickFilter(null); setPartySheetOpen(false); }}
                className={cn(
                  'min-h-[56px] rounded-xl border-2 px-3 py-2 text-left flex items-center justify-between gap-2 transition-colors active:scale-[0.98]',
                  !partyQuickFilter ? 'border-primary bg-primary/10' : 'border-border hover:bg-muted/60',
                )}
              >
                <div>
                  <div className="text-sm font-semibold">Everyone</div>
                  <div className="text-[11px] text-muted-foreground">Show all parties (no filter)</div>
                </div>
                {!partyQuickFilter && <Check className="h-4 w-4 text-primary shrink-0" />}
              </button>
              {topParties
                .filter(p => {
                  const q = partySearch.trim().toLowerCase();
                  if (!q) return true;
                  const name = (partyNames[p.id] || '').toLowerCase();
                  return name.includes(q) || p.id.toLowerCase().includes(q);
                })
                .slice(0, 80)
                .map(p => {
                  const selected = partyQuickFilter === p.id;
                  const name = partyNames[p.id] || `${p.id.slice(0, 8)}…`;
                  return (
                    <button
                      key={p.id}
                      type="button"
                      onClick={() => { setPartyQuickFilter(p.id); setPartySheetOpen(false); }}
                      className={cn(
                        'min-h-[60px] rounded-xl border-2 px-3 py-2 text-left flex items-center gap-2 transition-colors active:scale-[0.98]',
                        selected ? 'border-primary bg-primary/10' : 'border-border hover:bg-muted/60',
                      )}
                    >
                      <div className="flex-1 min-w-0">
                        <div className="text-sm font-semibold truncate">{name}</div>
                        <div className="text-[11px] text-muted-foreground flex flex-wrap gap-x-2">
                          <span className="text-success">In {formatUGX(p.cashIn)}</span>
                          <span className="text-destructive">Out {formatUGX(p.cashOut)}</span>
                          <span>· {p.count} tx</span>
                        </div>
                      </div>
                      {selected && <Check className="h-4 w-4 text-primary shrink-0" />}
                    </button>
                  );
                })}
              {topParties.length === 0 && (
                <div className="text-xs text-muted-foreground text-center py-6">
                  No parties in this period. Try a wider date range.
                </div>
              )}
            </div>
          </SheetContent>
        </Sheet>

        {/* ─── Mobile sticky bottom action bar ──────────────────────
            Keeps the two most-reached actions — Reset filters and the
            Simple/Detailed view toggle — within thumb's reach at the
            bottom of the viewport on phones. Hidden on sm+ where the
            in-flow header controls are already visible. */}
        {(() => {
          const hasActiveFilters =
            !!categoryQuickFilter ||
            topCategoriesLimit !== 5 ||
            directionQuickFilter !== 'all' ||
            !!partyQuickFilter ||
            !!pageSearch ||
            scopeFilter !== 'all';
          return (
            <>
              {/* Spacer so the last bit of content isn't covered by the bar */}
              <div className="h-20 sm:hidden" aria-hidden="true" />
              <div
                className={cn(
                  'sm:hidden fixed inset-x-0 bottom-0 z-40',
                  'bg-card/95 backdrop-blur border-t border-border',
                  'px-3 pt-2 pb-[max(env(safe-area-inset-bottom),0.5rem)]',
                )}
                role="toolbar"
                aria-label="Cash movement quick actions"
              >
                <div className="flex items-center gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="flex-1 h-11 gap-2"
                    onClick={() => {
                      setCategoryQuickFilter(null);
                      setTopCategoriesLimit(5);
                      setDirectionQuickFilter('all');
                      setPartyQuickFilter(null);
                      setPageSearch('');
                      setScopeFilter('all');
                    }}
                    disabled={!hasActiveFilters}
                    aria-label="Reset all filters back to defaults"
                  >
                    <X className="h-4 w-4" />
                    Reset filters
                  </Button>
                  <Button
                    type="button"
                    variant={simpleMode ? 'default' : 'secondary'}
                    size="sm"
                    className="flex-1 h-11 gap-2"
                    onClick={() => setSimpleMode(v => !v)}
                    aria-pressed={simpleMode}
                    aria-label={simpleMode ? 'Switch to detailed view' : 'Switch to simple view'}
                  >
                    {simpleMode ? 'Simple view' : 'Detailed view'}
                  </Button>
                </div>
              </div>
            </>
          );
        })()}
      </CardContent>
    </Card>
  );
}

// ─────────────────────────────────────────────────────────────
// WalletMovementSummary
// Minimalist breakdown of money INTO and OUT OF wallets for the
// currently loaded period. Pure read view — never mutates anything.
// ─────────────────────────────────────────────────────────────
// ─────────────────────────────────────────────────────────────
// Read-only ledger client — safety guard
// ─────────────────────────────────────────────────────────────
// The bucket-flow panel and its prior-period loader MUST be a pure
// read view: they may never change wallet balances, call RPCs, or
// write to ledger / wallet tables. This Proxy wraps the Supabase
// query builder and throws if any mutating method is invoked. It is
// the only Supabase entry point used by WalletMovementSummary.
const WALLET_PANEL_FORBIDDEN_METHODS = new Set([
  'insert', 'update', 'delete', 'upsert', 'rpc',
]);
function readOnlyLedger() {
  const builder = supabase.from('general_ledger');
  const guard: ProxyHandler<typeof builder> = {
    get(target, prop, receiver) {
      if (typeof prop === 'string' && WALLET_PANEL_FORBIDDEN_METHODS.has(prop)) {
        throw new Error(
          `[WalletMovementSummary] forbidden mutation '${prop}' attempted — bucket flow panel must remain read-only`
        );
      }
      const value = Reflect.get(target, prop, receiver);
      // Re-wrap chainable builder methods so the guard survives the chain.
      if (typeof value === 'function') {
        return (...args: unknown[]) => {
          const out = (value as (...a: unknown[]) => unknown).apply(target, args);
          return out && typeof out === 'object' && 'then' in (out as object) === false
            ? new Proxy(out as typeof builder, guard)
            : out;
        };
      }
      return value;
    },
  };
  return new Proxy(builder, guard);
}

function WalletMovementSummary({
  rows,
  includeAdjustments,
  period,
}: {
  rows: LedgerRow[];
  includeAdjustments: boolean;
  period: PeriodKey;
}) {
  // Tracks which (direction|category) rows are expanded to reveal underlying
  // ledger transactions for the currently loaded period.
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const toggleExpanded = (key: string) =>
    setExpanded(prev => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });

  // Net-flow KPI drill-down — opens a sheet listing every wallet-scope
  // cash_in / cash_out transaction that makes up Into − Out for the period.
  const [netDrill, setNetDrill] = useState<null | { direction: 'all' | 'cash_in' | 'cash_out'; from?: number; to?: number; label?: string; bucket?: 'withdrawable' | 'operational_float' | 'landlord_float' }>(null);
  const [netDrillQuery, setNetDrillQuery] = useState('');
  const [netDrillPage, setNetDrillPage] = useState(0);
  const NET_DRILL_PAGE_SIZE = 100;
  useEffect(() => {
    setNetDrillPage(0);
    setNetDrillQuery('');
  }, [netDrill?.direction, netDrill?.from, netDrill?.to, netDrill?.bucket]);

  const summary = useMemo(() => {
    // Clamp to the page's selected period so the totals here can never
    // include rows outside the visible date range (e.g. when the parent
    // over-fetches with only a lower bound).
    const { from, to } = periodRange(period);
    const fromTs = from ? from.getTime() : -Infinity;
    const toTs = to.getTime();
    const inMap = new Map<string, number>();
    const outMap = new Map<string, number>();
    let totalIn = 0;
    let totalOut = 0;
    for (const r of rows) {
      if (r.ledger_scope !== 'wallet') continue;
      if (!includeAdjustments && (r.classification === 'admin_correction' || r.category === 'system_balance_correction')) continue;
      const t = new Date(r.transaction_date).getTime();
      if (t < fromTs || t > toTs) continue;
      const amt = Number(r.amount) || 0;
      if (r.direction === 'cash_in') {
        inMap.set(r.category, (inMap.get(r.category) || 0) + amt);
        totalIn += amt;
      } else if (r.direction === 'cash_out') {
        outMap.set(r.category, (outMap.get(r.category) || 0) + amt);
        totalOut += amt;
      }
    }
    const sortDesc = (m: Map<string, number>) =>
      Array.from(m.entries())
        .filter(([, amt]) => amt > 0) // hide zero-total rows to keep the panel minimal
        .sort((a, b) => b[1] - a[1]);
    return {
      inRows: sortDesc(inMap),
      outRows: sortDesc(outMap),
      totalIn,
      totalOut,
      net: totalIn - totalOut,
    };
  }, [rows, includeAdjustments, period]);

  // ── Wallet-bucket breakdown ─────────────────────────────────
  // Classifies every wallet-scope ledger row into one of three buckets
  // (Withdrawable, Operational float, Landlord float) and tallies cash_in
  // / cash_out separately. Pure read-only aggregation — does not alter
  // any wallet figures or RPC behavior. The classifier is hoisted so the
  // drill-down filter can reuse it.
  const classifyBucket = useCallback((cat: string): 'withdrawable' | 'operational_float' | 'landlord_float' => {
    const c = (cat || '').toLowerCase();
    if (c.includes('landlord_float') || c.includes('landlord_payout')) return 'landlord_float';
    if (
      c.includes('agent_float') ||
      c.includes('partner_float') ||
      c.includes('float_topup') ||
      c.includes('float_swept') ||
      c.includes('proxy_float') ||
      c === 'rent_payment' ||
      c === 'rent_collection'
    ) return 'operational_float';
    return 'withdrawable';
  }, []);
  const bucketBreakdown = useMemo(() => {
    type BucketKey = 'withdrawable' | 'operational_float' | 'landlord_float';
    const buckets: Record<BucketKey, { in: number; out: number; inCount: number; outCount: number }> = {
      withdrawable: { in: 0, out: 0, inCount: 0, outCount: 0 },
      operational_float: { in: 0, out: 0, inCount: 0, outCount: 0 },
      landlord_float: { in: 0, out: 0, inCount: 0, outCount: 0 },
    };
    // Clamp to the same period window as the rest of the cash-movement page.
    const { from, to } = periodRange(period);
    const fromTs = from ? from.getTime() : -Infinity;
    const toTs = to.getTime();
    let scannedRows = 0;
    let walletScopeRows = 0;
    let adjustmentsSkipped = 0;
    let outOfWindow = 0;
    for (const r of rows) {
      scannedRows++;
      if (r.ledger_scope !== 'wallet') continue;
      walletScopeRows++;
      if (!includeAdjustments && (r.classification === 'admin_correction' || r.category === 'system_balance_correction')) {
        adjustmentsSkipped++;
        continue;
      }
      const t = new Date(r.transaction_date).getTime();
      if (t < fromTs || t > toTs) { outOfWindow++; continue; }
      const amt = Number(r.amount) || 0;
      if (amt <= 0) continue;
      const b = classifyBucket(r.category);
      if (r.direction === 'cash_in') { buckets[b].in += amt; buckets[b].inCount++; }
      else if (r.direction === 'cash_out') { buckets[b].out += amt; buckets[b].outCount++; }
    }
    return {
      ...buckets,
      meta: {
        from,
        to,
        scannedRows,
        walletScopeRows,
        adjustmentsSkipped,
        outOfWindow,
      },
    };
  }, [rows, includeAdjustments, classifyBucket, period]);

  // ── Previous-period comparison ──────────────────────────────
  // Computes a same-length window immediately preceding the current period and
  // pulls only wallet-scope ledger rows (small slice). "All time" has no prior
  // window so comparison is skipped.
  const priorRange = useMemo(() => {
    const cur = periodRange(period);
    if (!cur.from) return null;
    const lengthMs = cur.to.getTime() - cur.from.getTime();
    if (lengthMs <= 0) return null;
    const priorTo = cur.from;
    const priorFrom = new Date(cur.from.getTime() - lengthMs);
    return { from: priorFrom, to: priorTo };
  }, [period]);

  const [priorTotals, setPriorTotals] = useState<{
    inByCat: Map<string, number>;
    outByCat: Map<string, number>;
    totalIn: number;
    totalOut: number;
  } | null>(null);
  const [priorLoading, setPriorLoading] = useState(false);

  useEffect(() => {
    if (!priorRange) { setPriorTotals(null); return; }
    let cancelled = false;
    setPriorLoading(true);
    (async () => {
      try {
        // Server-side aggregate — this comparison only ever needed per-category
        // sums. Paging raw wallet-scope rows with deep OFFSETs timed out (HTTP 500).
        // Same dimensions, same client-side adjustment filter, identical totals.
        const inByCat = new Map<string, number>();
        const outByCat = new Map<string, number>();
        let totalIn = 0;
        let totalOut = 0;
        const { data, error } = await supabase.rpc('get_wallet_ledger_category_sums', {
          p_from: priorRange.from.toISOString(),
          p_to: priorRange.to.toISOString(),
        } as any);
        if (error) throw error;
        const groups = (data || []) as unknown as Array<{
          direction: string; category: string; classification: string; amount: number | string;
        }>;
        for (const r of groups) {
          if (!includeAdjustments && (r.classification === 'admin_correction' || r.category === 'system_balance_correction')) continue;
          const amt = Number(r.amount) || 0;
          if (r.direction === 'cash_in') {
            inByCat.set(r.category, (inByCat.get(r.category) || 0) + amt);
            totalIn += amt;
          } else if (r.direction === 'cash_out') {
            outByCat.set(r.category, (outByCat.get(r.category) || 0) + amt);
            totalOut += amt;
          }
        }
        if (!cancelled) setPriorTotals({ inByCat, outByCat, totalIn, totalOut });
      } catch (err) {
        console.error('[WalletMovementSummary] prior period load failed', err);
        if (!cancelled) setPriorTotals(null);
      } finally {
        if (!cancelled) setPriorLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [priorRange, includeAdjustments]);

  const formatDelta = (current: number, prior: number | undefined) => {
    if (prior === undefined) return null;
    const diff = current - prior;
    const absLabel = diff === 0
      ? ''
      : `${diff > 0 ? '+' : '−'}${formatUGX(Math.abs(diff))}`;
    if (prior === 0 && diff === 0) return { label: 'no change', absLabel: '', diff, tone: 'muted' as const, arrow: '·' };
    if (prior === 0) return { label: 'new', absLabel, diff, tone: 'pos' as const, arrow: '▲' };
    const pct = (diff / prior) * 100;
    const arrow = diff > 0 ? '▲' : diff < 0 ? '▼' : '·';
    const tone = diff > 0 ? 'pos' as const : diff < 0 ? 'neg' as const : 'muted' as const;
    return { label: `${arrow} ${Math.abs(pct).toFixed(0)}%`, absLabel, diff, tone, arrow };
  };
  const toneClass = (tone: 'pos' | 'neg' | 'muted', context: 'in' | 'out') => {
    // For inflows: up is good (success). For outflows: up is bad (destructive).
    if (tone === 'muted') return 'text-muted-foreground';
    if (context === 'in') return tone === 'pos' ? 'text-success' : 'text-destructive';
    return tone === 'pos' ? 'text-destructive' : 'text-success';
  };

  // Pre-bucket the underlying wallet-scope transactions per (direction|category)
  // so expanded rows render instantly without re-scanning the full ledger.
  const txByKey = useMemo(() => {
    const map = new Map<string, LedgerRow[]>();
    for (const r of rows) {
      if (r.ledger_scope !== 'wallet') continue;
      if (!includeAdjustments && (r.classification === 'admin_correction' || r.category === 'system_balance_correction')) continue;
      if (r.direction !== 'cash_in' && r.direction !== 'cash_out') continue;
      const key = `${r.direction}|${r.category}`;
      const list = map.get(key);
      if (list) list.push(r); else map.set(key, [r]);
    }
    // Newest first within each bucket.
    for (const list of map.values()) {
      list.sort((a, b) => new Date(b.transaction_date).getTime() - new Date(a.transaction_date).getTime());
    }
    return map;
  }, [rows, includeAdjustments]);

  const renderCategoryRow = (
    cat: string,
    amt: number,
    direction: 'cash_in' | 'cash_out',
  ) => {
    const key = `${direction}|${cat}`;
    const isOpen = expanded.has(key);
    const txs = txByKey.get(key) || [];
    const amountClass = direction === 'cash_in' ? 'text-success' : 'text-destructive';
    const priorAmt = priorTotals
      ? (direction === 'cash_in' ? priorTotals.inByCat.get(cat) : priorTotals.outByCat.get(cat))
      : undefined;
    const delta = priorTotals ? formatDelta(amt, priorAmt ?? 0) : null;
    const context = direction === 'cash_in' ? 'in' as const : 'out' as const;
    return (
      <div key={key} className="rounded border border-transparent hover:border-border/60">
        <button
          type="button"
          onClick={() => toggleExpanded(key)}
          aria-expanded={isOpen}
          className="w-full flex items-center justify-between gap-2 text-[12px] py-1 px-1 -mx-1 rounded hover:bg-muted/50 transition-colors text-left"
        >
          <span className="flex items-center gap-1 min-w-0">
            {isOpen
              ? <ChevronUp className="h-3 w-3 text-muted-foreground shrink-0" />
              : <ChevronDown className="h-3 w-3 text-muted-foreground shrink-0" />}
            <span className="text-muted-foreground truncate">{friendlyWalletLabel(cat, direction)}</span>
            <span className="text-[10px] text-muted-foreground/70 shrink-0">· {txs.length}</span>
          </span>
          <span className="flex items-center gap-1.5 shrink-0">
            {delta && (
              <span
                className={cn('flex items-center gap-1 text-[10px] font-mono', toneClass(delta.tone, context))}
                title={`Previous period: ${formatUGX(priorAmt ?? 0)}`}
              >
                {delta.absLabel && <span>{delta.absLabel}</span>}
                <span className="opacity-80">{delta.label}</span>
              </span>
            )}
            <span className={cn('font-mono', amountClass)}>{formatUGX(amt)}</span>
          </span>
        </button>
        {isOpen && (
          <div className="mt-1 mb-2 ml-4 border-l border-border/60 pl-2 space-y-1 max-h-72 overflow-y-auto">
            {txs.length === 0 && (
              <div className="text-[11px] text-muted-foreground italic">No transactions.</div>
            )}
            {txs.map((t, i) => (
              <div key={t.id || `${t.transaction_date}-${i}`} className="flex items-start justify-between gap-2 text-[11px]">
                <div className="min-w-0 flex-1">
                  <div className="text-foreground/80">
                    {format(new Date(t.transaction_date), 'dd MMM HH:mm')}
                    {t.linked_party && (
                      <span className="text-muted-foreground"> · {t.linked_party}</span>
                    )}
                  </div>
                  {t.description && (
                    <div className="text-muted-foreground truncate">{t.description}</div>
                  )}
                  {(t.reference_id || t.source_table) && (
                    <div className="text-[10px] text-muted-foreground/70 font-mono truncate">
                      {t.source_table && <span>{t.source_table}</span>}
                      {t.source_table && t.reference_id && <span> · </span>}
                      {t.reference_id && <span>{t.reference_id}</span>}
                    </div>
                  )}
                </div>
                <div className={cn('font-mono shrink-0', amountClass)}>
                  {formatUGX(Number(t.amount) || 0)}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    );
  };

  const priorWindowLabel = priorRange
    ? `${format(priorRange.from, 'dd MMM')} – ${format(priorRange.to, 'dd MMM')}`
    : null;
  const totalInDelta = priorTotals ? formatDelta(summary.totalIn, priorTotals.totalIn) : null;
  const totalOutDelta = priorTotals ? formatDelta(summary.totalOut, priorTotals.totalOut) : null;

  // ── Net-flow trend buckets ─────────────────────────────────
  // Bucket wallet-scope rows by calendar day / week / month across the
  // currently loaded period, summing net per bucket. Powers the sparkline
  // shown under the Net Flow KPI so trend/momentum is visible at a glance.
  type TrendGroup = 'daily' | 'weekly' | 'monthly';
  const defaultTrendGroup: TrendGroup = useMemo(() => {
    const cur = periodRange(period);
    const days = Math.max(1, differenceInCalendarDays(cur.to, cur.from ?? cur.to) + 1);
    if (days <= 60) return 'daily';
    if (days <= 365) return 'weekly';
    return 'monthly';
  }, [period]);
  const [trendGroup, setTrendGroup] = useState<TrendGroup>(defaultTrendGroup);
  // Keep grouping sensible when the user switches periods.
  useEffect(() => { setTrendGroup(defaultTrendGroup); }, [defaultTrendGroup]);

  const netTrend = useMemo(() => {
    const cur = periodRange(period);
    const earliest = cur.from ?? (rows.length
      ? new Date(Math.min(...rows.map(r => new Date(r.transaction_date).getTime())))
      : new Date());
    const startFor = (d: Date) =>
      trendGroup === 'daily'   ? startOfDay(d)
    : trendGroup === 'weekly'  ? startOfWeek(d, { weekStartsOn: 1 })
    :                            startOfMonth(d);
    const advance = (d: Date) =>
      trendGroup === 'daily'   ? addDays(d, 1)
    : trendGroup === 'weekly'  ? addWeeks(d, 1)
    :                            addMonths(d, 1);
    const labelFor = (start: Date, end: Date) =>
      trendGroup === 'daily'   ? format(start, 'dd MMM yyyy')
    : trendGroup === 'weekly'  ? `${format(start, 'dd MMM')} – ${format(addDays(end, -1), 'dd MMM yyyy')}`
    :                            format(start, 'MMM yyyy');

    // Build the bucket index map: aligned bucket-start → array index.
    const starts: Date[] = [];
    let cursor = startFor(earliest);
    const endTs = cur.to.getTime();
    let guard = 0;
    while (cursor.getTime() <= endTs && guard < 2000) {
      starts.push(cursor);
      cursor = advance(cursor);
      guard++;
    }
    if (starts.length === 0) starts.push(startFor(earliest));
    const nets = new Array<number>(starts.length).fill(0);
    const ins = new Array<number>(starts.length).fill(0);
    const outs = new Array<number>(starts.length).fill(0);
    const labels = starts.map((s, i) => labelFor(s, starts[i + 1] ?? advance(s)));
    const idxFor = (t: number) => {
      // binary search for bucket whose start <= t
      let lo = 0, hi = starts.length - 1, ans = 0;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (starts[mid].getTime() <= t) { ans = mid; lo = mid + 1; } else { hi = mid - 1; }
      }
      return ans;
    };
    const minTs = starts[0].getTime();
    for (const r of rows) {
      if (r.ledger_scope !== 'wallet') continue;
      if (!includeAdjustments && (r.classification === 'admin_correction' || r.category === 'system_balance_correction')) continue;
      if (r.direction !== 'cash_in' && r.direction !== 'cash_out') continue;
      const t = new Date(r.transaction_date).getTime();
      if (t < minTs || t > endTs) continue;
      const amt = Number(r.amount) || 0;
      const i = idxFor(t);
      if (r.direction === 'cash_in') { ins[i] += amt; nets[i] += amt; }
      else { outs[i] += amt; nets[i] -= amt; }
    }
    // Linear-regression slope helper on bucket index → value, for momentum labels
    const slopeOf = (arr: number[]) => {
      const n = arr.length;
      if (n <= 1) return 0;
      const meanX = (n - 1) / 2;
      const meanY = arr.reduce((s, v) => s + v, 0) / n;
      let num = 0, den = 0;
      for (let i = 0; i < n; i++) {
        num += (i - meanX) * (arr[i] - meanY);
        den += (i - meanX) ** 2;
      }
      return den === 0 ? 0 : num / den;
    };
    const slope = slopeOf(nets);
    const inSlope = slopeOf(ins);
    const outSlope = slopeOf(outs);
    const totalIn = ins.reduce((s, v) => s + v, 0);
    const totalOut = outs.reduce((s, v) => s + v, 0);
    // Bucket ranges (ms) so clicks on sparkline points can open the
    // drill-down sheet scoped to that specific bucket window.
    const ranges = starts.map((s, i) => ({
      from: s.getTime(),
      to: (starts[i + 1] ? starts[i + 1].getTime() : endTs + 1),
    }));
    return { nets, ins, outs, labels, slope, inSlope, outSlope, totalIn, totalOut, ranges };
  }, [rows, includeAdjustments, period, trendGroup]);

  // ── Exports ─────────────────────────────────────────────────
  const currentRange = useMemo(() => periodRange(period), [period]);
  const periodLabel = PERIODS.find(p => p.value === period)?.label ?? period;
  const rangeLabel = currentRange.from
    ? `${format(currentRange.from, 'dd MMM yyyy')} – ${format(currentRange.to, 'dd MMM yyyy')}`
    : `All time – ${format(currentRange.to, 'dd MMM yyyy')}`;

  // Empty-state guard must run AFTER all hooks above to keep hook order stable
  // across renders (otherwise React throws "Rendered more hooks than during the
  // previous render" when rows transition between empty and non-empty).
  if (summary.inRows.length === 0 && summary.outRows.length === 0) {
    return null;
  }

  const buildExportRows = () => {
    const rowsOut: Array<{ section: string; label: string; amount: number; prior: number; count: number }> = [];
    const pushSection = (
      section: string,
      entries: [string, number][],
      priorMap: Map<string, number> | undefined,
      direction: 'cash_in' | 'cash_out',
    ) => {
      for (const [cat, amt] of entries) {
        rowsOut.push({
          section,
          label: friendlyWalletLabel(cat, direction),
          amount: amt,
          prior: priorMap?.get(cat) ?? 0,
          count: (txByKey.get(`${direction}|${cat}`) || []).length,
        });
      }
    };
    pushSection('Into wallets', summary.inRows, priorTotals?.inByCat, 'cash_in');
    pushSection('Out of wallets', summary.outRows, priorTotals?.outByCat, 'cash_out');
    return rowsOut;
  };

  const handleExportCsv = () => {
    const exportRows = buildExportRows();
    const headers = ['Section', 'Category', 'Amount (UGX)', 'Previous period (UGX)', 'Change %', 'Transactions'];
    const body: (string | number)[][] = exportRows.map(r => {
      const pct = r.prior === 0 ? (r.amount === 0 ? '0' : 'new') : (((r.amount - r.prior) / r.prior) * 100).toFixed(1);
      return [r.section, r.label, Math.round(r.amount), Math.round(r.prior), pct, r.count];
    });
    // Totals
    body.push([]);
    body.push(['Totals', 'Into wallets', Math.round(summary.totalIn), Math.round(priorTotals?.totalIn ?? 0), '', '']);
    body.push(['Totals', 'Out of wallets', Math.round(summary.totalOut), Math.round(priorTotals?.totalOut ?? 0), '', '']);
    body.push(['Totals', 'Net into wallets', Math.round(summary.net), Math.round((priorTotals?.totalIn ?? 0) - (priorTotals?.totalOut ?? 0)), '', '']);
    downloadCsv(`wallet-money-movement-${period}-${format(new Date(), 'yyyyMMdd-HHmm')}.csv`, headers, body);
    toast.success('CSV downloaded');
  };

  const handleExportPdf = () => {
    const exportRows = buildExportRows();
    const doc = new jsPDF();
    doc.setFontSize(14);
    doc.text('Wallet Money Movement', 14, 16);
    doc.setFontSize(10);
    doc.text(`Period: ${periodLabel} (${rangeLabel})`, 14, 23);
    if (priorWindowLabel) {
      doc.text(`Compared to previous period: ${priorWindowLabel}`, 14, 29);
    }

    const tableStartY = priorWindowLabel ? 35 : 29;
    autoTable(doc, {
      startY: tableStartY,
      head: [['Section', 'Category', 'Amount (UGX)', 'Previous (UGX)', 'Change %', 'Txns']],
      body: exportRows.map(r => {
        const pct = r.prior === 0 ? (r.amount === 0 ? '0%' : 'new') : `${(((r.amount - r.prior) / r.prior) * 100).toFixed(1)}%`;
        return [
          r.section,
          r.label,
          formatUGX(r.amount),
          formatUGX(r.prior),
          pct,
          String(r.count),
        ];
      }),
      foot: [
        ['Totals', 'Into wallets',  formatUGX(summary.totalIn),  formatUGX(priorTotals?.totalIn ?? 0),  '', ''],
        ['Totals', 'Out of wallets', formatUGX(summary.totalOut), formatUGX(priorTotals?.totalOut ?? 0), '', ''],
        ['Totals', 'Net into wallets', formatUGX(summary.net), formatUGX((priorTotals?.totalIn ?? 0) - (priorTotals?.totalOut ?? 0)), '', ''],
      ],
      styles: { fontSize: 9 },
      headStyles: { fillColor: [30, 30, 30] },
      footStyles: { fillColor: [240, 240, 240], textColor: 20, fontStyle: 'bold' },
    });

    doc.save(`wallet-money-movement-${period}-${format(new Date(), 'yyyyMMdd-HHmm')}.pdf`);
    toast.success('PDF downloaded');
  };

  return (
    <div className="rounded-xl border border-border bg-muted/30 p-3 sm:p-4 space-y-3">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div>
          <h4 className="text-sm font-semibold">Wallet Money Movement</h4>
          <p className="text-[11px] text-muted-foreground">
            How money moved between company funds and user/operational wallets. Tap a row to see transactions.
          </p>
          {priorWindowLabel && (
            <p className="text-[10px] text-muted-foreground/70 mt-0.5">
              vs previous period: {priorWindowLabel}
              {priorLoading && <span className="ml-1 italic">· loading…</span>}
            </p>
          )}
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <Button
            size="sm"
            variant="outline"
            className="h-7 px-2 text-[11px] gap-1"
            onClick={handleExportCsv}
            title="Download summary as CSV"
          >
            <FileSpreadsheet className="h-3 w-3" /> CSV
          </Button>
          <Button
            size="sm"
            variant="outline"
            className="h-7 px-2 text-[11px] gap-1"
            onClick={handleExportPdf}
            title="Download summary as PDF"
          >
            <FileText className="h-3 w-3" /> PDF
          </Button>
        </div>
      </div>

      {/* Prominent Net Flow KPI — Into minus Out for the selected period */}
      {(() => {
        const priorNet = priorTotals ? priorTotals.totalIn - priorTotals.totalOut : undefined;
        const netDelta = priorTotals ? formatDelta(summary.net, priorNet ?? 0) : null;
        const positive = summary.net >= 0;
        return (
          <button
            type="button"
            onClick={() => setNetDrill({ direction: 'all' })}
            title="View the exact cash-in and cash-out transactions behind this figure"
            className={cn(
              'w-full text-left rounded-xl border p-4 sm:p-5 flex items-center justify-between gap-3 flex-wrap transition-colors hover:bg-opacity-80 cursor-pointer focus:outline-none focus:ring-2 focus:ring-ring',
              positive
                ? 'bg-success/10 border-success/30 hover:bg-success/15'
                : 'bg-destructive/10 border-destructive/30 hover:bg-destructive/15'
            )}
          >
            <div className="min-w-0">
              <div className="text-[10px] uppercase tracking-wide text-muted-foreground font-semibold">
                Net flow into wallets
              </div>
              <div className="text-[10px] text-muted-foreground/80">
                Into − Out · {periodLabel} · <span className="underline">click to view transactions</span>
              </div>
            </div>
            <div className="flex flex-col items-end shrink-0">
              <div className={cn(
                'font-mono font-bold text-2xl sm:text-3xl break-all leading-tight',
                positive ? 'text-success' : 'text-destructive'
              )}>
                {positive ? '+' : ''}{formatUGX(summary.net)}
              </div>
              {netDelta ? (
                <div
                  className={cn('flex items-center gap-1.5 text-[11px] font-mono mt-0.5', toneClass(netDelta.tone, 'in'))}
                  title={`Previous period net: ${formatUGX(priorNet ?? 0)}`}
                >
                  {netDelta.absLabel && <span>{netDelta.absLabel}</span>}
                  <span className="opacity-80">{netDelta.label}</span>
                  <span className="text-muted-foreground/70 ml-1">vs prior</span>
                </div>
              ) : priorWindowLabel ? (
                <div className="text-[10px] text-muted-foreground/70 mt-0.5">
                  {priorLoading ? 'Loading prior period…' : 'No prior data'}
                </div>
              ) : null}
            </div>
          </button>
        );
      })()}

      {/* Net-flow sparkline — momentum across the selected period */}
      {(() => {
        const { nets, ins, outs, labels, slope, inSlope, outSlope, totalIn, totalOut, ranges } = netTrend;
        const hasData = nets.some(v => v !== 0);
        if (!hasData) return null;
        const W = 600;
        const H = 56;
        const PAD = 4;
        const min = Math.min(0, ...nets);
        const max = Math.max(0, ...nets);
        const range = Math.max(1, max - min);
        const xStep = (W - PAD * 2) / Math.max(1, nets.length - 1);
        const yFor = (v: number) => H - PAD - ((v - min) / range) * (H - PAD * 2);
        const xFor = (i: number) => PAD + i * xStep;
        const zeroY = yFor(0);
        const points = nets.map((v, i) => `${xFor(i).toFixed(1)},${yFor(v).toFixed(1)}`).join(' ');
        const areaPoints = `${xFor(0).toFixed(1)},${zeroY.toFixed(1)} ${points} ${xFor(nets.length - 1).toFixed(1)},${zeroY.toFixed(1)}`;
        const last = nets[nets.length - 1];
        const lastColor = last >= 0 ? 'hsl(var(--success))' : 'hsl(var(--destructive))';
        const slopeTone = slope > 0 ? 'text-success' : slope < 0 ? 'text-destructive' : 'text-muted-foreground';
        const slopeLabel = slope > 0 ? '▲ Improving' : slope < 0 ? '▼ Worsening' : '· Flat';
        return (
          <div className="rounded-lg border border-border bg-background p-3">
            <div className="flex items-center justify-between gap-2 mb-1.5">
              <div className="text-[10px] uppercase tracking-wide text-muted-foreground font-semibold">
                Net flow trend · {periodLabel} · {nets.length} {trendGroup === 'daily' ? 'day' : trendGroup === 'weekly' ? 'wk' : 'mo'}
                {nets.length === 1 ? '' : 's'}
              </div>
              <div className="flex items-center gap-2">
                <div className="flex items-center gap-0.5 rounded border border-border bg-muted/40 p-0.5">
                  {(['daily', 'weekly', 'monthly'] as const).map(g => (
                    <button
                      key={g}
                      type="button"
                      onClick={() => setTrendGroup(g)}
                      className={cn(
                        'text-[10px] px-1.5 py-0.5 rounded transition-colors',
                        trendGroup === g
                          ? 'bg-background text-foreground shadow-sm font-semibold'
                          : 'text-muted-foreground hover:text-foreground'
                      )}
                    >
                      {g === 'daily' ? 'D' : g === 'weekly' ? 'W' : 'M'}
                    </button>
                  ))}
                </div>
                <div className={cn('text-[10px] font-mono font-semibold', slopeTone)} title="Linear trend across the period">
                  {slopeLabel}
                </div>
              </div>
            </div>
            <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="w-full h-14 block" aria-label="Net flow sparkline">
              <defs>
                <linearGradient id="netSparkGrad" x1="0" x2="0" y1="0" y2="1">
                  <stop offset="0%" stopColor="hsl(var(--success))" stopOpacity="0.25" />
                  <stop offset="100%" stopColor="hsl(var(--success))" stopOpacity="0" />
                </linearGradient>
              </defs>
              {/* Zero baseline */}
              <line x1={PAD} x2={W - PAD} y1={zeroY} y2={zeroY} stroke="hsl(var(--border))" strokeDasharray="2 2" strokeWidth="1" />
              {/* Filled area */}
              <polygon points={areaPoints} fill="url(#netSparkGrad)" />
              {/* Line */}
              <polyline points={points} fill="none" stroke="hsl(var(--primary))" strokeWidth="1.5" strokeLinejoin="round" strokeLinecap="round" />
              {/* Per-bucket clickable hit areas — opens the drill-down filtered to this bucket */}
              {nets.map((v, i) => {
                const r = ranges[i];
                const openBucket = () => setNetDrill({ direction: 'all', from: r.from, to: r.to, label: labels[i] });
                return (
                  <g key={i} style={{ cursor: 'pointer' }} onClick={openBucket}>
                    {/* Wide invisible hit area for easy tapping */}
                    <rect
                      x={Math.max(0, xFor(i) - xStep / 2)}
                      y={0}
                      width={Math.max(6, xStep)}
                      height={H}
                      fill="transparent"
                    />
                    <circle
                      cx={xFor(i)}
                      cy={yFor(v)}
                      r={1.8}
                      fill={v >= 0 ? 'hsl(var(--success))' : 'hsl(var(--destructive))'}
                    />
                    <title>{`${labels[i]}\nNet: ${(v >= 0 ? '+' : '−')}${formatUGX(Math.abs(v))}\nClick to view transactions`}</title>
                  </g>
                );
              })}
              {/* Highlight last point */}
              <circle cx={xFor(nets.length - 1)} cy={yFor(last)} r={2.6} fill={lastColor} stroke="hsl(var(--background))" strokeWidth="1" pointerEvents="none" />
            </svg>
            <div className="flex items-center justify-between text-[10px] text-muted-foreground mt-1 font-mono">
              <span>{labels[0]?.split(' – ')[0]}</span>
              <span>{labels[labels.length - 1]?.split(' – ')[1]}</span>
            </div>
            {/* Legend — Into vs Out contribution and momentum */}
            <div className="mt-2 pt-2 border-t border-border/60 flex flex-wrap items-center gap-x-4 gap-y-1 text-[10px]">
              {(() => {
                const tone = (s: number, positiveGood: boolean) => {
                  if (s === 0) return 'text-muted-foreground';
                  const good = positiveGood ? s > 0 : s < 0;
                  return good ? 'text-success' : 'text-destructive';
                };
                const arrow = (s: number) => (s > 0 ? '▲' : s < 0 ? '▼' : '·');
                return (
                  <>
                    <span className="flex items-center gap-1.5">
                      <span className="inline-block h-2 w-2 rounded-sm bg-success" aria-hidden />
                      <span className="text-muted-foreground">Into</span>
                      <span className="font-mono text-success">{formatUGX(totalIn)}</span>
                      <span className={cn('font-mono font-semibold', tone(inSlope, true))} title="Inflow momentum">
                        {arrow(inSlope)}
                      </span>
                    </span>
                    <span className="flex items-center gap-1.5">
                      <span className="inline-block h-2 w-2 rounded-sm bg-destructive" aria-hidden />
                      <span className="text-muted-foreground">Out</span>
                      <span className="font-mono text-destructive">{formatUGX(totalOut)}</span>
                      <span className={cn('font-mono font-semibold', tone(outSlope, false))} title="Outflow momentum (rising outflow is worsening)">
                        {arrow(outSlope)}
                      </span>
                    </span>
                    <span className="flex items-center gap-1.5 ml-auto">
                      <span className="inline-block h-[2px] w-3 rounded bg-primary" aria-hidden />
                      <span className="text-muted-foreground">Net</span>
                      <span className={cn('font-mono font-semibold', (totalIn - totalOut) >= 0 ? 'text-success' : 'text-destructive')}>
                        {(totalIn - totalOut) >= 0 ? '+' : '−'}{formatUGX(Math.abs(totalIn - totalOut))}
                      </span>
                      <span className={cn('font-mono font-semibold', tone(slope, true))}>{arrow(slope)}</span>
                    </span>
                  </>
                );
              })()}
            </div>
          </div>
        );
      })()}

      {/* Wallet bucket flow — Withdrawable / Operational float / Landlord float, in & out */}
      {(() => {
        const items: {
          key: 'withdrawable' | 'operational_float' | 'landlord_float';
          label: string;
          sub: string;
          definition: string;
          inExamples: string;
          outExamples: string;
          in: number;
          out: number;
          inCount: number;
          outCount: number;
          accent: string;
        }[] = [
          {
            key: 'withdrawable',
            label: 'Withdrawable balances',
            sub: 'User-spendable cash — what users can withdraw or spend.',
            definition: 'The wallet bucket users can actually withdraw to MoMo or bank. Routed by Wallet Routing v2 when recipient_type = "user". Includes commissions, Returns paid to supporters, partner commissions, and direct user deposits.',
            inExamples: 'User deposits routed to user, commissions earned, Returns paid to supporters, partner commissions, bonuses, payroll credits.',
            outExamples: 'User withdrawals, wallet-funded rent payments, wallet → platform debits (CFO Direct Debit).',
            in: bucketBreakdown.withdrawable.in,
            out: bucketBreakdown.withdrawable.out,
            inCount: bucketBreakdown.withdrawable.inCount,
            outCount: bucketBreakdown.withdrawable.outCount,
            accent: 'text-primary',
          },
          {
            key: 'operational_float',
            label: 'Operational float',
            sub: 'Company money on agent/partner wallets — never withdrawable.',
            definition: 'The float_balance bucket on agent and partner wallets. This is company capital held to facilitate rent collection and allocation. Routed when recipient_type = "operational_wallet". Cannot be withdrawn by the holder.',
            inExamples: 'Rent collected by agents, partner float top-ups, CFO float deposits routed to operational wallets.',
            outExamples: 'Float allocated to tenants/landlords, partner sweeps back to platform capital, agent float used for rent.',
            in: bucketBreakdown.operational_float.in,
            out: bucketBreakdown.operational_float.out,
            inCount: bucketBreakdown.operational_float.inCount,
            outCount: bucketBreakdown.operational_float.outCount,
            accent: 'text-amber-600',
          },
          {
            key: 'landlord_float',
            label: 'Landlord float',
            sub: 'Capital earmarked for landlord rent payouts.',
            definition: 'A dedicated float used to pay landlords. CFO deposits seed it; landlord payouts draw it down. Tracked separately so landlord-payout coverage is visible without mixing with general operational float.',
            inExamples: 'CFO landlord-float deposits, returns swept into landlord-payout reserves.',
            outExamples: 'Landlord payouts sent against allocated tenants.',
            in: bucketBreakdown.landlord_float.in,
            out: bucketBreakdown.landlord_float.out,
            inCount: bucketBreakdown.landlord_float.inCount,
            outCount: bucketBreakdown.landlord_float.outCount,
            accent: 'text-sky-600',
          },
        ];
        const anyActivity = items.some(i => i.in > 0 || i.out > 0);
        if (!anyActivity) return null;
        const meta = bucketBreakdown.meta;
        const fmtDate = (d: Date | null) =>
          d ? d.toLocaleString(undefined, { year: 'numeric', month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—';
        const windowLabel = meta.from
          ? `${fmtDate(meta.from)} → ${fmtDate(meta.to)}`
          : `All time → ${fmtDate(meta.to)}`;
        return (
          <TooltipProvider delayDuration={150}>
          <div className="rounded-lg border border-border bg-muted/30 p-3">
            <div className="flex items-center gap-1.5 mb-2">
              <div className="text-[10px] uppercase tracking-wide text-muted-foreground font-semibold">
                Wallet bucket flow · {periodLabel}
              </div>
              <Tooltip>
                <TooltipTrigger asChild>
                  <button type="button" className="text-muted-foreground hover:text-foreground" aria-label="How this is calculated">
                    <Info className="h-3 w-3" />
                  </button>
                </TooltipTrigger>
                <TooltipContent className="max-w-xs text-[11px] leading-snug">
                  <p className="font-semibold mb-1">How this is derived</p>
                  <p>Sums every <span className="font-mono">ledger_scope = 'wallet'</span> entry in <span className="font-mono">general_ledger</span> within the selected period. Each row is classified by category into one of three buckets, then split by direction:</p>
                  <ul className="list-disc ml-4 mt-1 space-y-0.5">
                    <li><span className="font-semibold">In</span> = sum of <span className="font-mono">cash_in</span> legs landing in that bucket.</li>
                    <li><span className="font-semibold">Out</span> = sum of <span className="font-mono">cash_out</span> legs leaving that bucket.</li>
                    <li><span className="font-semibold">Net</span> = In − Out for the period (positive = bucket grew).</li>
                  </ul>
                  <div className="mt-2 pt-1 border-t border-border/60 space-y-0.5 opacity-90">
                    <div><span className="font-semibold">Window:</span> {windowLabel}</div>
                    <div><span className="font-semibold">Rows scanned:</span> {meta.scannedRows.toLocaleString()} → wallet-scope: {meta.walletScopeRows.toLocaleString()}</div>
                    <div><span className="font-semibold">Excluded:</span> {meta.outOfWindow.toLocaleString()} out of window, {meta.adjustmentsSkipped.toLocaleString()} adjustments</div>
                  </div>
                  <p className="mt-1 opacity-80">Admin corrections are excluded unless "Include adjustments" is on. Wallet balances are never mutated by this view.</p>
                </TooltipContent>
              </Tooltip>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
              {items.map(it => {
                const net = it.in - it.out;
                const openDrill = (direction: 'all' | 'cash_in' | 'cash_out') =>
                  setNetDrill({ direction, bucket: it.key, label: it.label });
                return (
                  <div
                    key={it.key}
                    className="rounded-md border border-border bg-background p-2.5 space-y-1.5 hover:border-primary/40 hover:bg-muted/40 transition-colors cursor-pointer"
                    role="button"
                    tabIndex={0}
                    onClick={() => openDrill('all')}
                    onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openDrill('all'); } }}
                    title={`Click to open ${it.label} transactions for ${periodLabel}`}
                  >
                    <div className="flex items-baseline justify-between gap-2">
                      <div className="flex items-center gap-1 min-w-0">
                        <div className={cn('text-[11px] font-semibold truncate', it.accent)}>{it.label}</div>
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <button
                              type="button"
                              onClick={(e) => e.stopPropagation()}
                              className="text-muted-foreground/70 hover:text-foreground shrink-0"
                              aria-label={`What is ${it.label}`}
                            >
                              <Info className="h-3 w-3" />
                            </button>
                          </TooltipTrigger>
                          <TooltipContent className="max-w-xs text-[11px] leading-snug">
                            <p className={cn('font-semibold mb-1', it.accent)}>{it.label}</p>
                            <p>{it.definition}</p>
                            <p className="mt-1"><span className="text-success font-semibold">In:</span> {it.inExamples}</p>
                            <p className="mt-1"><span className="text-destructive font-semibold">Out:</span> {it.outExamples}</p>
                            <div className="mt-2 pt-1 border-t border-border/60 space-y-0.5">
                              <div className="font-semibold">How this bucket is computed</div>
                              <div className="opacity-90">Filter: <span className="font-mono">ledger_scope='wallet'</span> · classified to <span className="font-mono">{it.key}</span> · {periodLabel}</div>
                              <div className="opacity-90">Window: {windowLabel}</div>
                              <div><span className="text-success font-semibold">In</span> = Σ amount of {it.inCount.toLocaleString()} <span className="font-mono">cash_in</span> leg{it.inCount === 1 ? '' : 's'} = <span className="font-mono">{formatUGX(it.in)}</span></div>
                              <div><span className="text-destructive font-semibold">Out</span> = Σ amount of {it.outCount.toLocaleString()} <span className="font-mono">cash_out</span> leg{it.outCount === 1 ? '' : 's'} = <span className="font-mono">{formatUGX(it.out)}</span></div>
                              <div><span className="font-semibold">Net</span> = {formatUGX(it.in)} − {formatUGX(it.out)} = <span className="font-mono">{(it.in - it.out) >= 0 ? '+' : '−'}{formatUGX(Math.abs(it.in - it.out))}</span></div>
                            </div>
                          </TooltipContent>
                        </Tooltip>
                      </div>
                      <div
                        className={cn(
                          'font-mono text-[10px] shrink-0',
                          net > 0 ? 'text-success' : net < 0 ? 'text-destructive' : 'text-muted-foreground',
                        )}
                        title={`Net = In (${formatUGX(it.in)}) − Out (${formatUGX(it.out)}) for ${periodLabel}`}
                      >
                        Net {net > 0 ? '+' : ''}{formatUGX(net)}
                      </div>
                    </div>
                    <div className="text-[10px] text-muted-foreground leading-snug line-clamp-2">{it.sub}</div>
                    <div className="flex items-center justify-between gap-2 pt-1 border-t border-border/60">
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <button
                            type="button"
                            onClick={(e) => { e.stopPropagation(); openDrill('cash_in'); }}
                            className="flex items-center gap-1 text-[10px] text-success hover:underline focus:outline-none focus-visible:ring-1 focus-visible:ring-success rounded px-1 -mx-1"
                          >
                            <ArrowDownLeft className="h-3 w-3" />
                            <span className="font-mono">In · {formatUGX(it.in)}</span>
                          </button>
                        </TooltipTrigger>
                        <TooltipContent className="max-w-xs text-[11px] leading-snug">
                          <p className="font-semibold text-success mb-1">In — money entering {it.label}</p>
                          <p>Sum of every <span className="font-mono">cash_in</span> wallet-scope ledger leg classified to <span className="font-mono">{it.key}</span> within {periodLabel}.</p>
                          <div className="mt-1 space-y-0.5 opacity-90">
                            <div>Window: {windowLabel}</div>
                            <div>Contributing rows: <span className="font-mono">{it.inCount.toLocaleString()}</span></div>
                            <div>Σ amount: <span className="font-mono">{formatUGX(it.in)}</span></div>
                          </div>
                          <p className="mt-1 opacity-80">Click to drill into the underlying transactions.</p>
                        </TooltipContent>
                      </Tooltip>
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <button
                            type="button"
                            onClick={(e) => { e.stopPropagation(); openDrill('cash_out'); }}
                            className="flex items-center gap-1 text-[10px] text-destructive hover:underline focus:outline-none focus-visible:ring-1 focus-visible:ring-destructive rounded px-1 -mx-1"
                          >
                            <ArrowUpRight className="h-3 w-3" />
                            <span className="font-mono">Out · {formatUGX(it.out)}</span>
                          </button>
                        </TooltipTrigger>
                        <TooltipContent className="max-w-xs text-[11px] leading-snug">
                          <p className="font-semibold text-destructive mb-1">Out — money leaving {it.label}</p>
                          <p>Sum of every <span className="font-mono">cash_out</span> wallet-scope ledger leg classified to <span className="font-mono">{it.key}</span> within {periodLabel}.</p>
                          <div className="mt-1 space-y-0.5 opacity-90">
                            <div>Window: {windowLabel}</div>
                            <div>Contributing rows: <span className="font-mono">{it.outCount.toLocaleString()}</span></div>
                            <div>Σ amount: <span className="font-mono">{formatUGX(it.out)}</span></div>
                          </div>
                          <p className="mt-1 opacity-80">Click to drill into the underlying transactions.</p>
                        </TooltipContent>
                      </Tooltip>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
          </TooltipProvider>
        );
      })()}

      {/* Top drivers — top 3 inflow and outflow categories powering the net result */}
      {(summary.inRows.length > 0 || summary.outRows.length > 0) && (
        <div className="rounded-lg border border-border bg-muted/30 p-3">
          <div className="text-[10px] uppercase tracking-wide text-muted-foreground font-semibold mb-2">
            Top drivers · {periodLabel}
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <div className="text-[10px] font-semibold text-success mb-1 flex items-center gap-1">
                <ArrowDownLeft className="h-3 w-3" /> Top inflows
              </div>
              {summary.inRows.length === 0 ? (
                <div className="text-[11px] text-muted-foreground italic">No inflows.</div>
              ) : (
                <ol className="space-y-1">
                  {summary.inRows.slice(0, 3).map(([cat, amt], i) => {
                    const share = summary.totalIn > 0 ? (amt / summary.totalIn) * 100 : 0;
                    return (
                      <li key={`in-${cat}`} className="flex items-center justify-between gap-2 text-[11px]">
                        <span className="flex items-center gap-1.5 min-w-0">
                          <span className="text-[10px] text-muted-foreground/70 w-3 shrink-0">{i + 1}.</span>
                          <span className="truncate text-foreground/90">{friendlyWalletLabel(cat, 'cash_in')}</span>
                          <span className="text-[10px] text-muted-foreground/70 shrink-0">· {share.toFixed(0)}%</span>
                        </span>
                        <span className="font-mono text-success shrink-0">{formatUGX(amt)}</span>
                      </li>
                    );
                  })}
                </ol>
              )}
            </div>
            <div>
              <div className="text-[10px] font-semibold text-destructive mb-1 flex items-center gap-1">
                <ArrowUpRight className="h-3 w-3" /> Top outflows
              </div>
              {summary.outRows.length === 0 ? (
                <div className="text-[11px] text-muted-foreground italic">No outflows.</div>
              ) : (
                <ol className="space-y-1">
                  {summary.outRows.slice(0, 3).map(([cat, amt], i) => {
                    const share = summary.totalOut > 0 ? (amt / summary.totalOut) * 100 : 0;
                    return (
                      <li key={`out-${cat}`} className="flex items-center justify-between gap-2 text-[11px]">
                        <span className="flex items-center gap-1.5 min-w-0">
                          <span className="text-[10px] text-muted-foreground/70 w-3 shrink-0">{i + 1}.</span>
                          <span className="truncate text-foreground/90">{friendlyWalletLabel(cat, 'cash_out')}</span>
                          <span className="text-[10px] text-muted-foreground/70 shrink-0">· {share.toFixed(0)}%</span>
                        </span>
                        <span className="font-mono text-destructive shrink-0">{formatUGX(amt)}</span>
                      </li>
                    );
                  })}
                </ol>
              )}
            </div>
          </div>
        </div>
      )}

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        {/* Into wallets */}
        <div className="rounded-lg border border-border bg-background p-3 space-y-2">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-1.5 text-xs font-semibold text-success">
              <ArrowDownLeft className="h-3.5 w-3.5" /> Into wallets
            </div>
            <div className="flex items-center gap-1.5 shrink-0">
              {totalInDelta && (
                <span
                  className={cn('flex items-center gap-1 text-[10px] font-mono', toneClass(totalInDelta.tone, 'in'))}
                  title={`Previous: ${formatUGX(priorTotals?.totalIn ?? 0)}`}
                >
                  {totalInDelta.absLabel && <span>{totalInDelta.absLabel}</span>}
                  <span className="opacity-80">{totalInDelta.label}</span>
                </span>
              )}
              <div className="font-mono text-sm font-semibold text-success break-all">
                {formatUGX(summary.totalIn)}
              </div>
            </div>
          </div>
          <div className="space-y-1">
            {summary.inRows.length === 0 && (
              <div className="text-[11px] text-muted-foreground italic">No inflows in this period.</div>
            )}
            {summary.inRows.map(([cat, amt]) => renderCategoryRow(cat, amt, 'cash_in'))}
          </div>
        </div>

        {/* Out of wallets */}
        <div className="rounded-lg border border-border bg-background p-3 space-y-2">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-1.5 text-xs font-semibold text-destructive">
              <ArrowUpRight className="h-3.5 w-3.5" /> Out of wallets
            </div>
            <div className="flex items-center gap-1.5 shrink-0">
              {totalOutDelta && (
                <span
                  className={cn('flex items-center gap-1 text-[10px] font-mono', toneClass(totalOutDelta.tone, 'out'))}
                  title={`Previous: ${formatUGX(priorTotals?.totalOut ?? 0)}`}
                >
                  {totalOutDelta.absLabel && <span>{totalOutDelta.absLabel}</span>}
                  <span className="opacity-80">{totalOutDelta.label}</span>
                </span>
              )}
              <div className="font-mono text-sm font-semibold text-destructive break-all">
                {formatUGX(summary.totalOut)}
              </div>
            </div>
          </div>
          <div className="space-y-1">
            {summary.outRows.length === 0 && (
              <div className="text-[11px] text-muted-foreground italic">No outflows in this period.</div>
            )}
            {summary.outRows.map(([cat, amt]) => renderCategoryRow(cat, amt, 'cash_out'))}
          </div>
        </div>
      </div>

      {/* Net-flow drill-down sheet — lists exact cash_in / cash_out wallet
          transactions that compose Into − Out for the currently loaded period. */}
      <Sheet open={!!netDrill} onOpenChange={(o) => { if (!o) setNetDrill(null); }}>
        <SheetContent side="right" className="w-full sm:max-w-2xl overflow-y-auto">
          {netDrill && (() => {
            const allWalletTxs: LedgerRow[] = [];
            for (const list of txByKey.values()) allWalletTxs.push(...list);
            const dirFiltered = allWalletTxs.filter(r => {
              if (netDrill.direction !== 'all' && r.direction !== netDrill.direction) return false;
              if (netDrill.from !== undefined || netDrill.to !== undefined) {
                const t = new Date(r.transaction_date).getTime();
                if (netDrill.from !== undefined && t < netDrill.from) return false;
                if (netDrill.to !== undefined && t >= netDrill.to) return false;
              }
              if (netDrill.bucket && classifyBucket(r.category) !== netDrill.bucket) return false;
              return true;
            });
            const q = netDrillQuery.trim().toLowerCase();
            const searched = q
              ? dirFiltered.filter(r =>
                  (r.reference_id || '').toLowerCase().includes(q) ||
                  (r.linked_party || '').toLowerCase().includes(q) ||
                  (r.description || '').toLowerCase().includes(q) ||
                  (r.source_table || '').toLowerCase().includes(q) ||
                  (r.category || '').toLowerCase().includes(q)
                )
              : dirFiltered;
            const sorted = [...searched].sort((a, b) =>
              new Date(b.transaction_date).getTime() - new Date(a.transaction_date).getTime()
            );
            const sumIn = sorted.filter(r => r.direction === 'cash_in').reduce((s, r) => s + (Number(r.amount) || 0), 0);
            const sumOut = sorted.filter(r => r.direction === 'cash_out').reduce((s, r) => s + (Number(r.amount) || 0), 0);
            const totalPages = Math.max(1, Math.ceil(sorted.length / NET_DRILL_PAGE_SIZE));
            const page = Math.min(netDrillPage, totalPages - 1);
            const slice = sorted.slice(page * NET_DRILL_PAGE_SIZE, (page + 1) * NET_DRILL_PAGE_SIZE);
            return (
              <>
                <SheetHeader>
                  <SheetTitle className="flex items-center gap-2">
                    Net flow transactions
                    <Badge variant="outline" className="text-[10px]">{periodLabel}</Badge>
                    {netDrill.label && (
                      <Badge variant="secondary" className="text-[10px]">{netDrill.label}</Badge>
                    )}
                  </SheetTitle>
                  <SheetDescription>
                    {netDrill.label
                      ? `Wallet cash-in and cash-out within ${netDrill.label} that compose this bucket's net.`
                      : 'Every wallet-scope cash-in and cash-out that makes up Into − Out for this period.'}
                  </SheetDescription>
                  {(netDrill.label || netDrill.bucket) && (
                    <button
                      type="button"
                      onClick={() => setNetDrill({ direction: netDrill.direction })}
                      className="self-start mt-1 text-[10px] underline text-muted-foreground hover:text-foreground"
                    >
                      Clear bucket filter · show full period
                    </button>
                  )}
                </SheetHeader>

                {/* Direction tabs */}
                <div className="mt-3 flex flex-wrap gap-1.5">
                  {([
                    { v: 'all', label: `All · ${sorted.length}` },
                    { v: 'cash_in', label: 'Into wallets' },
                    { v: 'cash_out', label: 'Out of wallets' },
                  ] as const).map(opt => (
                    <button
                      key={opt.v}
                      type="button"
                      onClick={() => setNetDrill({ ...netDrill, direction: opt.v })}
                      className={cn(
                        'text-[11px] px-2.5 py-1 rounded-full border transition-colors',
                        netDrill.direction === opt.v
                          ? 'bg-primary text-primary-foreground border-primary'
                          : 'bg-background border-border hover:bg-muted'
                      )}
                    >
                      {opt.label}
                    </button>
                  ))}
                </div>

                {/* Totals strip */}
                <div className="mt-3 grid grid-cols-3 gap-2 text-[11px]">
                  <div className="rounded border border-border p-2">
                    <div className="text-muted-foreground">Into</div>
                    <div className="font-mono font-semibold text-success break-all">{formatUGX(sumIn)}</div>
                  </div>
                  <div className="rounded border border-border p-2">
                    <div className="text-muted-foreground">Out</div>
                    <div className="font-mono font-semibold text-destructive break-all">{formatUGX(sumOut)}</div>
                  </div>
                  <div className="rounded border border-border p-2">
                    <div className="text-muted-foreground">Net</div>
                    <div className={cn('font-mono font-semibold break-all', sumIn - sumOut >= 0 ? 'text-success' : 'text-destructive')}>
                      {sumIn - sumOut >= 0 ? '+' : ''}{formatUGX(sumIn - sumOut)}
                    </div>
                  </div>
                </div>

                {/* Search */}
                <div className="mt-3">
                  <Input
                    placeholder="Search reference, party, category, description…"
                    value={netDrillQuery}
                    onChange={(e) => { setNetDrillQuery(e.target.value); setNetDrillPage(0); }}
                    className="h-8 text-xs"
                  />
                </div>

                {/* List */}
                <div className="mt-3 space-y-1 border-t border-border pt-2">
                  {slice.length === 0 && (
                    <div className="text-[11px] text-muted-foreground italic py-6 text-center">
                      No transactions match.
                    </div>
                  )}
                  {slice.map((t, i) => {
                    const isIn = t.direction === 'cash_in';
                    return (
                      <div
                        key={t.id || `${t.transaction_date}-${i}`}
                        className="flex items-start justify-between gap-2 text-[11px] py-1.5 border-b border-border/40 last:border-b-0"
                      >
                        <div className="min-w-0 flex-1">
                          <div className="text-foreground/90">
                            {format(new Date(t.transaction_date), 'dd MMM HH:mm')}
                            <span className="text-muted-foreground"> · {friendlyWalletLabel(t.category, t.direction as 'cash_in' | 'cash_out')}</span>
                            {t.linked_party && (
                              <span className="text-muted-foreground"> · {t.linked_party}</span>
                            )}
                          </div>
                          {t.description && (
                            <div className="text-muted-foreground truncate">{t.description}</div>
                          )}
                          {(t.reference_id || t.source_table) && (
                            <div className="text-[10px] text-muted-foreground/70 font-mono truncate">
                              {t.source_table && <span>{t.source_table}</span>}
                              {t.source_table && t.reference_id && <span> · </span>}
                              {t.reference_id && <span>{t.reference_id}</span>}
                            </div>
                          )}
                        </div>
                        <div className={cn('font-mono shrink-0', isIn ? 'text-success' : 'text-destructive')}>
                          {isIn ? '+' : '−'}{formatUGX(Number(t.amount) || 0)}
                        </div>
                      </div>
                    );
                  })}
                </div>

                {/* Pagination */}
                {sorted.length > NET_DRILL_PAGE_SIZE && (
                  <div className="mt-3 flex items-center justify-between gap-2 text-[10px]">
                    <div className="text-muted-foreground">
                      {page * NET_DRILL_PAGE_SIZE + 1}–{Math.min((page + 1) * NET_DRILL_PAGE_SIZE, sorted.length)} of {sorted.length.toLocaleString()}
                    </div>
                    <div className="flex gap-1">
                      <Button size="sm" variant="outline" className="h-6 px-2 text-[10px]"
                        disabled={page === 0} onClick={() => setNetDrillPage(p => Math.max(0, p - 1))}>‹ Prev</Button>
                      <Button size="sm" variant="outline" className="h-6 px-2 text-[10px]"
                        disabled={page >= totalPages - 1} onClick={() => setNetDrillPage(p => Math.min(totalPages - 1, p + 1))}>Next ›</Button>
                    </div>
                  </div>
                )}
              </>
            );
          })()}
        </SheetContent>
      </Sheet>
    </div>
  );
}
