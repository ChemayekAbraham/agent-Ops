import { formatUGX } from '@/lib/rentCalculations';
import welileLogoUrl from '@/assets/welile-logo.png';

/**
 * Proxy Command Center list exports (partners / promissory notes).
 *
 * PDF only. The previous CSV export lost data twice over: spreadsheets coerced
 * the phone column to scientific notation, and only the visible page of rows
 * was written out. Callers must therefore hand over the FULL list, already
 * fetched across every page.
 *
 * Plain ASCII punctuation throughout - no emoji, no em dashes - so nothing
 * mis-decodes in the exported document.
 */

export interface ProxyPartnerPdfRow {
  partner_name: string;
  partner_phone: string;
  linked_at: string;
  portfolios: number;
  total_funded: number;
  last_funded_at: string | null;
  came_in: boolean;
  is_returning: boolean;
  notes_count: number;
  sources: string[];
}

export interface ProxyNotePdfRow {
  partner_name: string;
  phone: string;
  amount: number;
  contribution_type: string | null;
  status: string;
  total_collected: number;
  linked_partner_name: string | null;
  partner_came_in: boolean;
  created_at: string;
}

interface BaseInput {
  agentName?: string;
  filterSummary?: string;
  generatedAt?: Date;
}

const THEME_PRIMARY: [number, number, number] = [146, 52, 234];
const THEME_STRIPE: [number, number, number] = [245, 240, 252];

const COMPANY_NAME = 'Welile Technologies Limited';
const COMPANY_CONTACT = 'info@welile.com  |  www.welile.com';

const NONE = 'Not recorded';

const fmtDate = (iso: string | null | undefined) => {
  if (!iso) return NONE;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return NONE;
  return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
};

/** Phone kept as a plain text string, never a number. */
const fmtPhone = (v: string | null | undefined) => {
  const s = String(v ?? '').trim();
  return s ? s : NONE;
};

const titleCase = (s: string | null | undefined) =>
  (String(s ?? '').trim() || NONE).replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());

async function loadLogoBase64(): Promise<string | null> {
  try {
    const res = await fetch(welileLogoUrl);
    const blob = await res.blob();
    return await new Promise((resolve) => {
      const reader = new FileReader();
      reader.onloadend = () => resolve(reader.result as string);
      reader.onerror = () => resolve(null);
      reader.readAsDataURL(blob);
    });
  } catch {
    return null;
  }
}

async function startDoc(title: string, input: BaseInput, recordCount: number, summaryLines: string[]) {
  const { default: jsPDF } = await import('jspdf');
  const autoTableMod: any = await import('jspdf-autotable');
  const autoTable = autoTableMod.default || autoTableMod;

  const generatedAt = input.generatedAt || new Date();
  const doc = new jsPDF({ unit: 'mm', format: 'a4', orientation: 'landscape' });
  const pageWidth = doc.internal.pageSize.getWidth();
  const margin = 12;
  const logoBase64 = await loadLogoBase64();

  doc.setFillColor(...THEME_PRIMARY);
  doc.rect(0, 0, pageWidth, 26, 'F');
  if (logoBase64) {
    try { doc.addImage(logoBase64, 'PNG', margin, 5, 16, 16); } catch { /* ignore */ }
  }
  doc.setTextColor(255, 255, 255);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(14);
  doc.text(title, logoBase64 ? margin + 20 : margin, 12);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(8.5);
  doc.text(`${COMPANY_NAME}  |  ${COMPANY_CONTACT}`, logoBase64 ? margin + 20 : margin, 18);

  const meta = [
    input.agentName ? `Agent: ${input.agentName}` : null,
    `Records: ${recordCount.toLocaleString('en-US')}`,
    `Generated: ${generatedAt.toLocaleString('en-GB')}`,
  ].filter(Boolean).join('   |   ');
  doc.text(meta, pageWidth - margin, 18, { align: 'right' });

  doc.setTextColor(60, 60, 60);
  doc.setFontSize(9);
  let y = 33;
  if (input.filterSummary) {
    doc.text(`View: ${input.filterSummary}`, margin, y);
    y += 5;
  }
  summaryLines.forEach((line) => {
    doc.text(line, margin, y);
    y += 5;
  });

  return { doc, autoTable, margin, pageWidth, startY: y + 2 };
}

function footer(doc: any, pageWidth: number, margin: number) {
  const h = doc.internal.pageSize.getHeight();
  doc.setFontSize(7.5);
  doc.setTextColor(130, 130, 130);
  doc.text('Confidential. Contact details shown in full for reconciliation purposes.', margin, h - 6);
  doc.text(`Page ${doc.getNumberOfPages()}`, pageWidth - margin, h - 6, { align: 'right' });
}

