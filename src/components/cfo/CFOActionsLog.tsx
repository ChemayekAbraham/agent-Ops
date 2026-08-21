import { useEffect, useState } from 'react';
import { useQuery, keepPreviousData } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Calendar } from '@/components/ui/calendar';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Loader2, Download, Search, Filter, RefreshCw, ChevronLeft, ChevronRight, X, CalendarIcon, FileText, FileSpreadsheet, ChevronDown } from 'lucide-react';
import { format, startOfDay, endOfDay, subDays, startOfMonth } from 'date-fns';
import type { DateRange } from 'react-day-picker';
import { useDebouncedValue } from '@/hooks/useDebouncedValue';
import { generateCfoLedgerTrailPdf } from '@/lib/cfoLedgerTrailPdf';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';

/**
 * Ledger-derived CFO Actions Trail.
 *
 * This trail is driven DIRECTLY from `general_ledger` via the
 * `get_cfo_ledger_trail` RPC — one row per transaction (double-entry legs
 * are collapsed). Every cash movement that posts to the ledger appears here
 * automatically; there is no allow-list of action strings to maintain.
 */

type TrailRow = {
  group_id: string;
  transaction_date: string;
  amount: number;
  direction: string;
  category: string;
  classification: string | null;
  ledger_scope: string | null;
  description: string | null;
  user_id: string | null;
  actor_name: string | null;
  wallet_bucket: string | null;
  linked_party: string | null;
  reference_id: string | null;
  source_table: string | null;
  source_id: string | null;
  leg_count: number;
  total_count: number;
};

const fmt = (n: number) =>
  new Intl.NumberFormat('en-UG', { style: 'currency', currency: 'UGX', maximumFractionDigits: 0 }).format(n);

// Human-friendly labels for the common ledger categories. Anything not listed
// is auto-humanized (snake_case → Title Case), so new categories never vanish.
const CATEGORY_LABELS: Record<string, string> = {
  access_fee_collected: 'Access Fee',
  registration_fee_collected: 'Registration Fee',
  wallet_deposit: 'Wallet Deposit',
  deposit: 'Deposit',
  tenant_repayment: 'Tenant Repayment',
  agent_repayment: 'Agent Repayment',
  partner_funding: 'Partner Funding',
  supporter_capital: 'Supporter Capital',
  share_capital: 'Share Capital',
  rent_disbursement: 'Rent Disbursement',
  rent_principal_collected: 'Rent Principal Collected',
  landlord_rent_payment: 'Landlord Rent Payment',
  roi_expense: 'ROI Payout (Expense)',
  roi_wallet_credit: 'ROI Wallet Credit',
  roi_reinvestment: 'ROI Reinvestment',
  roi_payout: 'ROI Payout',
  agent_commission_earned: 'Agent Commission',
  agent_commission: 'Agent Commission',
  agent_commission_withdrawal: 'Commission Withdrawal',
  agent_commission_used_for_rent: 'Commission Used For Rent',
  partner_commission: 'Partner Commission',
  wallet_withdrawal: 'Wallet Withdrawal',
  wallet_transfer: 'Wallet Transfer',
  wallet_deduction: 'Wallet Deduction',
  proxy_partner_withdrawal: 'Partner Withdrawal',
  system_balance_correction: 'Balance Correction',
  agent_float_deposit: 'Agent Float Deposit',
  agent_float_assignment: 'Agent Float Assignment',
  agent_float_settlement: 'Agent Float Settlement',
  agent_float_used_for_rent: 'Float Used For Rent',
  agent_advance_credit: 'Agent Advance',
  marketing_expense: 'Marketing Expense',
  payroll_expense: 'Payroll',
  general_admin_expense: 'General & Admin',
  research_development_expense: 'R&D Expense',
  tax_expense: 'Tax',
  interest_expense: 'Interest Expense',
  equipment_expense: 'Equipment',
  debt_recovery: 'Debt Recovery',
  tenant_default_charge: 'Tenant Default Penalty',
  pending_portfolio_topup: 'Portfolio Top-up',
};

