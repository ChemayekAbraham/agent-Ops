/**
 * The black-and-white receipt copy: one data shape and one PDF builder for money in (partner receipts) and money out (payouts).
 * Mirrors the paper receipt book (Welile header, No., RECEIPT box, dotted lines, boxed Ugx amount, stamp, signature lines).
 * Display only: a copy is evidence of money already in the system; nothing here posts or moves money.
 * Pure black on white and grey, so it prints cleanly on a black-and-white printer or photocopier.
 *
 * Money out is built from the SAME data the public receipt page loads (get_payout_receipt_by_token), by copyFromPayoutReceipt in
 * payoutReceiptCopy.ts, so the recipient's copy, the merchant agent's copy and the company's archive copy are one document.
 * It never carries the merchant's commission (see receiptContentPolicy).
 */
import { format } from 'date-fns';
import { PAYOUT_RECEIPT_BASE_URL, type ArchiveRow } from '@/hooks/useReceiptArchive';
import { METHOD_LABEL, amountInWords, type PartnerReceiptRow } from '@/lib/partnerReceiptPdf';

export type ReceiptCopyStatus = 'issued' | 'voided' | 'corrected';

/** One dotted line of the receipt: a label, then the value sitting on the line. Five lines fit the paper layout. */
export interface ReceiptCopyLine { label: string; value: string }

export interface ReceiptCopyData {
  direction: 'in' | 'out';
  /** "4300" for a digital partner receipt, "WD261111-6EFB5B" or "RCPT-AB12CD34" for a payout receipt. */
  numberLabel: string;
  dateLabel: string;
  lines: ReceiptCopyLine[];
  amount: number;
  /** "10 NOV 2026", printed inside the stamp. */
  stampDate: string;
  /** Typed under "Authorised Signatory". Never a drawn signature. */
  signatory: string | null;
  clientSignatureLabel: string;
  status: ReceiptCopyStatus;
  replacedByNo: number | null;
  replacesEarlier: boolean;
  voidReason: string | null;
  verifyCode: string;
  qrText: string;
  /** Set on every copy printed or downloaded from the archive: it is a reprint, never the original. */
  reprintNote: string | null;
}

const methodLabel = (m: string) => (METHOD_LABEL as Record<string, string>)[m] ?? m;
const longDate = (iso: string) => format(new Date(iso.length === 10 ? `${iso}T00:00:00` : iso), 'dd MMM yyyy');

/** 0772123456 -> 0772 123 456. Anything that is not a 10-digit local number is shown as it was stored. */
export function prettyPhone(p: string | null): string {
  if (!p) return '';
  const d = p.replace(/\D/g, '');
  const local = d.startsWith('256') && d.length === 12 ? `0${d.slice(3)}` : d;
  return local.length === 10 ? `${local.slice(0, 4)} ${local.slice(4, 7)} ${local.slice(7)}` : p;
}

export function reprintNote(by: string | null, now = new Date()): string {
  return `Reprint printed ${format(now, 'dd MMM yyyy HH:mm')}${by ? ` by ${by}` : ''}. Not the original.`;
}

export function copyFromPartnerRow(r: PartnerReceiptRow, replacedByNo: number | null, reprint: string | null): ReceiptCopyData {
  const isInstrument = r.payment_method === 'cheque' || r.payment_method === 'bank_draft';
  const by = [
    `${methodLabel(r.payment_method)}${isInstrument && r.instrument_no ? ` no. ${r.instrument_no}` : ''}`,
    `Dated: ${longDate(r.received_on)}`,
    `Drawn on: ${r.drawn_on || '-'}`,
  ].join('     ');
  return {
    direction: 'in',
    numberLabel: String(r.receipt_no),
    dateLabel: longDate(r.received_on),
    lines: [
      { label: 'Received with thanks from:', value: r.received_from },
      { label: 'A sum of Shillings:', value: amountInWords(r.amount) },
      { label: 'By Cash/Cheque/Draft no:', value: by },
      { label: 'Branch:', value: r.branch },
      { label: 'Purpose:', value: r.purpose },
    ],
    amount: r.amount,
    stampDate: format(new Date(`${r.received_on}T00:00:00`), 'dd MMM yyyy').toUpperCase(),
    signatory: r.issued_by_name,
    clientSignatureLabel: 'Signature of Client',
    status: r.status === 'issued' ? 'issued' : r.superseded_by_id ? 'corrected' : 'voided',
    replacedByNo,
    replacesEarlier: !!r.supersedes_id,
    voidReason: r.void_reason,
    verifyCode: r.verify_token,
    // There is no public verify page for partner receipts yet, so the QR carries the codes as text.
    qrText: `WELILE RECEIPT ${r.receipt_no} | ${r.receipt_code} | verify ${r.verify_token}`,
    reprintNote: reprint,
  };
}

