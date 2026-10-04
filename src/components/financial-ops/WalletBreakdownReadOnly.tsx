import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import {
  Loader2, Search, Wallet, Lock, ChevronRight, ChevronDown, X,
  ArrowRightLeft, Banknote, FileDown, Share2, Layers,
} from 'lucide-react';
import { formatUGX } from '@/lib/rentCalculations';
import { batchedQuery } from '@/lib/supabaseBatchUtils';
import { WalletBucketLedgerDetail } from './WalletBucketLedgerDetail';
import {
  generateUserWalletStatementPdf,
  type UserWalletStatementRow,
} from '@/lib/userWalletStatementPdf';
import { sharePdfViaWhatsApp } from '@/lib/whatsappShare';
import { toast } from 'sonner';

type FocusBucket = 'float' | 'withdrawable' | null;

const CATEGORY_LABEL: Record<string, string> = {
  agent_float_deposit: 'Float deposit',
  operational_float_deposit: 'Float deposit',
  agent_float_topup: 'Float top-up',
  float_received: 'Float received',
  partner_float_transfer_in: 'Partner transfer in',
  rent_payment_for_tenant: "Paid tenant's rent",
  agent_float_used_for_rent: "Paid tenant's rent",
  agent_float_payout: 'Float payout',
  float_withdrawal: 'Float withdrawal',
  landlord_payout: 'Paid landlord',
  partner_float_transfer_out: 'Partner transfer out',
  agent_rent_commission: 'Rent commission (10%)',
  rent_commission: 'Rent commission',
  agent_commission_earned: 'Commission earned',
  agent_commission: 'Commission earned',
  agent_commission_payout: 'Commission paid out',
  agent_commission_payable: 'Commission posted',
  agent_investment_commission: 'Investment commission',
  investment_commission: 'Investment commission',
  partner_commission: 'Partner commission (2%)',
  subagent_commission: 'Sub-agent override',
  registration_bonus: 'Registration bonus',
  verification_bonus: 'Verification bonus',
  facilitation_bonus: 'Facilitation bonus',
  listing_bonus: 'Listing bonus',
  tenant_placement_bonus: 'Tenant placement bonus',
  agent_bonus: 'Bonus',
  approval_bonus: 'Approval bonus',
  referral_bonus: 'Referral bonus',
  roi_wallet_credit: 'Investor returns',
  withdrawal: 'Withdrawal',
  agent_wallet_withdrawal: 'Withdrawal',
  wallet_withdrawal: 'Withdrawal',
  deposit: 'Deposit',
  wallet_deposit: 'Deposit',
  tenant_repayment: 'Tenant repayment',
  rent_repayment: 'Rent repayment',
  rent_auto_deduction: 'Auto rent deduction',
  agent_float_settlement: 'Float settled',
  rent_float_funding: 'Rent funding',
  rent_disbursement: 'Rent disbursed to landlord',
  rent_receivable_created: 'Rent recorded',
  advance_disbursement: 'Advance disbursed',
  advance_repayment: 'Advance repayment',
  advance_recovery: 'Advance recovered',
  balance_correction: 'Wallet correction',
  historical_balance_reseed: 'Opening balance',
  wallet_transfer: 'Wallet transfer',
  transfer_in: 'Transfer received',
  transfer_out: 'Transfer sent',
  welcome_bonus: 'Welcome bonus',
};

function labelForCategory(cat: string | null): string {
  if (!cat) return 'Transaction';
  return CATEGORY_LABEL[cat] ?? cat.replace(/_/g, ' ');
}

/**
 * Read-only wallet breakdown for managers / Fin Ops. Lists every wallet
 * with the cached balance buckets, joined to the owner's name + phone.
 *
 * Filters:
 *   - Free-text search across full name / phone (case-insensitive)
 *   - Min / Max total balance range (UGX)
 *   - Optional bucket focus (Operations Float / Withdrawable) driven by the
 *     drilldown tiles on the wallet overview card
 *
 * No mutation hooks, no buttons. Pure observability.
 */
type WalletRow = {
  user_id: string;
  full_name: string;
  phone: string;
  balance: number;
  withdrawable: number;
  float: number;
  advance: number;
  locked: number;
};

