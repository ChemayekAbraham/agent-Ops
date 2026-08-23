import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { ArrowLeft, ChevronDown, ChevronRight, Loader2, Search, ExternalLink } from 'lucide-react';
import { formatUGX } from '@/lib/rentCalculations';
import { WalletBucketLedgerDetail } from './WalletBucketLedgerDetail';
import { LandlordFloatAllocationsDetail } from './LandlordFloatAllocationsDetail';


export type HolderBucket = 'withdrawable' | 'float' | 'landlord_float' | 'merchant_float';

interface HolderRow {
  key: string;
  userId: string | null;
  name: string;
  phone: string;
  amount: number;
  meta?: string;
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
  if (bucket === 'withdrawable' || bucket === 'float') {
    const column = bucket === 'withdrawable' ? 'withdrawable_balance' : 'float_balance';
    const { data: rows, error } = await supabase
      .from('wallets')
      .select('user_id, withdrawable_balance, float_balance')
      .gt(column, 0)
      .order(column, { ascending: false })
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
        amount: Number(
          bucket === 'withdrawable' ? r.withdrawable_balance ?? 0 : r.float_balance ?? 0,
        ),
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
      meta: `Evidenced ${formatUGX(Number(r.evidenced_amount ?? 0))} • Paid out ${formatUGX(Number(r.paid_out_total ?? 0))}`,
    }))
    .filter((r) => r.amount > 0)
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

  return (
    <div className="space-y-4">
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
