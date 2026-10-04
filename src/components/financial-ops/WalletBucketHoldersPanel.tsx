import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { ArrowDownUp, ArrowDownLeft, ArrowLeft, ArrowLeftRight, ArrowUpRight, ChevronDown, ChevronRight, Loader2, Search, ExternalLink, History } from 'lucide-react';

import { formatUGX } from '@/lib/rentCalculations';
import { batchedQuery } from '@/lib/supabaseBatchUtils';
import { WalletBucketLedgerDetail } from './WalletBucketLedgerDetail';
import { LandlordFloatAllocationsDetail } from './LandlordFloatAllocationsDetail';
import { CompanyFloatDisbursementHistoryDialog } from './CompanyFloatDisbursementHistoryDialog';


export type HolderBucket = 'withdrawable' | 'float' | 'landlord_float' | 'merchant_float';

type SortKey =
  | 'recent'
  | 'balance_desc'
  | 'balance_asc'
  | 'deposit_total_desc'
  | 'deposit_total_asc'
  | 'deposit_count_desc'
  | 'transfer_count_desc'
  | 'transfer_count_asc'
  | 'withdrawal_count_desc'
  | 'activity_desc'
  | 'activity_asc';

const SORT_OPTIONS: Array<{ value: SortKey; label: string }> = [
  { value: 'recent', label: 'Most recent activity first (default)' },
  { value: 'balance_desc', label: 'Balance: highest to lowest' },
  { value: 'balance_asc', label: 'Balance: lowest to highest' },
  { value: 'deposit_total_desc', label: 'Deposited: most to least' },
  { value: 'deposit_total_asc', label: 'Deposited: least to most' },
  { value: 'deposit_count_desc', label: 'Deposit count: most to least' },
  { value: 'transfer_count_desc', label: 'Transfers: highest to lowest' },
  { value: 'transfer_count_asc', label: 'Transfers: lowest to highest' },
  { value: 'withdrawal_count_desc', label: 'Withdrawals: most to least' },
  { value: 'activity_desc', label: 'Most active to least active' },
  { value: 'activity_asc', label: 'Least active to most active' },
];


interface HolderRow {
  key: string;
  userId: string | null;
  name: string;
  phone: string;
  amount: number;
  meta?: string;
  retired?: boolean;
}

const TITLES: Record<HolderBucket, { title: string; desc: string; amountLabel: string }> = {
  withdrawable: {
    title: 'Withdrawable Wallet — Holders',
    desc: 'Every user currently holding a withdrawable balance. Tap a row to see the ledger entries behind it.',
    amountLabel: 'Withdrawable',
  },
  float: {
    title: 'Operational Float — Holders',
    desc: 'Every user currently holding company operational float. Tap a row to see the ledger entries behind it.',
    amountLabel: 'Float',
  },
  landlord_float: {
    title: 'Landlord Float — Holders',
    desc: 'Agents who will pay a landlord today, for rent funded today. Tap a row to see the ledger entries behind it.',
    amountLabel: 'Due today',
  },
  merchant_float: {
    title: 'Merchant Float — Holders',
    desc: 'Cash-out merchant agents holding ledger-backed operational float. Tap a row to see the ledger entries behind it.',
    amountLabel: 'Float held',
  },
};

async function fetchProfiles(ids: string[]) {
  if (ids.length === 0) return new Map<string, { full_name: string | null; phone: string | null }>();
  const { data } = await supabase.rpc('ops_get_profiles_lite', { p_ids: ids });
  return new Map(
    ((data ?? []) as Array<{ id: string; full_name: string | null; phone: string | null }>).map((p) => [
      p.id,
      { full_name: p.full_name, phone: p.phone },
    ]),
  );
}

/**
 * Every browse query below defaults to "currently holds a positive balance",
 * which silently drops anyone who has spent down to zero -- so a search box
 * layered on top of that browse list can never find them either, no matter
 * what's typed. When there's a real search query, resolve it against every
 * user (search_users_fast, unrestricted) and read that bucket's value
 * directly for the matches, zero included, so ops can still trace someone's
 * history after their balance is gone.
 */
