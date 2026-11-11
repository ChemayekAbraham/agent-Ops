import { useQuery } from '@tanstack/react-query';
import { addDays, format, startOfWeek } from 'date-fns';
import { supabase } from '@/integrations/supabase/client';
import type { PartnerReceiptRow } from '@/lib/partnerReceiptPdf';

// The archive RPCs are not in the generated types until the migration is applied and types are regenerated.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const rpc = (fn: string, args?: Record<string, unknown>) => (supabase as any).rpc(fn, args);

async function call<T>(fn: string, args?: Record<string, unknown>): Promise<T> {
  const { data, error } = await rpc(fn, args);
  if (error) throw new Error(error.message);
  return data as T;
}

export type ArchiveDirection = 'in' | 'out';
export type ArchiveSource = 'partner_receipt' | 'payout';
export type ArchiveStatus = 'issued' | 'voided' | 'corrected';
export type ArchiveRange = 'today' | 'yesterday' | 'week' | 'custom';

export interface ArchiveRow {
  source: ArchiveSource;
  id: string;
  /** "4300" for a digital partner receipt, "RCPT-AB12CD34" for a payout receipt. */
  receipt_ref: string;
  receipt_no: number | null;
  direction: ArchiveDirection;
  event_at: string;
  client_name: string | null;
  client_phone: string | null;
  purpose: string;
  method: string;
  amount: number;
  status: ArchiveStatus;
  /** For a corrected receipt: the number of the receipt that replaced it. */
  replaced_by_no: number | null;
  /** Payout receipts only: the public link is https://welileapp.com/r/<token>. */
  link_token: string | null;
  issued_by_name: string | null;
  total_count: number;
}

export interface ArchiveSummary {
  from: string;
  to: string;
  issued_count: number;
  in_count: number;
  in_total: number;
  out_count: number;
  out_total: number;
  voided_count: number;
  pending_corrections: number;
  pending_cash_confirmations: number;
  pending_count: number;
  can_see_payouts: boolean;
}

export interface ArchiveFilters {
  search: string;
  direction: ArchiveDirection | '';
  range: ArchiveRange;
  from: string;
  to: string;
  method: string;
  source: ArchiveSource | '';
  status: ArchiveStatus | '';
  page: number;
}

export const ARCHIVE_PAGE_SIZE = 25;
export const PAYOUT_RECEIPT_BASE_URL = 'https://welileapp.com/r/';

const ymd = (d: Date) => format(d, 'yyyy-MM-dd');

/** The dates a range preset stands for. A custom range uses the two date boxes. */
export function resolveRange(f: Pick<ArchiveFilters, 'range' | 'from' | 'to'>, now = new Date()): { from: string; to: string } {
  if (f.range === 'yesterday') { const y = ymd(addDays(now, -1)); return { from: y, to: y }; }
  if (f.range === 'week') return { from: ymd(startOfWeek(now, { weekStartsOn: 1 })), to: ymd(now) };
  if (f.range === 'custom') return { from: f.from || '', to: f.to || f.from || '' };
  const t = ymd(now);
  return { from: t, to: t };
}

/**
 * Searching finds a client's receipts across ALL dates: a phone number or name is a history lookup, so the date range is
 * ignored while there is search text. The summary cards still follow the range.
 */
export function useReceiptArchive(f: ArchiveFilters) {
  const searching = f.search.trim() !== '';
  const r = resolveRange(f);
  return useQuery({
    queryKey: ['receipt-archive', f, searching ? null : r],
    placeholderData: (prev) => prev,
    queryFn: () => call<ArchiveRow[]>('search_receipt_archive', {
      p_search: f.search.trim() || null,
      p_direction: f.direction || null,
      p_from: searching ? null : r.from || null,
      p_to: searching ? null : r.to || null,
      p_method: f.method || null,
      p_source: f.source || null,
      p_status: f.status || null,
      p_limit: ARCHIVE_PAGE_SIZE,
      p_offset: f.page * ARCHIVE_PAGE_SIZE,
    }),
  });
}

export function useReceiptArchiveSummary(f: Pick<ArchiveFilters, 'range' | 'from' | 'to'>) {
  const r = resolveRange(f);
  return useQuery({
    queryKey: ['receipt-archive-summary', r],
    queryFn: () => call<ArchiveSummary>('receipt_archive_summary', { p_from: r.from || null, p_to: r.to || null }),
  });
}

/** The full partner receipt row, needed to draw its PDF. The list only carries what the table shows. */
export async function fetchPartnerReceiptRow(receiptNo: number, id: string): Promise<PartnerReceiptRow> {
  const rows = await call<PartnerReceiptRow[]>('search_partner_receipts', { p_search: String(receiptNo), p_limit: 10, p_offset: 0 });
  const row = rows.find((x) => x.id === id);
  if (!row) throw new Error('Could not load that receipt.');
  return row;
}
