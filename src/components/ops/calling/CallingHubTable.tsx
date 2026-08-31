import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Eye, MessageCircle } from 'lucide-react';
import { formatUGX } from '@/lib/rentCalculations';
import { CALLING_COLUMN_LABEL, type CallingColumnKey } from './callingHubColumns';
import type { CcRow } from '@/hooks/useCcCallingHub';

const DASH = '—';
const fmt = (v: string | null) => (v ? new Date(v).toLocaleString() : DASH);
const shortDate = (v: string | null) => (v ? new Date(v).toLocaleDateString() : 'Never');

/** Columns rendered as full-width action controls at the foot of a card. */
const ACTION_COLUMNS: CallingColumnKey[] = ['reveal', 'whatsapp'];

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
}: {
  columns: CallingColumnKey[];
  rows: CcRow[];
  metricLabel: string;
  revealed: Record<string, string | null>;
  revealing: boolean;
  wipBlocked: boolean;
  onReveal: (row: CcRow) => void;
}) {
  if (!rows.length) {
    return <p className="px-1 py-6 text-center text-xs text-muted-foreground">No rows on this tab.</p>;
  }

  const header = (c: CallingColumnKey) => (c === 'metric' ? metricLabel : CALLING_COLUMN_LABEL[c]);

  const revealButton = (row: CcRow, full: boolean) => {
    const phone = revealed[row.id];
    return (
      <Button
        size="sm"
        variant={phone ? 'secondary' : 'default'}
        className={full ? 'h-9 w-full text-xs' : 'h-7 px-2 text-[11px]'}
        disabled={wipBlocked || revealing || !!phone}
        title={wipBlocked ? 'Record the outcome of your open calls before revealing another number.' : undefined}
        onClick={() => onReveal(row)}
      >
        <Eye className="mr-1 h-3 w-3" />
        {phone ? 'Number revealed' : 'Reveal number'}
      </Button>
    );
  };

  const whatsappLink = (row: CcRow, full: boolean) => {
    const phone = revealed[row.id];
    if (!phone) return <span className="text-muted-foreground">{DASH}</span>;
    return (
      <a
        href={`https://wa.me/${phone.replace(/\D/g, '')}`}
        target="_blank"
        rel="noreferrer"
        className={
          full
            ? 'inline-flex h-9 w-full items-center justify-center gap-1 rounded-md border border-border bg-background text-xs font-semibold text-primary'
            : 'inline-flex items-center gap-1 text-xs font-semibold text-primary hover:underline'
        }
      >
        <MessageCircle className="h-3 w-3" /> WhatsApp
      </a>
    );
  };

  const cell = (row: CcRow, col: CallingColumnKey, full = false) => {
    const phone = revealed[row.id];
    switch (col) {
      case 'name':
        return <span className="font-semibold">{row.name}</span>;
      case 'phone':
        // Unrevealed is not an error state — the Reveal button carries the affordance.
        return phone ? (
          <span className="font-mono text-xs">{phone}</span>
        ) : (
          <span className="text-muted-foreground">{DASH}</span>
        );
      case 'linked_agent':
        return row.linked_agent ?? DASH;
      case 'district':
        return row.district ?? DASH;
      case 'metric':
        return metricCell(row);
      case 'reveal':
        return revealButton(row, full);
      case 'whatsapp':
        return whatsappLink(row, full);
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

  const lastIndex = columns.length - 1;
  const stickyRight = ACTION_COLUMNS.includes(columns[lastIndex]);

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
        <Table className="border-separate border-spacing-0">
          <TableHeader>
            <TableRow>
              {columns.map((c) => (
                <TableHead
                  key={c}
                  style={stickyStyle(c, 20)}
                  className={`whitespace-nowrap border-b border-border bg-card text-[11px] uppercase tracking-wide ${
                    c === 'name' ? 'sticky left-0 z-20' : ''
                  } ${stickyRightOffset(c) !== null ? 'sticky z-20' : ''}`}
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
                    style={stickyStyle(c, 10)}
                    className={`whitespace-nowrap border-b border-border/60 bg-card text-xs ${
                      c === 'name' ? 'sticky left-0 z-10' : ''
                    } ${stickyRightOffset(c) !== null ? 'sticky z-10' : ''}`}
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
