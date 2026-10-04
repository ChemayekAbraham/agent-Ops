import { formatUGX } from '@/lib/rentCalculations';
import welileLogoUrl from '@/assets/welile-logo.png';

export interface PartnerWithdrawalStatementPortfolio {
  portfolioName?: string | null;
  portfolioCode?: string | null;
  capitalAmount?: number | null;
  roiPercentage?: number | null;
  roiMode?: string | null;
  durationMonths?: number | null;
  payoutDay?: number | null;
  nextRoiDate?: string | null;
  maturityDate?: string | null;
  totalRoiEarned?: number | null;
  status?: string | null;
}

export interface PartnerWithdrawalStatementHistoryRow {
  date: string;
  amount: number;
  status: string;
  method: string;
  reference: string;
  isCurrent?: boolean;
}

export interface PartnerWithdrawalStatementInput {
  withdrawalId: string;
  partner: string;
  agent: string;
  payee: string;
  method: string;
  reference: string;
  amount: number;
  status: string;
  date: string;
  note?: string | null;
  portfolio: PartnerWithdrawalStatementPortfolio;
  history: PartnerWithdrawalStatementHistoryRow[];
  generatedAt?: Date;
}

const THEME_PRIMARY: [number, number, number] = [12, 74, 110];
const THEME_STRIPE: [number, number, number] = [237, 245, 250];
const COMPANY_NAME = 'Welile Technologies Limited';
const COMPANY_CONTACT = 'info@welile.com  |  www.welile.com';

const fmtDate = (iso?: string | null) => {
  if (!iso) return '—';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
};

const titleCase = (s?: string | null) =>
  (s || '—').replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());

async function loadLogoBase64(): Promise<string | null> {
  try {
    const res = await fetch(welileLogoUrl);
    const blob = await res.blob();
    return await new Promise((resolve) => {
      const reader = new FileReader();
      reader.onloadend = () => resolve(reader.result as string);
      reader.onerror = () => resolve(null);
      reader.readAsDataURL(blob);
    });
  } catch {
    return null;
  }
}