const CATEGORY_ICONS: Record<string, string> = {
  wallet_deposit: '💵', deposit: '💵', partner_funding: '🏦', supporter_capital: '🏦', share_capital: '🏦',
  roi_expense: '📉', roi_payout: '📈', roi_wallet_credit: '📈', roi_reinvestment: '🔁',
  agent_commission_earned: '👤', agent_commission: '👤', partner_commission: '🤝',
  wallet_withdrawal: '💸', proxy_partner_withdrawal: '💸', wallet_transfer: '🔁',
  wallet_deduction: '🔻', system_balance_correction: '🔧',
  rent_disbursement: '🏠', landlord_rent_payment: '🏠', rent_principal_collected: '🏠',
  agent_float_deposit: '🏦', agent_float_assignment: '🏦', agent_float_settlement: '🏦',
  marketing_expense: '📣', payroll_expense: '📋', general_admin_expense: '🗂️',
  access_fee_collected: '✅', registration_fee_collected: '✅',
};

const labelFor = (cat: string) =>
  CATEGORY_LABELS[cat] ||
  cat.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());

const FILTER_GROUPS: { label: string; value: string; categories: string[] | null }[] = [
  { label: 'All Movements', value: 'all', categories: null },
  { label: 'Deposits & Funding', value: 'inflow', categories: ['wallet_deposit', 'deposit', 'partner_funding', 'supporter_capital', 'share_capital', 'tenant_repayment', 'agent_repayment'] },
  { label: 'Withdrawals', value: 'withdrawals', categories: ['wallet_withdrawal', 'proxy_partner_withdrawal', 'wallet_deduction'] },
  { label: 'ROI', value: 'roi', categories: ['roi_expense', 'roi_payout', 'roi_wallet_credit', 'roi_reinvestment'] },
  { label: 'Commissions', value: 'commissions', categories: ['agent_commission_earned', 'agent_commission', 'agent_commission_withdrawal', 'partner_commission'] },
  { label: 'Rent & Landlord', value: 'rent', categories: ['rent_disbursement', 'landlord_rent_payment', 'rent_principal_collected'] },
  { label: 'Agent Float', value: 'float', categories: ['agent_float_deposit', 'agent_float_assignment', 'agent_float_settlement', 'agent_float_used_for_rent', 'agent_advance_credit'] },
  { label: 'Expenses', value: 'expenses', categories: ['marketing_expense', 'payroll_expense', 'general_admin_expense', 'research_development_expense', 'tax_expense', 'interest_expense', 'equipment_expense'] },
  { label: 'Corrections', value: 'corrections', categories: ['system_balance_correction'] },
];

const PAGE_SIZE = 25;

const AVATAR_TONES = [
  'bg-primary/15 text-primary',
  'bg-emerald-100 text-emerald-700 dark:bg-emerald-950/50 dark:text-emerald-400',
  'bg-amber-100 text-amber-700 dark:bg-amber-950/50 dark:text-amber-400',
  'bg-sky-100 text-sky-700 dark:bg-sky-950/50 dark:text-sky-400',
  'bg-orange-100 text-orange-700 dark:bg-orange-950/50 dark:text-orange-400',
];

const initialsFor = (name: string) =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase() || '')
    .join('') || 'SY';

const toneFor = (seed: string) => {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) % 997;
  return AVATAR_TONES[h % AVATAR_TONES.length];
};

const DATE_PRESETS: { label: string; days: number | 'mtd' }[] = [
  { label: 'Last 7 days', days: 7 },
  { label: 'Last 30 days', days: 30 },
  { label: 'Last 90 days', days: 90 },
  { label: 'Month to date', days: 'mtd' },
];

// Short reference for IDs (uuid → first segment, plain refs kept as-is).
const shortRef = (v?: string | null) => {
  if (!v) return null;
  const s = String(v).trim();
  if (!s) return null;
  return s.length > 12 ? s.slice(0, 8).toUpperCase() : s;
};

/**
 * Builds the human action sentence for a trail row from the LIVE ledger
 * fields only (category, reference, linked party, actor, posting date).
 * Nothing here is hardcoded sample data — unmatched categories fall back to
 * the humanised category label so new movements never vanish.
 */
