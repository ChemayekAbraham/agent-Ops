/**
 * Shared types for the General Weekly CFO Report.
 * Pure reporting layer over `public.get_cfo_weekly_report` — no accounting logic here.
 */

export interface WeeklyPeriod {
  from: string; to: string; days: number;
  /** Monday and Sunday of the reporting week (Kampala dates, YYYY-MM-DD). */
  week_start: string; week_end: string;
  /** False while the week is still in progress (figures run to the moment of generation). */
  complete: boolean;
}

export interface WeeklyCashSection {
  opening_cash: number; closing_cash: number; net_change: number;
  opening_bank: number; closing_bank: number;
  opening_treasury: number; closing_treasury: number;
  opening_a1: number; closing_a1: number;
  opening_a5: number; closing_a5: number;
  /** Landlord float pool, A21 + A22. */
  opening_pool: number; closing_pool: number;
  opening_incl_pool: number; closing_incl_pool: number;
}

export interface WeeklyCashFlowSection {
  inflows: number; outflows: number; net: number; legs: number;
  prev_inflows: number; prev_outflows: number; prev_net: number; prev_legs: number;
}

export interface WeeklyDailyFlow { day: string; inflow: number; outflow: number; net: number }

export interface WeeklyMovement {
  category: string; net: number; inflow: number; outflow: number;
  count: number; prev_net: number; prev_count: number; delta: number;
}

export interface WeeklyMajorTransaction {
  date: string; category: string; description: string | null;
  reference: string | null; amount: number; flow: 'inflow' | 'outflow';
}

export interface WeeklyPnl {
  revenue: number; expenses: number; net_result: number; net_margin: number;
  prev_revenue: number; prev_expenses: number; prev_net_result: number; prev_net_margin: number;
  /** X6 float restatement adjustments included in expenses. */
  float_restatement: number; prev_float_restatement: number;
}

export interface WeeklyPnlLine { category: string; account_code: string; amount: number; prev_amount: number; count: number }

export interface WeeklyAccountLine { account_code: string; label: string; opening: number; closing: number }

/** Balance-sheet receivable accounts (A4 excluded). */
export interface WeeklyReceivables {
  /** A3 Rent Plan receivables. */
  tenant_outstanding: number; opening_tenant_outstanding: number;
  /** A10 + A11 + A20 agent advances, access fees and registration fees. */
  advances_outstanding: number; opening_advances_outstanding: number;
  advances_active_count: number;
  other: number; opening_other: number;
  total: number; opening_total: number;
  lines: WeeklyAccountLine[];
}

/** Current liability accounts; Supporter capital (L2) separately. */
export interface WeeklyPayables {
  /** L1 wallet custody payable. */
  wallet_total: number;
  total: number; opening_total: number;
  supporter_capital: number; opening_supporter_capital: number;
  pending_operations_amount: number; pending_operations_count: number;
  lines: WeeklyAccountLine[];
}

export interface WeeklyPosition {
  money_we_have: number; money_in_treasury: number; money_in_bank: number; landlord_pool: number;
  money_we_owe: number; money_we_can_use: number; receivables: number;
  current_assets: number; current_liabilities: number;
  net_working_capital: number; opening_net_working_capital: number;
}

export interface CfoWeeklyReport {
  generated_at: string;
  currency: string;
  timezone: string;
  basis: string;
  period: WeeklyPeriod;
  previous_period: WeeklyPeriod;
  cash: WeeklyCashSection;
  cash_flow: WeeklyCashFlowSection;
  daily_flow: WeeklyDailyFlow[];
  movements: WeeklyMovement[];
  major_transactions: WeeklyMajorTransaction[];
  profit_and_loss: WeeklyPnl;
  revenue_lines: WeeklyPnlLine[];
  expense_lines: WeeklyPnlLine[];
  receivables: WeeklyReceivables;
  payables: WeeklyPayables;
  position: WeeklyPosition;
}

/** Human label for a ledger category ("agent_float_topup" → "Agent float topup"). */
export function prettyCategory(category: string): string {
  const s = String(category || '').replace(/_/g, ' ').trim();
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : '—';
}

/** Percentage change vs the previous 7-day period (null when there is no base). */
export function pctChange(current: number, previous: number): number | null {
  if (!previous) return null;
  return ((current - previous) / Math.abs(previous)) * 100;
}

export interface WeeklyRisk { title: string; detail: string; severity: 'high' | 'medium' | 'low' }

const ugx = (n: number) => Math.round(n).toLocaleString();

/** Monday (YYYY-MM-DD) of the week containing `d`, using the calendar date in Kampala. */
export function kampalaMonday(d: Date = new Date()): string {
  const k = new Date(d.getTime() + 3 * 3600_000); // Africa/Kampala is UTC+3 all year
  const dow = (k.getUTCDay() + 6) % 7; // 0 = Monday
  k.setUTCDate(k.getUTCDate() - dow);
  return k.toISOString().slice(0, 10);
}

