/**
 * Customer Transaction Statement PDF — Date · Category · Method · Amount.
 *
 * Presentation-only: rows are passed in already fetched from the ledger feed.
 * Styled as a formal financial statement (letterhead, summary panel, ruled
 * table, signature/footer block) so it can be shared or filed as-is.
 */
import welileLogo from '@/assets/welile-logo.png';

export interface TxStatementRow {
  date: string;          // ISO
  category: string;      // human label
  method: string;        // human label
  amount: number;        // absolute value
  direction: 'cash_in' | 'cash_out';
}

export interface TxStatementInput {
  ownerName: string;
  ownerPhone?: string | null;
  rows: TxStatementRow[];
  /** Optional filter description printed under the title. */
  periodLabel?: string;
}

const COMPANY = {
  name: 'Welile',
  tagline: 'Rent. Trust. Progress.',
  address: 'Kabaale, Entebbe, Uganda',
  web: 'welileapp.com',
};

const BRAND: [number, number, number] = [146, 52, 234];
const INK: [number, number, number] = [24, 24, 27];
const MUTED: [number, number, number] = [113, 113, 122];
const IN_COLOR: [number, number, number] = [21, 128, 61];
const OUT_COLOR: [number, number, number] = [185, 28, 28];

const money = (n: number) =>
  new Intl.NumberFormat('en-UG', { maximumFractionDigits: 0 }).format(Math.round(n));

const fmtDate = (iso: string) =>
  new Date(iso).toLocaleString('en-UG', {
    day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit',
  });

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

