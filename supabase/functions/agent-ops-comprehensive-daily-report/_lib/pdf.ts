// Branded PDF rendering of the Agent Ops Comprehensive Report.
//
// Visual language mirrors the institutional HTML report template:
// A4 portrait document pages, small purple company line, large dark section
// title, right-aligned meta table under a 2px dark rule, executive narrative
// block with a purple left bar, light-grey uppercase table headers with dark
// text, zebra rows, and a hairline footer carrying page numbers.
//
// Uses the same RPC payload as the HTML builder so the two reconcile exactly.

import { jsPDF } from 'https://esm.sh/jspdf@2.5.1';
import autoTable from 'https://esm.sh/jspdf-autotable@3.8.2';

type Any = any;
type RGB = [number, number, number];

const PRIMARY: RGB = [123, 25, 212];        // --primary
const PRIMARY_DARK: RGB = [88, 28, 135];    // --primary-dark
const TEXT_MAIN: RGB = [17, 24, 39];        // --text-main
const TEXT_BODY: RGB = [55, 65, 81];        // --text-body
const MUTED: RGB = [107, 114, 128];         // --text-muted
const BG_HEADER: RGB = [249, 250, 251];     // --bg-header
const BORDER: RGB = [229, 231, 235];        // --border-color
const BORDER_DARK: RGB = [209, 213, 219];   // --border-dark
const SUCCESS: RGB = [21, 128, 61];          // --status-success
const SUCCESS_BG: RGB = [240, 253, 244];
const WARNING: RGB = [180, 83, 9];           // --status-warning
const WARNING_BG: RGB = [255, 251, 235];
const DANGER: RGB = [185, 28, 28];           // --status-danger
const DANGER_BG: RGB = [254, 242, 242];
const NEUTRAL_LINE: RGB = [100, 116, 139];   // chart "expected" series
const GROUP_BG: RGB = [250, 245, 255];
const ZEBRA: RGB = [250, 250, 250];