async function hydrateWalletRows(userIds: string[]): Promise<WalletRow[]> {
  if (userIds.length === 0) return [];

  // Use the ops-scoped RPC so Fin Ops / manager roles can read names & phones
  // even when direct SELECT on public.profiles is blocked by RLS.
  const { data: profiles } = await supabase.rpc('ops_get_profiles_lite', {
    p_ids: userIds,
  });
  const pmap = new Map(
    ((profiles ?? []) as Array<{ id: string; full_name: string | null; phone: string | null }>).map(
      (p) => [p.id, p],
    ),
  );

  // Batched: a plain `.in('user_id', userIds)` with up to 1000 UUIDs is a GET
  // request whose query string can exceed URL length limits and fail silently
  // (the failure was showing up as "0 wallets shown", not an error).
  const rows = await batchedQuery<{
    user_id: string;
    balance: number;
    withdrawable_balance: number;
    float_balance: number;
    advance_balance: number;
    locked_balance: number;
  }>(
    userIds,
    (batch) =>
      supabase
        .from('wallets')
        .select('user_id, balance, withdrawable_balance, float_balance, advance_balance, locked_balance')
        .in('user_id', batch),
  );
  const wmap = new Map(rows.map((r) => [r.user_id, r]));

  return userIds.map((id) => {
    const p = pmap.get(id);
    const w = wmap.get(id);
    return {
      user_id: id,
      full_name: p?.full_name ?? 'Unknown',
      phone: p?.phone ?? '',
      balance: Number(w?.balance ?? 0),
      withdrawable: Number(w?.withdrawable_balance ?? 0),
      float: Number(w?.float_balance ?? 0),
      advance: Number(w?.advance_balance ?? 0),
      locked: Number(w?.locked_balance ?? 0),
    };
  });
}

