/**
 * Returns (ROI) Disbursement Report — PDF presentation layer.
 *
 * PRESENTATION ONLY. This module performs no financial computation: it renders
 * the payload already returned by the `get_roi_disbursement_report` RPC exactly
 * as the on-screen report shows it. Layout reproduces the approved
 * ROI_Disbursement_Report_v9 template (white page, purple accents, summary
 * band, numbered sections, repeated table headers across pages).
 */
import { savePdfWithVault } from '@/lib/pdfVault';

const PURPLE: [number, number, number] = [124, 10, 219];
const PURPLE_DEEP: [number, number, number] = [88, 8, 156];
const TINT: [number, number, number] = [245, 238, 254];
const BORDER: [number, number, number] = [214, 198, 240];
const INK: [number, number, number] = [32, 30, 42];
const MUTED: [number, number, number] = [118, 114, 132];

const ugx = (n: number | null | undefined) =>
  `UGX ${Math.round(Number(n ?? 0)).toLocaleString('en-US')}`;

export interface RoiPdfOptions {
  filename: string;
  /** e.g. "Daily" */
  periodLabel: string;
  /** Full report payload from the RPC (unmodified). */
  report: any;
}

export async function downloadRoiDisbursementPdf({ filename, periodLabel, report }: RoiPdfOptions) {
  const [{ default: jsPDF }, autoTableMod] = await Promise.all([
    import('jspdf'),
    import('jspdf-autotable'),
  ]);
  const autoTable = (autoTableMod as any).default ?? autoTableMod;

  const doc = new jsPDF({ orientation: 'portrait', unit: 'pt', format: 'a4' });
  const pageW = doc.internal.pageSize.getWidth();
  const pageH = doc.internal.pageSize.getHeight();
  const M = 40;
  const usable = pageW - M * 2;
  const bottom = 46;

  const s = report?.summary ?? {};
  const rec = report?.reconciliation ?? {};
  const cash: any[] = report?.cash ?? [];
  const comp: any[] = report?.compounded ?? [];
  const approvals: any[] = report?.approvals ?? [];
  const routing: any[] = report?.routing ?? [];
  const exceptions: any[] = report?.exceptions ?? [];

  const startEat = report?.period?.start_eat ?? '';
  const endEat = report?.period?.end_eat ?? '';
  const generated = report?.generated_at
    ? new Date(report.generated_at).toISOString().replace('T', ' ').slice(0, 16) + ' UTC'
    : '';

  let y = 62;

  const ensure = (need: number) => {
    if (y + need > pageH - bottom) {
      doc.addPage();
      y = 56;
    }
  };

  // ── Title block ──
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(21);
  doc.setTextColor(...PURPLE);
  doc.text('ROI Disbursement Report', M, y);
  y += 15;
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(9.5);
  doc.setTextColor(...MUTED);
  doc.text(`CFO-approved Returns disbursements — ${periodLabel} window: ${startEat} to ${endEat} (EAT)`, M, y);
  y += 13;
  doc.text(`Welile Technologies Ltd — Kabaale Palm Lane, Uganda · Generated ${generated}`, M, y);
  y += 20;

  // ── Summary band ──
  const cards = [
    { label: 'Total Returns approved', value: ugx(s.total_approved), hint: `${Number(s.portfolios_total ?? 0)} portfolio entries` },
    { label: 'Cash disbursed to wallets', value: ugx(s.cash_total), hint: `${Number(s.payouts_count ?? 0)} payouts` },
    { label: 'Compounded to principal', value: ugx(s.compounded_total), hint: `${Number(s.compounded_portfolios ?? 0)} portfolios` },
    { label: 'Partners affected', value: String(Number(s.partners_affected ?? 0)), hint: `Principal base ${ugx(s.principal_total)}` },
  ];
  const bandH = 74;
  const colW = usable / cards.length;
  doc.setFillColor(...TINT);
  doc.setDrawColor(...BORDER);
  doc.setLineWidth(0.6);
  doc.roundedRect(M, y, usable, bandH, 6, 6, 'FD');
  cards.forEach((c, i) => {
    const x = M + i * colW;
    if (i > 0) {
      doc.setDrawColor(...BORDER);
      doc.line(x, y + 6, x, y + bandH - 6);
    }
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(7.6);
    doc.setTextColor(...MUTED);
    doc.text(c.label, x + 10, y + 18);
    doc.setFont('helvetica', 'bold');
    doc.setTextColor(...PURPLE);
    let size = 12.5;
    doc.setFontSize(size);
    while (size > 7.5 && doc.getTextWidth(c.value) > colW - 20) {
      size -= 0.4;
      doc.setFontSize(size);
    }
    doc.text(c.value, x + 10, y + 42);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(7.4);
    doc.setTextColor(...MUTED);
    doc.text(doc.splitTextToSize(c.hint, colW - 18)[0], x + 10, y + 60);
  });
  y += bandH + 26;

  const heading = (text: string) => {
    // keep the heading with at least the first rows of its table
    ensure(130);
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(12.5);
    doc.setTextColor(...PURPLE);
    doc.text(text, M, y);
    y += 12;
  };

  const paragraph = (text: string) => {
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(9);
    const lines = doc.splitTextToSize(text, usable) as string[];
    ensure(lines.length * 12 + 8);
    doc.setTextColor(...MUTED);
    doc.text(lines, M, y + 4);
    y += lines.length * 12 + 10;
  };

  const table = (
    head: string[],
    body: (string | number)[][],
    opts?: { align?: Record<number, 'left' | 'right'>; foot?: (string | number)[][]; widths?: Record<number, number> },
  ) => {
    ensure(70);
    const columnStyles: Record<number, any> = {};
    head.forEach((_, i) => {
      columnStyles[i] = {
        halign: opts?.align?.[i] ?? 'left',
        ...(opts?.widths?.[i] ? { cellWidth: opts.widths[i] } : {}),
      };
    });
    autoTable(doc, {
      startY: y,
      head: [head],
      body: body.length ? body : [[{ content: 'No records in this window', colSpan: head.length, styles: { textColor: MUTED, halign: 'left' } }]],
      foot: opts?.foot,
      showHead: 'everyPage',
      showFoot: 'lastPage',
      rowPageBreak: 'avoid',
      styles: {
        font: 'helvetica', fontSize: 8, cellPadding: 4.5, overflow: 'linebreak',
        valign: 'middle', textColor: INK, lineColor: BORDER, lineWidth: 0.4,
      },
      headStyles: { fillColor: PURPLE, textColor: 255, fontStyle: 'bold', fontSize: 8, cellPadding: 5 },
      footStyles: { fillColor: TINT, textColor: PURPLE_DEEP, fontStyle: 'bold', fontSize: 8, lineColor: BORDER, lineWidth: 0.4 },
      alternateRowStyles: { fillColor: [251, 249, 254] },
      columnStyles,
      margin: { left: M, right: M, top: 56, bottom },
      tableWidth: usable,
    });
    y = ((doc as any).lastAutoTable?.finalY ?? y) + 22;
  };

  // ── 1. Cash Returns disbursed to wallets ──
  heading(`1. Cash Returns disbursed to wallets (${cash.length} payouts)`);
  table(
    ['#', 'Portfolio phone', 'Partner', 'Paid to', 'Principal', 'Returns paid', 'Time (EAT)'],
    cash.map((r) => [r.n, r.portfolio_phone, r.partner, r.paid_to, ugx(r.principal), ugx(r.returns_paid), r.time_eat]),
    {
      align: { 0: 'left', 4: 'right', 5: 'right', 6: 'right' },
      widths: { 0: 22, 1: 80, 3: 76, 4: 80, 5: 80, 6: 52 },
      foot: [[{ content: 'Total cash disbursed', colSpan: 5, styles: { halign: 'left' } } as any, { content: ugx(s.cash_total), styles: { halign: 'right' } } as any, '']],
    },
  );

  // ── 2. Returns compounded into principal ──
  heading(`2. Returns compounded into principal (${comp.length} portfolios)`);
  table(
    ['#', 'Portfolio phone', 'Partner', 'New principal', 'Returns compounded', 'Executed by', 'Time (EAT)'],
    comp.map((r) => [r.n, r.portfolio_phone, r.partner, ugx(r.new_principal), ugx(r.returns_compounded), r.executed_by, r.time_eat]),
    {
      align: { 0: 'left', 3: 'right', 4: 'right', 6: 'right' },
      widths: { 0: 24, 1: 84, 3: 80, 4: 88, 6: 52 },
      foot: [[{ content: 'Total compounded', colSpan: 4, styles: { halign: 'left' } } as any, { content: ugx(s.compounded_total), styles: { halign: 'right' } } as any, '', '']],
    },
  );

  // ── 3. Approval and authorisation ──
  heading('3. Approval and authorisation');
  table(
    ['Stage', 'Authorised by', 'Role', 'Items', 'Amount', 'Window (EAT)'],
    approvals.map((a) => [a.stage, a.authorised_by, a.role, a.items, ugx(a.amount), a.window]),
    {
      align: { 3: 'left', 4: 'right', 5: 'right' },
      widths: { 2: 58, 3: 40, 4: 96, 5: 78 },
      foot: [[
        { content: 'Total authorised', colSpan: 3, styles: { halign: 'left' } } as any,
        { content: String(Number(s.portfolios_total ?? 0)), styles: { halign: 'left' } } as any,
        { content: ugx(s.total_approved), styles: { halign: 'right' } } as any,
        '',
      ]],
    },
  );

  // ── 4. Reconciliation ──
  heading('4. Reconciliation');
  table(
    ['Ledger check', 'Legs', 'Amount'],
    [
      ['Wallet credits (roi_wallet_credit)', Number(rec?.wallet_credits?.legs ?? 0), ugx(rec?.wallet_credits?.amount)],
      ['Reinvestments (roi_reinvestment)', Number(rec?.reinvestments?.legs ?? 0), ugx(rec?.reinvestments?.amount)],
      ['Platform expense (roi_expense)', Number(rec?.platform_expense?.legs ?? 0), ugx(rec?.platform_expense?.amount)],
    ],
    {
      align: { 1: 'right', 2: 'right' },
      widths: { 1: 70, 2: 140 },
      foot: [[
        { content: 'Balanced (credits + reinvestment = expense)', styles: { halign: 'left' } } as any,
        '',
        { content: rec?.balanced ? 'YES' : 'NO', styles: { halign: 'right' } } as any,
      ]],
    },
  );
  paragraph(
    `Wallet credits + reinvestments = ${ugx(Number(rec?.wallet_credits?.amount ?? 0) + Number(rec?.reinvestments?.amount ?? 0))} against platform Returns expense ${ugx(rec?.platform_expense?.amount)}.` +
      (rec?.balanced ? ' Balanced.' : ' Variance present — review the ledger for this window.'),
  );

  // ── 5. Routing note ──
  heading('5. Note on routing (managed-proxy wallets)');
  if (!routing.length) {
    paragraph("Every cash payout in this window landed in the partner's own wallet. No managed-proxy routing applied.");
  } else {
    table(
      ['Receiving wallet', 'Phone', 'Credits', 'Amount'],
      routing.map((r) => [r.name, r.phone, r.credits, ugx(r.amount)]),
      { align: { 2: 'right', 3: 'right' }, widths: { 1: 100, 2: 66, 3: 130 } },
    );
    paragraph(
      `${Number(report?.proxy_credits ?? 0)} of the cash Returns credits in this window settled into managed-proxy wallets. The 'Partner' column names the portfolio owner entitled to the Returns; 'Paid to' names the wallet actually credited.`,
    );
  }

  // ── 6. Exceptions ──
  heading('6. Exceptions to review');
  if (!exceptions.length) {
    paragraph('No exceptions detected for this window.');
  } else {
    table(
      ['Portfolio', 'Partner', 'Amount', 'Compounded at', 'Paid at'],
      exceptions.map((e) => [e.portfolio_code ?? '—', e.partner, ugx(e.amount), e.compounded_at, e.paid_at]),
      { align: { 2: 'right', 3: 'right', 4: 'right' }, widths: { 2: 96, 3: 80, 4: 80 } },
    );
    paragraph(
      'Each portfolio above received both a compounding entry and a cash payout of the same amount for the same cycle. Partner Ops / CFO should confirm whether the cash leg was intended, as the amount was already reinvested into principal.',
    );
  }

  // ── Scope ──
  heading('7. Scope');
  paragraph(
    `general_ledger entries created between ${startEat} and ${endEat} (EAT) with categories roi_wallet_credit and roi_reinvestment, i.e. Returns approvals executed within the selected ${periodLabel.toLowerCase()} window. Amounts in UGX. 'Paid to' reflects managed-proxy routing where applicable; 'Partner' is the portfolio owner.`,
  );

  // ── Footers ──
  const pages = (doc as any).internal.getNumberOfPages();
  for (let p = 1; p <= pages; p++) {
    doc.setPage(p);
    doc.setDrawColor(...BORDER);
    doc.setLineWidth(0.5);
    doc.line(M, pageH - 30, pageW - M, pageH - 30);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(7.6);
    doc.setTextColor(...MUTED);
    doc.text('Welile Technologies Ltd · Returns (ROI) Disbursement Report · confidential', M, pageH - 18);
    doc.text(`Page ${p} of ${pages}`, pageW - M, pageH - 18, { align: 'right' });
  }

  savePdfWithVault(doc as any, filename, {
    label: `${periodLabel} Returns Disbursement Report`,
    category: 'audit',
  });
}
