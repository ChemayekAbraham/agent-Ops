import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { useAuth } from '@/hooks/useAuth';
import { supabase } from '@/integrations/supabase/client';
import { useEasyReadMode } from '@/hooks/useEasyReadMode';
import { useWalletActivityBadge } from '@/hooks/useWalletActivityBadge';
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetTrigger
} from '@/components/ui/sheet';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { ScrollArea } from '@/components/ui/scroll-area';
import {
  FileText,
  TrendingUp,
  TrendingDown,
  Users,
  CheckCircle2,
  Gift,
  ArrowDownToLine,
  Banknote,
  Calendar,
  Landmark,
  Coins,
  ArrowUpDown,
  Download,
  Loader2,
  Filter,
  X,
  ChevronDown,
  ChevronUp,
  FileSpreadsheet,
  Eye
} from 'lucide-react';
import { formatUGX } from '@/lib/rentCalculations';
import { format, subDays, isToday, isYesterday } from 'date-fns';
import { cn } from '@/lib/utils';
// jsPDF loaded dynamically when needed
import { toast } from 'sonner';
import { applyCustomerWalletLedgerFilters, isCustomerWalletLedgerEntryVisible } from '@/lib/customerWalletHistory';
import TransactionsFeed from '@/components/transactions/TransactionsFeed';

// ── Role-based highlight config ──
// Each role sees the categories that matter most to them surfaced first,
// in a "For you" card. Falls back to a generic set for unknown roles.
const ROLE_HIGHLIGHTS: Record<string, { title: string; subtitle: string; categories: string[] }> = {
  tenant: {
    title: 'Your rent activity',
    subtitle: 'Deposits, daily rent and refunds that matter for tenants',
    categories: ['deposit', 'rent_repayment', 'rent_auto_deduction', 'transfer_in', 'wallet_withdrawal'],
  },
  agent: {
    title: 'Your earnings as an agent',
    subtitle: 'Commissions, bonuses and float movements',
    categories: ['agent_commission', 'agent_commission_earned', 'subagent_commission', 'approval_bonus', 'referral_bonus', 'referral_first_transaction', 'wallet_withdrawal'],
  },
  proxy_agent: {
    title: 'Your earnings as an agent',
    subtitle: 'Commissions, bonuses and float movements',
    categories: ['agent_commission', 'agent_commission_earned', 'subagent_commission', 'approval_bonus', 'referral_bonus', 'wallet_withdrawal'],
  },
  partner: {
    title: 'Partner activity',
    subtitle: 'Proxy commissions, top-ups and payouts',
    categories: ['partner_commission', 'agent_commission', 'pool_investment', 'wallet_withdrawal', 'deposit'],
  },
  supporter: {
    title: 'Your investor activity',
    subtitle: 'Returns, top-ups and payouts on your portfolio',
    categories: ['supporter_reward', 'pool_investment', 'deposit', 'wallet_withdrawal', 'transfer_in'],
  },
};

const DEFAULT_HIGHLIGHT = {
  title: 'Your wallet activity',
  subtitle: 'The main things moving in and out of your wallet',
  categories: ['deposit', 'wallet_withdrawal', 'transfer_in', 'transfer_out', 'welcome_bonus'],
};

interface LedgerEntry {
  id: string;
  date: string;
  type: 'credit' | 'debit';
  category: string;
  description: string;
  amount: number;
  reference_id?: string | null;
  linked_party?: string | null;
  balance_after?: number;
  /** Set when this credit traces back to a sub-agent's activity. */
  subAgentName?: string | null;
  /** Plain-English description of what the sub-agent did to earn this. */
  subAgentAction?: string | null;
}

interface SubAgentEarningRow {
  key: string;
  subAgentName: string;
  action: string;
  amount: number;
  date: string;
  /** True when the matching wallet credit landed in the withdrawable bucket. */
  landed: boolean;
}

/** Turns a sub-agent earning event into a plain-English "what they did". */
function describeSubAgentAction(opts: {
  eventType?: string | null;
  earningType?: string | null;
  description?: string | null;
  label?: string | null;
}): string {
  const { eventType, earningType, description, label } = opts;
  if (eventType) {
    switch (eventType) {
      case 'house_listed_verified':
        return label ? `Listed a house that was verified — ${label}` : 'Listed a house that was verified';
      case 'landlord_verified':
        return 'Registered a landlord who was verified';
      case 'lc1_chairperson_verified':
        return 'Registered an LC1 chairperson who was verified';
      case 'tenant_landlord_funded':
        return "Their tenant got its landlord funded";
      default:
        return eventType.replace(/_/g, ' ');
    }
  }
  const d = (description || '').toLowerCase();
  if (d.includes('deposit')) return 'Collected a tenant deposit';
  if (d.includes('repayment') || d.includes('rent')) return 'Collected rent from a tenant';
  if (earningType === 'subagent_registration') return 'You registered them as a sub-agent';
  if (earningType) return earningType.replace(/_/g, ' ');
  return 'Sub-agent activity';
}

