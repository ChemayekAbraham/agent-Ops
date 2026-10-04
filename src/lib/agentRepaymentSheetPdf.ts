import { formatUGX, calculateRequestFee } from '@/lib/rentCalculations';
import welileLogoUrl from '@/assets/welile-logo.png';

export interface RepaymentSheetPlan {
  date: string;            // created_at
  disbursedAt: string | null;
  durationDays: number;
  status: string;
  registrationType?: string | null;
  rentAmount: number;      // rent paid to landlord
  totalRepayment: number;  // canonical total due
  amountRepaid: number;
  dailyRepayment?: number; // daily repayment amount tenant owes
  initialOutstanding?: number | null;
  landlordName?: string | null;
  propertyAddress?: string | null;
}

export interface RepaymentSheetTxn {
  date: string;
  amount: number;
}

/** A float allocation the agent personally made toward this tenant. */
export interface RepaymentSheetAllocation {
  date: string;   // exact date & time of allocation
  amount: number; // amount allocated by the agent
}

export interface RepaymentSheetData {
  aiId: string;
  tenantName: string;
  phone: string;
  agentName: string;
  generatedAt?: Date;
  plans: RepaymentSheetPlan[];
  transactions: RepaymentSheetTxn[];
  /** Float allocations made by the agent toward this tenant. */
  allocations?: RepaymentSheetAllocation[];
  /** Optional reporting window. When set, transactions are filtered to it. */
  periodFrom?: string | null;
  periodTo?: string | null;
  /** Optional status filter for the day-by-day allocation schedule. */
  scheduleStatusFilter?: DailyScheduleRow['status'][];
}

