import { useRef, useState, useEffect, createContext, useContext, useMemo } from 'react';
import { format } from 'date-fns';
import { FileText, TrendingUp, Wallet, BarChart3, Download, FileSpreadsheet, RefreshCw, Loader2, Calendar, ArrowUpRight, ArrowDownRight, Minus, GitCompareArrows, Activity, ClipboardList } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import { toast } from 'sonner';
import { exportToCSV } from '@/lib/exportUtils';
import { useFinancialStatements, type StatementPeriod, type FinancialStatementsData, type ComparisonMode, type ComparisonMetrics, type DeltaValue } from '@/hooks/useFinancialStatements';
import { Progress } from '@/components/ui/progress';
import { ComprehensiveCashMovement } from '@/components/cfo/ComprehensiveCashMovement';
import { LedgerDrillDownDialog } from '@/components/cfo/LedgerDrillDownDialog';
import { FS_DRILL_MAP } from '@/components/cfo/financialStatementsDrillMap';
import { startOfDay, endOfDay, subDays, startOfMonth, startOfYear, startOfWeek, startOfQuarter } from 'date-fns';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Calendar as CalendarPicker } from '@/components/ui/calendar';
import { CheckCircle2, AlertTriangle } from 'lucide-react';

import { formatDynamic as formatUGX } from '@/lib/currencyFormat';
import BalanceSheetPanel from '@/components/cfo/BalanceSheetPanel';
import BudgetApprovalPanel from '@/components/cfo/BudgetApprovalPanel';
import {
  useStatementOfCashFlows,
  flattenCashFlowStatement,
  type StatementOfCashFlows,
} from '@/hooks/useStatementOfCashFlows';

const PERIODS: { value: StatementPeriod; label: string }[] = [
  { value: 'today', label: 'Today' },
  { value: '7days', label: '7 Days' },
  { value: 'week', label: 'This Week' },
  { value: '30days', label: '30 Days' },
  { value: 'month', label: 'This Month' },
  { value: 'quarter', label: 'This Quarter' },
  { value: 'year', label: 'This Year' },
  { value: 'all', label: 'All Time' },
  { value: 'custom', label: 'Custom Range' },
];

const COMPARISON_MODES: { value: ComparisonMode; label: string; short: string }[] = [
  { value: 'previous', label: 'Previous Equivalent Period', short: 'Previous' },
  { value: 'dod', label: 'Day over Day', short: 'DoD' },
  { value: 'wow', label: 'Week over Week', short: 'WoW' },
  { value: 'mom', label: 'Month over Month', short: 'MoM' },
  { value: 'yoy', label: 'Year over Year', short: 'YoY' },
];

function DeltaBadge({ delta }: { delta: DeltaValue | undefined }) {
  if (!delta || (delta.change === 0 && delta.changePercent === null)) return null;
  const isPositive = delta.change > 0;
  const isNegative = delta.change < 0;
  const isNeutral = delta.change === 0;
  const pct = delta.changePercent !== null ? `${delta.changePercent > 0 ? '+' : ''}${delta.changePercent.toFixed(1)}%` : '';
  return (
    <span className={cn(
      'inline-flex items-center gap-0.5 text-[10px] font-medium rounded-full px-1.5 py-0.5 ml-1',
      isPositive && 'bg-success/10 text-success',
      isNegative && 'bg-destructive/10 text-destructive',
      isNeutral && 'bg-muted text-muted-foreground',
    )}>
      {isPositive && <ArrowUpRight className="h-2.5 w-2.5" />}
      {isNegative && <ArrowDownRight className="h-2.5 w-2.5" />}
      {isNeutral && <Minus className="h-2.5 w-2.5" />}
      {pct || formatUGX(Math.abs(delta.change))}
    </span>
  );
}

// ─────────────────────────────────────────────────────────────
// Sub-components
// ─────────────────────────────────────────────────────────────

