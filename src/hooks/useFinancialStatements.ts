import { useState, useCallback } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { startOfDay, endOfDay, subDays, subWeeks, subMonths, subYears, startOfMonth, startOfYear, startOfWeek, startOfQuarter, differenceInDays } from 'date-fns';
import {
  REVENUE_SERVICE_FAMILIES,
  MARKETING_EXPENSE_CATEGORIES,
  MARKETING_LEGACY_DESC_BUCKETS,
  OPERATING_EXPENSE_CATEGORIES,
  OPERATING_LEGACY_DESC_BUCKETS,
  classifyLedgerCategory,
  prettyCategory,
  type ServiceFamilyKey,
} from '@/lib/incomeStatementServiceMap';

/** One traceable line: a single existing ledger category and its period total. */
export interface StatementCategoryLine {
  /** Ledger category (or legacy description bucket) the amount comes from. */
  source: string;
  label: string;
  amount: number;
}

export interface ServiceRevenueFamily {
  key: ServiceFamilyKey | 'other';
  label: string;
  lines: StatementCategoryLine[];
  total: number;
}

export interface ExpenseGroup {
  lines: StatementCategoryLine[];
  total: number;
}

/** Categories that hit the ledger but map to no existing service/expense bucket. */
export interface UnmappedLedgerLine {
  category: string;
  direction: 'cash_in' | 'cash_out';
  amount: number;
}

export interface ServiceIncomeStatement {
  revenueFamilies: ServiceRevenueFamily[];
  totalRevenue: number;
  marketing: ExpenseGroup;
  operating: ExpenseGroup;
  totalMarketingExpenses: number;
  totalOperatingExpenses: number;
  netProfit: number;
  reviewQueue: UnmappedLedgerLine[];
}

export type StatementPeriod = 'today' | '7days' | 'week' | '30days' | 'month' | 'quarter' | 'year' | 'all' | 'custom';
export type ComparisonMode = 'none' | 'dod' | 'wow' | 'mom' | 'yoy';

export interface StatementFilters {
  period: StatementPeriod;
  startDate: Date | null;
  endDate: Date | null;
}

export interface IncomeStatementData {
  period: string;
  /**
   * Dynamically derived, service-based view of the SAME ledger rows used by the
   * classic sections below. Revenue is grouped into the Welile services that
   * actually exist; expenses are split into Marketing vs Operating using only
   * existing ledger categories. Nothing here alters the legacy figures.
   */
  byService: ServiceIncomeStatement;
  revenue: {
    accessFees: number;
    requestFees: number;
    otherServiceIncome: number;
    advanceAccessFeesCollected: number;
    total: number;
  };
  serviceDeliveryCosts: {
    platformRewards: number;
    agentCommissions: number;
    referralBonuses: number;
    agentBonuses: number;
    transactionExpenses: number;
    total: number;
  };
  grossProfit: number;
  grossMargin: number; // percentage
  operatingExpenses: {
    generalOperating: number;
    payrollExpenses: number;
    agentRequisitions: number;
    financialAgentExpenses: number;
    marketingExpenses: number;
    researchDevelopment: number;
    taxExpense: number;
    interestExpense: number;
    equipmentExpense: number;
    operationalSubcategories: {
      salaries: number;
      transport: number;
      food: number;
      officeRent: number;
      internet: number;
      airtime: number;
      stationery: number;
      propertyEquipment: number;
      taxes: number;
      interests: number;
    };
    total: number;
  };
  adjustments: {
    walletDeductions: number;
    systemCorrections: number;
    orphanReassignments: number;
    orphanReversals: number;
    total: number;
  };
  revenueRecognition: {
    expectedAccessFees: number;
    expectedRequestFees: number;
    totalExpectedRevenue: number;
    realizedAccessFees: number;
    realizedRequestFees: number;
    totalRealizedRevenue: number;
    deferredRevenue: number;
    recognitionRate: number;
  };
  // GAAP Below-the-Line Items
  operatingIncome: number; // Revenue - COGS - OpEx
  interestExpense: number;
  interestIncome: number;
  taxProvision: number;
  depreciation: number;
  amortization: number;
  netOperatingIncome: number; // After interest & tax
  ebitda: number;
  ebitdaMargin: number; // percentage
  operatingMargin: number; // percentage
}

export interface CashFlowData {
  period: string;
  operatingActivities: {
    tenantFeesReceived: number;
    otherServiceIncome: number;
    platformRewardsPaid: number;
    agentCommissionsPaid: number;
    agentCommissionWithdrawals: number;
    agentCommissionUsedForRent: number;
    payrollPaid: number;
    agentRequisitionsPaid: number;
    financialAgentExpensesPaid: number;
    marketingPaid: number;
    rdPaid: number;
    operationalSubcatPaid: number;
    withdrawalsPaid: number;
    netOperating: number;
  };
  facilitationActivities: {
    rentRepayments: number;
    rentPrincipalCollected: number;
    agentRepayments: number;
    advanceRepayments: number;
    rentDeployments: number;
    rentDisbursements: number;
    netFacilitation: number;
  };
  custodialActivities: {
    userDeposits: number;
    userWithdrawals: number;
    userTransfers: number;
    walletDeductions: number;
    roiWalletCredits: number;
    agentFloatUsedForRent: number;
    walletCommissionCredits: number;
    walletCorrectionCredits: number;
    walletCorrectionDebits: number;
    rentFloatFunding: number;
    netCustodial: number;
  };
  financingActivities: {
    supporterCapitalInflows: number;
    partnerFunding: number;
    shareCapital: number;
    roiReinvestment: number;
    supporterCapitalWithdrawals: number;
    netFinancing: number;
  };
  netCashMovement: number;
  openingBalance: number;
  closingBalance: number;
}

export interface ARAgingBucket {
  current: number;    // 0-30 days
  days31to60: number;
  days61to90: number;
  over90: number;
  total: number;
  badDebtProvision: number; // estimated allowance
}

export interface WorkingCapitalMetrics {
  currentAssets: number;
  currentLiabilities: number;
  workingCapital: number;
  currentRatio: number;
}

export interface EquityChanges {
  openingEquity: number;
  netIncome: number;
  otherChanges: number;
  closingEquity: number;
}