const CATEGORY_META: Record<string, { label: string; Icon: React.ElementType; colorClass: string; plainExplanation: string }> = {
  referral_bonus:        { label: 'Referral Bonus',          Icon: Users,          colorClass: 'text-primary bg-primary/10', plainExplanation: 'You earned this because someone you referred joined Welile.' },
  agent_commission:      { label: 'Commission Earned',        Icon: TrendingUp,     colorClass: 'text-success bg-success/10', plainExplanation: 'You earned 5% commission when a tenant you registered made a rent repayment.' },
  agent_commission_earned: { label: 'Cash-out Commission',     Icon: TrendingUp,     colorClass: 'text-success bg-success/10', plainExplanation: 'You earned 0.5% commission for settling a customer cash-out (Cash, Mobile Money or Bank) as a merchant agent.' },
  approval_bonus:        { label: 'Approval Bonus',           Icon: CheckCircle2,   colorClass: 'text-success bg-success/10', plainExplanation: 'You earned UGX 5,000 because a tenant you registered was approved for rent.' },
  subagent_commission:   { label: 'Sub-agent Commission',     Icon: TrendingUp,     colorClass: 'text-success bg-success/10', plainExplanation: 'You earned 2% because a sub-agent under you collected a rent repayment.' },
  referral_first_transaction: { label: 'First Transaction Bonus', Icon: Gift,      colorClass: 'text-warning bg-warning/10', plainExplanation: 'Bonus for your referred user completing their first transaction.' },
  welcome_bonus:         { label: 'Welcome Bonus',            Icon: Gift,           colorClass: 'text-warning bg-warning/10', plainExplanation: 'A one-time bonus for joining the Welile platform.' },
  deposit:               { label: 'Mobile Money Deposit',     Icon: Landmark,       colorClass: 'text-primary bg-primary/10', plainExplanation: 'Money deposited into your wallet via Mobile Money.' },
  wallet_withdrawal:     { label: 'Withdrawal',               Icon: ArrowDownToLine,colorClass: 'text-destructive bg-destructive/10', plainExplanation: 'Money you withdrew from your wallet to Mobile Money or bank.' },
  supporter_reward:      { label: 'Supporter Reward',         Icon: Coins,          colorClass: 'text-success bg-success/10', plainExplanation: 'Reward earned from your supporter investment portfolio.' },
  rent_repayment:        { label: 'Rent Repayment',           Icon: Banknote,       colorClass: 'text-primary bg-primary/10', plainExplanation: 'Daily rent deduction from your wallet to repay your rent advance.' },
  tenant_default_charge: { label: 'Tenant Default (Legacy)',   Icon: ArrowDownToLine,colorClass: 'text-destructive bg-destructive/10', plainExplanation: 'A historical charge from when agents were charged for tenant defaults. This policy has been discontinued.' },
  rent_auto_deduction:   { label: 'Auto Rent Deduction',      Icon: ArrowDownToLine,colorClass: 'text-destructive bg-destructive/10', plainExplanation: 'Your daily rent installment was automatically deducted from your wallet.' },
  transfer_out:          { label: 'Transfer Sent',            Icon: ArrowDownToLine,colorClass: 'text-destructive bg-destructive/10', plainExplanation: 'Money you sent to another Welile user.' },
  transfer_in:           { label: 'Transfer Received',        Icon: Landmark,       colorClass: 'text-primary bg-primary/10', plainExplanation: 'Money received from another Welile user.' },
  pool_investment:       { label: 'Pool Investment',          Icon: ArrowDownToLine,colorClass: 'text-primary bg-primary/10', plainExplanation: 'Money moved from your wallet to the rent management pool.' },
  agent_repayment:       { label: 'Advance Auto-Recovery',    Icon: ArrowDownToLine,colorClass: 'text-destructive bg-destructive/10', plainExplanation: 'You withdrew a little more than what was actually in your wallet. An auto-recovery advance was opened for that shortfall plus a 33% platform fee. It is paid back automatically from your future earnings straight to the platform — nothing is ever taken back from your wallet.' },
  agent_advance_credit:  { label: 'Advance Received',         Icon: Banknote,       colorClass: 'text-primary bg-primary/10', plainExplanation: 'An advance was added to your wallet. It will be repaid over the agreed period.' },
};

function getCategoryMeta(category: string, direction: string) {
  const meta = CATEGORY_META[category];
  if (meta) return meta;
  if (direction === 'cash_out') return { label: category.replace(/_/g, ' '), Icon: ArrowDownToLine, colorClass: 'text-destructive bg-destructive/10', plainExplanation: 'Money was deducted from your wallet.' };
  return { label: category.replace(/_/g, ' '), Icon: Banknote, colorClass: 'text-muted-foreground bg-muted', plainExplanation: 'Money was added to your wallet.' };
}

function formatAmount(amount: number): string {
  return `UGX ${amount.toLocaleString()}`;
}

const SUBAGENT_EARNING_TYPES = ['subagent_commission', 'subagent_override', 'subagent_registration'];

/**
 * Fetches every sub-agent-driven earning leg (recruiter overrides + sub-agent
 * commissions), resolves the sub-agent's name, and matches each leg to its
 * withdrawable wallet credit in the ledger. Mutates `entries` in place to attach
 * sub-agent name + plain-English action, and returns a flat list for the summary.
 */
