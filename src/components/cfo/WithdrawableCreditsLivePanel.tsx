import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { HeroCard } from '@/components/cfo/HeroCard';
import { formatUGX } from '@/lib/creditFeeCalculations';
import { kampalaTodayYmd, kampalaOffsetYmd, kampalaLabel } from '@/lib/kampalaDays';
import { Coins } from 'lucide-react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog';

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

/** Reporting periods, all bucketed on Kampala (EAT, UTC+3) calendar days. */
type Period = 'today' | 'yesterday' | 'sevenDays' | 'month';

const PERIODS: { key: Period; short: string; title: string }[] = [
  { key: 'today', short: 'Today', title: 'Today' },
  { key: 'yesterday', short: 'Yester.', title: 'Yesterday' },
  { key: 'sevenDays', short: '7 days', title: 'Past 7 days' },
  { key: 'month', short: 'Month', title: 'This month' },
];

const periodTitle = (p: Period) => PERIODS.find((x) => x.key === p)?.title ?? 'Today';

/**
 * Kampala-day bounds for a period: [start, end) as epoch ms, `end === null`
 * meaning "up to now". Midnight is the Kampala calendar day's midnight
 * (UTC+3), so the buckets match the RPC-side reporting convention whatever
 * device timezone the CFO is in.
 */
function periodBounds(p: Period): { from: number; to: number | null; phrase: string } {
  const todayYmd = kampalaTodayYmd();
  const midnight = (ymd: string) => new Date(`${ymd}T00:00:00+03:00`).getTime();
  switch (p) {
    case 'today':
      return { from: midnight(todayYmd), to: null, phrase: 'since midnight (Kampala)' };
    case 'yesterday': {
      const y = kampalaOffsetYmd(-1);
      return { from: midnight(y), to: midnight(todayYmd), phrase: `on ${kampalaLabel(y)} (Kampala)` };
    }
    case 'sevenDays':
      return { from: midnight(kampalaOffsetYmd(-6)), to: null, phrase: 'over the past 7 days (Kampala)' };
    case 'month':
      return { from: midnight(`${todayYmd.slice(0, 8)}01`), to: null, phrase: 'this month (Kampala)' };
  }
}

/**
 * Wallet credits into the withdrawable bucket for a selectable Kampala period
 * (today, yesterday, past 7 days, this month), grouped by what they were for.
 * Rendered through the same compact card the treasury and bank cards use, so
 * the three sit in one row as a set: amount on the face, period selector below,
 * breakdown in the modal. Nothing is derived here beyond grouping — every
 * figure is the ledger total the RPC returns.
 */
