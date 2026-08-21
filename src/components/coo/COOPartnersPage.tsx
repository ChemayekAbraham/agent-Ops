import { useEffect, useState, useCallback, useMemo, useRef } from 'react';
import * as AlertDialogPrimitive from '@radix-ui/react-alert-dialog';
import { supabase } from '@/integrations/supabase/client';
import { formatUGX } from '@/lib/rentCalculations';
import { MIN_INVEST, MAX_INVEST, investHelperRange, isInvestAmountValid } from '@/lib/partnershipInvestment';
import { toast } from '@/components/ui/sonner';
import { cn } from '@/lib/utils';
import { extractFromErrorObject } from '@/lib/extractEdgeFunctionError';
import {
  dateOnlyToLocalDate,
  dateOnlyToUtcMiddayIso,
  extractDateOnly,
  formatDateOnlyForDisplay,
  formatLocalDateOnly,
  buildCompoundProjection,
} from '@/lib/portfolioDates';
import {
  Loader2, Search, X, Download, ChevronLeft, ChevronRight, ChevronUp, ChevronDown,
  ChevronsUpDown, MoreHorizontal, TrendingUp, Pencil, Wallet, Ban, PlayCircle,
  Users, Banknote, PiggyBank, ArrowUpRight, Filter, RefreshCw, Phone, Calendar as CalendarIcon,
  CalendarDays, Shield, CheckCircle2, Clock, Briefcase, Save, Upload, Trash2,
  Plus, FileText, Share2, ArrowRightLeft, ShieldCheck, Handshake, Scissors, Info,
  Mail, MailCheck, MailX, MailWarning, Sparkles, Hourglass, CalendarClock, AlertTriangle, Lock
} from 'lucide-react';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { format } from 'date-fns';
import { Calendar } from '@/components/ui/calendar';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { downloadPortfolioPdf, sharePortfolioViaWhatsApp, type PortfolioPdfData } from '@/lib/portfolioPdf';
import { generateNearingPayoutsPdf, downloadBlob as downloadNearingBlob } from '@/lib/nearingPayoutsPdf';
import { sharePayoutCardViaWhatsApp, type PayoutCardData } from '@/lib/payoutShareCard';
import { fetchAllUserIdsByRole, batchedQuery, fetchPaginatedSupporterIds, fetchVerifiedFundedProspectIds, fetchSupporterSummary, fetchAllNearingPayoutPortfolios } from '@/lib/supabaseBatchUtils';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger, DropdownMenuSeparator, DropdownMenuLabel
} from '@/components/ui/dropdown-menu';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter
} from '@/components/ui/dialog';
import { Textarea } from '@/components/ui/textarea';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
  AlertDialogPortal, AlertDialogOverlay,
} from '@/components/ui/alert-dialog';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue
} from '@/components/ui/select';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Separator } from '@/components/ui/separator';
import { Slider } from '@/components/ui/slider';
import PartnerImportDialog from './PartnerImportDialog';
import UpdateContributionDatesDialog from './UpdateContributionDatesDialog';
import PartnerPaymentDetailsDialog from './PartnerPaymentDetailsDialog';
import { PortfolioTopUpsCard } from './PortfolioTopUpsCard';
import { PendingPortfoliosCard } from '@/components/executive/PendingPortfoliosCard';
import { PendingPortfoliosQueue } from '@/components/executive/PendingPortfoliosQueue';


/** Roll a stale next_roi_date forward month-by-month until it's >= today */
function getNextPayoutDate(nextRoiDate: string | null, createdAt: string, payoutDay: number): string {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const createdDateOnly = extractDateOnly(createdAt);
  const createdDate = createdDateOnly ? dateOnlyToLocalDate(createdDateOnly) : new Date(createdAt);
  const day = Math.min(payoutDay || createdDate.getDate(), 28);

  let d: Date;
  if (nextRoiDate) {
    d = dateOnlyToLocalDate(nextRoiDate);
  } else {
    // Walk forward from creation in monthly hops until we land on today or the future.
    // This covers portfolios whose `next_roi_date` was never written: their first payout
    // is created_at + 1 month on `payout_day`, and subsequent ones are monthly thereafter.
    d = new Date(createdDate.getFullYear(), createdDate.getMonth() + 1, day);
    while (d.getTime() < today.getTime()) {
      d = new Date(d.getFullYear(), d.getMonth() + 1, day);
    }
  }
  // Do NOT roll forward — preserve the actual stored date so overdue/missed dates remain visible.
  // Date only advances when CFO approves the payout.
  return formatLocalDateOnly(d);
}

/** Single source of truth for "is this portfolio's Next Payout Date today?".
 *  Compares YYYY-MM-DD strings in local TZ — DST/midnight safe. */
function isPortfolioDueToday(p: { next_roi_date: string | null; created_at: string; payout_day: number | null }): boolean {
  const next = getNextPayoutDate(p.next_roi_date, p.created_at, p.payout_day ?? 15);
  return next === formatLocalDateOnly(new Date());
}
import { RenewPortfolioDialog } from '@/components/manager/RenewPortfolioDialog';
import { FundInvestmentAccountDialog } from '@/components/manager/FundInvestmentAccountDialog';
import { CreateInvestmentAccountDialog } from '@/components/manager/CreateInvestmentAccountDialog';
import { InvitePartnerPortfolioDialog } from '@/components/partner/InvitePartnerPortfolioDialog';
import { LockPortfolioDialog, type LockablePortfolio } from '@/components/partner/LockPortfolioDialog';

/* ─── Types ─── */
interface PartnerRow {
  id: string;
  name: string;
  phone: string;
  email: string;
  funded: number;
  activeDeals: number;
  avgDeal: number;
  walletBalance: number;
  roiPercentage: number;
  payoutDay: number;
  roiMode: string;
  status: 'active' | 'suspended';
  joinedAt: string;
  lastActivity: string;
  nextRoiDate: string | null;
  payoutDates?: string[];
  isProspect?: boolean;
}

interface NearingPayoutPortfolio {
  portfolioId: string;
  investorId: string;
  name: string;
  portfolioName: string;
  phone: string;
  email: string;
  investmentAmount: number;
  roiPercentage: number;
  payoutDay: number;
  roiMode: string;
  createdAt: string;
  daysUntil: number;
  nextPayoutDate: string;
  dueToday: boolean;
  durationMonths: number;
  nextRoiDate: string | null;
  /** True once this portfolio's ROI for the current cycle is credited OR sitting in the approval queue. */
  alreadyProcessedThisCycle?: boolean;
  /** How it was already handled this cycle — drives the badge label. */
  processedState?: 'credited' | 'pending' | null;
  status?: string | null;
  paymentMethod?: 'mobile_money' | 'bank_transfer' | 'cash' | null;
  mobileNetwork?: string | null;
  mobileMoneyNumber?: string | null;
  bankName?: string | null;
  bankAccountName?: string | null;
  accountNumber?: string | null;
}

interface PortfolioRow {
  id: string;
  portfolio_code: string;
  account_name: string | null;
  investment_amount: number;
  roi_percentage: number;
  payout_day: number;
  roi_mode: string;
  status: string;
  created_at: string;
  maturity_date: string | null;
  total_roi_earned: number;
  duration_months: number;
  next_roi_date: string | null;
  investor_id: string | null;
  agent_id: string;
  payment_method?: 'mobile_money' | 'bank_transfer' | 'cash' | null;
  mobile_network?: 'MTN' | 'Airtel' | null;
  mobile_money_number?: string | null;
  bank_name?: string | null;
  bank_account_name?: string | null;
  account_number?: string | null;
  // Scheduled auto-renewal fields — when set, the portfolio is locked from
  // manual edits/top-ups/renews until the pending renewal takes effect and
  // the cron clears these fields.
  pending_renewal_effective_date?: string | null;
  pending_renewal_duration_months?: number | null;
}

interface PartnerDetail {
  profile: {
    id: string;
    full_name: string;
    phone: string;
    email: string | null;
    created_at: string;
    frozen_at: string | null;
    frozen_reason: string | null;
    funder_verified_at: string | null;
    signup_source: string | null;
  };
  walletBalance: number;
  withdrawableBalance: number;
  floatBalance: number;
  totalFunded: number;
  totalDeals: number;
  totalROIEarned: number;
  portfolios: PortfolioRow[];
 }

/**
 * Self-managed (Self Portfolio Management) commitment. These live in
 * `partner_self_commitments` / `partner_self_funding_lines`, NOT in
 * `investor_portfolios`, so Partner Ops has to read them separately or a
 * partner who supported tenants directly looks like they hold nothing.
 */
interface SelfCommitmentRow {
  id: string;
  committed_amount: number;
  term_months: number;
  monthly_rate: number;
  lines_count: number;
  status: string;
  payout_day: number | null;
  next_payout_at: string | null;
  term_end_at: string | null;
  total_earned: number;
  total_paid: number;
  created_at: string;
  lines: {
    id: string;
    rent_request_id: string;
    principal: number;
    status: string;
    tenant_name?: string | null;
  }[];
}

/**
 * A partner is CLEARED to receive portfolio top-ups / wallet→portfolio
 * transfers when they are EITHER explicitly verified (`funder_verified_at`)
 * OR they are a legacy partner who predates the self-registration
 * (`/partner-onboarding`) verification flow. Only self-registered funders
 * (`signup_source = 'funder-onboarding'`) require an explicit verification.
 *
 * This mirrors `useFunderApprovalStatus` and the server-side gates in the
 * `coo-create-portfolio` / `coo-invest-for-partner` edge functions and the
 * `enforce_funder_verified_for_portfolio` DB trigger — so the UI never
 * blocks a partner the backend would actually allow.
 */
const SELF_REG_SOURCE = 'funder-onboarding';
function isFunderCleared(
  p?: { funder_verified_at?: string | null; signup_source?: string | null } | null,
): boolean {
  if (!p) return false;
  if (p.funder_verified_at) return true;          // explicitly verified
  return p.signup_source !== SELF_REG_SOURCE;      // legacy partner → always cleared
}

interface SummaryData {
  totalPartners: number;
  activePartners: number;
  suspendedPartners: number;
  totalFunded: number;
  totalWalletBalance: number;
  avgROI: number;
  totalDeals: number;
  topPartnerName: string;
}

const PAGE_SIZE = 15;

/* ─── Helpers ─── */
function getOrdinalSuffix(day: number): string {
  if (day >= 11 && day <= 13) return 'th';
  switch (day % 10) {
    case 1: return 'st';
    case 2: return 'nd';
    case 3: return 'rd';
    default: return 'th';
  }
}

/** Portfolio shape needed for the deal-breakdown CSV export. */
interface ExportPortfolio {
  id: string;
  investor_id: string | null;
  agent_id: string | null;
  account_name: string | null;
  portfolio_code: string | null;
  investment_amount: number;
  roi_percentage: number;
  total_roi_earned: number | null;
  payout_day: number;
  roi_mode: string;
  next_roi_date: string | null;
  created_at: string;
}

function csvEscape(v: unknown): string {
  return `"${String(v ?? '').replace(/"/g, '""')}"`;
}

function exportPortfolioName(p: ExportPortfolio): string {
  return (p.account_name?.trim() || p.portfolio_code || 'Portfolio').trim();
}

/** ROI mode with underscores swapped for spaces (e.g. monthly_payout → "monthly payout"). */
function humanRoiMode(mode: string): string {
  return (mode || '').replace(/_/g, ' ').trim();
}

/** "12 Jun 2026 - 7 days" style payout cell (date + days until next payout). */
function buildPayoutCell(nextRoiDate: string | null, createdAt: string, payoutDay: number): string {
  const dateStr = getNextPayoutDate(nextRoiDate, createdAt, payoutDay); // YYYY-MM-DD
  const human = formatDateOnlyForDisplay(dateStr);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const d = dateOnlyToLocalDate(dateStr);
  const days = Math.round((d.getTime() - today.getTime()) / 86400000);
  const daysLabel =
    days === 0 ? 'Today'
    : days > 0 ? `${days} day${days === 1 ? '' : 's'}`
    : `${Math.abs(days)} day${Math.abs(days) === 1 ? '' : 's'} overdue`;
  return `${human} - ${daysLabel}`;
}

/**
 * Build & download the partners CSV with per-deal (portfolio) breakdown.
 * - Rows sorted by partner name ascending.
 * - Partners with more than one deal are split into one row per portfolio,
 *   named "{{PartnerName}} ({{PortfolioName}})".
 * - Joined date is human-readable; ROI Mode uses spaces (no underscores).
 */