async function buildSubAgentEarnings(userId: string, entries: LedgerEntry[]): Promise<SubAgentEarningRow[]> {
  const [overridesRes, earningsRes, legsRes] = await Promise.all([
    supabase
      .from('recruiter_override_events')
      .select('id, sub_agent_id, label, amount, source_id, occurred_at, event_type')
      .eq('recruiter_id', userId)
      .order('occurred_at', { ascending: false })
      .limit(300),
    supabase
      .from('agent_earnings')
      .select('id, amount, earning_type, description, source_user_id, created_at')
      .eq('agent_id', userId)
      .in('earning_type', SUBAGENT_EARNING_TYPES)
      .order('created_at', { ascending: false })
      .limit(300),
    applyCustomerWalletLedgerFilters(supabase
      .from('general_ledger')
      .select('id, amount, source_id, transaction_date, recipient_type, ledger_scope, wallet_bucket, classification, category, source_table, description, reference_id')
      .eq('user_id', userId)
      .eq('category', 'agent_commission')
      .eq('ledger_scope', 'wallet'))
      .order('transaction_date', { ascending: false })
      .limit(800),
  ]);

  const overrides = overridesRes.data || [];
  const earnings = earningsRes.data || [];
  const legs = (legsRes.data || []).filter(isCustomerWalletLedgerEntryVisible).map((l) => ({
    id: l.id as string,
    amount: Number(l.amount),
    source_id: l.source_id ? String(l.source_id) : null,
    date: l.transaction_date as string,
    bucket:
      (l.wallet_bucket as string | null) ||
      (l.recipient_type === 'user' && l.ledger_scope === 'wallet' ? 'withdrawable' : (l.ledger_scope as string | null)),
  }));

  // Resolve sub-agent names.
  const ids = [
    ...new Set([
      ...overrides.filter((o) => o.sub_agent_id).map((o) => o.sub_agent_id as string),
      ...earnings.filter((e) => e.source_user_id).map((e) => e.source_user_id as string),
    ]),
  ];
  const nameMap: Record<string, string> = {};
  if (ids.length > 0) {
    const { data: profiles } = await supabase.from('profiles').select('id, full_name').in('id', ids);
    (profiles || []).forEach((p) => { nameMap[p.id] = p.full_name || 'Unknown sub-agent'; });
  }

  type Leg = {
    key: string;
    subAgentName: string;
    action: string;
    amount: number;
    date: string;
    sourceId: string | null;
  };
  const earningLegs: Leg[] = [
    ...overrides.map((o) => ({
      key: `roe-${o.id}`,
      subAgentName: o.sub_agent_id ? (nameMap[o.sub_agent_id] || 'Unknown sub-agent') : 'A sub-agent',
      action: describeSubAgentAction({ eventType: o.event_type, label: o.label }),
      amount: Number(o.amount),
      date: o.occurred_at as string,
      sourceId: o.source_id ? String(o.source_id) : null,
    })),
    ...earnings.map((e) => ({
      key: `ae-${e.id}`,
      subAgentName: e.source_user_id ? (nameMap[e.source_user_id] || 'Unknown sub-agent') : 'A sub-agent',
      action: describeSubAgentAction({ earningType: e.earning_type, description: e.description }),
      amount: Number(e.amount),
      date: e.created_at as string,
      sourceId: null,
    })),
  ].sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());

  // Match each earning leg to a wallet credit (source_id first, then amount + time window).
  const used = new Set<string>();
  const result: SubAgentEarningRow[] = earningLegs.map((leg) => {
    let pick: (typeof legs)[number] | null = null;
    const avail = legs.filter((w) => !used.has(w.id));
    if (leg.sourceId) {
      pick = avail.find((w) => w.source_id === leg.sourceId && Math.abs(w.amount - leg.amount) < 1) || null;
    }
    if (!pick) {
      const t = new Date(leg.date).getTime();
      pick = avail
        .filter((w) => Math.abs(w.amount - leg.amount) < 1 && Math.abs(new Date(w.date).getTime() - t) < 5 * 60 * 1000)
        .sort((a, b) => Math.abs(new Date(a.date).getTime() - t) - Math.abs(new Date(b.date).getTime() - t))[0] || null;
    }
    if (pick) {
      used.add(pick.id);
      // Attach context to the matching wallet entry in the statement timeline.
      const entry = entries.find((en) => en.id === pick!.id);
      if (entry) {
        entry.subAgentName = leg.subAgentName;
        entry.subAgentAction = leg.action;
      }
    }
    return {
      key: leg.key,
      subAgentName: leg.subAgentName,
      action: leg.action,
      amount: leg.amount,
      date: leg.date,
      landed: pick ? pick.bucket === 'withdrawable' : false,
    };
  });

  return result;
}

