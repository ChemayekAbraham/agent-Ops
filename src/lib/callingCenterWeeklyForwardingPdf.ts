/**
 * Weekly Staff Forwarding Report (Wednesday → Tuesday).
 *
 * A separate, additive PDF for the Tenant Operations Calling Center. It copies
 * the visual conventions of `callingCenterCombinedPdf.ts` — purple header band,
 * metadata card, summary tiles, striped tables, footer with pagination — rather
 * than importing its internals, so no existing report can be affected by
 * anything here.
 *
 * The first section is always the staff × day matrix: one row per staff member,
 * one column per day of the selected Wednesday–Tuesday week, a weekly total per
 * staff member, then a "Daily total" row and a "Grand total" figure. Every
 * concern is counted once, against the staff member it was forwarded to, so a
 * concern later shared with more reviewers is never double-counted.
 */
import welileLogoUrl from '@/assets/welile-logo.png';
import type { ConcernPdfMetadata, ConcernPdfTile } from './callingCenterConcernPdf';

const THEME_PRIMARY: [number, number, number] = [108, 33, 196];
const THEME_PRIMARY_DARK: [number, number, number] = [76, 22, 150];
const THEME_ACCENT: [number, number, number] = [239, 176, 46];
const THEME_INK: [number, number, number] = [37, 31, 48];
const THEME_MUTED: [number, number, number] = [104, 96, 117];
const THEME_BORDER: [number, number, number] = [218, 208, 231];
const STRIPE: [number, number, number] = [246, 243, 251];

/** One staff member and what reached them on each day of the week. */
export interface WeeklyForwardingStaffRow {
  name: string;
  /** Per-day counts, in the same order as `dayLabels`. */
  perDay: number[];
  /** Made + received for the whole week — the row's own total. */
  total: number;
  fromMade: number;
  fromReceived: number;
}

export interface WeeklyForwardingInput {
  /** Short column headers, Wednesday first (e.g. "Wed 17 Sep"). */
  dayLabels: string[];
  rows: WeeklyForwardingStaffRow[];
  /** Total forwarded across all staff, per day. */
  dailyTotals: number[];
  /** Every forwarded concern in the week, counted once. */
  grandTotal: number;
  tiles: ConcernPdfTile[];
  /** Measure → value insight table. */
  insights: { label: string; value: string }[];
  /** Day-by-day view with the made/received split. */
  perDayBreakdown: { day: string; made: number; received: number; total: number; share: string }[];
  note: string;
}

async function loadLogoBase64(): Promise<string | null> {
  try {
    const res = await fetch(welileLogoUrl);
    const blob = await res.blob();
    return new Promise((resolve) => {
      const reader = new FileReader();
      reader.onloadend = () => resolve(reader.result as string);
      reader.onerror = () => resolve(null);
      reader.readAsDataURL(blob);
    });
  } catch {
    return null;
  }
}

const stamp = (d: Date) =>
  d.toLocaleString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });

