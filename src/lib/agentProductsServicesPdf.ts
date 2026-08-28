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

  // ---------------------------------------------------------------------------
  // Primitives
  // ---------------------------------------------------------------------------
  const sectionTitle = (text: string, sub?: string) => {
    ensure(sub ? 12 : 8);
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(9.5);
    doc.setTextColor(brand[0], brand[1], brand[2]);
    doc.text(text.toUpperCase(), margin, y);
    y += 4;
    if (sub) {
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(6.8);
      doc.setTextColor(125, 120, 138);
      doc.text(sub, margin, y);
      y += 4;
    }
    doc.setDrawColor(brand[0], brand[1], brand[2]);
    doc.line(margin, y, margin + contentWidth, y);
    y += 4;
  };

  const clip = (text: string, widthMm: number, size: number) => {
    const maxChars = Math.floor(widthMm / (size * 0.19));
    return text.length > maxChars ? `${text.slice(0, Math.max(1, maxChars - 1))}…` : text;
  };

  const drawTable = (
    tblTitle: string,
    head: string[],
    widthRatios: number[],
    body: (string | number)[][],
    aligns: ('left' | 'right')[] = [],
  ) => {
    if (!body.length) return;
    const ratioTotal = widthRatios.reduce((a, b) => a + (b > 0 ? b : 0), 0) || 1;
    const widths = widthRatios.map((w) => ((w > 0 ? w : 0) / ratioTotal) * contentWidth);
    ensure(18);
    if (tblTitle) {
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(8);
      doc.setTextColor(70, 60, 90);
      doc.text(tblTitle, margin, y);
      y += 3;
    }
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
      if (y + 5.6 > pageHeight - 16) { newPage(); drawHead(); }
      if (idx % 2 === 1) {
        doc.setFillColor(248, 248, 252);
        doc.rect(margin, y, contentWidth, 5.6, 'F');
      }
      let cx = margin + 2;
      r.forEach((c, i) => {
        const align = aligns[i] === 'right' ? 'right' : 'left';
        doc.setFontSize(7.4);
        doc.setTextColor(35, 35, 45);
        doc.text(clip(String(c ?? ''), widths[i] - 4, 7.4), align === 'right' ? cx + widths[i] - 4 : cx, y + 3.8, { align });
        cx += widths[i];
      });
      y += 5.6;
    });
    y += 6;
  };

  /** Big KPI cards, four per row by default. */
  const drawKpiCards = (
    cards: { label: string; value: string; detail?: string }[],
    perRow = 4,
  ) => {
    if (!cards.length) return;
    const gap = 3;
    const cardW = (contentWidth - gap * (perRow - 1)) / perRow;
    const cardH = 18;
    for (let i = 0; i < cards.length; i += perRow) {
      const row = cards.slice(i, i + perRow);
      ensure(cardH + 2);
      row.forEach((c, idx) => {
        const x = margin + idx * (cardW + gap);
        doc.setFillColor(248, 246, 252);
        doc.setDrawColor(226, 220, 238);
        doc.roundedRect(x, y, cardW, cardH, 1.5, 1.5, 'FD');
        doc.setFillColor(brand[0], brand[1], brand[2]);
        doc.rect(x, y, 1.4, cardH, 'F');
        doc.setFont('helvetica', 'bold');
        doc.setFontSize(6.4);
        doc.setTextColor(110, 100, 125);
        doc.text(clip(c.label.toUpperCase(), cardW - 7, 6.4), x + 4, y + 5);
        doc.setFont('helvetica', 'bold');
        doc.setFontSize(11);
        doc.setTextColor(30, 30, 42);
        doc.text(clip(c.value, cardW - 7, 11), x + 4, y + 11.5);
        if (c.detail) {
          doc.setFont('helvetica', 'normal');
          doc.setFontSize(6.2);
          doc.setTextColor(120, 115, 130);
          doc.text(clip(c.detail, cardW - 7, 6.2), x + 4, y + 15.5);
        }
      });
      y += cardH + gap;
    }
    y += 2;
  };

  /** Clean two-column label/value grid — replaces the dense metric tables. */
  const drawKpiGrid = (
    rows: { label: string; value: string; note?: string }[],
    columns = 2,
  ) => {
    if (!rows.length) return;
    const gap = 6;
    const colW = (contentWidth - gap * (columns - 1)) / columns;
    const rowH = 7.4;
    const perCol = Math.ceil(rows.length / columns);
    ensure(perCol * rowH + 2);
    const startY = y;
    rows.forEach((r, i) => {
      const col = Math.floor(i / perCol);
      const rowIdx = i % perCol;
      const x = margin + col * (colW + gap);
      const ry = startY + rowIdx * rowH;
      if (rowIdx % 2 === 1) {
        doc.setFillColor(249, 248, 253);
        doc.rect(x, ry, colW, rowH, 'F');
      }
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(7.4);
      doc.setTextColor(90, 85, 105);
      doc.text(clip(r.label, colW * 0.58, 7.4), x + 2, ry + 5);
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(7.8);
      doc.setTextColor(30, 30, 42);
      doc.text(clip(r.value, colW * 0.4, 7.8), x + colW - 2, ry + 5, { align: 'right' });
      if (r.note) {
        doc.setFont('helvetica', 'normal');
        doc.setFontSize(6);
        doc.setTextColor(140, 135, 150);
        doc.text(clip(r.note, colW * 0.4, 6), x + colW - 2, ry + 2.2, { align: 'right' });
      }
    });
    y = startY + perCol * rowH + 5;
  };

  /** Horizontal percentage progress bar with caption. */
  const drawProgress = (label: string, pctValue: number, caption: string) => {
    const p = Math.max(0, Math.min(100, Number(pctValue) || 0));
    ensure(12);
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(7.2);
    doc.setTextColor(60, 55, 75);
    doc.text(label, margin, y + 3);
    doc.setFontSize(7.2);
    doc.setTextColor(brand[0], brand[1], brand[2]);
    doc.text(`${p.toFixed(1)}%`, margin + contentWidth, y + 3, { align: 'right' });
    const barY = y + 4.6;
    doc.setFillColor(234, 230, 242);
    doc.roundedRect(margin, barY, contentWidth, 3.2, 1.2, 1.2, 'F');
    if (p > 0) {
      doc.setFillColor(brand[0], brand[1], brand[2]);
      doc.roundedRect(margin, barY, Math.max(1.5, (contentWidth * p) / 100), 3.2, 1.2, 1.2, 'F');
    }
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(6.2);
    doc.setTextColor(130, 125, 142);
    doc.text(caption, margin, barY + 6.4);
    y = barY + 9;
  };

  // ---------------------------------------------------------------------------
  // Clean, de-duplicated, issued-only datasets
  // ---------------------------------------------------------------------------
  const ACTIVE_SC = new Set(['active', 'verified', 'approved']);
  const serviceCentreRows = (() => {
    const seen = new Set<string>();
    return report.service_centre_rows
      .filter((r) => ACTIVE_SC.has(String(r.status || '').toLowerCase()))
      .filter((r) => {
        const key = `${(r.agent_name || r.id).trim().toLowerCase()}|${(r.location_name || '').trim().toLowerCase()}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
  })();

  const issuedRows = report.product_rows.filter((r) => r.is_issued);
  const bikeRows = issuedRows.filter((r) => r.product === 'bike');
  const phoneRows = issuedRows.filter((r) => r.product === 'smartphone');
  const pendingCount = report.product_rows.length - issuedRows.length;

  /** Rent receivables excluding archived/inactive records with no live position. */
  const rentRows = report.rent_rows.filter(
    (r) =>
      Number(r.live_plans) > 0 ||
      Number(r.outstanding) > 0 ||
      Number(r.collected_today) > 0 ||
      Number(r.daily_receivable) > 0,
  );

  const expectedTotal = apsExpectedTotal(report);
  const expectedDays = Math.max(1, Math.round(Number(report.rent.expected_days ?? rangeDays) || 1));
  const collectionRatePct = expectedTotal > 0 ? (Number(report.rent.collected_today) / expectedTotal) * 100 : 0;
  const scTarget = Number(report.service_centres.monthly_target) || 0;
  const scTargetPct = scTarget > 0 ? (Number(report.service_centres.new_this_month) / scTarget) * 100 : 0;
  const advRecoveryPct =
    Number(report.advances.outstanding) + Number(report.advances.deducted_today) > 0
      ? (Number(report.advances.deducted_today) /
          (Number(report.advances.outstanding) + Number(report.advances.deducted_today))) * 100
      : 0;
  const productValue = Number(report.bikes.total_value) + Number(report.phones.total_value);
  const productPaid = Number(report.bikes.paid) + Number(report.phones.paid);
  const productOutstanding = Number(report.bikes.outstanding) + Number(report.phones.outstanding);
  const productRepaidPct = productValue > 0 ? (productPaid / productValue) * 100 : 0;

  // ===========================================================================
  // PAGE 1 — Daily KPI header
  // ===========================================================================
  sectionTitle(
    '1. Daily performance headline',
    `${isRange ? 'Cumulative' : 'Single-day'} position · ${periodLabel} · compared with the ${rangeDays === 1 ? 'previous day' : `prior ${rangeDays} days`}`,
  );

  drawKpiCards([
    {
      label: 'Rent collected',
      value: apsUgx(report.rent.collected_today),
      detail: `${num(report.rent.collections_today)} entries · ${apsPctLabel(report.rent.collected_today, base.collected)} ${cmpLabel}`,
    },
    {
      label: 'Collection rate vs expected',
      value: `${collectionRatePct.toFixed(1)}%`,
      detail: `expected ${apsUgx(expectedTotal)} over ${num(expectedDays)} day${expectedDays === 1 ? '' : 's'}`,
    },
    {
      label: 'Outstanding rent receivable',
      value: apsUgx(report.rent.outstanding),
      detail: `${num(report.rent.live_plans)} live plans · ${num(report.rent.avg_days_outstanding)} avg days`,
    },
    {
      label: 'Active agents',
      value: num(report.agents.active_today),
      detail: `${num(report.agents.total)} on register · +${num(report.agents.new_today)} new`,
    },
  ]);

  drawKpiCards([
    {
      label: 'Advances outstanding',
      value: apsUgx(report.advances.outstanding),
      detail: `${num(report.advances.active_count)} active · recovered ${apsUgx(report.advances.deducted_today)}`,
    },
    {
      label: 'Advances issued',
      value: apsUgx(report.advances.issued_today),
      detail: `${num(report.advances.issued_count)} issued · ${num(report.advances.approved)} approved / ${num(report.advances.rejected)} rejected`,
    },
    {
      label: 'Active service centres',
      value: num(serviceCentreRows.length || report.service_centres.active_total),
      detail: `unique agent locations · ${num(report.service_centres.pending_total)} pending verification`,
    },
    {
      label: 'Equipment outstanding',
      value: apsUgx(productOutstanding),
      detail: `bikes ${apsUgx(report.bikes.outstanding)} · phones ${apsUgx(report.phones.outstanding)}`,
    },
  ]);

  y += 2;
  sectionTitle('Progress against targets');
  drawProgress(
    'Rent collection vs expected receivable',
    collectionRatePct,
    `${apsUgx(report.rent.collected_today)} collected of ${apsUgx(expectedTotal)} expected`,
  );
  drawProgress(
    'Advance recovery rate',
    advRecoveryPct,
    `${apsUgx(report.advances.deducted_today)} recovered against ${apsUgx(report.advances.outstanding)} still outstanding`,
  );
  drawProgress(
    'Service centres added this month vs target',
    scTargetPct,
    scTarget > 0
      ? `${num(report.service_centres.new_this_month)} of ${num(scTarget)} target (${report.service_centres.target_month})`
      : `${num(report.service_centres.new_this_month)} added this month · no monthly target set`,
  );
  drawProgress(
    'Equipment repayment progress (issued units only)',
    productRepaidPct,
    `${apsUgx(productPaid)} repaid of ${apsUgx(productValue)} issued value`,
  );

  // ===========================================================================
  // PAGE 2 — Category breakdown
  // ===========================================================================
  newPage();
  sectionTitle(
    '2. Category breakdown',
    'Rent · Advances · Service centres · Bikes & smartphones — issued positions only, archived records excluded',
  );

  drawKpiGrid([
    { label: 'Rent collected', value: apsUgx(report.rent.collected_today), note: `${apsPctLabel(report.rent.collected_today, base.collected)} ${cmpLabel}` },
    { label: 'Collection entries', value: num(report.rent.collections_today) },
    { label: 'Expected daily receivable', value: apsUgx(report.rent.daily_receivable) },
    { label: `Expected target (${num(expectedDays)} day${expectedDays === 1 ? '' : 's'})`, value: apsUgx(expectedTotal) },
    { label: 'Collection rate vs expected', value: `${collectionRatePct.toFixed(1)}%` },
    { label: 'Outstanding rent receivable', value: apsUgx(report.rent.outstanding) },
    { label: 'Live rent plans', value: num(report.rent.live_plans) },
    { label: 'Average days outstanding', value: num(report.rent.avg_days_outstanding) },
  ]);

  drawTable(
    'CATEGORY TOTALS',
    ['Category', 'Value in period', 'Outstanding', 'Volume', 'Share of outstanding'],
    [46, 34, 34, 30, 30],
    (() => {
      const totalOutstanding =
        Number(report.rent.outstanding) + Number(report.advances.outstanding) + productOutstanding;
      const share = (v: number) => (totalOutstanding > 0 ? `${((v / totalOutstanding) * 100).toFixed(1)}%` : '—');
      return [
        ['Rent', apsUgx(report.rent.collected_today), apsUgx(report.rent.outstanding), `${num(report.rent.live_plans)} plans`, share(Number(report.rent.outstanding))],
        ['Advances', apsUgx(report.advances.issued_today), apsUgx(report.advances.outstanding), `${num(report.advances.active_count)} active`, share(Number(report.advances.outstanding))],
        ['Service centres', '—', '—', `${num(serviceCentreRows.length)} active`, '—'],
        ['Motor bikes', apsUgx(report.bikes.paid), apsUgx(report.bikes.outstanding), `${num(bikeRows.length)} issued`, share(Number(report.bikes.outstanding))],
        ['Smartphones', apsUgx(report.phones.paid), apsUgx(report.phones.outstanding), `${num(phoneRows.length)} issued`, share(Number(report.phones.outstanding))],
      ];
    })(),
    ['left', 'right', 'right', 'right', 'right'],
  );

  sectionTitle('Advances');
  drawKpiGrid([
    { label: 'Requests submitted', value: num(report.advances.submitted) },
    { label: 'Requests approved', value: num(report.advances.approved) },
    { label: 'Requests rejected', value: num(report.advances.rejected) },
    { label: 'Amount issued', value: apsUgx(report.advances.issued_today) },
    { label: 'Recovered in period', value: apsUgx(report.advances.deducted_today) },
    { label: 'Outstanding balance', value: apsUgx(report.advances.outstanding) },
  ]);

  sectionTitle('Service centres, bikes & smartphones');
  drawKpiGrid([
    { label: 'Active service centres (unique agent locations)', value: num(serviceCentreRows.length) },
    { label: 'Added this month', value: num(report.service_centres.new_this_month), note: scTarget > 0 ? `target ${num(scTarget)}` : undefined },
    { label: 'Pending verification', value: num(report.service_centres.pending_total) },
    { label: 'Bikes issued (units)', value: num(bikeRows.length) },
    { label: 'Bikes outstanding', value: apsUgx(report.bikes.outstanding) },
    { label: 'Bikes daily recovery due', value: apsUgx(report.bikes.daily_receivable) },
    { label: 'Smartphones issued (units)', value: num(phoneRows.length) },
    { label: 'Smartphones outstanding', value: apsUgx(report.phones.outstanding) },
    { label: 'Smartphones daily recovery due', value: apsUgx(report.phones.daily_receivable) },
    { label: 'Orders pending issue (excluded above)', value: `${num(pendingCount)} units` },
  ]);

  // ===========================================================================
  // PAGE 3 — 14-day collection trend
  // ===========================================================================
  newPage();
  sectionTitle('3. 14-day collection trend', 'Daily rent collected, advances issued and recovered, and agents added');

  const series = [...report.trend].sort((a, b) => a.day.localeCompare(b.day)).slice(-14);
  if (series.length > 1) {
    const chartH = 46;
    const max = Math.max(...series.map((s) => Number(s.collected) || 0), 1);
    const step = contentWidth / series.length;
    const barW = Math.max(3, Math.min(16, step - 4));
    doc.setDrawColor(232, 230, 240);
    doc.setFillColor(252, 251, 254);
    doc.rect(margin, y, contentWidth, chartH, 'FD');
    // gridlines
    [0.25, 0.5, 0.75].forEach((g) => {
      const gy = y + chartH - chartH * g;
      doc.setDrawColor(238, 236, 245);
      doc.line(margin, gy, margin + contentWidth, gy);
    });
    series.forEach((s, i) => {
      const h = ((Number(s.collected) || 0) / max) * (chartH - 6);
      const bx = margin + i * step + (step - barW) / 2;
      doc.setFillColor(brand[0], brand[1], brand[2]);
      doc.roundedRect(bx, y + chartH - h, barW, Math.max(0.6, h), 0.6, 0.6, 'F');
    });
    y += chartH + 3;
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(6);
    doc.setTextColor(130, 125, 142);
    series.forEach((s, i) => {
      doc.text(format(new Date(`${s.day}T00:00:00`), 'dd MMM'), margin + i * step + step / 2, y, { align: 'center' });
    });
    y += 5;
    const totalCollected = series.reduce((a, s) => a + (Number(s.collected) || 0), 0);
    doc.setFontSize(6.6);
    doc.setTextColor(120, 115, 132);
    doc.text(`Peak day ${apsUgx(max)} · period total ${apsUgx(totalCollected)} · daily average ${apsUgx(totalCollected / series.length)}`, margin, y);
    y += 7;

    drawTable(
      'DAILY BREAKDOWN',
      ['Day', 'Collected', 'Advances issued', 'Advances recovered', 'New agents', 'Service centres'],
      [30, 40, 40, 40, 26, 30],
      series.map((s) => [
        fmtDay(s.day), apsUgx(s.collected), apsUgx(s.advances_issued),
        apsUgx(s.advances_deducted), num(s.new_agents), num(s.service_centres_added),
      ]),
      ['left', 'right', 'right', 'right', 'right', 'right'],
    );
  } else {
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(7.4);
    doc.setTextColor(130, 125, 142);
    doc.text('Not enough trend history for the selected period.', margin, y);
    y += 8;
  }

  const cumWindows = opts.cumulative?.windows ?? [];
  if (cumWindows.length) {
    drawTable(
      `CUMULATIVE BUILD-UP TO ${dayLabel}`,
      ['Window', 'From', 'Rent collected', 'Collections', 'New agents', 'Advances issued', 'Advances recovered'],
      [34, 24, 34, 24, 22, 34, 34],
      cumWindows.map((w) => [
        apsWindowLabel(w.days), fmtDay(w.from_date), apsUgx(w.rent_collected),
        `${num(w.collections_count)} (${num(w.collecting_agents)} agents)`,
        num(w.new_agents), apsUgx(w.advances_issued), apsUgx(w.advances_recovered),
      ]),
      ['left', 'left', 'right', 'right', 'right', 'right', 'right'],
    );
  }

  // ===========================================================================
  // PAGE 4 — Top 10 agent performers
  // ===========================================================================
  newPage();
  sectionTitle(
    '4. Top 10 agent performers',
    'Ranked by rent collected in the reporting period · archived and inactive records excluded',
  );

  const byAgent = new Map<string, { name: string; phone: string | null; location: string | null; collected: number; count: number; outstanding: number; plans: number; closing_float: number }>();
  rentRows.forEach((r) => {
    byAgent.set(r.agent_id, {
      name: r.agent_name || '—', phone: r.phone, location: r.location,
      collected: Number(r.collected_today) || 0, count: 0,
      outstanding: Number(r.outstanding) || 0, plans: Number(r.live_plans) || 0, closing_float: 0,
    });
  });
  report.agent_float_rows.forEach((f) => {
    const existing = byAgent.get(f.agent_id);
    if (existing) {
      existing.count = Number(f.collections_count) || 0;
      existing.closing_float = Number(f.closing_float) || 0;
      if (!existing.collected) existing.collected = Number(f.collections_amount) || 0;
    } else if (Number(f.collections_amount) > 0 || Number(f.closing_float) > 0) {
      byAgent.set(f.agent_id, {
        name: f.agent_name || '—', phone: f.phone, location: f.location,
        collected: Number(f.collections_amount) || 0, count: Number(f.collections_count) || 0,
        outstanding: 0, plans: 0, closing_float: Number(f.closing_float) || 0,
      });
    }
  });
  const top = [...byAgent.values()].sort((a, b) => b.collected - a.collected || b.outstanding - a.outstanding).slice(0, 10);
  const topCollected = top.reduce((a, r) => a + r.collected, 0);
  const bestCollected = Math.max(...top.map((r) => r.collected), 1);

  if (top.length) {
    drawKpiCards([
      { label: 'Top 10 collections', value: apsUgx(topCollected), detail: `${num(top.length)} agents ranked` },
      {
        label: 'Share of total collected',
        value: Number(report.rent.collected_today) > 0 ? `${((topCollected / Number(report.rent.collected_today)) * 100).toFixed(1)}%` : '—',
        detail: `of ${apsUgx(report.rent.collected_today)} collected`,
      },
      { label: 'Best performer', value: top[0].name, detail: apsUgx(top[0].collected) },
      { label: 'Agents with a live position', value: num(byAgent.size), detail: 'active receivable records only' },
    ]);

    drawTable(
      '',
      ['#', 'Agent', 'Location', 'Collected', 'Contribution', 'Plans', 'Outstanding', 'Closing float'],
      [10, 44, 32, 34, 30, 16, 34, 32],
      top.map((r, i) => [
        `${i + 1}`, r.name, r.location || '—', apsUgx(r.collected),
        `${((r.collected / bestCollected) * 100).toFixed(0)}% of best`,
        num(r.plans), apsUgx(r.outstanding), apsUgx(r.closing_float),
      ]),
      ['left', 'left', 'left', 'right', 'right', 'right', 'right', 'right'],
    );

    sectionTitle('Relative contribution');
    top.slice(0, 5).forEach((r) => {
      drawProgress(
        r.name,
        (r.collected / bestCollected) * 100,
        `${apsUgx(r.collected)} collected · ${num(r.count)} entries · ${num(r.plans)} live plans`,
      );
    });
  } else {
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(7.4);
    doc.setTextColor(130, 125, 142);
    doc.text('No agent collections recorded for the selected period.', margin, y);
  }

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
      `Agent Products & Services — Executive Summary · Period ${periodLabel} · Generated ${generated} (${report.timezone}) · Reported by ${actor} · Export ${exportType} · Issued positions only; service centres de-duplicated by unique agent location; archived rent records excluded`,
      margin,
      pageHeight - 8,
      { maxWidth: contentWidth },
    );
    doc.text(`Page ${p} of ${pages}`, pageWidth - margin, pageHeight - 4, { align: 'right' });
  }

  return doc.output('blob');
}