export function WalletStatement() {
  const { user, role } = useAuth();
  const [open, setOpen] = useState(false);
  const { count: newActivityCount, markSeen, refresh: refreshActivity } = useWalletActivityBadge(user?.id);
  const [loading, setLoading] = useState(true);
  const [exporting, setExporting] = useState(false);
  const [entries, setEntries] = useState<LedgerEntry[]>([]);
  const [totals, setTotals] = useState({ totalIn: 0, totalOut: 0 });
  const [breakdown, setBreakdown] = useState<Record<string, number>>({});
  const [userName, setUserName] = useState('');
  const [subAgentEarnings, setSubAgentEarnings] = useState<SubAgentEarningRow[]>([]);
  // Filters
  const [directionFilter, setDirectionFilter] = useState<'all' | 'credit' | 'debit'>('all');
  const [statusFilter, setStatusFilter] = useState<'all' | 'completed' | 'pending'>('all');
  const [categoryFilter, setCategoryFilter] = useState<string>('all');
  const [rangePreset, setRangePreset] = useState<'all' | '7d' | '30d' | '90d'>('all');
  // Progressive disclosure for a calmer default view
  const [showBreakdown, setShowBreakdown] = useState(false);
  const [showCategoryFilters, setShowCategoryFilters] = useState(false);
  // Infinite scroll: progressively reveal cards from the filtered list.
  const PAGE_SIZE = 25;
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);
  const scrollRootRef = useRef<HTMLDivElement>(null);
  const sentinelRef = useRef<HTMLDivElement>(null);
  // Accessibility: shared easy-read mode (applies globally to wallet + receipt UI)
  const { enabled: a11yMode, toggle: toggleA11y, size: a11ySize, setSize: setA11ySize } = useEasyReadMode();

  useEffect(() => {
    if (open && user) {
      fetchStatement();
      markSeen();
      void refreshActivity();
    }
  }, [open, user]);

  const fetchStatement = async () => {
    if (!user) return;
    setLoading(true);

    try {
      const [{ data: ledger, error }, { data: profile }, { data: referralEarnings }] = await Promise.all([
        applyCustomerWalletLedgerFilters(supabase
          .from('general_ledger')
          .select('id, transaction_date, amount, direction, category, description, reference_id, linked_party, classification, source_table')
          .eq('user_id', user.id)
          .eq('ledger_scope', 'wallet'))
          .order('transaction_date', { ascending: false })
          .limit(500),
        supabase.from('profiles').select('full_name').eq('id', user.id).single(),
        supabase
          .from('agent_earnings')
          .select('id, created_at, amount, earning_type, description')
          .eq('agent_id', user.id)
          .eq('earning_type', 'referral_bonus'),
      ]);

      if (error) throw error;
      setUserName(profile?.full_name || user.email || '');

      const allEntries: LedgerEntry[] = (ledger || []).filter(isCustomerWalletLedgerEntryVisible).map(row => ({
        id: row.id,
        date: row.transaction_date,
        type: (row.direction === 'cash_in' ? 'credit' : 'debit') as 'credit' | 'debit',
        category: row.category,
        description: row.description || getCategoryMeta(row.category, row.direction).label,
        amount: row.amount,
        reference_id: row.reference_id,
        linked_party: row.linked_party,
      }))
        // Hide internal bucket reclassifications (Withdrawable ↔ Float) — these are
        // paired legs that net to zero for the user and only confuse the statement.
        .filter(e => !(typeof e.reference_id === 'string' && /^WDR2FLT-/i.test(e.reference_id)));

      for (const re of referralEarnings || []) {
        const alreadyIn = allEntries.some(e => e.category === 'referral_bonus' &&
          Math.abs(new Date(e.date).getTime() - new Date(re.created_at).getTime()) < 5000 &&
          e.amount === re.amount);
        if (!alreadyIn) {
          allEntries.push({
            id: `ae-${re.id}`,
            date: re.created_at,
            type: 'credit',
            category: 'referral_bonus',
            description: re.description || 'Referral Bonus',
            amount: re.amount,
          });
        }
      }

      allEntries.sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());

      // ── Enrich agent credits with the sub-agent who triggered them ──
      if (role === 'agent') {
        try {
          const subList = await buildSubAgentEarnings(user.id, allEntries);
          setSubAgentEarnings(subList);
        } catch (e) {
          console.error('[WalletStatement] sub-agent enrichment failed', e);
          setSubAgentEarnings([]);
        }
      } else {
        setSubAgentEarnings([]);
      }

      let runningBalance = 0;
      for (const entry of allEntries) {
        if (entry.type === 'credit') runningBalance += entry.amount;
        else runningBalance -= entry.amount;
        entry.balance_after = Math.max(0, runningBalance);
      }

      const displayEntries = [...allEntries].reverse();
      const totalIn = allEntries.filter(e => e.type === 'credit').reduce((s, e) => s + e.amount, 0);
      const totalOut = allEntries.filter(e => e.type === 'debit').reduce((s, e) => s + e.amount, 0);

      const bk: Record<string, number> = {};
      for (const e of allEntries.filter(e => e.type === 'credit')) {
        bk[e.category] = (bk[e.category] || 0) + e.amount;
      }

      setEntries(displayEntries);
      setTotals({ totalIn, totalOut });
      setBreakdown(bk);
    } catch (error) {
      console.error('[WalletStatement] Error:', error);
    } finally {
      setLoading(false);
    }
  };

  // ── Derived: date range + filtered entries (shared by UI + exports) ──
  const rangeFrom = (() => {
    if (rangePreset === 'all') return null;
    const days = rangePreset === '7d' ? 7 : rangePreset === '30d' ? 30 : 90;
    return subDays(new Date(), days);
  })();

  const filteredEntries = entries.filter(entry => {
    if (directionFilter !== 'all' && entry.type !== directionFilter) return false;
    if (categoryFilter !== 'all' && entry.category !== categoryFilter) return false;
    if (rangeFrom && new Date(entry.date) < rangeFrom) return false;
    // Ledger-posted entries are always Completed; there is no pending source yet.
    if (statusFilter === 'pending') return false;
    return true;
  });

  const filteredTotals = filteredEntries.reduce(
    (acc, e) => {
      if (e.type === 'credit') acc.totalIn += e.amount;
      else acc.totalOut += e.amount;
      return acc;
    },
    { totalIn: 0, totalOut: 0 }
  );

  // Wallet balance immediately after each entry, keyed by ledger row id — derived
  // from `entries` (computed over the FULL unfiltered history above) and merged
  // onto TransactionsFeed's independently-paginated/filtered rows by id, so "why
  // did my balance change" stays traceable no matter which filter/page the feed
  // is currently showing.
  const balanceAfterById = useMemo(() => {
    const map: Record<string, number> = {};
    for (const e of entries) {
      if (e.balance_after != null) map[e.id] = e.balance_after;
    }
    return map;
  }, [entries]);

  const rangeLabel =
    rangePreset === 'all' ? 'All time' :
    rangePreset === '7d' ? 'Last 7 days' :
    rangePreset === '30d' ? 'Last 30 days' : 'Last 90 days';

  const filterSummary = [
    rangeLabel,
    directionFilter !== 'all' ? (directionFilter === 'credit' ? 'Money In only' : 'Money Out only') : null,
    categoryFilter !== 'all' ? `Type: ${categoryFilter.replace(/_/g, ' ')}` : null,
  ].filter(Boolean).join(' · ');

  const exportToCSV = useCallback(() => {
    if (filteredEntries.length === 0) {
      toast.error('No transactions to export');
      return;
    }
    const escape = (val: string | number | null | undefined) => {
      const s = val == null ? '' : String(val);
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    // Running / after balance is internal-only and never exported to users.
    const header = ['Date', 'Time', 'Description', 'Category', 'Type', 'Amount (UGX)', 'Reference', 'Linked Party'];
    const rows = filteredEntries.map(e => [
      format(new Date(e.date), 'yyyy-MM-dd'),
      format(new Date(e.date), 'HH:mm:ss'),
      e.description,
      e.category,
      e.type === 'credit' ? 'IN' : 'OUT',
      (e.type === 'credit' ? '+' : '-') + e.amount,
      e.reference_id ?? '',
      e.linked_party ?? '',
    ]);
    const meta = [
      ['Welile Wallet Statement'],
      ['Account', userName],
      ['Generated', format(new Date(), 'yyyy-MM-dd HH:mm')],
      ['Filters', filterSummary],
      ['Total In', `+${filteredTotals.totalIn}`],
      ['Total Out', `-${filteredTotals.totalOut}`],
      ['Net', `${filteredTotals.totalIn - filteredTotals.totalOut}`],
      [],
    ];
    const csv = [...meta, header, ...rows].map(r => r.map(escape).join(',')).join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `Welile_Wallet_Statement_${format(new Date(), 'yyyy-MM-dd')}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    toast.success('CSV downloaded');
  }, [filteredEntries, filteredTotals.totalIn, filteredTotals.totalOut, userName, filterSummary]);

  const exportToPDF = useCallback(async () => {
    if (filteredEntries.length === 0) {
      toast.error('No transactions to export');
      return;
    }

    setExporting(true);

    try {
      const { default: jsPDF } = await import('jspdf');
      const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });
      const pageWidth = doc.internal.pageSize.getWidth();
      const pageHeight = doc.internal.pageSize.getHeight();
      const margin = 15;
      const contentWidth = pageWidth - margin * 2;
      let y = margin;

      const addNewPageIfNeeded = (needed: number) => {
        if (y + needed > pageHeight - 20) {
          doc.addPage();
          y = margin;
          return true;
        }
        return false;
      };

      // ── Header ──
      doc.setFillColor(88, 28, 135); // purple
      doc.rect(0, 0, pageWidth, 44, 'F');
      doc.setTextColor(255, 255, 255);
      doc.setFontSize(18);
      doc.setFont('helvetica', 'bold');
      doc.text('Welile Wallet Statement', margin, 16);
      doc.setFontSize(10);
      doc.setFont('helvetica', 'normal');
      doc.text(userName, margin, 24);
      doc.text(`Generated: ${format(new Date(), 'PPP p')}`, margin, 30);
      doc.setFontSize(8);
      doc.text(`Filters: ${filterSummary}`, margin, 37);
      y = 52;

      // ── Summary ──
      doc.setTextColor(0, 0, 0);
      doc.setFontSize(12);
      doc.setFont('helvetica', 'bold');
      doc.text('Summary', margin, y);
      y += 8;

      doc.setFontSize(10);
      doc.setFont('helvetica', 'normal');

      // Total In
      doc.setFillColor(220, 252, 231);
      doc.roundedRect(margin, y, contentWidth / 2 - 3, 16, 2, 2, 'F');
      doc.setTextColor(22, 163, 74);
      doc.text('Total In', margin + 4, y + 6);
      doc.setFont('helvetica', 'bold');
      doc.text(`+${formatAmount(filteredTotals.totalIn)}`, margin + 4, y + 12);

      // Total Out
      doc.setFillColor(254, 226, 226);
      doc.roundedRect(margin + contentWidth / 2 + 3, y, contentWidth / 2 - 3, 16, 2, 2, 'F');
      doc.setTextColor(220, 38, 38);
      doc.text('Total Out', margin + contentWidth / 2 + 7, y + 6);
      doc.setFont('helvetica', 'bold');
      doc.text(`-${formatAmount(filteredTotals.totalOut)}`, margin + contentWidth / 2 + 7, y + 12);

      y += 22;

      // Net Balance
      const netBalance = Math.max(0, filteredTotals.totalIn - filteredTotals.totalOut);
      doc.setFillColor(240, 240, 240);
      doc.roundedRect(margin, y, contentWidth, 12, 2, 2, 'F');
      doc.setTextColor(0, 0, 0);
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(10);
      doc.text('Net Balance:', margin + 4, y + 8);
      doc.setTextColor(netBalance >= 0 ? 22 : 220, netBalance >= 0 ? 163 : 38, netBalance >= 0 ? 74 : 38);
      doc.text(formatAmount(netBalance), pageWidth - margin - 4, y + 8, { align: 'right' });
      y += 18;

      // ── Transaction Table ──
      doc.setTextColor(0, 0, 0);
      doc.setFontSize(12);
      doc.setFont('helvetica', 'bold');
      doc.text('Transaction History', margin, y);
      y += 6;

      // Table header
      const colWidths = [30, 78, 24, 36];
      const headers = ['Date', 'Description', 'Type', 'Amount'];

      doc.setFillColor(88, 28, 135);
      doc.rect(margin, y, contentWidth, 8, 'F');
      doc.setTextColor(255, 255, 255);
      doc.setFontSize(8);
      doc.setFont('helvetica', 'bold');

      let xPos = margin + 2;
      headers.forEach((h, i) => {
        doc.text(h, xPos, y + 5.5);
        xPos += colWidths[i];
      });
      y += 8;

      // Table rows
      doc.setFontSize(7.5);
      const sortedEntries = [...filteredEntries]; // already newest-first

      for (let i = 0; i < sortedEntries.length; i++) {
        const entry = sortedEntries[i];
        const rowHeight = entry.linked_party && entry.linked_party !== 'platform' ? 10 : 7;
        addNewPageIfNeeded(rowHeight);

        // Alternating row color
        if (i % 2 === 0) {
          doc.setFillColor(248, 248, 248);
          doc.rect(margin, y, contentWidth, rowHeight, 'F');
        }

        doc.setTextColor(80, 80, 80);
        doc.setFont('helvetica', 'normal');

        xPos = margin + 2;

        // Date
        doc.text(format(new Date(entry.date), 'dd/MM/yy'), xPos, y + 4.5);
        xPos += colWidths[0];

        // Description (truncated) + linked party
        const desc = entry.description.length > 38
          ? entry.description.substring(0, 35) + '...'
          : entry.description;
        doc.text(desc, xPos, y + 4.5);
        if (entry.linked_party && entry.linked_party !== 'platform') {
          doc.setFontSize(6);
          doc.setTextColor(160, 120, 0);
          doc.text(`→ ${entry.linked_party}`, xPos, y + 8);
          doc.setFontSize(7.5);
        }
        xPos += colWidths[1];

        // Type
        const isCredit = entry.type === 'credit';
        doc.setTextColor(isCredit ? 22 : 220, isCredit ? 163 : 38, isCredit ? 74 : 38);
        doc.setFont('helvetica', 'bold');
        doc.text(isCredit ? 'IN' : 'OUT', xPos, y + 4.5);
        xPos += colWidths[2];

        // Amount
        doc.text(`${isCredit ? '+' : '-'}${formatAmount(entry.amount)}`, xPos, y + 4.5);

        y += rowHeight;
      }

      // ── Footer ──
      y += 6;
      addNewPageIfNeeded(20);
      doc.setDrawColor(200, 200, 200);
      doc.line(margin, y, pageWidth - margin, y);
      y += 6;
      doc.setFontSize(7);
      doc.setTextColor(150, 150, 150);
      doc.setFont('helvetica', 'normal');
      doc.text('This is an auto-generated statement from Welile Technologies Limited.', margin, y);
      doc.text(`Total entries: ${filteredEntries.length}  ·  ${format(new Date(), 'PPPp')}`, margin, y + 4);

      // Save
      const filename = `Welile_Wallet_Statement_${format(new Date(), 'yyyy-MM-dd')}.pdf`;
      doc.save(filename);
      toast.success('PDF downloaded successfully');
    } catch (err) {
      console.error('[WalletStatement] PDF export error:', err);
      toast.error('Failed to export PDF');
    } finally {
      setExporting(false);
    }
  }, [filteredEntries, filteredTotals.totalIn, filteredTotals.totalOut, userName, filterSummary]);

  // Get unique categories for filter chips
  const uniqueCategories = [...new Set(entries.map(e => e.category))];

  const hasActiveFilters = directionFilter !== 'all' || categoryFilter !== 'all' || rangePreset !== 'all';

  // Group by date
  // Reset the visible window whenever the filtered result set changes so
  // switching filters/date range doesn't leave the user scrolled past new data.
  useEffect(() => {
    setVisibleCount(PAGE_SIZE);
  }, [directionFilter, statusFilter, categoryFilter, rangePreset, entries.length]);

  const visibleEntries = filteredEntries.slice(0, visibleCount);
  const hasMore = visibleCount < filteredEntries.length;

  // IntersectionObserver — scoped to the ScrollArea's inner viewport so
  // "in view" is measured against the sheet, not the browser window.
  useEffect(() => {
    if (!open || loading || !hasMore) return;
    const sentinel = sentinelRef.current;
    if (!sentinel) return;
    const viewport = scrollRootRef.current?.querySelector(
      '[data-radix-scroll-area-viewport]'
    ) as HTMLElement | null;
    const observer = new IntersectionObserver(
      (obsEntries) => {
        if (obsEntries[0]?.isIntersecting) {
          setVisibleCount((c) => Math.min(c + PAGE_SIZE, filteredEntries.length));
        }
      },
      { root: viewport ?? null, rootMargin: '240px 0px' }
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [open, loading, hasMore, filteredEntries.length]);

  const groupedEntries = visibleEntries.reduce((groups, entry) => {
    const key = format(new Date(entry.date), 'yyyy-MM-dd');
    if (!groups[key]) groups[key] = [];
    groups[key].push(entry);
    return groups;
  }, {} as Record<string, LedgerEntry[]>);

  const breakdownItems = Object.entries(breakdown).filter(([, v]) => v > 0);

  // ── Role-based highlights (computed from filtered entries) ──
  const highlightConfig = (role && ROLE_HIGHLIGHTS[role]) || DEFAULT_HIGHLIGHT;
  const highlightTotals = highlightConfig.categories
    .map((cat) => {
      const rows = filteredEntries.filter((e) => e.category === cat);
      if (rows.length === 0) return null;
      const inSum = rows.filter((e) => e.type === 'credit').reduce((s, e) => s + e.amount, 0);
      const outSum = rows.filter((e) => e.type === 'debit').reduce((s, e) => s + e.amount, 0);
      const net = inSum - outSum;
      const meta = getCategoryMeta(cat, net >= 0 ? 'cash_in' : 'cash_out');
      return { cat, count: rows.length, inSum, outSum, net, ...meta };
    })
    .filter((x): x is NonNullable<typeof x> => x !== null);

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          className={`relative gap-2 text-xs font-semibold text-[#9A4DE7] border-primary-foreground/30 hover:bg-primary-foreground/10 hover:text-white ${
            newActivityCount > 0 ? 'animate-pulse ring-2 ring-warning/60' : ''
          }`}
          aria-label={
            newActivityCount > 0
              ? `Wallet Statement — ${newActivityCount} new ${newActivityCount === 1 ? 'activity' : 'activities'}`
              : 'Wallet Statement'
          }
        >
          <FileText className="h-3.5 w-3.5" />
          Statement
          {newActivityCount > 0 && (
            <Badge className="absolute -top-2 -right-2 h-5 min-w-[20px] px-1 flex items-center justify-center text-[10px] font-bold bg-warning text-warning-foreground border border-background shadow">
              {newActivityCount > 99 ? '99+' : newActivityCount}
            </Badge>
          )}
        </Button>
      </SheetTrigger>

      <SheetContent
        side="bottom"
        className="h-[92vh] rounded-t-3xl p-0 flex flex-col"
      >
        <SheetHeader className="px-5 pt-5 pb-4 border-b shrink-0">
          <div className="flex items-center justify-between">
            <div>
              <SheetTitle className="text-xl font-bold flex items-center gap-2">
                <ArrowUpDown className="h-5 w-5 text-primary" aria-hidden="true" />
                Wallet Statement
              </SheetTitle>
              <p className="text-xs text-muted-foreground">All money in & out of your wallet</p>
            </div>
            <div className="flex items-center gap-2">
              <Button
                size="sm"
                variant={a11yMode ? 'default' : 'outline'}
                onClick={toggleA11y}
                aria-pressed={a11yMode}
                aria-label={a11yMode ? 'Turn off larger text and higher contrast' : 'Turn on larger text and higher contrast'}
                className="gap-1.5 text-xs font-semibold min-h-11"
                title={a11yMode ? 'Easy-read mode: ON' : 'Easy-read mode: OFF'}
              >
                <Eye className="h-3.5 w-3.5" aria-hidden="true" />
                {a11yMode ? 'Easy Read: On' : 'Easy Read'}
              </Button>
              {a11yMode && (
                <div
                  role="radiogroup"
                  aria-label="Easy-read text size"
                  className="inline-flex items-center rounded-md border border-primary/30 overflow-hidden"
                >
                  {([
                    { v: 0 as const, label: 'M', title: 'Medium text' },
                    { v: 1 as const, label: 'L', title: 'Large text' },
                    { v: 2 as const, label: 'XL', title: 'Extra-large text' },
                  ]).map((opt) => {
                    const active = a11ySize === opt.v;
                    return (
                      <button
                        key={opt.v}
                        type="button"
                        role="radio"
                        aria-checked={active}
                        aria-label={`${opt.title}`}
                        title={opt.title}
                        onClick={() => setA11ySize(opt.v)}
                        className={`px-2.5 py-1 text-xs font-semibold transition ${
                          active ? 'bg-primary text-primary-foreground' : 'bg-background text-primary hover:bg-primary/10'
                        }`}
                      >
                        {opt.label}
                      </button>
                    );
                  })}
                </div>
              )}
              <Button
                size="sm"
                variant="outline"
                onClick={exportToCSV}
                disabled={loading || filteredEntries.length === 0}
                className="gap-1.5 text-xs font-semibold border-primary/30 text-primary hover:bg-primary/10"
                title={`Download CSV · ${filterSummary}`}
                aria-label={`Download wallet statement as CSV. Filters applied: ${filterSummary}`}
              >
                <FileSpreadsheet className="h-3.5 w-3.5" aria-hidden="true" />
                CSV
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={exportToPDF}
                disabled={exporting || loading || filteredEntries.length === 0}
                className="gap-1.5 text-xs font-semibold border-primary/30 text-primary hover:bg-primary/10"
                title={`Download PDF · ${filterSummary}`}
                aria-label={exporting ? 'Generating PDF, please wait' : `Download wallet statement as PDF. Filters applied: ${filterSummary}`}
                aria-busy={exporting}
              >
                {exporting ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" /> : <Download className="h-3.5 w-3.5" aria-hidden="true" />}
                PDF
              </Button>
            </div>
          </div>
        </SheetHeader>

        {loading ? (
          <div className="space-y-4 p-5">
            <Skeleton className="h-24 w-full rounded-2xl" />
            <Skeleton className="h-16 w-full rounded-xl" />
            <Skeleton className="h-16 w-full rounded-xl" />
            <Skeleton className="h-16 w-full rounded-xl" />
          </div>
        ) : (
          <ScrollArea ref={scrollRootRef} className="flex-1 px-4 py-4" aria-label="Wallet statement content">

            {/* ── Hero: Net Balance ── */}
            <section aria-labelledby="ws-net-balance" className="mb-4 rounded-2xl border bg-card p-5">
              <h3 id="ws-net-balance" className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Net Balance</h3>
              <p
                className={`mt-1 text-3xl font-extrabold tracking-tight tabular-nums ${
                totals.totalIn - totals.totalOut >= 0 ? 'text-foreground' : 'text-destructive'
              }`}
                aria-label={`Net balance ${formatUGX(Math.max(0, totals.totalIn - totals.totalOut))}`}
              >
                {formatUGX(Math.max(0, totals.totalIn - totals.totalOut))}
              </p>
              <div className="mt-4 grid grid-cols-2 gap-3">
                <div className="rounded-xl bg-success/10 px-3 py-2.5">
                  <div className="flex items-center gap-1.5 text-success">
                    <TrendingUp className="h-3.5 w-3.5" aria-hidden="true" />
                    <span className="text-[10px] font-semibold uppercase tracking-wide">Money In</span>
                  </div>
                  <p className="mt-0.5 text-sm font-bold text-success tabular-nums" aria-label={`Money in total ${formatUGX(totals.totalIn)}`}>+{formatUGX(totals.totalIn)}</p>
                </div>
                <div className="rounded-xl bg-destructive/10 px-3 py-2.5">
                  <div className="flex items-center gap-1.5 text-destructive">
                    <TrendingDown className="h-3.5 w-3.5" aria-hidden="true" />
                    <span className="text-[10px] font-semibold uppercase tracking-wide">Money Out</span>
                  </div>
                  <p className="mt-0.5 text-sm font-bold text-destructive tabular-nums" aria-label={`Money out total ${formatUGX(totals.totalOut)}`}>-{formatUGX(totals.totalOut)}</p>
                </div>
              </div>
            </section>

            {/* ── Role-based highlights ── */}
            {highlightTotals.length > 0 && (
              <section aria-labelledby="ws-highlights" className="mb-4 rounded-2xl border bg-card p-4">
                <div className="mb-3 flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <h3 id="ws-highlights" className="text-[11px] font-semibold uppercase tracking-wider text-primary">
                      {highlightConfig.title}
                    </h3>
                    <p className="mt-0.5 text-[11px] text-muted-foreground">{highlightConfig.subtitle}</p>
                  </div>
                  {role && (
                    <Badge variant="secondary" className="shrink-0 text-[10px] capitalize">
                      {role.replace(/_/g, ' ')}
                    </Badge>
                  )}
                </div>
                <div className="grid grid-cols-1 gap-2 sm:grid-cols-2" role="group" aria-label="Category quick filters">
                  {highlightTotals.map((h) => {
                    const isPositive = h.net >= 0;
                    const selected = categoryFilter === h.cat;
                    return (
                      <button
                        key={h.cat}
                        type="button"
                        onClick={() => {
                          setCategoryFilter(h.cat === categoryFilter ? 'all' : h.cat);
                          setShowCategoryFilters(true);
                        }}
                        aria-pressed={selected}
                        aria-label={`${selected ? 'Remove' : 'Apply'} filter for ${h.label}. ${h.count} ${h.count === 1 ? 'entry' : 'entries'}, net ${isPositive ? 'plus' : 'minus'} ${formatUGX(Math.abs(h.net))}`}
                        className={`flex items-center gap-2.5 rounded-xl border px-3 py-2.5 text-left transition-colors hover:bg-muted/40 ${
                          selected ? 'border-primary bg-primary/5' : 'border-border'
                        }`}
                      >
                        <div className={`h-8 w-8 shrink-0 rounded-full flex items-center justify-center ${h.colorClass}`} aria-hidden="true">
                          <h.Icon className="h-4 w-4" aria-hidden="true" />
                        </div>
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-xs font-semibold text-foreground">{h.label}</p>
                          <p className="text-[10px] text-muted-foreground">{h.count} {h.count === 1 ? 'entry' : 'entries'}</p>
                        </div>
                        <p className={`shrink-0 text-sm font-bold tabular-nums ${isPositive ? 'text-success' : 'text-destructive'}`}>
                          {isPositive ? '+' : '-'}{formatUGX(Math.abs(h.net))}
                        </p>
                      </button>
                    );
                  })}
                </div>
              </section>
            )}

            {/* ── Earnings from your sub-agents ── */}
            {subAgentEarnings.length > 0 && (
              <section aria-labelledby="ws-subagent" className="mb-4 overflow-hidden rounded-2xl border bg-card">
                <div className="flex items-start justify-between gap-3 border-b bg-primary/5 px-4 py-3">
                  <div className="min-w-0">
                    <h3 id="ws-subagent" className="flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-wider text-primary">
                      <Users className="h-3.5 w-3.5" aria-hidden="true" />
                      Earnings from your sub-agents
                    </h3>
                    <p className="mt-0.5 text-[11px] text-muted-foreground">
                      Who earned you money, what they did, and how much.
                    </p>
                  </div>
                  <div className="shrink-0 text-right">
                    <p className="text-sm font-bold text-success tabular-nums">
                      +{formatUGX(subAgentEarnings.reduce((s, r) => s + r.amount, 0))}
                    </p>
                    <p className="text-[10px] text-muted-foreground">{subAgentEarnings.length} {subAgentEarnings.length === 1 ? 'earning' : 'earnings'}</p>
                  </div>
                </div>
                <ul className="divide-y divide-border/60 list-none p-0 m-0">
                  {subAgentEarnings.map((row) => (
                    <li key={row.key} className="flex items-center gap-3 px-4 py-3">
                      <div className="h-9 w-9 shrink-0 rounded-full bg-primary/10 text-primary flex items-center justify-center" aria-hidden="true">
                        <Users className="h-4 w-4" aria-hidden="true" />
                      </div>
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-semibold text-foreground">{row.subAgentName}</p>
                        <p className="mt-0.5 text-[11px] text-muted-foreground">{row.action}</p>
                        <p className="mt-0.5 text-[10px] text-muted-foreground/80">{format(new Date(row.date), 'MMM d, yyyy · h:mm a')}</p>
                      </div>
                      <div className="shrink-0 text-right">
                        <p className="text-sm font-bold text-success tabular-nums">+{formatUGX(row.amount)}</p>
                        {row.landed ? (
                          <span className="inline-flex items-center gap-0.5 text-[10px] font-medium text-success">
                            <CheckCircle2 className="h-3 w-3" aria-hidden="true" /> Withdrawable
                          </span>
                        ) : (
                          <span className="text-[10px] text-muted-foreground">Pending credit</span>
                        )}
                      </div>
                    </li>
                  ))}
                </ul>
              </section>
            )}

            {/* ── Income Breakdown (collapsed by default) ── */}
            {breakdownItems.length > 0 && (
              <div className="mb-4 overflow-hidden rounded-xl border">
                <button
                  type="button"
                  onClick={() => setShowBreakdown(v => !v)}
                  aria-expanded={showBreakdown}
                  aria-controls="ws-income-breakdown"
                  className="flex w-full items-center justify-between px-4 py-3 hover:bg-muted/40"
                >
                  <span className="text-xs font-bold uppercase tracking-wider text-muted-foreground">Income Breakdown</span>
                  {showBreakdown
                    ? <ChevronUp className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
                    : <ChevronDown className="h-4 w-4 text-muted-foreground" aria-hidden="true" />}
                </button>
                {showBreakdown && (
                  <div id="ws-income-breakdown" className="divide-y divide-border/50 border-t" role="region" aria-label="Income breakdown by category">
                    {breakdownItems.map(([category, amount]) => {
                      const { label, Icon, colorClass } = getCategoryMeta(category, 'cash_in');
                      return (
                        <div key={category} className="flex items-center justify-between px-4 py-2.5">
                          <div className="flex items-center gap-2.5">
                            <div className={`h-7 w-7 rounded-full flex items-center justify-center ${colorClass}`} aria-hidden="true">
                              <Icon className="h-3.5 w-3.5" aria-hidden="true" />
                            </div>
                            <span className="text-sm text-muted-foreground">{label}</span>
                          </div>
                          <span className="font-mono text-sm font-semibold text-success tabular-nums" aria-label={`${label} total ${formatUGX(amount)}`}>+{formatUGX(amount)}</span>
                        </div>
                      );
                    })}
                    <div className="flex justify-between bg-success/5 px-4 py-2.5 font-bold">
                      <span className="text-sm">Total Earned</span>
                      <span className="font-mono text-sm text-success tabular-nums" aria-label={`Total earned ${formatUGX(totals.totalIn)}`}>+{formatUGX(totals.totalIn)}</span>
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* ── Transaction history (shared canonical feed UI) ── */}
            <section className="space-y-3" aria-labelledby="ws-tx-history">
              <h3 id="ws-tx-history" className="text-[11px] font-bold uppercase tracking-wider text-muted-foreground">
                Transaction History
              </h3>
              <TransactionsFeed userId={user?.id} balanceAfterById={balanceAfterById} />
            </section>

          </ScrollArea>
        )}
      </SheetContent>
    </Sheet>
  );
}
