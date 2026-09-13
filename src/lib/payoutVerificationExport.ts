/**
 * Exports for the Financial Ops "Verify Payout Numbers" list.
 *
 * Read-only: pages through `finops_payout_verification_queue` with the same
 * filter, search and sort the operator is looking at, then writes a CSV or a
 * printable PDF. Rows carry National ID values, so treat the file as
 * confidential — it is only reachable by finance roles (the RPC itself checks).
 */
import { supabase } from '@/integrations/supabase/client';
import { formatUGX } from '@/lib/rentCalculations';
import type {
  PayoutDestinationRow,
  PayoutQueueFilter,
  PayoutQueueSort,
} from '@/hooks/usePayoutVerification';

const FETCH_PAGE = 500;
/** Hard ceiling so a mistaken "All" export cannot pull the whole table. */
const MAX_ROWS = 5000;

export interface PayoutExportQuery {
  status: PayoutQueueFilter;
  search: string;
  sort: PayoutQueueSort;
}

export interface PayoutExportRow extends PayoutDestinationRow {}

/** Pulls every row matching the current view (capped at MAX_ROWS). */
export async function fetchPayoutVerificationExportRows(
  q: PayoutExportQuery,
): Promise<PayoutExportRow[]> {
  const out: PayoutExportRow[] = [];
  for (let offset = 0; offset < MAX_ROWS; offset += FETCH_PAGE) {
    const { data, error } = await supabase.rpc('finops_payout_verification_queue', {
      p_status: q.status,
      p_search: q.search.trim() || null,
      p_sort: q.sort,
      p_limit: FETCH_PAGE,
      p_offset: offset,
    });
    if (error) throw new Error(error.message);
    const rows = ((data ?? []) as unknown[]).map((r) => {
      const row = r as Record<string, unknown>;
      const tokens = row.name_mismatch_tokens;
      return {
        ...(row as unknown as PayoutExportRow),
        name_match_score: row.name_match_score === null ? null : Number(row.name_match_score),
        withdrawable_balance: Number(row.withdrawable_balance ?? 0),
        total_count: Number(row.total_count ?? 0),
        name_mismatch_tokens: Array.isArray(tokens) ? (tokens as string[]) : [],
      } as PayoutExportRow;
    });
    out.push(...rows);
    if (rows.length < FETCH_PAGE) break;
  }
  return out;
}

export function matchLabel(score: number | null): string {
  if (score === null) return 'No National ID to compare';
  if (score >= 0.8) return 'Names match';
  if (score >= 0.5) return 'Partly matches';
  return 'Names do not match';
}

export function destinationLabel(r: PayoutExportRow): string {
  return r.destination_type === 'mobile_money'
    ? [r.provider ?? 'Mobile money', r.momo_number ?? ''].join(' ').trim()
    : [r.bank_name ?? 'Bank', r.bank_account_number ?? ''].join(' ').trim();
}

const STATUS_WORDS: Record<string, string> = {
  waiting: 'Waiting for verification',
  verified: 'Verified',
  rejected: 'Rejected',
};

function fmtDate(value: string | null): string {
  if (!value) return '';
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? '' : d.toISOString().slice(0, 16).replace('T', ' ');
}

const HEADERS = [
  'Status',
  'Holder name',
  'Account phone',
  'Destination type',
  'Provider / bank',
  'Number / account',
  'Name on destination',
  'National ID number',
  'Name on National ID',
  'Name match',
  'Match score',
  'Mismatched words',
  'Withdrawable balance (UGX)',
  'Call outcome',
  'Decision reason',
  'Decided by',
  'Decided at',
  'First seen',
];

