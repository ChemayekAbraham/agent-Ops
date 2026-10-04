import welileLogoUrl from '@/assets/welile-logo.png';
import { format } from 'date-fns';

const THEME_PRIMARY: [number, number, number] = [108, 33, 196];
const THEME_PRIMARY_DARK: [number, number, number] = [76, 22, 150];
const THEME_STRIPE: [number, number, number] = [243, 238, 252];

export interface IssueRow {
  created_at: string;
  customer_name: string;
  contact?: string | null;
  issue: string;
  experience: string;
  solution?: string | null;
  status: string;
}

export interface SupportRow {
  invested_on: string;
  partner_name: string;
  amount: number;
  notes?: string | null;
}

const fmtUGX = (n: number) =>
  new Intl.NumberFormat('en-UG', { style: 'currency', currency: 'UGX', maximumFractionDigits: 0 }).format(n || 0);

const titleCase = (s: string) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : '—');

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
 * Build a branded monthly CRM support report covering customer issues
 * (complaints + experience + solutions) and tenant support partner investments.
 */
export async function generateCrmSupportReportPdf(
  monthLabel: string,
  issues: IssueRow[],
  support: SupportRow[],
  generatedAt: Date = new Date(),
): Promise<Blob> {
  const { default: jsPDF } = await import('jspdf');
  const autoTableMod: any = await import('jspdf-autotable');
  const autoTable = autoTableMod.default || autoTableMod;

  const doc = new jsPDF({ unit: 'mm', format: 'a4', orientation: 'portrait' });
  const pageWidth = doc.internal.pageSize.getWidth();
  const margin = 12;
  const logo = await loadLogoBase64();

  // ── Header band ──
  doc.setFillColor(...THEME_PRIMARY);
  doc.rect(0, 0, pageWidth, 30, 'F');
  if (logo) {
    try { doc.addImage(logo, 'PNG', margin, 7, 16, 16); } catch { /* ignore */ }
  }
  doc.setTextColor(255, 255, 255);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(15);
  doc.text('Customer Support Monthly Report', logo ? margin + 20 : margin, 13);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(9);
  doc.text(`${monthLabel}`, logo ? margin + 20 : margin, 19);
  doc.text(`Generated ${format(generatedAt, 'dd MMM yyyy, HH:mm')}`, logo ? margin + 20 : margin, 24);

  let y = 40;

  // ── Summary line ──
  const resolved = issues.filter((i) => i.status === 'resolved').length;
  const totalInvested = support.reduce((s, r) => s + (Number(r.amount) || 0), 0);
  doc.setTextColor(15, 23, 42);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(10);
  doc.text(`${issues.length} issue${issues.length === 1 ? '' : 's'} logged · ${resolved} resolved`, margin, y);
  doc.text(`${support.length} investment${support.length === 1 ? '' : 's'} · ${fmtUGX(totalInvested)}`, pageWidth - margin, y, { align: 'right' });
  y += 6;

  // ── Section 1: Customer Issues ──
  doc.setTextColor(...THEME_PRIMARY_DARK);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(11);
  doc.text('Customer Issues & Complaints', margin, y);
  y += 2;
  doc.setDrawColor(...THEME_PRIMARY);
  doc.setLineWidth(0.5);
  doc.line(margin, y, pageWidth - margin, y);
  y += 4;

  autoTable(doc, {
    head: [['#', 'Date', 'Customer', 'Issue', 'Experience', 'Solution', 'Status']],
    body: issues.length
      ? issues.map((r, i) => [
          String(i + 1),
          format(new Date(r.created_at), 'dd MMM'),
          r.contact ? `${r.customer_name}\n${r.contact}` : r.customer_name,
          r.issue || '—',
          titleCase(r.experience),
          r.solution || '—',
          titleCase(r.status),
        ])
      : [['', '', '', 'No issues logged this month', '', '', '']],
    startY: y,
    margin: { left: margin, right: margin },
    tableWidth: pageWidth - margin * 2,
    styles: { fontSize: 8, cellPadding: 2, overflow: 'linebreak', valign: 'top' },
    headStyles: { fillColor: THEME_PRIMARY, textColor: 255, fontSize: 8, fontStyle: 'bold' },
    alternateRowStyles: { fillColor: THEME_STRIPE },
    columnStyles: {
      0: { cellWidth: 8, halign: 'right' },
      1: { cellWidth: 16 },
      2: { cellWidth: 28 },
      3: { cellWidth: 'auto' },
      4: { cellWidth: 20 },
      5: { cellWidth: 45 },
      6: { cellWidth: 18 },
    },
  });

  // ── Section 2: Tenant Support ──
  let sy = (doc as any).lastAutoTable?.finalY ? (doc as any).lastAutoTable.finalY + 10 : y + 20;
  doc.setTextColor(...THEME_PRIMARY_DARK);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(11);
  doc.text('Tenant Support — Partner Investments', margin, sy);
  sy += 2;
  doc.setDrawColor(...THEME_PRIMARY);
  doc.setLineWidth(0.5);
  doc.line(margin, sy, pageWidth - margin, sy);
  sy += 4;

  autoTable(doc, {
    head: [['#', 'Date', 'Partner', 'Notes', 'Amount Invested']],
    body: support.length
      ? support.map((r, i) => [
          String(i + 1),
          format(new Date(r.invested_on), 'dd MMM yyyy'),
          r.partner_name || '—',
          r.notes || '—',
          fmtUGX(Number(r.amount) || 0),
        ])
      : [['', '', 'No investments recorded this month', '', '']],
    foot: support.length ? [['', '', '', 'Total', fmtUGX(totalInvested)]] : undefined,
    startY: sy,
    margin: { left: margin, right: margin },
    tableWidth: pageWidth - margin * 2,
    styles: { fontSize: 8, cellPadding: 2, overflow: 'linebreak', valign: 'middle' },
    headStyles: { fillColor: THEME_PRIMARY_DARK, textColor: 255, fontSize: 8, fontStyle: 'bold' },
    footStyles: { fillColor: THEME_STRIPE, textColor: THEME_PRIMARY_DARK, fontStyle: 'bold', fontSize: 8 },
    alternateRowStyles: { fillColor: THEME_STRIPE },
    columnStyles: {
      0: { cellWidth: 8, halign: 'right' },
      1: { cellWidth: 28 },
      2: { cellWidth: 'auto' },
      3: { cellWidth: 60 },
      4: { halign: 'right', fontStyle: 'bold', cellWidth: 36 },
    },
  });

  // ── Footer ──
  const pageCount = (doc as any).internal.getNumberOfPages();
  for (let p = 1; p <= pageCount; p++) {
    doc.setPage(p);
    const ph = doc.internal.pageSize.getHeight();
    doc.setFontSize(7.5);
    doc.setTextColor(120, 120, 120);
    doc.text('Powered by Welile — confidential customer support report', margin, ph - 6);
    doc.text(`Page ${p} / ${pageCount}`, pageWidth - margin, ph - 6, { align: 'right' });
  }

  return doc.output('blob');
}