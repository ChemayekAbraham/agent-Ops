import { useState, useEffect, useRef } from 'react';
import { format } from 'date-fns';
import { useNavigate } from 'react-router-dom';
import {
  ArrowLeft, Download, FileSpreadsheet, FileText, Loader2, Calendar,
  TrendingUp, TrendingDown, DollarSign, Users, Building2, BarChart3,
  ArrowUpRight, ArrowDownRight, Minus, GitCompareArrows, RefreshCw, Presentation
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Separator } from '@/components/ui/separator';
import { cn } from '@/lib/utils';
import { toast } from 'sonner';
import { exportToCSV } from '@/lib/exportUtils';
import {
  useFinancialStatements,
  type StatementPeriod,
  type ComparisonMode,
  type FinancialStatementsData,
  type ComparisonMetrics,
  type DeltaValue,
} from '@/hooks/useFinancialStatements';
import { formatDynamic as formatUGX, formatDynamicCompact, getDynamicCurrencyCode } from '@/lib/currencyFormat';

// ── Period & Comparison configs ──
const PERIODS: { value: StatementPeriod; label: string }[] = [
  { value: 'today', label: 'Today' },
  { value: '7days', label: '7 Days' },
  { value: '30days', label: '30 Days' },
  { value: 'month', label: 'This Month' },
  { value: 'year', label: 'YTD' },
  { value: 'all', label: 'All Time' },
];
const COMPARISONS: { value: ComparisonMode; label: string }[] = [
  { value: 'none', label: 'Off' },
  { value: 'dod', label: 'DoD' },
  { value: 'wow', label: 'WoW' },
  { value: 'mom', label: 'MoM' },
  { value: 'yoy', label: 'YoY' },
];

// ── Helpers ──
function DeltaIndicator({ delta, invert }: { delta?: DeltaValue; invert?: boolean }) {
  if (!delta || (delta.change === 0 && delta.changePercent === null)) return null;
  const positive = invert ? delta.change < 0 : delta.change > 0;
  const negative = invert ? delta.change > 0 : delta.change < 0;
  const pct = delta.changePercent !== null ? `${delta.changePercent > 0 ? '+' : ''}${delta.changePercent.toFixed(1)}%` : '';
  return (
    <span className={cn(
      'inline-flex items-center gap-0.5 text-[11px] font-semibold',
      positive && 'text-emerald-600', negative && 'text-red-500',
      !positive && !negative && 'text-muted-foreground'
    )}>
      {positive && <ArrowUpRight className="h-3 w-3" />}
      {negative && <ArrowDownRight className="h-3 w-3" />}
      {!positive && !negative && <Minus className="h-3 w-3" />}
      {pct}
    </span>
  );
}

function KPICard({ label, value, delta, icon: Icon, format: fmt = 'currency' }: {
  label: string; value: number; delta?: DeltaValue; icon: any; format?: 'currency' | 'number' | 'compact';
}) {
  const formatted = fmt === 'currency' ? formatUGX(value) : fmt === 'compact' ? formatDynamicCompact(value) : value.toLocaleString();
  return (
    <Card className="border-border/50">
      <CardContent className="pt-4 pb-3 px-4">
        <div className="flex items-start justify-between mb-2">
          <div className="p-2 rounded-lg bg-primary/10">
            <Icon className="h-4 w-4 text-primary" />
          </div>
          <DeltaIndicator delta={delta} />
        </div>
        <p className="text-xl font-bold font-mono tracking-tight">{formatted}</p>
        <p className="text-xs text-muted-foreground mt-0.5">{label}</p>
      </CardContent>
    </Card>
  );
}

// ── GAAP-style Statement Row ──
function StatementRow({ label, value, bold, indent, negative, delta, borderTop, sub }: {
  label: string; value: number; bold?: boolean; indent?: boolean; negative?: boolean;
  delta?: DeltaValue; borderTop?: boolean; sub?: boolean;
}) {
  const valColor = negative
    ? (value > 0 ? 'text-red-500' : 'text-muted-foreground')
    : (value > 0 ? 'text-foreground' : value < 0 ? 'text-red-500' : 'text-muted-foreground');
  return (
    <div className={cn(
      'grid grid-cols-[1fr,auto,auto] gap-4 py-1.5 px-2',
      bold && 'font-semibold',
      borderTop && 'border-t border-border/60 pt-2 mt-1',
      sub && 'text-xs text-muted-foreground',
    )}>
      <span className={cn(indent && 'pl-4', sub && 'pl-8')}>
        {label}
      </span>
      <span className="w-8 flex justify-end">
        <DeltaIndicator delta={delta} invert={negative} />
      </span>
      <span className={cn('font-mono text-right min-w-[100px]', valColor)}>
        {negative && value > 0 ? `(${formatUGX(value)})` : formatUGX(value)}
      </span>
    </div>
  );
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <div className="bg-muted/40 px-2 py-1.5 mt-4 mb-1 rounded">
      <h4 className="text-xs font-bold text-primary uppercase tracking-widest">{children}</h4>
    </div>
  );
}