const n = (v: unknown) => Math.round(Number(v) || 0);
const num = (v: unknown) => n(v).toLocaleString();
const ugx = (v: unknown) => `UGX ${n(v).toLocaleString()}`;
const pos = (v: number) => Math.max(0, v);
const pctNum = (part: number, whole: number) => (whole > 0 ? (part / whole) * 100 : 0);
const pct = (part: number, whole: number) => (whole > 0 ? `${((part / whole) * 100).toFixed(1)}%` : '—');
const day = (d?: string | null) => (d ? String(d).slice(0, 10) : '—');
const prettyDay = (d: string) => {
  const parsed = new Date(`${d}T12:00:00Z`);
  return Number.isNaN(parsed.getTime())
    ? d
    : parsed.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'UTC' });
};

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
  const networkSize = population ? n(population.total) : rentRows.length;
  const activeAgents = population ? n(population.active) : n(agents.active_today);
  const livePlans = rentRows.reduce((s, r) => s + n(r.live_plans), 0) || n(rent.live_plans);

  const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });
  const pageWidth = doc.internal.pageSize.getWidth();
  const pageHeight = doc.internal.pageSize.getHeight();
  const margin = 16;
  const contentW = pageWidth - margin * 2;
  const footerY = pageHeight - 14;

  const periodText = fromDate === toDate
    ? prettyDay(toDate)
    : `${prettyDay(fromDate)} – ${prettyDay(toDate)}`;
  const generatedText = `${new Date().toLocaleString('en-GB', {
    day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'Africa/Nairobi',
  })} EAT`;
  const referenceId = `AOR-${toDate.replace(/-/g, '')}`;

  let cursor = margin;
  let pageStarted = false;
  let lastHeader: { title: string; meta: [string, string][] } = { title: '', meta: [] };

  const drawHeader = (title: string, meta: [string, string][]) => {
    let y = margin;

    doc.setFont('helvetica', 'bold');
    doc.setFontSize(7.5);
    doc.setTextColor(...PRIMARY);
    doc.text('WELILE TECHNOLOGIES LIMITED', margin, y + 3);

    doc.setFontSize(16);
    doc.setTextColor(...TEXT_MAIN);
    doc.text(title, margin, y + 11);

    // Right-aligned meta rows
    let metaY = y + 2.5;
    meta.forEach(([label, value]) => {
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(7);
      doc.setTextColor(...MUTED);
      doc.text(label.toUpperCase(), pageWidth - margin - 42, metaY, { align: 'right' });
      doc.setFontSize(7.6);
      doc.setTextColor(...TEXT_MAIN);
      doc.text(value, pageWidth - margin, metaY, { align: 'right' });
      metaY += 4.2;
    });

    y = Math.max(y + 15, metaY - 1);
    doc.setDrawColor(...TEXT_MAIN);
    doc.setLineWidth(0.7);
    doc.line(margin, y, pageWidth - margin, y);
    return y + 7;
  };

  /** Document header, exactly as on each template page. */
  const pageHeader = (title: string, meta: [string, string][]) => {
    if (pageStarted) doc.addPage();
    pageStarted = true;
    lastHeader = { title, meta };
    cursor = drawHeader(title, meta);
  };


  const sectionSubtitle = (text: string) => {
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(8);
    doc.setTextColor(...MUTED);
    const lines = doc.splitTextToSize(text, contentW);
    doc.text(lines, margin, cursor);
    cursor += lines.length * 3.6 + 3;
  };

  const sectionTitle = (text: string) => {
    if (cursor > pageHeight - 55) { pageHeader(text, [['Period:', periodText], ['Section:', 'continued']]); }
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(11.5);
    doc.setTextColor(...TEXT_MAIN);
    doc.text(text, margin, cursor);
    doc.setDrawColor(...BORDER_DARK);
    doc.setLineWidth(0.3);
    doc.line(margin, cursor + 1.8, pageWidth - margin, cursor + 1.8);
    cursor += 6.5;
  };

  /** Purple-bar narrative block. */
  const narrative = (text: string) => {
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(8.6);
    const lines: string[] = doc.splitTextToSize(text, contentW - 10);
    const h = lines.length * 4.1 + 7;
    doc.setFillColor(...BG_HEADER);
    doc.rect(margin, cursor, contentW, h, 'F');
    doc.setFillColor(...PRIMARY);
    doc.rect(margin, cursor, 1.1, h, 'F');
    doc.setTextColor(...TEXT_BODY);
    doc.text(lines, margin + 5, cursor + 5);
    cursor += h + 6;
  };

  const noteBox = (title: string, lines: string[]) => {
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(7.8);
    const wrapped = lines.flatMap((l) => doc.splitTextToSize(l, contentW - 8) as string[]);
    const h = wrapped.length * 3.7 + 11;
    if (cursor + h > footerY - 4) return;
    doc.setFillColor(248, 250, 252);
    doc.setDrawColor(...BORDER);
    doc.setLineWidth(0.2);
    doc.rect(margin, cursor, contentW, h, 'FD');
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(7.2);
    doc.setTextColor(...MUTED);
    doc.text(title.toUpperCase(), margin + 4, cursor + 5);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(7.8);
    doc.setTextColor(...TEXT_BODY);
    doc.text(wrapped, margin + 4, cursor + 9.5);
    cursor += h + 6;
  };

  const statusTone = (raw: string): RGB => {
    const s = raw.toLowerCase();
    if (/(overdue|default|reject|fail|suspend|inactive)/.test(s)) return DANGER;
    if (/(pending|review|await|requested|warn|partial)/.test(s)) return WARNING;
    if (/(active|approved|paid|verified|operational|complete|cleared)/.test(s)) return SUCCESS;
    return MUTED;
  };
  const toneBg = (tone: RGB): RGB => (tone === DANGER ? DANGER_BG : tone === WARNING ? WARNING_BG : tone === SUCCESS ? SUCCESS_BG : BG_HEADER);

  const table = (opts: {
    head: string[];
    body: (string | number)[][];
    empty?: string;
    rightFrom?: number;
    groupRows?: number[];
    fontSize?: number;
    /** Per-column text colour, mirroring the template's coloured figures. */
    colColors?: Record<number, RGB>;
    /** Column rendered as a tinted status badge. */
    statusCol?: number;
    /** Rows rendered bold as period totals. */
    boldRows?: number[];
    /** Per-row colour applied to `rowToneCol`, keyed by body row index. */
    rowTones?: Record<number, RGB>;
    rowToneCol?: number;
  }) => {


    if (!opts.body.length) {
      doc.setFont('helvetica', 'italic');
      doc.setFontSize(8.2);
      doc.setTextColor(...MUTED);
      doc.text(opts.empty || 'No qualifying records in this period.', margin, cursor + 3);
      cursor += 10;
      return;
    }
    const rightFrom = opts.rightFrom ?? 2;
    const columnStyles: Record<number, Any> = {};
    for (let i = rightFrom; i < opts.head.length; i += 1) columnStyles[i] = { halign: 'right' };
    const startPage = (doc as Any).getCurrentPageInfo().pageNumber;
    autoTable(doc, {
      startY: cursor,
      head: [opts.head],
      body: opts.body,
      margin: { left: margin, right: margin, top: margin + 22, bottom: 18 },
      didDrawPage: () => {
        const pageNo = (doc as Any).getCurrentPageInfo().pageNumber;
        if (pageNo > startPage && lastHeader.title) {
          drawHeader(lastHeader.title, [
            ...lastHeader.meta.filter(([l]) => !/^section/i.test(l)),
            ['Section:', 'continued'],
          ]);
        }
      },

      styles: {
        font: 'helvetica',
        fontSize: opts.fontSize ?? 7.4,
        cellPadding: { top: 1.7, bottom: 1.7, left: 2.2, right: 2.2 },
        textColor: TEXT_MAIN,
        lineColor: BORDER,
        lineWidth: 0,
      },
      headStyles: {
        fillColor: BG_HEADER,
        textColor: MUTED,
        fontSize: 6.6,
        fontStyle: 'bold',
        lineColor: BORDER_DARK,
        lineWidth: { top: 0.3, bottom: 0.5, left: 0, right: 0 } as Any,
      },
      bodyStyles: { lineColor: BORDER, lineWidth: { top: 0, bottom: 0.2, left: 0, right: 0 } as Any },
      alternateRowStyles: { fillColor: ZEBRA },
      columnStyles,
      theme: 'plain',
      didParseCell: (data: Any) => {
        if (data.section !== 'body') return;
        if (opts.groupRows?.includes(data.row.index)) {
          data.cell.styles.fillColor = GROUP_BG;
          data.cell.styles.textColor = PRIMARY_DARK;
          data.cell.styles.fontStyle = 'bold';
          return;
        }
        if (opts.boldRows?.includes(data.row.index)) {
          data.cell.styles.fillColor = BG_HEADER;
          data.cell.styles.fontStyle = 'bold';
        }
        const colColor = opts.colColors?.[data.column.index];
        if (colColor) {
          const text = String(data.cell.raw ?? '');
          const zero = /^(—|UGX 0|0|0\.0%)$/.test(text.trim());
          if (!zero) {
            data.cell.styles.textColor = colColor;
            data.cell.styles.fontStyle = 'bold';
          }
        }
        if (opts.rowToneCol === data.column.index) {
          const tone = opts.rowTones?.[data.row.index];
          const placeholder = /^(—|UGX 0|0|0\.0%)$/.test(String(data.cell.raw ?? '').trim());
          if (tone && !placeholder) {
            data.cell.styles.textColor = tone;
            data.cell.styles.fontStyle = 'bold';
          }
        }

        if (opts.statusCol === data.column.index) {
          const tone = statusTone(String(data.cell.raw ?? ''));
          data.cell.styles.textColor = tone;
          data.cell.styles.fillColor = toneBg(tone);
          data.cell.styles.fontStyle = 'bold';
          data.cell.styles.halign = 'center';
        }
      },

    });
    cursor = (doc as Any).lastAutoTable.finalY + 7;
  };

  /**
   * Bordered chart block with grouped bars — the print equivalent of the
   * template's Chart.js canvases (grey = expected, green = collected,
   * red = shortfall).
   */
  const barChart = (opts: {
    title: string;
    subtitle: string;
    series: { label: string; color: RGB }[];
    points: { label: string; values: number[] }[];
    valueFormat?: (v: number) => string;
  }) => {
    if (!opts.points.length) return;
    const blockH = 62;
    if (cursor + blockH > footerY - 6) {
      pageHeader(lastHeader.title, [
        ...lastHeader.meta.filter(([l]) => !/^section/i.test(l)),
        ['Section:', 'continued'],
      ]);
    }
    const top = cursor;
    doc.setDrawColor(...BORDER);
    doc.setLineWidth(0.2);
    doc.rect(margin, top, contentW, blockH, 'S');

    doc.setFont('helvetica', 'bold');
    doc.setFontSize(8.6);
    doc.setTextColor(...TEXT_MAIN);
    doc.text(opts.title, margin + 4, top + 6);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(7);
    doc.setTextColor(...MUTED);
    doc.text(opts.subtitle, margin + 4, top + 10.4);

    // Legend
    let lx = margin + 4;
    const ly = top + 15;
    opts.series.forEach((s) => {
      doc.setFillColor(...s.color);
      doc.rect(lx, ly - 2.2, 2.6, 2.6, 'F');
      doc.setFontSize(6.6);
      doc.setTextColor(...TEXT_BODY);
      doc.text(s.label, lx + 3.8, ly);
      lx += 3.8 + doc.getTextWidth(s.label) + 7;
    });

    const plotTop = top + 19;
    const plotBottom = top + blockH - 10;
    const plotLeft = margin + 4;
    const plotRight = pageWidth - margin - 4;
    const plotH = plotBottom - plotTop;
    const max = Math.max(1, ...opts.points.flatMap((p) => p.values));

    // Gridlines
    doc.setDrawColor(...BORDER);
    doc.setLineWidth(0.15);
    for (let g = 0; g <= 4; g += 1) {
      const y = plotBottom - (plotH * g) / 4;
      doc.line(plotLeft, y, plotRight, y);
    }
    doc.setDrawColor(...BORDER_DARK);
    doc.setLineWidth(0.3);
    doc.line(plotLeft, plotBottom, plotRight, plotBottom);

    const slot = (plotRight - plotLeft) / opts.points.length;
    const barW = Math.min(4.2, (slot - 2) / opts.series.length);
    opts.points.forEach((p, i) => {
      const groupW = barW * opts.series.length;
      const x0 = plotLeft + slot * i + (slot - groupW) / 2;
      p.values.forEach((v, si) => {
        const h = Math.max(0.4, (Math.max(0, v) / max) * plotH);
        doc.setFillColor(...opts.series[si].color);
        doc.rect(x0 + barW * si, plotBottom - h, barW, h, 'F');
      });
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(5.6);
      doc.setTextColor(...MUTED);
      const label = p.label.length > 12 ? `${p.label.slice(0, 11)}.` : p.label;
      doc.text(label, x0 + groupW / 2, plotBottom + 3.4, { align: 'center' });
    });

    // Max-value axis annotation
    doc.setFontSize(5.8);
    doc.setTextColor(...MUTED);
    doc.text((opts.valueFormat ?? num)(max), plotRight, plotTop - 1.2, { align: 'right' });

    cursor = top + blockH + 6;
  };



  // ── Page 1 — cover, executive narrative, KPI matrix ───────────────────────
  pageHeader('Agent Operations Comprehensive Report', [
    ['Reporting Period:', periodText],
    ['Generated:', generatedText],
    ['Reference ID:', referenceId],
    ['Report Status:', 'Final / System generated'],
  ]);

  narrative(
    `EXECUTIVE SUMMARY: Agent Operations recorded ${ugx(collected)} in rent collections against `
    + `${expectedTotal > 0 ? ugx(expectedTotal) : 'an unexposed'} expected obligation for ${periodLabel.toLowerCase()} `
    + `(${periodText}), a collection rate of ${expectedTotal > 0 ? `${pctNum(collected, expectedTotal).toFixed(1)}%` : 'n/a'}. `
    + `The operational network comprised ${num(networkSize)} agents and sub-agents, of whom ${num(activeAgents)} were active, `
    + `managing ${num(livePlans)} live rent plans. ${ugx(outstandingRent)} remained outstanding on the rent book at the close of the period. `
    + `Agent advances carried ${ugx(advOutstanding)} outstanding with ${ugx(recovered)} recovered, while `
    + `${num(sc.active_total)} service centres were operational and ${num(sc.pending_total)} applications awaited a decision.`,
  );

  sectionTitle('Executive Key Performance Indicators');
  sectionSubtitle('Comprehensive summary matrix of core operational and financial measures for the reporting window.');

  const matrix: (string | number)[][] = [];
  const groupRows: number[] = [];
  const group = (label: string) => { groupRows.push(matrix.length); matrix.push([label, '', '', '']); };

  group('1. AGENT NETWORK STRUCTURE');
  matrix.push(['Network size', 'Total agent network (unique individuals)', num(networkSize), '—']);
  matrix.push(['Primary collectors', 'Agents active in the period', num(activeAgents), population ? pct(activeAgents, networkSize) : '—']);
  matrix.push(['Sub-agents', 'Sub-agents (total / active)', population ? `${num(population.sub_total)} / ${num(population.sub_active)}` : '—', '—']);
  matrix.push(['Coverage', 'Agents that collected in the period', `${num(agentsCollected)} / ${num(rentRows.length)}`, pct(agentsCollected, rentRows.length)]);

  group('2. RENT COLLECTIONS');
  matrix.push(['Expected', 'Scheduled rent obligation', expectedTotal > 0 ? ugx(expectedTotal) : '—', '—']);
  matrix.push(['Collected', 'Rent actually collected', ugx(collected), expectedTotal > 0 ? `${pctNum(collected, expectedTotal).toFixed(1)}% of expected` : '—']);
  matrix.push(['Shortfall', 'Expected less collected', expectedTotal > 0 ? ugx(pos(expectedTotal - collected)) : '—', '—']);
  matrix.push(['Book', 'Rent portfolio outstanding', ugx(outstandingRent), `${num(livePlans)} live plans`]);
  matrix.push(['Ageing', 'Average days outstanding', num(rent.avg_days_outstanding), '—']);

  group('3. AGENT ADVANCES');
  matrix.push(['Issued', 'Principal issued in period', ugx(adv.issued_today), `${num(adv.issued_count)} advances`]);
  matrix.push(['Recovered', 'Recovered in period', ugx(recovered), recovered + advOutstanding > 0 ? `${pctNum(recovered, recovered + advOutstanding).toFixed(1)}% recovery` : '—']);
  matrix.push(['Exposure', 'Outstanding advance balance', ugx(advOutstanding), `${num(adv.active_count)} active`]);

  group('4. SERVICE CENTRES');
  matrix.push(['Footprint', 'Operational service centres', num(sc.active_total), `${num(sc.new_today)} added in period`]);
  matrix.push(['Pipeline', 'Applications awaiting decision', num(sc.pending_total), '—']);
  matrix.push([`Target (${sc.target_month ?? '—'})`, 'Monthly additions against target', `${num(sc.new_this_month)} / ${num(sc.monthly_target)}`, pct(n(sc.new_this_month), n(sc.monthly_target))]);

  group('5. PRODUCTS & SERVICES');
  const issuedAll = productRows.filter((r) => r.is_issued);
  const prodValue = issuedAll.reduce((s, r) => s + (Number(r.value) || 0), 0);
  const prodPaid = issuedAll.reduce((s, r) => s + (Number(r.paid) || 0), 0);
  matrix.push(['Applications', 'Product and service applications', num(productRows.length), `${num(issuedAll.length)} issued`]);
  matrix.push(['Receivable', 'Issued value against collected', ugx(prodValue), `${ugx(prodPaid)} collected`]);
  matrix.push(['Recovery', 'Collected against issued value', pct(prodPaid, prodValue), '—']);

  const matrixTones: Record<number, RGB> = {};
  matrix.forEach((row, i) => {
    if (groupRows.includes(i)) return;
    const label = `${row[0]} ${row[1]}`.toLowerCase();
    if (/(shortfall|outstanding|exposure|overdue|missed|ageing|inactive)/.test(label)) matrixTones[i] = DANGER;
    else if (/(pending|pipeline|receivable|applications)/.test(label)) matrixTones[i] = WARNING;
    else if (/(collected|recovered|recovery|target|footprint|coverage|active)/.test(label)) matrixTones[i] = SUCCESS;
    else matrixTones[i] = PRIMARY_DARK;
  });

  table({
    head: ['Metric category', 'Key performance indicator', 'Value / total', 'Target / performance'],
    body: matrix,
    rightFrom: 2,
    groupRows,
    fontSize: 7.6,
    rowTones: matrixTones,
    rowToneCol: 2,
  });


  noteBox('Authoritative business definitions and methodology', [
    '• Agent: a person with at least one rent request they are actively collecting for.',
    '• Sub-agent: an individual holding a validated parent-child relationship with a primary agent; unique identifiers prevent double counting.',
    '• Financial shortfall: expected scheduled obligation less actual paid amount, floored at zero.',
    '• All figures are in UGX and reconcile to the on-screen Comprehensive Report for the same window.',
  ]);

  // ── Page 2 — rent collections ─────────────────────────────────────────────
  pageHeader('Rent Collections', [['Period:', periodText], ['Section:', 'Rent collections analysis']]);
  sectionSubtitle('Expected against actual tenant rent collections for the selected reporting period.');
  table({
    head: ['Expected rent', 'Rent collected', 'Outstanding', 'Collection rate', 'Transactions', 'Agents collecting', 'Live plans'],
    body: [[
      expectedTotal > 0 ? ugx(expectedTotal) : '—',
      ugx(collected),
      ugx(outstandingRent),
      expectedTotal > 0 ? `${pctNum(collected, expectedTotal).toFixed(1)}%` : '—',
      num(rent.collections_today),
      `${num(agentsCollected)} / ${num(rentRows.length)}`,
      num(livePlans),
    ]],
    rightFrom: 0,
    colColors: { 1: SUCCESS, 2: DANGER, 3: PRIMARY },
  });

  const topRent = [...rentRows]
    .sort((a, b) => perAgentExpected(b) - perAgentExpected(a))
    .slice(0, 12);
  barChart({
    title: 'Expected obligation against actual collections',
    subtitle: 'Twelve agents carrying the largest scheduled obligation in the reporting window (UGX).',
    series: [
      { label: 'Expected scheduled obligation', color: NEUTRAL_LINE },
      { label: 'Actual paid amount', color: SUCCESS },
      { label: 'Missed financial shortfall', color: DANGER },
    ],
    points: topRent.map((r) => {
      const exp = perAgentExpected(r);
      const got = Number(r.collected_today) || 0;
      return { label: String(r.agent_name ?? '—'), values: [exp, got, pos(exp - got)] };
    }),
    valueFormat: ugx,
  });

  sectionTitle('Agent Collection Performance');
  table({
    head: ['Agent name', 'Phone', 'Plans', 'Expected', 'Collected', 'Outstanding', 'Rate', 'Avg days'],
    body: [...rentRows]
      .sort((a, b) => pos(Number(b.outstanding)) - pos(Number(a.outstanding)))
      .slice(0, 30)
      .map((r) => {
        const exp = perAgentExpected(r);
        const got = Number(r.collected_today) || 0;
        return [
          String(r.agent_name ?? '—'), String(r.phone ?? '—'), num(r.live_plans),
          exp > 0 ? ugx(exp) : '—', ugx(got), ugx(pos(Number(r.outstanding))),
          exp > 0 ? `${pctNum(got, exp).toFixed(1)}%` : '—', num(r.avg_days_outstanding),
        ];
      }),
    colColors: { 4: SUCCESS, 5: DANGER, 6: PRIMARY },
    empty: 'No live rent receivables in this period.',
  });

  // ── Page 3 — agent advances ───────────────────────────────────────────────
  pageHeader('Agent Advances', [['Period:', periodText], ['Section:', 'Advance book and recovery']]);
  sectionSubtitle('Advance issuance, recovery performance and outstanding exposure across the agent network.');
  table({
    head: ['Total issued', 'Advances issued', 'Recovered', 'Deducted', 'Outstanding', 'Active advances', 'Agents holding', 'Recovery rate'],
    body: [[
      ugx(adv.issued_today), num(adv.issued_count), ugx(recovered), ugx(adv.deducted_today),
      ugx(advOutstanding), num(adv.active_count),
      num(new Set(advRows.map((r) => r.agent_name)).size),
      recovered + advOutstanding > 0 ? `${pctNum(recovered, recovered + advOutstanding).toFixed(1)}%` : '—',
    ]],
    rightFrom: 0,
    colColors: { 2: SUCCESS, 3: WARNING, 4: DANGER, 7: SUCCESS },
  });

  sectionTitle('Advance Portfolio Detail');
  table({
    head: ['Agent', 'Phone', 'Principal (UGX)', 'Repaid (UGX)', 'Outstanding (UGX)', 'Installment (UGX)', 'Recovery', 'Issued', 'Status'],
    body: [...advRows]
      .sort((a, b) => pos(Number(b.outstanding)) - pos(Number(a.outstanding)))
      .slice(0, 30)
      .map((r) => [
        String(r.agent_name ?? '—'), String(r.phone ?? '—'),
        num(r.principal), num(r.recovered),
        num(pos(Number(r.outstanding))), num(r.installment),
        pct(Number(r.recovered) || 0, Number(r.principal) || 0),
        day(r.issued_at), String(r.status ?? 'unknown').replace(/_/g, ' '),
      ]),
    colColors: { 3: SUCCESS, 4: DANGER, 6: PRIMARY },
    statusCol: 8,
    empty: 'No advances recorded in this window.',
  });



  // ── Page 4 — service centres ──────────────────────────────────────────────
  pageHeader('Service Centers', [['Period:', periodText], ['Section:', 'Service centre network']]);
  sectionSubtitle('Requested, approved and operational service centres with the agents assigned to them.');
  table({
    head: ['Operational centres', 'Pending applications', 'Added in period', 'Added this month', `Target (${sc.target_month ?? '—'})`, 'Target achievement'],
    body: [[
      num(sc.active_total), num(sc.pending_total), num(sc.new_today), num(sc.new_this_month),
      num(sc.monthly_target), pct(n(sc.new_this_month), n(sc.monthly_target)),
    ]],
    rightFrom: 0,
    colColors: { 1: WARNING, 2: SUCCESS, 5: PRIMARY },
  });


  sectionTitle('Service Centers and Managing Agent Assignments');
  table({
    head: ['Service centre / location', 'Managing agent', 'Phone', 'Requested', 'Verified', 'Approved', 'Status'],
    body: scRows.slice(0, 30).map((r) => [
      String(r.location_name ?? '—'), String(r.agent_name ?? '—'), String(r.agent_phone ?? '—'),
      day(r.created_at), day(r.verified_at), day(r.approved_at),
      String(r.status ?? 'unknown').replace(/_/g, ' '),
    ]),
    rightFrom: 3,
    statusCol: 6,
    empty: 'No service centre activity in this period.',
  });


  // ── Page 5 — products and services ────────────────────────────────────────
  pageHeader('Agent Products & Services', [['Period:', periodText], ['Section:', 'Product lines and recovery']]);
  sectionSubtitle('Applications captured in the field with issued value against amounts collected.');

  const byProduct = new Map<string, Any[]>();
  for (const r of productRows) {
    const key = r.product === 'bike' ? 'Motor bikes' : r.product === 'smartphone' ? 'Smartphones' : 'Merchandise';
    if (!byProduct.has(key)) byProduct.set(key, []);
    byProduct.get(key)!.push(r);
  }
  table({
    head: ['Product line', 'Applications', 'Issued', 'Not issued', 'Issued value', 'Collected', 'Outstanding', 'Recovery'],
    body: [...byProduct.entries()].map(([label, rows]) => {
      const issued = rows.filter((r) => r.is_issued);
      const value = issued.reduce((s, r) => s + (Number(r.value) || 0), 0);
      const paid = issued.reduce((s, r) => s + (Number(r.paid) || 0), 0);
      const out = issued.reduce((s, r) => s + pos(Number(r.outstanding) || 0), 0);
      return [label, num(rows.length), num(issued.length), num(rows.length - issued.length), ugx(value), ugx(paid), ugx(out), pct(paid, value)];
    }),
    colColors: { 5: SUCCESS, 6: DANGER, 7: PRIMARY },
    empty: 'No product applications in this period.',
  });


  if (population) {
    sectionTitle('Network Position');
    table({
      head: ['Indicator', 'Value', 'Indicator', 'Value'],
      body: [
        ['Total operational agents', num(population.total), 'Ever collected', num(population.ever_collected)],
        ['Active in period', num(population.active), 'Inactive in period', num(population.inactive)],
        ['Primary agents (total / active)', `${num(population.primary_total)} / ${num(population.primary_active)}`, 'Sub-agents (total / active)', `${num(population.sub_total)} / ${num(population.sub_active)}`],
        ['Agents with a live plan', num(population.live_plan_agents), 'Live plans with no collection', num(population.live_plan_no_collection)],
      ],
      rightFrom: 1,
    });
  }

  // ── Footers ───────────────────────────────────────────────────────────────
  const pages = doc.getNumberOfPages();
  for (let i = 1; i <= pages; i += 1) {
    doc.setPage(i);
    doc.setDrawColor(...BORDER);
    doc.setLineWidth(0.2);
    doc.line(margin, footerY - 4, pageWidth - margin, footerY - 4);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(7);
    doc.setTextColor(...MUTED);
    doc.text('Welile Technologies Limited • Confidential', margin, footerY);
    doc.text(`Agent Operations Report | Page ${i} of ${pages}`, pageWidth - margin, footerY, { align: 'right' });
  }

  return new Uint8Array(doc.output('arraybuffer') as ArrayBuffer);
}

/** Highlight colours reused by the email summary. */
export const REPORT_ACCENTS = { SUCCESS, DANGER, PRIMARY };
