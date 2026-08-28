import jsPDF from 'jspdf';
import { format } from 'date-fns';
import type { AgentPopulation } from '@/lib/agentOpsComprehensiveReport';



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

export function generateAgentProductsServicesPdf(opts: {
  report: ApsReport;
  actor: string;
  exportType?: string;
  cumulative?: ApsCumulative | null;
  /** Same report shape for the preceding equal-length period (dynamic PoP baseline). */
  prev?: ApsReport | null;
  /** Canonical operational agent population, as shown in "Total Agents Composition & Sources". */
  population?: AgentPopulation | null;
}): Blob {
  const { report, actor } = opts;
  const rangeDays = Math.max(1, Math.round(Number(report.range_days) || 1));
  const prev = opts.prev ?? null;
  const cmpLabel = apsCompareLabel(rangeDays);

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
  doc.text('AGENT PRODUCTS & SERVICES — EXECUTIVE SUMMARY', margin, 16.5);
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

  const pct1 = (n: number | null) => (n === null ? '—' : `${n.toFixed(1)}%`);
  const share = (n: number, d: number) => (d > 0 ? (n / d) * 100 : null);
  const title = (s: any) => String(s ?? '—').replace(/_/g, ' ');

  // ===========================================================================
  // 1. KPI strip — the exact cards, order, values and hints from the page
  // ===========================================================================
  sectionTitle(
    '1. Daily performance headline',
    `${isRange ? 'Cumulative' : 'Single-day'} position · ${periodLabel} · ${report.timezone} · ${isRange ? `compared with the preceding ${num(rangeDays)} days` : 'compared with the previous day'}`,
  );

  drawKpiCards([
    {
      label: 'New agents added',
      value: num(report.agents.new_today),
      detail: `${apsPctLabel(report.agents.new_today, base.newAgents)} ${cmpLabel}`,
    },
    {
      label: 'Total agents',
      value: num(report.agents.total),
      detail: `${apsPctLabel(report.agents.total, base.totalAgents)} ${cmpLabel}`,
    },
    {
      label: 'Rent collected',
      value: apsUgx(report.rent.collected_today),
      detail: `${apsPctLabel(report.rent.collected_today, base.collected)} ${cmpLabel}`,
    },
    {
      label: 'Expected target (period)',
      value: apsUgx(expectedTotal),
      detail: `${apsUgx(report.rent.daily_receivable)}/day`,
    },
    {
      label: 'Collection rate vs expected',
      value: `${collectionRatePct.toFixed(1)}%`,
      detail: `${apsUgx(report.rent.collected_today)} of ${apsUgx(expectedTotal)}`,
    },
    {
      label: 'Outstanding receivable',
      value: apsUgx(report.rent.outstanding),
      detail: prev ? `${apsPctLabel(report.rent.outstanding, base.outstanding)} ${cmpLabel}` : undefined,
    },
    {
      label: 'Advances issued',
      value: apsUgx(report.advances.issued_today),
      detail: prev ? `${apsPctLabel(report.advances.issued_today, base.advIssued)} ${cmpLabel}` : undefined,
    },
    {
      label: 'Advance outstanding',
      value: apsUgx(report.advances.outstanding),
      detail: `${apsUgx(report.advances.deducted_today)} recovered`,
    },
    {
      label: 'Active service centres',
      value: num(report.service_centres.active_total),
      detail: prev ? `${apsPctLabel(report.service_centres.active_total, base.scActive)} ${cmpLabel}` : undefined,
    },
    {
      label: 'Bikes outstanding',
      value: apsUgx(report.bikes?.outstanding),
      detail: `${apsUgx(report.bikes?.daily_receivable)} due daily · ${num(report.bikes?.pending_total ?? 0)} pending issue (${apsUgx(report.bikes?.pending_value ?? 0)})`,
    },
    {
      label: 'Smartphones outstanding',
      value: apsUgx(report.phones?.outstanding),
      detail: `${apsUgx(report.phones?.daily_receivable)} due daily · ${num(report.phones?.pending_total ?? 0)} pending issue (${apsUgx(report.phones?.pending_value ?? 0)})`,
    },
    {
      label: 'Requests approved / rejected',
      value: `${num(report.advances.approved)} / ${num(report.advances.rejected)}`,
      detail: 'advance decisions',
    },
    {
      label: 'Pending service centres',
      value: num(report.service_centres.pending_total),
      detail: 'awaiting verification',
    },
  ]);

  y += 2;
  sectionTitle('Progress against targets');
  drawProgress(
    'Rent collection vs expected receivable',
    collectionRatePct,
    `${apsUgx(report.rent.collected_today)} collected of ${apsUgx(expectedTotal)} expected over ${num(expectedDays)} day${expectedDays === 1 ? '' : 's'}`,
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
  // 2. Total agents composition & sources (same figures as the page section)
  // ===========================================================================
  const population = opts.population ?? null;
  if (population) {
    newPage();
    const g = (v: unknown) => Math.max(0, Number(v) || 0);
    const totalPop = g(population.total);
    const popShare = (v: number) => (totalPop > 0 ? (v / totalPop) * 100 : 0);
    sectionTitle(
      '2. Total agents composition & sources',
      `How the total of ${num(totalPop)} operational agents as at ${dayLabel} is made up. An operational agent has recorded at least one rent collection or carries a live rent plan.`,
    );

    drawKpiCards([
      { label: 'Total agents', value: num(totalPop), detail: 'operational population' },
      {
        label: 'Main agents',
        value: `${num(g(population.primary_total))} · ${popShare(g(population.primary_total)).toFixed(1)}%`,
        detail: `${num(g(population.primary_active))} active · ${num(g(population.primary_inactive))} inactive`,
      },
      {
        label: 'Sub-agents',
        value: `${num(g(population.sub_total))} · ${popShare(g(population.sub_total)).toFixed(1)}%`,
        detail: `${num(g(population.sub_active))} active · ${num(g(population.sub_inactive))} inactive`,
      },
      {
        label: 'Active rent collecting',
        value: `${num(g(population.active))} · ${popShare(g(population.active)).toFixed(1)}%`,
        detail: 'collected in the last 30 days or carries a live plan',
      },
    ]);

    drawProgress(
      'Main agents share of network',
      popShare(g(population.primary_total)),
      `${num(g(population.primary_total))} main agents · ${num(g(population.sub_total))} sub-agents`,
    );
    drawProgress(
      'Active rent collecting agents',
      popShare(g(population.active)),
      `${num(g(population.active))} active · ${num(g(population.inactive))} inactive / onboarding`,
    );

    drawTable(
      'COMPOSITION RECONCILIATION',
      ['Source', 'Grouping', 'Agents', '% of total'],
      [60, 60, 30, 30],
      [
        ['Main agents', 'Network structure', num(g(population.primary_total)), `${popShare(g(population.primary_total)).toFixed(1)}%`],
        ['Sub-agents', 'Network structure', num(g(population.sub_total)), `${popShare(g(population.sub_total)).toFixed(1)}%`],
        ['Active rent collecting agents', 'Collection activity', num(g(population.active)), `${popShare(g(population.active)).toFixed(1)}%`],
        ['Inactive / onboarding agents', 'Collection activity', num(g(population.inactive)), `${popShare(g(population.inactive)).toFixed(1)}%`],
        ['Total agents', 'Each grouping sums to total', num(totalPop), '100.0%'],
      ],
      ['left', 'left', 'right', 'right'],
    );

    doc.setFont('helvetica', 'normal');
    doc.setFontSize(6.2);
    doc.setTextColor(130, 125, 142);
    doc.text(
      'Main + sub-agents = total agents. Active + inactive = total agents. The two groupings are two independent views of the same population, so they are not added together.',
      margin,
      y,
      { maxWidth: contentWidth },
    );
    y += 8;
  }

  // ===========================================================================
  // 3. Cumulative build-up (same table as the page)
  // ===========================================================================
  const cumWindows = opts.cumulative?.windows ?? [];
  if (cumWindows.length) {
    ensure(50);
    sectionTitle(
      `3. Cumulative build-up to ${dayLabel}`,
      'Totals accumulated from 7, 30, 90 and 365 days ago up to the reporting date',
    );
    drawTable(
      '',
      ['Window', 'From', 'Rent collected', 'Collections', 'New agents', 'Advances issued', 'Advances recovered'],
      [34, 24, 34, 30, 22, 34, 34],
      cumWindows.map((w) => [
        apsWindowLabel(w.days), fmtDay(w.from_date), apsUgx(w.rent_collected),
        `${num(w.collections_count)} · ${num(w.collecting_agents)} agents`,
        num(w.new_agents), `${apsUgx(w.advances_issued)} · ${num(w.advances_count)}`, apsUgx(w.advances_recovered),
      ]),
      ['left', 'left', 'right', 'right', 'right', 'right', 'right'],
    );
  }

  // ===========================================================================
  // 4. Rent collected — last 14 days (the page's chart)
  // ===========================================================================
  newPage();
  sectionTitle('4. Rent collected — last 14 days', 'Daily rent collected, advances issued and recovered, and agents added');

  const series = [...report.trend].sort((a, b) => a.day.localeCompare(b.day)).slice(-14);
  if (series.length > 1) {
    const chartH = 46;
    const max = Math.max(...series.map((s) => Number(s.collected) || 0), 1);
    const step = contentWidth / series.length;
    const barW = Math.max(3, Math.min(16, step - 4));
    doc.setDrawColor(232, 230, 240);
    doc.setFillColor(252, 251, 254);
    doc.rect(margin, y, contentWidth, chartH, 'FD');
    [0.25, 0.5, 0.75].forEach((gl) => {
      const gy = y + chartH - chartH * gl;
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

  // ===========================================================================
  // 5. Agent performance tab
  // ===========================================================================
  newPage();
  const floatRows = report.agent_float_rows || [];
  const collectingAgents = floatRows.filter((r) => Number(r.collections_count) > 0).length;
  const floatIn = floatRows.reduce((a, r) => a + (Number(r.float_received) || 0), 0);
  const floatOut = floatRows.reduce((a, r) => a + (Number(r.float_paid_out) || 0), 0);
  const floatCollected = floatRows.reduce((a, r) => a + (Number(r.collections_amount) || 0), 0);
  const topAgent = [...floatRows].sort((a, b) => Number(b.collections_amount) - Number(a.collections_amount))[0];

  sectionTitle('5. Agent performance', 'Float received, deployed and closing position, commission earned and collections per agent');
  drawKpiCards([
    { label: 'Agents that collected', value: pct1(share(collectingAgents, floatRows.length)), detail: `${num(collectingAgents)} of ${num(floatRows.length)} agents` },
    { label: 'Float deployed to landlords', value: pct1(share(floatOut, floatIn)), detail: 'paid out as share of float received' },
    { label: 'Top agent concentration', value: pct1(share(Number(topAgent?.collections_amount) || 0, floatCollected)), detail: topAgent?.agent_name || 'No collections' },
    { label: 'Collections growth', value: apsPctLabel(floatCollected, base.collected), detail: cmpLabel },
  ]);
  drawTable(
    '',
    ['Agent', 'Phone', 'Location', 'Float received', 'Paid out', 'Closing float', 'Commission', 'Collected', 'Txns'],
    [40, 26, 30, 30, 26, 28, 28, 30, 14],
    floatRows.map((r) => [
      r.agent_name || '—', r.phone || '—', r.location || '—',
      apsUgx(r.float_received), apsUgx(r.float_paid_out), apsUgx(r.closing_float),
      apsUgx(r.commission_balance), apsUgx(r.collections_amount), num(r.collections_count),
    ]),
    ['left', 'left', 'left', 'right', 'right', 'right', 'right', 'right', 'right'],
  );
  if (!floatRows.length) {
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(7.4);
    doc.setTextColor(130, 125, 142);
    doc.text('No agent float or collection activity for this period.', margin, y);
    y += 8;
  }

  // ===========================================================================
  // 6. New agents tab
  // ===========================================================================
  newPage();
  const newRows = report.new_agent_rows || [];
  const addedAgents = Number(report.agents.new_today) || newRows.length;
  const mainAdded = newRows.filter((r) => r.agent_type === 'main agent').length;
  const subAdded = newRows.filter((r) => r.agent_type === 'sub-agent').length;
  const addedDenom = mainAdded + subAdded || addedAgents;

  sectionTitle('6. New agents', 'Agents registered in the selected period, with growth and type mix');
  drawKpiCards([
    { label: 'Growth vs previous period', value: apsPctLabel(addedAgents, base.newAgents), detail: cmpLabel },
    { label: 'Share of total agent base', value: pct1(share(addedAgents, Number(report.agents.total) || 0)), detail: `${num(addedAgents)} of ${num(report.agents.total)} agents` },
    { label: 'Main agents added', value: `${num(mainAdded)} · ${pct1(share(mainAdded, addedDenom))}`, detail: 'of agents added' },
    { label: 'Sub-agents added', value: `${num(subAdded)} · ${pct1(share(subAdded, addedDenom))}`, detail: 'of agents added' },
  ]);
  drawTable(
    '',
    ['Agent', 'Phone', 'Location', 'Type', 'Parent agent', 'Added'],
    [44, 28, 34, 24, 40, 30],
    newRows.map((r) => [
      r.name || '—', r.phone || '—', r.location || '—', title(r.agent_type), r.parent_name || '—',
      r.created_at ? format(new Date(r.created_at), 'dd MMM yy HH:mm') : '—',
    ]),
    ['left', 'left', 'left', 'left', 'left', 'left'],
  );
  if (!newRows.length) {
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(7.4);
    doc.setTextColor(130, 125, 142);
    doc.text('No new agents registered in this period.', margin, y);
    y += 8;
  }

  // ===========================================================================
  // 7. Rent receivables tab
  // ===========================================================================
  newPage();
  const repaidTotal = rentRows.reduce((a, r) => a + (Number(r.repaid_to_date) || 0), 0);
  const payingAgents = rentRows.filter((r) => Number(r.collected_today) > 0).length;

  sectionTitle('7. Rent receivables', 'Live rent positions per agent · archived and inactive records excluded');
  drawKpiCards([
    { label: 'Collection rate vs expected', value: pct1(share(Number(report.rent.collected_today) || 0, expectedTotal)), detail: 'collected as share of period target' },
    { label: 'Portfolio repaid to date', value: pct1(share(repaidTotal, repaidTotal + (Number(report.rent.outstanding) || 0))), detail: 'repaid vs repaid + outstanding' },
    { label: 'Agents collecting in period', value: pct1(share(payingAgents, rentRows.length)), detail: `${num(payingAgents)} of ${num(rentRows.length)} agents` },
    { label: 'Outstanding growth', value: apsPctLabel(Number(report.rent.outstanding) || 0, base.outstanding), detail: cmpLabel },
  ]);
  drawTable(
    '',
    ['Agent', 'Phone', 'Plans', 'Daily due', 'Expected (period)', 'Collected', 'Repaid to date', 'Outstanding', 'Avg days'],
    [38, 26, 14, 26, 30, 28, 30, 30, 18],
    rentRows.map((r) => [
      r.agent_name || '—', r.phone || '—', num(r.live_plans), apsUgx(r.daily_receivable),
      apsUgx(apsAgentExpectedTotal(r, expectedDays)), apsUgx(r.collected_today),
      apsUgx(r.repaid_to_date), apsUgx(r.outstanding), num(r.avg_days_outstanding),
    ]),
    ['left', 'left', 'right', 'right', 'right', 'right', 'right', 'right', 'right'],
  );
  if (!rentRows.length) {
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(7.4);
    doc.setTextColor(130, 125, 142);
    doc.text('No live rent receivables.', margin, y);
    y += 8;
  }

  // ===========================================================================
  // 8. Advances tab
  // ===========================================================================
  newPage();
  const advRows = report.advance_rows || [];
  const advSubmitted = Number(report.advances.submitted) || 0;
  const advApproved = Number(report.advances.approved) || 0;
  const advRejected = Number(report.advances.rejected) || 0;
  const advDecided = advApproved + advRejected;
  const advRecovered = advRows.reduce((a, r) => a + (Number(r.recovered) || 0), 0);

  sectionTitle('8. Advances', 'Requests, issuance and recovery position for the selected period');
  drawKpiCards([
    { label: 'Approval rate', value: pct1(share(advApproved, advDecided || advSubmitted)), detail: `${num(advApproved)} approved` },
    { label: 'Rejection rate', value: pct1(share(advRejected, advDecided || advSubmitted)), detail: `${num(advRejected)} rejected` },
    { label: 'Recovery rate', value: pct1(share(advRecovered, advRecovered + (Number(report.advances.outstanding) || 0))), detail: 'recovered vs recovered + outstanding' },
    { label: 'Issued growth', value: apsPctLabel(Number(report.advances.issued_today) || 0, base.advIssued), detail: cmpLabel },
  ]);
  drawTable(
    '',
    ['Agent', 'Phone', 'Status', 'Principal', 'Recovered', 'Outstanding', 'Installment', 'Deducted'],
    [40, 28, 26, 30, 30, 30, 28, 28],
    advRows.map((r) => [
      r.agent_name || '—', r.phone || '—', title(r.status), apsUgx(r.principal),
      apsUgx(r.recovered), apsUgx(r.outstanding), apsUgx(r.installment), apsUgx(r.deducted_today),
    ]),
    ['left', 'left', 'left', 'right', 'right', 'right', 'right', 'right'],
  );
  if (!advRows.length) {
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(7.4);
    doc.setTextColor(130, 125, 142);
    doc.text('No active or newly issued advances.', margin, y);
    y += 8;
  }

  // ===========================================================================
  // 9. Service centres tab
  // ===========================================================================
  newPage();
  sectionTitle('9. Service centres', 'De-duplicated by unique agent location · active, verified or approved only');
  drawKpiCards([
    { label: 'Active service centres', value: num(serviceCentreRows.length), detail: 'unique agent locations' },
    { label: 'Added this month', value: num(report.service_centres.new_this_month), detail: scTarget > 0 ? `target ${num(scTarget)} (${report.service_centres.target_month})` : 'no monthly target set' },
    { label: 'Target achievement', value: scTarget > 0 ? `${scTargetPct.toFixed(1)}%` : '—', detail: 'this month vs target' },
    { label: 'Pending verification', value: num(report.service_centres.pending_total), detail: 'awaiting verification' },
  ]);
  drawTable(
    '',
    ['Agent', 'Phone', 'Location', 'Status', 'Created', 'Verified', 'Approved'],
    [44, 28, 44, 26, 26, 26, 26],
    serviceCentreRows.map((r) => [
      r.agent_name || '—', r.agent_phone || '—', r.location_name || '—', title(r.status),
      r.created_at ? format(new Date(r.created_at), 'dd MMM yy') : '—',
      r.verified_at ? format(new Date(r.verified_at), 'dd MMM yy') : '—',
      r.approved_at ? format(new Date(r.approved_at), 'dd MMM yy') : '—',
    ]),
    ['left', 'left', 'left', 'left', 'left', 'left', 'left'],
  );
  if (!serviceCentreRows.length) {
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(7.4);
    doc.setTextColor(130, 125, 142);
    doc.text('No service centre records.', margin, y);
    y += 8;
  }

  // ===========================================================================
  // 10 & 11. Motor bikes and smartphones tabs
  // ===========================================================================
  ([
    { idx: 10, label: 'Motor bikes', rows: bikeRows, stats: report.bikes, empty: 'No motor bikes issued' },
    { idx: 11, label: 'Smartphones', rows: phoneRows, stats: report.phones, empty: 'No smartphones issued' },
  ] as const).forEach((group) => {
    newPage();
    sectionTitle(
      `${group.idx}. ${group.label}`,
      'Issued units only · orders pending issue are reported separately and excluded from the table',
    );
    drawKpiCards([
      { label: 'Units issued', value: num(group.rows.length), detail: `${num(group.stats?.pending_total ?? 0)} pending issue (${apsUgx(group.stats?.pending_value ?? 0)})` },
      { label: 'Issued value', value: apsUgx(group.stats?.total_value), detail: `${apsUgx(group.stats?.paid)} paid` },
      { label: 'Outstanding', value: apsUgx(group.stats?.outstanding), detail: `${apsUgx(group.stats?.daily_receivable)} due daily` },
      {
        label: 'Repayment progress',
        value: pct1(share(Number(group.stats?.paid) || 0, Number(group.stats?.total_value) || 0)),
        detail: 'paid as share of issued value',
      },
    ]);
    drawTable(
      '',
      ['Holder', 'Phone', 'Item', 'Issued', 'Value', 'Paid', 'Outstanding', 'Daily rate', '% repaid', 'Position'],
      [34, 24, 34, 22, 26, 24, 28, 24, 18, 24],
      group.rows.map((r) => {
        const issued = r.issued_date ?? r.sale_date;
        return [
          r.client_name || '—', r.client_phone || '—', r.item_name || '—',
          issued ? format(new Date(`${String(issued).slice(0, 10)}T00:00:00`), 'dd MMM yy') : '—',
          apsUgx(r.value), apsUgx(r.paid), apsUgx(r.outstanding), apsUgx(r.daily_rate),
          `${num(r.repayment_rate)}%`,
          r.repayment_position === 'pending_issue' ? 'Pending issue' : title(r.repayment_position),
        ];
      }),
      ['left', 'left', 'left', 'left', 'right', 'right', 'right', 'right', 'right', 'left'],
    );
    if (!group.rows.length) {
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(7.4);
      doc.setTextColor(130, 125, 142);
      doc.text(group.empty, margin, y);
      y += 8;
    }
  });


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

