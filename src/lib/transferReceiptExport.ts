/**
 * Downloadable receipt for a single wallet item transfer (PDF or Excel).
 *
 * Presentation-only: it renders data already fetched for the transaction
 * feed / wallet statement. Nothing here writes wallet or ledger state.
 *
 * jsPDF and SheetJS are imported dynamically so neither lands in the
 * initial bundle.
 */
import { format } from 'date-fns';
import { savePdfWithVault } from '@/lib/pdfVault';
import { downloadXlsx } from '@/lib/xlsxExport';

export interface TransferReceiptData {
  /** The Welile item this transfer paid for, e.g. "Welile Rent". */
  item: string;
  amount: number;
  date: Date;
  sender: string;
  receiver: string;
  reference: string;
  /** Optional payment channel label shown as a detail row. */
  method?: string | null;
}

function safeRef(data: TransferReceiptData): string {
  return (data.reference || 'transfer').replace(/[^A-Za-z0-9_-]/g, '_');
}

export function transferReceiptFilename(data: TransferReceiptData, ext: 'pdf' | 'xlsx'): string {
  return `welile_transfer_${safeRef(data)}.${ext}`;
}

const UGX = (n: number) => `UGX ${Math.round(n).toLocaleString()}`;

export async function downloadTransferReceiptPdf(data: TransferReceiptData): Promise<void> {
  const { default: JsPDF } = await import('jspdf');
  const doc = new JsPDF({ unit: 'pt', format: 'a4' });

  const pageWidth = doc.internal.pageSize.getWidth();
  const marginX = 48;
  let y = 64;

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(20);
  doc.text('Transfer Receipt', marginX, y);

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(10);
  doc.setTextColor(120);
  y += 18;
  doc.text('Welile — wallet item transfer', marginX, y);
  doc.setTextColor(0);

  // Item + amount panel
  y += 30;
  doc.setDrawColor(220);
  doc.setFillColor(245, 247, 250);
  doc.roundedRect(marginX, y, pageWidth - marginX * 2, 92, 8, 8, 'F');
  doc.setFontSize(10);
  doc.setTextColor(110);
  doc.text('Item', marginX + 16, y + 22);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(14);
  doc.setTextColor(20);
  doc.text(data.item || 'Welile transfer', marginX + 16, y + 42);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(10);
  doc.setTextColor(110);
  doc.text('Amount', marginX + 16, y + 62);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(20);
  doc.setTextColor(20);
  doc.text(UGX(data.amount), marginX + 16, y + 84);
  y += 92;

  // Detail rows
  const rows: Array<[string, string]> = [
    ['Date', format(data.date, 'dd MMM yyyy, HH:mm')],
    ['Sender', data.sender || '—'],
    ['Receiver', data.receiver || '—'],
    ['Reference', data.reference || '—'],
  ];
  if (data.method) rows.push(['Payment channel', data.method]);

  y += 24;
  doc.setFontSize(11);
  for (const [label, value] of rows) {
    doc.setFont('helvetica', 'normal');
    doc.setTextColor(110);
    doc.text(label, marginX, y);
    doc.setFont('helvetica', 'bold');
    doc.setTextColor(20);
    doc.text(String(value), pageWidth - marginX, y, { align: 'right' });
    doc.setDrawColor(232);
    doc.line(marginX, y + 8, pageWidth - marginX, y + 8);
    y += 28;
  }

  y += 12;
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(9);
  doc.setTextColor(130);
  const footer = doc.splitTextToSize(
    'This receipt is generated from the Welile wallet record of this transfer. Amounts are in UGX.',
    pageWidth - marginX * 2,
  );
  doc.text(footer, marginX, y);

  savePdfWithVault(doc, transferReceiptFilename(data, 'pdf'), {
    label: `Transfer receipt — ${data.item || 'Welile transfer'}`,
    category: 'other',
  });
}

export async function downloadTransferReceiptXlsx(data: TransferReceiptData): Promise<void> {
  await downloadXlsx(
    transferReceiptFilename(data, 'xlsx'),
    ['Item', 'Amount (UGX)', 'Date', 'Sender', 'Receiver', 'Reference', 'Payment channel'],
    [[
      data.item || 'Welile transfer',
      Math.round(data.amount),
      format(data.date, 'dd MMM yyyy, HH:mm'),
      data.sender || '',
      data.receiver || '',
      data.reference || '',
      data.method || '',
    ]],
    'Transfer receipt',
  );
}
