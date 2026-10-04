import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { Card, CardContent } from '@/components/ui/card';
import { BarChart3, ChevronDown, ChevronUp, Loader2 } from 'lucide-react';
import { format, parseISO, startOfWeek } from 'date-fns';

/**
 * Transaction totals by period for the CFO dashboard.
 *
 * Reuses the same server-side aggregation the 7-day chart relies on
 * (`get_cfo_daily_cash_flow`) — the ledger produces thousands of legs per
 * day, so client-side reads would silently truncate at the Data API row cap.
 * Daily rows come back in Africa/Kampala calendar days and are rolled up
 * client-side into weekly (Monday-start) and monthly totals.
 *
 * Every ledger movement is double-entry, so Money In and Money Out mirror
 * each other per period; both are shown so the CFO sees the gross volume.
 *
 * Tapping a period row expands a "what it was for" breakdown powered by
 * `get_cfo_period_breakdown` — the same ledger population the totals use,
 * grouped into plain-language money pools (Landlord Float, Agent &
 * Operational Float, Wallet (withdrawable), Platform & custody) so each
 * line says which pool of money it belongs to.
 */

interface DailyRow {
  day: string; // YYYY-MM-DD (Kampala)
  inflow: number;
  outflow: number;
}

type PeriodMode = 'daily' | 'weekly' | 'monthly';

interface PeriodBucket {
  key: string;
  label: string;
  inflow: number;
  outflow: number;
  from: string; // ISO timestamptz (inclusive)
  to: string; // ISO timestamptz (exclusive)
}

interface CategoryLine {
  category: string;
  label: string;
  inflow: number;
  outflow: number;
}

interface PoolGroup {
  pool: string;
  inflow: number;
  outflow: number;
  lines: CategoryLine[];
}

/** Display order for the money pools in the breakdown. */
const POOL_ORDER = [
  'Landlord Float',
  'Agent & Operational Float',
  'Wallet (withdrawable)',
  'Platform & custody',
];

const DAILY_WINDOW = 90; // RPC hard cap
const DAILY_ROWS_SHOWN = 14;
const EAT_OFFSET_MS = 3 * 3_600_000; // Africa/Kampala is UTC+3, no DST

const fmtUgx = (n: number) =>
  `${n < 0 ? '-' : ''}UGX ${new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 }).format(Math.abs(n))}`;

function weekStartKey(day: string) {
  // Monday-start week, computed from the Kampala day key.
  const d = parseISO(day);
  return format(startOfWeek(d, { weekStartsOn: 1 }), 'yyyy-MM-dd');
}

/** Inclusive start / exclusive end of a Kampala calendar day, as ISO strings. */
function dayWindow(dayKey: string): { from: string; to: string } {
  const startUtc = Date.parse(`${dayKey}T00:00:00Z`) - EAT_OFFSET_MS;
  return {
    from: new Date(startUtc).toISOString(),
    to: new Date(startUtc + 86_400_000).toISOString(),
  };
}

const CATEGORY_LABELS: Record<string, string> = {
  agent_float_deposit: 'Agent float deposits',
  agent_float_settlement: 'Agent float settlements',
  agent_float_cash_offset: 'Agent float cash offsets',
  agent_float_cycle_settled_to_bank: 'Agent float settled to bank',
  partner_funding: 'Supporter funding',
  partner_receivable_capital: 'Supporter receivable (capital)',
  partner_receivable_created: 'Supporter receivable created',
  roi_expense: 'Returns expense',
  roi_wallet_credit: 'Returns paid to wallets',
  roi_reinvestment: 'Returns reinvested',
  pending_portfolio_topup: 'Pending portfolio top-ups',
  wallet_withdrawal: 'Wallet withdrawals',
  wallet_deposit: 'Wallet deposits',
  wallet_transfer: 'Wallet transfers',
  bucket_reclass_in: 'Bucket reclassifications (in)',
  bucket_reclass_out: 'Bucket reclassifications (out)',
  cash_receipt_in_transit: 'Cash receipts in transit',
  cash_custody_payable: 'Cash custody payable',
  rent_receivable_created: 'Rent receivables created',
  rent_plan_receivable_restatement: 'Rent plan receivable restatements',
  receivable_restatement_equity: 'Receivable restatement equity',
  verified_bank_cash_recognised: 'Verified bank cash recognised',
  rent_collection: 'Rent collections',
  rent_payment: 'Rent payments',
  commission_earned: 'Commission earned',
  agent_commission: 'Agent commission',
  salary_payment: 'Salary payments',
  advance_disbursement: 'Advance disbursements',
  advance_recovery: 'Advance recoveries',
  landlord_float_credited: 'Landlord float credited to landlords',
  agent_landlord_payout: 'Landlord float payouts to landlords',
  rent_float_funding: 'Landlord float funding',
  landlord_receivable_created: 'Landlord receivables created',
  landlord_receivable_obligation: 'Landlord payable obligations',
  landlord_receivable_collected: 'Landlord receivables collected',
  landlord_rent_payment: 'Landlord rent payments',
  system_balance_correction: 'Balance corrections',
};

