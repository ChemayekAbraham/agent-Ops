/**
 * Two new branded PDFs for the Calling Center:
 *  - the Received Calls report (calls that came in, exactly as filtered on screen);
 *  - the Calling Center Issues Review, which analyses forwarded concerns from
 *    both outbound and received calls.
 *
 * The existing Tenant Calls Report PDF is untouched; only its visual conventions
 * (header band, metadata card, summary tiles, striped table) are followed here.
 */
import welileLogoUrl from '@/assets/welile-logo.png';

const THEME_PRIMARY: [number, number, number] = [108, 33, 196];
const THEME_PRIMARY_DARK: [number, number, number] = [76, 22, 150];
const THEME_ACCENT: [number, number, number] = [239, 176, 46];
const THEME_INK: [number, number, number] = [37, 31, 48];
const THEME_MUTED: [number, number, number] = [104, 96, 117];
const THEME_BORDER: [number, number, number] = [218, 208, 231];

export interface ConcernPdfMetadata {
  generatedBy: string;
  email: string;
  generatedAt: Date;
  reportPeriod: string;
}

export interface ConcernPdfTile {
  label: string;
  value: string;
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

async function startDoc(title: string, subtitle: string, countLine: string, meta: ConcernPdfMetadata, tiles: ConcernPdfTile[]) {
  const { default: jsPDF } = await import('jspdf');
  const autoTableMod: any = await import('jspdf-autotable');
  const autoTable = autoTableMod.default || autoTableMod;

  const doc = new jsPDF({ unit: 'mm', format: 'a4', orientation: 'landscape' });
  const pageWidth = doc.internal.pageSize.getWidth();
  const margin = 12;
  const logo = await loadLogoBase64();

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
  doc.text('CONFIDENTIAL OPERATIONAL REPORT', pageWidth - margin, 13, { align: 'right' });
  doc.text(countLine, pageWidth - margin, 20, { align: 'right' });

  let y = 38;
  doc.setFillColor(249, 247, 252);
  doc.setDrawColor(...THEME_BORDER);
  doc.roundedRect(margin, y, pageWidth - margin * 2, 22, 2, 2, 'FD');
  doc.setFillColor(...THEME_PRIMARY);
  doc.roundedRect(margin, y, 3, 22, 1.5, 1.5, 'F');
  doc.setTextColor(...THEME_MUTED);
  doc.setFontSize(7.5);
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
    doc.text(k, x, y + 8);
    doc.setTextColor(...THEME_INK);
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(9);
    doc.text(doc.splitTextToSize(String(v), colW - 4)[0] ?? '—', x, y + 14);
    doc.setFontSize(7.5);
  });
  y += 28;

  if (tiles.length) {
    const tileW = (pageWidth - margin * 2 - (tiles.length - 1) * 3) / tiles.length;
    tiles.forEach((t, i) => {
      const x = margin + i * (tileW + 3);
      doc.setFillColor(255, 255, 255);
      doc.setDrawColor(...THEME_BORDER);
      doc.roundedRect(x, y, tileW, 17, 2, 2, 'FD');
      doc.setTextColor(...THEME_MUTED);
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(7);
      doc.text(t.label.toUpperCase(), x + 3, y + 6.5);
      doc.setTextColor(...THEME_INK);
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(11);
      doc.text(t.value, x + 3, y + 13.5);
    });
    y += 23;
  }

  return { doc, autoTable, pageWidth, margin, y };
}

function footer(doc: any, pageWidth: number, margin: number) {
  const pages = doc.internal.getNumberOfPages();
  for (let i = 1; i <= pages; i += 1) {
    doc.setPage(i);
    const h = doc.internal.pageSize.getHeight();
    doc.setDrawColor(...THEME_BORDER);
    doc.line(margin, h - 12, pageWidth - margin, h - 12);
    doc.setTextColor(...THEME_MUTED);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(7.5);
    doc.text('Welile · Tenant Operations · Calling Center', margin, h - 7);
    doc.text(`Page ${i} of ${pages}`, pageWidth - margin, h - 7, { align: 'right' });
  }
}

export interface ReceivedCallPdfRow {
  when: string;
  caller: string;
  phone: string;
  concern: string;
  notes: string;
  status: string;
  followUp: string;
  officer: string;
  forwardedTo: string;
}