async function loadLogoAsBase64(): Promise<string | null> {
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

function buildRepaymentSheetFileName(data: RepaymentSheetData): string {
  const safeName = data.tenantName.replace(/[^a-zA-Z0-9_-]/g, '_').replace(/_+/g, '_');
  if (data.periodFrom && data.periodTo) {
    return `Repayment_Sheet_${safeName}_${data.periodFrom}_to_${data.periodTo}.pdf`;
  }
  return `Repayment_Sheet_${safeName}_All-time.pdf`;
}

function fmtDate(d: string | null | undefined): string {
  if (!d) return '—';
  return new Date(d).toLocaleDateString('en-UG', { year: 'numeric', month: 'short', day: 'numeric' });
}

function addDays(d: string, days: number): string {
  const dt = new Date(d);
  dt.setDate(dt.getDate() + days);
  return dt.toISOString();
}

/**
 * Breaks a plan into its fee components from the canonical stored numbers.
 *   total_repayment = rent (to landlord) + access fee + registration fee
 * Outstanding-balance plans carry legacy debt with no fee formula.
 */
function decomposePlan(p: RepaymentSheetPlan) {
  const isOB = p.registrationType === 'outstanding_balance';
  if (isOB) {
    const total = Number(p.initialOutstanding ?? p.totalRepayment ?? 0);
    return { rentToLandlord: total, registrationFee: 0, accessFee: 0, totalDue: total };
  }
  const rentToLandlord = Number(p.rentAmount || 0);
  const registrationFee = calculateRequestFee(rentToLandlord);
  const totalDue = Number(p.totalRepayment || 0);
  const accessFee = Math.max(0, totalDue - rentToLandlord - registrationFee);
  return { rentToLandlord, registrationFee, accessFee, totalDue };
}

/**
 * Expected-to-date for a single plan, straight-line from disbursement across
 * the plan duration, capped at the total due. Lets the agent see whether a
 * tenant's allocations are ahead of or behind schedule.
 */
function expectedToDate(p: RepaymentSheetPlan, totalDue: number): number {
  const start = p.disbursedAt || p.date;
  if (!start || !p.durationDays || p.durationDays <= 0) return totalDue;
  const startMs = new Date(start).getTime();
  const elapsedDays = Math.floor((Date.now() - startMs) / (1000 * 60 * 60 * 24));
  if (elapsedDays <= 0) return 0;
  if (elapsedDays >= p.durationDays) return totalDue;
  const perDay = totalDue / p.durationDays;
  return Math.round(perDay * elapsedDays);
}

/** Local YYYY-MM-DD key for grouping by calendar day. */
function dayKey(d: string | number | Date): string {
  const dt = new Date(d);
  const y = dt.getFullYear();
  const m = String(dt.getMonth() + 1).padStart(2, '0');
  const day = String(dt.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function startOfDay(d: string | number | Date): number {
  const dt = new Date(d);
  dt.setHours(0, 0, 0, 0);
  return dt.getTime();
}

export interface DailyScheduleRow {
  dateMs: number;
  expected: number;          // amount the agent was expected to allocate that day
  allocated: number;         // amount actually allocated that day
  times: string[];           // exact times of each allocation that day
  status: 'allocated' | 'partial' | 'missed' | 'extra';
}

/**
 * Builds a calendar of every day the tenant was expected to be paying, from the
 * earliest plan start through today (or plan end), and overlays the agent's
 * actual float allocations on each day. Days with an expected amount but no
 * allocation are flagged as "missed" so it is obvious which dates the agent was
 * supposed to allocate on but did not.
 */
function buildDailySchedule(
  data: RepaymentSheetData,
  fromMs: number | null,
  toMs: number | null,
): DailyScheduleRow[] {
  const allocs = data.allocations ?? [];
  if (data.plans.length === 0 && allocs.length === 0) return [];

  // Expected-per-day contribution windows from each plan.
  const windows = data.plans
    .filter((p) => (p.dailyRepayment ?? 0) > 0 && p.durationDays > 0)
    .map((p) => {
      const start = startOfDay(p.disbursedAt || p.date);
      const end = start + p.durationDays * 86400000; // exclusive
      return { start, end, daily: Number(p.dailyRepayment || 0) };
    });

  // Allocations grouped by calendar day.
  const allocByDay = new Map<string, { amount: number; times: string[] }>();
  allocs.forEach((a) => {
    const k = dayKey(a.date);
    const cur = allocByDay.get(k) ?? { amount: 0, times: [] };
    cur.amount += Number(a.amount || 0);
    cur.times.push(new Date(a.date).toLocaleTimeString('en-UG', { hour: '2-digit', minute: '2-digit' }));
    allocByDay.set(k, cur);
  });

  // Determine the calendar span to render.
  const todayEnd = startOfDay(Date.now());
  let spanStart = Infinity;
  let spanEnd = -Infinity;
  windows.forEach((w) => {
    spanStart = Math.min(spanStart, w.start);
    spanEnd = Math.max(spanEnd, Math.min(w.end - 86400000, todayEnd));
  });
  allocs.forEach((a) => {
    const d = startOfDay(a.date);
    spanStart = Math.min(spanStart, d);
    spanEnd = Math.max(spanEnd, d);
  });
  if (!isFinite(spanStart) || spanEnd < spanStart) return [];

  // Clamp to the reporting period when one is selected.
  if (fromMs !== null) spanStart = Math.max(spanStart, startOfDay(fromMs));
  if (toMs !== null) spanEnd = Math.min(spanEnd, startOfDay(toMs));
  if (spanEnd < spanStart) return [];

  // Safety cap to keep the document bounded.
  const MAX_DAYS = 400;
  const rows: DailyScheduleRow[] = [];
  for (let ms = spanStart, count = 0; ms <= spanEnd && count < MAX_DAYS; ms += 86400000, count++) {
    const expected = windows.reduce((s, w) => (ms >= w.start && ms < w.end ? s + w.daily : s), 0);
    const a = allocByDay.get(dayKey(ms));
    const allocated = a?.amount ?? 0;
    const times = a?.times ?? [];
    let status: DailyScheduleRow['status'];
    if (expected <= 0) {
      status = allocated > 0 ? 'extra' : 'missed'; // no due that day
    } else if (allocated <= 0) {
      status = 'missed';
    } else if (allocated + 1 >= expected) {
      status = 'allocated';
    } else {
      status = 'partial';
    }
    // Skip days that have neither a due amount nor an allocation.
    if (expected <= 0 && allocated <= 0) continue;
    rows.push({ dateMs: ms, expected, allocated, times, status });
  }
  return rows;
}

export async function generateRepaymentSheetPdf(data: RepaymentSheetData): Promise<Blob> {
  const { jsPDF } = await import('jspdf');
  const pdf = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4', compress: true });
  const pw = pdf.internal.pageSize.getWidth();
  const ph = pdf.internal.pageSize.getHeight();
  const margin = 14;
  const cw = pw - margin * 2;
  let y = 14;

  const ensureSpace = (need: number) => {
    if (y > ph - need) { pdf.addPage(); y = 16; }
  };

  // ─── Branded header ───
  const logoBase64 = await loadLogoAsBase64();
  if (logoBase64) pdf.addImage(logoBase64, 'PNG', margin, y - 4, 14, 14);
  const textX = margin + 18;
  pdf.setFontSize(15);
  pdf.setFont('helvetica', 'bold');
  pdf.setTextColor(30, 41, 59);
  pdf.text('Welile Technologies Limited', textX, y + 2);
  pdf.setFontSize(8);
  pdf.setFont('helvetica', 'normal');
  pdf.setTextColor(100, 116, 139);
  pdf.text('P.O. Box 167564, Palm Lane, Kabaale, Entebbe — Uganda', textX, y + 7);
  pdf.text('info@welile.com  |  www.welile.com', textX, y + 11);
  y += 20;

  pdf.setDrawColor(59, 130, 246);
  pdf.setLineWidth(0.8);
  pdf.line(margin, y, pw - margin, y);
  y += 6;

  pdf.setFontSize(13);
  pdf.setFont('helvetica', 'bold');
  pdf.setTextColor(30, 41, 59);
  pdf.text('TENANT REPAYMENT SHEET', margin, y);
  pdf.setFontSize(8);
  pdf.setFont('helvetica', 'normal');
  pdf.setTextColor(100, 116, 139);
  pdf.text(`Generated: ${(data.generatedAt ?? new Date()).toLocaleString('en-UG')}`, pw - margin, y, { align: 'right' });
  y += 8;

  // ─── Reporting period banner ───
  const periodLabel =
    data.periodFrom || data.periodTo
      ? `Reporting period: ${fmtDate(data.periodFrom)} — ${fmtDate(data.periodTo)}`
      : 'Reporting period: All time';
  pdf.setFontSize(8);
  pdf.setFont('helvetica', 'bold');
  pdf.setTextColor(59, 130, 246);
  pdf.text(periodLabel, margin, y);
  y += 7;

  // ─── Tenant / agent identity ───
  const idRow = (label: string, value: string, x: number) => {
    pdf.setFontSize(8);
    pdf.setFont('helvetica', 'normal');
    pdf.setTextColor(100, 116, 139);
    pdf.text(label, x, y);
    pdf.setFont('helvetica', 'bold');
    pdf.setTextColor(30, 41, 59);
    pdf.text(value, x, y + 4);
  };
  idRow('TENANT', data.tenantName, margin);
  idRow('PHONE', data.phone || '—', margin + 70);
  idRow('AI ID', data.aiId, margin + 130);
  y += 9;
  idRow('MANAGING AGENT', data.agentName || '—', margin);
  idRow('RENT PLANS', String(data.plans.length), margin + 130);
  y += 10;

  // ─── Per-plan breakdown ───
  let totRentLandlord = 0, totAccess = 0, totReg = 0, totDue = 0, totRepaid = 0, totOutstanding = 0;

  data.plans.forEach((p, i) => {
    const { rentToLandlord, registrationFee, accessFee, totalDue } = decomposePlan(p);
    const repaid = Number(p.amountRepaid || 0);
    const outstanding = Math.max(0, totalDue - repaid);
    const expected = expectedToDate(p, totalDue);
    const variance = repaid - expected; // + ahead, - behind
    const start = p.disbursedAt || p.date;
    const endDate = p.durationDays > 0 ? addDays(start, p.durationDays) : null;

    totRentLandlord += rentToLandlord;
    totAccess += accessFee;
    totReg += registrationFee;
    totDue += totalDue;
    totRepaid += repaid;
    totOutstanding += outstanding;

    ensureSpace(64);

    // Card header
    pdf.setFillColor(241, 245, 249);
    pdf.roundedRect(margin, y - 4, cw, 8, 2, 2, 'F');
    pdf.setFontSize(9);
    pdf.setFont('helvetica', 'bold');
    pdf.setTextColor(51, 65, 85);
    pdf.text(`Plan ${i + 1} — ${p.status.charAt(0).toUpperCase() + p.status.slice(1)}`, margin + 3, y + 1);
    pdf.setFont('helvetica', 'normal');
    pdf.setTextColor(100, 116, 139);
    pdf.text(p.landlordName ? `Landlord: ${p.landlordName}` : '', pw - margin - 3, y + 1, { align: 'right' });
    y += 9;

    // Two-column fee detail
    const labelVal = (label: string, value: string, x: number, valueColor?: [number, number, number]) => {
      pdf.setFontSize(8);
      pdf.setFont('helvetica', 'normal');
      pdf.setTextColor(100, 116, 139);
      pdf.text(label, x, y);
      pdf.setFont('helvetica', 'bold');
      if (valueColor) pdf.setTextColor(...valueColor); else pdf.setTextColor(30, 41, 59);
      pdf.text(value, x + 62, y, { align: 'right' });
    };
    const colL = margin + 3;
    const colR = margin + cw / 2 + 3;

    labelVal('Rent paid to landlord', formatUGX(rentToLandlord), colL);
    labelVal('Start date', fmtDate(start), colR);
    y += 5;
    labelVal('Access fee', formatUGX(accessFee), colL);
    labelVal('End date', fmtDate(endDate), colR);
    y += 5;
    labelVal('Registration fee', formatUGX(registrationFee), colL);
    labelVal('Period', `${p.durationDays} days`, colR);
    y += 5;
    labelVal('Total due', formatUGX(totalDue), colL);
    labelVal('Expected to date', formatUGX(expected), colR);
    y += 5;
    labelVal('Repaid', formatUGX(repaid), colL, [34, 197, 94]);
    labelVal(
      variance >= 0 ? 'Ahead by' : 'Behind by',
      formatUGX(Math.abs(variance)),
      colR,
      variance >= 0 ? [34, 197, 94] : [239, 68, 68],
    );
    y += 5;
    labelVal('Daily repayment', formatUGX(Number(p.dailyRepayment || 0)), colL);
    labelVal('Outstanding balance', formatUGX(outstanding), colR, outstanding > 0 ? [239, 68, 68] : [34, 197, 94]);
    y += 5;
    const pct = totalDue > 0 ? Math.min(100, Math.round((repaid / totalDue) * 100)) : 0;
    labelVal('Progress', `${pct}%`, colL);
    y += 7;

    pdf.setDrawColor(226, 232, 240);
    pdf.setLineWidth(0.3);
    pdf.line(margin, y, pw - margin, y);
    y += 5;
  });

  // ─── Portfolio totals ───
  ensureSpace(40);
  pdf.setFillColor(30, 41, 59);
  pdf.roundedRect(margin, y - 4, cw, 8, 2, 2, 'F');
  pdf.setFontSize(9);
  pdf.setFont('helvetica', 'bold');
  pdf.setTextColor(255, 255, 255);
  pdf.text('PORTFOLIO TOTALS', margin + 3, y + 1);
  y += 10;

  const totRow = (label: string, value: string, color?: [number, number, number]) => {
    pdf.setFontSize(9);
    pdf.setFont('helvetica', 'normal');
    pdf.setTextColor(100, 116, 139);
    pdf.text(label, margin + 3, y);
    pdf.setFont('helvetica', 'bold');
    if (color) pdf.setTextColor(...color); else pdf.setTextColor(30, 41, 59);
    pdf.text(value, pw - margin - 3, y, { align: 'right' });
    y += 6;
  };
  totRow('Total rent paid to landlords', formatUGX(totRentLandlord));
  totRow('Total access fees', formatUGX(totAccess));
  totRow('Total registration fees', formatUGX(totReg));
  totRow('Total due', formatUGX(totDue));
  totRow('Total repaid', formatUGX(totRepaid), [34, 197, 94]);
  totRow('Total outstanding', formatUGX(totOutstanding), totOutstanding > 0 ? [239, 68, 68] : [34, 197, 94]);
  totRow('Collection rate', totDue > 0 ? `${Math.round((totRepaid / totDue) * 100)}%` : '—');
  y += 4;

  // ─── Repayment transactions ───
  const fromMs = data.periodFrom ? new Date(data.periodFrom).getTime() : null;
  const toMs = data.periodTo ? new Date(data.periodTo + 'T23:59:59').getTime() : null;
  const txns = data.transactions.filter((t) => {
    const ms = new Date(t.date).getTime();
    if (fromMs !== null && ms < fromMs) return false;
    if (toMs !== null && ms > toMs) return false;
    return true;
  });
  const periodRepaid = txns.reduce((s, t) => s + Number(t.amount || 0), 0);
  if (txns.length > 0) {
    ensureSpace(24);
    pdf.setFillColor(241, 245, 249);
    pdf.roundedRect(margin, y - 4, cw, 8, 2, 2, 'F');
    pdf.setFontSize(9);
    pdf.setFont('helvetica', 'bold');
    pdf.setTextColor(51, 65, 85);
    pdf.text(
      data.periodFrom || data.periodTo
        ? 'REPAYMENT TRANSACTIONS (IN PERIOD)'
        : 'REPAYMENT TRANSACTIONS',
      margin + 3,
      y + 1,
    );
    y += 9;

    pdf.setFontSize(8);
    pdf.setFont('helvetica', 'bold');
    pdf.setTextColor(100, 116, 139);
    pdf.text('#', margin + 3, y);
    pdf.text('Date & time', margin + 14, y);
    pdf.text('Amount', pw - margin - 3, y, { align: 'right' });
    y += 2;
    pdf.setDrawColor(226, 232, 240);
    pdf.setLineWidth(0.3);
    pdf.line(margin, y, pw - margin, y);
    y += 4;

    txns.forEach((t, i) => {
      ensureSpace(14);
      pdf.setFontSize(8);
      pdf.setFont('helvetica', 'normal');
      pdf.setTextColor(30, 41, 59);
      pdf.text(String(i + 1), margin + 3, y);
      pdf.text(new Date(t.date).toLocaleString('en-UG'), margin + 14, y);
      pdf.setFont('helvetica', 'bold');
      pdf.setTextColor(34, 197, 94);
      pdf.text(formatUGX(t.amount), pw - margin - 3, y, { align: 'right' });
      y += 5;
    });

    // Period subtotal
    ensureSpace(12);
    y += 1;
    pdf.setDrawColor(226, 232, 240);
    pdf.setLineWidth(0.3);
    pdf.line(margin, y, pw - margin, y);
    y += 5;
    pdf.setFontSize(8);
    pdf.setFont('helvetica', 'bold');
    pdf.setTextColor(100, 116, 139);
    pdf.text(`Collected in period (${txns.length} payment${txns.length === 1 ? '' : 's'})`, margin + 3, y);
    pdf.setTextColor(34, 197, 94);
    pdf.text(formatUGX(periodRepaid), pw - margin - 3, y, { align: 'right' });
    y += 6;
  } else if (data.periodFrom || data.periodTo) {
    ensureSpace(16);
    pdf.setFillColor(241, 245, 249);
    pdf.roundedRect(margin, y - 4, cw, 8, 2, 2, 'F');
    pdf.setFontSize(9);
    pdf.setFont('helvetica', 'bold');
    pdf.setTextColor(51, 65, 85);
    pdf.text('REPAYMENT TRANSACTIONS (IN PERIOD)', margin + 3, y + 1);
    y += 10;
    pdf.setFontSize(8);
    pdf.setFont('helvetica', 'normal');
    pdf.setTextColor(100, 116, 139);
    pdf.text('No repayments recorded in the selected period.', margin + 3, y);
    y += 6;
  }

  // ─── Float allocations made by the agent ───
  const allAllocations = data.allocations ?? [];
  const allocs = allAllocations.filter((a) => {
    const ms = new Date(a.date).getTime();
    if (fromMs !== null && ms < fromMs) return false;
    if (toMs !== null && ms > toMs) return false;
    return true;
  });
  const allocTotal = allocs.reduce((s, a) => s + Number(a.amount || 0), 0);
  if (allAllocations.length > 0) {
    ensureSpace(24);
    pdf.setFillColor(238, 242, 255);
    pdf.roundedRect(margin, y - 4, cw, 8, 2, 2, 'F');
    pdf.setFontSize(9);
    pdf.setFont('helvetica', 'bold');
    pdf.setTextColor(67, 56, 202);
    pdf.text(
      data.periodFrom || data.periodTo
        ? 'FLOAT ALLOCATIONS BY AGENT (IN PERIOD)'
        : 'FLOAT ALLOCATIONS BY AGENT',
      margin + 3,
      y + 1,
    );
    y += 9;

    if (allocs.length === 0) {
      pdf.setFontSize(8);
      pdf.setFont('helvetica', 'normal');
      pdf.setTextColor(100, 116, 139);
      pdf.text('No float allocations recorded in the selected period.', margin + 3, y);
      y += 6;
    } else {
      pdf.setFontSize(8);
      pdf.setFont('helvetica', 'bold');
      pdf.setTextColor(100, 116, 139);
      pdf.text('#', margin + 3, y);
      pdf.text('Date & time of allocation', margin + 14, y);
      pdf.text('Amount allocated', pw - margin - 3, y, { align: 'right' });
      y += 2;
      pdf.setDrawColor(226, 232, 240);
      pdf.setLineWidth(0.3);
      pdf.line(margin, y, pw - margin, y);
      y += 4;

      allocs.forEach((a, i) => {
        ensureSpace(14);
        pdf.setFontSize(8);
        pdf.setFont('helvetica', 'normal');
        pdf.setTextColor(30, 41, 59);
        pdf.text(String(i + 1), margin + 3, y);
        pdf.text(new Date(a.date).toLocaleString('en-UG'), margin + 14, y);
        pdf.setFont('helvetica', 'bold');
        pdf.setTextColor(67, 56, 202);
        pdf.text(formatUGX(a.amount), pw - margin - 3, y, { align: 'right' });
        y += 5;
      });

      ensureSpace(12);
      y += 1;
      pdf.setDrawColor(226, 232, 240);
      pdf.setLineWidth(0.3);
      pdf.line(margin, y, pw - margin, y);
      y += 5;
      pdf.setFontSize(8);
      pdf.setFont('helvetica', 'bold');
      pdf.setTextColor(100, 116, 139);
      pdf.text(
        `Total allocated by agent (${allocs.length} allocation${allocs.length === 1 ? '' : 's'})`,
        margin + 3,
        y,
      );
      pdf.setTextColor(67, 56, 202);
      pdf.text(formatUGX(allocTotal), pw - margin - 3, y, { align: 'right' });
      y += 6;
    }
  }

  // ─── Day-by-day allocation schedule ───
  // Shows, for every day the tenant was due, what the agent allocated (with the
  // exact time) and clearly flags days where no allocation was made.
  const schedule = buildDailySchedule(data, fromMs, toMs);
  const filteredSchedule = data.scheduleStatusFilter
    ? schedule.filter((r) => data.scheduleStatusFilter!.includes(r.status))
    : schedule;
  if (filteredSchedule.length > 0) {
    const schedExpected = filteredSchedule.reduce((s, r) => s + r.expected, 0);
    const schedAllocated = filteredSchedule.reduce((s, r) => s + r.allocated, 0);
    const missedDays = filteredSchedule.filter((r) => r.status === 'missed' && r.expected > 0).length;
    const partialDays = filteredSchedule.filter((r) => r.status === 'partial').length;

    // Column layout.
    const cDate = margin + 3;
    const cExp = margin + 42;
    const cAlloc = margin + 78;
    const cTime = margin + 116;
    const cStatus = pw - margin - 3;

    const drawScheduleHeader = (withTitle: boolean) => {
      if (withTitle) {
        ensureSpace(28);
        pdf.setFillColor(255, 247, 237);
        pdf.roundedRect(margin, y - 4, cw, 8, 2, 2, 'F');
        pdf.setFontSize(9);
        pdf.setFont('helvetica', 'bold');
        pdf.setTextColor(154, 52, 18);
        pdf.text(
          data.periodFrom || data.periodTo
            ? 'DAY-BY-DAY ALLOCATION SCHEDULE (IN PERIOD)'
            : 'DAY-BY-DAY ALLOCATION SCHEDULE',
          margin + 3,
          y + 1,
        );
        y += 9;
      } else {
        ensureSpace(16);
      }
      pdf.setFontSize(7.5);
      pdf.setFont('helvetica', 'bold');
      pdf.setTextColor(100, 116, 139);
      pdf.text('Date', cDate, y);
      pdf.text('Expected', cExp, y);
      pdf.text('Allocated', cAlloc, y);
      pdf.text('Time(s)', cTime, y);
      pdf.text('Status', cStatus, y, { align: 'right' });
      y += 2;
      pdf.setDrawColor(226, 232, 240);
      pdf.setLineWidth(0.3);
      pdf.line(margin, y, pw - margin, y);
      y += 4;
    };

    drawScheduleHeader(true);

    const statusMeta: Record<DailyScheduleRow['status'], { label: string; color: [number, number, number] }> = {
      allocated: { label: 'Allocated', color: [34, 197, 94] },
      partial: { label: 'Partial', color: [217, 119, 6] },
      missed: { label: 'NO ALLOCATION', color: [239, 68, 68] },
      extra: { label: 'Extra', color: [99, 102, 241] },
    };

    filteredSchedule.forEach((r) => {
      if (y > ph - 18) {
        pdf.addPage();
        y = 16;
        drawScheduleHeader(false);
      }
      const meta = statusMeta[r.status];
      // Subtle red wash behind missed days so they stand out.
      if (r.status === 'missed' && r.expected > 0) {
        pdf.setFillColor(254, 242, 242);
        pdf.rect(margin, y - 3.2, cw, 5, 'F');
      }
      pdf.setFontSize(7.5);
      pdf.setFont('helvetica', 'normal');
      pdf.setTextColor(30, 41, 59);
      pdf.text(fmtDate(new Date(r.dateMs).toISOString()), cDate, y);
      pdf.text(r.expected > 0 ? formatUGX(r.expected) : '—', cExp, y);
      if (r.allocated > 0) {
        pdf.setFont('helvetica', 'bold');
        pdf.setTextColor(34, 197, 94);
        pdf.text(formatUGX(r.allocated), cAlloc, y);
        pdf.setFont('helvetica', 'normal');
        pdf.setTextColor(30, 41, 59);
      } else {
        pdf.setTextColor(148, 163, 184);
        pdf.text('—', cAlloc, y);
        pdf.setTextColor(30, 41, 59);
      }
      const timeStr = r.times.length > 0 ? r.times.join(', ') : '—';
      pdf.setFontSize(r.times.length > 5 ? 6.5 : 7.5);
      pdf.setTextColor(100, 116, 139);
      pdf.text(timeStr, cTime, y, { maxWidth: cStatus - cTime - 4 });
      pdf.setFontSize(7.5);
      pdf.setFont('helvetica', 'bold');
      pdf.setTextColor(...meta.color);
      pdf.text(meta.label, cStatus, y, { align: 'right' });
      y += 5;
    });

    // Schedule summary.
    ensureSpace(20);
    y += 1;
    pdf.setDrawColor(226, 232, 240);
    pdf.setLineWidth(0.3);
    pdf.line(margin, y, pw - margin, y);
    y += 5;
    pdf.setFontSize(8);
    pdf.setFont('helvetica', 'bold');
    pdf.setTextColor(100, 116, 139);
    pdf.text(`Days expected: ${filteredSchedule.filter((r) => r.expected > 0).length}`, margin + 3, y);
    pdf.setTextColor(239, 68, 68);
    pdf.text(`Missed days: ${missedDays}`, margin + 60, y);
    pdf.setTextColor(217, 119, 6);
    pdf.text(`Partial: ${partialDays}`, margin + 105, y);
    y += 6;
    pdf.setTextColor(100, 116, 139);
    pdf.text('Total expected', margin + 3, y);
    pdf.setTextColor(30, 41, 59);
    pdf.text(formatUGX(schedExpected), cAlloc - 4, y, { align: 'right' });
    pdf.setTextColor(100, 116, 139);
    pdf.text('Total allocated', cTime - 6, y);
    pdf.setTextColor(34, 197, 94);
    pdf.text(formatUGX(schedAllocated), pw - margin - 3, y, { align: 'right' });
    y += 6;
  }

  // ─── Footer on every page ───
  const pageCount = pdf.getNumberOfPages();
  for (let i = 1; i <= pageCount; i++) {
    pdf.setPage(i);
    const footerY = ph - 10;
    pdf.setDrawColor(226, 232, 240);
    pdf.setLineWidth(0.3);
    pdf.line(margin, footerY - 4, pw - margin, footerY - 4);
    pdf.setFontSize(7);
    pdf.setFont('helvetica', 'normal');
    pdf.setTextColor(148, 163, 184);
    pdf.text('Welile Technologies Limited — Confidential. For authorized use only.', margin, footerY);
    pdf.text(`Page ${i} of ${pageCount}`, pw - margin, footerY, { align: 'right' });
  }

  return pdf.output('blob');
}

export async function shareOrDownloadRepaymentSheet(data: RepaymentSheetData): Promise<void> {
  const blob = await generateRepaymentSheetPdf(data);
  const file = new File(
    [blob],
    buildRepaymentSheetFileName(data),
    { type: 'application/pdf' },
  );

  if (navigator.share && navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({
        title: `Repayment Sheet — ${data.tenantName}`,
        text: `Welile repayment sheet for ${data.tenantName}`,
        files: [file],
      });
      return;
    } catch (err: any) {
      if (err?.name === 'AbortError') return;
      // fall through to download
    }
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = file.name;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

/**
 * Open the repayment sheet PDF inline (new browser tab) so the agent can view
 * it on screen — including the day-by-day float allocation log (amount, date &
 * time) — without forcing a download. Falls back to a download when the browser
 * blocks the popup (common on some mobile webviews).
 *
 * To survive popup blockers, callers may open a blank tab synchronously inside
 * the click handler and pass it in as `preopened`; this helper then redirects
 * that already-granted window to the generated blob URL.
 */
export async function openRepaymentSheetPdf(
  data: RepaymentSheetData,
  preopened?: Window | null,
): Promise<void> {
  const blob = await generateRepaymentSheetPdf(data);
  const url = URL.createObjectURL(blob);
  const fileName = buildRepaymentSheetFileName(data);

  const win = preopened ?? window.open('', '_blank');
  if (win) {
    try {
      win.location.href = url;
    } catch {
      win.close?.();
    }
  } else {
    // Popup blocked — fall back to a download so the agent still gets the sheet.
    const a = document.createElement('a');
    a.href = url;
    a.download = fileName;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  }
  // Revoke later so the new tab has time to load the document.
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}