export function WalletBreakdownReadOnly({
  focusBucket = null,
  onClearFocus,
}: {
  focusBucket?: FocusBucket;
  onClearFocus?: () => void;
} = {}) {
  const [search, setSearch] = useState('');
  const [minBal, setMinBal] = useState<string>('');
  const [maxBal, setMaxBal] = useState<string>('');
  const [expanded, setExpanded] = useState<string | null>(null);
  const [localBucket, setLocalBucket] = useState<FocusBucket>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const effectiveBucket = localBucket ?? focusBucket;

  // When a bucket drilldown is requested, scroll the table into view so the
  // operator immediately lands on the focused breakdown.
  useEffect(() => {
    if (focusBucket && rootRef.current) {
      rootRef.current.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  }, [focusBucket]);

  const trimmedSearch = search.trim();

  // Default browse view: top 1000 wallets by balance. Fine for "who holds the
  // most" but a zero-balance (or just low-balance) account can sit outside
  // this window entirely, so it must never be relied on for search.
  const { data: browseData, isLoading: browseLoading, error: browseError } = useQuery({
    queryKey: ['manager-wallet-breakdown'],
    enabled: trimmedSearch.length === 0,
    queryFn: async () => {
      const { data: rows, error } = await supabase
        .from('wallets')
        .select('user_id')
        .order('balance', { ascending: false })
        .limit(1000);
      if (error) throw error;
      return hydrateWalletRows((rows ?? []).map((r) => r.user_id).filter((id): id is string => !!id));
    },
    staleTime: 60_000,
  });

  // Search view: resolves against every user by name/phone (search_users_fast),
  // not just the top-1000-by-balance browse window, so an account with UGX 0
  // right now -- but real transaction history -- is still found.
  const { data: searchData, isLoading: searchLoading, error: searchError } = useQuery({
    queryKey: ['manager-wallet-breakdown-search', trimmedSearch],
    enabled: trimmedSearch.length > 0,
    queryFn: async () => {
      const { data: profiles, error } = await supabase.rpc('search_users_fast', {
        p_query: trimmedSearch,
        p_limit: 200,
      } as any);
      if (error) throw error;
      const ids = ((profiles ?? []) as Array<{ id: string }>).map((p) => p.id).filter(Boolean);
      return hydrateWalletRows(ids);
    },
    staleTime: 30_000,
  });

  const data = trimmedSearch.length > 0 ? searchData : browseData;
  const isLoading = trimmedSearch.length > 0 ? searchLoading : browseLoading;
  const loadError = trimmedSearch.length > 0 ? searchError : browseError;

  const filtered = useMemo(() => {
    if (!data) return [];
    const min = minBal ? Number(minBal) : null;
    const max = maxBal ? Number(maxBal) : null;
    const rows = data.filter((row) => {
      if (min !== null && row.balance < min) return false;
      if (max !== null && row.balance > max) return false;
      // Bucket focus: only show wallets actually holding that bucket.
      if (effectiveBucket === 'float' && row.float <= 0) return false;
      if (effectiveBucket === 'withdrawable' && row.withdrawable <= 0) return false;
      return true;
    });
    // When focused on a bucket, sort by that bucket descending so the
    // biggest holders surface first.
    if (effectiveBucket === 'float') {
      rows.sort((a, b) => b.float - a.float);
    } else if (effectiveBucket === 'withdrawable') {
      rows.sort((a, b) => b.withdrawable - a.withdrawable);
    }
    return rows;
  }, [data, minBal, maxBal, effectiveBucket]);

  const totalShown = filtered.reduce((s, r) => s + r.balance, 0);
  const focusTotal = filtered.reduce(
    (s, r) => s + (effectiveBucket === 'float' ? r.float : effectiveBucket === 'withdrawable' ? r.withdrawable : 0),
    0,
  );
  const focusLabel = effectiveBucket === 'float' ? 'Operations Float' : effectiveBucket === 'withdrawable' ? 'Withdrawable' : '';

  const [busyId, setBusyId] = useState<string | null>(null);
  const [busyAction, setBusyAction] = useState<'download' | 'share' | null>(null);

  const fetchAndBuildPdf = async (row: WalletRow): Promise<{ blob: Blob; filename: string }> => {
    const { data: ledgerRows, error: ledgerError } = await supabase
      .from('general_ledger')
      .select('id, transaction_date, direction, category, description, amount, wallet_bucket')
      .eq('user_id', row.user_id)
      .eq('ledger_scope', 'wallet')
      .order('transaction_date', { ascending: false })
      .limit(500);

    if (ledgerError) throw ledgerError;

    const mappedRows: UserWalletStatementRow[] = (ledgerRows ?? []).map((r) => ({
      date: r.transaction_date,
      bucket: (r.wallet_bucket === 'float' ? 'float' : 'withdrawable') as 'withdrawable' | 'float',
      label: labelForCategory(r.category),
      description: r.description || null,
      direction: (r.direction === 'cash_in' ? 'cash_in' : 'cash_out') as 'cash_in' | 'cash_out',
      amount: Number(r.amount || 0),
    }));

    const blob = await generateUserWalletStatementPdf({
      userName: row.full_name || 'Customer',
      userPhone: row.phone || null,
      withdrawableBalance: row.withdrawable,
      floatBalance: row.float,
      rows: mappedRows,
    });

    const safeName = (row.full_name || 'user').replace(/[^a-zA-Z0-9_-]/g, '_');
    const dateStr = new Date().toISOString().slice(0, 10);
    const filename = `wallet_statement_${safeName}_${dateStr}.pdf`;

    return { blob, filename };
  };

  const handleDownloadStatement = async (row: WalletRow, e?: React.MouseEvent) => {
    if (e) e.stopPropagation();
    try {
      setBusyId(row.user_id);
      setBusyAction('download');
      const { blob, filename } = await fetchAndBuildPdf(row);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1500);
      toast.success(`Statement downloaded for ${row.full_name}`);
    } catch (err: any) {
      console.error('Failed to generate wallet statement:', err);
      toast.error('Could not generate the statement PDF');
    } finally {
      setBusyId(null);
      setBusyAction(null);
    }
  };

  const handleShareStatement = async (row: WalletRow, e?: React.MouseEvent) => {
    if (e) e.stopPropagation();
    try {
      setBusyId(row.user_id);
      setBusyAction('share');
      const { blob, filename } = await fetchAndBuildPdf(row);
      const caption = `Welile wallet statement — ${row.full_name}: Withdrawable ${formatUGX(row.withdrawable)}, Float ${formatUGX(row.float)}.`;

      let cleanPhone = row.phone ? row.phone.replace(/\D/g, '') : undefined;
      if (cleanPhone && cleanPhone.startsWith('0') && cleanPhone.length === 10) {
        cleanPhone = `256${cleanPhone.slice(1)}`;
      }

      const result = await sharePdfViaWhatsApp(blob, {
        filename,
        caption,
        phone: cleanPhone,
      });
      if (result === 'deeplink') {
        toast.success('Statement downloaded — attach it in WhatsApp');
      } else if (result === 'shared') {
        toast.success('Statement shared via WhatsApp');
      }
    } catch (err: any) {
      console.error('Failed to share wallet statement:', err);
      toast.error('Could not share the statement');
    } finally {
      setBusyId(null);
      setBusyAction(null);
    }
  };

  return (
    <div ref={rootRef} className="space-y-5 scroll-mt-4">
      <div>
        <h2 className="text-xl sm:text-2xl font-bold flex items-center gap-2.5">
          <Wallet className="h-6 w-6 text-primary" />
          Wallet Breakdown
          <span className="inline-flex items-center gap-1 rounded-full border border-muted bg-muted/40 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
            <Lock className="h-3 w-3" /> Read-only
          </span>
        </h2>
        <p className="text-sm text-muted-foreground mt-1">
          Search every wallet by name, phone, or balance range. View only — no actions.
        </p>
      </div>

      {/* Active bucket focus banner */}
      {effectiveBucket && (
        <div className="flex items-center justify-between gap-3 rounded-xl border border-primary/40 bg-primary/10 px-4 py-3">
          <div className="flex items-center gap-2 min-w-0">
            {effectiveBucket === 'float' ? (
              <ArrowRightLeft className="h-4 w-4 text-primary shrink-0" />
            ) : (
              <Banknote className="h-4 w-4 text-primary shrink-0" />
            )}
            <div className="min-w-0">
              <p className="text-sm font-semibold text-foreground truncate">
                Drilldown: {focusLabel}
              </p>
              <p className="text-[11px] text-muted-foreground">
                {filtered.length.toLocaleString()} wallets • {formatUGX(focusTotal)} total
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={() => {
              setLocalBucket(null);
              onClearFocus?.();
            }}
            className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary shrink-0"
          >
            <X className="h-3.5 w-3.5" /> Clear
          </button>
        </div>
      )}

      {/* Filters */}
      <div className="grid gap-3 sm:grid-cols-3 rounded-xl border border-border bg-card p-4">
        <div className="sm:col-span-3">
          <Label htmlFor="wb-search" className="text-xs">Search by name or phone</Label>
          <div className="relative mt-1">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input
              id="wb-search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Type a name or phone…"
              className="pl-9"
            />
          </div>
        </div>
        <div>
          <Label htmlFor="wb-min" className="text-xs">Min balance (UGX)</Label>
          <Input
            id="wb-min"
            type="number"
            inputMode="numeric"
            value={minBal}
            onChange={(e) => setMinBal(e.target.value)}
            placeholder="0"
            className="mt-1"
          />
        </div>
        <div>
          <Label htmlFor="wb-max" className="text-xs">Max balance (UGX)</Label>
          <Input
            id="wb-max"
            type="number"
            inputMode="numeric"
            value={maxBal}
            onChange={(e) => setMaxBal(e.target.value)}
            placeholder="No limit"
            className="mt-1"
          />
        </div>
        <div className="sm:col-span-3 flex flex-wrap items-center justify-between gap-3 pt-1 border-t border-border/60">
          {/* Branded segmented control */}
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-xs font-medium text-muted-foreground">Filter by bucket:</span>
            <div className="inline-flex items-center p-1 rounded-xl bg-muted/70 border border-border/80 shadow-inner gap-1">
              {([
                { key: null, label: 'All Wallets', icon: Layers },
                { key: 'withdrawable' as const, label: 'Withdrawable', icon: Banknote, activeTone: 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-400 border-emerald-500/30' },
                { key: 'float' as const, label: 'Operational Float', icon: ArrowRightLeft, activeTone: 'bg-blue-500/15 text-blue-700 dark:text-blue-400 border-blue-500/30' },
              ]).map((opt) => {
                const Icon = opt.icon;
                const isActive = effectiveBucket === opt.key;
                return (
                  <button
                    key={opt.label}
                    type="button"
                    onClick={() => setLocalBucket(opt.key)}
                    className={`relative inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary ${
                      isActive
                        ? `${(opt as any).activeTone ?? 'bg-card text-foreground border-border/80 shadow-sm'} font-semibold border`
                        : 'text-muted-foreground hover:text-foreground hover:bg-card/50'
                    }`}
                  >
                    <Icon className="h-3.5 w-3.5" />
                    {opt.label}
                  </button>
                );
              })}
            </div>
          </div>
          {(search || minBal || maxBal || localBucket !== null) && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => { setSearch(''); setMinBal(''); setMaxBal(''); setLocalBucket(null); onClearFocus?.(); }}
              className="h-8 px-2.5 text-xs text-muted-foreground hover:text-foreground gap-1.5"
            >
              <X className="h-3.5 w-3.5" />
              Clear filters
            </Button>
          )}
        </div>
      </div>

      {/* Summary line */}
      <div className="flex items-center justify-between text-xs text-muted-foreground px-1">
        <span>{filtered.length.toLocaleString()} wallets shown {data && data.length >= 1000 ? '(top 1,000 by balance)' : ''}</span>
        <span className="font-mono tabular-nums font-semibold text-foreground">
          Total shown: {formatUGX(totalShown)}
        </span>
      </div>

      {/* Table */}
      <div className="rounded-xl border border-border bg-card overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-muted/50 text-muted-foreground">
              <tr className="text-left">
                <th className="px-3 py-2 font-semibold w-8"></th>
                <th className="px-3 py-2 font-semibold">Owner</th>
                <th className="px-3 py-2 font-semibold text-right">Total</th>
                <th className={`px-3 py-2 font-semibold text-right ${effectiveBucket === 'withdrawable' ? 'text-primary font-bold' : ''}`}>Withdrawable</th>
                <th className={`px-3 py-2 font-semibold text-right ${effectiveBucket === 'float' ? 'text-primary font-bold' : ''}`}>Float</th>
                <th className="px-3 py-2 font-semibold text-right">Advance</th>
                <th className="px-3 py-2 font-semibold text-right">Locked</th>
                <th className="px-3 py-2 font-semibold text-right w-24">Statement</th>
              </tr>
            </thead>
            <tbody>
              {isLoading ? (
                <tr>
                  <td colSpan={8} className="px-3 py-8 text-center text-muted-foreground">
                    <Loader2 className="h-4 w-4 animate-spin inline mr-2" />
                    Loading wallets…
                  </td>
                </tr>
              ) : loadError ? (
                <tr>
                  <td colSpan={8} className="px-3 py-8 text-center text-destructive">
                    Could not load wallets — {(loadError as Error).message || 'unknown error'}.
                  </td>
                </tr>
              ) : filtered.length === 0 ? (
                <tr>
                  <td colSpan={8} className="px-3 py-8 text-center text-muted-foreground">
                    No wallets match your filters.
                  </td>
                </tr>
              ) : (
                filtered.map((row) => {
                  const isOpen = expanded === row.user_id;
                  return (
                    <Fragment key={row.user_id}>
                      <tr
                        onClick={() => setExpanded(isOpen ? null : row.user_id)}
                        className="border-t border-border/60 hover:bg-muted/30 cursor-pointer"
                      >
                        <td className="px-3 py-2 text-muted-foreground">
                          {isOpen ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
                        </td>
                        <td className="px-3 py-2">
                          <div className="font-medium text-foreground">{row.full_name}</div>
                          <div className="text-[11px] text-muted-foreground">{row.phone || '—'}</div>
                        </td>
                        <td className="px-3 py-2 text-right font-mono tabular-nums font-semibold">{formatUGX(row.balance)}</td>
                        <td className={`px-3 py-2 text-right font-mono tabular-nums ${effectiveBucket === 'withdrawable' ? 'text-primary font-semibold' : ''}`}>{formatUGX(row.withdrawable)}</td>
                        <td className={`px-3 py-2 text-right font-mono tabular-nums ${effectiveBucket === 'float' ? 'text-primary font-semibold' : ''}`}>{formatUGX(row.float)}</td>
                        <td className="px-3 py-2 text-right font-mono tabular-nums text-warning">{row.advance > 0 ? formatUGX(row.advance) : '—'}</td>
                        <td className="px-3 py-2 text-right font-mono tabular-nums text-muted-foreground">{row.locked > 0 ? formatUGX(row.locked) : '—'}</td>
                        <td className="px-3 py-2 text-right" onClick={(e) => e.stopPropagation()}>
                          <div className="flex items-center justify-end gap-1">
                            <Button
                              type="button"
                              variant="ghost"
                              size="icon"
                              className="h-7 w-7 text-muted-foreground hover:text-primary hover:bg-primary/10"
                              title="Print / download wallet statement"
                              disabled={busyId === row.user_id}
                              onClick={(e) => handleDownloadStatement(row, e)}
                            >
                              {busyId === row.user_id && busyAction === 'download' ? (
                                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                              ) : (
                                <FileDown className="h-3.5 w-3.5" />
                              )}
                              <span className="sr-only">Print statement</span>
                            </Button>
                            <Button
                              type="button"
                              variant="ghost"
                              size="icon"
                              className="h-7 w-7 text-muted-foreground hover:text-emerald-600 hover:bg-emerald-500/10"
                              title="Share wallet statement via WhatsApp"
                              disabled={busyId === row.user_id}
                              onClick={(e) => handleShareStatement(row, e)}
                            >
                              {busyId === row.user_id && busyAction === 'share' ? (
                                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                              ) : (
                                <Share2 className="h-3.5 w-3.5" />
                              )}
                              <span className="sr-only">Share via WhatsApp</span>
                            </Button>
                          </div>
                        </td>
                      </tr>
                      {isOpen && (
                        <tr className="border-t border-border/60">
                          <td colSpan={8} className="p-0">
                            {/* Expanded statement action banner */}
                            <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 bg-card border-b border-border">
                              <div className="flex items-center gap-2.5">
                                <div className="h-8 w-8 rounded-lg bg-primary/10 flex items-center justify-center text-primary font-bold text-xs shrink-0">
                                  {(row.full_name || 'U').charAt(0).toUpperCase()}
                                </div>
                                <div>
                                  <div className="text-xs font-semibold text-foreground flex items-center gap-2">
                                    {row.full_name}
                                    {row.phone && <span className="text-[11px] font-normal text-muted-foreground">({row.phone})</span>}
                                  </div>
                                  <div className="text-[11px] text-muted-foreground">
                                    Withdrawable: <span className="font-mono font-medium text-foreground">{formatUGX(row.withdrawable)}</span>
                                    {' · '}Float: <span className="font-mono font-medium text-foreground">{formatUGX(row.float)}</span>
                                    {row.advance > 0 && <> · Advance: <span className="font-mono font-medium text-warning">{formatUGX(row.advance)}</span></>}
                                  </div>
                                </div>
                              </div>
                              <div className="flex items-center gap-2">
                                <Button
                                  type="button"
                                  size="sm"
                                  variant="outline"
                                  onClick={(e) => handleDownloadStatement(row, e)}
                                  disabled={busyId === row.user_id}
                                  className="h-8 gap-1.5 text-xs font-semibold hover:border-primary/50"
                                >
                                  {busyId === row.user_id && busyAction === 'download' ? (
                                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                                  ) : (
                                    <FileDown className="h-3.5 w-3.5 text-primary" />
                                  )}
                                  Print statement
                                </Button>
                                <Button
                                  type="button"
                                  size="sm"
                                  variant="outline"
                                  onClick={(e) => handleShareStatement(row, e)}
                                  disabled={busyId === row.user_id}
                                  className="h-8 gap-1.5 text-xs font-semibold border-emerald-500/30 text-emerald-700 dark:text-emerald-400 hover:bg-emerald-500/10"
                                >
                                  {busyId === row.user_id && busyAction === 'share' ? (
                                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                                  ) : (
                                    <Share2 className="h-3.5 w-3.5" />
                                  )}
                                  Share via WhatsApp
                                </Button>
                              </div>
                            </div>
                            <WalletBucketLedgerDetail
                              userId={row.user_id}
                              withdrawable={row.withdrawable}
                              float={row.float}
                              advance={row.advance}
                            />
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
