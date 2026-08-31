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

  const cell = (row: CcRow, col: CallingColumnKey) => {
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
        return (
          <Button
            size="sm"
            variant={phone ? 'secondary' : 'default'}
            className="h-7 px-2 text-[11px]"
            disabled={wipBlocked || revealing || !!phone}
            title={wipBlocked ? 'Record the outcome of your open calls before revealing another number.' : undefined}
            onClick={() => onReveal(row)}
          >
            <Eye className="mr-1 h-3 w-3" />
            {phone ? 'Number revealed' : 'Reveal number'}
          </Button>
        );
      case 'whatsapp':
        return phone ? (
          <a
            href={`https://wa.me/${phone.replace(/\D/g, '')}`}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 text-xs font-semibold text-primary hover:underline"
          >
            <MessageCircle className="h-3 w-3" /> WhatsApp
          </a>
        ) : (
          <span className="text-muted-foreground">{DASH}</span>
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

  return (
    <div className="overflow-x-auto">
      <Table>
        <TableHeader>
          <TableRow>
            {columns.map((c) => (
              <TableHead key={c} className="whitespace-nowrap text-[11px] uppercase tracking-wide">
                {header(c)}
              </TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row) => (
            <TableRow key={row.id}>
              {columns.map((c) => (
                <TableCell key={c} className="whitespace-nowrap text-xs">
                  {cell(row, c)}
                </TableCell>
              ))}
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