export interface BalanceSheetData {
  assets: {
    platformCash: number;
    userFundsHeld: number;
    receivables: number;
    rentReceivablesCreated: number;
    advanceAccessFeeReceivables: number;
    promissoryNotesReceivable: number;
    totalAssets: number;
  };
  platformObligations: {
    userWalletCustody: number;
    pendingWithdrawals: number;
    accruedPlatformRewards: number;
    agentCommissionsPayable: number;
    deferredRevenue: number;
    totalObligations: number;
  };
  platformEquity: {
    retainedOperatingSurplus: number;
    totalEquity: number;
  };
  revenueRecognition: {
    expectedRevenue: number;
    realizedRevenue: number;
    deferredRevenue: number;
    recognitionRate: number;
  };
  arAging: ARAgingBucket;
  workingCapital: WorkingCapitalMetrics;
  equityChanges: EquityChanges;
}

export interface FacilitatedVolumeData {
  totalFacilitatedRentVolume: number;
  totalRentRequests: number;
  approvedRequests: number;
  pendingRequests: number;
  totalAccessFeeIncome: number;
  totalRequestFeeIncome: number;
  activeTenants: number;
  activeAgents: number;
  averageRentAmount: number;
  supporterCapitalDeployed: number;
}

export interface DeltaValue {
  current: number;
  previous: number;
  change: number;
  changePercent: number | null;
}

export interface ComparisonMetrics {
  totalRevenue: DeltaValue;
  accessFees: DeltaValue;
  requestFees: DeltaValue;
  otherServiceIncome: DeltaValue;
  advanceAccessFeesCollected: DeltaValue;
  totalServiceCosts: DeltaValue;
  grossProfit: DeltaValue;
  totalOperatingExpenses: DeltaValue;
  operatingIncome: DeltaValue;
  ebitda: DeltaValue;
  netOperatingIncome: DeltaValue;
  netOperatingCash: DeltaValue;
  netFacilitation: DeltaValue;
  netCustodial: DeltaValue;
  netFinancing: DeltaValue;
  netCashMovement: DeltaValue;
  closingBalance: DeltaValue;
  totalFacilitatedRentVolume: DeltaValue;
  approvedRequests: DeltaValue;
  activeTenants: DeltaValue;
  activeAgents: DeltaValue;
}

function computeDelta(current: number, previous: number): DeltaValue {
  const change = current - previous;
  const changePercent = previous !== 0 ? (change / Math.abs(previous)) * 100 : null;
  return { current, previous, change, changePercent };
}

export function buildComparisonMetrics(c: FinancialStatementsData, p: FinancialStatementsData): ComparisonMetrics {
  return {
    totalRevenue: computeDelta(c.incomeStatement.revenue.total, p.incomeStatement.revenue.total),
    accessFees: computeDelta(c.incomeStatement.revenue.accessFees, p.incomeStatement.revenue.accessFees),
    requestFees: computeDelta(c.incomeStatement.revenue.requestFees, p.incomeStatement.revenue.requestFees),
    otherServiceIncome: computeDelta(c.incomeStatement.revenue.otherServiceIncome, p.incomeStatement.revenue.otherServiceIncome),
    advanceAccessFeesCollected: computeDelta(c.incomeStatement.revenue.advanceAccessFeesCollected, p.incomeStatement.revenue.advanceAccessFeesCollected),
    totalServiceCosts: computeDelta(c.incomeStatement.serviceDeliveryCosts.total, p.incomeStatement.serviceDeliveryCosts.total),
    grossProfit: computeDelta(c.incomeStatement.grossProfit, p.incomeStatement.grossProfit),
    totalOperatingExpenses: computeDelta(c.incomeStatement.operatingExpenses.total, p.incomeStatement.operatingExpenses.total),
    operatingIncome: computeDelta(c.incomeStatement.operatingIncome, p.incomeStatement.operatingIncome),
    ebitda: computeDelta(c.incomeStatement.ebitda, p.incomeStatement.ebitda),
    netOperatingIncome: computeDelta(c.incomeStatement.netOperatingIncome, p.incomeStatement.netOperatingIncome),
    netOperatingCash: computeDelta(c.cashFlow.operatingActivities.netOperating, p.cashFlow.operatingActivities.netOperating),
    netFacilitation: computeDelta(c.cashFlow.facilitationActivities.netFacilitation, p.cashFlow.facilitationActivities.netFacilitation),
    netCustodial: computeDelta(c.cashFlow.custodialActivities.netCustodial, p.cashFlow.custodialActivities.netCustodial),
    netFinancing: computeDelta(c.cashFlow.financingActivities.netFinancing, p.cashFlow.financingActivities.netFinancing),
    netCashMovement: computeDelta(c.cashFlow.netCashMovement, p.cashFlow.netCashMovement),
    closingBalance: computeDelta(c.cashFlow.closingBalance, p.cashFlow.closingBalance),
    totalFacilitatedRentVolume: computeDelta(c.facilitatedVolume.totalFacilitatedRentVolume, p.facilitatedVolume.totalFacilitatedRentVolume),
    approvedRequests: computeDelta(c.facilitatedVolume.approvedRequests, p.facilitatedVolume.approvedRequests),
    activeTenants: computeDelta(c.facilitatedVolume.activeTenants, p.facilitatedVolume.activeTenants),
    activeAgents: computeDelta(c.facilitatedVolume.activeAgents, p.facilitatedVolume.activeAgents),
  };
}

/**
 * Read-only reconciliation checks. Everything here is derived from the same
 * `general_ledger` rows the statements are built from — there are no
 * independent totals or manual overrides.
 */
export interface ReconciliationCheck {
  openingCash: number;
  cashIn: number;
  cashOut: number;
  periodNet: number;
  closingCash: number;
  /** Balance-sheet cash as at period end — must equal `closingCash`. */
  balanceSheetCash: number;
  cashDifference: number;
  cashTied: boolean;
  /** Net movement explained by the classified cash-flow sections. */
  classifiedNet: number;
  /** Ledger movement not yet attributed to a cash-flow section. */
  unclassifiedNet: number;
  totalAssets: number;
  totalLiabilities: number;
  totalEquity: number;
  balanceDifference: number;
  balanced: boolean;
}

export interface FinancialStatementsData {
  incomeStatement: IncomeStatementData;
  cashFlow: CashFlowData;
  balanceSheet: BalanceSheetData;
  facilitatedVolume: FacilitatedVolumeData;
  reconciliation: ReconciliationCheck;
  generatedAt: Date;
  filters: StatementFilters;
}

function getPeriodDates(period: StatementPeriod): { start: Date | null; end: Date | null } {
  const now = new Date();
  switch (period) {
    case 'today': return { start: startOfDay(now), end: endOfDay(now) };
    case '7days': return { start: startOfDay(subDays(now, 7)), end: endOfDay(now) };
    case 'week': return { start: startOfWeek(now, { weekStartsOn: 1 }), end: endOfDay(now) };
    case '30days': return { start: startOfDay(subDays(now, 30)), end: endOfDay(now) };
    case 'month': return { start: startOfMonth(now), end: endOfDay(now) };
    case 'quarter': return { start: startOfQuarter(now), end: endOfDay(now) };
    case 'year': return { start: startOfYear(now), end: endOfDay(now) };
    default: return { start: null, end: null };
  }
}

