import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { Loader2, ArrowDownLeft, ArrowUpRight, Wallet, Banknote, AlertTriangle, HelpCircle, ChevronRight } from 'lucide-react';
import { formatUGX } from '@/lib/rentCalculations';
import { LedgerEntryDetailDialog } from './LedgerEntryDetailDialog';

/**
 * Per-user wallet bucket → ledger drill-down.
 *
 * Given a user_id and their cached bucket balances, this lists every
 * wallet-scope ledger entry (general_ledger.ledger_scope = 'wallet')
 * grouped by the bucket it moved (withdrawable / float / advance), with the
 * exact timestamp, category, description and signed amount behind each.
 *
 * Ops / Fin Ops surface — exempt from the user-facing ledger filter, so we
 * intentionally show admin_correction / system_balance_correction legs too
 * since they are part of what produced the cached bucket figure.
 */

type BucketKey = 'withdrawable' | 'float' | 'advance' | 'unclassified';

interface LedgerRow {
  id: string;
  transaction_date: string;
  direction: string;
  category: string | null;
  description: string | null;
  amount: number;
  wallet_bucket: string | null;
  classification: string | null;
}

const BUCKETS: { key: BucketKey; label: string; icon: typeof Wallet; tone: string }[] = [
  { key: 'withdrawable', label: 'Withdrawable', icon: Wallet, tone: 'text-primary' },
  { key: 'float', label: 'Float', icon: Banknote, tone: 'text-sky-600' },
  { key: 'advance', label: 'Advance', icon: AlertTriangle, tone: 'text-warning' },
  { key: 'unclassified', label: 'Unclassified', icon: HelpCircle, tone: 'text-muted-foreground' },
];

function fmtTs(iso: string): string {
  try {
    return new Date(iso).toLocaleString('en-GB', {
      day: '2-digit', month: 'short', year: 'numeric',
      hour: '2-digit', minute: '2-digit',
    });
  } catch {
    return iso;
  }
}

