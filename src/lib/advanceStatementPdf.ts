import welileLogo from '@/assets/welile-logo.png';
import { formatDynamic as fmtUGX } from '@/lib/currencyFormat';

export interface AdvanceStatementRow {
  principal: number;
  outstanding_balance: number;
  status: string;
  issued_at?: string | null;
  expires_at?: string | null;
  created_at?: string | null;
  daily_deduction: number;
  days_left: number;
  access_fee: number;
}

export interface AdvanceStatementInput {
  ownerName: string;
  ownerPhone?: string | null;
  totalOutstanding: number;
  rows: AdvanceStatementRow[];
  periodLabel?: string;
}

const STATUS_LABEL: Record<string, string> = {
  active: 'Active',
  outstanding: 'Outstanding',
  approved: 'Approved',
  disbursed: 'Disbursed',
  overdue: 'Overdue',
  completed: 'Completed',
};

function statusLabel(s: string) {
  return STATUS_LABEL[s] || (s ? s.charAt(0).toUpperCase() + s.slice(1) : '—');
}

function fmtDate(iso?: string | null) {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString('en-UG', { day: '2-digit', month: 'short', year: 'numeric' });
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
 * Generate an advance statement PDF for an agent — one card per advance with
 * principal, outstanding, daily deduction, days left, access fee and dates.
 * Portrait A4, mobile-friendly, shareable on WhatsApp.
 */
export async function generateAdvanceStatementPdf(input: AdvanceStatementInput): Promise<Blob> {
  const { jsPDF } = await import('jspdf');
  const pdf = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4', compress: true });
  const pw = pdf.internal.pageSize.getWidth();
  const ph = pdf.internal.pageSize.getHeight();
  const margin = 12;
  const logo = await loadLogo();

  let pageNo = 1;
  const drawHeader = (no: number) => {
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
    pdf.text('Welile Advance Statement', margin + 22, 13);
    pdf.setFont('helvetica', 'normal');
    pdf.setFontSize(8);
    pdf.text(
      `Generated ${new Date().toLocaleString('en-UG', { dateStyle: 'medium', timeStyle: 'short' })}`,
      margin + 22, 19,
    );
    pdf.setFontSize(8);
    pdf.text(`Page ${no}`, pw - margin, 19, { align: 'right' });
  };

  const drawFooter = () => {
    pdf.setFontSize(8);
    pdf.setTextColor(120, 120, 120);
    pdf.text('welile.com  ·  Advance statement  ·  Confidential', pw / 2, ph - 6, { align: 'center' });
  };

  drawHeader(pageNo);
  let y = 34;

  // Owner block
  pdf.setTextColor(20, 20, 20);
  pdf.setFont('helvetica', 'bold');
  pdf.setFontSize(11);
  pdf.text(input.ownerName, margin, y);
  if (input.ownerPhone) {
    pdf.setFont('helvetica', 'normal');
    pdf.setFontSize(9);
    pdf.setTextColor(90, 90, 90);
    pdf.text(input.ownerPhone, margin, y + 5);
  }
  if (input.periodLabel) {
    pdf.setFont('helvetica', 'italic');
    pdf.setFontSize(9);
    pdf.setTextColor(100, 100, 100);
    pdf.text(input.periodLabel, margin, y + (input.ownerPhone ? 10 : 5));
    y += (input.ownerPhone ? 15 : 10);
  } else {
    y += 12;
  }

  // Headline card
  pdf.setFillColor(255, 247, 237);
  pdf.roundedRect(margin, y, pw - margin * 2, 26, 3, 3, 'F');
  pdf.setTextColor(90, 90, 90);
  pdf.setFont('helvetica', 'bold');
  pdf.setFontSize(8);
  pdf.text('TOTAL OUTSTANDING', margin + 5, y + 7);
  pdf.setTextColor(180, 83, 9);
  pdf.setFontSize(20);
  pdf.text(fmtUGX(input.totalOutstanding), margin + 5, y + 17);
  pdf.setFont('helvetica', 'normal');
  pdf.setFontSize(9);
  pdf.setTextColor(90, 90, 90);
  pdf.text(`${input.rows.length} advance${input.rows.length === 1 ? '' : 's'} on file`, margin + 5, y + 23);
  y += 32;

  // Advances heading
  pdf.setTextColor(60, 60, 60);
  pdf.setFont('helvetica', 'bold');
  pdf.setFontSize(10);
  pdf.text(`Advances (${input.rows.length})`, margin, y);
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
    pdf.text('No advances on file.', margin, y + 5);
  } else {
    for (const r of input.rows) {
      ensure(26);
      pdf.setDrawColor(230, 230, 230);
      pdf.line(margin, y, pw - margin, y);
      y += 5;

      pdf.setTextColor(20, 20, 20);
      pdf.setFont('helvetica', 'bold');
      pdf.setFontSize(11);
      pdf.text(fmtUGX(r.principal), margin, y);
      pdf.setFont('helvetica', 'normal');
      pdf.setFontSize(9);
      pdf.setTextColor(110, 110, 110);
      pdf.text(statusLabel(r.status), pw - margin, y, { align: 'right' });
      y += 5;

      pdf.setFontSize(8);
      pdf.setTextColor(70, 70, 70);
      const owed = `Owed: ${fmtUGX(r.outstanding_balance)}`;
      const daily = r.status === 'completed' ? 'Daily: —' : `Daily: ${fmtUGX(r.daily_deduction)}`;
      const days = r.status === 'completed' ? 'Days left: —' : `Days left: ${r.days_left}d`;
      pdf.text(`${owed}    ${daily}    ${days}`, margin, y);
      y += 4;

      pdf.setTextColor(120, 120, 120);
      const issued = `Issued ${fmtDate(r.issued_at || r.created_at)}`;
      const fee = r.access_fee > 0 && r.status !== 'completed' ? `    Incl. ${fmtUGX(r.access_fee)} access fee` : '';
      pdf.text(`${issued}${fee}`, margin, y);
      y += 5;
    }
  }

  drawFooter();
  return pdf.output('blob');
}