function categoryLabel(category: string): string {
  if (CATEGORY_LABELS[category]) return CATEGORY_LABELS[category];
  return category
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

export function TransactionPeriodTotals() {
  const [mode, setMode] = useState<PeriodMode>('daily');
  const [expandedKey, setExpandedKey] = useState<string | null>(null);

  const { data, isLoading, error } = useQuery<DailyRow[]>({
    queryKey: ['cfo-transaction-period-totals'],
    queryFn: async () => {
      const { data, error } = await supabase.rpc('get_cfo_daily_cash_flow', { p_days: DAILY_WINDOW });
      if (error) throw error;
      return ((data as any[]) || []).map((r) => ({
        day: String(r.day).slice(0, 10),
        inflow: Number(r.inflow) || 0,
        outflow: Number(r.outflow) || 0,
      }));
    },
    staleTime: 60_000,
  });

  const dailyRows = useMemo(() => {
    if (!data?.length) return [];
    return [...data].sort((a, b) => b.day.localeCompare(a.day));
  }, [data]);

  const buckets = useMemo((): PeriodBucket[] => {
    if (!dailyRows.length) return [];
    if (mode === 'daily') {
      return dailyRows.slice(0, DAILY_ROWS_SHOWN).map((r) => ({
        key: r.day,
        label: format(parseISO(r.day), 'EEE d MMM'),
        inflow: r.inflow,
        outflow: r.outflow,
        ...dayWindow(r.day),
      }));
    }
    const map = new Map<string, PeriodBucket & { days: string[] }>();
    for (const r of dailyRows) {
      let key: string;
      let label: string;
      if (mode === 'weekly') {
        key = weekStartKey(r.day);
        const end = format(new Date(parseISO(key).getTime() + 6 * 86_400_000), 'd MMM');
        label = `${format(parseISO(key), 'd MMM')} – ${end}`;
      } else {
        key = r.day.slice(0, 7);
        label = format(parseISO(`${key}-01`), 'MMMM yyyy');
      }
      const cur = map.get(key) ?? { key, label, inflow: 0, outflow: 0, from: '', to: '', days: [] as string[] };
      cur.inflow += r.inflow;
      cur.outflow += r.outflow;
      cur.days.push(r.day);
      map.set(key, cur);
    }
    return Array.from(map.values())
      .sort((a, b) => b.key.localeCompare(a.key))
      .map((b) => {
        const first = b.days[b.days.length - 1]; // earliest day in bucket
        const last = b.days[0]; // latest day in bucket
        const from = dayWindow(first).from;
        const to = dayWindow(last).to;
        return { key: b.key, label: b.label, inflow: b.inflow, outflow: b.outflow, from, to };
      });
  }, [dailyRows, mode]);

  const totalInflow = buckets.reduce((s, b) => s + b.inflow, 0);
  const totalOutflow = buckets.reduce((s, b) => s + b.outflow, 0);

  const expandedBucket = expandedKey ? buckets.find((b) => b.key === expandedKey) ?? null : null;

  const { data: poolGroups, isLoading: categoriesLoading } = useQuery<PoolGroup[]>({
    queryKey: ['cfo-period-pool-breakdown', expandedBucket?.from, expandedBucket?.to],
    enabled: !!expandedBucket,
    queryFn: async () => {
      const { data, error } = await supabase.rpc('get_cfo_period_breakdown', {
        p_from: expandedBucket!.from,
        p_to: expandedBucket!.to,
      });
      if (error) throw error;
      const pools = new Map<string, Map<string, CategoryLine>>();
      for (const r of (data as any[]) || []) {
        const pool = String(r.pool || 'Platform & custody');
        const category = String(r.category || 'other');
        const amount = Number(r.amount) || 0;
        let lines = pools.get(pool);
        if (!lines) {
          lines = new Map();
          pools.set(pool, lines);
        }
        const cur = lines.get(category) ?? {
          category,
          label: categoryLabel(category),
          inflow: 0,
          outflow: 0,
        };
        if (r.direction === 'cash_in') cur.inflow += amount;
        else cur.outflow += amount;
        lines.set(category, cur);
      }
      const order = (p: string) => {
        const i = POOL_ORDER.indexOf(p);
        return i >= 0 ? i : POOL_ORDER.length;
      };
      return Array.from(pools.entries())
        .map(([pool, lines]) => {
          const all = Array.from(lines.values()).sort(
            (a, b) => Math.max(b.inflow, b.outflow) - Math.max(a.inflow, a.outflow),
          );
          return {
            pool,
            inflow: all.reduce((s, c) => s + c.inflow, 0),
            outflow: all.reduce((s, c) => s + c.outflow, 0),
            lines: all,
          };
        })
        .sort((a, b) => order(a.pool) - order(b.pool));
    },
    staleTime: 60_000,
  });

  const totalLabel =
    mode === 'daily'
      ? `Total — last ${DAILY_ROWS_SHOWN} days`
      : mode === 'weekly'
      ? `Total — ${buckets.length} week${buckets.length === 1 ? '' : 's'}`
      : `Total — ${buckets.length} month${buckets.length === 1 ? '' : 's'}`;

  return (
    <Card className="rounded-2xl shadow-sm">
      <CardContent className="p-4 sm:p-5">
        <div className="flex flex-wrap items-center justify-between gap-2 mb-4">
          <p className="flex items-center gap-2.5 text-sm font-semibold tracking-tight">
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-primary/10">
              <BarChart3 className="h-4 w-4 text-primary" />
            </span>
            Transactions — Daily, Weekly &amp; Monthly Totals
          </p>
          <div className="flex items-center rounded-full border bg-muted/40 p-0.5">
            {(['daily', 'weekly', 'monthly'] as PeriodMode[]).map((m) => (
              <button
                key={m}
                type="button"
                onClick={() => {
                  setMode(m);
                  setExpandedKey(null);
                }}
                aria-pressed={mode === m}
                className={`rounded-full px-3 py-1 text-xs font-medium capitalize transition-colors ${
                  mode === m
                    ? 'bg-primary text-primary-foreground shadow-sm'
                    : 'text-muted-foreground hover:text-foreground'
                }`}
              >
                {m}
              </button>
            ))}
          </div>
        </div>

        {isLoading ? (
          <div className="flex items-center justify-center gap-2 py-10 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading totals…
          </div>
        ) : error || !buckets.length ? (
          <div className="py-10 text-center text-sm text-muted-foreground">
            No transaction totals available for the last {DAILY_WINDOW} days.
          </div>
        ) : (
          <>
            <div className="rounded-lg border border-border overflow-hidden">
              <div className="max-h-[360px] overflow-y-auto">
                <table className="w-full text-sm">
                  <thead className="bg-muted/40 sticky top-0">
                    <tr className="text-[11px] uppercase tracking-wider text-muted-foreground">
                      <th className="text-left px-3 py-2 font-semibold">{mode === 'daily' ? 'Day' : mode === 'weekly' ? 'Week' : 'Month'}</th>
                      <th className="text-right px-3 py-2 font-semibold text-emerald-700">Money In</th>
                      <th className="text-right px-3 py-2 font-semibold text-rose-700">Money Out</th>
                      <th className="w-8 px-2 py-2" aria-label="Details" />
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {buckets.map((b) => {
                      const isOpen = expandedKey === b.key;
                      return (
                        <FragmentRow
                          key={b.key}
                          bucket={b}
                          isOpen={isOpen}
                          onToggle={() => setExpandedKey(isOpen ? null : b.key)}
                          categoriesLoading={categoriesLoading}
                          poolGroups={isOpen ? poolGroups : undefined}
                        />
                      );
                    })}
                  </tbody>
                  <tfoot className="bg-muted/30 font-semibold">
                    <tr>
                      <td className="px-3 py-2">{totalLabel}</td>
                      <td className="px-3 py-2 text-right tabular-nums font-mono text-emerald-700">{fmtUgx(totalInflow)}</td>
                      <td className="px-3 py-2 text-right tabular-nums font-mono text-rose-700">{fmtUgx(totalOutflow)}</td>
                      <td />
                    </tr>
                  </tfoot>
                </table>
              </div>
            </div>
            <p className="mt-2 text-[11px] text-muted-foreground">
              Uganda calendar days (EAT). Money In and Money Out mirror each other because every
              movement is recorded as a balanced double entry — together they show the gross volume
              of transactions for the period. Tap a row to see what the transactions were for.
              {mode === 'daily' && dailyRows.length > DAILY_ROWS_SHOWN && (
                <> Showing the most recent {DAILY_ROWS_SHOWN} of {dailyRows.length} days.</>
              )}
            </p>
          </>
        )}
      </CardContent>
    </Card>
  );
}

const POOL_LINES_SHOWN = 6;

function FragmentRow({
  bucket,
  isOpen,
  onToggle,
  categoriesLoading,
  poolGroups,
}: {
  bucket: PeriodBucket;
  isOpen: boolean;
  onToggle: () => void;
  categoriesLoading: boolean;
  poolGroups?: PoolGroup[];
}) {
  return (
    <>
      <tr
        className="hover:bg-muted/30 cursor-pointer select-none"
        onClick={onToggle}
        aria-expanded={isOpen}
      >
        <td className="px-3 py-2 font-medium">{bucket.label}</td>
        <td className="px-3 py-2 text-right tabular-nums font-mono text-emerald-700">{fmtUgx(bucket.inflow)}</td>
        <td className="px-3 py-2 text-right tabular-nums font-mono text-rose-700">{fmtUgx(bucket.outflow)}</td>
        <td className="px-2 py-2 text-muted-foreground">
          {isOpen ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
        </td>
      </tr>
      {isOpen && (
        <tr className="bg-muted/20">
          <td colSpan={4} className="px-3 py-3">
            <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground mb-2">
              What the transactions were for — {bucket.label}
            </p>
            {categoriesLoading ? (
              <div className="flex items-center gap-2 py-3 text-xs text-muted-foreground">
                <Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading breakdown…
              </div>
            ) : !poolGroups?.length ? (
              <p className="py-2 text-xs text-muted-foreground">No transactions recorded in this period.</p>
            ) : (
              <div className="space-y-2">
                {poolGroups.map((g) => {
                  const shown = g.lines.slice(0, POOL_LINES_SHOWN);
                  const hiddenCount = g.lines.length - shown.length;
                  return (
                    <div key={g.pool} className="rounded-md border border-border/60 overflow-hidden bg-background">
                      <div className="flex items-center justify-between gap-3 bg-primary/5 px-2.5 py-1.5">
                        <span className="text-[11px] font-semibold tracking-tight">{g.pool}</span>
                        <span className="text-[10px] tabular-nums font-mono text-muted-foreground">
                          In {fmtUgx(g.inflow)} · Out {fmtUgx(g.outflow)}
                        </span>
                      </div>
                      <table className="w-full text-xs">
                        <thead className="bg-muted/40">
                          <tr className="text-[10px] uppercase tracking-wider text-muted-foreground">
                            <th className="text-left px-2.5 py-1.5 font-semibold">Purpose</th>
                            <th className="text-right px-2.5 py-1.5 font-semibold text-emerald-700">In</th>
                            <th className="text-right px-2.5 py-1.5 font-semibold text-rose-700">Out</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-border/60">
                          {shown.map((c) => (
                            <tr key={c.category}>
                              <td className="px-2.5 py-1.5">{c.label}</td>
                              <td className="px-2.5 py-1.5 text-right tabular-nums font-mono text-emerald-700">
                                {c.inflow ? fmtUgx(c.inflow) : '—'}
                              </td>
                              <td className="px-2.5 py-1.5 text-right tabular-nums font-mono text-rose-700">
                                {c.outflow ? fmtUgx(c.outflow) : '—'}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                      {hiddenCount > 0 && (
                        <p className="px-2.5 py-1.5 text-[10px] text-muted-foreground bg-muted/30">
                          + {hiddenCount} more purpose{hiddenCount === 1 ? '' : 's'} with smaller amounts
                        </p>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </td>
        </tr>
      )}
    </>
  );
}
