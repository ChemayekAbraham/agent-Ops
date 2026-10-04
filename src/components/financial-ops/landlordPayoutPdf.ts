import type { LandlordPayoutShareData } from './LandlordPayoutShareCard';
import { downloadXlsx } from '@/lib/xlsxExport';
import { supabase } from '@/integrations/supabase/client';

// Bulk export of many funded landlord payouts (list/cards PDF, summary PDF)
// at once, not logged before this. Plain client-side insert so the
// audit_logs IP-capture trigger sees the real browser IP directly. Never
// blocks the actual download.
async function logPayoutPdfExport(filename: string) {
  try {
    const { data: { user } } = await supabase.auth.getUser();
    await supabase.from('audit_logs').insert({
      user_id: user?.id ?? null,
      action_type: 'pdf_report_exported',
      table_name: 'export',
      record_id: null,
      metadata: { filename },
    });
  } catch (e) {
    console.warn('[landlordPayoutPdf] audit log insert failed:', e);
  }
}

// ───────────────────────────────────────────────────────────
// Standalone PDF builder for landlord payout cards.
// Used by bulk export so we don't have to mount the React
// dialog component for each row. Mirrors the visual card
// rendered in LandlordPayoutShareCard.tsx.
// ───────────────────────────────────────────────────────────

const A4_PAGE_MM = { width: 210, height: 297 };
const PDF_MARGIN_MM = 14;
const PDF_HEADER_MM = 18;
const PDF_FOOTER_MM = 14;
const CARD_CAPTURE_WIDTH_PX = 480;
const CARD_CAPTURE_PIXEL_RATIO = 2.5;

function formatUGX(n: number) {
  return `UGX ${Number(n).toLocaleString()}`;
}

// ───────────────────────────────────────────────────────────
// Selectable export columns — shared by the PDF list export and
// the spreadsheet (XLSX) export so both stay in lockstep.
// ───────────────────────────────────────────────────────────
export type PayoutColumnKey =
  | 'date'
  | 'landlord'
  | 'momo'
  | 'tenant'
  | 'agent'
  | 'agent_phone'
  | 'tid'
  | 'country'
  | 'amount';

export interface PayoutColumnDef {
  key: PayoutColumnKey;
  label: string;
  /** Display string for the PDF cell. */
  text: (d: LandlordPayoutShareData) => string;
  /** Raw value for the spreadsheet cell (numbers stay numeric so sums work). */
  raw?: (d: LandlordPayoutShareData) => string | number;
  numeric?: boolean;
  pdfWidth?: number;
  pdfFontSize?: number;
}

export const PAYOUT_COLUMNS: PayoutColumnDef[] = [
  {
    key: 'date',
    label: 'Date / Period',
    text: (d) => new Date(d.paid_at).toLocaleDateString('en-UG'),
    raw: (d) => new Date(d.paid_at).toLocaleDateString('en-UG'),
    pdfWidth: 18,
  },
  { key: 'landlord', label: 'Landlord', text: (d) => d.landlord_name || '—' },
  {
    key: 'momo',
    label: 'MoMo Number',
    text: (d) => `${d.mobile_money_provider || ''} ${d.landlord_phone || ''}`.trim() || '—',
  },
  { key: 'tenant', label: 'Tenant', text: (d) => d.tenant_name || 'Unallocated' },
  { key: 'agent', label: 'Agent', text: (d) => d.agent_name || '—' },
  { key: 'agent_phone', label: 'Agent Phone', text: (d) => d.agent_phone || '—' },
  { key: 'tid', label: 'MoMo TID', text: (d) => d.momo_reference || '—', pdfWidth: 26, pdfFontSize: 7 },
  { key: 'country', label: 'Country', text: (d) => d.country || '—' },
  {
    key: 'amount',
    label: 'Amount',
    text: (d) => formatUGX(Number(d.amount || 0)),
    raw: (d) => Number(d.amount || 0),
    numeric: true,
  },
];

export const DEFAULT_PAYOUT_COLUMNS: PayoutColumnKey[] = [
  'date',
  'landlord',
  'momo',
  'tenant',
  'agent',
  'tid',
  'amount',
];

