import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { HeroCard } from '@/components/cfo/HeroCard';
import { formatUGX } from '@/lib/creditFeeCalculations';
import { kampalaTodayYmd, kampalaOffsetYmd, kampalaLabel } from '@/lib/kampalaDays';
import { kampalaDate, type DrilldownPreset } from '@/components/cfo/MoneyDrilldownReport';
import { creditsGroupLabel } from '@/lib/withdrawableCreditsGroups';
import { WithdrawableCreditsReport } from '@/components/cfo/WithdrawableCreditsReport';
import { Coins } from 'lucide-react';
import { Button } from '@/components/ui/button';

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
export function periodBounds(p: Period): { from: number; to: number | null; phrase: string } {
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
 * Rendered through the same compact card the treasury and bank cards use, and
 * the drill-down opens the same paged report layout as the Money Paid Out
 * page. Nothing is derived here beyond grouping — every figure is the ledger
 * total the RPC returns.
 */
export function WithdrawableCreditsLivePanel({ moneyWeHaveTotal }: { moneyWeHaveTotal: number }) {
  const [live, setLive] = useState(false);
  const [period, setPeriod] = useState<Period>('today');
  const bounds = periodBounds(period);
  const fromIso = new Date(bounds.from).toISOString();
  const toIso = bounds.to === null ? null : new Date(bounds.to).toISOString();
  // Inclusive Kampala day bounds for the report's date inputs.
  const fromYmd = kampalaDate(new Date(bounds.from));
  const toYmd = bounds.to === null ? kampalaTodayYmd() : kampalaDate(new Date(bounds.to - 1));

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

  const [report, setReport] = useState<{ open: boolean; preset: DrilldownPreset | null }>({ open: false, preset: null });
  const openReport = (preset: DrilldownPreset | null) => setReport({ open: true, preset });

  const grouped = new Map<string, { total: number; credits: number }>();
  (q.data ?? []).forEach((r) => {
    const k = creditsGroupLabel(r.category);
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
    onSelect: () => openReport({
      label: `${k} — ${periodTitle(period)}`,
      from: fromYmd,
      to: toYmd,
      status: '',
      type: k,
      expected: { amount: g.total, count: g.credits, basis: 'confirmed' as const },
    }),
  }));

  const periodSelector = (
    <div className="grid grid-cols-4 gap-1 rounded-lg bg-muted/60 p-1" role="group" aria-label="Credits period">
      {PERIODS.map((p) => {
        const active = p.key === period;
        return (
          <Button
            key={p.key}
            type="button"
            variant="ghost"
            size="sm"
            aria-pressed={active}
            onClick={() => setPeriod(p.key)}
            className={`min-h-[32px] h-auto truncate rounded-md px-1 py-1 text-[10px] font-medium transition-colors ${
              active
                ? 'bg-background shadow-sm font-semibold text-foreground'
                : 'text-muted-foreground hover:text-foreground'
            }`}
          >
            {p.short}
          </Button>
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
      onClick={() => openReport({
        label: periodTitle(period),
        from: fromYmd,
        to: toYmd,
        status: '',
        expected: { amount: total, count, basis: 'confirmed' as const },
      })}
      footer={
        q.error
          ? `Could not load credits for ${periodTitle(period).toLowerCase()} from the ledger.`
          : `${count.toLocaleString()} credits ${bounds.phrase}`
      }
      footerTone="bg-emerald-50/70 dark:bg-emerald-950/30 text-emerald-700 dark:text-emerald-400 italic"
      action={periodSelector}
    />
    <WithdrawableCreditsReport
      open={report.open}
      onOpenChange={(o) => setReport((r) => ({ ...r, open: o }))}
      preset={report.preset}
    />
    </>
  );
}
