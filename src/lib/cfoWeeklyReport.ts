/**
 * Shared types for the General Weekly CFO Report.
 * Pure reporting layer over `public.get_cfo_weekly_report` — no accounting logic here.
 */

export interface WeeklyPeriod { from: string; to: string; days: number }

export interface WeeklyCashSection {
  opening_cash: number; closing_cash: number; net_change: number;
  opening_bank: number; closing_bank: number;
  opening_treasury: number; closing_treasury: number;
  opening_a1: number; closing_a1: number;
  opening_a5: number; closing_a5: number;
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
}

export interface WeeklyPnlLine { category: string; amount: number; prev_amount: number; count: number }

export interface WeeklyReceivables {
  tenant_outstanding: number; advances_outstanding: number;
  advances_active_count: number; total: number;
}

export interface WeeklyPayables {
  wallet_total: number; wallet_withdrawable: number; wallet_float: number;
  pending_operations_amount: number; pending_operations_count: number; total: number;
}

export interface WeeklyPosition {
  money_we_have: number; money_in_treasury: number; money_in_bank: number;
  money_we_owe: number; money_we_can_use: number; receivables: number;
  net_working_capital: number;
}

export interface CfoWeeklyReport {
  generated_at: string;
  currency: string;
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
      title: 'Wallet obligations exceed cash held',
      detail: `Money we owe (${position.money_we_owe.toLocaleString()}) is above money we have (${position.money_we_have.toLocaleString()}), leaving nothing free for operations.`,
    });
    actions.push('Restore cash cover for wallet obligations before approving further discretionary payouts.');
  }
  if (cash.net_change < 0) {
    risks.push({
      severity: cash.closing_cash > 0 && Math.abs(cash.net_change) > cash.closing_cash ? 'high' : 'medium',
      title: 'Cash position declined over the week',
      detail: `Cash fell by ${Math.abs(cash.net_change).toLocaleString()} from opening ${cash.opening_cash.toLocaleString()} to closing ${cash.closing_cash.toLocaleString()}.`,
    });
    actions.push('Review the largest outflow categories below and confirm each was funded from collections rather than opening cash.');
  }
  if (cash_flow.outflows > cash_flow.inflows) {
    risks.push({
      severity: 'medium',
      title: 'Outflows outpaced inflows',
      detail: `Outflows ${cash_flow.outflows.toLocaleString()} against inflows ${cash_flow.inflows.toLocaleString()} across ${cash_flow.legs} cash legs.`,
    });
    actions.push('Tighten daily disbursement pacing so weekly outflows track collections.');
  }
  if (pnl.net_result < 0) {
    risks.push({
      severity: 'high',
      title: 'Negative net result for the week',
      detail: `Revenue ${pnl.revenue.toLocaleString()} against expenses ${pnl.expenses.toLocaleString()} gives a net result of ${pnl.net_result.toLocaleString()} (margin ${pnl.net_margin}%).`,
    });
    actions.push('Escalate the top three expense categories for cost review at the next management meeting.');
  }
  if (receivables.total > position.money_we_have) {
    risks.push({
      severity: 'medium',
      title: 'Receivables larger than cash held',
      detail: `Receivables ${receivables.total.toLocaleString()} (tenant arrears ${receivables.tenant_outstanding.toLocaleString()} + advances ${receivables.advances_outstanding.toLocaleString()}) exceed cash on hand.`,
    });
    actions.push('Push collections on tenant arrears and agent advance recovery to convert receivables into cash.');
  }
  if (payables.pending_operations_count > 0) {
    risks.push({
      severity: 'low',
      title: 'Pending wallet operations awaiting settlement',
      detail: `${payables.pending_operations_count} pending operation(s) worth ${payables.pending_operations_amount.toLocaleString()} are not yet settled.`,
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
  actions.push('Confirm the closing cash figure against the Statement of Cash Flows and the Full Ledger before circulating externally.');
  return { risks, actions };
}