export async function generateReceivedCallsPdf(
  rows: ReceivedCallPdfRow[],
  tiles: ConcernPdfTile[],
  meta: ConcernPdfMetadata,
): Promise<Blob> {
  const { doc, autoTable, pageWidth, margin, y } = await startDoc(
    'Received Calls Report',
    'Tenant Operations · Calling Center · calls that came in',
    `${rows.length.toLocaleString()} received call${rows.length === 1 ? '' : 's'}`,
    meta,
    tiles,
  );

  autoTable(doc, {
    startY: y,
    head: [['When', 'Caller', 'Phone', 'Concern', 'Notes', 'Status', 'Follow-up', 'Recorded by', 'Forwarded to']],
    body: rows.map((r) => [r.when, r.caller, r.phone, r.concern, r.notes, r.status, r.followUp, r.officer, r.forwardedTo]),
    styles: { fontSize: 7.5, cellPadding: 2, textColor: THEME_INK, lineColor: THEME_BORDER, lineWidth: 0.1 },
    headStyles: { fillColor: THEME_PRIMARY, textColor: [255, 255, 255], fontStyle: 'bold', fontSize: 7.5 },
    alternateRowStyles: { fillColor: [246, 243, 251] },
    columnStyles: {
      0: { cellWidth: 24 },
      3: { cellWidth: 62 },
      4: { cellWidth: 45 },
    },
    margin: { left: margin, right: margin },
  });

  footer(doc, pageWidth, margin);
  return doc.output('blob');
}

export interface IssuesReviewInput {
  tiles: ConcernPdfTile[];
  bySource: { label: string; count: number; pct: number }[];
  byStatus: { label: string; count: number; pct: number }[];
  byPriority: { label: string; count: number }[];
  byReceiver: {
    name: string;
    total: number;
    completed: number;
    overdue: number;
    avgHours: string;
    reassignedIn?: number;
    onTime?: number;
    avgLate?: string;
  }[];
  repeatThemes: { theme: string; count: number }[];
  deadlinePerformance?: { label: string; value: string }[];
  reassignments?: { when: string; concern: string; from: string; to: string; by: string; reason: string }[];
  rows: {
    when: string;
    source: string;
    title: string;
    caller: string;
    from: string;
    firstTo?: string;
    to: string;
    changes?: string;
    status: string;
    due: string;
    completed: string;
    pastDue?: string;
    outcome: string;
  }[];
  recommendations: { title: string; detail: string }[];
}

