import { useCallback, useEffect, useState } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Calendar as CalendarPicker } from '@/components/ui/calendar';
import { cn } from '@/lib/utils';
import {
  classifyAssets, classifyLiabilities, classifyEquity, hasFlagged, visibleFlaggedLines,
  expandLandlordFloat,
  type BsGroup, type LandlordFloatSplit,
} from '@/components/cfo/balanceSheetClassification';
import { formatDynamic as formatUGX } from '@/lib/currencyFormat';
import { useReceivablesBreakdown } from '@/hooks/useReceivables';
import { format, endOfDay } from 'date-fns';
import {
  AlertTriangle, Calendar, CheckCircle2, ChevronDown, ChevronRight,
  Download, FileSpreadsheet, Loader2, RefreshCw,
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
  balance_check: {
    total_assets: number;
    total_liabilities_and_equity: number;
    difference: number;
    balanced: boolean;
    state?: 'balanced' | 'failed';
    message?: string;
  };
}

/** Payload for the tap-to-drill-down modal. */
interface Drilldown {
  title: string;
  value: number;
  unsourced?: boolean;
  /** Plain-language explanation for derived values that are not a direct account line. */
  sourceNote?: string;
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

/** Reporting account code embedded in a line's source ("... — account A1"). */
function accountCodeOf(line: PositionLine): string | null {
  const m = /account\s+([A-Za-z]\d+)/.exec(line.source ?? '');
  return m ? m[1].toUpperCase() : null;
}

interface AccountDetail {
  account_code: string;
  net: number;
  legs: number;
  shown: number;
  truncated: boolean;
  categories: { category: string; ledger_scope: string; legs: number; net: number }[];
  transactions: {
    transaction_group_id: string | null;
    transaction_date: string;
    category: string;
    source_table: string | null;
    net: number;
  }[];
}

/**
 * Second drill level: the ledger activity behind one reporting account, grouped
 * by movement category plus the most recent individual entries. Everything is
 * computed server-side by `get_sofp_account_detail`, which reads the same
 * `sofp_ledger_legs` basis as the statement itself — read-only, no new maths.
 */
function AccountActivity({ accountCode, asAt }: { accountCode: string; asAt: Date }) {
  const [open, setOpen] = useState(false);
  const [detail, setDetail] = useState<AccountDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const toggle = async () => {
    const next = !open;
    setOpen(next);
    if (!next || detail || loading) return;
    setLoading(true);
    setError(null);
    const { data, error: rpcError } = await supabase.rpc('get_sofp_account_detail', {
      p_as_at: endOfDay(asAt).toISOString(),
      p_account_code: accountCode,
      p_limit: 50,
    });
    if (rpcError) setError(rpcError.message);
    else setDetail(data as unknown as AccountDetail);
    setLoading(false);
  };

  return (
    <div className="mt-1">
      <button
        type="button"
        onClick={toggle}
        className="flex items-center gap-1 text-[10px] font-medium text-primary"
      >
        {open ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
        {open ? 'Hide activity detail' : 'See activity detail'}
      </button>
      {open && (
        <div className="mt-1 rounded-md border border-border/60 bg-muted/20 p-2">
          {loading && (
            <p className="flex items-center gap-1 text-[10px] text-muted-foreground">
              <Loader2 className="h-3 w-3 animate-spin" /> Loading activity…
            </p>
          )}
          {error && <p className="text-[10px] text-destructive">Could not load the detail: {error}</p>}
          {detail && (
            <div className="space-y-2">
              <p className="text-[10px] text-muted-foreground">
                {detail.legs.toLocaleString()} ledger entries up to the selected date · net {fmtAmount(detail.net)}
              </p>
              {detail.categories.length > 0 && (
                <div>
                  <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">By category</p>
                  {detail.categories.map(c => (
                    <div key={`${c.ledger_scope}-${c.category}`} className="flex items-start justify-between gap-3 py-0.5">
                      <span className="text-[11px] text-muted-foreground truncate">
                        {c.category} <span className="text-muted-foreground/60">({c.ledger_scope} · {c.legs.toLocaleString()})</span>
                      </span>
                      <span className={cn('font-mono text-[11px] shrink-0', c.net < 0 ? 'text-destructive' : '')}>
                        {fmtAmount(c.net)}
                      </span>
                    </div>
                  ))}
                </div>
              )}
              {detail.transactions.length > 0 && (
                <div>
                  <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Recent entries</p>
                  {detail.transactions.map((t, i) => (
                    <div key={`${t.transaction_group_id ?? 'x'}-${i}`} className="flex items-start justify-between gap-3 py-0.5">
                      <span className="text-[11px] text-muted-foreground truncate">
                        {format(new Date(t.transaction_date), 'dd MMM yyyy')} · {t.category}
                        {t.source_table ? <span className="text-muted-foreground/60"> · {t.source_table}</span> : null}
                      </span>
                      <span className={cn('font-mono text-[11px] shrink-0', t.net < 0 ? 'text-destructive' : '')}>
                        {fmtAmount(t.net)}
                      </span>
                    </div>
                  ))}
                </div>
              )}
              {detail.legs === 0 && (
                <p className="text-[10px] text-muted-foreground">No ledger activity on this account up to the selected date.</p>
              )}
              {detail.truncated && (
                <p className="text-[10px] text-muted-foreground/70">
                  Showing the {detail.shown} most recent entries only — older activity is still included in the balance above.
                </p>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/* ---------------------------------------------------------------------------
 * Receivables detail: the actual outstanding receivables behind a receivables
 * line — who owes it, the exact amount, when it is due and its status. Read
 * from the authoritative server-side definition (`get_receivables_breakdown`
 * over `v_receivables_lines`); no receivables maths is done here.
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

function ReceivablesDetail({ categoryKey }: { categoryKey: string }) {
  const [open, setOpen] = useState(false);
  const { data, isLoading, error } = useReceivablesBreakdown(open);
  const category = (data?.categories ?? []).find(c => c.key === categoryKey);

  return (
    <div className="mt-1">
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        className="flex items-center gap-1 text-[10px] font-medium text-primary"
      >
        {open ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
        {open ? 'Hide the actual receivables' : 'See the actual receivables'}
      </button>
      {open && (
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
          {data && !category && (
            <p className="text-[10px] text-muted-foreground">No outstanding receivables recorded here.</p>
          )}
          {category && (
            <div className="space-y-2">
              <p className="text-[10px] text-muted-foreground">
                {category.item_count.toLocaleString()} outstanding receivables · total {fmtAmount(category.outstanding)}
              </p>
              {category.products.map(p => (
                <div key={p.key}>
                  <div className="flex items-start justify-between gap-3">
                    <span className="text-[11px] font-medium text-foreground truncate">
                      {p.label} <span className="text-muted-foreground/70">({p.item_count.toLocaleString()})</span>
                    </span>
                    <span className="font-mono text-[11px] shrink-0">{fmtAmount(p.outstanding)}</span>
                  </div>
                  {p.items.map(it => (
                    <div key={it.item_id} className="flex items-start justify-between gap-3 py-0.5 pl-2">
                      <span className="text-[11px] text-muted-foreground truncate">
                        {it.counterparty || 'Unnamed account'}
                        {it.due_date ? (
                          <span className="text-muted-foreground/60">
                            {' '}· due {format(new Date(it.due_date), 'dd MMM yyyy')}
                            {it.due_kind === 'projected' ? ' (expected)' : ''}
                          </span>
                        ) : null}
                        {it.status ? <span className="text-muted-foreground/60"> · {it.status}</span> : null}
                      </span>
                      <span className="font-mono text-[11px] shrink-0">{fmtAmount(it.amount)}</span>
                    </div>
                  ))}
                  {p.item_count > p.items.length && (
                    <p className="pl-2 text-[10px] text-muted-foreground/70">
                      Showing the {p.items.length} largest of {p.item_count.toLocaleString()} — the total above includes them all.
                    </p>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** One line inside the modal: its amount, where the value comes from, and its activity. */
function ModalLine({ line, asAt, size = 'sm' }: { line: PositionLine; asAt: Date; size?: 'sm' | 'xs' }) {
  const code = accountCodeOf(line);
  const receivablesKey = receivablesCategoryOf(line.label);
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
      <p className="mt-0.5 text-[10px] text-muted-foreground/70 break-words">
        <span className="font-medium text-muted-foreground">Value source:</span>{' '}
        {line.source || 'Calculated from the displayed balance-sheet components'}
      </p>
      {receivablesKey && <ReceivablesDetail categoryKey={receivablesKey} />}
      {code && <AccountActivity accountCode={code} asAt={asAt} />}
    </div>
  );
}

/** The drill-down modal: account-level breakdown of any tapped line or total. */
function DrilldownDialog({ drill, asAt, onClose }: { drill: Drilldown | null; asAt: Date; onClose: () => void }) {
  const fmt = fmtAmount;
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
              {drill.unsourced && (
                <p className="text-[10px] text-muted-foreground">
                  No ledger account maps here yet — any balance sits in an operational sub-ledger and is shown under memo sub-ledgers, not in the ledger totals.
                </p>
              )}
              {drill.sourceNote && (
                <div className="rounded-md border border-border bg-muted/30 p-2">
                  <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Value source</p>
                  <p className="mt-0.5 text-xs text-foreground">{drill.sourceNote}</p>
                </div>
              )}
              {receivablesCategoryOf(drill.title) && (
                <div className="space-y-1">
                  <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                    Actual receivables behind this balance
                  </p>
                  <ReceivablesDetail categoryKey={receivablesCategoryOf(drill.title) as string} />
                </div>
              )}
              {drill.components && drill.components.length > 0 && (
                <div className="space-y-1">
                  <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Where this balance comes from</p>
                  {drill.components.map(c => (
                    <div key={c.label} className="border-b border-border/40 py-1.5 last:border-0">
                      <ModalLine line={c} asAt={asAt} />
                    </div>
                  ))}
                </div>
              )}
              {drill.groups && drill.groups.length > 0 && (
                <div className="space-y-1">
                  <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Where this total comes from</p>
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
                          <ModalLine line={c} asAt={asAt} size="xs" />
                        </div>
                      ))}
                      {g.lines.length > 0 ? (
                        <div className="mt-1 space-y-1 pl-4">
                          {g.lines.map(l => (
                            <div key={`${g.label}-${l.label}`} className="border-l border-border/60 pl-2">
                              <ModalLine line={l} asAt={asAt} size="xs" />
                            </div>
                          ))}
                        </div>
                      ) : g.unsourced ? (
                        <p className="mt-1 pl-4 text-[10px] text-muted-foreground/70">
                          Value source: operational records outside the ledger; no mapped ledger account is available yet.
                        </p>
                      ) : (
                        <p className="mt-1 pl-4 text-[10px] text-muted-foreground/70">
                          Value source: calculated from the displayed balance-sheet components.
                        </p>
                      )}
                    </div>
                  ))}
                </div>
              )}
              {drill.lines && drill.lines.length > 0 && (
                <div className="space-y-1">
                  <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">Where this balance comes from</p>
                  {drill.lines.map(l => (
                    <div key={l.label} className="border-b border-border/40 py-1.5 last:border-0">
                      <ModalLine line={l} asAt={asAt} />
                    </div>
                  ))}
                </div>
              )}
              {(!drill.lines || drill.lines.length === 0) && (!drill.groups || drill.groups.length === 0) && (!drill.components || drill.components.length === 0) && !drill.unsourced && (
                <p className="text-[10px] text-muted-foreground">No further account-level breakdown is available for this line.</p>
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

export default function BalanceSheetPanel() {
  const [asAt, setAsAt] = useState<Date>(new Date());
  const [data, setData] = useState<StatementOfFinancialPosition | null>(null);
  const [loading, setLoading] = useState(false);
  const [showSources, setShowSources] = useState(false);
  const [exporting, setExporting] = useState(false);
  /** Presentation-only breakdown of the existing Landlord Float. */
  const [floatSplit, setFloatSplit] = useState<LandlordFloatSplit | null>(null);
  /** Line or total the user tapped, shown as a modal breakdown. */
  const [drill, setDrill] = useState<Drilldown | null>(null);

  const load = useCallback(async (date: Date) => {
    setLoading(true);
    try {
      const asAtIso = endOfDay(date).toISOString();
      const { data: res, error } = await (supabase as any).rpc('get_statement_of_financial_position', {
        p_as_at: asAtIso,
      });
      if (error) throw error;
      setData(res as StatementOfFinancialPosition);

      const { data: split, error: splitError } = await (supabase as any).rpc('get_landlord_float_management_split', {
        p_as_at: asAtIso,
      });
      if (splitError) console.warn('Landlord float split unavailable:', splitError.message);
      setFloatSplit((split as LandlordFloatSplit) ?? null);
    } catch (e: any) {
      toast.error(e?.message ?? 'Failed to generate the statement of financial position');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(asAt); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const title = `WELILE — BALANCE SHEET — As at ${format(asAt, 'dd MMMM yyyy')}`;
  const assetGroups = data
    ? classifyAssets([...data.assets.current, ...data.assets.non_current])
    : null;
  const liabilityGroups = data
    ? classifyLiabilities([...data.liabilities.current, ...data.liabilities.non_current])
    : null;
  // E3 and E4 are equity accounts in ledger_account_catalog and are reported in
  // equity. They were briefly reclassified onto the asset side as components of
  // Intangible Assets, which inverted their sign and produced a negative
  // intangible asset; per BIS approval that reclassification is removed. Every
  // total below is now the RPC's own figure, with nothing added or moved.
  const equityGroups = data ? classifyEquity(data.equity.lines) : null;
  const assetRows = assetGroups?.groups ?? [];
  const assetsTotal = data ? data.assets.total : 0;
  const equityTotal = data ? data.equity.total : 0;
  const totalLiabilitiesAndEquity = data
    ? data.balance_check.total_liabilities_and_equity
    : 0;
  const marketplaceRows = expandLandlordFloat(liabilityGroups?.marketplace ?? [], floatSplit);
  /** Each section's groups must still sum to the RPC's own total. */
  const assetDrift = data && assetGroups ? Math.round(assetGroups.total - data.assets.total) : 0;
  const equityDrift = data && equityGroups ? Math.round(equityGroups.total - equityTotal) : 0;
  const liabilityGroupDrift = data && liabilityGroups
    ? Math.round(liabilityGroups.total - data.liabilities.total)
    : 0;

  const exportCSV = () => {
    if (!data) return;
    const rows: (string | number)[][] = [[title], []];
    rows.push(['ASSETS', '']);
    assetRows.forEach(g => {
      rows.push([g.label, g.heading ? '' : g.value]);
      (g.components ?? []).forEach(c => rows.push(['   ' + c.label, c.value]));
    });
    if (assetGroups && hasFlagged(assetGroups.flagged)) {
      rows.push([assetGroups.flagged.label, assetGroups.flagged.value]);
      visibleFlaggedLines(assetGroups.flagged).forEach(l => rows.push(['   ' + l.label, l.value]));
    }
    rows.push(['TOTAL ASSETS', assetsTotal]);
    rows.push([]);
    rows.push(['LIABILITIES', '']);
    (liabilityGroups?.standalone ?? []).forEach(g => rows.push([g.label, g.value]));
    rows.push(['Market Place Liabilities', '']);
    marketplaceRows.forEach(g => {
      const pad = '   '.repeat(1 + (g.depth ?? 0));
      // A heading names the block below it; its figure is on the block's total.
      rows.push([pad + g.label, g.heading ? '' : g.value]);
      (g.components ?? []).forEach(c => rows.push([pad + '   ' + c.label, c.value]));
    });
    rows.push(['Subtotal — Market Place Liabilities', liabilityGroups?.marketplaceTotal ?? 0]);
    if (liabilityGroups && hasFlagged(liabilityGroups.flagged)) {
      rows.push([liabilityGroups.flagged.label, liabilityGroups.flagged.value]);
      visibleFlaggedLines(liabilityGroups.flagged).forEach(l => rows.push(['   ' + l.label, l.value]));
    }
    rows.push(['TOTAL LIABILITIES', data.liabilities.total]);
    rows.push([]);
    rows.push(["SHAREHOLDERS' EQUITY", '']);
    (equityGroups?.groups ?? []).forEach(g => rows.push([g.label, g.value]));
    if (equityGroups && hasFlagged(equityGroups.flagged)) {
      rows.push([equityGroups.flagged.label, equityGroups.flagged.value]);
      visibleFlaggedLines(equityGroups.flagged).forEach(l => rows.push(['   ' + l.label, l.value]));
    }
    rows.push(["TOTAL SHAREHOLDERS' EQUITY", equityTotal]);
    rows.push([]);
    rows.push(['TOTAL LIABILITIES AND EQUITY', totalLiabilitiesAndEquity]);
    rows.push(['Balance check difference', data.balance_check.difference]);
    rows.push(['Balanced', data.balance_check.balanced ? 'YES' : 'NO']);
    if (data.trial_balance) {
      rows.push([]);
      rows.push(['TRIAL BALANCE', '']);
      rows.push(['Total debits', data.trial_balance.total_debits]);
      rows.push(['Total credits', data.trial_balance.total_credits]);
      rows.push(['Difference', data.trial_balance.difference]);
    }
    if (data.reconciliation) {
      rows.push([]);
      rows.push(['UNRESOLVED ONE-SIDED LEDGER POSTINGS', '']);
      rows.push(['Transactions affected', data.reconciliation.unresolved_groups]);
      rows.push(['Absolute amount', data.reconciliation.unresolved_absolute_amount]);
      rows.push(['Suspense plug applied', 'NO — no plug is used; the balance check is a real assertion']);
      rows.push(['Unreconciled difference (assets less liabilities and equity)', data.reconciliation.unreconciled_difference ?? data.balance_check.difference]);
      data.reconciliation.schedule?.forEach(r =>
        rows.push([`${r.category} (${r.ledger_scope}) — ${r.groups} transactions`, r.net_debit_less_credit]));
      rows.push([]);
      rows.push(['MEMO — NOT IN TOTALS', '']);
      data.reconciliation.memo_sub_ledgers?.forEach(l => rows.push([l.label, l.value]));
    }

    const csv = rows.map(r => r.map(c => `"${String(c ?? '').replace(/"/g, '""')}"`).join(',')).join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `welile-statement-of-financial-position-${format(asAt, 'yyyy-MM-dd')}.csv`;
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

      pdf.setFillColor(37, 99, 235);
      pdf.rect(0, 0, pw, 12, 'F');
      pdf.setTextColor(255, 255, 255);
      pdf.setFontSize(10);
      pdf.setFont('helvetica', 'bold');
      pdf.text('WELILE TECHNOLOGIES LIMITED', margin, 8);
      pdf.text('CONFIDENTIAL', pw - margin - 25, 8);

      pdf.setTextColor(0, 0, 0);
      pdf.setFontSize(13);
      pdf.text('BALANCE SHEET', margin, y);
      y += 6;
      pdf.setFontSize(9);
      pdf.setFont('helvetica', 'normal');
      pdf.setTextColor(100, 100, 100);
      pdf.text(`As at ${format(asAt, 'dd MMMM yyyy')}`, margin, y);
      pdf.text(`Generated: ${format(new Date(data.generated_at), 'dd MMM yyyy, HH:mm')}`, pw - margin - 60, y);
      y += 3;
      pdf.setDrawColor(220, 220, 220);
      pdf.line(margin, y, pw - margin, y);
      y += 6;

      const heading = (t: string) => {
        if (y > ph - 30) { pdf.addPage(); y = 20; }
        pdf.setFontSize(8);
        pdf.setFont('helvetica', 'bold');
        pdf.setTextColor(37, 99, 235);
        pdf.text(t.toUpperCase(), margin, y);
        pdf.setTextColor(0, 0, 0);
        y += 5;
      };
      const row = (label: string, value: number, bold = false, indent = true) => {
        if (y > ph - 20) { pdf.addPage(); y = 20; }
        pdf.setFontSize(bold ? 9 : 8);
        pdf.setFont('helvetica', bold ? 'bold' : 'normal');
        pdf.setTextColor(bold ? 0 : 80, bold ? 0 : 80, bold ? 0 : 80);
        pdf.text(label, indent && !bold ? margin + 5 : margin, y);
        const str = value < 0 ? `(${formatUGX(Math.abs(value))})` : formatUGX(value);
        pdf.text(str, pw - margin, y, { align: 'right' });
        if (bold) { pdf.setDrawColor(200, 200, 200); pdf.line(margin, y + 1.5, pw - margin, y + 1.5); }
        y += bold ? 7 : 5;
      };

      /** A block heading: names the rows beneath it and carries no amount. */
      const blockHeading = (label: string) => {
        if (y > ph - 20) { pdf.addPage(); y = 20; }
        pdf.setFontSize(8);
        pdf.setFont('helvetica', 'bold');
        pdf.setTextColor(60, 60, 60);
        pdf.text(label, margin + 2, y);
        pdf.setTextColor(0, 0, 0);
        y += 5;
      };

      const flaggedRows = (g?: BsGroup) => {
        if (!g || !hasFlagged(g)) return;
        row(g.label, g.value, true);
        visibleFlaggedLines(g).forEach(l => row('   ' + l.label, l.value));
      };

      heading('Assets');
      assetRows.forEach(g => {
        if (g.heading) blockHeading(g.label);
        else row(g.label, g.value, g.subtotal);
        (g.components ?? []).forEach(c => row('   ' + c.label, c.value));
      });
      flaggedRows(assetGroups?.flagged);
      row('TOTAL ASSETS', assetsTotal, true);

      heading('Liabilities');
      (liabilityGroups?.standalone ?? []).forEach(g => row(g.label, g.value));
      heading('Market Place Liabilities');
      marketplaceRows.forEach(g => {
        const pad = '   '.repeat(g.depth ?? 0);
        if (g.heading) blockHeading(pad + g.label);
        else row(pad + g.label, g.value, g.subtotal);
        (g.components ?? []).forEach(c => row(pad + '   ' + c.label, c.value));
      });
      row('Subtotal — Market Place Liabilities', liabilityGroups?.marketplaceTotal ?? 0, true);
      flaggedRows(liabilityGroups?.flagged);
      row('TOTAL LIABILITIES', data.liabilities.total, true);

      heading("Shareholders' Equity");
      (equityGroups?.groups ?? []).forEach(g => row(g.label, g.value));
      flaggedRows(equityGroups?.flagged);
      row("TOTAL SHAREHOLDERS' EQUITY", equityTotal, true);

      heading('Balance Check');
      row('Total Assets', assetsTotal);
      row('Total Liabilities and Equity', totalLiabilitiesAndEquity);
      row('Difference', data.balance_check.difference, true);
      if (data.trial_balance) {
        heading('Trial Balance');
        row('Total Debits', data.trial_balance.total_debits);
        row('Total Credits', data.trial_balance.total_credits);
        row('Difference', data.trial_balance.difference, true);
      }
      if (data.reconciliation) {
        heading('Unresolved one-sided ledger postings');
        row(`Transactions affected: ${data.reconciliation.unresolved_groups.toLocaleString()}`, data.reconciliation.unresolved_absolute_amount);
        row(
          'Unreconciled difference (no suspense plug applied)',
          data.reconciliation.unreconciled_difference ?? data.balance_check.difference,
          true,
        );
        data.reconciliation.schedule?.forEach(r =>
          row(`${r.category.replace(/_/g, ' ')} · ${r.ledger_scope} · ${r.groups} txns`, r.net_debit_less_credit));
        heading('Memo — operational records and wallet caches (not in totals)');
        data.reconciliation.memo_sub_ledgers?.forEach(l => row(l.label, l.value));
      }
      pdf.setFontSize(8);
      pdf.setFont('helvetica', 'bold');
      pdf.setTextColor(...(data.balance_check.balanced ? [22, 163, 74] : [220, 38, 38]) as [number, number, number]);
      pdf.text(
        data.balance_check.balanced
          ? 'BALANCED — Total Assets = Total Liabilities + Equity'
          : 'NOT BALANCED — difference shown above; no figures have been adjusted',
        margin, y,
      );

      pdf.setFillColor(37, 99, 235);
      pdf.rect(0, ph - 8, pw, 8, 'F');
      pdf.setTextColor(255, 255, 255);
      pdf.setFontSize(7);
      pdf.text('Welile Technologies Limited — Confidential Financial Report — All figures in UGX', pw / 2, ph - 3, { align: 'center' });

      const fileName = `welile-statement-of-financial-position-${format(asAt, 'yyyy-MM-dd')}.pdf`;
      const blob = pdf.output('blob');
      const file = new File([blob], fileName, { type: 'application/pdf' });
      if (navigator.share && navigator.canShare?.({ files: [file] })) {
        await navigator.share({ title: 'Welile Balance Sheet', files: [file] });
      } else {
        pdf.save(fileName);
        toast.success('PDF downloaded');
      }
    } catch (e: any) {
      if (e?.name !== 'AbortError') toast.error('PDF export failed');
    } finally {
      setExporting(false);
    }
  };

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <Popover>
          <PopoverTrigger asChild>
            <Button size="sm" variant="outline" className="h-7 text-xs gap-1">
              <Calendar className="h-3.5 w-3.5" />
              As at {format(asAt, 'dd MMM yyyy')}
            </Button>
          </PopoverTrigger>
          <PopoverContent className="w-auto p-0 z-[200]" align="start">
            <CalendarPicker
              mode="single"
              selected={asAt}
              onSelect={(d) => { if (d) { setAsAt(d); load(d); } }}
              initialFocus
              className="p-3 pointer-events-auto"
            />
          </PopoverContent>
        </Popover>
        <Button size="sm" className="h-7 text-xs gap-1" onClick={() => load(asAt)} disabled={loading}>
          {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
          {data ? 'Refresh' : 'Generate'}
        </Button>
        <Button
          size="sm"
          variant={showSources ? 'default' : 'outline'}
          className="h-7 text-xs"
          onClick={() => setShowSources(s => !s)}
        >
          {showSources ? 'Hide account detail' : 'Show account detail'}
        </Button>
      </div>

      {loading && !data && (
        <div className="py-10 text-center text-muted-foreground text-xs">
          <Loader2 className="h-5 w-5 animate-spin mx-auto mb-2" />
          Building the statement from the general ledger…
        </div>
      )}

      {data && (
        <>
          <div className="text-center pb-2 border-b border-border">
            <p className="text-[11px] font-bold uppercase tracking-widest">Welile — Balance Sheet</p>
            <p className="text-[10px] text-muted-foreground">Balance Sheet — As at {format(asAt, 'dd MMMM yyyy')} · All figures in {data.currency}</p>
          </div>

          <div
            className={cn(
              'rounded-lg border p-3 flex items-start gap-2',
              data.balance_check.balanced ? 'border-success/40 bg-success/5' : 'border-destructive/40 bg-destructive/5',
            )}
          >
            {data.balance_check.balanced
              ? <CheckCircle2 className="h-4 w-4 text-success mt-0.5 shrink-0" />
              : <AlertTriangle className="h-4 w-4 text-destructive mt-0.5 shrink-0" />}
            <div className="min-w-0 space-y-1">
              <p className={cn('text-xs font-semibold', data.balance_check.balanced ? 'text-success' : 'text-destructive')}>
                {data.balance_check.balanced
                  ? 'Balanced — Total Assets = Total Liabilities + Equity (real ledger data, no plug)'
                  : 'BALANCE CHECK FAILED — Total Assets do not equal Total Liabilities + Equity'}
              </p>
              <p className="text-[10px] font-mono text-muted-foreground break-words">
                {formatUGX(assetsTotal)} vs {formatUGX(totalLiabilitiesAndEquity)} · Difference {formatUGX(data.balance_check.difference)}
              </p>
              {!data.balance_check.balanced && (
                <p className="text-[10px] text-destructive/90 break-words">
                  {data.balance_check.message
                    ?? 'No suspense plug has been applied — the difference above is real and must be resolved in the ledger.'}
                </p>
              )}
            </div>
          </div>

          <div className="grid gap-4 lg:grid-cols-2">
            <div>
              <Badge variant="outline" className="text-[10px]">Assets</Badge>
              <SectionHeading>Assets</SectionHeading>
              <div>
                {assetRows.map(g => (
                  g.subtotal
                    ? <TotalRow
                        key={g.label} label={g.label} value={g.value} depth={g.depth}
                        onOpen={() => setDrill({
                          title: g.label, value: g.value,
                          sourceNote: 'Calculated by adding the asset lines shown in this section.',
                          groups: assetRows.filter(row => !row.subtotal && !row.heading),
                        })}
                      />
                    : <GroupRow
                        key={g.label} group={g} components={g.components}
                        heading={g.heading} depth={g.depth} showSources={showSources}
                        onOpen={() => setDrill({ title: g.label, value: g.value, unsourced: g.unsourced, lines: g.lines, components: g.components })}
                      />
                ))}
              </div>
              <FlaggedBlock group={assetGroups?.flagged} showSources={showSources} onOpen={setDrill} />
              <TotalRow
                label="Total Assets" value={assetsTotal} emphasis
                onOpen={() => setDrill({
                  title: 'Total Assets', value: assetsTotal,
                  sourceNote: 'Calculated by adding all asset balances returned by the general ledger statement.',
                  groups: [...assetRows.filter(g => !g.subtotal), ...(assetGroups && hasFlagged(assetGroups.flagged) ? [assetGroups.flagged] : [])],
                })}
              />
              <DriftNote drift={assetDrift} of="Total Assets" />
            </div>

            <div>
              <Badge variant="outline" className="text-[10px]">Liabilities &amp; Shareholders&apos; Equity</Badge>
              <SectionHeading>Liabilities</SectionHeading>
              <div>{liabilityGroups?.standalone.map(g => (
                <GroupRow
                  key={g.label} group={g} showSources={showSources}
                  onOpen={() => setDrill({ title: g.label, value: g.value, unsourced: g.unsourced, lines: g.lines, components: g.components })}
                />
              ))}</div>
              <SubHeading>Market Place Liabilities</SubHeading>
              <div>
                {marketplaceRows.map(g => (
                  g.subtotal
                    ? <TotalRow
                        key={g.label} label={g.label} value={g.value} depth={g.depth}
                        onOpen={() => setDrill({
                          title: g.label, value: g.value,
                          sourceNote: 'Calculated by adding the marketplace liability lines shown in this section.',
                          groups: marketplaceRows.filter(row => !row.subtotal && !row.heading),
                        })}
                      />
                    : <GroupRow
                        key={g.label} group={g} components={g.components}
                        heading={g.heading} depth={g.depth} showSources={showSources}
                        onOpen={() => setDrill({
                          title: g.label, value: g.value, unsourced: g.unsourced, lines: g.lines, components: g.components,
                          sourceNote: g.lines.length === 0 && !g.unsourced
                            ? 'Measured from landlord float ledger entries and split by the landlord record’s management type.'
                            : undefined,
                        })}
                      />
                ))}
              </div>
              <TotalRow
                label="Subtotal — Market Place Liabilities" value={liabilityGroups?.marketplaceTotal ?? 0}
                onOpen={() => setDrill({
                  title: 'Market Place Liabilities', value: liabilityGroups?.marketplaceTotal ?? 0,
                  sourceNote: 'Calculated by adding all marketplace liability balances shown below.',
                  groups: marketplaceRows.filter(g => !g.subtotal),
                })}
              />
              <FlaggedBlock group={liabilityGroups?.flagged} showSources={showSources} onOpen={setDrill} />
              <TotalRow
                label="Total Liabilities" value={data.liabilities.total}
                onOpen={() => setDrill({
                  title: 'Total Liabilities', value: data.liabilities.total,
                  sourceNote: 'Calculated by adding every liability account returned by the general ledger statement.',
                  groups: [
                    ...(liabilityGroups?.standalone ?? []),
                    ...marketplaceRows.filter(g => !g.subtotal),
                    ...(liabilityGroups && hasFlagged(liabilityGroups.flagged) ? [liabilityGroups.flagged] : []),
                  ],
                })}
              />
              <DriftNote drift={liabilityGroupDrift} of="Total Liabilities" />
              <SectionHeading>Shareholders&apos; Equity</SectionHeading>
              <div>{equityGroups?.groups.map(g => (
                <GroupRow
                  key={g.label} group={g} showSources={showSources}
                  onOpen={() => setDrill({ title: g.label, value: g.value, unsourced: g.unsourced, lines: g.lines, components: g.components })}
                />
              ))}</div>
              <FlaggedBlock group={equityGroups?.flagged} showSources={showSources} onOpen={setDrill} />
              <TotalRow
                label="Total Shareholders&apos; Equity" value={equityTotal}
                onOpen={() => setDrill({
                  title: "Total Shareholders' Equity", value: equityTotal,
                  sourceNote: 'Calculated by adding every shareholders’ equity balance returned by the general ledger statement.',
                  groups: [...(equityGroups?.groups ?? []), ...(equityGroups && hasFlagged(equityGroups.flagged) ? [equityGroups.flagged] : [])],
                })}
              />
              <DriftNote drift={equityDrift} of="Total Shareholders&apos; Equity" />
              <TotalRow
                label="Total Liabilities and Shareholders&apos; Equity" value={totalLiabilitiesAndEquity} emphasis
                onOpen={() => setDrill({
                  title: "Total Liabilities and Shareholders' Equity", value: totalLiabilitiesAndEquity,
                  sourceNote: 'Calculated by adding Total Liabilities and Total Shareholders’ Equity.',
                  groups: [
                    ...(liabilityGroups?.standalone ?? []),
                    ...marketplaceRows.filter(g => !g.subtotal),
                    ...(liabilityGroups && hasFlagged(liabilityGroups.flagged) ? [liabilityGroups.flagged] : []),
                    ...(equityGroups?.groups ?? []),
                    ...(equityGroups && hasFlagged(equityGroups.flagged) ? [equityGroups.flagged] : []),
                  ],
                })}
              />
            </div>
          </div>

          {(data.trial_balance || data.reconciliation) && (
            <div className="rounded-lg border border-border p-3 space-y-3">
              <p className="text-[10px] font-bold uppercase tracking-widest text-primary">Trial balance and reconciliation</p>

              {data.trial_balance && (
                <div className="grid grid-cols-3 gap-2 text-center">
                  <div>
                    <p className="text-[9px] uppercase text-muted-foreground">Total debits</p>
                    <p className="font-mono text-xs font-semibold">{formatUGX(data.trial_balance.total_debits)}</p>
                  </div>
                  <div>
                    <p className="text-[9px] uppercase text-muted-foreground">Total credits</p>
                    <p className="font-mono text-xs font-semibold">{formatUGX(data.trial_balance.total_credits)}</p>
                  </div>
                  <div>
                    <p className="text-[9px] uppercase text-muted-foreground">Difference</p>
                    <p className={cn('font-mono text-xs font-semibold', data.trial_balance.balanced ? 'text-success' : 'text-destructive')}>
                      {formatUGX(data.trial_balance.difference)}
                    </p>
                  </div>
                </div>
              )}

              {data.reconciliation && (
                <>
                  <p className="text-[10px] text-muted-foreground">
                    {data.reconciliation.unresolved_groups.toLocaleString()} historic ledger transactions carry only one side of their entry
                    ({formatUGX(data.reconciliation.unresolved_absolute_amount)} in absolute terms) and are listed below by category.
                    Their missing side is recognised, itemised, in the equity line "Unmatched Historic Postings"
                    {typeof data.reconciliation.one_sided_equity_counterpart === 'number'
                      ? ` (${formatUGX(data.reconciliation.one_sided_equity_counterpart)})`
                      : ''}. No suspense plug is applied: every balanced ledger entry is mapped to a real debit and a real credit, so nothing
                    unexplained is absorbed into Current Assets. Classification exclusions are applied to whole transaction groups, never to individual legs.
                  </p>


                  {data.reconciliation.schedule?.length > 0 && (
                    <div className="space-y-0.5">
                      {data.reconciliation.schedule.map(r => (
                        <div key={`${r.ledger_scope}-${r.category}`} className="flex items-center justify-between gap-3 border-b border-border/40 py-1">
                          <span className="text-[10px] text-muted-foreground truncate">
                            {r.category.replace(/_/g, ' ')} · {r.ledger_scope} · {r.groups.toLocaleString()} transactions
                          </span>
                          <span className={cn('font-mono text-[10px] shrink-0', r.net_debit_less_credit < 0 ? 'text-destructive' : 'text-foreground')}>
                            {r.net_debit_less_credit < 0
                              ? `(${formatUGX(Math.abs(r.net_debit_less_credit))})`
                              : formatUGX(r.net_debit_less_credit)}
                          </span>
                        </div>
                      ))}
                    </div>
                  )}

                  {data.reconciliation.memo_sub_ledgers?.length > 0 && (
                    <>
                      <p className="text-[10px] font-bold uppercase tracking-widest text-primary pt-1">
                        Memo — operational records and wallet caches (not in the totals)
                      </p>
                      <div className="space-y-0.5">
                        {data.reconciliation.memo_sub_ledgers.map(l => (
                          <LineRow key={l.label} line={l} showSources={showSources} />
                        ))}
                      </div>
                    </>
                  )}

                  {data.reconciliation.excluded_classifications?.length > 0 && (
                    <p className="text-[10px] text-muted-foreground">
                      Excluded ledger classifications:{' '}
                      {data.reconciliation.excluded_classifications
                        .map(c => `${c.classification} (${c.legs.toLocaleString()} legs, ${formatUGX(c.amount)})`)
                        .join(' · ')}
                    </p>
                  )}
                </>
              )}
            </div>
          )}

          <div className="flex gap-2 pt-3 border-t border-border">
            <Button variant="outline" size="sm" className="flex-1 gap-2 text-xs" onClick={exportCSV}>
              <FileSpreadsheet className="h-3.5 w-3.5" /> Export CSV
            </Button>
            <Button variant="outline" size="sm" className="flex-1 gap-2 text-xs" onClick={exportPDF} disabled={exporting}>
              {exporting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Download className="h-3.5 w-3.5" />}
              PDF / Print
            </Button>
          </div>

          <p className="text-[10px] text-muted-foreground text-center">
            Every figure is generated live from the general ledger and existing operational records. No values are hard-coded and nothing is adjusted to force a balance.
          </p>
        </>
      )}

      <DrilldownDialog drill={drill} asAt={asAt} onClose={() => setDrill(null)} />
    </div>
  );
}