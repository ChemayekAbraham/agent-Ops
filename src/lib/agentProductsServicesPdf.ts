import jsPDF from 'jspdf';
import { format } from 'date-fns';

export interface ApsAgents { new_today: number; new_prev: number; total: number; base: number; active_today: number }
export interface ApsRent {
  collected_today: number; collected_prev: number; collections_today: number;
  outstanding: number; daily_receivable: number; live_plans: number; avg_days_outstanding: number;
  expected_cumulative?: number; expected_days?: number;
}
export interface ApsAdvances {
  submitted: number; approved: number; rejected: number; issued_today: number;
  issued_count: number; deducted_today: number; outstanding: number; active_count: number;
}
export interface ApsServiceCentres {
  active_total: number; new_today: number; new_prev: number; new_this_month: number;
  pending_total: number; monthly_target: number; target_month: string;
}
export interface ApsProduct {
  issued_today: number; issued_total: number; total_value: number;
  paid: number; outstanding: number; daily_receivable: number;
  pending_total?: number;
  /** Value of ordered-but-not-yet-issued units, already included in total_value. */
  pending_value?: number;
}
export interface ApsTrendPoint {
  day: string; collected: number; advances_issued: number; advances_deducted: number;
  service_centres_added: number; new_agents: number;
}
export interface ApsNewAgentRow {
  id: string; name: string; phone: string | null; location: string | null;
  created_at: string; agent_type: 'main agent' | 'sub-agent'; parent_name: string | null;
}
export interface ApsRentRow {
  agent_id: string; agent_name: string; phone: string | null; location: string | null;
  live_plans: number; outstanding: number; daily_receivable: number; repaid_to_date: number;
  avg_days_outstanding: number; collected_today: number;
  expected_cumulative?: number;
}
export interface ApsAdvanceRow {
  id: string; agent_name: string; phone: string | null; status: string;
  principal: number; outstanding: number; recovered: number; installment: number;
  issued_at: string | null; deducted_today: number;
}
export interface ApsServiceCentreRow {
  id: string; agent_name: string; agent_phone: string | null; location_name: string | null;
  status: string; created_at: string; verified_at: string | null; approved_at: string | null;
}
export interface ApsProductRow {
  id: string; product: 'bike' | 'smartphone'; item_name: string; quantity: number;
  value: number; paid: number; outstanding: number; payment_status: string | null;
  order_status: string | null; payment_plan: string | null; sale_date: string | null;
  /** Real handover date (CFO disbursement / lease activation / access acceptance). */
  issued_date: string | null;
  is_issued: boolean;
  client_name: string | null; client_phone: string | null; daily_rate: number;
  recovery_status: string | null; last_recovery_at: string | null;
  repayment_rate: number; repayment_position: string;
}
export interface ApsFloatRow {
  agent_id: string; agent_name: string; phone: string | null; location: string | null;
  float_received: number; float_paid_out: number; closing_float: number;
  commission_balance: number; transactions: number;
  collections_amount: number; collections_count: number;
}
export interface ApsReport {
  day: string; timezone: string; generated_at: string;
  from_date?: string | null; to_date?: string | null; range_days?: number | null;
  agents: ApsAgents; rent: ApsRent; advances: ApsAdvances; service_centres: ApsServiceCentres;
  bikes: ApsProduct; phones: ApsProduct;
  trend: ApsTrendPoint[];
  new_agent_rows: ApsNewAgentRow[];
  rent_rows: ApsRentRow[];
  advance_rows: ApsAdvanceRow[];
  service_centre_rows: ApsServiceCentreRow[];
  product_rows: ApsProductRow[];
  agent_float_rows: ApsFloatRow[];
}

/** One cumulative window: everything from `from_date` up to the reporting date. */
export interface ApsCumulativeWindow {
  days: number;
  from_date: string;
  to_date: string;
  rent_collected: number;
  collections_count: number;
  collecting_agents: number;
  new_agents: number;
  advances_issued: number;
  advances_count: number;
  advances_recovered: number;
}

export interface ApsCumulative {
  as_of: string;
  timezone: string;
  windows: ApsCumulativeWindow[];
}

export const apsWindowLabel = (days: number) =>
  days === 365 ? 'Last 1 year (365 days)' : `Last ${days} days`;

