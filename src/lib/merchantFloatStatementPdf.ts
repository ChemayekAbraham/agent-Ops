import welileLogo from '@/assets/welile-logo.png';
import { formatUGX } from '@/lib/rentCalculations';
import { archivePdfBlob } from '@/lib/pdfVault';

export interface MerchantFloatStatementRow {
  date: string;
  category: string;
  label: string;
  description?: string | null;
  direction: 'cash_in' | 'cash_out';
  amount: number;
  runningBalance: number;
  /** True for admin/finance correction legs — badged, never hidden. */
  isCorrection?: boolean;
}

export interface MerchantFloatStatementInput {
  agentName: string;
  agentPhone?: string | null;
  totalIn: number;
  totalOut: number;
  balance: number;
  /** Float balance per the books (wallets.float_balance) for the tally line. */
  booksBalance?: number;
  /** Opening balance the running balance starts from. */
  openingBalance?: number;
  /** Optional period filter shown on the statement (yyyy-MM-dd). */
  periodFrom?: string | null;
  periodTo?: string | null;
  rows: MerchantFloatStatementRow[];
}

function fmtDateTime(iso: string) {
  return new Date(iso).toLocaleString('en-UG', {
    day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit',
  });
}

async function loadLogo(): Promise<string | null> {
  try {
    const res = await fetch(welileLogo);
    const blob = await res.blob();
    return await new Promise<string>((resolve, reject) => {
      const r = new FileReader();
      r.onloadend = () => resolve(r.result as string);
      r.onerror = reject;
      r.readAsDataURL(blob);
    });
  } catch {
    return null;
  }
}

/**
 * Branded, WhatsApp-friendly A4 portrait statement of one merchant agent's
 * company float movement (float sent in, float used, running balance).
 */
