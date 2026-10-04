import { useEffect, useState } from 'react';
import { Info, ShoppingBag } from 'lucide-react';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/hooks/useAuth';
import { Card, CardContent } from '@/components/ui/card';
import { formatUGX } from '@/lib/businessAdvanceCalculations';
import { SHOPPING_ADVANCE_MIN, SHOPPING_ADVANCE_MAX } from './ShoppingAdvanceBoostScreen';

interface Row {
  id: string;
  amount: number;
  date: string;
  from: string | null;
}

/**
 * Informational Shopping Advance access-limit history. Read-only: derived from
 * the user's received wallet transfers (2x each), starting at UGX 30,000 and
 * capped at UGX 30,000,000. This is not a balance and cannot be spent.
 * Must match the figure computed in the wallet-transfer edge function.
 */
export function ShoppingAdvanceHistory() {
  const { user } = useAuth();
  const [rows, setRows] = useState<Row[] | null>(null);

  useEffect(() => {
    if (!user) return;
    let cancelled = false;
    (async () => {
      const { data } = await supabase
        .from('general_ledger')
        .select('id, amount, transaction_date, linked_party')
        .eq('user_id', user.id)
        .eq('category', 'wallet_transfer')
        .eq('direction', 'cash_in')
        .neq('classification', 'admin_correction')
        .neq('category', 'system_balance_correction')
        .order('transaction_date', { ascending: true })
        .limit(5000);
      if (cancelled) return;
      setRows(
        (data ?? []).map((r: any) => ({
          id: r.id,
          amount: Number(r.amount || 0),
          date: r.transaction_date,
          from: r.linked_party ?? null,
        })),
      );
    })();
    return () => {
      cancelled = true;
    };
  }, [user]);

  if (!user || rows === null) return null;

  let running = SHOPPING_ADVANCE_MIN;
  const history = rows.map((r) => {
    const increase = r.amount * 2;
    running = Math.min(running + increase, SHOPPING_ADVANCE_MAX);
    return { ...r, increase, limitAfter: running };
  });
  const current = running;
  const recent = [...history].reverse().slice(0, 20);

  return (
    <Card>
      <CardContent className="space-y-4 p-4">
        <div className="flex items-center gap-2">
          <ShoppingBag className="h-5 w-5 text-primary" aria-hidden />
          <h3 className="font-semibold">Shopping Advance access limit</h3>
        </div>

        <div className="rounded-lg bg-muted p-3 text-center">
          <p className="text-xs uppercase tracking-wide text-muted-foreground">Current access limit</p>
          <p className="text-2xl font-bold text-primary">{formatUGX(current)}</p>
        </div>

        <div className="flex gap-2 rounded-lg border border-border p-3 text-xs text-muted-foreground">
          <Info className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
          <p>
            For information only — this is not money in your wallet and cannot be spent or withdrawn.
            Every limit starts at {formatUGX(SHOPPING_ADVANCE_MIN)} and grows by 2× each transfer you
            receive, up to {formatUGX(SHOPPING_ADVANCE_MAX)}.
          </p>
        </div>

        {recent.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No transfers received yet. When someone sends you money, your limit grows by 2× the amount.
          </p>
        ) : (
          <ul className="divide-y divide-border">
            {recent.map((h) => (
              <li key={h.id} className="flex items-center justify-between gap-3 py-2 text-sm">
                <div className="min-w-0">
                  <p className="truncate font-medium">
                    Received {formatUGX(h.amount)}
                    {h.from ? ` from ${h.from}` : ''}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {new Date(h.date).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })}
                  </p>
                </div>
                <div className="shrink-0 text-right">
                  <p className="font-semibold text-primary">+{formatUGX(h.increase)}</p>
                  <p className="text-xs text-muted-foreground">Limit {formatUGX(h.limitAfter)}</p>
                </div>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
