/**
 * SMS Cost / Yoola Credit Usage Report.
 *
 * Answers "what am I actually spending the SMS credit money on" — daily
 * message volume and cost (computed at 30 UGX per GSM-7/UCS-2 segment, not
 * the provider's own patchy self-reported cost figure — see
 * get_sms_cost_report's migration comment for why), split by provider, and a
 * top-30 breakdown by source (which feature/campaign generated the spend).
 *
 * jspdf + jspdf-autotable are imported dynamically so the chunk only ships
 * when an operator actually generates a report — same pattern as
 * smsTrafficReportPdf.ts.
 */
import { savePdfWithVault } from '@/lib/pdfVault';
import type { SmsCostReport } from '@/hooks/useSmsCostReport';

export interface SmsCostReportMeta {
  /** Human window label, e.g. "Last 30 days" or "June 2026". */
  windowLabel: string;
  /** Range subline, e.g. "04 Apr 2026 → 02 Jul 2026". */
  rangeLabel?: string;
}

const BRAND = {
  purple: [124, 58, 237] as [number, number, number],
  purpleDark: [76, 29, 149] as [number, number, number],
  ink: [30, 27, 45] as [number, number, number],
  slate: [100, 116, 139] as [number, number, number],
  line: [226, 232, 240] as [number, number, number],
  green: [16, 122, 87] as [number, number, number],
  amber: [180, 83, 9] as [number, number, number],
  zebra: [248, 247, 252] as [number, number, number],
  cardBg: [249, 248, 253] as [number, number, number],
};

function fmt(n: number) {
  return Math.round(n || 0).toLocaleString();
}
function ugx(n: number) {
  return `UGX ${fmt(n)}`;
}