function formatPeriodLabel(filters: StatementFilters): string {
  const { start, end } = getPeriodDates(filters.period);
  const s = filters.startDate || start;
  const e = filters.endDate || end;
  if (!s && !e) return 'All Time';
  const fmt = (d: Date) => d.toLocaleDateString('en-UG', { day: '2-digit', month: 'short', year: 'numeric' });
  if (!s) return `Up to ${fmt(e!)}`;
  if (!e) return `From ${fmt(s)}`;
  return `${fmt(s)} — ${fmt(e)}`;
}

// Standalone generation function (no React state) — used for comparison periods
async function generateStatementsRaw(activeFilters: StatementFilters): Promise<FinancialStatementsData> {
      const { start, end } = getPeriodDates(activeFilters.period);
      const startDate = activeFilters.startDate || start;
      const endDate = activeFilters.endDate || end;

      // ── Ledger legs are aggregated ON THE SERVER ────────────────────────────
      // Previously this hook paged ~400k `general_ledger` rows into the browser
      // (5k-row pages with deep OFFSETs), which reliably tripped the Postgres
      // statement timeout and returned HTTP 500. `get_financial_statement_ledger_sums`
      // returns the exact same money, pre-summed per
      // (period, ledger_scope, direction, category, legacy description bucket).
      // We rehydrate one synthetic row per group so every downstream
      // `sumBy` / `sumByDescriptionMatch` / total calculation below is untouched
      // and produces byte-identical figures.
      interface LedgerSumRow {
        period: string;
        ledger_scope: string;
        direction: string;
        category: string;
        desc_bucket: string | null;
        amount: number | string;
      }

      const { data: sumRowsRaw, error: sumsError } = await supabase.rpc(
        'get_financial_statement_ledger_sums',
        {
          p_start: startDate ? startDate.toISOString() : null,
          p_end: endDate ? endDate.toISOString() : null,
        } as any,
      );
      if (sumsError) throw sumsError;
      const sumRows = ((sumRowsRaw || []) as unknown as LedgerSumRow[]).map(r => ({
        amount: Number(r.amount) || 0,
        direction: r.direction,
        category: r.category,
        ledger_scope: r.ledger_scope,
        description: r.desc_bucket ?? null,
        period: r.period,
      }));

      const scopedRows = (scope: 'platform' | 'wallet' | 'bridge', direction: 'cash_in' | 'cash_out') =>
        sumRows.filter(r => r.period === 'current' && r.ledger_scope === scope && r.direction === direction);

      const platformIn = scopedRows('platform', 'cash_in');
      const platformOut = scopedRows('platform', 'cash_out');
      const walletIn = scopedRows('wallet', 'cash_in');
      const walletOut = scopedRows('wallet', 'cash_out');
      const bridgeIn = scopedRows('bridge', 'cash_in');
      const bridgeOut = scopedRows('bridge', 'cash_out');
      const prevPlatform = sumRows.filter(r => r.period === 'prior');

      const [
        walletsRes, rentRequestsRes, advancesRes,
        allTimePlatformRes, promissoryNotesRes,
      ] = await Promise.all([
        supabase.rpc('get_wallet_totals'),
        supabase.from('rent_requests').select('id, rent_amount, access_fee, request_fee, status, tenant_id, agent_id, created_at').limit(10000),
        supabase.from('agent_advances').select('access_fee, access_fee_collected, access_fee_status, status').in('status', ['active', 'overdue']),
        supabase.rpc('get_platform_cash_summary'),
        supabase.from('promissory_notes').select('amount, total_collected, status').in('status', ['pending', 'activated']),
      ]);

      const walletTotalsData = walletsRes.data as any;
      const wallets = [{ balance: Number(walletTotalsData?.total_balance ?? 0) }];
      const rentRequests = rentRequestsRes.data || [];
      const activeAdvances = advancesRes.data || [];
      const allTimePlatformSummary = allTimePlatformRes.data as any;
      const promissoryNotes = promissoryNotesRes.data || [];

      const excludeSynthetic = (rows: any[]) => rows.filter(r => r.category !== 'opening_balance');
      const sumBy = (rows: any[], cats: string[]) =>
        excludeSynthetic(rows).filter(r => cats.includes(r.category)).reduce((s, r) => s + Number(r.amount), 0);
      const sumWithDirectionFallback = (
        preferredRows: any[], fallbackRows: any[], categories: string[],
      ) => {
        return categories.reduce((total, cat) => {
          const preferred = sumBy(preferredRows, [cat]);
          return total + (preferred > 0 ? preferred : sumBy(fallbackRows, [cat]));
        }, 0);
      };

      // ══════════════════════════════════════════════════════════════
      // INCOME STATEMENT — Platform scope ONLY (earned revenue & costs)
      // ══════════════════════════════════════════════════════════════
      const accessFees = sumWithDirectionFallback(platformIn, platformOut, ['tenant_access_fee', 'access_fee', 'access_fee_collected']);
      const requestFees = sumWithDirectionFallback(platformIn, platformOut, ['tenant_request_fee', 'request_fee', 'registration_fee_collected']);
      const otherServiceIncome = sumWithDirectionFallback(platformIn, platformOut, ['platform_service_income', 'landlord_platform_fee', 'management_fee']);
      const platformRewards = sumWithDirectionFallback(platformOut, platformIn, ['supporter_platform_rewards', 'supporter_reward', 'investment_reward', 'roi_payout', 'roi_expense']);
      // Agent commissions = direct payouts only. `agent_commission_earned` (which
      // includes the auto-paid UGX 5,000 listing bonus) is reclassified below as
      // a TRANSACTION EXPENSE — it is a per-event platform cost of acquiring a
      // listing, not a revenue-share commission. It is NEVER counted as revenue.
      const agentCommissions = sumWithDirectionFallback(platformOut, platformIn, ['agent_commission_payout', 'agent_commission', 'agent_payout', 'agent_approval_bonus']);
      // Referral & agent bonuses (production + legacy)
      const referralBonuses = sumBy(walletIn, ['referral_bonus']) + sumBy(platformOut, ['referral_bonus']);
      const agentBonuses = sumBy(walletIn, ['agent_bonus']) + sumBy(platformOut, ['agent_bonus']);
      const totalIncentiveCosts = referralBonuses + agentBonuses;
      // Transaction expenses = per-transaction platform costs. Includes listing
      // bonuses (posted under `agent_commission_earned` by credit-listing-bonus)
      // alongside the dedicated `transaction_platform_expenses` bucket.
      const transactionExpenses = sumWithDirectionFallback(platformOut, platformIn, ['transaction_platform_expenses', 'agent_commission_earned']);
      const generalOperating = sumWithDirectionFallback(platformOut, platformIn, ['operational_expenses', 'platform_expense']);
      const payrollExpenses = sumWithDirectionFallback(platformOut, platformIn, ['salary_payment', 'employee_advance', 'payroll_expense']);
      const agentRequisitions = sumWithDirectionFallback(platformOut, platformIn, ['agent_requisition']);
      const financialAgentExpenses = sumWithDirectionFallback(platformOut, platformIn, ['platform_expense_disbursement']);

      // ── GAAP Expense Categories (proper ledger categories) ──
      const marketingExpenseCat = sumWithDirectionFallback(platformOut, platformIn, ['marketing_expense']);
      const generalAdminCat = sumWithDirectionFallback(platformOut, platformIn, ['general_admin_expense']);
      const researchDevCat = sumWithDirectionFallback(platformOut, platformIn, ['research_development_expense']);
      const taxExpenseCat = sumWithDirectionFallback(platformOut, platformIn, ['tax_expense']);
      const interestExpenseCat = sumWithDirectionFallback(platformOut, platformIn, ['interest_expense']);
      const equipmentExpenseCat = sumWithDirectionFallback(platformOut, platformIn, ['equipment_expense']);

      // Legacy expenses captured (description-based for historical data)
      const legacyMarketingExpense = sumBy(walletOut, ['marketing_expense']) + sumBy(platformOut, ['marketing_expense']);
      const tenantDefaultCharges = sumBy(walletOut, ['tenant_default_charge']);
      const debtClearance = sumBy(walletOut, ['debt_clearance']);

      // Legacy subcategory matching for old system_balance_correction entries
      const sumByDescriptionMatch = (rows: any[], pattern: string) =>
        excludeSynthetic(rows)
          .filter(r => r.category === 'system_balance_correction' && r.description && r.description.toLowerCase().includes(pattern.toLowerCase()))
          .reduce((s, r) => s + Number(r.amount), 0);

      const legacyMarketingDesc = sumByDescriptionMatch(walletIn, 'Marketing Expenses');
      const legacyRnDDesc = sumByDescriptionMatch(walletIn, 'Research & Development');
      const opSubSalaries = sumByDescriptionMatch(walletIn, '→ Salaries') || sumByDescriptionMatch(platformOut, '→ Salaries');
      const opSubTransport = sumByDescriptionMatch(walletIn, '→ Transport') || sumByDescriptionMatch(platformOut, '→ Transport');
      const opSubFood = sumByDescriptionMatch(walletIn, '→ Food') || sumByDescriptionMatch(platformOut, '→ Food');
      const opSubOfficeRent = sumByDescriptionMatch(walletIn, '→ Office Rent') || sumByDescriptionMatch(platformOut, '→ Office Rent');
      const opSubInternet = sumByDescriptionMatch(walletIn, '→ Internet') || sumByDescriptionMatch(platformOut, '→ Internet');
      const opSubAirtime = sumByDescriptionMatch(walletIn, '→ Airtime') || sumByDescriptionMatch(platformOut, '→ Airtime');
      const opSubStationery = sumByDescriptionMatch(walletIn, '→ Stationery') || sumByDescriptionMatch(platformOut, '→ Stationery');
      const opSubPropertyEquipment = sumByDescriptionMatch(walletIn, '→ Property & Equipment') || sumByDescriptionMatch(platformOut, '→ Property & Equipment');
      const opSubTaxes = sumByDescriptionMatch(walletIn, '→ Taxes') || sumByDescriptionMatch(platformOut, '→ Taxes');
      const opSubInterests = sumByDescriptionMatch(walletIn, '→ Interests') || sumByDescriptionMatch(platformOut, '→ Interests');

      // Combined totals: proper category + legacy description-based
      const totalMarketingExpense = marketingExpenseCat + legacyMarketingExpense + legacyMarketingDesc;
      const totalGeneralAdmin = generalAdminCat + generalOperating + opSubTransport + opSubFood + opSubOfficeRent + opSubInternet + opSubAirtime + opSubStationery;
      const totalPayroll = payrollExpenses + opSubSalaries;
      const totalRnD = researchDevCat + legacyRnDDesc;
      const totalTaxExpense = taxExpenseCat + opSubTaxes;
      const totalInterestExpense = interestExpenseCat + opSubInterests;
      const totalEquipmentExpense = equipmentExpenseCat + opSubPropertyEquipment;

      const operatingExpensesTotal = totalMarketingExpense + totalGeneralAdmin + totalPayroll + totalRnD + totalTaxExpense + totalInterestExpense + totalEquipmentExpense + agentRequisitions + financialAgentExpenses + transactionExpenses + tenantDefaultCharges + debtClearance;

      const advanceAccessFeesCollected = activeAdvances.reduce((s: number, a: any) => s + Number(a.access_fee_collected || 0), 0);

      const totalRevenue = accessFees + requestFees + otherServiceIncome + advanceAccessFeesCollected;
      const totalServiceCosts = platformRewards + agentCommissions + totalIncentiveCosts + transactionExpenses;

      // ── GAAP: Gross Profit ──
      const grossProfit = totalRevenue - totalServiceCosts;
      const grossMargin = totalRevenue > 0 ? (grossProfit / totalRevenue) * 100 : 0;

      // ── Revenue Recognition: Expected vs Realized vs Deferred ──
      const activeRentRequests = rentRequests.filter(r => ['approved', 'funded', 'disbursed', 'repaying'].includes(r.status));
      const expectedAccessFees = activeRentRequests.reduce((s, r) => s + Number(r.access_fee || 0), 0);
      const expectedRequestFees = activeRentRequests.reduce((s, r) => s + Number(r.request_fee || 0), 0);
      const totalExpectedRevenue = expectedAccessFees + expectedRequestFees;
      const realizedAccessFees = accessFees + advanceAccessFeesCollected;
      const realizedRequestFees = requestFees;
      const totalRealizedRevenue = realizedAccessFees + realizedRequestFees;
      const deferredRevenue = Math.max(0, totalExpectedRevenue - totalRealizedRevenue);
      const recognitionRate = totalExpectedRevenue > 0 ? (totalRealizedRevenue / totalExpectedRevenue) * 100 : 0;

      // ── Adjustments (non-revenue, non-expense items that affect net income) ──
      const walletDeductions = sumWithDirectionFallback(platformIn, walletOut, ['wallet_deduction']);
      const systemCorrections = sumWithDirectionFallback(platformIn, platformOut, ['system_balance_correction'])
        - (legacyMarketingDesc + legacyRnDDesc + opSubSalaries + opSubTransport + opSubFood + opSubOfficeRent + opSubInternet + opSubAirtime + opSubStationery + opSubPropertyEquipment + opSubTaxes + opSubInterests);
      const orphanReassignments = sumBy(platformIn, ['orphan_reassignment']);
      const orphanReversals = sumBy(platformOut, ['orphan_reversal']);
      const adjustmentsTotal = walletDeductions + Math.max(0, systemCorrections) - orphanReversals + orphanReassignments;

      // ── GAAP: Below-the-Line Items ──
      // Interest: from proper category + legacy subcategories
      const interestExpense = totalInterestExpense;
      const interestIncome = 0; // No interest income streams yet
      // Tax: from proper category + legacy subcategories
      const taxProvision = totalTaxExpense;
      // D&A: Equipment category + legacy Property & Equipment as depreciation proxy
      const depreciation = totalEquipmentExpense;
      const amortization = 0; // No software amortization tracked separately yet

      // Operating Income = Gross Profit - OpEx (excluding interest, tax, D&A)
      const opExExcludingITDA = operatingExpensesTotal - interestExpense - taxProvision - depreciation - amortization;
      const operatingIncome = grossProfit - opExExcludingITDA + adjustmentsTotal;

      // Net Income = Operating Income - Interest - Tax
      const netOperatingIncome = operatingIncome - interestExpense + interestIncome - taxProvision;

      // EBITDA = Operating Income + D&A (already excludes interest & tax)
      const ebitda = operatingIncome + depreciation + amortization;
      const ebitdaMargin = totalRevenue > 0 ? (ebitda / totalRevenue) * 100 : 0;
      const operatingMargin = totalRevenue > 0 ? (operatingIncome / totalRevenue) * 100 : 0;

      // ══════════════════════════════════════════════════════════════
      // CASH FLOW — All categories tracked
      // ══════════════════════════════════════════════════════════════

      // Operating (platform scope)
      const tenantFeesReceived = accessFees + requestFees;
      const agentCommissionWithdrawals = sumBy(walletOut, ['agent_commission_withdrawal']);
      const agentCommissionUsedForRent = sumBy(walletOut, ['agent_commission_used_for_rent']);
      const payrollPaid = payrollExpenses;
      const agentRequisitionsPaid = agentRequisitions;
      const financialAgentExpensesPaid = financialAgentExpenses;
      const marketingPaid = totalMarketingExpense;
      const rdPaid = totalRnD;
      const operationalSubcatPaid = opSubSalaries + opSubTransport + opSubFood + opSubOfficeRent + opSubInternet + opSubAirtime + opSubStationery + opSubPropertyEquipment + opSubTaxes + opSubInterests;
      const withdrawalsPaid = generalOperating + transactionExpenses;
      const netOperating = tenantFeesReceived + otherServiceIncome - platformRewards - agentCommissions - payrollPaid - agentRequisitionsPaid - financialAgentExpensesPaid - marketingPaid - rdPaid - operationalSubcatPaid - withdrawalsPaid;

      // Facilitation Activities
      const rentRepayments = sumWithDirectionFallback(platformIn, platformOut, ['rent_repayment', 'loan_repayment', 'tenant_repayment']);
      const rentPrincipalCollected = sumBy(platformIn, ['rent_principal_collected']) + sumBy(walletIn, ['rent_principal_collected']);
      const agentRepayments = sumBy(platformIn, ['agent_repayment']);
      const advanceRepayments = sumBy(walletOut, ['advance_repayment', 'credit_access_repayment']);
      const rentDeployments = sumBy(platformOut, ['pool_rent_deployment', 'rent_facilitation_payout']);
      const rentDisbursements = sumBy(platformOut, ['rent_disbursement']);
      const netFacilitation = rentRepayments + rentPrincipalCollected + agentRepayments + advanceRepayments - rentDeployments - rentDisbursements;

      // Custodial (wallet scope) — includes all legacy wallet categories
      const userDeposits = sumBy(walletIn, ['deposit', 'wallet_deposit', 'agent_float_deposit', 'pending_portfolio_topup']);
      const userWithdrawals = sumBy(walletOut, ['wallet_withdrawal']);
      const userTransfers = sumBy(walletOut, ['wallet_transfer']);
      const cfWalletDeductions = sumBy(walletOut, ['wallet_deduction']);
      const roiWalletCredits = sumBy(walletIn, ['roi_wallet_credit', 'roi_payout']);
      const agentFloatUsedForRent = sumBy(walletOut, ['agent_float_used_for_rent']);
      const walletCommissionCredits = sumBy(walletIn, ['agent_commission_earned', 'agent_commission', 'referral_bonus', 'agent_bonus', 'agent_investment_commission', 'account_merge']);
      const walletCorrectionCredits = sumBy(walletIn, ['system_balance_correction']);
      const walletCorrectionDebits = sumBy(walletOut, ['system_balance_correction']);
      const walletRentDisbursements = sumBy(walletOut, ['rent_disbursement']);
      const walletRoiExpense = sumBy(walletOut, ['roi_expense', 'roi_payout']);
      const rentFloatFunding = sumBy(walletIn, ['rent_float_funding', 'landlord_rent_payment', 'pool_capital_received', 'pool_rent_deployment_reversal', 'rent_obligation_reversal', 'coo_proxy_investment_reversal', 'proxy_investment_commission', 'platform_expense']);
      const walletRepaymentInflows = sumBy(walletIn, ['agent_repayment', 'supporter_rent_fund', 'agent_proxy_investment', 'roi_reinvestment']);
      // Legacy investment/deployment outflows
      const legacyInvestmentOutflows = sumBy(walletOut, ['agent_proxy_investment', 'coo_proxy_investment', 'supporter_rent_fund', 'wallet_to_investment', 'angel_pool_investment', 'rent_payment_for_tenant', 'rent_obligation', 'proxy_partner_withdrawal', 'rent_obligation_reversal_adjustment', 'rent_float_funding', 'pending_portfolio_topup']);
      const netCustodial = userDeposits + roiWalletCredits + walletCommissionCredits + walletCorrectionCredits + rentFloatFunding + walletRepaymentInflows - userWithdrawals - userTransfers - cfWalletDeductions - agentFloatUsedForRent - walletCorrectionDebits - walletRentDisbursements - walletRoiExpense - legacyInvestmentOutflows;

      // Financing (bridge scope)
      const supporterCapitalInflows = sumBy(bridgeIn, ['supporter_facilitation_capital', 'supporter_deposit', 'investment_deposit']);
      const partnerFunding = sumBy(bridgeIn, ['partner_funding']);
      const shareCapital = sumBy(bridgeIn, ['share_capital']);
      const roiReinvestment = sumBy(bridgeIn, ['roi_reinvestment']);
      const supporterCapitalWithdrawals = sumBy(bridgeOut, ['supporter_withdrawal', 'investment_withdrawal']);
      const agentCommissionBridge = sumBy(bridgeOut, ['agent_commission']);
      const netFinancing = supporterCapitalInflows + partnerFunding + shareCapital + roiReinvestment - supporterCapitalWithdrawals - agentCommissionBridge;

      const netCashMovement = netOperating + netFacilitation + netCustodial + netFinancing;
      const openingBalance = prevPlatform.reduce(
        (s, r) => r.direction === 'cash_in' ? s + Number(r.amount) : s - Number(r.amount), 0
      );
      // Ledger-true cash movement for the period: every platform-scope leg,
      // nothing classified or excluded. This is what makes the closing cash on
      // the cash flow statement tie exactly to the balance sheet.
      const periodCashIn = platformIn.reduce((s, r) => s + Number(r.amount), 0);
      const periodCashOut = platformOut.reduce((s, r) => s + Number(r.amount), 0);
      const periodCashNet = periodCashIn - periodCashOut;
      const closingBalance = openingBalance + periodCashNet;

      // ══════════════════════════════════════════════════════════════
      // BALANCE SHEET
      // ══════════════════════════════════════════════════════════════
      // Balance-sheet cash IS the cash flow closing balance (same ledger legs),
      // so `Closing cash == Balance sheet cash` holds for every period.
      const platformCash = closingBalance;

      const userFundsHeld = (wallets || []).reduce((s, w) => s + (w.balance || 0), 0);

      const outstandingRent = rentRequests
        .filter(r => ['funded', 'disbursed', 'repaying'].includes(r.status))
        .reduce((s, r) => s + Number(r.rent_amount || 0), 0);

      // Rent Receivables Created (bridge/platform scope)
      const rentReceivablesCreated = sumBy(bridgeIn, ['rent_receivable_created']);

      const advanceAccessFeeReceivables = activeAdvances.reduce((s: number, a: any) =>
        s + (Number(a.access_fee || 0) - Number(a.access_fee_collected || 0)), 0);

      const promissoryNotesReceivable = promissoryNotes.reduce((s: number, n: any) =>
        s + (Number(n.amount || 0) - Number(n.total_collected || 0)), 0);

      const totalAssets = platformCash + userFundsHeld + outstandingRent + rentReceivablesCreated + advanceAccessFeeReceivables + promissoryNotesReceivable;

      const userWalletCustody = userFundsHeld;
      const pendingWithdrawals = sumBy(platformOut, ['wallet_withdrawal']) * 0.1;
      const accruedPlatformRewards = platformRewards * 0.1;
      const agentCommissionsPayable = agentCommissions * 0.05;
      const totalObligations = userWalletCustody + pendingWithdrawals + accruedPlatformRewards + agentCommissionsPayable + deferredRevenue;

      const retainedOperatingSurplus = totalAssets - totalObligations;

      // ── GAAP: AR Aging ──
      const now = new Date();
      const arCurrent = rentRequests
        .filter(r => ['funded', 'disbursed', 'repaying'].includes(r.status))
        .reduce((s, r) => {
          const daysSince = Math.floor((now.getTime() - new Date(r.created_at).getTime()) / (1000 * 60 * 60 * 24));
          return daysSince <= 30 ? s + Number(r.rent_amount || 0) : s;
        }, 0);
      const arDays31to60 = rentRequests
        .filter(r => ['funded', 'disbursed', 'repaying'].includes(r.status))
        .reduce((s, r) => {
          const daysSince = Math.floor((now.getTime() - new Date(r.created_at).getTime()) / (1000 * 60 * 60 * 24));
          return daysSince > 30 && daysSince <= 60 ? s + Number(r.rent_amount || 0) : s;
        }, 0);
      const arDays61to90 = rentRequests
        .filter(r => ['funded', 'disbursed', 'repaying'].includes(r.status))
        .reduce((s, r) => {
          const daysSince = Math.floor((now.getTime() - new Date(r.created_at).getTime()) / (1000 * 60 * 60 * 24));
          return daysSince > 60 && daysSince <= 90 ? s + Number(r.rent_amount || 0) : s;
        }, 0);
      const arOver90 = rentRequests
        .filter(r => ['funded', 'disbursed', 'repaying'].includes(r.status))
        .reduce((s, r) => {
          const daysSince = Math.floor((now.getTime() - new Date(r.created_at).getTime()) / (1000 * 60 * 60 * 24));
          return daysSince > 90 ? s + Number(r.rent_amount || 0) : s;
        }, 0);
      const arTotal = arCurrent + arDays31to60 + arDays61to90 + arOver90;
      // Bad debt provision: 0% current, 5% 31-60, 15% 61-90, 50% 90+
      const badDebtProvision = arDays31to60 * 0.05 + arDays61to90 * 0.15 + arOver90 * 0.50;

      // ── GAAP: Working Capital ──
      const currentAssets = platformCash + userFundsHeld + outstandingRent + advanceAccessFeeReceivables;
      const currentLiabilities = userWalletCustody + pendingWithdrawals + accruedPlatformRewards + agentCommissionsPayable + deferredRevenue;
      const workingCapitalAmount = currentAssets - currentLiabilities;
      const currentRatio = currentLiabilities > 0 ? currentAssets / currentLiabilities : 0;

      // ── GAAP: Statement of Changes in Equity ──
      const openingEquity = Math.max(0, openingBalance); // approximate
      const equityNetIncome = netOperatingIncome;
      const closingEquity = retainedOperatingSurplus;

      // ── FACILITATED VOLUME ──
      const approvedRequests = rentRequests.filter(r => ['approved', 'funded', 'disbursed', 'repaying'].includes(r.status));
      const pendingRequestsList = rentRequests.filter(r => r.status === 'pending');
      const totalFacilitatedRentVolume = approvedRequests.reduce((s, r) => s + Number(r.rent_amount), 0);
      const totalAccessFeeIncome = approvedRequests.reduce((s, r) => s + Number(r.access_fee || 0), 0);
      const totalRequestFeeIncome = approvedRequests.reduce((s, r) => s + Number(r.request_fee || 0), 0);
      const uniqueTenants = new Set(rentRequests.map(r => r.tenant_id)).size;
      const uniqueAgents = new Set(rentRequests.filter(r => r.agent_id).map(r => r.agent_id)).size;
      const averageRentAmount = approvedRequests.length > 0 ? totalFacilitatedRentVolume / approvedRequests.length : 0;
      const supporterCapitalDeployed = sumBy(bridgeIn, ['supporter_facilitation_capital', 'supporter_deposit', 'investment_deposit']);

      // ══════════════════════════════════════════════════════════════
      // SERVICE-BASED INCOME STATEMENT (dynamic, same ledger rows)
      // ══════════════════════════════════════════════════════════════
      const line = (source: string, amount: number): StatementCategoryLine => ({
        source,
        label: prettyCategory(source),
        amount,
      });

      const revenueFamilies: ServiceRevenueFamily[] = REVENUE_SERVICE_FAMILIES.map(fam => {
        const lines: StatementCategoryLine[] = [];
        fam.categories.forEach(cat => {
          const amount = sumWithDirectionFallback(platformIn, platformOut, [cat]);
          if (amount > 0) lines.push(line(cat, amount));
        });
        // Agent advance access fees are an existing Welile agent service whose
        // collected amount is tracked on `agent_advances` (access_fee_collected).
        if (fam.key === 'agent' && advanceAccessFeesCollected > 0) {
          lines.push({
            source: 'agent_advances.access_fee_collected',
            label: 'Advance Access Fees Collected',
            amount: advanceAccessFeesCollected,
          });
        }
        return {
          key: fam.key,
          label: fam.label,
          lines,
          total: lines.reduce((s, l) => s + l.amount, 0),
        };
      }).filter(f => f.lines.length > 0);

      const serviceTotalRevenue = revenueFamilies.reduce((s, f) => s + f.total, 0);

      const buildExpenseGroup = (
        categories: string[],
        legacyBuckets: string[],
      ): ExpenseGroup => {
        const lines: StatementCategoryLine[] = [];
        categories.forEach(cat => {
          const amount = sumWithDirectionFallback(platformOut, platformIn, [cat]);
          if (amount > 0) lines.push(line(cat, amount));
        });
        legacyBuckets.forEach(bucket => {
          const amount =
            sumByDescriptionMatch(walletIn, bucket) || sumByDescriptionMatch(platformOut, bucket);
          if (amount > 0) {
            lines.push({
              source: `system_balance_correction · ${bucket}`,
              label: bucket.replace('→ ', ''),
              amount,
            });
          }
        });
        return { lines, total: lines.reduce((s, l) => s + l.amount, 0) };
      };

      const marketingGroup = buildExpenseGroup(MARKETING_EXPENSE_CATEGORIES, MARKETING_LEGACY_DESC_BUCKETS);
      const operatingGroup = buildExpenseGroup(OPERATING_EXPENSE_CATEGORIES, OPERATING_LEGACY_DESC_BUCKETS);

      // Anything on the platform ledger that maps to no existing service or
      // accounting bucket is flagged — never absorbed into a total.
      const reviewQueue: UnmappedLedgerLine[] = (() => {
        const acc = new Map<string, UnmappedLedgerLine>();
        [...platformIn, ...platformOut].forEach(r => {
          if (r.category === 'opening_balance') return;
          if (classifyLedgerCategory(r.category).kind !== 'unmapped') return;
          const dir = r.direction === 'cash_in' ? 'cash_in' : 'cash_out';
          const key = `${r.category}|${dir}`;
          const existing = acc.get(key);
          if (existing) existing.amount += Number(r.amount) || 0;
          else acc.set(key, { category: r.category, direction: dir, amount: Number(r.amount) || 0 });
        });
        return Array.from(acc.values())
          .filter(l => l.amount !== 0)
          .sort((a, b) => b.amount - a.amount);
      })();

      const serviceNetProfit = serviceTotalRevenue - marketingGroup.total - operatingGroup.total;

      const result: FinancialStatementsData = {
        generatedAt: new Date(),
        filters: activeFilters,
        incomeStatement: {
          period: formatPeriodLabel(activeFilters),
          byService: {
            revenueFamilies,
            totalRevenue: serviceTotalRevenue,
            marketing: marketingGroup,
            operating: operatingGroup,
            totalMarketingExpenses: marketingGroup.total,
            totalOperatingExpenses: operatingGroup.total,
            netProfit: serviceNetProfit,
            reviewQueue,
          },
          revenue: { accessFees, requestFees, otherServiceIncome, advanceAccessFeesCollected, total: totalRevenue },
          serviceDeliveryCosts: { platformRewards, agentCommissions, referralBonuses, agentBonuses, transactionExpenses, total: totalServiceCosts },
          grossProfit,
          grossMargin,
          operatingExpenses: {
            generalOperating: totalGeneralAdmin, payrollExpenses: totalPayroll, agentRequisitions, financialAgentExpenses,
            marketingExpenses: totalMarketingExpense, researchDevelopment: totalRnD,
            taxExpense: totalTaxExpense, interestExpense: totalInterestExpense, equipmentExpense: totalEquipmentExpense,
            operationalSubcategories: {
              salaries: opSubSalaries, transport: opSubTransport, food: opSubFood,
              officeRent: opSubOfficeRent, internet: opSubInternet, airtime: opSubAirtime,
              stationery: opSubStationery, propertyEquipment: opSubPropertyEquipment,
              taxes: opSubTaxes, interests: opSubInterests,
            },
            total: operatingExpensesTotal,
          },
          adjustments: {
            walletDeductions,
            systemCorrections: Math.max(0, systemCorrections),
            orphanReassignments,
            orphanReversals,
            total: adjustmentsTotal,
          },
          revenueRecognition: {
            expectedAccessFees, expectedRequestFees, totalExpectedRevenue,
            realizedAccessFees, realizedRequestFees, totalRealizedRevenue,
            deferredRevenue, recognitionRate,
          },
          operatingIncome,
          interestExpense,
          interestIncome,
          taxProvision,
          depreciation,
          amortization,
          netOperatingIncome,
          ebitda,
          ebitdaMargin,
          operatingMargin,
        },
        cashFlow: {
          period: formatPeriodLabel(activeFilters),
          operatingActivities: {
            tenantFeesReceived, otherServiceIncome, platformRewardsPaid: platformRewards,
            agentCommissionsPaid: agentCommissions, agentCommissionWithdrawals, agentCommissionUsedForRent: agentCommissionUsedForRent,
            payrollPaid, agentRequisitionsPaid, financialAgentExpensesPaid,
            marketingPaid, rdPaid, operationalSubcatPaid, withdrawalsPaid, netOperating,
          },
          facilitationActivities: {
            rentRepayments, rentPrincipalCollected, agentRepayments, advanceRepayments,
            rentDeployments, rentDisbursements, netFacilitation,
          },
          custodialActivities: {
            userDeposits, userWithdrawals, userTransfers,
            walletDeductions: cfWalletDeductions, roiWalletCredits,
            agentFloatUsedForRent, walletCommissionCredits,
            walletCorrectionCredits, walletCorrectionDebits,
            rentFloatFunding, netCustodial,
          },
          financingActivities: {
            supporterCapitalInflows, partnerFunding, shareCapital,
            roiReinvestment, supporterCapitalWithdrawals, netFinancing,
          },
          netCashMovement,
          openingBalance,
          closingBalance,
        },
        balanceSheet: {
          assets: {
            platformCash, userFundsHeld, receivables: outstandingRent, rentReceivablesCreated,
            advanceAccessFeeReceivables, promissoryNotesReceivable, totalAssets,
          },
          platformObligations: { userWalletCustody, pendingWithdrawals, accruedPlatformRewards, agentCommissionsPayable, deferredRevenue, totalObligations },
          platformEquity: { retainedOperatingSurplus, totalEquity: retainedOperatingSurplus },
          revenueRecognition: {
            expectedRevenue: totalExpectedRevenue,
            realizedRevenue: totalRealizedRevenue,
            deferredRevenue,
            recognitionRate,
          },
          arAging: {
            current: arCurrent,
            days31to60: arDays31to60,
            days61to90: arDays61to90,
            over90: arOver90,
            total: arTotal,
            badDebtProvision,
          },
          workingCapital: {
            currentAssets,
            currentLiabilities,
            workingCapital: workingCapitalAmount,
            currentRatio,
          },
          equityChanges: {
            openingEquity,
            netIncome: equityNetIncome,
            otherChanges: 0,
            closingEquity,
          },
        },
        facilitatedVolume: {
          totalFacilitatedRentVolume,
          totalRentRequests: rentRequests.length,
          approvedRequests: approvedRequests.length,
          pendingRequests: pendingRequestsList.length,
          totalAccessFeeIncome,
          totalRequestFeeIncome,
          activeTenants: uniqueTenants,
          activeAgents: uniqueAgents,
          averageRentAmount,
          supporterCapitalDeployed,
        },
        reconciliation: {
          openingCash: openingBalance,
          cashIn: periodCashIn,
          cashOut: periodCashOut,
          periodNet: periodCashNet,
          closingCash: closingBalance,
          balanceSheetCash: platformCash,
          cashDifference: closingBalance - platformCash,
          cashTied: Math.abs(closingBalance - platformCash) < 1,
          classifiedNet: netCashMovement,
          unclassifiedNet: periodCashNet - netCashMovement,
          totalAssets,
          totalLiabilities: totalObligations,
          totalEquity: retainedOperatingSurplus,
          balanceDifference: totalAssets - (totalObligations + retainedOperatingSurplus),
          balanced: Math.abs(totalAssets - (totalObligations + retainedOperatingSurplus)) < 1,
        },
      };

      return result;
}

