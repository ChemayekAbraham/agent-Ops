import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { ArrowLeft, Banknote, Loader2, Landmark, Truck } from 'lucide-react';
import { formatUGX } from '@/lib/rentCalculations';

/**
 * Bucket 5 — Actual Money.
 *
 * Real cash the company holds, taken straight from the Balance Sheet cash
 * accounts in the general ledger: A1 Cash and Bank + A5 Cash in Transit.
 * This is NOT a wallet cache — it is what is physically banked or held.
 */

interface CashLine {
  category: string;
  debits: number;
  credits: number;
  net: number;
  entry_count: number;
}

interface TreasuryPosition {
  a1: number;
  a5: number;
  total: number;
  lines: CashLine[];
  asAt: string;
}

export function useActualMoneyPosition() {
  return useQuery({
    queryKey: ['actual-money-position'],
    queryFn: async (): Promise<TreasuryPosition> => {
      const { data, error } = await supabase.rpc('get_treasury_cash_position' as any, {} as any);
      if (error) throw error;
      const d = (data ?? {}) as any;
      const a1 = Number(d.a1_cash_and_bank ?? 0);
      const a5 = Number(d.a5_cash_in_transit ?? 0);
      return {
        a1,
        a5,
        total: Number(d.total_cash ?? a1 + a5),
        lines: ((d.lines ?? []) as any[]).map((l) => ({
          category: String(l.category ?? '—'),
          debits: Number(l.debits ?? 0),
          credits: Number(l.credits ?? 0),
          net: Number(l.net ?? 0),
          entry_count: Number(l.entry_count ?? 0),
        })),
        asAt: d.as_at ?? new Date().toISOString(),
      };
    },
    staleTime: 60_000,
    retry: false,
  });
}

function prettyCategory(c: string) {
  return c.replace(/_/g, ' ').replace(/\b\w/g, (m) => m.toUpperCase());
}

export function ActualMoneyDetail({ onBack }: { onBack: () => void }) {
  const { data, isLoading, error } = useActualMoneyPosition();

  return (
    <div className="space-y-4">
      <div>
        <Button variant="ghost" size="sm" onClick={onBack} className="-ml-2 mb-1 gap-1.5">
          <ArrowLeft className="h-4 w-4" /> Wallet Buckets
        </Button>
        <h2 className="text-lg sm:text-xl font-bold tracking-tight flex items-center gap-2">
          <Banknote className="h-5 w-5 text-primary" /> Actual Money — Real Cash We Hold
        </h2>
        <p className="text-sm text-muted-foreground mt-0.5 max-w-2xl">
          Cash physically in bank accounts and mobile money lines, plus cash collected but not yet
          banked. Ledger-derived (Balance Sheet accounts A1 and A5) — not a wallet cache.
        </p>
      </div>

      {isLoading ? (
        <div className="py-10 text-center text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin inline mr-2" /> Loading cash position…
        </div>
      ) : error ? (
        <div className="py-10 text-center text-sm text-destructive">
          Could not load the cash position.
        </div>
      ) : data ? (
        <>
          <div className="grid gap-3 sm:grid-cols-3">
            <Card className="border-emerald-500/20">
              <CardContent className="p-4">
                <p className="text-[10px] uppercase tracking-wider text-muted-foreground flex items-center gap-1.5">
                  <Landmark className="h-3.5 w-3.5" /> Cash and Bank (A1)
                </p>
                <p className="font-mono tabular-nums text-lg font-bold mt-1">{formatUGX(data.a1)}</p>
              </CardContent>
            </Card>
            <Card className="border-amber-500/20">
              <CardContent className="p-4">
                <p className="text-[10px] uppercase tracking-wider text-muted-foreground flex items-center gap-1.5">
                  <Truck className="h-3.5 w-3.5" /> Cash in Transit (A5)
                </p>
                <p className="font-mono tabular-nums text-lg font-bold mt-1">{formatUGX(data.a5)}</p>
              </CardContent>
            </Card>
            <Card className="border-primary/30 bg-primary/5">
              <CardContent className="p-4">
                <p className="text-[10px] uppercase tracking-wider text-muted-foreground">
                  Total actual money
                </p>
                <p className="font-mono tabular-nums text-lg font-bold mt-1 text-primary">
                  {formatUGX(data.total)}
                </p>
              </CardContent>
            </Card>
          </div>

          <Card>
            <CardContent className="p-0 overflow-x-auto">
              <table className="w-full text-xs">
                <thead className="text-muted-foreground bg-muted/40">
                  <tr className="text-left">
                    <th className="px-3 py-2 font-medium">Cash movement</th>
                    <th className="px-3 py-2 font-medium text-right">Money in</th>
                    <th className="px-3 py-2 font-medium text-right">Money out</th>
                    <th className="px-3 py-2 font-medium text-right">Net</th>
                    <th className="px-3 py-2 font-medium text-right">Entries</th>
                  </tr>
                </thead>
                <tbody>
                  {data.lines.length === 0 ? (
                    <tr>
                      <td colSpan={5} className="px-3 py-4 text-center text-muted-foreground">
                        No cash movements recorded.
                      </td>
                    </tr>
                  ) : (
                    data.lines.map((l) => (
                      <tr key={l.category} className="border-t border-border/50 hover:bg-muted/30">
                        <td className="px-3 py-2 font-medium text-foreground">
                          {prettyCategory(l.category)}
                        </td>
                        <td className="px-3 py-2 text-right font-mono tabular-nums text-emerald-600">
                          {formatUGX(l.debits)}
                        </td>
                        <td className="px-3 py-2 text-right font-mono tabular-nums text-destructive">
                          {formatUGX(l.credits)}
                        </td>
                        <td className="px-3 py-2 text-right font-mono tabular-nums font-semibold">
                          {formatUGX(l.net)}
                        </td>
                        <td className="px-3 py-2 text-right font-mono tabular-nums text-muted-foreground">
                          {l.entry_count}
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </CardContent>
          </Card>
        </>
      ) : null}
    </div>
  );
}
