import { useRef, useState, useEffect, createContext, useContext, useMemo } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { format } from 'date-fns';
import {
  FileText, TrendingUp, Wallet, BarChart3, Download, FileSpreadsheet,
  RefreshCw, Loader2, Calendar, ArrowUpRight, ArrowDownRight, Minus,
  GitCompareArrows, Activity, ClipboardList, ShieldCheck, ChevronDown, ChevronRight,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import { toast } from 'sonner';
import { exportToCSV } from '@/lib/exportUtils';
import { useFinancialStatements, type StatementPeriod, type FinancialStatementsData, type ComparisonMode, type ComparisonMetrics, type DeltaValue, getPreviousPeriodDates, generateStatementsRaw } from '@/hooks/useFinancialStatements';
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
import FinIncomeStatementSection from '@/components/cfo/FinIncomeStatementSection';
import { useFinIncomeStatement, buildFinIncomeRows, convertToFinIncomeStatement } from '@/hooks/useFinIncomeStatement';
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
        {Math.abs(d.unexplained_difference ?? 0) >= 1 && (
          <CashFlowRow
            label="Movement not explained by counterpart entries (not allocated to any activity)"
            value={d.unexplained_difference ?? 0}
          />
        )}
        <div className={cn('flex items-center gap-1.5 pt-1 text-[11px]', d.reconciles ? 'text-success' : 'text-destructive')}>
          {d.reconciles ? <CheckCircle2 className="h-3.5 w-3.5" /> : <AlertTriangle className="h-3.5 w-3.5" />}
          <span>
            {d.reconciles
              ? 'Operating + investing + financing activities explain the whole movement, and closing cash equals the cash accounts on the Balance Sheet.'
              : `The activities explain ${formatUGX(d.explained_net_change ?? d.net_change - d.unreconciled_residual)} of the ${formatUGX(d.net_change)} movement; the rest comes from one-sided or unbalanced ledger entries (${d.unexplained_groups_count ?? 0} groups).`}
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
          <CashFlowRow label="Total Balance Sheet cash accounts" value={d.balance_sheet_cash} weight="group" />
          <CashFlowRow
            label="Difference: closing cash less Balance Sheet cash accounts"
            value={d.closing_cash - d.balance_sheet_cash}
            weight="group"
          />
          <div className={cn('flex items-center gap-1.5 text-[11px]', d.ties_to_balance_sheet ? 'text-success' : 'text-destructive')}>
            {d.ties_to_balance_sheet ? <CheckCircle2 className="h-3.5 w-3.5" /> : <AlertTriangle className="h-3.5 w-3.5" />}
            <span>
              {d.ties_to_balance_sheet
                ? 'Closing cash equals the Balance Sheet cash accounts exactly.'
                : 'Closing cash does not equal the Balance Sheet cash accounts — review the cash account list.'}
            </span>
          </div>
        </div>
        {Math.abs(d.unreconciled_residual) >= 1 && (
          <p className="text-[10px] text-muted-foreground">
            {formatUGX(Math.abs(d.unreconciled_residual))} of the period movement is not explained by the counterpart
            entries (one-sided or unbalanced ledger groups). It is not added to any activity line; the statement data
            lists the groups concerned.
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

type Tab = 'balance' | 'income' | 'cashflow' | 'movement' | 'volume' | 'budget';

const TABS: { id: Tab; label: string; icon: React.ReactNode }[] = [
  { id: 'balance', label: 'Balance Sheet', icon: <FileText className="h-4 w-4" /> },
  { id: 'income', label: 'Income Statement', icon: <TrendingUp className="h-4 w-4" /> },
  { id: 'cashflow', label: 'Cash Flow', icon: <Wallet className="h-4 w-4" /> },
  { id: 'movement', label: 'Cash Movement', icon: <Activity className="h-4 w-4" /> },
  { id: 'volume', label: 'Facilitated Volume', icon: <BarChart3 className="h-4 w-4" /> },
  { id: 'budget', label: 'Department Budgets', icon: <ClipboardList className="h-4 w-4" /> },
];

export function FinancialStatementsPanel() {
  return <FinancialStatementsPanelInner />;
}

/**
 * Executive Reconciliation Banner — proves the financial statements tie back to the ledger.
 * Read-only: every figure comes from the same `general_ledger` rows.
 */
function ReconciliationCard({ r, cf }: { r: import('@/hooks/useFinancialStatements').ReconciliationCheck; cf?: StatementOfCashFlows | null }) {
  const [expanded, setExpanded] = useState(false);
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
    <div className={cn(
      "rounded-lg border px-3 py-2 text-xs transition-colors",
      ok ? "border-emerald-500/30 bg-emerald-500/[0.03]" : "border-amber-500/40 bg-amber-500/[0.04]"
    )}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          {ok ? (
            <ShieldCheck className="h-4 w-4 text-emerald-600 dark:text-emerald-400 shrink-0" />
          ) : (
            <AlertTriangle className="h-4 w-4 text-amber-600 dark:text-amber-400 shrink-0" />
          )}
          <span className="font-semibold text-foreground">
            {ok ? "General Ledger Integrity: Balanced" : "Ledger Audit Gap"}
          </span>
          <span className="text-muted-foreground hidden sm:inline">·</span>
          <span className="text-muted-foreground hidden sm:inline font-mono">
            Assets ({formatUGX(r.totalAssets)}) = Liab + Equity ({formatUGX(r.totalLiabilities + r.totalEquity)})
          </span>
        </div>

        <button
          type="button"
          onClick={() => setExpanded(e => !e)}
          className="text-[11px] font-medium text-primary hover:underline flex items-center gap-1 ml-auto"
        >
          <span>{expanded ? "Hide Breakdown" : "Audit Details"}</span>
          {expanded ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
        </button>
      </div>

      {expanded && (
        <div className="mt-2 pt-2 border-t border-border/40 grid grid-cols-1 sm:grid-cols-3 gap-2 text-[11px]">
          <div className="p-2 rounded bg-background/60 border border-border/50">
            <span className="text-muted-foreground block text-[10px] uppercase tracking-wide">Balance Check</span>
            <span className="font-mono text-foreground font-medium">
              Diff: {formatUGX(r.balanceDifference)}
            </span>
          </div>
          <div className="p-2 rounded bg-background/60 border border-border/50">
            <span className="text-muted-foreground block text-[10px] uppercase tracking-wide">Cash Reconciliation</span>
            <span className="font-mono text-foreground font-medium">
              Closing: {formatUGX(cash.closingCash)} vs BS: {formatUGX(cash.balanceSheetCash)}
            </span>
          </div>
          <div className="p-2 rounded bg-background/60 border border-border/50">
            <span className="text-muted-foreground block text-[10px] uppercase tracking-wide">Net Cash Movement</span>
            <span className="font-mono text-foreground font-medium">
              {formatUGX(cash.netMovement)}
            </span>
          </div>
        </div>
      )}
    </div>
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
  const [activeTab, setActiveTab] = useState<Tab>('balance');
  const [sharing, setSharing] = useState(false);
  const contentRef = useRef<HTMLDivElement>(null);

  const [drillLabel, setDrillLabel] = useState<string | null>(null);
  const drillDates = useMemo(
    () => getEffectiveDates(filters.period, filters.startDate, filters.endDate),
    [filters.period, filters.startDate, filters.endDate],
  );
  const drillCtx = useMemo<DrillContextValue>(() => ({ open: setDrillLabel }), []);

  const { data: cashFlow, error: cashFlowError } = useStatementOfCashFlows(drillDates.start, drillDates.end);
  // The income statements resolve ledger legs the same way the balance sheet does, so running
  // them while the Balance Sheet tab loads makes both compete for the database. Start them the
  // first time the Income tab is opened (and keep them afterwards).
  const [incomeOpened, setIncomeOpened] = useState(activeTab === 'income');
  useEffect(() => { if (activeTab === 'income') setIncomeOpened(true); }, [activeTab]);
  // Income Statement from the revenue and expense accounts (fin_income_statement); replaces the browser P&L.
  const { data: finIncome, error: finIncomeError, loading: finIncomeLoading } = useFinIncomeStatement(drillDates.start, drillDates.end, incomeOpened);

  const comparisonDates = useMemo(() => {
    if (comparisonMode === 'none' || !drillDates.start || !drillDates.end) return null;
    return getPreviousPeriodDates(drillDates.start, drillDates.end, comparisonMode);
  }, [comparisonMode, drillDates.start, drillDates.end]);

  const isComparisonActive = comparisonMode !== 'none' && !!drillDates.start && !!drillDates.end;
  const { data: compFinIncome } = useFinIncomeStatement(
    comparisonDates?.start ?? null,
    comparisonDates?.end ?? null,
    isComparisonActive && incomeOpened
  );

  const [multiYearData, setMultiYearData] = useState<{ label: string; statement: import('@/hooks/useFinIncomeStatement').FinIncomeStatement }[] | null>(null);

  useEffect(() => {
    // Only load multi-year comparison if user is actively viewing the Income Statement
    if (activeTab !== 'income' || multiYearData) return;

    let active = true;
    async function loadYears() {
      try {
        const fetchYear = async (year: number) => {
          try {
            const { data: rpcData, error } = await supabase.rpc('fin_income_statement', {
              p_from: `${year}-01-01T00:00:00+03:00`,
              p_to: `${year}-12-31T23:59:59+03:00`,
            });
            if (!error && rpcData) return rpcData as unknown as import('@/hooks/useFinIncomeStatement').FinIncomeStatement;
          } catch {
            // Fallback to client-side compilation if fin_income_statement RPC is unavailable
          }
          const raw = await generateStatementsRaw({
            period: 'custom',
            startDate: new Date(`${year}-01-01T00:00:00.000Z`),
            endDate: new Date(`${year}-12-31T23:59:59.999Z`),
          });
          return convertToFinIncomeStatement(raw.incomeStatement);
        };

        const [stmt2024, stmt2025, stmt2026] = await Promise.all([
          fetchYear(2024),
          fetchYear(2025),
          fetchYear(2026),
        ]);
        if (!active) return;
        setMultiYearData([
          { label: '2024', statement: stmt2024 },
          { label: '2025', statement: stmt2025 },
          { label: '2026', statement: stmt2026 },
        ]);
      } catch (e) {
        console.warn('Could not load multi-year statements:', e);
      }
    }
    void loadYears();
    return () => { active = false; };
  }, [activeTab, multiYearData]);

  useEffect(() => {
    generate();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

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
      const activeFinIncome = finIncome || (data ? convertToFinIncomeStatement(data.incomeStatement) : null);
      if (!activeFinIncome) { toast.error('Income statement is still loading'); return; }
      rows.push(['WELILE — Income Statement', period, '']);
      rows.push(['All amounts in UGX; revenue and expense accounts of the General Ledger', '', '']);
      rows.push(['', '', '']);
      buildFinIncomeRows(activeFinIncome).forEach(row => {
        rows.push([row.kind === 'section' ? row.label.toUpperCase() : row.kind === 'line' ? `  ${row.label}` : row.label, '', row.amount ?? '']);
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

    const headers = ['Item', 'Sub-item', 'Amount (UGX)'];
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
        const activeFinIncome = finIncome || (data ? convertToFinIncomeStatement(data.incomeStatement) : null);
        if (!activeFinIncome) { toast.error('Income statement is still loading'); setSharing(false); return; }
        pdf.setFontSize(7);
        pdf.setTextColor(120, 120, 120);
        pdf.text('Revenue and expense accounts of the General Ledger (fin_income_statement). All amounts in UGX.', margin, y);
        y += 6;
        buildFinIncomeRows(activeFinIncome).forEach(row => {
          if (y > 190) { pdf.addPage(); y = 18; }
          const strong = row.kind !== 'line';
          pdf.setFont('helvetica', strong ? 'bold' : 'normal');
          pdf.setFontSize(row.kind === 'section' ? 8 : 7);
          pdf.setTextColor(30, 30, 30);
          pdf.text(row.kind === 'section' ? row.label.toUpperCase() : row.label, row.kind === 'line' ? margin + 4 : margin, y);
          if (row.amount !== null) pdf.text(pnlValue(row.amount), pw - margin, y, { align: 'right' });
          y += row.kind === 'section' ? 6 : 5;
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
    } catch (err: unknown) {
      if ((err as Error)?.name !== 'AbortError') { toast.error('PDF export failed'); console.error(err); }
    } finally {
      setSharing(false);
    }
  };

  return (
    <DrillContext.Provider value={drillCtx}>
    <div className="space-y-4">
      {/* 1. Institutional CFO Page Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 pb-1">
        <div>
          <div className="flex items-center gap-2.5">
            <h1 className="text-xl font-bold tracking-tight text-foreground">
              Financial Statements
            </h1>
            <Badge variant="outline" className="text-[10px] font-mono border-primary/30 bg-primary/5 text-primary">
              CFO Office
            </Badge>
          </div>
          <p className="text-xs text-muted-foreground mt-0.5">
            Consolidated general ledger financial reports, balance sheet positions, and statutory disclosures.
          </p>
        </div>

        {/* Global Export for Income / Cashflow / Volume when applicable */}
        {activeTab !== 'balance' && activeTab !== 'budget' && activeTab !== 'movement' && data && (
          <div className="flex items-center gap-2 shrink-0">
            <Button
              size="sm"
              variant="outline"
              onClick={handleExportCSV}
              className="h-8 text-xs gap-1.5 shadow-xs"
            >
              <Download className="h-3.5 w-3.5 text-muted-foreground" />
              CSV
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={handleExportPDF}
              disabled={sharing}
              className="h-8 text-xs gap-1.5 shadow-xs"
            >
              {sharing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <FileSpreadsheet className="h-3.5 w-3.5 text-muted-foreground" />}
              PDF
            </Button>
          </div>
        )}
      </div>

      {/* 2. Top-Level Sleek Tab Navigation (Institutional Style) */}
      <div className="border-b border-border">
        <nav className="flex space-x-1 sm:space-x-3 overflow-x-auto scrollbar-none" aria-label="Statements">
          {TABS.map(tab => {
            const isActive = activeTab === tab.id;
            return (
              <button
                key={tab.id}
                type="button"
                onClick={() => setActiveTab(tab.id)}
                className={cn(
                  "flex items-center gap-2 py-2.5 px-3 border-b-2 text-xs whitespace-nowrap transition-all font-medium",
                  isActive
                    ? "border-primary text-primary font-semibold"
                    : "border-transparent text-muted-foreground hover:text-foreground hover:border-border"
                )}
              >
                {tab.icon}
                <span>{tab.label}</span>
              </button>
            );
          })}
        </nav>
      </div>

      {/* 3. Reconciliation Strip (Compact Audit Confirmation) */}
      {data && activeTab !== 'movement' && activeTab !== 'budget' && (
        <ReconciliationCard r={data.reconciliation} cf={cashFlow} />
      )}

      {/* 4. Statement-Specific Period Controls (Only for statements that use the period model) */}
      {(activeTab === 'income' || activeTab === 'cashflow' || activeTab === 'volume') && (
        <div className="flex flex-wrap items-center justify-between gap-3 p-2.5 rounded-xl border border-border bg-card shadow-xs">
          {/* Period selector */}
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground mr-1 flex items-center gap-1">
              <Calendar className="h-3.5 w-3.5 text-primary" />
              Period:
            </span>
            <div className="inline-flex p-0.5 rounded-lg bg-muted/60 border border-border/50 gap-0.5">
              {PERIODS.map(p => (
                <button
                  key={p.value}
                  type="button"
                  onClick={() => handleChangePeriod(p.value)}
                  className={cn(
                    "px-2.5 py-1 text-xs font-medium rounded-md transition-all",
                    filters.period === p.value
                      ? "bg-background text-foreground shadow-xs font-semibold"
                      : "text-muted-foreground hover:text-foreground"
                  )}
                >
                  {p.label}
                </button>
              ))}
            </div>
          </div>

          {/* Comparison Mode & Refresh */}
          <div className="flex flex-wrap items-center gap-2">
            <div className="flex items-center gap-1">
              <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground mr-1">
                Compare:
              </span>
              <div className="inline-flex p-0.5 rounded-lg bg-muted/60 border border-border/50 gap-0.5">
                {COMPARISON_MODES.map(m => (
                  <button
                    key={m.value}
                    type="button"
                    onClick={() => updateComparisonMode(m.value)}
                    className={cn(
                      "px-2 py-1 text-xs font-medium rounded-md transition-all",
                      comparisonMode === m.value
                        ? "bg-background text-foreground shadow-xs font-semibold"
                        : "text-muted-foreground hover:text-foreground"
                    )}
                  >
                    {m.short}
                  </button>
                ))}
              </div>
              {loadingComparison && <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground ml-1" />}
            </div>

            <Button
              onClick={handleGenerate}
              disabled={loading}
              size="sm"
              className="h-8 text-xs font-medium gap-1.5 shadow-xs"
            >
              {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
              {loading ? "Compiling…" : data ? "Refresh" : "Generate Statements"}
            </Button>
          </div>

          {/* Custom Date Range Popovers if Custom is active */}
          {filters.period === 'custom' && (
            <div className="w-full flex flex-wrap items-center gap-2 pt-2 border-t border-border/40">
              <span className="text-xs text-muted-foreground font-medium">Custom Window:</span>
              <Popover>
                <PopoverTrigger asChild>
                  <Button size="sm" variant="outline" className="h-7 text-xs gap-1.5">
                    <Calendar className="h-3 w-3 text-primary" />
                    {customStart ? format(customStart, 'dd MMM yyyy') : 'Start date'}
                  </Button>
                </PopoverTrigger>
                <PopoverContent className="w-auto p-0 z-[200]" align="start">
                  <CalendarPicker mode="single" selected={customStart} onSelect={setCustomStart} initialFocus className="p-3 pointer-events-auto" />
                </PopoverContent>
              </Popover>
              <span className="text-muted-foreground text-xs">→</span>
              <Popover>
                <PopoverTrigger asChild>
                  <Button size="sm" variant="outline" className="h-7 text-xs gap-1.5">
                    <Calendar className="h-3 w-3 text-primary" />
                    {customEnd ? format(customEnd, 'dd MMM yyyy') : 'End date'}
                  </Button>
                </PopoverTrigger>
                <PopoverContent className="w-auto p-0 z-[200]" align="start">
                  <CalendarPicker mode="single" selected={customEnd} onSelect={setCustomEnd} initialFocus className="p-3 pointer-events-auto" />
                </PopoverContent>
              </Popover>
              <Button size="sm" className="h-7 text-xs" onClick={applyCustomRange} disabled={loading}>
                Apply Window
              </Button>
            </div>
          )}
        </div>
      )}

      {/* 5. Statement Body Area */}
      <div ref={contentRef} className="pt-1">
        {activeTab === 'balance' && <BalanceSheetPanel />}

        {activeTab === 'income' && (
          <FinIncomeStatementSection
            d={finIncome}
            error={finIncomeError}
            fallbackD={data?.incomeStatement}
            fallbackComparisonD={previousData?.incomeStatement}
            comparisonD={comparisonMode !== 'none' ? compFinIncome : null}
            comparisonLabel={comparisonMode !== 'none' ? COMPARISON_MODES.find(m => m.value === comparisonMode)?.short : undefined}
            multiYearColumns={multiYearData ?? undefined}
          />
        )}

        {activeTab === 'cashflow' && (
          data ? (
            <CashFlowSection d={cashFlow} error={cashFlowError} />
          ) : (
            <div className="rounded-xl border border-dashed border-border p-12 text-center text-muted-foreground">
              <Wallet className="h-10 w-10 mx-auto mb-2 opacity-30" />
              <p className="text-sm font-medium text-foreground">Cash Flow Statement</p>
              <p className="text-xs text-muted-foreground mt-1 mb-4">Click below to generate the statement from general ledger cash accounts.</p>
              <Button size="sm" onClick={handleGenerate} disabled={loading}>
                {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin mr-1.5" /> : <RefreshCw className="h-3.5 w-3.5 mr-1.5" />}
                Generate Statement
              </Button>
            </div>
          )
        )}

        {activeTab === 'movement' && <ComprehensiveCashMovement />}

        {activeTab === 'volume' && (
          data ? (
            <FacilitatedVolumeSection d={data.facilitatedVolume} cm={comparisonMetrics} />
          ) : (
            <div className="rounded-xl border border-dashed border-border p-12 text-center text-muted-foreground">
              <BarChart3 className="h-10 w-10 mx-auto mb-2 opacity-30" />
              <p className="text-sm font-medium text-foreground">Facilitated Volume</p>
              <p className="text-xs text-muted-foreground mt-1 mb-4">Click below to compile facilitated volume metrics from active Rent Plans.</p>
              <Button size="sm" onClick={handleGenerate} disabled={loading}>
                {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin mr-1.5" /> : <RefreshCw className="h-3.5 w-3.5 mr-1.5" />}
                Generate Metrics
              </Button>
            </div>
          )
        )}

        {activeTab === 'budget' && <BudgetApprovalPanel />}
      </div>

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
