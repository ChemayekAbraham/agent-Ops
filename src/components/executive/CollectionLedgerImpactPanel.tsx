import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { formatUGX } from '@/lib/rentCalculations';
import { Loader2, RefreshCw, Scale, Wallet } from 'lucide-react';

type LedgerRow = {
  id: string;
  created_at: string;
  transaction_date: string;
  transaction_group_id: string | null;
  amount: number;
  direction: 'cash_in' | 'cash_out' | string;
  category: string;
  description: string | null;
  account: string | null;
  ledger_scope: string;
  wallet_bucket: string | null;
  user_id: string | null;
  linked_party: string | null;
  classification: string | null;
  recipient_type: string | null;
};

type WalletRow = {
  user_id: string;
  balance: number;
  withdrawable_balance: number;
  float_balance: number;
  advance_balance: number;
  updated_at: string;
};

async function fetchLedgerForCollection(collectionId: string): Promise<LedgerRow[]> {
  const { data, error } = await supabase
    .from('general_ledger')
    .select('id, created_at, transaction_date, transaction_group_id, amount, direction, category, description, account, ledger_scope, wallet_bucket, user_id, linked_party, classification, recipient_type')
    .eq('source_table', 'agent_collections')
    .eq('source_id', collectionId)
    .order('created_at', { ascending: true });
  if (error) throw error;
  return (data || []) as LedgerRow[];
}

async function fetchWalletsFor(userIds: string[]): Promise<Map<string, WalletRow>> {
  const map = new Map<string, WalletRow>();
  if (!userIds.length) return map;
  const { data } = await supabase
    .from('wallets')
    .select('user_id, balance, withdrawable_balance, float_balance, advance_balance, updated_at')
    .in('user_id', userIds);
  (data || []).forEach((w: any) => map.set(w.user_id, w as WalletRow));
  return map;
}

async function fetchProfileNames(ids: string[]): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  if (!ids.length) return map;
  const { data } = await supabase
    .from('profiles')
    .select('id, full_name, phone')
    .in('id', ids);
  (data || []).forEach((p: any) => map.set(p.id, p.full_name || p.phone || p.id.slice(0, 8)));
  return map;
}

const scopeTone: Record<string, string> = {
  wallet: 'bg-primary/10 text-primary border-primary/30',
  platform: 'bg-amber-500/10 text-amber-700 border-amber-500/30',
  bridge: 'bg-violet-500/10 text-violet-700 border-violet-500/30',
};
const bucketTone: Record<string, string> = {
  withdrawable: 'bg-emerald-500/10 text-emerald-700 border-emerald-500/30',
  float: 'bg-sky-500/10 text-sky-700 border-sky-500/30',
  advance: 'bg-rose-500/10 text-rose-700 border-rose-500/30',
};