function exportToCSV(rows: PartnerRow[], portfolios: ExportPortfolio[]) {
  const supporterIdSet = new Set(rows.map(r => r.id));
  const byOwner = new Map<string, ExportPortfolio[]>();
  portfolios.forEach(p => {
    const ownerId = p.investor_id && supporterIdSet.has(p.investor_id)
      ? p.investor_id
      : p.agent_id && supporterIdSet.has(p.agent_id)
        ? p.agent_id
        : null;
    if (!ownerId) return;
    const arr = byOwner.get(ownerId) || [];
    arr.push(p);
    byOwner.set(ownerId, arr);
  });

  const header = [
    'Name', 'Phone', 'Email', 'Status', 'Wallet',
    'Principal', 'ROI %', 'Returns', 'ROI Mode', 'Payout Day & Date', 'Joined',
  ];

  const sortedRows = [...rows].sort((a, b) =>
    (a.name || '').localeCompare(b.name || '', undefined, { sensitivity: 'base' })
  );

  const csvRows: string[] = [];
  sortedRows.forEach(r => {
    const statusLabel = r.status === 'suspended' ? 'Suspended' : 'Active';
    const joined = r.joinedAt ? formatDateOnlyForDisplay(r.joinedAt) : '';
    const ports = (byOwner.get(r.id) || []).slice().sort((a, b) =>
      exportPortfolioName(a).localeCompare(exportPortfolioName(b), undefined, { sensitivity: 'base' })
    );

    if (ports.length === 0) {
      csvRows.push([
        r.name, r.phone, r.email, statusLabel, r.walletBalance,
        '', '', '', '', '', joined,
      ].map(csvEscape).join(','));
      return;
    }

    ports.forEach(p => {
      const name = ports.length > 1 ? `${r.name} (${exportPortfolioName(p)})` : r.name;
      // Returns = Principal × ROI%
      const returns = Math.round((p.investment_amount ?? 0) * ((p.roi_percentage ?? 0) / 100));
      csvRows.push([
        name, r.phone, r.email, statusLabel, r.walletBalance,
        p.investment_amount ?? 0,
        p.roi_percentage ?? '',
        returns,
        humanRoiMode(p.roi_mode),
        buildPayoutCell(p.next_roi_date, p.created_at, p.payout_day ?? 15),
        p.created_at ? formatDateOnlyForDisplay(p.created_at) : joined,
      ].map(csvEscape).join(','));
    });
  });

  const csv = [header.map(csvEscape).join(','), ...csvRows].join('\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'partners-export.csv';
  a.click();
  URL.revokeObjectURL(url);
}

function formatDate(d: string | null) {
  return formatDateOnlyForDisplay(d);
}

function timeSince(d: string) {
  const diff = Date.now() - new Date(d).getTime();
  const days = Math.floor(diff / 86400000);
  if (days === 0) return 'Today';
  if (days === 1) return 'Yesterday';
  if (days < 30) return `${days}d ago`;
  if (days < 365) return `${Math.floor(days / 30)}mo ago`;
  return `${Math.floor(days / 365)}y ago`;
}

/* ─── Main Component ─── */
export default function COOPartnersPage({ readOnly = false }: { readOnly?: boolean } = {}) {
  const [rows, setRows] = useState<PartnerRow[]>([]);
  const [summary, setSummary] = useState<SummaryData | null>(null);
  // Wallet Balances breakdown dialog (all partners holding wallet money)
  const [walletBalancesOpen, setWalletBalancesOpen] = useState(false);
  const [walletBalancesSearch, setWalletBalancesSearch] = useState('');
  const [walletBalancesLoading, setWalletBalancesLoading] = useState(false);
  const [walletBalancesList, setWalletBalancesList] = useState<{ id: string; name: string; phone: string; email: string; balance: number }[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isSearching, setIsSearching] = useState(false);
  const [totalCount, setTotalCount] = useState(0);
  const [debouncedSearch, setDebouncedSearch] = useState('');

  // Table state
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(0);
  const [sortKey, setSortKey] = useState<string | null>('funded');
  const [sortDir, setSortDir] = useState<'asc' | 'desc' | null>('desc');
  const [filterStatus, setFilterStatus] = useState<'all' | 'active' | 'suspended'>('all');
  const [filterRoiMode, setFilterRoiMode] = useState<'all' | 'monthly_payout' | 'monthly_compounding'>('all');
  const [filterContact, setFilterContact] = useState<'all' | 'has_phone' | 'no_phone' | 'has_email' | 'no_email'>('all');
  const [filterWallet, setFilterWallet] = useState<'all' | 'has_balance' | 'empty'>('all');
  // Prospect mode: when 'prospects_only', the table swaps its data source to
  // verified, wallet-funded users who don't own a portfolio yet.
  const [filterProspect, setFilterProspect] = useState<'all' | 'prospects_only'>('all');
  const [payoutDateFrom, setPayoutDateFrom] = useState<Date | undefined>(undefined);
  const [payoutDateTo, setPayoutDateTo] = useState<Date | undefined>(undefined);
  // When a payout date range is active we need to filter across ALL partners,
  // not just the current server-paginated page. We lazily fetch the full set
  // (scoped to the current search term) and cache it here.
  const [allRowsForPayoutFilter, setAllRowsForPayoutFilter] = useState<PartnerRow[] | null>(null);
  const [loadingAllRowsForPayout, setLoadingAllRowsForPayout] = useState(false);

  // Invest dialog
  const [investPartner, setInvestPartner] = useState<PartnerRow | null>(null);
  const [investAmount, setInvestAmount] = useState('');
  const [investing, setInvesting] = useState(false);

  // Edit dialog
  const [editPartner, setEditPartner] = useState<PartnerRow | null>(null);
  const [editRoi, setEditRoi] = useState('');
  const [editRoiMode, setEditRoiMode] = useState('monthly_payout');
  const [editName, setEditName] = useState('');
  const [editPhone, setEditPhone] = useState('');

  // Partner payment details dialog
  const [paymentDetailsOpen, setPaymentDetailsOpen] = useState(false);
  const [paymentDetailsPortfolio, setPaymentDetailsPortfolio] = useState<any | null>(null);
  const [saving, setSaving] = useState(false);

  // Suspend dialog
  const [suspendPartner, setSuspendPartner] = useState<PartnerRow | null>(null);
  const [suspending, setSuspending] = useState(false);

  // Delete partner dialog
  const [deletePartnerTarget, setDeletePartnerTarget] = useState<PartnerRow | null>(null);
  const [deletePartnerReason, setDeletePartnerReason] = useState('');
  const [deletingPartner, setDeletingPartner] = useState(false);

  // Partner Detail view
  const [detailPartner, setDetailPartner] = useState<PartnerDetail | null>(null);
  const [detailSelfCommitments, setDetailSelfCommitments] = useState<SelfCommitmentRow[]>([]);
  const [expandedSelfTenants, setExpandedSelfTenants] = useState<Record<string, boolean>>({});
  const [detailLoading, setDetailLoading] = useState(false);
  const [editingPortfolioId, setEditingPortfolioId] = useState<string | null>(null);
  const [editingPayoutDay, setEditingPayoutDay] = useState('');
  const [savingPortfolio, setSavingPortfolio] = useState(false);
  const [editingNextPayoutId, setEditingNextPayoutId] = useState<string | null>(null);
  const [editingNextPayoutDate, setEditingNextPayoutDate] = useState('');

  // Edit portfolio dialog
  const [editPortfolio, setEditPortfolio] = useState<PortfolioRow | null>(null);
  const [editPortfolioAmount, setEditPortfolioAmount] = useState('');
  const [editPortfolioRoi, setEditPortfolioRoi] = useState('');
  const [editPortfolioRoiMode, setEditPortfolioRoiMode] = useState('monthly_payout');

  // Nearing payouts dialog
  const [nearingPayoutsOpen, setNearingPayoutsOpen] = useState(false);
  const [allPortfoliosForPayout, setAllPortfoliosForPayout] = useState<NearingPayoutPortfolio[]>([]);
  const [expiringPortfoliosOpen, setExpiringPortfoliosOpen] = useState(false);
  const [pendingPortfoliosOpen, setPendingPortfoliosOpen] = useState(false);
  const [editPortfolioDuration, setEditPortfolioDuration] = useState('');
  const [editPortfolioStatus, setEditPortfolioStatus] = useState('');
  const [editPortfolioDate, setEditPortfolioDate] = useState('');
  const [savingEditPortfolio, setSavingEditPortfolio] = useState(false);

  // Import dialog
  const [importOpen, setImportOpen] = useState(false);
  const [updateDatesOpen, setUpdateDatesOpen] = useState(false);

  // Delete portfolio dialog
  const [deletePortfolio, setDeletePortfolio] = useState<PortfolioRow | null>(null);
  const [deleteReason, setDeleteReason] = useState('');
  const [deleting, setDeleting] = useState(false);

  // Renew portfolio dialog
  const [renewPortfolio, setRenewPortfolio] = useState<PortfolioRow | null>(null);
  const [renewOpen, setRenewOpen] = useState(false);
  // Lock portfolio dialog (full principal or split)
  const [lockPortfolio, setLockPortfolio] = useState<LockablePortfolio | null>(null);
  const [lockOpen, setLockOpen] = useState(false);
  const [renewalCounts, setRenewalCounts] = useState<Record<string, number>>({});
  const [pendingRedemptions, setPendingRedemptions] = useState<Record<string, boolean>>({});
  const [recentRenewals, setRecentRenewals] = useState<Record<string, string>>({});

  // Bulk activate
  const [activatingAll, setActivatingAll] = useState(false);
  const [pendingApprovalCount, setPendingApprovalCount] = useState(0);
  const [showActivateConfirm, setShowActivateConfirm] = useState(false);

  // Wallet top-up dialog (external deposit)
  const [topUpPortfolio, setTopUpPortfolio] = useState<PortfolioRow | null>(null);
  const [topUpOpen, setTopUpOpen] = useState(false);

  // Wallet → Portfolio transfer dialog
  const [walletToPortfolio, setWalletToPortfolio] = useState<PortfolioRow | null>(null);
  const [walletToPortfolioAmount, setWalletToPortfolioAmount] = useState('');
  const [walletToPortfolioReason, setWalletToPortfolioReason] = useState('');
  const [walletToPortfolioSaving, setWalletToPortfolioSaving] = useState(false);
  const [walletTransferMethod, setWalletTransferMethod] = useState<'wallet' | 'proxy_agent'>('wallet');
  const [walletTransferFundSource, setWalletTransferFundSource] = useState<'withdrawable' | 'float'>('withdrawable');
  const [proxyAgentInfo, setProxyAgentInfo] = useState<{ agentId: string; agentName: string; walletBalance: number; withdrawable?: number; float?: number } | null>(null);
  const [loadingProxyAgent, setLoadingProxyAgent] = useState(false);

  // Pending top-ups per portfolio (status: pending)
  const [pendingTopUps, setPendingTopUps] = useState<Record<string, { count: number; total: number }>>({});
  // Top-ups awaiting Financial Ops verification (status: awaiting_verification)
  const [awaitingVerification, setAwaitingVerification] = useState<Record<string, { count: number; total: number }>>({});
  // Top-ups approved and parked until next ROI cycle (status: approved)
  const [approvedTopUps, setApprovedTopUps] = useState<Record<string, { count: number; total: number }>>({});
  // Top-ups automatically merged into principal at the ROI cycle
  // (status: completed, metadata.auto_applied_at_roi_cycle: true). Surfaced as a
  // green "✅ Auto-applied" badge so COO knows the parked capital is now active.
  const [autoAppliedTopUps, setAutoAppliedTopUps] = useState<Record<string, { count: number; total: number }>>({});
  const [applyingTopUps, setApplyingTopUps] = useState<string | null>(null);
  // Merge dialog state
  const [mergeDialogPortfolioId, setMergeDialogPortfolioId] = useState<string | null>(null);
  const [mergeReason, setMergeReason] = useState('');
  const [mergingTopUp, setMergingTopUp] = useState(false);
  const [cancelDialogPortfolioId, setCancelDialogPortfolioId] = useState<string | null>(null);
  const [cancelReason, setCancelReason] = useState('');
  const [cancellingTopUp, setCancellingTopUp] = useState(false);

  // Portfolio name editing
  const [editingNameId, setEditingNameId] = useState<string | null>(null);
  const [editingNameValue, setEditingNameValue] = useState('');
  const [savingName, setSavingName] = useState(false);

  // Add portfolio dialog (within partner detail)
  const [addPortfolioOpen, setAddPortfolioOpen] = useState(false);
  // Top-level create portfolio dialog
  const [createPortfolioOpen, setCreatePortfolioOpen] = useState(false);
  // Invite existing partner to add another portfolio via secure email link
  const [invitePartnerPortfolio, setInvitePartnerPortfolio] = useState<{ id: string; full_name?: string | null; email?: string | null } | null>(null);
  
  const [addPortfolioAmount, setAddPortfolioAmount] = useState('');
  const [addPortfolioRoi, setAddPortfolioRoi] = useState('20');
  const [addPortfolioRoiMode, setAddPortfolioRoiMode] = useState('monthly_payout');
  const [addPortfolioDuration, setAddPortfolioDuration] = useState('12');
  const [addPortfolioPayoutDay, setAddPortfolioPayoutDay] = useState('15');
  const [addPortfolioDate, setAddPortfolioDate] = useState('');
  const [addPortfolioFundingSource, setAddPortfolioFundingSource] = useState<'wallet' | 'proxy_agent'>('wallet');
  const [addingPortfolio, setAddingPortfolio] = useState(false);

  // Compound from portfolio view
  const [compoundingPortfolioId, setCompoundingPortfolioId] = useState<string | null>(null);
  const [detailHiddenForCompound, setDetailHiddenForCompound] = useState(false);
  const [compoundPreview, setCompoundPreview] = useState<{
    portfolio: PortfolioRow;
    roiAmount: number;
    currentPrincipal: number;
    newPrincipal: number;
    roiPercentage: number;
    nextRoiDate: string;
  } | null>(null);

  const openCompoundPreview = (portfolio: PortfolioRow) => {
    const roiAmount = Math.round(portfolio.investment_amount * portfolio.roi_percentage / 100);
    const newPrincipal = portfolio.investment_amount + roiAmount;
    const currentDate = new Date(portfolio.next_roi_date || new Date());
    const newDate = new Date(currentDate);
    newDate.setMonth(newDate.getMonth() + 1);
    const nextRoiDate = newDate.toISOString().split('T')[0];
    setCompoundPreview({
      portfolio,
      roiAmount,
      currentPrincipal: portfolio.investment_amount,
      newPrincipal,
      roiPercentage: portfolio.roi_percentage,
      nextRoiDate,
    });
    setDetailHiddenForCompound(true);
  };

  const handlePortfolioCompound = async (portfolio: PortfolioRow) => {
    if (!detailPartner) return;
    setCompoundingPortfolioId(portfolio.id);
    try {
      const roiAmount = Math.round(portfolio.investment_amount * portfolio.roi_percentage / 100);
      const newAmount = portfolio.investment_amount + roiAmount;
      const refId = `CMP-${Date.now().toString(36).toUpperCase()}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) throw new Error('Not authenticated');

      // Advance next_roi_date by +1 month on compound
      const currentDate = new Date(portfolio.next_roi_date || new Date());
      const newDate = new Date(currentDate);
      newDate.setMonth(newDate.getMonth() + 1);
      const newRoiDate = newDate.toISOString().split('T')[0];

      const { error: upErr } = await supabase
        .from('investor_portfolios')
        .update({ investment_amount: newAmount, next_roi_date: newRoiDate })
        .eq('id', portfolio.id);
      if (upErr) throw upErr;

      // Double-entry ledger: roi_expense + roi_reinvestment
      const { error: ledgerErr } = await supabase.rpc('create_ledger_transaction', {
        entries: [
          {
            user_id: detailPartner.profile.id,
            ledger_scope: 'platform',
            direction: 'cash_out',
            amount: roiAmount,
            category: 'roi_expense',
            description: `ROI compounded: ${formatUGX(roiAmount)} reinvested into portfolio. New principal: ${formatUGX(newAmount)}. Ref: ${refId}`,
            reference_id: refId,
            source_table: 'investor_portfolios',
            source_id: portfolio.id,
            linked_party: user.id,
            currency: 'UGX',
          },
          {
            user_id: detailPartner.profile.id,
            ledger_scope: 'platform',
            direction: 'cash_in',
            amount: roiAmount,
            category: 'roi_reinvestment',
            description: `ROI reinvestment: ${formatUGX(roiAmount)} added to principal. New principal: ${formatUGX(newAmount)}. Ref: ${refId}`,
            reference_id: refId,
            source_table: 'investor_portfolios',
            source_id: portfolio.id,
            linked_party: user.id,
            currency: 'UGX',
          },
        ],
      });
      if (ledgerErr) throw ledgerErr;

      await supabase.from('audit_logs').insert({
        user_id: user.id,
        action_type: 'roi_compounded',
        table_name: 'investor_portfolios',
        record_id: portfolio.id,
        metadata: { roi_amount: roiAmount, new_principal: newAmount, reference: refId, partner_id: detailPartner.profile.id, new_roi_date: newRoiDate },
      });

      await supabase.from('notifications').insert({
        user_id: detailPartner.profile.id,
        title: 'Portfolio ROI Compounded',
        message: `Your ROI of ${formatUGX(roiAmount)} has been compounded into your portfolio. New investment total: ${formatUGX(newAmount)}. Next payout: ${newRoiDate}. Ref: ${refId}`,
        type: 'portfolio_update',
        metadata: { portfolio_id: portfolio.id, roi_amount: roiAmount, reference: refId },
      });

      // Send partner-portfolio-compounded transactional email (fire-and-forget, non-blocking).
      // This is an EXISTING partner compounding an active portfolio.
      try {
        // Resolve partner email (not stored on detailPartner.profile)
        const { data: profileRow } = await supabase
          .from('profiles')
          .select('email')
          .eq('id', detailPartner.profile.id)
          .maybeSingle();
        const recipientEmail = profileRow?.email;
        const isRealEmail =
          recipientEmail &&
          !recipientEmail.endsWith('@welile.user') &&
          !recipientEmail.endsWith('@noapp.welile.user');

        if (isRealEmail) {
          // Build the ACTUAL compounding history anchored at the partner's
          // contribution date (portfolio.created_at). We replay every prior
          // `roi_compounded` audit event for this portfolio in order, then
          // append the cycle we just posted. The final balance equals the
          // new principal exactly — no synthetic forward projection.
          const { data: priorLogs } = await supabase
            .from('audit_logs')
            .select('created_at, metadata')
            .eq('action_type', 'roi_compounded')
            .eq('record_id', portfolio.id)
            .order('created_at', { ascending: true });

          // The audit row for THIS compound was inserted just above, so it's
          // included in `priorLogs`. paymentNumber = total cycles to date.
          const allLogs = priorLogs ?? [];
          const paymentNumber = allLogs.length;

          // Derive the original principal (contribution amount) from the
          // first compound event: balance_before of cycle 1 = new_principal − roi_amount.
          // If no logs (shouldn't happen — we just inserted one), fall back.
          let originalPrincipal = Number(portfolio.investment_amount) - roiAmount; // pre-current-compound principal
          if (allLogs.length >= 1) {
            const first: any = allLogs[0].metadata || {};
            const firstNew = Number(first.new_principal || 0);
            const firstRoi = Number(first.roi_amount || 0);
            if (firstNew > 0 && firstRoi >= 0) originalPrincipal = firstNew - firstRoi;
          }

          // FORWARD PROJECTION breakdown.
          // The current month (the cycle we just compounded) is excluded —
          // its result IS the "New Total Partnership Value" headline.
          // The breakdown starts from the NEXT month and projects monthly
          // compounding through the remainder of the portfolio's duration.
          // Anchored to the contribution date (not cycle count) so skipped
          // or backfilled cycles never cause month drift.
          const compound_history = buildCompoundProjection({
            contributionDate: portfolio.created_at,
            durationMonths: Number(portfolio.duration_months || 12),
            newPrincipal: Number(newAmount),
            roiPct: Number(portfolio.roi_percentage || 0),
            compoundDate: new Date(),
          });

          const contributionDateStr = new Date(portfolio.created_at).toLocaleDateString('en-GB', {
            day: '2-digit', month: 'long', year: 'numeric',
          });
          const compoundDate = new Date().toLocaleDateString('en-GB', {
            day: '2-digit', month: 'long', year: 'numeric',
          });

          await supabase.functions.invoke('send-transactional-email', {
            body: {
              templateName: 'partner-portfolio-compounded',
              recipientEmail,
              idempotencyKey: `partner-portfolio-compounded-${detailPartner.profile.id}-${portfolio.id}-${paymentNumber}`,
              templateData: {
                partner_name: detailPartner.profile.full_name || 'Partner',
                portfolio_id: portfolio.portfolio_code || portfolio.id,
                compound_date: compoundDate,
                contribution_date: contributionDateStr,
                initial_partnership_amount: originalPrincipal,
                roi_return: `${portfolio.roi_percentage}%`,
                return_amount: roiAmount,
                // For existing partners we show the value AFTER this cycle
                // (principal + return earned), matching the in-app dialog.
                new_total_partnership_value: Number(newAmount),
                roi_percentage: portfolio.roi_percentage,
                payment_number: paymentNumber,
                // Actual cycles since contribution date — never a 12-month
                // forward projection. Length = paymentNumber.
                compound_history,
                currency: 'UGX',
                company_name: 'Welile',
                logo_url: 'https://welileapp.com/welile-logo.png',
                unsubscribe_url: 'https://welile.com/unsubscribe',
                dashboard_url: 'https://welileapp.com/auth',
              },
            },
          });
        }
      } catch (emailErr) {
        console.warn('[partner-portfolio-compounded] email dispatch failed (non-blocking):', emailErr);
      }

      toast.success(`Compounded ${formatUGX(roiAmount)}`, { description: `New principal: ${formatUGX(newAmount)}. Ref: ${refId}` });
      // Refresh detail view
      if (detailPartner?.profile?.id) openPartnerDetail(detailPartner.profile.id);
      refreshInBackground();
    } catch (err: any) {
      toast.error('Compound failed', { description: err.message });
    } finally {
      setCompoundingPortfolioId(null);
    }
  };

  /* ─── Build PartnerRow[] for an arbitrary set of supporter ids. ─── */
  const buildRowsForIds = useCallback(async (ids: string[]): Promise<PartnerRow[]> => {
    if (ids.length === 0) return [];
    const [profiles, wallets, portfolios] = await Promise.all([
      batchedQuery<any>(ids, (batch) => supabase.from('profiles').select('id, full_name, phone, email, created_at, frozen_at').in('id', batch)),
      batchedQuery<any>(ids, (batch) => supabase.from('wallets').select('user_id, balance').in('user_id', batch)),
      batchedQuery<any>(ids, (batch) =>
        supabase.from('investor_portfolios')
          .select('id, investor_id, agent_id, investment_amount, roi_percentage, payout_day, roi_mode, status, created_at, next_roi_date')
          .or(`investor_id.in.(${batch.join(',')}),agent_id.in.(${batch.join(',')})`)
          .in('status', ['active', 'pending_approval', 'pending'])
          .order('created_at', { ascending: false })
      ),
    ]);

    const seenPortfolioIds = new Set<string>();
    const dedupedPortfolios = (portfolios as any[]).filter(p => {
      if (seenPortfolioIds.has(p.id)) return false;
      seenPortfolioIds.add(p.id);
      return true;
    });

    const profileMap = new Map((profiles as any[]).map(p => [p.id, p]));
    const walletMap = new Map((wallets as any[]).map(w => [w.user_id, w.balance || 0]));

    const supporterIdSet = new Set(ids);
    const partnerAgg = new Map<string, { funded: number; deals: number; roiPercentage: number; payoutDay: number; roiMode: string; lastActivity: string; nextRoiDate: string | null; payoutDates: string[] }>();

    dedupedPortfolios.forEach(p => {
      const ownerId = p.investor_id && supporterIdSet.has(p.investor_id)
        ? p.investor_id
        : p.agent_id && supporterIdSet.has(p.agent_id)
          ? p.agent_id
          : null;
      if (!ownerId) return;

      const existing = partnerAgg.get(ownerId) || { funded: 0, deals: 0, roiPercentage: 0, payoutDay: 0, roiMode: 'monthly_payout', lastActivity: '', nextRoiDate: null as string | null, payoutDates: [] as string[] };
      existing.funded += (p.investment_amount || 0);
      existing.deals += 1;
      if (existing.deals === 1 || !existing.roiPercentage) {
        existing.roiPercentage = p.roi_percentage ?? 15;
        existing.payoutDay = p.payout_day ?? 15;
        existing.roiMode = p.roi_mode ?? 'monthly_payout';
      }
      const effectiveDate = getNextPayoutDate(p.next_roi_date, p.created_at, p.payout_day ?? 15);
      if (!existing.nextRoiDate || effectiveDate < existing.nextRoiDate) {
        existing.nextRoiDate = effectiveDate;
      }
      // Track ALL portfolio next-payout dates so the date-range filter can
      // include partners with ANY portfolio paying in the selected window.
      existing.payoutDates.push(effectiveDate);
      if (!existing.lastActivity || p.created_at > existing.lastActivity) {
        existing.lastActivity = p.created_at;
      }
      partnerAgg.set(ownerId, existing);
    });

    return ids.map(id => {
      const agg = partnerAgg.get(id) || { funded: 0, deals: 0, roiPercentage: 15, payoutDay: 15, roiMode: 'monthly_payout', lastActivity: '', nextRoiDate: null, payoutDates: [] as string[] };
      const profile = profileMap.get(id);
      const isSuspended = !!profile?.frozen_at;
      return {
        id,
        name: profile?.full_name || id.slice(0, 8),
        phone: profile?.phone || '',
        email: profile?.email || '',
        funded: agg.funded,
        activeDeals: agg.deals,
        avgDeal: agg.deals > 0 ? Math.round(agg.funded / agg.deals) : 0,
        walletBalance: walletMap.get(id) || 0,
        roiPercentage: agg.roiPercentage,
        payoutDay: agg.payoutDay,
        roiMode: agg.roiMode,
        status: (isSuspended ? 'suspended' : 'active') as 'active' | 'suspended',
        joinedAt: profile?.created_at || '',
        lastActivity: agg.lastActivity || '',
        nextRoiDate: agg.nextRoiDate,
        payoutDates: agg.payoutDates,
        // No portfolios yet → a prospect surfaced by search (e.g. a verified
        // depositor with wallet money). Ops can still invest/top-up from wallet.
        isProspect: agg.deals === 0,
      };
    });
  }, []);

  /* ─── Core fetch logic: server-side paginated ─── */
  const fetchDataCore = useCallback(async (fetchPage: number, searchTerm: string) => {
    const { ids: supporterIds, totalCount: count } = filterProspect === 'prospects_only'
      ? await fetchVerifiedFundedProspectIds(fetchPage, PAGE_SIZE, searchTerm)
      : await fetchPaginatedSupporterIds(fetchPage, PAGE_SIZE, searchTerm);
    setTotalCount(count);

    if (supporterIds.length === 0) {
      setRows([]);
      if (count === 0) {
        setSummary({ totalPartners: 0, activePartners: 0, suspendedPartners: 0, totalFunded: 0, totalWalletBalance: 0, avgROI: 0, totalDeals: 0, topPartnerName: '—' });
      }
      return;
    }

    const tableRows = await buildRowsForIds(supporterIds);
    setRows(tableRows);
  }, [buildRowsForIds, filterProspect]);

  /* ─── Wallet balances breakdown: ALL partners holding wallet money ─── */
  useEffect(() => {
    if (!walletBalancesOpen) return;
    let cancelled = false;
    (async () => {
      setWalletBalancesLoading(true);
      try {
        const ids = await fetchAllUserIdsByRole('supporter');
        if (!ids.length) { if (!cancelled) setWalletBalancesList([]); return; }
        const wallets = await batchedQuery<{ user_id: string; balance: number }>(
          ids,
          (batch) => supabase.from('wallets').select('user_id, balance').in('user_id', batch).gt('balance', 0),
        );
        const holderIds = wallets.map(w => w.user_id);
        const profiles = holderIds.length
          ? await batchedQuery<{ id: string; full_name: string | null; phone: string | null; email: string | null }>(
              holderIds,
              (batch) => supabase.from('profiles').select('id, full_name, phone, email').in('id', batch),
            )
          : [];
        const pMap = new Map(profiles.map(p => [p.id, p]));
        const list = wallets
          .map(w => ({
            id: w.user_id,
            name: pMap.get(w.user_id)?.full_name || w.user_id.slice(0, 8),
            phone: pMap.get(w.user_id)?.phone || '',
            email: pMap.get(w.user_id)?.email || '',
            balance: Number(w.balance) || 0,
          }))
          .sort((a, b) => b.balance - a.balance);
        if (!cancelled) setWalletBalancesList(list);
      } catch (e) {
        console.error('[COOPartnersPage] wallet balances load failed', e);
        if (!cancelled) toast.error('Could not load partner wallet balances');
      } finally {
        if (!cancelled) setWalletBalancesLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [walletBalancesOpen]);

  const walletBalancesFiltered = useMemo(() => {
    const q = walletBalancesSearch.trim().toLowerCase();
    if (!q) return walletBalancesList;
    return walletBalancesList.filter(p =>
      p.name.toLowerCase().includes(q) || p.phone.toLowerCase().includes(q) || p.email.toLowerCase().includes(q));
  }, [walletBalancesList, walletBalancesSearch]);
  const walletBalancesTotal = useMemo(
    () => walletBalancesFiltered.reduce((s, p) => s + p.balance, 0),
    [walletBalancesFiltered],
  );

  /* ─── Nearing payouts: loaded independently from ALL supporters ─── */
  const [nearingPayoutsLoading, setNearingPayoutsLoading] = useState(false); // eslint-disable-line -- top-level hook, after all other useState
  const fetchNearingPayoutsAsync = useCallback(async () => {
    setNearingPayoutsLoading(true);
    try {
      const { portfolios, profileMap, supporterIds } = await fetchAllNearingPayoutPortfolios();
      const now = new Date();
      now.setHours(0, 0, 0, 0);
      const nearingList: NearingPayoutPortfolio[] = [];
      const todayStr = formatLocalDateOnly(new Date());
      portfolios.forEach(p => {
        if (p.status !== 'active') return;
        const ownerId = p.investor_id && supporterIds.has(p.investor_id) ? p.investor_id
          : p.agent_id && supporterIds.has(p.agent_id) ? p.agent_id : null;
        if (!ownerId) return;

        // Single source of truth for the Next Payout Date — handles null next_roi_date
        // by deriving from created_at + payout_day, and is timezone-safe.
        const effectiveNextDate = getNextPayoutDate(p.next_roi_date, p.created_at, p.payout_day ?? 15);
        const roiDate = dateOnlyToLocalDate(effectiveNextDate);
        const diffMs = roiDate.getTime() - now.getTime();
        const du = Math.round(diffMs / (1000 * 60 * 60 * 24));
        const dueToday = effectiveNextDate === todayStr;
        const prof = profileMap.get(ownerId);
        const effectivePayoutDay = p.payout_day || roiDate.getDate();
        nearingList.push({
          portfolioId: p.id,
          investorId: ownerId,
          name: prof?.full_name || ownerId.slice(0, 8),
          portfolioName: p.account_name || p.portfolio_code || p.id.slice(0, 8),
          phone: prof?.phone || '',
          email: prof?.email || '',
          investmentAmount: p.investment_amount || 0,
          roiPercentage: p.roi_percentage ?? 15,
          payoutDay: effectivePayoutDay,
          roiMode: p.roi_mode ?? 'monthly_payout',
          createdAt: p.created_at,
          daysUntil: du,
          nextPayoutDate: effectiveNextDate,
          dueToday,
          durationMonths: Number((p as any).duration_months || 12),
          nextRoiDate: p.next_roi_date,
          status: (p as any).status ?? null,
          paymentMethod: (p as any).payment_method ?? null,
          mobileNetwork: (p as any).mobile_network ?? null,
          mobileMoneyNumber: (p as any).mobile_money_number ?? null,
          bankName: (p as any).bank_name ?? null,
          bankAccountName: (p as any).bank_account_name ?? null,
          accountNumber: (p as any).account_number ?? null,
        });
      });
      nearingList.sort((a, b) => a.daysUntil - b.daysUntil);

      // ── Mark portfolios already handled THIS cycle so they drop off the list ──
      // A portfolio is "processed" if a ledger credit exists for its cycle key
      // (roi-cycle-<portfolioId>-<cycleAnchor>) OR an ROI payout is still open in
      // the approval queue. Either way it must NOT be payable again — this is the
      // primary defence against duplicate / double ROI credits.
      try {
        const cycleKeyToPortfolio = new Map<string, string>();
        for (const n of nearingList) {
          const anchor = n.nextRoiDate || new Date().toISOString().slice(0, 10);
          cycleKeyToPortfolio.set(`roi-cycle-${n.portfolioId}-${anchor}`, n.portfolioId);
        }
        const portfolioIds = nearingList.map(n => n.portfolioId);
        const cycleKeys = Array.from(cycleKeyToPortfolio.keys());
        const creditedPortfolioIds = new Set<string>();
        const pendingPortfolioIds = new Set<string>();

        const chunk = <T,>(arr: T[], size: number) => {
          const out: T[][] = [];
          for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
          return out;
        };

        await Promise.all([
          ...chunk(cycleKeys, 200).map(async (batch) => {
            const { data } = await supabase
              .from('general_ledger')
              .select('idempotency_key')
              .in('idempotency_key', batch);
            for (const r of (data as any[]) || []) {
              const pid = cycleKeyToPortfolio.get(r.idempotency_key);
              if (pid) creditedPortfolioIds.add(pid);
            }
          }),
          ...chunk(portfolioIds, 200).map(async (batch) => {
            const { data } = await supabase
              .from('pending_wallet_operations')
              .select('source_id')
              .eq('source_table', 'investor_portfolios')
              .eq('category', 'roi_payout')
              .in('source_id', batch)
              .in('status', ['pending', 'pending_coo_approval', 'coo_approved', 'awaiting_verification']);
            for (const r of (data as any[]) || []) {
              if (r.source_id) pendingPortfolioIds.add(r.source_id);
            }
          }),
        ]);

        for (const n of nearingList) {
          if (creditedPortfolioIds.has(n.portfolioId)) {
            n.alreadyProcessedThisCycle = true;
            n.processedState = 'credited';
          } else if (pendingPortfolioIds.has(n.portfolioId)) {
            n.alreadyProcessedThisCycle = true;
            n.processedState = 'pending';
          }
        }
      } catch (e) {
        console.error('[NearingPayout] cycle-processed lookup failed:', e);
      }

      if (import.meta.env.DEV) {
        const dueCount = nearingList.filter(n => n.dueToday).length;
        // eslint-disable-next-line no-console
        console.debug('[NearingPayout] today=%s dueToday=%d totalActive=%d', todayStr, dueCount, nearingList.length);
        const drift = nearingList.find(n => n.dueToday && n.daysUntil !== 0);
        if (drift) console.warn('[NearingPayout] dueToday/daysUntil drift on', drift.portfolioId, drift);
      }
      setAllPortfoliosForPayout(nearingList);
    } catch (e) {
      console.error('Nearing payouts fetch error:', e);
    } finally {
      setNearingPayoutsLoading(false);
    }
  }, []);

  /* ─── Summary stats (fetched once, cached) ─── */
  const fetchSummaryStats = useCallback(async () => {
    try {
      const stats = await fetchSupporterSummary();
      setSummary({
        ...stats,
        avgROI: 0,
        topPartnerName: '—',
      });
    } catch (e) {
      console.error('Summary stats error:', e);
    }
  }, []);

  /* ─── Initial fetch (with loading spinner) ─── */
  const isInitialLoad = useRef(true);
  const fetchData = useCallback(async () => {
    // Only show full spinner on first load, not on search/page changes
    if (isInitialLoad.current) {
      setIsLoading(true);
    } else {
      setIsSearching(true);
    }
    try { await fetchDataCore(page, debouncedSearch); }
    catch (e) { console.error(e); }
    finally {
      setIsLoading(false);
      setIsSearching(false);
      isInitialLoad.current = false;
    }
  }, [fetchDataCore, page, debouncedSearch]);

  /* ─── Background refresh (no spinner, no page flash) ─── */
  const refreshInBackground = useCallback(async () => {
    try {
      await Promise.all([
        fetchDataCore(page, debouncedSearch),
        fetchNearingPayoutsAsync(),
      ]);
    }
    catch (e) { console.error('Background refresh error:', e); }
  }, [fetchDataCore, page, debouncedSearch, fetchNearingPayoutsAsync]);

  // Fetch pending_approval count
  const fetchPendingCount = useCallback(async () => {
    const { count } = await supabase
      .from('investor_portfolios')
      .select('id', { count: 'exact', head: true })
      .eq('status', 'pending_approval');
    setPendingApprovalCount(count || 0);
  }, []);

  // Debounce search input — single source of truth for resetting page on search.
  // The input's onChange purposefully does NOT touch page, so we only fire one
  // fetch per settled search term instead of one per keystroke.
  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedSearch(prev => (prev === search ? prev : search));
      setPage(prev => (prev === 0 ? prev : 0));
    }, 400);
    return () => clearTimeout(timer);
  }, [search]);

  useEffect(() => { fetchData(); fetchPendingCount(); }, [fetchData, fetchPendingCount]);

  // Fetch summary stats + nearing payouts once on mount (independent)
  useEffect(() => { fetchSummaryStats(); }, [fetchSummaryStats]);
  useEffect(() => { fetchNearingPayoutsAsync(); }, [fetchNearingPayoutsAsync]);

  // Refresh wallet balances whenever the Wallet → Portfolio dialog opens
  useEffect(() => {
    if (walletToPortfolio) {
      refreshDetailWalletBalances();
    }
  }, [walletToPortfolio]);

  // Single portfolio approve
  const [approvingId, setApprovingId] = useState<string | null>(null);
  const handleApprovePortfolio = async (portfolioId: string) => {
    setApprovingId(portfolioId);
    try {
      const { error } = await supabase
        .from('investor_portfolios')
        .update({ status: 'active' })
        .eq('id', portfolioId)
        .eq('status', 'pending_approval');

      if (error) throw error;

      // Also approve any linked pending_wallet_operations
      await supabase
        .from('pending_wallet_operations')
        .update({ status: 'approved' })
        .eq('source_id', portfolioId)
        .eq('status', 'pending');

      // Audit log
      const { data: { user: currentUser } } = await supabase.auth.getUser();
      await supabase.from('audit_logs').insert({
        user_id: currentUser?.id,
        action_type: 'approve_portfolio',
        table_name: 'investor_portfolios',
        record_id: portfolioId,
        metadata: { approved_individually: true },
      });

      toast.success('Portfolio approved and activated');
      // Refresh detail view
      if (detailPartner?.profile?.id) openPartnerDetail(detailPartner.profile.id);
      fetchPendingCount();
    } catch (e: any) {
      toast.error(e.message || 'Failed to approve portfolio');
    } finally {
      setApprovingId(null);
    }
  };

  // Bulk activate all pending_approval portfolios
  const handleBulkActivate = async () => {
    setActivatingAll(true);
    try {
      const { error } = await supabase
        .from('investor_portfolios')
        .update({ status: 'active' })
        .eq('status', 'pending_approval');

      if (error) throw error;

      toast.success(`${pendingApprovalCount} portfolios activated successfully`);
      setShowActivateConfirm(false);
      setPendingApprovalCount(0);
      refreshInBackground();
    } catch (e: any) {
      console.error('Bulk activate error:', e);
      toast.error(e.message || 'Failed to activate portfolios');
    } finally {
      setActivatingAll(false);
    }
  };

  /* ─── Open Partner Detail ─── */
  async function openPartnerDetail(partnerId: string) {
    setDetailLoading(true);
    setDetailPartner(null);
    setDetailSelfCommitments([]);
    try {
      const [profileRes, walletRes, portfolioRes, ledgerRes, selfCommitRes, selfLinesRes] = await Promise.all([
        supabase.from('profiles').select('id, full_name, phone, email, created_at, frozen_at, frozen_reason, funder_verified_at, signup_source').eq('id', partnerId).single(),
        supabase.from('wallets').select('balance, withdrawable_balance, float_balance').eq('user_id', partnerId).single(),
        supabase.from('investor_portfolios')
          .select('id, portfolio_code, account_name, investment_amount, roi_percentage, payout_day, roi_mode, status, created_at, maturity_date, total_roi_earned, duration_months, next_roi_date, investor_id, agent_id, payment_method, mobile_network, mobile_money_number, bank_name, bank_account_name, account_number, pending_renewal_effective_date, pending_renewal_duration_months')
          .or(`investor_id.eq.${partnerId},agent_id.eq.${partnerId}`)
          .order('created_at', { ascending: false }),
        supabase.from('general_ledger')
          .select('amount, direction, category')
          .eq('user_id', partnerId)
          .in('category', ['supporter_rent_fund', 'supporter_facilitation_capital', 'coo_proxy_investment']),
        // Self-managed commitments (Self Portfolio Management) — these never
        // create an investor_portfolios row, so read them directly.
        supabase.from('partner_self_commitments')
          .select('id, committed_amount, term_months, monthly_rate, lines_count, status, payout_day, next_payout_at, term_end_at, total_earned, total_paid, created_at')
          .eq('partner_id', partnerId)
          .order('created_at', { ascending: false }),
        supabase.from('partner_self_funding_lines')
          .select('id, commitment_id, rent_request_id, principal, status')
          .eq('partner_id', partnerId)
          .order('created_at', { ascending: false }),
      ]);

      const ledgerData = ledgerRes.data || [];
      const ledgerFunded = ledgerData.filter(e => e.direction === 'cash_out').reduce((s, e) => s + (e.amount || 0), 0);
      const ledgerDeals = ledgerData.filter(e => e.direction === 'cash_out').length;
      const portfolios = (portfolioRes.data || []) as PortfolioRow[];
      const portfolioROIEarned = portfolios.reduce((s, p) => s + (p.total_roi_earned || 0), 0);

      // ── Self-managed commitments: attach lines + tenant names ─────────────
      const selfLines = (selfLinesRes.data || []) as any[];
      const rentRequestIds = Array.from(new Set(selfLines.map(l => l.rent_request_id).filter(Boolean)));
      const tenantNameByRequest: Record<string, string> = {};
      if (rentRequestIds.length > 0) {
        const { data: rrRows } = await supabase
          .from('rent_requests')
          .select('id, tenant_id')
          .in('id', rentRequestIds);
        const tenantIds = Array.from(new Set((rrRows || []).map((r: any) => r.tenant_id).filter(Boolean)));
        const nameById: Record<string, string> = {};
        if (tenantIds.length > 0) {
          const { data: tenantRows } = await supabase
            .from('profiles')
            .select('id, full_name')
            .in('id', tenantIds);
          (tenantRows || []).forEach((t: any) => { nameById[t.id] = t.full_name; });
        }
        (rrRows || []).forEach((r: any) => {
          if (r.tenant_id && nameById[r.tenant_id]) tenantNameByRequest[r.id] = nameById[r.tenant_id];
        });
      }
      const selfCommitments: SelfCommitmentRow[] = ((selfCommitRes.data || []) as any[]).map(c => ({
        ...c,
        committed_amount: Number(c.committed_amount || 0),
        total_earned: Number(c.total_earned || 0),
        total_paid: Number(c.total_paid || 0),
        lines: selfLines
          .filter(l => l.commitment_id === c.id)
          .map(l => ({
            id: l.id,
            rent_request_id: l.rent_request_id,
            principal: Number(l.principal || 0),
            status: l.status,
            tenant_name: tenantNameByRequest[l.rent_request_id] || null,
          })),
      }));
      setDetailSelfCommitments(selfCommitments);

      // Self-managed principal is live partner capital and must count towards
      // Principal / Returns, otherwise a self-managed partner reads as empty.
      const SELF_ACTIVE = new Set(['active', 'matured', 'pending_payout']);
      const selfPrincipal = selfCommitments
        .filter(c => SELF_ACTIVE.has(c.status))
        .reduce((s, c) => s + c.committed_amount, 0);
      const selfEarned = selfCommitments.reduce((s, c) => s + c.total_earned, 0);
      const totalROIEarned = portfolioROIEarned + selfEarned;

      // Fetch renewal counts and pending top-ups for these portfolios
      const portfolioIds = portfolios.map(p => p.id);
      if (portfolioIds.length > 0) {
        const [renewalsRes, pendingRes, redemptionsRes] = await Promise.all([
          supabase
            .from('portfolio_renewals')
            .select('portfolio_id, created_at')
            .in('portfolio_id', portfolioIds),
          supabase
            .from('pending_wallet_operations')
            .select('source_id, amount, status, reviewed_by, reviewed_at, metadata')
            .in('source_id', portfolioIds)
            .eq('source_table', 'investor_portfolios')
            .eq('operation_type', 'portfolio_topup')
            .in('status', ['pending', 'awaiting_verification', 'approved', 'completed']),
          supabase
            .from('portfolio_action_requests')
            .select('portfolio_id')
            .in('portfolio_id', portfolioIds)
            .eq('request_type', 'REDEMPTION_REQUEST')
            .in('status', ['pending', 'processing']),
        ]);
        const counts: Record<string, number> = {};
        const latestRenewal: Record<string, string> = {};
        (renewalsRes.data || []).forEach((r: any) => {
          counts[r.portfolio_id] = (counts[r.portfolio_id] || 0) + 1;
          const prev = latestRenewal[r.portfolio_id];
          if (!prev || new Date(r.created_at) > new Date(prev)) latestRenewal[r.portfolio_id] = r.created_at;
        });
        setRenewalCounts(counts);
        setRecentRenewals(latestRenewal);
        const redemptionMap: Record<string, boolean> = {};
        (redemptionsRes.data || []).forEach((r: any) => { redemptionMap[r.portfolio_id] = true; });
        setPendingRedemptions(redemptionMap);

        const pending: Record<string, { count: number; total: number }> = {};
        const awaiting: Record<string, { count: number; total: number }> = {};
        const approved: Record<string, { count: number; total: number }> = {};
        const autoApplied: Record<string, { count: number; total: number }> = {};
        // Only surface auto-applied merges from the last 30 days so the badge
        // reflects the most recent ROI cycle, not every historical merge.
        const autoAppliedSince = Date.now() - 30 * 24 * 60 * 60 * 1000;
        (pendingRes.data || []).forEach((op: any) => {
          const key = op.source_id;
          if (op.status === 'approved') {
            if (!approved[key]) approved[key] = { count: 0, total: 0 };
            approved[key].count += 1;
            approved[key].total += Number(op.amount);
          } else if (op.status === 'awaiting_verification') {
            if (!awaiting[key]) awaiting[key] = { count: 0, total: 0 };
            awaiting[key].count += 1;
            awaiting[key].total += Number(op.amount);
          } else if (op.status === 'completed') {
            // Distinguish automatic ROI-cycle merges from manual "Apply Top-up".
            // Auto-merges are flagged in metadata (reviewed_by is a UUID column and
            // cannot hold a sentinel string).
            const isAuto = op.metadata?.auto_applied_at_roi_cycle === true;
            const ts = op.reviewed_at ? new Date(op.reviewed_at).getTime() : 0;
            if (isAuto && ts >= autoAppliedSince) {
              if (!autoApplied[key]) autoApplied[key] = { count: 0, total: 0 };
              autoApplied[key].count += 1;
              autoApplied[key].total += Number(op.amount);
            }
          } else {
            if (!pending[key]) pending[key] = { count: 0, total: 0 };
            pending[key].count += 1;
            pending[key].total += Number(op.amount);
          }
        });
        setPendingTopUps(pending);
        setAwaitingVerification(awaiting);
        setApprovedTopUps(approved);
        setAutoAppliedTopUps(autoApplied);
      }

      // Principal is the authoritative outstanding capital across the partner's
      // active portfolios. Prefer this over the ledger sum: a partner can have
      // several portfolios while only some contributions were ledger-tagged with
      // the tracked categories, which made the ledger-first figure stale (showing
      // only the one recorded contribution instead of the full principal).
      // Include matured portfolios: they still hold outstanding partner
      // principal until explicitly withdrawn or renewed. Only exclude terminal
      // states (withdrawn/cancelled/rejected/pending_ops_approval).
      const PRINCIPAL_STATUSES = new Set(['active', 'matured']);
      const portfolioFunded = portfolios
        .filter(p => p.status == null || PRINCIPAL_STATUSES.has(p.status))
        .reduce((s, p) => s + (p.investment_amount || 0), 0);
      // Fall back to the ledger only for imported partners with no portfolio rows.
      const baseFunded = portfolios.length > 0 ? portfolioFunded : (selfCommitments.length > 0 ? 0 : ledgerFunded);
      const totalFunded = baseFunded + selfPrincipal;
      const baseDeals = portfolios.length > 0 ? portfolios.length : (selfCommitments.length > 0 ? 0 : ledgerDeals);
      const totalDeals = baseDeals + selfCommitments.length;

      setDetailPartner({
        profile: profileRes.data as any,
        walletBalance: walletRes.data?.balance || 0,
        withdrawableBalance: (walletRes.data as any)?.withdrawable_balance || 0,
        floatBalance: (walletRes.data as any)?.float_balance || 0,
        totalFunded,
        totalDeals,
        totalROIEarned,
        portfolios,
      });
    } catch (e) { console.error(e); toast.error('Failed to load partner details'); }
    finally { setDetailLoading(false); }
  }

  /* ─── Refresh only wallet balances for the open detail partner ─── */
  async function refreshDetailWalletBalances() {
    if (!detailPartner?.profile?.id) return;
    try {
      const { data, error } = await supabase
        .from('wallets')
        .select('balance, withdrawable_balance, float_balance')
        .eq('user_id', detailPartner.profile.id)
        .single();
      if (error || !data) return;
      setDetailPartner(prev =>
        prev
          ? {
              ...prev,
              walletBalance: data.balance || 0,
              withdrawableBalance: (data as any).withdrawable_balance || 0,
              floatBalance: (data as any).float_balance || 0,
            }
          : prev
      );
    } catch { /* silently ignore refresh failures */ }
  }

  /* ─── Submit Pending Top-Ups for Financial Ops Verification ─── */
  async function handleApplyPendingTopUps(portfolioId: string) {
    setApplyingTopUps(portfolioId);
    try {
      const { data, error } = await supabase.functions.invoke('apply-pending-topups', {
        body: { portfolio_id: portfolioId },
      });
      if (error) throw new Error(error.message);
      if (data?.error) throw new Error(data.error);
      toast.success(`${data.count} deposit(s) submitted for verification`, {
        description: `UGX ${Number(data.total_amount).toLocaleString()} sent to Financial Operations for approval.`,
      });
      if (detailPartner?.profile?.id) openPartnerDetail(detailPartner.profile.id);
    } catch (e: any) {
      toast.error('Failed to submit for verification', { description: e.message });
    } finally {
      setApplyingTopUps(null);
    }
  }

  /* ─── Merge Approved Top-Ups Into Portfolio Principal ─── */
  async function handleMergePendingTopUps() {
    if (!mergeDialogPortfolioId || mergeReason.trim().length < 10) return;
    setMergingTopUp(true);
    try {
      const { data, error } = await supabase.functions.invoke('merge-pending-topups', {
        body: { portfolio_id: mergeDialogPortfolioId, reason: mergeReason.trim() },
      });
      if (error) throw new Error(error.message);
      if (data?.error) throw new Error(data.error);
      toast.success(`Merged ${formatUGX(data.merged_amount)} into principal`, {
        description: `New capital: ${formatUGX(data.new_capital)}. ${data.ops_count} top-up(s) applied.`,
      });
      setMergeDialogPortfolioId(null);
      setMergeReason('');
      if (detailPartner?.profile?.id) openPartnerDetail(detailPartner.profile.id);
      refreshInBackground();
    } catch (e: any) {
      toast.error('Failed to merge top-ups', { description: e.message });
    } finally {
      setMergingTopUp(false);
    }
  }

  /* ─── Cancel Pending (Parked) Top-Ups & Refund Wallet ─── */
  async function handleCancelPendingTopUps() {
    if (!cancelDialogPortfolioId || cancelReason.trim().length < 10) return;
    setCancellingTopUp(true);
    try {
      const { data, error } = await supabase.functions.invoke('cancel-pending-topups', {
        body: { portfolio_id: cancelDialogPortfolioId, reason: cancelReason.trim() },
      });
      if (error) throw new Error(error.message);
      if (data?.error) throw new Error(data.error);
      toast.success(`Cancelled ${formatUGX(data.total_cancelled)} pending principal`, {
        description: `${data.ops_count} top-up(s) refunded to partner wallet.`,
      });
      setCancelDialogPortfolioId(null);
      setCancelReason('');
      if (detailPartner?.profile?.id) openPartnerDetail(detailPartner.profile.id);
      refreshInBackground();
    } catch (e: any) {
      toast.error('Failed to cancel top-ups', { description: e.message });
    } finally {
      setCancellingTopUp(false);
    }
  }

  /* ─── Save portfolio account name ─── */
  async function handleSavePortfolioName(portfolioId: string) {
    const trimmed = editingNameValue.trim();
    setSavingName(true);
    try {
      const { error } = await supabase
        .from('investor_portfolios')
        .update({ account_name: trimmed || null })
        .eq('id', portfolioId);
      if (error) throw error;

      const { data: { user: currentUser } } = await supabase.auth.getUser();
      await supabase.from('audit_logs').insert({
        user_id: currentUser?.id,
        action_type: 'edit_portfolio_name',
        table_name: 'investor_portfolios',
        record_id: portfolioId,
        metadata: { new_name: trimmed },
      });

      toast.success(trimmed ? 'Portfolio name updated' : 'Portfolio name removed');
      setEditingNameId(null);
      if (detailPartner) {
        const updated = detailPartner.portfolios.map(p =>
          p.id === portfolioId ? { ...p, account_name: trimmed || null } : p
        );
        setDetailPartner({ ...detailPartner, portfolios: updated });
      }
    } catch (e: any) { toast.error(e.message || 'Failed to update name'); }
    finally { setSavingName(false); }
  }

  /* ─── Save portfolio payout day ─── */
  async function handleSavePortfolioPayoutDay(portfolioId: string) {
    const day = Number(editingPayoutDay);
    if (isNaN(day) || day < 1 || day > 28) { toast.error('Day must be 1-28'); return; }
    setSavingPortfolio(true);
    try {
      // Keep next_roi_date in sync: payout_day alone never moves an already-set
      // next_roi_date, and both the partner UI and the ROI cron prefer
      // next_roi_date whenever it is populated. Realign the stored date (same
      // month/year) to the new day-of-month, but only if that cycle is still
      // in the future — past/overdue cycles stay visible untouched.
      const { data: current } = await supabase
        .from('investor_portfolios')
        .select('next_roi_date')
        .eq('id', portfolioId)
        .maybeSingle();

      const patch: { payout_day: number; next_roi_date?: string } = { payout_day: day };
      const existingNext = current?.next_roi_date as string | null | undefined;
      if (existingNext) {
        const existing = dateOnlyToLocalDate(existingNext);
        const realigned = new Date(existing.getFullYear(), existing.getMonth(), day);
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        if (realigned.getTime() >= today.getTime()) {
          patch.next_roi_date = formatLocalDateOnly(realigned);
        }
      }

      const { error } = await supabase
        .from('investor_portfolios')
        .update(patch)
        .eq('id', portfolioId);
      if (error) throw error;
      toast.success(
        patch.next_roi_date
          ? `Payout day updated to ${day}${getOrdinalSuffix(day)} — next payout moved to ${patch.next_roi_date}`
          : `Payout day updated to ${day}${getOrdinalSuffix(day)}`
      );
      setEditingPortfolioId(null);
      // Refresh detail
      if (detailPartner) {
        const updated = detailPartner.portfolios.map(p =>
          p.id === portfolioId
            ? { ...p, payout_day: day, next_roi_date: patch.next_roi_date ?? p.next_roi_date }
            : p
        );
        setDetailPartner({ ...detailPartner, portfolios: updated });
      }
    } catch (e: any) { toast.error(e.message || 'Failed to update'); }
    finally { setSavingPortfolio(false); }
  }

  /* ─── Save next payout date ─── */
  async function handleSaveNextPayoutDate(portfolioId: string) {
    if (!editingNextPayoutDate) { toast.error('Please select a date'); return; }
    setSavingPortfolio(true);
    try {
      const { error } = await supabase
        .from('investor_portfolios')
        .update({ next_roi_date: editingNextPayoutDate })
        .eq('id', portfolioId);
      if (error) throw error;
      toast.success('Next payout date updated');
      setEditingNextPayoutId(null);
      if (detailPartner) {
        const updated = detailPartner.portfolios.map(p =>
          p.id === portfolioId ? { ...p, next_roi_date: editingNextPayoutDate } : p
        );
        setDetailPartner({ ...detailPartner, portfolios: updated });
      }
    } catch (e: any) { toast.error(e.message || 'Failed to update'); }
    finally { setSavingPortfolio(false); }
  }

  /* ─── Delete Portfolio ─── */
  async function handleDeletePortfolio() {
    if (!deletePortfolio || !deleteReason.trim()) {
      toast.error('Please provide a reason for deletion');
      return;
    }
    if (deleteReason.trim().length < 10) {
      toast.error('Reason must be at least 10 characters');
      return;
    }
    setDeleting(true);
    try {
      // Get current user for audit
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) throw new Error('Not authenticated');

      // Proxy-safe delete: if the portfolio actually belongs to another partner
      // (investor_id) and is only linked to the currently-viewed partner via
      // agent_id, we must NOT hard-delete — that would wipe the real partner's
      // record too. Instead, detach the proxy link by pointing agent_id back
      // to the investor. The portfolio stays intact in the real partner's
      // account and simply disappears from this view.
      const viewingPartnerId = detailPartner?.profile.id;
      const isProxyEntry =
        !!deletePortfolio.investor_id &&
        !!viewingPartnerId &&
        deletePortfolio.investor_id !== viewingPartnerId &&
        deletePortfolio.agent_id === viewingPartnerId;

      if (isProxyEntry) {
        const { error: auditErr } = await supabase.from('audit_logs').insert({
          user_id: user.id,
          action_type: 'portfolio_proxy_unlinked',
          table_name: 'investor_portfolios',
          record_id: deletePortfolio.id,
          metadata: {
            portfolio_code: deletePortfolio.portfolio_code,
            investment_amount: deletePortfolio.investment_amount,
            previous_agent_id: viewingPartnerId,
            previous_agent_name: detailPartner?.profile.full_name,
            real_investor_id: deletePortfolio.investor_id,
            reason: deleteReason.trim(),
          },
        });
        if (auditErr) throw auditErr;

        const { error: unlinkErr } = await supabase
          .from('investor_portfolios')
          .update({ agent_id: deletePortfolio.investor_id })
          .eq('id', deletePortfolio.id);
        if (unlinkErr) throw unlinkErr;

        toast.success(`Portfolio ${deletePortfolio.portfolio_code} removed from this account`, {
          description: 'The partner who owns it still has it. Action logged for audit.',
        });

        if (detailPartner) {
          const updated = detailPartner.portfolios.filter(p => p.id !== deletePortfolio.id);
          setDetailPartner({ ...detailPartner, portfolios: updated });
        }
        setDeletePortfolio(null);
        setDeleteReason('');
        refreshInBackground();
        return;
      }

      // Log to audit_logs before deletion
      const { error: auditErr } = await supabase.from('audit_logs').insert({
        user_id: user.id,
        action_type: 'delete_investment_portfolio',
        table_name: 'investor_portfolios',
        record_id: deletePortfolio.id,
        metadata: {
          portfolio_code: deletePortfolio.portfolio_code,
          investment_amount: deletePortfolio.investment_amount,
          roi_percentage: deletePortfolio.roi_percentage,
          status: deletePortfolio.status,
          created_at: deletePortfolio.created_at,
          reason: deleteReason.trim(),
          partner_id: detailPartner?.profile.id,
          partner_name: detailPartner?.profile.full_name,
        },
      });
      if (auditErr) throw auditErr;

      // Delete the portfolio
      const { error: delErr } = await supabase
        .from('investor_portfolios')
        .delete()
        .eq('id', deletePortfolio.id);
      if (delErr) throw delErr;

      toast.success(`Portfolio ${deletePortfolio.portfolio_code} deleted`, { description: 'Action logged for audit.' });

      // Update local state
      if (detailPartner) {
        const updated = detailPartner.portfolios.filter(p => p.id !== deletePortfolio.id);
        setDetailPartner({ ...detailPartner, portfolios: updated });
      }
      setDeletePortfolio(null);
      setDeleteReason('');
      refreshInBackground();
    } catch (e: any) {
      toast.error(e.message || 'Failed to delete portfolio');
    } finally {
      setDeleting(false);
    }
  }

  /* ─── Add New Portfolio Invite (no wallet debit, no active portfolio yet) ─── */
  async function handleAddPortfolio() {
    console.log('[handleAddPortfolio] click', {
      hasDetailPartner: !!detailPartner,
      addPortfolioAmount,
      addPortfolioRoi,
      addPortfolioDuration,
      addPortfolioFundingSource,
      proxyAgentInfo,
    });
    if (!detailPartner) { toast.error('No partner selected'); return; }
    const amt = Number(String(addPortfolioAmount).replace(/[^\d.]/g, ''));
    const roi = Number(addPortfolioRoi);
    const duration = Number(addPortfolioDuration);

    if (isNaN(amt) || amt < 20000) { toast.error('Minimum portfolio invite amount: UGX 20,000'); return; }
    if (amt > MAX_INVEST) { toast.error(`Maximum investment: ${formatUGX(MAX_INVEST)}`); return; }
    if (isNaN(roi) || roi <= 0 || roi > 100) { toast.error('ROI must be between 1 and 100'); return; }
    if (isNaN(duration) || duration < 1 || duration > 60) { toast.error('Duration must be 1-60 months'); return; }
    const partnerId = detailPartner.profile.id;
    if (detailPartner.profile.frozen_at) { toast.error('Partner account is suspended. Unfreeze before sending an invite.'); return; }
    if (!detailPartner.profile.email) { toast.error('Partner has no email on file. Add an email before sending an invite.'); return; }


    setAddingPortfolio(true);
    try {
      const { data: result, error } = await supabase.functions.invoke('create-portfolio-invite', {
        body: {
          partner_id: partnerId,
          amount: amt,
          roi_percentage: roi,
          roi_mode: addPortfolioRoiMode,
          duration_months: duration,
        },
      });
      if (error) throw new Error(await extractFromErrorObject(error, 'Portfolio invite failed.'));
      if (result?.error) throw new Error(result.error);

      toast.success(`Invite sent — portfolio ${result.portfolio_code}`, {
        description: `${detailPartner.profile.full_name} will review, complete details and sign by email. It now appears in Invited Portfolios.`,
      });

      setAddPortfolioOpen(false);
      setAddPortfolioAmount('');
      setAddPortfolioRoi('20');
      setAddPortfolioRoiMode('monthly_payout');
      setAddPortfolioDuration('12');
      setAddPortfolioPayoutDay('15');
      setAddPortfolioDate('');
      setAddPortfolioFundingSource('wallet');
      setProxyAgentInfo(null);
      await openPartnerDetail(partnerId);
      refreshInBackground();
    } catch (e: any) {
      console.error('Portfolio invite error:', e);
      toast.error(e.message || 'Failed to send portfolio invite');
    } finally {
      setAddingPortfolio(false);
    }
  }

  /* ─── Open Edit Portfolio ─── */
  function openEditPortfolio(p: PortfolioRow) {
    setEditPortfolio(p);
    setEditPortfolioAmount(String(p.investment_amount));
    setEditPortfolioRoi(String(p.roi_percentage));
    setEditPortfolioRoiMode(p.roi_mode || 'monthly_payout');
    setEditPortfolioDuration(String(p.duration_months));
    setEditPortfolioStatus(p.status);
    setEditPortfolioDate(extractDateOnly(p.created_at) || '');
  }

  /* ─── Save Edit Portfolio ─── */
  async function handleSaveEditPortfolio() {
    if (!editPortfolio || !detailPartner) return;
    const amount = Number(editPortfolioAmount);
    const roi = Number(editPortfolioRoi);
    const duration = Number(editPortfolioDuration);
    if (isNaN(amount) || amount < MIN_INVEST) { toast.error(`Min investment: ${formatUGX(MIN_INVEST)}`); return; }
    if (isNaN(roi) || roi <= 0 || roi > 100) { toast.error('ROI must be 1-100%'); return; }
    if (isNaN(duration) || duration < 1 || duration > 120) { toast.error('Duration must be 1-120 months'); return; }

    setSavingEditPortfolio(true);
    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) throw new Error('Not authenticated');

      // Resolve editor name for audit trail (shown in PDF appendix)
      const { data: editorProfile } = await supabase
        .from('profiles')
        .select('full_name')
        .eq('id', user.id)
        .maybeSingle();

      // Audit log the edit
      await supabase.from('audit_logs').insert({
        user_id: user.id,
        action_type: 'edit_investment_portfolio',
        table_name: 'investor_portfolios',
        record_id: editPortfolio.id,
        metadata: {
          portfolio_code: editPortfolio.portfolio_code,
          partner_id: detailPartner.profile.id,
          partner_name: detailPartner.profile.full_name,
          editor_name: editorProfile?.full_name || null,
          edited_at: new Date().toISOString(),
          changes: {
            investment_amount: { from: editPortfolio.investment_amount, to: amount },
            roi_percentage: { from: editPortfolio.roi_percentage, to: roi },
            roi_mode: { from: editPortfolio.roi_mode, to: editPortfolioRoiMode },
            duration_months: { from: editPortfolio.duration_months, to: duration },
            status: { from: editPortfolio.status, to: editPortfolioStatus },
            created_at: { from: editPortfolio.created_at, to: editPortfolioDate ? dateOnlyToUtcMiddayIso(editPortfolioDate) : editPortfolio.created_at },
          },
        },
      });

      const updatePayload: Record<string, any> = {
        investment_amount: amount,
        roi_percentage: roi,
        roi_mode: editPortfolioRoiMode,
        duration_months: duration,
        status: editPortfolioStatus,
      };
      if (editPortfolioDate) {
        updatePayload.created_at = dateOnlyToUtcMiddayIso(editPortfolioDate);
      }

      const { error } = await supabase
        .from('investor_portfolios')
        .update(updatePayload)
        .eq('id', editPortfolio.id);
      if (error) throw error;

      toast.success(`Portfolio ${editPortfolio.portfolio_code} updated`);

      // NOTE: mode-switch into "compounding" does NOT send the compound
      // confirmation email. That email is reserved for an ACTUAL compound
      // event (Compound ROI button or Nearing Payout compound action),
      // where a real `roi_compounded` ledger + audit entry exists.

      // Update local state
      const updated = detailPartner.portfolios.map(p =>
        p.id === editPortfolio.id
          ? { ...p, investment_amount: amount, roi_percentage: roi, roi_mode: editPortfolioRoiMode, duration_months: duration, status: editPortfolioStatus, created_at: editPortfolioDate ? dateOnlyToUtcMiddayIso(editPortfolioDate) : p.created_at }
          : p
      );
      setDetailPartner({ ...detailPartner, portfolios: updated });
      setEditPortfolio(null);
      refreshInBackground();
    } catch (e: any) { toast.error(e.message || 'Failed to update portfolio'); }
    finally { setSavingEditPortfolio(false); }
  }

  /* ─── When ANY local filter is active (status, ROI mode, contact, wallet,  ───
     ─── payout date range), fetch ALL matching partners across every server  ───
     ─── page (scoped to the current search) so client-side filters evaluate  ───
     ─── against the whole dataset instead of only the visible 50-row page.   ───
     ─── Cleared when no local filter is active.                              ─── */
  useEffect(() => {
    const filterActive =
      filterStatus !== 'all' ||
      filterRoiMode !== 'all' ||
      filterContact !== 'all' ||
      filterWallet !== 'all' ||
      filterProspect !== 'all' ||
      !!payoutDateFrom ||
      !!payoutDateTo;
    if (!filterActive) {
      if (allRowsForPayoutFilter !== null) setAllRowsForPayoutFilter(null);
      return;
    }
    let cancelled = false;
    (async () => {
      setLoadingAllRowsForPayout(true);
      try {
        const allIds: string[] = [];
        let p = 0;
        while (p < 200) {
          const { ids } = filterProspect === 'prospects_only'
            ? await fetchVerifiedFundedProspectIds(p, PAGE_SIZE, debouncedSearch)
            : await fetchPaginatedSupporterIds(p, PAGE_SIZE, debouncedSearch);
          if (ids.length === 0) break;
          allIds.push(...ids);
          if (ids.length < PAGE_SIZE) break;
          p += 1;
        }
        const fullRows = allIds.length ? await buildRowsForIds(allIds) : [];
        if (!cancelled) setAllRowsForPayoutFilter(fullRows);
      } catch (e) {
        console.error('[local-filter] failed to fetch all partners', e);
        if (!cancelled) setAllRowsForPayoutFilter([]);
      } finally {
        if (!cancelled) setLoadingAllRowsForPayout(false);
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filterStatus, filterRoiMode, filterContact, filterWallet, filterProspect, payoutDateFrom, payoutDateTo, debouncedSearch, buildRowsForIds]);

  /* ─── Filtered / Sorted (local filters on current page, search is server-side) ─── */
  const processed = useMemo(() => {
    // When ANY local filter is active, evaluate against the full
    // (search-scoped) dataset so we don't miss partners on other pages.
    const sourceRows = allRowsForPayoutFilter ?? rows;
    let result = [...sourceRows];
    if (filterStatus !== 'all') result = result.filter(r => r.status === filterStatus);
    if (filterRoiMode !== 'all') result = result.filter(r => r.roiMode === filterRoiMode);
    if (filterContact === 'has_phone') result = result.filter(r => r.phone && !r.phone.includes('@'));
    else if (filterContact === 'no_phone') result = result.filter(r => !r.phone || r.phone.includes('@'));
    else if (filterContact === 'has_email') result = result.filter(r => r.email && !r.email.includes('placeholder'));
    else if (filterContact === 'no_email') result = result.filter(r => !r.email || r.email.includes('placeholder'));
    if (filterWallet === 'has_balance') result = result.filter(r => (r.walletBalance || 0) > 0);
    else if (filterWallet === 'empty') result = result.filter(r => (r.walletBalance || 0) <= 0);
    if (payoutDateFrom || payoutDateTo) {
      // Include partners that have ANY portfolio with a next-payout date
      // inside the selected window (inclusive on both ends).
      const fromMs = payoutDateFrom ? new Date(payoutDateFrom.getFullYear(), payoutDateFrom.getMonth(), payoutDateFrom.getDate()).getTime() : null;
      const toMs = payoutDateTo ? new Date(payoutDateTo.getFullYear(), payoutDateTo.getMonth(), payoutDateTo.getDate(), 23, 59, 59, 999).getTime() : null;
      result = result.filter(r => {
        const dates: string[] = ((r as any).payoutDates as string[] | undefined) ?? ((r as any).nextRoiDate ? [(r as any).nextRoiDate] : []);
        if (!dates.length) return false;
        return dates.some(d => {
          const t = new Date(d + 'T00:00:00').getTime();
          if (isNaN(t)) return false;
          if (fromMs !== null && t < fromMs) return false;
          if (toMs !== null && t > toMs) return false;
          return true;
        });
      });
    }
    if (sortKey && sortDir) {
      result.sort((a, b) => {
        const av = (a as any)[sortKey];
        const bv = (b as any)[sortKey];
        if (av == null && bv == null) return 0;
        if (av == null) return 1;
        if (bv == null) return -1;
        if (typeof av === 'number' && typeof bv === 'number') return sortDir === 'asc' ? av - bv : bv - av;
        return sortDir === 'asc' ? String(av).localeCompare(String(bv)) : String(bv).localeCompare(String(av));
      });
    }
    return result;
  }, [rows, allRowsForPayoutFilter, sortKey, sortDir, filterStatus, filterRoiMode, filterContact, filterWallet, payoutDateFrom, payoutDateTo]);

  // Detect any client-side filter that narrows results below the current page.
  // Server-side pagination only knows about `search` — every other filter runs
  // locally on the current page, so combining them with multi-page pagination
  // produces "No matching partners found" on later pages even though the pager
  // still shows e.g. 11/55. When local filters are active we collapse the pager
  // to a single page over the filtered current page.
  const hasLocalFilter =
    filterStatus !== 'all' ||
    filterRoiMode !== 'all' ||
    filterContact !== 'all' ||
    filterWallet !== 'all' ||
    filterProspect !== 'all' ||
    !!payoutDateFrom ||
    !!payoutDateTo;
  // When local filters are active we work over the full search-scoped dataset
  // (`processed`) and paginate it client-side at PAGE_SIZE per page so the
  // user still gets prev/next and at least 50 rows per view.
  const totalPages = hasLocalFilter
    ? Math.max(1, Math.ceil(processed.length / PAGE_SIZE))
    : Math.max(1, Math.ceil(totalCount / PAGE_SIZE));
  const safePage = Math.min(page, totalPages - 1);
  const paged = hasLocalFilter
    ? processed.slice(safePage * PAGE_SIZE, (safePage + 1) * PAGE_SIZE)
    : processed;

  function handleSort(key: string) {
    if (sortKey === key) {
      if (sortDir === 'asc') setSortDir('desc');
      else { setSortKey(null); setSortDir(null); }
    } else {
      setSortKey(key);
      setSortDir('asc');
    }
    setPage(0);
  }

  /* ─── Export: fetches ALL matching partners (across every page) and ─── */
  /* ─── re-applies the active local filters before writing the CSV.    ─── */
  const [exporting, setExporting] = useState(false);

  async function handleExportAll() {
    if (exporting) return;
    setExporting(true);
    try {
      // Page through all matching supporter ids using the same server-side
      // search predicate so the export reflects the full result set, not just
      // the rows currently rendered.
      const allIds: string[] = [];
      let p = 0;
      // Hard cap to avoid runaway loops; matches the 2000-match limit upstream.
      while (p < 200) {
        const { ids } = filterProspect === 'prospects_only'
          ? await fetchVerifiedFundedProspectIds(p, PAGE_SIZE, debouncedSearch)
          : await fetchPaginatedSupporterIds(p, PAGE_SIZE, debouncedSearch);
        if (ids.length === 0) break;
        allIds.push(...ids);
        if (ids.length < PAGE_SIZE) break;
        p += 1;
      }
      if (allIds.length === 0) {
        toast.info('No partners to export');
        return;
      }
      const fullRows = await buildRowsForIds(allIds);

      // Re-apply local filters (status / roiMode / contact / wallet / payout window)
      // so the exported CSV matches what the user is filtering for in the UI.
      let filtered = fullRows;
      if (filterStatus !== 'all') filtered = filtered.filter(r => r.status === filterStatus);
      if (filterRoiMode !== 'all') filtered = filtered.filter(r => r.roiMode === filterRoiMode);
      if (filterContact === 'has_phone') filtered = filtered.filter(r => r.phone && !r.phone.includes('@'));
      else if (filterContact === 'no_phone') filtered = filtered.filter(r => !r.phone || r.phone.includes('@'));
      else if (filterContact === 'has_email') filtered = filtered.filter(r => r.email && !r.email.includes('placeholder'));
      else if (filterContact === 'no_email') filtered = filtered.filter(r => !r.email || r.email.includes('placeholder'));
      if (filterWallet === 'has_balance') filtered = filtered.filter(r => (r.walletBalance || 0) > 0);
      else if (filterWallet === 'empty') filtered = filtered.filter(r => (r.walletBalance || 0) <= 0);
      if (payoutDateFrom || payoutDateTo) {
        const fromMs = payoutDateFrom ? new Date(payoutDateFrom.getFullYear(), payoutDateFrom.getMonth(), payoutDateFrom.getDate()).getTime() : null;
        const toMs = payoutDateTo ? new Date(payoutDateTo.getFullYear(), payoutDateTo.getMonth(), payoutDateTo.getDate(), 23, 59, 59, 999).getTime() : null;
        filtered = filtered.filter(r => {
          const dates: string[] = ((r as any).payoutDates as string[] | undefined) ?? ((r as any).nextRoiDate ? [(r as any).nextRoiDate] : []);
          if (!dates.length) return false;
          return dates.some(d => {
            const t = new Date(d + 'T00:00:00').getTime();
            if (isNaN(t)) return false;
            if (fromMs !== null && t < fromMs) return false;
            if (toMs !== null && t > toMs) return false;
            return true;
          });
        });
      }
      // Fetch portfolios for the filtered partners so the CSV can break each
      // deal out into its own row ("{{PartnerName}} ({{PortfolioName}})").
      const filteredIds = filtered.map(r => r.id);
      const exportPortfoliosRaw = await batchedQuery<any>(filteredIds, (batch) =>
        supabase.from('investor_portfolios')
          .select('id, investor_id, agent_id, account_name, portfolio_code, investment_amount, roi_percentage, total_roi_earned, payout_day, roi_mode, status, created_at, next_roi_date')
          .or(`investor_id.in.(${batch.join(',')}),agent_id.in.(${batch.join(',')})`)
          .in('status', ['active', 'pending_approval', 'pending'])
          .order('created_at', { ascending: false })
      );
      const seenExportPortfolioIds = new Set<string>();
      const exportPortfolios = (exportPortfoliosRaw as any[]).filter(p => {
        if (seenExportPortfolioIds.has(p.id)) return false;
        seenExportPortfolioIds.add(p.id);
        return true;
      });
      exportToCSV(filtered, exportPortfolios);
      toast.success(`Exported ${filtered.length} partner${filtered.length !== 1 ? 's' : ''}`);
    } catch (e: any) {
      console.error('Export failed', e);
      toast.error(e?.message || 'Export failed');
    } finally {
      setExporting(false);
    }
  }

  /* ─── Invest ─── */
  async function handleInvest() {
    if (!investPartner) return;
    const amt = Number(investAmount);
    if (isNaN(amt) || amt < MIN_INVEST) { toast.error(`Minimum: ${formatUGX(MIN_INVEST)}`); return; }
    if (amt > MAX_INVEST) { toast.error(`Maximum: ${formatUGX(MAX_INVEST)}`); return; }
    if (amt > investPartner.walletBalance) { toast.error(`Only ${formatUGX(investPartner.walletBalance)} available`); return; }
    setInvesting(true);
    try {
      const { data: result, error } = await supabase.functions.invoke('coo-invest-for-partner', {
        body: { partner_id: investPartner.id, amount: amt },
      });
      if (error) throw new Error(await extractFromErrorObject(error, 'Investment failed.'));
      if (result?.error) throw new Error(result.error);
      toast.success(`Invested ${formatUGX(amt)} for ${investPartner.name}`, { description: `Ref: ${result.reference_id}` });
      setInvestPartner(null);
      setInvestAmount('');
      refreshInBackground();
    } catch (e: any) { toast.error(e.message || 'Investment failed'); }
    finally { setInvesting(false); }
  }

  /* ─── Fetch proxy agent for wallet transfer dialog ─── */
  async function fetchProxyAgentForPartner(partnerId: string) {
    setLoadingProxyAgent(true);
    setProxyAgentInfo(null);
    try {
      const { data: proxyAssignment } = await supabase
        .from('proxy_agent_assignments')
        .select('agent_id')
        .eq('beneficiary_id', partnerId)
        .eq('is_active', true)
        .eq('approval_status', 'approved')
        .limit(1)
        .maybeSingle();

      if (proxyAssignment?.agent_id) {
        const [profileRes, walletRes] = await Promise.all([
          supabase.from('profiles').select('full_name').eq('id', proxyAssignment.agent_id).single(),
          supabase.from('wallets').select('balance, withdrawable_balance, float_balance').eq('user_id', proxyAssignment.agent_id).maybeSingle(),
        ]);
        setProxyAgentInfo({
          agentId: proxyAssignment.agent_id,
          agentName: profileRes.data?.full_name || 'Agent',
          walletBalance: walletRes.data ? Number(walletRes.data.balance) : 0,
          withdrawable: walletRes.data ? Number((walletRes.data as any).withdrawable_balance ?? 0) : 0,
          float: walletRes.data ? Number((walletRes.data as any).float_balance ?? 0) : 0,
        });
      }
    } catch { /* ignore */ }
    finally { setLoadingProxyAgent(false); }
  }

  /* ─── Wallet → Portfolio Transfer ─── */
  async function handleWalletToPortfolio() {
    if (!walletToPortfolio || !detailPartner) return;
    if (!isFunderCleared(detailPartner.profile)) {
      toast.error('Transfer blocked — self-registered funder not verified. Approve in Partner Ops → Verify Funder.');
      return;
    }
    const amt = Number(walletToPortfolioAmount);

    const sourceBalance = walletTransferMethod === 'wallet'
      ? (walletTransferFundSource === 'float' ? detailPartner.floatBalance : detailPartner.withdrawableBalance)
      : (walletTransferFundSource === 'float' ? (proxyAgentInfo?.float ?? 0) : (proxyAgentInfo?.withdrawable ?? proxyAgentInfo?.walletBalance ?? 0));
    const bucketLabel = walletTransferFundSource === 'float' ? 'operational float' : 'personal deposit';

    if (isNaN(amt) || amt < 1000) { toast.error('Minimum: UGX 1,000'); return; }
    if (amt > sourceBalance) { toast.error(`Only ${formatUGX(sourceBalance)} available in ${walletTransferMethod === 'wallet' ? 'partner' : 'proxy agent'} ${bucketLabel}`); return; }
    if (walletToPortfolioReason.trim().length < 10) { toast.error('Reason must be at least 10 characters'); return; }
    if (walletTransferMethod === 'proxy_agent' && !proxyAgentInfo) { toast.error('No proxy agent assigned'); return; }

    setWalletToPortfolioSaving(true);
    try {
      const { data: result, error } = await supabase.functions.invoke('coo-wallet-to-portfolio', {
        body: {
          portfolio_id: walletToPortfolio.id,
          amount: amt,
          reason: walletToPortfolioReason.trim(),
          payment_method: walletTransferMethod,
          fund_source: walletTransferFundSource,
          source_wallet_user_id: walletTransferMethod === 'proxy_agent' ? proxyAgentInfo?.agentId : detailPartner?.profile?.id,
        },
      });
      if (error) throw new Error(await extractFromErrorObject(error, 'Transfer failed.'));
      if (result?.error) throw new Error(result.error);

      const sourceLabel = `${walletTransferMethod === 'wallet' ? 'partner' : `${proxyAgentInfo?.agentName}'s`} ${bucketLabel}`;
      toast.success(`${formatUGX(amt)} top-up processed for ${walletToPortfolio.account_name || walletToPortfolio.portfolio_code}`, {
        description: `Deducted from ${sourceLabel}. Applied at maturity.`,
      });
      setWalletToPortfolio(null);
      setWalletToPortfolioAmount('');
      setWalletToPortfolioReason('');
      setWalletTransferFundSource('withdrawable');
      setProxyAgentInfo(null);
      if (detailPartner?.profile?.id) openPartnerDetail(detailPartner.profile.id);
      refreshInBackground();
    } catch (e: any) { toast.error(e.message || 'Transfer failed'); }
    finally { setWalletToPortfolioSaving(false); }
  }

  function openEdit(r: PartnerRow) {
    setEditPartner(r);
    setEditName(r.name);
    setEditPhone(r.phone);
    setEditRoi(String(r.roiPercentage));
    setEditRoiMode(r.roiMode || 'monthly_payout');
  }

  async function handleSaveEdit() {
    if (!editPartner) return;
    setSaving(true);
    try {
      const { error: profileErr } = await supabase
        .from('profiles')
        .update({ full_name: editName.trim(), phone: editPhone.trim() })
        .eq('id', editPartner.id);
      if (profileErr) throw profileErr;

      const newRoi = Number(editRoi);
      const updateFields: Record<string, any> = {};
      if (!isNaN(newRoi) && newRoi > 0 && newRoi <= 100) updateFields.roi_percentage = newRoi;
      if (editRoiMode === 'monthly_payout' || editRoiMode === 'monthly_compounding') updateFields.roi_mode = editRoiMode;

      if (Object.keys(updateFields).length > 0) {
        await supabase.from('investor_portfolios').update(updateFields).eq('investor_id', editPartner.id).in('status', ['active', 'pending']);
        await supabase.from('investor_portfolios').update(updateFields).eq('agent_id', editPartner.id).is('investor_id', null).in('status', ['active', 'pending']);
      }
      toast.success(`Updated ${editName.trim()}`);
      setEditPartner(null);
      refreshInBackground();
    } catch (e: any) { toast.error(e.message || 'Update failed'); }
    finally { setSaving(false); }
  }

  /* ─── Suspend / Reactivate ─── */
  async function handleToggleSuspend() {
    if (!suspendPartner) return;
    setSuspending(true);
    const shouldFreeze = suspendPartner.status === 'active';
    try {
      const { error } = await supabase
        .from('profiles')
        .update(shouldFreeze
          ? { frozen_at: new Date().toISOString(), frozen_reason: 'Suspended by COO' }
          : { frozen_at: null, frozen_reason: null }
        )
        .eq('id', suspendPartner.id);
      if (error) throw error;
      toast.success(`${suspendPartner.name} is now ${shouldFreeze ? 'suspended' : 'active'}`);
      setSuspendPartner(null);
      refreshInBackground();
    } catch (e: any) { toast.error(e.message || 'Failed'); }
    finally { setSuspending(false); }
  }

  /* ─── Delete Partner (Permanent) ─── */
  async function handleDeletePartner() {
    if (!deletePartnerTarget || deletePartnerReason.length < 10) return;
    setDeletingPartner(true);
    try {
      // Remove supporter role
      const { error: roleErr } = await supabase
        .from('user_roles')
        .delete()
        .eq('user_id', deletePartnerTarget.id)
        .eq('role', 'supporter');
      if (roleErr) throw roleErr;

      // Freeze the profile with deletion reason
      const { error: profileErr } = await supabase
        .from('profiles')
        .update({
          frozen_at: new Date().toISOString(),
          frozen_reason: `Deleted by COO: ${deletePartnerReason}`,
        })
        .eq('id', deletePartnerTarget.id);
      if (profileErr) throw profileErr;

      // Audit log
      const { data: { user: currentUser } } = await supabase.auth.getUser();
      await supabase.from('audit_logs').insert({
        user_id: currentUser?.id,
        action_type: 'partner_deleted',
        table_name: 'user_roles',
        record_id: deletePartnerTarget.id,
        metadata: {
          partner_name: deletePartnerTarget.name,
          reason: deletePartnerReason,
        },
      });

      toast.success(`${deletePartnerTarget.name} has been permanently deleted as a partner`);
      setDeletePartnerTarget(null);
      setDeletePartnerReason('');
      refreshInBackground();
    } catch (e: any) {
      toast.error(e.message || 'Failed to delete partner');
    } finally {
      setDeletingPartner(false);
    }
  }

  /* ─── Sort Icon ─── */
  function SortIcon({ colKey }: { colKey: string }) {
    if (sortKey !== colKey) return <ChevronsUpDown className="h-2.5 w-2.5 opacity-30" />;
    if (sortDir === 'asc') return <ChevronUp className="h-2.5 w-2.5 text-primary" />;
    return <ChevronDown className="h-2.5 w-2.5 text-primary" />;
  }

  /* ─── Column config (memoized so rows don't re-render on unrelated state changes) ─── */
  const columns = useMemo<{ key: string; label: string; align?: 'left' | 'right' | 'center'; sortable?: boolean; hideOnMobile?: boolean; render?: (r: PartnerRow) => React.ReactNode }[]>(() => [
    { key: 'name', label: 'Partner', render: (r) => (
      <button
        onClick={() => openPartnerDetail(r.id)}
        className="min-w-0 text-left group"
      >
        <p className="font-semibold text-foreground truncate group-hover:text-primary transition-colors underline-offset-2 group-hover:underline flex items-center gap-1.5">
          <span className="truncate">{r.name}</span>
          {r.isProspect && (
            <span className="shrink-0 inline-flex items-center gap-0.5 rounded-full bg-amber-500/15 text-amber-600 dark:text-amber-400 px-1.5 py-0.5 text-[8px] font-bold uppercase tracking-wide"><Sparkles className="h-2.5 w-2.5" />New prospect</span>
          )}
        </p>
        <p className="text-[10px] text-muted-foreground">{r.phone || '—'}</p>
      </button>
    )},
    { key: 'status', label: 'Status', render: (r) => (
      <span className={cn(
        'inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-wider',
        r.status === 'active' ? 'bg-primary/10 text-primary' : 'bg-destructive/15 text-destructive'
      )}>
        <span className={cn('w-1.5 h-1.5 rounded-full', r.status === 'active' ? 'bg-primary' : 'bg-destructive')} />
        {r.status}
      </span>
    )},
    { key: 'walletBalance', label: 'Wallet', align: 'right', render: (r) => (
      <span className={cn('font-semibold tabular-nums', r.walletBalance >= MIN_INVEST ? 'text-primary' : 'text-muted-foreground')}>
        {formatUGX(r.walletBalance)}
      </span>
    )},
    { key: 'funded', label: 'Total Funded', align: 'right', render: (r) => (
      <span className="font-semibold tabular-nums">{formatUGX(r.funded)}</span>
    )},
    { key: 'activeDeals', label: 'Deals', align: 'right', hideOnMobile: true },
    { key: 'roiPercentage', label: 'Returns', align: 'right', render: (r) => (
      <span className="font-bold text-primary">{r.roiPercentage}%</span>
    )},
    { key: 'roiMode', label: 'Mode', hideOnMobile: true, render: (r) => (
      <span className={cn(
        'px-2 py-0.5 rounded-full text-[10px] font-semibold',
        r.roiMode === 'monthly_compounding' ? 'bg-primary/10 text-primary' : 'bg-muted text-muted-foreground'
      )}>
        {r.roiMode === 'monthly_compounding' ? 'Compound' : 'Payout'}
      </span>
    )},
    { key: 'nextRoiDate', label: 'Next Payout', align: 'right', hideOnMobile: true, render: (r) => (
      <span className="text-muted-foreground">
        {r.nextRoiDate
          ? new Date(r.nextRoiDate + 'T00:00:00').toLocaleDateString('en-UG', { month: 'short', day: 'numeric' })
          : '—'}
      </span>
    )},
    { key: 'joinedAt', label: 'Joined', sortable: true, hideOnMobile: true, render: (r) => (
      <span className="text-muted-foreground text-xs">
        {r.joinedAt ? new Date(r.joinedAt).toLocaleDateString() : '—'}
      </span>
    )},
    {
      key: 'actions', label: '', sortable: false, render: (r) => (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon" className="h-7 w-7" onClick={e => e.stopPropagation()}>
              <MoreHorizontal className="h-4 w-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-48">
            <DropdownMenuItem onClick={e => { e.stopPropagation(); openEdit(r); }} className="gap-2">
              <Pencil className="h-3.5 w-3.5" /> Edit Partner
            </DropdownMenuItem>
            <DropdownMenuItem
              disabled={r.walletBalance < MIN_INVEST || r.status === 'suspended'}
              onClick={e => { e.stopPropagation(); setInvestPartner(r); }}
              className="gap-2"
            >
              <TrendingUp className="h-3.5 w-3.5" /> Invest {r.walletBalance >= MIN_INVEST ? '' : '(Low bal)'}
            </DropdownMenuItem>
            {!readOnly && (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  onClick={e => { e.stopPropagation(); setSuspendPartner(r); }}
                  className={cn('gap-2', r.status === 'active' ? 'text-amber-600 focus:text-amber-600' : 'text-primary focus:text-primary')}
                >
                  {r.status === 'active' ? <Ban className="h-3.5 w-3.5" /> : <PlayCircle className="h-3.5 w-3.5" />}
                  {r.status === 'active' ? 'Suspend' : 'Reactivate'}
                </DropdownMenuItem>
                <DropdownMenuItem
                  onClick={e => { e.stopPropagation(); setDeletePartnerTarget(r); setDeletePartnerReason(''); }}
                  className="gap-2 text-destructive focus:text-destructive"
                >
                  <Trash2 className="h-3.5 w-3.5" /> Delete Partner
                </DropdownMenuItem>
              </>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      )
    },
  ], [readOnly]);

  /* ─── Render ─── */
  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-20">
        <Loader2 className="h-6 w-6 animate-spin text-primary" />
      </div>
    );
  }


  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div>
          <h1 className="text-xl sm:text-2xl font-black tracking-tight">Partner Management</h1>
          <p className="text-sm text-muted-foreground mt-0.5">Monitor, manage, and invest for all supporters & partners</p>
        </div>
        <div className="flex items-center gap-2 self-start">
          <Button size="sm" className="gap-1.5" onClick={() => setCreatePortfolioOpen(true)}>
            <Mail className="h-3.5 w-3.5" /> Create Portfolio
          </Button>
          <Button variant="outline" size="sm" onClick={fetchData} className="gap-1.5">
            <RefreshCw className="h-3.5 w-3.5" /> Refresh
          </Button>
        </div>
      </div>

      {/* Summary Cards */}
      {summary && (
        <div className="grid grid-cols-2 lg:grid-cols-3 gap-3">
          <SummaryCard icon={<Users className="h-4 w-4" />} label="Total Partners" value={summary.totalPartners}
            sub={`${summary.activePartners} active · ${summary.suspendedPartners} suspended`} accent="primary" />
          <PendingPortfoliosCard onClick={() => setPendingPortfoliosOpen(true)} />
          <SummaryCard icon={<Wallet className="h-4 w-4" />} label="Wallet Balances" value={formatUGX(summary.totalWalletBalance)}
            sub="Across all partner wallets · tap to view" accent="amber"
            onClick={() => { setWalletBalancesSearch(''); setWalletBalancesOpen(true); }} />
          <NearingPayoutsCard portfolios={allPortfoliosForPayout} onClick={() => setNearingPayoutsOpen(true)} />
          <ExpiringPortfoliosCard portfolios={allPortfoliosForPayout} onClick={() => setExpiringPortfoliosOpen(true)} />
          <PortfolioTopUpsCard />
        </div>
      )}

      {/* Filters Bar */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative flex-1 min-w-[180px] max-w-xs">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
          <input type="text" value={search} onChange={e => setSearch(e.target.value)}
            placeholder="Search by name or phone…"
            className="h-9 w-full rounded-lg border border-border bg-background pl-8 pr-8 text-sm placeholder:text-muted-foreground/60 focus:outline-none focus:ring-2 focus:ring-primary/30 transition-colors" />
          {isSearching ? (
            <Loader2 className="absolute right-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-primary animate-spin" />
          ) : search ? (
            <button onClick={() => { setSearch(''); setPage(0); }} className="absolute right-2 top-1/2 -translate-y-1/2 p-0.5 rounded hover:bg-muted">
              <X className="h-3 w-3 text-muted-foreground" />
            </button>
          ) : null}
        </div>
        <Select value={filterStatus} onValueChange={(v: any) => { setFilterStatus(v); setPage(0); }}>
          <SelectTrigger className="w-[120px] h-9 text-xs"><Filter className="h-3 w-3 mr-1 text-muted-foreground" /><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Status</SelectItem>
            <SelectItem value="active">Active</SelectItem>
            <SelectItem value="suspended">Suspended</SelectItem>
          </SelectContent>
        </Select>
        <Select value={filterRoiMode} onValueChange={(v: any) => { setFilterRoiMode(v); setPage(0); }}>
          <SelectTrigger className="w-[140px] h-9 text-xs"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Modes</SelectItem>
            <SelectItem value="monthly_payout">Payout</SelectItem>
            <SelectItem value="monthly_compounding">Compounding</SelectItem>
          </SelectContent>
        </Select>
        <Select value={filterContact} onValueChange={(v: any) => { setFilterContact(v); setPage(0); }}>
          <SelectTrigger className="w-[140px] h-9 text-xs"><Phone className="h-3 w-3 mr-1 text-muted-foreground" /><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Contacts</SelectItem>
            <SelectItem value="has_phone">Has Phone</SelectItem>
            <SelectItem value="no_phone">No Phone</SelectItem>
            <SelectItem value="has_email">Has Email</SelectItem>
            <SelectItem value="no_email">No Email</SelectItem>
          </SelectContent>
        </Select>
        <Select value={filterWallet} onValueChange={(v: any) => { setFilterWallet(v); setPage(0); }}>
          <SelectTrigger className="w-[140px] h-9 text-xs"><Wallet className="h-3 w-3 mr-1 text-muted-foreground" /><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Wallets</SelectItem>
            <SelectItem value="has_balance">Has Balance</SelectItem>
            <SelectItem value="empty">Empty</SelectItem>
          </SelectContent>
        </Select>
        <Select value={filterProspect} onValueChange={(v: any) => { setFilterProspect(v); setPage(0); }}>
          <SelectTrigger className={cn("w-[170px] h-9 text-xs", filterProspect === 'prospects_only' && "border-amber-500 text-amber-600 dark:text-amber-400")}>
            <Sparkles className="h-3 w-3 mr-1" /><SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Partners</SelectItem>
            <SelectItem value="prospects_only">New Prospects Only</SelectItem>
          </SelectContent>
        </Select>
        {/* Payment Date Range Filter */}
        <Popover>
          <PopoverTrigger asChild>
            <Button variant="outline" size="sm" className={cn("h-9 gap-1.5 text-xs", (payoutDateFrom || payoutDateTo) && "border-primary text-primary")}>
              {loadingAllRowsForPayout && (payoutDateFrom || payoutDateTo)
                ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
                : <CalendarDays className="h-3.5 w-3.5" />}
              {payoutDateFrom && payoutDateTo
                ? `${format(payoutDateFrom, 'MMM d')} – ${format(payoutDateTo, 'MMM d')}`
                : payoutDateFrom
                  ? `From ${format(payoutDateFrom, 'MMM d')}`
                  : payoutDateTo
                    ? `Until ${format(payoutDateTo, 'MMM d')}`
                    : 'Payout Range'}
            </Button>
          </PopoverTrigger>
          <PopoverContent className="w-auto p-3" align="start">
            <div className="space-y-3">
              <div className="text-xs font-semibold text-muted-foreground">Filter by next payout date</div>
              <div className="flex gap-3">
                <div className="space-y-1">
                  <Label className="text-[10px] uppercase tracking-wider text-muted-foreground">From</Label>
                  <Calendar mode="single" selected={payoutDateFrom} onSelect={(d) => { setPayoutDateFrom(d); setSortKey('payoutDay'); setSortDir('asc'); setPage(0); }} className="p-2 pointer-events-auto" />
                </div>
                <div className="space-y-1">
                  <Label className="text-[10px] uppercase tracking-wider text-muted-foreground">To</Label>
                  <Calendar mode="single" selected={payoutDateTo} onSelect={(d) => { setPayoutDateTo(d); setSortKey('payoutDay'); setSortDir('asc'); setPage(0); }} className="p-2 pointer-events-auto" />
                </div>
              </div>
              {(payoutDateFrom || payoutDateTo) && (
                <Button variant="ghost" size="sm" className="w-full text-xs" onClick={() => { setPayoutDateFrom(undefined); setPayoutDateTo(undefined); setPage(0); }}>
                  <X className="h-3 w-3 mr-1" /> Clear Date Range
                </Button>
              )}
            </div>
          </PopoverContent>
        </Popover>
        <Button variant="outline" size="sm" className="h-9 gap-1.5 text-xs" onClick={() => setImportOpen(true)}>
          <Upload className="h-3.5 w-3.5" /> Import
        </Button>
        <Button variant="outline" size="sm" className="h-9 gap-1.5 text-xs" onClick={() => setUpdateDatesOpen(true)}>
          <CalendarDays className="h-3.5 w-3.5" /> Update Dates
        </Button>
        {pendingApprovalCount > 0 && (
          <Button
            size="sm"
            className="h-9 gap-1.5 text-xs bg-emerald-600 hover:bg-emerald-700 text-white"
            onClick={() => setShowActivateConfirm(true)}
          >
            <CheckCircle2 className="h-3.5 w-3.5" />
            Activate All ({pendingApprovalCount})
          </Button>
        )}
        <Button variant="outline" size="sm" className="h-9 gap-1.5 text-xs ml-auto" onClick={handleExportAll} disabled={exporting}>
          {exporting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Download className="h-3.5 w-3.5" />}
          {exporting ? 'Exporting…' : 'Export CSV'}
        </Button>
      </div>

      {/* Table */}
      <div className="rounded-xl border border-border bg-card shadow-sm overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-xs sm:text-sm min-w-[640px]">
            <thead>
              <tr className="border-b-2 border-border bg-muted/60">
                <th className="px-2 sm:px-3 py-2.5 text-[9px] sm:text-[10px] font-black uppercase tracking-widest text-muted-foreground text-center w-10">#</th>
                {columns.map(col => {
                  const isSortable = col.sortable !== false;
                  return (
                    <th key={col.key} onClick={() => isSortable && handleSort(col.key)}
                      className={cn(
                        'px-2 sm:px-3 py-2.5 text-[9px] sm:text-[10px] font-black uppercase tracking-widest text-muted-foreground whitespace-nowrap select-none',
                        col.align === 'right' ? 'text-right' : 'text-left',
                        col.hideOnMobile && 'hidden lg:table-cell',
                        isSortable && 'cursor-pointer hover:text-foreground transition-colors'
                      )}>
                      <span className="inline-flex items-center gap-1">
                        {col.label}
                        {isSortable && col.label && <SortIcon colKey={col.key} />}
                      </span>
                    </th>
                  );
                })}
              </tr>
            </thead>
            <tbody className="divide-y divide-border/30">
               {(isSearching || (loadingAllRowsForPayout && paged.length === 0)) && paged.length === 0 ? (
                Array.from({ length: 6 }).map((_, i) => (
                  <tr key={`sk-${i}`} className="animate-pulse">
                    <td className="px-2 sm:px-3 py-3"><div className="h-3 w-4 bg-muted rounded" /></td>
                    {columns.map(col => (
                      <td key={col.key} className={cn('px-2 sm:px-3 py-3', col.hideOnMobile && 'hidden lg:table-cell')}>
                        <div className="h-3 w-20 bg-muted rounded" />
                      </td>
                    ))}
                  </tr>
                ))
              ) : paged.length === 0 ? (
                <tr>
                  <td colSpan={columns.length + 1} className="px-4 py-12 text-center text-sm text-muted-foreground italic">
                    {hasLocalFilter
                      ? (filterProspect === 'prospects_only'
                          ? 'No verified wallet-funded prospects without a portfolio'
                          : 'No partners match the selected filters')
                      : search
                        ? `No matching partners found for "${search}"`
                        : 'No partners registered'}
                  </td>
                </tr>
              ) : (
                paged.map((row, i) => (
                  <tr key={row.id} className={cn('transition-colors', i % 2 === 0 ? 'bg-card' : 'bg-muted/15', 'hover:bg-primary/[0.04]', row.status === 'suspended' && 'opacity-60')}>
                    <td className="px-2 sm:px-3 py-2 text-[10px] font-bold text-muted-foreground/50 text-center tabular-nums">
                      {safePage * PAGE_SIZE + i + 1}
                    </td>
                    {columns.map(col => (
                      <td key={col.key} className={cn('px-2 sm:px-3 py-2 tabular-nums', col.align === 'right' ? 'text-right' : 'text-left', col.hideOnMobile && 'hidden lg:table-cell')}>
                        {col.render ? col.render(row) : String((row as any)[col.key] ?? '—')}
                      </td>
                    ))}
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
        {/* Pagination */}
        <div className="flex items-center justify-between px-3 py-2 border-t border-border bg-muted/30">
          <span className="text-[10px] sm:text-xs font-semibold text-muted-foreground tabular-nums flex items-center gap-1.5">
            {loadingAllRowsForPayout && <Loader2 className="h-3 w-3 animate-spin text-primary" />}
            {hasLocalFilter
              ? `${processed.length.toLocaleString()} of ${totalCount.toLocaleString()} (filtered)`
              : processed.length === rows.length
                ? `${rows.length.toLocaleString()} partner${rows.length !== 1 ? 's' : ''}`
                : `${processed.length.toLocaleString()} of ${rows.length.toLocaleString()} (filtered)`}
          </span>
          {totalPages > 1 && (
            <div className="flex items-center gap-1">
              <button onClick={() => setPage(p => Math.max(0, p - 1))} disabled={safePage === 0}
                className="p-1 rounded hover:bg-muted disabled:opacity-20 transition-colors"><ChevronLeft className="h-4 w-4" /></button>
              <span className="text-xs font-bold tabular-nums text-muted-foreground px-2">{safePage + 1}/{totalPages}</span>
              <button onClick={() => setPage(p => Math.min(totalPages - 1, p + 1))} disabled={safePage >= totalPages - 1}
                className="p-1 rounded hover:bg-muted disabled:opacity-20 transition-colors"><ChevronRight className="h-4 w-4" /></button>
            </div>
          )}
        </div>
      </div>

      {/* ─── Partner Detail Dialog ─── */}
      <Dialog open={(!!detailPartner || detailLoading) && !detailHiddenForCompound} onOpenChange={open => { if (!open && !compoundPreview) { setDetailPartner(null); setEditingPortfolioId(null); setEditingNextPayoutId(null); } }}>
        <DialogContent className="sm:max-w-2xl max-h-[90vh] overflow-y-auto p-0">
          {detailLoading ? (
            <div className="flex items-center justify-center py-20">
              <Loader2 className="h-6 w-6 animate-spin text-primary" />
            </div>
          ) : detailPartner ? (
            <>
              {/* Hero Header */}
              <div className="relative bg-gradient-to-br from-primary/10 via-primary/5 to-transparent p-5 pb-4">
                <div className="flex items-start gap-4">
                  <div className="w-14 h-14 rounded-2xl bg-primary/15 flex items-center justify-center text-xl font-black text-primary shrink-0">
                    {detailPartner.profile.full_name?.charAt(0)?.toUpperCase() || '?'}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <h2 className="text-lg font-black tracking-tight">{detailPartner.profile.full_name}</h2>
                      <Badge variant={detailPartner.profile.frozen_at ? 'destructive' : 'default'} className="text-[10px]">
                        {detailPartner.profile.frozen_at ? 'Suspended' : 'Active'}
                      </Badge>
                      {detailPartner.profile.funder_verified_at ? (
                        <Badge variant="outline" className="text-[10px] border-success/40 text-success bg-success/10 gap-1">
                          <ShieldCheck className="h-3 w-3" /> Verified
                        </Badge>
                      ) : detailPartner.profile.signup_source === SELF_REG_SOURCE ? (
                        <Badge variant="outline" className="text-[10px] border-amber-500/40 text-amber-600 bg-amber-500/10 gap-1">
                          <Shield className="h-3 w-3" /> Unverified
                        </Badge>
                      ) : (
                        <Badge variant="outline" className="text-[10px] border-muted-foreground/30 text-muted-foreground gap-1">
                          <ShieldCheck className="h-3 w-3" /> Legacy partner
                        </Badge>
                      )}
                    </div>
                    <div className="flex items-center gap-4 mt-1.5 text-xs text-muted-foreground flex-wrap">
                      <span className="inline-flex items-center gap-1"><Phone className="h-3 w-3" />{detailPartner.profile.phone || '—'}</span>
                      <span className="inline-flex items-center gap-1 min-w-0">
                        <Mail className="h-3 w-3 shrink-0" />
                        <span className="truncate">{detailPartner.profile.email || '—'}</span>
                      </span>
                      <span className="inline-flex items-center gap-1"><CalendarIcon className="h-3 w-3" />Joined {formatDate(detailPartner.profile.created_at)}</span>
                    </div>
                    {detailPartner.profile.frozen_at && (
                      <p className="text-[11px] text-destructive mt-1.5 bg-destructive/10 px-2 py-1 rounded-md inline-block">
                        <Shield className="h-3 w-3 inline mr-1" />Suspended: {detailPartner.profile.frozen_reason || 'No reason given'}
                      </p>
                    )}
                    {!isFunderCleared(detailPartner.profile) && (
                      <div className="mt-2 rounded-lg border border-amber-500/30 bg-amber-500/10 p-2.5 flex items-start gap-2">
                        <Shield className="h-4 w-4 text-amber-600 shrink-0 mt-0.5" />
                        <div className="text-[11px]">
                          <p className="font-bold text-amber-700 dark:text-amber-400">
                            Top-ups blocked — funder not verified
                          </p>
                          <p className="text-muted-foreground mt-0.5">
                            Self-registered partner. Approve in Partner Ops → Verify Funder before any portfolio top-up.
                          </p>
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              </div>

              <div className="px-5 pb-5 space-y-5">
                {/* Financial Summary Cards */}
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5">
                  <MiniKPI icon={<Wallet className="h-3.5 w-3.5" />} label="Wallet Balance" value={formatUGX(detailPartner.walletBalance)} variant="primary" />
                  <MiniKPI icon={<Banknote className="h-3.5 w-3.5" />} label="Principal" value={formatUGX(detailPartner.totalFunded)} variant="emerald" />
                  <MiniKPI icon={<TrendingUp className="h-3.5 w-3.5" />} label="Returns Earned" value={formatUGX(detailPartner.totalROIEarned)} variant="amber" />
                  <MiniKPI icon={<Briefcase className="h-3.5 w-3.5" />} label="Portfolios" value={detailPartner.portfolios.length + detailSelfCommitments.length} variant="violet" />
                </div>

                <Separator />

                {/* Self-managed portfolios (Self Portfolio Management) */}
                {detailSelfCommitments.length > 0 && (
                  <div>
                    <div className="flex items-center justify-between mb-3">
                      <h3 className="text-sm font-black uppercase tracking-widest text-muted-foreground">Self-Managed Portfolios</h3>
                      <Badge variant="outline" className="text-[10px] tabular-nums">{detailSelfCommitments.length} total</Badge>
                    </div>
                    <div className="space-y-2.5">
                      {detailSelfCommitments.map((c, idx) => {
                        const expanded = !!expandedSelfTenants[c.id];
                        const statusColor = c.status === 'active'
                          ? 'bg-primary/10 text-primary'
                          : c.status === 'matured'
                            ? 'bg-amber-500/10 text-amber-600'
                            : 'bg-muted text-muted-foreground';
                        return (
                          <Card key={c.id} className="overflow-hidden transition-all">
                            <div className="p-3.5">
                              {/* Header row — mirrors investment portfolio cards */}
                              <div className="flex items-start gap-2 mb-2.5">
                                <div className="w-8 h-8 rounded-lg bg-violet-500/10 flex items-center justify-center text-xs font-black text-violet-600 dark:text-violet-300 shrink-0">
                                  #{idx + 1}
                                </div>
                                <div className="flex-1 min-w-0">
                                  <div className="flex items-center gap-1.5 flex-wrap">
                                    <p className="text-sm font-bold truncate">Self-managed portfolio</p>
                                    <span className={cn('px-1.5 py-0.5 rounded text-[9px] font-bold uppercase whitespace-nowrap shrink-0', statusColor)}>
                                      {String(c.status).replace(/_/g, ' ')}
                                    </span>
                                    <span className="px-2 py-0.5 rounded-full text-[9px] font-bold uppercase tracking-wide bg-violet-500/15 text-violet-600 dark:text-violet-300 border border-violet-500/30 whitespace-nowrap shrink-0">
                                      Self-managed
                                    </span>
                                  </div>
                                  <p className="text-[10px] text-muted-foreground">{timeSince(c.created_at)} · {c.term_months}mo term</p>
                                </div>
                              </div>

                              {/* Committed amount — full width */}
                              <p className="text-lg font-black tabular-nums mb-1.5">{formatUGX(c.committed_amount)}</p>

                              {/* Details grid — same shell as investment portfolio cards */}
                              <div className="grid grid-cols-2 sm:grid-cols-4 gap-x-4 gap-y-1.5 text-xs bg-muted/30 rounded-lg p-2.5">
                                <div>
                                  <span className="text-muted-foreground">Returns Rate</span>
                                  <p className="font-bold text-primary">{c.monthly_rate}%</p>
                                </div>
                                <div>
                                  <span className="text-muted-foreground">Monthly Returns</span>
                                  <p className="font-bold">{formatUGX(Math.round(c.committed_amount * (c.monthly_rate / 100)))}</p>
                                </div>
                                <div>
                                  <span className="text-muted-foreground">Mode</span>
                                  <p className="font-semibold">💰 Payout</p>
                                </div>
                                <div>
                                  <span className="text-muted-foreground">Total Earned</span>
                                  <p className="font-bold text-primary">{formatUGX(c.total_earned)}</p>
                                </div>
                                <div>
                                  <span className="text-muted-foreground">Paid Out</span>
                                  <p className="font-semibold">{formatUGX(c.total_paid)}</p>
                                </div>
                                <div>
                                  <span className="text-muted-foreground">Duration</span>
                                  <p className="font-semibold">{c.term_months} months</p>
                                </div>
                                <div>
                                  <span className="text-muted-foreground">Next Payout</span>
                                  <p className="font-semibold">{c.next_payout_at ? formatDate(c.next_payout_at) : '—'}</p>
                                </div>
                                <div>
                                  <span className="text-muted-foreground">Term Ends</span>
                                  <p className="font-semibold">{c.term_end_at ? formatDate(c.term_end_at) : '—'}</p>
                                </div>
                              </div>

                              {/* Payout day row */}
                              <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-1 mt-2.5 pt-2.5 border-t border-border/50">
                                <div className="flex items-center gap-2 text-xs flex-wrap">
                                  <CalendarDays className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                                  <span className="text-muted-foreground">Payout Day:</span>
                                  <span className="font-bold">
                                    {c.payout_day
                                      ? `${c.payout_day}${getOrdinalSuffix(c.payout_day)} of month`
                                      : 'Not set'}
                                  </span>
                                </div>
                                {c.next_payout_at && (
                                  <span className="text-[10px] text-muted-foreground flex items-center gap-1 pl-5 sm:pl-0">
                                    <Clock className="h-3 w-3" /> Next: {formatDate(c.next_payout_at)}
                                  </span>
                                )}
                              </div>

                              {/* Tenants supported — count only, expandable */}
                              <button
                                type="button"
                                onClick={() => setExpandedSelfTenants(prev => ({ ...prev, [c.id]: !prev[c.id] }))}
                                className="mt-3 w-full flex items-center justify-between gap-2 rounded-lg border border-border bg-muted/30 px-2.5 py-2 text-left hover:bg-muted/60 transition-colors"
                                aria-expanded={expanded}
                              >
                                <span className="text-[11px] font-semibold">
                                  Tenants supported
                                  <span className="ml-1.5 tabular-nums text-muted-foreground font-bold">{c.lines_count}</span>
                                </span>
                                <span className="inline-flex items-center gap-1 text-[10px] text-muted-foreground">
                                  {expanded ? 'Hide' : 'View'}
                                  {expanded
                                    ? <ChevronUp className="h-3 w-3" />
                                    : <ChevronDown className="h-3 w-3" />}
                                </span>
                              </button>
                              {expanded && (
                                c.lines.length > 0 ? (
                                  <div className="mt-2 space-y-1.5">
                                    {c.lines.map(l => (
                                      <div key={l.id} className="flex items-center justify-between gap-2 rounded-lg bg-muted/40 px-2.5 py-1.5">
                                        <span className="text-[11px] font-medium truncate">{l.tenant_name || 'Tenant'}</span>
                                        <span className="text-[11px] tabular-nums text-muted-foreground">
                                          {formatUGX(l.principal)} · <span className="capitalize">{String(l.status).replace(/_/g, ' ')}</span>
                                        </span>
                                      </div>
                                    ))}
                                  </div>
                                ) : (
                                  <p className="mt-2 text-[11px] text-muted-foreground px-2.5">No tenants linked yet.</p>
                                )
                              )}
                            </div>
                          </Card>
                        );
                      })}
                    </div>
                    <Separator className="mt-5" />
                  </div>
                )}

                {/* Portfolio Breakdown */}
                <div>
                  <div className="flex items-center justify-between mb-3">
                    <h3 className="text-sm font-black uppercase tracking-widest text-muted-foreground">Investment Portfolios</h3>
                    <div className="flex items-center gap-2">
                      <Button
                        size="sm"
                        className="h-7 px-3 text-[10px] gap-1"
                        onClick={() => {
                          setAddPortfolioFundingSource('wallet');
                          setProxyAgentInfo(null);
                          if (detailPartner?.profile?.id) fetchProxyAgentForPartner(detailPartner.profile.id);
                          setAddPortfolioOpen(true);
                        }}
                      >
                        <Plus className="h-3 w-3" /> Add Portfolio
                      </Button>
                      <Badge variant="outline" className="text-[10px] tabular-nums">{detailPartner.portfolios.length} total</Badge>
                    </div>
                  </div>

                  {detailPartner.portfolios.length === 0 ? (
                    <div className="rounded-xl border-2 border-dashed border-border p-8 text-center text-sm text-muted-foreground">
                      No portfolios found for this partner.
                    </div>
                  ) : (
                    <div className="space-y-2.5">
                      {detailPartner.portfolios.map((p, idx) => {
                        const isEditing = editingPortfolioId === p.id;
                        const monthlyROI = Math.round(p.investment_amount * (p.roi_percentage / 100));
                        const statusColor = p.status === 'active' ? 'bg-primary/10 text-primary' : p.status === 'matured' ? 'bg-amber-500/10 text-amber-600' : 'bg-muted text-muted-foreground';

                        return (
                              (() => {
                                // Portfolio is LOCKED for edits when a renewal is
                                // scheduled (Partner Ops already approved an early
                                // renewal, cron will apply it at maturity midnight).
                                const pendingRenewalDate = p.pending_renewal_effective_date
                                  ? new Date(`${p.pending_renewal_effective_date}T00:00:00`)
                                  : null;
                                const isPendingRenewal = !!pendingRenewalDate;
                                const daysToRenewal = pendingRenewalDate
                                  ? Math.max(0, Math.ceil((pendingRenewalDate.getTime() - Date.now()) / 86400000))
                                  : 0;
                                const isPendingRedemption = !!pendingRedemptions[p.id];
                                const lastRenewalAt = recentRenewals[p.id] ? new Date(recentRenewals[p.id]) : null;
                                const renewedRecently = !!lastRenewalAt && (Date.now() - lastRenewalAt.getTime()) < 30 * 86400000;
                                const renewedDaysAgo = lastRenewalAt ? Math.floor((Date.now() - lastRenewalAt.getTime()) / 86400000) : 0;
                                return (
                              <Card
                                key={p.id}
                                className={cn(
                                  'overflow-hidden transition-all',
                                  isEditing && 'ring-2 ring-primary/30',
                                  isPendingRenewal && 'ring-2 ring-purple-400/40 bg-purple-50/30 dark:bg-purple-950/20 opacity-95',
                                  isPendingRedemption && 'ring-2 ring-amber-400/50 bg-amber-50/40 dark:bg-amber-950/20',
                                )}
                              >
                                {isPendingRedemption && (
                                  <div className="flex items-center gap-2 px-3.5 py-2 border-b border-amber-200 bg-amber-100/70 dark:bg-amber-900/30 dark:border-amber-800/60 text-[11px] font-semibold text-amber-900 dark:text-amber-200">
                                    <RefreshCw className="h-3.5 w-3.5" />
                                    <span>Partner requested payout at maturity — portfolio locked from edits until redemption is processed.</span>
                                    <span className="ml-auto uppercase tracking-wide text-[9px] bg-amber-200/70 dark:bg-amber-800/60 px-1.5 py-0.5 rounded">
                                      Locked
                                    </span>
                                  </div>
                                )}
                                {isPendingRenewal && (
                                  <div className="flex items-center gap-2 px-3.5 py-2 border-b border-purple-200 bg-purple-100/70 dark:bg-purple-900/30 dark:border-purple-800/60 text-[11px] font-semibold text-purple-800 dark:text-purple-200">
                                    <RefreshCw className="h-3.5 w-3.5" />
                                    <span>
                                      Auto-renews on {pendingRenewalDate!.toLocaleDateString('en-UG', { day: 'numeric', month: 'short', year: 'numeric' })}
                                      {daysToRenewal > 0
                                        ? ` — in ${daysToRenewal} day${daysToRenewal === 1 ? '' : 's'}`
                                        : ' — awaiting cron'}
                                    </span>
                                    <span className="ml-auto uppercase tracking-wide text-[9px] bg-purple-200/70 dark:bg-purple-800/60 px-1.5 py-0.5 rounded">
                                      Scheduled
                                    </span>
                                  </div>
                                )}
                            <div className="p-3.5">
                              {/* Portfolio header row */}
                              <div className="flex items-start gap-2 mb-2.5">
                                <div className="w-8 h-8 rounded-lg bg-primary/10 flex items-center justify-center text-xs font-black text-primary shrink-0">
                                  #{idx + 1}
                                </div>
                                <div className="flex-1 min-w-0">
                                  {/* Account name above ID */}
                                  {p.account_name && editingNameId !== p.id && (
                                    <p className="text-xs font-semibold text-foreground leading-tight truncate">{p.account_name}</p>
                                  )}
                                  <div className="flex items-center justify-between gap-1.5 flex-wrap">
                                    <div className="flex items-center gap-1.5">
                                      <p className={cn('text-sm font-bold truncate', p.account_name ? 'text-muted-foreground text-xs' : '')}>{p.portfolio_code}</p>
                                      <span className={cn('px-1.5 py-0.5 rounded text-[9px] font-bold uppercase whitespace-nowrap shrink-0', statusColor)}>
                                        {p.status}
                                      </span>
                                      {isPendingRenewal && (
                                        <span
                                          className="px-2 py-0.5 rounded-full text-[10px] font-bold bg-purple-500/15 text-purple-600 dark:text-purple-300 border border-purple-500/30 whitespace-nowrap shrink-0 inline-flex items-center gap-1"
                                          title={`Auto-renews on ${pendingRenewalDate!.toLocaleDateString('en-UG', { day: 'numeric', month: 'short', year: 'numeric' })}`}
                                        >
                                          <RefreshCw className="h-2.5 w-2.5" />
                                          {daysToRenewal > 0
                                            ? `Renews in ${daysToRenewal} day${daysToRenewal === 1 ? '' : 's'}`
                                            : 'Renews today'}
                                        </span>
                                      )}
                                      {renewedRecently && !isPendingRenewal && (
                                        <span
                                          className="px-2 py-0.5 rounded-full text-[10px] font-bold bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 border border-emerald-500/30 whitespace-nowrap shrink-0 inline-flex items-center gap-1"
                                          title={`Renewed on ${lastRenewalAt!.toLocaleDateString('en-UG', { day: 'numeric', month: 'short', year: 'numeric' })}`}
                                        >
                                          <RefreshCw className="h-2.5 w-2.5" />
                                          {renewedDaysAgo === 0 ? 'Renewed today' : `Renewed ${renewedDaysAgo}d ago`}
                                        </span>
                                      )}
                                    </div>
                                    {approvedTopUps[p.id]?.total > 0 && (
                                       <span className="px-2 py-0.5 rounded-full text-[10px] font-bold bg-amber-500/15 text-amber-600 dark:text-amber-400 border border-amber-500/20 whitespace-nowrap shrink-0">
                                         ⏳ Pending Principal +{formatUGX(approvedTopUps[p.id].total)}
                                       </span>
                                    )}
                                    {autoAppliedTopUps[p.id]?.total > 0 && (
                                       <span
                                         className="px-2 py-0.5 rounded-full text-[10px] font-bold bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 border border-emerald-500/20 whitespace-nowrap shrink-0"
                                         title="Parked top-up(s) were automatically merged into principal at the ROI cycle"
                                       >
                                         ✅ Auto-applied +{formatUGX(autoAppliedTopUps[p.id].total)}
                                       </span>
                                    )}
                                    {(pendingTopUps[p.id]?.total > 0 || awaitingVerification[p.id]?.total > 0) && (
                                      <span className="px-2 py-0.5 rounded-full text-[10px] font-bold bg-amber-500/15 text-amber-600 dark:text-amber-400 border border-amber-500/20 whitespace-nowrap shrink-0">
                                        ⏳ Awaiting Top-up {formatUGX((pendingTopUps[p.id]?.total || 0) + (awaitingVerification[p.id]?.total || 0))}
                                      </span>
                                    )}
                                  </div>
                                  {/* Inline name edit */}
                                  {editingNameId === p.id ? (
                                    <div className="flex items-center gap-1.5 mt-1.5 w-full">
                                      <Input
                                        value={editingNameValue}
                                        onChange={e => setEditingNameValue(e.target.value)}
                                        placeholder="Enter portfolio name..."
                                        className="h-9 flex-1 min-w-0 text-sm"
                                        autoFocus
                                        onKeyDown={e => {
                                          if (e.key === 'Enter') handleSavePortfolioName(p.id);
                                          if (e.key === 'Escape') setEditingNameId(null);
                                        }}
                                      />
                                      <Button size="sm" className="h-9 px-3 text-xs min-w-[44px]" onClick={() => handleSavePortfolioName(p.id)} disabled={savingName}>
                                        {savingName ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
                                      </Button>
                                      <Button size="sm" variant="ghost" className="h-9 px-3 text-xs min-w-[44px]" onClick={() => setEditingNameId(null)}>
                                        <X className="h-3.5 w-3.5" />
                                      </Button>
                                    </div>
                                  ) : (
                                    <button
                                      onClick={() => { setEditingNameId(p.id); setEditingNameValue(p.account_name || ''); }}
                                      className="flex items-center gap-1 mt-0.5 text-[10px] text-muted-foreground hover:text-primary transition-colors"
                                    >
                                      <Pencil className="h-2.5 w-2.5" />
                                      {p.account_name ? 'Edit Name' : 'Add Name'}
                                    </button>
                                  )}
                                  <p className="text-[10px] text-muted-foreground">{timeSince(p.created_at)} · {p.duration_months}mo term</p>
                                </div>
                              </div>
                              {/* Investment amount - full width on mobile */}
                              <p className="text-lg font-black tabular-nums mb-1">{formatUGX(p.investment_amount)}</p>
                              {pendingTopUps[p.id] && (
                                <div className="flex items-center gap-1.5 mb-1">
                                  <Badge variant="outline" className="text-[10px] px-2 py-0.5 border-amber-500/40 text-amber-600 bg-amber-500/5">
                                    ⏳ {pendingTopUps[p.id].count} pending top-up{pendingTopUps[p.id].count > 1 ? 's' : ''}: {formatUGX(pendingTopUps[p.id].total)}
                                  </Badge>
                                </div>
                              )}
                              {pendingTopUps[p.id] && (
                                 <p className="text-[9px] text-muted-foreground mb-1.5 pl-0.5">
                                   Auto-clears daily — merges into capital only after the next Returns payout is approved (cron runs 7:00 PM EAT)
                                 </p>
                              )}
                              {awaitingVerification[p.id] && (
                                <div className="flex items-center gap-1.5 mb-2.5">
                                  <Badge variant="outline" className="text-[10px] px-2 py-0.5 border-blue-500/40 text-blue-600 bg-blue-500/5">
                                    🔍 {awaitingVerification[p.id].count} awaiting verification: {formatUGX(awaitingVerification[p.id].total)}
                                  </Badge>
                                </div>
                              )}
                              {approvedTopUps[p.id] && (
                                <div className="flex items-center gap-1.5 mb-2.5">
                                   <Badge variant="outline" className="text-[10px] px-2 py-0.5 border-amber-500/40 text-amber-600 bg-amber-500/5">
                                     ⏳ {formatUGX(approvedTopUps[p.id].total)} top-up waiting to be added ({approvedTopUps[p.id].count} pending) — joins the balance right after the next returns payout
                                   </Badge>
                                </div>
                              )}

                              {/* Details grid */}
                              <div className="grid grid-cols-2 sm:grid-cols-4 gap-x-4 gap-y-1.5 text-xs bg-muted/30 rounded-lg p-2.5">
                                <div>
                                  <span className="text-muted-foreground">Returns Rate</span>
                                  <p className="font-bold text-primary">{p.roi_percentage}%</p>
                                </div>
                                <div>
                                  <span className="text-muted-foreground">Monthly Returns</span>
                                  <p className="font-bold">{formatUGX(monthlyROI)}</p>
                                </div>
                                <div>
                                  <span className="text-muted-foreground">Mode</span>
                                  <p className="font-semibold">{p.roi_mode === 'monthly_compounding' ? '📈 Compound' : '💰 Payout'}</p>
                                </div>
                                <div>
                                  <span className="text-muted-foreground">Total Earned</span>
                                  <p className="font-bold text-primary">{formatUGX(p.total_roi_earned)}</p>
                                </div>
                                <div>
                                  <span className="text-muted-foreground">Contributed On</span>
                                  <p className="font-semibold">{formatDate(p.created_at)}</p>
                                </div>
                                <div>
                                  <span className="text-muted-foreground">Duration</span>
                                  <p className="font-semibold">{p.duration_months} months</p>
                                </div>
                                <div>
                                  <span className="text-muted-foreground">Next Payout</span>
                                  {editingNextPayoutId === p.id ? (
                                    <div className="flex items-center gap-1 mt-1">
                                      <Input
                                        type="date"
                                        value={editingNextPayoutDate}
                                        onChange={e => setEditingNextPayoutDate(e.target.value)}
                                        className="h-7 w-full text-xs"
                                      />
                                      <Button size="icon" variant="ghost" className="h-6 w-6 shrink-0" onClick={() => handleSaveNextPayoutDate(p.id)} disabled={savingPortfolio}>
                                        {savingPortfolio ? <Loader2 className="h-3 w-3 animate-spin" /> : <Save className="h-3 w-3" />}
                                      </Button>
                                      <Button size="icon" variant="ghost" className="h-6 w-6 shrink-0" onClick={() => setEditingNextPayoutId(null)}>
                                        <X className="h-3 w-3" />
                                      </Button>
                                    </div>
                                  ) : (
                                    <div className="flex items-center gap-1.5">
                                      <p className="font-semibold">
                                        {(() => {
                                          const nd = getNextPayoutDate(p.next_roi_date, p.created_at, p.payout_day ?? 15);
                                          return new Date(nd + 'T00:00:00').toLocaleDateString('en-UG', { month: 'long', day: 'numeric', year: 'numeric' });
                                        })()}
                                      </p>
                                      {!readOnly && (
                                        <button
                                          onClick={() => {
                                            setEditingNextPayoutId(p.id);
                                            const nd = getNextPayoutDate(p.next_roi_date, p.created_at, p.payout_day ?? 15);
                                            setEditingNextPayoutDate(nd);
                                          }}
                                          className="p-1 rounded-md hover:bg-muted text-muted-foreground hover:text-foreground transition-colors"
                                          title="Edit next payout date"
                                        >
                                          <Pencil className="h-3 w-3" />
                                        </button>
                                      )}
                                    </div>
                                  )}
                                </div>
                                <div>
                                  <span className="text-muted-foreground">Payout Status</span>
                                  <p className="font-semibold">
                                    {p.status === 'active'
                                      ? <span className="text-primary">🟢 Active</span>
                                      : p.status === 'pending_approval'
                                        ? <span className="text-amber-600">⏸ Awaiting Approval</span>
                                        : <span className="text-amber-600">⏸ {p.status === 'pending' ? 'Pending' : p.status}</span>}
                                  </p>
                                </div>
                              </div>

                              {/* Payout Day Row */}
                              <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-1 mt-2.5 pt-2.5 border-t border-border/50">
                                <div className="flex items-center gap-2 text-xs flex-wrap">
                                  <CalendarDays className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                                  <span className="text-muted-foreground">Payout Day:</span>
                                  {isEditing ? (
                                    <div className="flex items-center gap-1.5">
                                      <Input
                                        type="number" min={1} max={28}
                                        value={editingPayoutDay}
                                        onChange={e => setEditingPayoutDay(e.target.value)}
                                        className="h-7 w-16 text-xs text-center"
                                      />
                                      <Button size="sm" className="h-7 px-2 text-[10px]" onClick={() => handleSavePortfolioPayoutDay(p.id)} disabled={savingPortfolio}>
                                        {savingPortfolio ? <Loader2 className="h-3 w-3 animate-spin" /> : <Save className="h-3 w-3" />}
                                      </Button>
                                      <Button size="sm" variant="ghost" className="h-7 px-2 text-[10px]" onClick={() => setEditingPortfolioId(null)}>
                                        <X className="h-3 w-3" />
                                      </Button>
                                    </div>
                                  ) : (
                                    <div className="flex items-center gap-1.5">
                                      <span className="font-bold">
                                        {p.payout_day
                                          ? `${p.payout_day}${getOrdinalSuffix(p.payout_day)} of month`
                                          : p.next_roi_date
                                            ? `${new Date(p.next_roi_date + 'T00:00:00').getDate()}${getOrdinalSuffix(new Date(p.next_roi_date + 'T00:00:00').getDate())} of month`
                                            : 'Not set'}
                                      </span>
                                      {!readOnly && (
                                        <button
                                          onClick={() => { setEditingPortfolioId(p.id); setEditingPayoutDay(String(p.payout_day)); }}
                                          className="p-1 rounded-md hover:bg-muted text-muted-foreground hover:text-foreground transition-colors"
                                          title="Edit payout day"
                                        >
                                          <Pencil className="h-3 w-3" />
                                        </button>
                                      )}
                                    </div>
                                  )}
                                </div>
                                {(
                                  <span className="text-[10px] text-muted-foreground flex items-center gap-1 pl-5 sm:pl-0">
                                    <Clock className="h-3 w-3" /> Next: {(() => {
                                      const nd = getNextPayoutDate(p.next_roi_date, p.created_at, p.payout_day ?? 15);
                                      return new Date(nd + 'T00:00:00').toLocaleDateString('en-UG', { month: 'short', day: 'numeric', year: 'numeric' });
                                    })()}
                                  </span>
                                )}
                              </div>

                              {/* Edit, Approve, Top Up & Delete Portfolio Buttons */}
                              <fieldset
                                disabled={isPendingRedemption}
                                className={cn(
                                  'mt-2.5 pt-2.5 border-t border-border/50',
                                  isPendingRedemption && 'opacity-60 cursor-not-allowed',
                                )}
                                title={isPendingRedemption ? 'Portfolio is locked — partner requested payout at maturity.' : undefined}
                              >
                              <div className="grid grid-cols-2 sm:flex sm:flex-wrap sm:items-center sm:justify-end gap-1.5">
                                {(p.status === 'pending_approval' || p.status === 'pending') && (
                                  <Button
                                    variant="ghost"
                                    size="sm"
                                    className="h-9 px-3 text-xs text-success hover:text-success hover:bg-success/10 gap-1.5 font-semibold min-h-[44px]"
                                    onClick={() => handleApprovePortfolio(p.id)}
                                    disabled={approvingId === p.id}
                                  >
                                    {approvingId === p.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <CheckCircle2 className="h-3.5 w-3.5" />}
                                    Approve
                                  </Button>
                                )}
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  className="h-9 px-3 text-xs text-primary hover:text-primary hover:bg-primary/10 gap-1.5 min-h-[44px]"
                                  onClick={() => openEditPortfolio(p)}
                                >
                                  <Pencil className="h-3.5 w-3.5" /> Edit
                                </Button>
                                {!readOnly && (
                                  <Button
                                    variant="ghost"
                                    size="sm"
                                    className="h-9 px-3 text-xs text-sky-600 hover:text-sky-700 hover:bg-sky-500/10 gap-1.5 min-h-[44px]"
                                    onClick={() => { setPaymentDetailsPortfolio(p); setPaymentDetailsOpen(true); }}
                                    title="Set MoMo / bank details for this portfolio"
                                  >
                                    <Banknote className="h-3.5 w-3.5" /> Payment Details
                                  </Button>
                                )}
                                {!readOnly && p.status === 'active' && (
                                  <Button
                                    variant="ghost"
                                    size="sm"
                                    className="h-9 px-3 text-xs text-emerald-600 hover:text-emerald-700 hover:bg-emerald-500/10 gap-1.5 min-h-[44px]"
                                    onClick={() => {
                                      setTopUpPortfolio(p);
                                      setTopUpOpen(true);
                                    }}
                                  >
                                    <Wallet className="h-3.5 w-3.5" /> Top Up
                                  </Button>
                                )}
                                {!readOnly && p.status === 'active' && detailPartner && detailPartner.walletBalance > 0 && (
                                  <Button
                                    variant="ghost"
                                    size="sm"
                                    className="h-9 px-3 text-xs text-primary hover:text-primary hover:bg-primary/10 gap-1.5 min-h-[44px]"
                                    onClick={() => {
                                      setWalletToPortfolio(p);
                                      setWalletToPortfolioAmount('');
                                      setWalletToPortfolioReason('');
                                      setWalletTransferMethod('wallet');
                                      if (detailPartner?.profile?.id) fetchProxyAgentForPartner(detailPartner.profile.id);
                                    }}
                                  >
                                    <ArrowRightLeft className="h-3.5 w-3.5" /> Wallet → Portfolio
                                  </Button>
                                )}
                                {!readOnly && pendingTopUps[p.id] && (
                                  <Button
                                    variant="ghost"
                                    size="sm"
                                    className="h-9 px-3 text-xs text-amber-600 hover:text-amber-700 hover:bg-amber-500/10 gap-1.5 font-semibold min-h-[44px]"
                                    onClick={() => handleApplyPendingTopUps(p.id)}
                                    disabled={applyingTopUps === p.id}
                                  >
                                    {applyingTopUps === p.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ShieldCheck className="h-3.5 w-3.5" />}
                                    Submit {pendingTopUps[p.id].count} for Verification
                                  </Button>
                                )}
                                {awaitingVerification[p.id] && (
                                  <Badge variant="outline" className="text-[10px] px-2 py-1 border-blue-500/40 text-blue-600 bg-blue-500/5 gap-1">
                                    <Clock className="h-3 w-3" />
                                    Awaiting Financial Ops
                                  </Badge>
                                )}
                                {!readOnly && (
                                  <Button
                                    variant="ghost"
                                    size="sm"
                                    className="h-9 px-3 text-xs text-amber-600 hover:text-amber-700 hover:bg-amber-500/10 gap-1.5 min-h-[44px]"
                                    onClick={() => { setRenewPortfolio(p); setRenewOpen(true); }}
                                  >
                                    <RefreshCw className="h-3.5 w-3.5" /> Renew
                                    {(renewalCounts[p.id] || 0) > 0 && (
                                      <Badge variant="outline" className="ml-1 text-[9px] px-1.5 py-0 h-4 border-amber-500/40 text-amber-600">
                                        ×{renewalCounts[p.id]}
                                      </Badge>
                                    )}
                                  </Button>
                                )}
                                {!readOnly && (
                                  <Button
                                    variant="ghost"
                                    size="sm"
                                    className="h-9 px-3 text-xs text-destructive hover:text-destructive hover:bg-destructive/10 gap-1.5 min-h-[44px]"
                                    onClick={() => { setDeletePortfolio(p); setDeleteReason(''); }}
                                  >
                                    <Trash2 className="h-3.5 w-3.5" /> Delete
                                  </Button>
                                )}
                                {!readOnly && approvedTopUps[p.id]?.total > 0 && (
                                  <Button
                                    variant="ghost"
                                    size="sm"
                                    className="h-9 px-3 text-xs text-amber-600 hover:text-amber-700 hover:bg-amber-500/10 gap-1.5 font-semibold min-h-[44px]"
                                    onClick={() => { setMergeDialogPortfolioId(p.id); setMergeReason(''); }}
                                  >
                                    <ArrowRightLeft className="h-3.5 w-3.5" /> Apply Top-up
                                  </Button>
                                )}
                                {!readOnly && approvedTopUps[p.id]?.total > 0 && (
                                  <Button
                                    variant="ghost"
                                    size="sm"
                                    className="h-9 px-3 text-xs text-destructive hover:text-destructive hover:bg-destructive/10 gap-1.5 font-semibold min-h-[44px]"
                                    onClick={() => { setCancelDialogPortfolioId(p.id); setCancelReason(''); }}
                                    title="Cancel pending top-up and refund partner wallet"
                                  >
                                    <Ban className="h-3.5 w-3.5" /> Cancel Top-up ({formatUGX(approvedTopUps[p.id].total)})
                                  </Button>
                                )}
                                {!readOnly && p.status === 'active' && (
                                  <Button
                                    variant="ghost"
                                    size="sm"
                                    className="h-9 px-3 text-xs text-primary hover:text-primary hover:bg-primary/5 gap-1.5 min-h-[44px]"
                                    disabled={compoundingPortfolioId === p.id}
                                    onClick={() => openCompoundPreview(p)}
                                  >
                                    {compoundingPortfolioId === p.id
                                      ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
                                      : <TrendingUp className="h-3.5 w-3.5" />}
                                    Compound
                                  </Button>
                                )}
                                {!readOnly && p.status !== 'locked' && (
                                  <Button
                                    variant="ghost"
                                    size="sm"
                                    className="h-9 px-3 text-xs text-amber-700 hover:text-amber-800 hover:bg-amber-500/10 gap-1.5 min-h-[44px]"
                                    onClick={() => {
                                      setLockPortfolio({
                                        id: p.id,
                                        portfolio_code: p.portfolio_code,
                                        investment_amount: Number(p.investment_amount) || 0,
                                        status: p.status,
                                      });
                                      setLockOpen(true);
                                    }}
                                    title="Lock the full principal or split what stays active"
                                  >
                                    <Lock className="h-3.5 w-3.5" /> Lock
                                  </Button>
                                )}
                              </div>
                              </fieldset>

                            </div>
                          </Card>
                                );
                              })()
                        );
                      })}
                    </div>
                  )}
                </div>
              </div>
            </>
          ) : null}
        </DialogContent>
      </Dialog>

      {/* ─── Add Portfolio Dialog ─── */}
      <Dialog open={addPortfolioOpen} onOpenChange={open => { if (!open) setAddPortfolioOpen(false); }}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Plus className="h-5 w-5 text-primary" /> Add Funding Portfolio
            </DialogTitle>
            <DialogDescription>
              Create a new portfolio for {detailPartner?.profile.full_name}. Funds are deducted from the selected wallet immediately.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            {/* Funding Source Selector */}
            <div className="space-y-2">
              <Label>Funding Source *</Label>
              <div className="grid grid-cols-2 gap-2">
                <button
                  type="button"
                  onClick={() => setAddPortfolioFundingSource('wallet')}
                  className={`p-3 rounded-lg border text-left transition-colors ${
                    addPortfolioFundingSource === 'wallet'
                      ? 'border-primary bg-primary/5 ring-1 ring-primary'
                      : 'border-border hover:bg-muted/40'
                  }`}
                >
                  <div className="flex items-center gap-2 text-xs font-semibold">
                    <Wallet className="h-3.5 w-3.5 text-primary" /> Partner Wallet
                  </div>
                  <p className="text-[11px] text-muted-foreground mt-1 truncate">{detailPartner?.profile.full_name}</p>
                  <div className="mt-1.5 space-y-0.5">
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-[10px] text-muted-foreground">Withdrawable</span>
                      <span className="text-xs font-bold text-primary">{detailPartner ? formatUGX(detailPartner.withdrawableBalance) : '—'}</span>
                    </div>
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-[10px] text-muted-foreground">Float</span>
                      <span className="text-xs font-semibold text-muted-foreground">{detailPartner ? formatUGX(detailPartner.floatBalance) : '—'}</span>
                    </div>
                  </div>
                </button>
                <button
                  type="button"
                  onClick={() => proxyAgentInfo && setAddPortfolioFundingSource('proxy_agent')}
                  disabled={!proxyAgentInfo && !loadingProxyAgent}
                  className={`p-3 rounded-lg border text-left transition-colors ${
                    addPortfolioFundingSource === 'proxy_agent'
                      ? 'border-primary bg-primary/5 ring-1 ring-primary'
                      : 'border-border hover:bg-muted/40'
                  } ${!proxyAgentInfo ? 'opacity-60 cursor-not-allowed' : ''}`}
                >
                  <div className="flex items-center gap-2 text-xs font-semibold">
                    <Users className="h-3.5 w-3.5 text-primary" /> Proxy Agent Wallet
                  </div>
                  {loadingProxyAgent ? (
                    <p className="text-[11px] text-muted-foreground mt-1">Checking...</p>
                  ) : proxyAgentInfo ? (
                    <>
                      <p className="text-[11px] text-muted-foreground mt-1 truncate">{proxyAgentInfo.agentName}</p>
                      <p className="text-sm font-bold mt-1">{formatUGX(proxyAgentInfo.walletBalance)}</p>
                    </>
                  ) : (
                    <p className="text-[11px] text-muted-foreground mt-1">No proxy agent assigned</p>
                  )}
                </button>
              </div>
              {addPortfolioFundingSource === 'proxy_agent' && proxyAgentInfo && Number(addPortfolioAmount) > proxyAgentInfo.walletBalance && (
                <p className="text-[11px] text-destructive">⚠ Amount exceeds proxy agent wallet balance</p>
              )}
              {addPortfolioFundingSource === 'wallet' && detailPartner && Number(addPortfolioAmount) > detailPartner.withdrawableBalance && (
                <p className="text-[11px] text-destructive">
                  ⚠ Amount exceeds withdrawable balance. Only {formatUGX(detailPartner.withdrawableBalance)} is investable
                  {detailPartner.floatBalance > 0 && <> — {formatUGX(detailPartner.floatBalance)} is operational float and cannot be used.</>}
                </p>
              )}
            </div>

            <div className="space-y-2">
              <Label>Investment Amount (UGX) *</Label>
              <Input
                type="number"
                min={MIN_INVEST}
                value={addPortfolioAmount}
                onChange={e => setAddPortfolioAmount(e.target.value)}
                placeholder="Min 20,000"
              />
              <p className="text-xs text-muted-foreground">
                Minimum UGX 20,000. This sends a secure email link; no wallet is debited until partner completion and Ops approval.
              </p>
              <div className="flex gap-2 flex-wrap">
                {[500000, 1000000, 2000000, 5000000, 10000000].map(a => (
                  <Button key={a} variant="outline" size="sm" className="text-xs h-7"
                    onClick={() => setAddPortfolioAmount(String(a))}>
                    {a >= 1000000 ? `${(a / 1000000).toFixed(0)}M` : `${(a / 1000).toFixed(0)}K`}
                  </Button>
                ))}
              </div>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-2">
                <Label>Returns Rate (%)</Label>
                <Input type="number" min={1} max={100} value={addPortfolioRoi}
                  onChange={e => setAddPortfolioRoi(e.target.value)} />
              </div>
              <div className="space-y-2">
                <Label>Duration (months)</Label>
                <Input type="number" min={1} max={60} value={addPortfolioDuration}
                  onChange={e => setAddPortfolioDuration(e.target.value)} />
              </div>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-2">
                <Label>Returns Mode</Label>
                <Select value={addPortfolioRoiMode} onValueChange={setAddPortfolioRoiMode}>
                  <SelectTrigger className="h-9"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="monthly_payout">💰 Monthly Payout</SelectItem>
                    <SelectItem value="monthly_compounding">📈 Compounding</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label className="text-muted-foreground text-xs">Payout Day</Label>
                <p className="text-sm font-medium text-foreground">Auto-derived from contribution date</p>
              </div>
            </div>

            <div className="space-y-2">
              <Label>Contribution Date (optional, for backdating)</Label>
              <Input type="date" value={addPortfolioDate}
                onChange={e => setAddPortfolioDate(e.target.value)} />
              <p className="text-[10px] text-muted-foreground">Leave empty for today's date</p>
            </div>

            {addPortfolioAmount && Number(addPortfolioAmount) >= 20000 && (
              <div className="p-3 rounded-lg bg-muted/30 border border-border/50 text-xs space-y-1">
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Amount:</span>
                  <span className="font-bold">{formatUGX(Number(addPortfolioAmount))}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Monthly Returns:</span>
                  <span className="font-bold text-primary">{formatUGX(Math.round(Number(addPortfolioAmount) * (Number(addPortfolioRoi) / 100)))}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Maturity:</span>
                  <span className="font-semibold">{addPortfolioDuration} months</span>
                </div>
              </div>
            )}
            {addPortfolioAmount && Number(addPortfolioAmount) < 20000 && (
              <p className="text-xs text-destructive">Amount must be at least UGX 20,000</p>
            )}
            {addPortfolioAmount && Number(addPortfolioAmount) > MAX_INVEST && (
              <p className="text-xs text-destructive">Amount must not exceed {formatUGX(MAX_INVEST)}</p>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setAddPortfolioOpen(false)} disabled={addingPortfolio}>Cancel</Button>
            <Button
              type="button"
              variant="secondary"
              disabled={addingPortfolio || !detailPartner}
              onClick={() => {
                if (!detailPartner?.profile) return;
                setAddPortfolioOpen(false);
                setInvitePartnerPortfolio({
                  id: detailPartner.profile.id,
                  full_name: detailPartner.profile.full_name,
                  email: detailPartner.profile.email,
                });
              }}
            >
              <Mail className="h-4 w-4 mr-2" /> Invite via email
            </Button>
            <Button
              type="button"
              onClick={handleAddPortfolio}
              disabled={addingPortfolio || !addPortfolioAmount || Number(addPortfolioAmount) < 20000 || Number(addPortfolioAmount) > MAX_INVEST}
            >
              {addingPortfolio ? <><Loader2 className="h-4 w-4 mr-2 animate-spin" /> Creating...</> : <><Mail className="h-4 w-4 mr-2" /> Create Portfolio</>}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Invite existing partner to add a new portfolio (Ops sends secure email link) */}
      <InvitePartnerPortfolioDialog
        open={!!invitePartnerPortfolio}
        onOpenChange={(o) => { if (!o) setInvitePartnerPortfolio(null); }}
        partner={invitePartnerPortfolio}
        onSent={() => { refreshInBackground(); fetchPendingCount(); }}
      />

      {/* ─── Invest Dialog ─── */}
      <Dialog open={!!investPartner} onOpenChange={open => { if (!open) { setInvestPartner(null); setInvestAmount(''); } }}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2"><TrendingUp className="h-5 w-5 text-primary" /> Invest for {investPartner?.name}</DialogTitle>
            <DialogDescription>Deploy capital from partner wallet into the Rent Pool. Min: {formatUGX(MIN_INVEST)}.</DialogDescription>
          </DialogHeader>
          {investPartner && (
            <div className="space-y-4">
              <div className="flex items-center gap-2 p-3 rounded-lg bg-muted/50 border border-border/60">
                <Wallet className="h-4 w-4 text-muted-foreground" /><span className="text-sm text-muted-foreground">Available:</span>
                <span className="text-sm font-bold">{formatUGX(investPartner.walletBalance)}</span>
              </div>
              <div className="space-y-2">
                <Label>Investment Amount (UGX)</Label>
                <Input type="number" min={MIN_INVEST} max={investPartner.walletBalance} value={investAmount}
                  onChange={e => setInvestAmount(e.target.value)} placeholder={`Min ${MIN_INVEST.toLocaleString()}`} />
                <p className="text-xs text-muted-foreground">
                  {investHelperRange(investPartner.walletBalance)}
                </p>
                <div className="flex gap-2 flex-wrap">
                  {[1000, 5000, 10000, 50000, 100000, 200000, 500000].filter(a => a <= investPartner.walletBalance).map(a => (
                    <Button key={a} variant="outline" size="sm" className="text-xs h-7" onClick={() => setInvestAmount(String(a))}>{(a / 1000).toFixed(0)}K</Button>
                  ))}
                  <Button variant="outline" size="sm" className="text-xs h-7" onClick={() => setInvestAmount(String(investPartner.walletBalance))}>Max</Button>
                </div>
              </div>
              <div className="p-3 rounded-lg bg-muted/30 border border-border/50 text-xs text-muted-foreground">
                📅 Payout Cycle: <strong className="text-foreground">Every 30 days</strong> from investment date
              </div>
              {investAmount && Number(investAmount) >= MIN_INVEST && (
                <div className="text-xs bg-primary/5 border border-primary/20 rounded-lg p-3 space-y-1">
                  <p>Monthly reward ({investPartner.roiPercentage}%): <strong className="text-primary">{formatUGX(Math.round(Number(investAmount) * (investPartner.roiPercentage / 100)))}</strong></p>
                  <p>Remaining wallet: <strong>{formatUGX(investPartner.walletBalance - Number(investAmount))}</strong></p>
                </div>
              )}
              {investAmount && Number(investAmount) < MIN_INVEST && (
                <p className="text-xs text-destructive">Amount must be at least UGX 1,000</p>
              )}
              {investAmount && Number(investAmount) > Math.min(MAX_INVEST, investPartner.walletBalance) && (
                <p className="text-xs text-destructive">Amount must not exceed {formatUGX(Math.min(MAX_INVEST, investPartner.walletBalance))}</p>
              )}
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setInvestPartner(null)}>Cancel</Button>
            <Button onClick={handleInvest} disabled={investing || !investAmount || !isInvestAmountValid(Number(investAmount), investPartner.walletBalance)}>
              {investing && <Loader2 className="h-4 w-4 animate-spin mr-2" />} Confirm Investment
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ─── Edit Dialog ─── */}
      <Dialog open={!!editPartner} onOpenChange={open => { if (!open) setEditPartner(null); }}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2"><Pencil className="h-5 w-5 text-primary" /> Edit Partner</DialogTitle>
            <DialogDescription>Update partner profile, returns rate, and mode.</DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label className="text-xs">Full Name</Label>
                <Input value={editName} onChange={e => setEditName(e.target.value)} />
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs">Phone</Label>
                <Input value={editPhone} onChange={e => setEditPhone(e.target.value)} />
              </div>
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">Returns Percentage (%)</Label>
              <Input type="number" min={1} max={100} value={editRoi} onChange={e => setEditRoi(e.target.value)} />
              <div className="flex gap-1.5">
                {[10, 15, 20, 25].map(v => (
                  <Button key={v} variant={editRoi === String(v) ? 'default' : 'outline'} size="sm" className="text-[10px] h-6 px-2 flex-1"
                    onClick={() => setEditRoi(String(v))}>{v}%</Button>
                ))}
              </div>
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">Returns Payment Mode</Label>
              <div className="grid grid-cols-2 gap-2">
                <Button variant={editRoiMode === 'monthly_payout' ? 'default' : 'outline'} size="sm" className="text-xs h-9"
                  onClick={() => setEditRoiMode('monthly_payout')}>
                  <ArrowUpRight className="h-3.5 w-3.5 mr-1.5" /> Monthly Payout
                </Button>
                <Button variant={editRoiMode === 'monthly_compounding' ? 'default' : 'outline'} size="sm" className="text-xs h-9"
                  onClick={() => setEditRoiMode('monthly_compounding')}>
                  <TrendingUp className="h-3.5 w-3.5 mr-1.5" /> Compounding
                </Button>
              </div>
              <p className="text-[11px] text-muted-foreground">
                {editRoiMode === 'monthly_compounding' ? 'Returns are reinvested monthly, growing the principal.' : 'Returns are paid out to wallet each month.'}
              </p>
            </div>
            <p className="text-[11px] text-muted-foreground bg-muted/50 rounded-lg p-2.5">
              💡 To edit the <strong>Payout Day</strong> for individual investments, click the partner name to view their portfolio breakdown.
            </p>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditPartner(null)}>Cancel</Button>
            <Button onClick={handleSaveEdit} disabled={saving || !editName.trim()}>
              {saving && <Loader2 className="h-4 w-4 animate-spin mr-2" />} Save Changes
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ─── Suspend / Reactivate Confirm ─── */}
      <AlertDialog open={!!suspendPartner} onOpenChange={open => { if (!open) setSuspendPartner(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{suspendPartner?.status === 'active' ? 'Suspend Partner' : 'Reactivate Partner'}</AlertDialogTitle>
            <AlertDialogDescription>
              {suspendPartner?.status === 'active'
                ? <>This will suspend <strong>{suspendPartner?.name}</strong>. They will lose access to partner features until reactivated.</>
                : <>This will reactivate <strong>{suspendPartner?.name}</strong> and restore their partner access.</>}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={handleToggleSuspend} disabled={suspending}
              className={suspendPartner?.status === 'active' ? 'bg-destructive text-destructive-foreground hover:bg-destructive/90' : ''}>
              {suspending && <Loader2 className="h-4 w-4 animate-spin mr-2" />}
              {suspendPartner?.status === 'active' ? 'Suspend' : 'Reactivate'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* ─── Delete Partner Confirm ─── */}
      <Dialog open={!!deletePartnerTarget} onOpenChange={open => { if (!open) { setDeletePartnerTarget(null); setDeletePartnerReason(''); } }}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-destructive">
              <Trash2 className="h-5 w-5" /> Delete Partner
            </DialogTitle>
            <DialogDescription>
              This will <strong>permanently remove</strong> <strong>{deletePartnerTarget?.name}</strong> as a partner. Their supporter role will be revoked and account frozen. This action cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div>
              <Label className="text-xs font-semibold">Deletion Reason <span className="text-destructive">*</span></Label>
              <Textarea
                placeholder="Provide a detailed reason (min 10 characters)..."
                value={deletePartnerReason}
                onChange={e => setDeletePartnerReason(e.target.value)}
                className="mt-1 text-sm"
                rows={3}
              />
              {deletePartnerReason.length > 0 && deletePartnerReason.length < 10 && (
                <p className="text-[10px] text-destructive mt-1">Reason must be at least 10 characters</p>
              )}
            </div>
          </div>
          <DialogFooter className="gap-2 sm:gap-0">
            <Button variant="outline" onClick={() => { setDeletePartnerTarget(null); setDeletePartnerReason(''); }}>Cancel</Button>
            <Button
              variant="destructive"
              onClick={handleDeletePartner}
              disabled={deletingPartner || deletePartnerReason.length < 10}
            >
              {deletingPartner && <Loader2 className="h-4 w-4 animate-spin mr-2" />}
              Delete Permanently
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Import Dialog */}
      <PartnerImportDialog open={importOpen} onOpenChange={setImportOpen} onSuccess={() => { refreshInBackground(); fetchPendingCount(); }} />

      {/* Partner Payment Details Dialog */}
      {detailPartner && paymentDetailsPortfolio && (
        <PartnerPaymentDetailsDialog
          open={paymentDetailsOpen}
          onOpenChange={(o) => { setPaymentDetailsOpen(o); if (!o) setPaymentDetailsPortfolio(null); }}
          partnerId={detailPartner.profile.id}
          partnerName={detailPartner.profile.full_name || 'Partner'}
          portfolio={paymentDetailsPortfolio}
          onSaved={() => { if (detailPartner?.profile?.id) openPartnerDetail(detailPartner.profile.id); }}
        />
      )}

      {/* Compound Preview Dialog */}
      <AlertDialog open={!!compoundPreview} onOpenChange={(open) => { if (!open) { setCompoundPreview(null); setDetailHiddenForCompound(false); } }}>
        <AlertDialogPortal>
          <AlertDialogOverlay className="z-[190]" />
          <AlertDialogPrimitive.Content
            className="fixed left-[50%] top-[50%] z-[200] grid w-full max-w-md translate-x-[-50%] translate-y-[-50%] gap-4 border border-border bg-background p-5 shadow-lg duration-150 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-98 data-[state=open]:zoom-in-98 sm:rounded-xl"
          >
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2">
              <TrendingUp className="h-5 w-5 text-primary" />
              Confirm Compounding
            </AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-4 pt-2">
                <p className="text-sm text-muted-foreground">
                  You are about to compound the ROI into this portfolio. Review the changes below:
                </p>
                {compoundPreview && (
                  <div className="rounded-xl border border-border bg-muted/30 p-4 space-y-3">
                    <div className="flex justify-between text-sm">
                      <span className="text-muted-foreground">Current Principal</span>
                      <span className="font-semibold">{formatUGX(compoundPreview.currentPrincipal)}</span>
                    </div>
                    <div className="flex justify-between text-sm">
                      <span className="text-muted-foreground">ROI ({compoundPreview.roiPercentage}%)</span>
                      <span className="font-semibold text-green-600">+ {formatUGX(compoundPreview.roiAmount)}</span>
                    </div>
                    <Separator />
                    <div className="flex justify-between text-sm">
                      <span className="font-medium">New Principal</span>
                      <span className="font-bold text-primary text-base">{formatUGX(compoundPreview.newPrincipal)}</span>
                    </div>
                    <div className="flex justify-between text-sm">
                      <span className="text-muted-foreground">Next Payout Date</span>
                      <span className="font-semibold text-blue-600">
                        {compoundPreview.nextRoiDate ? new Date(compoundPreview.nextRoiDate + 'T00:00:00').toLocaleDateString('en-UG', { year: 'numeric', month: 'short', day: 'numeric' }) : '—'}
                      </span>
                    </div>
                  </div>
                )}
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={!!compoundingPortfolioId}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              disabled={!!compoundingPortfolioId}
              onClick={() => {
                if (compoundPreview) {
                  handlePortfolioCompound(compoundPreview.portfolio);
                  setCompoundPreview(null);
                  setDetailHiddenForCompound(false);
                }
              }}
            >
              {compoundingPortfolioId ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : null}
              Confirm Compound
            </AlertDialogAction>
          </AlertDialogFooter>
          </AlertDialogPrimitive.Content>
        </AlertDialogPortal>
      </AlertDialog>

      <UpdateContributionDatesDialog open={updateDatesOpen} onOpenChange={setUpdateDatesOpen} onSuccess={() => {
        refreshInBackground();
        if (detailPartner?.profile?.id) openPartnerDetail(detailPartner.profile.id);
      }} />

      {/* Top-level Create Portfolio Dialog */}
      <CreateInvestmentAccountDialog
        open={createPortfolioOpen}
        onOpenChange={setCreatePortfolioOpen}
        mode="direct_confirmation"
        onSuccess={() => { refreshInBackground(); fetchPendingCount(); }}
      />

      {/* ─── Bulk Activate Confirmation ─── */}
      <AlertDialog open={showActivateConfirm} onOpenChange={setShowActivateConfirm}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2">
              <CheckCircle2 className="h-5 w-5 text-emerald-600" />
              Activate All Pending Portfolios
            </AlertDialogTitle>
            <AlertDialogDescription>
              This will set <strong>{pendingApprovalCount}</strong> portfolios from <strong>Awaiting Approval</strong> to <strong>Active</strong>.
              These are imported records that don't require wallet operations. This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={activatingAll}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleBulkActivate}
              disabled={activatingAll}
              className="bg-emerald-600 hover:bg-emerald-700"
            >
              {activatingAll && <Loader2 className="h-4 w-4 animate-spin mr-2" />}
              Activate {pendingApprovalCount} Portfolios
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* ─── Delete Portfolio Confirmation ─── */}
      <Dialog open={!!deletePortfolio} onOpenChange={open => { if (!open) { setDeletePortfolio(null); setDeleteReason(''); } }}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-destructive">
              <Trash2 className="h-5 w-5" /> Delete Investment Portfolio
            </DialogTitle>
            <DialogDescription>
              This will permanently delete portfolio <strong>{deletePortfolio?.portfolio_code}</strong> ({formatUGX(deletePortfolio?.investment_amount || 0)}).
              This action cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="p-3 rounded-lg bg-destructive/10 border border-destructive/20 text-xs space-y-1">
              <p><strong>Portfolio:</strong> {deletePortfolio?.portfolio_code}</p>
              <p><strong>Amount:</strong> {formatUGX(deletePortfolio?.investment_amount || 0)}</p>
              <p><strong>ROI:</strong> {deletePortfolio?.roi_percentage}% · {deletePortfolio?.roi_mode === 'monthly_compounding' ? 'Compounding' : 'Payout'}</p>
              <p><strong>Status:</strong> {deletePortfolio?.status}</p>
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs font-semibold">Reason for Deletion <span className="text-destructive">*</span></Label>
              <Textarea
                value={deleteReason}
                onChange={e => setDeleteReason(e.target.value)}
                placeholder="Provide a detailed reason for deleting this investment (min 10 characters)..."
                className="min-h-[80px] text-sm"
                maxLength={500}
              />
              <p className="text-[10px] text-muted-foreground">{deleteReason.length}/500 characters</p>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => { setDeletePortfolio(null); setDeleteReason(''); }}>Cancel</Button>
            <Button
              variant="destructive"
              onClick={handleDeletePortfolio}
              disabled={deleting || deleteReason.trim().length < 10}
            >
              {deleting && <Loader2 className="h-4 w-4 animate-spin mr-2" />}
              Delete Portfolio
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      {/* ─── Edit Portfolio Dialog ─── */}
      <Dialog open={!!editPortfolio} onOpenChange={open => { if (!open) setEditPortfolio(null); }}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2"><Pencil className="h-5 w-5 text-primary" /> Edit Portfolio</DialogTitle>
            <DialogDescription>
              Update portfolio <strong>{editPortfolio?.portfolio_code}</strong> details.
            </DialogDescription>
          </DialogHeader>
          {editPortfolio && (
            <div className="space-y-4">
              <div className="space-y-1.5">
                <Label className="text-xs">Investment Amount (UGX)</Label>
                <Input type="number" min={MIN_INVEST} value={editPortfolioAmount}
                  onChange={e => setEditPortfolioAmount(e.target.value)} placeholder={`Min ${MIN_INVEST.toLocaleString()}`} />
                <div className="flex gap-1.5 flex-wrap">
                  {[500000, 1000000, 2000000, 5000000, 10000000].map(a => (
                    <Button key={a} variant={editPortfolioAmount === String(a) ? 'default' : 'outline'} size="sm" className="text-[10px] h-6 px-2"
                      onClick={() => setEditPortfolioAmount(String(a))}>{(a / 1000000).toFixed(a >= 1000000 ? 0 : 1)}M</Button>
                  ))}
                </div>
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs">Returns Percentage (%)</Label>
                <Input type="number" min={1} max={100} value={editPortfolioRoi} onChange={e => setEditPortfolioRoi(e.target.value)} />
                <div className="flex gap-1.5">
                  {[10, 15, 20, 25].map(v => (
                    <Button key={v} variant={editPortfolioRoi === String(v) ? 'default' : 'outline'} size="sm" className="text-[10px] h-6 px-2 flex-1"
                      onClick={() => setEditPortfolioRoi(String(v))}>{v}%</Button>
                  ))}
                </div>
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs">Returns Mode</Label>
                <div className="grid grid-cols-2 gap-2">
                  <Button variant={editPortfolioRoiMode === 'monthly_payout' ? 'default' : 'outline'} size="sm" className="text-xs h-9"
                    onClick={() => setEditPortfolioRoiMode('monthly_payout')}>
                    <ArrowUpRight className="h-3.5 w-3.5 mr-1.5" /> Payout
                  </Button>
                  <Button variant={editPortfolioRoiMode === 'monthly_compounding' ? 'default' : 'outline'} size="sm" className="text-xs h-9"
                    onClick={() => setEditPortfolioRoiMode('monthly_compounding')}>
                    <TrendingUp className="h-3.5 w-3.5 mr-1.5" /> Compounding
                  </Button>
                </div>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label className="text-xs">Duration (months)</Label>
                  <Input type="number" min={1} max={120} value={editPortfolioDuration} onChange={e => setEditPortfolioDuration(e.target.value)} />
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs">Status</Label>
                  <Select value={editPortfolioStatus} onValueChange={setEditPortfolioStatus}>
                    <SelectTrigger className="h-9 text-xs"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="active">Active</SelectItem>
                      <SelectItem value="pending">Pending</SelectItem>
                      <SelectItem value="pending_approval">Pending Approval</SelectItem>
                      <SelectItem value="matured">Matured</SelectItem>
                      <SelectItem value="cancelled">Cancelled</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs flex items-center gap-1.5"><CalendarDays className="h-3.5 w-3.5 text-muted-foreground" /> Contribution Date</Label>
                <Input type="date" value={editPortfolioDate} onChange={e => setEditPortfolioDate(e.target.value)} className="h-10 text-sm" />
                {editPortfolio.created_at && (
                  <p className="text-[10px] text-muted-foreground">Current: {formatDate(editPortfolio.created_at)}</p>
                )}
              </div>
              {editPortfolioAmount && Number(editPortfolioAmount) >= MIN_INVEST && editPortfolioRoi && (
                <div className="text-xs bg-primary/5 border border-primary/20 rounded-lg p-3 space-y-1">
                  <p>Monthly Returns ({editPortfolioRoi}%): <strong className="text-primary">{formatUGX(Math.round(Number(editPortfolioAmount) * (Number(editPortfolioRoi) / 100)))}</strong></p>
                  <p>Duration: <strong>{editPortfolioDuration} months</strong></p>
                </div>
              )}
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditPortfolio(null)}>Cancel</Button>
            <Button onClick={handleSaveEditPortfolio} disabled={savingEditPortfolio}>
              {savingEditPortfolio && <Loader2 className="h-4 w-4 animate-spin mr-2" />} Save Changes
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Renew Portfolio Dialog */}
      <RenewPortfolioDialog
        open={renewOpen}
        onOpenChange={setRenewOpen}
        portfolio={renewPortfolio}
        onSuccess={() => {
          if (detailPartner?.profile?.id) openPartnerDetail(detailPartner.profile.id);
          // Refresh renewal counts
          if (renewPortfolio) {
            setRenewalCounts(prev => ({ ...prev, [renewPortfolio.id]: (prev[renewPortfolio.id] || 0) + 1 }));
          }
        }}
      />

      {/* ─── Lock Portfolio (full principal or split) ─── */}
      <LockPortfolioDialog
        open={lockOpen}
        onOpenChange={(o) => { setLockOpen(o); if (!o) setLockPortfolio(null); }}
        portfolio={lockPortfolio}
        onSuccess={() => {
          if (detailPartner?.profile?.id) openPartnerDetail(detailPartner.profile.id);
        }}
      />

      {/* Wallet → Portfolio Top-Up Dialog */}
      <FundInvestmentAccountDialog
        open={topUpOpen}
        onOpenChange={setTopUpOpen}
        account={topUpPortfolio ? {
          id: topUpPortfolio.id,
          portfolio_code: topUpPortfolio.portfolio_code,
          account_name: topUpPortfolio.account_name,
          investment_amount: topUpPortfolio.investment_amount,
          investor_id: topUpPortfolio.investor_id,
          agent_id: topUpPortfolio.agent_id,
          investor_name: detailPartner?.profile?.full_name,
          investor_verified_at: detailPartner?.profile?.funder_verified_at ?? null,
          investor_signup_source: detailPartner?.profile?.signup_source ?? null,
        } : null}
        onSuccess={() => {
          if (detailPartner?.profile?.id) openPartnerDetail(detailPartner.profile.id);
        }}
      />

      {/* Wallet → Portfolio Transfer Dialog */}
      <Dialog open={!!walletToPortfolio} onOpenChange={(open) => { if (!open) { setWalletToPortfolio(null); setWalletToPortfolioAmount(''); setWalletToPortfolioReason(''); setProxyAgentInfo(null); } }}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <ArrowRightLeft className="h-4 w-4 text-primary" />
              Wallet → Portfolio Transfer
            </DialogTitle>
            <DialogDescription>
              Move funds into this portfolio from partner wallet or proxy agent wallet.
            </DialogDescription>
          </DialogHeader>

          {walletToPortfolio && detailPartner && (
            <div className="space-y-4 py-2">
              {/* Verification status banner */}
              {!isFunderCleared(detailPartner.profile) && (
                <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 flex items-start gap-2.5">
                  <AlertTriangle className="h-4 w-4 text-amber-600 shrink-0 mt-0.5" />
                  <div className="text-xs">
                    <p className="font-bold text-amber-700 dark:text-amber-400 flex items-center gap-1">
                      <Shield className="h-3 w-3" /> Transfer blocked — funder not verified
                    </p>
                    <p className="text-muted-foreground mt-0.5 leading-relaxed">
                      {`${detailPartner.profile.full_name} self-registered and is awaiting Partner Ops approval. Verify them before any wallet → portfolio transfer.`}
                    </p>
                  </div>
                </div>
              )}

              {/* Portfolio info */}
              <div className="rounded-lg border border-primary/20 p-3 bg-primary/5">
                <p className="text-sm font-semibold text-foreground">{walletToPortfolio.account_name || walletToPortfolio.portfolio_code}</p>
                <p className="text-xs text-muted-foreground mt-0.5">
                  Current Capital: {formatUGX(walletToPortfolio.investment_amount)}
                </p>
              </div>

              {/* Funding source selector */}
              <div className="space-y-1.5">
                <Label className="text-xs">Funding Source</Label>
                <div className="grid grid-cols-2 gap-2">
                  <button
                    type="button"
                    onClick={() => setWalletTransferMethod('wallet')}
                    className={cn(
                      "flex flex-col items-center gap-1 rounded-lg border-2 p-3 transition-all text-center",
                      walletTransferMethod === 'wallet'
                        ? "border-primary bg-primary/10 shadow-sm"
                        : "border-border bg-background hover:border-muted-foreground/30 cursor-pointer"
                    )}
                  >
                    <Wallet className={cn("h-4 w-4", walletTransferMethod === 'wallet' ? "text-primary" : "text-muted-foreground")} />
                    <span className={cn("text-xs font-medium", walletTransferMethod === 'wallet' ? "text-primary" : "text-muted-foreground")}>Wallet</span>
                    <span className="text-[10px] text-muted-foreground">Partner wallet</span>
                  </button>
                  <button
                    type="button"
                    disabled={!proxyAgentInfo && !loadingProxyAgent}
                    onClick={() => proxyAgentInfo && setWalletTransferMethod('proxy_agent')}
                    className={cn(
                      "flex flex-col items-center gap-1 rounded-lg border-2 p-3 transition-all text-center",
                      !proxyAgentInfo && !loadingProxyAgent
                        ? "border-border bg-muted/30 opacity-50 cursor-not-allowed"
                        : walletTransferMethod === 'proxy_agent'
                          ? "border-primary bg-primary/10 shadow-sm"
                          : "border-border bg-background hover:border-muted-foreground/30 cursor-pointer"
                    )}
                  >
                    <Users className={cn("h-4 w-4", walletTransferMethod === 'proxy_agent' ? "text-primary" : "text-muted-foreground")} />
                    <span className={cn("text-xs font-medium", walletTransferMethod === 'proxy_agent' ? "text-primary" : "text-muted-foreground")}>Proxy Agent</span>
                    <span className="text-[10px] text-muted-foreground">
                      {loadingProxyAgent ? '...' : proxyAgentInfo ? proxyAgentInfo.agentName : 'No agent assigned'}
                    </span>
                  </button>
                </div>
              </div>

              {/* Deploy-from bucket selector */}
              <div className="space-y-1.5">
                <Label className="text-xs">Deploy From</Label>
                <div className="grid grid-cols-2 gap-2">
                  {([
                    {
                      value: 'withdrawable' as const, label: 'Personal Deposit',
                      bal: walletTransferMethod === 'wallet' ? detailPartner.withdrawableBalance : (proxyAgentInfo?.withdrawable ?? 0),
                    },
                    {
                      value: 'float' as const, label: 'Operational Float',
                      bal: walletTransferMethod === 'wallet' ? detailPartner.floatBalance : (proxyAgentInfo?.float ?? 0),
                    },
                  ]).map(opt => {
                    const selected = walletTransferFundSource === opt.value;
                    return (
                      <button key={opt.value} type="button"
                        onClick={() => setWalletTransferFundSource(opt.value)}
                        className={cn(
                          "flex flex-col items-start gap-0.5 rounded-lg border-2 p-2.5 transition-all text-left",
                          selected ? "border-primary bg-primary/10 shadow-sm" : "border-border bg-background hover:border-muted-foreground/30"
                        )}>
                        <span className={cn("text-xs font-medium", selected ? "text-primary" : "text-muted-foreground")}>{opt.label}</span>
                        <span className="text-sm font-bold text-foreground">{formatUGX(opt.bal)}</span>
                      </button>
                    );
                  })}
                </div>
              </div>

              {/* Balance display */}
              <div className="flex items-center gap-2 p-3 rounded-lg bg-muted/50 border border-border/60">
                <Wallet className="h-4 w-4 text-muted-foreground" />
                <span className="text-sm text-muted-foreground">
                  {walletTransferFundSource === 'float' ? 'Operational Float:' : 'Personal Deposit:'}
                </span>
                <span className="text-sm font-bold">
                  {walletTransferMethod === 'wallet'
                    ? formatUGX(walletTransferFundSource === 'float' ? detailPartner.floatBalance : detailPartner.withdrawableBalance)
                    : proxyAgentInfo ? formatUGX(walletTransferFundSource === 'float' ? (proxyAgentInfo.float ?? 0) : (proxyAgentInfo.withdrawable ?? 0)) : '—'}
                </span>
              </div>

              {/* Amount */}
              <div className="space-y-1.5">
                <Label className="text-xs">Amount (UGX)</Label>
                <Input
                  type="number"
                  min={1000}
                  value={walletToPortfolioAmount}
                  onChange={e => setWalletToPortfolioAmount(e.target.value)}
                  placeholder="e.g. 5,000,000"
                  className="h-9"
                  autoFocus
                />
                {(() => {
                  const maxBal = walletTransferMethod === 'wallet'
                    ? (walletTransferFundSource === 'float' ? detailPartner.floatBalance : detailPartner.withdrawableBalance)
                    : (walletTransferFundSource === 'float' ? (proxyAgentInfo?.float ?? 0) : (proxyAgentInfo?.withdrawable ?? 0));
                  return (
                    <div className="flex gap-2 flex-wrap">
                      {[1000, 5000, 10000, 50000, 100000, 500000, 1000000].filter(a => a <= maxBal).map(a => (
                        <Button key={a} variant="outline" size="sm" className="text-xs h-7"
                          onClick={() => setWalletToPortfolioAmount(String(a))}>
                          {formatUGX(a)}
                        </Button>
                      ))}
                      {maxBal >= 1000 && (
                        <Button variant="outline" size="sm" className="text-xs h-7"
                          onClick={() => setWalletToPortfolioAmount(String(maxBal))}>
                          Max
                        </Button>
                      )}
                    </div>
                  );
                })()}
                {(() => {
                  const maxBal = walletTransferMethod === 'wallet'
                    ? (walletTransferFundSource === 'float' ? detailPartner.floatBalance : detailPartner.withdrawableBalance)
                    : (walletTransferFundSource === 'float' ? (proxyAgentInfo?.float ?? 0) : (proxyAgentInfo?.withdrawable ?? 0));
                  const amt = Number(walletToPortfolioAmount) || 0;
                  if (amt > maxBal && maxBal >= 0) {
                    return <p className="text-[10px] text-destructive font-medium">Insufficient balance ({formatUGX(maxBal)} available)</p>;
                  }
                  return null;
                })()}
              </div>

              {/* Reason */}
              <div className="space-y-1.5">
                <Label className="text-xs">Reason (required, min 10 chars)</Label>
                <Input
                  value={walletToPortfolioReason}
                  onChange={e => setWalletToPortfolioReason(e.target.value)}
                  placeholder="e.g. Partner requested wallet-to-portfolio transfer"
                  className="h-9"
                />
              </div>

              {/* Prominent charge confirmation — always visible so the operator
                  cannot miss WHICH wallet is being debited. */}
              {(() => {
                const isProxy = walletTransferMethod === 'proxy_agent';
                const chargeOwner = isProxy
                  ? (proxyAgentInfo?.agentName || 'Proxy Agent')
                  : (detailPartner.profile.full_name || 'Partner');
                const ownerRole = isProxy ? 'Proxy Agent' : 'Partner';
                const amt = Number(walletToPortfolioAmount) || 0;
                return (
                  <div className={cn(
                    "rounded-lg border-2 p-3 space-y-2",
                    isProxy
                      ? "border-amber-500/60 bg-amber-500/10"
                      : "border-primary/50 bg-primary/10"
                  )}>
                    <div className="flex items-center gap-2">
                      {isProxy
                        ? <Users className="h-4 w-4 text-amber-600 shrink-0" />
                        : <Wallet className="h-4 w-4 text-primary shrink-0" />}
                      <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                        This will charge
                      </span>
                    </div>
                    <p className={cn("text-sm font-bold", isProxy ? "text-amber-700 dark:text-amber-400" : "text-primary")}>
                      {chargeOwner}'s wallet ({ownerRole})
                    </p>
                    {amt >= 1000 && (
                      <p className="text-xs text-muted-foreground">
                        <span className="font-bold text-foreground">{formatUGX(amt)}</span> will be deducted from this wallet and applied to portfolio capital at maturity.
                      </p>
                    )}
                    {isProxy && (
                      <p className="text-[10px] text-amber-700 dark:text-amber-400 font-medium">
                        ⚠️ Not the partner's own wallet — funds leave {chargeOwner}'s balance.
                      </p>
                    )}
                  </div>
                );
              })()}
            </div>
          )}

          <DialogFooter>
            <Button variant="outline" onClick={() => setWalletToPortfolio(null)}>Cancel</Button>
            <Button
              onClick={handleWalletToPortfolio}
              disabled={walletToPortfolioSaving || !isFunderCleared(detailPartner?.profile) || Number(walletToPortfolioAmount) < 1000 || walletToPortfolioReason.trim().length < 10 || (walletTransferMethod === 'proxy_agent' && !proxyAgentInfo)}
            >
              {walletToPortfolioSaving && <Loader2 className="h-4 w-4 animate-spin mr-1.5" />}
              {!isFunderCleared(detailPartner?.profile)
                ? 'Blocked — Funder Not Verified'
                : walletTransferMethod === 'proxy_agent'
                  ? `Charge ${proxyAgentInfo?.agentName || 'Proxy Agent'}'s Wallet`
                  : `Charge ${detailPartner?.profile?.full_name || 'Partner'}'s Wallet`}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      {/* Nearing Payouts Dialog */}
      <NearingPayoutsDialog open={nearingPayoutsOpen} onOpenChange={setNearingPayoutsOpen} portfolios={allPortfoliosForPayout} onActionComplete={refreshInBackground} />

      {/* Expiring Portfolios Dialog */}
      <ExpiringPortfoliosDialog open={expiringPortfoliosOpen} onOpenChange={setExpiringPortfoliosOpen} portfolios={allPortfoliosForPayout} />
      <Dialog open={pendingPortfoliosOpen} onOpenChange={setPendingPortfoliosOpen}>
        <DialogContent className="max-w-2xl max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Pending portfolios</DialogTitle>
          </DialogHeader>
          <PendingPortfoliosQueue />
        </DialogContent>
      </Dialog>

      {/* Merge Pending Top-Ups Dialog */}
      <Dialog open={!!mergeDialogPortfolioId} onOpenChange={(open) => { if (!open) { setMergeDialogPortfolioId(null); setMergeReason(''); } }}>
        <DialogContent stable className="max-w-sm">
          <DialogHeader>
            <DialogTitle className="text-sm">Apply Pending Principal</DialogTitle>
            <DialogDescription className="text-xs">
              Merge approved top-ups into the portfolio's active principal immediately instead of waiting for the next ROI cycle.
            </DialogDescription>
          </DialogHeader>
          {mergeDialogPortfolioId && approvedTopUps[mergeDialogPortfolioId] && (
            <div className="rounded-lg bg-amber-500/10 border border-amber-500/20 p-3 text-xs">
              <p className="font-semibold text-amber-700 dark:text-amber-400">
                {approvedTopUps[mergeDialogPortfolioId].count} pending top-up{approvedTopUps[mergeDialogPortfolioId].count > 1 ? 's' : ''} totaling {formatUGX(approvedTopUps[mergeDialogPortfolioId].total)}
              </p>
            </div>
          )}
          <div className="space-y-1.5">
            <Label className="text-xs font-medium">Reason for manual merge (min 10 chars)</Label>
            <Textarea
              value={mergeReason}
              onChange={e => setMergeReason(e.target.value)}
              placeholder="e.g. Partner requested early activation of top-up funds..."
              className="text-xs min-h-[70px]"
            />
          </div>
          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => { setMergeDialogPortfolioId(null); setMergeReason(''); }}>
              Cancel
            </Button>
            <Button
              size="sm"
              className="gap-1.5"
              disabled={mergingTopUp || mergeReason.trim().length < 10}
              onClick={handleMergePendingTopUps}
            >
              {mergingTopUp ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ArrowRightLeft className="h-3.5 w-3.5" />}
              Apply Now
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Cancel Pending Top-Ups Dialog */}
      <Dialog
        open={!!cancelDialogPortfolioId}
        onOpenChange={(open) => { if (!open) { setCancelDialogPortfolioId(null); setCancelReason(''); } }}
      >
        <DialogContent stable className="max-w-sm">
          <DialogHeader>
            <DialogTitle className="text-sm flex items-center gap-2">
              <Ban className="h-4 w-4 text-destructive" /> Cancel Pending Top-Up?
            </DialogTitle>
            <DialogDescription className="text-xs">
              The parked top-up will be cancelled and the full amount refunded back to the partner's wallet. The next ROI cycle will not include this principal.
            </DialogDescription>
          </DialogHeader>
          {cancelDialogPortfolioId && approvedTopUps[cancelDialogPortfolioId] && (
            <div className="rounded-lg bg-destructive/10 border border-destructive/20 p-3 text-xs">
              <p className="font-semibold text-destructive">
                {approvedTopUps[cancelDialogPortfolioId].count} pending top-up{approvedTopUps[cancelDialogPortfolioId].count > 1 ? 's' : ''} totaling {formatUGX(approvedTopUps[cancelDialogPortfolioId].total)}
              </p>
              <p className="text-[11px] text-muted-foreground mt-1">
                Will be refunded to the partner's wallet immediately.
              </p>
            </div>
          )}
          <div className="space-y-1.5">
            <Label className="text-xs font-medium">Reason for cancellation (min 10 chars)</Label>
            <Textarea
              value={cancelReason}
              onChange={e => setCancelReason(e.target.value)}
              placeholder="e.g. Partner requested refund, duplicate top-up, wrong portfolio..."
              className="text-xs min-h-[70px]"
            />
          </div>
          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => { setCancelDialogPortfolioId(null); setCancelReason(''); }}>
              Keep Top-up
            </Button>
            <Button
              size="sm"
              variant="destructive"
              className="gap-1.5"
              disabled={cancellingTopUp || cancelReason.trim().length < 10}
              onClick={handleCancelPendingTopUps}
            >
              {cancellingTopUp ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Ban className="h-3.5 w-3.5" />}
              Confirm Cancel
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ─── Wallet Balances breakdown ─── */}
      <Dialog open={walletBalancesOpen} onOpenChange={setWalletBalancesOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-base">
              <Wallet className="h-4 w-4" /> Partner Wallet Balances
            </DialogTitle>
            <DialogDescription className="text-xs">
              Every partner currently holding money in their wallet, highest balance first.
            </DialogDescription>
          </DialogHeader>

          <div className="relative">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
            <Input
              value={walletBalancesSearch}
              onChange={e => setWalletBalancesSearch(e.target.value)}
              placeholder="Search by name, phone or email..."
              className="pl-8 h-9 text-xs"
            />
          </div>

          <div className="flex items-center justify-between rounded-lg border bg-muted/40 px-3 py-2 text-xs">
            <span className="text-muted-foreground">{walletBalancesFiltered.length} partner{walletBalancesFiltered.length === 1 ? '' : 's'}</span>
            <span className="font-bold tabular-nums">{formatUGX(walletBalancesTotal)}</span>
          </div>

          <div className="max-h-[50vh] overflow-y-auto -mx-1 px-1">
            {walletBalancesLoading ? (
              <div className="flex items-center justify-center gap-2 py-10 text-xs text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" /> Loading partner wallets...
              </div>
            ) : walletBalancesFiltered.length === 0 ? (
              <p className="py-10 text-center text-xs text-muted-foreground">
                {walletBalancesSearch ? 'No partner matches this search.' : 'No partner is holding wallet money.'}
              </p>
            ) : (
              <div className="divide-y">
                {walletBalancesFiltered.map(p => (
                  <div key={p.id} className="flex items-center justify-between gap-3 py-2.5">
                    <div className="min-w-0">
                      <p className="text-xs font-semibold truncate">{p.name}</p>
                      <p className="text-[11px] text-muted-foreground truncate">{p.phone || p.email || '—'}</p>
                    </div>
                    <span className="text-xs font-bold tabular-nums shrink-0">{formatUGX(p.balance)}</span>
                  </div>
                ))}
              </div>
            )}
          </div>

          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => setWalletBalancesOpen(false)}>Close</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