// ── Statement Sections ──
function IncomeStatement({ d, cm }: { d: FinancialStatementsData['incomeStatement']; cm?: ComparisonMetrics | null }) {
  return (
    <div>
      <SectionTitle>Revenue</SectionTitle>
      <StatementRow label="Tenant Access Fees" value={d.revenue.accessFees} indent delta={cm?.accessFees} />
      <StatementRow label="Tenant Request Fees" value={d.revenue.requestFees} indent delta={cm?.requestFees} />
      <StatementRow label="Other Service Income" value={d.revenue.otherServiceIncome} indent delta={cm?.otherServiceIncome} />
      <StatementRow label="Advance Access Fees" value={d.revenue.advanceAccessFeesCollected} indent delta={cm?.advanceAccessFeesCollected} />
      <StatementRow label="Total Revenue" value={d.revenue.total} bold borderTop delta={cm?.totalRevenue} />

      <SectionTitle>Cost of Revenue</SectionTitle>
      <StatementRow label="Platform Rewards" value={d.serviceDeliveryCosts.platformRewards} indent negative />
      <StatementRow label="Agent Commissions" value={d.serviceDeliveryCosts.agentCommissions} indent negative />
      <StatementRow label="Referral Bonuses" value={d.serviceDeliveryCosts.referralBonuses} indent negative />
      <StatementRow label="Agent Bonuses" value={d.serviceDeliveryCosts.agentBonuses} indent negative />
      <StatementRow label="Transaction Expenses" value={d.serviceDeliveryCosts.transactionExpenses} indent negative />
      <StatementRow label="Total Cost of Revenue" value={d.serviceDeliveryCosts.total} bold negative borderTop delta={cm?.totalServiceCosts} />

      <StatementRow label="Gross Profit" value={d.revenue.total - d.serviceDeliveryCosts.total} bold borderTop />

      <SectionTitle>Operating Expenses</SectionTitle>
      <StatementRow label="Payroll & Staff" value={d.operatingExpenses.payrollExpenses} indent negative />
      <StatementRow label="Agent Requisitions" value={d.operatingExpenses.agentRequisitions} indent negative />
      <StatementRow label="Financial Agent Expenses" value={d.operatingExpenses.financialAgentExpenses} indent negative />
      <StatementRow label="Sales & Marketing" value={d.operatingExpenses.marketingExpenses} indent negative />
      <StatementRow label="Research & Development" value={d.operatingExpenses.researchDevelopment} indent negative />
      <StatementRow label="Tax Expense" value={d.operatingExpenses.taxExpense} indent negative />
      <StatementRow label="Interest Expense" value={d.operatingExpenses.interestExpense} indent negative />
      <StatementRow label="Equipment & Depreciation" value={d.operatingExpenses.equipmentExpense} indent negative />
      {d.operatingExpenses.operationalSubcategories && (
        <>
          {d.operatingExpenses.operationalSubcategories.salaries > 0 && <StatementRow label="Salaries" value={d.operatingExpenses.operationalSubcategories.salaries} negative sub />}
          {d.operatingExpenses.operationalSubcategories.transport > 0 && <StatementRow label="Transport" value={d.operatingExpenses.operationalSubcategories.transport} negative sub />}
          {d.operatingExpenses.operationalSubcategories.food > 0 && <StatementRow label="Food & Meals" value={d.operatingExpenses.operationalSubcategories.food} negative sub />}
          {d.operatingExpenses.operationalSubcategories.officeRent > 0 && <StatementRow label="Office Rent" value={d.operatingExpenses.operationalSubcategories.officeRent} negative sub />}
          {d.operatingExpenses.operationalSubcategories.internet > 0 && <StatementRow label="Internet & Telecom" value={d.operatingExpenses.operationalSubcategories.internet} negative sub />}
          {d.operatingExpenses.operationalSubcategories.airtime > 0 && <StatementRow label="Airtime" value={d.operatingExpenses.operationalSubcategories.airtime} negative sub />}
          {d.operatingExpenses.operationalSubcategories.stationery > 0 && <StatementRow label="Stationery" value={d.operatingExpenses.operationalSubcategories.stationery} negative sub />}
        </>
      )}
      <StatementRow label="General & Administrative" value={d.operatingExpenses.generalOperating} indent negative />
      <StatementRow label="Total Operating Expenses" value={d.operatingExpenses.total} bold negative borderTop delta={cm?.totalOperatingExpenses} />

      {(d.adjustments.walletDeductions > 0 || d.adjustments.systemCorrections > 0 || d.adjustments.orphanReassignments > 0 || d.adjustments.orphanReversals > 0) && (
        <>
          <SectionTitle>Other Income (Expense)</SectionTitle>
          {d.adjustments.walletDeductions > 0 && <StatementRow label="Recovery Income" value={d.adjustments.walletDeductions} indent />}
          {d.adjustments.systemCorrections > 0 && <StatementRow label="System Corrections" value={d.adjustments.systemCorrections} indent />}
          {d.adjustments.orphanReassignments > 0 && <StatementRow label="Orphan Reassignments" value={d.adjustments.orphanReassignments} indent />}
          {d.adjustments.orphanReversals > 0 && <StatementRow label="Orphan Reversals" value={d.adjustments.orphanReversals} indent negative />}
          <StatementRow label="Total Other Income" value={d.adjustments.total} bold borderTop />
        </>
      )}

      <div className={cn(
        'grid grid-cols-[1fr,auto,auto] gap-4 py-3 px-2 mt-2 rounded-lg',
        d.netOperatingIncome >= 0 ? 'bg-emerald-500/10' : 'bg-red-500/10'
      )}>
        <span className="font-bold text-base">Net Income</span>
        <span><DeltaIndicator delta={cm?.netOperatingIncome} /></span>
        <span className={cn('font-bold font-mono text-base text-right', d.netOperatingIncome >= 0 ? 'text-emerald-600' : 'text-red-500')}>
          {formatUGX(d.netOperatingIncome)}
        </span>
      </div>
    </div>
  );
}

function CashFlowStatement({ d, cm }: { d: FinancialStatementsData['cashFlow']; cm?: ComparisonMetrics | null }) {
  return (
    <div>
      <SectionTitle>Cash Flows from Operating Activities</SectionTitle>
      <StatementRow label="Tenant Fees Received" value={d.operatingActivities.tenantFeesReceived} indent />
      <StatementRow label="Other Platform Income" value={d.operatingActivities.otherServiceIncome} indent />
      <StatementRow label="Platform Rewards Paid" value={d.operatingActivities.platformRewardsPaid} indent negative />
      <StatementRow label="Agent Commissions Paid" value={d.operatingActivities.agentCommissionsPaid} indent negative />
      {d.operatingActivities.agentCommissionWithdrawals > 0 && <StatementRow label="Agent Commission Withdrawals" value={d.operatingActivities.agentCommissionWithdrawals} indent negative />}
      <StatementRow label="Payroll Paid" value={d.operatingActivities.payrollPaid} indent negative />
      <StatementRow label="Agent Requisitions" value={d.operatingActivities.agentRequisitionsPaid} indent negative />
      <StatementRow label="Marketing Expenses" value={d.operatingActivities.marketingPaid} indent negative />
      <StatementRow label="R&D Expenses" value={d.operatingActivities.rdPaid} indent negative />
      <StatementRow label="Operational Expenses" value={d.operatingActivities.operationalSubcatPaid} indent negative />
      <StatementRow label="General Expenses" value={d.operatingActivities.withdrawalsPaid} indent negative />
      <StatementRow label="Net Cash from Operations" value={d.operatingActivities.netOperating} bold borderTop delta={cm?.netOperatingCash} />

      <SectionTitle>Cash Flows from Facilitation Activities</SectionTitle>
      <StatementRow label="Rent Repayments Received" value={d.facilitationActivities.rentRepayments} indent />
      {d.facilitationActivities.rentPrincipalCollected > 0 && <StatementRow label="Principal Collected" value={d.facilitationActivities.rentPrincipalCollected} indent />}
      {d.facilitationActivities.agentRepayments > 0 && <StatementRow label="Agent Repayments" value={d.facilitationActivities.agentRepayments} indent />}
      {d.facilitationActivities.advanceRepayments > 0 && <StatementRow label="Advance Repayments" value={d.facilitationActivities.advanceRepayments} indent />}
      <StatementRow label="Rent Deployed" value={d.facilitationActivities.rentDeployments} indent negative />
      {d.facilitationActivities.rentDisbursements > 0 && <StatementRow label="Rent Disbursements" value={d.facilitationActivities.rentDisbursements} indent negative />}
      <StatementRow label="Net Cash from Facilitation" value={d.facilitationActivities.netFacilitation} bold borderTop delta={cm?.netFacilitation} />

      <SectionTitle>Cash Flows from Custodial Activities</SectionTitle>
      <StatementRow label="User Deposits" value={d.custodialActivities.userDeposits} indent />
      {d.custodialActivities.roiWalletCredits > 0 && <StatementRow label="ROI Credits" value={d.custodialActivities.roiWalletCredits} indent />}
      {d.custodialActivities.walletCommissionCredits > 0 && <StatementRow label="Commission Credits" value={d.custodialActivities.walletCommissionCredits} indent />}
      {d.custodialActivities.walletCorrectionCredits > 0 && <StatementRow label="CFO Credits" value={d.custodialActivities.walletCorrectionCredits} indent />}
      <StatementRow label="User Withdrawals" value={d.custodialActivities.userWithdrawals} indent negative />
      {d.custodialActivities.userTransfers > 0 && <StatementRow label="Wallet Transfers" value={d.custodialActivities.userTransfers} indent negative />}
      {d.custodialActivities.walletDeductions > 0 && <StatementRow label="Wallet Deductions" value={d.custodialActivities.walletDeductions} indent negative />}
      {d.custodialActivities.walletCorrectionDebits > 0 && <StatementRow label="CFO Debits" value={d.custodialActivities.walletCorrectionDebits} indent negative />}
      <StatementRow label="Net Change in Custody" value={d.custodialActivities.netCustodial} bold borderTop delta={cm?.netCustodial} />

      <SectionTitle>Cash Flows from Financing Activities</SectionTitle>
      <StatementRow label="Supporter Capital Inflows" value={d.financingActivities.supporterCapitalInflows} indent />
      {d.financingActivities.partnerFunding > 0 && <StatementRow label="Partner Funding" value={d.financingActivities.partnerFunding} indent />}
      {d.financingActivities.shareCapital > 0 && <StatementRow label="Share Capital" value={d.financingActivities.shareCapital} indent />}
      {d.financingActivities.roiReinvestment > 0 && <StatementRow label="ROI Reinvestment" value={d.financingActivities.roiReinvestment} indent />}
      <StatementRow label="Capital Withdrawals" value={d.financingActivities.supporterCapitalWithdrawals} indent negative />
      <StatementRow label="Net Cash from Financing" value={d.financingActivities.netFinancing} bold borderTop delta={cm?.netFinancing} />

      <div className="mt-4 space-y-1 border-t-2 border-primary/30 pt-3">
        <StatementRow label="Opening Balance" value={d.openingBalance} />
        <StatementRow label="Net Change in Cash" value={d.netCashMovement} bold delta={cm?.netCashMovement} />
        <div className="grid grid-cols-[1fr,auto,auto] gap-4 py-3 px-2 rounded-lg bg-primary/10">
          <span className="font-bold text-base">Cash & Equivalents, End of Period</span>
          <span><DeltaIndicator delta={cm?.closingBalance} /></span>
          <span className="font-bold font-mono text-base text-right text-primary">{formatUGX(d.closingBalance)}</span>
        </div>
      </div>
    </div>
  );
}

