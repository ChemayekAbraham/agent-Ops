import { useEffect, useState } from 'react';
import { Info, ShoppingBag, Timer } from 'lucide-react';
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
const DAY_MS = 24 * 60 * 60 * 1000;

export function ShoppingAdvanceHistory() {
  const { user } = useAuth();
  const [rows, setRows] = useState<Row[] | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [reload, setReload] = useState(0);

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  // Refetch when the oldest transfer in the window expires so the limit stays accurate.
  const oldestExpiry = rows && rows.length ? new Date(rows[0].date).getTime() + DAY_MS : null;
  useEffect(() => {
    if (oldestExpiry && now >= oldestExpiry) setReload((r) => r + 1);
  }, [oldestExpiry, now >= (oldestExpiry ?? Infinity)]);

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
        .gte('transaction_date', new Date(Date.now() - DAY_MS).toISOString())
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
  }, [user, reload]);

  if (!user || rows === null) return null;

  let running = SHOPPING_ADVANCE_MIN;
  const history = rows.map((r) => {
    const increase = r.amount * 2;
    running = Math.min(running + increase, SHOPPING_ADVANCE_MAX);
    return { ...r, increase, limitAfter: running };
  });
  // Limit resets to 0 once 24 hours pass without a received transfer.
  const current = rows.length === 0 ? 0 : running;
  const recent = [...history].reverse().slice(0, 20);
  const resetAt = rows.length ? new Date(rows[rows.length - 1].date).getTime() + DAY_MS : null;
  const remaining = resetAt ? Math.max(0, resetAt - now) : 0;
  const hh = Math.floor(remaining / 3600000);
  const mm = Math.floor((remaining % 3600000) / 60000);
  const ss = Math.floor((remaining % 60000) / 1000);
  const pad = (n: number) => String(n).padStart(2, '0');

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
          {resetAt && remaining > 0 && (
            <div className="mt-2 flex items-center justify-center gap-1.5 text-xs text-muted-foreground">
              <Timer className="h-3.5 w-3.5" aria-hidden />
              <span>
                Resets to UGX 0 in{' '}
                <span className="font-mono font-semibold text-foreground tabular-nums">
                  {pad(hh)}:{pad(mm)}:{pad(ss)}
                </span>
              </span>
            </div>
          )}
          {resetAt && remaining > 0 && rows.length > 1 && (
            <p className="mt-1 text-[11px] text-muted-foreground">
              Older transfers drop off earlier, so the limit may go down before then. A new transfer restarts the clock.
            </p>
          )}
        </div>


        <div className="flex gap-2 rounded-lg border border-border p-3 text-xs text-muted-foreground">
          <Info className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
          <p>
            For information only — this is not money in your wallet and cannot be spent or withdrawn.
            Every limit starts at {formatUGX(SHOPPING_ADVANCE_MIN)} and grows by 2× each transfer you
            receive, up to {formatUGX(SHOPPING_ADVANCE_MAX)}. It resets to UGX 0 every 24 hours.
          </p>
        </div>

        {recent.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No transfers received in the last 24 hours. Your limit is UGX 0. When someone sends you money, your limit grows by 2× the amount.
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
