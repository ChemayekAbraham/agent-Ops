/**
 * Per-tab column sets for the shared Call Centre hub.
 *
 * A tab is a COLUMN SET, not merely a filter. Exactly these tabs, exactly these
 * columns, nothing more. Notably the Engaged tab carries NO phone number and NO
 * call action — engagement is already recorded, so re-dialling is not offered.
 *
 * The `metric` column is dynamic: its header is metric_label and its value is
 * formatted by metric_format, both supplied per row by cc_call_queue_page.
 */
import type { CcRowState } from '@/hooks/useCcCallingHub';

export type CallingTabKey = Extract<CcRowState, 'to_call' | 'engaged' | 'unreachable' | 'parked' | 'callback'>;

export type CallingColumnKey =
  | 'name'
  | 'phone'
  | 'linked_agent'
  | 'district'
  | 'metric'
  | 'actions'
  | 'feedback_category'
  | 'severity'
  | 'routed_to'
  | 'ticket_ref'
  | 'ticket_status'
  | 'attempts'
  | 'last_attempt'
  | 'next_retry'
  | 'park_reason'
  | 'fix_ticket_ref'
  | 'callback_due'
  | 'booked_by';

/**
 * Static fallbacks. `metric` deliberately has no fixed label — the header comes
 * from the RPC's metric_label. Never hardcode it at a call site.
 */
export const CALLING_COLUMN_LABEL: Record<CallingColumnKey, string> = {
  name: 'Name',
  phone: 'Phone',
  linked_agent: 'Linked agent',
  district: 'District',
  metric: 'Metric',
  actions: 'Actions',
  feedback_category: 'Feedback category',
  severity: 'Severity',
  routed_to: 'Routed to',
  ticket_ref: 'Ticket ref',
  ticket_status: 'Ticket status',
  attempts: 'Attempts',
  last_attempt: 'Last attempt',
  next_retry: 'Next retry due',
  park_reason: 'Park reason',
  fix_ticket_ref: 'Data-fix ticket',
  callback_due: 'Callback due',
  booked_by: 'Booked by',
};

export const CALLING_TABS: { key: CallingTabKey; label: string; columns: CallingColumnKey[] }[] = [
  {
    key: 'to_call',
    label: 'To call',
    columns: ['name', 'phone', 'linked_agent', 'district', 'metric', 'actions'],
  },
  {
    key: 'engaged',
    label: 'Engaged',
    // Deliberately no phone and no reveal action on this tab.
    columns: ['name', 'linked_agent', 'feedback_category', 'severity', 'routed_to', 'ticket_ref', 'ticket_status'],
  },
  {
    key: 'unreachable',
    label: 'Not reached',
    columns: ['name', 'phone', 'attempts', 'last_attempt', 'next_retry', 'actions'],
  },
  {
    key: 'parked',
    label: 'Parked',
    columns: ['name', 'phone', 'attempts', 'park_reason', 'fix_ticket_ref'],
  },
  {
    key: 'callback',
    label: 'Callback',
    columns: ['name', 'phone', 'callback_due', 'booked_by', 'actions'],
  },
];

/** Columns that must never appear in an export produced by this screen. */
export const EXPORT_FORBIDDEN_COLUMNS: CallingColumnKey[] = ['phone', 'actions'];

export function exportableColumns(columns: CallingColumnKey[]): CallingColumnKey[] {
  return columns.filter((c) => !EXPORT_FORBIDDEN_COLUMNS.includes(c));
}
