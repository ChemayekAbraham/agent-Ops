// Generates a downloadable receipt (PDF or Excel) for a manual rent
// collection performed from the Tenant Ops drill-down. Mirrors the style
// of withdrawalReceiptPdf.ts and reuses the PDF vault + xlsx helpers so the
// artifact is archived on-device and stays lean (dynamic imports).
import { format } from 'date-fns';
import { savePdfWithVault } from '@/lib/pdfVault';
import { downloadXlsx } from '@/lib/xlsxExport';

export interface RentCollectionReceiptData {
  reference: string;        // rent request id
  tenantName: string;
  tenantPhone?: string;
  agentName?: string;
  totalCollected: number;
  tenantDeducted: number;
  agentDeducted: number;
  commissionPaid?: number;
  remainingBalance?: number;
  requestedAmount?: number; // amount the collector tried to take (for partial collections)
  isPartial?: boolean;      // true when this is a partial / shortfall collection
  reason: string;
  collectedBy?: string;
  date: Date;
  currency?: string;
}

const CURRENCY = 'UGX';

function safeRef(ref: string): string {
  return (ref || 'receipt').replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 24);
}

export function rentCollectionReceiptFilename(data: RentCollectionReceiptData, ext: 'pdf' | 'xlsx'): string {
  return `rent_collection_${safeRef(data.reference)}.${ext}`;
}

function fmt(n: number, currency = CURRENCY): string {
  return `${currency} ${Math.round(Number(n) || 0).toLocaleString()}`;
}

async function renderPdf(data: RentCollectionReceiptData) {
  const { default: JsPDF } = await import('jspdf');
  const doc = new JsPDF({ unit: 'pt', format: 'a4' });
  const currency = data.currency || CURRENCY;
  const pageWidth = doc.internal.pageSize.getWidth();
  const marginX = 48;
  let y = 64;

  // Header
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(20);
  doc.text(data.isPartial ? 'Partial Rent Collection Receipt' : 'Rent Collection Receipt', marginX, y);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(10);
  doc.setTextColor(120);
  y += 18;
  doc.text(
    data.isPartial ? 'Welile — server-confirmed partial collection' : 'Welile — server-confirmed collection',
    marginX,
    y,
  );
  doc.setTextColor(0);

  // Amount block
  y += 36;
  doc.setDrawColor(220);
  doc.setFillColor(240, 248, 244);
  doc.roundedRect(marginX, y, pageWidth - marginX * 2, 70, 8, 8, 'F');
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(10);
  doc.setTextColor(110);
  doc.text('Total Collected', marginX + 16, y + 22);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(22);
  doc.setTextColor(20);
  doc.text(fmt(data.totalCollected, currency), marginX + 16, y + 52);
  y += 70;

  // Source breakdown
  y += 18;
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(11);
  doc.setTextColor(20);
  doc.text('Collection Breakdown', marginX, y);
  y += 10;
  doc.setDrawColor(230);
  doc.line(marginX, y, pageWidth - marginX, y);
  y += 14;

  doc.setFontSize(10);
  const drawLine = (label: string, value: string, opts?: { bold?: boolean; muted?: boolean }) => {
    doc.setFont('helvetica', opts?.bold ? 'bold' : 'normal');
    doc.setTextColor(opts?.muted ? 130 : 30);
    doc.text(label, marginX, y);
    const w = doc.getTextWidth(value);
    doc.text(value, pageWidth - marginX - w, y);
    y += 16;
  };

  drawLine('From tenant wallet', fmt(data.tenantDeducted, currency));
  drawLine('From linked agent wallet', fmt(data.agentDeducted, currency), { muted: data.agentDeducted === 0 });
  y += 4;
  doc.setDrawColor(210);
  doc.line(marginX, y - 8, pageWidth - marginX, y - 8);
  if (typeof data.requestedAmount === 'number' && data.requestedAmount !== data.totalCollected) {
    drawLine('Amount requested', fmt(data.requestedAmount, currency), { muted: true });
  }
  drawLine('Total collected', fmt(data.totalCollected, currency), { bold: true });
  if (typeof data.commissionPaid === 'number' && data.commissionPaid > 0) {
    drawLine('Agent commission (10%)', fmt(data.commissionPaid, currency), { muted: true });
  }
  if (typeof data.remainingBalance === 'number') {
    drawLine(
      data.remainingBalance > 0 ? 'Balance remaining (partial)' : 'Balance remaining',
      fmt(data.remainingBalance, currency),
      { bold: data.remainingBalance > 0, muted: data.remainingBalance <= 0 },
    );
  }

  // Details
  const rows: Array<[string, string]> = [
    ['Reference', data.reference],
    ['Collection type', data.isPartial ? 'Partial' : 'Full'],
    ['Tenant', data.tenantName],
    ...(data.tenantPhone ? [['Tenant phone', data.tenantPhone] as [string, string]] : []),
    ...(data.agentName ? [['Linked agent', data.agentName] as [string, string]] : []),
    ...(data.collectedBy ? [['Collected by', data.collectedBy] as [string, string]] : []),
    ['Date', format(data.date, 'MMM d, yyyy HH:mm')],
    ['Reason', data.reason],
  ];
  y += 24;
  doc.setFontSize(11);
  rows.forEach(([label, value]) => {
    doc.setTextColor(110);
    doc.setFont('helvetica', 'normal');
    doc.text(label, marginX, y);
    doc.setTextColor(20);
    doc.setFont('helvetica', 'bold');
    const lines = doc.splitTextToSize(String(value ?? '-'), pageWidth - marginX * 2 - 120);
    doc.text(lines, marginX + 120, y);
    y += 16 * Math.max(1, lines.length) + 6;
    doc.setDrawColor(235);
    doc.line(marginX, y - 4, pageWidth - marginX, y - 4);
  });

  // Footer
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(9);
  doc.setTextColor(140);
  doc.text(
    'This receipt confirms a manual rent collection processed by Welile from the tenant wallet, with any shortfall drawn from the linked agent wallet.',
    marginX,
    doc.internal.pageSize.getHeight() - 48,
    { maxWidth: pageWidth - marginX * 2 },
  );
  return doc;
}