export async function generateIssuesReviewPdf(input: IssuesReviewInput, meta: ConcernPdfMetadata): Promise<Blob> {
  const { doc, autoTable, pageWidth, margin, y } = await startDoc(
    'Calling Center Issues Review',
    'Tenant Operations · forwarded concerns from outbound and received calls',
    `${input.rows.length.toLocaleString()} forwarded concern${input.rows.length === 1 ? '' : 's'}`,
    meta,
    input.tiles,
  );

  let cursor = y;

  const section = (label: string) => {
    doc.setTextColor(...THEME_PRIMARY_DARK);
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(10);
    doc.text(label, margin, cursor);
    cursor += 3;
  };

  section('Where the concerns came from and where they stand');
  autoTable(doc, {
    startY: cursor,
    head: [['Source', 'Count', 'Share', 'Status', 'Count', 'Share']],
    body: Array.from({ length: Math.max(input.bySource.length, input.byStatus.length) }).map((_, i) => [
      input.bySource[i]?.label ?? '',
      input.bySource[i] ? String(input.bySource[i].count) : '',
      input.bySource[i] ? `${input.bySource[i].pct}%` : '',
      input.byStatus[i]?.label ?? '',
      input.byStatus[i] ? String(input.byStatus[i].count) : '',
      input.byStatus[i] ? `${input.byStatus[i].pct}%` : '',
    ]),
    styles: { fontSize: 8, cellPadding: 2, textColor: THEME_INK, lineColor: THEME_BORDER, lineWidth: 0.1 },
    headStyles: { fillColor: THEME_PRIMARY, textColor: [255, 255, 255], fontStyle: 'bold', fontSize: 8 },
    alternateRowStyles: { fillColor: [246, 243, 251] },
    margin: { left: margin, right: margin },
  });
  cursor = (doc as any).lastAutoTable.finalY + 8;

  if (input.deadlinePerformance?.length) {
    section('Answer times and how they were kept');
    autoTable(doc, {
      startY: cursor,
      head: [['Measure', 'Result']],
      body: input.deadlinePerformance.map((d) => [d.label, d.value]),
      styles: { fontSize: 8, cellPadding: 2, textColor: THEME_INK, lineColor: THEME_BORDER, lineWidth: 0.1 },
      headStyles: { fillColor: THEME_PRIMARY, textColor: [255, 255, 255], fontStyle: 'bold', fontSize: 8 },
      alternateRowStyles: { fillColor: [246, 243, 251] },
      columnStyles: { 0: { cellWidth: 90 } },
      margin: { left: margin, right: margin },
    });
    cursor = (doc as any).lastAutoTable.finalY + 8;
  }

  if (input.reassignments?.length) {
    if (cursor > doc.internal.pageSize.getHeight() - 60) {
      doc.addPage();
      cursor = 20;
    }
    section('Every change of the person handling a concern');
    autoTable(doc, {
      startY: cursor,
      head: [['When', 'Concern', 'From', 'To', 'Changed by', 'Reason given']],
      body: input.reassignments.map((r) => [r.when, r.concern, r.from, r.to, r.by, r.reason]),
      styles: { fontSize: 7.5, cellPadding: 2, textColor: THEME_INK, lineColor: THEME_BORDER, lineWidth: 0.1 },
      headStyles: { fillColor: THEME_PRIMARY, textColor: [255, 255, 255], fontStyle: 'bold', fontSize: 7.5 },
      alternateRowStyles: { fillColor: [246, 243, 251] },
      columnStyles: { 1: { cellWidth: 60 }, 5: { cellWidth: 70 } },
      margin: { left: margin, right: margin },
    });
    cursor = (doc as any).lastAutoTable.finalY + 8;
  }

  if (input.byReceiver.length) {
    if (cursor > doc.internal.pageSize.getHeight() - 60) {
      doc.addPage();
      cursor = 20;
    }
    section('How each staff member handled what reached them');
    autoTable(doc, {
      startY: cursor,
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
      body: input.byReceiver.map((r) => [
        r.name,
        String(r.total),
        String(r.completed),
        String(r.overdue),
        String(r.onTime ?? '—'),
        r.avgHours,
        r.avgLate ?? '—',
        String(r.reassignedIn ?? 0),
      ]),
      styles: { fontSize: 8, cellPadding: 2, textColor: THEME_INK, lineColor: THEME_BORDER, lineWidth: 0.1 },
      headStyles: { fillColor: THEME_PRIMARY, textColor: [255, 255, 255], fontStyle: 'bold', fontSize: 8 },
      alternateRowStyles: { fillColor: [246, 243, 251] },
      margin: { left: margin, right: margin },
    });
    cursor = (doc as any).lastAutoTable.finalY + 8;
  }

  if (input.repeatThemes.length) {
    section('Concerns that keep coming back');
    autoTable(doc, {
      startY: cursor,
      head: [['Repeated concern', 'Times raised']],
      body: input.repeatThemes.map((t) => [t.theme, String(t.count)]),
      styles: { fontSize: 8, cellPadding: 2, textColor: THEME_INK, lineColor: THEME_BORDER, lineWidth: 0.1 },
      headStyles: { fillColor: THEME_PRIMARY, textColor: [255, 255, 255], fontStyle: 'bold', fontSize: 8 },
      alternateRowStyles: { fillColor: [246, 243, 251] },
      margin: { left: margin, right: margin },
    });
    cursor = (doc as any).lastAutoTable.finalY + 8;
  }

  doc.addPage();
  cursor = 20;
  section('Every forwarded concern in this period');
  autoTable(doc, {
    startY: cursor,
    head: [
      [
        'Forwarded',
        'Source',
        'Concern',
        'Caller',
        'From',
        'First sent to',
        'Now with',
        'Changes',
        'Status',
        'Due',
        'Completed',
        'Past due',
        'What was done',
      ],
    ],
    body: input.rows.map((r) => [
      r.when,
      r.source,
      r.title,
      r.caller,
      r.from,
      r.firstTo ?? r.to,
      r.to,
      r.changes ?? '0',
      r.status,
      r.due,
      r.completed,
      r.pastDue ?? '—',
      r.outcome,
    ]),
    styles: { fontSize: 6.5, cellPadding: 1.6, textColor: THEME_INK, lineColor: THEME_BORDER, lineWidth: 0.1 },
    headStyles: { fillColor: THEME_PRIMARY, textColor: [255, 255, 255], fontStyle: 'bold', fontSize: 6.5 },
    alternateRowStyles: { fillColor: [246, 243, 251] },
    columnStyles: { 2: { cellWidth: 40 }, 12: { cellWidth: 38 } },
    margin: { left: margin, right: margin },
  });
  cursor = (doc as any).lastAutoTable.finalY + 8;

  if (input.recommendations.length) {
    if (cursor > doc.internal.pageSize.getHeight() - 50) {
      doc.addPage();
      cursor = 20;
    }
    section('What this suggests');
    input.recommendations.forEach((r) => {
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

  footer(doc, pageWidth, margin);
  return doc.output('blob');
}
