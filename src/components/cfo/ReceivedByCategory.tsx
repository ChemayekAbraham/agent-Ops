import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { addDays, format, subDays, subMonths } from 'date-fns';
import { ArrowDownLeft, ArrowUpRight, ChevronLeft, ChevronRight, Coins, Info, Search } from 'lucide-react';
import { supabase } from '@/integrations/supabase/client';
import { cfoReportRetry } from '@/hooks/cfoReportRetry';
import { formatUGX } from '@/lib/creditFeeCalculations';
import { kampalaDate, monthStart } from '@/components/cfo/MoneyDrilldownReport';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

/**
 * READ-ONLY "Money In" report for the CFO dashboard (section id received-by-category).
 *
 * Every figure comes from the server-side authoritative report
 * (`get_cfo_received_by_category_totals` / `get_cfo_received_by_category_page`) over
 * confirmed production ledger payment legs. Nothing here writes or changes a
 * wallet, balance, ledger entry or payout. Custody movements (wallet
 * withdrawals/transfers, float cycles) are not company payments and are
 * excluded by the server definition, so no category is counted twice.
 */

type CategoryRow = {
  category_key: string;
  category_label: string;
  sort_order: number;
  amount: number;
  tx_count: number;
  pct: number;
  nature: 'income' | 'capital' | 'recovery';
};

const NATURE: Record<CategoryRow['nature'], { label: string; cls: string }> = {
  income: { label: 'Income', cls: 'bg-success/15 text-success' },
  capital: { label: 'Capital — not income', cls: 'bg-warning/15 text-warning' },
  recovery: { label: 'Recovery — not income', cls: 'bg-muted text-muted-foreground' },
};

type PaidRow = {
  id: string;
  transaction_date: string;
  created_at: string;
  category_key: string;
  category_label: string;
  ledger_category: string;
  amount: number;
  description: string | null;
  reference_id: string | null;
  counterparty: string | null;
  counterparty_phone: string | null;
  source_table: string | null;
  classification: string | null;
};

const PAGE = 50;

/** Kampala-day window presets, newest bound = today (Kampala). */
type PresetKey = 'this_month' | '7d' | '30d' | '3m' | 'custom';

const PRESETS: { key: PresetKey; label: string }[] = [
  { key: 'this_month', label: 'This month' },
  { key: '7d', label: 'Last 7 days' },
  { key: '30d', label: 'Last 30 days' },
  { key: '3m', label: 'Last 3 months' },
  { key: 'custom', label: 'Custom' },
];

export function resolveReceivedWindow(kind: PresetKey, from: string, to: string): { from: string; to: string; label: string } {
  const today = kampalaDate();
  switch (kind) {
    case 'this_month':
      return { from: monthStart(), to: today, label: `${monthStart()} – ${today}` };
    case '7d':
      return { from: format(subDays(new Date(`${today}T00:00:00Z`), 6), 'yyyy-MM-dd'), to: today, label: `Last 7 days to ${today}` };
    case '30d':
      return { from: format(subDays(new Date(`${today}T00:00:00Z`), 29), 'yyyy-MM-dd'), to: today, label: `Last 30 days to ${today}` };
    case '3m':
      return { from: format(subMonths(new Date(`${today}T00:00:00Z`), 3), 'yyyy-MM-dd'), to: today, label: `Last 3 months to ${today}` };
    default:
      return { from, to, label: `${from || 'earliest'} – ${to || 'latest'}` };
  }
}

const when = (r: PaidRow) =>
  new Date(r.transaction_date ?? r.created_at).toLocaleString('en-GB', { timeZone: 'Africa/Kampala' });

const prettyLedgerCategory = (c: string) =>
  c.split('_').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');

const fmtDay = (d: string) => (d ? format(new Date(`${d}T00:00:00Z`), 'd MMM yyyy') : '');