function BalanceSheetStatement({ d }: { d: FinancialStatementsData['balanceSheet'] }) {
  const balanced = Math.abs(d.assets.totalAssets - (d.platformObligations.totalObligations + d.platformEquity.totalEquity)) < 1;
  return (
    <div>
      <SectionTitle>Assets</SectionTitle>
      <StatementRow label="Cash & Cash Equivalents" value={d.assets.platformCash} indent />
      <StatementRow label="User Funds Held in Custody" value={d.assets.userFundsHeld} indent />
      <StatementRow label="Rent Receivables" value={d.assets.receivables} indent />
      {d.assets.rentReceivablesCreated > 0 && <StatementRow label="Rent Receivables Created" value={d.assets.rentReceivablesCreated} indent />}
      <StatementRow label="Advance Access Fee Receivables" value={d.assets.advanceAccessFeeReceivables} indent />
      <StatementRow label="Promissory Notes Receivable" value={d.assets.promissoryNotesReceivable} indent />
      <StatementRow label="Total Assets" value={d.assets.totalAssets} bold borderTop />

      <SectionTitle>Liabilities</SectionTitle>
      <StatementRow label="User Wallet Obligations" value={d.platformObligations.userWalletCustody} indent negative />
      <StatementRow label="Pending Withdrawals" value={d.platformObligations.pendingWithdrawals} indent negative />
      <StatementRow label="Accrued Platform Rewards" value={d.platformObligations.accruedPlatformRewards} indent negative />
      <StatementRow label="Agent Commissions Payable" value={d.platformObligations.agentCommissionsPayable} indent negative />
      {d.platformObligations.deferredRevenue > 0 && <StatementRow label="Deferred Revenue (Unrecognized Fees)" value={d.platformObligations.deferredRevenue} indent negative />}
      <StatementRow label="Total Liabilities" value={d.platformObligations.totalObligations} bold negative borderTop />

      <SectionTitle>Stockholders' Equity</SectionTitle>
      <StatementRow label="Retained Earnings" value={d.platformEquity.retainedOperatingSurplus} indent />
      <StatementRow label="Total Stockholders' Equity" value={d.platformEquity.totalEquity} bold borderTop />

      {/* Revenue Recognition Note */}
      {d.revenueRecognition.expectedRevenue > 0 && (
        <div className="mt-4 p-3 rounded-lg border border-amber-200 bg-amber-50/50 dark:bg-amber-950/20 dark:border-amber-800">
          <p className="text-xs font-semibold text-amber-700 dark:text-amber-400 uppercase tracking-wider mb-2">Note: Revenue Recognition (ASC 606)</p>
          <div className="grid grid-cols-2 gap-x-6 gap-y-1 text-xs">
            <span className="text-muted-foreground">Expected Revenue (Contracted)</span>
            <span className="font-mono text-right">{formatUGX(d.revenueRecognition.expectedRevenue)}</span>
            <span className="text-muted-foreground">Realized Revenue (Collected)</span>
            <span className="font-mono text-right text-emerald-600">{formatUGX(d.revenueRecognition.realizedRevenue)}</span>
            <span className="text-muted-foreground">Deferred Revenue</span>
            <span className="font-mono text-right text-amber-600">{formatUGX(d.revenueRecognition.deferredRevenue)}</span>
            <span className="text-muted-foreground">Recognition Rate</span>
            <span className="font-mono text-right">{d.revenueRecognition.recognitionRate.toFixed(1)}%</span>
          </div>
        </div>
      )}

      <div className={cn('text-center py-2 mt-3 rounded text-xs font-medium', balanced ? 'bg-emerald-500/10 text-emerald-600' : 'bg-red-500/10 text-red-500')}>
        {balanced ? '✓ Assets = Liabilities + Equity (Balanced)' : '⚠ Balance sheet requires reconciliation'}
      </div>
    </div>
  );
}