export function WithdrawableCreditsLivePanel({ moneyWeHaveTotal }: { moneyWeHaveTotal: number }) {
  const [live, setLive] = useState(false);
  const [period, setPeriod] = useState<Period>('today');
  const bounds = periodBounds(period);
  const fromIso = new Date(bounds.from).toISOString();
  const toIso = bounds.to === null ? null : new Date(bounds.to).toISOString();

  const q = useQuery({
    queryKey: ['cfo-withdrawable-credits', period],
    queryFn: async () => {
      const { data, error } = await supabase.rpc('get_cfo_withdrawable_credits_range', {
        p_from: fromIso,
        p_to: toIso ?? undefined,
      });
      if (error) throw error;
      return (data ?? []) as Row[];
    },
    refetchInterval: live ? false : 30000,
    placeholderData: (prev) => prev,
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

  const [openGroup, setOpenGroup] = useState<string | null>(null);
  const cats = (q.data ?? []).filter((r) => label(r.category) === openGroup).map((r) => r.category);
  const detail = useQuery({
    queryKey: ['cfo-withdrawable-credits-detail', period, openGroup, cats.join(',')],
    enabled: !!openGroup && cats.length > 0,
    queryFn: async () => {
      const { data, error } = await supabase.rpc('get_cfo_withdrawable_credits_range_detail', {
        p_categories: cats,
        p_from: fromIso,
        p_to: toIso ?? undefined,
      });
      if (error) throw error;
      return data ?? [];
    },
  });

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
  const loadingOrError = q.isLoading || q.error;

  const items = rows.map(([k, g]) => ({
    dot: 'bg-emerald-500',
    label: `${k} (${g.credits.toLocaleString()})`,
    value: formatUGX(g.total),
    onSelect: () => setOpenGroup(k),
  }));

  const openTotals = openGroup ? grouped.get(openGroup) : undefined;

  const periodSelector = (
    <div className="grid grid-cols-4 gap-1 rounded-lg bg-muted/60 p-1" role="group" aria-label="Credits period">
      {PERIODS.map((p) => {
        const active = p.key === period;
        return (
          <button
            key={p.key}
            type="button"
            aria-pressed={active}
            onClick={() => setPeriod(p.key)}
            className={`min-h-[28px] truncate rounded-md px-1 py-1 text-[10px] font-medium transition-colors ${
              active
                ? 'bg-background shadow-sm font-semibold text-foreground'
                : 'text-muted-foreground hover:text-foreground'
            }`}
          >
            {p.short}
          </button>
        );
      })}
    </div>
  );

  return (
    <>
    <HeroCard
      icon={<Coins className="h-4 w-4" />}
      tone="success"
      title="Withdrawable credits"
      value={loadingOrError ? '—' : formatUGX(total)}
      percentageLabel={loadingOrError || moneyWeHaveTotal <= 0
        ? '—'
        : `${((total / moneyWeHaveTotal) * 100).toFixed(1)}% of Money We Have`}
      percentageDirection="up"
      percentageValue={!loadingOrError ? total : undefined}
      percentageTotal={moneyWeHaveTotal}
      items={items}
      footer={
        q.error
          ? `Could not load credits for ${periodTitle(period).toLowerCase()} from the ledger.`
          : `${count.toLocaleString()} credits ${bounds.phrase}`
      }
      footerTone="bg-emerald-50/70 dark:bg-emerald-950/30 text-emerald-700 dark:text-emerald-400 italic"
      action={periodSelector}
    />
    <Dialog open={!!openGroup} onOpenChange={(o) => !o && setOpenGroup(null)}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="text-base">{openGroup} — {periodTitle(period).toLowerCase()}</DialogTitle>
          <DialogDescription className="text-xs">
            {openTotals ? `${openTotals.credits.toLocaleString()} credits · ${formatUGX(openTotals.total)} ${bounds.phrase}` : ''}
          </DialogDescription>
        </DialogHeader>
        {openGroup && (
          <div className="rounded-md border border-border/60 bg-muted/30 p-2 text-xs space-y-1">
            <p className="font-medium text-foreground">By type</p>
            {(q.data ?? [])
              .filter((r) => label(r.category) === openGroup)
              .sort((a, b) => Number(b.total) - Number(a.total))
              .map((r) => (
                <div key={r.category} className="flex items-center justify-between gap-3">
                  <span className="text-muted-foreground capitalize">{r.category.replace(/_/g, ' ')} ({Number(r.credits).toLocaleString()})</span>
                  <span className="tabular-nums font-medium text-foreground">{formatUGX(Number(r.total))}</span>
                </div>
              ))}
            {openTotals && (
              <div className="flex items-center justify-between gap-3 border-t border-border/60 pt-1 font-medium">
                <span>Total</span>
                <span className="tabular-nums">{formatUGX(openTotals.total)}</span>
              </div>
            )}
          </div>
        )}
        <div className="max-h-[50vh] overflow-y-auto space-y-0">
          {detail.isLoading && <p className="text-xs text-muted-foreground py-4">Loading…</p>}
          {detail.error && <p className="text-xs text-destructive py-4">Could not load these credits.</p>}
          {(detail.data ?? []).map((r: any) => (
            <div key={r.id} className="flex items-start justify-between gap-3 py-2 border-b border-border/60 text-xs">
              <div className="min-w-0">
                <p className="font-medium text-foreground truncate">{r.full_name || 'Unknown user'}{r.phone ? ` · ${r.phone}` : ''}</p>
                <p className="text-muted-foreground truncate">{(r.category as string).replace(/_/g, ' ')} · {new Date(r.created_at).toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'Africa/Kampala' })}</p>
                {r.description && <p className="text-muted-foreground truncate">{r.description}</p>}
              </div>
              <span className="tabular-nums font-medium shrink-0 text-foreground">{formatUGX(Number(r.amount))}</span>
            </div>
          ))}
          {detail.data && detail.data.length >= 1000 && <p className="text-[11px] text-muted-foreground pt-2">Showing the largest 1,000 credits.</p>}
        </div>
      </DialogContent>
    </Dialog>
    </>
  );
}
