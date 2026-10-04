import { format, parseISO } from 'date-fns';
import { formatUGX } from '@/lib/rentCalculations';

export interface ArchivedReportMeta {
  id: string;
  source: string | null;
  source_label: string | null;
  granularity: string | null;
  period_start: string | null;
  period_end: string | null;
  title: string | null;
  submitted_by_name: string | null;
  submitted_at: string;
}

const MUTED: [number, number, number] = [107, 114, 128];
const INK: [number, number, number] = [17, 24, 39];

function money(v: unknown): string {
  if (v === null || v === undefined || v === '') return '\u2014';
  const n = Number(v);
  if (!Number.isFinite(n)) return '\u2014';
  return formatUGX(n);
}

function pct(v: unknown): string {
  if (v === null || v === undefined || v === '') return '\u2014';
  const n = Number(v);
  if (!Number.isFinite(n)) return '\u2014';
  return `${n.toFixed(1)}%`;
}

/** Build and download a printable copy of an archived report. */
export async function downloadArchivedReportPdf(
  meta: ArchivedReportMeta,
  payload: Record<string, unknown> | null,
): Promise<void> {
  const { jsPDF } = await import('jspdf');
  const autoTableMod: any = await import('jspdf-autotable');
  const autoTable = autoTableMod.default ?? autoTableMod;

  const doc = new jsPDF({ orientation: 'portrait', unit: 'pt', format: 'a4' });
  const pageWidth = doc.internal.pageSize.getWidth();
  const pageHeight = doc.internal.pageSize.getHeight();
  const marginX = 48;
  const contentWidth = pageWidth - marginX * 2;

  const title = meta.title || 'Archived report';

  // 1. Title
  doc.setFontSize(15);
  doc.setFont('helvetica', 'bold');
  doc.setTextColor(...INK);
  doc.text(title, pageWidth / 2, 48, { align: 'center', maxWidth: contentWidth });

  // 2 & 3. Context lines
  doc.setFontSize(9.5);
  doc.setFont('helvetica', 'normal');
  doc.setTextColor(...MUTED);
  doc.text(
    `${meta.source_label ?? meta.source ?? '\u2014'} · ${meta.period_start ?? '\u2014'} to ${meta.period_end ?? '\u2014'}`,
    pageWidth / 2,
    66,
    { align: 'center' },
  );
  let submittedAt = meta.submitted_at;
  try {
    submittedAt = format(parseISO(meta.submitted_at), 'dd MMM yyyy HH:mm');
  } catch {
    /* keep raw */
  }
  doc.text(
    `Submitted by ${meta.submitted_by_name ?? 'Unknown'} on ${submittedAt}`,
    pageWidth / 2,
    80,
    { align: 'center' },
  );

  // 4. Rule
  doc.setDrawColor(203, 213, 225);
  doc.line(marginX, 92, pageWidth - marginX, 92);

  let cursorY = 112;

  const ensureRoom = (needed: number) => {
    if (cursorY + needed > pageHeight - 48) {
      doc.addPage();
      cursorY = 56;
    }
  };

  const heading = (text: string) => {
    ensureRoom(40);
    doc.setFontSize(11);
    doc.setFont('helvetica', 'bold');
    doc.setTextColor(...INK);
    doc.text(text, marginX, cursorY);
    cursorY += 14;
  };

  const zoneA = (payload?.zone_a ?? null) as Record<string, unknown> | null;
  const narrative = typeof payload?.narrative === 'string' ? (payload.narrative as string) : '';
  const actions = Array.isArray(payload?.actions) ? (payload!.actions as Record<string, unknown>[]) : [];
  const carried = Array.isArray(payload?.carried_close_outs)
    ? (payload!.carried_close_outs as Record<string, unknown>[])
    : [];

  // 5. Figures
  if (zoneA) {
    autoTable(doc, {
      startY: cursorY,
      margin: { left: marginX, right: marginX, top: 56, bottom: 48 },
      body: [
        ['Collected', money(zoneA.collected_ugx)],
        ['Scheduled due', money(zoneA.scheduled_due_ugx)],
        ['Collection rate', pct(zoneA.collection_rate_pct)],
        ['Threshold', pct(zoneA.threshold_pct)],
        ['Arrears brought forward', money(zoneA.arrears_target_ugx)],
        ['Arrears outstanding', money(zoneA.arrears_outstanding_ugx)],
      ],
      styles: { fontSize: 9.5, cellPadding: 5, overflow: 'linebreak' },
      columnStyles: {
        0: { cellWidth: contentWidth * 0.6, textColor: MUTED },
        1: { halign: 'right', fontStyle: 'bold' },
      },
      theme: 'grid',
    });
    cursorY = ((doc as any).lastAutoTable?.finalY ?? cursorY) + 24;
  }

  // 6. Narrative
  if (narrative.trim().length > 0) {
    heading('Why these numbers');
    doc.setFontSize(9.5);
    doc.setFont('helvetica', 'normal');
    doc.setTextColor(...INK);
    const lines: string[] = doc.splitTextToSize(narrative, contentWidth);
    for (const line of lines) {
      ensureRoom(16);
      doc.text(line, marginX, cursorY);
      cursorY += 13;
    }
    cursorY += 14;
  }

  // 7. Actions
  if (actions.length > 0) {
    heading('Actions');
    autoTable(doc, {
      startY: cursorY,
      margin: { left: marginX, right: marginX, top: 56, bottom: 48 },
      head: [['Action', 'Owner', 'Due']],
      body: actions.map((a) => [
        String(a.item_text ?? '\u2014'),
        String(a.owner_label ?? '\u2014'),
        String(a.due_date ?? '\u2014'),
      ]),
      showHead: 'everyPage',
      styles: { fontSize: 9, cellPadding: 5, overflow: 'linebreak' },
      headStyles: { fillColor: [31, 41, 55], textColor: 255, fontStyle: 'bold' },
      columnStyles: { 0: { cellWidth: contentWidth * 0.55 } },
    });
    cursorY = ((doc as any).lastAutoTable?.finalY ?? cursorY) + 24;
  }

  // 8. Carried actions
  if (carried.length > 0) {
    heading('Carried actions');
    autoTable(doc, {
      startY: cursorY,
      margin: { left: marginX, right: marginX, top: 56, bottom: 48 },
      head: [['Action', 'Outcome', 'Note']],
      body: carried.map((c) => [
        String(c.item_text ?? '\u2014'),
        String(c.outcome ?? '\u2014'),
        String(c.outcome_note ?? '\u2014'),
      ]),
      showHead: 'everyPage',
      styles: { fontSize: 9, cellPadding: 5, overflow: 'linebreak' },
      headStyles: { fillColor: [31, 41, 55], textColor: 255, fontStyle: 'bold' },
      columnStyles: { 0: { cellWidth: contentWidth * 0.45 } },
    });
    cursorY = ((doc as any).lastAutoTable?.finalY ?? cursorY) + 24;
  }

  // 9. Fallback
  if (!zoneA && narrative.trim().length === 0 && actions.length === 0 && carried.length === 0) {
    doc.setFontSize(8.5);
    doc.setFont('courier', 'normal');
    doc.setTextColor(...INK);
    const raw = JSON.stringify(payload ?? {}, null, 2);
    const lines: string[] = doc.splitTextToSize(raw, contentWidth);
    for (const line of lines) {
      ensureRoom(14);
      doc.text(line, marginX, cursorY);
      cursorY += 11;
    }
  }

  // 10. Footer — page count read only once the document is complete.
  const totalPages = doc.getNumberOfPages();
  for (let page = 1; page <= totalPages; page++) {
    doc.setPage(page);
    doc.setFontSize(8);
    doc.setFont('helvetica', 'normal');
    doc.setTextColor(...MUTED);
    doc.text(
      `Welile Technologies · ${title} · page ${page} of ${totalPages}`,
      pageWidth / 2,
      pageHeight - 20,
      { align: 'center' },
    );
  }

  const slug = (v: string | null | undefined, fallback: string) =>
    (v ?? fallback).toString().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || fallback;

  doc.save(
    `welile-report-${slug(meta.source, 'report')}-${slug(meta.granularity, 'period')}-${meta.period_start ?? 'undated'}.pdf`,
  );
}
