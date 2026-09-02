// Branded PDF rendering of the Agent Ops Comprehensive Report.
// Uses the same RPC payload as the HTML builder so the two reconcile exactly.

import { jsPDF } from 'https://esm.sh/jspdf@2.5.1';
import autoTable from 'https://esm.sh/jspdf-autotable@3.8.2';

type Any = any;
type RGB = [number, number, number];

const BRAND: RGB = [123, 25, 212];
const BRAND_DARK: RGB = [70, 12, 122];
const MUTED: RGB = [110, 110, 125];
const BORDER: RGB = [220, 218, 230];
const EMERALD: RGB = [21, 128, 61];
const ROSE: RGB = [190, 24, 60];
const AMBER: RGB = [180, 83, 9];
const BLUE: RGB = [29, 78, 216];

const n = (v: unknown) => Math.round(Number(v) || 0);
const num = (v: unknown) => n(v).toLocaleString();
const ugx = (v: unknown) => `UGX ${n(v).toLocaleString()}`;
const pos = (v: number) => Math.max(0, v);
const pctNum = (part: number, whole: number) => (whole > 0 ? (part / whole) * 100 : 0);
const pct = (part: number, whole: number) => (whole > 0 ? `${((part / whole) * 100).toFixed(1)}%` : '—');
const tint = (c: RGB, f: number): RGB => [
  Math.round(c[0] + (255 - c[0]) * f),
  Math.round(c[1] + (255 - c[1]) * f),
  Math.round(c[2] + (255 - c[2]) * f),
];
const day = (d?: string | null) => (d ? String(d).slice(0, 10) : '—');

