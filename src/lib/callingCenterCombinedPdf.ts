/**
 * Combined Calling Center Report.
 *
 * One PDF holding BOTH existing reports in full — the Received Calls report and
 * the Issues Review — with an executive summary in front of them.
 *
 * Deliberately self-contained: it copies the visual conventions of
 * `callingCenterConcernPdf.ts` (header band, metadata card, summary tiles,
 * striped tables, footer with pagination) rather than importing its private
 * helpers, so neither existing report can be affected by anything here. No data
 * is summarised away: every column of both reports is carried through.
 */
import welileLogoUrl from '@/assets/welile-logo.png';
import type { ConcernPdfMetadata, ConcernPdfTile, ReceivedCallPdfRow, IssuesReviewInput } from './callingCenterConcernPdf';

const THEME_PRIMARY: [number, number, number] = [108, 33, 196];
const THEME_PRIMARY_DARK: [number, number, number] = [76, 22, 150];
const THEME_ACCENT: [number, number, number] = [239, 176, 46];
const THEME_INK: [number, number, number] = [37, 31, 48];
const THEME_MUTED: [number, number, number] = [104, 96, 117];
const THEME_BORDER: [number, number, number] = [218, 208, 231];
const STRIPE: [number, number, number] = [246, 243, 251];

export interface CombinedCallingCenterInput {
  /** Overall totals across both reports. */
  executiveTiles: ConcernPdfTile[];
  /** Overall figures table: measure → value (+ optional share of its own report). */
  executiveTotals: { label: string; value: string; share?: string }[];
  received: {
    tiles: ConcernPdfTile[];
    byStatus: { label: string; count: number; pct: number }[];
    byOfficer: { name: string; total: number; open: number; resolved: number; forwarded: number }[];
    rows: ReceivedCallPdfRow[];
  };
  issues: IssuesReviewInput;
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

export async function generateCombinedCallingCenterPdf(
  input: CombinedCallingCenterInput,
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
    headStyles: { fillColor: THEME_PRIMARY, textColor: [255, 255, 255] as [number, number, number], fontStyle: 'bold' as const, fontSize: 8 },
    alternateRowStyles: { fillColor: STRIPE },
    margin: { left: margin, right: margin, top: 20, bottom: 18 },
  };

  let cursor = 0;

  /** Purple banner used on the cover and at the top of each major section. */
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
      ['PERIOD', meta.reportPeriod],
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

  /** Section heading, with a page break when there is no room left for a table. */
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

  // =============================================== 1. Executive summary
  banner(
    'Combined Calling Center Report',
    'Tenant Operations · Received Calls and Issues Review in one record',
    'CONFIDENTIAL OPERATIONAL REPORT',
    `${input.received.rows.length.toLocaleString()} received calls · ${input.issues.rows.length.toLocaleString()} forwarded concerns`,
  );
  metaCard();
  tiles(input.executiveTiles);

  section('1 · Executive summary', 60);
  table({
    head: [['Measure', 'Figure', 'Share of its report']],
    body: input.executiveTotals.map((r) => [r.label, r.value, r.share ?? '—']),
    columnStyles: { 0: { cellWidth: 120 } },
  });

  section('Status breakdown — received calls and forwarded concerns side by side', 60);
  table({
    head: [['Received call status', 'Count', 'Share', 'Concern status', 'Count', 'Share']],
    body: Array.from({
      length: Math.max(input.received.byStatus.length, input.issues.byStatus.length),
    }).map((_, i) => [
      input.received.byStatus[i]?.label ?? '',
      input.received.byStatus[i] ? String(input.received.byStatus[i].count) : '',
      input.received.byStatus[i] ? `${input.received.byStatus[i].pct}%` : '',
      input.issues.byStatus[i]?.label ?? '',
      input.issues.byStatus[i] ? String(input.issues.byStatus[i].count) : '',
      input.issues.byStatus[i] ? `${input.issues.byStatus[i].pct}%` : '',
    ]),
  });

  if (input.issues.byPriority.length) {
    section('Concern priority mix', 50);
    table({
      head: [['Priority', 'Concerns']],
      body: input.issues.byPriority.map((p) => [p.label, String(p.count)]),
      columnStyles: { 0: { cellWidth: 90 } },
    });
  }

  // ============================================ 2. Received calls summary
  doc.addPage();
  cursor = 20;
  section('2 · Received Calls — summary', 60);
  tiles(input.received.tiles);
  table({
    head: [['Where each received call stands', 'Count', 'Share of received calls']],
    body: input.received.byStatus.map((s) => [s.label, String(s.count), `${s.pct}%`]),
    columnStyles: { 0: { cellWidth: 120 } },
  });

  if (input.received.byOfficer.length) {
    section('Who recorded the calls that came in', 55);
    table({
      head: [['Recorded by', 'Calls taken', 'Still open', 'Resolved or closed', 'Forwarded to staff']],
      body: input.received.byOfficer.map((o) => [
        o.name,
        String(o.total),
        String(o.open),
        String(o.resolved),
        String(o.forwarded),
      ]),
    });
  }

