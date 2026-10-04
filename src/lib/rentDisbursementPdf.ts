/**
 * Rent Disbursement Report — PDF presentation layer.
 *
 * PRESENTATION ONLY. No financial computation happens here: this renders the
 * payload returned by the `get_rent_disbursement_report` RPC exactly as the
 * on-screen CFO report shows it (same rows, same totals, same statuses).
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

export interface RentDisbursementPdfOptions {
  filename: string;
  /** Reporting date label, e.g. "2026-08-11" */
  dateLabel: string;
  /** Full report payload from the RPC (unmodified). */
  report: any;
}

export async function downloadRentDisbursementPdf({ filename, dateLabel, report }: RentDisbursementPdfOptions) {
  const [{ default: jsPDF }, autoTableMod] = await Promise.all([
    import('jspdf'),
    import('jspdf-autotable'),
  ]);
  const autoTable = (autoTableMod as any).default ?? autoTableMod;

  const doc = new jsPDF({ orientation: 'landscape', unit: 'pt', format: 'a4' });
  const pageW = doc.internal.pageSize.getWidth();
  const pageH = doc.internal.pageSize.getHeight();
  const M = 34;
  const usable = pageW - M * 2;
  const bottom = 44;

  const s = report?.summary ?? {};
  const rows: any[] = report?.rows ?? [];
  const byMethod: any[] = report?.by_method ?? [];
  const byStatus: any[] = report?.by_status ?? [];
  const startEat = report?.period?.start_eat ?? '';
  const endEat = report?.period?.end_eat ?? '';
  const generated = report?.generated_at
    ? new Date(report.generated_at).toISOString().replace('T', ' ').slice(0, 16) + ' UTC'
    : '';

  let y = 54;
  const ensure = (need: number) => {
    if (y + need > pageH - bottom) {
      doc.addPage();
      y = 50;
    }
  };

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(20);
  doc.setTextColor(...PURPLE);
  doc.text('Rent Disbursement Report', M, y);
  y += 15;
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(9.5);
  doc.setTextColor(...MUTED);
  doc.text(`Reporting date: ${dateLabel} (EAT) — window ${startEat} to ${endEat}`, M, y);
  y += 13;
  doc.text(`Welile Technologies Ltd — Kabaale Palm Lane, Uganda · Generated ${generated}`, M, y);
  y += 20;

  const cards = [
    { label: 'Rent disbursements', value: String(Number(s.disbursements_count ?? 0)), hint: 'Successful entries for the day' },
    { label: 'Total amount disbursed', value: ugx(s.total_amount), hint: 'Sum of rent paid out' },
    { label: 'Tenants covered', value: String(Number(s.tenants_count ?? 0)), hint: 'Distinct tenants' },
    { label: 'Landlords paid', value: String(Number(s.landlords_count ?? 0)), hint: 'Distinct landlords' },
  ];
  const bandH = 70;
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
    let size = 13;
    doc.setFontSize(size);
    while (size > 7.5 && doc.getTextWidth(c.value) > colW - 20) {
      size -= 0.4;
      doc.setFontSize(size);
    }
    doc.text(c.value, x + 10, y + 42);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(7.4);
    doc.setTextColor(...MUTED);
    doc.text(doc.splitTextToSize(c.hint, colW - 18)[0], x + 10, y + 58);
  });
  y += bandH + 24;

  const heading = (text: string) => {
    ensure(120);
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(12);
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
      body: body.length ? body : [[{ content: 'No rent disbursements recorded for this day', colSpan: head.length, styles: { textColor: MUTED, halign: 'left' } }]],
      foot: opts?.foot,
      showHead: 'everyPage',
      showFoot: 'lastPage',
      rowPageBreak: 'avoid',
      styles: {
        font: 'helvetica', fontSize: 7.5, cellPadding: 4, overflow: 'linebreak',
        valign: 'middle', textColor: INK, lineColor: BORDER, lineWidth: 0.4,
      },
      headStyles: { fillColor: PURPLE, textColor: 255, fontStyle: 'bold', fontSize: 7.5, cellPadding: 5 },
      footStyles: { fillColor: TINT, textColor: PURPLE_DEEP, fontStyle: 'bold', fontSize: 7.5, lineColor: BORDER, lineWidth: 0.4 },
      alternateRowStyles: { fillColor: [251, 249, 254] },
      columnStyles,
      margin: { left: M, right: M, top: 50, bottom },
      tableWidth: usable,
    });
    y = ((doc as any).lastAutoTable?.finalY ?? y) + 20;
  };

  heading(`1. Rent disbursements (${rows.length})`);
  table(
    ['#', 'Tenant', 'Tenant phone', 'Landlord', 'Landlord phone', 'Property / location', 'Recipient', 'Method', 'Reference', 'Status', 'Time (EAT)', 'Amount'],
    rows.map((r) => [
      r.n,
      r.tenant_name,
      r.tenant_phone,
      r.landlord_name,
      r.landlord_phone,
      [r.property, r.location].filter(Boolean).join(' · ') || '—',
      r.recipient_name && r.recipient_name !== '—' ? `${r.recipient_name} (${r.recipient_type})` : r.recipient_type,
      r.payout_method,
      r.reference,
      r.status,
      `${r.date_eat} ${r.time_eat}`,
      ugx(r.amount),
    ]),
    {
      align: { 0: 'left', 11: 'right' },
      widths: { 0: 20, 2: 58, 4: 58, 7: 48, 9: 54, 10: 74, 11: 74 },
      foot: [[
        { content: `Total rent disbursed (${Number(s.disbursements_count ?? 0)} disbursements)`, colSpan: 11, styles: { halign: 'left' } } as any,
        { content: ugx(s.total_amount), styles: { halign: 'right' } } as any,
      ]],
    },
  );

  heading('2. Breakdown by payout method');
  table(
    ['Payout method', 'Disbursements', 'Amount'],
    byMethod.map((m) => [m.label, m.count, ugx(m.amount)]),
    { align: { 1: 'right', 2: 'right' }, widths: { 1: 96, 2: 110 } },
  );

  heading('3. Breakdown by rent request status');
  table(
    ['Status', 'Disbursements', 'Amount'],
    byStatus.map((m) => [m.label, m.count, ugx(m.amount)]),
    { align: { 1: 'right', 2: 'right' }, widths: { 1: 96, 2: 110 } },
  );

  heading('4. Scope');
  paragraph(
    `Successful rent disbursement transactions recorded in the general ledger between ${startEat} and ${endEat} (EAT) — category "rent_disbursement", platform scope, cash out, excluding administrative corrections. Cancelled, failed or pending rent requests are not part of this set because no rent disbursement transaction exists for them. Amounts in UGX.`,
  );

  const pages = (doc as any).internal.getNumberOfPages();
  for (let p = 1; p <= pages; p++) {
    doc.setPage(p);
    doc.setDrawColor(...BORDER);
    doc.setLineWidth(0.5);
    doc.line(M, pageH - 28, pageW - M, pageH - 28);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(7.6);
    doc.setTextColor(...MUTED);
    doc.text('Welile Technologies Ltd · Rent Disbursement Report · confidential', M, pageH - 16);
    doc.text(`Page ${p} of ${pages}`, pageW - M, pageH - 16, { align: 'right' });
  }

  savePdfWithVault(doc as any, filename, {
    label: `Rent Disbursement Report ${dateLabel}`,
    category: 'audit',
  });
}
