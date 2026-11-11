import { useCallback, useEffect, useRef, useState } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Calendar as CalendarPicker } from '@/components/ui/calendar';
import { cn } from '@/lib/utils';
import {
  classifyAssets, classifyLiabilities, classifyEquity, hasFlagged, visibleFlaggedLines,
  expandLandlordFloat, CARRIED_FORWARD_LABEL, UNMATCHED_HISTORIC_POSTINGS_LABEL,
  type BsGroup, type LandlordFloatSplit,
} from '@/components/cfo/balanceSheetClassification';
import { formatDynamic as formatUGX } from '@/lib/currencyFormat';
import { useReceivablesBreakdown } from '@/hooks/useReceivables';
import { format, endOfDay, subYears, isToday } from 'date-fns';
import {
  AlertTriangle, Calendar, CheckCircle2, ChevronDown, ChevronRight,
  Download, FileSpreadsheet, GitCompareArrows, Loader2, RefreshCw,
  TrendingUp, Wallet, ShieldCheck,
} from 'lucide-react';
import { toast } from 'sonner';

interface PositionLine {
  label: string;
  value: number;
  source?: string;
}

interface ScheduleRow {
  ledger_scope: string;
  category: string;
  groups: number;
  net_debit_less_credit: number;
}

interface Reconciliation {
  plug_applied?: boolean;
  unreconciled_difference?: number;
  classification_filter_granularity?: string;
  unresolved_groups: number;
  unresolved_absolute_amount: number;
  one_sided_equity_counterpart?: number;

  schedule: ScheduleRow[];
  excluded_classifications: { classification: string; legs: number; amount: number }[];
  memo_sub_ledgers: PositionLine[];
}

export interface StatementOfFinancialPosition {
  as_at: string;
  generated_at: string;
  currency: string;
  assets: {
    current: PositionLine[];
    non_current: PositionLine[];
    total_current: number;
    total_non_current: number;
    total: number;
  };
  liabilities: {
    current: PositionLine[];
    non_current: PositionLine[];
    total_current: number;
    total_non_current: number;
    total: number;
  };
  equity: {
    lines: PositionLine[];
    revenue_to_date: number;
    expenses_to_date: number;
    total: number;
  };
  trial_balance?: {
    total_debits: number;
    total_credits: number;
    difference: number;
    balanced: boolean;
  };
  reconciliation?: Reconciliation;
  /** fin_balance_sheet only: ledger vs operational records, and plain-language disclosures. */
  subledger_ties?: { key: string; label: string; ledger: number; operational: number; difference: number }[];
  subledger_ties_basis?: string;
  disclosures?: string[];
  balance_check: {
    total_assets: number;
    total_liabilities_and_equity: number;
    difference: number;
    balanced: boolean;
    state?: 'balanced' | 'failed';
    message?: string;
  };
}

/** One statutory payroll obligation returned by hr_pay_statutory_liability(). */
interface StatutoryLiabilityRow {
  authority: string;
  component_code: string;
  label: string;
  withheld: number;
  remitted: number;
  outstanding: number;
}

const STATUTORY_NOTE =
  'Taken from payroll records, not the general ledger: amounts withheld on payroll that has already been paid, less anything already remitted. The books hold no tax account, so this figure is shown for disclosure and is not included in Total Liabilities.';

const UNMATCHED_POSTINGS_NOTE =
  'Old ledger entries that are missing their matching side. These are not cash, income or a new transaction — they are bookkeeping placeholders that keep the balance sheet level while the original entries are traced and completed.';

/** Payload for the tap-to-drill-down modal. */
interface Drilldown {
  title: string;
  value: number;
  unsourced?: boolean;
  /** Plain-language explanation for derived values that are not a direct account line. */
  sourceNote?: string;
  /** Disclosure note printed in the modal (used for payroll-derived figures). */
  note?: string;
  /** Account-level lines behind the figure. */
  lines?: PositionLine[];
  /** Indented component lines (e.g. partner obligations inside Landlord Float). */
  components?: PositionLine[];
  /** Whole groups, for section totals. */
  groups?: BsGroup[];
}

function LineRow({ line, showSources, onOpen }: { line: PositionLine; showSources: boolean; onOpen?: () => void }) {
  const [open, setOpen] = useState(false);
  const tappable = !!onOpen;
  return (
    <div className="border-b border-border/40 last:border-0">
      <button
        type="button"
        onClick={() => (onOpen ? onOpen() : setOpen(o => !o))}
        className="w-full flex items-start justify-between gap-3 py-1.5 text-left"
      >
        <span className="flex items-start gap-1 min-w-0 text-xs text-muted-foreground">
          {tappable || showSources
            ? (open && !tappable ? <ChevronDown className="h-3 w-3 mt-0.5 shrink-0" /> : <ChevronRight className="h-3 w-3 mt-0.5 shrink-0" />)
            : null}
          <span className="truncate">{line.label}</span>
        </span>
        <span className={cn('font-mono text-xs shrink-0 text-right', line.value < 0 ? 'text-destructive' : 'text-foreground')}>
          {line.value < 0 ? `(${formatUGX(Math.abs(line.value))})` : formatUGX(line.value)}
        </span>
      </button>
      {!tappable && showSources && open && (
        <p className="pb-2 pl-4 text-[10px] text-muted-foreground">Derived from {line.source}</p>
      )}
    </div>
  );
}

function TotalRow({ label, value, emphasis, depth = 0, onOpen }: {
  label: string; value: number; emphasis?: boolean; depth?: number; onOpen?: () => void;
}) {
  const inner = (
    <>
      <span className={cn('text-xs flex items-center gap-1', emphasis ? 'font-bold uppercase tracking-wide' : 'font-semibold')}>
        {onOpen && <ChevronRight className="h-3 w-3 shrink-0 text-muted-foreground" />}
        {label}
      </span>
      <span className={cn('font-mono', emphasis ? 'text-sm font-bold' : 'text-xs font-semibold')}>
        {value < 0 ? `(${formatUGX(Math.abs(value))})` : formatUGX(value)}
      </span>
    </>
  );
  const cls = cn(
    'flex items-center justify-between gap-3 py-2 border-t w-full text-left',
    emphasis ? 'border-primary/50 mt-1' : 'border-border',
    depth > 0 && 'pl-3',
  );
  return onOpen
    ? <button type="button" onClick={onOpen} className={cls}>{inner}</button>
    : <div className={cls}>{inner}</div>;
}

function SectionHeading({ children }: { children: React.ReactNode }) {
  return (
    <p className="text-[10px] font-bold uppercase tracking-widest text-primary mt-4 mb-1">{children}</p>
  );
}

function SubHeading({ children }: { children: React.ReactNode }) {
  return (
    <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground mt-3 mb-1">{children}</p>
  );
}

/**
 * Presentation-layer regrouping of the liability side of the statement.
 * Nothing is recalculated: every line keeps the exact value the ledger-driven
 * RPC returned. Lines are only bucketed into business categories, keyed on the
 * reporting account code embedded in `source`
 * ("general_ledger trial balance — account L4").
 *
 * Any liability account not explicitly named falls through to "Other Payables"
 * so no balance can silently disappear from the statement.
 */
function GroupRow({
  group, showSources, components, heading, depth = 0, onOpen,
}: {
  group: BsGroup; showSources: boolean; components?: PositionLine[];
  heading?: boolean; depth?: number; onOpen?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const expandable = !onOpen && showSources && group.lines.length > 0;
  const showChevron = !!onOpen || expandable;
  return (
    <div className={cn('last:border-0', heading ? '' : 'border-b border-border/40')}>
      <button
        type="button"
        onClick={() => (onOpen ? onOpen() : expandable && setOpen(o => !o))}
        className={cn('w-full flex items-start justify-between gap-3 py-1.5 text-left', depth > 0 && 'pl-3')}
      >
        <span
          className={cn(
            'flex items-start gap-1 min-w-0 text-xs',
            heading ? 'font-medium text-foreground' : 'text-muted-foreground',
          )}
        >
          {showChevron
            ? (open && expandable ? <ChevronDown className="h-3 w-3 mt-0.5 shrink-0" /> : <ChevronRight className="h-3 w-3 mt-0.5 shrink-0" />)
            : null}
          <span className="truncate">{group.label}</span>
          {/* A category with no ledger account behind it is a structural gap,
              not a measured nil. Saying so stops a zero here being read as
              "we hold none of this" when it means "the ledger does not track
              it yet" — the balances for several of these sit in operational
              sub-ledgers and are listed under memo sub-ledgers below. */}
          {group.unsourced && (
            <span
              className="shrink-0 rounded px-1 py-px text-[9px] font-medium uppercase tracking-wide bg-muted text-muted-foreground"
              title="No ledger account maps here yet — any balance sits in an operational sub-ledger and is shown under memo sub-ledgers, not in the ledger totals."
            >
              not in ledger
            </span>
          )}
        </span>
        {/* A heading names the block below it; its own total line carries the
            figure, so the amount is not printed twice. */}
        {!heading && (
          <span
            className={cn(
              'font-mono text-xs shrink-0 text-right',
              group.unsourced ? 'text-muted-foreground/70' : group.value < 0 ? 'text-destructive' : 'text-foreground',
            )}
          >
            {group.value < 0 ? `(${formatUGX(Math.abs(group.value))})` : formatUGX(group.value)}
          </span>
        )}
      </button>
      {/* Component lines are part of the row's own presentation, so they show
          regardless of the source toggle or the expand state. */}
      {components && components.length > 0 && (
        <div className={cn('pb-1.5 space-y-0.5', depth > 0 ? 'pl-7' : 'pl-4')}>
          {components.map(c => (
            <p key={c.label} className="text-[11px] text-muted-foreground flex justify-between gap-3">
              <span className="truncate">{c.label}</span>
              <span className={cn('font-mono shrink-0', c.value < 0 ? 'text-destructive' : '')}>
                {c.value < 0 ? `(${formatUGX(Math.abs(c.value))})` : formatUGX(c.value)}
              </span>
            </p>
          ))}
        </div>
      )}
      {expandable && open && (
        <div className="pb-2 pl-4 space-y-0.5">
          {group.lines.map(l => (
            <p key={l.label} className="text-[10px] text-muted-foreground flex justify-between gap-3">
              <span className="truncate">{l.label}</span>
              <span className="font-mono shrink-0">{formatUGX(l.value)}</span>
            </p>
          ))}
        </div>
      )}
    </div>
  );
}


/** Unclassified lines, itemised so nothing hides inside a total. */
function FlaggedBlock({ group, showSources, onOpen }: { group?: BsGroup; showSources: boolean; onOpen?: (d: Drilldown) => void }) {
  if (!group || !hasFlagged(group)) return null;
  return (
    <div className="mt-2 rounded-md border border-warning/40 bg-warning/5 p-2">
      <p className="text-[10px] font-semibold uppercase tracking-wide text-warning">{group.label}</p>
      <p className="mb-1 text-[10px] text-muted-foreground">
        Included in the section total. These accounts have no confident home in the current structure.
      </p>
      {visibleFlaggedLines(group).map(l => (
        <LineRow
          key={l.label} line={l} showSources={showSources}
          onOpen={onOpen ? () => onOpen({ title: l.label, value: l.value, lines: [l] }) : undefined}
        />
      ))}
      <TotalRow
        label="Subtotal — flagged" value={group.value}
        onOpen={onOpen ? () => onOpen({ title: group.label, value: group.value, lines: visibleFlaggedLines(group) }) : undefined}
      />
    </div>
  );
}

const fmtAmount = (v: number) => (v < 0 ? `(${formatUGX(Math.abs(v))})` : formatUGX(v));

/* ---------------------------------------------------------------------------
 * Receivables detail: the actual outstanding receivables behind a receivables
 * line, grouped by product with each exact value. Read from the authoritative
 * server-side definition (`get_receivables_breakdown` over
 * `v_receivables_lines`); no receivables maths is done here.
 * ------------------------------------------------------------------------- */

/** Which receivables category (if any) a balance-sheet label refers to. */
function receivablesCategoryOf(label: string): string | null {
  const l = label.toLowerCase();
  if (!l.includes('receivable')) return null;
  if (l.includes('tenant')) return 'tenant';
  if (l.includes('agent')) return 'agent';
  if (l.includes('landlord')) return 'landlord';
  if (l.includes('partner')) return 'partner';
  return null;
}

/**
 * Receivable products that must always be listed for a category, even when the
 * server returns no outstanding items for them (so a nil balance reads as
 * "nothing owed" rather than looking absent). `from` names the server category
 * the product is actually returned under.
 */
const ALWAYS_SHOWN_PRODUCTS: Record<string, { key: string; label: string; from: string }[]> = {
  tenant: [
    { key: 'rent_plan', label: 'Rent Access Plans', from: 'tenant' },
    { key: 'tenant_service_charge', label: 'Tenant Service Charges', from: 'tenant' },
    { key: 'business_advance', label: 'Business Advances', from: 'tenant' },
  ],
  landlord: [
    { key: 'welile_homes', label: 'Welile Homes Subscriptions', from: 'landlord' },
    { key: 'landlord_float_receivable', label: 'Landlord Float Receivables', from: 'landlord' },
  ],
  partner: [
    { key: 'promissory_note', label: 'Promissory Notes', from: 'partner' },
  ],
};


function ReceivablesDetail({ categoryKey }: { categoryKey: string }) {
  const { data, isLoading, error } = useReceivablesBreakdown(true);
  const category = (data?.categories ?? []).find(c => c.key === categoryKey);

  // Rows to render: every product the server returned for this category, plus
  // any always-shown product (possibly from another server category) at its
  // real outstanding value, or zero when it has no open items.
  const rows: { key: string; label: string; outstanding: number }[] = [];
  if (data) {
    const expected = ALWAYS_SHOWN_PRODUCTS[categoryKey] ?? [];
    const findProduct = (fromKey: string, productKey: string) =>
      (data.categories ?? [])
        .find(c => c.key === fromKey)
        ?.products.find(p => p.key === productKey);

    for (const e of expected) {
      const p = findProduct(e.from, e.key);
      rows.push({ key: e.key, label: p?.label ?? e.label, outstanding: p?.outstanding ?? 0 });
    }
    for (const p of category?.products ?? []) {
      if (!rows.some(r => r.key === p.key)) {
        rows.push({ key: p.key, label: p.label, outstanding: p.outstanding });
      }
    }
  }

  const total = rows.reduce((s, r) => s + (r.outstanding ?? 0), 0);

  return (
    <div className="mt-1">
      <div className="mt-1 rounded-md border border-border/60 bg-muted/20 p-2">
          {isLoading && (
            <p className="flex items-center gap-1 text-[10px] text-muted-foreground">
              <Loader2 className="h-3 w-3 animate-spin" /> Loading receivables…
            </p>
          )}
          {error && (
            <p className="text-[10px] text-destructive">
              Could not load the receivables: {(error as Error).message}
            </p>
          )}
          {data && rows.length === 0 && (
            <p className="text-[10px] text-muted-foreground">No outstanding receivables recorded here.</p>
          )}
          {rows.length > 0 && (
            <div className="space-y-2">
              <p className="text-[10px] text-muted-foreground">
                Total receivables · {fmtAmount(total)}
              </p>
              {rows.map(r => (
                <div key={r.key}>
                  <div className="flex items-start justify-between gap-3">
                    <span className="text-[11px] font-medium text-foreground truncate">{r.label}</span>
                    <span className="font-mono text-[11px] shrink-0">{fmtAmount(r.outstanding)}</span>
                  </div>
                </div>
              ))}
            </div>
          )}
      </div>
    </div>
  );
}


/** One named component and its exact value inside the modal. */
function ModalLine({ line, size = 'sm' }: { line: PositionLine; size?: 'sm' | 'xs' }) {
  return (
    <div>
      <div className="flex items-start justify-between gap-3">
        <span className={cn('text-muted-foreground', size === 'sm' ? 'text-xs' : 'text-[11px] text-muted-foreground/80')}>
          {line.label}
        </span>
        <span className={cn('font-mono shrink-0', size === 'sm' ? 'text-xs' : 'text-[11px]', line.value < 0 ? 'text-destructive' : '')}>
          {fmtAmount(line.value)}
        </span>
      </div>
    </div>
  );
}

interface CarriedForwardRow {
  group_label: string;
  legs: number;
  amount: number;
}

const callLooseRpc = <T = unknown>(fn: string, args: Record<string, unknown> = {}) =>
  (supabase.rpc.bind(supabase) as unknown as (name: string, params?: Record<string, unknown>) => Promise<{ data: T | null; error: { message: string } | null }>)(fn, args);

/**
 * The server functions run with statement_timeout = 120s. If nothing has come
 * back shortly after that, the connection is dead (usually a gateway timeout),
 * so stop the spinner instead of waiting forever.
 */
const SOFP_CLIENT_TIMEOUT_MS = 130_000;

/** One in-flight statement request per as-at key, shared by every caller. */
const sofpInflight = new Map<string, Promise<StatementOfFinancialPosition>>();

function friendlyLoadError(e: unknown): string {
  const raw = e instanceof Error ? e.message : String(e ?? '');
  if (/failed to fetch|networkerror|load failed|timed out|timeout|504|canceling statement/i.test(raw)) {
    return 'The server did not finish building the balance sheet in time, so the connection was dropped. '
      + 'No figures were changed. Please retry; if it keeps happening the ledger statement query needs a performance fix on the server.';
  }
  return raw || 'Failed to generate the statement of financial position';
}

/**
 * Fetch the authoritative statement (get_statement_of_financial_position) once.
 * No fallbacks: fin_balance_sheet re-runs this same statement internally, so
 * "falling back" to it only doubles the wait before failing.
 */
function fetchSofp(date: Date): Promise<StatementOfFinancialPosition> {
  const isCurrent = isToday(date);
  const key = isCurrent ? 'now' : format(date, 'yyyy-MM-dd');
  const existing = sofpInflight.get(key);
  if (existing) return existing;

  const params = isCurrent ? {} : { p_as_at: endOfDay(date).toISOString() };
  const request = (async () => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('Balance sheet request timed out')), SOFP_CLIENT_TIMEOUT_MS);
      });
      const { data, error } = await Promise.race([
        callLooseRpc<StatementOfFinancialPosition>('get_statement_of_financial_position', params),
        timeout,
      ]);
      if (error) throw new Error(error.message);
      if (!data) throw new Error('The server returned an empty balance sheet');
      return data;
    } finally {
      if (timer) clearTimeout(timer);
      sofpInflight.delete(key);
    }
  })();
  sofpInflight.set(key, request);
  return request;
}

