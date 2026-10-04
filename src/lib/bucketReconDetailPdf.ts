// PDF export for the Bucket Reconciliation "Missing / Extra" drill-down detail view.
// Mirrors the CSV export: header identity, prorated-obligation math, and the underlying
// (filtered) collections tables — but branded and paginated for print/share.

import welileLogoUrl from '@/assets/welile-logo.png';
import { format } from 'date-fns';
import { formatDynamic as formatUGX } from '@/lib/currencyFormat';

const THEME_PRIMARY: [number, number, number] = [108, 33, 196];
const ROSE: [number, number, number] = [190, 18, 60];
const AMBER: [number, number, number] = [180, 83, 9];
const MUTED: [number, number, number] = [100, 116, 139];
const STRIPE: [number, number, number] = [243, 238, 252];

export interface ReconDetailPdfMissing {
  kind: 'missing';
  tenantName: string;
  tenantId: string | null;
  agentName: string;
  agentId: string | null;
  rentRequestId: string;
  planStatus: string;
  dailyPlan: number;
  bucketDays: number;
  totalDue: number;
  paidBefore: number;
  remaining: number;
  expectedInBucket: number;
  collectedInBucket: number;
  variance: number; // positive number representing shortfall
  planCollections: Array<{ whenEat: string; agent: string; method: string; amount: number; collectionId: string }>;
  tenantOtherCollections: Array<{ whenEat: string; agent: string; method: string; amount: number; rentRequestId: string; collectionId: string }>;
}

export interface ReconDetailPdfExtra {
  kind: 'extra';
  collectionId: string;
  whenEat: string;
  amount: number;
  extraAmount: number;
  reasonLabel: string;
  tenantName: string;
  tenantId: string | null;
  agentName: string;
  agentId: string | null;
  method: string;
  rentRequestId: string | null;
  planStatus?: string;
  dailyPlan?: number;
  bucketDays?: number;
  totalDue?: number;
  paidBefore?: number;
  remaining?: number;
  expectedInBucket?: number;
  timeline: Array<{ whenEat: string; amount: number; cumulative: number; overDaily: number; overRemaining: number; isThis: boolean; collectionId: string }>;
}

export interface ReconDetailPdfMeta {
  bucketLabel: string;
  filterText?: string;
  filterPlan?: string;
  filterFromEat?: string;
  filterToEat?: string;
}

async function loadLogoBase64(): Promise<string | null> {
  try {
    const res = await fetch(welileLogoUrl);
    const blob = await res.blob();
    return await new Promise((resolve) => {
      const reader = new FileReader();
      reader.onloadend = () => resolve(reader.result as string);
      reader.onerror = () => resolve(null);
      reader.readAsDataURL(blob);
    });
  } catch {
    return null;
  }
}