export async function generateWeeklyForwardingPdf(
  input: WeeklyForwardingInput,
  meta: ConcernPdfMetadata,
): Promise<Blob> {
  const { default: jsPDF } = await import('jspdf');
  const autoTableMod: any = await import('jspdf-autotable');
  const autoTable = autoTableMod.default || autoTableMod;

  const doc = new jsPDF({ unit: 'mm', format: 'a4', orientation: 'landscape' });
  const pageWidth = doc.internal.pageSize.getWidth();
  const pageHeight = doc.internal.pageSize.getHeight();
  const margin = 12;
  const logo = await loadLogoBase64();

  const tableBase = {
    styles: { fontSize: 8, cellPadding: 2, textColor: THEME_INK, lineColor: THEME_BORDER, lineWidth: 0.1 },
    headStyles: {
      fillColor: THEME_PRIMARY,
      textColor: [255, 255, 255] as [number, number, number],
      fontStyle: 'bold' as const,
      fontSize: 8,
    },
    alternateRowStyles: { fillColor: STRIPE },
    margin: { left: margin, right: margin, top: 20, bottom: 18 },
  };

  let cursor = 0;

  const banner = (title: string, subtitle: string, rightTop: string, rightBottom: string) => {
    doc.setFillColor(...THEME_PRIMARY_DARK);
    doc.rect(0, 0, pageWidth, 31, 'F');
    doc.setFillColor(...THEME_PRIMARY);
    doc.rect(0, 0, 5, 31, 'F');
    doc.setFillColor(...THEME_ACCENT);
    doc.rect(0, 29, pageWidth, 2, 'F');
    if (logo) {
      try {
        doc.addImage(logo, 'PNG', margin, 6.5, 17, 17);
      } catch {
        /* ignore */
      }
    }
    const hx = logo ? margin + 21 : margin;
    doc.setTextColor(255, 255, 255);
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(16);
    doc.text(title, hx, 13);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(9);
    doc.text(subtitle, hx, 19);
    doc.setFontSize(8);
    doc.text(rightTop, pageWidth - margin, 13, { align: 'right' });
    doc.text(rightBottom, pageWidth - margin, 20, { align: 'right' });
    cursor = 38;
  };

  const metaCard = () => {
    doc.setFillColor(249, 247, 252);
    doc.setDrawColor(...THEME_BORDER);
    doc.roundedRect(margin, cursor, pageWidth - margin * 2, 22, 2, 2, 'FD');
    doc.setFillColor(...THEME_PRIMARY);
    doc.roundedRect(margin, cursor, 3, 22, 1.5, 1.5, 'F');
    const cols = [
      ['WEEK (WED - TUE)', meta.reportPeriod],
      ['PREPARED BY', meta.generatedBy],
      ['CONTACT', meta.email],
      ['GENERATED', stamp(meta.generatedAt)],
    ];
    const colW = (pageWidth - margin * 2 - 8) / cols.length;
    cols.forEach(([k, v], i) => {
      const x = margin + 6 + i * colW;
      doc.setTextColor(...THEME_MUTED);
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(7.5);
      doc.text(k, x, cursor + 8);
      doc.setTextColor(...THEME_INK);
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(9);
      doc.text(doc.splitTextToSize(String(v), colW - 4)[0] ?? '—', x, cursor + 14);
    });
    cursor += 28;
  };

  const tiles = (list: ConcernPdfTile[]) => {
    if (!list.length) return;
    const tileW = (pageWidth - margin * 2 - (list.length - 1) * 3) / list.length;
    list.forEach((t, i) => {
      const x = margin + i * (tileW + 3);
      doc.setFillColor(255, 255, 255);
      doc.setDrawColor(...THEME_BORDER);
      doc.roundedRect(x, cursor, tileW, 17, 2, 2, 'FD');
      doc.setTextColor(...THEME_MUTED);
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(7);
      doc.text(doc.splitTextToSize(t.label.toUpperCase(), tileW - 5)[0] ?? '', x + 3, cursor + 6.5);
      doc.setTextColor(...THEME_INK);
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(11);
      doc.text(t.value, x + 3, cursor + 13.5);
    });
    cursor += 23;
  };

  const section = (label: string, needed = 40) => {
    if (cursor > pageHeight - needed) {
      doc.addPage();
      cursor = 20;
    }
    doc.setTextColor(...THEME_PRIMARY_DARK);
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(10.5);
    doc.text(label, margin, cursor);
    cursor += 3.5;
  };

  const note = (text: string) => {
    doc.setTextColor(...THEME_MUTED);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(8);
    const lines = doc.splitTextToSize(text, pageWidth - margin * 2);
    doc.text(lines, margin, cursor + 3);
    cursor += 3 + lines.length * 3.8 + 2;
  };

  const table = (opts: Record<string, any>) => {
    autoTable(doc, { ...tableBase, ...opts, startY: cursor });
    cursor = (doc as any).lastAutoTable.finalY + 8;
  };

  banner(
    'Weekly Staff Forwarding Report',
    'Tenant Operations · Calling Center · concerns forwarded to staff, Wednesday to Tuesday',
    'CONFIDENTIAL OPERATIONAL REPORT',
    `${input.grandTotal.toLocaleString()} forwarded · ${input.rows.length.toLocaleString()} staff member${input.rows.length === 1 ? '' : 's'}`,
  );
  metaCard();

  // ==================================== 1. Staff × day matrix (first section)
  section('1 · Forwarded to staff, day by day', 70);
  note(input.note);
  if (!input.rows.length) {
    note('No concern was forwarded to any staff member in this week.');
  } else {
    const body: string[][] = input.rows.map((r) => [
      r.name,
      ...r.perDay.map((n) => (n ? String(n) : '—')),
      String(r.total),
    ]);
    body.push(['Daily total — all staff', ...input.dailyTotals.map((n) => String(n)), String(input.grandTotal)]);
    body.push([
      'Grand total — whole week',
      ...input.dayLabels.map(() => ''),
      String(input.grandTotal),
    ]);
    const lastTwo = body.length - 2;
    const dayCols: Record<number, any> = {};
    input.dayLabels.forEach((_, i) => {
      dayCols[i + 1] = { halign: 'center', cellWidth: 20 };
    });
    table({
      head: [['Staff member', ...input.dayLabels, 'Weekly total']],
      body,
      styles: { ...tableBase.styles, fontSize: 8 },
      headStyles: { ...tableBase.headStyles, fontSize: 7.5, halign: 'center' },
      columnStyles: {
        0: { cellWidth: 55, halign: 'left' },
        ...dayCols,
        [input.dayLabels.length + 1]: { halign: 'center', fontStyle: 'bold', cellWidth: 24 },
      },
      didParseCell: (data: any) => {
        if (data.section === 'head' && data.column.index === 0) data.cell.styles.halign = 'left';
        if (data.section !== 'body') return;
        if (data.row.index >= lastTwo) {
          data.cell.styles.fontStyle = 'bold';
          data.cell.styles.fillColor = data.row.index === lastTwo ? STRIPE : [237, 229, 249];
          if (data.column.index === 0) data.cell.styles.halign = 'left';
        }
      },
    });
  }

  // ==================================================== 2. Week at a glance
  section('2 · Week at a glance', 60);
  tiles(input.tiles);
  table({
    head: [['Measure', 'Figure']],
    body: input.insights.map((r) => [r.label, r.value]),
    columnStyles: { 0: { cellWidth: 140 } },
  });

  // ============================================= 3. Each day of the week
  section('3 · Each day of the week — where the forwarded work came from', 60);
  table({
    head: [['Day', 'From calls we made', 'From calls that came in', 'Total forwarded', 'Share of the week']],
    body: [
      ...input.perDayBreakdown.map((d) => [d.day, String(d.made), String(d.received), String(d.total), d.share]),
      [
        'Whole week',
        String(input.perDayBreakdown.reduce((a, d) => a + d.made, 0)),
        String(input.perDayBreakdown.reduce((a, d) => a + d.received, 0)),
        String(input.grandTotal),
        '100%',
      ],
    ],
    columnStyles: { 0: { cellWidth: 55 } },
    didParseCell: (data: any) => {
      if (data.section === 'body' && data.row.index === input.perDayBreakdown.length) {
        data.cell.styles.fontStyle = 'bold';
        data.cell.styles.fillColor = STRIPE;
      }
    },
  });

  // ============================================= 4. Staff weekly totals
  if (input.rows.length) {
    section('4 · Weekly total for each staff member', 60);
    table({
      head: [['Staff member', 'From calls we made', 'From calls that came in', 'Weekly total', 'Share of the week']],
      body: input.rows.map((r) => [
        r.name,
        String(r.fromMade),
        String(r.fromReceived),
        String(r.total),
        input.grandTotal ? `${Math.round((r.total / input.grandTotal) * 100)}%` : '0%',
      ]),
      columnStyles: { 0: { cellWidth: 70 } },
    });
  }

  // =========================================================== Footer
  const pages = (doc.internal as any).getNumberOfPages();
  for (let i = 1; i <= pages; i += 1) {
    doc.setPage(i);
    doc.setDrawColor(...THEME_BORDER);
    doc.line(margin, pageHeight - 12, pageWidth - margin, pageHeight - 12);
    doc.setTextColor(...THEME_MUTED);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(7.5);
    doc.text('Welile · Tenant Operations · Calling Center · Weekly Staff Forwarding Report', margin, pageHeight - 7);
    doc.text(`Page ${i} of ${pages}`, pageWidth - margin, pageHeight - 7, { align: 'right' });
  }

  return doc.output('blob');
}