  // =================================== 3. Complete received calls report
  doc.addPage();
  cursor = 20;
  section('3 · Complete Received Calls report', 30);
  if (!input.received.rows.length) {
    note('No received calls were recorded in this period.');
  } else {
    table({
      head: [['When', 'Caller', 'Phone', 'Concern', 'Notes', 'Status', 'Follow-up', 'Recorded by', 'Forwarded to']],
      body: input.received.rows.map((r) => [
        r.when,
        r.caller,
        r.phone,
        r.concern,
        r.notes,
        r.status,
        r.followUp,
        r.officer,
        r.forwardedTo,
      ]),
      styles: { ...tableBase.styles, fontSize: 7.5 },
      headStyles: { ...tableBase.headStyles, fontSize: 7.5 },
      columnStyles: { 0: { cellWidth: 24 }, 3: { cellWidth: 62 }, 4: { cellWidth: 45 } },
    });
  }

  // ============================================ 4. Issues review summary
  doc.addPage();
  cursor = 20;
  section('4 · Issues Review — summary', 60);
  tiles(input.issues.tiles);

  table({
    head: [['Source', 'Count', 'Share', 'Status', 'Count', 'Share']],
    body: Array.from({ length: Math.max(input.issues.bySource.length, input.issues.byStatus.length) }).map((_, i) => [
      input.issues.bySource[i]?.label ?? '',
      input.issues.bySource[i] ? String(input.issues.bySource[i].count) : '',
      input.issues.bySource[i] ? `${input.issues.bySource[i].pct}%` : '',
      input.issues.byStatus[i]?.label ?? '',
      input.issues.byStatus[i] ? String(input.issues.byStatus[i].count) : '',
      input.issues.byStatus[i] ? `${input.issues.byStatus[i].pct}%` : '',
    ]),
  });

  if (input.issues.deadlinePerformance?.length) {
    section('Answer times and how they were kept', 55);
    table({
      head: [['Measure', 'Result']],
      body: input.issues.deadlinePerformance.map((d) => [d.label, d.value]),
      columnStyles: { 0: { cellWidth: 90 } },
    });
  }

  if (input.issues.byReceiver.length) {
    section('How each staff member handled what reached them', 55);
    table({
      head: [
        [
          'Staff member',
          'Received',
          'Completed',
          'Past due',
          'Answered in time',
          'Average time to complete',
          'Average time past due',
          'Handed to them later',
        ],
      ],
      body: input.issues.byReceiver.map((r) => [
        r.name,
        String(r.total),
        String(r.completed),
        String(r.overdue),
        String(r.onTime ?? '—'),
        r.avgHours,
        r.avgLate ?? '—',
        String(r.reassignedIn ?? 0),
      ]),
    });
  }

  if (input.issues.repeatThemes.length) {
    section('Concerns that keep coming back', 50);
    table({
      head: [['Repeated concern', 'Times raised']],
      body: input.issues.repeatThemes.map((t) => [t.theme, String(t.count)]),
      columnStyles: { 0: { cellWidth: 140 } },
    });
  }

  if (input.issues.reassignments?.length) {
    section('Every change of the person handling a concern', 55);
    table({
      head: [['When', 'Concern', 'From', 'To', 'Changed by', 'Reason given']],
      body: input.issues.reassignments.map((r) => [r.when, r.concern, r.from, r.to, r.by, r.reason]),
      styles: { ...tableBase.styles, fontSize: 7.5 },
      headStyles: { ...tableBase.headStyles, fontSize: 7.5 },
      columnStyles: { 1: { cellWidth: 60 }, 5: { cellWidth: 70 } },
    });
  }

  // ==================================== 5. Complete issues review report
  doc.addPage();
  cursor = 20;
  section('5 · Complete Issues Review report', 30);
  if (!input.issues.rows.length) {
    note('No concerns were forwarded in this period.');
  } else {
    table({
      head: [
        [
          'Forwarded',
          'Source',
          'Concern',
          'Caller',
          'From',
          'First sent to',
          'Now with',
          'Reviewers',
          'Changes',
          'Status',
          'Due',
          'Completed',
          'Past due',
          'What was done',
        ],
      ],
      body: input.issues.rows.map((r) => [
        r.when,
        r.source,
        r.title,
        r.caller,
        r.from,
        r.firstTo ?? r.to,
        r.to,
        r.reviewers ?? r.to,
        r.changes ?? '0',
        r.status,
        r.due,
        r.completed,
        r.pastDue ?? '—',
        r.outcome,
      ]),
      styles: { ...tableBase.styles, fontSize: 6.5, cellPadding: 1.6 },
      headStyles: { ...tableBase.headStyles, fontSize: 6.5 },
      columnStyles: { 2: { cellWidth: 35 }, 7: { cellWidth: 34 }, 13: { cellWidth: 34 } },
    });
  }

  if (input.issues.recommendations.length) {
    section('What this suggests', 50);
    input.issues.recommendations.forEach((r) => {
      if (cursor > pageHeight - 30) {
        doc.addPage();
        cursor = 20;
      }
      doc.setTextColor(...THEME_INK);
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(8.5);
      doc.text(`• ${r.title}`, margin, cursor + 4);
      doc.setFont('helvetica', 'normal');
      doc.setTextColor(...THEME_MUTED);
      doc.setFontSize(8);
      const lines = doc.splitTextToSize(r.detail, pageWidth - margin * 2 - 6);
      doc.text(lines, margin + 4, cursor + 9);
      cursor += 9 + lines.length * 4;
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
    doc.text('Welile · Tenant Operations · Calling Center · Combined Report', margin, pageHeight - 7);
    doc.text(`Page ${i} of ${pages}`, pageWidth - margin, pageHeight - 7, { align: 'right' });
  }

  return doc.output('blob');
}