/** Fallback for a payout row when the full receipt cannot be loaded: only what the archive list itself carries. */
export function copyFromPayoutRow(r: ArchiveRow, reference: string | null, reprint: string | null): ReceiptCopyData {
  const token = r.link_token ?? '';
  return {
    direction: 'out',
    numberLabel: r.receipt_ref,
    dateLabel: longDate(r.event_at),
    lines: [
      { label: 'Paid to:', value: r.client_name ?? '' },
      { label: 'A sum of Shillings:', value: amountInWords(r.amount) },
      { label: 'Paid by:', value: `${methodLabel(r.method)}${r.client_phone ? `, ${prettyPhone(r.client_phone)}` : ''}` },
      { label: 'Purpose:', value: r.purpose },
      { label: 'Reference:', value: reference ?? '' },
    ],
    amount: r.amount,
    stampDate: format(new Date(r.event_at), 'dd MMM yyyy').toUpperCase(),
    signatory: null,
    clientSignatureLabel: "Recipient's signature",
    status: r.status,
    replacedByNo: r.replaced_by_no,
    replacesEarlier: false,
    voidReason: null,
    verifyCode: token.slice(0, 8).toUpperCase(),
    qrText: token ? `${PAYOUT_RECEIPT_BASE_URL}${token}` : `WELILE PAYOUT ${r.receipt_ref}`,
    reprintNote: reprint,
  };
}

const GREY = 110;

/** The Welile wordmark on the paper receipts is set in Chewy. The app already loads Google Fonts, so Chewy is loaded the same way. */
export const WORDMARK_FONT = "'Chewy', 'Arial Rounded MT Bold', Helvetica, Arial, sans-serif";
const CHEWY_CSS = 'https://fonts.googleapis.com/css2?family=Chewy&display=swap';

/** Adds the Chewy stylesheet once and waits for the font. Resolves false (never throws) when it cannot load. */
export async function ensureChewy(): Promise<boolean> {
  if (typeof document === 'undefined') return false;
  try {
    if (!document.querySelector('link[data-welile-chewy]')) {
      const link = document.createElement('link');
      link.rel = 'stylesheet'; link.href = CHEWY_CSS; link.setAttribute('data-welile-chewy', '1');
      document.head.appendChild(link);
    }
    await document.fonts.load('100px Chewy', 'Welile');
    return document.fonts.check('100px Chewy');
  } catch {
    return false;
  }
}

/** "Welile" drawn in Chewy as a PNG (black on transparent), for the PDF. Null when Chewy is unavailable. */
async function wordmarkPng(): Promise<{ url: string; ratio: number } | null> {
  if (!(await ensureChewy())) return null;
  const size = 220;
  const probe = document.createElement('canvas').getContext('2d');
  if (!probe) return null;
  probe.font = `${size}px Chewy`;
  const w = Math.ceil(probe.measureText('Welile').width) + 8;
  const h = Math.ceil(size * 1.25);
  const canvas = document.createElement('canvas');
  canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  ctx.font = `${size}px Chewy`; ctx.fillStyle = '#000000'; ctx.textBaseline = 'alphabetic';
  ctx.fillText('Welile', 4, Math.round(size * 0.95));
  return { url: canvas.toDataURL('image/png'), ratio: w / h };
}

