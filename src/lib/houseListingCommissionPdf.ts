import welileLogoUrl from '@/assets/welile-logo.png';
import { format } from 'date-fns';

const THEME_PRIMARY: [number, number, number] = [108, 33, 196];
const THEME_PRIMARY_DARK: [number, number, number] = [76, 22, 150];
const THEME_STRIPE: [number, number, number] = [243, 238, 252];

export interface HlcTypeRow { label: string; amount: number; count: number }
export interface HlcAgentRow { name: string; phone: string; amount: number; count: number }

export interface HouseListingCommissionPdfData {
  periodLabel: string;
  totalAmount: number;
  totalCount: number;
  agentCount: number;
  byType: HlcTypeRow[];
  byAgent: HlcAgentRow[];
}

const fmtUGX = (n: number) =>
  `UGX ${new Intl.NumberFormat('en-UG', { maximumFractionDigits: 0 }).format(n)}`;

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

export async function generateHouseListingCommissionPdf(
  data: HouseListingCommissionPdfData,
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
  doc.text('House Listing Commission Report', logo ? margin + 20 : margin, 14);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(9);
  doc.text(`Generated ${format(generatedAt, 'dd MMM yyyy, HH:mm')}`, logo ? margin + 20 : margin, 21);

  // ── Summary strip ──
  let y = 40;
  doc.setTextColor(15, 23, 42);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(10);
  doc.text(`Period: ${data.periodLabel}`, margin, y);
  y += 6;

  const summaryHead = [['Total Commission Paid', 'Payments', 'Agents Paid']];
  const summaryBody = [[
    fmtUGX(data.totalAmount),
    data.totalCount.toLocaleString(),
    data.agentCount.toLocaleString(),
  ]];
  autoTable(doc, {
    head: summaryHead,
    body: summaryBody,
    startY: y,
    margin: { left: margin, right: margin },
    tableWidth: pageWidth - margin * 2,
    styles: { fontSize: 9, cellPadding: 3, halign: 'center', valign: 'middle' },
    headStyles: { fillColor: THEME_PRIMARY_DARK, textColor: 255, fontStyle: 'bold', halign: 'center' },
    bodyStyles: { fontStyle: 'bold', fontSize: 11 },
  });

  // ── Commission by type ──
  let ty = ((doc as any).lastAutoTable?.finalY || y) + 10;
  doc.setTextColor(...THEME_PRIMARY_DARK);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(11);
  doc.text('Commission by Type', margin, ty);
  ty += 2;
  doc.setDrawColor(...THEME_PRIMARY);
  doc.setLineWidth(0.5);
  doc.line(margin, ty, pageWidth - margin, ty);
  ty += 4;

  const typeHead = [['Commission Type', 'Payments', 'Amount (UGX)', 'Share']];
  const typeBody = data.byType.map((t) => [
    t.label,
    t.count.toLocaleString(),
    fmtUGX(t.amount),
    data.totalAmount > 0 ? `${Math.round((t.amount / data.totalAmount) * 100)}%` : '0%',
  ]);
  autoTable(doc, {
    head: typeHead,
    body: typeBody,
    startY: ty,
    margin: { left: margin, right: margin },
    tableWidth: pageWidth - margin * 2,
    styles: { fontSize: 8.5, cellPadding: 2.2, overflow: 'linebreak', valign: 'middle' },
    headStyles: { fillColor: THEME_PRIMARY, textColor: 255, fontStyle: 'bold' },
    alternateRowStyles: { fillColor: THEME_STRIPE },
    columnStyles: {
      0: { cellWidth: 'auto' },
      1: { cellWidth: 26, halign: 'center' },
      2: { cellWidth: 42, halign: 'right', fontStyle: 'bold' },
      3: { cellWidth: 22, halign: 'center' },
    },
  });

  // ── By agent ──
  let ay = ((doc as any).lastAutoTable?.finalY || ty) + 10;
  doc.setTextColor(...THEME_PRIMARY_DARK);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(11);
  doc.text(`Commission by Agent (${data.byAgent.length})`, margin, ay);
  ay += 2;
  doc.setDrawColor(...THEME_PRIMARY);
  doc.setLineWidth(0.5);
  doc.line(margin, ay, pageWidth - margin, ay);
  ay += 4;

  const agentHead = [['#', 'Agent', 'Phone', 'Payments', 'Amount (UGX)']];
  const agentBody = data.byAgent.map((a, i) => [
    String(i + 1),
    a.name || '—',
    a.phone || '—',
    a.count.toLocaleString(),
    fmtUGX(a.amount),
  ]);
  autoTable(doc, {
    head: agentHead,
    body: agentBody,
    startY: ay,
    margin: { left: margin, right: margin },
    tableWidth: pageWidth - margin * 2,
    styles: { fontSize: 8, cellPadding: 1.8, overflow: 'linebreak', valign: 'middle' },
    headStyles: { fillColor: THEME_PRIMARY, textColor: 255, fontStyle: 'bold' },
    alternateRowStyles: { fillColor: THEME_STRIPE },
    columnStyles: {
      0: { cellWidth: 10, halign: 'right' },
      1: { cellWidth: 'auto' },
      2: { cellWidth: 40 },
      3: { cellWidth: 24, halign: 'center' },
      4: { cellWidth: 40, halign: 'right', fontStyle: 'bold' },
    },
  });

  // ── Footer ──
  const pageCount = (doc as any).internal.getNumberOfPages();
  for (let p = 1; p <= pageCount; p++) {
    doc.setPage(p);
    const ph = doc.internal.pageSize.getHeight();
    doc.setFontSize(7.5);
    doc.setTextColor(120, 120, 120);
    doc.text('Powered by Welile — confidential commission report', margin, ph - 6);
    doc.text(`Page ${p} / ${pageCount}`, pageWidth - margin, ph - 6, { align: 'right' });
  }

  return doc.output('blob');
}