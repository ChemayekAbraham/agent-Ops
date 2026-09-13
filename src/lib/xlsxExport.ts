import { supabase } from '@/integrations/supabase/client';

// Bulk export of many rows of (usually customer/financial) data at once is
// a real data-exfiltration risk distinct from a single receipt/statement
// download — see the "tie every action to an IP" series. This is the one
// shared choke point every downloadXlsx(Workbook) caller already goes
// through, so logging it once here covers every XLSX-based bulk export in
// the app without touching each of the ~15 call sites individually. A plain
// client-side insert, so the audit_logs IP-capture trigger sees the real
// browser IP directly (no service-role indirection like the edge-function
// items in this series). Never blocks the actual download.
async function logBulkXlsxExport(filename: string, sheetLabel: string, rowCount: number) {
  try {
    const { data: { user } } = await supabase.auth.getUser();
    await supabase.from('audit_logs').insert({
      user_id: user?.id ?? null,
      action_type: 'bulk_data_exported',
      table_name: 'xlsx_export',
      record_id: null,
      metadata: { filename, sheet: sheetLabel, row_count: rowCount, format: 'xlsx' },
    });
  } catch (e) {
    console.warn('[xlsxExport] audit log insert failed:', e);
  }
}

/**
 * Tiny wrapper around SheetJS for audit downloads. Mirrors the shape of
 * downloadCsv so callers can swap formats without rebuilding their payload.
 * - Writes a single worksheet with a frozen header row.
 * - Auto-sizes columns from header + sample data.
 * - Uses dynamic import so the ~400KB xlsx bundle is only fetched on
 *   first export, keeping the FinOps dashboard initial load lean.
 */
export async function downloadXlsx(
  filename: string,
  headers: string[],
  rows: (string | number | null | undefined)[][],
  sheetName = 'Audit',
) {
  const XLSX = await import('xlsx');
  const aoa: (string | number | null | undefined)[][] = [headers, ...rows];
  const ws = XLSX.utils.aoa_to_sheet(aoa);

  // Freeze the header row so it stays visible while scrolling long audits.
  (ws as any)['!freeze'] = { xSplit: 0, ySplit: 1 };
  (ws as any)['!views'] = [{ state: 'frozen', ySplit: 1 }];

  // Auto-size columns: longest of header / first 200 row values, capped.
  const sample = rows.slice(0, 200);
  ws['!cols'] = headers.map((h, i) => {
    let max = String(h ?? '').length;
    for (const r of sample) {
      const v = r[i];
      const len = v === null || v === undefined ? 0 : String(v).length;
      if (len > max) max = len;
    }
    return { wch: Math.min(60, Math.max(8, max + 2)) };
  });

  const wb = XLSX.utils.book_new();
  // Excel limits sheet names to 31 chars and forbids a few characters.
  const safeSheet = sheetName.replace(/[\\/?*[\]:]/g, '').slice(0, 31) || 'Audit';
  XLSX.utils.book_append_sheet(wb, ws, safeSheet);
  XLSX.writeFile(wb, filename);

  void logBulkXlsxExport(filename, safeSheet, rows.length);
}

export interface XlsxSheet {
  name: string;
  headers: string[];
  rows: (string | number | null | undefined)[][];
}

/**
 * Multi-sheet variant of downloadXlsx — used for comprehensive reports where
 * each section of a dashboard becomes its own worksheet in one workbook.
 */
export async function downloadXlsxWorkbook(filename: string, sheets: XlsxSheet[]) {
  const XLSX = await import('xlsx');
  const wb = XLSX.utils.book_new();
  const used = new Set<string>();

  sheets.forEach((sheet, idx) => {
    const ws = XLSX.utils.aoa_to_sheet([sheet.headers, ...sheet.rows]);
    (ws as any)['!views'] = [{ state: 'frozen', ySplit: 1 }];
    const sample = sheet.rows.slice(0, 200);
    ws['!cols'] = sheet.headers.map((h, i) => {
      let max = String(h ?? '').length;
      for (const r of sample) {
        const v = r[i];
        const len = v === null || v === undefined ? 0 : String(v).length;
        if (len > max) max = len;
      }
      return { wch: Math.min(60, Math.max(8, max + 2)) };
    });

    let name = (sheet.name || `Sheet${idx + 1}`).replace(/[\\/?*[\]:]/g, '').slice(0, 31);
    while (used.has(name)) name = `${name.slice(0, 28)}_${idx}`;
    used.add(name);
    XLSX.utils.book_append_sheet(wb, ws, name);
  });

  XLSX.writeFile(wb, filename);

  const totalRows = sheets.reduce((sum, s) => sum + s.rows.length, 0);
  void logBulkXlsxExport(filename, sheets.map((s) => s.name).join(', '), totalRows);
}
