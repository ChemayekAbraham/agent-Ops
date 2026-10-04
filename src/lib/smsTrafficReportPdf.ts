/**
 * Professional SMS / OTP Traffic Report PDF.
 *
 * A polished, board-ready alternative to the generic audit export used by the
 * CTO Communications dashboard. Features a branded header band, a KPI summary
 * strip, a cleanly typeset table with right-aligned numerics and a coloured
 * success-rate column, and a consistent footer with page numbers.
 *
 * jspdf + jspdf-autotable are imported dynamically so the chunk only ships
 * when an operator actually generates a report.
 */
import { savePdfWithVault } from '@/lib/pdfVault';

export interface SmsTrafficDay {
  day: string;        // yyyy-MM-dd
  total: number;
  delivered: number;
  failed: number;
  yoola: number;
  at: number;
  other: number;
}

export interface SmsTrafficReportMeta {
  /** Human window label, e.g. "Last 90 days" or "June 2026". */
  windowLabel: string;
  /** Range subline, e.g. "04 Apr 2026 → 02 Jul 2026". */
  rangeLabel?: string;
  /** Quick today/week context line. */
  contextLabel?: string;
}

const BRAND = {
  purple: [124, 58, 237] as [number, number, number],
  purpleDark: [76, 29, 149] as [number, number, number],
  ink: [30, 27, 45] as [number, number, number],
  slate: [100, 116, 139] as [number, number, number],
  line: [226, 232, 240] as [number, number, number],
  green: [16, 122, 87] as [number, number, number],
  amber: [180, 83, 9] as [number, number, number],
  red: [190, 40, 40] as [number, number, number],
  zebra: [248, 247, 252] as [number, number, number],
  cardBg: [249, 248, 253] as [number, number, number],
};

function fmt(n: number) {
  return (n || 0).toLocaleString();
}