// ── PPTX Export ──
async function exportToPPTX(data: FinancialStatementsData) {
  const pptxgen = (await import('pptxgenjs')).default;
  const pres = new pptxgen();
  pres.layout = 'LAYOUT_16x9';
  pres.author = 'Welile Technologies';
  pres.company = 'Welile Technologies Limited';
  pres.title = 'Financial Report';

  const BRAND = '1E3A5F';
  const WHITE = 'FFFFFF';
  const GRAY = '6B7280';
  const GREEN = '059669';
  const RED = 'DC2626';

  // Slide 1: Title
  const s1 = pres.addSlide();
  s1.background = { fill: BRAND };
  s1.addText('WELILE TECHNOLOGIES LIMITED', { x: 0.8, y: 1.5, w: 8.4, h: 0.6, fontSize: 28, fontFace: 'Arial', bold: true, color: WHITE });
  s1.addText('Financial Report', { x: 0.8, y: 2.2, w: 8.4, h: 0.5, fontSize: 20, fontFace: 'Arial', color: 'A0C4E8' });
  s1.addText(`Period: ${data.incomeStatement.period}`, { x: 0.8, y: 3.0, w: 8.4, h: 0.4, fontSize: 14, fontFace: 'Arial', color: 'A0C4E8' });
  s1.addText(`Generated: ${format(data.generatedAt, 'MMMM dd, yyyy')}`, { x: 0.8, y: 3.5, w: 8.4, h: 0.3, fontSize: 11, fontFace: 'Arial', color: '7FB5D5' });
  s1.addText('CONFIDENTIAL', { x: 7.5, y: 4.8, w: 2, h: 0.3, fontSize: 9, fontFace: 'Arial', color: '7FB5D5', align: 'right' });

  // Slide 2: Executive Summary KPIs
  const s2 = pres.addSlide();
  s2.addText('Executive Summary', { x: 0.8, y: 0.4, w: 8.4, h: 0.5, fontSize: 22, fontFace: 'Arial', bold: true, color: BRAND });
  s2.addShape(pres.ShapeType.rect, { x: 0.8, y: 0.95, w: 2, h: 0.03, fill: { color: BRAND } });
  const kpis = [
    { label: 'Total Revenue', value: formatUGX(data.incomeStatement.revenue.total) },
    { label: 'Net Income', value: formatUGX(data.incomeStatement.netOperatingIncome) },
    { label: 'Closing Cash', value: formatUGX(data.cashFlow.closingBalance) },
    { label: 'Facilitated Volume', value: formatUGX(data.facilitatedVolume.totalFacilitatedRentVolume) },
    { label: 'Active Tenants', value: data.facilitatedVolume.activeTenants.toString() },
    { label: 'Active Agents', value: data.facilitatedVolume.activeAgents.toString() },
  ];
  kpis.forEach((kpi, i) => {
    const col = i % 3;
    const row = Math.floor(i / 3);
    const x = 0.8 + col * 2.9;
    const y = 1.4 + row * 1.5;
    s2.addShape(pres.ShapeType.roundRect, { x, y, w: 2.6, h: 1.2, fill: { color: 'F0F4F8' }, rectRadius: 0.1 });
    s2.addText(kpi.value, { x, y: y + 0.15, w: 2.6, h: 0.5, fontSize: 16, fontFace: 'Arial', bold: true, color: BRAND, align: 'center' });
    s2.addText(kpi.label, { x, y: y + 0.7, w: 2.6, h: 0.3, fontSize: 9, fontFace: 'Arial', color: GRAY, align: 'center' });
  });

  // Slide 3: Income Statement
  const s3 = pres.addSlide();
  s3.addText('Consolidated Statement of Income', { x: 0.8, y: 0.4, w: 8.4, h: 0.5, fontSize: 20, fontFace: 'Arial', bold: true, color: BRAND });
  s3.addShape(pres.ShapeType.rect, { x: 0.8, y: 0.95, w: 2.5, h: 0.03, fill: { color: BRAND } });
  const isRows = [
    ['', 'Amount'],
    ['Revenue', ''],
    ['  Access Fees', formatUGX(data.incomeStatement.revenue.accessFees)],
    ['  Request Fees', formatUGX(data.incomeStatement.revenue.requestFees)],
    ['  Other Income', formatUGX(data.incomeStatement.revenue.otherServiceIncome)],
    ['Total Revenue', formatUGX(data.incomeStatement.revenue.total)],
    ['', ''],
    ['Cost of Revenue', formatUGX(data.incomeStatement.serviceDeliveryCosts.total)],
    ['Gross Profit', formatUGX(data.incomeStatement.revenue.total - data.incomeStatement.serviceDeliveryCosts.total)],
    ['Operating Expenses', formatUGX(data.incomeStatement.operatingExpenses.total)],
    ['Net Income', formatUGX(data.incomeStatement.netOperatingIncome)],
  ];
  s3.addTable(isRows.map((row, i) => row.map((cell, j) => ({
    text: cell,
    options: {
      fontSize: i === 0 ? 9 : [1, 6].includes(i) ? 8 : 9,
      fontFace: 'Arial',
      bold: i === 0 || [5, 8, 10].includes(i),
      color: i === 10 ? (data.incomeStatement.netOperatingIncome >= 0 ? GREEN : RED) : i === 0 ? WHITE : '333333',
      fill: { color: i === 0 ? BRAND : i % 2 === 0 ? 'F9FAFB' : WHITE },
      align: j === 1 ? 'right' as const : 'left' as const,
      border: { type: 'solid' as const, pt: 0.5, color: 'E5E7EB' },
      margin: [4, 8, 4, 8],
    }
  }))), { x: 0.8, y: 1.2, w: 8.4, colW: [5.5, 2.9] });

  // Slide 4: Cash Flow Highlights
  const s4 = pres.addSlide();
  s4.addText('Cash Flow Highlights', { x: 0.8, y: 0.4, w: 8.4, h: 0.5, fontSize: 20, fontFace: 'Arial', bold: true, color: BRAND });
  s4.addShape(pres.ShapeType.rect, { x: 0.8, y: 0.95, w: 2, h: 0.03, fill: { color: BRAND } });
  const cfItems = [
    { label: 'Operating Activities', value: data.cashFlow.operatingActivities.netOperating },
    { label: 'Facilitation Activities', value: data.cashFlow.facilitationActivities.netFacilitation },
    { label: 'Custodial Activities', value: data.cashFlow.custodialActivities.netCustodial },
    { label: 'Financing Activities', value: data.cashFlow.financingActivities.netFinancing },
  ];
  cfItems.forEach((item, i) => {
    const y = 1.4 + i * 0.9;
    s4.addShape(pres.ShapeType.roundRect, { x: 0.8, y, w: 5, h: 0.7, fill: { color: i % 2 === 0 ? 'F0F4F8' : WHITE }, rectRadius: 0.05 });
    s4.addText(item.label, { x: 1, y, w: 3, h: 0.7, fontSize: 11, fontFace: 'Arial', color: '333333', valign: 'middle' });
    s4.addText(formatUGX(item.value), { x: 4, y, w: 1.8, h: 0.7, fontSize: 12, fontFace: 'Arial', bold: true, color: item.value >= 0 ? GREEN : RED, align: 'right', valign: 'middle' });
  });
  s4.addShape(pres.ShapeType.roundRect, { x: 0.8, y: 5, w: 5, h: 0.7, fill: { color: BRAND }, rectRadius: 0.05 });
  s4.addText('Closing Cash Balance', { x: 1, y: 5, w: 3, h: 0.7, fontSize: 12, fontFace: 'Arial', bold: true, color: WHITE, valign: 'middle' });
  s4.addText(formatUGX(data.cashFlow.closingBalance), { x: 4, y: 5, w: 1.8, h: 0.7, fontSize: 14, fontFace: 'Arial', bold: true, color: WHITE, align: 'right', valign: 'middle' });

  // Slide 5: Balance Sheet
  const s5 = pres.addSlide();
  s5.addText('Consolidated Balance Sheet', { x: 0.8, y: 0.4, w: 8.4, h: 0.5, fontSize: 20, fontFace: 'Arial', bold: true, color: BRAND });
  s5.addShape(pres.ShapeType.rect, { x: 0.8, y: 0.95, w: 2.5, h: 0.03, fill: { color: BRAND } });
  const bsRows = [
    ['', 'Amount'],
    ['ASSETS', ''],
    ['  Cash & Equivalents', formatUGX(data.balanceSheet.assets.platformCash)],
    ['  User Funds in Custody', formatUGX(data.balanceSheet.assets.userFundsHeld)],
    ['  Receivables', formatUGX(data.balanceSheet.assets.receivables)],
    ['Total Assets', formatUGX(data.balanceSheet.assets.totalAssets)],
    ['', ''],
    ['LIABILITIES', ''],
    ['  User Wallet Obligations', formatUGX(data.balanceSheet.platformObligations.userWalletCustody)],
    ...(data.balanceSheet.platformObligations.deferredRevenue > 0 ? [['  Deferred Revenue', formatUGX(data.balanceSheet.platformObligations.deferredRevenue)]] : []),
    ['Total Liabilities', formatUGX(data.balanceSheet.platformObligations.totalObligations)],
    ['', ''],
    ['EQUITY', ''],
    ['  Retained Earnings', formatUGX(data.balanceSheet.platformEquity.retainedOperatingSurplus)],
    ['Total Equity', formatUGX(data.balanceSheet.platformEquity.totalEquity)],
    ['', ''],
    ['REVENUE RECOGNITION (ASC 606)', ''],
    ['  Expected Revenue', formatUGX(data.balanceSheet.revenueRecognition.expectedRevenue)],
    ['  Realized Revenue', formatUGX(data.balanceSheet.revenueRecognition.realizedRevenue)],
    ['  Deferred Revenue', formatUGX(data.balanceSheet.revenueRecognition.deferredRevenue)],
    ['  Recognition Rate', `${data.balanceSheet.revenueRecognition.recognitionRate.toFixed(1)}%`],
  ];
  s5.addTable(bsRows.map((row, i) => row.map((cell, j) => ({
    text: cell,
    options: {
      fontSize: 9,
      fontFace: 'Arial',
      bold: i === 0 || [1, 5, 7, 9, 11, 13].includes(i),
      color: i === 0 ? WHITE : '333333',
      fill: { color: i === 0 ? BRAND : i % 2 === 0 ? 'F9FAFB' : WHITE },
      align: j === 1 ? 'right' as const : 'left' as const,
      border: { type: 'solid' as const, pt: 0.5, color: 'E5E7EB' },
      margin: [3, 8, 3, 8],
    }
  }))), { x: 0.8, y: 1.2, w: 8.4, colW: [5.5, 2.9] });

  // Slide 6: Disclaimer
  const s6 = pres.addSlide();
  s6.background = { fill: BRAND };
  s6.addText('Thank You', { x: 0.8, y: 2, w: 8.4, h: 0.8, fontSize: 32, fontFace: 'Arial', bold: true, color: WHITE, align: 'center' });
  s6.addText('Welile Technologies Limited\nConfidential Financial Report', { x: 0.8, y: 3, w: 8.4, h: 0.6, fontSize: 12, fontFace: 'Arial', color: '7FB5D5', align: 'center' });
  s6.addText(`Generated ${format(data.generatedAt, 'MMMM dd, yyyy')}`, { x: 0.8, y: 3.8, w: 8.4, h: 0.3, fontSize: 10, fontFace: 'Arial', color: '7FB5D5', align: 'center' });

  pres.writeFile({ fileName: `Welile-Financial-Report-${format(new Date(), 'yyyy-MM-dd')}.pptx` });
}

