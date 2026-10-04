import welileLogoUrl from '@/assets/welile-logo.png';
import { format } from 'date-fns';

const THEME_PRIMARY: [number, number, number] = [108, 33, 196];
const THEME_PRIMARY_DARK: [number, number, number] = [76, 22, 150];
const THEME_STRIPE: [number, number, number] = [243, 238, 252];

export interface TenantRepaymentPdfRow {
  /** ISO timestamp of the repayment. */
  date: string;
  amount: number;
  /** Remaining balance on the plan immediately after this repayment. */
  remaining: number;
}

export interface TenantRepaymentPlanBlock {
  planDate: string;
  status: string;
  rentAmount: number;
  totalRepayment: number;
  totalRepaid: number;
  remaining: number;
  landlordName?: string | null;
  propertyAddress?: string | null;
  /** Newest-first rows; the PDF prints them oldest-first for readability. */
  rows: TenantRepaymentPdfRow[];
}

export interface TenantRepaymentReportPdfData {
  tenantName: string;
  phone?: string | null;
  aiId?: string | null;
  generatedBy?: string | null;
  plans: TenantRepaymentPlanBlock[];
}

const fmtUGX = (n: number) =>
  `UGX ${new Intl.NumberFormat('en-UG', { maximumFractionDigits: 0 }).format(Math.round(n))}`;

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

export function buildTenantRepaymentReportFilename(tenantName: string, generatedAt = new Date()): string {
  const slug = (tenantName || 'tenant').replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').toLowerCase();
  return `welile-repayment-report-${slug}-${format(generatedAt, 'yyyyMMdd-HHmm')}.pdf`;
}

export async function generateTenantRepaymentReportPdf(
  data: TenantRepaymentReportPdfData,
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
  doc.text('Tenant Repayment Report', logo ? margin + 20 : margin, 14);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(9);
  doc.text(`Generated ${format(generatedAt, 'dd MMM yyyy, HH:mm')}`, logo ? margin + 20 : margin, 21);

  // ── Tenant identity ──
  let y = 40;
  doc.setTextColor(15, 23, 42);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(12);
  doc.text(data.tenantName || 'Tenant', margin, y);
  y += 5;
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(9);
  const meta = [
    data.phone ? `Phone: ${data.phone}` : null,
    data.aiId ? `Welile AI ID: ${data.aiId}` : null,
    data.generatedBy ? `Prepared by: ${data.generatedBy}` : null,
  ].filter(Boolean) as string[];
  for (const line of meta) { doc.text(line, margin, y); y += 4.5; }
  y += 2;

  // ── Overall summary ──
  const totalPaid = data.plans.reduce((s, p) => s + p.totalRepaid, 0);
  const totalDue = data.plans.reduce((s, p) => s + p.totalRepayment, 0);
  const totalRemaining = data.plans.reduce((s, p) => s + Math.max(0, p.remaining), 0);
  const paymentCount = data.plans.reduce((s, p) => s + p.rows.length, 0);

  autoTable(doc, {
    head: [['Rent Plans', 'Payments Recorded', 'Total Due', 'Total Repaid', 'Balance Remaining']],
    body: [[
      String(data.plans.length),
      String(paymentCount),
      fmtUGX(totalDue),
      fmtUGX(totalPaid),
      fmtUGX(totalRemaining),
    ]],
    startY: y,
    margin: { left: margin, right: margin },
    tableWidth: pageWidth - margin * 2,
    styles: { fontSize: 8.5, cellPadding: 2.6, halign: 'center', valign: 'middle' },
    headStyles: { fillColor: THEME_PRIMARY_DARK, textColor: 255, fontStyle: 'bold', halign: 'center' },
    bodyStyles: { fontStyle: 'bold', fontSize: 9.5 },
  });
  y = ((doc as any).lastAutoTable?.finalY || y) + 10;

  // ── Per-plan repayment ledger ──
  for (const plan of data.plans) {
    if (y > doc.internal.pageSize.getHeight() - 45) { doc.addPage(); y = 20; }

    doc.setTextColor(...THEME_PRIMARY_DARK);
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(10.5);
    doc.text(
      `Plan of ${format(new Date(plan.planDate), 'dd MMM yyyy')} — ${plan.status.replace(/_/g, ' ')}`,
      margin,
      y,
    );
    y += 2;
    doc.setDrawColor(...THEME_PRIMARY);
    doc.setLineWidth(0.5);
    doc.line(margin, y, pageWidth - margin, y);
    y += 4.5;

    doc.setTextColor(71, 85, 105);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(8.5);
    doc.text(
      `Rent ${fmtUGX(plan.rentAmount)}  ·  Total due ${fmtUGX(plan.totalRepayment)}  ·  Repaid ${fmtUGX(plan.totalRepaid)}  ·  Balance ${plan.remaining > 0 ? fmtUGX(plan.remaining) : 'Cleared'}`,
      margin,
      y,
    );
    y += 4.5;
    if (plan.landlordName) {
      doc.text(`Property: ${plan.landlordName}${plan.propertyAddress ? ` — ${plan.propertyAddress}` : ''}`, margin, y, {
        maxWidth: pageWidth - margin * 2,
      });
      y += 4.5;
    }

    const rowsOldestFirst = [...plan.rows].reverse();
    if (rowsOldestFirst.length === 0) {
      doc.setTextColor(148, 163, 184);
      doc.text('No repayments recorded on this plan yet.', margin, y);
      y += 8;
      continue;
    }

    autoTable(doc, {
      head: [['#', 'Date', 'Time', 'Amount Paid', 'Balance After']],
      body: rowsOldestFirst.map((r, i) => [
        String(i + 1),
        format(new Date(r.date), 'dd/MM/yy'),
        format(new Date(r.date), 'HH:mm'),
        fmtUGX(r.amount),
        r.remaining > 0 ? fmtUGX(r.remaining) : 'Cleared',
      ]),
      startY: y,
      margin: { left: margin, right: margin },
      tableWidth: pageWidth - margin * 2,
      styles: { fontSize: 8.5, cellPadding: 2.2, valign: 'middle' },
      headStyles: { fillColor: THEME_PRIMARY, textColor: 255, fontStyle: 'bold' },
      alternateRowStyles: { fillColor: THEME_STRIPE },
      columnStyles: {
        0: { cellWidth: 12, halign: 'center' },
        1: { cellWidth: 28 },
        2: { cellWidth: 20 },
        3: { cellWidth: 45, halign: 'right', fontStyle: 'bold' },
        4: { cellWidth: 'auto', halign: 'right' },
      },
    });
    y = ((doc as any).lastAutoTable?.finalY || y) + 9;
  }

  // ── Footer on every page ──
  const pageCount = (doc as any).internal.getNumberOfPages();
  for (let p = 1; p <= pageCount; p++) {
    doc.setPage(p);
    const fy = doc.internal.pageSize.getHeight() - 8;
    doc.setFontSize(7);
    doc.setFont('helvetica', 'normal');
    doc.setTextColor(148, 163, 184);
    doc.text('Welile Technologies Limited — confidential repayment report.', margin, fy);
    doc.text(`Page ${p} of ${pageCount}`, pageWidth - margin, fy, { align: 'right' });
  }

  return doc.output('blob');
}
