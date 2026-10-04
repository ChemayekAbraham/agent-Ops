import welileLogoUrl from '@/assets/welile-logo.png';
import { format } from 'date-fns';
import { savePdfWithVault } from '@/lib/pdfVault';
import { downloadXlsxWorkbook } from '@/lib/xlsxExport';
import type { CommsRecent } from '@/hooks/useTenantCommunications';

/**
 * Reporting for the Tenant Communications tab's message log — a
 * presentation-only export of rows already fetched by
 * `useTenantCommunications` (src/hooks/useTenantCommunications.ts). No new
 * query, no business logic: this file only formats what the hook returns.
 */

const PRIMARY: [number, number, number] = [79, 70, 229]; // indigo-600
const PRIMARY_DARK: [number, number, number] = [55, 48, 163]; // indigo-800
const STRIPE: [number, number, number] = [239, 241, 254];

const fmtDateTime = (d: string) => (d ? format(new Date(d), 'dd MMM yyyy, HH:mm') : '—');

const resultLabel = (r: CommsRecent) =>
  r.status === 'sent' ? 'Sent' : r.status === 'failed' ? 'Failed' : 'Skipped';

function messageStats(messages: CommsRecent[]) {
  const total = messages.length;
  const sent = messages.filter((m) => m.status === 'sent').length;
  const failed = messages.filter((m) => m.status === 'failed').length;
  const skipped = total - sent - failed;
  const deliveryRate = total > 0 ? Math.round((sent / total) * 1000) / 10 : 0;
  return { total, sent, failed, skipped, deliveryRate };
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

/**
 * "Professional PDF" export of the Recent payment messages log. Mirrors the
 * branding recipe of `generateCfoWeeklyReportPdf` (src/lib/cfoWeeklyReportPdf.ts)
 * — header band, section()/table() helpers, footer — applied to the message
 * log instead of financial figures.
 */
export async function generateTenantCommsMessageLogPdf(
  messages: CommsRecent[],
  meta?: { generatedByUserId?: string },
): Promise<void> {
  const { default: jsPDF } = await import('jspdf');
  const autoTableMod: any = await import('jspdf-autotable');
  const autoTable = autoTableMod.default || autoTableMod;

  const doc = new jsPDF({ unit: 'mm', format: 'a4', orientation: 'portrait' });
  const pw = doc.internal.pageSize.getWidth();
  const margin = 12;
  const logo = await loadLogoBase64();
  const { total, sent, failed, skipped, deliveryRate } = messageStats(messages);

  // ── Header band ──
  doc.setFillColor(...PRIMARY);
  doc.rect(0, 0, pw, 30, 'F');
  if (logo) { try { doc.addImage(logo, 'PNG', margin, 6, 17, 17); } catch { /* ignore */ } }
  doc.setTextColor(255, 255, 255);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(16);
  doc.text('Tenant Payment Messages Report', logo ? margin + 21 : margin, 13);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(9);
  doc.text(
    `${total} message${total === 1 ? '' : 's'} in the log  ·  Generated ${format(new Date(), 'dd MMM yyyy, HH:mm')}`,
    logo ? margin + 21 : margin, 20,
  );
  doc.setFontSize(8);
  doc.text('Tenant Operations Workspace — Tenant Communications', logo ? margin + 21 : margin, 25.5);

  let y = 38;
  doc.setTextColor(15, 23, 42);

  // ── Summary ──
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(12);
  doc.setTextColor(...PRIMARY_DARK);
  doc.text('Summary', margin, y);
  y += 2;
  doc.setDrawColor(...PRIMARY);
  doc.line(margin, y, pw - margin, y);
  y += 5;

  doc.setTextColor(30, 30, 30);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(9);
  const summaryLines = doc.splitTextToSize(
    `${total} message${total === 1 ? '' : 's'} logged, ${sent} sent, ${failed} failed, ${skipped} skipped — a ${deliveryRate}% delivery rate.`,
    pw - margin * 2,
  );
  doc.text(summaryLines, margin, y);
  y += summaryLines.length * 4.4 + 4;

  const section = (title: string, startY: number) => {
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(11.5);
    doc.setTextColor(...PRIMARY_DARK);
    doc.text(title, margin, startY);
    doc.setDrawColor(...PRIMARY);
    doc.line(margin, startY + 2, pw - margin, startY + 2);
    doc.setTextColor(15, 23, 42);
    return startY + 6;
  };

  const table = (head: string[][], body: (string | number)[][], startY: number, foot?: (string | number)[][]) => {
    autoTable(doc, {
      head, body, foot, startY,
      margin: { left: margin, right: margin },
      styles: { fontSize: 8, cellPadding: 2, overflow: 'linebreak', valign: 'middle' },
      headStyles: { fillColor: PRIMARY_DARK, textColor: 255, fontSize: 8, fontStyle: 'bold' },
      footStyles: { fillColor: STRIPE, textColor: 15, fontStyle: 'bold', fontSize: 8 },
      alternateRowStyles: { fillColor: STRIPE },
      columnStyles: { 1: { halign: 'right' }, 2: { halign: 'right' }, 3: { halign: 'right' } },
    });
    return ((doc as any).lastAutoTable?.finalY || startY) + 8;
  };

  // ── Message log detail ──
  y = section('Message Log', y);
  table(
    [['When', 'Tenant', 'Message', 'Channel', 'Result', 'Reason']],
    messages.map((m) => [
      fmtDateTime(m.created_at),
      m.tenant_name ?? m.tenant_id.slice(0, 8),
      m.event_key,
      m.channel,
      resultLabel(m),
      m.skip_reason ?? '—',
    ]),
    y,
  );

  // ── Footer on every page ──
  const pageCount = (doc as any).internal.getNumberOfPages();
  for (let p = 1; p <= pageCount; p++) {
    doc.setPage(p);
    const ph = doc.internal.pageSize.getHeight();
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(7.5);
    doc.setTextColor(120, 120, 120);
    doc.text('Powered by Welile — Tenant Operations Workspace', margin, ph - 6);
    doc.text(`Page ${p} / ${pageCount}`, pw - margin, ph - 6, { align: 'right' });
  }

  const filename = `tenant-payment-messages-${format(new Date(), 'yyyyMMdd-HHmm')}.pdf`;
  savePdfWithVault(doc, filename, {
    label: 'Tenant Payment Messages Report',
    category: 'tenant-ops',
    userId: meta?.generatedByUserId,
  });
}

/**
 * Excel export of the same message log — a 'Summary' sheet (totals by
 * result/channel) plus a 'Messages' sheet with every row and column, built
 * with the existing shared `downloadXlsxWorkbook` writer
 * (src/lib/xlsxExport.ts) rather than reimplementing Excel writing.
 */
export async function exportTenantCommsMessageLogXlsx(messages: CommsRecent[]): Promise<void> {
  const { total, sent, failed, skipped, deliveryRate } = messageStats(messages);

  const byChannel = new Map<string, number>();
  for (const m of messages) {
    byChannel.set(m.channel, (byChannel.get(m.channel) ?? 0) + 1);
  }

  const summaryRows: (string | number)[][] = [
    ['Total messages', total],
    ['Sent', sent],
    ['Failed', failed],
    ['Skipped', skipped],
    ['Delivery rate', `${deliveryRate}%`],
    ['', ''],
    ['By channel', ''],
    ...Array.from(byChannel.entries()).map(([channel, count]) => [channel, count]),
  ];

  await downloadXlsxWorkbook(
    `tenant-payment-messages-${format(new Date(), 'yyyyMMdd-HHmm')}.xlsx`,
    [
      { name: 'Summary', headers: ['Metric', 'Value'], rows: summaryRows },
      {
        name: 'Messages',
        headers: ['When', 'Tenant', 'Tenant ID', 'Message', 'Channel', 'Status', 'Skip Reason', 'Provider', 'Phone'],
        rows: messages.map((m) => [
          fmtDateTime(m.created_at),
          m.tenant_name ?? '',
          m.tenant_id,
          m.event_key,
          m.channel,
          resultLabel(m),
          m.skip_reason ?? '',
          m.provider ?? '',
          m.phone ?? '',
        ]),
      },
    ],
  );
}
