import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Eye, MessageCircle } from 'lucide-react';
import {
  CALLING_COLUMN_LABEL,
  type CallingColumnKey,
} from './callingHubColumns';
import type { CcRow } from '@/hooks/useCcCallingHub';

const fmt = (v: string | null) => (v ? new Date(v).toLocaleString() : '—');

export function CallingHubTable({
  columns,
  rows,
  revealed,
  revealing,
  wipBlocked,
  onReveal,
}: {
  columns: CallingColumnKey[];
  rows: CcRow[];
  revealed: Record<string, string | null>;
  revealing: boolean;
  wipBlocked: boolean;
  onReveal: (row: CcRow) => void;
}) {
  if (!rows.length) {
    return <p className="px-1 py-6 text-center text-xs text-muted-foreground">No rows on this tab.</p>;
  }

  const cell = (row: CcRow, col: CallingColumnKey) => {
    const phone = revealed[row.id];
    switch (col) {
      case 'name':
        return <span className="font-semibold">{row.name}</span>;
      case 'phone':
        return phone ? (
          <span className="font-mono text-xs">{phone}</span>
        ) : (
          <span className="text-xs text-muted-foreground">hidden</span>
        );
      case 'linked_agent':
        return row.linked_agent ?? '—';
      case 'district':
        return row.district ?? '—';
      case 'priority_value':
        return row.priority_value === null ? '—' : row.priority_value.toLocaleString();
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
            {phone ? 'Number revealed' : 'Reveal & call'}
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
          <span className="text-xs text-muted-foreground">—</span>
        );
      case 'feedback_category':
        return row.feedback_category ?? '—';
      case 'severity':
        return row.severity ? (
          <Badge
            variant={row.severity === 'critical' || row.severity === 'high' ? 'destructive' : 'secondary'}
            className="capitalize"
          >
            {row.severity}
          </Badge>
        ) : (
          '—'
        );
      case 'routed_to':
        return row.routed_to ?? '—';
      case 'ticket_ref':
        return row.ticket_ref ? <span className="font-mono text-xs">{row.ticket_ref}</span> : '—';
      case 'ticket_status':
        return row.ticket_status ? (
          <Badge variant="outline" className="capitalize">{String(row.ticket_status).replace(/_/g, ' ')}</Badge>
        ) : (
          '—'
        );
      case 'attempts':
        return row.attempts_made;
      case 'last_attempt':
        return fmt(row.last_attempt_at);
      case 'next_retry':
        return fmt(row.next_retry_at);
      case 'park_reason':
        return row.park_reason ? String(row.park_reason).replace(/_/g, ' ') : '—';
      case 'fix_ticket_ref':
        return row.fix_ticket_ref ? <span className="font-mono text-xs">{row.fix_ticket_ref}</span> : '—';
      case 'callback_due':
        return fmt(row.callback_due_at);
      case 'booked_by':
        return row.booked_by ?? '—';
      default:
        return '—';
    }
  };

  return (
    <div className="overflow-x-auto">
      <Table>
        <TableHeader>
          <TableRow>
            {columns.map((c) => (
              <TableHead key={c} className="whitespace-nowrap text-[11px] uppercase tracking-wide">
                {CALLING_COLUMN_LABEL[c]}
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