export async function generateProxyPartnerListPdf(
  input: BaseInput & { rows: ProxyPartnerPdfRow[] },
): Promise<Blob> {
  const rows = input.rows;
  const funded = rows.reduce((s, r) => s + (Number(r.total_funded) || 0), 0);
  const cameIn = rows.filter((r) => r.came_in).length;
  const returning = rows.filter((r) => r.is_returning).length;

  const { doc, autoTable, margin, pageWidth, startY } = await startDoc(
    'Proxy Partner List',
    input,
    rows.length,
    [
      `Total funded by these partners: ${formatUGX(funded)}`,
      `Came in: ${cameIn.toLocaleString('en-US')}   |   Returning: ${returning.toLocaleString('en-US')}   |   Not yet funded: ${(rows.length - cameIn).toLocaleString('en-US')}`,
    ],
  );

  autoTable(doc, {
    startY,
    margin: { left: margin, right: margin },
    head: [['#', 'Partner', 'Phone', 'Linked on', 'Portfolios', 'Total funded', 'Last funded', 'Came in', 'Returning', 'Notes', 'Sources']],
    body: rows.map((r, i) => [
      String(i + 1),
      String(r.partner_name || NONE),
      fmtPhone(r.partner_phone),
      fmtDate(r.linked_at),
      String(Number(r.portfolios) || 0),
      formatUGX(Number(r.total_funded) || 0),
      fmtDate(r.last_funded_at),
      r.came_in ? 'Yes' : 'No',
      r.is_returning ? 'Yes' : 'No',
      String(Number(r.notes_count) || 0),
      (r.sources ?? []).join(', ') || NONE,
    ]),
    styles: { fontSize: 7.5, cellPadding: 1.8, overflow: 'linebreak', textColor: [40, 40, 40] },
    headStyles: { fillColor: THEME_PRIMARY, textColor: [255, 255, 255], fontStyle: 'bold', fontSize: 7.5 },
    alternateRowStyles: { fillColor: THEME_STRIPE },
    columnStyles: {
      0: { cellWidth: 9, halign: 'right' },
      1: { cellWidth: 46 },
      2: { cellWidth: 28 },
      3: { cellWidth: 22 },
      4: { cellWidth: 17, halign: 'right' },
      5: { cellWidth: 30, halign: 'right' },
      6: { cellWidth: 22 },
      7: { cellWidth: 15 },
      8: { cellWidth: 17 },
      9: { cellWidth: 13, halign: 'right' },
    },
    didDrawPage: () => footer(doc, pageWidth, margin),
  });

  return doc.output('blob');
}

export async function generateProxyNoteListPdf(
  input: BaseInput & { rows: ProxyNotePdfRow[] },
): Promise<Blob> {
  const rows = input.rows;
  const promised = rows.reduce((s, r) => s + (Number(r.amount) || 0), 0);
  const collected = rows.reduce((s, r) => s + (Number(r.total_collected) || 0), 0);
  const activated = rows.filter((r) => r.status === 'activated').length;

  const { doc, autoTable, margin, pageWidth, startY } = await startDoc(
    'Proxy Promissory Notes',
    input,
    rows.length,
    [
      `Promised: ${formatUGX(promised)}   |   Collected: ${formatUGX(collected)}`,
      `Activated: ${activated.toLocaleString('en-US')}   |   Still pending: ${(rows.length - activated).toLocaleString('en-US')}`,
    ],
  );

  autoTable(doc, {
    startY,
    margin: { left: margin, right: margin },
    head: [['#', 'Partner', 'Phone', 'Amount', 'Type', 'Status', 'Collected', 'Linked partner', 'Came in', 'Recorded']],
    body: rows.map((r, i) => [
      String(i + 1),
      String(r.partner_name || NONE),
      fmtPhone(r.phone),
      formatUGX(Number(r.amount) || 0),
      titleCase(r.contribution_type),
      titleCase(r.status),
      formatUGX(Number(r.total_collected) || 0),
      String(r.linked_partner_name || 'Not linked'),
      r.partner_came_in ? 'Yes' : 'No',
      fmtDate(r.created_at),
    ]),
    styles: { fontSize: 7.5, cellPadding: 1.8, overflow: 'linebreak', textColor: [40, 40, 40] },
    headStyles: { fillColor: THEME_PRIMARY, textColor: [255, 255, 255], fontStyle: 'bold', fontSize: 7.5 },
    alternateRowStyles: { fillColor: THEME_STRIPE },
    columnStyles: {
      0: { cellWidth: 9, halign: 'right' },
      1: { cellWidth: 46 },
      2: { cellWidth: 28 },
      3: { cellWidth: 30, halign: 'right' },
      4: { cellWidth: 24 },
      5: { cellWidth: 22 },
      6: { cellWidth: 30, halign: 'right' },
      8: { cellWidth: 15 },
      9: { cellWidth: 22 },
    },
    didDrawPage: () => footer(doc, pageWidth, margin),
  });

  return doc.output('blob');
}
