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
  const escape = (v: string | number | null | undefined) => {
    const s = v === null || v === undefined ? '' : String(v);
    return `"${s.replace(/"/g, '""')}"`;
  };
  const lines = [headers.map(escape).join(','), ...rows.map((r) => r.map(escape).join(','))];
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