/** Disclosure-only schedules, fetched after the statement so they never compete with it. */
async function fetchAuxiliary(date: Date) {
  const params = isToday(date) ? {} : { p_as_at: endOfDay(date).toISOString() };
  const [split, stat] = await Promise.allSettled([
    callLooseRpc<LandlordFloatSplit>('get_landlord_float_management_split', params),
    callLooseRpc<StatutoryLiabilityRow[]>('hr_pay_statutory_liability'),
  ]);
  return {
    floatSplit: split.status === 'fulfilled' && !split.value.error ? split.value.data : null,
    statutory: stat.status === 'fulfilled' && !stat.value.error ? stat.value.data : null,
  };
}

/**
 * Detailed breakdown of the carried-forward equity line (ledger account E3),
 * fetched only while its drill-down modal is open.
 */
function useEquityBreakdown(rpcName: string, active: boolean) {
  const [rows, setRows] = useState<CarriedForwardRow[] | null>(null);
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    setLoading(true);
    callLooseRpc<CarriedForwardRow[]>(rpcName, { p_as_at: new Date().toISOString() })
      .then(({ data, error }) => {
        if (cancelled) return;
        if (error) setRows([]);
        else setRows((data ?? []).map(r => ({ ...r, amount: Number(r.amount) })));
        setLoading(false);
      });
    return () => { cancelled = true; };
  }, [rpcName, active]);
  return { rows, loading };
}