export async function downloadSmsTrafficPdf(
  filename: string,
  rows: SmsTrafficDay[],
  meta: SmsTrafficReportMeta,
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

  const generatedAt =
    new Date().toISOString().replace('T', ' ').slice(0, 16) + ' UTC';

  // Aggregate totals for the KPI strip.
  const totals = rows.reduce(
    (s, r) => {
      s.total += r.total;
      s.delivered += r.delivered;
      s.failed += r.failed;
      s.yoola += r.yoola;
      s.at += r.at;
      s.other += r.other;
      return s;
    },
    { total: 0, delivered: 0, failed: 0, yoola: 0, at: 0, other: 0 },
  );
  const successPct = totals.total
    ? Math.round((totals.delivered / totals.total) * 100)
    : 0;

  // ---- Header band -------------------------------------------------------
  const bandH = 74;
  doc.setFillColor(...BRAND.purple);
  doc.rect(0, 0, pageW, bandH, 'F');
  // subtle darker accent stripe
  doc.setFillColor(...BRAND.purpleDark);
  doc.rect(0, bandH - 4, pageW, 4, 'F');

  doc.setTextColor(255, 255, 255);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(19);
  doc.text('SMS / OTP Traffic Report', M, 34);

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(10);
  doc.setTextColor(235, 228, 252);
  doc.text('Welile Technologies  ·  CTO Communications', M, 52);

  // Right-aligned brand mark + generated stamp
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(13);
  doc.setTextColor(255, 255, 255);
  doc.text('WELILE', pageW - M, 32, { align: 'right' });
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(8.5);
  doc.setTextColor(235, 228, 252);
  doc.text(`Generated ${generatedAt}`, pageW - M, 48, { align: 'right' });
  doc.text(meta.windowLabel, pageW - M, 60, { align: 'right' });

  // ---- KPI summary cards -------------------------------------------------
  const cardY = bandH + 18;
  const cardH = 52;
  const gap = 12;
  const cards: { label: string; value: string; accent: [number, number, number] }[] = [
    { label: 'Total messages', value: fmt(totals.total), accent: BRAND.purple },
    { label: 'Delivered', value: `${fmt(totals.delivered)}  (${successPct}%)`, accent: BRAND.green },
    { label: 'Failed', value: fmt(totals.failed), accent: BRAND.red },
    { label: 'Yoola', value: fmt(totals.yoola), accent: BRAND.purpleDark },
    { label: "Africa's Talking", value: fmt(totals.at), accent: BRAND.amber },
    { label: 'Days covered', value: fmt(rows.length), accent: BRAND.slate },
  ];
  const cardW = (pageW - M * 2 - gap * (cards.length - 1)) / cards.length;
  cards.forEach((c, i) => {
    const x = M + i * (cardW + gap);
    doc.setFillColor(...BRAND.cardBg);
    doc.setDrawColor(...BRAND.line);
    doc.roundedRect(x, cardY, cardW, cardH, 6, 6, 'FD');
    // accent tab
    doc.setFillColor(...c.accent);
    doc.roundedRect(x, cardY, 4, cardH, 2, 2, 'F');
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(7.5);
    doc.setTextColor(...BRAND.slate);
    doc.text(c.label.toUpperCase(), x + 12, cardY + 18);
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(13);
    doc.setTextColor(...BRAND.ink);
    doc.text(c.value, x + 12, cardY + 38);
  });

  // ---- Context / range line ---------------------------------------------
  let cursorY = cardY + cardH + 20;
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(9);
  doc.setTextColor(...BRAND.ink);
  doc.text('Reporting window', M, cursorY);
  doc.setFont('helvetica', 'normal');
  doc.setTextColor(...BRAND.slate);
  const winLine = meta.rangeLabel
    ? `${meta.windowLabel}  ·  ${meta.rangeLabel}`
    : meta.windowLabel;
  doc.text(winLine, M + 96, cursorY);
  if (meta.contextLabel) {
    cursorY += 13;
    doc.setFont('helvetica', 'bold');
    doc.setTextColor(...BRAND.ink);
    doc.text('Recent activity', M, cursorY);
    doc.setFont('helvetica', 'normal');
    doc.setTextColor(...BRAND.slate);
    doc.text(meta.contextLabel, M + 96, cursorY);
  }
  cursorY += 16;

  // ---- Table -------------------------------------------------------------
  const head = [[
    'Date', 'Total', 'Delivered', 'Failed', 'Success %', 'Yoola', "Africa's Talking", 'Other',
  ]];
  const body = rows.map((r) => {
    const pct = r.total ? Math.round((r.delivered / r.total) * 100) : null;
    return [
      r.day,
      fmt(r.total),
      fmt(r.delivered),
      fmt(r.failed),
      pct === null ? '—' : `${pct}%`,
      fmt(r.yoola),
      fmt(r.at),
      fmt(r.other),
    ];
  });

  autoTable(doc, {
    startY: cursorY,
    head,
    body,
    theme: 'grid',
    styles: {
      fontSize: 8,
      cellPadding: { top: 5, bottom: 5, left: 7, right: 7 },
      lineColor: BRAND.line,
      lineWidth: 0.5,
      textColor: BRAND.ink,
      valign: 'middle',
    },
    headStyles: {
      fillColor: BRAND.purple,
      textColor: 255,
      fontStyle: 'bold',
      fontSize: 8,
      halign: 'left',
    },
    alternateRowStyles: { fillColor: BRAND.zebra },
    columnStyles: {
      0: { halign: 'left', fontStyle: 'bold', cellWidth: 90 },
      1: { halign: 'right' },
      2: { halign: 'right' },
      3: { halign: 'right' },
      4: { halign: 'right', fontStyle: 'bold' },
      5: { halign: 'right' },
      6: { halign: 'right' },
      7: { halign: 'right' },
    },
    margin: { left: M, right: M, bottom: 40 },
    // Colour the success-% cell by health band.
    didParseCell: (data: any) => {
      if (data.section === 'body' && data.column.index === 4) {
        const raw = String(data.cell.raw || '').replace('%', '');
        const pct = Number(raw);
        if (!Number.isNaN(pct)) {
          if (pct >= 90) data.cell.styles.textColor = BRAND.green;
          else if (pct >= 70) data.cell.styles.textColor = BRAND.amber;
          else data.cell.styles.textColor = BRAND.red;
        }
      }
      if (data.section === 'body' && data.column.index === 3) {
        const n = Number(String(data.cell.raw || '').replace(/,/g, ''));
        if (n > 0) data.cell.styles.textColor = BRAND.red;
      }
    },
    didDrawPage: () => {
      const pageNum = (doc as any).internal.getNumberOfPages();
      doc.setDrawColor(...BRAND.line);
      doc.setLineWidth(0.5);
      doc.line(M, pageH - 26, pageW - M, pageH - 26);
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(8);
      doc.setTextColor(...BRAND.slate);
      doc.text('Welile SMS / OTP Traffic  ·  Confidential', M, pageH - 14);
      doc.text(`Page ${pageNum}`, pageW - M, pageH - 14, { align: 'right' });
    },
  });

  savePdfWithVault(doc as any, filename, {
    label: 'SMS / OTP Traffic Report',
    category: 'audit',
  });
}
