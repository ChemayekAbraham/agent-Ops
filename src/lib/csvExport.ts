import { supabase } from '@/integrations/supabase/client';

// Shared choke point for the 13 components that call downloadCsv with data
// spanning many transactions/verifications/reports at once (cash movement,
// ROI/rent disbursements, deposit verification queues, daily rent reports,
// and more) -- a real bulk data-exfiltration risk, not logged before this.
// Plain client-side insert so the audit_logs IP-capture trigger sees the
// real browser IP directly. Never blocks the actual download.
async function logCsvExport(filename: string, rowCount: number) {
  try {
    const { data: { user } } = await supabase.auth.getUser();
    await supabase.from('audit_logs').insert({
      user_id: user?.id ?? null,
      action_type: 'csv_exported',
      table_name: 'export',
      record_id: null,
      metadata: { filename, row_count: rowCount },
    });
  } catch (e) {
    console.warn('[csvExport] audit log insert failed:', e);
  }
}

// A string that opens with one of these is read as a formula by Excel / Sheets.
const FORMULA_LEAD = /^[=+\-@\t\r]/;
// Numbers, phone numbers and percentages that merely start with + or -
// ("-5,000", "+256700000000", "-12.5%", "-5000 UGX") are not formulas. Anything
// containing an operator or letters beyond a short unit suffix still is.
const PLAIN_NUMERIC = /^[+-]?\d[\d\s,.()%-]*[A-Za-z]{0,4}$/;

/**
 * One RFC 4180 cell. Real numbers are written as-is. Strings that could run as a
 * spreadsheet formula (error messages and names are user-influenced text) get a
 * leading apostrophe so they open as plain text (CSV injection, OWASP).
 */
export function csvCell(v: string | number | null | undefined): string {
  let s = v === null || v === undefined ? '' : String(v);
  if (typeof v === 'string' && FORMULA_LEAD.test(s) && s !== '-' && !PLAIN_NUMERIC.test(s)) {
    s = `'${s}`;
  }
  return `"${s.replace(/"/g, '""')}"`;
}

/**
 * Tiny dependency-free CSV exporter for audit downloads.
 * - Quotes every field, doubles embedded quotes (RFC 4180).
 * - Prepends a UTF-8 BOM so Excel opens it with the right encoding.
 * - Triggers a browser download via a temporary <a> element.
 */
export function downloadCsv(
  filename: string,
  headers: string[],
  rows: (string | number | null | undefined)[][],
) {
  const lines = [headers.map(csvCell).join(','), ...rows.map((r) => r.map(csvCell).join(','))];
  const csv = '\uFEFF' + lines.join('\r\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);

  void logCsvExport(filename, rows.length);
}

/** Format an ISO timestamp for CSV — keep ISO so Excel can sort, but
 *  fall back to empty string when missing. */
export function csvTimestamp(iso: string | null | undefined): string {
  if (!iso) return '';
  try {
    return new Date(iso).toISOString();
  } catch {
    return '';
  }
}