export async function generateBucketReconDetailPdf(
  detail: ReconDetailPdfMissing | ReconDetailPdfExtra,
  meta: ReconDetailPdfMeta,
  generatedAt: Date = new Date(),
): Promise<Blob> {
  const { default: jsPDF } = await import('jspdf');
  const autoTableMod: any = await import('jspdf-autotable');
  const autoTable = autoTableMod.default || autoTableMod;

  const doc = new jsPDF({ unit: 'mm', format: 'a4', orientation: 'portrait' });
  const pageWidth = doc.internal.pageSize.getWidth();
  const margin = 12;
  const accent = detail.kind === 'missing' ? ROSE : AMBER;

  const logo = await loadLogoBase64();

  // Header band
  doc.setFillColor(...THEME_PRIMARY);
  doc.rect(0, 0, pageWidth, 30, 'F');
  if (logo) {
    try { doc.addImage(logo, 'PNG', margin, 7, 16, 16); } catch { /* ignore */ }
  }
  doc.setTextColor(255, 255, 255);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(15);
  const title = detail.kind === 'missing'
    ? 'Reconciliation · Missing (Underpayment)'
    : 'Reconciliation · Extra Collection';
  doc.text(title, logo ? margin + 20 : margin, 14);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(9);
  doc.text(`Bucket: ${meta.bucketLabel}`, logo ? margin + 20 : margin, 21);
  doc.text(`Generated ${format(generatedAt, 'dd MMM yyyy, HH:mm')}`, pageWidth - margin, 21, { align: 'right' });

  // Identity band
  let y = 36;
  doc.setDrawColor(...accent);
  doc.setLineWidth(0.6);
  doc.line(margin, y, pageWidth - margin, y);
  y += 5;

  doc.setTextColor(15, 23, 42);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(12);
  const primaryName = detail.kind === 'missing'
    ? (detail.tenantName || '(no tenant)')
    : (detail.tenantName || '(no tenant)');
  doc.text(primaryName, margin, y);
  y += 5;

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(9);
  doc.setTextColor(...MUTED);
  const identity: string[] = [];
  if (detail.kind === 'missing') {
    identity.push(`Agent: ${detail.agentName || '—'}`);
    identity.push(`Plan: ${detail.rentRequestId.slice(0, 8)}`);
    identity.push(`Status: ${detail.planStatus || '—'}`);
    if (detail.tenantId) identity.push(`Tenant ID: ${detail.tenantId.slice(0, 8)}`);
  } else {
    identity.push(`Agent: ${detail.agentName || '—'}`);
    identity.push(`When (EAT): ${detail.whenEat}`);
    identity.push(`Reason: ${detail.reasonLabel}`);
    if (detail.rentRequestId) identity.push(`Plan: ${detail.rentRequestId.slice(0, 8)}`);
    if (detail.method) identity.push(`Method: ${detail.method.replace(/_/g, ' ')}`);
  }
  doc.text(identity.join('   ·   '), margin, y, { maxWidth: pageWidth - margin * 2 });
  y += 6;

  // KPI strip
  const kpis: Array<{ label: string; value: string; tone?: [number, number, number] }> = detail.kind === 'missing'
    ? [
        { label: 'Expected', value: formatUGX(Math.round(detail.expectedInBucket)) },
        { label: 'Collected', value: formatUGX(Math.round(detail.collectedInBucket)) },
        { label: 'Variance', value: `− ${formatUGX(Math.round(detail.variance))}`, tone: ROSE },
        { label: 'Remaining balance', value: formatUGX(Math.round(detail.remaining)) },
      ]
    : [
        { label: 'Amount', value: formatUGX(Math.round(detail.amount)) },
        { label: 'Extra', value: `+ ${formatUGX(Math.round(detail.extraAmount))}`, tone: AMBER },
        { label: 'Expected in bucket', value: detail.expectedInBucket != null ? formatUGX(Math.round(detail.expectedInBucket)) : '—' },
        { label: 'Remaining balance', value: detail.remaining != null ? formatUGX(Math.round(detail.remaining)) : '—' },
      ];
  const cardW = (pageWidth - margin * 2 - 6) / 4;
  const cardH = 16;
  kpis.forEach((k, i) => {
    const x = margin + i * (cardW + 2);
    doc.setDrawColor(226, 232, 240);
    doc.setFillColor(...STRIPE);
    doc.roundedRect(x, y, cardW, cardH, 1.5, 1.5, 'FD');
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(7.5);
    doc.setTextColor(...MUTED);
    doc.text(k.label.toUpperCase(), x + 2.5, y + 5);
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(11);
    if (k.tone) doc.setTextColor(...k.tone); else doc.setTextColor(15, 23, 42);
    doc.text(k.value, x + 2.5, y + 12);
  });
  y += cardH + 6;

  // Filter summary (only when active)
  const anyFilter = Boolean(meta.filterText || meta.filterPlan || meta.filterFromEat || meta.filterToEat);
  if (anyFilter) {
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(8.5);
    doc.setTextColor(...MUTED);
    doc.text('Active filters', margin, y);
    y += 4;
    doc.setFont('helvetica', 'normal');
    doc.setTextColor(15, 23, 42);
    const bits: string[] = [];
    if (meta.filterText) bits.push(`text: "${meta.filterText}"`);
    if (meta.filterPlan) bits.push(`plan: ${meta.filterPlan}`);
    if (meta.filterFromEat) bits.push(`from: ${meta.filterFromEat}`);
    if (meta.filterToEat) bits.push(`to: ${meta.filterToEat}`);
    doc.text(bits.join('   ·   '), margin, y, { maxWidth: pageWidth - margin * 2 });
    y += 5;
  }

  // Prorated math table
  const mathRows: Array<[string, string]> = [];
  if (detail.kind === 'missing') {
    mathRows.push(['Plan daily repayment', formatUGX(Math.round(detail.dailyPlan))]);
    mathRows.push(['Bucket length', detail.bucketDays >= 0.999 ? '1 full day' : `${(detail.bucketDays * 24).toFixed(2)} hours (${(detail.bucketDays * 100).toFixed(1)}% of a day)`]);
    mathRows.push(['Daily × bucket length', formatUGX(Math.round(detail.dailyPlan * detail.bucketDays))]);
    mathRows.push(['Total due on plan', formatUGX(Math.round(detail.totalDue))]);
    mathRows.push(['Already repaid before bucket', formatUGX(Math.round(detail.paidBefore))]);
    mathRows.push(['Remaining balance (cap)', formatUGX(Math.round(detail.remaining))]);
    mathRows.push(['Expected in bucket = min(daily × bucket, remaining)', formatUGX(Math.round(detail.expectedInBucket))]);
    mathRows.push(['Collected in bucket', formatUGX(Math.round(detail.collectedInBucket))]);
    mathRows.push(['Variance (shortfall)', `− ${formatUGX(Math.round(detail.variance))}`]);
  } else if (detail.dailyPlan != null && detail.bucketDays != null) {
    mathRows.push(['Plan status', detail.planStatus || '—']);
    mathRows.push(['Plan daily repayment', formatUGX(Math.round(detail.dailyPlan))]);
    mathRows.push(['Bucket length', detail.bucketDays >= 0.999 ? '1 full day' : `${(detail.bucketDays * 24).toFixed(2)} hours (${(detail.bucketDays * 100).toFixed(1)}% of a day)`]);
    mathRows.push(['Total due on plan', formatUGX(Math.round(detail.totalDue ?? 0))]);
    mathRows.push(['Already repaid before bucket', formatUGX(Math.round(detail.paidBefore ?? 0))]);
    mathRows.push(['Remaining balance (cap)', formatUGX(Math.round(detail.remaining ?? 0))]);
    mathRows.push(['Expected in bucket', formatUGX(Math.round(detail.expectedInBucket ?? 0))]);
    mathRows.push(['Collection amount', formatUGX(Math.round(detail.amount))]);
    mathRows.push(['Extra over expected', `+ ${formatUGX(Math.round(detail.extraAmount))}`]);
  } else {
    mathRows.push(['Note', 'This extra collection is not linked to an active plan; no prorated obligation applies.']);
  }

  autoTable(doc, {
    startY: y,
    head: [['Prorated obligation', 'Value']],
    body: mathRows,
    theme: 'grid',
    styles: { fontSize: 9, cellPadding: 2 },
    headStyles: { fillColor: accent, textColor: [255, 255, 255], fontStyle: 'bold' },
    columnStyles: { 1: { halign: 'right', cellWidth: 55 } },
    margin: { left: margin, right: margin },
  });
  y = (doc as any).lastAutoTable.finalY + 6;

  // Underlying collections
  if (detail.kind === 'missing') {
    autoTable(doc, {
      startY: y,
      head: [[`Collections linked to this plan in this bucket (${detail.planCollections.length})`]],
      body: [[' ']],
      theme: 'plain',
      styles: { fontSize: 9, fontStyle: 'bold', textColor: [15, 23, 42] },
      margin: { left: margin, right: margin },
    });
    y = (doc as any).lastAutoTable.finalY;
    if (detail.planCollections.length === 0) {
      doc.setFont('helvetica', 'italic');
      doc.setFontSize(9);
      doc.setTextColor(...MUTED);
      doc.text('Zero collections — the plan received nothing in this window.', margin, y + 4);
      y += 8;
    } else {
      autoTable(doc, {
        startY: y,
        head: [['When (EAT)', 'Agent', 'Method', 'Amount', 'Collection ID']],
        body: detail.planCollections.map((r) => [r.whenEat, r.agent || '—', r.method || '—', formatUGX(Math.round(r.amount)), r.collectionId.slice(0, 8)]),
        theme: 'striped',
        styles: { fontSize: 8.5, cellPadding: 1.8 },
        headStyles: { fillColor: accent, textColor: [255, 255, 255], fontStyle: 'bold' },
        alternateRowStyles: { fillColor: STRIPE },
        columnStyles: { 3: { halign: 'right' }, 4: { font: 'courier', fontSize: 8 } },
        margin: { left: margin, right: margin },
      });
      y = (doc as any).lastAutoTable.finalY + 6;
    }

    if (detail.tenantOtherCollections.length > 0) {
      autoTable(doc, {
        startY: y,
        head: [[`Same tenant paid on ${detail.tenantOtherCollections.length} other plan${detail.tenantOtherCollections.length === 1 ? '' : 's'} in this bucket`]],
        body: [[' ']],
        theme: 'plain',
        styles: { fontSize: 9, fontStyle: 'bold', textColor: [15, 23, 42] },
        margin: { left: margin, right: margin },
      });
      y = (doc as any).lastAutoTable.finalY;
      autoTable(doc, {
        startY: y,
        head: [['When (EAT)', 'Agent', 'Method', 'Amount', 'Plan', 'Collection ID']],
        body: detail.tenantOtherCollections.map((r) => [r.whenEat, r.agent || '—', r.method || '—', formatUGX(Math.round(r.amount)), r.rentRequestId.slice(0, 8), r.collectionId.slice(0, 8)]),
        theme: 'striped',
        styles: { fontSize: 8.5, cellPadding: 1.8 },
        headStyles: { fillColor: [71, 85, 105], textColor: [255, 255, 255], fontStyle: 'bold' },
        alternateRowStyles: { fillColor: STRIPE },
        columnStyles: { 3: { halign: 'right' }, 4: { font: 'courier', fontSize: 8 }, 5: { font: 'courier', fontSize: 8 } },
        margin: { left: margin, right: margin },
      });
      y = (doc as any).lastAutoTable.finalY + 6;
    }
  } else {
    // Extra: cumulative timeline
    autoTable(doc, {
      startY: y,
      head: [[`Cumulative timeline on this plan (${detail.timeline.length} row${detail.timeline.length === 1 ? '' : 's'})`]],
      body: [[' ']],
      theme: 'plain',
      styles: { fontSize: 9, fontStyle: 'bold', textColor: [15, 23, 42] },
      margin: { left: margin, right: margin },
    });
    y = (doc as any).lastAutoTable.finalY;
    if (detail.timeline.length === 0) {
      doc.setFont('helvetica', 'italic');
      doc.setFontSize(9);
      doc.setTextColor(...MUTED);
      doc.text('No related timeline — this extra collection is unlinked from any active plan.', margin, y + 4);
      y += 8;
    } else {
      autoTable(doc, {
        startY: y,
        head: [['When (EAT)', 'Amount', 'Cumulative', 'Over daily', 'Over remaining', 'This row', 'Collection ID']],
        body: detail.timeline.map((t) => [
          t.whenEat,
          formatUGX(Math.round(t.amount)),
          formatUGX(Math.round(t.cumulative)),
          t.overDaily > 0 ? `+ ${formatUGX(Math.round(t.overDaily))}` : '—',
          t.overRemaining > 0 ? `+ ${formatUGX(Math.round(t.overRemaining))}` : '—',
          t.isThis ? '★' : '',
          t.collectionId.slice(0, 8),
        ]),
        theme: 'striped',
        styles: { fontSize: 8.5, cellPadding: 1.8 },
        headStyles: { fillColor: accent, textColor: [255, 255, 255], fontStyle: 'bold' },
        alternateRowStyles: { fillColor: STRIPE },
        columnStyles: { 1: { halign: 'right' }, 2: { halign: 'right' }, 3: { halign: 'right' }, 4: { halign: 'right' }, 5: { halign: 'center' }, 6: { font: 'courier', fontSize: 8 } },
        didParseCell: (data: any) => {
          if (data.section === 'body' && detail.timeline[data.row.index]?.isThis) {
            data.cell.styles.fillColor = [254, 243, 199];
            data.cell.styles.textColor = [15, 23, 42];
          }
        },
        margin: { left: margin, right: margin },
      });
      y = (doc as any).lastAutoTable.finalY + 6;
    }
  }

  // Footer on every page
  const pageCount = (doc as any).internal.getNumberOfPages();
  for (let i = 1; i <= pageCount; i++) {
    doc.setPage(i);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(8);
    doc.setTextColor(...MUTED);
    const footer = `Welile · Bucket Reconciliation · ${detail.kind === 'missing' ? 'Missing' : 'Extra'} detail · Page ${i} of ${pageCount}`;
    doc.text(footer, pageWidth / 2, doc.internal.pageSize.getHeight() - 6, { align: 'center' });
  }

  return doc.output('blob');
}