const describeAction = (r: TrailRow): string => {
  const party = r.linked_party || (r.actor_name && r.actor_name !== 'System' ? r.actor_name : null);
  const ref = shortRef(r.reference_id) || shortRef(r.source_id);
  const cat = r.category;

  if (cat === 'rent_disbursement' || cat === 'landlord_rent_payment') {
    return `Approved rent payout for Landlord #${ref || party || '—'}`;
  }
  if (cat === 'payroll_expense') {
    return `Released payroll for ${format(new Date(r.transaction_date), 'MMMM yyyy')}`;
  }
  if (
    cat === 'agent_commission' ||
    cat === 'agent_commission_earned' ||
    cat === 'agent_commission_withdrawal' ||
    cat === 'partner_commission'
  ) {
    return `Approved agent commissions batch #${ref || party || '—'}`;
  }
  if (cat.startsWith('agent_float')) {
    return `Replenished agent float — ${party || ref || 'Unassigned team'}`;
  }
  if (cat === 'system_balance_correction' || r.classification === 'admin_correction') {
    return `Adjusted ledger correction — Wallet ${shortRef(r.user_id) || ref || '—'}`;
  }
  return party ? `${labelFor(cat)} — ${party}` : labelFor(cat);
};

// Real relative timestamp computed from the logged action time ("2h ago").
const relativeTime = (iso: string): string => {
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return '';
  const secs = Math.max(0, Math.floor((Date.now() - then) / 1000));
  if (secs < 60) return 'just now';
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days < 7) return `${days}d ago`;
  const weeks = Math.floor(days / 7);
  if (days < 30) return `${weeks}w ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo ago`;
  return `${Math.floor(days / 365)}y ago`;
};