export async function generatePartnerWithdrawalStatementPdf(
  input: PartnerWithdrawalStatementInput,
): Promise<Blob> {
  const { default: jsPDF } = await import('jspdf');
  const autoTableMod: any = await import('jspdf-autotable');
  const autoTable = autoTableMod.default || autoTableMod;

  const generatedAt = input.generatedAt || new Date();
  const doc = new jsPDF({ unit: 'mm', format: 'a4', orientation: 'portrait' });
  const pageWidth = doc.internal.pageSize.getWidth();
  const margin = 14;
  const logoBase64 = await loadLogoBase64();

  const portfolioLabel =
    input.portfolio.portfolioName ||
    input.portfolio.portfolioCode ||
    'Portfolio not identified';

  // Header band
  doc.setFillColor(...THEME_PRIMARY);
  doc.rect(0, 0, pageWidth, 30, 'F');
  if (logoBase64) {
    try { doc.addImage(logoBase64, 'PNG', margin, 6, 18, 18); } catch { /* ignore */ }
  }
  const headX = logoBase64 ? margin + 23 : margin;
  doc.setTextColor(255, 255, 255);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(15);
  doc.text('Portfolio Payout Statement', headX, 13);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(8.5);
  doc.text(`${COMPANY_NAME}  |  ${COMPANY_CONTACT}`, headX, 19);
  doc.text(`Generated: ${generatedAt.toLocaleString('en-GB')}`, headX, 24.5);

  // Portfolio identity block — the payout is always tied to one portfolio.
  let y = 38;
  doc.setTextColor(...THEME_PRIMARY);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(12);
  doc.text(`Portfolio: ${portfolioLabel}`, margin, y);
  y += 6;
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(9.5);
  doc.setTextColor(60, 60, 60);
  doc.text(`Partner: ${input.partner || '—'}`, margin, y);
  doc.text(`Statement ref: ${input.withdrawalId.slice(0, 8).toUpperCase()}`, pageWidth - margin, y, { align: 'right' });
  y += 8;

  autoTable(doc, {
    startY: y,
    margin: { left: margin, right: margin },
    head: [['Portfolio details', '']],
    body: [
      ['Portfolio name', portfolioLabel],
      ['Portfolio code', input.portfolio.portfolioCode || '—'],
      ['Portfolio status', titleCase(input.portfolio.status)],
      ['Capital funded', input.portfolio.capitalAmount != null ? formatUGX(Number(input.portfolio.capitalAmount)) : '—'],
      ['Returns rate', input.portfolio.roiPercentage != null ? `${input.portfolio.roiPercentage}% ${titleCase(input.portfolio.roiMode)}` : '—'],
      ['Duration', input.portfolio.durationMonths != null ? `${input.portfolio.durationMonths} months` : '—'],
      ['Payout day', input.portfolio.payoutDay != null ? String(input.portfolio.payoutDay) : '—'],
      ['Next returns date', fmtDate(input.portfolio.nextRoiDate)],
      ['Maturity date', fmtDate(input.portfolio.maturityDate)],
      ['Total returns paid to date', input.portfolio.totalRoiEarned != null ? formatUGX(Number(input.portfolio.totalRoiEarned)) : '—'],
    ],
    theme: 'grid',
    styles: { fontSize: 9, cellPadding: 2.2, textColor: [40, 40, 40] },
    headStyles: { fillColor: THEME_PRIMARY, textColor: [255, 255, 255], fontStyle: 'bold', fontSize: 9 },
    columnStyles: { 0: { cellWidth: 62, fontStyle: 'bold' }, 1: { cellWidth: 'auto' } },
  });

  y = (doc as any).lastAutoTable.finalY + 8;

  autoTable(doc, {
    startY: y,
    margin: { left: margin, right: margin },
    head: [['This payout', '']],
    body: [
      ['Amount withdrawn', formatUGX(Number(input.amount) || 0)],
      ['Withdrawn for portfolio', portfolioLabel],
      ['Status', titleCase(input.status)],
      ['Date', fmtDate(input.date)],
      ['Payment channel', titleCase(input.method)],
      ['Transaction reference', input.reference || '—'],
      ['Payee (account name)', input.payee || '—'],
      ['Processed by agent', input.agent || '—'],
      ['Narration', input.note || '—'],
    ],
    theme: 'grid',
    styles: { fontSize: 9, cellPadding: 2.2, overflow: 'linebreak', textColor: [40, 40, 40] },
    headStyles: { fillColor: THEME_PRIMARY, textColor: [255, 255, 255], fontStyle: 'bold', fontSize: 9 },
    columnStyles: { 0: { cellWidth: 62, fontStyle: 'bold' }, 1: { cellWidth: 'auto' } },
  });

  y = (doc as any).lastAutoTable.finalY + 8;

  const historyTotal = input.history.reduce((s, r) => s + (Number(r.amount) || 0), 0);
  const completedTotal = input.history
    .filter((r) => r.status === 'completed')
    .reduce((s, r) => s + (Number(r.amount) || 0), 0);

  autoTable(doc, {
    startY: y,
    margin: { left: margin, right: margin },
    head: [['#', 'Date', 'Amount', 'Status', 'Channel', 'Reference']],
    body: input.history.map((r, i) => [
      String(i + 1) + (r.isCurrent ? ' •' : ''),
      fmtDate(r.date),
      formatUGX(Number(r.amount) || 0),
      titleCase(r.status),
      titleCase(r.method),
      r.reference || '—',
    ]),
    foot: [[
      '',
      'Total',
      formatUGX(historyTotal),
      `Settled: ${formatUGX(completedTotal)}`,
      '',
      '',
    ]],
    styles: { fontSize: 8.5, cellPadding: 2, overflow: 'linebreak', textColor: [40, 40, 40] },
    headStyles: { fillColor: THEME_PRIMARY, textColor: [255, 255, 255], fontStyle: 'bold', fontSize: 8.5 },
    footStyles: { fillColor: THEME_STRIPE, textColor: [20, 20, 20], fontStyle: 'bold', fontSize: 8.5 },
    alternateRowStyles: { fillColor: THEME_STRIPE },
    columnStyles: {
      0: { cellWidth: 12, halign: 'right' },
      1: { cellWidth: 26 },
      2: { cellWidth: 32, halign: 'right' },
      3: { cellWidth: 30 },
      4: { cellWidth: 28 },
      5: { cellWidth: 'auto' },
    },
    didDrawPage: () => {
      const h = doc.internal.pageSize.getHeight();
      doc.setFontSize(7.5);
      doc.setTextColor(130, 130, 130);
      doc.text('Confidential — portfolio payout statement issued by Welile Technologies Limited.', margin, h - 8);
      doc.text(`Page ${doc.getNumberOfPages()}`, pageWidth - margin, h - 8, { align: 'right' });
    },
  });

  y = (doc as any).lastAutoTable.finalY + 8;
  doc.setFontSize(8);
  doc.setTextColor(110, 110, 110);
  doc.text(
    'All payout history above is limited to this portfolio. Amounts are in Ugandan Shillings (UGX).',
    margin,
    y,
  );

  return doc.output('blob');
}