/* ─── Summary Card ─── */
function SummaryCard({ icon, label, value, sub, accent, onClick }: {
  icon: React.ReactNode; label: string; value: string | number; sub: string;
  accent: 'primary' | 'emerald' | 'amber' | 'violet';
  onClick?: () => void;
}) {
  const styles = {
    primary: { card: 'border-primary/30 bg-primary/5', icon: 'text-primary bg-primary/10' },
    emerald: { card: 'border-primary/20 bg-primary/[0.03]', icon: 'text-primary bg-primary/10' },
    amber: { card: 'border-amber-500/20 bg-amber-500/5', icon: 'text-amber-600 bg-amber-500/10' },
    violet: { card: 'border-violet-500/20 bg-violet-500/5', icon: 'text-violet-600 bg-violet-500/10' },
  };
  const s = styles[accent];
  return (
    <div
      className={cn('rounded-2xl border p-3.5 space-y-2', s.card, onClick && 'cursor-pointer transition-shadow hover:shadow-md focus:outline-none focus:ring-2 focus:ring-ring')}
      onClick={onClick}
      role={onClick ? 'button' : undefined}
      tabIndex={onClick ? 0 : undefined}
      onKeyDown={onClick ? (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onClick(); } } : undefined}
    >
      <div className="flex items-center gap-2">
        <div className={cn('p-1.5 rounded-lg', s.icon)}>{icon}</div>
        <span className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground">{label}</span>
      </div>
      <p className="text-xl font-black tracking-tight tabular-nums">{value}</p>
      <p className="text-[11px] text-muted-foreground leading-snug">{sub}</p>
    </div>
  );
}