// ── Enhanced PDF Export ──
async function exportTo10KPDF(data: FinancialStatementsData) {
  const { jsPDF } = await import('jspdf');
  const pdf = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });
  const pw = pdf.internal.pageSize.getWidth();
  const ph = pdf.internal.pageSize.getHeight();
  const margin = 20;
  const contentW = pw - margin * 2;
  let y = 0;

  const BRAND_R = 30, BRAND_G = 58, BRAND_B = 95;
  const addFooter = () => {
    pdf.setFillColor(BRAND_R, BRAND_G, BRAND_B);
    pdf.rect(0, ph - 10, pw, 10, 'F');
    pdf.setTextColor(255, 255, 255);
    pdf.setFontSize(7);
    pdf.text('Welile Technologies Limited — Confidential Financial Report', pw / 2, ph - 4, { align: 'center' });
  };

  const checkPage = (needed: number) => {
    if (y + needed > ph - 20) {
      addFooter();
      pdf.addPage();
      y = 20;
    }
  };

  // Cover page
  pdf.setFillColor(BRAND_R, BRAND_G, BRAND_B);
  pdf.rect(0, 0, pw, ph, 'F');
  pdf.setTextColor(255, 255, 255);
  pdf.setFontSize(32);
  pdf.setFont('helvetica', 'bold');
  pdf.text('WELILE TECHNOLOGIES', margin, 80);
  pdf.setFontSize(24);
  pdf.text('LIMITED', margin, 92);
  pdf.setDrawColor(160, 196, 232);
  pdf.setLineWidth(0.5);
  pdf.line(margin, 100, margin + 60, 100);
  pdf.setFontSize(16);
  pdf.setFont('helvetica', 'normal');
  pdf.setTextColor(160, 196, 232);
  pdf.text('Financial Report', margin, 115);
  pdf.setFontSize(12);
  pdf.text(`Period: ${data.incomeStatement.period}`, margin, 128);
  pdf.text(`Generated: ${format(data.generatedAt, 'MMMM dd, yyyy')}`, margin, 140);
  pdf.setFontSize(9);
  pdf.text('CONFIDENTIAL', margin, ph - 30);
  pdf.text('This report contains confidential financial information of', margin, ph - 24);
  pdf.text('Welile Technologies Limited and is intended solely for authorized recipients.', margin, ph - 18);

  // Income Statement page
  pdf.addPage();
  y = 20;
  pdf.setFillColor(BRAND_R, BRAND_G, BRAND_B);
  pdf.rect(0, 0, pw, 14, 'F');
  pdf.setTextColor(255, 255, 255);
  pdf.setFontSize(10);
  pdf.setFont('helvetica', 'bold');
  pdf.text('WELILE TECHNOLOGIES LIMITED', margin, 9);
  pdf.text(`Period: ${data.incomeStatement.period}`, pw - margin, 9, { align: 'right' });

  y = 24;
  pdf.setTextColor(BRAND_R, BRAND_G, BRAND_B);
  pdf.setFontSize(16);
  pdf.setFont('helvetica', 'bold');
  pdf.text('Consolidated Statement of Income', margin, y);
  y += 4;
  pdf.setDrawColor(BRAND_R, BRAND_G, BRAND_B);
  pdf.setLineWidth(0.8);
  pdf.line(margin, y, margin + 70, y);
  y += 8;

  const addSectionHead = (title: string) => {
    checkPage(8);
    pdf.setFontSize(8);
    pdf.setFont('helvetica', 'bold');
    pdf.setTextColor(BRAND_R, BRAND_G, BRAND_B);
    pdf.text(title.toUpperCase(), margin, y);
    y += 5;
  };

  const addRow = (label: string, value: number, opts?: { bold?: boolean; indent?: boolean; negative?: boolean; highlight?: boolean }) => {
    checkPage(6);
    const { bold, indent, negative, highlight } = opts || {};
    if (highlight) {
      pdf.setFillColor(240, 244, 248);
      pdf.rect(margin - 2, y - 3.5, contentW + 4, 5.5, 'F');
    }
    pdf.setFontSize(bold ? 9 : 8);
    pdf.setFont('helvetica', bold ? 'bold' : 'normal');
    pdf.setTextColor(bold ? 30 : 80, bold ? 30 : 80, bold ? 30 : 80);
    pdf.text(label, indent ? margin + 6 : margin, y);
    const valStr = negative && value > 0 ? `(${formatUGX(value)})` : formatUGX(value);
    if (negative && value > 0) pdf.setTextColor(220, 38, 38);
    else if (!negative && value > 0) pdf.setTextColor(5, 150, 105);
    else pdf.setTextColor(0, 0, 0);
    pdf.text(valStr, pw - margin, y, { align: 'right' });
    pdf.setTextColor(0, 0, 0);
    if (bold) { pdf.setDrawColor(200, 200, 200); pdf.line(margin, y + 1.5, pw - margin, y + 1.5); }
    y += bold ? 6.5 : 5;
  };

  addSectionHead('Revenue');
  addRow('Tenant Access Fees', data.incomeStatement.revenue.accessFees, { indent: true });
  addRow('Tenant Request Fees', data.incomeStatement.revenue.requestFees, { indent: true });
  addRow('Other Service Income', data.incomeStatement.revenue.otherServiceIncome, { indent: true });
  addRow('Advance Access Fees', data.incomeStatement.revenue.advanceAccessFeesCollected, { indent: true });
  addRow('Total Revenue', data.incomeStatement.revenue.total, { bold: true, highlight: true });
  y += 2;
  addSectionHead('Cost of Revenue');
  addRow('Platform Rewards', data.incomeStatement.serviceDeliveryCosts.platformRewards, { indent: true, negative: true });
  addRow('Agent Commissions', data.incomeStatement.serviceDeliveryCosts.agentCommissions, { indent: true, negative: true });
  addRow('Total Cost of Revenue', data.incomeStatement.serviceDeliveryCosts.total, { bold: true, negative: true });
  y += 2;
  addRow('Gross Profit', data.incomeStatement.revenue.total - data.incomeStatement.serviceDeliveryCosts.total, { bold: true, highlight: true });
  y += 2;
  addSectionHead('Operating Expenses');
  addRow('Payroll & Staff', data.incomeStatement.operatingExpenses.payrollExpenses, { indent: true, negative: true });
  addRow('Sales & Marketing', data.incomeStatement.operatingExpenses.marketingExpenses, { indent: true, negative: true });
  addRow('Research & Development', data.incomeStatement.operatingExpenses.researchDevelopment, { indent: true, negative: true });
  addRow('Tax Expense', data.incomeStatement.operatingExpenses.taxExpense, { indent: true, negative: true });
  addRow('Interest Expense', data.incomeStatement.operatingExpenses.interestExpense, { indent: true, negative: true });
  addRow('Equipment & Depreciation', data.incomeStatement.operatingExpenses.equipmentExpense, { indent: true, negative: true });
  addRow('General & Administrative', data.incomeStatement.operatingExpenses.generalOperating, { indent: true, negative: true });
  addRow('Total Operating Expenses', data.incomeStatement.operatingExpenses.total, { bold: true, negative: true });
  y += 4;
  // Net Income highlight
  const niColor = data.incomeStatement.netOperatingIncome >= 0;
  pdf.setFillColor(niColor ? 5 : 220, niColor ? 150 : 38, niColor ? 105 : 38);
  pdf.roundedRect(margin - 2, y - 4, contentW + 4, 8, 1, 1, 'F');
  pdf.setTextColor(255, 255, 255);
  pdf.setFontSize(11);
  pdf.setFont('helvetica', 'bold');
  pdf.text('NET INCOME', margin + 2, y);
  pdf.text(formatUGX(data.incomeStatement.netOperatingIncome), pw - margin - 2, y, { align: 'right' });
  y += 10;
  addFooter();

  // Cash Flow page
  pdf.addPage();
  y = 20;
  pdf.setFillColor(BRAND_R, BRAND_G, BRAND_B);
  pdf.rect(0, 0, pw, 14, 'F');
  pdf.setTextColor(255, 255, 255);
  pdf.setFontSize(10);
  pdf.setFont('helvetica', 'bold');
  pdf.text('WELILE TECHNOLOGIES LIMITED', margin, 9);
  y = 24;
  pdf.setTextColor(BRAND_R, BRAND_G, BRAND_B);
  pdf.setFontSize(16);
  pdf.setFont('helvetica', 'bold');
  pdf.text('Consolidated Statement of Cash Flows', margin, y);
  y += 4;
  pdf.setDrawColor(BRAND_R, BRAND_G, BRAND_B);
  pdf.setLineWidth(0.8);
  pdf.line(margin, y, margin + 75, y);
  y += 8;

  addSectionHead('Operating Activities');
  addRow('Tenant Fees Received', data.cashFlow.operatingActivities.tenantFeesReceived, { indent: true });
  addRow('Other Platform Income', data.cashFlow.operatingActivities.otherServiceIncome, { indent: true });
  addRow('Platform Rewards Paid', data.cashFlow.operatingActivities.platformRewardsPaid, { indent: true, negative: true });
  addRow('Agent Commissions Paid', data.cashFlow.operatingActivities.agentCommissionsPaid, { indent: true, negative: true });
  addRow('Payroll Paid', data.cashFlow.operatingActivities.payrollPaid, { indent: true, negative: true });
  addRow('Operating Expenses', data.cashFlow.operatingActivities.withdrawalsPaid, { indent: true, negative: true });
  addRow('Net Cash from Operations', data.cashFlow.operatingActivities.netOperating, { bold: true, highlight: true });
  y += 2;

  addSectionHead('Facilitation Activities');
  addRow('Rent Repayments', data.cashFlow.facilitationActivities.rentRepayments, { indent: true });
  addRow('Rent Deployed', data.cashFlow.facilitationActivities.rentDeployments, { indent: true, negative: true });
  addRow('Net Cash from Facilitation', data.cashFlow.facilitationActivities.netFacilitation, { bold: true });
  y += 2;

  addSectionHead('Custodial Activities');
  addRow('User Deposits', data.cashFlow.custodialActivities.userDeposits, { indent: true });
  addRow('User Withdrawals', data.cashFlow.custodialActivities.userWithdrawals, { indent: true, negative: true });
  addRow('Net Change in Custody', data.cashFlow.custodialActivities.netCustodial, { bold: true });
  y += 2;

  addSectionHead('Financing Activities');
  addRow('Supporter Capital Inflows', data.cashFlow.financingActivities.supporterCapitalInflows, { indent: true });
  addRow('Capital Withdrawals', data.cashFlow.financingActivities.supporterCapitalWithdrawals, { indent: true, negative: true });
  addRow('Net Cash from Financing', data.cashFlow.financingActivities.netFinancing, { bold: true });
  y += 4;

  addRow('Opening Balance', data.cashFlow.openingBalance, {});
  addRow('Net Change in Cash', data.cashFlow.netCashMovement, { bold: true });
  pdf.setFillColor(BRAND_R, BRAND_G, BRAND_B);
  pdf.roundedRect(margin - 2, y - 4, contentW + 4, 8, 1, 1, 'F');
  pdf.setTextColor(255, 255, 255);
  pdf.setFontSize(11);
  pdf.setFont('helvetica', 'bold');
  pdf.text('CLOSING CASH BALANCE', margin + 2, y);
  pdf.text(formatUGX(data.cashFlow.closingBalance), pw - margin - 2, y, { align: 'right' });
  addFooter();

  // Balance Sheet page
  pdf.addPage();
  y = 20;
  pdf.setFillColor(BRAND_R, BRAND_G, BRAND_B);
  pdf.rect(0, 0, pw, 14, 'F');
  pdf.setTextColor(255, 255, 255);
  pdf.setFontSize(10);
  pdf.setFont('helvetica', 'bold');
  pdf.text('WELILE TECHNOLOGIES LIMITED', margin, 9);
  y = 24;
  pdf.setTextColor(BRAND_R, BRAND_G, BRAND_B);
  pdf.setFontSize(16);
  pdf.setFont('helvetica', 'bold');
  pdf.text('Consolidated Balance Sheet', margin, y);
  y += 4;
  pdf.setDrawColor(BRAND_R, BRAND_G, BRAND_B);
  pdf.setLineWidth(0.8);
  pdf.line(margin, y, margin + 55, y);
  y += 8;

  addSectionHead('Assets');
  addRow('Cash & Cash Equivalents', data.balanceSheet.assets.platformCash, { indent: true });
  addRow('User Funds in Custody', data.balanceSheet.assets.userFundsHeld, { indent: true });
  addRow('Rent Receivables', data.balanceSheet.assets.receivables, { indent: true });
  addRow('Advance Access Fee Receivables', data.balanceSheet.assets.advanceAccessFeeReceivables, { indent: true });
  addRow('Promissory Notes Receivable', data.balanceSheet.assets.promissoryNotesReceivable, { indent: true });
  addRow('Total Assets', data.balanceSheet.assets.totalAssets, { bold: true, highlight: true });
  y += 4;

  addSectionHead('Liabilities');
  addRow('User Wallet Obligations', data.balanceSheet.platformObligations.userWalletCustody, { indent: true, negative: true });
  addRow('Pending Withdrawals', data.balanceSheet.platformObligations.pendingWithdrawals, { indent: true, negative: true });
  addRow('Accrued Platform Rewards', data.balanceSheet.platformObligations.accruedPlatformRewards, { indent: true, negative: true });
  addRow('Agent Commissions Payable', data.balanceSheet.platformObligations.agentCommissionsPayable, { indent: true, negative: true });
  if (data.balanceSheet.platformObligations.deferredRevenue > 0) {
    addRow('Deferred Revenue (Unrecognized Fees)', data.balanceSheet.platformObligations.deferredRevenue, { indent: true, negative: true });
  }
  addRow('Total Liabilities', data.balanceSheet.platformObligations.totalObligations, { bold: true, negative: true });
  y += 4;

  addSectionHead("Stockholders' Equity");
  addRow('Retained Earnings', data.balanceSheet.platformEquity.retainedOperatingSurplus, { indent: true });
  addRow('Total Equity', data.balanceSheet.platformEquity.totalEquity, { bold: true, highlight: true });
  y += 4;

  addSectionHead('Revenue Recognition (ASC 606)');
  addRow('Expected Revenue (Contracted)', data.balanceSheet.revenueRecognition.expectedRevenue, { indent: true });
  addRow('Realized Revenue (Collected)', data.balanceSheet.revenueRecognition.realizedRevenue, { indent: true });
  addRow('Deferred Revenue', data.balanceSheet.revenueRecognition.deferredRevenue, { indent: true, negative: true });
  addFooter();

  pdf.save(`Welile-10K-Report-${format(new Date(), 'yyyy-MM-dd')}.pdf`);
}