function getPreviousPeriodDates(
  currentStart: Date,
  currentEnd: Date,
  mode: ComparisonMode
): { start: Date; end: Date } {
  switch (mode) {
    case 'dod': return { start: subDays(currentStart, 1), end: subDays(currentEnd, 1) };
    case 'wow': return { start: subWeeks(currentStart, 1), end: subWeeks(currentEnd, 1) };
    case 'mom': return { start: subMonths(currentStart, 1), end: subMonths(currentEnd, 1) };
    case 'yoy': return { start: subYears(currentStart, 1), end: subYears(currentEnd, 1) };
    default: {
      const days = differenceInDays(currentEnd, currentStart);
      return { start: subDays(currentStart, days + 1), end: subDays(currentStart, 1) };
    }
  }
}

function getResolvedDates(filters: StatementFilters): { start: Date | null; end: Date | null } {
  if (filters.startDate && filters.endDate) return { start: filters.startDate, end: filters.endDate };
  return getPeriodDates(filters.period);
}

export function useFinancialStatements() {
  const [loading, setLoading] = useState(false);
  const [data, setData] = useState<FinancialStatementsData | null>(null);
  const [previousData, setPreviousData] = useState<FinancialStatementsData | null>(null);
  const [comparisonMode, setComparisonMode] = useState<ComparisonMode>('none');
  const [loadingComparison, setLoadingComparison] = useState(false);
  const [filters, setFilters] = useState<StatementFilters>({
    period: '30days',
    startDate: null,
    endDate: null,
  });

  const generate = useCallback(async (overrideFilters?: StatementFilters, overrideComparison?: ComparisonMode) => {
    const activeFilters = overrideFilters || filters;
    const activeComparison = overrideComparison ?? comparisonMode;
    setLoading(true);

    try {
      const result = await generateStatementsRaw(activeFilters);
      setData(result);

      // Generate comparison period if needed
      if (activeComparison !== 'none') {
        const { start, end } = getResolvedDates(activeFilters);
        if (start && end) {
          setLoadingComparison(true);
          try {
            const prevDates = getPreviousPeriodDates(start, end, activeComparison);
            const prevFilters: StatementFilters = {
              period: 'all',
              startDate: prevDates.start,
              endDate: prevDates.end,
            };
            const prevResult = await generateStatementsRaw(prevFilters);
            setPreviousData(prevResult);
          } catch {
            setPreviousData(null);
          } finally {
            setLoadingComparison(false);
          }
        }
      } else {
        setPreviousData(null);
      }

      return result;
    } catch (err) {
      console.error('Financial statements generation failed:', err);
      throw err;
    } finally {
      setLoading(false);
    }
  }, [filters, comparisonMode]);

  const updatePeriod = useCallback((period: StatementPeriod) => {
    const newFilters: StatementFilters = { ...filters, period, startDate: null, endDate: null };
    setFilters(newFilters);
    generate(newFilters);
  }, [filters, generate]);

  const updateComparisonMode = useCallback((mode: ComparisonMode) => {
    setComparisonMode(mode);
    if (data) {
      generate(undefined, mode);
    }
  }, [data, generate]);

  const comparisonMetrics = data && previousData ? buildComparisonMetrics(data, previousData) : null;

  return {
    data, loading, filters, generate, updatePeriod, setFilters,
    comparisonMode, updateComparisonMode,
    previousData, comparisonMetrics, loadingComparison,
  };
}
