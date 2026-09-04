import type * as React from 'react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Eye, MessageCircle } from 'lucide-react';
import { formatUGX } from '@/lib/rentCalculations';
import { CALLING_COLUMN_LABEL, type CallingColumnKey } from './callingHubColumns';
import type { CcRow } from '@/hooks/useCcCallingHub';
import { telHref } from './ccPhone';

const DASH = '—';
const fmt = (v: string | null) => (v ? new Date(v).toLocaleString() : DASH);
const shortDate = (v: string | null) => (v ? new Date(v).toLocaleDateString() : 'Never');

/** Columns rendered as full-width action controls at the foot of a card. */
const ACTION_COLUMNS: CallingColumnKey[] = ['actions'];

/** Fixed pixel width of the pinned Actions column. */
const ACTIONS_WIDTH = 150;

/**
 * Relative weights for the flexible columns. The table is table-fixed, so the
 * browser cannot widen a column to fit its content; these weights decide the
 * share of the remaining space instead.
 */
const COLUMN_WEIGHT: Partial<Record<CallingColumnKey, number>> = {
  name: 3,
  phone: 2,
  linked_agent: 2.4,
  district: 1.6,
  metric: 1.6,
  feedback_category: 2,
  severity: 1.2,
  routed_to: 1.6,
  ticket_ref: 1.4,
  ticket_status: 1.4,
  attempts: 0.9,
  last_attempt: 1.8,
  next_retry: 1.8,
  park_reason: 2,
  fix_ticket_ref: 1.6,
  callback_due: 1.8,
  booked_by: 1.8,
};

/** Formatted by metric_format. A null value is an em dash, never a zero. */
function metricCell(row: CcRow) {
  switch (row.metric_format) {
    case 'ugx':
      return row.metric_value === null ? DASH : formatUGX(row.metric_value);
    case 'days': {
      if (row.metric_value === null) return DASH;
      const n = Math.round(row.metric_value);
      return n < 0 ? `${Math.abs(n)}d behind` : `${n}d`;
    }
    case 'date':
      return shortDate(row.metric_date);
    case 'number':
      return row.metric_value === null ? DASH : Math.round(row.metric_value).toLocaleString();
    case 'text':
    default:
      return row.metric_text ?? DASH;
  }
}

