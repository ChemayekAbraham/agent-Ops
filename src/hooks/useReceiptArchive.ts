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

/** Mirrors the database rule: a phone search is digits (with + ( ) - and spaces), 6+ digits or starting 0 or +. */
export function looksLikePhone(s: string): boolean {
  const t = s.trim();
  if (!/^\+?[0-9][0-9 ()-]*$/.test(t)) return false;
  return t.replace(/\D/g, '').length >= 6 || /^[+0]/.test(t);
}

/** Last 9 digits: 0772123456, 772123456 and +256 772 123 456 are the same number. */
export function phoneKey(p: string | null): string {
  const d = (p ?? '').replace(/\D/g, '');
  return d.length >= 9 ? d.slice(-9) : d;
}

/** What the person typed, reduced the way the database reduces it: drop 256 or a leading 0. */
function searchDigits(s: string): string {
  let d = s.replace(/\D/g, '');
  if (d.startsWith('256') && d.length >= 12) d = d.slice(3);
  else if (d.startsWith('0')) d = d.slice(1);
  return d;
}

export interface ClientCardData {
  /** Set when exactly one phone number matches; otherwise null and `otherNumbers` says how many matched. */
  phone: string | null;
  otherNumbers: number;
  name: string | null;
  /** Every distinct name used on this number. More than one is a flag for review, not an accusation. */
  names: string[];
  receipts: number;
  inTotal: number;
  outTotal: number;
  firstAt: string | null;
  /** True when the client has more receipts than were read (200). */
  truncated: boolean;
}

const CLIENT_CARD_LIMIT = 200;

/**
 * The client behind a phone-number search: totals across ALL of their receipts, whatever date range or filters the table uses.
 * Money totals count issued receipts only (voided and corrected ones are not money that moved).
 */
export function useClientCard(search: string) {
  const q = search.trim();
  return useQuery({
    queryKey: ['receipt-archive-client', q],
    enabled: looksLikePhone(q),
    queryFn: async (): Promise<ClientCardData | null> => {
      const rows = await call<ArchiveRow[]>('search_receipt_archive', { p_search: q, p_limit: CLIENT_CARD_LIMIT, p_offset: 0 });
      const d = searchDigits(q);
      const hits = rows.filter((r) => d !== '' && phoneKey(r.client_phone).includes(d));
      if (hits.length === 0) return null;
      const keys = new Set(hits.map((r) => phoneKey(r.client_phone)));
      if (keys.size > 1) {
        return { phone: null, otherNumbers: keys.size, name: null, names: [], receipts: 0, inTotal: 0, outTotal: 0, firstAt: null, truncated: false };
      }
      const names = Array.from(new Map(
        hits.map((r) => (r.client_name ?? '').trim()).filter(Boolean).map((n) => [n.toLowerCase(), n] as const),
      ).values());
      const live = hits.filter((r) => r.status === 'issued');
      return {
        phone: hits[0].client_phone,
        otherNumbers: 0,
        name: hits[0].client_name,
        names,
        receipts: hits.length,
        inTotal: live.filter((r) => r.direction === 'in').reduce((s, r) => s + Number(r.amount), 0),
        outTotal: live.filter((r) => r.direction === 'out').reduce((s, r) => s + Number(r.amount), 0),
        firstAt: hits.reduce((min, r) => (r.event_at < min ? r.event_at : min), hits[0].event_at),
        truncated: (rows[0]?.total_count ?? 0) > CLIENT_CARD_LIMIT,
      };
    },
  });
}

/** The full partner receipt row, needed to draw its PDF. The list only carries what the table shows. */
export async function fetchPartnerReceiptRow(receiptNo: number, id: string): Promise<PartnerReceiptRow> {
  const rows = await call<PartnerReceiptRow[]>('search_partner_receipts', { p_search: String(receiptNo), p_limit: 10, p_offset: 0 });
  const row = rows.find((x) => x.id === id);
  if (!row) throw new Error('Could not load that receipt.');
  return row;
}
