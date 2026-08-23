import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { ArrowLeft, ChevronDown, ChevronRight, Loader2, Search, ExternalLink, History } from 'lucide-react';
import { formatUGX } from '@/lib/rentCalculations';
import { WalletBucketLedgerDetail } from './WalletBucketLedgerDetail';
import { LandlordFloatAllocationsDetail } from './LandlordFloatAllocationsDetail';
import { CompanyFloatDisbursementHistoryDialog } from './CompanyFloatDisbursementHistoryDialog';


export type HolderBucket = 'withdrawable' | 'float' | 'landlord_float' | 'merchant_float';

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
    desc: 'Agents holding money reserved for landlord payouts. Tap a row to see the ledger entries behind it.',
    amountLabel: 'Landlord float',
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

async function loadHolders(bucket: HolderBucket): Promise<HolderRow[]> {
  if (bucket === 'withdrawable') {
    const { data: rows, error } = await supabase.rpc('get_withdrawable_wallet_holders_by_recent_withdrawal');
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
    const { data: rows, error } = await supabase
      .from('wallets')
      .select('user_id, withdrawable_balance, float_balance')
      .gt('float_balance', 0)
      .order('float_balance', { ascending: false })
      .limit(500);
    if (error) throw error;
    const ids = (rows ?? []).map((r) => r.user_id).filter((v): v is string => !!v);
    const pmap = await fetchProfiles(ids);
    return (rows ?? []).map((r) => {
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
    const { data: rows, error } = await supabase
      .from('agent_landlord_float')
      .select('id, agent_id, balance, region, total_funded, total_paid_out')
      .gt('balance', 0)
      .order('balance', { ascending: false })
      .limit(500);
    if (error) throw error;
    const ids = (rows ?? []).map((r) => r.agent_id).filter((v): v is string => !!v);
    const pmap = await fetchProfiles(ids);
    return (rows ?? []).map((r) => {
      const p = r.agent_id ? pmap.get(r.agent_id) : undefined;
      return {
        key: r.id,
        userId: r.agent_id ?? null,
        name: p?.full_name ?? 'Unknown agent',
        phone: p?.phone ?? '',
        amount: Number(r.balance ?? 0),
        meta: [
          r.region ? `Region ${r.region}` : null,
          `Funded ${formatUGX(Number(r.total_funded ?? 0))}`,
          `Paid out ${formatUGX(Number(r.total_paid_out ?? 0))}`,
        ]
          .filter(Boolean)
          .join(' • '),
      };
    });
  }

  const { data, error } = await supabase.rpc('get_merchant_float_positions' as any);
  if (error) throw error;
  return ((data ?? []) as any[])
    .map((r) => ({
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
    }))
    // A desk that is no longer active is NOT a merchant float holder. Its wallet
    // float is ordinary operational float and belongs only to the Operational
    // Float bucket — counting it here double-counts the same money.
    .filter((r) => r.amount > 0 && !r.retired)
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
  const [expanded, setExpanded] = useState<string | null>(null);
  const [companyHistoryOpen, setCompanyHistoryOpen] = useState(false);
  const meta = TITLES[bucket];

  const { data, isLoading, error } = useQuery({
    queryKey: ['wallet-bucket-holders', bucket],
    queryFn: () => loadHolders(bucket),
    staleTime: 30_000,
  });

  const rows = useMemo(() => {
    const q = search.trim().toLowerCase();
    const list = data ?? [];
    if (!q) return list;
    return list.filter((r) => `${r.name} ${r.phone}`.toLowerCase().includes(q));
  }, [data, search]);

  const total = rows.reduce((s, r) => s + r.amount, 0);

  // Landlord float only: split the outstanding earmarks by who put the money
  // there — company float (CFO disbursements) vs funders supporting a landlord
  // directly from their own wallet (`partner_self_funding`).
  const { data: sourceSplit } = useQuery({
    queryKey: ['landlord-float-source-split'],
    enabled: bucket === 'landlord_float',
    staleTime: 30_000,
    queryFn: async () => {
      const { data, error } = await supabase
        .from('agent_landlord_float_allocations' as any)
        .select('source, remaining_amount, status')
        .in('status', ['open', 'partially_paid'])
        .limit(5000);
      if (error) throw error;
      let company = 0;
      let companyCount = 0;
      let funder = 0;
      let funderCount = 0;
      for (const r of (data ?? []) as any[]) {
        const amt = Number(r.remaining_amount) || 0;
        if (r.source === 'partner_self_funding') {
          funder += amt;
          funderCount += 1;
        } else {
          company += amt;
          companyCount += 1;
        }
      }
      return { company, companyCount, funder, funderCount };
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
                        <p className="text-sm font-semibold text-foreground truncate">{r.name}</p>
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
