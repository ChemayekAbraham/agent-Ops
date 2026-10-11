// Repayment history statement a lending agent can show or send to a borrower.
// jsPDF is loaded on demand to keep it out of the main bundle.

export interface RepaymentPdfInput {
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

export async function generateRepaymentHistoryPdf(i: RepaymentPdfInput): Promise<Blob> {
  const { jsPDF } = await import('jspdf');
  const autoTable = (await import('jspdf-autotable')).default;
  const doc = new jsPDF({ unit: 'pt', format: 'a4' });
  const W = doc.internal.pageSize.getWidth();
  const M = 40;

  doc.setFillColor(107, 33, 168);
  doc.rect(0, 0, W, 70, 'F');
  doc.setTextColor(255, 255, 255);
  doc.setFont('helvetica', 'bold').setFontSize(18).text('Loan Repayment History', M, 34);
  doc.setFont('helvetica', 'normal').setFontSize(10).text(`Generated ${fmtDate(new Date().toISOString())}`, M, 54);

  doc.setTextColor(30, 41, 59);
  doc.setFont('helvetica', 'bold').setFontSize(13).text(i.borrowerName, M, 98);
  doc.setFont('helvetica', 'normal').setFontSize(10).setTextColor(100, 116, 139);
  if (i.borrowerPhone) doc.text(`Phone: ${i.borrowerPhone}`, M, 114);

  const pct = i.totalDue > 0 ? Math.min(100, Math.round((i.amountRepaid / i.totalDue) * 100)) : 0;
  autoTable(doc, {
    startY: 128,
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
  doc.setFontSize(8).setTextColor(100, 116, 139)
    .text('Statement issued by your lending agent through Welile. Please keep it for your records.', M, H - 24);
  return doc.output('blob');
}