/* ─── Mini KPI ─── */
function MiniKPI({ icon, label, value, variant }: {
  icon: React.ReactNode; label: string; value: string | number;
  variant: 'primary' | 'emerald' | 'amber' | 'violet';
}) {
  const colors = {
    primary: 'border-primary/30 bg-primary/5',
    emerald: 'border-primary/20 bg-primary/[0.03]',
    amber: 'border-amber-500/20 bg-amber-500/5',
    violet: 'border-violet-500/20 bg-violet-500/5',
  };
  return (
    <div className={cn('rounded-xl border p-2.5 text-center', colors[variant])}>
      <div className="flex justify-center mb-1 text-muted-foreground">{icon}</div>
      <p className="text-xs font-black tabular-nums">{value}</p>
      <p className="text-[9px] text-muted-foreground uppercase tracking-widest font-semibold mt-0.5">{label}</p>
    </div>
  );
}

/* ─── Portfolio expiry helper ─── */
// Expiration is anchored to the contribution date (created_at) + duration_months.
function computePortfolioExpiry(createdAt: string, durationMonths: number) {
  const start = new Date(createdAt);
  const expiry = new Date(start);
  expiry.setMonth(expiry.getMonth() + (Number(durationMonths) || 12));
  const now = new Date();
  const remainingDays = Math.ceil((expiry.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));
  return { expiry, remainingDays };
}

