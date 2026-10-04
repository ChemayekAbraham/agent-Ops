// jsPDF loaded dynamically to reduce initial bundle size
import type { jsPDF as JsPDFType } from 'jspdf';
import { format } from 'date-fns';
import { formatUGX } from '@/lib/rentCalculations';
import { savePdfWithVault } from '@/lib/pdfVault';

const BRAND_PURPLE: [number, number, number] = [146, 52, 234];
const BRAND_LIGHT: [number, number, number] = [147, 51, 234];
const GRAY: [number, number, number] = [107, 114, 128];
const BLACK: [number, number, number] = [17, 24, 39];
const WHITE: [number, number, number] = [255, 255, 255];

function addBrandHeader(doc: JsPDFType, title: string): number {
  // Purple header bar
  doc.setFillColor(...BRAND_PURPLE);
  doc.rect(0, 0, 210, 38, 'F');

  doc.setTextColor(...WHITE);
  doc.setFontSize(22);
  doc.setFont('helvetica', 'bold');
  doc.text('Welile', 14, 18);
  doc.setFontSize(9);
  doc.setFont('helvetica', 'normal');
  doc.text('www.welile.com', 14, 25);
  
  doc.setFontSize(14);
  doc.setFont('helvetica', 'bold');
  doc.text(title, 196, 18, { align: 'right' });
  doc.setFontSize(8);
  doc.setFont('helvetica', 'normal');
  doc.text(`Generated: ${format(new Date(), 'MMM d, yyyy HH:mm')}`, 196, 25, { align: 'right' });
  
  // Accent line
  doc.setFillColor(...BRAND_LIGHT);
  doc.rect(0, 38, 210, 2, 'F');
  
  return 46;
}

function addRow(doc: JsPDFType, y: number, label: string, value: string, bold = false) {
  doc.setTextColor(...GRAY);
  doc.setFontSize(9);
  doc.setFont('helvetica', 'normal');
  doc.text(label, 14, y);
  
  doc.setTextColor(...BLACK);
  doc.setFontSize(10);
  doc.setFont('helvetica', bold ? 'bold' : 'normal');
  doc.text(value, 196, y, { align: 'right' });
  
  return y + 7;
}

function addDivider(doc: JsPDFType, y: number) {
  doc.setDrawColor(229, 231, 235);
  doc.setLineWidth(0.3);
  doc.line(14, y, 196, y);
  return y + 4;
}

function addFooter(doc: JsPDFType) {
  const pageHeight = doc.internal.pageSize.getHeight();
  doc.setFillColor(249, 250, 251);
  doc.rect(0, pageHeight - 20, 210, 20, 'F');
  doc.setTextColor(...GRAY);
  doc.setFontSize(7);
  doc.setFont('helvetica', 'normal');
  doc.text('Powered by Welile • www.welile.com', 105, pageHeight - 12, { align: 'center' });
  doc.text('This is a system-generated receipt. For queries, contact support.', 105, pageHeight - 7, { align: 'center' });
}

// ── DEPOSIT RECEIPT ──────────────────────────────────────
export interface DepositReceiptData {
  amount: number;
  status: string;
  provider?: string | null;
  transactionId?: string | null;
  transactionDate?: string | null;
  createdAt: string;
  approvedAt?: string | null;
  notes?: string | null;
  depositorName?: string;
  recipientName?: string;
  /** Human-readable deposit purpose label, e.g. "Operational Float". */
  purpose?: string | null;
}

export async function generateDepositReceiptPdf(data: DepositReceiptData): Promise<JsPDFType> {
  const { jsPDF } = await import('jspdf');
  const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4', compress: true });
  let y = addBrandHeader(doc, 'DEPOSIT RECEIPT');

  // Status badge area
  const statusColor: [number, number, number] = data.status === 'approved' ? [22, 163, 74] : data.status === 'rejected' ? [220, 38, 38] : [234, 179, 8];
  doc.setFillColor(...statusColor);
  doc.roundedRect(14, y, 40, 8, 2, 2, 'F');
  doc.setTextColor(...WHITE);
  doc.setFontSize(9);
  doc.setFont('helvetica', 'bold');
  doc.text(data.status.toUpperCase(), 34, y + 5.5, { align: 'center' });
  y += 16;

  // Amount
  doc.setTextColor(...BRAND_PURPLE);
  doc.setFontSize(24);
  doc.setFont('helvetica', 'bold');
  doc.text(formatUGX(data.amount), 105, y, { align: 'center' });
  y += 12;

  y = addDivider(doc, y);

  if (data.depositorName) y = addRow(doc, y, 'Depositor', data.depositorName);
  if (data.recipientName) y = addRow(doc, y, 'Recipient', data.recipientName);
  if (data.purpose) y = addRow(doc, y, 'Purpose', data.purpose);
  if (data.provider) y = addRow(doc, y, 'Provider', data.provider.toUpperCase());
  if (data.transactionId) y = addRow(doc, y, 'Transaction ID', data.transactionId);
  if (data.transactionDate) y = addRow(doc, y, 'Transaction Date', format(new Date(data.transactionDate), 'MMM d, yyyy h:mm a'));
  y = addRow(doc, y, 'Requested On', format(new Date(data.createdAt), 'MMM d, yyyy h:mm a'));
  if (data.approvedAt) y = addRow(doc, y, 'Verified On', format(new Date(data.approvedAt), 'MMM d, yyyy h:mm a'));
  if (data.notes) y = addRow(doc, y, 'Notes', data.notes);

  y = addDivider(doc, y);
  y = addRow(doc, y, 'Total Deposited', formatUGX(data.amount), true);

  addFooter(doc);
  return doc;
}

