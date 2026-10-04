import { useEffect, useState } from 'react';
import { supabase } from '@/integrations/supabase/client';

export interface TelecomBalances {
  mtn: { amount: number; at: string } | null;
  airtel: { amount: number; at: string } | null;
}

/**
 * Live MTN / Airtel float balances as reported on the most recent
 * balance-carrying email for each channel. Re-reads whenever `refreshKey`
 * changes. Relocated verbatim out of `TelecomBalanceStrip` in
 * `EmailTransactionsPanel.tsx` — zero behavior change.
 */
export function useTelecomBalances(refreshKey: string | null): TelecomBalances {
  const [bal, setBal] = useState<TelecomBalances>({ mtn: null, airtel: null });

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const pick = async (channel: string, senderToken: string) => {
        const { data } = await (supabase.from('gmail_transactions') as any)
          .select('balance, internal_date, subject')
          .eq('channel', channel)
          .not('balance', 'is', null)
          // Only real forwarded telecom SMS carry a true float balance.
          // Internal Welile report emails (e.g. "Daily Wallet Financial
          // Summary Report") also land in this table and had a bogus
          // "balance" parsed out of their body, which was overriding the
          // genuine MoMoPay figure. Match the telecom sender token — no
          // spaces, so the filter survives URL encoding.
          .ilike('subject', `%${senderToken}%`)
          .order('internal_date', { ascending: false })
          .limit(1);
        const row = Array.isArray(data) ? data[0] : null;
        return row ? { amount: Number(row.balance), at: String(row.internal_date) } : null;
      };
      const [mtn, airtel] = await Promise.all([
        pick('mtn_momo', 'MobMoney'),
        pick('airtel_money', 'AirtelMoney'),
      ]);
      if (!cancelled) setBal({ mtn, airtel });
    })();
    return () => {
      cancelled = true;
    };
  }, [refreshKey]);

  return bal;
}