function resolveColumns(keys?: PayoutColumnKey[]): PayoutColumnDef[] {
  const wanted = keys && keys.length ? keys : DEFAULT_PAYOUT_COLUMNS;
  // Preserve the order the caller requested, ignoring unknown keys.
  const byKey = new Map(PAYOUT_COLUMNS.map((c) => [c.key, c]));
  const cols = wanted.map((k) => byKey.get(k)).filter(Boolean) as PayoutColumnDef[];
  return cols.length ? cols : PAYOUT_COLUMNS.filter((c) => DEFAULT_PAYOUT_COLUMNS.includes(c.key));
}

function escapeHtml(s: string) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Build the gradient payout card as an offscreen DOM node using
 * inline styles only, so it renders identically without Tailwind.
 */
function buildCardNode(d: LandlordPayoutShareData): HTMLDivElement {
  const root = document.createElement('div');
  root.style.position = 'fixed';
  root.style.left = '-10000px';
  root.style.top = '0';
  root.style.width = `${CARD_CAPTURE_WIDTH_PX}px`;
  root.style.pointerEvents = 'none';
  root.style.zIndex = '-1';

  const paidAt = new Date(d.paid_at).toLocaleString('en-UG');
  const tenant = d.tenant_name || 'Unallocated';

  root.innerHTML = `
    <div style="
      width:${CARD_CAPTURE_WIDTH_PX}px;
      box-sizing:border-box;
      border-radius:20px;
      padding:22px;
      color:#ffffff;
      font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif;
      background:linear-gradient(135deg,#3d0066 0%,#7A00CC 55%,#1a0033 100%);
      box-shadow:0 20px 40px -20px rgba(60,0,100,0.4);
      position:relative;
      overflow:hidden;
    ">
      <div style="position:relative;z-index:1;">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:18px;">
          <div>
            <div style="font-size:10px;letter-spacing:0.2em;text-transform:uppercase;color:#e9d5ff;">Welile · Landlord Paid</div>
            <div style="font-size:12px;color:rgba(237,221,255,0.8);margin-top:2px;">${escapeHtml(paidAt)}</div>
          </div>
          <div style="height:36px;width:36px;border-radius:9999px;background:rgba(255,255,255,0.15);display:flex;align-items:center;justify-content:center;">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#6ee7b7" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
              <circle cx="12" cy="12" r="10"></circle>
              <path d="M9 12l2 2 4-4"></path>
            </svg>
          </div>
        </div>
        <div style="margin-bottom:18px;">
          <div style="font-size:10px;letter-spacing:0.12em;text-transform:uppercase;color:#e9d5ff;">Amount sent</div>
          <div style="font-size:32px;font-weight:700;line-height:1.1;margin-top:4px;">${escapeHtml(formatUGX(d.amount))}</div>
        </div>
        <div style="border-radius:14px;background:rgba(255,255,255,0.10);border:1px solid rgba(255,255,255,0.15);padding:14px;">
          ${row('Landlord', escapeHtml(d.landlord_name))}
          ${row(escapeHtml(d.mobile_money_provider), `<span style="font-family:ui-monospace,Menlo,Consolas,monospace;">${escapeHtml(d.landlord_phone)}</span>`)}
          ${row('Tenant', escapeHtml(tenant))}
          ${row('MoMo TID', `<span style="font-family:ui-monospace,Menlo,Consolas,monospace;word-break:break-all;">${escapeHtml(d.momo_reference)}</span>`)}
          ${d.agent_name ? row('Agent', escapeHtml(d.agent_name)) : ''}
        </div>
        <div style="margin-top:14px;font-size:10px;text-align:center;color:rgba(237,221,255,0.8);">
          Powered by Welile · welileapp.com
        </div>
      </div>
    </div>
  `;
  return root;
}

function row(label: string, value: string) {
  return `
    <div style="display:flex;justify-content:space-between;gap:12px;font-size:13px;padding:3px 0;">
      <span style="color:#e9d5ff;">${label}</span>
      <span style="font-weight:600;text-align:right;">${value}</span>
    </div>
  `;
}