export async function downloadDepositReceipt(data: DepositReceiptData) {
  const doc = await generateDepositReceiptPdf(data);
  const filename = `Welile_Deposit_Receipt_${format(new Date(), 'yyyyMMdd')}.pdf`;
  savePdfWithVault(doc, filename, {
    label: `Deposit Receipt · ${formatUGX(data.amount)}`,
    category: 'withdrawal-receipt',
  });
}

export function buildDepositReceiptWhatsApp(data: DepositReceiptData): string {
  const lines = [
    `📄 *Welile Deposit Receipt*`,
    `━━━━━━━━━━━━━━━━`,
    `💰 *Amount:* ${formatUGX(data.amount)}`,
    `✅ *Status:* ${data.status.charAt(0).toUpperCase() + data.status.slice(1)}`,
  ];
  if (data.provider) lines.push(`📱 *Provider:* ${data.provider.toUpperCase()}`);
  if (data.transactionId) lines.push(`🔗 *Txn ID:* ${data.transactionId}`);
  if (data.purpose) lines.push(`🎯 *Purpose:* ${data.purpose}`);
  if (data.depositorName) lines.push(`👤 *Depositor:* ${data.depositorName}`);
  if (data.recipientName) lines.push(`👤 *Recipient:* ${data.recipientName}`);
  lines.push(`📅 *Date:* ${format(new Date(data.createdAt), 'MMM d, yyyy h:mm a')}`);
  if (data.notes) lines.push(`📝 *Note:* ${data.notes}`);
  lines.push(`━━━━━━━━━━━━━━━━`, `Powered by Welile`);
  return lines.join('\n');
}

// ── RENT STATEMENT / RECEIPT ──────────────────────────────
export interface RentStatementData {
  tenantName: string;
  tenantPhone?: string;
  landlordName: string;
  propertyAddress?: string;
  rentAmount: number;
  totalRepayment: number;
  amountRepaid: number;
  dailyRepayment: number;
  durationDays: number;
  status: string;
  createdAt: string;
  requestId: string;
}

