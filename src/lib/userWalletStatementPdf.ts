import welileLogo from '@/assets/welile-logo.png';
import { formatUGX } from '@/lib/rentCalculations';
import { archivePdfBlob } from '@/lib/pdfVault';

export interface UserWalletStatementRow {
  date: string;
  bucket: 'withdrawable' | 'float';
  label: string;
  description?: string | null;
  direction: 'cash_in' | 'cash_out';
  amount: number;
}

export interface UserWalletStatementInput {
  userName: string;
  userPhone?: string | null;
  withdrawableBalance: number;
  floatBalance: number;
  /** Optional period filter shown on the statement (yyyy-MM-dd). */
  periodFrom?: string | null;
  periodTo?: string | null;
  rows: UserWalletStatementRow[];
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
 * Branded, printable A4 portrait mini-statement of one user's wallet — both
 * the withdrawable balance and operational float, side by side, plus every
 * movement across both buckets in the selected period. Used by Financial Ops
 * / managers to trace a person's history regardless of their current balance.
 */
export async function generateUserWalletStatementPdf(
  input: UserWalletStatementInput,
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
    pdf.text('Wallet Mini-Statement', margin + 22, 13);
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
    pdf.text('welile.com  ·  Wallet mini-statement  ·  Confidential', pw / 2, ph - 6, { align: 'center' });
  };

  let pageNo = 1;
  drawHeader(pageNo);
  let y = 34;

  pdf.setTextColor(20, 20, 20);
  pdf.setFont('helvetica', 'bold');
  pdf.setFontSize(11);
  pdf.text(input.userName, margin, y);
  if (input.userPhone) {
    pdf.setFont('helvetica', 'normal');
    pdf.setFontSize(9);
    pdf.setTextColor(90, 90, 90);
    pdf.text(input.userPhone, margin, y + 5);
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

  // Current balance cards — withdrawable + float, side by side.
  const colW = (pw - margin * 2 - 4) / 2;
  pdf.setFillColor(232, 250, 240);
  pdf.roundedRect(margin, y, colW, 26, 3, 3, 'F');
  pdf.setFillColor(235, 244, 253);
  pdf.roundedRect(margin + colW + 4, y, colW, 26, 3, 3, 'F');
  pdf.setTextColor(40, 130, 90);
  pdf.setFont('helvetica', 'bold');
  pdf.setFontSize(8);
  pdf.text('WITHDRAWABLE BALANCE', margin + 5, y + 8);
  pdf.setTextColor(20, 20, 20);
  pdf.setFontSize(15);
  pdf.text(formatUGX(input.withdrawableBalance), margin + 5, y + 18);
  pdf.setTextColor(30, 110, 190);
  pdf.setFont('helvetica', 'bold');
  pdf.setFontSize(8);
  pdf.text('OPERATIONAL FLOAT', margin + colW + 9, y + 8);
  pdf.setTextColor(20, 20, 20);
  pdf.setFontSize(15);
  pdf.text(formatUGX(input.floatBalance), margin + colW + 9, y + 18);
  y += 34;

  const totalIn = input.rows.filter((r) => r.direction === 'cash_in').reduce((s, r) => s + r.amount, 0);
  const totalOut = input.rows.filter((r) => r.direction === 'cash_out').reduce((s, r) => s + r.amount, 0);

  pdf.setFillColor(245, 245, 245);
  pdf.roundedRect(margin, y, pw - margin * 2, 14, 2, 2, 'F');
  pdf.setTextColor(40, 130, 90);
  pdf.setFont('helvetica', 'bold');
  pdf.setFontSize(9);
  pdf.text(`Money in: ${formatUGX(totalIn)}`, margin + 4, y + 9);
  pdf.setTextColor(170, 60, 60);
  pdf.text(`Money out: ${formatUGX(totalOut)}`, margin + (pw - margin * 2) / 2 + 4, y + 9);
  y += 20;

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
    pdf.text('No wallet activity recorded for this person in this period.', margin, y + 5);
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
      pdf.text(r.label, margin, y);

      if (r.direction === 'cash_in') pdf.setTextColor(35, 130, 80);
      else pdf.setTextColor(170, 60, 60);
      pdf.text(`${r.direction === 'cash_in' ? '+' : '-'}${formatUGX(r.amount)}`, pw - margin, y, { align: 'right' });

      y += 4;
      pdf.setFont('helvetica', 'normal');
      pdf.setFontSize(8);
      pdf.setTextColor(100, 100, 100);
      pdf.text(fmtDateTime(r.date), margin, y);
      pdf.text(r.bucket === 'float' ? 'Operational float' : 'Withdrawable', pw - margin, y, { align: 'right' });
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
    label: `Wallet mini-statement — ${input.userName}`,
    filename: buildUserWalletStatementFilename(input.userName, input.userPhone),
    category: 'finops-report',
  }).catch(() => {});
  return blob;
}

export function buildUserWalletStatementFilename(
  name: string,
  phone?: string | null,
  period?: { from?: string | null; to?: string | null },
) {
  const slug = (name || phone || 'user').replace(/[^\w]+/g, '_').slice(0, 40);
  if (period && (period.from || period.to)) {
    return `Welile_Wallet_Statement_${slug}_${period.from || 'start'}_to_${period.to || new Date().toISOString().slice(0, 10)}.pdf`;
  }
  return `Welile_Wallet_Statement_${slug}_${new Date().toISOString().slice(0, 10)}.pdf`;
}
