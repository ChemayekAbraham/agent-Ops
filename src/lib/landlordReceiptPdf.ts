import jsPDF from 'jspdf';
import QRCode from 'qrcode';
import { formatUGX } from '@/lib/rentCalculations';

/** Display-safe landlord rent receipt as returned by `get_landlord_payout_receipt`. */
export interface LandlordReceiptData {
  receipt_code: string;
  receipt_number: string;
  status: 'completed' | 'reversed' | 'refunded' | string;
  amount: number;
  landlord_name: string;
  tenant_name: string;
  agent_name?: string | null;
  rent_period?: string | null;
  house_type?: string | null;
  property_address?: string | null;
  paid_at?: string | null;
  processed_by_name?: string | null;
  processor_role?: string | null;
  payment_method?: string | null;
  transaction_reference?: string | null;
  generated_at?: string | null;
  reversed_at?: string | null;
}

export function landlordReceiptUrl(code: string) {
  return `https://welileapp.com/r/${code}`;
}

export function formatReceiptDateTime(iso?: string | null) {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('en-GB', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function landlordReceiptStatusLabel(status: string) {
  if (status === 'reversed') return 'Payment Reversed';
  if (status === 'refunded') return 'Payment Refunded';
  return 'Payment Completed';
}

/**
 * Builds and downloads the landlord rent receipt as an A4 PDF. Layout is drawn
 * programmatically (no html2canvas) so it matches the web receipt and prints
 * cleanly on A4.
 */
export async function downloadLandlordReceiptPdf(data: LandlordReceiptData) {
  const PURPLE: [number, number, number] = [139, 44, 245];
  const INK: [number, number, number] = [23, 27, 44];
  const MUTED: [number, number, number] = [120, 130, 150];

  const doc = new jsPDF({ unit: 'pt', format: 'a4' });
  const pageW = doc.internal.pageSize.getWidth();
  const cardX = 48;
  const cardW = pageW - cardX * 2;
  let y = 56;

  // Header
  doc.setTextColor(...PURPLE);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(22);
  doc.text('WELILE', cardX, y);
  doc.setTextColor(...INK);
  doc.setFontSize(15);
  doc.text('Rent Payment Receipt', cardX, (y += 26));
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(10);
  doc.setTextColor(...MUTED);
  doc.text(
    `Receipt No. ${data.receipt_number}  ·  ${formatReceiptDateTime(data.paid_at)}  ·  ${landlordReceiptStatusLabel(
      data.status,
    )}`,
    cardX,
    (y += 18),
  );

  // Amount block
  y += 20;
  doc.setDrawColor(230, 232, 240);
  doc.setFillColor(251, 249, 255);
  doc.roundedRect(cardX, y, cardW, 96, 10, 10, 'FD');
  doc.setTextColor(144, 97, 217);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(9);
  doc.text('AMOUNT PAID', cardX + cardW / 2, y + 26, { align: 'center' });
  doc.setTextColor(...PURPLE);
  doc.setFontSize(28);
  doc.text(formatUGX(data.amount), cardX + cardW / 2, y + 58, { align: 'center' });
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(10);
  doc.setTextColor(...MUTED);
  doc.text(
    `Rent successfully paid to ${data.landlord_name} for ${data.tenant_name}`,
    cardX + cardW / 2,
    y + 80,
    { align: 'center' },
  );
  y += 122;

  // Details
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(9);
  doc.setTextColor(...MUTED);
  doc.text('PAYMENT DETAILS', cardX, y);
  y += 14;

  const rows: Array<[string, string]> = [
    ['Landlord', data.landlord_name || '—'],
    ['Tenant', data.tenant_name || '—'],
    ['Rent Period', data.rent_period || '—'],
    ['House Type', data.house_type || '—'],
    ['Property Address', data.property_address || '—'],
    ['Amount Paid', formatUGX(data.amount)],
    ['Payment Date', formatReceiptDateTime(data.paid_at)],
    ['Processed By', data.processed_by_name || '—'],
    ['Processor Role', data.processor_role || '—'],
    ['Payment Method', data.payment_method || '—'],
    ['Transaction Reference', data.transaction_reference || '—'],
    ['Receipt Number', data.receipt_number],
  ];

  for (const [label, value] of rows) {
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(9);
    doc.setTextColor(...MUTED);
    doc.text(label, cardX, y);
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(10);
    doc.setTextColor(...INK);
    const lines = doc.splitTextToSize(String(value), cardW - 190);
    doc.text(lines, cardX + 180, y);
    y += 14 * Math.max(1, lines.length) + 8;
    doc.setDrawColor(226, 229, 238);
    doc.line(cardX, y - 10, cardX + cardW, y - 10);
  }

  // Footer + QR
  y += 12;
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(9);
  doc.setTextColor(...MUTED);
  const footer = doc.splitTextToSize(
    'This receipt confirms that Welile recorded the above rent payment as successfully disbursed to the landlord.',
    cardW,
  );
  doc.text(footer, cardX, y);
  y += 14 * footer.length + 10;

  try {
    const url = landlordReceiptUrl(data.receipt_code);
    const qr = await QRCode.toDataURL(url, { margin: 1, width: 220 });
    doc.addImage(qr, 'PNG', cardX, y, 92, 92);
    doc.setFontSize(9);
    doc.setTextColor(...MUTED);
    doc.text('Scan to verify this receipt', cardX + 106, y + 40);
    doc.setTextColor(...PURPLE);
    doc.setFont('helvetica', 'bold');
    doc.text(url.replace('https://', ''), cardX + 106, y + 56);
  } catch {
    /* QR is decorative — never block the download */
  }

  doc.save(`welile-rent-receipt-${data.receipt_number}.pdf`);
}