export async function renderPayoutCardPng(d: LandlordPayoutShareData): Promise<string> {
  const { toPng } = await import('html-to-image');
  const node = buildCardNode(d);
  document.body.appendChild(node);
  try {
    // wait one frame for layout
    await new Promise<void>((r) => requestAnimationFrame(() => r()));
    const dataUrl = await toPng(node.firstElementChild as HTMLElement, {
      pixelRatio: CARD_CAPTURE_PIXEL_RATIO,
      cacheBust: true,
      skipFonts: true,
      width: CARD_CAPTURE_WIDTH_PX,
      style: {
        width: `${CARD_CAPTURE_WIDTH_PX}px`,
        maxWidth: `${CARD_CAPTURE_WIDTH_PX}px`,
        transform: 'none',
      },
    });
    return dataUrl;
  } finally {
    node.remove();
  }
}

/**
 * Build a compact list PDF — many landlord payouts per A4 page,
 * rendered as a table (NOT one card per page). Caller can pass an
 * `onProgress(done, total)` callback for UX.
 */
export async function buildBulkPayoutsPdfBlob(
  rows: LandlordPayoutShareData[],
  columns?: PayoutColumnKey[],
  onProgress?: (done: number, total: number) => void,
): Promise<Blob> {
  if (!rows.length) throw new Error('No payouts to export');
  const { jsPDF } = await import('jspdf');
  const autoTable = (await import('jspdf-autotable')).default;
  const pdf = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4', compress: true });

  const margin = PDF_MARGIN_MM;
  const pageW = A4_PAGE_MM.width;
  const generatedAt = new Date().toLocaleString('en-UG');
  const total = rows.reduce((sum, r) => sum + Number(r.amount || 0), 0);
  const cols = resolveColumns(columns);
  const amountIdx = cols.findIndex((c) => c.key === 'amount');

  const body = rows.map((d, i) => [String(i + 1), ...cols.map((c) => c.text(d))]);

  // Footer: blank cells across, "Total" in the second-to-last column when an
  // amount column is present, then the grand total under the amount column.
  const footRow = ['', ...cols.map(() => '')];
  if (amountIdx >= 0) {
    footRow[amountIdx + 1] = formatUGX(total);
    if (amountIdx >= 1) footRow[amountIdx] = 'Total';
    else footRow[0] = 'Total';
  }

  // Per-column PDF styling, offset by 1 for the leading "#" column.
  const columnStyles: Record<number, any> = { 0: { cellWidth: 11, halign: 'right' } };
  cols.forEach((c, idx) => {
    const pos = idx + 1;
    const style: any = {};
    if (c.pdfWidth) style.cellWidth = c.pdfWidth;
    if (c.pdfFontSize) style.fontSize = c.pdfFontSize;
    if (c.numeric) {
      style.halign = 'right';
      style.fontStyle = 'bold';
    }
    if (Object.keys(style).length) columnStyles[pos] = style;
  });

  autoTable(pdf, {
    head: [['#', ...cols.map((c) => c.label)]],
    body,
    foot: amountIdx >= 0 ? [footRow] : undefined,
    // Grand total only on the final page so per-page footers don't read as
    // misleading "running" totals.
    showFoot: 'lastPage',
    startY: margin + PDF_HEADER_MM,
    // top margin keeps the repeated table header clear of the page title band
    // on pages 2+ (startY only applies to the first page).
    margin: {
      left: margin,
      right: margin,
      top: margin + PDF_HEADER_MM,
      bottom: PDF_FOOTER_MM + margin,
    },
    styles: { fontSize: 8, cellPadding: 2, overflow: 'linebreak', valign: 'middle' },
    headStyles: { fillColor: [122, 0, 204], textColor: [255, 255, 255], fontStyle: 'bold' },
    footStyles: { fillColor: [240, 235, 250], textColor: [0, 0, 0], fontStyle: 'bold' },
    alternateRowStyles: { fillColor: [248, 246, 252] },
    columnStyles,
    didDrawPage: () => {
      // Header
      pdf.setFontSize(16);
      pdf.setFont('helvetica', 'bold');
      pdf.setTextColor(0, 0, 0);
      pdf.text('Welile — Funded Landlord Payouts', margin, margin + 6);
      pdf.setFontSize(9);
      pdf.setFont('helvetica', 'normal');
      pdf.setTextColor(100, 100, 100);
      pdf.text(`Generated: ${generatedAt}  ·  ${rows.length} payouts`, margin, margin + 12);
      pdf.setTextColor(0, 0, 0);

      // Footer
      const pageH = A4_PAGE_MM.height;
      const footerY = pageH - margin - PDF_FOOTER_MM + 6;
      pdf.setDrawColor(220, 220, 220);
      pdf.setLineWidth(0.2);
      pdf.line(margin, footerY - 4, pageW - margin, footerY - 4);
      pdf.setFontSize(8);
      pdf.setTextColor(80, 80, 80);
      pdf.text('Internal Welile payout reconciliation report · welileapp.com', margin, footerY);
      const pageNum = pdf.getNumberOfPages();
      pdf.text(`Page ${pageNum}`, pageW - margin, footerY, { align: 'right' });
      pdf.setTextColor(0, 0, 0);
    },
  });

  onProgress?.(rows.length, rows.length);
  return pdf.output('blob');
}