export async function generateRentStatementPdf(data: RentStatementData): Promise<JsPDFType> {
  const { jsPDF } = await import('jspdf');
  const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4', compress: true });
  let y = addBrandHeader(doc, 'RENT STATEMENT');

  const outstanding = Math.max(0, data.totalRepayment - data.amountRepaid);
  const progress = data.totalRepayment > 0 ? Math.min(100, (data.amountRepaid / data.totalRepayment) * 100) : 0;

  // Tenant info section
  doc.setFillColor(249, 250, 251);
  doc.roundedRect(14, y, 182, 20, 3, 3, 'F');
  doc.setTextColor(...BLACK);
  doc.setFontSize(12);
  doc.setFont('helvetica', 'bold');
  doc.text(data.tenantName, 20, y + 8);
  doc.setFontSize(9);
  doc.setFont('helvetica', 'normal');
  doc.setTextColor(...GRAY);
  if (data.tenantPhone) doc.text(data.tenantPhone, 20, y + 14);
  doc.text(`Ref: WEL-${data.requestId.substring(0, 8).toUpperCase()}`, 190, y + 8, { align: 'right' });
  y += 28;

  // Key figures in boxes
  const boxW = 58;
  const boxes = [
    { label: 'Rent Amount', value: formatUGX(data.rentAmount), color: BRAND_PURPLE },
    { label: 'Amount Repaid', value: formatUGX(data.amountRepaid), color: [22, 163, 74] as [number, number, number] },
    { label: 'Outstanding', value: formatUGX(outstanding), color: (outstanding > 0 ? [220, 38, 38] : [22, 163, 74]) as [number, number, number] },
  ];

  boxes.forEach((box, i) => {
    const x = 14 + i * (boxW + 4);
    doc.setFillColor(249, 250, 251);
    doc.roundedRect(x, y, boxW, 22, 2, 2, 'F');
    doc.setTextColor(...GRAY);
    doc.setFontSize(7);
    doc.setFont('helvetica', 'normal');
    doc.text(box.label, x + boxW / 2, y + 7, { align: 'center' });
    doc.setTextColor(...(box.color as [number, number, number]));
    doc.setFontSize(12);
    doc.setFont('helvetica', 'bold');
    doc.text(box.value, x + boxW / 2, y + 17, { align: 'center' });
  });
  y += 30;

  // Progress bar
  doc.setFillColor(229, 231, 235);
  doc.roundedRect(14, y, 182, 5, 2, 2, 'F');
  if (progress > 0) {
    const barColor: [number, number, number] = progress >= 100 ? [22, 163, 74] : BRAND_LIGHT;
    doc.setFillColor(...barColor);
    doc.roundedRect(14, y, Math.max(4, 182 * (progress / 100)), 5, 2, 2, 'F');
  }
  doc.setTextColor(...GRAY);
  doc.setFontSize(8);
  doc.text(`${progress.toFixed(1)}% Complete`, 105, y + 10, { align: 'center' });
  y += 16;

  y = addDivider(doc, y);

  // Details
  y = addRow(doc, y, 'Landlord', data.landlordName);
  if (data.propertyAddress) y = addRow(doc, y, 'Property', data.propertyAddress);
  y = addRow(doc, y, 'Total Repayment', formatUGX(data.totalRepayment));
  y = addRow(doc, y, 'Daily Repayment', formatUGX(data.dailyRepayment));
  y = addRow(doc, y, 'Duration', `${data.durationDays} days`);
  y = addRow(doc, y, 'Status', (data.status || 'pending').toUpperCase());
  y = addRow(doc, y, 'Request Date', format(new Date(data.createdAt), 'MMM d, yyyy'));

  y = addDivider(doc, y);
  
  // Outstanding highlight
  if (outstanding > 0) {
    doc.setFillColor(254, 242, 242);
    doc.roundedRect(14, y, 182, 12, 2, 2, 'F');
    doc.setTextColor(220, 38, 38);
    doc.setFontSize(12);
    doc.setFont('helvetica', 'bold');
    doc.text(`OUTSTANDING BALANCE: ${formatUGX(outstanding)}`, 105, y + 8, { align: 'center' });
    y += 18;
  } else {
    doc.setFillColor(240, 253, 244);
    doc.roundedRect(14, y, 182, 12, 2, 2, 'F');
    doc.setTextColor(22, 163, 74);
    doc.setFontSize(12);
    doc.setFont('helvetica', 'bold');
    doc.text('✓ FULLY PAID', 105, y + 8, { align: 'center' });
    y += 18;
  }

  addFooter(doc);
  return doc;
}

export async function downloadRentStatement(data: RentStatementData) {
  const doc = await generateRentStatementPdf(data);
  const filename = `Welile_Rent_Statement_${data.tenantName.replace(/\s+/g, '_')}_${format(new Date(), 'yyyyMMdd')}.pdf`;
  savePdfWithVault(doc, filename, {
    label: `Rent Statement · ${data.tenantName}`,
    category: 'tenant-ops',
  });
}

export function buildRentStatementWhatsApp(data: RentStatementData): string {
  const outstanding = Math.max(0, data.totalRepayment - data.amountRepaid);
  const progress = data.totalRepayment > 0 ? Math.min(100, (data.amountRepaid / data.totalRepayment) * 100) : 0;
  
  const lines = [
    `📄 *Welile Rent Statement*`,
    `━━━━━━━━━━━━━━━━`,
    `👤 *Tenant:* ${data.tenantName}`,
    `🏠 *Landlord:* ${data.landlordName}`,
    `━━━━━━━━━━━━━━━━`,
    `💰 *Rent:* ${formatUGX(data.rentAmount)}`,
    `💳 *Total Repayment:* ${formatUGX(data.totalRepayment)}`,
    `✅ *Paid:* ${formatUGX(data.amountRepaid)}`,
    outstanding > 0 
      ? `❌ *Outstanding:* ${formatUGX(outstanding)}`
      : `✅ *FULLY PAID*`,
    `📊 *Progress:* ${progress.toFixed(1)}%`,
    `📅 *Daily:* ${formatUGX(data.dailyRepayment)}`,
    `🔗 *Ref:* WEL-${data.requestId.substring(0, 8).toUpperCase()}`,
    `━━━━━━━━━━━━━━━━`,
    `Powered by Welile`,
  ];
  return lines.join('\n');
}
