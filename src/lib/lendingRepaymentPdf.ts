// Repayment history statement a lending agent can show or send to a borrower.
// jsPDF is loaded on demand to keep it out of the main bundle.

import welileLogo from '@/assets/welile-logo.png';

export interface RepaymentPdfInput {
  agentName?: string | null;
  borrowerName: string;
  borrowerPhone?: string | null;
  principal: number;
  ratePct: number;
  totalDue: number;
  amountRepaid: number;
  outstanding: number;
  takenOn: string;
  dueDate?: string | null;
  status: string;
  fundingLabel: string;
  payments: { amount_ugx: number; created_at: string }[];
}

const fmtDate = (d: string) =>
  new Date(d).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'Africa/Kampala' });
const ugx = (n: number) => `UGX ${Math.round(n).toLocaleString('en-US')}`;

async function loadLogo(): Promise<string | null> {
  try {
    const blob = await (await fetch(welileLogo)).blob();
    return await new Promise<string>((resolve, reject) => {
      const r = new FileReader();
      r.onloadend = () => resolve(r.result as string);
      r.onerror = reject;
      r.readAsDataURL(blob);
    });
  } catch { return null; }
}

export async function generateRepaymentHistoryPdf(i: RepaymentPdfInput): Promise<Blob> {
  const { jsPDF } = await import('jspdf');
  const autoTable = (await import('jspdf-autotable')).default;
  const doc = new jsPDF({ unit: 'pt', format: 'a4' });
  const W = doc.internal.pageSize.getWidth();
  const M = 40;

  const logo = await loadLogo();
  doc.setFillColor(107, 33, 168);
  doc.rect(0, 0, W, 84, 'F');
  let tx = M;
  if (logo) {
    doc.setFillColor(255, 255, 255);
    doc.roundedRect(M, 14, 56, 56, 8, 8, 'F');
    try { doc.addImage(logo, 'PNG', M + 6, 20, 44, 44, undefined, 'FAST'); tx = M + 70; } catch { /* ignore */ }
  }
  doc.setTextColor(255, 255, 255);
  doc.setFont('helvetica', 'bold').setFontSize(11).text('WELILE LENDING AGENT', tx, 30);
  doc.setFontSize(18).text('Loan Repayment Statement', tx, 52);
  doc.setFont('helvetica', 'normal').setFontSize(9)
    .text(`${i.agentName ? `Lender: ${i.agentName}  |  ` : ''}Issued ${fmtDate(new Date().toISOString())}`, tx, 68);

  doc.setTextColor(30, 41, 59);
  doc.setFont('helvetica', 'bold').setFontSize(13).text(i.borrowerName, M, 112);
  doc.setFont('helvetica', 'normal').setFontSize(10).setTextColor(100, 116, 139);
  if (i.borrowerPhone) doc.text(`Phone: ${i.borrowerPhone}`, M, 128);

  const pct = i.totalDue > 0 ? Math.min(100, Math.round((i.amountRepaid / i.totalDue) * 100)) : 0;
  autoTable(doc, {
    startY: 142,
    theme: 'grid',
    styles: { fontSize: 10, cellPadding: 6 },
    headStyles: { fillColor: [107, 33, 168] },
    head: [['Loan summary', '']],
    body: [
      ['Amount borrowed', ugx(i.principal)],
      ['Interest rate', `${i.ratePct}%`],
      ['Total to repay', ugx(i.totalDue)],
      ['Total repaid', `${ugx(i.amountRepaid)} (${pct}%)`],
      ['Still owed', ugx(i.outstanding)],
      ['Loan taken on', fmtDate(i.takenOn)],
      ['Due date', i.dueDate ? fmtDate(i.dueDate) : '-'],
      ['Funded from', i.fundingLabel],
      ['Status', i.status.replace(/_/g, ' ')],
    ],
    columnStyles: { 0: { fontStyle: 'bold', cellWidth: 160 } },
  });

  const y = (doc as any).lastAutoTable.finalY + 24;
  doc.setTextColor(30, 41, 59).setFont('helvetica', 'bold').setFontSize(12).text('Payments', M, y);
  let running = 0;
  autoTable(doc, {
    startY: y + 8,
    theme: 'striped',
    styles: { fontSize: 10, cellPadding: 6 },
    headStyles: { fillColor: [107, 33, 168] },
    head: [['#', 'Date', 'Amount paid', 'Total paid so far']],
    body: i.payments.length
      ? i.payments.map((p, idx) => {
          running += Number(p.amount_ugx) || 0;
          return [String(idx + 1), fmtDate(p.created_at), ugx(Number(p.amount_ugx) || 0), ugx(running)];
        })
      : [['', 'No payments recorded yet', '', '']],
  });

  const H = doc.internal.pageSize.getHeight();
  doc.setDrawColor(107, 33, 168).line(M, H - 40, W - M, H - 40);
  doc.setFontSize(8).setTextColor(100, 116, 139)
    .text(`Issued by ${i.agentName || 'your lending agent'}, a Welile Lending Agent. Please keep this statement for your records.`, M, H - 28)
    .text('Welile  |  welileapp.com', M, H - 17);
  return doc.output('blob');
}