async function resolveSearchIds(query: string): Promise<string[]> {
  const { data, error } = await supabase.rpc('search_users_fast', {
    p_query: query,
    p_limit: 200,
  } as any);
  if (error) throw error;
  return ((data ?? []) as Array<{ id: string }>).map((p) => p.id).filter(Boolean);
}

interface LandlordFloatDueTodayHolder {
  agent_id: string;
  amount: number;
  landlord_names: string[] | null;
  rent_request_count: number;
}

interface LandlordFloatDueToday {
  holders: LandlordFloatDueTodayHolder[];
  company_amount: number;
  company_count: number;
  funder_amount: number;
  funder_count: number;
}

/**
 * Rent funded today, still owed to a landlord -- the same "today" definition
 * as the parent Wallet Buckets tile (docs/HANDOVER/71), just grouped by the
 * agent who will pay it instead of summed platform-wide. Deliberately NOT
 * the agent's running agent_landlord_float.balance, which is mostly older
 * backlog and confused Josh when it showed ~80M next to a tile that said ~4M.
 */
async function fetchLandlordFloatDueToday(): Promise<LandlordFloatDueToday> {
  const { data, error } = await supabase.rpc('get_landlord_float_due_today' as any);
  if (error) throw error;
  const d = (data ?? {}) as any;
  return {
    holders: (d.holders ?? []) as LandlordFloatDueTodayHolder[],
    company_amount: Number(d.company_amount ?? 0),
    company_count: Number(d.company_count ?? 0),
    funder_amount: Number(d.funder_amount ?? 0),
    funder_count: Number(d.funder_count ?? 0),
  };
}

async function fetchLandlordFloatDueTodayHolders(): Promise<LandlordFloatDueTodayHolder[]> {
  return (await fetchLandlordFloatDueToday()).holders;
}