export function WalletBucketLedgerDetail({
  userId,
  withdrawable,
  float,
  advance,
  onlyBucket,
}: {
  userId: string;
  withdrawable: number;
  float: number;
  advance: number;
  onlyBucket?: BucketKey;
}) {
  const [detailId, setDetailId] = useState<string | null>(null);
  const { data, isLoading, error } = useQuery({
    queryKey: ['wallet-bucket-ledger', userId],
    queryFn: async () => {
      const { data: rows, error } = await supabase
        .from('general_ledger')
        .select('id, transaction_date, direction, category, description, amount, wallet_bucket, classification')
        .eq('user_id', userId)
        .eq('ledger_scope', 'wallet')
        .order('transaction_date', { ascending: false })
        .limit(500);
      if (error) throw error;
      return (rows ?? []) as LedgerRow[];
    },
    staleTime: 30_000,
  });

  const grouped = useMemo(() => {
    const g: Record<BucketKey, LedgerRow[]> = {
      withdrawable: [], float: [], advance: [], unclassified: [],
    };
    for (const r of data ?? []) {
      const b = (r.wallet_bucket as BucketKey) ?? null;
      if (b === 'withdrawable' || b === 'float' || b === 'advance') g[b].push(r);
      else g.unclassified.push(r);
    }
    return g;
  }, [data]);

  const cachedFor = (k: BucketKey) =>
    k === 'withdrawable' ? withdrawable : k === 'float' ? float : k === 'advance' ? advance : null;

  if (isLoading) {
    return (
      <div className="px-4 py-6 text-center text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin inline mr-2" />
        Loading ledger entries…
      </div>
    );
  }

  if (error) {
    return (
      <div className="px-4 py-6 text-center text-sm text-destructive">
        Could not load ledger entries.
      </div>
    );
  }

  return (
    <div className="space-y-4 p-4 bg-muted/20">
      {BUCKETS.filter((b) => (onlyBucket ? b.key === onlyBucket : true)).map(({ key, label, icon: Icon, tone }) => {
        const rows = grouped[key];
        if (key !== 'unclassified' && rows.length === 0 && cachedFor(key) === 0) return null;
        const ledgerNet = rows.reduce(
          (s, r) => s + (r.direction === 'cash_in' ? Number(r.amount) : -Number(r.amount)),
          0,
        );
        const cached = cachedFor(key);
        return (
          <div key={key} className="rounded-lg border border-border bg-card overflow-hidden">
            <div className="flex items-center justify-between gap-2 px-3 py-2 bg-muted/40 border-b border-border">
              <span className={`flex items-center gap-2 text-sm font-semibold ${tone}`}>
                <Icon className="h-4 w-4" /> {label}
                <span className="text-[11px] font-normal text-muted-foreground">
                  {rows.length} {rows.length === 1 ? 'entry' : 'entries'}
                </span>
              </span>
              <span className="text-right">
                {cached !== null && (
                  <span className="block text-[10px] uppercase tracking-wider text-muted-foreground">
                    cached {formatUGX(cached)}
                  </span>
                )}
                <span className="font-mono tabular-nums text-sm font-semibold">
                  ledger net {formatUGX(ledgerNet)}
                </span>
              </span>
            </div>
            {rows.length === 0 ? (
              <div className="px-3 py-3 text-xs text-muted-foreground">No ledger entries.</div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead className="text-muted-foreground">
                    <tr className="text-left border-b border-border/60">
                      <th className="px-3 py-1.5 font-medium">Timestamp</th>
                      <th className="px-3 py-1.5 font-medium">Category</th>
                      <th className="px-3 py-1.5 font-medium">Description</th>
                      <th className="px-3 py-1.5 font-medium text-right">Amount</th>
                      <th className="px-2 py-1.5 font-medium sr-only">Details</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((r) => {
                      const isIn = r.direction === 'cash_in';
                      return (
                        <tr
                          key={r.id}
                          onClick={() => setDetailId(r.id)}
                          title="Open full transaction detail"
                          className="border-t border-border/40 hover:bg-muted/30 cursor-pointer"
                        >
                          <td className="px-3 py-1.5 whitespace-nowrap font-mono tabular-nums text-muted-foreground">
                            {fmtTs(r.transaction_date)}
                          </td>
                          <td className="px-3 py-1.5">
                            <span className="font-medium text-foreground">{r.category ?? '—'}</span>
                            {r.classification && r.classification !== 'production' && (
                              <span className="ml-1 rounded bg-muted px-1 text-[9px] uppercase tracking-wider text-muted-foreground">
                                {r.classification}
                              </span>
                            )}
                          </td>
                          <td className="px-3 py-1.5 text-muted-foreground max-w-[280px] truncate" title={r.description ?? ''}>
                            {r.description ?? '—'}
                          </td>
                          <td className={`px-3 py-1.5 text-right font-mono tabular-nums font-semibold ${isIn ? 'text-emerald-600' : 'text-destructive'}`}>
                            <span className="inline-flex items-center gap-1 justify-end">
                              {isIn ? <ArrowDownLeft className="h-3 w-3" /> : <ArrowUpRight className="h-3 w-3" />}
                              {isIn ? '+' : '−'}{formatUGX(Number(r.amount))}
                            </span>
                          </td>
                          <td className="px-2 py-1.5 text-right text-muted-foreground">
                            <ChevronRight className="h-3.5 w-3.5 inline" />
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        );
      })}
      {(data ?? []).length >= 500 && (
        <p className="text-[11px] text-muted-foreground text-center">
          Showing the most recent 500 wallet ledger entries.
        </p>
      )}
      <LedgerEntryDetailDialog
        entryId={detailId}
        open={!!detailId}
        onOpenChange={(v) => !v && setDetailId(null)}
      />
    </div>
  );
}