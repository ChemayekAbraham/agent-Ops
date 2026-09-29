import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { HeroCard } from '@/components/cfo/HeroCard';
import { formatUGX } from '@/lib/creditFeeCalculations';
import { Coins } from 'lucide-react';

const GROUPS: Record<string, string> = {
  roi_wallet_credit: 'Supporter returns',
  roi_payout: 'Supporter returns',
  wallet_deposit: 'Deposits',
  wallet_transfer: 'Wallet transfers in',
  bucket_reclass_in: 'Float moved to withdrawable',
  agent_commission: 'Commissions',
  agent_commission_earned: 'Commissions',
  partner_commission: 'Commissions',
  proxy_investment_commission: 'Commissions',
  agent_investment_commission: 'Commissions',
  agent_advance_credit: 'Agent advances',
  system_balance_correction: 'Corrections',
};
const label = (c: string) =>
  GROUPS[c] ??
  (c.includes('bonus') ? 'Bonuses'
    : c.includes('salary') || c.includes('payroll') ? 'Salary & payroll'
    : c.includes('correction') ? 'Corrections'
    : c.includes('commission') ? 'Commissions'
    : 'Other');

type Row = { category: string; total: number; credits: number };

/**
 * Today's wallet credits into the withdrawable bucket, grouped by what they
 * were for. Rendered through the same compact card the treasury and bank cards
 * use, so the three sit in one row as a set: amount on the face, breakdown in
 * the modal. Nothing is derived here beyond grouping — every figure is the
 * ledger total the RPC returns.
 */
export function WithdrawableCreditsLivePanel() {
  const [live, setLive] = useState(false);
  const q = useQuery({
    queryKey: ['cfo-withdrawable-credits-today'],
    queryFn: async () => {
      const { data, error } = await supabase.rpc('get_cfo_withdrawable_credits_today');
      if (error) throw error;
      return (data ?? []) as Row[];
    },
    refetchInterval: live ? false : 30000,
  });
  const timer = useRef<number | null>(null);
  const refetch = q.refetch;

  useEffect(() => {
    const ch = supabase
      .channel('cfo-withdrawable-credits')
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'general_ledger' }, () => {
        if (timer.current) return;
        timer.current = window.setTimeout(() => { timer.current = null; refetch(); }, 5000);
      })
      .subscribe((s) => setLive(s === 'SUBSCRIBED'));
    return () => { if (timer.current) clearTimeout(timer.current); supabase.removeChannel(ch); };
  }, [refetch]);

  const grouped = new Map<string, { total: number; credits: number }>();
  (q.data ?? []).forEach((r) => {
    const k = label(r.category);
    const g = grouped.get(k) ?? { total: 0, credits: 0 };
    g.total += Number(r.total); g.credits += Number(r.credits);
    grouped.set(k, g);
  });
  const rows = [...grouped.entries()].sort((a, b) => b[1].total - a[1].total);
  const total = rows.reduce((s, [, g]) => s + g.total, 0);
  const count = rows.reduce((s, [, g]) => s + g.credits, 0);

  const items = rows.map(([k, g]) => ({
    dot: 'bg-emerald-500',
    label: `${k} (${g.credits.toLocaleString()})`,
    value: formatUGX(g.total),
  }));

  return (
    <HeroCard
      icon={<Coins className="h-4 w-4" />}
      tone="success"
      title="Withdrawable credits today"
      value={q.isLoading || q.error ? '—' : formatUGX(total)}
      percentageLabel={`${live ? 'Live' : 'Auto-refresh'} · updated ${q.dataUpdatedAt ? new Date(q.dataUpdatedAt).toLocaleTimeString() : '—'}`}
      items={items}
      footer={
        q.error
          ? 'Could not load today’s credits from the ledger.'
          : `${count.toLocaleString()} credits since midnight (Kampala)`
      }
      footerTone="bg-emerald-50/70 dark:bg-emerald-950/30 text-emerald-700 dark:text-emerald-400 italic"
    />
  );
}