function cells(r: PayoutExportRow): string[] {
  return [
    STATUS_WORDS[r.status] ?? r.status,
    r.full_name ?? '',
    r.user_phone ?? '',
    r.destination_type === 'mobile_money' ? 'Mobile money' : 'Bank transfer',
    (r.destination_type === 'mobile_money' ? r.provider : r.bank_name) ?? '',
    (r.destination_type === 'mobile_money' ? r.momo_number : r.bank_account_number) ?? '',
    r.account_name ?? '',
    r.national_id ?? '',
    r.national_id_name ?? '',
    matchLabel(r.name_match_score),
    r.name_match_score === null ? '' : r.name_match_score.toFixed(2),
    (r.name_mismatch_tokens ?? []).join(' '),
    String(Math.round(r.withdrawable_balance ?? 0)),
    r.call_outcome ?? '',
    r.decision_reason ?? '',
    r.decided_by_name ?? '',
    fmtDate(r.decided_at),
    fmtDate(r.first_seen_at),
  ];
}

function csvCell(value: string): string {
  // Guard against spreadsheet formula injection on values starting = + - @.
  const safe = /^[=+\-@]/.test(value) ? `'${value}` : value;
  return `"${safe.replace(/"/g, '""')}"`;
}

export function buildPayoutVerificationCsv(rows: PayoutExportRow[]): string {
  const lines = [HEADERS.map(csvCell).join(',')];
  rows.forEach((r) => lines.push(cells(r).map(csvCell).join(',')));
  return `\uFEFF${lines.join('\r\n')}`;
}

export function payoutExportFileName(q: PayoutExportQuery, ext: 'csv' | 'pdf'): string {
  const stamp = new Date().toISOString().slice(0, 10);
  return `welile-payout-verification-${q.status}-${stamp}.${ext}`;
}

export function downloadBlob(blob: Blob, fileName: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

/** Landscape A4 table, one page per ~20 rows, with a totals line. */
export async function buildPayoutVerificationPdf(
  rows: PayoutExportRow[],
  q: PayoutExportQuery,
): Promise<Blob> {
  const { jsPDF } = await import('jspdf');
  const autoTable = (await import('jspdf-autotable')).default;
  const doc = new jsPDF({ unit: 'pt', format: 'a4', orientation: 'landscape' });

  const PRIMARY: [number, number, number] = [107, 33, 168];
  const pageW = doc.internal.pageSize.getWidth();

  doc.setFillColor(...PRIMARY);
  doc.rect(0, 0, pageW, 64, 'F');
  doc.setTextColor(255, 255, 255);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(16);
  doc.text('Payout number verification', 32, 28);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(9);
  const totalBalance = rows.reduce((s, r) => s + (r.withdrawable_balance ?? 0), 0);
  doc.text(
    `${rows.length} destination(s) · ${q.status} · balance held ${formatUGX(totalBalance)} · generated ${new Date().toLocaleString()}`,
    32,
    46,
  );

  autoTable(doc, {
    startY: 80,
    head: [
      [
        'Status',
        'Holder',
        'Phone',
        'Destination',
        'Name on destination',
        'National ID',
        'Name on ID',
        'Match',
        'Balance',
        'Decision',
      ],
    ],
    body: rows.map((r) => [
      STATUS_WORDS[r.status] ?? r.status,
      r.full_name ?? '',
      r.user_phone ?? '',
      destinationLabel(r),
      r.account_name ?? '',
      r.national_id ?? '—',
      r.national_id_name ?? '—',
      matchLabel(r.name_match_score),
      formatUGX(r.withdrawable_balance ?? 0),
      [r.call_outcome, r.decision_reason].filter(Boolean).join(' — '),
    ]),
    styles: { fontSize: 7.5, cellPadding: 3, overflow: 'linebreak' },
    headStyles: { fillColor: PRIMARY, textColor: 255, fontSize: 8 },
    alternateRowStyles: { fillColor: [248, 245, 255] },
    columnStyles: {
      8: { halign: 'right' },
      9: { cellWidth: 120 },
    },
    margin: { left: 24, right: 24, bottom: 34 },
    didDrawPage: () => {
      const h = doc.internal.pageSize.getHeight();
      doc.setFontSize(7.5);
      doc.setTextColor(120);
      doc.text('Confidential — contains National ID details. Financial Ops use only.', 24, h - 16);
    },
  });

  return doc.output('blob');
}