// ── Main Page Component ──
type StatementTab = 'income' | 'cashflow' | 'balance';

export default function InvestorReportPage() {
  const navigate = useNavigate();
  const {
    data, loading, filters, generate, updatePeriod,
    comparisonMode, updateComparisonMode, comparisonMetrics, loadingComparison,
  } = useFinancialStatements();
  const [activeTab, setActiveTab] = useState<StatementTab>('income');
  const [exporting, setExporting] = useState<'pdf' | 'pptx' | null>(null);

  useEffect(() => { generate(); }, []);

  const handleExportPDF = async () => {
    if (!data) { toast.error('Generate report first'); return; }
    setExporting('pdf');
    try {
      await exportTo10KPDF(data);
      toast.success('10-K style PDF downloaded');
    } catch (e) {
      console.error(e);
      toast.error('PDF export failed');
    } finally {
      setExporting(null);
    }
  };

  const handleExportPPTX = async () => {
    if (!data) { toast.error('Generate report first'); return; }
    setExporting('pptx');
    try {
      await exportToPPTX(data);
      toast.success('Investor deck downloaded');
    } catch (e) {
      console.error(e);
      toast.error('PPTX export failed');
    } finally {
      setExporting(null);
    }
  };

  const handleExportCSV = () => {
    if (!data) { toast.error('Generate report first'); return; }
    const d = data.incomeStatement;
    const rows: (string | number)[][] = [
      ['WELILE TECHNOLOGIES — Financial Report', '', data.incomeStatement.period],
      ['', '', ''],
      ['REVENUE', '', ''],
      ['Access Fees', '', d.revenue.accessFees],
      ['Request Fees', '', d.revenue.requestFees],
      ['Other Income', '', d.revenue.otherServiceIncome],
      ['Total Revenue', '', d.revenue.total],
      ['Cost of Revenue', '', -d.serviceDeliveryCosts.total],
      ['Gross Profit', '', d.revenue.total - d.serviceDeliveryCosts.total],
      ['Operating Expenses', '', -d.operatingExpenses.total],
      ['Net Income', '', d.netOperatingIncome],
    ];
    exportToCSV({ headers: ['Item', '', `Amount (${getDynamicCurrencyCode()})`], rows }, `welile-investor-report-${format(new Date(), 'yyyy-MM-dd')}`);
    toast.success('CSV exported');
  };

  return (
    <div className="min-h-screen bg-background">
      {/* Header */}
      <div className="border-b bg-card sticky top-0 z-10">
        <div className="container mx-auto px-4 py-3 max-w-6xl flex items-center gap-3">
          <Button variant="ghost" size="icon" onClick={() => navigate(-1)}>
            <ArrowLeft className="h-5 w-5" />
          </Button>
          <div className="flex-1">
            <h1 className="text-lg font-bold tracking-tight">Investor Relations — Financial Report</h1>
            <p className="text-xs text-muted-foreground">WELILE TECHNOLOGIES LIMITED</p>
          </div>
          <div className="flex gap-2">
            <Button variant="outline" size="sm" className="gap-1.5 text-xs" onClick={handleExportCSV}>
              <FileSpreadsheet className="h-3.5 w-3.5" /> CSV
            </Button>
            <Button variant="outline" size="sm" className="gap-1.5 text-xs" onClick={handleExportPDF} disabled={exporting === 'pdf'}>
              {exporting === 'pdf' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <FileText className="h-3.5 w-3.5" />} 10-K PDF
            </Button>
            <Button size="sm" className="gap-1.5 text-xs" onClick={handleExportPPTX} disabled={exporting === 'pptx'}>
              {exporting === 'pptx' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Presentation className="h-3.5 w-3.5" />} Investor Deck
            </Button>
          </div>
        </div>
      </div>

      <div className="container mx-auto px-4 py-6 max-w-6xl space-y-6">
        {/* Controls */}
        <div className="flex flex-wrap gap-4 items-center">
          <div className="flex flex-wrap gap-1.5 items-center">
            <Calendar className="h-4 w-4 text-muted-foreground" />
            {PERIODS.map(p => (
              <Button key={p.value} size="sm" variant={filters.period === p.value ? 'default' : 'outline'} className="text-xs h-7" onClick={() => updatePeriod(p.value)}>
                {p.label}
              </Button>
            ))}
          </div>
          <Separator orientation="vertical" className="h-6 hidden sm:block" />
          <div className="flex flex-wrap gap-1.5 items-center">
            <GitCompareArrows className="h-4 w-4 text-muted-foreground" />
            {COMPARISONS.map(c => (
              <Button key={c.value} size="sm" variant={comparisonMode === c.value ? 'default' : 'outline'} className="text-xs h-7" onClick={() => updateComparisonMode(c.value)}>
                {c.label}
              </Button>
            ))}
            {loadingComparison && <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />}
          </div>
          <Button size="sm" variant="outline" className="ml-auto gap-1.5 text-xs" onClick={() => generate()} disabled={loading}>
            {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
            Refresh
          </Button>
        </div>

        {/* KPI Cards */}
        {data && (
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
            <KPICard label="Total Revenue" value={data.incomeStatement.revenue.total} icon={DollarSign} delta={comparisonMetrics?.totalRevenue} />
            <KPICard label="Net Income" value={data.incomeStatement.netOperatingIncome} icon={TrendingUp} delta={comparisonMetrics?.netOperatingIncome} />
            <KPICard label="Cash Balance" value={data.cashFlow.closingBalance} icon={Building2} delta={comparisonMetrics?.closingBalance} format="compact" />
            <KPICard label="Facilitated Volume" value={data.facilitatedVolume.totalFacilitatedRentVolume} icon={BarChart3} delta={comparisonMetrics?.totalFacilitatedRentVolume} format="compact" />
            <KPICard label="Active Tenants" value={data.facilitatedVolume.activeTenants} icon={Users} delta={comparisonMetrics?.activeTenants} format="number" />
            <KPICard label="Active Agents" value={data.facilitatedVolume.activeAgents} icon={Users} delta={comparisonMetrics?.activeAgents} format="number" />
          </div>
        )}

        {/* Gross Margin & Operating Margin */}
        {data && (
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <Card className="border-border/50">
              <CardContent className="pt-4 pb-3">
                <p className="text-xs text-muted-foreground">Gross Margin</p>
                <p className="text-2xl font-bold font-mono">
                  {data.incomeStatement.revenue.total > 0
                    ? `${(((data.incomeStatement.revenue.total - data.incomeStatement.serviceDeliveryCosts.total) / data.incomeStatement.revenue.total) * 100).toFixed(1)}%`
                    : '—'}
                </p>
              </CardContent>
            </Card>
            <Card className="border-border/50">
              <CardContent className="pt-4 pb-3">
                <p className="text-xs text-muted-foreground">Operating Margin</p>
                <p className="text-2xl font-bold font-mono">
                  {data.incomeStatement.revenue.total > 0
                    ? `${((data.incomeStatement.netOperatingIncome / data.incomeStatement.revenue.total) * 100).toFixed(1)}%`
                    : '—'}
                </p>
              </CardContent>
            </Card>
            <Card className="border-border/50">
              <CardContent className="pt-4 pb-3">
                <p className="text-xs text-muted-foreground">Capital Utilization</p>
                <p className="text-2xl font-bold font-mono">
                  {data.facilitatedVolume.supporterCapitalDeployed > 0
                    ? `${((data.facilitatedVolume.totalFacilitatedRentVolume / data.facilitatedVolume.supporterCapitalDeployed) * 100).toFixed(1)}%`
                    : '—'}
                </p>
              </CardContent>
            </Card>
          </div>
        )}

        {/* Statement Tabs */}
        {data && (
          <Card>
            <CardHeader className="pb-0">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-[10px] text-muted-foreground uppercase tracking-widest">Welile Technologies Limited</p>
                  <CardTitle className="text-base">
                    {activeTab === 'income' && 'Consolidated Statement of Income'}
                    {activeTab === 'cashflow' && 'Consolidated Statement of Cash Flows'}
                    {activeTab === 'balance' && 'Consolidated Balance Sheet'}
                  </CardTitle>
                </div>
                <div className="flex items-center gap-2">
                  <Badge variant="outline" className="text-[10px]">{data.incomeStatement.period}</Badge>
                  {comparisonMode !== 'none' && comparisonMetrics && (
                    <Badge variant="secondary" className="text-[10px]">
                      {COMPARISONS.find(c => c.value === comparisonMode)?.label}
                    </Badge>
                  )}
                </div>
              </div>
              <p className="text-[10px] text-muted-foreground mt-1">
                (Amounts in {getDynamicCurrencyCode()}, except per-unit data)
              </p>
              <div className="flex gap-1 mt-3">
                {(['income', 'cashflow', 'balance'] as StatementTab[]).map(tab => (
                  <Button
                    key={tab}
                    size="sm"
                    variant={activeTab === tab ? 'default' : 'ghost'}
                    className="text-xs h-8"
                    onClick={() => setActiveTab(tab)}
                  >
                    {tab === 'income' && 'Income Statement'}
                    {tab === 'cashflow' && 'Cash Flow'}
                    {tab === 'balance' && 'Balance Sheet'}
                  </Button>
                ))}
              </div>
            </CardHeader>
            <CardContent className="pt-2">
              {activeTab === 'income' && <IncomeStatement d={data.incomeStatement} cm={comparisonMetrics} />}
              {activeTab === 'cashflow' && <CashFlowStatement d={data.cashFlow} cm={comparisonMetrics} />}
              {activeTab === 'balance' && <BalanceSheetStatement d={data.balanceSheet} />}
            </CardContent>
          </Card>
        )}

        {/* Generated timestamp */}
        {data && (
          <p className="text-xs text-center text-muted-foreground">
            Report generated {format(data.generatedAt, 'MMMM dd, yyyy · HH:mm')} · {data.incomeStatement.period}
          </p>
        )}

        {/* Loading state */}
        {loading && !data && (
          <div className="text-center py-20">
            <Loader2 className="h-8 w-8 animate-spin text-primary mx-auto mb-3" />
            <p className="text-sm text-muted-foreground">Generating financial report…</p>
          </div>
        )}
      </div>
    </div>
  );
}