export async function generateTransactionStatementPdf(input: TxStatementInput): Promise<Blob> {
  const { jsPDF } = await import('jspdf');
  const pdf = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4', compress: true });
  const pw = pdf.internal.pageSize.getWidth();
  const ph = pdf.internal.pageSize.getHeight();
  const M = 14;
  const logo = await loadLogo();

  const totalIn = input.rows.filter(r => r.direction === 'cash_in').reduce((s, r) => s + r.amount, 0);
  const totalOut = input.rows.filter(r => r.direction === 'cash_out').reduce((s, r) => s + r.amount, 0);

  // Column geometry (Date · Category · Method · Amount)
  const cDate = M + 2;
  const cCat = M + 44;
  const cMethod = M + 108;
  const cAmount = pw - M - 2;

  let page = 0;

  const drawLetterhead = () => {
    pdf.setFillColor(...BRAND);
    pdf.rect(0, 0, pw, 30, 'F');
    pdf.setFillColor(255, 255, 255);
    pdf.roundedRect(M, 6, 18, 18, 2.5, 2.5, 'F');
    if (logo) {
      try { pdf.addImage(logo, 'PNG', M + 1.5, 7.5, 15, 15, undefined, 'FAST'); } catch { /* ignore */ }
    }
    pdf.setTextColor(255, 255, 255);
    pdf.setFont('helvetica', 'bold');
    pdf.setFontSize(15);
    pdf.text(COMPANY.name, M + 23, 14);
    pdf.setFont('helvetica', 'normal');
    pdf.setFontSize(8);
    pdf.text(COMPANY.tagline, M + 23, 19);
    pdf.text(COMPANY.address, pw - M, 13, { align: 'right' });
    pdf.text(COMPANY.web, pw - M, 18, { align: 'right' });
    // thin gold rule under the band
    pdf.setDrawColor(212, 175, 55);
    pdf.setLineWidth(0.8);
    pdf.line(0, 30.4, pw, 30.4);
  };

  const drawTableHead = (y: number) => {
    pdf.setFillColor(244, 240, 252);
    pdf.rect(M, y - 5.5, pw - M * 2, 8, 'F');
    pdf.setFont('helvetica', 'bold');
    pdf.setFontSize(8);
    pdf.setTextColor(...BRAND);
    pdf.text('DATE', cDate, y);
    pdf.text('CATEGORY', cCat, y);
    pdf.text('METHOD', cMethod, y);
    pdf.text('AMOUNT (UGX)', cAmount, y, { align: 'right' });
    return y + 7;
  };

  const drawFooter = () => {
    pdf.setDrawColor(228, 228, 231);
    pdf.setLineWidth(0.2);
    pdf.line(M, ph - 14, pw - M, ph - 14);
    pdf.setFont('helvetica', 'normal');
    pdf.setFontSize(7.5);
    pdf.setTextColor(...MUTED);
    pdf.text(`${COMPANY.name} · ${COMPANY.address} · ${COMPANY.web}`, M, ph - 9);
    pdf.text(`Page ${page}`, pw - M, ph - 9, { align: 'right' });
    pdf.text('This statement is generated from the Welile general ledger and is confidential.', M, ph - 5);
  };

  const newPage = (withHead = true) => {
    if (page > 0) { drawFooter(); pdf.addPage(); }
    page += 1;
    drawLetterhead();
    let y = 40;
    if (withHead) y = drawTableHead(y + 4);
    return y;
  };

  // ── Page 1 header block ──
  page = 1;
  drawLetterhead();
  let y = 40;

  pdf.setTextColor(...INK);
  pdf.setFont('helvetica', 'bold');
  pdf.setFontSize(16);
  pdf.text('Statement of Transactions', M, y);
  y += 6;
  pdf.setFont('helvetica', 'normal');
  pdf.setFontSize(8.5);
  pdf.setTextColor(...MUTED);
  pdf.text(
    `${input.periodLabel ?? 'All recorded activity'}  ·  Issued ${new Date().toLocaleString('en-UG', { dateStyle: 'medium', timeStyle: 'short' })}`,
    M, y,
  );
  y += 9;

  // Account holder
  pdf.setFillColor(250, 250, 252);
  pdf.roundedRect(M, y, pw - M * 2, 18, 2.5, 2.5, 'F');
  pdf.setFont('helvetica', 'bold');
  pdf.setFontSize(7.5);
  pdf.setTextColor(...MUTED);
  pdf.text('ACCOUNT HOLDER', M + 5, y + 6);
  pdf.setFontSize(11);
  pdf.setTextColor(...INK);
  pdf.text(input.ownerName || '—', M + 5, y + 13);
  if (input.ownerPhone) {
    pdf.setFont('helvetica', 'normal');
    pdf.setFontSize(9);
    pdf.setTextColor(...MUTED);
    pdf.text(input.ownerPhone, pw - M - 5, y + 13, { align: 'right' });
  }
  y += 25;

  // Summary trio
  const boxW = (pw - M * 2 - 8) / 3;
  const summary: { label: string; value: string; color: [number, number, number] }[] = [
    { label: 'MONEY IN', value: `UGX ${money(totalIn)}`, color: IN_COLOR },
    { label: 'MONEY OUT', value: `UGX ${money(totalOut)}`, color: OUT_COLOR },
    { label: 'NET MOVEMENT', value: `UGX ${money(totalIn - totalOut)}`, color: INK },
  ];
  summary.forEach((s, i) => {
    const x = M + i * (boxW + 4);
    pdf.setFillColor(255, 255, 255);
    pdf.setDrawColor(228, 228, 231);
    pdf.setLineWidth(0.3);
    pdf.roundedRect(x, y, boxW, 20, 2.5, 2.5, 'FD');
    pdf.setFont('helvetica', 'bold');
    pdf.setFontSize(7);
    pdf.setTextColor(...MUTED);
    pdf.text(s.label, x + 4, y + 7);
    pdf.setFontSize(11);
    pdf.setTextColor(...s.color);
    pdf.text(s.value, x + 4, y + 15);
  });
  y += 27;

  pdf.setFont('helvetica', 'bold');
  pdf.setFontSize(9);
  pdf.setTextColor(...INK);
  pdf.text(`Transactions (${input.rows.length})`, M, y);
  y += 6;
  y = drawTableHead(y);

  // ── Rows ──
  const rowH = 7.6;
  input.rows.forEach((r, i) => {
    if (y > ph - 32) y = newPage();
    if (i % 2 === 1) {
      pdf.setFillColor(250, 250, 251);
      pdf.rect(M, y - 5, pw - M * 2, rowH, 'F');
    }
    pdf.setFont('helvetica', 'normal');
    pdf.setFontSize(8);
    pdf.setTextColor(...INK);
    pdf.text(fmtDate(r.date), cDate, y);
    pdf.text(pdf.splitTextToSize(r.category, cMethod - cCat - 4)[0] ?? '', cCat, y);
    pdf.setTextColor(...MUTED);
    pdf.text(pdf.splitTextToSize(r.method, 34)[0] ?? '', cMethod, y);
    pdf.setFont('helvetica', 'bold');
    pdf.setTextColor(...(r.direction === 'cash_in' ? IN_COLOR : OUT_COLOR));
    pdf.text(`${r.direction === 'cash_in' ? '+' : '-'}${money(r.amount)}`, cAmount, y, { align: 'right' });
    y += rowH;
  });

  if (input.rows.length === 0) {
    pdf.setFont('helvetica', 'italic');
    pdf.setFontSize(9);
    pdf.setTextColor(...MUTED);
    pdf.text('No transactions recorded for this selection.', M + 2, y + 2);
    y += 10;
  }

  // ── Totals row ──
  if (y > ph - 44) y = newPage(false);
  y += 2;
  pdf.setDrawColor(...BRAND);
  pdf.setLineWidth(0.5);
  pdf.line(M, y, pw - M, y);
  y += 7;
  pdf.setFont('helvetica', 'bold');
  pdf.setFontSize(9);
  pdf.setTextColor(...INK);
  pdf.text('Net movement for the period', cDate, y);
  pdf.setTextColor(...(totalIn - totalOut >= 0 ? IN_COLOR : OUT_COLOR));
  pdf.text(`UGX ${money(totalIn - totalOut)}`, cAmount, y, { align: 'right' });
  y += 14;

  // ── Attestation block ──
  if (y < ph - 40) {
    pdf.setFont('helvetica', 'normal');
    pdf.setFontSize(7.5);
    pdf.setTextColor(...MUTED);
    pdf.text(
      'Prepared by Welile Finance from the double-entry general ledger. All amounts are in Uganda Shillings (UGX).',
      M, y,
    );
    y += 12;
    pdf.setDrawColor(180, 180, 185);
    pdf.setLineWidth(0.3);
    pdf.line(M, y, M + 55, y);
    pdf.line(pw - M - 55, y, pw - M, y);
    pdf.setFontSize(7.5);
    pdf.text('Authorised signatory', M, y + 4);
    pdf.text('Date', pw - M - 55, y + 4);
  }

  drawFooter();
  return pdf.output('blob');
}
