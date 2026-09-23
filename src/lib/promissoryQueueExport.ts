import { formatUGX } from '@/lib/rentCalculations';

/**
 * CSV / PDF export for the Partner Ops promissory conversion queue.
 * Pure presentation: takes the already-filtered, already-ranked rows and
 * serialises them. Reads nothing, writes nothing.
 */

export interface QueueExportRow {
  rank: number;
  partner_name: string;
  phone_number: string | null;
  agent_name: string;
  amount: number;
  daysOverdue: number | null;
  fulfilment_due_on: string | null;
  recorded_on: string;
  score: number;
  tierLabel: string;
  assigned_owner: string;
  last_contact: string;
  snoozed_until: string | null;
  resolution: string | null;
}

export interface QueueExportMeta {
  viewLabel: string;
  tierLabel: string;
  sortLabel: string;
  search: string;
  generatedBy: string;
}

function csvCell(v: string | number | null | undefined): string {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function stamp(): string {
  return new Date().toISOString().slice(0, 16).replace(/[T:]/g, '-');
}

export function buildQueueCsv(rows: QueueExportRow[]): string {
  const header = [
    'Rank', 'Partner', 'Phone', 'Recording agent', 'Amount (UGX)',
    'Priority score', 'Days late', 'Escalation status', 'Assigned owner',
    'Promised date', 'Recorded date', 'Last contact', 'Snoozed until', 'Resolution',
  ];
  const lines = rows.map(r => [
    r.rank,
    csvCell(r.partner_name),
    csvCell(r.phone_number),
    csvCell(r.agent_name),
    Math.round(Number(r.amount || 0)),
    r.score,
    r.daysOverdue === null ? '' : r.daysOverdue,
    csvCell(r.tierLabel),
    csvCell(r.assigned_owner),
    r.fulfilment_due_on || '',
    r.recorded_on || '',
    csvCell(r.last_contact),
    r.snoozed_until || '',
    csvCell((r.resolution || '').replace(/_/g, ' ')),
  ].join(','));
  return [header.join(','), ...lines].join('\n');
}

export function downloadQueueCsv(rows: QueueExportRow[]): void {
  const blob = new Blob([`﻿${buildQueueCsv(rows)}`], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `promissory-conversion-queue-${stamp()}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

export async function downloadQueuePdf(rows: QueueExportRow[], meta: QueueExportMeta): Promise<void> {
  const { default: jsPDF } = await import('jspdf');
  const autoTableMod: any = await import('jspdf-autotable');
  const autoTable = autoTableMod.default || autoTableMod;

  const doc = new jsPDF({ unit: 'mm', format: 'a4', orientation: 'landscape' });
  const pageWidth = doc.internal.pageSize.getWidth();
  const margin = 12;

  doc.setFillColor(146, 52, 234);
  doc.rect(0, 0, pageWidth, 20, 'F');
  doc.setTextColor(255, 255, 255);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(13);
  doc.text('WELILE — Promissory Conversion Queue', margin, 9);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(8);
  doc.text(`Generated: ${new Date().toLocaleString('en-GB')} · Partner Ops — Confidential`, margin, 15);
  doc.text(`By: ${meta.generatedBy || '—'}`, pageWidth - margin, 9, { align: 'right' });

  doc.setTextColor(0, 0, 0);
  doc.setFontSize(8);
  const filterBits = [
    `View: ${meta.viewLabel}`,
    `Tier: ${meta.tierLabel}`,
    `Sort: ${meta.sortLabel}`,
    meta.search ? `Search: "${meta.search}"` : null,
  ].filter(Boolean).join('   ·   ');
  doc.text(filterBits, margin, 26);

  const totalValue = rows.reduce((s, r) => s + Number(r.amount || 0), 0);
  const escalated = rows.filter(r => r.tierLabel === 'Escalated');

  autoTable(doc, {
    startY: 30,
    head: [['Rows', 'Total value', 'Escalated (7+ days late)', 'Escalated value']],
    body: [[
      String(rows.length),
      formatUGX(totalValue),
      String(escalated.length),
      formatUGX(escalated.reduce((s, r) => s + Number(r.amount || 0), 0)),
    ]],
    theme: 'grid',
    styles: { fontSize: 8 },
    headStyles: { fillColor: [60, 60, 60] },
    margin: { left: margin, right: margin },
  });

  autoTable(doc, {
    startY: (doc as any).lastAutoTable.finalY + 4,
    head: [[
      '#', 'Partner', 'Phone', 'Agent', 'Amount', 'Score',
      'Days late', 'Status', 'Owner', 'Promised', 'Last contact',
    ]],
    body: rows.map(r => [
      String(r.rank),
      r.partner_name || '—',
      r.phone_number || '—',
      r.agent_name || '—',
      formatUGX(Number(r.amount || 0)),
      String(r.score),
      r.daysOverdue === null ? '—' : String(Math.max(0, r.daysOverdue)),
      r.tierLabel,
      r.assigned_owner || '—',
      r.fulfilment_due_on || '—',
      r.last_contact || '—',
    ]),
    theme: 'striped',
    styles: { fontSize: 7, cellPadding: 1.2 },
    headStyles: { fillColor: [146, 52, 234], fontSize: 7 },
    columnStyles: {
      4: { halign: 'right' },
      5: { halign: 'center' },
      6: { halign: 'center' },
    },
    margin: { left: margin, right: margin },
    didDrawPage: () => {
      const pageH = doc.internal.pageSize.getHeight();
      doc.setFontSize(7);
      doc.setTextColor(120, 120, 120);
      doc.text(
        `Page ${doc.getNumberOfPages()} · Score = 60% promise size + 40% lateness (saturates at 30 days)`,
        margin,
        pageH - 5,
      );
    },
  });

  doc.save(`promissory-conversion-queue-${stamp()}.pdf`);
}