/**
 * Build a spreadsheet (XLSX) of the funded payouts using the same
 * selectable column registry as the PDF list export. Amounts stay numeric
 * so Excel can sum/filter them, and a grand-total row is appended.
 */
export async function exportPayoutsXlsx(
  rows: LandlordPayoutShareData[],
  filename: string,
  columns?: PayoutColumnKey[],
): Promise<void> {
  if (!rows.length) throw new Error('No payouts to export');
  const cols = resolveColumns(columns);
  const headers = ['#', ...cols.map((c) => c.label)];
  const dataRows: (string | number)[][] = rows.map((d, i) => [
    i + 1,
    ...cols.map((c) => (c.raw ? c.raw(d) : c.text(d))),
  ]);

  const amountIdx = cols.findIndex((c) => c.key === 'amount');
  if (amountIdx >= 0) {
    const total = rows.reduce((s, r) => s + Number(r.amount || 0), 0);
    const totalRow: (string | number)[] = ['', ...cols.map(() => '')];
    totalRow[amountIdx + 1] = total;
    totalRow[amountIdx >= 1 ? amountIdx : 0] = 'Total';
    dataRows.push(totalRow);
  }

  await downloadXlsx(filename, headers, dataRows, 'Funded Payouts');
}

/**
 * Build a card-style PDF — the branded gradient payout card (one per row),
 * laid out two per A4 page. Heavier than the compact list (renders each card
 * to a PNG) but matches the shareable receipt look. Caller can pass an
 * `onProgress(done, total)` callback for UX.
 */
export async function buildBulkCardsPdfBlob(
  rows: LandlordPayoutShareData[],
  onProgress?: (done: number, total: number) => void,
): Promise<Blob> {
  if (!rows.length) throw new Error('No payouts to export');
  const { jsPDF } = await import('jspdf');
  const pdf = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4', compress: true });

  const margin = PDF_MARGIN_MM;
  const pageW = A4_PAGE_MM.width;
  const pageH = A4_PAGE_MM.height;
  const contentW = pageW - margin * 2;
  const gap = 8;
  let y = margin;

  for (let i = 0; i < rows.length; i++) {
    const dataUrl = await renderPayoutCardPng(rows[i]);
    const props = pdf.getImageProperties(dataUrl);
    const imgH = (props.height / props.width) * contentW;

    // New page if the card won't fit in the remaining vertical space.
    if (y + imgH > pageH - margin && y > margin) {
      pdf.addPage();
      y = margin;
    }
    pdf.addImage(dataUrl, 'PNG', margin, y, contentW, imgH, undefined, 'FAST');
    y += imgH + gap;
    onProgress?.(i + 1, rows.length);
  }

  return pdf.output('blob');
}

export function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  setTimeout(() => URL.revokeObjectURL(url), 1000);

  void logPayoutPdfExport(filename);
}

// ───────────────────────────────────────────────────────────
// Summary PDF — a printable breakdown of funded landlord payouts
// grouped by region and country, with real counts + amounts and a
// grand total. Distinct from the per-payout list/card exports.
// ───────────────────────────────────────────────────────────
export interface FundedSummaryStat {
  name: string;
  count: number;
  total: number;
}