export function CollectionLedgerImpactPanel({
  collectionId,
  agentId,
  tenantId,
  agentName,
  tenantName,
}: {
  collectionId: string;
  agentId?: string | null;
  tenantId?: string | null;
  agentName?: string | null;
  tenantName?: string | null;
}) {
  const {
    data: legs = [],
    isLoading,
    isFetching,
    refetch,
    dataUpdatedAt,
    error,
  } = useQuery({
    queryKey: ['collection-ledger-impact', collectionId],
    queryFn: () => fetchLedgerForCollection(collectionId),
    refetchInterval: 8_000,
    staleTime: 4_000,
  });

  const walletUserIds = useMemo(() => {
    const s = new Set<string>();
    legs.forEach((l) => {
      if (l.ledger_scope === 'wallet' && l.user_id) s.add(l.user_id);
    });
    return Array.from(s);
  }, [legs]);

  const { data: wallets = new Map<string, WalletRow>() } = useQuery({
    queryKey: ['collection-ledger-wallets', collectionId, walletUserIds.join(',')],
    queryFn: () => fetchWalletsFor(walletUserIds),
    enabled: walletUserIds.length > 0,
    refetchInterval: 8_000,
  });

  const missingNameIds = useMemo(() => {
    const s = new Set<string>();
    legs.forEach((l) => { if (l.user_id) s.add(l.user_id); });
    if (agentId) s.delete(agentId);
    if (tenantId) s.delete(tenantId);
    return Array.from(s);
  }, [legs, agentId, tenantId]);

  const { data: extraNames = new Map<string, string>() } = useQuery({
    queryKey: ['collection-ledger-names', collectionId, missingNameIds.join(',')],
    queryFn: () => fetchProfileNames(missingNameIds),
    enabled: missingNameIds.length > 0,
    staleTime: 5 * 60_000,
  });

  const nameFor = (uid: string | null): string => {
    if (!uid) return '—';
    if (agentId && uid === agentId) return agentName || 'Agent';
    if (tenantId && uid === tenantId) return tenantName || 'Tenant';
    return extraNames.get(uid) || uid.slice(0, 8);
  };

  // Double-entry check per transaction_group_id: sum(cash_in) == sum(cash_out).
  const groups = useMemo(() => {
    const g = new Map<string, { in: number; out: number; count: number }>();
    legs.forEach((l) => {
      const key = l.transaction_group_id || l.id;
      const cur = g.get(key) || { in: 0, out: 0, count: 0 };
      const amt = Number(l.amount) || 0;
      if (l.direction === 'cash_in') cur.in += amt;
      else if (l.direction === 'cash_out') cur.out += amt;
      cur.count += 1;
      g.set(key, cur);
    });
    return g;
  }, [legs]);

  const balanced = useMemo(() => {
    if (!legs.length) return true;
    for (const v of groups.values()) {
      if (Math.abs(v.in - v.out) > 0.01) return false;
    }
    return true;
  }, [legs, groups]);

  // Per-user wallet net change from this collection's wallet-scope legs.
  const walletImpacts = useMemo(() => {
    const m = new Map<string, { net: number; bucket: string | null }>();
    legs.forEach((l) => {
      if (l.ledger_scope !== 'wallet' || !l.user_id) return;
      const delta = (l.direction === 'cash_in' ? 1 : -1) * (Number(l.amount) || 0);
      const cur = m.get(l.user_id) || { net: 0, bucket: l.wallet_bucket };
      cur.net += delta;
      if (!cur.bucket && l.wallet_bucket) cur.bucket = l.wallet_bucket;
      m.set(l.user_id, cur);
    });
    return m;
  }, [legs]);

  const fmtWhen = (iso: string) =>
    new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Africa/Kampala',
      month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
    }).format(new Date(iso));

  const secondsAgo = Math.max(0, Math.round((Date.now() - dataUpdatedAt) / 1000));

  return (
    <div className="mt-4 rounded-lg border border-border bg-muted/20 overflow-hidden">
      <div className="flex items-center justify-between gap-2 px-3 py-2 bg-muted/40 border-b border-border">
        <div className="flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-wide text-foreground">
          <Scale className="h-3.5 w-3.5" />
          Double-entry ledger impact
          {legs.length > 0 && (
            <span className={`ml-1 inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full border text-[9px] ${balanced ? 'bg-emerald-500/10 text-emerald-700 border-emerald-500/30' : 'bg-rose-500/10 text-rose-700 border-rose-500/30'}`}>
              {balanced ? '✓ balanced' : '✗ unbalanced'}
            </span>
          )}
        </div>
        <button
          type="button"
          onClick={() => refetch()}
          disabled={isFetching}
          title={`Updated ${secondsAgo}s ago · auto-refresh every 8s`}
          className="inline-flex items-center gap-1 h-6 px-1.5 rounded-md text-[10px] font-semibold bg-background border border-border hover:bg-muted disabled:opacity-50"
        >
          <RefreshCw className={`h-3 w-3 ${isFetching ? 'animate-spin' : ''}`} /> {secondsAgo}s
        </button>
      </div>

      {isLoading ? (
        <div className="flex items-center justify-center py-6 text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
        </div>
      ) : error ? (
        <p className="p-3 text-[11px] text-rose-600">Failed to load ledger entries.</p>
      ) : legs.length === 0 ? (
        <p className="p-3 text-[11px] text-muted-foreground">
          No ledger entries found for this collection yet. If this record was posted very recently, entries will appear on the next auto-refresh.
        </p>
      ) : (
        <>
          <div className="overflow-auto">
            <table className="w-full text-[10.5px]">
              <thead className="bg-muted/60 text-muted-foreground">
                <tr>
                  <th className="text-left font-bold uppercase tracking-wide px-2 py-1 text-[9px]">When (EAT)</th>
                  <th className="text-left font-bold uppercase tracking-wide px-2 py-1 text-[9px]">Category</th>
                  <th className="text-left font-bold uppercase tracking-wide px-2 py-1 text-[9px]">Scope</th>
                  <th className="text-left font-bold uppercase tracking-wide px-2 py-1 text-[9px]">Party</th>
                  <th className="text-right font-bold uppercase tracking-wide px-2 py-1 text-[9px]">In</th>
                  <th className="text-right font-bold uppercase tracking-wide px-2 py-1 text-[9px]">Out</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {legs.map((l) => {
                  const isIn = l.direction === 'cash_in';
                  const amt = Number(l.amount) || 0;
                  return (
                    <tr key={l.id} className="hover:bg-background/60">
                      <td className="px-2 py-1 tabular-nums whitespace-nowrap text-muted-foreground">{fmtWhen(l.created_at)}</td>
                      <td className="px-2 py-1">
                        <span className="font-semibold text-foreground">{l.category.replace(/_/g, ' ')}</span>
                        {l.classification && l.classification !== 'production' && (
                          <span className="ml-1 text-[9px] uppercase text-amber-700">[{l.classification}]</span>
                        )}
                      </td>
                      <td className="px-2 py-1">
                        <span className={`inline-flex items-center px-1 py-0.5 rounded border text-[9px] uppercase font-semibold ${scopeTone[l.ledger_scope] || 'bg-muted text-muted-foreground border-border'}`}>
                          {l.ledger_scope}
                        </span>
                        {l.wallet_bucket && (
                          <span className={`ml-1 inline-flex items-center px-1 py-0.5 rounded border text-[9px] uppercase font-semibold ${bucketTone[l.wallet_bucket] || 'bg-muted text-muted-foreground border-border'}`}>
                            {l.wallet_bucket}
                          </span>
                        )}
                      </td>
                      <td className="px-2 py-1 truncate max-w-[10rem]">{l.user_id ? nameFor(l.user_id) : (l.linked_party || l.account || '—')}</td>
                      <td className={`px-2 py-1 text-right tabular-nums ${isIn ? 'text-emerald-700 font-semibold' : 'text-muted-foreground'}`}>{isIn ? formatUGX(amt) : ''}</td>
                      <td className={`px-2 py-1 text-right tabular-nums ${!isIn ? 'text-rose-700 font-semibold' : 'text-muted-foreground'}`}>{!isIn ? formatUGX(amt) : ''}</td>
                    </tr>
                  );
                })}
              </tbody>
              <tfoot className="bg-muted/60">
                <tr className="border-t border-border">
                  <td className="px-2 py-1 text-[9px] font-bold uppercase tracking-wide" colSpan={4}>Totals</td>
                  <td className="px-2 py-1 text-right tabular-nums font-bold text-emerald-700">
                    {formatUGX(legs.filter((l) => l.direction === 'cash_in').reduce((s, l) => s + (Number(l.amount) || 0), 0))}
                  </td>
                  <td className="px-2 py-1 text-right tabular-nums font-bold text-rose-700">
                    {formatUGX(legs.filter((l) => l.direction === 'cash_out').reduce((s, l) => s + (Number(l.amount) || 0), 0))}
                  </td>
                </tr>
              </tfoot>
            </table>
          </div>

          {walletImpacts.size > 0 && (
            <div className="border-t border-border p-2.5">
              <p className="flex items-center gap-1 text-[10px] font-bold uppercase tracking-wide text-muted-foreground mb-1.5">
                <Wallet className="h-3 w-3" /> Wallet balance impact (real-time)
              </p>
              <div className="grid gap-1.5">
                {Array.from(walletImpacts.entries()).map(([uid, impact]) => {
                  const w = wallets.get(uid);
                  const currentForBucket =
                    impact.bucket === 'withdrawable' ? w?.withdrawable_balance
                    : impact.bucket === 'float' ? w?.float_balance
                    : impact.bucket === 'advance' ? w?.advance_balance
                    : w?.balance;
                  const before = currentForBucket != null ? Number(currentForBucket) - impact.net : null;
                  const positive = impact.net >= 0;
                  return (
                    <div key={uid} className="rounded-md border border-border bg-background p-2 text-[10.5px]">
                      <div className="flex items-center justify-between gap-2">
                        <div className="min-w-0">
                          <p className="font-semibold text-foreground truncate">{nameFor(uid)}</p>
                          <p className="text-[9px] font-mono text-muted-foreground truncate">{uid}</p>
                        </div>
                        <span className={`px-1.5 py-0.5 rounded border text-[9px] uppercase font-semibold ${impact.bucket ? (bucketTone[impact.bucket] || 'bg-muted text-muted-foreground border-border') : 'bg-muted text-muted-foreground border-border'}`}>
                          {impact.bucket || 'wallet'}
                        </span>
                      </div>
                      <div className="mt-1 grid grid-cols-3 gap-1.5">
                        <div>
                          <p className="text-[9px] uppercase text-muted-foreground">Before</p>
                          <p className="tabular-nums font-semibold">{before != null ? formatUGX(before) : '—'}</p>
                        </div>
                        <div>
                          <p className="text-[9px] uppercase text-muted-foreground">Change</p>
                          <p className={`tabular-nums font-bold ${positive ? 'text-emerald-700' : 'text-rose-700'}`}>
                            {positive ? '+' : ''}{formatUGX(impact.net)}
                          </p>
                        </div>
                        <div>
                          <p className="text-[9px] uppercase text-muted-foreground">Now</p>
                          <p className="tabular-nums font-bold text-foreground">{currentForBucket != null ? formatUGX(Number(currentForBucket)) : '—'}</p>
                        </div>
                      </div>
                      {w && (
                        <p className="mt-1 text-[9px] text-muted-foreground">
                          Wallet · withdrawable {formatUGX(Number(w.withdrawable_balance) || 0)} · float {formatUGX(Number(w.float_balance) || 0)} · advance {formatUGX(Number(w.advance_balance) || 0)}
                        </p>
                      )}
                    </div>
                  );
                })}
              </div>
              <p className="mt-1.5 text-[9px] text-muted-foreground">
                "Before" is the current wallet bucket balance minus this collection's net change. Auto-refreshes every 8s.
              </p>
            </div>
          )}
        </>
      )}
    </div>
  );
}