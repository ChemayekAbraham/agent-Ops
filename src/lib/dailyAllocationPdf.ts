import { format } from 'date-fns';
import { formatUGX } from '@/lib/rentCalculations';

export interface AllocationRow {
  name: string;
  property?: string;
  daily: number;        // expected to collect today
  outstanding: number;  // total still owed
  paid: number;         // total paid so far
}

export interface DailyAllocationPdfData {
  agentName?: string;
  agentPhone?: string;
  rows: AllocationRow[];
  collectedToday?: number;
  tenantsCollectedToday?: number;
}

/**
 * A plain, manager/supporter-friendly "Daily Allocation Report" — one row per
 * tenant the agent is responsible for, with what is due today and what is still
 * outstanding, plus a clear top summary. Kept simple on purpose so it reads well
 * on a phone or when forwarded over WhatsApp/email.
 */
export async function generateDailyAllocationPdf(data: DailyAllocationPdfData): Promise<Uint8Array> {
  const { jsPDF } = await import('jspdf');
  const doc = new jsPDF();
  const pageWidth = doc.internal.pageSize.getWidth();

  const rows = data.rows;
  const totalToCollect = rows.reduce((s, r) => s + Math.max(0, r.outstanding), 0);
  const totalPaid = rows.reduce((s, r) => s + Math.max(0, r.paid), 0);
  const totalDueToday = rows.reduce((s, r) => s + Math.max(0, r.daily), 0);
  const owingCount = rows.filter(r => r.outstanding > 0).length;

  // ─── Header ───────────────────────────────────────────────
  doc.setFillColor(34, 197, 94);
  doc.rect(0, 0, pageWidth, 30, 'F');
  doc.setTextColor(255, 255, 255);
  doc.setFontSize(16);
  doc.setFont('helvetica', 'bold');
  doc.text('WELILE PLATFORM', pageWidth / 2, 12, { align: 'center' });
  doc.setFontSize(10);
  doc.setFont('helvetica', 'normal');
  doc.text('Daily Allocation Report', pageWidth / 2, 21, { align: 'center' });
  doc.setFontSize(8);
  doc.text(`Generated: ${format(new Date(), 'EEEE, MMMM d, yyyy HH:mm')}`, pageWidth / 2, 27, { align: 'center' });

  doc.setTextColor(30, 30, 30);

  // ─── Agent line ───────────────────────────────────────────
  let y = 38;
  if (data.agentName || data.agentPhone) {
    doc.setFontSize(9);
    doc.setFont('helvetica', 'bold');
    doc.text('Agent:', 14, y);
    doc.setFont('helvetica', 'normal');
    doc.text(`${data.agentName || 'N/A'}${data.agentPhone ? ` (${data.agentPhone})` : ''}`, 32, y);
    y += 8;
  }

  // ─── Summary cards ────────────────────────────────────────
  const cardGap = 4;
  const cardW = (pageWidth - 28 - cardGap * 2) / 3;
  const cards: [string, string, [number, number, number]][] = [
    ['Due today', formatUGX(totalDueToday), [202, 138, 4]],
    ['Still to collect', formatUGX(totalToCollect), [220, 38, 38]],
    ['Collected (total)', formatUGX(totalPaid), [22, 163, 74]],
  ];
  cards.forEach(([label, value, color], i) => {
    const x = 14 + i * (cardW + cardGap);
    doc.setFillColor(248, 250, 252);
    doc.roundedRect(x, y, cardW, 18, 2, 2, 'F');
    doc.setFontSize(7);
    doc.setTextColor(110, 110, 110);
    doc.setFont('helvetica', 'bold');
    doc.text(label.toUpperCase(), x + 3, y + 6);
    doc.setFontSize(10);
    doc.setTextColor(color[0], color[1], color[2]);
    doc.text(value, x + 3, y + 13);
  });
  y += 24;

  doc.setTextColor(30, 30, 30);
  doc.setFontSize(8);
  doc.setFont('helvetica', 'normal');
  const subLine = `${rows.length} tenant${rows.length === 1 ? '' : 's'}  •  ${owingCount} owing` +
    (data.collectedToday != null
      ? `  •  Collected today: ${formatUGX(data.collectedToday)} from ${data.tenantsCollectedToday ?? 0} tenant${(data.tenantsCollectedToday ?? 0) === 1 ? '' : 's'}`
      : '');
  doc.text(subLine, 14, y);
  y += 8;

  // ─── Table header ─────────────────────────────────────────
  const colName = 16;
  const colProp = 70;
  const colDaily = 128;
  const colOut = 165;
  doc.setFillColor(34, 197, 94);
  doc.rect(14, y, pageWidth - 28, 7, 'F');
  doc.setTextColor(255, 255, 255);
  doc.setFontSize(8);
  doc.setFont('helvetica', 'bold');
  doc.text('Tenant', colName, y + 4.5);
  doc.text('Property', colProp, y + 4.5);
  doc.text('Due today', colDaily, y + 4.5);
  doc.text('Outstanding', colOut, y + 4.5);
  y += 7;

  doc.setTextColor(30, 30, 30);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(8);

  const truncate = (s: string, max: number) => (s.length > max ? `${s.slice(0, max - 1)}…` : s);

  rows.forEach((r, i) => {
    if (y > 272) {
      doc.addPage();
      y = 15;
    }
    doc.setFillColor(i % 2 === 0 ? 249 : 255, i % 2 === 0 ? 250 : 255, i % 2 === 0 ? 251 : 255);
    doc.rect(14, y - 3, pageWidth - 28, 6.5, 'F');

    doc.setTextColor(30, 30, 30);
    doc.text(truncate(r.name || 'Tenant', 30), colName, y + 1);
    doc.setTextColor(100, 100, 100);
    doc.text(truncate(r.property || '—', 30), colProp, y + 1);
    doc.setTextColor(202, 138, 4);
    doc.text(r.daily > 0 ? formatUGX(r.daily) : '-', colDaily, y + 1);
    doc.setTextColor(r.outstanding > 0 ? 220 : 22, r.outstanding > 0 ? 38 : 163, r.outstanding > 0 ? 38 : 74);
    doc.text(r.outstanding > 0 ? formatUGX(r.outstanding) : 'Paid', colOut, y + 1);
    y += 6.5;
  });

  // ─── Totals row ───────────────────────────────────────────
  if (y > 272) { doc.addPage(); y = 15; }
  doc.setDrawColor(34, 197, 94);
  doc.setLineWidth(0.5);
  doc.line(14, y - 2, pageWidth - 14, y - 2);
  doc.setFont('helvetica', 'bold');
  doc.setTextColor(30, 30, 30);
  doc.text('TOTAL', colName, y + 3);
  doc.setTextColor(202, 138, 4);
  doc.text(formatUGX(totalDueToday), colDaily, y + 3);
  doc.setTextColor(220, 38, 38);
  doc.text(formatUGX(totalToCollect), colOut, y + 3);

  // ─── Footer ───────────────────────────────────────────────
  const pageCount = (doc.internal as any).getNumberOfPages();
  for (let p = 1; p <= pageCount; p++) {
    doc.setPage(p);
    doc.setFontSize(7);
    doc.setTextColor(150);
    doc.text(
      'Automated daily allocation report generated by Welile Platform.',
      pageWidth / 2,
      290,
      { align: 'center' },
    );
    doc.text(`Page ${p} of ${pageCount}`, pageWidth - 14, 290, { align: 'right' });
  }

  return doc.output('arraybuffer') as unknown as Uint8Array;
}

