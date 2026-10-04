import welileLogo from '@/assets/welile-logo.png';
import { formatUGX } from '@/lib/rentCalculations';
import { archivePdfBlob } from '@/lib/pdfVault';

/**
 * Branded settlement schedule of money the company owes merchant agents.
 *
 * Only CONFIRMED, unreimbursed out-of-pocket advances appear in the payable
 * total — unconfirmed shortfalls are printed in a clearly separated section and
 * excluded from every figure Finance would pay against.
 */
export interface MerchantDebtPdfLine {
  createdAt: string;
  kind: string;
  payoutAmount: number;
  floatUsed: number;
  amount: number;
  withdrawalId: string | null;
  note: string | null;
}

export interface MerchantDebtPdfAgent {
  agentName: string;
  agentPhone: string | null;
  payable: number;
  underReview: number;
  lines: MerchantDebtPdfLine[];
}

export interface MerchantDebtPdfInput {
  agents: MerchantDebtPdfAgent[];
  payableTotal: number;
  underReviewTotal: number;
}

function fmtDate(iso: string) {
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

export function buildMerchantDebtSettlementFilename(count: number) {
  return `Welile_Merchant_Settlement_Schedule_${count}_agents_${new Date().toISOString().slice(0, 10)}.pdf`;
}

export async function generateMerchantDebtSettlementPdf(input: MerchantDebtPdfInput): Promise<Blob> {
  const { jsPDF } = await import('jspdf');
  const pdf = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4', compress: true });
  const pw = pdf.internal.pageSize.getWidth();
  const ph = pdf.internal.pageSize.getHeight();
  const margin = 12;
  const logo = await loadLogo();
  let pageNo = 1;

  const drawHeader = (n: number) => {
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
    pdf.text('Merchant Agent Settlement Schedule', margin + 22, 13);
    pdf.setFont('helvetica', 'normal');
    pdf.setFontSize(8);
    pdf.text(
      `Generated ${new Date().toLocaleString('en-UG', { dateStyle: 'medium', timeStyle: 'short' })}`,
      margin + 22, 19,
    );
    pdf.text(`Page ${n}`, pw - margin, 19, { align: 'right' });
  };

  const drawFooter = () => {
    pdf.setFontSize(8);
    pdf.setTextColor(120, 120, 120);
    pdf.text(
      'welile.com  ·  Confirmed out-of-pocket advances only  ·  Confidential',
      pw / 2, ph - 6, { align: 'center' },
    );
  };

  drawHeader(pageNo);
  let y = 34;
  const ensure = (need: number) => {
    if (y + need > ph - 14) {
      drawFooter();
      pdf.addPage();
      pageNo += 1;
      drawHeader(pageNo);
      y = 32;
    }
  };

  // Headline payable card
  pdf.setFillColor(245, 240, 255);
  pdf.roundedRect(margin, y, pw - margin * 2, 32, 3, 3, 'F');
  pdf.setTextColor(90, 90, 90);
  pdf.setFont('helvetica', 'bold');
  pdf.setFontSize(8);
  pdf.text('TOTAL TO SETTLE NOW', margin + 5, y + 7);
  pdf.setTextColor(20, 20, 20);
  pdf.setFontSize(22);
  pdf.text(formatUGX(input.payableTotal), margin + 5, y + 18);
  pdf.setFont('helvetica', 'normal');
  pdf.setFontSize(8);
  pdf.setTextColor(90, 90, 90);
  pdf.text(
    `${input.agents.length} agent${input.agents.length === 1 ? '' : 's'} selected · confirmed own-money advances not yet refunded`,
    margin + 5, y + 25,
  );
  pdf.text(
    `Excluded from this total: ${formatUGX(input.underReviewTotal)} the books do not support`,
    margin + 5, y + 29.5,
  );
  y += 40;

  for (const a of input.agents) {
    ensure(26);
    pdf.setDrawColor(210, 200, 240);
    pdf.setFillColor(250, 248, 255);
    pdf.roundedRect(margin, y, pw - margin * 2, 14, 2, 2, 'FD');
    pdf.setTextColor(20, 20, 20);
    pdf.setFont('helvetica', 'bold');
    pdf.setFontSize(10.5);
    pdf.text(a.agentName, margin + 4, y + 6);
    pdf.setFont('helvetica', 'normal');
    pdf.setFontSize(8);
    pdf.setTextColor(100, 100, 100);
    pdf.text(a.agentPhone || '—', margin + 4, y + 11);
    pdf.setFont('helvetica', 'bold');
    pdf.setFontSize(12);
    pdf.setTextColor(146, 52, 234);
    pdf.text(formatUGX(a.payable), pw - margin - 4, y + 7, { align: 'right' });
    if (a.underReview > 0) {
      pdf.setFont('helvetica', 'normal');
      pdf.setFontSize(7.5);
      pdf.setTextColor(150, 90, 60);
      pdf.text(`${formatUGX(a.underReview)} under review (not paid)`, pw - margin - 4, y + 11.5, { align: 'right' });
    }
    y += 18;

    // Column head
    ensure(10);
    pdf.setFont('helvetica', 'bold');
    pdf.setFontSize(7.5);
    pdf.setTextColor(120, 120, 120);
    pdf.text('DATE', margin + 1, y);
    pdf.text('WHAT HAPPENED', margin + 34, y);
    pdf.text('PAYOUT', pw - margin - 62, y, { align: 'right' });
    pdf.text('FLOAT USED', pw - margin - 30, y, { align: 'right' });
    pdf.text('OWED', pw - margin - 1, y, { align: 'right' });
    y += 2.5;
    pdf.setDrawColor(225, 225, 225);
    pdf.line(margin, y, pw - margin, y);
    y += 4;

    if (a.lines.length === 0) {
      pdf.setFont('helvetica', 'italic');
      pdf.setFontSize(8);
      pdf.setTextColor(130, 130, 130);
      pdf.text('No confirmed advance lines for this agent.', margin + 1, y);
      y += 6;
    } else {
      for (const l of a.lines) {
        const label = l.kind === 'telecom' ? 'Telecom sending charge they paid' : 'Customer payout from their own phone money';
        const ref = l.withdrawalId ? `Ref ${l.withdrawalId.slice(0, 8)}` : 'No payout ref';
        const noteLines = l.note ? pdf.splitTextToSize(l.note, pw - margin * 2 - 70) : [];
        const rowH = 9 + noteLines.length * 3.2;
        ensure(rowH);
        pdf.setFont('helvetica', 'normal');
        pdf.setFontSize(8);
        pdf.setTextColor(40, 40, 40);
        pdf.text(fmtDate(l.createdAt), margin + 1, y);
        pdf.text(pdf.splitTextToSize(label, 60)[0], margin + 34, y);
        pdf.text(l.payoutAmount ? formatUGX(l.payoutAmount) : '—', pw - margin - 62, y, { align: 'right' });
        pdf.text(formatUGX(l.floatUsed), pw - margin - 30, y, { align: 'right' });
        pdf.setFont('helvetica', 'bold');
        pdf.text(formatUGX(l.amount), pw - margin - 1, y, { align: 'right' });
        y += 3.6;
        pdf.setFont('helvetica', 'normal');
        pdf.setFontSize(7);
        pdf.setTextColor(135, 135, 135);
        pdf.text(ref, margin + 34, y);
        y += 3.4;
        if (noteLines.length) {
          pdf.text(noteLines, margin + 34, y);
          y += noteLines.length * 3.2;
        }
        y += 1.6;
      }
      ensure(10);
      pdf.setDrawColor(225, 225, 225);
      pdf.line(margin, y, pw - margin, y);
      y += 4.5;
      pdf.setFont('helvetica', 'bold');
      pdf.setFontSize(8.5);
      pdf.setTextColor(20, 20, 20);
      pdf.text(`Settle to ${a.agentName}`, margin + 1, y);
      pdf.text(formatUGX(a.payable), pw - margin - 1, y, { align: 'right' });
      y += 9;
    }
  }

  // Sign-off block
  ensure(34);
  pdf.setDrawColor(200, 200, 200);
  pdf.setFillColor(250, 250, 250);
  pdf.roundedRect(margin, y, pw - margin * 2, 28, 2, 2, 'FD');
  pdf.setFont('helvetica', 'bold');
  pdf.setFontSize(8);
  pdf.setTextColor(90, 90, 90);
  pdf.text('PREPARED BY (FINANCIAL OPS)', margin + 5, y + 7);
  pdf.text('APPROVED BY (CFO)', pw / 2 + 4, y + 7);
  pdf.setDrawColor(160, 160, 160);
  pdf.line(margin + 5, y + 20, pw / 2 - 6, y + 20);
  pdf.line(pw / 2 + 4, y + 20, pw - margin - 5, y + 20);
  pdf.setFont('helvetica', 'normal');
  pdf.setFontSize(7);
  pdf.text('Name, signature & date', margin + 5, y + 24);
  pdf.text('Name, signature & date', pw / 2 + 4, y + 24);

  drawFooter();
  const blob = pdf.output('blob');
  archivePdfBlob(blob, {
    label: `Merchant settlement schedule — ${input.agents.length} agent(s)`,
    filename: buildMerchantDebtSettlementFilename(input.agents.length),
    category: 'finops-report',
  }).catch(() => {});
  return blob;
}