const EXPIRY_WINDOW_DAYS = 90; // "about to expire" = within 3 months

function getExpiringPortfolios(portfolios: NearingPayoutPortfolio[]) {
  return portfolios
    .filter(p => p.status === 'active' || p.status == null)
    .map(p => {
      const { expiry, remainingDays } = computePortfolioExpiry(p.createdAt, p.durationMonths);
      return { ...p, expiry, remainingDays };
    })
    .filter(p => p.remainingDays >= 0 && p.remainingDays <= EXPIRY_WINDOW_DAYS)
    .sort((a, b) => a.remainingDays - b.remainingDays);
}

/* ─── Expiring Portfolios Card ─── */
function ExpiringPortfoliosCard({ portfolios, onClick }: { portfolios: NearingPayoutPortfolio[]; onClick: () => void }) {
  const expiring = useMemo(() => getExpiringPortfolios(portfolios), [portfolios]);
  const count = expiring.length;
  const soonest = count > 0 ? expiring[0].remainingDays : null;
  const hasExpiring = count > 0;
  return (
    <button onClick={onClick} aria-label={`${count} portfolio(s) expiring within 3 months`} className={cn(
      'rounded-2xl border p-4 space-y-2.5 text-left w-full transition-all hover:shadow-lg active:scale-[0.98]',
      hasExpiring ? 'border-rose-500/40 bg-rose-500/5 ring-2 ring-rose-500/20 shadow-sm' : 'border-primary/20 bg-primary/[0.03]'
    )}>
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2.5">
          <div className={cn('p-2 rounded-xl', hasExpiring ? 'bg-rose-500/10 text-rose-600' : 'bg-primary/10 text-primary')}>
            <Hourglass className="h-5 w-5" />
          </div>
          <div>
            <span className={cn('text-xs font-bold uppercase tracking-wider', hasExpiring ? 'text-rose-700 dark:text-rose-400' : 'text-muted-foreground')}>
              Expiring Soon · 3 mo
            </span>
            <p className={cn('text-[11px] leading-snug mt-0.5', hasExpiring ? 'text-rose-600/80 font-medium' : 'text-muted-foreground')}>
              {hasExpiring ? `Soonest in ${soonest} day${soonest === 1 ? '' : 's'}` : 'None expiring soon'}
            </p>
          </div>
        </div>
        <div className={cn('text-2xl font-black tabular-nums px-3 py-1 rounded-xl', hasExpiring ? 'bg-rose-500/10 text-rose-700 dark:text-rose-300' : 'text-foreground')}>
          {count}
        </div>
      </div>
      {hasExpiring && (
        <div className="flex items-center justify-center gap-1.5 pt-1 border-t border-border/40">
          <span className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wide">Tap to review →</span>
        </div>
      )}
    </button>
  );
}