function buildFilename(): string {
  return `welile-daily-allocation-${format(new Date(), 'yyyy-MM-dd')}.pdf`;
}

/**
 * Share the report via the native share sheet (so the agent can send it to a
 * manager or supporter over WhatsApp, email, etc.). Falls back to a download
 * when file sharing isn't supported by the browser.
 */
export async function shareDailyAllocationPdf(data: DailyAllocationPdfData): Promise<'shared' | 'downloaded'> {
  const bytes = await generateDailyAllocationPdf(data);
  const blob = new Blob([bytes as unknown as ArrayBuffer], { type: 'application/pdf' });
  const filename = buildFilename();

  const nav = navigator as Navigator & { canShare?: (d?: ShareData) => boolean };
  try {
    const file = new File([blob], filename, { type: 'application/pdf' });
    if (nav.canShare && nav.canShare({ files: [file] }) && nav.share) {
      await nav.share({
        files: [file],
        title: 'Daily Allocation Report',
        text: `Welile daily allocation report — ${format(new Date(), 'MMMM d, yyyy')}`,
      });
      return 'shared';
    }
  } catch (e: any) {
    // User cancelled the share sheet — treat as a no-op, don't fall through to download.
    if (e?.name === 'AbortError') return 'shared';
  }

  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
  return 'downloaded';
}