async function loadHolders(bucket: HolderBucket, searchQuery: string): Promise<HolderRow[]> {
  const q = searchQuery.trim();

  if (bucket === 'withdrawable') {
    if (q) {
      const ids = await resolveSearchIds(q);
      if (ids.length === 0) return [];
      const [rows, pmap] = await Promise.all([
        batchedQuery<{ user_id: string; withdrawable_balance: number }>(ids, (batch) =>
          supabase.from('wallets').select('user_id, withdrawable_balance').in('user_id', batch),
        ),
        fetchProfiles(ids),
      ]);
      const wmap = new Map(rows.map((r) => [r.user_id, r]));
      return ids.map((id) => {
        const p = pmap.get(id);
        return {
          key: id,
          userId: id,
          name: p?.full_name ?? 'Unknown',
          phone: p?.phone ?? '',
          amount: Number(wmap.get(id)?.withdrawable_balance ?? 0),
        };
      });
    }
    const { data: rows, error } = await supabase.rpc('get_withdrawable_wallet_holders_by_recent_withdrawal' as any);
    if (error) throw error;
    return ((rows ?? []) as any[]).map((r) => ({
      key: r.user_id ?? Math.random().toString(36),
      userId: r.user_id ?? null,
      name: r.name ?? 'Unknown',
      phone: r.phone ?? '',
      amount: Number(r.withdrawable_balance ?? 0),
    }));
  }

  if (bucket === 'float') {
    // Active merchant desk agents hold their float in this same wallets.float_balance
    // column, so without this exclusion they show up here AND in the merchant_float
    // bucket below -- double-counting the same money. A retired desk's float is
    // correctly left in (see the merchant_float branch's own comment on this split).
    const { data: agentRows, error: agentError } = await supabase
      .from('cashout_agents')
      .select('agent_id')
      .eq('is_active', true);
    if (agentError) throw agentError;
    const merchantAgentIds = new Set(
      (agentRows ?? []).map((a) => a.agent_id).filter((v): v is string => !!v),
    );

    if (q) {
      const ids = (await resolveSearchIds(q)).filter((id) => !merchantAgentIds.has(id));
      if (ids.length === 0) return [];
      const [rows, pmap] = await Promise.all([
        batchedQuery<{ user_id: string; float_balance: number }>(ids, (batch) =>
          supabase.from('wallets').select('user_id, float_balance').in('user_id', batch),
        ),
        fetchProfiles(ids),
      ]);
      const wmap = new Map(rows.map((r) => [r.user_id, r]));
      return ids.map((id) => {
        const p = pmap.get(id);
        return {
          key: id,
          userId: id,
          name: p?.full_name ?? 'Unknown',
          phone: p?.phone ?? '',
          amount: Number(wmap.get(id)?.float_balance ?? 0),
        };
      });
    }

    const { data: rows, error } = await supabase
      .from('wallets')
      .select('user_id, withdrawable_balance, float_balance')
      .gt('float_balance', 0)
      .order('float_balance', { ascending: false })
      .limit(500);
    if (error) throw error;
    const filtered = (rows ?? []).filter((r) => !r.user_id || !merchantAgentIds.has(r.user_id));
    const ids = filtered.map((r) => r.user_id).filter((v): v is string => !!v);
    const pmap = await fetchProfiles(ids);
    return filtered.map((r) => {
      const p = r.user_id ? pmap.get(r.user_id) : undefined;
      return {
        key: r.user_id ?? Math.random().toString(36),
        userId: r.user_id ?? null,
        name: p?.full_name ?? 'Unknown',
        phone: p?.phone ?? '',
        amount: Number(r.float_balance ?? 0),
      };
    });
  }

  if (bucket === 'landlord_float') {
    const holders = await fetchLandlordFloatDueTodayHolders();
    const ids = holders.map((h) => h.agent_id).filter((v): v is string => !!v);
    const pmap = await fetchProfiles(ids);
    const rows: HolderRow[] = holders.map((h) => {
      const p = h.agent_id ? pmap.get(h.agent_id) : undefined;
      const names = (h.landlord_names ?? []).filter(Boolean);
      return {
        key: h.agent_id,
        userId: h.agent_id,
        name: p?.full_name ?? 'Unknown agent',
        phone: p?.phone ?? '',
        amount: Number(h.amount ?? 0),
        meta: [
          `${h.rent_request_count} rent request${h.rent_request_count === 1 ? '' : 's'} funded today`,
          names.length ? `Landlord${names.length === 1 ? '' : 's'}: ${names.join(', ')}` : null,
        ]
          .filter(Boolean)
          .join(' • '),
      };
    });
    if (!q) return rows;
    const ql = q.toLowerCase();
    return rows.filter((r) => `${r.name} ${r.phone}`.toLowerCase().includes(ql));
  }

  const { data, error } = await supabase.rpc('get_merchant_float_positions' as any);
  if (error) throw error;
  const positions = ((data ?? []) as any[]).map((r) => ({
    key: String(r.desk_id),
    userId: r.agent_id ?? null,
    name: r.agent_name ?? r.label ?? 'Merchant desk',
    phone: r.agent_phone ?? '',
    amount: Number(r.ledger_float_held ?? 0),
    retired: r.is_active === false,
    meta: [
      r.is_active === false ? 'Retired desk — float is plain operational float' : null,
      `Evidenced ${formatUGX(Number(r.evidenced_amount ?? 0))}`,
      `Paid out ${formatUGX(Number(r.paid_out_total ?? 0))}`,
    ]
      .filter(Boolean)
      .join(' • '),
  }));
  const ql = q.toLowerCase();
  return positions
    // A desk that is no longer active is NOT a merchant float holder. Its wallet
    // float is ordinary operational float and belongs only to the Operational
    // Float bucket — counting it here double-counts the same money. A desk
    // currently at zero float is still a holder while actively searching, so
    // ops can trace it; the browse view (no search) hides zero as before.
    .filter((r) => !r.retired && (q ? true : r.amount > 0))
    .filter((r) => !q || `${r.name} ${r.phone}`.toLowerCase().includes(ql))
    .sort((a, b) => b.amount - a.amount);
}

