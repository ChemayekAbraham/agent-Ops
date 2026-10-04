import { formatUGX } from '@/lib/rentCalculations';

export interface CollectionsStatementAgent {
  name: string;
  phone: string | null;
  collected: number;
  expected: number;
  collections_count: number;
  tenants_paid: number;
  active_tenants: number;
  expected_source: 'history' | 'projected';
  last_collection_at: string | null;
  pct: number | null;
}

export interface CollectionsStatementInput {
  periodLabel: string;
  rangeStart: Date;
  rangeEnd: Date;
  bucket: string;
  generatedAt?: string | null;
  totals: {
    collected: number;
    expected: number;
    collections_count: number;
    avg_collection: number;
    active_agents: number;
    tenants_paid: number;
    requests_count: number;
    requests_amount: number;
  };
  series: { label: string; collected: number; requests: number; collectionsCount: number }[];
  peak: { label: string; amount: number; count: number }[];
  agents: CollectionsStatementAgent[];
}

const PURPLE: [number, number, number] = [107, 33, 168];
const d = (v: Date) => v.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });

/**
 * Financial statement style PDF for agent rent collections vs expected targets.
 * Purely a presentation of the data already loaded in the command center.
 */
export async function generateAgentCollectionsStatementPdf(input: CollectionsStatementInput): Promise<Blob> {
  const { jsPDF } = await import('jspdf');
  const autoTableMod: any = await import('jspdf-autotable');
  const autoTable = autoTableMod.default || autoTableMod;

  const doc = new jsPDF({ unit: 'mm', format: 'a4', orientation: 'portrait', compress: true });
  const pw = doc.internal.pageSize.getWidth();
  const margin = 12;

  // Header band
  doc.setFillColor(...PURPLE);
  doc.rect(0, 0, pw, 30, 'F');
  doc.setTextColor(255, 255, 255);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(20);
  doc.text('Welile', margin, 19);
  doc.setFontSize(13);
  doc.text('Agent Collections Financial Statement', pw - margin, 13, { align: 'right' });
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(8.5);
  doc.text(input.periodLabel, pw - margin, 19, { align: 'right' });
  doc.text(
    `${d(input.rangeStart)} — ${d(input.rangeEnd)} · grouped by ${input.bucket} · EAT`,
    pw - margin,
    24,
    { align: 'right' },
  );

  doc.setTextColor(0, 0, 0);
  doc.setFontSize(8);
  doc.text(
    `Generated ${new Date(input.generatedAt || Date.now()).toLocaleString('en-GB')}`,
    margin,
    36,
  );

  const t = input.totals;
  const variance = t.collected - t.expected;
  const coverage = t.expected > 0 ? (t.collected / t.expected) * 100 : null;

  // Statement of collections
  autoTable(doc, {
    startY: 40,
    head: [['Statement of collections', 'Amount (UGX)']],
    body: [
      ['Expected collections (daily targets in period)', formatUGX(t.expected)],
      ['Collections recorded', formatUGX(t.collected)],
      ['Variance (collected less expected)', formatUGX(variance)],
      ['Collection rate', coverage === null ? 'No expectation on record' : `${coverage.toFixed(1)}%`],
      ['Payments recorded', String(t.collections_count)],
      ['Average payment', formatUGX(t.avg_collection)],
      ['Active agents', String(t.active_agents)],
      ['Tenants paid', String(t.tenants_paid)],
      ['New rent requests', `${t.requests_count} · ${formatUGX(t.requests_amount)}`],
    ],
    theme: 'grid',
    styles: { fontSize: 8.5, cellPadding: 2 },
    headStyles: { fillColor: PURPLE, textColor: 255, fontSize: 9 },
    columnStyles: { 1: { halign: 'right', fontStyle: 'bold' } },
    margin: { left: margin, right: margin },
  });

  // Period movement
  if (input.series.length) {
    autoTable(doc, {
      startY: (doc as any).lastAutoTable.finalY + 6,
      head: [['Period', 'Collected (UGX)', 'Payments', 'Rent requested (UGX)']],
      body: input.series.map(s => [
        s.label,
        formatUGX(s.collected),
        String(s.collectionsCount),
        formatUGX(s.requests),
      ]),
      foot: [[
        'Total',
        formatUGX(input.series.reduce((a, s) => a + s.collected, 0)),
        String(input.series.reduce((a, s) => a + s.collectionsCount, 0)),
        formatUGX(input.series.reduce((a, s) => a + s.requests, 0)),
      ]],
      theme: 'striped',
      styles: { fontSize: 8, cellPadding: 1.6 },
      headStyles: { fillColor: PURPLE, textColor: 255 },
      footStyles: { fillColor: [243, 232, 255], textColor: 40, fontStyle: 'bold' },
      columnStyles: { 1: { halign: 'right' }, 2: { halign: 'right' }, 3: { halign: 'right' } },
      margin: { left: margin, right: margin },
    });
  }

  // Agent schedule
  autoTable(doc, {
    startY: (doc as any).lastAutoTable.finalY + 6,
    head: [['#', 'Agent', 'Phone', 'Expected', 'Collected', 'Variance', 'Rate', 'Payments', 'Tenants paid']],
    body: input.agents.map((a, i) => [
      String(i + 1),
      a.expected_source === 'projected' ? `${a.name} *` : a.name,
      a.phone || '—',
      formatUGX(a.expected),
      formatUGX(a.collected),
      formatUGX(a.collected - a.expected),
      a.pct === null ? '—' : `${a.pct}%`,
      String(a.collections_count),
      `${a.tenants_paid}/${a.active_tenants}`,
    ]),
    foot: [[
      '',
      `${input.agents.length} agents`,
      '',
      formatUGX(input.agents.reduce((s, a) => s + a.expected, 0)),
      formatUGX(input.agents.reduce((s, a) => s + a.collected, 0)),
      formatUGX(input.agents.reduce((s, a) => s + (a.collected - a.expected), 0)),
      coverage === null ? '—' : `${coverage.toFixed(1)}%`,
      String(input.agents.reduce((s, a) => s + a.collections_count, 0)),
      String(input.agents.reduce((s, a) => s + a.tenants_paid, 0)),
    ]],
    theme: 'grid',
    styles: { fontSize: 7.2, cellPadding: 1.4, overflow: 'linebreak' },
    headStyles: { fillColor: PURPLE, textColor: 255, fontSize: 7.4 },
    footStyles: { fillColor: [243, 232, 255], textColor: 40, fontStyle: 'bold' },
    columnStyles: {
      0: { cellWidth: 7, halign: 'right' },
      2: { cellWidth: 24 },
      3: { halign: 'right' },
      4: { halign: 'right', fontStyle: 'bold' },
      5: { halign: 'right' },
      6: { halign: 'right', cellWidth: 12 },
      7: { halign: 'right', cellWidth: 14 },
      8: { halign: 'right', cellWidth: 16 },
    },
    margin: { left: margin, right: margin },
  });

  // Peak hours
  if (input.peak.some(p => p.amount > 0)) {
    autoTable(doc, {
      startY: (doc as any).lastAutoTable.finalY + 6,
      head: [['Hour (EAT)', 'Collected (UGX)', 'Payments']],
      body: input.peak.filter(p => p.amount > 0).map(p => [p.label, formatUGX(p.amount), String(p.count)]),
      theme: 'striped',
      styles: { fontSize: 8, cellPadding: 1.6 },
      headStyles: { fillColor: PURPLE, textColor: 255 },
      columnStyles: { 1: { halign: 'right' }, 2: { halign: 'right' } },
      margin: { left: margin, right: margin },
    });
  }

  // Notes + page numbers
  const notesY = (doc as any).lastAutoTable.finalY + 6;
  doc.setFontSize(7.5);
  doc.setTextColor(90, 90, 90);
  doc.text(
    '* Expected target projected from the agent\'s current daily target where no daily snapshot exists.',
    margin,
    notesY,
  );
  doc.text(
    'Collected figures come from recorded agent collections. All amounts in Ugandan Shillings (UGX).',
    margin,
    notesY + 4,
  );

  const pages = doc.getNumberOfPages();
  for (let i = 1; i <= pages; i++) {
    doc.setPage(i);
    doc.setFontSize(7);
    doc.setTextColor(130, 130, 130);
    doc.text(
      `Welile · Agent Collections Financial Statement · Page ${i} of ${pages}`,
      pw / 2,
      doc.internal.pageSize.getHeight() - 6,
      { align: 'center' },
    );
  }

  return doc.output('blob');
}