/* ─── Expiring Portfolios Dialog ─── */
function ExpiringPortfoliosDialog({ open, onOpenChange, portfolios }: {
  open: boolean; onOpenChange: (v: boolean) => void; portfolios: NearingPayoutPortfolio[];
}) {
  const [search, setSearch] = useState('');
  const expiring = useMemo(() => getExpiringPortfolios(portfolios), [portfolios]);
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return expiring;
    return expiring.filter(p =>
      p.name.toLowerCase().includes(q) ||
      p.portfolioName.toLowerCase().includes(q) ||
      (p.phone || '').toLowerCase().includes(q)
    );
  }, [expiring, search]);

  /* ─── Bulk-send the "Maturity Notice" email to every partner expiring soon. ─── */
  const [sendingNotices, setSendingNotices] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [confirmPortfolioIds, setConfirmPortfolioIds] = useState<string[]>([]);
  type NoticeProgress = {
    queued: number; sent: number; skipped: number;
    suppressed: number; rateLimited: number; failed: number; processed: number;
    done: boolean;
  };
  const [progress, setProgress] = useState<NoticeProgress | null>(null);

  function openMaturityConfirm() {
    // One notice per expiring portfolio exactly as listed in the dialog.
    const portfolioIds = Array.from(new Set(filtered.map(p => p.portfolioId).filter(Boolean)));
    if (portfolioIds.length === 0) {
      toast.info('No portfolios to notify');
      return;
    }
    setConfirmPortfolioIds(portfolioIds);
    setConfirmOpen(true);
  }

  async function handleConfirmSend() {
    setConfirmOpen(false);
    if (sendingNotices || confirmPortfolioIds.length === 0) return;
    setSendingNotices(true);
    setProgress({ queued: confirmPortfolioIds.length, sent: 0, skipped: 0, suppressed: 0, rateLimited: 0, failed: 0, processed: 0, done: false });
    try {
      const { data: sessionData } = await supabase.auth.getSession();
      const token = sessionData.session?.access_token;
      const apikey = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY as string;
      const url = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/bulk-send-maturity-notice`;
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`,
          'apikey': apikey,
        },
        body: JSON.stringify({ portfolioIds: confirmPortfolioIds, stream: true }),
      });
      if (!res.ok || !res.body) {
        const txt = await res.text().catch(() => '');
        throw new Error(txt || `Request failed (${res.status})`);
      }

      // Read the NDJSON progress stream line-by-line.
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let last: any = null;
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';
        for (const line of lines) {
          if (!line.trim()) continue;
          let evt: any;
          try { evt = JSON.parse(line); } catch { continue; }
          if (evt.type === 'error') throw new Error(evt.error || 'Send failed');
          last = evt;
          setProgress({
            queued: evt.queued ?? confirmPortfolioIds.length,
            sent: evt.sent ?? 0,
            skipped: evt.skipped ?? 0,
            suppressed: evt.suppressed ?? 0,
            rateLimited: evt.rateLimited ?? 0,
            failed: evt.failed ?? 0,
            processed: evt.processed ?? 0,
            done: evt.type === 'done',
          });
        }
      }

      const sent = last?.sent ?? 0;
      const skipped = last?.skipped ?? 0;
      const suppressed = last?.suppressed ?? 0;
      const rateLimited = last?.rateLimited ?? 0;
      const failed = last?.failed ?? 0;
      toast.success(`Maturity notices sent: ${sent}`, {
        description: `${skipped} skipped (no email), ${suppressed} suppressed, ${rateLimited} rate-limited, ${failed} failed.`,
      });
    } catch (e: any) {
      console.error('Bulk maturity notice failed', e);
      toast.error(e?.message || 'Failed to send maturity notices');
      setProgress(prev => (prev ? { ...prev, done: true } : prev));
    } finally {
      setSendingNotices(false);
      setConfirmPortfolioIds([]);
    }
  }

  const fmtDate = (d: Date) => d.toLocaleDateString('en-UG', { day: 'numeric', month: 'short', year: 'numeric' });
  const urgency = (days: number) =>
    days <= 14 ? { tone: 'text-rose-700 dark:text-rose-300 bg-rose-500/10 border-rose-500/30' }
    : days <= 30 ? { tone: 'text-amber-700 dark:text-amber-300 bg-amber-500/10 border-amber-500/30' }
    : { tone: 'text-primary bg-primary/10 border-primary/30' };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent stable className="max-w-3xl max-h-[85vh] flex flex-col">
        <DialogHeader>
          <DialogTitle className="text-sm flex items-center gap-2">
            <Hourglass className="h-4 w-4 text-rose-600" /> Portfolios Expiring Soon
          </DialogTitle>
          <DialogDescription className="text-xs">
            {expiring.length} active portfolio{expiring.length === 1 ? '' : 's'} reaching maturity within the next 3 months (based on contribution date + duration).
          </DialogDescription>
        </DialogHeader>
        <div className="relative">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
          <input type="text" value={search} onChange={e => setSearch(e.target.value)}
            placeholder="Search by partner, portfolio or phone…"
            className="h-9 w-full rounded-lg border border-border bg-background pl-8 pr-3 text-sm placeholder:text-muted-foreground/60 focus:outline-none focus:ring-2 focus:ring-primary/30" />
        </div>
        {expiring.length > 0 && (
          <Button
            variant="outline"
            size="sm"
            className="h-9 gap-1.5 text-xs self-start"
            onClick={openMaturityConfirm}
            disabled={sendingNotices}
          >
            {sendingNotices ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Mail className="h-3.5 w-3.5" />}
            {sendingNotices ? 'Sending…' : `Send Maturity Notice to ${filtered.length} Portfolio${filtered.length === 1 ? '' : 's'}`}
          </Button>
        )}
        {progress && (
          <div className="rounded-xl border border-border bg-muted/30 p-3 space-y-2">
            <div className="flex items-center justify-between">
              <p className="text-xs font-semibold flex items-center gap-1.5">
                {progress.done
                  ? <CheckCircle2 className="h-3.5 w-3.5 text-emerald-600" />
                  : <Loader2 className="h-3.5 w-3.5 animate-spin text-primary" />}
                {progress.done ? 'Maturity notices complete' : 'Sending maturity notices…'}
              </p>
              <span className="text-[11px] tabular-nums text-muted-foreground">
                {progress.processed}/{progress.queued}
              </span>
            </div>
            <div className="h-1.5 w-full overflow-hidden rounded-full bg-border">
              <div
                className={cn('h-full rounded-full transition-all', progress.done ? 'bg-emerald-500' : 'bg-primary')}
                style={{ width: `${progress.queued ? Math.round((progress.processed / progress.queued) * 100) : 0}%` }}
              />
            </div>
            <div className="grid grid-cols-3 sm:grid-cols-6 gap-2 pt-0.5">
              {([
                ['Queued', progress.queued, 'text-muted-foreground'],
                ['Sent', progress.sent, 'text-emerald-600'],
                ['Skipped', progress.skipped, 'text-amber-600'],
                ['Suppressed', progress.suppressed, 'text-muted-foreground'],
                ['Rate-limited', progress.rateLimited, 'text-orange-600'],
                ['Failed', progress.failed, 'text-rose-600'],
              ] as const).map(([label, value, tone]) => (
                <div key={label} className="rounded-lg bg-background border border-border px-2 py-1.5 text-center">
                  <p className={cn('text-base font-bold tabular-nums leading-none', tone)}>{value}</p>
                  <p className="text-[9px] uppercase tracking-wide text-muted-foreground mt-1">{label}</p>
                </div>
              ))}
            </div>
          </div>
        )}
        <div className="flex-1 overflow-y-auto -mx-1 px-1">
          {filtered.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-12 text-muted-foreground">
              <CalendarClock className="h-8 w-8 mb-2 opacity-40" />
              <p className="text-sm">No portfolios expiring within 3 months.</p>
            </div>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 py-1">
              {filtered.map(p => {
                const u = urgency(p.remainingDays);
                return (
                  <div key={p.portfolioId} className="rounded-2xl border border-border bg-card p-4 space-y-3">
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <p className="text-sm font-bold truncate">{p.portfolioName}</p>
                        <p className="text-[11px] text-muted-foreground font-mono">#{p.portfolioId.slice(0, 8)}</p>
                      </div>
                      <span className={cn('shrink-0 text-[11px] font-bold px-2 py-1 rounded-lg border tabular-nums', u.tone)}>
                        {p.remainingDays} day{p.remainingDays === 1 ? '' : 's'} left
                      </span>
                    </div>
                    <div className="flex items-center gap-2 rounded-lg bg-muted/50 p-2">
                      <div className="p-1.5 rounded-lg bg-primary/10 text-primary"><Users className="h-3.5 w-3.5" /></div>
                      <div className="min-w-0">
                        <p className="text-xs font-semibold truncate">{p.name}</p>
                        <p className="text-[10px] text-muted-foreground truncate">{p.phone || p.email || 'No contact'}</p>
                      </div>
                    </div>
                    <div className="grid grid-cols-2 gap-2 text-xs">
                      <div className="space-y-0.5">
                        <p className="text-[10px] uppercase tracking-wide text-muted-foreground font-semibold">Expiry Date</p>
                        <p className="font-semibold flex items-center gap-1"><CalendarClock className="h-3 w-3 text-rose-600" />{fmtDate(p.expiry)}</p>
                      </div>
                      <div className="space-y-0.5">
                        <p className="text-[10px] uppercase tracking-wide text-muted-foreground font-semibold">Started</p>
                        <p className="font-semibold">{new Date(p.createdAt).toLocaleDateString('en-UG', { day: 'numeric', month: 'short', year: 'numeric' })}</p>
                      </div>
                      <div className="space-y-0.5">
                        <p className="text-[10px] uppercase tracking-wide text-muted-foreground font-semibold">Principal</p>
                        <p className="font-semibold tabular-nums">{formatUGX(p.investmentAmount)}</p>
                      </div>
                      <div className="space-y-0.5">
                        <p className="text-[10px] uppercase tracking-wide text-muted-foreground font-semibold">Duration</p>
                        <p className="font-semibold tabular-nums">{p.durationMonths} mo · {p.roiPercentage}% {p.roiMode === 'monthly_compounding' ? 'cmp' : 'pay'}</p>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </DialogContent>
      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Send Maturity Notices</AlertDialogTitle>
            <AlertDialogDescription>
              You are about to send the <strong>"Maturity Notice"</strong> email for{' '}
              <strong>{confirmPortfolioIds.length} expiring portfolio{confirmPortfolioIds.length === 1 ? '' : 's'}</strong> listed here.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={() => setConfirmPortfolioIds([])}>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={handleConfirmSend} disabled={sendingNotices}>
              {sendingNotices ? (
                <>
                  <Loader2 className="h-3.5 w-3.5 animate-spin mr-1.5" />
                  Sending…
                </>
              ) : (
                <>Send {confirmPortfolioIds.length} Notice{confirmPortfolioIds.length === 1 ? '' : 's'}</>
              )}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Dialog>
  );
}

/* ─── Nearing Payouts Card ─── */
function NearingPayoutsCard({ portfolios, onClick }: { portfolios: NearingPayoutPortfolio[]; onClick: () => void }) {
  // Single source of truth: portfolios whose Next Payout Date == today (local TZ string compare).
  // Overdue (<today) and upcoming (>today) are excluded from this card; the dialog still lists everything.
  const dueToday = portfolios.filter(p => p.dueToday);
  const dueTodayCount = dueToday.length;
  const totalAmount = dueToday.reduce((s, p) => s + Math.round(p.investmentAmount * p.roiPercentage / 100), 0);
  const hasPayouts = dueTodayCount > 0;
  const overdueCount = 0; // styling flag retained, but card is scoped to "today"
  const todayLabel = new Date().toLocaleDateString('en-UG', { weekday: 'short', day: 'numeric', month: 'short' });
  return (
    <button onClick={onClick} aria-label={`${dueTodayCount} portfolio(s) reach Next Payout Date today (${todayLabel})`} className={cn(
      'rounded-2xl border p-4 space-y-2.5 text-left w-full transition-all hover:shadow-lg active:scale-[0.98]',
      overdueCount > 0
        ? 'border-destructive/40 bg-destructive/5 ring-2 ring-destructive/25 shadow-sm'
        : hasPayouts
        ? 'border-amber-500/40 bg-amber-500/5 ring-2 ring-amber-500/20 shadow-sm'
        : 'border-violet-500/20 bg-violet-500/5'
    )}>
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2.5">
          <div className={cn(
            'p-2 rounded-xl',
            overdueCount > 0 ? 'bg-destructive/10 text-destructive animate-pulse' : hasPayouts ? 'bg-amber-500/10 text-amber-600' : 'bg-violet-500/10 text-violet-600'
          )}>
            <CalendarDays className="h-5 w-5" />
          </div>
          <div>
            <span className={cn(
              'text-xs font-bold uppercase tracking-wider',
              overdueCount > 0 ? 'text-destructive' : hasPayouts ? 'text-amber-700 dark:text-amber-400' : 'text-muted-foreground'
            )}>
              Nearing Payout · Today
            </span>
            <p className={cn(
              'text-[11px] leading-snug mt-0.5',
              overdueCount > 0 ? 'text-destructive/80 font-medium' : hasPayouts ? 'text-amber-600/80 font-medium' : 'text-muted-foreground'
            )}>
              {hasPayouts
                ? `${todayLabel} · ~${formatUGX(totalAmount)} due`
                : `${todayLabel} · no payouts due`}
            </p>
          </div>
        </div>
        <div className={cn(
          'text-2xl font-black tabular-nums px-3 py-1 rounded-xl',
          overdueCount > 0 ? 'bg-destructive/10 text-destructive' : hasPayouts ? 'bg-amber-500/10 text-amber-700 dark:text-amber-300' : 'text-foreground'
        )}>
          {dueTodayCount}
        </div>
      </div>
      {hasPayouts && (
        <div className="flex items-center justify-center gap-1.5 pt-1 border-t border-border/40">
          <span className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wide">
            Tap to review & take action →
          </span>
        </div>
      )}
    </button>
  );
}

function NearingPayoutsDialog({ open, onOpenChange, portfolios, onActionComplete }: {
  open: boolean; onOpenChange: (v: boolean) => void; portfolios: NearingPayoutPortfolio[];
  onActionComplete?: () => void;
}) {
  const [search, setSearch] = useState('');
  // Default to "today" so the dialog matches the Nearing-Payout card count
  // (the card is strictly scoped to portfolios due today).
  const [rangeFilter, setRangeFilter] = useState<string>('today');
  const [processing, setProcessing] = useState<Record<string, 'compound' | 'pay' | 'split' | null>>({});
  const [completed, setCompleted] = useState<Record<string, 'compounded' | 'pending' | 'completed' | 'split'>>({});
  const [reasons, setReasons] = useState<Record<string, string>>({});
  const [managedInfo, setManagedInfo] = useState<Record<string, { isManaged: boolean; agentName: string; agentId: string; hasProxy: boolean } | null>>({});
  
  // Step 2 state
  const [selectedPayout, setSelectedPayout] = useState<NearingPayoutPortfolio | null>(null);
  const [paymentStep, setPaymentStep] = useState<'list' | 'payment-options' | 'split-config'>('list');
  const [checkingManagedStep2, setCheckingManagedStep2] = useState(false);
  // Hide anyone whose ROI is already credited / pending this cycle so they can't
  // be paid twice. ON by default so the visible count / PDF export match the
  // Nearing-Payout card (which counts every portfolio due today regardless of
  // processing state). Pay buttons are already disabled for processed rows.
  const [showProcessed, setShowProcessed] = useState(true);

  // Split payout state
  const [splitCashAmount, setSplitCashAmount] = useState(0);
  const [splitPayMode, setSplitPayMode] = useState<'wallet' | 'agent_wallet' | 'already_paid'>('wallet');
  const [splitReinvestMode, setSplitReinvestMode] = useState<'reinvest' | 'keep_returns'>('reinvest');

  // Compound confirmation state — shown after a compound action completes
  type CompoundEmailStatus = 'queued' | 'previously_sent' | 'suppressed' | 'skipped_no_email' | 'failed';
  const [compoundConfirmation, setCompoundConfirmation] = useState<{
    open: boolean;
    partnerName: string;
    portfolioLabel: string;
    roiAmount: number;
    newPrincipal: number;
    refId: string;
    recipientEmail: string;
    emailStatus: CompoundEmailStatus;
    emailDetail?: string;
  } | null>(null);

  // Keep a local snapshot so items don't vanish when parent refetches
  const [localPortfolios, setLocalPortfolios] = useState<NearingPayoutPortfolio[]>(portfolios);
  useEffect(() => {
    if (open && Object.keys(completed).length === 0) {
      setLocalPortfolios(portfolios);
    }
  }, [open, portfolios, completed]);

  // Reset state when dialog closes
  useEffect(() => {
    if (!open) {
      setCompleted({});
      setPaymentStep('list');
      setSelectedPayout(null);
    }
  }, [open]);

  const filtered = useMemo(() => {
    let list = localPortfolios;
    // Compute the current week boundaries (Mon–Sun) so the "5 days" (weekdays)
    // and "Weekend" (Sat & Sun) filters scope to the given week, not a rolling window.
    const now = new Date();
    const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const dow = startOfToday.getDay(); // 0=Sun … 6=Sat
    const mondayOffset = dow === 0 ? -6 : 1 - dow; // shift back to Monday
    const weekMonday = new Date(startOfToday);
    weekMonday.setDate(startOfToday.getDate() + mondayOffset);
    const weekFriday = new Date(weekMonday); weekFriday.setDate(weekMonday.getDate() + 4); // Mon..Fri
    const weekSaturday = new Date(weekMonday); weekSaturday.setDate(weekMonday.getDate() + 5);
    const weekSunday = new Date(weekMonday); weekSunday.setDate(weekMonday.getDate() + 6);
    const inRange = (dateStr: string, from: Date, to: Date) => {
      if (!dateStr) return false;
      const d = new Date(dateStr);
      const day = new Date(d.getFullYear(), d.getMonth(), d.getDate());
      return day >= from && day <= to;
    };
    // Apply range filter
    if (rangeFilter === 'overdue') {
      list = list.filter(p => p.daysUntil < 0);
    } else if (rangeFilter === 'today') {
      list = list.filter(p => p.daysUntil === 0);
    } else if (rangeFilter === 'tomorrow') {
      list = list.filter(p => p.daysUntil === 1);
    } else if (rangeFilter === '5') {
      // Weekdays (Mon–Fri) of the current week
      list = list.filter(p => inRange(p.nextPayoutDate, weekMonday, weekFriday));
    } else if (rangeFilter === 'weekend') {
      // Saturday & Sunday of the current week
      list = list.filter(p => inRange(p.nextPayoutDate, weekSaturday, weekSunday));
    } else if (rangeFilter === '7') {
      list = list.filter(p => p.daysUntil >= -30 && p.daysUntil <= 7);
    } else if (rangeFilter === '14') {
      list = list.filter(p => p.daysUntil >= -30 && p.daysUntil <= 14);
    } else if (rangeFilter === '30') {
      list = list.filter(p => p.daysUntil >= -30 && p.daysUntil <= 30);
    }
    // Apply search filter
    const q = search.trim().toLowerCase();
    if (q) {
      list = list.filter(p =>
        p.name.toLowerCase().includes(q) ||
        p.portfolioName.toLowerCase().includes(q) ||
        p.phone.toLowerCase().includes(q) ||
        p.email.toLowerCase().includes(q)
      );
    }
    // Drop anyone already credited / pending this cycle — the core guard against
    // duplicate ROI credits. `completed` is the in-session equivalent (just paid).
    if (!showProcessed) {
      list = list.filter(p => !p.alreadyProcessedThisCycle && !completed[p.portfolioId]);
    }
    return list;
  }, [localPortfolios, search, rangeFilter, showProcessed, completed]);

  // How many were removed from view because they're already handled this cycle.
  const processedHiddenCount = useMemo(
    () => localPortfolios.filter(p => p.alreadyProcessedThisCycle).length,
    [localPortfolios],
  );

  const generateRef = (prefix: string) => `${prefix}-${Date.now().toString(36).toUpperCase()}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;

  // Map the active range filter onto a human-readable label used in the PDF
  // header so the exported document mirrors the on-screen filter context.
  const rangeFilterLabel = (() => {
    switch (rangeFilter) {
      case 'overdue': return 'Overdue only';
      case 'today':   return 'Due today';
      case 'tomorrow': return 'Due tomorrow';
      case '5':       return 'This week (Mon–Fri)';
      case 'weekend': return 'This weekend (Sat & Sun)';
      case '7':       return 'Next 7 days (incl. overdue ≤ 30d)';
      case '14':      return 'Next 14 days (incl. overdue ≤ 30d)';
      case '30':      return 'Next 30 days (incl. overdue ≤ 30d)';
      case 'all':     return 'All portfolios';
      default:        return `Filter: ${rangeFilter}`;
    }
  })();

  // Two-way destination breakdown for the PDF dropdown: Banks (all bank names
  // combined) and Mobile Money (all networks combined). Each total includes
  // compounding portfolios — they are listed last in the PDF with "--" payout
  // details since they reinvest instead of cashing out.
  const payMethodGroups = useMemo(() => {
    let banks = 0, banksCompounding = 0, momo = 0, momoCompounding = 0;
    for (const p of filtered) {
      const compounding = p.roiMode === 'monthly_compounding';
      if (p.paymentMethod === 'bank_transfer') {
        banks += 1;
        if (compounding) banksCompounding += 1;
      } else if (p.paymentMethod === 'mobile_money') {
        momo += 1;
        if (compounding) momoCompounding += 1;
      }
    }
    return { banks, banksCompounding, momo, momoCompounding };
  }, [filtered]);

  // Does a visible row match the chosen payout destination?
  const matchesPayMethod = (p: NearingPayoutPortfolio, key: string) => {
    if (key === 'all') return true;
    // Banks / Mobile Money exports include compounding portfolios too — the
    // PDF lists them last and masks their payout details with "--".
    if (key === 'banks') return p.paymentMethod === 'bank_transfer';
    if (key === 'mobile_money') return p.paymentMethod === 'mobile_money';
    if (p.roiMode === 'monthly_compounding') return false;
    if (key === 'cash') return p.paymentMethod === 'cash';
    if (key === 'unset') return !p.paymentMethod;
    if (key.startsWith('bank:')) {
      if (p.paymentMethod !== 'bank_transfer') return false;
      const name = (p.bankName || '').trim().toUpperCase() || 'BANK (NAME NOT SET)';
      return name === key.slice(5);
    }
    if (key.startsWith('momo:')) {
      if (p.paymentMethod !== 'mobile_money') return false;
      const net = (p.mobileNetwork || '').trim().toUpperCase() || 'MOBILE MONEY (NETWORK NOT SET)';
      return net === key.slice(5);
    }
    return true;
  };

  const payMethodLabel = (key: string) => {
    if (key === 'all') return 'All payment modes';
    if (key === 'banks') return 'Banks (all bank transfers)';
    if (key === 'mobile_money') return 'Mobile Money (all networks)';
    if (key === 'cash') return 'Cash';
    if (key === 'unset') return 'No payout method set';
    if (key.startsWith('bank:')) return `${key.slice(5)} (bank transfer)`;
    if (key.startsWith('momo:')) return `${key.slice(5)} (mobile money)`;
    return key;
  };

  const [exportingPdf, setExportingPdf] = useState(false);
  const handleExportPdf = async (methodKey: string = 'all') => {
    if (exportingPdf) return;
    const rows = filtered.filter(p => matchesPayMethod(p, methodKey));
    if (rows.length === 0) {
      toast.info('Nothing to export', { description: 'The current filter has no matching portfolios.' });
      return;
    }
    setExportingPdf(true);
    try {
      const blob = await generateNearingPayoutsPdf({
        filterLabel: methodKey === 'all' ? rangeFilterLabel : `${rangeFilterLabel} · ${payMethodLabel(methodKey)}`,
        searchQuery: search.trim() || undefined,
        totalCount: localPortfolios.length,
        rows: rows.map((p) => ({
          investorId: p.investorId,
          portfolioId: p.portfolioId,
          name: p.name,
          portfolioName: p.portfolioName,
          phone: p.phone,
          email: p.email,
          investmentAmount: p.investmentAmount,
          roiPercentage: p.roiPercentage,
          roiMode: p.roiMode,
          daysUntil: p.daysUntil,
          nextPayoutDate: p.nextPayoutDate,
          createdAt: p.createdAt,
          durationMonths: p.durationMonths,
          nextRoiDate: p.nextRoiDate,
          payoutDay: p.payoutDay,
          status: (p as any).status,
        })),
      });
      const stamp = new Date().toISOString().slice(0, 10);
      const methodSlug = methodKey === 'all'
        ? 'all-modes'
        : methodKey === 'banks'
          ? 'banks'
          : methodKey === 'mobile_money'
            ? 'mobile-money'
            : methodKey.replace(/^bank:|^momo:/, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
      downloadNearingBlob(blob, `welile-nearing-payouts-${rangeFilter}-${methodSlug}-${stamp}.pdf`);
      toast.success('PDF exported', { description: `${rows.length} portfolio${rows.length === 1 ? '' : 's'} · ${payMethodLabel(methodKey)}.` });
    } catch (err: any) {
      console.error('Nearing payouts PDF export error:', err);
      toast.error('Export failed', { description: err?.message || 'Could not generate the PDF.' });
    } finally {
      setExportingPdf(false);
    }
  };

  // Share a branded WhatsApp payout card for a single partner. Resolves the
  // freshest payment destination (portfolio route → saved method) so the
  // mobile-money name / number on the card matches what Ops will actually pay.
  const [sharingCardId, setSharingCardId] = useState<string | null>(null);
  const handleShareCard = async (p: NearingPayoutPortfolio) => {
    if (sharingCardId) return;
    setSharingCardId(p.portfolioId);
    try {
      const roiAmount = Math.round(p.investmentAmount * p.roiPercentage / 100);
      let cardData: PayoutCardData = {
        partnerName: p.name,
        portfolioName: p.portfolioName,
        payoutDate: new Date(p.nextPayoutDate + 'T00:00:00').toLocaleDateString('en-GB', {
          day: '2-digit', month: 'short', year: 'numeric',
        }),
        amount: roiAmount,
        reference: p.portfolioId.slice(0, 8).toUpperCase(),
      };

      const { data: det } = await supabase
        .from('investor_portfolios')
        .select('payment_method, mobile_network, mobile_money_number, bank_name, bank_account_name, account_number, account_name')
        .eq('id', p.portfolioId)
        .maybeSingle();

      if (det?.payment_method === 'mobile_money') {
        cardData = {
          ...cardData, mode: 'mobile_money', provider: det.mobile_network || 'MoMo',
          momoName: det.bank_account_name || p.name,
          momoNumber: det.mobile_money_number || '',
        };
      } else if (det?.payment_method === 'bank_transfer') {
        cardData = {
          ...cardData, mode: 'bank_transfer', bankName: det.bank_name,
          bankAccountName: det.bank_account_name || p.name, bankAccountNumber: det.account_number,
        };
      } else if (det?.payment_method === 'cash') {
        cardData = { ...cardData, mode: 'cash' };
      } else {
        // Fall back to the partner's saved payout method.
        const { data: saved } = await supabase
          .from('saved_payout_methods' as never)
          .select('*')
          .eq('user_id', p.investorId)
          .order('is_default', { ascending: false })
          .order('last_used_at', { ascending: false, nullsFirst: false })
          .limit(1);
        const s: any = (saved ?? [])[0];
        if (s?.payout_mode === 'mobile_money') {
          cardData = { ...cardData, mode: 'mobile_money', provider: s.momo_provider, momoName: s.momo_name || p.name, momoNumber: s.momo_number };
        } else if (s?.payout_mode === 'bank_transfer') {
          cardData = { ...cardData, mode: 'bank_transfer', bankName: s.bank_name, bankAccountName: s.bank_account_name || p.name, bankAccountNumber: s.bank_account_number };
        } else {
          cardData = { ...cardData, mode: 'mobile_money', momoName: p.name };
        }
      }

      const res = await sharePayoutCardViaWhatsApp(cardData);
      if (res.method === 'downloaded') {
        toast.success('Payout card ready', { description: 'Image downloaded — attach it in the WhatsApp chat that just opened.' });
      }
    } catch (err: any) {
      console.error('Share payout card error:', err);
      toast.error('Could not create card', { description: err?.message || 'Please try again.' });
    } finally {
      setSharingCardId(null);
    }
  };

  const handleCompound = async (p: NearingPayoutPortfolio, reason: string) => {
    setProcessing(prev => ({ ...prev, [p.portfolioId]: 'compound' }));
    try {
      const roiAmount = Math.round(p.investmentAmount * p.roiPercentage / 100);
      const newAmount = p.investmentAmount + roiAmount;
      const refId = generateRef('CMP');
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) throw new Error('Not authenticated');

      // Advance next_roi_date by +1 month on compound
      const currentDate = new Date(p.nextPayoutDate || new Date());
      const newDate = new Date(currentDate);
      newDate.setMonth(newDate.getMonth() + 1);
      const newRoiDate = newDate.toISOString().split('T')[0];

      const { error: upErr } = await supabase
        .from('investor_portfolios')
        .update({ investment_amount: newAmount, next_roi_date: newRoiDate })
        .eq('id', p.portfolioId);
      if (upErr) throw upErr;

      // Reinvest ledger via RPC (double-entry: roi_expense + roi_reinvestment)
      const { error: ledgerErr } = await supabase.rpc('create_ledger_transaction', {
        entries: [
          {
            user_id: p.investorId,
            ledger_scope: 'platform',
            direction: 'cash_out',
            amount: roiAmount,
            category: 'roi_expense',
            description: `ROI compounded: ${formatUGX(roiAmount)} reinvested into portfolio. New principal: ${formatUGX(newAmount)}. Reason: ${reason}`,
            reference_id: refId,
            source_table: 'investor_portfolios',
            source_id: p.portfolioId,
            linked_party: user.id,
            currency: 'UGX',
          },
          {
            user_id: p.investorId,
            ledger_scope: 'platform',
            direction: 'cash_in',
            amount: roiAmount,
            category: 'roi_reinvestment',
            description: `ROI reinvestment: ${formatUGX(roiAmount)} added to principal. New principal: ${formatUGX(newAmount)}. Ref: ${refId}`,
            reference_id: refId,
            source_table: 'investor_portfolios',
            source_id: p.portfolioId,
            linked_party: user.id,
            currency: 'UGX',
          },
        ],
      });
      if (ledgerErr) throw ledgerErr;

      await supabase.from('audit_logs').insert({
        user_id: user.id,
        action_type: 'roi_compounded',
        table_name: 'investor_portfolios',
        record_id: p.portfolioId,
        metadata: { roi_amount: roiAmount, new_principal: newAmount, reference: refId, partner_id: p.investorId, reason, new_roi_date: newRoiDate },
      });

      await supabase.from('notifications').insert({
        user_id: p.investorId,
        title: 'Portfolio ROI Compounded',
        message: `Your ROI of ${formatUGX(roiAmount)} has been compounded into your portfolio. New investment total: ${formatUGX(newAmount)}. Next payout: ${newRoiDate}. Ref: ${refId}`,
        type: 'portfolio_update',
        metadata: { portfolio_id: p.portfolioId, roi_amount: roiAmount, reference: refId },
      });

      // Send partner-portfolio-compounded transactional email (fire-and-forget, non-blocking).
      // Existing partner — bulk compound action.
      const recipientEmail = p.email || '';
      const isRealEmail =
        !!recipientEmail &&
        !recipientEmail.endsWith('@welile.user') &&
        !recipientEmail.endsWith('@noapp.welile.user');
      let emailStatus: CompoundEmailStatus = 'skipped_no_email';
      let emailDetail: string | undefined;

      if (isRealEmail) {
        try {
          const { data: priorLogs } = await supabase
            .from('audit_logs')
            .select('created_at, metadata')
            .eq('action_type', 'roi_compounded')
            .eq('record_id', p.portfolioId)
            .order('created_at', { ascending: true });
          const allLogs = priorLogs ?? [];
          const paymentNumber = allLogs.length;

          let originalPrincipal = Number(p.investmentAmount) - roiAmount;
          if (allLogs.length >= 1) {
            const first: any = allLogs[0].metadata || {};
            const firstNew = Number(first.new_principal || 0);
            const firstRoi = Number(first.roi_amount || 0);
            if (firstNew > 0 && firstRoi >= 0) originalPrincipal = firstNew - firstRoi;
          }

          // FORWARD PROJECTION breakdown — excludes the current cycle (its
          // result IS the New Total Partnership Value headline) and starts
          // from next month, compounding monthly through portfolio maturity.
          // Anchored to contribution date (not cycle count) — robust to
          // skipped/backfilled past cycles.
          const compound_history = buildCompoundProjection({
            contributionDate: p.createdAt,
            durationMonths: Number(p.durationMonths || 12),
            newPrincipal: Number(newAmount),
            roiPct: Number(p.roiPercentage || 0),
            compoundDate: new Date(),
          });

          // Detect "previously sent" — was a partner-portfolio-compounded email for this recipient
          // already successfully sent before this action?
          const { count: priorSentCount } = await supabase
            .from('email_send_log')
            .select('id', { count: 'exact', head: true })
            .eq('template_name', 'partner-portfolio-compounded')
            .eq('recipient_email', recipientEmail)
            .eq('status', 'sent');

          const compoundDate = new Date().toLocaleDateString('en-GB', {
            day: '2-digit', month: 'long', year: 'numeric',
          });
          const contributionDateStr = new Date(p.createdAt).toLocaleDateString('en-GB', {
            day: '2-digit', month: 'long', year: 'numeric',
          });

          const { data: emailResp, error: emailInvokeErr } = await supabase.functions.invoke('send-transactional-email', {
            body: {
              templateName: 'partner-portfolio-compounded',
              recipientEmail,
              idempotencyKey: `partner-portfolio-compounded-${p.investorId}-${p.portfolioId}-${paymentNumber}`,
              templateData: {
                partner_name: p.name || 'Partner',
                portfolio_id: p.portfolioName || p.portfolioId,
                compound_date: compoundDate,
                contribution_date: contributionDateStr,
                initial_partnership_amount: originalPrincipal,
                roi_return: `${p.roiPercentage}%`,
                return_amount: roiAmount,
                new_total_partnership_value: newAmount,
                roi_percentage: p.roiPercentage,
                payment_number: paymentNumber,
                compound_history,
                currency: 'UGX',
                company_name: 'Welile',
                logo_url: 'https://welileapp.com/welile-logo.png',
                unsubscribe_url: 'https://welile.com/unsubscribe',
                dashboard_url: 'https://welileapp.com/auth',
              },
            },
          });

          if (emailInvokeErr) {
            emailStatus = 'failed';
            emailDetail = emailInvokeErr.message || 'Edge function returned an error';
          } else if (emailResp?.success === false && emailResp?.reason === 'email_suppressed') {
            emailStatus = 'suppressed';
            emailDetail = 'Recipient is on the suppression list (unsubscribed or bounced).';
          } else if (emailResp?.success && emailResp?.queued) {
            emailStatus = (priorSentCount ?? 0) > 0 ? 'previously_sent' : 'queued';
            emailDetail = (priorSentCount ?? 0) > 0
              ? `New email queued. ${priorSentCount} previous compound email(s) were already delivered to this recipient.`
              : 'Email handed off to the dispatcher and will be delivered shortly.';
          } else {
            emailStatus = 'failed';
            emailDetail = 'Unexpected response from the email service.';
          }
        } catch (emailErr: any) {
          emailStatus = 'failed';
          emailDetail = emailErr?.message || 'Email dispatch threw an exception.';
          console.warn('[partner-portfolio-compounded] email dispatch failed (non-blocking):', emailErr);
        }
      } else {
        emailDetail = recipientEmail
          ? `Internal placeholder address (${recipientEmail}) — no email sent.`
          : 'Partner has no email address on file.';
      }

      toast.success(`Compounded ${formatUGX(roiAmount)} for ${p.name}`, { description: `Ref: ${refId}` });
      setCompoundConfirmation({
        open: true,
        partnerName: p.name || 'Partner',
        portfolioLabel: p.portfolioName || p.portfolioId,
        roiAmount,
        newPrincipal: newAmount,
        refId,
        recipientEmail,
        emailStatus,
        emailDetail,
      });
      setCompleted(prev => ({ ...prev, [p.portfolioId]: 'compounded' }));
      onActionComplete?.();
    } catch (err: any) {
      toast.error('Compound failed', { description: err.message });
    } finally {
      setProcessing(prev => ({ ...prev, [p.portfolioId]: null }));
    }
  };

  const handlePay = async (p: NearingPayoutPortfolio, reason: string, mode: 'wallet' | 'already_paid' | 'agent_wallet') => {
    setProcessing(prev => ({ ...prev, [p.portfolioId]: 'pay' }));
    try {
      const roiAmount = Math.round(p.investmentAmount * p.roiPercentage / 100);
      const refId = generateRef('PAY');
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) throw new Error('Not authenticated');

      // ── ROI CYCLE GUARD (once per payout cycle) ──────────────────────────
      // Block a second payout for the same portfolio + cycle. The cycle is keyed
      // by the portfolio's current next_roi_date (advances only on approval), so
      // an accidental double-submit is refused before a duplicate credit / a
      // duplicate pending approval can be created. The backend enforces the same
      // rule idempotently as the final safety net.
      const cycleAnchor = p.nextRoiDate || new Date().toISOString().slice(0, 10);
      const roiCycleKey = `roi-cycle-${p.portfolioId}-${cycleAnchor}`;
      const [{ data: creditedRows }, { data: openOps }] = await Promise.all([
        supabase
          .from('general_ledger')
          .select('id')
          .eq('idempotency_key', roiCycleKey)
          .limit(1),
        supabase
          .from('pending_wallet_operations')
          .select('id')
          .eq('source_id', p.portfolioId)
          .eq('source_table', 'investor_portfolios')
          .eq('category', 'roi_payout')
          .in('status', ['pending', 'pending_coo_approval', 'coo_approved', 'awaiting_verification'])
          .limit(1),
      ]);
      if (creditedRows && creditedRows.length > 0) {
        toast.error('Already paid this cycle', {
          description: `${p.name} already received their ROI for the ${cycleAnchor} cycle. It advances after the next due date.`,
        });
        setProcessing(prev => ({ ...prev, [p.portfolioId]: null }));
        return;
      }
      if (openOps && openOps.length > 0) {
        toast.error('Payout already in the approval queue', {
          description: `An ROI payout for ${p.name} is already awaiting approval. Approve or reject that one first.`,
        });
        setProcessing(prev => ({ ...prev, [p.portfolioId]: null }));
        return;
      }

      // Date stays unchanged — only advances when CFO approves the payout

      // Managed-proxy ROI rule: the full ROI goes to the proxy agent wallet,
      // earmarked by linked_party=partner. The partner wallet/dashboard must
      // not receive any of this withdrawable ROI.
      const operationType = mode === 'wallet' ? 'roi_wallet_credit' : 'roi_already_paid';
      const modeLabel = mode === 'wallet' ? 'Wallet' : 'Cash';
      const managed = managedInfo[p.portfolioId];
      const txnGroupId = crypto.randomUUID();
      const hasProxy = !!managed;
      const isManagedProxy = !!managed?.isManaged;

      const { error: pendErr } = await supabase.from('pending_wallet_operations').insert({
        user_id: p.investorId,
        amount: roiAmount,
        direction: 'cash_in',
        category: 'roi_payout',
        source_table: 'investor_portfolios',
        source_id: p.portfolioId,
        reference_id: refId,
        operation_type: operationType,
        transaction_group_id: txnGroupId,
        target_wallet_user_id: isManagedProxy ? managed.agentId : null,
        description: isManagedProxy
          ? `[Proxy Agent Wallet] ROI payout of ${formatUGX(roiAmount)} to ${managed.agentName}'s wallet for partner ${p.name}. Portfolio: ${p.portfolioId.slice(0, 8)}. Reason: ${reason}`
          : `[${modeLabel}] ROI payout of ${formatUGX(roiAmount)} to ${p.name}'s wallet. Portfolio: ${p.portfolioId.slice(0, 8)}. Reason: ${reason}`,
        linked_party: user.id,
        status: 'pending_coo_approval',
        metadata: {
          partner_name: p.name,
          roi_percentage: p.roiPercentage,
          investment_amount: p.investmentAmount,
          initiated_by: user.id,
          reason,
          pay_mode: mode,
          ...(hasProxy ? { proxy_agent_name: managed.agentName, proxy_agent_id: managed.agentId, custody_route: isManagedProxy ? 'managed_proxy_agent_wallet_v3' : 'partner_wallet_v2' } : {}),
        },
      });
      if (pendErr) throw pendErr;

      const auditAction = mode === 'wallet' ? 'roi_payout_requested' : 'roi_already_paid_logged';
      await supabase.from('audit_logs').insert({
        user_id: user.id,
        action_type: auditAction,
        table_name: 'pending_wallet_operations',
        record_id: p.portfolioId,
        metadata: {
          roi_amount: roiAmount, reference: refId, partner_id: p.investorId, partner_name: p.name, reason, pay_mode: mode,
          ...(hasProxy ? { proxy_agent_id: managed.agentId, proxy_agent_name: managed.agentName, custody_route: isManagedProxy ? 'managed_proxy_agent_wallet_v3' : 'partner_wallet_v2' } : {}),
        },
      });

      await supabase.from('notifications').insert({
        user_id: p.investorId,
        title: mode === 'wallet' ? 'ROI Payout Initiated' : 'ROI Payment Recorded',
        message: isManagedProxy
          ? `An ROI payout of ${formatUGX(roiAmount)} has been initiated to your proxy agent ${managed.agentName}. Pending approval. Ref: ${refId}`
          : `An ROI payout of ${formatUGX(roiAmount)} has been ${mode === 'wallet' ? 'initiated for your wallet' : 'recorded as already paid'}. Pending approval. Ref: ${refId}`,
        type: 'payout_initiated',
        metadata: { portfolio_id: p.portfolioId, roi_amount: roiAmount, reference: refId, pay_mode: mode },
      });

      // Notify COO users (not CFO — COO must approve first)
      const { data: cooUsers } = await supabase.from('user_roles').select('user_id').eq('role', 'manager');
      if (cooUsers && cooUsers.length > 0) {
        await supabase.from('notifications').insert(
          cooUsers.map(c => ({
            user_id: c.user_id,
            title: 'ROI Payout Awaiting COO Approval',
            message: isManagedProxy
              ? `[Proxy Agent Wallet ${managed.agentName}] ${p.name}: ${formatUGX(roiAmount)} pending COO approval. Ref: ${refId}`
              : hasProxy
                ? `[Partner Wallet via Proxy ${managed.agentName}] ${p.name}: ${formatUGX(roiAmount)} pending COO approval. Ref: ${refId}`
              : `[${modeLabel}] ${p.name} has an ROI payout of ${formatUGX(roiAmount)} pending COO approval. Ref: ${refId}`,
            type: 'approval_required',
            metadata: { portfolio_id: p.portfolioId, partner_id: p.investorId, roi_amount: roiAmount, reference: refId, pay_mode: mode },
          }))
        );
      }

      toast.success(`${modeLabel}: ${formatUGX(roiAmount)} submitted for COO approval`, { description: `Ref: ${refId}` });
      setCompleted(prev => ({ ...prev, [p.portfolioId]: 'pending' }));
      setPaymentStep('list');
      setSelectedPayout(null);
      onActionComplete?.();
    } catch (err: any) {
      toast.error('Pay request failed', { description: err.message });
    } finally {
      setProcessing(prev => ({ ...prev, [p.portfolioId]: null }));
    }
  };

  // Handle Pay click — transition to step 2
  const handlePayClick = async (p: NearingPayoutPortfolio) => {
    setSelectedPayout(p);
    setPaymentStep('payment-options');
    
    // Check managed status if not already known
    if (managedInfo[p.portfolioId] === undefined) {
      setCheckingManagedStep2(true);
      try {
        // Mirror the server rule (`resolveManagedProxy`): approved + active
        // only, managed rows first, newest first — a stale non-managed row must
        // never shadow the live managed link.
        const { data: proxyRows } = await supabase
          .from('proxy_agent_assignments')
          .select('agent_id, is_managed_account, created_at, agent:agent_id(full_name)')
          .eq('beneficiary_id', p.investorId)
          .eq('is_active', true)
          .eq('approval_status', 'approved')
          .order('is_managed_account', { ascending: false })
          .order('created_at', { ascending: false })
          .limit(1);
        const proxyData = proxyRows?.[0] ?? null;
        if (proxyData) {
          const agentName = (proxyData.agent as any)?.full_name || 'Agent';
          setManagedInfo(prev => ({ ...prev, [p.portfolioId]: { isManaged: !!proxyData.is_managed_account, agentName, agentId: proxyData.agent_id, hasProxy: true } }));
        } else {
          setManagedInfo(prev => ({ ...prev, [p.portfolioId]: null }));
        }
      } catch {
        setManagedInfo(prev => ({ ...prev, [p.portfolioId]: null }));
      } finally {
        setCheckingManagedStep2(false);
      }
    }
  };

  // Handle Split click — transition to split-config step
  const handleSplitClick = async (p: NearingPayoutPortfolio) => {
    const roiAmount = Math.round(p.investmentAmount * p.roiPercentage / 100);

    // Check managed status
    if (managedInfo[p.portfolioId] === undefined) {
      setCheckingManagedStep2(true);
      try {
        const { data: proxyRows } = await supabase
          .from('proxy_agent_assignments')
          .select('agent_id, is_managed_account, created_at, agent:agent_id(full_name)')
          .eq('beneficiary_id', p.investorId)
          .eq('is_active', true)
          .eq('approval_status', 'approved')
          .order('is_managed_account', { ascending: false })
          .order('created_at', { ascending: false })
          .limit(1);
        const proxyData = proxyRows?.[0] ?? null;
        if (proxyData) {
          const agentName = (proxyData.agent as any)?.full_name || 'Agent';
          setManagedInfo(prev => ({ ...prev, [p.portfolioId]: { isManaged: !!proxyData.is_managed_account, agentName, agentId: proxyData.agent_id, hasProxy: true } }));
        } else {
          setManagedInfo(prev => ({ ...prev, [p.portfolioId]: null }));
        }
      } catch {
        setManagedInfo(prev => ({ ...prev, [p.portfolioId]: null }));
      } finally {
        setCheckingManagedStep2(false);
      }
    }
    setSelectedPayout(p);
    setSplitCashAmount(Math.round(roiAmount / 2)); // Default 50/50
    setSplitPayMode('wallet');
    setSplitReinvestMode('reinvest');
    setPaymentStep('split-config');
  };

  // Handle Split Payout — cash portion to pending_wallet_operations, reinvest portion to portfolio
  const handleSplitPayout = async (p: NearingPayoutPortfolio, cashAmount: number, reason: string, payMode: 'wallet' | 'agent_wallet' | 'already_paid', reinvestMode: 'reinvest' | 'keep_returns' = 'reinvest') => {
    setProcessing(prev => ({ ...prev, [p.portfolioId]: 'split' }));
    try {
      const roiAmount = Math.round(p.investmentAmount * p.roiPercentage / 100);
      const reinvestAmount = roiAmount - cashAmount;
      if (cashAmount < 1 || reinvestAmount < 1) throw new Error('Both cash and reinvest amounts must be at least 1');

      const refId = generateRef('SPL');
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) throw new Error('Not authenticated');

      // ── ROI CYCLE GUARD (once per payout cycle) ──────────────────────────
      const cycleAnchor = p.nextRoiDate || new Date().toISOString().slice(0, 10);
      const roiCycleKey = `roi-cycle-${p.portfolioId}-${cycleAnchor}`;
      const [{ data: creditedRows }, { data: openOps }] = await Promise.all([
        supabase.from('general_ledger').select('id').eq('idempotency_key', roiCycleKey).limit(1),
        supabase
          .from('pending_wallet_operations')
          .select('id')
          .eq('source_id', p.portfolioId)
          .eq('source_table', 'investor_portfolios')
          .eq('category', 'roi_payout')
          .in('status', ['pending', 'pending_coo_approval', 'coo_approved', 'awaiting_verification'])
          .limit(1),
      ]);
      if (creditedRows && creditedRows.length > 0) {
        toast.error('Already paid this cycle', {
          description: `${p.name} already received their ROI for the ${cycleAnchor} cycle.`,
        });
        setProcessing(prev => ({ ...prev, [p.portfolioId]: null }));
        return;
      }
      if (openOps && openOps.length > 0) {
        toast.error('Payout already in the approval queue', {
          description: `An ROI payout for ${p.name} is already awaiting approval.`,
        });
        setProcessing(prev => ({ ...prev, [p.portfolioId]: null }));
        return;
      }

      const managed = managedInfo[p.portfolioId];
      // Split allowed for all partners (incl. managed proxy). For managed proxy,
      // the cash leg routes to the proxy agent wallet; reinvest portion stays in the portfolio.
      const hasProxy = !!managed;
      const modeLabel = payMode === 'wallet' ? 'Partner Wallet' : payMode === 'agent_wallet' ? 'Partner Wallet (via Proxy)' : 'Cash';
      const txnGroupId = crypto.randomUUID();

      // Date stays unchanged — only advances when CFO approves the payout

      const isKeepReturns = reinvestMode === 'keep_returns';
      const reinvestLabel = isKeepReturns ? 'kept as returns' : 'reinvested into principal';

      // ── Reinvest portion: add to principal OR keep as earned returns ──
      let newPrincipal = p.investmentAmount;
      if (isKeepReturns) {
        // Keep as returns — increment total_roi_earned, principal stays flat
        const { data: currentP } = await supabase.from('investor_portfolios').select('total_roi_earned').eq('id', p.portfolioId).single();
        const currentRoiEarned = Number(currentP?.total_roi_earned || 0);
        const { error: upErr } = await supabase
          .from('investor_portfolios')
          .update({ total_roi_earned: currentRoiEarned + reinvestAmount })
          .eq('id', p.portfolioId);
        if (upErr) throw upErr;
        newPrincipal = p.investmentAmount; // stays the same
      } else {
        // Reinvest — add to principal (current behavior)
        newPrincipal = p.investmentAmount + reinvestAmount;
        const { error: upErr } = await supabase
          .from('investor_portfolios')
          .update({ investment_amount: newPrincipal })
          .eq('id', p.portfolioId);
        if (upErr) throw upErr;
      }

      // Reinvest ledger via RPC (double-entry: roi_expense + roi_reinvestment)
      const { error: ledgerErr } = await supabase.rpc('create_ledger_transaction', {
        entries: [
          {
            user_id: p.investorId,
            ledger_scope: 'platform',
            direction: 'cash_out',
            amount: reinvestAmount,
            category: 'roi_expense',
            description: `[Split ROI] ${formatUGX(reinvestAmount)} ${reinvestLabel}. ${isKeepReturns ? `Principal unchanged: ${formatUGX(p.investmentAmount)}` : `New principal: ${formatUGX(newPrincipal)}`}. Cash portion: ${formatUGX(cashAmount)} via ${modeLabel}. Reason: ${reason}`,
            reference_id: refId,
            source_table: 'investor_portfolios',
            source_id: p.portfolioId,
            linked_party: user.id,
            currency: 'UGX',
          },
          {
            user_id: p.investorId,
            ledger_scope: 'platform',
            direction: 'cash_in',
            amount: reinvestAmount,
            category: isKeepReturns ? 'roi_wallet_credit' : 'roi_reinvestment',
            description: `[Split ROI] ${formatUGX(reinvestAmount)} ${reinvestLabel}. Ref: ${refId}`,
            reference_id: refId,
            source_table: 'investor_portfolios',
            source_id: p.portfolioId,
            linked_party: user.id,
            currency: 'UGX',
          },
        ],
      });
      if (ledgerErr) throw ledgerErr;

      // ── Cash portion: submit to pending_wallet_operations for CFO approval ──
      const operationType = payMode === 'agent_wallet' || payMode === 'wallet' ? 'roi_split_cash' : 'roi_split_already_paid';
      const { error: pendErr } = await supabase.from('pending_wallet_operations').insert({
        user_id: p.investorId,
        amount: cashAmount,
        direction: 'cash_in',
        category: 'roi_payout',
        source_table: 'investor_portfolios',
        source_id: p.portfolioId,
        reference_id: refId,
        operation_type: operationType,
        transaction_group_id: txnGroupId,
        target_wallet_user_id: null,
        description: hasProxy
          ? `[Split ROI → Partner Wallet via Proxy ${managed.agentName}] Cash portion ${formatUGX(cashAmount)} to ${p.name}'s partner wallet. Reinvested: ${formatUGX(reinvestAmount)}. Total ROI: ${formatUGX(roiAmount)}. Reason: ${reason}`
          : `[Split ROI → ${modeLabel}] Cash portion ${formatUGX(cashAmount)} to ${p.name}'s wallet. Reinvested: ${formatUGX(reinvestAmount)}. Total ROI: ${formatUGX(roiAmount)}. Reason: ${reason}`,
        linked_party: user.id,
        // Split-ROI cash portions MUST enter the same approval chain as full
        // ROI payouts (COO → CFO). Using a bare 'pending' status orphaned them
        // outside both queues (COO reads `pending_coo_approval`, CFO reads
        // `coo_approved`), so the cash portion was never credited and the
        // partner's proxy payout could never be requested.
        status: 'pending_coo_approval',
        metadata: {
          partner_name: p.name,
          roi_percentage: p.roiPercentage,
          investment_amount: p.investmentAmount,
          initiated_by: user.id,
          reason,
          pay_mode: payMode,
          split_payout: true,
          cash_amount: cashAmount,
          reinvest_amount: reinvestAmount,
          total_roi: roiAmount,
          new_principal: newPrincipal,
          ...(hasProxy ? { proxy_agent_name: managed.agentName, proxy_agent_id: managed.agentId, custody_route: 'partner_wallet_v2' } : {}),
        },
      });
      if (pendErr) throw pendErr;

      // ── Audit log ──
      await supabase.from('audit_logs').insert({
        user_id: user.id,
        action_type: 'roi_split_payout',
        table_name: 'investor_portfolios',
        record_id: p.portfolioId,
        metadata: {
          roi_amount: roiAmount, cash_amount: cashAmount, reinvest_amount: reinvestAmount,
          new_principal: newPrincipal, reference: refId, partner_id: p.investorId, partner_name: p.name,
          reason, pay_mode: payMode, reinvest_mode: reinvestMode,
          ...(hasProxy ? { proxy_agent_id: managed.agentId, proxy_agent_name: managed.agentName, custody_route: 'partner_wallet_v2' } : {}),
        },
      });

      // ── Partner Split Allocation email (fire-and-forget; never blocks split) ──
      try {
        const recipientEmail = (p.email || '').trim();
        const isPlaceholder = !recipientEmail || recipientEmail.includes('placeholder');
        if (!isPlaceholder) {
          // Fetch portfolio_code + duration_months to mirror exact ledger values.
          const { data: pf } = await supabase
            .from('investor_portfolios')
            .select('portfolio_code, duration_months, next_roi_date, payout_day, created_at')
            .eq('id', p.portfolioId)
            .maybeSingle();

          const portfolioName = pf?.portfolio_code || p.portfolioName || 'Portfolio';
          const portfolioShortId = p.portfolioId.replace(/-/g, '').slice(0, 8).toUpperCase();
          const durationMonths = Number(pf?.duration_months || 12);

          const fmtDate = (iso: string | Date) => {
            const d = iso instanceof Date ? iso : new Date(iso);
            return isNaN(d.getTime()) ? '' : d.toLocaleDateString('en-GB', { day: '2-digit', month: 'long', year: 'numeric' });
          };

          const processingDate = fmtDate(new Date());
          // New maturity date = today + duration_months (compound cycle restart).
          const maturity = new Date();
          maturity.setMonth(maturity.getMonth() + durationMonths);
          const newMaturityDate = fmtDate(maturity);

          await supabase.functions.invoke('send-transactional-email', {
            body: {
              templateName: 'partnership-split-allocation',
              recipientEmail,
              idempotencyKey: `partnership-split-allocation-${p.investorId}-${refId}`,
              templateData: {
                partner_name: p.name || 'Partner',
                portfolio_name: portfolioName,
                portfolio_id: portfolioShortId,
                total_matured_value: roiAmount,
                withdrawal_amount: cashAmount,
                compounded_amount: reinvestAmount,
                processing_date: processingDate,
                new_maturity_date: newMaturityDate,
                new_cycle_duration: `${durationMonths} months`,
                currency: 'UGX',
                company_name: 'Welile',
                logo_url: 'https://welileapp.com/welile-logo.png',
                unsubscribe_url: 'https://welile.com/unsubscribe',
              },
            },
          });
        }
      } catch (emailErr) {
        console.warn('[partnership-split-allocation] email dispatch failed (non-blocking):', emailErr);
      }

      // ── Notifications ──
      const reinvestMsg = isKeepReturns
        ? `${formatUGX(reinvestAmount)} kept as earned returns (principal unchanged: ${formatUGX(p.investmentAmount)})`
        : `${formatUGX(reinvestAmount)} reinvested into your portfolio. New principal: ${formatUGX(newPrincipal)}`;
      await supabase.from('notifications').insert({
        user_id: p.investorId,
        title: '✂️ Split ROI Processed',
        message: `Your ROI of ${formatUGX(roiAmount)} has been split: ${formatUGX(cashAmount)} ${payMode === 'already_paid' ? 'paid via cash' : 'sent to your wallet (pending approval)'}, and ${reinvestMsg}. Ref: ${refId}`,
        type: 'payout_initiated',
        metadata: { portfolio_id: p.portfolioId, roi_amount: roiAmount, cash_amount: cashAmount, reinvest_amount: reinvestAmount, reinvest_mode: reinvestMode, reference: refId },
      });

      // Notify CFO
      const { data: cfoUsers } = await supabase.from('user_roles').select('user_id').eq('role', 'cfo');
      if (cfoUsers?.length) {
        await supabase.from('notifications').insert(
          cfoUsers.map((c: any) => ({
            user_id: c.user_id,
            title: '✂️ Split ROI Payout Pending',
            message: `${p.name}: ${formatUGX(cashAmount)} cash (${modeLabel}) + ${formatUGX(reinvestAmount)} ${isKeepReturns ? 'kept as returns' : 'reinvested'}. Awaiting approval. Ref: ${refId}`,
            type: 'approval_needed',
            metadata: { portfolio_id: p.portfolioId, reference: refId, cash_amount: cashAmount, reinvest_amount: reinvestAmount, reinvest_mode: reinvestMode },
          }))
        );
      }

      toast.success(`Split payout for ${p.name}`, {
        description: `${formatUGX(cashAmount)} to ${modeLabel} · ${formatUGX(reinvestAmount)} ${isKeepReturns ? 'kept as returns' : 'reinvested'} · Ref: ${refId}`,
      });
      setCompleted(prev => ({ ...prev, [p.portfolioId]: 'split' }));
      setPaymentStep('list');
      setSelectedPayout(null);
      onActionComplete?.();
    } catch (err: any) {
      toast.error('Split payout failed', { description: err.message });
    } finally {
      setProcessing(prev => ({ ...prev, [p.portfolioId]: null }));
    }
  };

  const selectedRoiAmount = selectedPayout ? Math.round(selectedPayout.investmentAmount * selectedPayout.roiPercentage / 100) : 0;
  const selectedManaged = selectedPayout ? managedInfo[selectedPayout.portfolioId] : null;
  const selectedReason = selectedPayout ? (reasons[selectedPayout.portfolioId] || '') : '';
  const selectedProcessing = selectedPayout ? processing[selectedPayout.portfolioId] : null;

  return (
    <>
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg max-h-[90vh] p-0 sm:max-w-xl">
        {paymentStep === 'list' ? (
          <>
            <DialogHeader className="p-4 pb-2 sm:p-5 sm:pb-3">
              <DialogTitle className="flex items-center gap-2 text-base">
                <CalendarDays className="h-4.5 w-4.5 text-violet-600" />
                Portfolios Nearing Payout
              </DialogTitle>
              <DialogDescription className="text-xs">
                {filtered.length} of {localPortfolios.length} portfolio{localPortfolios.length !== 1 ? 's' : ''} · {localPortfolios.filter(p => p.daysUntil < 0).length} overdue
              </DialogDescription>
            </DialogHeader>
            <div className="px-4 sm:px-5 space-y-2">
              <div className="flex gap-2">
                <div className="relative flex-1">
                  <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
                  <input
                    type="text"
                    value={search}
                    onChange={e => setSearch(e.target.value)}
                    placeholder="Search by name, portfolio, phone…"
                    className="h-9 w-full rounded-lg border border-border bg-background pl-8 pr-8 text-sm placeholder:text-muted-foreground/60 focus:outline-none focus:ring-2 focus:ring-primary/30 transition-colors"
                  />
                  {search && (
                    <button onClick={() => setSearch('')} className="absolute right-2 top-1/2 -translate-y-1/2 p-0.5 rounded hover:bg-muted">
                      <X className="h-3 w-3 text-muted-foreground" />
                    </button>
                  )}
                </div>
                <Select value={rangeFilter} onValueChange={setRangeFilter}>
                  <SelectTrigger className="w-[120px] h-9 text-xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="today">Today</SelectItem>
                    <SelectItem value="tomorrow">Tomorrow</SelectItem>
                    <SelectItem value="5">5 days</SelectItem>
                    <SelectItem value="weekend">Weekend</SelectItem>
                    <SelectItem value="7">7 days</SelectItem>
                    <SelectItem value="30">30 days</SelectItem>
                    <SelectItem value="overdue">Overdue</SelectItem>
                    <SelectItem value="all">All</SelectItem>
                  </SelectContent>
                </Select>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      disabled={exportingPdf || filtered.length === 0}
                      className="h-9 gap-1.5 text-xs whitespace-nowrap"
                      title="Export as PDF by payment mode"
                    >
                      {exportingPdf ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      ) : (
                        <Download className="h-3.5 w-3.5" />
                      )}
                      PDF
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent
                    align="end"
                    side="bottom"
                    sideOffset={6}
                    collisionPadding={8}
                    className="z-[200] w-64 max-h-[min(20rem,60vh)] overflow-y-auto"
                  >
                    <DropdownMenuLabel className="text-[10px] uppercase tracking-wide text-muted-foreground">
                      Export by destination
                    </DropdownMenuLabel>
                    <DropdownMenuItem onClick={() => handleExportPdf('banks')} className="text-xs" disabled={payMethodGroups.banks === 0}>
                      <span className="truncate">Banks</span>
                      <span className="ml-auto pl-2 tabular-nums text-muted-foreground">{payMethodGroups.banks}</span>
                    </DropdownMenuItem>
                    <DropdownMenuItem onClick={() => handleExportPdf('mobile_money')} className="text-xs" disabled={payMethodGroups.momo === 0}>
                      <span className="truncate">Mobile Money</span>
                      <span className="ml-auto pl-2 tabular-nums text-muted-foreground">{payMethodGroups.momo}</span>
                    </DropdownMenuItem>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem onClick={() => handleExportPdf('all')} className="text-xs">
                      All payment modes
                      <span className="ml-auto tabular-nums text-muted-foreground">{filtered.length}</span>
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
            </div>
            <div className="overflow-y-auto max-h-[calc(90vh-160px)] px-4 pb-4 sm:px-5 sm:pb-5 space-y-2">
              {processedHiddenCount > 0 && (
                <div className="flex items-center justify-between gap-2 rounded-lg border border-green-500/30 bg-green-500/5 px-3 py-2">
                  <p className="text-xs text-green-700 dark:text-green-300">
                    <span className="font-semibold">{processedHiddenCount}</span> already paid or pending this cycle{showProcessed ? ' (shown, cannot be paid again)' : ' — hidden to prevent double credits'}
                  </p>
                  <button
                    type="button"
                    onClick={() => setShowProcessed(v => !v)}
                    className="text-xs font-medium text-green-700 dark:text-green-300 underline underline-offset-2 shrink-0"
                  >
                    {showProcessed ? 'Hide them' : 'Show them'}
                  </button>
                </div>
              )}
              {filtered.length === 0 ? (
                <div className="text-center py-10 text-muted-foreground text-sm">
                  <CalendarDays className="h-8 w-8 mx-auto mb-2 opacity-40" />
                  {search ? 'No matching portfolios found.' : 'No portfolios nearing payout.'}
                </div>
              ) : (
                filtered.map((p, idx) => {
                  const roiAmount = Math.round(p.investmentAmount * p.roiPercentage / 100);
                  const isProcessing = processing[p.portfolioId];
                  const isDone = completed[p.portfolioId];
                  const refPreview = `${p.portfolioId.slice(0, 8)}`;
                  // Labelled payout destination (registered name + number).
                  const destLabel =
                    p.paymentMethod === 'bank_transfer' ? 'Account name'
                    : p.paymentMethod === 'cash' ? 'Payout'
                    : 'MoMo name';
                  const destName =
                    p.paymentMethod === 'bank_transfer'
                      ? (p.bankAccountName || p.name)
                      : p.paymentMethod === 'cash'
                      ? 'Cash pickup'
                      : (p.bankAccountName || p.name || 'Name not set');
                  const destExtra =
                    p.paymentMethod === 'bank_transfer'
                      ? [p.bankName, p.accountNumber].filter(Boolean).join(' · ')
                      : p.paymentMethod === 'cash'
                      ? ''
                      : [p.mobileNetwork, p.mobileMoneyNumber].filter(Boolean).join(' · ');
                  return (
                    <div key={p.portfolioId + idx} className={cn("rounded-xl border border-border/60 bg-card p-3 sm:p-4 space-y-2", isDone === 'compounded' && "opacity-60 border-green-500/40 bg-green-500/5", isDone === 'pending' && "opacity-80 border-amber-500/40 bg-amber-500/5", isDone === 'split' && "opacity-70 border-violet-500/40 bg-violet-500/5")}>
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0">
                          <div className="flex items-center gap-1.5 flex-wrap">
                            <p className="font-semibold text-sm truncate">{p.name}</p>
                            {p.roiMode === 'monthly_compounding' && (
                              <Badge className="shrink-0 text-[9px] bg-green-500/15 text-green-700 dark:text-green-300 border-green-500/30">
                                📈 Compounding
                              </Badge>
                            )}
                          </div>
                          <p className="text-xs text-primary/80 font-medium truncate">{p.portfolioName}</p>
                          <p className="text-xs text-muted-foreground">{p.phone || p.email || 'No contact'}</p>
                        </div>
                        {isDone === 'pending' ? (
                          <Badge className="shrink-0 text-[10px] bg-amber-500/15 text-amber-700 dark:text-amber-300 border-amber-500/30">
                            ⏳ Pending Approval
                          </Badge>
                        ) : isDone === 'compounded' ? (
                          <Badge className="shrink-0 text-[10px] bg-green-500/15 text-green-700 dark:text-green-300 border-green-500/30">
                            ✓ Compounded
                          </Badge>
                        ) : isDone === 'split' ? (
                          <Badge className="shrink-0 text-[10px] bg-violet-500/15 text-violet-700 dark:text-violet-300 border-violet-500/30">
                            ✂️ Split Processed
                          </Badge>
                        ) : p.daysUntil < 0 ? (
                          <Badge variant="destructive" className="shrink-0 text-[10px]">
                            {Math.abs(p.daysUntil)}d overdue
                          </Badge>
                        ) : p.daysUntil === 0 ? (
                          <Badge className="shrink-0 text-[10px] bg-amber-500/15 text-amber-700 dark:text-amber-300 border-amber-500/30">
                            Due Today
                          </Badge>
                        ) : (
                          <Badge variant={p.daysUntil <= 2 ? 'warning' : 'secondary'} className="shrink-0 text-[10px]">
                            {p.daysUntil === 1 ? 'Tomorrow' : `${p.daysUntil}d away`}
                          </Badge>
                        )}
                      </div>
                      <div className="grid grid-cols-2 gap-2 text-center">
                        <div className="rounded-lg bg-muted/50 p-2">
                          <p className="text-[10px] text-muted-foreground">Principal</p>
                          <p className="text-xs font-bold tabular-nums">{formatUGX(p.investmentAmount)}</p>
                        </div>
                        <div className="rounded-lg bg-muted/50 p-2">
                          <p className="text-[10px] text-muted-foreground">Returns Due</p>
                          <p className="text-xs font-bold tabular-nums text-primary">{formatUGX(roiAmount)}</p>
                        </div>
                        <div className="rounded-lg bg-muted/50 p-2">
                          <p className="text-[10px] text-muted-foreground">Contribution Date</p>
                          <p className="text-xs font-bold">
                            {formatDateOnlyForDisplay(p.createdAt, { month: 'short', day: 'numeric', year: 'numeric' })}
                          </p>
                        </div>
                        <div className="rounded-lg bg-muted/50 p-2">
                          <p className="text-[10px] text-muted-foreground">Payout Date</p>
                          <p className="text-xs font-bold">
                            {new Date(p.nextPayoutDate + 'T00:00:00').toLocaleDateString('en-UG', { month: 'short', day: 'numeric', year: 'numeric' })}
                          </p>
                        </div>
                      </div>
                      <div className="flex items-center justify-between text-[10px] text-muted-foreground">
                        <span>{p.roiPercentage}% · {p.roiMode === 'monthly_compounding' ? 'Compounding' : 'Payout'}</span>
                        <span className="font-mono">{refPreview}</span>
                      </div>
                      <div className="rounded-lg border border-border/60 bg-muted/30 px-2.5 py-1.5">
                        <p className="text-[9px] uppercase tracking-wide text-muted-foreground">{destLabel}</p>
                        <p className="text-xs font-semibold">{destName}</p>
                        {destExtra && <p className="text-[10px] text-muted-foreground">{destExtra}</p>}
                      </div>
                      {/* Audit Reason + Action Buttons */}
                      {p.alreadyProcessedThisCycle && !isDone && (
                        <div className="flex items-center gap-2 rounded-lg border border-green-500/30 bg-green-500/5 px-3 py-2">
                          <CheckCircle2 className="h-4 w-4 text-green-600 shrink-0" />
                          <p className="text-xs font-medium text-green-700 dark:text-green-300">
                            {p.processedState === 'pending'
                              ? 'ROI already in the approval queue for this cycle — cannot pay again.'
                              : 'ROI already credited this cycle — cannot pay again.'}
                          </p>
                        </div>
                      )}
                      {!isDone && !p.alreadyProcessedThisCycle && (
                        <div className="space-y-2 pt-1">
                          <Textarea
                            placeholder="Include reason and phone number or A/C"
                            className="min-h-[60px] text-xs"
                            value={reasons[p.portfolioId] || ''}
                            onChange={e => setReasons(prev => ({ ...prev, [p.portfolioId]: e.target.value }))}
                          />
                          {(reasons[p.portfolioId]?.length || 0) > 0 && (reasons[p.portfolioId]?.length || 0) < 10 && (
                            <p className="text-[10px] text-destructive">Reason must be at least 10 characters</p>
                          )}
                          <div className="flex gap-2">
                            <Button
                              size="sm"
                              variant="outline"
                              className="flex-1 text-xs gap-1.5"
                              disabled={!!isProcessing || (reasons[p.portfolioId]?.length || 0) < 10}
                              onClick={() => handleCompound(p, reasons[p.portfolioId])}
                            >
                              {isProcessing === 'compound' ? <Loader2 className="h-3 w-3 animate-spin" /> : <ArrowUpRight className="h-3 w-3" />}
                              Compound
                            </Button>
                            <Button
                              size="sm"
                              variant="secondary"
                              className="flex-1 text-xs gap-1.5"
                              disabled={!!isProcessing || (reasons[p.portfolioId]?.length || 0) < 10}
                              onClick={() => handleSplitClick(p)}
                            >
                              {isProcessing === 'split' ? <Loader2 className="h-3 w-3 animate-spin" /> : <Scissors className="h-3 w-3" />}
                              Split
                            </Button>
                            <Button
                              size="sm"
                              variant="default"
                              className="flex-1 text-xs gap-1.5"
                              disabled={!!isProcessing || (reasons[p.portfolioId]?.length || 0) < 10}
                              onClick={() => handlePayClick(p)}
                            >
                              <Wallet className="h-3 w-3" />
                              Pay
                            </Button>
                          </div>
                        </div>
                      )}
                      <Button
                        size="sm"
                        variant="ghost"
                        className="w-full text-xs gap-1.5 text-muted-foreground hover:text-primary"
                        disabled={sharingCardId === p.portfolioId}
                        onClick={() => handleShareCard(p)}
                      >
                        {sharingCardId === p.portfolioId ? <Loader2 className="h-3 w-3 animate-spin" /> : <Share2 className="h-3 w-3" />}
                        Share payout card
                      </Button>
                    </div>
                  );
                })
              )}
            </div>
          </>
        ) : paymentStep === 'payment-options' && selectedPayout ? (
          /* ═══ Step 2: Payment Options ═══ */
          <>
            <DialogHeader className="p-4 pb-2 sm:p-5 sm:pb-3">
              <DialogTitle className="flex items-center gap-2 text-base">
                <button
                  onClick={() => { setPaymentStep('list'); setSelectedPayout(null); }}
                  className="p-1 -ml-1 rounded-lg hover:bg-muted transition-colors"
                >
                  <ArrowUpRight className="h-4 w-4 rotate-[225deg]" />
                </button>
                Payment Options
              </DialogTitle>
              <DialogDescription className="text-xs">
                Choose how to pay {selectedPayout.name}
              </DialogDescription>
            </DialogHeader>
            <div className="px-4 pb-4 sm:px-5 sm:pb-5 space-y-4">
              {/* Payout Summary Card */}
              <div className="rounded-xl border border-border/60 bg-muted/30 p-4 space-y-3">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="font-semibold text-sm">{selectedPayout.name}</p>
                    <p className="text-xs text-muted-foreground">{selectedPayout.phone || selectedPayout.email || 'No contact'}</p>
                  </div>
                  <Badge variant="secondary" className="text-[10px] shrink-0">
                    {selectedPayout.daysUntil === 0 ? 'Today' : selectedPayout.daysUntil === 1 ? 'Tomorrow' : `${selectedPayout.daysUntil}d away`}
                  </Badge>
                </div>
                <div className="grid grid-cols-2 gap-2 text-center">
                  <div className="rounded-lg bg-background p-2">
                    <p className="text-[10px] text-muted-foreground">Principal</p>
                    <p className="text-xs font-bold tabular-nums">{formatUGX(selectedPayout.investmentAmount)}</p>
                  </div>
                  <div className="rounded-lg bg-primary/10 p-2">
                    <p className="text-[10px] text-muted-foreground">Returns Due</p>
                    <p className="text-xs font-bold tabular-nums text-primary">{formatUGX(selectedRoiAmount)}</p>
                  </div>
                </div>
                <div className="rounded-lg bg-background border border-border/40 p-2.5">
                  <p className="text-[10px] text-muted-foreground mb-0.5">Audit Reason</p>
                  <p className="text-xs leading-relaxed">{selectedReason}</p>
                </div>
              </div>

              {/* Managed Account Status */}
              {checkingManagedStep2 ? (
                <div className="flex items-center justify-center gap-2 py-4 text-muted-foreground">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  <span className="text-xs">Checking account status...</span>
                </div>
              ) : selectedManaged?.isManaged ? (
                /* ─── Managed Account ─── */
                <div className="space-y-3">
                   <div className="flex items-center gap-2 rounded-xl bg-primary/10 border border-primary/20 px-3 py-2.5">
                     <ShieldCheck className="h-4 w-4 text-primary shrink-0" />
                     <div className="min-w-0">
                       <p className="text-xs font-semibold text-primary">Managed Account</p>
                       <p className="text-[10px] text-primary/70">Funds are routed to proxy agent <strong>{selectedManaged.agentName}</strong>'s wallet for disbursement to the partner. Partner wallet is not credited.</p>
                     </div>
                   </div>
                   <Button
                     className="w-full gap-2"
                     disabled={!!selectedProcessing}
                     onClick={() => handlePay(selectedPayout, selectedReason, 'wallet')}
                   >
                     {selectedProcessing === 'pay' ? <Loader2 className="h-4 w-4 animate-spin" /> : <ShieldCheck className="h-4 w-4" />}
                     Pay to Proxy Agent Wallet
                   </Button>
                </div>
              ) : (
                /* ─── Standard or Non-Managed Proxy Account ─── */
                <div className="space-y-3">
                  {/* Show proxy agent notice for non-managed assignments */}
                  {selectedManaged?.hasProxy && !selectedManaged?.isManaged && (
                    <div className="flex items-center gap-2 rounded-xl bg-amber-500/10 border border-amber-500/20 px-3 py-2.5">
                      <Handshake className="h-4 w-4 text-amber-600 shrink-0" />
                      <div className="min-w-0">
                        <p className="text-xs font-semibold text-amber-700 dark:text-amber-400">Linked Proxy Agent</p>
                        <p className="text-[10px] text-amber-600/80 dark:text-amber-400/70">
                          <strong>{selectedManaged.agentName}</strong> is assigned as proxy agent for this partner
                        </p>
                      </div>
                    </div>
                  )}
                  <p className="text-xs font-medium text-muted-foreground">Select payment method</p>
                  <div className="grid grid-cols-2 gap-3">
                    <button
                      className={cn(
                        "flex flex-col items-center gap-2 rounded-xl border-2 p-4 transition-all",
                        "hover:border-primary/50 hover:bg-primary/5",
                        "focus:outline-none focus:ring-2 focus:ring-primary/30"
                      )}
                      disabled={!!selectedProcessing}
                       onClick={() => handlePay(selectedPayout, selectedReason, 'wallet')}
                    >
                      {selectedProcessing === 'pay' ? (
                        <Loader2 className="h-6 w-6 animate-spin text-primary" />
                      ) : selectedManaged?.hasProxy ? (
                        <ShieldCheck className="h-6 w-6 text-primary" />
                      ) : (
                        <Wallet className="h-6 w-6 text-primary" />
                      )}
                       <span className="text-xs font-semibold">Pay to Partner Wallet</span>
                       <span className="text-[10px] text-muted-foreground leading-tight text-center">
                         {selectedManaged?.hasProxy ? `Lands in partner's wallet (proxy: ${selectedManaged.agentName})` : "Credit partner's digital wallet"}
                       </span>
                    </button>
                    <button
                      className={cn(
                        "flex flex-col items-center gap-2 rounded-xl border-2 p-4 transition-all",
                        "hover:border-primary/50 hover:bg-primary/5",
                        "focus:outline-none focus:ring-2 focus:ring-primary/30"
                      )}
                      disabled={!!selectedProcessing}
                      onClick={() => handlePay(selectedPayout, selectedReason, 'already_paid')}
                    >
                      <CheckCircle2 className="h-6 w-6 text-primary" />
                      <span className="text-xs font-semibold">Cash</span>
                      <span className="text-[10px] text-muted-foreground leading-tight text-center">Already/to be paid externally</span>
                    </button>
                  </div>
                </div>
              )}
            </div>
          </>
        ) : paymentStep === 'split-config' && selectedPayout ? (
          /* ═══ Step 3: Split Configuration ═══ */
          <>
            <DialogHeader className="p-4 pb-2 sm:p-5 sm:pb-3">
              <DialogTitle className="flex items-center gap-2 text-base">
                <button
                  onClick={() => { setPaymentStep('list'); setSelectedPayout(null); }}
                  className="p-1 -ml-1 rounded-lg hover:bg-muted transition-colors"
                >
                  <ArrowUpRight className="h-4 w-4 rotate-[225deg]" />
                </button>
                <Scissors className="h-4 w-4" />
                Split Payout
              </DialogTitle>
              <DialogDescription className="text-xs">
                Split {selectedPayout.name}'s returns between cash and reinvestment
              </DialogDescription>
            </DialogHeader>
            <div className="px-4 pb-4 sm:px-5 sm:pb-5 space-y-4">
              {/* Summary */}
              <div className="rounded-xl border border-border/60 bg-muted/30 p-4 space-y-3">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="font-semibold text-sm">{selectedPayout.name}</p>
                    <p className="text-xs text-muted-foreground">{selectedPayout.phone || selectedPayout.email || 'No contact'}</p>
                  </div>
                  <Badge variant="secondary" className="text-[10px] shrink-0">
                    {selectedPayout.roiPercentage}% ROI
                  </Badge>
                </div>
                <div className="grid grid-cols-3 gap-2 text-center">
                  <div className="rounded-lg bg-background p-2">
                    <p className="text-[10px] text-muted-foreground">Principal</p>
                    <p className="text-xs font-bold tabular-nums">{formatUGX(selectedPayout.investmentAmount)}</p>
                  </div>
                  <div className="rounded-lg bg-primary/10 p-2">
                    <p className="text-[10px] text-muted-foreground">Total Returns</p>
                    <p className="text-xs font-bold tabular-nums text-primary">{formatUGX(selectedRoiAmount)}</p>
                  </div>
                  <div className="rounded-lg bg-background p-2">
                    <p className="text-[10px] text-muted-foreground">
                      {splitReinvestMode === 'keep_returns' ? 'Principal (unchanged)' : 'New Principal'}
                    </p>
                    <p className="text-xs font-bold tabular-nums">
                      {formatUGX(splitReinvestMode === 'keep_returns' ? selectedPayout.investmentAmount : selectedPayout.investmentAmount + (selectedRoiAmount - splitCashAmount))}
                    </p>
                  </div>
                </div>
              </div>

              {/* Split Controls */}
              <div className="space-y-3">
                <Label className="text-xs font-medium">Cash Amount</Label>
                <div className="flex items-center gap-3">
                  <Input
                    type="number"
                    min={1}
                    max={selectedRoiAmount - 1}
                    value={splitCashAmount}
                    onChange={e => {
                      const val = Math.max(1, Math.min(selectedRoiAmount - 1, Number(e.target.value) || 0));
                      setSplitCashAmount(val);
                    }}
                    className="text-sm tabular-nums"
                  />
                </div>
                <Slider
                  min={1}
                  max={selectedRoiAmount - 1}
                  step={1000}
                  value={[splitCashAmount]}
                  onValueChange={([v]) => setSplitCashAmount(v)}
                  className="py-1"
                />

                {/* Visual breakdown */}
                <div className="grid grid-cols-2 gap-3">
                  <div className="rounded-xl border-2 border-primary/30 bg-primary/5 p-3 text-center">
                    <Wallet className="h-4 w-4 mx-auto mb-1 text-primary" />
                    <p className="text-[10px] text-muted-foreground">Cash Payout</p>
                    <p className="text-sm font-bold tabular-nums text-primary">{formatUGX(splitCashAmount)}</p>
                  </div>
                  <div className={cn("rounded-xl border-2 p-3 text-center cursor-pointer transition-all", splitReinvestMode === 'reinvest' ? "border-green-500/50 bg-green-500/10" : "border-border/40 bg-muted/30 hover:border-green-500/30")} onClick={() => setSplitReinvestMode('reinvest')}>
                    <TrendingUp className="h-4 w-4 mx-auto mb-1 text-green-600" />
                    <p className="text-[10px] text-muted-foreground">Reinvest</p>
                    <p className="text-sm font-bold tabular-nums text-green-600">{formatUGX(selectedRoiAmount - splitCashAmount)}</p>
                    <p className="text-[9px] text-muted-foreground mt-0.5">Adds to principal</p>
                  </div>
                  <div className={cn("rounded-xl border-2 p-3 text-center cursor-pointer transition-all", splitReinvestMode === 'keep_returns' ? "border-amber-500/50 bg-amber-500/10" : "border-border/40 bg-muted/30 hover:border-amber-500/30")} onClick={() => setSplitReinvestMode('keep_returns')}>
                    <PiggyBank className="h-4 w-4 mx-auto mb-1 text-amber-600" />
                    <p className="text-[10px] text-muted-foreground">Keep as Returns</p>
                    <p className="text-sm font-bold tabular-nums text-amber-600">{formatUGX(selectedRoiAmount - splitCashAmount)}</p>
                    <p className="text-[9px] text-muted-foreground mt-0.5">Principal stays flat</p>
                  </div>
                </div>
              </div>

              {/* Payment method for cash portion */}
              {checkingManagedStep2 ? (
                <div className="flex items-center justify-center gap-2 py-3 text-muted-foreground">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  <span className="text-xs">Checking account status...</span>
                </div>
              ) : (
                <div className="space-y-2">
                  <Label className="text-xs font-medium">Cash portion payment method</Label>
                  <Select value={splitPayMode} onValueChange={(v: any) => setSplitPayMode(v)}>
                    <SelectTrigger className="h-9 text-xs">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="wallet">
                        {selectedManaged?.isManaged || selectedManaged?.hasProxy
                          ? `Partner Wallet (proxy: ${selectedManaged?.agentName})`
                          : 'Pay to Partner Wallet'}
                      </SelectItem>
                      <SelectItem value="already_paid">Cash (already/to be paid externally)</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              )}

              {/* Audit reason */}
              <div className="rounded-lg bg-background border border-border/40 p-2.5">
                <p className="text-[10px] text-muted-foreground mb-0.5">Audit Reason</p>
                <p className="text-xs leading-relaxed">{selectedReason}</p>
              </div>

              {/* Confirm */}
              <Button
                className="w-full gap-2"
                disabled={!!selectedProcessing || splitCashAmount < 1 || splitCashAmount >= selectedRoiAmount}
                onClick={() => handleSplitPayout(selectedPayout, splitCashAmount, selectedReason, splitPayMode, splitReinvestMode)}
              >
                {selectedProcessing === 'split' ? <Loader2 className="h-4 w-4 animate-spin" /> : <Scissors className="h-4 w-4" />}
                Confirm Split Payout
              </Button>
            </div>
          </>
        ) : null}
      </DialogContent>
    </Dialog>

    {/* Compound confirmation — shows recipient email + queue status */}
    <Dialog
      open={!!compoundConfirmation?.open}
      onOpenChange={(v) => {
        if (!v) setCompoundConfirmation(prev => prev ? { ...prev, open: false } : prev);
      }}
    >
      <DialogContent className="sm:max-w-md">
        {compoundConfirmation && (() => {
          const status = compoundConfirmation.emailStatus;
          const styles =
            status === 'queued' || status === 'previously_sent'
              ? { Icon: MailCheck, ring: 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400', label: status === 'queued' ? 'Email queued for delivery' : 'New email queued (previously sent)' }
              : status === 'suppressed'
              ? { Icon: MailX, ring: 'bg-destructive/10 text-destructive', label: 'Email suppressed' }
              : status === 'skipped_no_email'
              ? { Icon: Mail, ring: 'bg-muted text-muted-foreground', label: 'No email sent' }
              : { Icon: MailWarning, ring: 'bg-amber-500/10 text-amber-700 dark:text-amber-400', label: 'Email failed' };
          const StatusIcon = styles.Icon;
          return (
            <>
              <DialogHeader>
                <div className="flex items-center gap-2">
                  <div className="h-9 w-9 rounded-full bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 flex items-center justify-center">
                    <CheckCircle2 className="h-5 w-5" />
                  </div>
                  <div>
                    <DialogTitle className="text-base">ROI Compounded</DialogTitle>
                    <DialogDescription className="text-xs">
                      {compoundConfirmation.partnerName} · {compoundConfirmation.portfolioLabel}
                    </DialogDescription>
                  </div>
                </div>
              </DialogHeader>
              <div className="space-y-3">
                <div className="grid grid-cols-2 gap-2">
                  <div className="rounded-lg bg-muted/50 border border-border/40 p-2.5">
                    <p className="text-[10px] text-muted-foreground uppercase tracking-wide">ROI Reinvested</p>
                    <p className="text-sm font-bold tabular-nums">{formatUGX(compoundConfirmation.roiAmount)}</p>
                  </div>
                  <div className="rounded-lg bg-muted/50 border border-border/40 p-2.5">
                    <p className="text-[10px] text-muted-foreground uppercase tracking-wide">New Principal</p>
                    <p className="text-sm font-bold tabular-nums">{formatUGX(compoundConfirmation.newPrincipal)}</p>
                  </div>
                </div>

                <div className={cn('rounded-lg border border-border/40 p-3 space-y-2')}>
                  <div className="flex items-start gap-2.5">
                    <div className={cn('h-8 w-8 rounded-full flex items-center justify-center shrink-0', styles.ring)}>
                      <StatusIcon className="h-4 w-4" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-xs font-semibold">{styles.label}</p>
                      <p className="text-[11px] text-muted-foreground break-all mt-0.5">
                        {compoundConfirmation.recipientEmail || '—'}
                      </p>
                      {compoundConfirmation.emailDetail && (
                        <p className="text-[11px] text-muted-foreground mt-1.5 leading-relaxed">
                          {compoundConfirmation.emailDetail}
                        </p>
                      )}
                    </div>
                  </div>
                </div>

                <div className="rounded-lg bg-muted/30 border border-dashed border-border/40 p-2">
                  <p className="text-[10px] text-muted-foreground uppercase tracking-wide">Reference</p>
                  <p className="text-xs font-mono break-all">{compoundConfirmation.refId}</p>
                </div>
              </div>
              <DialogFooter>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setCompoundConfirmation(prev => prev ? { ...prev, open: false } : prev)}
                >
                  Close
                </Button>
              </DialogFooter>
            </>
          );
        })()}
      </DialogContent>
    </Dialog>
    </>
  );
}