export function WalletBucketHoldersPanel({
  bucket,
  onBack,
  onOpenFullTool,
}: {
  bucket: HolderBucket;
  onBack: () => void;
  onOpenFullTool?: () => void;
}) {
  const [search, setSearch] = useState('');
  const [sortBy, setSortBy] = useState<SortKey>('recent');
  const [expanded, setExpanded] = useState<string | null>(null);
  const [companyHistoryOpen, setCompanyHistoryOpen] = useState(false);
  const meta = TITLES[bucket];

  const trimmedSearch = search.trim();
  const { data, isLoading, error } = useQuery({
    queryKey: ['wallet-bucket-holders', bucket, trimmedSearch],
    queryFn: () => loadHolders(bucket, trimmedSearch),
    staleTime: 30_000,
  });


  // Per-holder activity counters: how many withdrawals this person has taken and
  // how many wallet transfers they were part of.
  const holderIds = useMemo(
    () => Array.from(new Set((data ?? []).map((r) => r.userId).filter((v): v is string => !!v))),
    [data],
  );

  const { data: activity } = useQuery({
    queryKey: ['wallet-holder-activity-counts', holderIds],
    enabled: holderIds.length > 0,
    staleTime: 30_000,
    queryFn: async () => {
      const { data: rows, error } = await supabase.rpc(
        'get_wallet_holder_activity_counts' as any,
        { p_user_ids: holderIds } as any,
      );
      if (error) throw error;
      const map = new Map<
        string,
        {
          withdrawals: number;
          withdrawalTotal: number;
          transfers: number;
          transferTotal: number;
          deposits: number;
          depositTotal: number;
          lastActivityAt: number;
        }
      >();
      for (const r of (rows ?? []) as any[]) {
        const times = [r.last_withdrawal_at, r.last_transfer_at, r.last_deposit_at]
          .map((t) => (t ? new Date(t as string).getTime() : 0))
          .filter((n) => Number.isFinite(n));
        map.set(String(r.user_id), {
          withdrawals: Number(r.withdrawal_count ?? 0),
          withdrawalTotal: Number(r.withdrawal_total ?? 0),
          transfers: Number(r.transfer_count ?? 0),
          transferTotal: Number(r.transfer_total ?? 0),
          deposits: Number(r.deposit_count ?? 0),
          depositTotal: Number(r.deposit_total ?? 0),
          lastActivityAt: times.length ? Math.max(...times) : 0,
        });
      }
      return map;
    },
  });

  // Sort only -- the search text is already applied server-side by the query
  // above (loadHolders resolves it via search_users_fast), so re-filtering the
  // result here by substring would only risk dropping legitimate fuzzy matches.
  // `recent` keeps the order the loader returned (for the withdrawable bucket
  // that is "most recent withdrawal first").
  const rows = useMemo(() => {
    const list = data ?? [];
    if (sortBy === 'recent') return list;
    const stat = (r: HolderRow) => (r.userId ? activity?.get(r.userId) : undefined);
    return [...list].sort((a, b) => {
      const sa = stat(a);
      const sb = stat(b);
      switch (sortBy) {
        case 'balance_desc':
          return b.amount - a.amount;
        case 'balance_asc':
          return a.amount - b.amount;
        case 'deposit_total_desc':
          return (sb?.depositTotal ?? 0) - (sa?.depositTotal ?? 0);
        case 'deposit_total_asc':
          return (sa?.depositTotal ?? 0) - (sb?.depositTotal ?? 0);
        case 'deposit_count_desc':
          return (sb?.deposits ?? 0) - (sa?.deposits ?? 0);
        case 'transfer_count_desc':
          return (sb?.transfers ?? 0) - (sa?.transfers ?? 0);
        case 'transfer_count_asc':
          return (sa?.transfers ?? 0) - (sb?.transfers ?? 0);
        case 'withdrawal_count_desc':
          return (sb?.withdrawals ?? 0) - (sa?.withdrawals ?? 0);
        case 'activity_desc':
        case 'activity_asc': {
          const av = (sa?.withdrawals ?? 0) + (sa?.transfers ?? 0) + (sa?.deposits ?? 0);
          const bv = (sb?.withdrawals ?? 0) + (sb?.transfers ?? 0) + (sb?.deposits ?? 0);
          return sortBy === 'activity_desc' ? bv - av : av - bv;
        }
        default:
          return 0;
      }
    });
  }, [data, sortBy, activity]);

  const total = rows.reduce((s, r) => s + r.amount, 0);


  // Landlord float only: split TODAY's outstanding earmarks by who put the
  // money there — company float (CFO disbursements) vs funders supporting a
  // landlord directly from their own wallet (`partner_self_funding`). Same
  // due-today scope as the holder rows above, from the same RPC, so this
  // split and the list below can never disagree.
  const { data: sourceSplit } = useQuery({
    queryKey: ['landlord-float-due-today-source-split'],
    enabled: bucket === 'landlord_float',
    staleTime: 30_000,
    queryFn: async () => {
      const d = await fetchLandlordFloatDueToday();
      return {
        company: d.company_amount,
        companyCount: d.company_count,
        funder: d.funder_amount,
        funderCount: d.funder_count,
      };
    },
  });

  // Landlord float only: money that funders have promised to deposit but has not
  // yet arrived in any wallet bucket. These are future landlord float commitments.
  const { data: receivablesTotal } = useQuery({
    queryKey: ['landlord-float-receivables-total'],
    enabled: bucket === 'landlord_float',
    staleTime: 30_000,
    queryFn: async () => {
      const { data, error } = await supabase
        .from('landlord_float_receivables' as any)
        .select('amount, status')
        .not('status', 'in', '("settled","cancelled")')
        .limit(5000);
      if (error) throw error;
      let total = 0;
      let count = 0;
      for (const r of (data ?? []) as any[]) {
        total += Number(r.amount) || 0;
        count += 1;
      }
      return { total, count };
    },
  });

  return (
    <div className="space-y-4">
      <CompanyFloatDisbursementHistoryDialog
        open={companyHistoryOpen}
        onOpenChange={setCompanyHistoryOpen}
      />
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <Button variant="ghost" size="sm" onClick={onBack} className="-ml-2 mb-1 gap-1.5">
            <ArrowLeft className="h-4 w-4" /> Wallet Buckets
          </Button>
          <h2 className="text-lg sm:text-xl font-bold tracking-tight">{meta.title}</h2>
          <p className="text-sm text-muted-foreground mt-0.5 max-w-2xl">{meta.desc}</p>
        </div>
        {onOpenFullTool && (
          <Button variant="outline" size="sm" onClick={onOpenFullTool} className="gap-1.5">
            <ExternalLink className="h-4 w-4" /> Open full tool
          </Button>
        )}
      </div>

      {bucket === 'landlord_float' && (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Card className="border-purple-500/20 bg-purple-500/5">
            <CardContent className="p-3 sm:p-4">
              <p className="text-[10px] uppercase tracking-wider text-muted-foreground">
                Funded by company float
              </p>
              <p className="font-mono tabular-nums text-lg font-bold text-purple-600 dark:text-purple-400">
                {sourceSplit ? formatUGX(sourceSplit.company) : 'UGX —'}
              </p>
              <p className="text-xs text-muted-foreground mt-0.5">
                {sourceSplit?.companyCount ?? 0} open earmark
                {(sourceSplit?.companyCount ?? 0) === 1 ? '' : 's'} from CFO disbursements
              </p>
              <button
                type="button"
                onClick={() => setCompanyHistoryOpen(true)}
                className="mt-2 inline-flex items-center gap-1 rounded-full border border-purple-500/30 bg-purple-500/10 px-2.5 py-1 text-[11px] font-medium text-purple-700 dark:text-purple-300 hover:bg-purple-500/20 transition-colors"
              >
                <History className="h-3 w-3" /> Disbursement history
              </button>
            </CardContent>
          </Card>

          <Card className="border-emerald-500/20 bg-emerald-500/5">
            <CardContent className="p-3 sm:p-4">
              <p className="text-[10px] uppercase tracking-wider text-muted-foreground">
                Funded by funders directly
              </p>
              <p className="font-mono tabular-nums text-lg font-bold text-emerald-600 dark:text-emerald-400">
                {sourceSplit ? formatUGX(sourceSplit.funder) : 'UGX —'}
              </p>
              <p className="text-xs text-muted-foreground mt-0.5">
                {sourceSplit?.funderCount ?? 0} open earmark
                {(sourceSplit?.funderCount ?? 0) === 1 ? '' : 's'} from funder wallets
              </p>
            </CardContent>
          </Card>
          <Card className="border-amber-500/20 bg-amber-500/5">
            <CardContent className="p-3 sm:p-4">
              <p className="text-[10px] uppercase tracking-wider text-muted-foreground">
                Float receivable
              </p>
              <p className="font-mono tabular-nums text-lg font-bold text-amber-600 dark:text-amber-400">
                {receivablesTotal ? formatUGX(receivablesTotal.total) : 'UGX —'}
              </p>
              <p className="text-xs text-muted-foreground mt-0.5">
                {receivablesTotal?.count ?? 0} pending pledge
                {(receivablesTotal?.count ?? 0) === 1 ? '' : 's'} from funders yet to deposit
              </p>
            </CardContent>
          </Card>
          <Card className="border-slate-500/20 bg-slate-500/5">
            <CardContent className="p-3 sm:p-4">
              <p className="text-[10px] uppercase tracking-wider text-muted-foreground">
                Unearmarked float
              </p>
              <p className="font-mono tabular-nums text-lg font-bold text-slate-600 dark:text-slate-400">
                {sourceSplit && data ? formatUGX(Math.max(0, (data?.reduce((s, r) => s + r.amount, 0) ?? 0) - sourceSplit.company - sourceSplit.funder)) : 'UGX —'}
              </p>
              <p className="text-xs text-muted-foreground mt-0.5">
                Held float not yet assigned to a landlord or tenant
              </p>
            </CardContent>
          </Card>
        </div>
      )}

      <Card>
        <CardContent className="p-3 sm:p-4 space-y-3">
          <div className="flex flex-wrap items-center gap-3">
            <div className="relative flex-1 min-w-[200px]">
              <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <Input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search by name or phone"
                className="pl-8"
              />
            </div>
            <div className="min-w-[220px]">
              <Select value={sortBy} onValueChange={(v) => setSortBy(v as SortKey)}>
                <SelectTrigger className="h-10">
                  <div className="flex items-center gap-2 min-w-0">
                    <ArrowDownUp className="h-4 w-4 text-muted-foreground shrink-0" />
                    <SelectValue placeholder="Sort holders" />
                  </div>
                </SelectTrigger>
                <SelectContent>
                  {SORT_OPTIONS.map((o) => (
                    <SelectItem key={o.value} value={o.value}>
                      {o.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="text-right">
              <p className="text-[10px] uppercase tracking-wider text-muted-foreground">
                {rows.length} {rows.length === 1 ? 'holder' : 'holders'} shown
              </p>
              <p className="font-mono tabular-nums text-sm font-bold text-primary">
                {formatUGX(total)}
              </p>
            </div>
          </div>

          {isLoading ? (
            <div className="py-8 text-center text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin inline mr-2" /> Loading holders…
            </div>
          ) : error ? (
            <div className="py-8 text-center text-sm text-destructive">Could not load holders.</div>
          ) : rows.length === 0 ? (
            <div className="py-8 text-center text-sm text-muted-foreground">
              No holders in this bucket.
            </div>
          ) : (
            <div className="divide-y divide-border rounded-lg border border-border overflow-hidden">
              {rows.map((r) => {
                const isOpen = expanded === r.key;
                const act = activity;
                return (
                  <div key={r.key}>
                    <button
                      type="button"
                      onClick={() => setExpanded(isOpen ? null : r.key)}
                      className="w-full flex items-center gap-3 px-3 py-2.5 text-left hover:bg-muted/40 transition-colors"
                    >
                      {isOpen ? (
                        <ChevronDown className="h-4 w-4 text-muted-foreground shrink-0" />
                      ) : (
                        <ChevronRight className="h-4 w-4 text-muted-foreground shrink-0" />
                      )}
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 min-w-0">
                          <p className="text-sm font-semibold text-foreground truncate">{r.name}</p>
                          {(() => {
                            const a = r.userId ? act?.get(r.userId) : undefined;
                            return (
                              <span className="flex items-center gap-1 shrink-0">
                                <span
                                  title={
                                    a
                                      ? `${a.withdrawals} withdrawals • ${formatUGX(a.withdrawalTotal)}`
                                      : 'Withdrawals'
                                  }
                                  className="inline-flex items-center gap-1 rounded-full border border-sky-500/30 bg-sky-500/10 px-2 py-0.5 text-[10px] font-semibold text-sky-700 dark:text-sky-300"
                                >
                                  <ArrowUpRight className="h-3 w-3" />
                                  {a?.withdrawals ?? 0}
                                </span>
                                <span
                                  title={
                                    a
                                      ? `${a.transfers} wallet transfers • ${formatUGX(a.transferTotal)}`
                                      : 'Wallet transfers'
                                  }
                                  className="inline-flex items-center gap-1 rounded-full border border-violet-500/30 bg-violet-500/10 px-2 py-0.5 text-[10px] font-semibold text-violet-700 dark:text-violet-300"
                                >
                                  <ArrowLeftRight className="h-3 w-3" />
                                  {a?.transfers ?? 0}
                                </span>
                                <span
                                  title={
                                    a
                                      ? `${a.deposits} deposits • ${formatUGX(a.depositTotal)}`
                                      : 'Deposits'
                                  }
                                  className="inline-flex items-center gap-1 rounded-full border border-emerald-500/30 bg-emerald-500/10 px-2 py-0.5 text-[10px] font-semibold text-emerald-700 dark:text-emerald-300"
                                >
                                  <ArrowDownLeft className="h-3 w-3" />
                                  {a?.deposits ?? 0}
                                </span>
                              </span>

                            );
                          })()}
                        </div>
                        <p className="text-xs text-muted-foreground truncate">
                          {r.phone || '—'}
                          {r.meta ? ` • ${r.meta}` : ''}
                        </p>
                      </div>

                      <div className="text-right shrink-0">
                        <p className="text-[10px] uppercase tracking-wider text-muted-foreground">
                          {meta.amountLabel}
                        </p>
                        <p className="font-mono tabular-nums text-sm font-bold">
                          {formatUGX(r.amount)}
                        </p>
                      </div>
                    </button>
                    {isOpen &&
                      (r.userId ? (
                        bucket === 'landlord_float' ? (
                          <LandlordFloatAllocationsDetail agentId={r.userId} />
                        ) : (
                          <WalletBucketLedgerDetail
                            userId={r.userId}
                            withdrawable={bucket === 'withdrawable' ? r.amount : 0}
                            float={bucket === 'withdrawable' ? 0 : r.amount}
                            advance={0}
                            onlyBucket={bucket === 'withdrawable' ? 'withdrawable' : 'float'}
                          />
                        )
                      ) : (
                        <div className="px-4 py-4 text-xs text-muted-foreground bg-muted/20">
                          This holder is not linked to a platform user account, so ledger entries
                          cannot be drilled into.
                        </div>
                      ))}

                  </div>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