export async function buildFundedSummaryPdfBlob(params: {
  regionStats: FundedSummaryStat[];
  countryStats: FundedSummaryStat[];
  payoutCount: number;
  grandTotal: number;
  scopeLabel?: string;
}): Promise<Blob> {
  const { jsPDF } = await import('jspdf');
  const autoTable = (await import('jspdf-autotable')).default;
  const pdf = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4', compress: true });

  const margin = PDF_MARGIN_MM;
  const pageW = A4_PAGE_MM.width;
  const pageH = A4_PAGE_MM.height;
  const generatedAt = new Date().toLocaleString('en-UG');
  const scope = params.scopeLabel ? ` · ${params.scopeLabel}` : '';

  const drawChrome = () => {
    pdf.setFontSize(16);
    pdf.setFont('helvetica', 'bold');
    pdf.setTextColor(0, 0, 0);
    pdf.text('Welile — Funded Landlord Payouts (Summary)', margin, margin + 6);
    pdf.setFontSize(9);
    pdf.setFont('helvetica', 'normal');
    pdf.setTextColor(100, 100, 100);
    pdf.text(
      `Generated: ${generatedAt}  ·  ${params.payoutCount} payouts  ·  ${formatUGX(params.grandTotal)}${scope}`,
      margin,
      margin + 12,
    );
    pdf.setTextColor(0, 0, 0);

    const footerY = pageH - margin - PDF_FOOTER_MM + 6;
    pdf.setDrawColor(220, 220, 220);
    pdf.setLineWidth(0.2);
    pdf.line(margin, footerY - 4, pageW - margin, footerY - 4);
    pdf.setFontSize(8);
    pdf.setTextColor(80, 80, 80);
    pdf.text('Internal Welile payout reconciliation report · welileapp.com', margin, footerY);
    pdf.text(`Page ${pdf.getNumberOfPages()}`, pageW - margin, footerY, { align: 'right' });
    pdf.setTextColor(0, 0, 0);
  };

  const commonOpts = {
    margin: {
      left: margin,
      right: margin,
      top: margin + PDF_HEADER_MM,
      bottom: PDF_FOOTER_MM + margin,
    },
    styles: { fontSize: 9, cellPadding: 2.5, overflow: 'linebreak' as const, valign: 'middle' as const },
    headStyles: { fillColor: [122, 0, 204] as [number, number, number], textColor: [255, 255, 255] as [number, number, number], fontStyle: 'bold' as const },
    footStyles: { fillColor: [240, 235, 250] as [number, number, number], textColor: [0, 0, 0] as [number, number, number], fontStyle: 'bold' as const },
    alternateRowStyles: { fillColor: [248, 246, 252] as [number, number, number] },
    columnStyles: {
      1: { halign: 'right' as const, cellWidth: 30 },
      2: { halign: 'right' as const, cellWidth: 45, fontStyle: 'bold' as const },
    },
    didDrawPage: drawChrome,
  };

  const regions = params.regionStats.filter((r) => r.count > 0);
  if (regions.length) {
    autoTable(pdf, {
      head: [['Region', 'Payouts', 'Amount']],
      body: regions.map((r) => [r.name, String(r.count), formatUGX(r.total)]),
      foot: [['Total', String(params.payoutCount), formatUGX(params.grandTotal)]],
      showFoot: 'lastPage',
      startY: margin + PDF_HEADER_MM,
      ...commonOpts,
    });
  }

  const countries = params.countryStats.filter((c) => c.count > 0);
  if (countries.length) {
    const prevY = (pdf as any).lastAutoTable?.finalY ?? margin + PDF_HEADER_MM;
    autoTable(pdf, {
      head: [['Country', 'Payouts', 'Amount']],
      body: countries.map((c) => [c.name, String(c.count), formatUGX(c.total)]),
      foot: [['Total', String(params.payoutCount), formatUGX(params.grandTotal)]],
      showFoot: 'lastPage',
      startY: regions.length ? prevY + 8 : margin + PDF_HEADER_MM,
      ...commonOpts,
    });
  }

  if (!regions.length && !countries.length) {
    drawChrome();
    pdf.setFontSize(11);
    pdf.text('No funded payouts in the selected scope.', margin, margin + PDF_HEADER_MM + 10);
  }

  return pdf.output('blob');
}