export function apsPctChange(current: number, previous: number): number | null {
  const c = Number(current) || 0;
  const p = Number(previous) || 0;
  if (p === 0) return c === 0 ? 0 : null;
  return ((c - p) / p) * 100;
}

export function apsPctLabel(current: number, previous: number): string {
  const v = apsPctChange(current, previous);
  if (v === null) return 'new';
  return `${v > 0 ? '+' : ''}${v.toFixed(1)}%`;
}

/** Dynamic period-over-period comparison label, e.g. "vs prev day", "vs prior 7 days". */
export function apsCompareLabel(rangeDays?: number | null): string {
  const d = Math.max(1, Math.round(Number(rangeDays) || 1));
  return d === 1 ? 'vs prev day' : `vs prior ${d.toLocaleString()} days`;
}

/** Column heading for the preceding equal-length period. */
export function apsPrevColumnLabel(rangeDays?: number | null): string {
  const d = Math.max(1, Math.round(Number(rangeDays) || 1));
  return d === 1 ? 'Previous day' : `Prior ${d.toLocaleString()} days`;
}

/** `+X% vs prior N days` — the full dynamic PoP badge text. */
export function apsPopLabel(current: number, previous: number, rangeDays?: number | null): string {
  return `${apsPctLabel(current, previous)} ${apsCompareLabel(rangeDays)}`;
}

export const apsUgx = (n: any) => `UGX ${Math.round(Number(n) || 0).toLocaleString()}`;

/**
 * Cumulative expected collections for the whole selected window: the sum of every
 * live plan's daily repayment for each day it was live between the start date and
 * the report date. Falls back to a single day × range days when the RPC predates
 * the cumulative field.
 */
export function apsExpectedTotal(report: { rent: ApsRent; range_days?: number }): number {
  const cum = Number(report.rent.expected_cumulative);
  if (Number.isFinite(cum) && cum > 0) return cum;
  const days = Math.max(1, Math.round(Number(report.rent.expected_days ?? report.range_days) || 1));
  return (Number(report.rent.daily_receivable) || 0) * days;
}

/** Cumulative expected collections for one agent row. */
export function apsAgentExpectedTotal(row: ApsRentRow, rangeDays?: number | null): number {
  const cum = Number(row.expected_cumulative);
  if (Number.isFinite(cum) && cum > 0) return cum;
  const days = Math.max(1, Math.round(Number(rangeDays) || 1));
  return (Number(row.daily_receivable) || 0) * days;
}
const num = (n: any) => Math.round(Number(n) || 0).toLocaleString();
const title = (s: any) => String(s ?? '—').replace(/_/g, ' ');

