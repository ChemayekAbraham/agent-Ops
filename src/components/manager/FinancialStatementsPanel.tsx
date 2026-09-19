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
  { value: 'none', label: 'No Comparison', short: 'Off' },
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

function IncomeStatementSection({ d, cm }: { d: FinancialStatementsData['incomeStatement']; cm?: ComparisonMetrics | null }) {
  const bs = d.byService;
  const totals = incomeStatementTotals(d);
  return (
    <div className="space-y-1">
      <SectionHeader>Revenue</SectionHeader>
      <p className="text-[10px] text-muted-foreground pl-4 -mt-1 mb-1">
        Revenue from approved ledger transactions, grouped by Welile service.
      </p>
      {bs.revenueFamilies.length === 0 && (
        <p className="text-xs text-muted-foreground pl-4">No service revenue recorded for this period.</p>
      )}
      {bs.revenueFamilies.map(fam => (
        <div key={fam.key} className="mb-1">
          <p className="text-[11px] font-medium pl-2 mt-2">{fam.label}</p>
          {fam.lines.map(l => (
            <div key={l.source} className="flex justify-between items-center text-sm pl-6" title={`Ledger source: ${l.source}`}>
              <span className="text-muted-foreground">{l.label}</span>
              <span className="font-mono text-success">{formatUGX(l.amount)}</span>
            </div>
          ))}
          <div className="flex justify-between items-center text-xs pl-4 pr-0 font-medium border-t border-border/40 pt-1 mt-1">
            <span>{fam.label} — Subtotal</span>
            <span className="font-mono">{formatUGX(fam.total)}</span>
          </div>
        </div>
      ))}
      <LineItem label="Gross Revenue" value={bs.grossRevenue} bold />
      {bs.contraRevenue.lines.length > 0 && (
        <>
          <SectionHeader>Revenue Deductions</SectionHeader>
          {bs.contraRevenue.lines.map(l => (
            <div key={l.source} className="flex justify-between items-center text-sm pl-6" title={`Ledger source: ${l.source}`}>
              <span className="text-muted-foreground">{l.label}</span>
              <span className="font-mono text-destructive">({formatUGX(l.amount)})</span>
            </div>
          ))}
          <LineItem label="Total Revenue Deductions" value={bs.contraRevenue.total} negative bold />
        </>
      )}
      <LineItem label="Net Revenue" value={totals.netRevenue} bold />

      {bs.reviewQueue.length > 0 && (
        <div className="mt-3 p-3 rounded-lg border border-warning/30 bg-warning/5">
          <p className="text-xs font-semibold text-warning uppercase tracking-wider mb-1">Flagged for review — unmapped ledger categories</p>
          <p className="text-[10px] text-muted-foreground mb-2">
            These approved ledger entries do not map to an existing service or accounting category. They are excluded from the totals above until classified.
          </p>
          {bs.reviewQueue.map(l => (
            <div key={`${l.category}-${l.direction}`} className="flex justify-between items-center text-xs">
              <span className="text-muted-foreground">{l.category} · {l.direction === 'cash_in' ? 'in' : 'out'}</span>
              <span className="font-mono">{formatUGX(l.amount)}</span>
            </div>
          ))}
        </div>
      )}

      <SectionHeader>Cost of Revenue</SectionHeader>
      <LineItem label="Platform Rewards (Supporters)" value={d.serviceDeliveryCosts.platformRewards} negative indent />
      <LineItem label="Agent Commissions" value={d.serviceDeliveryCosts.agentCommissions} negative indent />
      <LineItem label="Referral Bonuses" value={d.serviceDeliveryCosts.referralBonuses} negative indent />
      <LineItem label="Agent Bonuses" value={d.serviceDeliveryCosts.agentBonuses} negative indent />
      <LineItem label="Transaction Expenses" value={d.serviceDeliveryCosts.transactionExpenses} negative indent />
      <LineItem label="Total Cost of Revenue" value={d.serviceDeliveryCosts.total} negative bold delta={cm?.totalServiceCosts} />

      <div className={cn(
        'flex justify-between items-center font-semibold pt-2 mt-1 border-t border-primary/20',
        totals.grossProfit >= 0 ? 'text-success' : 'text-destructive'
      )}>
        <span className="flex items-center">Gross Profit{cm && <DeltaBadge delta={cm.grossProfit} />}</span>
        <span className="font-mono">{formatUGX(totals.grossProfit)}</span>
      </div>
      <div className="flex justify-between items-center text-xs pl-4 pr-2">
        <span className="text-muted-foreground">Gross Margin</span>
        <span className="font-mono text-muted-foreground">{totals.grossMargin.toFixed(1)}%</span>
      </div>

      <SectionHeader>Operating Expenses</SectionHeader>
      <LineItem label="Payroll & Staff Costs" value={d.operatingExpenses.payrollExpenses} negative indent />
      <LineItem label="Agent Requisitions" value={d.operatingExpenses.agentRequisitions} negative indent />
      <LineItem label="Financial Agent Expenses" value={d.operatingExpenses.financialAgentExpenses} negative indent />
      <LineItem label="Marketing Expenses" value={d.operatingExpenses.marketingExpenses} negative indent />
      <LineItem label="Research & Development" value={d.operatingExpenses.researchDevelopment} negative indent />
      {(d.operatingExpenses.operationalSubcategories.salaries > 0 ||
        d.operatingExpenses.operationalSubcategories.transport > 0 ||
        d.operatingExpenses.operationalSubcategories.food > 0 ||
        d.operatingExpenses.operationalSubcategories.officeRent > 0 ||
        d.operatingExpenses.operationalSubcategories.internet > 0 ||
        d.operatingExpenses.operationalSubcategories.airtime > 0 ||
        d.operatingExpenses.operationalSubcategories.stationery > 0) && (
        <>
          <p className="text-[10px] text-muted-foreground pl-4 mt-1 font-medium">Operational Breakdown:</p>
          {d.operatingExpenses.operationalSubcategories.salaries > 0 && <LineItem label="  Salaries" value={d.operatingExpenses.operationalSubcategories.salaries} negative indent />}
          {d.operatingExpenses.operationalSubcategories.transport > 0 && <LineItem label="  Transport" value={d.operatingExpenses.operationalSubcategories.transport} negative indent />}
          {d.operatingExpenses.operationalSubcategories.food > 0 && <LineItem label="  Food" value={d.operatingExpenses.operationalSubcategories.food} negative indent />}
          {d.operatingExpenses.operationalSubcategories.officeRent > 0 && <LineItem label="  Office Rent" value={d.operatingExpenses.operationalSubcategories.officeRent} negative indent />}
          {d.operatingExpenses.operationalSubcategories.internet > 0 && <LineItem label="  Internet" value={d.operatingExpenses.operationalSubcategories.internet} negative indent />}
          {d.operatingExpenses.operationalSubcategories.airtime > 0 && <LineItem label="  Airtime" value={d.operatingExpenses.operationalSubcategories.airtime} negative indent />}
          {d.operatingExpenses.operationalSubcategories.stationery > 0 && <LineItem label="  Stationery" value={d.operatingExpenses.operationalSubcategories.stationery} negative indent />}
        </>
      )}
      <LineItem label="General & Admin Expenses" value={d.operatingExpenses.generalOperating} negative indent />
      <LineItem label="Total Operating Expenses" value={d.operatingExpenses.total} negative bold delta={cm?.totalOperatingExpenses} />

      {/* Adjustments are a component of Operating Income below, so they are
          presented here rather than after Net Income, where they read as a
          footnote to a figure they had already changed. */}
      {(d.adjustments.walletDeductions > 0 || d.adjustments.systemCorrections > 0 || d.adjustments.orphanReassignments > 0 || d.adjustments.orphanReversals > 0) && (
        <>
          <SectionHeader>Adjustments & Corrections</SectionHeader>
          {d.adjustments.walletDeductions > 0 && <LineItem label="Wallet Deductions (Recoveries)" value={d.adjustments.walletDeductions} indent />}
          {d.adjustments.systemCorrections > 0 && <LineItem label="System Balance Corrections" value={d.adjustments.systemCorrections} indent />}
          {d.adjustments.orphanReassignments > 0 && <LineItem label="Orphan Reassignments" value={d.adjustments.orphanReassignments} indent />}
          {d.adjustments.orphanReversals > 0 && <LineItem label="Orphan Reversals" value={d.adjustments.orphanReversals} negative indent />}
          <LineItem label="Net Adjustments" value={d.adjustments.total} bold />
        </>
      )}

      <div className="mt-2 p-3 rounded-lg bg-primary/5 border border-primary/20">
        <div className="flex justify-between items-center font-bold">
          <span className="flex items-center text-primary">EBITDA{cm && <DeltaBadge delta={cm.ebitda} />}</span>
          <span className="font-mono text-primary">{formatUGX(totals.ebitda)}</span>
        </div>
        <div className="flex justify-between items-center text-xs mt-1">
          <span className="text-muted-foreground">EBITDA Margin</span>
          <span className="font-mono text-muted-foreground">{totals.ebitdaMargin.toFixed(1)}%</span>
        </div>
      </div>

      <SectionHeader>Depreciation &amp; Amortization</SectionHeader>
      <LineItem label="Depreciation (Property & Equipment)" value={d.depreciation} negative indent />
      <LineItem label="Amortization (Software & IP)" value={d.amortization} negative indent />

      <div className={cn(
        'flex justify-between items-center font-semibold pt-2 mt-1 border-t border-primary/20',
        totals.operatingIncome >= 0 ? 'text-success' : 'text-destructive'
      )}>
        <span className="flex items-center">Operating Profit / (Loss) (EBIT){cm && <DeltaBadge delta={cm.operatingIncome} />}</span>
        <span className="font-mono">{formatUGX(totals.operatingIncome)}</span>
      </div>
      <div className="flex justify-between items-center text-xs pl-4 pr-2">
        <span className="text-muted-foreground">Operating Margin</span>
        <span className="font-mono text-muted-foreground">{totals.operatingMargin.toFixed(1)}%</span>
      </div>

      <SectionHeader>Finance Income / (Costs)</SectionHeader>
      <LineItem label="Finance Income" value={d.interestIncome} indent />
      <LineItem label="Interest Expense" value={d.interestExpense} negative indent />
      <LineItem label="Net Finance Income / (Costs)" value={d.otherIncomeExpensesNet} bold />

      <div className={cn(
        'flex justify-between items-center font-semibold pt-2 mt-1 border-t border-primary/20',
        totals.profitBeforeTax >= 0 ? 'text-success' : 'text-destructive'
      )}>
        <span>Profit / (Loss) Before Tax</span>
        <span className="font-mono">{formatUGX(totals.profitBeforeTax)}</span>
      </div>

      <SectionHeader>Tax</SectionHeader>
      <LineItem label="Tax Provision" value={d.taxProvision} negative indent />


      <div className={cn(
        'flex justify-between items-center text-base font-bold pt-3 border-t-2 border-primary/30 mt-2',
        totals.netIncome >= 0 ? 'text-success' : 'text-destructive'
      )}>
        <span className="flex items-center">Net Income{cm && <DeltaBadge delta={cm.netOperatingIncome} />}</span>
        <span className="font-mono">{formatUGX(totals.netIncome)}</span>
      </div>

      <div className="mt-6 pt-3 border-t border-border">
        <SectionHeader>Supporting Schedule — Revenue Recognition</SectionHeader>
        <p className="text-[10px] text-muted-foreground pl-4 -mt-1 mb-1">Expected revenue from active Rent Plans compared with ledger-confirmed collections.</p>
        <LineItem label="Expected Access Fees" value={d.revenueRecognition.expectedAccessFees} indent />
        <LineItem label="Expected Request Fees" value={d.revenueRecognition.expectedRequestFees} indent />
        <LineItem label="Total Expected Revenue" value={d.revenueRecognition.totalExpectedRevenue} bold />
        <LineItem label="Realized Access Fees" value={d.revenueRecognition.realizedAccessFees} indent />
        <LineItem label="Realized Request Fees" value={d.revenueRecognition.realizedRequestFees} indent />
        <LineItem label="Total Realized Revenue" value={d.revenueRecognition.totalRealizedRevenue} bold />
        <LineItem label="Revenue Not Yet Collected" value={d.revenueRecognition.deferredRevenue} indent />
        <div className="flex justify-between items-center text-xs pl-4 pr-2">
          <span className="text-muted-foreground">Recognition Rate</span>
          <span className="font-mono text-muted-foreground">{d.revenueRecognition.recognitionRate.toFixed(1)}%</span>
        </div>
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
  const { data, loading, filters, generate, updatePeriod, setFilters, comparisonMode, updateComparisonMode, comparisonMetrics, loadingComparison } = useFinancialStatements();
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
      rows.push(['WELILE — Income Statement', '', period]);
      rows.push(['', '', '']);
      rows.push(['REVENUE BY WELILE SERVICE', '', '']);
      d.byService.revenueFamilies.forEach(fam => {
        rows.push([fam.label, '', '']);
        fam.lines.forEach(l => rows.push([`  ${l.label}`, l.source, l.amount]));
        rows.push([`  ${fam.label} Subtotal`, '', fam.total]);
      });
      rows.push(['Total Revenue (Services)', '', d.byService.totalRevenue]);
      rows.push(['', '', '']);
      rows.push(['MARKETING EXPENSES', '', '']);
      d.byService.marketing.lines.forEach(l => rows.push([`  ${l.label}`, l.source, -l.amount]));
      rows.push(['Total Marketing Expenses', '', -d.byService.totalMarketingExpenses]);
      rows.push(['', '', '']);
      rows.push(['OPERATING EXPENSES', '', '']);
      d.byService.operating.lines.forEach(l => rows.push([`  ${l.label}`, l.source, -l.amount]));
      rows.push(['Total Operating Expenses', '', -d.byService.totalOperatingExpenses]);
      rows.push(['Net Profit/(Loss)', '', d.byService.netProfit]);
      if (d.byService.reviewQueue.length > 0) {
        rows.push(['', '', '']);
        rows.push(['FLAGGED FOR REVIEW (UNMAPPED CATEGORIES)', '', '']);
        d.byService.reviewQueue.forEach(l => rows.push([`  ${l.category}`, l.direction, l.amount]));
      }
      rows.push(['', '', '']);
      rows.push(['REVENUE RECOGNITION', '', '']);
      rows.push(['Expected Access Fees', '', d.revenueRecognition.expectedAccessFees]);
      rows.push(['Expected Request Fees', '', d.revenueRecognition.expectedRequestFees]);
      rows.push(['Total Expected Revenue', '', d.revenueRecognition.totalExpectedRevenue]);
      rows.push(['Realized Access Fees', '', d.revenueRecognition.realizedAccessFees]);
      rows.push(['Realized Request Fees', '', d.revenueRecognition.realizedRequestFees]);
      rows.push(['Total Realized Revenue', '', d.revenueRecognition.totalRealizedRevenue]);
      rows.push(['Deferred Revenue', '', d.revenueRecognition.deferredRevenue]);
      rows.push(['Recognition Rate (%)', '', d.revenueRecognition.recognitionRate.toFixed(1)]);
      rows.push(['', '', '']);
      rows.push(['REALIZED REVENUE (LEDGER)', '', '']);
      rows.push(['Access Fees', '', d.revenue.accessFees]);
      rows.push(['Request Fees', '', d.revenue.requestFees]);
      rows.push(['Other Service Income', '', d.revenue.otherServiceIncome]);
      rows.push(['Advance Access Fees Collected', '', d.revenue.advanceAccessFeesCollected]);
      rows.push(['Total Revenue', '', d.revenue.total]);
      rows.push(['', '', '']);
      rows.push(['SERVICE DELIVERY COSTS', '', '']);
      rows.push(['Platform Rewards', '', -d.serviceDeliveryCosts.platformRewards]);
      rows.push(['Agent Commissions', '', -d.serviceDeliveryCosts.agentCommissions]);
      rows.push(['Referral Bonuses', '', -d.serviceDeliveryCosts.referralBonuses]);
      rows.push(['Agent Bonuses', '', -d.serviceDeliveryCosts.agentBonuses]);
      rows.push(['Transaction Expenses', '', -d.serviceDeliveryCosts.transactionExpenses]);
      rows.push(['Total Service Costs', '', -d.serviceDeliveryCosts.total]);
      rows.push(['Payroll & Staff Costs', '', -d.operatingExpenses.payrollExpenses]);
      rows.push(['Agent Requisitions', '', -d.operatingExpenses.agentRequisitions]);
      rows.push(['Financial Agent Expenses', '', -d.operatingExpenses.financialAgentExpenses]);
      rows.push(['Marketing Expenses', '', -d.operatingExpenses.marketingExpenses]);
      rows.push(['Research & Development', '', -d.operatingExpenses.researchDevelopment]);
      rows.push(['Tax Expense', '', -d.operatingExpenses.taxExpense]);
      rows.push(['Interest Expense', '', -d.operatingExpenses.interestExpense]);
      rows.push(['Equipment & Depreciation', '', -d.operatingExpenses.equipmentExpense]);
      if (d.operatingExpenses.operationalSubcategories.salaries) rows.push(['  Salaries', '', -d.operatingExpenses.operationalSubcategories.salaries]);
      if (d.operatingExpenses.operationalSubcategories.transport) rows.push(['  Transport', '', -d.operatingExpenses.operationalSubcategories.transport]);
      if (d.operatingExpenses.operationalSubcategories.food) rows.push(['  Food', '', -d.operatingExpenses.operationalSubcategories.food]);
      if (d.operatingExpenses.operationalSubcategories.officeRent) rows.push(['  Office Rent', '', -d.operatingExpenses.operationalSubcategories.officeRent]);
      if (d.operatingExpenses.operationalSubcategories.internet) rows.push(['  Internet', '', -d.operatingExpenses.operationalSubcategories.internet]);
      if (d.operatingExpenses.operationalSubcategories.airtime) rows.push(['  Airtime', '', -d.operatingExpenses.operationalSubcategories.airtime]);
      if (d.operatingExpenses.operationalSubcategories.stationery) rows.push(['  Stationery', '', -d.operatingExpenses.operationalSubcategories.stationery]);
      if (d.operatingExpenses.operationalSubcategories.propertyEquipment) rows.push(['  Property & Equipment', '', -d.operatingExpenses.operationalSubcategories.propertyEquipment]);
      if (d.operatingExpenses.operationalSubcategories.taxes) rows.push(['  Taxes (legacy)', '', -d.operatingExpenses.operationalSubcategories.taxes]);
      if (d.operatingExpenses.operationalSubcategories.interests) rows.push(['  Interests (legacy)', '', -d.operatingExpenses.operationalSubcategories.interests]);
      rows.push(['General & Admin Expenses', '', -d.operatingExpenses.generalOperating]);
      rows.push(['Total Operating Expenses', '', -d.operatingExpenses.total]);
      rows.push(['', '', '']);
      rows.push(['ADJUSTMENTS & CORRECTIONS', '', '']);
      if (d.adjustments.walletDeductions) rows.push(['Wallet Deductions (Recoveries)', '', d.adjustments.walletDeductions]);
      if (d.adjustments.systemCorrections) rows.push(['System Balance Corrections', '', d.adjustments.systemCorrections]);
      if (d.adjustments.orphanReassignments) rows.push(['Orphan Reassignments', '', d.adjustments.orphanReassignments]);
      if (d.adjustments.orphanReversals) rows.push(['Orphan Reversals', '', -d.adjustments.orphanReversals]);
      rows.push(['Net Adjustments', '', d.adjustments.total]);
      rows.push(['NET OPERATING INCOME', '', d.netOperatingIncome]);
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

    exportToCSV({ headers: ['Item', 'Sub-item', 'Amount (UGX)'], rows }, `welile-${activeTab}-${format(new Date(), 'yyyy-MM-dd')}`);
    toast.success('CSV exported');
  };

  const handleExportPDF = async () => {
    if (!data) { toast.error('Generate statements first'); return; }
    setSharing(true);
    try {
      const { jsPDF } = await import('jspdf');
      const pdf = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });
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
        addSection('Revenue by Welile Service');
        d.byService.revenueFamilies.forEach(fam => {
          addSection(fam.label);
          fam.lines.forEach(l => addRow(l.label, l.amount, false, false, true));
          addRow(`${fam.label} Subtotal`, fam.total, true);
        });
        addRow('Total Revenue (Services)', d.byService.totalRevenue, true);
        y += 3;
        addSection('Marketing Expenses');
        d.byService.marketing.lines.forEach(l => addRow(l.label, l.amount, false, true, true));
        addRow('Total Marketing Expenses', d.byService.totalMarketingExpenses, true, true);
        y += 3;
        addSection('Operating Expenses');
        d.byService.operating.lines.forEach(l => addRow(l.label, l.amount, false, true, true));
        addRow('Total Operating Expenses', d.byService.totalOperatingExpenses, true, true);
        addRow('Net Profit/(Loss)', d.byService.netProfit, true, d.byService.netProfit < 0);
        if (d.byService.reviewQueue.length > 0) {
          y += 3;
          addSection('Flagged for Review (Unmapped Categories)');
          d.byService.reviewQueue.forEach(l => addRow(`${l.category} (${l.direction})`, l.amount, false, false, true));
        }
        y += 3;
        addSection('Revenue Recognition');
        addRow('Expected Access Fees', d.revenueRecognition.expectedAccessFees, false, false, true);
        addRow('Expected Request Fees', d.revenueRecognition.expectedRequestFees, false, false, true);
        addRow('Total Expected Revenue', d.revenueRecognition.totalExpectedRevenue, true);
        addRow('Realized Access Fees', d.revenueRecognition.realizedAccessFees, false, false, true);
        addRow('Realized Request Fees', d.revenueRecognition.realizedRequestFees, false, false, true);
        addRow('Total Realized Revenue', d.revenueRecognition.totalRealizedRevenue, true);
        addRow('Deferred Revenue', d.revenueRecognition.deferredRevenue, true, false, true);
        y += 3;
        addSection('Realized Revenue (Ledger-Confirmed)');
        addRow('Tenant Access Fees', d.revenue.accessFees, false, false, true);
        addRow('Tenant Request Fees', d.revenue.requestFees, false, false, true);
        addRow('Other Service Income', d.revenue.otherServiceIncome, false, false, true);
        addRow('Total Revenue', d.revenue.total, true);
        y += 3;
        addSection('Service Delivery Costs');
        addRow('Platform Rewards', d.serviceDeliveryCosts.platformRewards, false, true, true);
        addRow('Agent Commissions', d.serviceDeliveryCosts.agentCommissions, false, true, true);
        addRow('Referral Bonuses', d.serviceDeliveryCosts.referralBonuses, false, true, true);
        addRow('Agent Bonuses', d.serviceDeliveryCosts.agentBonuses, false, true, true);
        addRow('Transaction Expenses', d.serviceDeliveryCosts.transactionExpenses, false, true, true);
        addRow('Total Service Costs', d.serviceDeliveryCosts.total, true, true);
        y += 3;
        addSection('Operating Expenses');
        addRow('Payroll & Staff Costs', d.operatingExpenses.payrollExpenses, false, true, true);
        addRow('Agent Requisitions', d.operatingExpenses.agentRequisitions, false, true, true);
        addRow('Financial Agent Expenses', d.operatingExpenses.financialAgentExpenses, false, true, true);
        addRow('Marketing Expenses', d.operatingExpenses.marketingExpenses, false, true, true);
        addRow('Research & Development', d.operatingExpenses.researchDevelopment, false, true, true);
        addRow('Tax Expense', d.operatingExpenses.taxExpense, false, true, true);
        addRow('Interest Expense', d.operatingExpenses.interestExpense, false, true, true);
        addRow('Equipment & Depreciation', d.operatingExpenses.equipmentExpense, false, true, true);
        addRow('General & Admin', d.operatingExpenses.generalOperating, false, true, true);
        addRow('Total Operating Expenses', d.operatingExpenses.total, true, true);
        y += 3;
        pdf.setFontSize(11);
        pdf.setFont('helvetica', 'bold');
        pdf.setTextColor(d.netOperatingIncome >= 0 ? 22 : 220, d.netOperatingIncome >= 0 ? 163 : 38, d.netOperatingIncome >= 0 ? 74 : 38);
        pdf.text('NET OPERATING INCOME', margin, y);
        pdf.text(formatUGX(d.netOperatingIncome), pw - margin, y, { align: 'right' });
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
            {activeTab === 'income' && data && <IncomeStatementSection d={data.incomeStatement} cm={comparisonMetrics} />}
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
