// Generates a single-page PDF receipt for a Welile Smartphone order.
// Uses jsPDF dynamically to keep it out of the initial bundle. Mirrors the
// house style of withdrawalReceiptPdf.ts (helvetica, UGX ISO code, vault archive).
import { format } from 'date-fns';
import { savePdfWithVault } from '@/lib/pdfVault';

export type SmartphoneOrderStatus =
  | 'submitted'
  | 'pending_approval'
  | 'coo_approved'
  | 'approved'
  | 'rejected'
  | 'processing'
  | 'completed'
  | 'failed';

const STATUS_LABELS: Record<SmartphoneOrderStatus, string> = {
  submitted: 'Submitted',
  pending_approval: 'Pending approval',
  coo_approved: 'Approved — awaiting disbursement',
  approved: 'Approved',
  rejected: 'Rejected',
  processing: 'Processing',
  completed: 'Completed',
  failed: 'Failed',
};



export interface SmartphoneOrderReceiptData {
  /** Order id (used as the receipt reference). */
  orderId: string;
  /** Amount the agent chose to have recovered from their wallet, in UGX. */
  amount: number;
  /** Amount still to be recovered from the wallet, in UGX. */
  outstanding: number;
  status: SmartphoneOrderStatus;
  /** When the order was placed. */
  orderedAt: Date;
  /** Agent name, when known. */
  customerName?: string | null;
  /** Agent phone, when known. */
  customerPhone?: string | null;
  /** Item label, e.g. 'Welile Smartphone' or 'Welile Spiro Bike'. */
  itemLabel?: string;
  /** Optional tracking reference (e.g. Spiro bike orders). */
  trackingReference?: string | null;
}

const CURRENCY = 'UGX';
const DEFAULT_ITEM = 'Welile Smartphone';

function ugx(amount: number): string {
  return `${CURRENCY} ${Math.round(amount).toLocaleString()}`;
}

function safeRef(orderId: string): string {
  return (orderId || 'order').replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 12);
}

export function smartphoneOrderReceiptFilename(data: SmartphoneOrderReceiptData): string {
  const slug = (data.itemLabel ?? DEFAULT_ITEM).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  return `${slug || 'welile_order'}_${safeRef(data.orderId)}.pdf`;
}

async function renderReceipt(data: SmartphoneOrderReceiptData) {
  const itemLabel = data.itemLabel ?? DEFAULT_ITEM;
  const { default: JsPDF } = await import('jspdf');
  const doc = new JsPDF({ unit: 'pt', format: 'a4' });

  const pageWidth = doc.internal.pageSize.getWidth();
  const marginX = 48;
  let y = 64;

  // Header
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(20);
  doc.text('Order Receipt', marginX, y);

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(10);
  doc.setTextColor(120);
  y += 18;
  doc.text(`Welile — ${itemLabel}`, marginX, y);
  doc.setTextColor(0);

  // Amount block
  y += 36;
  doc.setDrawColor(220);
  doc.setFillColor(245, 247, 250);
  doc.roundedRect(marginX, y, pageWidth - marginX * 2, 70, 8, 8, 'F');
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(10);
  doc.setTextColor(110);
  doc.text('Amount to recover from wallet', marginX + 16, y + 22);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(22);
  doc.setTextColor(20);
  doc.text(ugx(data.amount), marginX + 16, y + 52);
  y += 70;

  // Details
  const rows: Array<[string, string]> = [
    ['Item', itemLabel],
    ['Reference', data.orderId],
    ...(data.trackingReference ? [['Tracking reference', data.trackingReference] as [string, string]] : []),
    ['Order status', STATUS_LABELS[data.status] ?? 'Submitted'],
    ['Amount ordered', ugx(data.amount)],
    ['Amount outstanding', data.outstanding > 0 ? ugx(data.outstanding) : `${CURRENCY} 0 (fully recovered)`],
    ['Ordered on', format(data.orderedAt, 'MMM d, yyyy HH:mm')],
    ['Receipt generated', format(new Date(), 'MMM d, yyyy HH:mm')],
    ['Ordered by', data.customerName || '—'],
    ['Phone', data.customerPhone || '—'],
  ];

  y += 30;
  doc.setFontSize(11);
  rows.forEach(([label, value]) => {
    doc.setTextColor(110);
    doc.setFont('helvetica', 'normal');
    doc.text(label, marginX, y);
    doc.setTextColor(20);
    doc.setFont('helvetica', 'bold');
    const valueLines = doc.splitTextToSize(String(value ?? '-'), pageWidth - marginX * 2 - 150);
    doc.text(valueLines, marginX + 150, y);
    y += 16 * Math.max(1, valueLines.length) + 6;
    doc.setDrawColor(235);
    doc.line(marginX, y - 4, pageWidth - marginX, y - 4);
  });

  // Footer
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(9);
  doc.setTextColor(140);
  doc.text(
    `This receipt confirms your ${itemLabel} order. The final price is set by marketing; the amount above is recovered from your withdrawable wallet over time.`,
    marginX,
    doc.internal.pageSize.getHeight() - 48,
    { maxWidth: pageWidth - marginX * 2 },
  );

  return doc;
}

/** Build the PDF in-memory and return a Blob (used for sharing / emailing). */
export async function buildSmartphoneOrderReceiptBlob(data: SmartphoneOrderReceiptData): Promise<Blob> {
  const doc = await renderReceipt(data);
  return doc.output('blob') as Blob;
}

export async function downloadSmartphoneOrderReceipt(data: SmartphoneOrderReceiptData): Promise<void> {
  const doc = await renderReceipt(data);
  savePdfWithVault(doc, smartphoneOrderReceiptFilename(data), {
    label: `${data.itemLabel ?? DEFAULT_ITEM} Receipt · ${ugx(data.amount)}`,
    category: 'merchandise-receipt',
  });
}

/**
 * Share the receipt via the device share sheet (Web Share Level 2).
 * Returns `true` when the sheet opened (or sharing completed), `false`
 * when the platform cannot share files — caller should fall back to download.
 */
export async function shareSmartphoneOrderReceipt(data: SmartphoneOrderReceiptData): Promise<boolean> {
  const nav: any = typeof navigator !== 'undefined' ? navigator : null;
  const blob = await buildSmartphoneOrderReceiptBlob(data);
  const filename = smartphoneOrderReceiptFilename(data);

  if (nav && typeof nav.canShare === 'function' && typeof nav.share === 'function') {
    try {
      const file = new File([blob], filename, { type: 'application/pdf' });
      const payload = {
        files: [file],
        title: 'Order Receipt',
        text: `${data.itemLabel ?? DEFAULT_ITEM} order ${data.orderId} — ${ugx(data.amount)}`,
      };
      if (nav.canShare(payload)) {
        await nav.share(payload);
        return true;
      }
    } catch (e: any) {
      if (e?.name === 'AbortError') return true;
      console.warn('[smartphoneOrderReceiptPdf] share failed', e);
    }
  }
  return false;
}