export function ReceivedByCategory() {
  const [preset, setPreset] = useState<PresetKey>('this_month');
  const [customFrom, setCustomFrom] = useState('');
  const [customTo, setCustomTo] = useState('');
  // Applied filters: only these reach the server (form state stays local).
  const [applied, setApplied] = useState<{ from: string; to: string }>(() => ({
    from: monthStart(), to: kampalaDate(),
  }));
  const [appliedCategory, setAppliedCategory] = useState<string>('all');
  const [appliedSearch, setAppliedSearch] = useState('');
  const [searchDraft, setSearchDraft] = useState('');
  const [offset, setOffset] = useState(0);

  const windowLabel = useMemo(
    () => resolveReceivedWindow(preset, customFrom, customTo),
    [preset, customFrom, customTo],
  );

  const applyWindow = (kind: PresetKey) => {
    setPreset(kind);
    if (kind === 'custom') return; // custom applies through the Apply button
    const w = resolveReceivedWindow(kind, '', '');
    setApplied({ from: w.from, to: w.to });
    setOffset(0);
  };

  const applyCustom = () => {
    if (!customFrom && !customTo) return;
    const from = customFrom || '2020-01-01';
    const to = customTo || kampalaDate();
    setApplied({ from, to });
    setOffset(0);
  };

  const totals = useQuery({
    queryKey: ['cfo-received-by-category-totals', applied.from, applied.to],
    queryFn: async (): Promise<CategoryRow[]> => {
      const { data, error } = await (supabase.rpc as any)('get_cfo_received_by_category_totals', {
        p_from: applied.from, p_to: applied.to,
      });
      if (error) throw error;
      return (data ?? []) as CategoryRow[];
    },
    retry: cfoReportRetry,
    staleTime: 60_000,
  });

  const page = useQuery({
    queryKey: ['cfo-received-by-category-page', applied.from, applied.to, appliedCategory, appliedSearch, offset],
    queryFn: async () => {
      const { data, error } = await (supabase.rpc as any)('get_cfo_received_by_category_page', {
        p_from: applied.from, p_to: applied.to,
        p_category: appliedCategory === 'all' ? null : appliedCategory,
        p_search: appliedSearch.trim() ? appliedSearch.trim() : null,
        p_offset: offset, p_limit: PAGE,
      });
      if (error) throw error;
      const rows = (data ?? []) as PaidRow[];
      return { rows, matched: rows.length ? Number((rows[0] as any).total_matched ?? rows.length) : 0 };
    },
    retry: cfoReportRetry,
    staleTime: 60_000,
  });

  const rows = totals.data ?? [];
  const grand = rows.reduce((s, r) => s + r.amount, 0);
  const grandCount = rows.reduce((s, r) => s + r.tx_count, 0);
  const incomeTotal = rows.filter(r => r.nature === 'income').reduce((s, r) => s + r.amount, 0);

  const pageRows = page.data?.rows ?? [];
  const matched = page.data?.matched ?? 0;
  const showing = `${matched === 0 ? 0 : offset + 1}–${Math.min(offset + pageRows.length, matched)} of ${matched.toLocaleString()}`;

  return (
    <div className="space-y-4">
      <div className="rounded-md border border-border/70 bg-card p-4 shadow-sm">
        <div className="flex flex-wrap items-center gap-2">
          <Coins className="h-4 w-4 text-primary shrink-0" />
          <h2 className="text-sm font-semibold">Money In</h2>
        </div>
        <p className="mt-1 text-xs text-muted-foreground">
          Money the company received — total, transaction count and share of total for each category,
          from confirmed receipts in the ledger. Each tile shows whether it is income, capital or a recovery. Reporting only: nothing here moves money.
        </p>

        {/* Date window */}
        <div className="mt-3 flex flex-wrap items-center gap-1.5" role="group" aria-label="Date period">
          {PRESETS.map(p => (
            <button key={p.key} type="button" onClick={() => applyWindow(p.key)}
              aria-pressed={preset === p.key}
              className={`rounded-full border px-3 py-1.5 text-xs font-medium transition-colors ${
                preset === p.key
                  ? 'border-primary bg-primary/10 text-primary'
                  : 'border-border bg-background text-muted-foreground hover:bg-muted/50'
              }`}>
              {p.label}
            </button>
          ))}
        </div>
        {preset === 'custom' && (
          <div className="mt-2 flex flex-wrap items-end gap-2">
            <label className="text-xs text-muted-foreground">
              From
              <Input type="date" value={customFrom} onChange={e => setCustomFrom(e.target.value)}
                className="mt-1 h-8 w-40 text-xs" max={kampalaDate()} />
            </label>
            <label className="text-xs text-muted-foreground">
              To
              <Input type="date" value={customTo} onChange={e => setCustomTo(e.target.value)}
                className="mt-1 h-8 w-40 text-xs" max={kampalaDate()} />
            </label>
            <Button type="button" size="sm" variant="outline" className="h-8 px-3 text-xs"
              onClick={applyCustom} disabled={!customFrom && !customTo}>
              Apply dates
            </Button>
          </div>
        )}
        <p className="mt-2 text-[11px] text-muted-foreground">
          {totals.isLoading ? 'Loading…' : totals.error ? 'Could not load the period breakdown' : `${fmtDay(applied.from)} – ${fmtDay(applied.to)} (Kampala days)`}
        </p>
      </div>

      {/* Category tiles + grand total */}
      {totals.error ? (
        <div className="rounded-md border border-destructive/30 bg-destructive/5 p-4 text-xs text-destructive">
          Could not load the Money In breakdown. Try again shortly.
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2 lg:grid-cols-4">
          <div className="rounded-md border border-primary/30 bg-primary/5 p-4 shadow-sm">
            <p className="text-[11px] font-medium uppercase tracking-wide text-primary">Grand total received</p>
            <p className="mt-1 text-lg font-bold tabular-nums">
              {totals.isLoading ? '…' : totals.error ? 'Unavailable' : formatUGX(grand)}
            </p>
            <p className="mt-0.5 text-[11px] text-muted-foreground">
              {totals.isLoading ? '' : totals.error ? '' : `${grandCount.toLocaleString()} transactions · genuine income ${formatUGX(incomeTotal)}`}
            </p>
          </div>
          {rows.map(r => (
            <button key={r.category_key} type="button"
              onClick={() => { setAppliedCategory(r.category_key); setOffset(0); }}
              aria-pressed={appliedCategory === r.category_key}
              className={`rounded-md border p-4 text-left shadow-sm transition-colors ${
                appliedCategory === r.category_key
                  ? 'border-primary bg-primary/5'
                  : 'border-border/70 bg-card hover:bg-muted/40'
              }`}>
              <p className="truncate text-[11px] font-semibold text-foreground" title={r.category_label}>{r.category_label}</p>
              <span className={`mt-1 inline-flex rounded-full px-2 py-0.5 text-[10px] font-medium ${NATURE[r.nature]?.cls ?? ''}`}>{NATURE[r.nature]?.label}</span>
              <p className="mt-1 text-sm font-bold tabular-nums">{formatUGX(r.amount)}</p>
              <p className="mt-0.5 text-[11px] text-muted-foreground">
                {r.tx_count.toLocaleString()} transactions · {r.pct.toFixed(2)}% of total
              </p>
              <span className="mt-2 block h-1.5 w-full overflow-hidden rounded-full bg-muted" aria-hidden="true">
                <span className="block h-full rounded-full bg-primary/70" style={{ width: `${Math.min(r.pct, 100)}%` }} />
              </span>
            </button>
          ))}
        </div>
      )}

      {/* Transaction table */}
      <div className="rounded-md border border-border/70 bg-card shadow-sm">
        <div className="flex flex-col gap-2 border-b border-border/60 p-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-center gap-2 min-w-0">
            <span className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-md ${
              appliedCategory === 'all' ? 'bg-primary/10 text-primary' : 'bg-warning/10 text-warning'
            }`}>
              {appliedCategory === 'all' ? <Coins className="h-4 w-4" /> : <Info className="h-4 w-4" />}
            </span>
            <p className="truncate text-xs font-semibold">
              {appliedCategory === 'all'
                ? 'All received transactions'
                : `${rows.find(r => r.category_key === appliedCategory)?.category_label ?? 'Category'} only`}
            </p>
            {appliedCategory !== 'all' && (
              <Button type="button" size="sm" variant="ghost" className="h-7 px-2 text-[11px]"
                onClick={() => { setAppliedCategory('all'); setOffset(0); }}>
                Show all
              </Button>
            )}
          </div>
          <form className="flex items-center gap-1.5" onSubmit={e => { e.preventDefault(); setAppliedSearch(searchDraft); setOffset(0); }}>
            <div className="relative">
              <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input value={searchDraft} onChange={e => setSearchDraft(e.target.value)}
                placeholder="Search payer, reference, description…"
                className="h-8 w-full min-w-52 pl-7 text-xs sm:w-64" aria-label="Search received transactions" />
            </div>
            <Button type="submit" size="sm" variant="outline" className="h-8 px-3 text-xs">Search</Button>
          </form>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full min-w-[720px] text-left text-xs">
            <thead>
              <tr className="border-b border-border/60 text-[11px] uppercase tracking-wide text-muted-foreground">
                <th className="px-3 py-2 font-medium">Date/time</th>
                <th className="px-3 py-2 font-medium">Category</th>
                <th className="px-3 py-2 font-medium">Type</th>
                <th className="px-3 py-2 text-right font-medium">Amount</th>
                <th className="px-3 py-2 font-medium">Received from</th>
                <th className="px-3 py-2 font-medium">Reference</th>
                <th className="px-3 py-2 font-medium">Description</th>
                <th className="px-3 py-2 font-medium">Record</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border/50">
              {page.isLoading && (
                <tr><td colSpan={8} className="px-3 py-6 text-center text-muted-foreground">Loading transactions…</td></tr>
              )}
              {page.error && (
                <tr><td colSpan={8} className="px-3 py-6 text-center text-destructive">Could not load transactions. Try again shortly.</td></tr>
              )}
              {!page.isLoading && !page.error && pageRows.map(r => (
                <tr key={r.id} className="align-top">
                  <td className="whitespace-nowrap px-3 py-2 text-muted-foreground">{when(r)}</td>
                  <td className="px-3 py-2 font-medium">{r.category_label}</td>
                  <td className="px-3 py-2 text-muted-foreground">{prettyLedgerCategory(r.ledger_category)}</td>
                  <td className="whitespace-nowrap px-3 py-2 text-right font-medium tabular-nums">{formatUGX(r.amount)}</td>
                  <td className="px-3 py-2">
                    {r.counterparty
                      ? <span className="block">{r.counterparty}<span className="block text-[10px] text-muted-foreground">{r.counterparty_phone}</span></span>
                      : <span className="text-muted-foreground">—</span>}
                  </td>
                  <td className="px-3 py-2 break-words text-muted-foreground">{r.reference_id || '—'}</td>
                  <td className="max-w-[240px] px-3 py-2 break-words text-muted-foreground">{r.description || '—'}</td>
                  <td className="px-3 py-2">
                    <span className={`inline-flex whitespace-nowrap rounded-full px-2 py-0.5 text-[10px] font-medium ${
                      r.classification === 'legacy_real' ? 'bg-muted text-muted-foreground' : 'bg-success/15 text-success'
                    }`}>
                      {r.classification === 'legacy_real' ? 'Historical' : 'Confirmed'}
                    </span>
                  </td>
                </tr>
              ))}
              {!page.isLoading && !page.error && pageRows.length === 0 && (
                <tr><td colSpan={8} className="px-3 py-6 text-center text-muted-foreground">No received transactions in this window.</td></tr>
              )}
            </tbody>
          </table>
        </div>

        <div className="flex items-center justify-between border-t border-border/60 p-3">
          <p className="text-[11px] text-muted-foreground">Showing {showing}</p>
          <div className="flex items-center gap-1.5">
            <Button type="button" size="sm" variant="outline" className="h-8 px-2.5"
              disabled={offset === 0 || page.isLoading}
              onClick={() => setOffset(Math.max(0, offset - PAGE))} aria-label="Previous page">
              <ChevronLeft className="h-4 w-4" />
            </Button>
            <Button type="button" size="sm" variant="outline" className="h-8 px-2.5"
              disabled={offset + PAGE >= matched || page.isLoading}
              onClick={() => setOffset(offset + PAGE)} aria-label="Next page">
              <ChevronRight className="h-4 w-4" />
            </Button>
          </div>
        </div>
      </div>

      <div className="flex items-start gap-2 rounded-md border border-border/60 bg-muted/30 p-3">
        <ArrowDownLeft className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        <p className="text-[11px] text-muted-foreground">
          <ArrowUpRight className="mr-1 inline h-3 w-3" aria-hidden="true" />
          Basis: confirmed production company-side receipt legs in the ledger, Kampala dates, classified by
          their recorded ledger category (never by description). Only Fees and Other Income are genuine income;
          Partner money is capital owed back to Supporters, Rent Plan and agent repayments are recoveries of money
          already paid out. Wallet transfers, float cycles, cash in transit, bank deposits, compounding and
          Returns credits are internal movements and are excluded, so nothing is counted twice.
        </p>
      </div>
    </div>
  );
}

export default ReceivedByCategory;