export async function generateMerchantFloatStatementPdf(
  input: MerchantFloatStatementInput,
): Promise<Blob> {
  const { jsPDF } = await import('jspdf');
  const pdf = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4', compress: true });
  const pw = pdf.internal.pageSize.getWidth();
  const ph = pdf.internal.pageSize.getHeight();
  const margin = 12;
  const logo = await loadLogo();

  const drawHeader = (pageNo: number) => {
    pdf.setFillColor(146, 52, 234);
    pdf.rect(0, 0, pw, 26, 'F');
    pdf.setFillColor(255, 255, 255);
    pdf.roundedRect(margin, 5, 16, 16, 2, 2, 'F');
    if (logo) {
      try { pdf.addImage(logo, 'PNG', margin + 1.5, 6.5, 13, 13, undefined, 'FAST'); } catch { /* ignore */ }
    }
    pdf.setTextColor(255, 255, 255);
    pdf.setFont('helvetica', 'bold');
    pdf.setFontSize(13);
    pdf.text('Merchant Float Statement', margin + 22, 13);
    pdf.setFont('helvetica', 'normal');
    pdf.setFontSize(8);
    pdf.text(
      `Generated ${new Date().toLocaleString('en-UG', { dateStyle: 'medium', timeStyle: 'short' })}`,
      margin + 22, 19,
    );
    pdf.text(`Page ${pageNo}`, pw - margin, 19, { align: 'right' });
  };

  const drawFooter = () => {
    pdf.setFontSize(8);
    pdf.setTextColor(120, 120, 120);
    pdf.text('welile.com  ·  Merchant float statement  ·  Confidential', pw / 2, ph - 6, { align: 'center' });
  };

  let pageNo = 1;
  drawHeader(pageNo);
  let y = 34;

  pdf.setTextColor(20, 20, 20);
  pdf.setFont('helvetica', 'bold');
  pdf.setFontSize(11);
  pdf.text(input.agentName, margin, y);
  if (input.agentPhone) {
    pdf.setFont('helvetica', 'normal');
    pdf.setFontSize(9);
    pdf.setTextColor(90, 90, 90);
    pdf.text(input.agentPhone, margin, y + 5);
  }
  y += 12;

  if (input.periodFrom || input.periodTo) {
    pdf.setFont('helvetica', 'bold');
    pdf.setFontSize(9);
    pdf.setTextColor(90, 90, 90);
    pdf.text(
      `Period: ${input.periodFrom || 'earliest'} to ${input.periodTo || 'today'}`,
      margin,
      y - 4,
    );
    y += 4;
  }

  // Headline card — float left
  pdf.setFillColor(245, 240, 255);
  pdf.roundedRect(margin, y, pw - margin * 2, 30, 3, 3, 'F');
  pdf.setTextColor(90, 90, 90);
  pdf.setFont('helvetica', 'bold');
  pdf.setFontSize(8);
  pdf.text('FLOAT LEFT WITH AGENT', margin + 5, y + 7);
  pdf.setTextColor(20, 20, 20);
  pdf.setFontSize(22);
  pdf.text(formatUGX(input.balance), margin + 5, y + 18);
  pdf.setFont('helvetica', 'normal');
  pdf.setFontSize(9);
  pdf.setTextColor(90, 90, 90);
  pdf.text('Company money this agent still holds', margin + 5, y + 25);
  y += 36;

  // Books tally line — statement close vs wallet books, corrections included.
  if (typeof input.booksBalance === 'number') {
    const variance = input.balance - input.booksBalance;
    pdf.setFont('helvetica', 'bold');
    pdf.setFontSize(9);
    if (Math.abs(variance) < 1) pdf.setTextColor(35, 130, 80);
    else pdf.setTextColor(170, 60, 60);
    pdf.text(
      Math.abs(variance) < 1
        ? `Tallies with the books: ${formatUGX(input.booksBalance)}`
        : `Books say ${formatUGX(input.booksBalance)} — variance ${formatUGX(variance)}`,
      margin,
      y,
    );
    y += 8;
  }

  if (typeof input.openingBalance === 'number' && Math.abs(input.openingBalance) >= 1) {
    pdf.setFont('helvetica', 'normal');
    pdf.setFontSize(8);
    pdf.setTextColor(110, 110, 110);
    pdf.text(
      `Opening balance before the first movement: ${formatUGX(input.openingBalance)} (anchored baseline from past float resets)`,
      margin,
      y,
    );
    y += 7;
  }

  // In / Out tiles
  const colW = (pw - margin * 2 - 4) / 2;
  pdf.setFillColor(232, 250, 240);
  pdf.roundedRect(margin, y, colW, 16, 2, 2, 'F');
  pdf.setFillColor(253, 235, 235);
  pdf.roundedRect(margin + colW + 4, y, colW, 16, 2, 2, 'F');
  pdf.setTextColor(40, 130, 90);
  pdf.setFont('helvetica', 'bold');
  pdf.setFontSize(8);
  pdf.text('FLOAT SENT IN', margin + 4, y + 6);
  pdf.setTextColor(20, 20, 20);
  pdf.setFontSize(12);
  pdf.text(formatUGX(input.totalIn), margin + 4, y + 13);
  pdf.setTextColor(170, 60, 60);
  pdf.setFontSize(8);
  pdf.text('FLOAT USED', margin + colW + 8, y + 6);
  pdf.setTextColor(20, 20, 20);
  pdf.setFontSize(12);
  pdf.text(formatUGX(input.totalOut), margin + colW + 8, y + 13);
  y += 22;

  pdf.setTextColor(60, 60, 60);
  pdf.setFont('helvetica', 'bold');
  pdf.setFontSize(10);
  pdf.text(`Movements (${input.rows.length})`, margin, y);
  y += 5;

  const ensure = (need: number) => {
    if (y + need > ph - 14) {
      drawFooter();
      pdf.addPage();
      pageNo += 1;
      drawHeader(pageNo);
      y = 32;
    }
  };

  if (input.rows.length === 0) {
    pdf.setFont('helvetica', 'italic');
    pdf.setFontSize(9);
    pdf.setTextColor(120, 120, 120);
    pdf.text('No float movement recorded for this agent yet.', margin, y + 5);
  } else {
    for (const r of input.rows) {
      const noteLines = r.description ? pdf.splitTextToSize(r.description, pw - margin * 2 - 40) : [];
      const rowH = 12 + noteLines.length * 3.5;
      ensure(rowH + 2);

      pdf.setDrawColor(230, 230, 230);
      pdf.line(margin, y, pw - margin, y);
      y += 4;

      pdf.setTextColor(20, 20, 20);
      pdf.setFont('helvetica', 'bold');
      pdf.setFontSize(10);
      pdf.text(r.isCorrection ? `[ADMIN CORRECTION] ${r.label}` : r.label, margin, y);

      if (r.direction === 'cash_in') pdf.setTextColor(35, 130, 80);
      else pdf.setTextColor(170, 60, 60);
      pdf.text(`${r.direction === 'cash_in' ? '+' : '-'}${formatUGX(r.amount)}`, pw - margin, y, { align: 'right' });

      y += 4;
      pdf.setFont('helvetica', 'normal');
      pdf.setFontSize(8);
      pdf.setTextColor(100, 100, 100);
      pdf.text(fmtDateTime(r.date), margin, y);
      pdf.text(`Balance ${formatUGX(r.runningBalance)}`, pw - margin, y, { align: 'right' });
      y += 3.5;

      if (noteLines.length) {
        pdf.setTextColor(130, 130, 130);
        pdf.text(noteLines, margin, y);
        y += noteLines.length * 3.5;
      }
      y += 2;
    }
  }

  drawFooter();
  const blob = pdf.output('blob');
  archivePdfBlob(blob, {
    label: `Float statement — ${input.agentName}`,
    filename: buildMerchantFloatStatementFilename(input.agentName, input.agentPhone),
    category: 'finops-report',
  }).catch(() => {});
  return blob;
}

export function buildMerchantFloatStatementFilename(
  name: string,
  phone?: string | null,
  period?: { from?: string | null; to?: string | null },
) {
  const slug = (name || phone || 'merchant').replace(/[^\w]+/g, '_').slice(0, 40);
  if (period && (period.from || period.to)) {
    return `Welile_Float_Statement_${slug}_${period.from || 'start'}_to_${period.to || new Date().toISOString().slice(0, 10)}.pdf`;
  }
  return `Welile_Float_Statement_${slug}_${new Date().toISOString().slice(0, 10)}.pdf`;
}

/** Native share sheet (WhatsApp on mobile), with download + wa.me fallback. */
export async function shareMerchantFloatStatementPdf(blob: Blob, filename: string, caption: string) {
  const file = new File([blob], filename, { type: 'application/pdf' });
  const nav = navigator as Navigator & { canShare?: (d: ShareData) => boolean };
  if (nav.canShare && nav.canShare({ files: [file] }) && navigator.share) {
    try {
      await navigator.share({ files: [file], title: filename, text: caption });
      return;
    } catch (err) {
      if ((err as DOMException)?.name === 'AbortError') return;
    }
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1500);
  window.open(`https://wa.me/?text=${encodeURIComponent(caption)}`, '_blank');
}