export function CFOActionsLog() {
  const [filterGroup, setFilterGroup] = useState('all');
  const [searchInput, setSearchInput] = useState('');
  const [page, setPage] = useState(0);
  const [dateRange, setDateRange] = useState<DateRange | undefined>();
  const [open, setOpen] = useState(true);
  const search = useDebouncedValue(searchInput.trim(), 350);


  const fromISO = dateRange?.from ? startOfDay(dateRange.from).toISOString() : null;
  const toISO = dateRange?.to ? endOfDay(dateRange.to).toISOString() : (dateRange?.from ? endOfDay(dateRange.from).toISOString() : null);

  // Reset to first page whenever the query (filter or search) changes.
  useEffect(() => {
    setPage(0);
  }, [filterGroup, search, fromISO, toISO]);

  const { data, isLoading, isFetching, refetch } = useQuery({
    queryKey: ['cfo-ledger-trail', filterGroup, search, page, fromISO, toISO],
    queryFn: async () => {
      const group = FILTER_GROUPS.find((g) => g.value === filterGroup);
      const categories = group?.categories ?? null;

      const { data, error } = await supabase.rpc('get_cfo_ledger_trail', {
        p_limit: PAGE_SIZE,
        p_offset: page * PAGE_SIZE,
        p_categories: categories,
        p_classification: null,
        p_search: search || null,
        p_from: fromISO,
        p_to: toISO,
      });
      if (error) throw error;
      const result = (data || []) as TrailRow[];
      return {
        rows: result,
        total: result.length ? Number(result[0].total_count) || 0 : 0,
      };
    },
    staleTime: 30_000,
    placeholderData: keepPreviousData,
  });

  const filtered = data?.rows || [];
  const total = data?.total || 0;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const rangeStart = total === 0 ? 0 : page * PAGE_SIZE + 1;
  const rangeEnd = Math.min(total, (page + 1) * PAGE_SIZE);

  // ── Single source of truth for filter display strings ──
  // The UI controls and the exported filter block both read these, so the
  // export can never drift from what the dashboard shows.
  const categoryLabel = FILTER_GROUPS.find((g) => g.value === filterGroup)?.label ?? 'All Movements';
  const dateRangeLabel = dateRange?.from
    ? dateRange.to && dateRange.to.getTime() !== dateRange.from.getTime()
      ? `${format(dateRange.from, 'MMM d')} – ${format(dateRange.to, 'MMM d, yyyy')}`
      : format(dateRange.from, 'MMM d, yyyy')
    : '';

  const [exporting, setExporting] = useState<null | 'csv' | 'pdf'>(null);

  // Fetch EVERY matching row across all pages, honouring the current filters
  // (category group, search, and date range). Pagination only limits the
  // on-screen list — exports always reflect the full filtered result set.
  const fetchAllMatching = async (): Promise<TrailRow[]> => {
    const group = FILTER_GROUPS.find((g) => g.value === filterGroup);
    const categories = group?.categories ?? null;
    const BATCH = 200;
    const all: TrailRow[] = [];
    let offset = 0;
    // Cap to avoid runaway loops on enormous histories.
    for (let i = 0; i < 200; i++) {
      const { data, error } = await supabase.rpc('get_cfo_ledger_trail', {
        p_limit: BATCH,
        p_offset: offset,
        p_categories: categories,
        p_classification: null,
        p_search: search || null,
        p_from: fromISO,
        p_to: toISO,
      });
      if (error) throw error;
      const batch = (data || []) as TrailRow[];
      all.push(...batch);
      if (batch.length < BATCH) break;
      offset += BATCH;
    }
    return all;
  };

  const downloadBlob = (blob: Blob, filename: string) => {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1500);
  };

  const isOutRow = (r: TrailRow) => r.direction === 'cash_out' || r.direction === 'debit';

  // Human-readable summary of the filters currently applied, derived from the
  // exact same strings the UI renders. Used verbatim at the top of every
  // export so the file mirrors the dashboard, including empty states.
  const buildFilterSummary = () => ({
    category: categoryLabel,
    dateRange: dateRangeLabel || 'All dates',
    search: search || 'None',
  });

  const handleExportCSV = async () => {
    if (exporting) return;
    setExporting('csv');
    try {
      const rows = await fetchAllMatching();
      if (!rows.length) {
        toast.info('No movements match the current filters.');
        return;
      }
      const summary = buildFilterSummary();
      const csvCell = (v: string) => `"${(v ?? '').replace(/"/g, '""')}"`;
      // Filter context block at the very top of the file.
      const meta = [
        ['CFO Actions Trail'],
        ['Generated', format(new Date(), 'yyyy-MM-dd HH:mm')],
        ['Category Filter', summary.category],
        ['Date Range', summary.dateRange],
        ['Search Terms', summary.search],
        ['Total Movements', String(rows.length)],
        [],
      ]
        .map((cells) => cells.map(csvCell).join(','))
        .join('\n') + '\n';
      const header = 'Date,Movement,Direction,Amount,Party,Classification,Reference,Source,Description\n';
      const csv =
        meta +
        header +
        rows
          .map((r) => {
            const cells = [
              format(new Date(r.transaction_date), 'yyyy-MM-dd HH:mm'),
              labelFor(r.category),
              isOutRow(r) ? 'OUT' : 'IN',
              String(r.amount ?? ''),
              r.actor_name || '',
              r.classification || '',
              r.reference_id || '',
              r.source_table || '',
              (r.description || '').replace(/"/g, '""'),
            ];
            return cells.map((c) => `"${c}"`).join(',');
          })
          .join('\n');
      downloadBlob(new Blob([csv], { type: 'text/csv' }), `cfo-ledger-trail-${format(new Date(), 'yyyy-MM-dd')}.csv`);
      toast.success(`Exported ${rows.length.toLocaleString()} movements to CSV.`);
    } catch (err: any) {
      toast.error(err?.message || 'Failed to export CSV.');
    } finally {
      setExporting(null);
    }
  };

  const handleExportPDF = async () => {
    if (exporting) return;
    setExporting('pdf');
    try {
      const rows = await fetchAllMatching();
      if (!rows.length) {
        toast.info('No movements match the current filters.');
        return;
      }
      const summary = buildFilterSummary();
      const blob = await generateCfoLedgerTrailPdf(
        rows.map((r) => ({
          date: new Date(r.transaction_date),
          movement: labelFor(r.category),
          isOut: isOutRow(r),
          amount: Number(r.amount) || 0,
          party: r.actor_name && r.actor_name !== 'System' ? r.actor_name : undefined,
          reference: r.reference_id || undefined,
          classification: r.classification || undefined,
          description: r.description || undefined,
        })),
        {
          categoryText: summary.category,
          dateRangeText: summary.dateRange,
          searchText: summary.search,
        },
      );
      downloadBlob(blob, `cfo-ledger-trail-${format(new Date(), 'yyyy-MM-dd')}.pdf`);
      toast.success(`Exported ${rows.length.toLocaleString()} movements to PDF.`);
    } catch (err: any) {
      toast.error(err?.message || 'Failed to export PDF.');
    } finally {
      setExporting(null);
    }
  };

  if (isLoading) {
    return (
      <Card className="rounded-lg shadow-sm">
        <CardContent className="p-4 flex justify-center">
          <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="rounded-lg shadow-sm">
      <CardContent className="p-4">
        <div className="flex items-center justify-between gap-2 mb-1 flex-wrap">
          <div className="flex items-center gap-2 text-sm font-bold tracking-tight">
            <span>CFO Actions Log</span>
            {total > 0 && (
              <Badge variant="secondary" className="text-[10px]">{total.toLocaleString()}</Badge>
            )}
          </div>
          <div className="flex items-center gap-1">
            <div className={`flex items-center gap-1 ${open ? '' : 'hidden'}`}>
              {isFetching && <Loader2 className="h-3 w-3 animate-spin text-muted-foreground" />}
              <Button variant="ghost" size="sm" className="h-7 text-xs gap-1" onClick={() => refetch()} disabled={isFetching}>
                <RefreshCw className={`h-3 w-3 ${isFetching ? 'animate-spin' : ''}`} /> Refresh
              </Button>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="ghost" size="sm" className="h-7 text-xs gap-1" disabled={!total || !!exporting}>
                    {exporting ? <Loader2 className="h-3 w-3 animate-spin" /> : <Download className="h-3 w-3" />} Export
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem onClick={handleExportCSV} disabled={!!exporting} className="text-xs gap-2">
                    <FileSpreadsheet className="h-3.5 w-3.5" /> Export CSV
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={handleExportPDF} disabled={!!exporting} className="text-xs gap-2">
                    <FileText className="h-3.5 w-3.5" /> Export PDF
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
            <button
              type="button"
              onClick={() => setOpen((o) => !o)}
              aria-expanded={open}
              aria-label={`${open ? 'Collapse' : 'Expand'} CFO Actions Log`}
              className="text-muted-foreground hover:text-foreground shrink-0"
            >
              <ChevronDown className={`h-3.5 w-3.5 transition-transform ${open ? 'rotate-180' : ''}`} />
            </button>
          </div>
        </div>

        {open && (
        <>
        <p className="text-[10px] text-muted-foreground mb-3">
          Derived directly from the general ledger — every posted cash movement appears automatically.
        </p>


        <div className="flex gap-2 mb-3 flex-wrap">
          <div className="relative flex-1 min-w-[120px]">
            <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3 w-3 text-muted-foreground" />
            <Input
              placeholder="Search name, description, reference…"
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
              className="h-7 text-xs pl-7 pr-7"
            />
            {searchInput && (
              <button
                type="button"
                onClick={() => setSearchInput('')}
                aria-label="Clear search"
                className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
              >
                <X className="h-3 w-3" />
              </button>
            )}
          </div>
          <Select value={filterGroup} onValueChange={setFilterGroup}>
            <SelectTrigger className="h-7 text-xs w-[160px]">
              <Filter className="h-3 w-3 mr-1" />
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {FILTER_GROUPS.map((g) => (
                <SelectItem key={g.value} value={g.value} className="text-xs">{g.label}</SelectItem>
              ))}
            </SelectContent>
          </Select>

          <Popover>
            <PopoverTrigger asChild>
              <Button
                variant="outline"
                size="sm"
                className={cn(
                  'h-7 text-xs gap-1 justify-start font-normal',
                  !dateRange?.from && 'text-muted-foreground',
                )}
              >
                <CalendarIcon className="h-3 w-3" />
                {dateRangeLabel ? dateRangeLabel : <span>Date range</span>}
                {dateRange?.from && (
                  <X
                    className="h-3 w-3 ml-1 hover:text-foreground"
                    onClick={(e) => {
                      e.stopPropagation();
                      setDateRange(undefined);
                    }}
                  />
                )}
              </Button>
            </PopoverTrigger>
            <PopoverContent className="w-auto p-0" align="end">
              <div className="flex flex-wrap gap-1 border-b border-border p-2">
                {DATE_PRESETS.map((preset) => (
                  <Button
                    key={preset.label}
                    variant="ghost"
                    size="sm"
                    className="h-7 text-xs"
                    onClick={() => {
                      const to = new Date();
                      const from = preset.days === 'mtd' ? startOfMonth(to) : subDays(to, preset.days - 1);
                      setDateRange({ from, to });
                    }}
                  >
                    {preset.label}
                  </Button>
                ))}
              </div>
              <Calendar
                mode="range"
                selected={dateRange}
                onSelect={setDateRange}
                numberOfMonths={2}
                initialFocus
                className={cn('p-3 pointer-events-auto')}
              />
            </PopoverContent>
          </Popover>
        </div>

        {!filtered.length ? (
          <p className="text-sm text-muted-foreground text-center py-4">No movements found.</p>
        ) : (
          <>
          <div className="space-y-2 max-h-[500px] overflow-y-auto">
            {filtered.map((r) => {
              const amount = Number(r.amount) || 0;
              const isOut = r.direction === 'cash_out' || r.direction === 'debit';
              const isCorrection = r.classification === 'admin_correction';
              const partyName = r.actor_name && r.actor_name !== 'System' ? r.actor_name : 'System';
              const actionText = describeAction(r);
              // Colour is hashed off a stable actor identity so the same
              // person keeps the same avatar tone across sessions.
              const avatarSeed = r.user_id || partyName;

              return (
                <div key={r.group_id} className="flex items-start gap-3 px-1 py-2 border-b border-border/50 last:border-0 hover:bg-muted/30 transition-colors">
                  <div className={`h-8 w-8 rounded-full flex items-center justify-center text-[10px] font-bold shrink-0 mt-0.5 ${toneFor(avatarSeed)}`}>
                    {initialsFor(partyName)}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-start justify-between gap-3">
                      <p className="text-xs text-foreground truncate">{actionText}</p>
                      <div className="shrink-0 text-right">
                        {amount > 0 && (
                          <p className={`text-xs font-bold tabular-nums ${isOut ? 'text-destructive' : 'text-foreground'}`}>
                            {fmt(amount)}
                          </p>
                        )}
                        <p
                          className="text-[10px] text-muted-foreground"
                          title={format(new Date(r.transaction_date), 'MMM d, yyyy h:mm a')}
                        >
                          {relativeTime(r.transaction_date)}
                        </p>
                      </div>
                    </div>
                    {r.description && (
                      <p className="text-[10px] text-muted-foreground truncate mt-0.5">{r.description}</p>
                    )}
                    <div className="flex items-center gap-1.5 mt-1 flex-wrap">
                      {r.reference_id && (
                        <span className="text-[10px] text-muted-foreground/70 font-mono truncate max-w-[140px]">
                          {r.reference_id}
                        </span>
                      )}
                      {isCorrection && (
                        <Badge variant="outline" className="text-[9px] h-4 px-1 border-orange-400 text-orange-600">
                          Correction
                        </Badge>
                      )}
                      {r.source_table && (
                        <Badge variant="outline" className="text-[9px] h-4 px-1 text-muted-foreground">
                          {r.source_table}
                        </Badge>
                      )}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
          <div className="flex items-center justify-between gap-2 mt-3 pt-3 border-t border-border/50">
            <span className="text-[10px] text-muted-foreground">
              {rangeStart}–{rangeEnd} of {total.toLocaleString()}
            </span>
            <div className="flex items-center gap-1">
              <Button
                variant="outline"
                size="sm"
                className="h-7 px-2 text-xs gap-1"
                onClick={() => setPage((p) => Math.max(0, p - 1))}
                disabled={page === 0 || isFetching}
              >
                <ChevronLeft className="h-3 w-3" /> Prev
              </Button>
              <span className="text-[10px] text-muted-foreground tabular-nums px-1">
                {page + 1} / {totalPages}
              </span>
              <Button
                variant="outline"
                size="sm"
                className="h-7 px-2 text-xs gap-1"
                onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))}
                disabled={page >= totalPages - 1 || isFetching}
              >
                Next <ChevronRight className="h-3 w-3" />
              </Button>
            </div>
          </div>
          </>
        )}
        </>
        )}

      </CardContent>
    </Card>
  );
}