export async function downloadSmsCostReportPdf(
  filename: string,
  report: SmsCostReport,
  meta: SmsCostReportMeta,
) {
  const [{ default: jsPDF }, autoTableMod] = await Promise.all([
    import('jspdf'),
    import('jspdf-autotable'),
  ]);
  const autoTable = (autoTableMod as any).default ?? autoTableMod;

  const doc = new jsPDF({ orientation: 'landscape', unit: 'pt', format: 'a4' });
  const pageW = doc.internal.pageSize.getWidth();
  const pageH = doc.internal.pageSize.getHeight();
  const M = 32;
  const generatedAt = new Date().toISOString().replace('T', ' ').slice(0, 16) + ' UTC';

  // ---- Header band --------------------------------------------------------
  const bandH = 74;
  doc.setFillColor(...BRAND.purple);
  doc.rect(0, 0, pageW, bandH, 'F');
  doc.setFillColor(...BRAND.purpleDark);
  doc.rect(0, bandH - 4, pageW, 4, 'F');

  doc.setTextColor(255, 255, 255);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(19);
  doc.text('SMS Cost / Yoola Credit Usage Report', M, 34);

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(10);
  doc.setTextColor(235, 228, 252);
  doc.text('Welile Technologies  ·  CTO Communications', M, 52);

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(13);
  doc.setTextColor(255, 255, 255);
  doc.text('WELILE', pageW - M, 32, { align: 'right' });
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(8.5);
  doc.setTextColor(235, 228, 252);
  doc.text(`Generated ${generatedAt}`, pageW - M, 48, { align: 'right' });
  doc.text(meta.windowLabel, pageW - M, 60, { align: 'right' });

  // ---- KPI summary cards ----------------------------------------------------
  const t = report.totals;
  const cardY = bandH + 18;
  const cardH = 52;
  const gap = 12;
  const cards: { label: string; value: string; accent: [number, number, number] }[] = [
    { label: 'Total cost (all attempts)', value: ugx(t.cost_ugx), accent: BRAND.purple },
    { label: 'Cost — accepted sends only', value: ugx(t.cost_ugx_sent_only), accent: BRAND.green },
    { label: 'Messages sent', value: fmt(t.sent), accent: BRAND.green },
    { label: 'Messages failed', value: fmt(t.failed), accent: BRAND.amber },
    { label: 'Total segments', value: fmt(t.segments), accent: BRAND.purpleDark },
    { label: 'Avg cost / message', value: ugx(t.messages ? t.cost_ugx / t.messages : 0), accent: BRAND.slate },
  ];
  const cardW = (pageW - M * 2 - gap * (cards.length - 1)) / cards.length;
  cards.forEach((c, i) => {
    const x = M + i * (cardW + gap);
    doc.setFillColor(...BRAND.cardBg);
    doc.setDrawColor(...BRAND.line);
    doc.roundedRect(x, cardY, cardW, cardH, 6, 6, 'FD');
    doc.setFillColor(...c.accent);
    doc.roundedRect(x, cardY, 4, cardH, 2, 2, 'F');
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(7);
    doc.setTextColor(...BRAND.slate);
    doc.text(c.label.toUpperCase(), x + 12, cardY + 18, { maxWidth: cardW - 16 });
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(13);
    doc.setTextColor(...BRAND.ink);
    doc.text(c.value, x + 12, cardY + 38);
  });

  // ---- Context line ---------------------------------------------------------
  let cursorY = cardY + cardH + 20;
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(9);
  doc.setTextColor(...BRAND.ink);
  doc.text('Reporting window', M, cursorY);
  doc.setFont('helvetica', 'normal');
  doc.setTextColor(...BRAND.slate);
  const winLine = meta.rangeLabel ? `${meta.windowLabel}  ·  ${meta.rangeLabel}` : meta.windowLabel;
  doc.text(winLine, M + 96, cursorY);
  cursorY += 13;
  doc.setFont('helvetica', 'bold');
  doc.setTextColor(...BRAND.ink);
  doc.text('Cost basis', M, cursorY);
  doc.setFont('helvetica', 'normal');
  doc.setTextColor(...BRAND.slate);
  doc.text(
    'UGX 30 per SMS segment, computed from message length (160/153 chars for GSM-7, 70/67 for Unicode) — not the provider-reported cost field.',
    M + 96, cursorY,
  );
  cursorY += 18;

  // ---- Daily table ------------------------------------------------------
  autoTable(doc, {
    startY: cursorY,
    head: [['Date', 'Messages', 'Segments', 'Yoola cost', "AT cost", 'Other cost', 'Total cost']],
    body: [...report.daily].reverse().map((r) => [
      r.day,
      fmt(r.messages),
      fmt(r.segments),
      ugx(r.yoola_cost_ugx),
      ugx(r.at_cost_ugx),
      ugx(r.other_cost_ugx),
      ugx(r.cost_ugx),
    ]),
    theme: 'grid',
    styles: { fontSize: 8, cellPadding: { top: 5, bottom: 5, left: 7, right: 7 }, lineColor: BRAND.line, lineWidth: 0.5, textColor: BRAND.ink, valign: 'middle' },
    headStyles: { fillColor: BRAND.purple, textColor: 255, fontStyle: 'bold', fontSize: 8, halign: 'left' },
    alternateRowStyles: { fillColor: BRAND.zebra },
    columnStyles: {
      0: { halign: 'left', fontStyle: 'bold', cellWidth: 90 },
      1: { halign: 'right' }, 2: { halign: 'right' }, 3: { halign: 'right' },
      4: { halign: 'right' }, 5: { halign: 'right' }, 6: { halign: 'right', fontStyle: 'bold' },
    },
    margin: { left: M, right: M, bottom: 40 },
    didDrawPage: () => {
      const pageNum = (doc as any).internal.getNumberOfPages();
      doc.setDrawColor(...BRAND.line);
      doc.setLineWidth(0.5);
      doc.line(M, pageH - 26, pageW - M, pageH - 26);
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(8);
      doc.setTextColor(...BRAND.slate);
      doc.text('Welile SMS Cost Report  ·  Confidential', M, pageH - 14);
      doc.text(`Page ${pageNum}`, pageW - M, pageH - 14, { align: 'right' });
    },
  });

  // ---- By-source breakdown (new page) ------------------------------------
  doc.addPage();
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(13);
  doc.setTextColor(...BRAND.ink);
  doc.text('Cost by source — what the spend was for', M, 40);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(9);
  doc.setTextColor(...BRAND.slate);
  doc.text('Top 30 sources by cost within the reporting window.', M, 56);

  autoTable(doc, {
    startY: 70,
    head: [['Source', 'Messages', 'Segments', 'Cost (UGX)', 'Share of total']],
    body: report.by_source.map((r) => [
      r.source,
      fmt(r.messages),
      fmt(r.segments),
      ugx(r.cost_ugx),
      t.cost_ugx ? `${((r.cost_ugx / t.cost_ugx) * 100).toFixed(1)}%` : '—',
    ]),
    theme: 'grid',
    styles: { fontSize: 8, cellPadding: { top: 5, bottom: 5, left: 7, right: 7 }, lineColor: BRAND.line, lineWidth: 0.5, textColor: BRAND.ink, valign: 'middle' },
    headStyles: { fillColor: BRAND.purpleDark, textColor: 255, fontStyle: 'bold', fontSize: 8, halign: 'left' },
    alternateRowStyles: { fillColor: BRAND.zebra },
    columnStyles: {
      0: { halign: 'left', fontStyle: 'bold' },
      1: { halign: 'right' }, 2: { halign: 'right' }, 3: { halign: 'right', fontStyle: 'bold' }, 4: { halign: 'right' },
    },
    margin: { left: M, right: M, bottom: 40 },
    didDrawPage: () => {
      const pageNum = (doc as any).internal.getNumberOfPages();
      doc.setDrawColor(...BRAND.line);
      doc.setLineWidth(0.5);
      doc.line(M, pageH - 26, pageW - M, pageH - 26);
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(8);
      doc.setTextColor(...BRAND.slate);
      doc.text('Welile SMS Cost Report  ·  Confidential', M, pageH - 14);
      doc.text(`Page ${pageNum}`, pageW - M, pageH - 14, { align: 'right' });
    },
  });

  savePdfWithVault(doc as any, filename, {
    label: 'SMS Cost / Yoola Credit Usage Report',
    category: 'audit',
  });
}