function LineItem({ label, value, negative, bold, indent, delta }: { label: string; value: number; negative?: boolean; bold?: boolean; indent?: boolean; delta?: DeltaValue }) {
  const colored = negative
    ? value > 0 ? 'text-destructive' : 'text-muted-foreground'
    : value > 0 ? 'text-success' : value < 0 ? 'text-destructive' : 'text-muted-foreground';
  const drill = useContext(DrillContext);
  const trimmed = label.trim();
  const spec = FS_DRILL_MAP[trimmed];
  const clickable = !!spec && !!drill;
  return (
    <div
      className={cn(
        'flex justify-between items-center',
        indent && 'pl-4',
        bold ? 'font-semibold border-t border-border/50 pt-2 mt-1' : 'text-sm',
        clickable && 'cursor-pointer rounded hover:bg-muted/40 -mx-1 px-1 transition-colors'
      )}
      onClick={clickable ? () => drill!.open(trimmed) : undefined}
      role={clickable ? 'button' : undefined}
      title={clickable ? 'Click to view underlying ledger entries' : undefined}
    >
      <span className={cn(bold ? '' : 'text-muted-foreground', 'flex items-center')}>
        {label}
        {clickable && <span className="ml-1 text-[10px] text-primary/70">›</span>}
        {delta && <DeltaBadge delta={delta} />}
      </span>
      <span className={cn('font-mono', colored)}>
        {negative && value > 0 ? `(${formatUGX(value)})` : formatUGX(value)}
      </span>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// Drill-down context — exposes startDate/endDate + open(label)
// ─────────────────────────────────────────────────────────────
interface DrillContextValue {
  open: (label: string) => void;
}
const DrillContext = createContext<DrillContextValue | null>(null);

function getEffectiveDates(period: StatementPeriod, startDate: Date | null, endDate: Date | null) {
  if (startDate || endDate) return { start: startDate, end: endDate };
  const now = new Date();
  switch (period) {
    case 'today':   return { start: startOfDay(now), end: endOfDay(now) };
    case '7days':   return { start: startOfDay(subDays(now, 7)), end: endOfDay(now) };
    case 'week':    return { start: startOfWeek(now, { weekStartsOn: 1 }), end: endOfDay(now) };
    case '30days':  return { start: startOfDay(subDays(now, 30)), end: endOfDay(now) };
    case 'month':   return { start: startOfMonth(now), end: endOfDay(now) };
    case 'quarter': return { start: startOfQuarter(now), end: endOfDay(now) };
    case 'year':    return { start: startOfYear(now), end: endOfDay(now) };
    default:        return { start: null, end: null };
  }
}

function SectionHeader({ children }: { children: React.ReactNode }) {
  return <h4 className="text-xs font-semibold text-primary uppercase tracking-wider mt-4 mb-2">{children}</h4>;
}

function incomeStatementTotals(d: FinancialStatementsData['incomeStatement']) {
  const netRevenue = d.byService.totalRevenue;
  const grossProfit = netRevenue - d.serviceDeliveryCosts.total;
  const ebitda = grossProfit - d.operatingExpenses.total + d.adjustments.total;
  const operatingIncome = ebitda - d.depreciation - d.amortization;
  const profitBeforeTax = operatingIncome + d.otherIncomeExpensesNet;
  const netIncome = profitBeforeTax - d.taxProvision;

  return {
    netRevenue,
    grossProfit,
    grossMargin: netRevenue > 0 ? (grossProfit / netRevenue) * 100 : 0,
    ebitda,
    ebitdaMargin: netRevenue > 0 ? (ebitda / netRevenue) * 100 : 0,
    operatingIncome,
    operatingMargin: netRevenue > 0 ? (operatingIncome / netRevenue) * 100 : 0,
    profitBeforeTax,
    netIncome,
  };
}

type PnlRowKind = 'section' | 'group' | 'detail' | 'subtotal' | 'highlight' | 'margin';

interface PnlRow {
  key: string;
  label: string;
  current?: number;
  previous?: number;
  kind: PnlRowKind;
  source?: string;
  percentage?: boolean;
}

const pnlValue = (value: number) => value < 0 ? `(${formatUGX(Math.abs(value))})` : formatUGX(value);
const pnlChangePercent = (current: number, previous: number) => previous === 0 ? null : ((current - previous) / Math.abs(previous)) * 100;

function buildManagementPnl(d: FinancialStatementsData['incomeStatement'], previous?: FinancialStatementsData['incomeStatement']): PnlRow[] {
  const c = incomeStatementTotals(d);
  const p = previous ? incomeStatementTotals(previous) : undefined;
  const rows: PnlRow[] = [];
  const add = (key: string, label: string, current: number, previousValue: number | undefined, kind: PnlRowKind, source?: string, percentage?: boolean) =>
    rows.push({ key, label, current, previous: previousValue, kind, source, percentage });
  const previousRevenueLine = (source: string) => previous?.byService.revenueFamilies.flatMap(f => f.lines).find(l => l.source === source)?.amount ?? 0;
  const previousContraLine = (source: string) => previous?.byService.contraRevenue.lines.find(l => l.source === source)?.amount ?? 0;

  rows.push({ key: 'revenue', label: 'Revenue', kind: 'section' });
  d.byService.revenueFamilies.forEach(family => {
    rows.push({ key: `revenue-family-${family.key}`, label: family.label, kind: 'group' });
    family.lines.forEach(line => add(`revenue-${line.source}`, line.label, line.amount, previousRevenueLine(line.source), 'detail', line.source));
    const previousFamily = previous?.byService.revenueFamilies.find(item => item.key === family.key)?.total ?? 0;
    add(`revenue-family-total-${family.key}`, `Total ${family.label}`, family.total, previousFamily, 'subtotal');
  });
  add('gross-revenue', 'Gross Revenue', d.byService.grossRevenue, previous?.byService.grossRevenue, 'subtotal');
  if (d.byService.contraRevenue.lines.length > 0 || (previous?.byService.contraRevenue.lines.length ?? 0) > 0) {
    rows.push({ key: 'revenue-deductions', label: 'Revenue Deductions', kind: 'group' });
    d.byService.contraRevenue.lines.forEach(line => add(`contra-${line.source}`, line.label, -line.amount, -previousContraLine(line.source), 'detail', line.source));
    add('total-revenue-deductions', 'Total Revenue Deductions', -d.byService.contraRevenue.total, previous ? -previous.byService.contraRevenue.total : undefined, 'subtotal');
  }
  add('net-revenue', 'Net Revenue', c.netRevenue, p?.netRevenue, 'subtotal');

  rows.push({ key: 'cost-of-revenue', label: 'Cost of Revenue', kind: 'section' });
  add('platform-rewards', 'Platform Rewards (Supporters)', -d.serviceDeliveryCosts.platformRewards, previous ? -previous.serviceDeliveryCosts.platformRewards : undefined, 'detail');
  add('agent-commissions', 'Agent Commissions', -d.serviceDeliveryCosts.agentCommissions, previous ? -previous.serviceDeliveryCosts.agentCommissions : undefined, 'detail');
  add('referral-bonuses', 'Referral Bonuses', -d.serviceDeliveryCosts.referralBonuses, previous ? -previous.serviceDeliveryCosts.referralBonuses : undefined, 'detail');
  add('agent-bonuses', 'Agent Bonuses', -d.serviceDeliveryCosts.agentBonuses, previous ? -previous.serviceDeliveryCosts.agentBonuses : undefined, 'detail');
  add('transaction-expenses', 'Transaction Expenses', -d.serviceDeliveryCosts.transactionExpenses, previous ? -previous.serviceDeliveryCosts.transactionExpenses : undefined, 'detail');
  add('total-cost-of-revenue', 'Total Cost of Revenue', -d.serviceDeliveryCosts.total, previous ? -previous.serviceDeliveryCosts.total : undefined, 'subtotal');
  add('gross-profit', 'Gross Profit / (Loss)', c.grossProfit, p?.grossProfit, 'highlight');
  add('gross-margin', 'Gross Margin %', c.grossMargin, p?.grossMargin, 'margin', undefined, true);

  rows.push({ key: 'operating-expenses', label: 'Operating Expenses', kind: 'section' });
  rows.push({ key: 'people-operations', label: 'People & Field Operations', kind: 'group' });
  add('payroll', 'Payroll & Staff Costs', -d.operatingExpenses.payrollExpenses, previous ? -previous.operatingExpenses.payrollExpenses : undefined, 'detail');
  add('agent-requisitions', 'Agent Requisitions', -d.operatingExpenses.agentRequisitions, previous ? -previous.operatingExpenses.agentRequisitions : undefined, 'detail');
  add('financial-agent-expenses', 'Financial Agent Expenses', -d.operatingExpenses.financialAgentExpenses, previous ? -previous.operatingExpenses.financialAgentExpenses : undefined, 'detail');
  rows.push({ key: 'growth-product', label: 'Growth & Product', kind: 'group' });
  add('marketing', 'Marketing Expenses', -d.operatingExpenses.marketingExpenses, previous ? -previous.operatingExpenses.marketingExpenses : undefined, 'detail');
  add('research-development', 'Research & Development', -d.operatingExpenses.researchDevelopment, previous ? -previous.operatingExpenses.researchDevelopment : undefined, 'detail');
  rows.push({ key: 'general-administration', label: 'General & Administration', kind: 'group' });
  add('general-admin', 'General & Admin Expenses', -d.operatingExpenses.generalOperating, previous ? -previous.operatingExpenses.generalOperating : undefined, 'detail');
  add('tenant-default', 'Tenant Default Charge', -d.operatingExpenses.tenantDefaultCharges, previous ? -previous.operatingExpenses.tenantDefaultCharges : undefined, 'detail');
  add('debt-clearance', 'Debt Clearance', -d.operatingExpenses.debtClearance, previous ? -previous.operatingExpenses.debtClearance : undefined, 'detail');
  add('platform-loss', 'Platform Loss Writeoff', -d.operatingExpenses.platformLossWriteoff, previous ? -previous.operatingExpenses.platformLossWriteoff : undefined, 'detail');
  add('merchant-oop', 'Merchant Oop Reimbursement', -d.operatingExpenses.merchantOopReimbursement, previous ? -previous.operatingExpenses.merchantOopReimbursement : undefined, 'detail');
  add('total-operating-expenses', 'Total Operating Expenses', -d.operatingExpenses.total, previous ? -previous.operatingExpenses.total : undefined, 'subtotal');

  if (d.adjustments.total !== 0 || (previous?.adjustments.total ?? 0) !== 0) {
    rows.push({ key: 'adjustments', label: 'Operating Adjustments & Corrections', kind: 'group' });
    add('wallet-deductions', 'Wallet Deductions (Recoveries)', d.adjustments.walletDeductions, previous?.adjustments.walletDeductions, 'detail');
    add('system-corrections', 'System Balance Corrections', d.adjustments.systemCorrections, previous?.adjustments.systemCorrections, 'detail');
    add('orphan-reassignments', 'Orphan Reassignments', d.adjustments.orphanReassignments, previous?.adjustments.orphanReassignments, 'detail');
    add('orphan-reversals', 'Orphan Reversals', -d.adjustments.orphanReversals, previous ? -previous.adjustments.orphanReversals : undefined, 'detail');
    add('net-adjustments', 'Net Operating Adjustments', d.adjustments.total, previous?.adjustments.total, 'subtotal');
  }
  rows.push({ key: 'depreciation-amortization', label: 'Depreciation & Amortization', kind: 'group' });
  add('depreciation', 'Depreciation (Property & Equipment)', -d.depreciation, previous ? -previous.depreciation : undefined, 'detail');
  add('amortization', 'Amortization (Software & IP)', -d.amortization, previous ? -previous.amortization : undefined, 'detail');
  add('operating-profit', 'Operating Profit / (Loss)', c.operatingIncome, p?.operatingIncome, 'highlight');

  rows.push({ key: 'other-income-expense', label: 'Other Income / (Expense)', kind: 'section' });
  add('finance-income', 'Finance Income', d.interestIncome, previous?.interestIncome, 'detail');
  add('interest-expense', 'Interest Expense', -d.interestExpense, previous ? -previous.interestExpense : undefined, 'detail');
  add('net-other-income-expense', 'Net Other Income / (Expense)', d.otherIncomeExpensesNet, previous?.otherIncomeExpensesNet, 'subtotal');
  add('profit-before-tax', 'Profit / (Loss) Before Tax', c.profitBeforeTax, p?.profitBeforeTax, 'highlight');
  rows.push({ key: 'tax', label: 'Tax', kind: 'section' });
  add('tax-provision', 'Tax Provision', -d.taxProvision, previous ? -previous.taxProvision : undefined, 'detail');
  add('net-profit', 'Net Profit / (Loss)', c.netIncome, p?.netIncome, 'highlight');
  return rows;
}

function buildRevenueRecognitionRows(d: FinancialStatementsData['incomeStatement'], previous?: FinancialStatementsData['incomeStatement']): PnlRow[] {
  return [
    { key: 'expected-access', label: 'Expected Access Fees', current: d.revenueRecognition.expectedAccessFees, previous: previous?.revenueRecognition.expectedAccessFees, kind: 'detail' },
    { key: 'expected-request', label: 'Expected Request Fees', current: d.revenueRecognition.expectedRequestFees, previous: previous?.revenueRecognition.expectedRequestFees, kind: 'detail' },
    { key: 'expected-total', label: 'Total Expected Revenue', current: d.revenueRecognition.totalExpectedRevenue, previous: previous?.revenueRecognition.totalExpectedRevenue, kind: 'subtotal' },
    { key: 'realized-access', label: 'Realized Access Fees', current: d.revenueRecognition.realizedAccessFees, previous: previous?.revenueRecognition.realizedAccessFees, kind: 'detail' },
    { key: 'realized-request', label: 'Realized Request Fees', current: d.revenueRecognition.realizedRequestFees, previous: previous?.revenueRecognition.realizedRequestFees, kind: 'detail' },
    { key: 'realized-total', label: 'Total Realized Revenue', current: d.revenueRecognition.totalRealizedRevenue, previous: previous?.revenueRecognition.totalRealizedRevenue, kind: 'subtotal' },
    { key: 'deferred-revenue', label: 'Revenue Not Yet Collected', current: d.revenueRecognition.deferredRevenue, previous: previous?.revenueRecognition.deferredRevenue, kind: 'detail' },
    { key: 'recognition-rate', label: 'Recognition Rate', current: d.revenueRecognition.recognitionRate, previous: previous?.revenueRecognition.recognitionRate, kind: 'margin', percentage: true },
  ];
}

function ManagementPnlTable({ rows }: { rows: PnlRow[] }) {
  return (
    <div className="overflow-x-auto border border-border rounded-md">
      <div className="min-w-[820px]">
        <div className="grid grid-cols-[minmax(250px,1.8fr)_repeat(4,minmax(125px,1fr))] bg-muted/60 border-b border-border text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
          <div className="px-3 py-2.5">Account</div>
          <div className="px-3 py-2.5 text-right">Current Period</div>
          <div className="px-3 py-2.5 text-right">Previous Period</div>
          <div className="px-3 py-2.5 text-right">Change</div>
          <div className="px-3 py-2.5 text-right">Change %</div>
        </div>
        {rows.map(row => {
          if (row.kind === 'section') return (
            <div key={row.key} className="px-3 py-2.5 bg-secondary/70 border-t border-border first:border-t-0 text-xs font-bold uppercase tracking-wider">
              {row.label}
            </div>
          );
          if (row.kind === 'group') return (
            <div key={row.key} className="px-3 py-2 bg-muted/30 border-t border-border/60 text-[11px] font-semibold text-foreground">
              {row.label}
            </div>
          );
          const current = row.current ?? 0;
          const previous = row.previous;
          const change = previous === undefined ? undefined : current - previous;
          const changePercent = previous === undefined ? undefined : pnlChangePercent(current, previous);
          const emphasized = row.kind === 'highlight';
          return (
            <div key={row.key} title={row.source ? `Ledger source: ${row.source}` : undefined} className={cn(
              'grid grid-cols-[minmax(250px,1.8fr)_repeat(4,minmax(125px,1fr))] border-t border-border/50 text-xs tabular-nums',
              row.kind === 'detail' && 'text-muted-foreground',
              row.kind === 'subtotal' && 'font-semibold bg-muted/10',
              emphasized && 'font-bold bg-primary/5 border-t-2 border-primary/30 text-foreground',
              row.kind === 'margin' && 'font-semibold bg-primary/5 text-foreground',
            )}>
              <div className={cn('px-3 py-2', row.kind === 'detail' && 'pl-7')}>{row.label}</div>
              {[current, previous, change].map((value, index) => (
                <div key={index} className={cn('px-3 py-2 text-right font-mono', value !== undefined && value < 0 && 'text-destructive')}>
                  {value === undefined ? '—' : row.percentage ? `${value.toFixed(1)}%` : pnlValue(value)}
                </div>
              ))}
              <div className={cn('px-3 py-2 text-right font-mono', changePercent !== undefined && changePercent !== null && changePercent < 0 && 'text-destructive')}>
                {changePercent === undefined || changePercent === null ? '—' : `${changePercent > 0 ? '+' : ''}${changePercent.toFixed(1)}%`}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function IncomeStatementSection({ d, previous }: { d: FinancialStatementsData['incomeStatement']; previous?: FinancialStatementsData['incomeStatement'] }) {
  const rows = buildManagementPnl(d, previous);
  const recognitionRows = buildRevenueRecognitionRows(d, previous);
  return (
    <div className="space-y-6">
      <div>
        <p className="text-xs text-muted-foreground mb-3">Management P&amp;L · all amounts in UGX · ledger-backed registered accounts only</p>
        <ManagementPnlTable rows={rows} />
      </div>
      {d.byService.reviewQueue.length > 0 && (
        <div className="p-3 rounded-md border border-warning/30 bg-warning/5">
          <p className="text-xs font-semibold text-warning uppercase tracking-wider mb-1">Flagged for review — unmapped ledger categories</p>
          {d.byService.reviewQueue.map(line => <div key={`${line.category}-${line.direction}`} className="flex justify-between text-xs"><span>{line.category}</span><span className="font-mono">{formatUGX(line.amount)}</span></div>)}
        </div>
      )}
      <div>
        <SectionHeader>Supporting Schedule — Revenue Recognition</SectionHeader>
        <p className="text-[10px] text-muted-foreground mb-2">Expected revenue from active Rent Plans compared with ledger-confirmed collections.</p>
        <ManagementPnlTable rows={recognitionRows} />
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// Statement of Cash Flows — corporate presentation.
// Sourced entirely from public.get_statement_of_cash_flows(), which derives
// cash from the General Ledger cash accounts (A1 Cash & Bank, A2 Float with
// Agents) via ledger_account_map / cash_flow_line_map. Internal wallet
// transfers, platform mirror legs, custody movements and reclassifications
// are eliminated inside the RPC and never reach these totals.
// ─────────────────────────────────────────────────────────────

function CashFlowRow({ label, value, indent = 0, weight = 'normal' }: { label: string; value: number; indent?: number; weight?: 'normal' | 'group' | 'section' }) {
  return (
    <div
      className={cn(
        'flex justify-between items-center gap-4',
        weight === 'normal' && 'text-sm',
        weight === 'group' && 'text-sm font-semibold border-t border-border/50 pt-1.5 mt-1',
        weight === 'section' && 'text-sm font-bold border-t-2 border-primary/30 pt-2 mt-1.5',
      )}
      style={{ paddingLeft: indent * 12 }}
    >
      <span className={cn(weight === 'normal' ? 'text-muted-foreground' : 'text-foreground')}>{label}</span>
      <span className={cn('font-mono shrink-0', value < 0 ? 'text-destructive' : value > 0 ? 'text-success' : 'text-muted-foreground')}>
        {value < 0 ? `(${formatUGX(Math.abs(value))})` : formatUGX(value)}
      </span>
    </div>
  );
}

function CashFlowStatementSectionBlock({ title, section }: { title: string; section: StatementOfCashFlows['operating'] }) {
  return (
    <div className="space-y-1">
      <SectionHeader>{title}</SectionHeader>
      {section.groups.length === 0 && (
        <p className="pl-4 text-xs text-muted-foreground">No cash flows in this period.</p>
      )}
      {section.groups.map(g => (
        <div key={g.label} className="space-y-1 mb-2">
          <p className="text-xs font-semibold text-foreground pl-1">{g.label}</p>
          {g.lines.map(l => (
            <CashFlowRow key={l.label} label={l.label} value={l.amount} indent={2} />
          ))}
          <CashFlowRow label={`Total ${g.label}`} value={g.total} indent={1} weight="group" />
        </div>
      ))}
      <CashFlowRow
        label={`Net cash provided by (used in) ${title.replace('Cash Flows from ', '').toLowerCase()}`}
        value={section.total}
        weight="section"
      />
    </div>
  );
}

function CashFlowSection({ d, error }: { d: StatementOfCashFlows | null; error?: string | null }) {
  if (error) {
    return (
      <div className="flex items-start gap-2 rounded-md border border-destructive/40 p-3 text-xs text-destructive">
        <AlertTriangle className="h-4 w-4 shrink-0" />
        <span>Could not build the cash flow statement: {error}</span>
      </div>
    );
  }
  if (!d) {
    return (
      <div className="flex items-center gap-2 py-8 justify-center text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" /> Building statement of cash flows…
      </div>
    );
  }
  return (
    <div className="space-y-1">
      <p className="text-[10px] text-muted-foreground">{d.cash_definition}</p>

      <CashFlowStatementSectionBlock title="Cash Flows from Operating Activities" section={d.operating} />
      <CashFlowStatementSectionBlock title="Cash Flows from Investing Activities" section={d.investing} />
      <CashFlowStatementSectionBlock title="Cash Flows from Financing Activities" section={d.financing} />

      <div className="pt-4 mt-3 border-t-2 border-primary/30 space-y-1">
        <CashFlowRow label="Effect of exchange rate changes on cash and cash equivalents" value={d.exchange_rate_effect} />
        <CashFlowRow label="Net increase / (decrease) in cash and cash equivalents" value={d.net_change} weight="group" />
        <CashFlowRow label="Cash and cash equivalents at beginning of period" value={d.opening_cash} />
        <div className="flex justify-between items-center text-base font-bold border-t-2 border-primary/30 pt-2">
          <span>Cash and cash equivalents at end of period</span>
          <span className="font-mono text-primary">{formatUGX(d.closing_cash)}</span>
        </div>
        <div className={cn('flex items-center gap-1.5 pt-1 text-[11px]', d.reconciles ? 'text-success' : 'text-destructive')}>
          {d.reconciles ? <CheckCircle2 className="h-3.5 w-3.5" /> : <AlertTriangle className="h-3.5 w-3.5" />}
          <span>
            {d.reconciles
              ? 'Opening cash + net increase / (decrease) = closing cash, and closing cash equals the cash accounts on the Balance Sheet.'
              : 'Opening cash + net movement does not tie to closing cash — review the ledger.'}
          </span>
        </div>
        {/* Explicit tie-out to the Balance Sheet cash accounts. Each account is
            shown at its signed ledger value (debits less credits) so the total
            can be checked by simple addition. */}
        <div className="pt-3 mt-2 border-t border-border/60 space-y-1">
          <p className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wide">
            Reconciliation to Balance Sheet cash accounts
          </p>
          {(d.cash_accounts ?? []).map((a) => (
            <CashFlowRow key={a.code} label={`${a.code} ${a.label}`} value={a.closing} indent={1} />
          ))}
          <CashFlowRow label="Total Balance Sheet cash accounts (A1 + A2)" value={d.balance_sheet_cash} weight="group" />
          <CashFlowRow
            label="Difference: closing cash less Balance Sheet cash accounts"
            value={d.closing_cash - d.balance_sheet_cash}
            weight="group"
          />
          <div className={cn('flex items-center gap-1.5 text-[11px]', d.ties_to_balance_sheet ? 'text-success' : 'text-destructive')}>
            {d.ties_to_balance_sheet ? <CheckCircle2 className="h-3.5 w-3.5" /> : <AlertTriangle className="h-3.5 w-3.5" />}
            <span>
              {d.ties_to_balance_sheet
                ? 'Closing cash equals A1 + A2 exactly — zero unexplained difference.'
                : 'Closing cash does not equal A1 + A2 — review the cash account mapping.'}
            </span>
          </div>
        </div>
        {Math.abs(d.unreconciled_residual) >= 1 && (
          <p className="text-[10px] text-muted-foreground">
            {formatUGX(Math.abs(d.unreconciled_residual))} of the period movement comes from historic single-sided
            ledger postings with no counterpart leg. It is disclosed on its own line inside Other Operating Activities
            rather than spread across real business lines.
          </p>
        )}
      </div>
    </div>
  );
}

function BalanceSheetSection({ d }: { d: FinancialStatementsData['balanceSheet'] }) {
  const balanced = Math.abs(d.assets.totalAssets - (d.platformObligations.totalObligations + d.platformEquity.totalEquity)) < 1;
  return (
    <div className="space-y-1">
      <SectionHeader>Assets</SectionHeader>
      <LineItem label="Platform Cash (Earned Revenue)" value={d.assets.platformCash} indent />
      <LineItem label="User Funds Held in Custody" value={d.assets.userFundsHeld} indent />
      <LineItem label="Rent Receivables (Funded)" value={d.assets.receivables} indent />
      {d.assets.rentReceivablesCreated > 0 && (
        <LineItem label="Rent Receivables Created" value={d.assets.rentReceivablesCreated} indent />
      )}
      <LineItem label="Advance Access Fee Receivables" value={d.assets.advanceAccessFeeReceivables} indent />
      <LineItem label="Promissory Notes Receivable" value={d.assets.promissoryNotesReceivable} indent />
      <LineItem label="Total Assets" value={d.assets.totalAssets} bold />

      <SectionHeader>Obligations (Liabilities)</SectionHeader>
      <p className="text-[10px] text-muted-foreground pl-4 -mt-1 mb-1">User wallets are custodial — these funds belong to users, not the platform</p>
      <LineItem label="User Wallet Balances (Custody)" value={d.platformObligations.userWalletCustody} negative indent />
      <LineItem label="Pending Withdrawal Provisions" value={d.platformObligations.pendingWithdrawals} negative indent />
      <LineItem label="Accrued Platform Rewards" value={d.platformObligations.accruedPlatformRewards} negative indent />
      <LineItem label="Agent Commissions Payable" value={d.platformObligations.agentCommissionsPayable} negative indent />
      {d.platformObligations.deferredRevenue > 0 && (
        <LineItem label="Deferred Revenue (Unrecognized Fees)" value={d.platformObligations.deferredRevenue} negative indent />
      )}
      <LineItem label="Total Obligations" value={d.platformObligations.totalObligations} negative bold />

      <SectionHeader>Platform Equity</SectionHeader>
      <LineItem label="Retained Operating Surplus" value={d.platformEquity.retainedOperatingSurplus} indent />
      <LineItem label="Total Equity" value={d.platformEquity.totalEquity} bold />

      {/* GAAP: AR Aging Schedule */}
      {d.arAging.total > 0 && (
        <div className="mt-3 p-3 rounded-lg bg-secondary/50 border border-border/50 space-y-1">
          <p className="text-xs font-semibold text-primary uppercase tracking-wider">Accounts Receivable Aging</p>
          <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs">
            <span className="text-muted-foreground">Current (0–30 days)</span>
            <span className="font-mono text-right text-success">{formatUGX(d.arAging.current)}</span>
            <span className="text-muted-foreground">31–60 days</span>
            <span className="font-mono text-right text-warning">{formatUGX(d.arAging.days31to60)}</span>
            <span className="text-muted-foreground">61–90 days</span>
            <span className="font-mono text-right text-warning">{formatUGX(d.arAging.days61to90)}</span>
            <span className="text-muted-foreground">90+ days (At Risk)</span>
            <span className="font-mono text-right text-destructive">{formatUGX(d.arAging.over90)}</span>
            <span className="font-medium">Total Receivables</span>
            <span className="font-mono text-right font-medium">{formatUGX(d.arAging.total)}</span>
            <span className="text-muted-foreground">Bad Debt Provision (Est.)</span>
            <span className="font-mono text-right text-destructive">{formatUGX(d.arAging.badDebtProvision)}</span>
          </div>
        </div>
      )}

      {/* GAAP: Working Capital */}
      <div className="mt-3 p-3 rounded-lg bg-secondary/50 border border-border/50 space-y-1">
        <p className="text-xs font-semibold text-primary uppercase tracking-wider">Working Capital Analysis</p>
        <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs">
          <span className="text-muted-foreground">Current Assets</span>
          <span className="font-mono text-right">{formatUGX(d.workingCapital.currentAssets)}</span>
          <span className="text-muted-foreground">Current Liabilities</span>
          <span className="font-mono text-right">{formatUGX(d.workingCapital.currentLiabilities)}</span>
          <span className="font-medium">Net Working Capital</span>
          <span className={cn('font-mono text-right font-medium', d.workingCapital.workingCapital >= 0 ? 'text-success' : 'text-destructive')}>
            {formatUGX(d.workingCapital.workingCapital)}
          </span>
          <span className="text-muted-foreground">Current Ratio</span>
          <span className="font-mono text-right">{d.workingCapital.currentRatio.toFixed(2)}x</span>
        </div>
      </div>

      {/* GAAP: Statement of Changes in Equity */}
      <div className="mt-3 p-3 rounded-lg bg-secondary/50 border border-border/50 space-y-1">
        <p className="text-xs font-semibold text-primary uppercase tracking-wider">Statement of Changes in Equity</p>
        <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs">
          <span className="text-muted-foreground">Opening Equity</span>
          <span className="font-mono text-right">{formatUGX(d.equityChanges.openingEquity)}</span>
          <span className="text-muted-foreground">Net Income for Period</span>
          <span className={cn('font-mono text-right', d.equityChanges.netIncome >= 0 ? 'text-success' : 'text-destructive')}>
            {formatUGX(d.equityChanges.netIncome)}
          </span>
          {d.equityChanges.otherChanges !== 0 && (
            <>
              <span className="text-muted-foreground">Other Changes</span>
              <span className="font-mono text-right">{formatUGX(d.equityChanges.otherChanges)}</span>
            </>
          )}
          <span className="font-medium">Closing Equity</span>
          <span className="font-mono text-right font-medium">{formatUGX(d.equityChanges.closingEquity)}</span>
        </div>
      </div>

      {/* Revenue Recognition Summary */}
      {d.revenueRecognition.expectedRevenue > 0 && (
        <div className="mt-3 p-3 rounded-lg bg-warning/5 border border-warning/20 space-y-1">
          <p className="text-xs font-semibold text-warning uppercase tracking-wider">Revenue Recognition (ASC 606)</p>
          <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs">
            <span className="text-muted-foreground">Expected Revenue</span>
            <span className="font-mono text-right">{formatUGX(d.revenueRecognition.expectedRevenue)}</span>
            <span className="text-muted-foreground">Realized Revenue</span>
            <span className="font-mono text-right text-success">{formatUGX(d.revenueRecognition.realizedRevenue)}</span>
            <span className="text-muted-foreground">Deferred Revenue</span>
            <span className="font-mono text-right text-warning">{formatUGX(d.revenueRecognition.deferredRevenue)}</span>
            <span className="text-muted-foreground">Recognition Rate</span>
            <span className="font-mono text-right">{d.revenueRecognition.recognitionRate.toFixed(1)}%</span>
          </div>
        </div>
      )}

      <p className={cn('text-xs text-center pt-2 mt-1', balanced ? 'text-success' : 'text-destructive')}>
        {balanced ? '✓ Balance sheet is balanced (Assets = Obligations + Equity)' : '⚠ Requires reconciliation'}
      </p>
    </div>
  );
}

function FacilitatedVolumeSection({ d, cm }: { d: FinancialStatementsData['facilitatedVolume']; cm?: ComparisonMetrics | null }) {
  const utilizationRate = d.supporterCapitalDeployed > 0 ? Math.min(100, (d.totalFacilitatedRentVolume / d.supporterCapitalDeployed) * 100) : 0;
  return (
    <div className="space-y-4">
      <div className="text-center py-3 rounded-xl bg-primary/5 border border-primary/20">
        <p className="text-xs text-muted-foreground uppercase tracking-wider mb-1">Total Facilitated Rent Volume</p>
        <p className="text-3xl font-bold font-mono text-primary">{formatUGX(d.totalFacilitatedRentVolume)}</p>
        {cm && <DeltaBadge delta={cm.totalFacilitatedRentVolume} />}
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div className="p-3 rounded-lg bg-success/10 border border-success/20 text-center">
          <p className="text-xl font-bold text-success">{d.approvedRequests}</p>
          <p className="text-xs text-muted-foreground">Approved Requests</p>
        </div>
        <div className="p-3 rounded-lg bg-warning/10 border border-warning/20 text-center">
          <p className="text-xl font-bold text-warning">{d.pendingRequests}</p>
          <p className="text-xs text-muted-foreground">Pending Requests</p>
        </div>
        <div className="p-3 rounded-lg bg-secondary text-center">
          <p className="text-xl font-bold font-mono text-primary">{d.activeTenants}</p>
          <p className="text-xs text-muted-foreground">Unique Tenants</p>
        </div>
        <div className="p-3 rounded-lg bg-secondary text-center">
          <p className="text-xl font-bold font-mono text-primary">{d.activeAgents}</p>
          <p className="text-xs text-muted-foreground">Active Agents</p>
        </div>
      </div>

      <div className="space-y-1">
        <SectionHeader>Fee Income Breakdown</SectionHeader>
        <LineItem label="Access Fee Income" value={d.totalAccessFeeIncome} indent />
        <LineItem label="Request Fee Income" value={d.totalRequestFeeIncome} indent />
        <LineItem label="Average Rent Amount" value={d.averageRentAmount} indent />
      </div>

      <div className="space-y-2">
        <div className="flex justify-between text-sm">
          <span className="text-muted-foreground">Capital Utilization Rate</span>
          <span className="font-mono font-semibold">{utilizationRate.toFixed(1)}%</span>
        </div>
        <Progress value={utilizationRate} className="h-2" />
        <div className="grid grid-cols-2 gap-2 text-xs text-center text-muted-foreground">
          <span>Deployed: {formatUGX(d.supporterCapitalDeployed)}</span>
          <span>Facilitated: {formatUGX(d.totalFacilitatedRentVolume)}</span>
        </div>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// Main Panel
// ─────────────────────────────────────────────────────────────

type Tab = 'income' | 'cashflow' | 'movement' | 'balance' | 'volume' | 'budget';

const TABS: { id: Tab; label: string; icon: React.ReactNode }[] = [
  { id: 'movement', label: 'Cash Movement', icon: <Activity className="h-3.5 w-3.5" /> },
  { id: 'income', label: 'Income', icon: <TrendingUp className="h-3.5 w-3.5" /> },
  { id: 'cashflow', label: 'Cash Flow', icon: <Wallet className="h-3.5 w-3.5" /> },
  { id: 'balance', label: 'Balance Sheet', icon: <FileText className="h-3.5 w-3.5" /> },
  { id: 'volume', label: 'Facilitated Volume', icon: <BarChart3 className="h-3.5 w-3.5" /> },
  { id: 'budget', label: 'Department Budgets', icon: <ClipboardList className="h-3.5 w-3.5" /> },
];

export function FinancialStatementsPanel() {
  return <FinancialStatementsPanelInner />;
}

/**
 * Reconciliation strip — proves the three statements tie back to the ledger.
 * Read-only: every figure comes from the same `general_ledger` rows.
 */
function ReconciliationCard({ r, cf }: { r: import('@/hooks/useFinancialStatements').ReconciliationCheck; cf?: StatementOfCashFlows | null }) {
  // When the ledger-derived statement of cash flows is available it is the
  // authoritative cash reconciliation: it resolves every leg through the same
  // resolver the balance sheet uses, so its closing cash is the balance sheet's
  // cash. The legacy client-side figures are only used as a fallback.
  const cash = cf
    ? {
        openingCash: cf.opening_cash,
        closingCash: cf.closing_cash,
        netMovement: cf.net_change,
        balanceSheetCash: cf.balance_sheet_cash,
        cashDifference: cf.closing_cash - cf.balance_sheet_cash,
        cashTied: cf.ties_to_balance_sheet,
        unclassifiedNet: cf.unreconciled_residual,
      }
    : {
        openingCash: r.openingCash,
        closingCash: r.closingCash,
        netMovement: r.periodNet,
        balanceSheetCash: r.balanceSheetCash,
        cashDifference: r.cashDifference,
        cashTied: r.cashTied,
        unclassifiedNet: r.unclassifiedNet,
      };
  const ok = r.balanced && cash.cashTied;
  return (
    <Card className={cn('border', ok ? 'border-success/40' : 'border-destructive/40')}>
      <CardContent className="py-3 space-y-2">
        <div className="flex items-center gap-2">
          {ok ? <CheckCircle2 className="h-4 w-4 text-success" /> : <AlertTriangle className="h-4 w-4 text-destructive" />}
          <p className={cn('text-xs font-semibold', ok ? 'text-success' : 'text-destructive')}>
            {ok ? 'Reconciled to the general ledger' : 'Reconciliation gap — review below'}
          </p>
        </div>
        <div className="grid grid-cols-2 gap-2 text-[11px]">
          <div className="rounded-md border border-border/60 p-2">
            <p className="uppercase tracking-wider text-muted-foreground">Assets = Liabilities + Equity</p>
            <p className="font-mono text-foreground">{formatUGX(r.totalAssets)} = {formatUGX(r.totalLiabilities)} + {formatUGX(r.totalEquity)}</p>
            <p className={cn('font-mono', r.balanced ? 'text-muted-foreground' : 'text-destructive')}>
              Difference {formatUGX(r.balanceDifference)}
            </p>
          </div>
          <div className="rounded-md border border-border/60 p-2">
            <p className="uppercase tracking-wider text-muted-foreground">Closing cash vs balance sheet cash</p>
            <p className="font-mono text-foreground">{formatUGX(cash.closingCash)} vs {formatUGX(cash.balanceSheetCash)}</p>
            <p className={cn('font-mono', cash.cashTied ? 'text-muted-foreground' : 'text-destructive')}>
              Difference {formatUGX(cash.cashDifference)}
            </p>
          </div>
        </div>
        <div className="grid grid-cols-3 gap-2 text-[11px]">
          <Figure label="Opening cash" value={cash.openingCash} />
          <Figure label="Net cash movement" value={cash.netMovement} />
          <Figure label="Closing cash" value={cash.closingCash} />
        </div>
        {Math.abs(cash.unclassifiedNet) >= 1 && (
          <p className="text-[10px] text-muted-foreground">
            {formatUGX(Math.abs(cash.unclassifiedNet))} of single-sided historic ledger movement is shown on
            its own line — closing cash still ties to the ledger and the balance sheet.
          </p>
        )}

      </CardContent>
    </Card>
  );
}

function Figure({ label, value }: { label: string; value: number }) {
  return (
    <div>
      <p className="uppercase tracking-wider text-muted-foreground">{label}</p>
      <p className="font-mono text-foreground">{formatUGX(value)}</p>
    </div>
  );
}

function FinancialStatementsPanelInner() {
  const { data, previousData, loading, filters, generate, updatePeriod, setFilters, comparisonMode, updateComparisonMode, comparisonMetrics, loadingComparison } = useFinancialStatements();
  const [customStart, setCustomStart] = useState<Date | undefined>();
  const [customEnd, setCustomEnd] = useState<Date | undefined>();
  const [activeTab, setActiveTab] = useState<Tab>('movement');
  const [sharing, setSharing] = useState(false);
  const contentRef = useRef<HTMLDivElement>(null);

  const [drillLabel, setDrillLabel] = useState<string | null>(null);
  const drillDates = useMemo(
    () => getEffectiveDates(filters.period, filters.startDate, filters.endDate),
    [filters.period, filters.startDate, filters.endDate],
  );
  const drillCtx = useMemo<DrillContextValue>(() => ({ open: setDrillLabel }), []);

  const { data: cashFlow, error: cashFlowError } = useStatementOfCashFlows(drillDates.start, drillDates.end);

  useEffect(() => {
    generate();
  }, []);

  const handleGenerate = async () => {
    try {
      await generate();
      toast.success('Financial statements generated');
    } catch {
      toast.error('Failed to generate statements');
    }
  };

  const handleChangePeriod = (period: StatementPeriod) => {
    if (period === 'custom') {
      setFilters({ period: 'custom', startDate: customStart ? startOfDay(customStart) : null, endDate: customEnd ? endOfDay(customEnd) : null });
      return;
    }
    updatePeriod(period);
  };

  const applyCustomRange = () => {
    if (!customStart || !customEnd) {
      toast.error('Pick both a start and an end date');
      return;
    }
    if (customEnd < customStart) {
      toast.error('End date cannot be before the start date');
      return;
    }
    const next = { period: 'custom' as StatementPeriod, startDate: startOfDay(customStart), endDate: endOfDay(customEnd) };
    setFilters(next);
    generate(next);
  };

  const getTabLabel = () => {
    switch (activeTab) {
      case 'income': return 'Income Statement';
      case 'cashflow': return 'Cash Flow Statement';
      case 'movement': return 'Comprehensive Cash Movement';
      case 'balance': return 'Balance Sheet';
      case 'volume': return 'Facilitated Volume Report';
      case 'budget': return 'Department Budgets & CFO Approval';
    }
  };

  const handleExportCSV = () => {
    if (!data) { toast.error('Generate statements first'); return; }

    const rows: (string | number)[][] = [];
    const period = data.incomeStatement.period;

    if (activeTab === 'income') {
      const d = data.incomeStatement;
      const pnlRows = buildManagementPnl(d, previousData?.incomeStatement);
      rows.push(['WELILE — Management P&L', period, previousData?.incomeStatement.period ?? 'Previous period', '', '']);
      rows.push(['', '', '', '', '']);
      pnlRows.forEach(row => {
        if (row.kind === 'section' || row.kind === 'group') {
          rows.push([row.label.toUpperCase(), '', '', '', '']);
          return;
        }
        const current = row.current ?? 0;
        const previous = row.previous;
        const change = previous === undefined ? '' : current - previous;
        const pct = previous === undefined ? '' : pnlChangePercent(current, previous);
        rows.push([row.label, row.percentage ? `${current.toFixed(1)}%` : current, previous === undefined ? '' : row.percentage ? `${previous.toFixed(1)}%` : previous, change === '' ? '' : row.percentage ? `${Number(change).toFixed(1)} pp` : change, pct === null || pct === '' ? '' : `${Number(pct).toFixed(1)}%`]);
      });
      rows.push(['', '', '', '', '']);
      rows.push(['SUPPORTING SCHEDULE — REVENUE RECOGNITION', '', '', '', '']);
      buildRevenueRecognitionRows(d, previousData?.incomeStatement).forEach(row => {
        const current = row.current ?? 0;
        const previous = row.previous;
        const change = previous === undefined ? '' : current - previous;
        const pct = previous === undefined ? '' : pnlChangePercent(current, previous);
        rows.push([row.label, row.percentage ? `${current.toFixed(1)}%` : current, previous === undefined ? '' : row.percentage ? `${previous.toFixed(1)}%` : previous, change === '' ? '' : row.percentage ? `${Number(change).toFixed(1)} pp` : change, pct === null || pct === '' ? '' : `${Number(pct).toFixed(1)}%`]);
      });
    } else if (activeTab === 'cashflow') {
      if (!cashFlow) { toast.error('Cash flow statement is still loading'); return; }
      rows.push(['WELILE — Statement of Cash Flows', '', period]);
      rows.push(['All amounts in UGX', '', '']);
      rows.push([cashFlow.cash_definition, '', '']);
      rows.push(['', '', '']);
      for (const r of flattenCashFlowStatement(cashFlow)) {
        rows.push([
          r.level === 'line' ? `  ${r.label}` : r.label,
          '',
          r.amount === null ? '' : r.amount,
        ]);
      }
    } else if (activeTab === 'balance') {
      const d = data.balanceSheet;
      rows.push(['WELILE — Balance Sheet', '', period]);
      rows.push(['', '', '']);
      rows.push(['ASSETS', '', '']);
      rows.push(['Platform Cash (Earned Revenue)', '', d.assets.platformCash]);
      rows.push(['User Funds Held in Custody', '', d.assets.userFundsHeld]);
      rows.push(['Rent Receivables (Funded)', '', d.assets.receivables]);
      if (d.assets.rentReceivablesCreated) rows.push(['Rent Receivables Created', '', d.assets.rentReceivablesCreated]);
      rows.push(['Advance Access Fee Receivables', '', d.assets.advanceAccessFeeReceivables]);
      rows.push(['Promissory Notes Receivable', '', d.assets.promissoryNotesReceivable]);
      rows.push(['Total Assets', '', d.assets.totalAssets]);
      rows.push(['', '', '']);
      rows.push(['OBLIGATIONS (LIABILITIES)', '', '']);
      rows.push(['User Wallet Balances (Custody)', '', d.platformObligations.userWalletCustody]);
      rows.push(['Pending Withdrawal Provisions', '', d.platformObligations.pendingWithdrawals]);
      rows.push(['Accrued Platform Rewards', '', d.platformObligations.accruedPlatformRewards]);
      rows.push(['Agent Commissions Payable', '', d.platformObligations.agentCommissionsPayable]);
      if (d.platformObligations.deferredRevenue > 0) rows.push(['Deferred Revenue (Unrecognized Fees)', '', d.platformObligations.deferredRevenue]);
      rows.push(['Total Obligations', '', d.platformObligations.totalObligations]);
      rows.push(['', '', '']);
      rows.push(['PLATFORM EQUITY', '', '']);
      rows.push(['Retained Operating Surplus', '', d.platformEquity.retainedOperatingSurplus]);
      rows.push(['Total Equity', '', d.platformEquity.totalEquity]);
      rows.push(['', '', '']);
      rows.push(['REVENUE RECOGNITION (ASC 606)', '', '']);
      rows.push(['Expected Revenue', '', d.revenueRecognition.expectedRevenue]);
      rows.push(['Realized Revenue', '', d.revenueRecognition.realizedRevenue]);
      rows.push(['Deferred Revenue', '', d.revenueRecognition.deferredRevenue]);
      rows.push(['Recognition Rate (%)', '', d.revenueRecognition.recognitionRate]);
    } else {
      const d = data.facilitatedVolume;
      rows.push(['WELILE — Facilitated Volume Report', '', period]);
      rows.push(['Total Facilitated Rent Volume', '', d.totalFacilitatedRentVolume]);
      rows.push(['Total Rent Requests', '', d.totalRentRequests]);
      rows.push(['Approved Requests', '', d.approvedRequests]);
      rows.push(['Pending Requests', '', d.pendingRequests]);
      rows.push(['Active Tenants', '', d.activeTenants]);
      rows.push(['Active Agents', '', d.activeAgents]);
      rows.push(['Average Rent Amount', '', d.averageRentAmount]);
      rows.push(['Supporter Capital Deployed', '', d.supporterCapitalDeployed]);
      rows.push(['Access Fee Income', '', d.totalAccessFeeIncome]);
      rows.push(['Request Fee Income', '', d.totalRequestFeeIncome]);
    }

    const headers = activeTab === 'income'
      ? ['Account', 'Current Period', 'Previous Period', 'Change', 'Change %']
      : ['Item', 'Sub-item', 'Amount (UGX)'];
    exportToCSV({ headers, rows }, `welile-${activeTab}-${format(new Date(), 'yyyy-MM-dd')}`);
    toast.success('CSV exported');
  };

  const handleExportPDF = async () => {
    if (!data) { toast.error('Generate statements first'); return; }
    setSharing(true);
    try {
      const { jsPDF } = await import('jspdf');
      const pdf = new jsPDF({ orientation: activeTab === 'income' ? 'landscape' : 'portrait', unit: 'mm', format: 'a4' });
      const pw = pdf.internal.pageSize.getWidth();
      const margin = 15;
      let y = 20;

      // Header
      pdf.setFillColor(37, 99, 235);
      pdf.rect(0, 0, pw, 12, 'F');
      pdf.setTextColor(255, 255, 255);
      pdf.setFontSize(10);
      pdf.setFont('helvetica', 'bold');
      pdf.text('WELILE TECHNOLOGIES LIMITED', margin, 8);
      pdf.text('CONFIDENTIAL', pw - margin - 25, 8);

      y = 22;
      pdf.setTextColor(0, 0, 0);
      pdf.setFontSize(16);
      pdf.setFont('helvetica', 'bold');
      pdf.text(getTabLabel(), margin, y);
      y += 7;
      pdf.setFontSize(9);
      pdf.setFont('helvetica', 'normal');
      pdf.setTextColor(100, 100, 100);
      pdf.text(`Period: ${data.incomeStatement.period}`, margin, y);
      pdf.text(`Generated: ${format(data.generatedAt, 'dd MMM yyyy, HH:mm')}`, pw - margin - 60, y);
      y += 6;
      pdf.setDrawColor(220, 220, 220);
      pdf.line(margin, y, pw - margin, y);
      y += 8;

      const addSection = (title: string) => {
        pdf.setFontSize(8);
        pdf.setFont('helvetica', 'bold');
        pdf.setTextColor(37, 99, 235);
        pdf.text(title.toUpperCase(), margin, y);
        y += 5;
        pdf.setTextColor(0, 0, 0);
      };

      const addRow = (label: string, value: number, bold = false, negative = false, indent = false) => {
        if (y > 270) { pdf.addPage(); y = 20; }
        pdf.setFontSize(bold ? 9 : 8);
        pdf.setFont('helvetica', bold ? 'bold' : 'normal');
        pdf.setTextColor(bold ? 0 : 80, bold ? 0 : 80, bold ? 0 : 80);
        pdf.text(label, indent ? margin + 6 : margin, y);
        const valStr = negative && value > 0 ? `(${formatUGX(value)})` : formatUGX(value);
        if (negative && value > 0) pdf.setTextColor(220, 38, 38);
        else if (!negative && value > 0) pdf.setTextColor(22, 163, 74);
        else pdf.setTextColor(0, 0, 0);
        pdf.text(valStr, pw - margin, y, { align: 'right' });
        pdf.setTextColor(0, 0, 0);
        if (bold) { pdf.setDrawColor(200, 200, 200); pdf.line(margin, y + 1, pw - margin, y + 1); }
        y += bold ? 6 : 5;
      };

      if (activeTab === 'income') {
        const d = data.incomeStatement;
        const pnlRows = buildManagementPnl(d, previousData?.incomeStatement);
        const columns = [margin, 128, 174, 220, pw - margin];
        pdf.setFontSize(7);
        pdf.setFont('helvetica', 'bold');
        pdf.setTextColor(90, 90, 90);
        ['ACCOUNT', 'CURRENT PERIOD', 'PREVIOUS PERIOD', 'CHANGE', 'CHANGE %'].forEach((label, index) =>
          pdf.text(label, columns[index], y, { align: index === 0 ? 'left' : 'right' }));
        y += 5;
        pdf.setDrawColor(190, 190, 190);
        pdf.line(margin, y - 3, pw - margin, y - 3);
        pnlRows.forEach(row => {
          if (y > 190) { pdf.addPage(); y = 18; }
          if (row.kind === 'section' || row.kind === 'group') {
            pdf.setFont('helvetica', 'bold');
            pdf.setFontSize(row.kind === 'section' ? 8 : 7);
            pdf.setTextColor(row.kind === 'section' ? 37 : 55, row.kind === 'section' ? 99 : 55, row.kind === 'section' ? 235 : 55);
            pdf.text(row.label.toUpperCase(), margin, y);
            y += row.kind === 'section' ? 6 : 5;
            return;
          }
          const current = row.current ?? 0;
          const previous = row.previous;
          const change = previous === undefined ? undefined : current - previous;
          const pct = previous === undefined ? undefined : pnlChangePercent(current, previous);
          const bold = row.kind === 'highlight' || row.kind === 'subtotal' || row.kind === 'margin';
          pdf.setFont('helvetica', bold ? 'bold' : 'normal');
          pdf.setFontSize(bold ? 7.5 : 7);
          pdf.setTextColor(30, 30, 30);
          pdf.text(row.label, row.kind === 'detail' ? margin + 4 : margin, y);
          const values = [
            row.percentage ? `${current.toFixed(1)}%` : pnlValue(current),
            previous === undefined ? '—' : row.percentage ? `${previous.toFixed(1)}%` : pnlValue(previous),
            change === undefined ? '—' : row.percentage ? `${change.toFixed(1)} pp` : pnlValue(change),
            pct === undefined || pct === null ? '—' : `${pct > 0 ? '+' : ''}${pct.toFixed(1)}%`,
          ];
          values.forEach((value, index) => pdf.text(value, columns[index + 1], y, { align: 'right' }));
          if (row.kind === 'highlight') {
            pdf.setDrawColor(180, 180, 180);
            pdf.line(margin, y + 1.5, pw - margin, y + 1.5);
          }
          y += 5;
        });
        y += 3;
        addSection('Supporting Schedule — Revenue Recognition');
        buildRevenueRecognitionRows(d, previousData?.incomeStatement).forEach(row => {
          const current = row.current ?? 0;
          const previous = row.previous;
          const change = previous === undefined ? undefined : current - previous;
          const pct = previous === undefined ? undefined : pnlChangePercent(current, previous);
          if (y > 190) { pdf.addPage(); y = 18; }
          pdf.setFont('helvetica', row.kind === 'subtotal' || row.kind === 'margin' ? 'bold' : 'normal');
          pdf.setFontSize(7);
          pdf.setTextColor(30, 30, 30);
          pdf.text(row.label, row.kind === 'detail' ? margin + 4 : margin, y);
          const values = [
            row.percentage ? `${current.toFixed(1)}%` : pnlValue(current),
            previous === undefined ? '—' : row.percentage ? `${previous.toFixed(1)}%` : pnlValue(previous),
            change === undefined ? '—' : row.percentage ? `${change.toFixed(1)} pp` : pnlValue(change),
            pct === undefined || pct === null ? '—' : `${pct > 0 ? '+' : ''}${pct.toFixed(1)}%`,
          ];
          values.forEach((value, index) => pdf.text(value, columns[index + 1], y, { align: 'right' }));
          y += 5;
        });
      } else if (activeTab === 'cashflow') {
        if (!cashFlow) { toast.error('Cash flow statement is still loading'); setSharing(false); return; }
        pdf.setFontSize(7);
        pdf.setTextColor(120, 120, 120);
        pdf.text(pdf.splitTextToSize(cashFlow.cash_definition, pw - margin * 2), margin, y);
        y += 8;
        pdf.setTextColor(0, 0, 0);
        for (const r of flattenCashFlowStatement(cashFlow)) {
          if (r.level === 'section') { y += 2; addSection(r.label); continue; }
          if (r.amount === null) {
            if (y > 270) { pdf.addPage(); y = 20; }
            pdf.setFontSize(8);
            pdf.setFont('helvetica', 'bold');
            pdf.setTextColor(0, 0, 0);
            pdf.text(r.label, margin + 3, y);
            y += 5;
            continue;
          }
          addRow(r.label, r.amount, r.level !== 'line', false, r.level === 'line');
        }
      } else if (activeTab === 'balance') {
        const d = data.balanceSheet;
        addSection('Assets');
        addRow('Platform Cash (Earned Revenue)', d.assets.platformCash, false, false, true);
        addRow('User Funds Held in Custody', d.assets.userFundsHeld, false, false, true);
        addRow('Rent Receivables (Funded)', d.assets.receivables, false, false, true);
        addRow('Advance Access Fee Receivables', d.assets.advanceAccessFeeReceivables, false, false, true);
        addRow('Promissory Notes Receivable', d.assets.promissoryNotesReceivable, false, false, true);
        addRow('Total Assets', d.assets.totalAssets, true);
        y += 3;
        addSection('Obligations (Liabilities)');
        addRow('User Wallet Balances (Custody)', d.platformObligations.userWalletCustody, false, true, true);
        addRow('Pending Withdrawal Provisions', d.platformObligations.pendingWithdrawals, false, true, true);
        addRow('Accrued Platform Rewards', d.platformObligations.accruedPlatformRewards, false, true, true);
        addRow('Agent Commissions Payable', d.platformObligations.agentCommissionsPayable, false, true, true);
        if (d.platformObligations.deferredRevenue > 0) {
          addRow('Deferred Revenue (Unrecognized Fees)', d.platformObligations.deferredRevenue, false, true, true);
        }
        addRow('Total Obligations', d.platformObligations.totalObligations, true, true);
        y += 3;
        addSection('Platform Equity');
        addRow('Retained Operating Surplus', d.platformEquity.retainedOperatingSurplus, false, false, true);
        addRow('Total Equity', d.platformEquity.totalEquity, true);
        y += 3;
        addSection('Revenue Recognition (ASC 606)');
        addRow('Expected Revenue', d.revenueRecognition.expectedRevenue, false, false, true);
        addRow('Realized Revenue', d.revenueRecognition.realizedRevenue, false, false, true);
        addRow('Deferred Revenue', d.revenueRecognition.deferredRevenue, false, true, true);
        addRow(`Recognition Rate: ${d.revenueRecognition.recognitionRate.toFixed(1)}%`, 0, false, false, true);
      } else {
        const d = data.facilitatedVolume;
        addSection('Facilitated Volume');
        addRow('Total Facilitated Rent Volume', d.totalFacilitatedRentVolume, true);
        y += 3;
        addSection('Request Activity');
        addRow('Total Rent Requests', d.totalRentRequests);
        addRow('Approved Requests', d.approvedRequests);
        addRow('Pending Requests', d.pendingRequests);
        y += 3;
        addSection('Network Activity');
        addRow('Active Tenants', d.activeTenants);
        addRow('Active Agents', d.activeAgents);
        addRow('Average Rent Amount', d.averageRentAmount);
        y += 3;
        addSection('Capital & Fees');
        addRow('Supporter Capital Deployed', d.supporterCapitalDeployed);
        addRow('Access Fee Income', d.totalAccessFeeIncome);
        addRow('Request Fee Income', d.totalRequestFeeIncome);
      }

      // Footer
      const ph = pdf.internal.pageSize.getHeight();
      pdf.setFillColor(37, 99, 235);
      pdf.rect(0, ph - 8, pw, 8, 'F');
      pdf.setTextColor(255, 255, 255);
      pdf.setFontSize(7);
      pdf.text('Welile Technologies Limited — welile.com — Confidential Financial Report', pw / 2, ph - 3, { align: 'center' });

      const fileName = `welile-${activeTab}-${format(new Date(), 'yyyy-MM-dd')}.pdf`;
      const blob = pdf.output('blob');
      const file = new File([blob], fileName, { type: 'application/pdf' });

      if (navigator.share && navigator.canShare?.({ files: [file] })) {
        await navigator.share({ title: `Welile ${getTabLabel()}`, files: [file] });
        toast.success('Shared successfully!');
      } else {
        pdf.save(fileName);
        toast.success('PDF downloaded!');
      }
    } catch (err: any) {
      if (err?.name !== 'AbortError') { toast.error('PDF export failed'); console.error(err); }
    } finally {
      setSharing(false);
    }
  };

  return (
    <DrillContext.Provider value={drillCtx}>
    <div className="space-y-4">
      {/* Period Selector */}
      <div className="flex flex-wrap gap-2 items-center">
        <Calendar className="h-4 w-4 text-muted-foreground shrink-0" />
        {PERIODS.map(p => (
          <Button
            key={p.value}
            size="sm"
            variant={filters.period === p.value ? 'default' : 'outline'}
            className="text-xs h-7"
            onClick={() => handleChangePeriod(p.value)}
          >
            {p.label}
          </Button>
        ))}
      </div>

      {/* Custom Range Pickers */}
      {filters.period === 'custom' && (
        <div className="flex flex-wrap items-center gap-2">
          <Popover>
            <PopoverTrigger asChild>
              <Button size="sm" variant="outline" className="h-7 text-xs gap-1">
                <Calendar className="h-3.5 w-3.5" />
                {customStart ? format(customStart, 'dd MMM yyyy') : 'Start date'}
              </Button>
            </PopoverTrigger>
            <PopoverContent className="w-auto p-0 z-[200]" align="start">
              <CalendarPicker mode="single" selected={customStart} onSelect={setCustomStart} initialFocus className="p-3 pointer-events-auto" />
            </PopoverContent>
          </Popover>
          <Popover>
            <PopoverTrigger asChild>
              <Button size="sm" variant="outline" className="h-7 text-xs gap-1">
                <Calendar className="h-3.5 w-3.5" />
                {customEnd ? format(customEnd, 'dd MMM yyyy') : 'End date'}
              </Button>
            </PopoverTrigger>
            <PopoverContent className="w-auto p-0 z-[200]" align="start">
              <CalendarPicker mode="single" selected={customEnd} onSelect={setCustomEnd} initialFocus className="p-3 pointer-events-auto" />
            </PopoverContent>
          </Popover>
          <Button size="sm" className="h-7 text-xs" onClick={applyCustomRange} disabled={loading}>
            Apply range
          </Button>
        </div>
      )}

      {/* Comparison Mode Selector */}
      <div className="flex flex-wrap gap-2 items-center">
        <GitCompareArrows className="h-4 w-4 text-muted-foreground shrink-0" />
        {COMPARISON_MODES.map(m => (
          <Button
            key={m.value}
            size="sm"
            variant={comparisonMode === m.value ? 'default' : 'outline'}
            className="text-xs h-7"
            onClick={() => updateComparisonMode(m.value)}
          >
            {m.short}
          </Button>
        ))}
        {loadingComparison && <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />}
      </div>

      {/* Generate Button */}
      <Button
        onClick={handleGenerate}
        disabled={loading}
        className="w-full gap-2"
        size="lg"
      >
        {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
        {loading ? 'Generating Statements…' : data ? 'Regenerate Statements' : 'Generate Financial Statements'}
      </Button>

      {/* Generated Timestamp */}
      {data && (
        <p className="text-xs text-center text-muted-foreground">
          Generated {format(data.generatedAt, 'dd MMM yyyy, HH:mm')} · Period: {data.incomeStatement.period}
        </p>
      )}

      {/* Statement Tabs + Content */}
      {data && (
        <ReconciliationCard r={data.reconciliation} cf={cashFlow} />
      )}

      {(data || activeTab === 'budget') && (
        <Card ref={contentRef}>
          <CardContent className="pt-4 pb-6">
            {/* Tab Switcher */}
            <div className="grid grid-cols-2 gap-2 mb-6">
              {TABS.map(tab => (
                <button
                  key={tab.id}
                  onClick={() => setActiveTab(tab.id)}
                  className={cn(
                    'flex items-center gap-1.5 text-xs font-medium px-3 py-2 rounded-lg border transition-colors',
                    activeTab === tab.id
                      ? 'bg-primary text-primary-foreground border-primary'
                      : 'bg-secondary border-border text-muted-foreground hover:text-foreground hover:border-primary/50'
                  )}
                >
                  {tab.icon}
                  {tab.label}
                </button>
              ))}
            </div>

            {/* Statement Title */}
            <div className="flex items-center justify-between mb-4 pb-3 border-b border-border">
              <h3 className="text-sm font-semibold">{getTabLabel()}</h3>
              <div className="flex items-center gap-2">
                {data && <Badge variant="outline" className="text-xs">{data.incomeStatement.period}</Badge>}
                {data && comparisonMode !== 'none' && comparisonMetrics && (
                  <Badge variant="secondary" className="text-[10px]">
                    vs {COMPARISON_MODES.find(m => m.value === comparisonMode)?.label}
                  </Badge>
                )}
              </div>
            </div>

            {/* Active Statement */}
            {activeTab === 'income' && data && <IncomeStatementSection d={data.incomeStatement} previous={previousData?.incomeStatement} />}
            {activeTab === 'cashflow' && data && <CashFlowSection d={cashFlow} error={cashFlowError} />}
            {activeTab === 'movement' && <ComprehensiveCashMovement />}
            {activeTab === 'balance' && <BalanceSheetPanel />}
            {activeTab === 'volume' && data && <FacilitatedVolumeSection d={data.facilitatedVolume} cm={comparisonMetrics} />}
            {activeTab === 'budget' && <BudgetApprovalPanel />}

            {/* Export Actions */}
            {data && activeTab !== 'balance' && activeTab !== 'budget' && (
            <div className="flex gap-2 mt-6 pt-4 border-t border-border">
              <Button variant="outline" size="sm" className="flex-1 gap-2 text-xs" onClick={handleExportCSV}>
                <FileSpreadsheet className="h-3.5 w-3.5" />
                Export CSV
              </Button>
              <Button variant="outline" size="sm" className="flex-1 gap-2 text-xs" onClick={handleExportPDF} disabled={sharing}>
                {sharing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Download className="h-3.5 w-3.5" />}
                PDF / Share
              </Button>
            </div>
            )}
          </CardContent>
        </Card>
      )}

      {/* Empty state */}
      {!data && !loading && activeTab !== 'budget' && (
        <div className="text-center py-12 text-muted-foreground">
          <FileText className="h-12 w-12 mx-auto mb-3 opacity-30" />
          <p className="text-sm">Select a period and generate statements</p>
          <p className="text-xs mt-1">Data is pulled live from the financial ledger</p>
        </div>
      )}

      <LedgerDrillDownDialog
        open={!!drillLabel}
        onOpenChange={(o) => { if (!o) setDrillLabel(null); }}
        title={drillLabel ?? ''}
        spec={drillLabel ? FS_DRILL_MAP[drillLabel] ?? null : null}
        startDate={drillDates.start}
        endDate={drillDates.end}
        periodLabel={data?.incomeStatement.period}
      />
    </div>
    </DrillContext.Provider>
  );
}