export function CallingHubTable({
  columns,
  rows,
  metricLabel,
  revealed,
  revealing,
  wipBlocked,
  onReveal,
  actionLabels,
  actionIcon: ActionIcon = Eye,
}: {
  columns: CallingColumnKey[];
  rows: CcRow[];
  metricLabel: string;
  revealed: Record<string, string | null>;
  revealing: boolean;
  wipBlocked: boolean;
  onReveal: (row: CcRow) => void;
  /**
   * Presentation-only override of the primary action's wording. Defaults keep
   * the Calling Hub's existing "Reveal number" copy untouched; the Calling
   * Center passes "Call" because the same action also dials.
   */
  actionLabels?: { compact: string; full: string; compactOpen: string; fullOpen: string; title: string };
  actionIcon?: React.ComponentType<{ className?: string }>;
}) {
  const labels = actionLabels ?? {
    compact: 'Reveal',
    full: 'Reveal number',
    compactOpen: 'View',
    fullOpen: 'View call details',
    title: 'Reveal number',
  };
  if (!rows.length) {
    return <p className="px-1 py-6 text-center text-xs text-muted-foreground">No rows on this tab.</p>;
  }

  const header = (c: CallingColumnKey) => (c === 'metric' ? metricLabel : CALLING_COLUMN_LABEL[c]);

  const revealButton = (row: CcRow, full: boolean) => {
    // An open reveal can be re-opened as often as needed — it only closes when
    // the call outcome has been recorded, which drops the row from `revealed`.
    const isOpen = Object.prototype.hasOwnProperty.call(revealed, row.id);
    return (
      <Button
        size="sm"
        variant={isOpen ? 'secondary' : 'default'}
        className={full ? 'h-9 w-full text-xs' : 'h-7 px-2 text-[11px]'}
        disabled={(wipBlocked && !isOpen) || revealing}
        title={
          wipBlocked && !isOpen
            ? 'Record the outcome of your open calls before revealing another number.'
            : isOpen
              ? 'View the revealed number and call details again'
              : labels.title
        }
        onClick={() => onReveal(row)}
      >
        <ActionIcon className="mr-1 h-3 w-3" />
        {full ? (isOpen ? labels.fullOpen : labels.full) : isOpen ? labels.compactOpen : labels.compact}
      </Button>
    );
  };



  const whatsappLink = (row: CcRow, full: boolean) => {
    const phone = revealed[row.id];
    if (!phone) return full ? <span className="text-muted-foreground">{DASH}</span> : null;
    return (
      <a
        href={`https://wa.me/${phone.replace(/\D/g, '')}`}
        target="_blank"
        rel="noreferrer"
        className={
          full
            ? 'inline-flex h-9 w-full items-center justify-center gap-1 rounded-md border border-border bg-background text-xs font-semibold text-primary'
            : 'inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-border text-primary hover:bg-muted'
        }
        title="Open WhatsApp chat"
        aria-label="Open WhatsApp chat"
      >
        <MessageCircle className="h-3.5 w-3.5" />
        {full && <span className="ml-1">WhatsApp</span>}
      </a>
    );
  };

  const cell = (row: CcRow, col: CallingColumnKey, full = false) => {
    const phone = revealed[row.id];
    switch (col) {
      case 'name':
        return (
          <span className="block truncate font-semibold" title={row.name ?? undefined}>
            {row.name}
          </span>
        );
      case 'phone':
        // Unrevealed is not an error state — the Reveal button carries the affordance.
        // A revealed number is always dialable, at every viewport width.
        return phone ? (
          <a href={telHref(phone)} className="font-mono text-xs font-semibold text-primary underline-offset-2 hover:underline">
            {phone}
          </a>
        ) : (
          <span className="text-muted-foreground">{DASH}</span>
        );
      case 'linked_agent':
        return (
          <span className="block truncate" title={row.linked_agent ?? undefined}>
            {row.linked_agent ?? DASH}
          </span>
        );
      case 'district':
        return (
          <span className="block truncate" title={row.district ?? undefined}>
            {row.district ?? DASH}
          </span>
        );
      case 'metric':
        return metricCell(row);
      case 'actions':
        return full ? (
          <div className="flex flex-col gap-2">
            {revealButton(row, true)}
            {whatsappLink(row, true)}
          </div>
        ) : (
          <div className="flex items-center justify-end gap-1">
            {revealButton(row, false)}
            {whatsappLink(row, false)}
          </div>
        );
      case 'feedback_category':
        return row.feedback_category ?? DASH;
      case 'severity':
        return row.severity ? (
          <Badge
            variant={row.severity === 'critical' || row.severity === 'high' ? 'destructive' : 'secondary'}
            className="capitalize"
          >
            {row.severity}
          </Badge>
        ) : (
          DASH
        );
      case 'routed_to':
        return row.routed_to ?? DASH;
      case 'ticket_ref':
        return row.ticket_ref ? <span className="font-mono text-xs">{row.ticket_ref}</span> : DASH;
      case 'ticket_status':
        return row.ticket_status ? (
          <Badge variant="outline" className="capitalize">{String(row.ticket_status).replace(/_/g, ' ')}</Badge>
        ) : (
          DASH
        );
      case 'attempts':
        return row.attempts_made;
      case 'last_attempt':
        return fmt(row.last_attempt_at);
      case 'next_retry':
        return fmt(row.next_retry_at);
      case 'park_reason':
        return row.park_reason ? String(row.park_reason).replace(/_/g, ' ') : DASH;
      case 'fix_ticket_ref':
        return row.fix_ticket_ref ? <span className="font-mono text-xs">{row.fix_ticket_ref}</span> : DASH;
      case 'callback_due':
        return fmt(row.callback_due_at);
      case 'booked_by':
        return row.booked_by ?? DASH;
      default:
        return DASH;
    }
  };

  /**
   * The per-tab column set in callingHubColumns.ts is the single contract for
   * both renderings — the cards read the same `columns` prop as the table, so a
   * tab can never silently lose a column on a narrow screen.
   */
  const detailColumns = columns.filter((c) => c !== 'name' && !ACTION_COLUMNS.includes(c));
  const actionColumns = columns.filter((c) => ACTION_COLUMNS.includes(c));

  /**
   * The single trailing Actions column is pinned to the right so a narrow
   * viewport can never put the primary action out of reach. Everything else
   * shares the remaining width proportionally under table-fixed.
   */
  const hasActions = columns.includes('actions');
  const flexColumns = columns.filter((c) => c !== 'actions');
  const totalWeight = flexColumns.reduce((sum, c) => sum + (COLUMN_WEIGHT[c] ?? 1.5), 0) || 1;
  const columnStyle = (c: CallingColumnKey): React.CSSProperties =>
    c === 'actions'
      ? { width: ACTIONS_WIDTH, minWidth: ACTIONS_WIDTH, right: 0 }
      : { width: `calc((100% - ${hasActions ? ACTIONS_WIDTH : 0}px) * ${(COLUMN_WEIGHT[c] ?? 1.5) / totalWeight})` };
  const pinClass = (c: CallingColumnKey, header: boolean) =>
    c === 'name'
      ? header
        ? 'sticky left-0 z-20'
        : 'sticky left-0 z-10'
      : c === 'actions' && hasActions
        ? header
          ? 'sticky z-20'
          : 'sticky z-10'
        : '';
  const nowrap = (c: CallingColumnKey) =>
    ['name', 'linked_agent', 'district', 'feedback_category', 'routed_to', 'park_reason', 'booked_by'].includes(c)
      ? ''
      : 'whitespace-nowrap';


  return (
    <>
      {/* Stacked cards below lg */}
      <div className="space-y-2 lg:hidden">
        {rows.map((row) => (
          <div key={row.id} className="rounded-xl border border-border/60 bg-card p-3">
            <p className="text-sm font-semibold leading-tight">{row.name}</p>
            <dl className="mt-2 grid grid-cols-1 gap-x-3 gap-y-1.5 sm:grid-cols-2">
              {detailColumns.map((c) => (
                <div key={c} className="min-w-0">
                  <dt className="text-[10px] uppercase tracking-wide text-muted-foreground">{header(c)}</dt>
                  <dd className="break-words text-xs">{cell(row, c)}</dd>
                </div>
              ))}
            </dl>
            {actionColumns.length > 0 && (
              <div className="mt-3 flex flex-col gap-2">
                {actionColumns.map((c) => (
                  <div key={c} className="w-full">
                    {cell(row, c, true)}
                  </div>
                ))}
              </div>
            )}
          </div>
        ))}
      </div>

      {/* Table at lg and above */}
      {/* The shadcn Table supplies its own scroll container; keep this wrapper
          non-scrolling so the sticky columns pin against that scrollport. */}
      <div className="hidden min-w-0 lg:block">
        {/* border-separate: Chrome will not honour position:sticky on cells of a
            border-collapse table, and the sticky action column is load-bearing. */}
        <Table className="w-full table-fixed border-separate border-spacing-0">
          <TableHeader>
            <TableRow>
              {columns.map((c) => (
                <TableHead
                  key={c}
                  style={columnStyle(c)}
                  className={`truncate border-b border-border bg-card text-[11px] uppercase tracking-wide ${nowrap(c)} ${pinClass(c, true)}`}
                  title={header(c)}
                >
                  {header(c)}
                </TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((row) => (
              <TableRow key={row.id}>
                {columns.map((c) => (
                  <TableCell
                    key={c}
                    style={columnStyle(c)}
                    className={`overflow-hidden text-ellipsis border-b border-border/60 bg-card text-xs ${nowrap(c)} ${pinClass(c, false)}`}
                  >
                    {cell(row, c)}
                  </TableCell>
                ))}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

    </>
  );
}