export function generateAgentProductsServicesPdf(opts: {
  report: ApsReport;
  actor: string;
  exportType?: string;
  cumulative?: ApsCumulative | null;
  /** Same report shape for the preceding equal-length period (dynamic PoP baseline). */
  prev?: ApsReport | null;
}): Blob {
  const { report, actor } = opts;
  const rangeDays = Math.max(1, Math.round(Number(report.range_days) || 1));
  const prev = opts.prev ?? null;
  const cmpLabel = apsCompareLabel(rangeDays);
  const prevCol = apsPrevColumnLabel(rangeDays);
  /** Previous-period baselines: real prior-window report when available, else the RPC's day-over-day fields. */
  const base = {
    newAgents: prev ? Number(prev.agents.new_today) : Number(report.agents.new_prev),
    totalAgents: prev ? Number(prev.agents.total) : Number(report.agents.base),
    activeAgents: prev ? Number(prev.agents.active_today) : 0,
    collected: prev ? Number(prev.rent.collected_today) : Number(report.rent.collected_prev),
    collections: prev ? Number(prev.rent.collections_today) : 0,
    dailyReceivable: prev ? Number(prev.rent.daily_receivable) : 0,
    expectedTotal: prev ? apsExpectedTotal(prev) : 0,
    outstanding: prev ? Number(prev.rent.outstanding) : 0,
    advSubmitted: prev ? Number(prev.advances.submitted) : 0,
    advApproved: prev ? Number(prev.advances.approved) : 0,
    advRejected: prev ? Number(prev.advances.rejected) : 0,
    advIssued: prev ? Number(prev.advances.issued_today) : 0,
    advRecovered: prev ? Number(prev.advances.deducted_today) : 0,
    advOutstanding: prev ? Number(prev.advances.outstanding) : 0,
    scActive: prev ? Number(prev.service_centres.active_total) : 0,
    scNew: prev ? Number(prev.service_centres.new_today) : Number(report.service_centres.new_prev),
    scPending: prev ? Number(prev.service_centres.pending_total) : 0,
    bikes: prev ? Number(prev.bikes?.outstanding) : 0,
    phones: prev ? Number(prev.phones?.outstanding) : 0,
  };
  const hasPrev = !!prev;
  const cell = (v: string) => (hasPrev || v ? v : '—');
  const pct = (current: number, previous: number, available = true) =>
    available ? apsPctLabel(current, previous) : '—';
  const exportType = opts.exportType || 'PDF';
  const doc = new jsPDF({ orientation: 'landscape', unit: 'mm', format: 'a4' });
  const pageWidth = doc.internal.pageSize.getWidth();
  const pageHeight = doc.internal.pageSize.getHeight();
  const margin = 12;
  const contentWidth = pageWidth - margin * 2;
  let y = 14;

  const brand: [number, number, number] = [88, 28, 135];
  const fmtDay = (d?: string | null) => {
    if (!d) return '—';
    try { return format(new Date(d.length <= 10 ? `${d}T00:00:00` : d), 'dd MMM yyyy'); } catch { return String(d); }
  };
  const dayLabel = fmtDay(report.day);
  const isRange = rangeDays > 1 && !!report.from_date;
  const periodLabel = isRange
    ? `${fmtDay(report.from_date)} – ${dayLabel} (${rangeDays} days cumulative)`
    : dayLabel;

  const newPage = () => { doc.addPage(); y = 16; };
  const ensure = (h: number) => { if (y + h > pageHeight - 16) newPage(); };

  // ===== Header band =====
  doc.setFillColor(brand[0], brand[1], brand[2]);
  doc.rect(0, 0, pageWidth, 24, 'F');
  doc.setTextColor(255, 255, 255);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(9);
  doc.text('WELILE', margin, 9);
  doc.setFontSize(13);
  doc.text('AGENT PRODUCTS & SERVICES — DAILY REPORT', margin, 16.5);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(8);
  doc.text(`${isRange ? 'Reporting period' : 'Reporting day'}: ${periodLabel}  ·  ${report.timezone}`, margin, 21.5);
  y = 31;

  doc.setTextColor(90, 90, 100);
  doc.setFontSize(7.5);
  doc.text(isRange ? `Cumulative totals · compared with the preceding ${rangeDays} days` : 'Compared with the previous day', margin, y);
  doc.text(`Reported by: ${actor}`, pageWidth - margin, y, { align: 'right' });
  y += 6;

  const drawTable = (
    tblTitle: string,
    head: string[],
    widthRatios: number[],
    body: (string | number)[][],
    aligns: ('left' | 'right')[] = [],
  ) => {
    if (!body.length) return;
    // Normalise the supplied relative widths so every table fills exactly
    // 100% of the printable width — never wider, never short.
    const ratioTotal = widthRatios.reduce((a, b) => a + (b > 0 ? b : 0), 0) || 1;
    const widths = widthRatios.map((w) => ((w > 0 ? w : 0) / ratioTotal) * contentWidth);
    ensure(18);
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(8.5);
    doc.setTextColor(brand[0], brand[1], brand[2]);
    doc.text(tblTitle, margin, y);
    y += 3;
    const drawHead = () => {
      doc.setFillColor(brand[0], brand[1], brand[2]);
      doc.rect(margin, y, contentWidth, 6, 'F');
      doc.setTextColor(255, 255, 255);
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(7.5);
      let hx = margin + 2;
      head.forEach((h, i) => {
        const align = aligns[i] === 'right' ? 'right' : 'left';
        doc.text(h, align === 'right' ? hx + widths[i] - 4 : hx, y + 4, { align });
        hx += widths[i];
      });
      y += 6;
      doc.setFont('helvetica', 'normal');
      doc.setTextColor(35, 35, 45);
    };
    drawHead();
    body.forEach((r, idx) => {
      if (y + 5.2 > pageHeight - 16) { newPage(); drawHead(); }
      if (idx % 2 === 1) {
        doc.setFillColor(248, 248, 252);
        doc.rect(margin, y, contentWidth, 5.2, 'F');
      }
      let cx = margin + 2;
      r.forEach((cell, i) => {
        const align = aligns[i] === 'right' ? 'right' : 'left';
        const text = String(cell ?? '');
        const maxChars = Math.floor(widths[i] / 1.55);
        const shown = text.length > maxChars ? `${text.slice(0, Math.max(1, maxChars - 1))}…` : text;
        doc.setFontSize(7.2);
        doc.setTextColor(35, 35, 45);
        doc.text(shown, align === 'right' ? cx + widths[i] - 4 : cx, y + 3.6, { align });
        cx += widths[i];
      });
      y += 5.2;
    });
    y += 5;
  };

  const w4: number[] = [110, 50, 50, 50];
  const a4: ('left' | 'right')[] = ['left', 'right', 'right', 'right'];

  // ===== KPI summary cards (before the detailed sections) =====
  const drawKpiCards = (
    cards: { label: string; value: string; detail?: string }[],
    perRow = 4,
    title = 'DAILY SUMMARY',
  ) => {
    if (!cards.length) return;
    const gap = 3;
    const cardW = (contentWidth - gap * (perRow - 1)) / perRow;
    const cardH = 17;
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(8.5);
    doc.setTextColor(brand[0], brand[1], brand[2]);
    ensure(6 + cardH);
    doc.text(title, margin, y);
    y += 3;
    for (let i = 0; i < cards.length; i += perRow) {
      const row = cards.slice(i, i + perRow);
      ensure(cardH + 2);
      row.forEach((c, idx) => {
        const x = margin + idx * (cardW + gap);
        doc.setFillColor(248, 246, 252);
        doc.setDrawColor(226, 220, 238);
        doc.roundedRect(x, y, cardW, cardH, 1.5, 1.5, 'FD');
        doc.setFillColor(brand[0], brand[1], brand[2]);
        doc.rect(x, y, 1.2, cardH, 'F');
        doc.setFont('helvetica', 'bold');
        doc.setFontSize(6.4);
        doc.setTextColor(110, 100, 125);
        doc.text(c.label.toUpperCase(), x + 4, y + 5);
        doc.setFont('helvetica', 'bold');
        doc.setFontSize(10);
        doc.setTextColor(35, 35, 45);
        const maxChars = Math.floor((cardW - 7) / 1.95);
        const shown = c.value.length > maxChars ? `${c.value.slice(0, Math.max(1, maxChars - 1))}…` : c.value;
        doc.text(shown, x + 4, y + 11);
        if (c.detail) {
          doc.setFont('helvetica', 'normal');
          doc.setFontSize(6.2);
          doc.setTextColor(120, 115, 130);
          const dMax = Math.floor((cardW - 7) / 1.25);
          doc.text(
            c.detail.length > dMax ? `${c.detail.slice(0, Math.max(1, dMax - 1))}…` : c.detail,
            x + 4,
            y + 14.8,
          );
        }
      });
      y += cardH + gap;
    }
    y += 3;
  };

  const expectedTotal = apsExpectedTotal(report);
  const expectedDays = Math.max(1, Math.round(Number(report.rent.expected_days ?? rangeDays) || 1));
  const collectionRatePct =
    expectedTotal > 0 ? (Number(report.rent.collected_today) / expectedTotal) * 100 : 0;

  drawKpiCards([
    {
      label: 'Rent collected today',
      value: apsUgx(report.rent.collected_today),
      detail: `${num(report.rent.collections_today)} entries · ${apsPctLabel(report.rent.collected_today, base.collected)} ${cmpLabel}`,
    },
    {
      label: 'Collection rate vs expected',
      value: `${collectionRatePct.toFixed(1)}%`,
      detail: `expected ${apsUgx(expectedTotal)} over ${num(expectedDays)} day${expectedDays === 1 ? '' : 's'}`,
    },
    {
      label: 'Outstanding receivable',
      value: apsUgx(report.rent.outstanding),
      detail: hasPrev
        ? `${num(report.rent.live_plans)} live plans · ${apsPctLabel(report.rent.outstanding, base.outstanding)} ${cmpLabel}`
        : `${num(report.rent.live_plans)} live plans · ${num(report.rent.avg_days_outstanding)} avg days`,
    },
    {
      label: 'Active agents today',
      value: num(report.agents.active_today),
      detail: `${num(report.agents.total)} on register · ${apsPctLabel(report.agents.new_today, base.newAgents)} new ${cmpLabel}`,
    },
    {
      label: 'Advances issued today',
      value: apsUgx(report.advances.issued_today),
      detail: hasPrev
        ? `${num(report.advances.issued_count)} advance(s) · ${apsPctLabel(report.advances.issued_today, base.advIssued)} ${cmpLabel}`
        : `${num(report.advances.issued_count)} advance(s) · ${num(report.advances.approved)} approved`,
    },
    {
      label: 'Advances outstanding',
      value: apsUgx(report.advances.outstanding),
      detail: hasPrev
        ? `${num(report.advances.active_count)} active · ${apsPctLabel(report.advances.outstanding, base.advOutstanding)} ${cmpLabel}`
        : `${num(report.advances.active_count)} active · recovered ${apsUgx(report.advances.deducted_today)}`,
    },
    {
      label: 'Service centres',
      value: num(report.service_centres.active_total),
      detail: hasPrev
        ? `+${num(report.service_centres.new_today)} new · ${apsPctLabel(report.service_centres.active_total, base.scActive)} ${cmpLabel}`
        : `+${num(report.service_centres.new_today)} today · ${num(report.service_centres.pending_total)} pending`,
    },
    {
      label: 'Products outstanding',
      value: apsUgx(Number(report.bikes.outstanding) + Number(report.phones.outstanding)),
      detail: hasPrev
        ? `bikes ${apsUgx(report.bikes.outstanding)} · ${apsPctLabel(
            Number(report.bikes.outstanding) + Number(report.phones.outstanding),
            base.bikes + base.phones,
          )} ${cmpLabel}`
        : `bikes ${apsUgx(report.bikes.outstanding)} · phones ${apsUgx(report.phones.outstanding)}`,
    },
  ]);

  // ===== 1. New agents =====
  drawTable('1. NEW AGENTS', ['Metric', 'Current period', prevCol, 'Change'], w4, [
    ['New agents added', num(report.agents.new_today), num(base.newAgents), apsPctLabel(report.agents.new_today, base.newAgents)],
    ['Total agents (register)', num(report.agents.total), num(report.agents.base), apsPctLabel(report.agents.total, report.agents.base)],
    ['Active agents (collected)', num(report.agents.active_today), cell(hasPrev ? num(base.activeAgents) : ''), pct(report.agents.active_today, base.activeAgents, hasPrev)],
  ], a4);

  if (report.new_agent_rows.length) {
    const rows = report.new_agent_rows;
    const mainCount = rows.filter(r => (r.agent_type || '').toLowerCase() !== 'sub').length;
    const subCount = rows.length - mainCount;
    const parentTally = new Map<string, number>();
    rows.forEach(r => {
      const p = (r.parent_name || '').trim();
      if (!p) return;
      parentTally.set(p, (parentTally.get(p) || 0) + 1);
    });
    const topParent = [...parentTally.entries()].sort((a, b) => b[1] - a[1])[0];
    drawKpiCards(
      [
        { label: 'Total registered', value: num(rows.length), detail: 'new agents in period' },
        { label: 'Main agents', value: num(mainCount), detail: `${rows.length ? ((mainCount / rows.length) * 100).toFixed(0) : '0'}% of new` },
        { label: 'Sub-agents', value: num(subCount), detail: `${rows.length ? ((subCount / rows.length) * 100).toFixed(0) : '0'}% of new` },
        {
          label: 'Top parent agent',
          value: topParent ? topParent[0] : '—',
          detail: topParent ? `${num(topParent[1])} sub-agent(s) recruited` : 'no parent recorded',
        },
      ],
      4,
      'NEW AGENTS SUMMARY',
    );
  }


  // ===== 1b. Cumulative build-up to the reporting date =====
  const cumWindows = opts.cumulative?.windows ?? [];
  if (cumWindows.length) {
    drawTable(
      `CUMULATIVE BUILD-UP TO ${dayLabel}`,
      ['Window', 'From', 'Rent collected', 'Collections', 'New agents', 'Advances issued', 'Advances recovered'],
      [34, 22, 34, 20, 20, 34, 34],
      cumWindows.map(w => [
        apsWindowLabel(w.days),
        fmtDay(w.from_date),
        apsUgx(w.rent_collected),
        `${num(w.collections_count)} (${num(w.collecting_agents)} agents)`,
        num(w.new_agents),
        `${apsUgx(w.advances_issued)} · ${num(w.advances_count)}`,
        apsUgx(w.advances_recovered),
      ]),
      ['left', 'left', 'right', 'right', 'right', 'right', 'right'],
    );
  }

  // ===== 2. Rent receivables =====
  drawTable('2. RENT RECEIVABLES', ['Metric', 'Current period', prevCol, 'Change'], w4, [
    ['Rent collected', apsUgx(report.rent.collected_today), apsUgx(base.collected), apsPctLabel(report.rent.collected_today, base.collected)],
    ['Collection entries recorded', num(report.rent.collections_today), cell(hasPrev ? num(base.collections) : ''), pct(report.rent.collections_today, base.collections, hasPrev)],
    ['Expected daily receivable (per day)', apsUgx(report.rent.daily_receivable), cell(hasPrev ? apsUgx(base.dailyReceivable) : ''), pct(report.rent.daily_receivable, base.dailyReceivable, hasPrev)],
    [`Expected target (cumulative, ${num(expectedDays)} day${expectedDays === 1 ? '' : 's'})`, apsUgx(expectedTotal), cell(hasPrev ? apsUgx(base.expectedTotal) : ''), pct(expectedTotal, base.expectedTotal, hasPrev)],
    ['Collection rate vs expected', `${collectionRatePct.toFixed(1)}%`, '—', '—'],
    ['Total outstanding receivable', apsUgx(report.rent.outstanding), cell(hasPrev ? apsUgx(base.outstanding) : ''), pct(report.rent.outstanding, base.outstanding, hasPrev)],
    ['Live rent plans', num(report.rent.live_plans), '—', '—'],
    ['Average duration outstanding (days)', num(report.rent.avg_days_outstanding), '—', '—'],
  ], a4);

  // ===== 3. Advances =====
  drawTable('3. ADVANCES', ['Metric', 'Current period', prevCol, 'Change'], w4, [
    ['Requests submitted', num(report.advances.submitted), cell(hasPrev ? num(base.advSubmitted) : ''), pct(report.advances.submitted, base.advSubmitted, hasPrev)],
    ['Requests approved', num(report.advances.approved), cell(hasPrev ? num(base.advApproved) : ''), pct(report.advances.approved, base.advApproved, hasPrev)],
    ['Requests rejected', num(report.advances.rejected), cell(hasPrev ? num(base.advRejected) : ''), pct(report.advances.rejected, base.advRejected, hasPrev)],
    ['Advance amount issued', apsUgx(report.advances.issued_today), cell(hasPrev ? apsUgx(base.advIssued) : `${num(report.advances.issued_count)} advance(s)`), pct(report.advances.issued_today, base.advIssued, hasPrev)],
    ['Recovered (deductions)', apsUgx(report.advances.deducted_today), cell(hasPrev ? apsUgx(base.advRecovered) : ''), pct(report.advances.deducted_today, base.advRecovered, hasPrev)],
    ['Outstanding advance balance', apsUgx(report.advances.outstanding), cell(hasPrev ? apsUgx(base.advOutstanding) : `${num(report.advances.active_count)} active`), pct(report.advances.outstanding, base.advOutstanding, hasPrev)],
  ], a4);

  // ===== 4. Service centres =====
  const scTarget = Number(report.service_centres.monthly_target) || 0;
  drawTable('4. SERVICE CENTRES', ['Metric', 'Current period', prevCol, 'Change'], w4, [
    ['Active service centres', num(report.service_centres.active_total), cell(hasPrev ? num(base.scActive) : ''), pct(report.service_centres.active_total, base.scActive, hasPrev)],
    ['New in period', num(report.service_centres.new_today), num(base.scNew), apsPctLabel(report.service_centres.new_today, base.scNew)],
    ['Added this month', num(report.service_centres.new_this_month), scTarget > 0 ? `target ${num(scTarget)}` : 'no target set', scTarget > 0 ? `${((Number(report.service_centres.new_this_month) / scTarget) * 100).toFixed(1)}% of target` : '—'],
    ['Pending verification', num(report.service_centres.pending_total), cell(hasPrev ? num(base.scPending) : ''), pct(report.service_centres.pending_total, base.scPending, hasPrev)],
  ], a4);

  // ===== 5. Motor bikes / 6. Smartphones =====
  const productBlock = (label: string, p: ApsProduct, pp?: ApsProduct | null) => [
    [`${label} — issued in period`, num(p.issued_today), cell(pp ? num(pp.issued_today) : `${num(p.issued_total)} total`), pct(p.issued_today, Number(pp?.issued_today) || 0, !!pp)],
    [`${label} — total value`, apsUgx(p.total_value), '—', '—'],
    [`${label} — repaid to date`, apsUgx(p.paid), `${p.total_value > 0 ? ((Number(p.paid) / Number(p.total_value)) * 100).toFixed(1) : '0.0'}%`, '—'],
    [`${label} — outstanding`, apsUgx(p.outstanding), cell(pp ? apsUgx(pp.outstanding) : ''), pct(p.outstanding, Number(pp?.outstanding) || 0, !!pp)],
    [`${label} — daily recovery due`, apsUgx(p.daily_receivable), '—', '—'],
  ];
  drawTable('5. MOTOR BIKES', ['Metric', 'Current period', prevCol, 'Change'], w4, productBlock('Bikes', report.bikes, prev?.bikes ?? null), a4);
  drawTable('6. SMARTPHONES', ['Metric', 'Current period', prevCol, 'Change'], w4, productBlock('Smartphones', report.phones, prev?.phones ?? null), a4);

  // ===== 14-day trend =====
  if (report.trend.length > 1) {
    ensure(52);
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(8.5);
    doc.setTextColor(brand[0], brand[1], brand[2]);
    doc.text('14-DAY RENT COLLECTION TREND', margin, y);
    y += 4;
    const chartH = 30;
    const series = [...report.trend].sort((a, b) => a.day.localeCompare(b.day));
    const max = Math.max(...series.map(s => Number(s.collected) || 0), 1);
    const step = (contentWidth - 4) / series.length;
    const barW = Math.max(2, Math.min(12, step - 2));
    doc.setDrawColor(230, 230, 238);
    doc.rect(margin, y, contentWidth, chartH);
    series.forEach((s, i) => {
      const h = ((Number(s.collected) || 0) / max) * (chartH - 4);
      doc.setFillColor(brand[0], brand[1], brand[2]);
      doc.rect(margin + 2 + i * step, y + chartH - h, barW, h, 'F');
    });
    y += chartH + 3;
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(6.5);
    doc.setTextColor(120, 120, 130);
    doc.text(fmtDay(series[0].day), margin, y);
    doc.text(`peak ${apsUgx(max)}`, margin + contentWidth / 2, y, { align: 'center' });
    doc.text(fmtDay(series[series.length - 1].day), margin + contentWidth, y, { align: 'right' });
    y += 6;

    drawTable(
      'DAILY BREAKDOWN (LAST 14 DAYS)',
      ['Day', 'New agents', 'Collected', 'Advances issued', 'Advances recovered', 'Service centres'],
      [40, 34, 60, 60, 60, 40],
      series.map(s => [
        fmtDay(s.day), num(s.new_agents), apsUgx(s.collected),
        apsUgx(s.advances_issued), apsUgx(s.advances_deducted), num(s.service_centres_added),
      ]),
      ['left', 'right', 'right', 'right', 'right', 'right'],
    );
  }

  // ===== 7. Individual agent performance =====
  if (report.agent_float_rows.length) {
    drawTable(
      `7. INDIVIDUAL AGENT PERFORMANCE — FLOAT & COLLECTIONS (${num(report.agent_float_rows.length)} agent${report.agent_float_rows.length === 1 ? '' : 's'})`,
      ['Agent', 'Phone', 'Location', 'Float received', 'Paid out', 'Closing float', 'Commission', 'Collected', 'Txns'],
      [46, 28, 30, 34, 30, 32, 30, 32, 20],
      report.agent_float_rows.map(r => [
        r.agent_name || '—', r.phone || '—', r.location || '—',
        apsUgx(r.float_received), apsUgx(r.float_paid_out), apsUgx(r.closing_float),
        apsUgx(r.commission_balance), apsUgx(r.collections_amount), num(r.collections_count),
      ]),
      ['left', 'left', 'left', 'right', 'right', 'right', 'right', 'right', 'right'],
    );
  }

  if (report.rent_rows.length) {
    drawTable(
      `AGENT RENT RECEIVABLES DETAIL (${num(report.rent_rows.length)} agent${report.rent_rows.length === 1 ? '' : 's'})`,
      ['Agent', 'Phone', 'Plans', 'Daily due', 'Expected (period)', 'Collected', 'Repaid to date', 'Outstanding', 'Avg days'],
      [44, 26, 16, 32, 36, 34, 34, 36, 28],
      report.rent_rows.map(r => [
        r.agent_name || '—', r.phone || '—', num(r.live_plans),
        apsUgx(r.daily_receivable), apsUgx(apsAgentExpectedTotal(r, expectedDays)),
        apsUgx(r.collected_today), apsUgx(r.repaid_to_date),
        apsUgx(r.outstanding), num(r.avg_days_outstanding),
      ]),
      ['left', 'left', 'right', 'right', 'right', 'right', 'right', 'right', 'right'],
    );
  }

  if (report.advance_rows.length) {
    drawTable(
      `AGENT ADVANCES DETAIL (${num(report.advance_rows.length)} advance${report.advance_rows.length === 1 ? '' : 's'})`,
      ['Agent', 'Phone', 'Status', 'Principal', 'Recovered', 'Outstanding', 'Installment', 'Deducted today'],
      [50, 30, 26, 38, 38, 38, 34, 38],
      report.advance_rows.map(r => [
        r.agent_name || '—', r.phone || '—', title(r.status),
        apsUgx(r.principal), apsUgx(r.recovered), apsUgx(r.outstanding),
        apsUgx(r.installment), apsUgx(r.deducted_today),
      ]),
      ['left', 'left', 'left', 'right', 'right', 'right', 'right', 'right'],
    );
  }

  if (report.service_centre_rows.length) {
    drawTable(
      `SERVICE CENTRE REGISTER (${num(report.service_centre_rows.length)} record${report.service_centre_rows.length === 1 ? '' : 's'})`,
      ['Agent', 'Phone', 'Location', 'Status', 'Created', 'Verified', 'Approved'],
      [50, 30, 56, 28, 38, 38, 38],
      report.service_centre_rows.map(r => [
        r.agent_name || '—', r.agent_phone || '—', r.location_name || '—',
        title(r.status), fmtDay(r.created_at), fmtDay(r.verified_at), fmtDay(r.approved_at),
      ]),
      ['left', 'left', 'left', 'left', 'left', 'left', 'left'],
    );
  }

  const bikeRows = report.product_rows.filter(r => r.product === 'bike');
  const phoneRows = report.product_rows.filter(r => r.product === 'smartphone');
  const productTable = (label: string, rows: ApsProductRow[]) => {
    if (!rows.length) return;
    drawTable(
      `${label} — REPAYMENT POSITIONS (${num(rows.length)} record${rows.length === 1 ? '' : 's'})`,
      ['Holder', 'Phone', 'Item', 'Issued', 'Value', 'Paid', 'Outstanding', 'Daily rate', '% repaid', 'Position'],
      [42, 26, 38, 26, 28, 28, 30, 24, 20, 30],
      rows.map(r => [
        r.client_name || '—', r.client_phone || '—', r.item_name || '—',
        r.is_issued ? fmtDay(r.issued_date ?? r.sale_date) : 'Not issued',
        apsUgx(r.value), apsUgx(r.paid), apsUgx(r.outstanding), apsUgx(r.daily_rate),
        `${num(r.repayment_rate)}%`, title(r.repayment_position),
      ]),
      ['left', 'left', 'left', 'left', 'right', 'right', 'right', 'right', 'right', 'left'],
    );
  };
  productTable('MOTOR BIKES', bikeRows);
  productTable('SMARTPHONES', phoneRows);

  // ===== Audit footer =====
  const pages = doc.getNumberOfPages();
  const generated = (() => {
    try { return format(new Date(report.generated_at), 'dd MMM yyyy HH:mm:ss'); } catch { return report.generated_at; }
  })();
  for (let p = 1; p <= pages; p += 1) {
    doc.setPage(p);
    doc.setDrawColor(230, 230, 238);
    doc.line(margin, pageHeight - 12, pageWidth - margin, pageHeight - 12);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(6.5);
    doc.setTextColor(120, 120, 130);
    doc.text(
      `Agent Products & Services — Daily Report · Day ${dayLabel} · Generated ${generated} (${report.timezone}) · Reported by ${actor} · Export ${exportType} · Source: agent register, rent requests, agent collections, agent advances, service centres, merchandise sales & production ledger`,
      margin,
      pageHeight - 8,
      { maxWidth: contentWidth },
    );
    doc.text(`Page ${p} of ${pages}`, pageWidth - margin, pageHeight - 4, { align: 'right' });
  }

  return doc.output('blob');
}