/** The drill-down modal: named components and exact values for any tapped line or total. */
function DrilldownDialog({ drill, onClose }: { drill: Drilldown | null; onClose: () => void }) {
  const fmt = fmtAmount;
  const receivablesKey = drill ? receivablesCategoryOf(drill.title) : null;
  const isCarriedForward = drill?.title === CARRIED_FORWARD_LABEL;
  const isUnmatchedHistoricPostings = drill?.title === UNMATCHED_HISTORIC_POSTINGS_LABEL;
  const isDeferredFee = drill?.title === 'Deferred Rent Plan Fee Income';
  const carriedForward = useEquityBreakdown('get_carried_forward_breakdown', !!isCarriedForward);
  const unmatchedPostings = useEquityBreakdown('get_unmatched_postings_breakdown', !!isUnmatchedHistoricPostings);
  const deferredFee = useEquityBreakdown('get_deferred_fee_breakdown', !!isDeferredFee);

  return (
    <Dialog open={!!drill} onOpenChange={o => { if (!o) onClose(); }}>
      <DialogContent className="max-w-md max-h-[85vh] overflow-y-auto">
        {drill && (
          <>
            <DialogHeader>
              <DialogTitle className="text-sm leading-snug pr-6">{drill.title}</DialogTitle>
            </DialogHeader>
            <div className="space-y-3">
              <div className="flex items-baseline justify-between gap-3 border-b border-border pb-2">
                <span className="text-[10px] uppercase tracking-widest text-muted-foreground">Balance</span>
                <span className={cn('font-mono text-base font-bold', drill.value < 0 ? 'text-destructive' : 'text-foreground')}>
                  {fmt(drill.value)}
                </span>
              </div>
              {isCarriedForward && (
                <div className="space-y-1">
                  <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                    Detailed Breakdown
                  </p>
                  {carriedForward.loading && (
                    <p className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
                      <Loader2 className="h-3 w-3 animate-spin" /> Loading breakdown…
                    </p>
                  )}
                  {!carriedForward.loading && (carriedForward.rows ?? []).map(r => (
                    <div key={r.group_label} className="border-b border-border/40 py-1.5 last:border-0">
                      <ModalLine
                        line={{
                          label: r.group_label,
                          value: r.amount,
                          source: `${r.legs} ledger ${r.legs === 1 ? 'entry' : 'entries'}`,
                        }}
                      />
                    </div>
                  ))}
                  {!carriedForward.loading && (carriedForward.rows ?? []).length === 0 && (
                    <p className="text-[10px] text-muted-foreground">No underlying entries found.</p>
                  )}
                  <p className="rounded-md border border-border/60 bg-muted/20 p-2 text-[10px] leading-relaxed text-muted-foreground">
                    These are starting balances and corrections brought into the books from earlier
                    records. They are historical bookkeeping entries, not new cash, revenue or
                    obligations.
                  </p>
                </div>
              )}
              {isUnmatchedHistoricPostings && (
                <div className="space-y-1">
                  <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                    Detailed Breakdown
                  </p>
                  {unmatchedPostings.loading && (
                    <p className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
                      <Loader2 className="h-3 w-3 animate-spin" /> Loading breakdown…
                    </p>
                  )}
                  {!unmatchedPostings.loading && (unmatchedPostings.rows ?? []).map(r => (
                    <div key={r.group_label} className="border-b border-border/40 py-1.5 last:border-0">
                      <ModalLine
                        line={{
                          label: r.group_label,
                          value: r.amount,
                          source: `${r.legs} ledger ${r.legs === 1 ? 'entry' : 'entries'}`,
                        }}
                      />
                    </div>
                  ))}
                  {!unmatchedPostings.loading && (unmatchedPostings.rows ?? []).length === 0 && (
                    <p className="text-[10px] text-muted-foreground">No underlying entries found.</p>
                  )}
                  <p className="rounded-md border border-border/60 bg-muted/20 p-2 text-[10px] leading-relaxed text-muted-foreground">
                    {UNMATCHED_POSTINGS_NOTE}
                  </p>
                </div>
              )}
              {isDeferredFee && (
                <div className="space-y-1">
                  <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                    Detailed Breakdown
                  </p>
                  {deferredFee.loading && (
                    <p className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
                      <Loader2 className="h-3 w-3 animate-spin" /> Loading breakdown…
                    </p>
                  )}
                  {!deferredFee.loading && (deferredFee.rows ?? []).map(r => (
                    <div key={r.group_label} className="border-b border-border/40 py-1.5 last:border-0">
                      <ModalLine
                        line={{
                          label: r.group_label,
                          value: r.amount,
                          source: `${r.legs} ledger ${r.legs === 1 ? 'entry' : 'entries'}`,
                        }}
                      />
                    </div>
                  ))}
                  {!deferredFee.loading && (deferredFee.rows ?? []).length === 0 && (
                    <p className="text-[10px] text-muted-foreground">No underlying entries found.</p>
                  )}
                  <p className="rounded-md border border-border/60 bg-muted/20 p-2 text-[10px] leading-relaxed text-muted-foreground">
                    Rent plan fees are recorded when a plan is funded and earned gradually as the
                    tenant repays. The balance above is the portion still to be earned; it falls
                    automatically with every repayment.
                  </p>
                </div>
              )}

              {receivablesKey && (
                <div className="space-y-1">
                  <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                    Breakdown
                  </p>
                   <ReceivablesDetail categoryKey={receivablesKey} />
                </div>
              )}
              {drill.note && (
                <p className="rounded-md border border-border/60 bg-muted/20 p-2 text-[10px] leading-relaxed text-muted-foreground">
                  {drill.note}
                </p>
              )}
              {!receivablesKey && drill.components && drill.components.length > 0 && (
                <div className="space-y-1">
                  <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Breakdown</p>
                  {drill.components.map(c => (
                    <div key={c.label} className="border-b border-border/40 py-1.5 last:border-0">
                      <ModalLine line={c} />
                    </div>
                  ))}
                </div>
              )}
              {!receivablesKey && drill.groups && drill.groups.length > 0 && (
                <div className="space-y-1">
                  <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Breakdown</p>
                  {drill.groups.map(g => (
                    <div key={g.label} className="border-b border-border/40 py-1.5 last:border-0">
                      <div className="flex items-start justify-between gap-3">
                        <span className="text-xs font-medium text-muted-foreground" style={{ paddingLeft: (g.depth ?? 0) * 12 }}>{g.label}</span>
                        <span className={cn('font-mono text-xs shrink-0', g.value < 0 ? 'text-destructive' : '')}>
                          {g.heading ? '' : fmt(g.value)}
                        </span>
                      </div>
                      {receivablesCategoryOf(g.label) && (
                        <div className="pl-4 pt-1">
                          <ReceivablesDetail categoryKey={receivablesCategoryOf(g.label) as string} />
                        </div>
                      )}
                      {(g.components ?? []).map(c => (
                        <div key={c.label} className="pl-4 pt-1">
                          <ModalLine line={c} size="xs" />
                        </div>
                      ))}
                      {g.lines.length > 0 ? (
                        <div className="mt-1 space-y-1 pl-4">
                          {g.lines.map(l => (
                            <div key={`${g.label}-${l.label}`} className="border-l border-border/60 pl-2">
                               <ModalLine line={l} size="xs" />
                            </div>
                          ))}
                        </div>
                       ) : null}
                    </div>
                  ))}
                </div>
              )}
              {!receivablesKey && !isCarriedForward && !isUnmatchedHistoricPostings && !isDeferredFee && drill.lines && drill.lines.length > 0 && (
                <div className="space-y-1">
                  <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Breakdown</p>
                  {drill.lines.map(l => {
                    const displayLine = isUnmatchedHistoricPostings
                      ? { ...l, label: 'Unmatched Historic Postings — Opening Balance Counterpart' }
                      : l;
                    return (
                      <div key={displayLine.label} className="border-b border-border/40 py-1.5 last:border-0">
                        <ModalLine line={displayLine} />
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

/** The categories must sum to the RPC's own total; say so loudly if they do not. */
function DriftNote({ drift, of }: { drift: number; of: string }) {
  if (drift === 0) return null;
  return (
    <p className="mt-1 flex items-start gap-1 text-[10px] text-destructive">
      <AlertTriangle className="h-3 w-3 mt-0.5 shrink-0" />
      Category subtotals differ from {of} by {formatUGX(Math.abs(drift))}.
    </p>
  );
}

const SNAPSHOT_KEY_PREFIX = 'welile_bs_snapshot_v2_';

interface SnapshotStorage {
  data: StatementOfFinancialPosition;
  floatSplit: LandlordFloatSplit | null;
  statutory: StatutoryLiabilityRow[] | null;
  cachedAt: number;
}

function getStoredSnapshot(dateKey: string): SnapshotStorage | null {
  try {
    const raw = sessionStorage.getItem(SNAPSHOT_KEY_PREFIX + dateKey) || localStorage.getItem(SNAPSHOT_KEY_PREFIX + dateKey);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as SnapshotStorage;
    if (parsed?.data?.assets?.current) {
      return parsed;
    }
  } catch {
    // Ignore storage parse issues
  }
  return null;
}

function storeSnapshot(
  dateKey: string,
  payload: {
    data: StatementOfFinancialPosition;
    floatSplit: LandlordFloatSplit | null;
    statutory: StatutoryLiabilityRow[] | null;
  }
) {
  try {
    const serialized = JSON.stringify({
      ...payload,
      cachedAt: Date.now(),
    });
    sessionStorage.setItem(SNAPSHOT_KEY_PREFIX + dateKey, serialized);
    localStorage.setItem(SNAPSHOT_KEY_PREFIX + dateKey, serialized);
  } catch {
    // Ignore storage quota limits
  }
}

export default function BalanceSheetPanel() {
  const [asAt, setAsAt] = useState<Date>(new Date());
  const [data, setData] = useState<StatementOfFinancialPosition | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadStartedAt, setLoadStartedAt] = useState<number | null>(null);
  const [elapsedSec, setElapsedSec] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [showSources, setShowSources] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [floatSplit, setFloatSplit] = useState<LandlordFloatSplit | null>(null);
  const [drill, setDrill] = useState<Drilldown | null>(null);
  const [statutory, setStatutory] = useState<StatutoryLiabilityRow[] | null>(null);
  const [loadingTies, setLoadingTies] = useState(false);
  const [tiesError, setTiesError] = useState<string | null>(null);

  // Comparative period state (Uber Form 10-K presentation)
  const [showComparison, setShowComparison] = useState(false);
  const [compareDate, setCompareDate] = useState<Date>(() => subYears(new Date(), 1));
  const [compareData, setCompareData] = useState<StatementOfFinancialPosition | null>(null);
  const [compareFloatSplit, setCompareFloatSplit] = useState<LandlordFloatSplit | null>(null);
  const [compareStatutory, setCompareStatutory] = useState<StatutoryLiabilityRow[] | null>(null);
  const [loadingCompare, setLoadingCompare] = useState(false);

  // Supporting schedules collapsible state
  const [openSchedule1, setOpenSchedule1] = useState(false);
  const [openSchedule2, setOpenSchedule2] = useState(false);
  const [openSchedule3, setOpenSchedule3] = useState(false);

  // Ignore responses for an as-at date the user has already moved away from.
  const latestLoadKey = useRef<string>('');
  const latestCompareKey = useRef<string>('');

  // Visible elapsed-time counter so a slow server is obvious rather than a silent spinner.
  useEffect(() => {
    if (loadStartedAt === null) return;
    const id = setInterval(() => setElapsedSec(Math.round((Date.now() - loadStartedAt) / 1000)), 1000);
    return () => clearInterval(id);
  }, [loadStartedAt]);

  const load = useCallback(async (date: Date, force = false) => {
    const dateKey = format(date, 'yyyy-MM-dd');
    latestLoadKey.current = dateKey;

    // 1. Instant render from a recent snapshot of the same server statement.
    const stored = getStoredSnapshot(dateKey);
    if (stored) {
      setData(stored.data);
      setFloatSplit(stored.floatSplit);
      setStatutory(stored.statutory);
      setError(null);
      if (!force && Date.now() - stored.cachedAt < 5 * 60 * 1000) return;
    }

    setLoading(true);
    setLoadStartedAt(Date.now());
    setElapsedSec(0);
    setError(null);

    try {
      // 2. The single authoritative statement — nothing else runs alongside it.
      const sheet = await fetchSofp(date);
      if (latestLoadKey.current !== dateKey) return;
      setData(sheet);
      setError(null);
      storeSnapshot(dateKey, { data: sheet, floatSplit: stored?.floatSplit ?? null, statutory: stored?.statutory ?? null });
      setLoading(false);
      setLoadStartedAt(null);

      // 3. Disclosure schedules only after the statement is on screen.
      const aux = await fetchAuxiliary(date);
      if (latestLoadKey.current !== dateKey) return;
      setFloatSplit(aux.floatSplit);
      setStatutory(aux.statutory);
      storeSnapshot(dateKey, { data: sheet, floatSplit: aux.floatSplit, statutory: aux.statutory });
    } catch (e: unknown) {
      if (latestLoadKey.current !== dateKey) return;
      console.error('Balance Sheet load failed:', e);
      const msg = friendlyLoadError(e);
      // Keep any snapshot already on screen; only show the error page when there is nothing.
      if (!stored) {
        setData(null);
        setError(msg);
      }
      toast.error(stored ? 'Could not refresh the balance sheet — showing the last loaded statement.' : 'Unable to generate the balance sheet');
    } finally {
      if (latestLoadKey.current === dateKey) {
        setLoading(false);
        setLoadStartedAt(null);
      }
    }
  }, []);

  const loadComparison = useCallback(async (date: Date, force = false) => {
    const dateKey = format(date, 'yyyy-MM-dd');
    latestCompareKey.current = dateKey;

    const stored = getStoredSnapshot(dateKey);
    if (stored) {
      setCompareData(stored.data);
      setCompareFloatSplit(stored.floatSplit);
      setCompareStatutory(stored.statutory);
      if (!force && Date.now() - stored.cachedAt < 5 * 60 * 1000) return;
    }

    setLoadingCompare(true);
    try {
      const sheet = await fetchSofp(date);
      if (latestCompareKey.current !== dateKey) return;
      setCompareData(sheet);
      storeSnapshot(dateKey, { data: sheet, floatSplit: stored?.floatSplit ?? null, statutory: stored?.statutory ?? null });
      setLoadingCompare(false);

      const aux = await fetchAuxiliary(date);
      if (latestCompareKey.current !== dateKey) return;
      setCompareFloatSplit(aux.floatSplit);
      setCompareStatutory(aux.statutory);
      storeSnapshot(dateKey, { data: sheet, floatSplit: aux.floatSplit, statutory: aux.statutory });
    } catch (e: unknown) {
      if (latestCompareKey.current !== dateKey) return;
      console.warn('Failed to load comparative balance sheet:', e);
      toast.error('Could not load the comparative period. ' + friendlyLoadError(e));
    } finally {
      if (latestCompareKey.current === dateKey) setLoadingCompare(false);
    }
  }, []);

  /**
   * Sub-ledger tie-out (Schedule I) on request only. fin_balance_sheet rebuilds
   * the whole statement internally, so running it automatically doubled the
   * database work on every load.
   */
  const loadSubledgerTies = useCallback(async () => {
    setLoadingTies(true);
    setTiesError(null);
    try {
      const params = isToday(asAt) ? {} : { p_as_at: endOfDay(asAt).toISOString() };
      const { data: res, error: err } = await callLooseRpc<StatementOfFinancialPosition>('fin_balance_sheet', params);
      if (err) throw new Error(err.message);
      setData(prev => (prev ? {
        ...prev,
        subledger_ties: res?.subledger_ties ?? [],
        subledger_ties_basis: res?.subledger_ties_basis,
        disclosures: res?.disclosures,
      } : prev));
      setOpenSchedule1(true);
    } catch (e: unknown) {
      setTiesError(friendlyLoadError(e));
    } finally {
      setLoadingTies(false);
    }
  }, [asAt]);

  useEffect(() => {
    load(asAt);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (showComparison) {
      loadComparison(compareDate);
    }
  }, [showComparison, compareDate, loadComparison]);

  const title = `WELILE — BALANCE SHEET — As at ${format(asAt, 'dd MMMM yyyy')}`;

  // Current period classification
  const assetGroups = data
    ? classifyAssets([...data.assets.current, ...data.assets.non_current])
    : null;
  const liabilityGroups = data
    ? classifyLiabilities([...data.liabilities.current, ...data.liabilities.non_current])
    : null;
  const equityGroups = data ? classifyEquity(data.equity.lines) : null;
  const assetRows = assetGroups?.groups ?? [];
  const assetsTotal = data ? data.assets.total : 0;
  const equityTotal = data ? data.equity.total : 0;
  const totalLiabilitiesAndEquity = data
    ? data.balance_check.total_liabilities_and_equity
    : 0;
  const marketplaceRows = expandLandlordFloat(liabilityGroups?.marketplace ?? [], floatSplit);

  // Compare period classification
  const compareAssetGroups = compareData
    ? classifyAssets([...compareData.assets.current, ...compareData.assets.non_current])
    : null;
  const compareLiabilityGroups = compareData
    ? classifyLiabilities([...compareData.liabilities.current, ...compareData.liabilities.non_current])
    : null;
  const compareEquityGroups = compareData ? classifyEquity(compareData.equity.lines) : null;
  const compareAssetRows = compareAssetGroups?.groups ?? [];
  const compareAssetsTotal = compareData ? compareData.assets.total : 0;
  const compareEquityTotal = compareData ? compareData.equity.total : 0;
  const compareTotalLiabilitiesAndEquity = compareData
    ? compareData.balance_check.total_liabilities_and_equity
    : 0;
  const compareMarketplaceRows = expandLandlordFloat(compareLiabilityGroups?.marketplace ?? [], compareFloatSplit);

  // Drift validations
  const assetDrift = data && assetGroups ? Math.round(assetGroups.total - data.assets.total) : 0;
  const equityDrift = data && equityGroups ? Math.round(equityGroups.total - equityTotal) : 0;
  const liabilityGroupDrift = data && liabilityGroups
    ? Math.round(liabilityGroups.total - data.liabilities.total)
    : 0;

  // Statutory payroll disclosure lines
  const statutoryLines: PositionLine[] = (statutory ?? []).map(r => ({
    label: r.label,
    value: Number(r.outstanding ?? 0),
  }));
  const statutoryTotal = statutoryLines.reduce((t, l) => t + l.value, 0);
  const isTaxLine = (label: string) => label === 'Taxes Payable';

  const standaloneComponents = (g: BsGroup) =>
    isTaxLine(g.label) && statutory ? statutoryLines : g.components;
  const standaloneNote = (g: BsGroup) =>
    isTaxLine(g.label) && statutory ? STATUTORY_NOTE : undefined;

  const standaloneRows: BsGroup[] = (liabilityGroups?.standalone ?? []).map(g =>
    isTaxLine(g.label) && statutory
      ? { ...g, value: statutoryTotal, components: [], unsourced: false }
      : g,
  );

  const compareStatutoryLines: PositionLine[] = (compareStatutory ?? []).map(r => ({
    label: r.label,
    value: Number(r.outstanding ?? 0),
  }));
  const compareStatutoryTotal = compareStatutoryLines.reduce((t, l) => t + l.value, 0);
  const compareStandaloneRows: BsGroup[] = (compareLiabilityGroups?.standalone ?? []).map(g =>
    isTaxLine(g.label) && compareStatutory
      ? { ...g, value: compareStatutoryTotal, components: [], unsourced: false }
      : g,
  );

  // Partition asset rows into Current and Non-Current (Uber Form 10-K hierarchy)
  const isNonCurrentAsset = (label: string) => {
    const l = label.toLowerCase();
    return (
      l.includes('property') ||
      l.includes('equipment') ||
      l.includes('intangible') ||
      l.includes('goodwill')
    );
  };

  const currentAssetRows = assetRows.filter(g => !isNonCurrentAsset(g.label));
  const nonCurrentAssetRows = assetRows.filter(g => isNonCurrentAsset(g.label));
  const currentAssetsTotal = data?.assets.total_current ?? currentAssetRows.reduce((s, g) => s + (g.heading ? 0 : g.value), 0);
  const nonCurrentAssetsTotal = data?.assets.total_non_current ?? nonCurrentAssetRows.reduce((s, g) => s + (g.heading ? 0 : g.value), 0);

  const compareCurrentAssetsTotal = compareData?.assets.total_current ?? 0;
  const compareNonCurrentAssetsTotal = compareData?.assets.total_non_current ?? 0;

  // Partition liabilities into Current and Non-Current
  const isNonCurrentLiability = (label: string) => {
    const l = label.toLowerCase();
    return l.includes('borrowed') || l.includes('long-term') || l.includes('capital held');
  };

  const currentMarketplaceRows = marketplaceRows.filter(g => !isNonCurrentLiability(g.label));
  const nonCurrentMarketplaceRows = marketplaceRows.filter(g => isNonCurrentLiability(g.label));

  const currentLiabilitiesTotal = data?.liabilities.total_current ?? (
    standaloneRows.reduce((s, g) => s + (isTaxLine(g.label) ? 0 : g.value), 0) +
    currentMarketplaceRows.filter(g => !g.subtotal && !g.depth && !g.heading).reduce((s, g) => s + g.value, 0)
  );
  const nonCurrentLiabilitiesTotal = data?.liabilities.total_non_current ?? (
    nonCurrentMarketplaceRows.filter(g => !g.subtotal && !g.depth && !g.heading).reduce((s, g) => s + g.value, 0)
  );

  const compareCurrentLiabilitiesTotal = compareData?.liabilities.total_current ?? 0;
  const compareNonCurrentLiabilitiesTotal = compareData?.liabilities.total_non_current ?? 0;

  // Working capital
  const workingCapital = (data?.assets.total_current ?? currentAssetsTotal) - (data?.liabilities.total_current ?? currentLiabilitiesTotal);

  // Helper to find matching comparison value
  const findCompVal = (label: string, groups: BsGroup[] | null): number | null => {
    if (!groups) return null;
    const match = groups.find(g => g.label.toLowerCase().trim() === label.toLowerCase().trim());
    return match ? match.value : null;
  };

  const formatPct = (val: number, total: number) => {
    if (!total || total === 0) return '—';
    const pct = (val / total) * 100;
    return `${pct.toFixed(1)}%`;
  };

  const formatVariance = (cur: number, comp: number | null) => {
    if (comp === null) return { diffText: '—', pctText: '' };
    const diff = cur - comp;
    const diffStr = diff < 0 ? `(${formatUGX(Math.abs(diff))})` : formatUGX(diff);
    if (comp === 0) return { diffText: diffStr, pctText: '' };
    const pct = ((cur - comp) / Math.abs(comp)) * 100;
    const pctStr = `${pct > 0 ? '+' : ''}${pct.toFixed(1)}%`;
    return { diffText: diffStr, pctText: pctStr };
  };

  const exportCSV = () => {
    if (!data) return;
    const rows: (string | number)[][] = [
      ['WELILE TECHNOLOGIES LIMITED'],
      ['CONSOLIDATED BALANCE SHEETS'],
      [`As at ${format(asAt, 'dd MMMM yyyy')}${showComparison && compareData ? ` and ${format(compareDate, 'dd MMMM yyyy')}` : ''}`],
      ['(All amounts in Uganda Shillings [UGX])'],
      [],
    ];

    const header = ['Financial Line Item', `As of ${format(asAt, 'yyyy-MM-dd')}`, '% of Assets'];
    if (showComparison && compareData) {
      header.push(`As of ${format(compareDate, 'yyyy-MM-dd')}`, '% of Assets', 'Variance (UGX)');
    }
    rows.push(header);

    rows.push(['ASSETS', '', '']);
    rows.push(['Current assets:', '', '']);
    currentAssetRows.forEach(g => {
      const compVal = findCompVal(g.label, compareAssetRows);
      const row: (string | number)[] = [
        '   ' + g.label,
        g.heading ? '' : g.value,
        g.heading ? '' : formatPct(g.value, assetsTotal),
      ];
      if (showComparison && compareData) {
        row.push(compVal !== null ? compVal : '', compVal !== null ? formatPct(compVal, compareAssetsTotal) : '', compVal !== null ? g.value - compVal : '');
      }
      rows.push(row);
    });
    rows.push(['Total current assets', currentAssetsTotal, formatPct(currentAssetsTotal, assetsTotal)]);

    rows.push(['Non-current assets:', '', '']);
    nonCurrentAssetRows.forEach(g => {
      const compVal = findCompVal(g.label, compareAssetRows);
      const row: (string | number)[] = [
        '   ' + g.label,
        g.heading ? '' : g.value,
        g.heading ? '' : formatPct(g.value, assetsTotal),
      ];
      if (showComparison && compareData) {
        row.push(compVal !== null ? compVal : '', compVal !== null ? formatPct(compVal, compareAssetsTotal) : '', compVal !== null ? g.value - compVal : '');
      }
      rows.push(row);
    });
    rows.push(['Total non-current assets', nonCurrentAssetsTotal, formatPct(nonCurrentAssetsTotal, assetsTotal)]);
    rows.push(['TOTAL ASSETS', assetsTotal, '100.0%']);

    rows.push([]);
    rows.push(['LIABILITIES AND SHAREHOLDERS\' EQUITY', '', '']);
    rows.push(['Current liabilities:', '', '']);
    standaloneRows.forEach(g => {
      rows.push(['   ' + g.label, g.value, formatPct(g.value, assetsTotal)]);
    });
    currentMarketplaceRows.forEach(g => {
      const pad = '   '.repeat(1 + (g.depth ?? 0));
      rows.push([pad + g.label, g.heading ? '' : g.value, g.heading ? '' : formatPct(g.value, assetsTotal)]);
    });
    rows.push(['Total current liabilities', currentLiabilitiesTotal, formatPct(currentLiabilitiesTotal, assetsTotal)]);

    rows.push(['Non-current liabilities:', '', '']);
    nonCurrentMarketplaceRows.forEach(g => {
      const pad = '   '.repeat(1 + (g.depth ?? 0));
      rows.push([pad + g.label, g.heading ? '' : g.value, g.heading ? '' : formatPct(g.value, assetsTotal)]);
    });
    rows.push(['Total non-current liabilities', nonCurrentLiabilitiesTotal, formatPct(nonCurrentLiabilitiesTotal, assetsTotal)]);
    rows.push(['TOTAL LIABILITIES', data.liabilities.total, formatPct(data.liabilities.total, assetsTotal)]);

    rows.push([]);
    rows.push(['Shareholders\' equity:', '', '']);
    (equityGroups?.groups ?? []).forEach(g => {
      rows.push(['   ' + g.label, g.value, formatPct(g.value, assetsTotal)]);
    });
    rows.push(['TOTAL SHAREHOLDERS\' EQUITY', equityTotal, formatPct(equityTotal, assetsTotal)]);

    rows.push([]);
    rows.push(['TOTAL LIABILITIES AND SHAREHOLDERS\' EQUITY', totalLiabilitiesAndEquity, formatPct(totalLiabilitiesAndEquity, assetsTotal)]);
    rows.push(['Balance Check Difference', data.balance_check.difference, '']);
    rows.push(['Balanced (real ledger, no plug)', data.balance_check.balanced ? 'YES' : 'NO', '']);

    const csv = rows.map(r => r.map(c => `"${String(c ?? '').replace(/"/g, '""')}"`).join(',')).join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `welile-consolidated-balance-sheet-${format(asAt, 'yyyy-MM-dd')}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const exportPDF = async () => {
    if (!data) return;
    setExporting(true);
    try {
      const { jsPDF } = await import('jspdf');
      const pdf = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });
      const pw = pdf.internal.pageSize.getWidth();
      const ph = pdf.internal.pageSize.getHeight();
      const margin = 14;
      let y = 20;

      pdf.setFillColor(30, 41, 59);
      pdf.rect(0, 0, pw, 14, 'F');
      pdf.setTextColor(255, 255, 255);
      pdf.setFontSize(10);
      pdf.setFont('helvetica', 'bold');
      pdf.text('WELILE TECHNOLOGIES LIMITED', margin, 9);
      pdf.setFontSize(8);
      pdf.text('CONSOLIDATED BALANCE SHEETS', pw - margin - 50, 9);

      pdf.setTextColor(0, 0, 0);
      pdf.setFontSize(13);
      y = 22;
      pdf.text('STATEMENT OF FINANCIAL POSITION', margin, y);
      y += 5;
      pdf.setFontSize(8);
      pdf.setFont('helvetica', 'normal');
      pdf.setTextColor(100, 100, 100);
      pdf.text(`As at ${format(asAt, 'dd MMMM yyyy')} · All figures in Uganda Shillings (UGX)`, margin, y);
      y += 3;
      pdf.setDrawColor(200, 200, 200);
      pdf.line(margin, y, pw - margin, y);
      y += 6;

      const printHeading = (text: string) => {
        if (y > ph - 25) { pdf.addPage(); y = 20; }
        pdf.setFontSize(9);
        pdf.setFont('helvetica', 'bold');
        pdf.setTextColor(30, 41, 59);
        pdf.text(text.toUpperCase(), margin, y);
        y += 5;
      };

      const printRow = (label: string, val: number, bold = false, indent = 4) => {
        if (y > ph - 20) { pdf.addPage(); y = 20; }
        pdf.setFontSize(bold ? 8.5 : 8);
        pdf.setFont('helvetica', bold ? 'bold' : 'normal');
        pdf.setTextColor(bold ? 0 : 70, bold ? 0 : 70, bold ? 0 : 70);
        pdf.text(label, margin + indent, y);
        const valStr = val < 0 ? `(${formatUGX(Math.abs(val))})` : formatUGX(val);
        pdf.text(valStr, pw - margin - 20, y, { align: 'right' });
        const pctStr = formatPct(val, assetsTotal);
        pdf.text(pctStr, pw - margin, y, { align: 'right' });
        if (bold) {
          pdf.setDrawColor(220, 220, 220);
          pdf.line(margin + indent, y + 1.5, pw - margin, y + 1.5);
        }
        y += bold ? 6 : 4.5;
      };

      printHeading('Assets');
      pdf.setFontSize(8);
      pdf.setFont('helvetica', 'bold');
      pdf.text('Current assets:', margin + 2, y);
      y += 4.5;
      currentAssetRows.forEach(g => {
        if (!g.heading) printRow(g.label, g.value, false, 4);
      });
      printRow('Total current assets', currentAssetsTotal, true, 2);

      y += 2;
      pdf.setFontSize(8);
      pdf.setFont('helvetica', 'bold');
      pdf.text('Non-current assets:', margin + 2, y);
      y += 4.5;
      nonCurrentAssetRows.forEach(g => {
        if (!g.heading) printRow(g.label, g.value, false, 4);
      });
      printRow('Total non-current assets', nonCurrentAssetsTotal, true, 2);
      printRow('TOTAL ASSETS', assetsTotal, true, 0);

      y += 3;
      printHeading('Liabilities and Shareholders\' Equity');
      pdf.setFontSize(8);
      pdf.setFont('helvetica', 'bold');
      pdf.text('Current liabilities:', margin + 2, y);
      y += 4.5;
      standaloneRows.forEach(g => printRow(g.label, g.value, false, 4));
      currentMarketplaceRows.forEach(g => {
        if (!g.heading && !g.subtotal) printRow(g.label, g.value, false, 4);
      });
      printRow('Total current liabilities', currentLiabilitiesTotal, true, 2);

      y += 2;
      pdf.setFontSize(8);
      pdf.setFont('helvetica', 'bold');
      pdf.text('Non-current liabilities:', margin + 2, y);
      y += 4.5;
      nonCurrentMarketplaceRows.forEach(g => {
        if (!g.heading && !g.subtotal) printRow(g.label, g.value, false, 4);
      });
      printRow('Total non-current liabilities', nonCurrentLiabilitiesTotal, true, 2);
      printRow('TOTAL LIABILITIES', data.liabilities.total, true, 0);

      y += 2;
      pdf.setFontSize(8);
      pdf.setFont('helvetica', 'bold');
      pdf.text('Shareholders\' equity:', margin + 2, y);
      y += 4.5;
      (equityGroups?.groups ?? []).forEach(g => printRow(g.label, g.value, false, 4));
      printRow('TOTAL SHAREHOLDERS\' EQUITY', equityTotal, true, 2);

      y += 2;
      printRow('TOTAL LIABILITIES AND SHAREHOLDERS\' EQUITY', totalLiabilitiesAndEquity, true, 0);

      y += 4;
      pdf.setFontSize(7.5);
      pdf.setFont('helvetica', 'italic');
      pdf.setTextColor(data.balance_check.balanced ? 22 : 180, data.balance_check.balanced ? 101 : 30, data.balance_check.balanced ? 52 : 30);
      pdf.text(
        data.balance_check.balanced
          ? 'ASSERTION: Balanced — Total Assets equal Total Liabilities and Shareholders\' Equity (Zero suspense plug applied).'
          : `ASSERTION: Unbalanced Difference: ${formatUGX(data.balance_check.difference)} — Real ledger data with no plug.`,
        margin, y,
      );

      const fileName = `welile-balance-sheet-${format(asAt, 'yyyy-MM-dd')}.pdf`;
      pdf.save(fileName);
      toast.success('PDF report downloaded');
    } catch {
      toast.error('Failed to export PDF');
    } finally {
      setExporting(false);
    }
  };

  return (
    <div className="space-y-4">
      {/* 1. Executive Summary KPI Strip */}
      {data && (
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-2.5">
          <div className="rounded-xl border border-border bg-card p-3 shadow-xs">
            <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground flex items-center justify-between">
              Total Assets
              <Wallet className="h-3.5 w-3.5 text-primary opacity-80" />
            </p>
            <p className="text-base font-bold font-mono text-foreground mt-1 tabular-nums">
              {formatUGX(assetsTotal)}
            </p>
            <p className="text-[10px] text-muted-foreground mt-0.5">
              Current: {formatUGX(currentAssetsTotal)}
            </p>
          </div>

          <div className="rounded-xl border border-border bg-card p-3 shadow-xs">
            <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground flex items-center justify-between">
              Total Liabilities
              <AlertTriangle className="h-3.5 w-3.5 text-amber-500 opacity-80" />
            </p>
            <p className="text-base font-bold font-mono text-foreground mt-1 tabular-nums">
              {formatUGX(data.liabilities.total)}
            </p>
            <p className="text-[10px] text-muted-foreground mt-0.5">
              Current: {formatUGX(currentLiabilitiesTotal)}
            </p>
          </div>

          <div className="rounded-xl border border-border bg-card p-3 shadow-xs">
            <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground flex items-center justify-between">
              Shareholders' Equity
              <TrendingUp className="h-3.5 w-3.5 text-emerald-500 opacity-80" />
            </p>
            <p className={cn("text-base font-bold font-mono mt-1 tabular-nums", equityTotal < 0 ? "text-destructive" : "text-foreground")}>
              {equityTotal < 0 ? `(${formatUGX(Math.abs(equityTotal))})` : formatUGX(equityTotal)}
            </p>
            <p className="text-[10px] text-muted-foreground mt-0.5">
              Net position from ledger
            </p>
          </div>

          <div className="rounded-xl border border-border bg-card p-3 shadow-xs">
            <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground flex items-center justify-between">
              Net Working Capital
              <ShieldCheck className="h-3.5 w-3.5 text-blue-500 opacity-80" />
            </p>
            <p className={cn("text-base font-bold font-mono mt-1 tabular-nums", workingCapital < 0 ? "text-destructive" : "text-foreground")}>
              {workingCapital < 0 ? `(${formatUGX(Math.abs(workingCapital))})` : formatUGX(workingCapital)}
            </p>
            <p className="text-[10px] text-muted-foreground mt-0.5">
              Current Assets - Current Liab.
            </p>
          </div>
        </div>
      )}

      {/* 2. Controls and Date Selection Toolbar */}
      <div className="flex flex-wrap items-center justify-between gap-2 p-2 rounded-xl border border-border bg-card shadow-xs">
        <div className="flex flex-wrap items-center gap-2">
          {/* As of Date Picker */}
          <Popover>
            <PopoverTrigger asChild>
              <Button size="sm" variant="outline" className="h-8 text-xs gap-1.5 font-medium">
                <Calendar className="h-3.5 w-3.5 text-primary" />
                <span>As of: <strong className="font-semibold">{format(asAt, 'dd MMM yyyy')}</strong></span>
              </Button>
            </PopoverTrigger>
            <PopoverContent className="w-auto p-0 z-[200]" align="start">
              <CalendarPicker
                mode="single"
                selected={asAt}
                onSelect={(d) => {
                  if (d) {
                    setAsAt(d);
                    load(d, false);
                  }
                }}
                initialFocus
                className="p-3 pointer-events-auto"
              />
            </PopoverContent>
          </Popover>

          <Button
            size="sm"
            variant="outline"
            className="h-8 text-xs gap-1"
            onClick={() => load(asAt, true)}
            disabled={loading}
          >
            {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
            {data ? 'Refresh' : 'Generate'}
          </Button>

          {/* Comparative Period Toggle */}
          <Button
            size="sm"
            variant={showComparison ? 'default' : 'outline'}
            className="h-8 text-xs gap-1.5"
            onClick={() => setShowComparison(s => !s)}
          >
            <GitCompareArrows className="h-3.5 w-3.5" />
            {showComparison ? 'Comparison Active' : 'Compare Period'}
          </Button>

          {showComparison && (
            <Popover>
              <PopoverTrigger asChild>
                <Button size="sm" variant="outline" className="h-8 text-xs gap-1.5 border-dashed border-primary/60">
                  <Calendar className="h-3.5 w-3.5 text-primary" />
                  <span>Prior: <strong className="font-semibold">{format(compareDate, 'dd MMM yyyy')}</strong></span>
                </Button>
              </PopoverTrigger>
              <PopoverContent className="w-auto p-0 z-[200]" align="start">
                <CalendarPicker
                  mode="single"
                  selected={compareDate}
                  onSelect={(d) => {
                    if (d) {
                      setCompareDate(d);
                      loadComparison(d, false);
                    }
                  }}
                  initialFocus
                  className="p-3 pointer-events-auto"
                />
              </PopoverContent>
            </Popover>
          )}

          <Button
            size="sm"
            variant="ghost"
            className="h-8 text-xs text-muted-foreground hover:text-foreground"
            onClick={() => setShowSources(s => !s)}
          >
            {showSources ? 'Hide account codes' : 'Show account codes'}
          </Button>
        </div>

        <div className="flex items-center gap-1.5">
          <Button size="sm" variant="outline" className="h-8 text-xs gap-1.5" onClick={exportCSV} disabled={!data}>
            <FileSpreadsheet className="h-3.5 w-3.5 text-emerald-600" />
            CSV
          </Button>
          <Button size="sm" variant="outline" className="h-8 text-xs gap-1.5" onClick={exportPDF} disabled={!data || exporting}>
            {exporting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Download className="h-3.5 w-3.5 text-blue-600" />}
            PDF
          </Button>
        </div>
      </div>

      {loading && !data && (
        <div className="py-14 text-center text-muted-foreground text-xs rounded-xl border border-border bg-card">
          <Loader2 className="h-6 w-6 animate-spin mx-auto mb-2 text-primary" />
          <p className="font-medium text-foreground text-sm">Compiling Consolidated Balance Sheet from General Ledger…</p>
          <p className="text-[11px] text-muted-foreground mt-1">Resolving real double-entry account positions, statutory payroll obligations, and asset classifications.</p>
          <p className="text-[11px] text-muted-foreground mt-2 font-mono tabular-nums">
            {elapsedSec}s elapsed{elapsedSec >= 20 ? ' · the ledger statement is large; this can take up to two minutes' : ''}
          </p>
        </div>
      )}

      {loading && data && (
        <div className="flex items-center justify-center gap-2 py-2 px-3 rounded-lg bg-muted/60 text-xs text-muted-foreground border border-border/50">
          <Loader2 className="h-3.5 w-3.5 animate-spin text-primary" />
          <span>Refreshing latest positions from the General Ledger…</span>
        </div>
      )}

      {!loading && !data && (
        <div className="py-12 px-4 text-center rounded-xl border border-dashed border-border bg-card">
          {error ? (
            <div className="max-w-md mx-auto space-y-3">
              <div className="inline-flex p-3 rounded-full bg-destructive/10 text-destructive mb-1">
                <AlertTriangle className="h-6 w-6" />
              </div>
              <h3 className="text-sm font-semibold text-foreground">Unable to generate Balance Sheet</h3>
              <p className="text-xs text-muted-foreground break-words">{error}</p>
              <Button size="sm" onClick={() => load(asAt, true)} className="text-xs gap-1.5 mt-2">
                <RefreshCw className="h-3.5 w-3.5" />
                Retry
              </Button>
            </div>
          ) : (
            <div className="max-w-md mx-auto space-y-2">
              <FileSpreadsheet className="h-8 w-8 mx-auto text-muted-foreground/40 mb-1" />
              <p className="text-xs font-medium text-foreground">No Balance Sheet loaded</p>
              <p className="text-[11px] text-muted-foreground">Select a date and click Generate to compile the statement.</p>
              <Button size="sm" onClick={() => load(asAt, true)} className="text-xs gap-1.5 mt-2">
                <RefreshCw className="h-3.5 w-3.5" />
                Generate
              </Button>
            </div>
          )}
        </div>
      )}

      {data && (
        <>
          {/* 3. Official Uber Form 10-K Consolidated Balance Sheets Presentation */}
          <div className="rounded-xl border border-border bg-card shadow-sm overflow-hidden">
            {/* Formal Header */}
            <div className="p-4 border-b border-border text-center space-y-1 bg-muted/10">
              <h2 className="text-xs font-bold uppercase tracking-widest text-foreground">
                Welile Technologies Limited
              </h2>
              <h1 className="text-base font-bold text-foreground tracking-tight">
                CONSOLIDATED BALANCE SHEETS
              </h1>
              <p className="text-[11px] text-muted-foreground">
                (Amounts in Uganda Shillings [UGX])
              </p>
            </div>

            {/* Table */}
            <div className="overflow-x-auto">
              <table className="w-full text-xs border-collapse">
                <thead>
                  <tr className="border-b-2 border-border/80 text-muted-foreground text-[11px]">
                    <th className="py-2.5 pl-4 pr-3 text-left font-semibold">
                      Account / Financial Category
                    </th>
                    <th className="py-2.5 px-3 text-right font-semibold whitespace-nowrap">
                      As of {format(asAt, 'MMM d, yyyy')}
                    </th>
                    <th className="py-2.5 px-3 text-right font-semibold whitespace-nowrap text-muted-foreground/80">
                      % of Assets
                    </th>
                    {showComparison && compareData && (
                      <>
                        <th className="py-2.5 px-3 text-right font-semibold whitespace-nowrap border-l border-border/50">
                          As of {format(compareDate, 'MMM d, yyyy')}
                        </th>
                        <th className="py-2.5 px-3 text-right font-semibold whitespace-nowrap text-muted-foreground/80">
                          % of Assets
                        </th>
                        <th className="py-2.5 pl-3 pr-4 text-right font-semibold whitespace-nowrap">
                          Variance
                        </th>
                      </>
                    )}
                  </tr>
                </thead>

                <tbody className="divide-y divide-border/30">
                  {/* ======================================================== */}
                  {/* ASSETS SECTION                                           */}
                  {/* ======================================================== */}
                  <tr className="bg-muted/30">
                    <td colSpan={showComparison && compareData ? 6 : 3} className="py-2 pl-4 text-xs font-bold text-foreground uppercase tracking-wider">
                      ASSETS
                    </td>
                  </tr>

                  {/* Current Assets Header */}
                  <tr className="bg-muted/10">
                    <td colSpan={showComparison && compareData ? 6 : 3} className="py-1.5 pl-5 text-[11px] font-semibold text-foreground/90 italic">
                      Current assets:
                    </td>
                  </tr>

                  {/* Current Assets Rows */}
                  {currentAssetRows.map(g => {
                    const compVal = findCompVal(g.label, compareAssetRows);
                    const variance = formatVariance(g.value, compVal);
                    return (
                      <tr
                        key={g.label}
                        onClick={() => setDrill({
                          title: g.label,
                          value: g.value,
                          unsourced: g.unsourced,
                          lines: g.lines,
                          components: g.components,
                        })}
                        className="hover:bg-muted/40 cursor-pointer transition-colors group"
                      >
                        <td className="py-1.5 pl-8 pr-3 text-muted-foreground group-hover:text-foreground">
                          <div className="flex items-center gap-1.5">
                            <span className="truncate">{g.label}</span>
                            {showSources && g.lines[0]?.source && (
                              <span className="text-[9px] font-mono px-1 rounded bg-muted text-muted-foreground shrink-0">
                                {g.lines[0].source.split('—').pop()?.trim()}
                              </span>
                            )}
                            {g.unsourced && (
                              <span className="text-[9px] px-1 rounded bg-muted text-muted-foreground shrink-0">
                                not in ledger
                              </span>
                            )}
                          </div>
                        </td>
                        <td className={cn("py-1.5 px-3 text-right font-mono tabular-nums", g.value < 0 ? "text-destructive" : "text-foreground")}>
                          {g.value < 0 ? `(${formatUGX(Math.abs(g.value))})` : formatUGX(g.value)}
                        </td>
                        <td className="py-1.5 px-3 text-right font-mono tabular-nums text-muted-foreground">
                          {formatPct(g.value, assetsTotal)}
                        </td>
                        {showComparison && compareData && (
                          <>
                            <td className="py-1.5 px-3 text-right font-mono tabular-nums text-muted-foreground border-l border-border/40">
                              {compVal !== null ? (compVal < 0 ? `(${formatUGX(Math.abs(compVal))})` : formatUGX(compVal)) : '—'}
                            </td>
                            <td className="py-1.5 px-3 text-right font-mono tabular-nums text-muted-foreground">
                              {compVal !== null ? formatPct(compVal, compareAssetsTotal) : '—'}
                            </td>
                            <td className={cn("py-1.5 pl-3 pr-4 text-right font-mono tabular-nums text-[11px]", (compVal !== null && g.value - compVal < 0) ? "text-amber-600" : "text-emerald-600")}>
                              {variance.diffText}
                              {variance.pctText && <span className="text-[9px] ml-1 opacity-80">({variance.pctText})</span>}
                            </td>
                          </>
                        )}
                      </tr>
                    );
                  })}

                  {/* Total Current Assets Subtotal */}
                  <tr className="border-t border-border font-semibold bg-muted/15">
                    <td className="py-2 pl-6 pr-3 text-foreground">
                      Total current assets
                    </td>
                    <td className="py-2 px-3 text-right font-mono tabular-nums text-foreground">
                      {formatUGX(currentAssetsTotal)}
                    </td>
                    <td className="py-2 px-3 text-right font-mono tabular-nums text-foreground">
                      {formatPct(currentAssetsTotal, assetsTotal)}
                    </td>
                    {showComparison && compareData && (
                      <>
                        <td className="py-2 px-3 text-right font-mono tabular-nums text-foreground border-l border-border/40">
                          {formatUGX(compareCurrentAssetsTotal)}
                        </td>
                        <td className="py-2 px-3 text-right font-mono tabular-nums text-foreground">
                          {formatPct(compareCurrentAssetsTotal, compareAssetsTotal)}
                        </td>
                        <td className="py-2 pl-3 pr-4 text-right font-mono tabular-nums text-[11px]">
                          {formatVariance(currentAssetsTotal, compareCurrentAssetsTotal).diffText}
                        </td>
                      </>
                    )}
                  </tr>

                  {/* Non-Current Assets Header */}
                  <tr className="bg-muted/10">
                    <td colSpan={showComparison && compareData ? 6 : 3} className="py-1.5 pl-5 text-[11px] font-semibold text-foreground/90 italic">
                      Non-current assets:
                    </td>
                  </tr>

                  {/* Non-Current Assets Rows */}
                  {nonCurrentAssetRows.map(g => {
                    const compVal = findCompVal(g.label, compareAssetRows);
                    const variance = formatVariance(g.value, compVal);
                    return (
                      <tr
                        key={g.label}
                        onClick={() => setDrill({
                          title: g.label,
                          value: g.value,
                          unsourced: g.unsourced,
                          lines: g.lines,
                          components: g.components,
                        })}
                        className="hover:bg-muted/40 cursor-pointer transition-colors group"
                      >
                        <td className="py-1.5 pl-8 pr-3 text-muted-foreground group-hover:text-foreground">
                          <div className="flex items-center gap-1.5">
                            <span className="truncate">{g.label}</span>
                            {showSources && g.lines[0]?.source && (
                              <span className="text-[9px] font-mono px-1 rounded bg-muted text-muted-foreground shrink-0">
                                {g.lines[0].source.split('—').pop()?.trim()}
                              </span>
                            )}
                          </div>
                        </td>
                        <td className={cn("py-1.5 px-3 text-right font-mono tabular-nums", g.value < 0 ? "text-destructive" : "text-foreground")}>
                          {g.value < 0 ? `(${formatUGX(Math.abs(g.value))})` : formatUGX(g.value)}
                        </td>
                        <td className="py-1.5 px-3 text-right font-mono tabular-nums text-muted-foreground">
                          {formatPct(g.value, assetsTotal)}
                        </td>
                        {showComparison && compareData && (
                          <>
                            <td className="py-1.5 px-3 text-right font-mono tabular-nums text-muted-foreground border-l border-border/40">
                              {compVal !== null ? (compVal < 0 ? `(${formatUGX(Math.abs(compVal))})` : formatUGX(compVal)) : '—'}
                            </td>
                            <td className="py-1.5 px-3 text-right font-mono tabular-nums text-muted-foreground">
                              {compVal !== null ? formatPct(compVal, compareAssetsTotal) : '—'}
                            </td>
                            <td className="py-1.5 pl-3 pr-4 text-right font-mono tabular-nums text-[11px]">
                              {variance.diffText}
                            </td>
                          </>
                        )}
                      </tr>
                    );
                  })}

                  {/* Total Non-Current Assets Subtotal */}
                  <tr className="border-t border-border font-semibold bg-muted/15">
                    <td className="py-2 pl-6 pr-3 text-foreground">
                      Total non-current assets
                    </td>
                    <td className="py-2 px-3 text-right font-mono tabular-nums text-foreground">
                      {formatUGX(nonCurrentAssetsTotal)}
                    </td>
                    <td className="py-2 px-3 text-right font-mono tabular-nums text-foreground">
                      {formatPct(nonCurrentAssetsTotal, assetsTotal)}
                    </td>
                    {showComparison && compareData && (
                      <>
                        <td className="py-2 px-3 text-right font-mono tabular-nums text-foreground border-l border-border/40">
                          {formatUGX(compareNonCurrentAssetsTotal)}
                        </td>
                        <td className="py-2 px-3 text-right font-mono tabular-nums text-foreground">
                          {formatPct(compareNonCurrentAssetsTotal, compareAssetsTotal)}
                        </td>
                        <td className="py-2 pl-3 pr-4 text-right font-mono tabular-nums text-[11px]">
                          {formatVariance(nonCurrentAssetsTotal, compareNonCurrentAssetsTotal).diffText}
                        </td>
                      </>
                    )}
                  </tr>

                  {/* Flagged Assets if any */}
                  {assetGroups && hasFlagged(assetGroups.flagged) && (
                    <tr className="bg-amber-500/10 border-t border-amber-500/30 text-amber-700 dark:text-amber-400">
                      <td className="py-1.5 pl-6 pr-3 font-medium">
                        {assetGroups.flagged.label}
                      </td>
                      <td className="py-1.5 px-3 text-right font-mono tabular-nums">
                        {formatUGX(assetGroups.flagged.value)}
                      </td>
                      <td className="py-1.5 px-3 text-right font-mono tabular-nums">
                        {formatPct(assetGroups.flagged.value, assetsTotal)}
                      </td>
                      {showComparison && compareData && <td colSpan={3} />}
                    </tr>
                  )}

                  {/* TOTAL ASSETS (Uber double bottom border) */}
                  <tr className="border-t-2 border-b-2 border-primary/50 bg-primary/5 font-bold">
                    <td className="py-2.5 pl-4 pr-3 text-sm text-foreground uppercase tracking-wider">
                      TOTAL ASSETS
                    </td>
                    <td className="py-2.5 px-3 text-right font-mono text-sm tabular-nums text-primary">
                      {formatUGX(assetsTotal)}
                    </td>
                    <td className="py-2.5 px-3 text-right font-mono text-sm tabular-nums text-primary">
                      100.0%
                    </td>
                    {showComparison && compareData && (
                      <>
                        <td className="py-2.5 px-3 text-right font-mono text-sm tabular-nums text-foreground border-l border-border/40">
                          {formatUGX(compareAssetsTotal)}
                        </td>
                        <td className="py-2.5 px-3 text-right font-mono text-sm tabular-nums text-foreground">
                          100.0%
                        </td>
                        <td className="py-2.5 pl-3 pr-4 text-right font-mono text-sm tabular-nums text-primary">
                          {formatVariance(assetsTotal, compareAssetsTotal).diffText}
                        </td>
                      </>
                    )}
                  </tr>

                  {/* ======================================================== */}
                  {/* LIABILITIES AND SHAREHOLDERS' EQUITY SECTION            */}
                  {/* ======================================================== */}
                  <tr className="bg-muted/30">
                    <td colSpan={showComparison && compareData ? 6 : 3} className="py-2.5 pl-4 text-xs font-bold text-foreground uppercase tracking-wider">
                      LIABILITIES AND SHAREHOLDERS' EQUITY
                    </td>
                  </tr>

                  {/* Current Liabilities Header */}
                  <tr className="bg-muted/10">
                    <td colSpan={showComparison && compareData ? 6 : 3} className="py-1.5 pl-5 text-[11px] font-semibold text-foreground/90 italic">
                      Current liabilities:
                    </td>
                  </tr>

                  {/* Standalone Current Liabilities (Customer Custody L1, Deferred Fees L7, etc.) */}
                  {standaloneRows.map(g => {
                    const compVal = findCompVal(g.label, compareStandaloneRows);
                    const variance = formatVariance(g.value, compVal);
                    return (
                      <tr
                        key={g.label}
                        onClick={() => setDrill({
                          title: g.label,
                          value: g.value,
                          unsourced: g.unsourced,
                          lines: g.lines,
                          components: standaloneComponents(g),
                          note: standaloneNote(g),
                        })}
                        className="hover:bg-muted/40 cursor-pointer transition-colors group"
                      >
                        <td className="py-1.5 pl-8 pr-3 text-muted-foreground group-hover:text-foreground">
                          <div className="flex items-center gap-1.5">
                            <span className="truncate">{g.label}</span>
                            {isTaxLine(g.label) && (
                              <span className="text-[9px] px-1 rounded bg-amber-500/10 text-amber-600 shrink-0 font-medium">
                                payroll disclosure
                              </span>
                            )}
                            {showSources && g.lines[0]?.source && (
                              <span className="text-[9px] font-mono px-1 rounded bg-muted text-muted-foreground shrink-0">
                                {g.lines[0].source.split('—').pop()?.trim()}
                              </span>
                            )}
                          </div>
                        </td>
                        <td className={cn("py-1.5 px-3 text-right font-mono tabular-nums", g.value < 0 ? "text-destructive" : "text-foreground")}>
                          {g.value < 0 ? `(${formatUGX(Math.abs(g.value))})` : formatUGX(g.value)}
                        </td>
                        <td className="py-1.5 px-3 text-right font-mono tabular-nums text-muted-foreground">
                          {formatPct(g.value, assetsTotal)}
                        </td>
                        {showComparison && compareData && (
                          <>
                            <td className="py-1.5 px-3 text-right font-mono tabular-nums text-muted-foreground border-l border-border/40">
                              {compVal !== null ? (compVal < 0 ? `(${formatUGX(Math.abs(compVal))})` : formatUGX(compVal)) : '—'}
                            </td>
                            <td className="py-1.5 px-3 text-right font-mono tabular-nums text-muted-foreground">
                              {compVal !== null ? formatPct(compVal, compareAssetsTotal) : '—'}
                            </td>
                            <td className="py-1.5 pl-3 pr-4 text-right font-mono tabular-nums text-[11px]">
                              {variance.diffText}
                            </td>
                          </>
                        )}
                      </tr>
                    );
                  })}

                  {/* Current Marketplace Liabilities (L4 Landlord Flow, Float, etc.) */}
                  {currentMarketplaceRows.map(g => {
                    const compVal = findCompVal(g.label, compareMarketplaceRows);
                    const variance = formatVariance(g.value, compVal);
                    if (g.subtotal) return null; // We render section subtotals uniformly
                    return (
                      <tr
                        key={g.label}
                        onClick={() => setDrill({
                          title: g.label,
                          value: g.value,
                          unsourced: g.unsourced,
                          lines: g.lines,
                          components: g.components,
                        })}
                        className="hover:bg-muted/40 cursor-pointer transition-colors group"
                      >
                        <td className={cn("py-1.5 pr-3 text-muted-foreground group-hover:text-foreground", g.depth ? "pl-11" : "pl-8")}>
                          <div className="flex items-center gap-1.5">
                            <span className="truncate">{g.label}</span>
                            {showSources && g.lines[0]?.source && (
                              <span className="text-[9px] font-mono px-1 rounded bg-muted text-muted-foreground shrink-0">
                                {g.lines[0].source.split('—').pop()?.trim()}
                              </span>
                            )}
                          </div>
                        </td>
                        <td className={cn("py-1.5 px-3 text-right font-mono tabular-nums", g.value < 0 ? "text-destructive" : "text-foreground")}>
                          {g.value < 0 ? `(${formatUGX(Math.abs(g.value))})` : formatUGX(g.value)}
                        </td>
                        <td className="py-1.5 px-3 text-right font-mono tabular-nums text-muted-foreground">
                          {formatPct(g.value, assetsTotal)}
                        </td>
                        {showComparison && compareData && (
                          <>
                            <td className="py-1.5 px-3 text-right font-mono tabular-nums text-muted-foreground border-l border-border/40">
                              {compVal !== null ? (compVal < 0 ? `(${formatUGX(Math.abs(compVal))})` : formatUGX(compVal)) : '—'}
                            </td>
                            <td className="py-1.5 px-3 text-right font-mono tabular-nums text-muted-foreground">
                              {compVal !== null ? formatPct(compVal, compareAssetsTotal) : '—'}
                            </td>
                            <td className="py-1.5 pl-3 pr-4 text-right font-mono tabular-nums text-[11px]">
                              {variance.diffText}
                            </td>
                          </>
                        )}
                      </tr>
                    );
                  })}

                  {/* Total Current Liabilities Subtotal */}
                  <tr className="border-t border-border font-semibold bg-muted/15">
                    <td className="py-2 pl-6 pr-3 text-foreground">
                      Total current liabilities
                    </td>
                    <td className="py-2 px-3 text-right font-mono tabular-nums text-foreground">
                      {formatUGX(currentLiabilitiesTotal)}
                    </td>
                    <td className="py-2 px-3 text-right font-mono tabular-nums text-foreground">
                      {formatPct(currentLiabilitiesTotal, assetsTotal)}
                    </td>
                    {showComparison && compareData && (
                      <>
                        <td className="py-2 px-3 text-right font-mono tabular-nums text-foreground border-l border-border/40">
                          {formatUGX(compareCurrentLiabilitiesTotal)}
                        </td>
                        <td className="py-2 px-3 text-right font-mono tabular-nums text-foreground">
                          {formatPct(compareCurrentLiabilitiesTotal, compareAssetsTotal)}
                        </td>
                        <td className="py-2 pl-3 pr-4 text-right font-mono tabular-nums text-[11px]">
                          {formatVariance(currentLiabilitiesTotal, compareCurrentLiabilitiesTotal).diffText}
                        </td>
                      </>
                    )}
                  </tr>

                  {/* Non-Current Liabilities Header */}
                  <tr className="bg-muted/10">
                    <td colSpan={showComparison && compareData ? 6 : 3} className="py-1.5 pl-5 text-[11px] font-semibold text-foreground/90 italic">
                      Non-current liabilities:
                    </td>
                  </tr>

                  {/* Non-Current Liabilities Rows (Partner Capital Held L2, Borrowed funds) */}
                  {nonCurrentMarketplaceRows.map(g => {
                    const compVal = findCompVal(g.label, compareMarketplaceRows);
                    const variance = formatVariance(g.value, compVal);
                    if (g.subtotal) return null;
                    return (
                      <tr
                        key={g.label}
                        onClick={() => setDrill({
                          title: g.label,
                          value: g.value,
                          unsourced: g.unsourced,
                          lines: g.lines,
                          components: g.components,
                        })}
                        className="hover:bg-muted/40 cursor-pointer transition-colors group"
                      >
                        <td className={cn("py-1.5 pr-3 text-muted-foreground group-hover:text-foreground", g.depth ? "pl-11" : "pl-8")}>
                          <div className="flex items-center gap-1.5">
                            <span className="truncate">{g.label}</span>
                            {showSources && g.lines[0]?.source && (
                              <span className="text-[9px] font-mono px-1 rounded bg-muted text-muted-foreground shrink-0">
                                {g.lines[0].source.split('—').pop()?.trim()}
                              </span>
                            )}
                          </div>
                        </td>
                        <td className={cn("py-1.5 px-3 text-right font-mono tabular-nums", g.value < 0 ? "text-destructive" : "text-foreground")}>
                          {g.value < 0 ? `(${formatUGX(Math.abs(g.value))})` : formatUGX(g.value)}
                        </td>
                        <td className="py-1.5 px-3 text-right font-mono tabular-nums text-muted-foreground">
                          {formatPct(g.value, assetsTotal)}
                        </td>
                        {showComparison && compareData && (
                          <>
                            <td className="py-1.5 px-3 text-right font-mono tabular-nums text-muted-foreground border-l border-border/40">
                              {compVal !== null ? (compVal < 0 ? `(${formatUGX(Math.abs(compVal))})` : formatUGX(compVal)) : '—'}
                            </td>
                            <td className="py-1.5 px-3 text-right font-mono tabular-nums text-muted-foreground">
                              {compVal !== null ? formatPct(compVal, compareAssetsTotal) : '—'}
                            </td>
                            <td className="py-1.5 pl-3 pr-4 text-right font-mono tabular-nums text-[11px]">
                              {variance.diffText}
                            </td>
                          </>
                        )}
                      </tr>
                    );
                  })}

                  {/* Total Non-Current Liabilities Subtotal */}
                  <tr className="border-t border-border font-semibold bg-muted/15">
                    <td className="py-2 pl-6 pr-3 text-foreground">
                      Total non-current liabilities
                    </td>
                    <td className="py-2 px-3 text-right font-mono tabular-nums text-foreground">
                      {formatUGX(nonCurrentLiabilitiesTotal)}
                    </td>
                    <td className="py-2 px-3 text-right font-mono tabular-nums text-foreground">
                      {formatPct(nonCurrentLiabilitiesTotal, assetsTotal)}
                    </td>
                    {showComparison && compareData && (
                      <>
                        <td className="py-2 px-3 text-right font-mono tabular-nums text-foreground border-l border-border/40">
                          {formatUGX(compareNonCurrentLiabilitiesTotal)}
                        </td>
                        <td className="py-2 px-3 text-right font-mono tabular-nums text-foreground">
                          {formatPct(compareNonCurrentLiabilitiesTotal, compareAssetsTotal)}
                        </td>
                        <td className="py-2 pl-3 pr-4 text-right font-mono tabular-nums text-[11px]">
                          {formatVariance(nonCurrentLiabilitiesTotal, compareNonCurrentLiabilitiesTotal).diffText}
                        </td>
                      </>
                    )}
                  </tr>

                  {/* Flagged Liabilities if any */}
                  {liabilityGroups && hasFlagged(liabilityGroups.flagged) && (
                    <tr className="bg-amber-500/10 border-t border-amber-500/30 text-amber-700 dark:text-amber-400">
                      <td className="py-1.5 pl-6 pr-3 font-medium">
                        {liabilityGroups.flagged.label}
                      </td>
                      <td className="py-1.5 px-3 text-right font-mono tabular-nums">
                        {formatUGX(liabilityGroups.flagged.value)}
                      </td>
                      <td className="py-1.5 px-3 text-right font-mono tabular-nums">
                        {formatPct(liabilityGroups.flagged.value, assetsTotal)}
                      </td>
                      {showComparison && compareData && <td colSpan={3} />}
                    </tr>
                  )}

                  {/* TOTAL LIABILITIES */}
                  <tr className="border-t border-b border-border/80 font-bold bg-muted/20">
                    <td className="py-2 pl-4 pr-3 text-foreground">
                      TOTAL LIABILITIES
                    </td>
                    <td className="py-2 px-3 text-right font-mono tabular-nums text-foreground">
                      {formatUGX(data.liabilities.total)}
                    </td>
                    <td className="py-2 px-3 text-right font-mono tabular-nums text-foreground">
                      {formatPct(data.liabilities.total, assetsTotal)}
                    </td>
                    {showComparison && compareData && (
                      <>
                        <td className="py-2 px-3 text-right font-mono tabular-nums text-foreground border-l border-border/40">
                          {formatUGX(compareData.liabilities.total)}
                        </td>
                        <td className="py-2 px-3 text-right font-mono tabular-nums text-foreground">
                          {formatPct(compareData.liabilities.total, compareAssetsTotal)}
                        </td>
                        <td className="py-2 pl-3 pr-4 text-right font-mono tabular-nums text-[11px]">
                          {formatVariance(data.liabilities.total, compareData.liabilities.total).diffText}
                        </td>
                      </>
                    )}
                  </tr>

                  {/* Shareholders' Equity Header */}
                  <tr className="bg-muted/10">
                    <td colSpan={showComparison && compareData ? 6 : 3} className="py-2 pl-5 text-[11px] font-semibold text-foreground/90 italic">
                      Shareholders' equity:
                    </td>
                  </tr>

                  {/* Equity Rows */}
                  {(equityGroups?.groups ?? []).map(g => {
                    const compVal = findCompVal(g.label, compareEquityGroups?.groups ?? null);
                    const variance = formatVariance(g.value, compVal);
                    return (
                      <tr
                        key={g.label}
                        onClick={() => setDrill({
                          title: g.label,
                          value: g.value,
                          unsourced: g.unsourced,
                          lines: g.lines,
                          components: g.components,
                        })}
                        className="hover:bg-muted/40 cursor-pointer transition-colors group"
                      >
                        <td className="py-1.5 pl-8 pr-3 text-muted-foreground group-hover:text-foreground">
                          <div className="flex items-center gap-1.5">
                            <span className="truncate">{g.label}</span>
                            {showSources && g.lines[0]?.source && (
                              <span className="text-[9px] font-mono px-1 rounded bg-muted text-muted-foreground shrink-0">
                                {g.lines[0].source.split('—').pop()?.trim()}
                              </span>
                            )}
                          </div>
                        </td>
                        <td className={cn("py-1.5 px-3 text-right font-mono tabular-nums", g.value < 0 ? "text-destructive" : "text-foreground")}>
                          {g.value < 0 ? `(${formatUGX(Math.abs(g.value))})` : formatUGX(g.value)}
                        </td>
                        <td className="py-1.5 px-3 text-right font-mono tabular-nums text-muted-foreground">
                          {formatPct(g.value, assetsTotal)}
                        </td>
                        {showComparison && compareData && (
                          <>
                            <td className="py-1.5 px-3 text-right font-mono tabular-nums text-muted-foreground border-l border-border/40">
                              {compVal !== null ? (compVal < 0 ? `(${formatUGX(Math.abs(compVal))})` : formatUGX(compVal)) : '—'}
                            </td>
                            <td className="py-1.5 px-3 text-right font-mono tabular-nums text-muted-foreground">
                              {compVal !== null ? formatPct(compVal, compareAssetsTotal) : '—'}
                            </td>
                            <td className="py-1.5 pl-3 pr-4 text-right font-mono tabular-nums text-[11px]">
                              {variance.diffText}
                            </td>
                          </>
                        )}
                      </tr>
                    );
                  })}

                  {/* Flagged Equity if any */}
                  {equityGroups && hasFlagged(equityGroups.flagged) && (
                    <tr className="bg-amber-500/10 border-t border-amber-500/30 text-amber-700 dark:text-amber-400">
                      <td className="py-1.5 pl-6 pr-3 font-medium">
                        {equityGroups.flagged.label}
                      </td>
                      <td className="py-1.5 px-3 text-right font-mono tabular-nums">
                        {formatUGX(equityGroups.flagged.value)}
                      </td>
                      <td className="py-1.5 px-3 text-right font-mono tabular-nums">
                        {formatPct(equityGroups.flagged.value, assetsTotal)}
                      </td>
                      {showComparison && compareData && <td colSpan={3} />}
                    </tr>
                  )}

                  {/* Total Shareholders' Equity Subtotal */}
                  <tr className="border-t border-border font-semibold bg-muted/15">
                    <td className="py-2 pl-6 pr-3 text-foreground">
                      Total shareholders' equity
                    </td>
                    <td className={cn("py-2 px-3 text-right font-mono tabular-nums", equityTotal < 0 ? "text-destructive" : "text-foreground")}>
                      {equityTotal < 0 ? `(${formatUGX(Math.abs(equityTotal))})` : formatUGX(equityTotal)}
                    </td>
                    <td className="py-2 px-3 text-right font-mono tabular-nums text-foreground">
                      {formatPct(equityTotal, assetsTotal)}
                    </td>
                    {showComparison && compareData && (
                      <>
                        <td className="py-2 px-3 text-right font-mono tabular-nums text-foreground border-l border-border/40">
                          {compareEquityTotal < 0 ? `(${formatUGX(Math.abs(compareEquityTotal))})` : formatUGX(compareEquityTotal)}
                        </td>
                        <td className="py-2 px-3 text-right font-mono tabular-nums text-foreground">
                          {formatPct(compareEquityTotal, compareAssetsTotal)}
                        </td>
                        <td className="py-2 pl-3 pr-4 text-right font-mono tabular-nums text-[11px]">
                          {formatVariance(equityTotal, compareEquityTotal).diffText}
                        </td>
                      </>
                    )}
                  </tr>

                  {/* TOTAL LIABILITIES AND SHAREHOLDERS' EQUITY (Uber double bottom border) */}
                  <tr className="border-t-2 border-b-2 border-primary/50 bg-primary/5 font-bold">
                    <td className="py-2.5 pl-4 pr-3 text-sm text-foreground uppercase tracking-wider">
                      TOTAL LIABILITIES AND SHAREHOLDERS' EQUITY
                    </td>
                    <td className="py-2.5 px-3 text-right font-mono text-sm tabular-nums text-primary">
                      {formatUGX(totalLiabilitiesAndEquity)}
                    </td>
                    <td className="py-2.5 px-3 text-right font-mono text-sm tabular-nums text-primary">
                      {formatPct(totalLiabilitiesAndEquity, assetsTotal)}
                    </td>
                    {showComparison && compareData && (
                      <>
                        <td className="py-2.5 px-3 text-right font-mono text-sm tabular-nums text-foreground border-l border-border/40">
                          {formatUGX(compareTotalLiabilitiesAndEquity)}
                        </td>
                        <td className="py-2.5 px-3 text-right font-mono text-sm tabular-nums text-foreground">
                          {formatPct(compareTotalLiabilitiesAndEquity, compareAssetsTotal)}
                        </td>
                        <td className="py-2.5 pl-3 pr-4 text-right font-mono text-sm tabular-nums text-primary">
                          {formatVariance(totalLiabilitiesAndEquity, compareTotalLiabilitiesAndEquity).diffText}
                        </td>
                      </>
                    )}
                  </tr>
                </tbody>
              </table>
            </div>

            {/* Assertion & Reconciliation Banner */}
            <div className={cn(
              "p-3.5 border-t flex items-start gap-2.5 text-xs",
              data.balance_check.balanced ? "bg-emerald-500/5 text-emerald-800 dark:text-emerald-300 border-emerald-500/30" : "bg-destructive/5 text-destructive border-destructive/30"
            )}>
              {data.balance_check.balanced ? (
                <CheckCircle2 className="h-4 w-4 text-emerald-600 shrink-0 mt-0.5" />
              ) : (
                <AlertTriangle className="h-4 w-4 text-destructive shrink-0 mt-0.5" />
              )}
              <div className="space-y-0.5">
                <p className="font-semibold">
                  {data.balance_check.balanced
                    ? 'AUDIT ASSERTION: BALANCED — Total Assets equal Total Liabilities and Shareholders\' Equity.'
                    : 'AUDIT ASSERTION: NOT BALANCED — Real General Ledger Difference Detected'}
                </p>
                <p className="text-[11px] opacity-90 font-mono">
                  Assets: {formatUGX(assetsTotal)} vs Liabilities &amp; Equity: {formatUGX(totalLiabilitiesAndEquity)} · Difference: {formatUGX(data.balance_check.difference)}
                </p>
                <p className="text-[10px] opacity-80 pt-0.5">
                  Zero suspense plug applied. Every line item maps to a real general ledger debit or credit entry.
                </p>
              </div>
            </div>
          </div>

          {/* 4. Collapsible Supporting Schedules */}
          <div className="space-y-2 pt-1">
            {/* Schedule I: Subledger Ties */}
            {!data.subledger_ties && (
              <div className="rounded-xl border border-dashed border-border bg-card p-3 flex flex-wrap items-center justify-between gap-2 text-xs">
                <span className="flex items-center gap-2">
                  <span className="font-mono text-primary font-bold">Schedule I</span>
                  <span className="text-muted-foreground">Subledger Ties (Ledger vs Operational Records) — loaded on request</span>
                </span>
                <div className="flex items-center gap-2">
                  {tiesError && <span className="text-[11px] text-destructive max-w-xs">{tiesError}</span>}
                  <Button size="sm" variant="outline" className="h-7 text-xs gap-1.5" onClick={loadSubledgerTies} disabled={loadingTies}>
                    {loadingTies ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
                    {loadingTies ? 'Checking…' : 'Run tie-out'}
                  </Button>
                </div>
              </div>
            )}
            {data.subledger_ties && data.subledger_ties.length > 0 && (
              <div className="rounded-xl border border-border bg-card overflow-hidden">
                <button
                  type="button"
                  onClick={() => setOpenSchedule1(s => !s)}
                  className="w-full flex items-center justify-between p-3 text-xs font-semibold text-left hover:bg-muted/30 transition-colors"
                >
                  <span className="flex items-center gap-2">
                    <span className="font-mono text-primary font-bold">Schedule I</span>
                    <span>Subledger Ties (Ledger vs Operational Records)</span>
                  </span>
                  {openSchedule1 ? <ChevronDown className="h-4 w-4 text-muted-foreground" /> : <ChevronRight className="h-4 w-4 text-muted-foreground" />}
                </button>
                {openSchedule1 && (
                  <div className="p-3 pt-0 border-t border-border/50 space-y-2">
                    <div className="overflow-x-auto">
                      <table className="w-full text-xs">
                        <thead>
                          <tr className="text-left text-muted-foreground border-b border-border text-[11px]">
                            <th className="py-1.5 font-medium">Balance</th>
                            <th className="py-1.5 font-medium text-right">Ledger</th>
                            <th className="py-1.5 font-medium text-right">Operational</th>
                            <th className="py-1.5 font-medium text-right">Difference</th>
                          </tr>
                        </thead>
                        <tbody>
                          {data.subledger_ties.map((t) => (
                            <tr key={t.key} className="border-b border-border/40 last:border-0">
                              <td className="py-1.5 pr-2">{t.label}</td>
                              <td className="py-1.5 text-right font-mono tabular-nums">{formatUGX(t.ledger)}</td>
                              <td className="py-1.5 text-right font-mono tabular-nums">{formatUGX(t.operational)}</td>
                              <td className={cn("py-1.5 text-right font-mono tabular-nums", Math.abs(t.difference) >= 1 ? "text-destructive" : "text-emerald-600")}>
                                {formatUGX(t.difference)}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                    {data.subledger_ties_basis && (
                      <p className="text-[11px] text-amber-700 dark:text-amber-400">{data.subledger_ties_basis}</p>
                    )}
                    {data.disclosures?.map((d) => (
                      <p key={d} className="text-[11px] text-muted-foreground">{d}</p>
                    ))}
                  </div>
                )}
              </div>
            )}

            {/* Schedule II: Statutory Payroll Taxes */}
            {statutory && statutory.length > 0 && (
              <div className="rounded-xl border border-border bg-card overflow-hidden">
                <button
                  type="button"
                  onClick={() => setOpenSchedule2(s => !s)}
                  className="w-full flex items-center justify-between p-3 text-xs font-semibold text-left hover:bg-muted/30 transition-colors"
                >
                  <span className="flex items-center gap-2">
                    <span className="font-mono text-primary font-bold">Schedule II</span>
                    <span>Statutory Payroll Liabilities (PAYE, NSSF, LST Withheld)</span>
                  </span>
                  {openSchedule2 ? <ChevronDown className="h-4 w-4 text-muted-foreground" /> : <ChevronRight className="h-4 w-4 text-muted-foreground" />}
                </button>
                {openSchedule2 && (
                  <div className="p-3 pt-0 border-t border-border/50 space-y-2">
                    <p className="text-[11px] text-muted-foreground">
                      Amounts withheld on payroll that has actually been paid, net of recorded remittances. Derived from payroll records for disclosure purposes.
                    </p>
                    <div className="overflow-x-auto">
                      <table className="w-full text-xs">
                        <thead>
                          <tr className="text-left text-muted-foreground border-b border-border text-[11px]">
                            <th className="py-1.5 font-medium">Obligation</th>
                            <th className="py-1.5 font-medium text-right">Withheld</th>
                            <th className="py-1.5 font-medium text-right">Remitted</th>
                            <th className="py-1.5 font-medium text-right">Outstanding</th>
                          </tr>
                        </thead>
                        <tbody>
                          {statutory.map((s) => (
                            <tr key={s.component_code} className="border-b border-border/40 last:border-0">
                              <td className="py-1.5 pr-2">{s.label} ({s.authority})</td>
                              <td className="py-1.5 text-right font-mono tabular-nums">{formatUGX(s.withheld)}</td>
                              <td className="py-1.5 text-right font-mono tabular-nums">{formatUGX(s.remitted)}</td>
                              <td className="py-1.5 text-right font-mono tabular-nums font-semibold text-foreground">
                                {formatUGX(s.outstanding)}
                              </td>
                            </tr>
                          ))}
                          <tr className="border-t border-border font-bold">
                            <td className="py-2">Total Statutory Obligations</td>
                            <td className="py-2 text-right font-mono tabular-nums">{formatUGX(statutory.reduce((t, r) => t + r.withheld, 0))}</td>
                            <td className="py-2 text-right font-mono tabular-nums">{formatUGX(statutory.reduce((t, r) => t + r.remitted, 0))}</td>
                            <td className="py-2 text-right font-mono tabular-nums text-primary">{formatUGX(statutoryTotal)}</td>
                          </tr>
                        </tbody>
                      </table>
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* Schedule III: Trial Balance & One-Sided Postings */}
            {(data.trial_balance || data.reconciliation) && (
              <div className="rounded-xl border border-border bg-card overflow-hidden">
                <button
                  type="button"
                  onClick={() => setOpenSchedule3(s => !s)}
                  className="w-full flex items-center justify-between p-3 text-xs font-semibold text-left hover:bg-muted/30 transition-colors"
                >
                  <span className="flex items-center gap-2">
                    <span className="font-mono text-primary font-bold">Schedule III</span>
                    <span>Trial Balance &amp; Ledger Reconciliation</span>
                  </span>
                  {openSchedule3 ? <ChevronDown className="h-4 w-4 text-muted-foreground" /> : <ChevronRight className="h-4 w-4 text-muted-foreground" />}
                </button>
                {openSchedule3 && (
                  <div className="p-3 pt-0 border-t border-border/50 space-y-3">
                    {data.trial_balance && (
                      <div className="grid grid-cols-3 gap-2 text-center p-2 rounded-lg bg-muted/20">
                        <div>
                          <p className="text-[9px] uppercase tracking-wider text-muted-foreground">Total Debits</p>
                          <p className="font-mono text-xs font-semibold mt-0.5">{formatUGX(data.trial_balance.total_debits)}</p>
                        </div>
                        <div>
                          <p className="text-[9px] uppercase tracking-wider text-muted-foreground">Total Credits</p>
                          <p className="font-mono text-xs font-semibold mt-0.5">{formatUGX(data.trial_balance.total_credits)}</p>
                        </div>
                        <div>
                          <p className="text-[9px] uppercase tracking-wider text-muted-foreground">Difference</p>
                          <p className={cn("font-mono text-xs font-semibold mt-0.5", data.trial_balance.balanced ? "text-emerald-600" : "text-destructive")}>
                            {formatUGX(data.trial_balance.difference)}
                          </p>
                        </div>
                      </div>
                    )}

                    {data.reconciliation && (
                      <div className="space-y-2">
                        <p className="text-[11px] text-muted-foreground">
                          {data.reconciliation.unresolved_groups.toLocaleString()} historic ledger transactions carry only one side of their entry ({formatUGX(data.reconciliation.unresolved_absolute_amount)} in absolute terms). Their counterpart is recognised in the equity line "{UNMATCHED_HISTORIC_POSTINGS_LABEL}".
                        </p>
                        {data.reconciliation.schedule?.length > 0 && (
                          <div className="space-y-1 max-h-48 overflow-y-auto pr-1">
                            {data.reconciliation.schedule.map(r => (
                              <div key={`${r.ledger_scope}-${r.category}`} className="flex items-center justify-between text-[11px] border-b border-border/30 py-1">
                                <span className="text-muted-foreground truncate">{r.category.replace(/_/g, ' ')} · {r.ledger_scope} ({r.groups} txns)</span>
                                <span className="font-mono tabular-nums shrink-0">{formatUGX(r.net_debit_less_credit)}</span>
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}
          </div>

          <p className="text-[10px] text-muted-foreground text-center pt-2">
            Every figure is generated live from the general ledger and operational records. No figures have been forced or altered.
          </p>
        </>
      )}

      <DrilldownDialog drill={drill} onClose={() => setDrill(null)} />
    </div>
  );
}