export async function downloadRentCollectionReceiptPdf(data: RentCollectionReceiptData): Promise<void> {
  const doc = await renderPdf(data);
  const filename = rentCollectionReceiptFilename(data, 'pdf');
  savePdfWithVault(doc, filename, {
    label: `Rent Collection · ${data.tenantName} · ${fmt(data.totalCollected, data.currency)}`,
    category: 'tenant-ops',
  });
}

export async function downloadRentCollectionReceiptXlsx(data: RentCollectionReceiptData): Promise<void> {
  const currency = data.currency || CURRENCY;
  const headers = ['Field', 'Value'];
  const rows: (string | number)[][] = [
    ['Receipt', 'Rent Collection Receipt'],
    ['Reference', data.reference],
    ['Collection type', data.isPartial ? 'Partial' : 'Full'],
    ['Date', format(data.date, 'yyyy-MM-dd HH:mm')],
    ['Tenant', data.tenantName],
    ...(data.tenantPhone ? [['Tenant phone', data.tenantPhone]] : []),
    ...(data.agentName ? [['Linked agent', data.agentName]] : []),
    ...(data.collectedBy ? [['Collected by', data.collectedBy]] : []),
    ['Currency', currency],
    ...(typeof data.requestedAmount === 'number' ? [['Amount requested', Math.round(data.requestedAmount)]] : []),
    ['From tenant wallet', Math.round(data.tenantDeducted)],
    ['From linked agent wallet', Math.round(data.agentDeducted)],
    ['Total collected', Math.round(data.totalCollected)],
    ...(typeof data.commissionPaid === 'number' ? [['Agent commission (10%)', Math.round(data.commissionPaid)]] : []),
    ...(typeof data.remainingBalance === 'number' ? [['Balance remaining', Math.round(data.remainingBalance)]] : []),
    ['Reason', data.reason],
  ];
  await downloadXlsx(rentCollectionReceiptFilename(data, 'xlsx'), headers, rows, 'Collection');
}