/** Builds the receipt copy PDF: A5 landscape, the size of one receipt in the paper book (two per A4 sheet). */
export async function buildReceiptCopyPdf(d: ReceiptCopyData) {
  const [{ jsPDF }, QRCode] = await Promise.all([import('jspdf'), import('qrcode')]);
  const doc = new jsPDF({ unit: 'mm', format: 'a5', orientation: 'landscape' });
  const W = doc.internal.pageSize.getWidth();
  const H = doc.internal.pageSize.getHeight();
  const M = 12;
  const dead = d.status !== 'issued';
  doc.setTextColor(0, 0, 0); doc.setDrawColor(0, 0, 0);

  // Header
  const mark = await wordmarkPng();
  if (mark) {
    const mh = 17; const mw = mh * mark.ratio;
    doc.addImage(mark.url, 'PNG', M, 8.5, mw, mh);
    doc.setFont('helvetica', 'bold'); doc.setFontSize(5); doc.text('TM', M + mw + 0.5, 12);
  } else {
    doc.setFont('helvetica', 'bold'); doc.setFontSize(28); doc.text('Welile', M, 23);
    doc.setFontSize(5); doc.text('TM', M + 41, 15);
  }
  doc.setFont('helvetica', 'bold'); doc.setFontSize(7); doc.text('WELILE TECHNOLOGIES (U) LIMITED', W - M, 12, { align: 'right' });
  doc.setFont('helvetica', 'normal');
  doc.text('P.O Box 167564, Kampala - Uganda', W - M, 16, { align: 'right' });
  doc.text('Email: info@welile.com', W - M, 20, { align: 'right' });
  doc.text('Tel: +256 764 379 713, +256 744 475 573', W - M, 24, { align: 'right' });
  doc.setLineWidth(0.4); doc.line(M, 28, W - M, 28);

  // No. / RECEIPT / Date
  doc.setFontSize(9);
  doc.text('No:', M, 38); doc.setFont('helvetica', 'bold'); doc.setFontSize(11); doc.text(d.numberLabel, M + 8, 38);
  doc.setLineWidth(0.6); doc.rect(W / 2 - 20, 31.5, 40, 9.5);
  doc.setFontSize(13); doc.text('RECEIPT', W / 2, 38.2, { align: 'center' });
  doc.setFont('helvetica', 'normal'); doc.setFontSize(9);
  doc.text('Date:', W - M - 44, 38); doc.setFont('helvetica', 'bold'); doc.text(d.dateLabel, W - M, 38, { align: 'right' });

  // Dotted lines: label, then the value sitting on a dotted underline
  let y = 51;
  for (const l of d.lines) {
    doc.setFont('helvetica', 'normal'); doc.setFontSize(9);
    doc.text(l.label, M, y);
    const x = M + doc.getTextWidth(l.label) + 2;
    doc.setLineWidth(0.2); doc.setLineDashPattern([0.6, 0.8], 0); doc.line(x, y + 1, W - M, y + 1); doc.setLineDashPattern([], 0);
    doc.setFont('helvetica', 'bold');
    const wrapped = doc.splitTextToSize(l.value || '', W - M - x - 2) as string[];
    doc.text(wrapped[0] ?? '', x + 1.5, y - 0.4);
    y += 9;
  }

  // Boxed amount
  const boxY = y + 3;
  doc.setLineWidth(0.6); doc.roundedRect(M, boxY, 58, 11, 2.5, 2.5);
  doc.setFont('helvetica', 'bold'); doc.setFontSize(12.5);
  doc.text(`Ugx. ${Math.round(d.amount).toLocaleString('en-US')}/=`, M + 4, boxY + 7.6);

  // Stamp: grey outline, the company stamp for a black-and-white copy
  doc.setDrawColor(GREY, GREY, GREY); doc.setTextColor(GREY, GREY, GREY); doc.setLineWidth(0.5);
  doc.roundedRect(W / 2 - 4, boxY - 4, 50, 22, 3, 3);
  doc.setFont('helvetica', 'bold'); doc.setFontSize(6.5);
  doc.text('WELILE TECHNOLOGIES', W / 2 + 21, boxY + 2, { align: 'center' });
  doc.text('LIMITED', W / 2 + 21, boxY + 5.5, { align: 'center' });
  doc.setFont('helvetica', 'normal'); doc.setFontSize(5.5);
  doc.text('P.O Box 167564 Kampala Uganda', W / 2 + 21, boxY + 9, { align: 'center' });
  doc.setFont('helvetica', 'bold'); doc.setFontSize(8); doc.text(d.stampDate, W / 2 + 21, boxY + 14.5, { align: 'center' });
  doc.setTextColor(0, 0, 0); doc.setDrawColor(0, 0, 0);

  // Authorised signatory (right) and client signature (left)
  doc.setFont('helvetica', 'bold'); doc.setFontSize(8);
  doc.text('For Welile Technologies Limited.', W - M, boxY + 1, { align: 'right' });
  const sigY = boxY + 15;
  doc.setLineWidth(0.3); doc.setLineDashPattern([0.6, 0.8], 0);
  doc.line(W - M - 52, sigY, W - M, sigY); doc.line(M, sigY, M + 58, sigY); doc.setLineDashPattern([], 0);
  doc.setFont('helvetica', 'normal'); doc.setFontSize(7);
  doc.text(d.signatory ? `${d.signatory} (Authorised Signatory)` : '(Authorised Signatory)', W - M, sigY + 3.5, { align: 'right' });
  doc.text(d.clientSignatureLabel, M, sigY + 3.5);
  if (d.direction === 'in') {
    doc.setFontSize(6); doc.text('(Cheques/Drafts are subject to rectification)', M, sigY + 6.8);
  }

  // Footer: QR and codes
  const qr = await QRCode.toDataURL(d.qrText, { margin: 0, width: 240, color: { dark: '#000000', light: '#ffffff' } });
  doc.addImage(qr, 'PNG', W - M - 15, H - 21, 15, 15);
  doc.setFont('helvetica', 'normal'); doc.setFontSize(6);
  doc.text(`Verify code: ${d.verifyCode}`, W - M - 17, H - 14, { align: 'right' });
  doc.text('Digitally recorded copy. Internal payment acknowledgement, not a URA fiscal receipt.', W - M - 17, H - 10.5, { align: 'right' });
  if (d.reprintNote) { doc.setFont('helvetica', 'bold'); doc.text(d.reprintNote, M, H - 6); }

  // VOID / corrected: large grey diagonal mark. A voided receipt must never read as valid.
  if (dead) {
    doc.setTextColor(165, 165, 165); doc.setFont('helvetica', 'bold'); doc.setFontSize(64);
    doc.text(d.status === 'corrected' ? 'CORRECTED' : 'VOID', W / 2, H / 2 + 14, { align: 'center', angle: 18 });
    doc.setTextColor(0, 0, 0); doc.setFontSize(8);
    const why = d.status === 'corrected' && d.replacedByNo != null ? `Replaced by No. ${d.replacedByNo}` : d.voidReason ?? '';
    if (why) doc.text(why, W / 2, H - 16, { align: 'center' });
  } else if (d.replacesEarlier) {
    doc.setFont('helvetica', 'normal'); doc.setFontSize(7); doc.text('Replaces an earlier receipt.', M, H - 10.5);
  }
  return doc;
}

export const copyFileName = (d: ReceiptCopyData) => `Welile-receipt-${d.numberLabel}.pdf`;

export async function downloadReceiptCopy(d: ReceiptCopyData) {
  (await buildReceiptCopyPdf(d)).save(copyFileName(d));
}

/** Opens the PDF in a new tab with the print dialog ready. The window is opened first so the click is not treated as a popup. */
export async function printReceiptCopy(d: ReceiptCopyData): Promise<boolean> {
  const w = window.open('', '_blank');
  if (!w) return false;
  try {
    const doc = await buildReceiptCopyPdf(d);
    doc.autoPrint();
    w.location.href = doc.output('bloburl') as unknown as string;
    return true;
  } catch (e) {
    w.close();
    throw e;
  }
}