export function buildComprehensiveReportPdf(input: {
  report: Any;
  population?: Any;
  fromDate: string;
  toDate: string;
  periodLabel: string;
}): Uint8Array {
  const { report, population, fromDate, toDate, periodLabel } = input;
  const rent = report?.rent ?? {};
  const adv = report?.advances ?? {};
  const sc = report?.service_centres ?? {};
  const agents = report?.agents ?? {};
  const rentRows: Any[] = report?.rent_rows || [];
  const advRows: Any[] = report?.advance_rows || [];
  const scRows: Any[] = report?.service_centre_rows || [];
  const productRows: Any[] = report?.product_rows || [];

  const perAgentExpected = (r: Any) => Number(r.expected_cumulative) || Number(r.daily_receivable) || 0;
  const collected = rentRows.reduce((s, r) => s + (Number(r.collected_today) || 0), 0);
  const expectedTotal = rentRows.reduce((s, r) => s + perAgentExpected(r), 0);
  const outstandingRent = rentRows.reduce((s, r) => s + pos(Number(r.outstanding) || 0), 0);
  const agentsCollected = rentRows.filter((r) => (Number(r.collected_today) || 0) > 0).length;
  const recovered = advRows.reduce((s, r) => s + (Number(r.recovered) || 0), 0);
  const advOutstanding = pos(Number(adv.outstanding) || 0);

  const doc = new jsPDF({ orientation: 'landscape', unit: 'mm', format: 'a4' });
  const pageWidth = doc.internal.pageSize.getWidth();
  const margin = 12;

  // Header band
  doc.setFillColor(...BRAND);
  doc.rect(0, 0, pageWidth, 24, 'F');
  doc.setFillColor(...BRAND_DARK);
  doc.rect(0, 24, pageWidth, 1.5, 'F');
  doc.setTextColor(255, 255, 255);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(15);
  doc.text('Agent Operations — Comprehensive Report', margin, 11);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(9);
  doc.setTextColor(232, 220, 250);
  doc.text(`${periodLabel} · ${fromDate === toDate ? fromDate : `${fromDate} to ${toDate}`}`, margin, 17.5);
  doc.setTextColor(255, 255, 255);
  doc.setFontSize(8.5);
  doc.text(
    `Generated ${new Date().toLocaleString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'Africa/Nairobi' })} EAT`,
    pageWidth - margin, 11, { align: 'right' },
  );
  doc.setTextColor(225, 210, 248);
  doc.text('Automated daily report', pageWidth - margin, 17, { align: 'right' });

  // KPI cards
  const cards: { label: string; value: string; sub: string; accent: RGB }[] = [
    { label: 'Operational agents', value: population ? num(population.total) : num(rentRows.length), sub: population ? `${num(population.active)} active in period` : 'network figure pending', accent: BRAND },
    { label: 'Active agents', value: population ? num(population.active) : num(agents.active_today), sub: population ? `${pct(n(population.active), n(population.total))} of network` : 'transacting in period', accent: EMERALD },
    { label: 'Sub-agents', value: population ? num(population.sub_total) : '—', sub: population ? `${num(population.sub_active)} active` : 'pending', accent: BLUE },
    { label: 'Rent collected', value: ugx(collected), sub: `${num(agentsCollected)} of ${num(rentRows.length)} agents collected`, accent: EMERALD },
    { label: 'Rent expected', value: expectedTotal > 0 ? ugx(expectedTotal) : '—', sub: expectedTotal > 0 ? `${pctNum(collected, expectedTotal).toFixed(1)}% collection rate` : 'not exposed', accent: AMBER },
    { label: 'Rent outstanding', value: ugx(outstandingRent), sub: `${num(rent.live_plans)} live plans`, accent: ROSE },
    { label: 'Advance outstanding', value: ugx(advOutstanding), sub: `${ugx(adv.issued_today)} issued in period`, accent: AMBER },
    { label: 'Service centres', value: num(sc.active_total), sub: `${num(sc.pending_total)} pending`, accent: BRAND_DARK },
  ];
  const cols = 4, gap = 4;
  const cardW = (pageWidth - margin * 2 - gap * (cols - 1)) / cols;
  const cardH = 20, startY = 31;
  cards.forEach((c, i) => {
    const x = margin + (i % cols) * (cardW + gap);
    const y = startY + Math.floor(i / cols) * (cardH + gap);
    doc.setFillColor(...tint(c.accent, 0.93));
    doc.setDrawColor(...BORDER);
    doc.setLineWidth(0.2);
    doc.roundedRect(x, y, cardW, cardH, 2, 2, 'FD');
    doc.setFillColor(...c.accent);
    doc.rect(x, y, cardW, 1.8, 'F');
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(6.6);
    doc.setTextColor(...MUTED);
    doc.text(c.label.toUpperCase(), x + 3.5, y + 7.5);
    doc.setFontSize(11.5);
    doc.setTextColor(...c.accent);
    doc.text(c.value, x + 3.5, y + 14);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(6);
    doc.setTextColor(...MUTED);
    doc.text(c.sub, x + 3.5, y + 18);
  });

  let cursor = startY + 2 * (cardH + gap) + 4;

  const section = (title: string, head: string[], body: (string | number)[][], empty: string) => {
    if (cursor > 165) { doc.addPage(); cursor = 18; }
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(11);
    doc.setTextColor(...BRAND_DARK);
    doc.text(title, margin, cursor);
    doc.setDrawColor(...BRAND);
    doc.setLineWidth(0.4);
    doc.line(margin, cursor + 1.6, pageWidth - margin, cursor + 1.6);
    cursor += 5;
    if (!body.length) {
      doc.setFont('helvetica', 'italic');
      doc.setFontSize(8.5);
      doc.setTextColor(...MUTED);
      doc.text(empty, margin, cursor + 3);
      cursor += 10;
      return;
    }
    autoTable(doc, {
      startY: cursor,
      head: [head],
      body,
      margin: { left: margin, right: margin },
      styles: { fontSize: 7.4, cellPadding: 1.6, textColor: [40, 40, 55], lineColor: BORDER, lineWidth: 0.1 },
      headStyles: { fillColor: BRAND, textColor: [255, 255, 255], fontSize: 7.2, fontStyle: 'bold' },
      alternateRowStyles: { fillColor: [248, 246, 252] },
      theme: 'grid',
    });
    cursor = (doc as Any).lastAutoTable.finalY + 8;
  };

  // Network
  if (population) {
    section('Network position', ['Indicator', 'Value', 'Indicator', 'Value'], [
      ['Total operational agents', num(population.total), 'Ever collected', num(population.ever_collected)],
      ['Active in period', num(population.active), 'Inactive in period', num(population.inactive)],
      ['Primary agents (total / active)', `${num(population.primary_total)} / ${num(population.primary_active)}`, 'Sub-agents (total / active)', `${num(population.sub_total)} / ${num(population.sub_active)}`],
      ['Agents with a live plan', num(population.live_plan_agents), 'Live plans with no collection', num(population.live_plan_no_collection)],
    ], 'Population data unavailable.');
  }

  // Rent
  section('Rent collections — summary', ['Indicator', 'Value', 'Indicator', 'Value'], [
    ['Total rent collected', ugx(collected), 'Expected rent (scheduled)', expectedTotal > 0 ? ugx(expectedTotal) : '—'],
    ['Collection rate', expectedTotal > 0 ? `${pctNum(collected, expectedTotal).toFixed(1)}%` : '—', 'Missed / shortfall', expectedTotal > 0 ? ugx(pos(expectedTotal - collected)) : '—'],
    ['Collection transactions', num(rent.collections_today), 'Portfolio outstanding', ugx(outstandingRent)],
    ['Agents collecting', `${num(agentsCollected)} / ${num(rentRows.length)}`, 'Average days outstanding', num(rent.avg_days_outstanding)],
  ], 'No rent data in this window.');

  section(
    'Collections by agent (top 25 by outstanding)',
    ['Agent', 'Phone', 'Plans', 'Expected', 'Collected', 'Outstanding', 'Rate', 'Avg days'],
    [...rentRows]
      .sort((a, b) => pos(Number(b.outstanding)) - pos(Number(a.outstanding)))
      .slice(0, 25)
      .map((r) => {
        const exp = perAgentExpected(r);
        const got = Number(r.collected_today) || 0;
        return [
          String(r.agent_name ?? '—'), String(r.phone ?? '—'), num(r.live_plans),
          exp > 0 ? ugx(exp) : '—', ugx(got), ugx(pos(Number(r.outstanding))),
          exp > 0 ? `${pctNum(got, exp).toFixed(1)}%` : '—', num(r.avg_days_outstanding),
        ];
      }),
    'No live rent receivables in this period.',
  );

  // Advances
  section('Agent advances — summary', ['Indicator', 'Value', 'Indicator', 'Value'], [
    ['Principal issued in period', ugx(adv.issued_today), 'Advances issued (count)', num(adv.issued_count)],
    ['Outstanding advance balance', ugx(advOutstanding), 'Active repaying advances', num(adv.active_count)],
    ['Recovered (period rows)', ugx(recovered), 'Recovery rate', recovered + advOutstanding > 0 ? `${pctNum(recovered, recovered + advOutstanding).toFixed(1)}%` : '—'],
    ['Deducted in period', ugx(adv.deducted_today), 'Agents holding advances', num(new Set(advRows.map((r) => r.agent_name)).size)],
  ], 'No advance data in this window.');

  section(
    'Advances (top 20 by outstanding)',
    ['Agent', 'Phone', 'Principal', 'Repaid', 'Outstanding', 'Installment', 'Recovery %', 'Issued', 'Status'],
    [...advRows]
      .sort((a, b) => pos(Number(b.outstanding)) - pos(Number(a.outstanding)))
      .slice(0, 20)
      .map((r) => [
        String(r.agent_name ?? '—'), String(r.phone ?? '—'), ugx(r.principal), ugx(r.recovered),
        ugx(pos(Number(r.outstanding))), ugx(r.installment),
        pct(Number(r.recovered) || 0, Number(r.principal) || 0),
        day(r.issued_at), String(r.status ?? 'unknown').replace(/_/g, ' '),
      ]),
    'No advances recorded in this window.',
  );

  // Service centres
  section('Service centres — summary', ['Indicator', 'Value', 'Indicator', 'Value'], [
    ['Operational service centres', num(sc.active_total), 'Pending applications', num(sc.pending_total)],
    ['Added in period', num(sc.new_today), 'Added this month', num(sc.new_this_month)],
    [`Monthly target (${sc.target_month ?? '—'})`, num(sc.monthly_target), 'Target achievement', pct(n(sc.new_this_month), n(sc.monthly_target))],
  ], 'No service centre data in this window.');

  section(
    'Service centres in period',
    ['Service centre / location', 'Managing agent', 'Phone', 'Requested', 'Verified', 'Approved', 'Status'],
    scRows.slice(0, 25).map((r) => [
      String(r.location_name ?? '—'), String(r.agent_name ?? '—'), String(r.agent_phone ?? '—'),
      day(r.created_at), day(r.verified_at), day(r.approved_at),
      String(r.status ?? 'unknown').replace(/_/g, ' '),
    ]),
    'No service centre activity in this period.',
  );

  // Products
  const byProduct = new Map<string, Any[]>();
  for (const r of productRows) {
    const key = r.product === 'bike' ? 'Motor bikes' : r.product === 'smartphone' ? 'Smartphones' : 'Merchandise';
    if (!byProduct.has(key)) byProduct.set(key, []);
    byProduct.get(key)!.push(r);
  }
  section(
    'Agent products & services',
    ['Product', 'Applications', 'Issued', 'Not issued', 'Approved principal', 'Collected', 'Outstanding', 'Rate'],
    [...byProduct.entries()].map(([label, rows]) => {
      const issued = rows.filter((r) => r.is_issued);
      const value = issued.reduce((s, r) => s + (Number(r.value) || 0), 0);
      const paid = issued.reduce((s, r) => s + (Number(r.paid) || 0), 0);
      const out = issued.reduce((s, r) => s + pos(Number(r.outstanding) || 0), 0);
      return [label, num(rows.length), num(issued.length), num(rows.length - issued.length), ugx(value), ugx(paid), ugx(out), pct(paid, value)];
    }),
    'No product applications in this period.',
  );

  // Footer page numbers
  const pages = doc.getNumberOfPages();
  for (let i = 1; i <= pages; i++) {
    doc.setPage(i);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(7);
    doc.setTextColor(...MUTED);
    doc.text('Welile Agent Operations · figures reconcile to the on-screen Comprehensive Report', margin, doc.internal.pageSize.getHeight() - 6);
    doc.text(`Page ${i} of ${pages}`, pageWidth - margin, doc.internal.pageSize.getHeight() - 6, { align: 'right' });
  }

  return new Uint8Array(doc.output('arraybuffer') as ArrayBuffer);
}
