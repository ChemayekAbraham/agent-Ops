import welileLogoUrl from '@/assets/welile-logo.png';
import { format } from 'date-fns';

const THEME_PRIMARY: [number, number, number] = [108, 33, 196];
const THEME_PRIMARY_DARK: [number, number, number] = [76, 22, 150];
const THEME_STRIPE: [number, number, number] = [243, 238, 252];

export interface TenantCallReportRow {
  when: string;
  tenant: string;
  tenantPhone?: string | null;
  agent?: string | null;
  agentPhone?: string | null;
  status: string;
  category?: string | null;
  comment?: string | null;
  context?: string | null;
  officer?: string | null;
}

export interface TenantCallReportSummary {
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

/**
 * Branded Tenant Calls Report — same records as the Calling Hub spine, laid out
 * with the system's standard report header band, summary tiles and striped table.
 */
export async function generateTenantCallsReportPdf(
  periodLabel: string,
  summary: TenantCallReportSummary[],
  rows: TenantCallReportRow[],
  generatedAt: Date = new Date(),
): Promise<Blob> {
  const { default: jsPDF } = await import('jspdf');
  const autoTableMod: any = await import('jspdf-autotable');
  const autoTable = autoTableMod.default || autoTableMod;

  const doc = new jsPDF({ unit: 'mm', format: 'a4', orientation: 'landscape' });
  const pageWidth = doc.internal.pageSize.getWidth();
  const margin = 12;
  const logo = await loadLogoBase64();

  // ── Header band ──
  doc.setFillColor(...THEME_PRIMARY);
  doc.rect(0, 0, pageWidth, 28, 'F');
  if (logo) {
    try {
      doc.addImage(logo, 'PNG', margin, 6, 16, 16);
    } catch {
      /* ignore */
    }
  }
  const hx = logo ? margin + 20 : margin;
  doc.setTextColor(255, 255, 255);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(15);
  doc.text('Tenant Calls Report', hx, 12);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(9);
  doc.text(periodLabel, hx, 18);
  doc.text(`Generated ${format(generatedAt, 'dd MMM yyyy, HH:mm')}`, hx, 23);

  // ── Summary tiles ──
  let y = 36;
  const tileW = (pageWidth - margin * 2 - (summary.length - 1) * 3) / Math.max(summary.length, 1);
  summary.forEach((s, i) => {
    const x = margin + i * (tileW + 3);
    doc.setFillColor(...THEME_STRIPE);
    doc.roundedRect(x, y, tileW, 16, 2, 2, 'F');
    doc.setTextColor(90, 90, 100);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(7.5);
    doc.text(s.label, x + 3, y + 5.5);
    doc.setTextColor(...THEME_PRIMARY_DARK);
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(12);
    doc.text(s.value, x + 3, y + 12.5);
  });
  y += 24;

  doc.setTextColor(...THEME_PRIMARY_DARK);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(11);
  doc.text('Calls made in this period', margin, y);
  y += 2;
  doc.setDrawColor(...THEME_PRIMARY);
  doc.setLineWidth(0.5);
  doc.line(margin, y, pageWidth - margin, y);
  y += 4;

  autoTable(doc, {
    head: [['#', 'When', 'Tenant', 'Agent', 'Status', 'Feedback', 'Comment', 'Tenant plan', 'Officer']],
    body: rows.length
      ? rows.map((r, i) => [
          String(i + 1),
          r.when,
          r.tenantPhone ? `${r.tenant}\n${r.tenantPhone}` : r.tenant,
          r.agent ? (r.agentPhone ? `${r.agent}\n${r.agentPhone}` : r.agent) : '—',
          r.status,
          r.category || '—',
          r.comment || '—',
          r.context || '—',
          r.officer || '—',
        ])
      : [['', '', '', '', 'No calls recorded in this period', '', '', '', '']],
    startY: y,
    margin: { left: margin, right: margin },
    tableWidth: pageWidth - margin * 2,
    styles: { fontSize: 7.5, cellPadding: 1.8, overflow: 'linebreak', valign: 'top' },
    headStyles: { fillColor: THEME_PRIMARY, textColor: 255, fontSize: 7.5, fontStyle: 'bold' },
    alternateRowStyles: { fillColor: THEME_STRIPE },
    columnStyles: {
      0: { cellWidth: 8, halign: 'right' },
      1: { cellWidth: 26 },
      2: { cellWidth: 38 },
      3: { cellWidth: 34 },
      4: { cellWidth: 26 },
      5: { cellWidth: 30 },
      6: { cellWidth: 'auto' },
      7: { cellWidth: 40 },
      8: { cellWidth: 28 },
    },
  });

  const pageCount = (doc as any).internal.getNumberOfPages();
  for (let p = 1; p <= pageCount; p++) {
    doc.setPage(p);
    const ph = doc.internal.pageSize.getHeight();
    doc.setFontSize(7.5);
    doc.setTextColor(120, 120, 120);
    doc.text('Powered by Welile — confidential tenant calling report', margin, ph - 6);
    doc.text(`Page ${p} / ${pageCount}`, pageWidth - margin, ph - 6, { align: 'right' });
  }

  return doc.output('blob');
}