/** Selectable weeks: this week (in progress) first, then `count` completed weeks, newest first. */
export function weekOptions(count = 12, now: Date = new Date()): { value: string; label: string; inProgress: boolean }[] {
  const thisMon = kampalaMonday(now);
  const out: { value: string; label: string; inProgress: boolean }[] = [];
  for (let i = 0; i <= count; i++) {
    const mon = new Date(`${thisMon}T00:00:00Z`);
    mon.setUTCDate(mon.getUTCDate() - 7 * i);
    const sun = new Date(mon);
    sun.setUTCDate(sun.getUTCDate() + 6);
    const f = (x: Date) => x.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', timeZone: 'UTC' });
    const value = mon.toISOString().slice(0, 10);
    out.push({
      value,
      label: `${f(mon)} – ${f(sun)} ${sun.getUTCFullYear()}${i === 0 ? ' (this week, so far)' : i === 1 ? ' (last week)' : ''}`,
      inProgress: i === 0,
    });
  }
  return out;
}

/**
 * Risks and CFO recommendations derived only from the figures in the report —
 * no thresholds are written back anywhere, nothing is estimated or invented.
 */
export function deriveRisksAndActions(r: CfoWeeklyReport): { risks: WeeklyRisk[]; actions: string[] } {
  const risks: WeeklyRisk[] = [];
  const actions: string[] = [];
  const { cash, cash_flow, profit_and_loss: pnl, position, receivables, payables } = r;

  if (position.money_we_owe > position.money_we_have) {
    risks.push({
      severity: 'high',
      title: 'Current liabilities exceed cash held',
      detail: `Current liabilities (${ugx(position.money_we_owe)}, of which wallet custody ${ugx(payables.wallet_total)}) are above cash in A1 + A5 (${ugx(position.money_we_have)}). The landlord float pool (${ugx(position.landlord_pool)}) is held separately.`,
    });
    actions.push('Restore cash cover for wallet custody and other current liabilities before approving further discretionary payouts.');
  }
  if (cash.closing_a1 < 0) {
    risks.push({
      severity: 'high',
      title: 'Cash and bank account (A1) shows a negative balance',
      detail: `A1 closed at ${ugx(cash.closing_a1)}. A bank account cannot be overdrawn by this much, so the ledger is missing or misclassifying cash entries.`,
    });
    actions.push('Reconcile A1 to the bank and mobile-money statements and post the missing or misclassified entries.');
  }
  if (cash.net_change < 0) {
    risks.push({
      severity: cash.closing_cash > 0 && Math.abs(cash.net_change) > cash.closing_cash ? 'high' : 'medium',
      title: 'Cash position declined over the week',
      detail: `Cash fell by ${ugx(Math.abs(cash.net_change))} from opening ${ugx(cash.opening_cash)} to closing ${ugx(cash.closing_cash)}.`,
    });
    actions.push('Review the largest outflow categories below and confirm each was funded from collections rather than opening cash.');
  }
  if (cash_flow.outflows > cash_flow.inflows) {
    risks.push({
      severity: 'medium',
      title: 'Outflows outpaced inflows',
      detail: `Outflows ${ugx(cash_flow.outflows)} against inflows ${ugx(cash_flow.inflows)} across ${cash_flow.legs} cash legs.`,
    });
    actions.push('Tighten daily disbursement pacing so weekly outflows track collections.');
  }
  if (pnl.net_result < 0) {
    const x6 = pnl.float_restatement || 0;
    risks.push({
      severity: 'high',
      title: 'Negative net result for the week',
      detail: `Revenue ${ugx(pnl.revenue)} against expenses ${ugx(pnl.expenses)} gives a net result of ${ugx(pnl.net_result)}.`
        + (x6 ? ` Expenses include ${ugx(x6)} of float restatement adjustments (X6), which are corrections rather than trading costs.` : ''),
    });
    if (x6) actions.push('Review the float restatement adjustments (X6) posted this week and confirm each one is supported.');
    actions.push('Escalate the top three expense categories for cost review at the next management meeting.');
  }
  const tenantAndAdvances = receivables.tenant_outstanding + receivables.advances_outstanding;
  if (tenantAndAdvances > position.money_we_have) {
    risks.push({
      severity: 'medium',
      title: 'Tenant and agent receivables larger than cash held',
      detail: `Rent Plan receivables ${ugx(receivables.tenant_outstanding)} and agent advances ${ugx(receivables.advances_outstanding)} exceed cash in A1 + A5.`,
    });
    actions.push('Push collections on Rent Plan arrears and agent advance recovery to convert receivables into cash.');
  }
  if (payables.pending_operations_count > 0) {
    risks.push({
      severity: 'low',
      title: 'Pending wallet operations awaiting settlement',
      detail: `${payables.pending_operations_count} pending operation(s) worth ${ugx(payables.pending_operations_amount)} are not yet settled.`,
    });
    actions.push('Clear or reject pending wallet operations so the payables figure stays clean.');
  }
  if (!risks.length) {
    risks.push({
      severity: 'low',
      title: 'No threshold breaches detected',
      detail: 'Cash, obligations, profitability and receivables all sit within the reported comparatives for this period.',
    });
  }
  if (!actions.length) actions.push('Maintain current disbursement and collection pacing; no corrective action indicated by this week’s figures.');
  actions.push('Confirm the closing cash figure against the Statement of Cash Flows and the Statement of Financial Position before circulating externally.');
  return { risks, actions };
}
