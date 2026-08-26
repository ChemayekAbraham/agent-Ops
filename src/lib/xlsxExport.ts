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
}