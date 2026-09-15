import { useState, useCallback } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { startOfDay, endOfDay, subDays, subWeeks, subMonths, subYears, startOfMonth, startOfYear, startOfWeek, startOfQuarter, differenceInDays } from 'date-fns';
import {
  REVENUE_SERVICE_FAMILIES,
  MARKETING_EXPENSE_CATEGORIES,
  MARKETING_LEGACY_DESC_BUCKETS,
  OPERATING_EXPENSE_CATEGORIES,
  OPERATING_LEGACY_DESC_BUCKETS,
  CONTRA_REVENUE_CATEGORIES,
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
  /** Gross service revenue before contra-revenue deductions. */
  grossRevenue: number;
  /** Revenue deductions (e.g. pricing subsidies) that debit R1 Platform Revenue. */
  contraRevenue: ExpenseGroup;
  /** Net service revenue = grossRevenue − contraRevenue.total. */
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
  /** Non-operating items presented between operating profit and tax. */
  otherIncomeExpensesNet: number;
  /** Operating profit plus other income/(expenses), before tax. */
  profitBeforeTax: number;
  interestExpense: number;
  interestIncome: number;
  taxProvision: number;
  depreciation: number;
  amortization: number;
  netOperatingIncome: number; // After interest & tax
  ebitda: number;
  ebitdaMargin: number; // percentage
  operatingMargin: number; // percentage
  /**
   * Ties the assembled statement back to the R1/X1-X5 trial balance and
   * surfaces anything unaccounted for, so a missing category cannot pass
   * silently the way X4 and X5 did.
   */
  reconciliation: {
    revenue: { statement: number; ledgerR1: number; difference: number };
    expenses: {
      statement: number;
      ledgerX1toX5: number;
      byAccount: { X1: number; X2: number; X3: number; X4: number; X5: number };
      difference: number;
    };
    unclassified: { agentCommissionEarnedPlatform: number; note: string };
    unexplainedExpenseDifference: number;
  };
  /**
   * What the company earned and spent in the selected period, and whether that
   * was a profit or a loss. Derived from account codes (R1 vs X1-X5) rather
   * than category name lists, so it is complete by construction and moves with
   * the selected period.
   */
  periodSummary: {
    periodLabel: string;
    startDate: string | null;
    endDate: string | null;
    earned: number;
    spent: number;
    spentExcludingUnclassified: number;
    profitOrLoss: number;
    profitOrLossExcludingUnclassified: number;
    isProfit: boolean;
    unclassifiedExcluded: number;
    spentByAccount: { X1: number; X2: number; X3: number; X4: number; X5: number };
  };
  /**
   * Reporting-only disclosure: fee revenue earned under the existing rule that
   * never reached R1, because recognition is gated to plans funded on or after
   * the treasury waterfall go-live date.
   *
   * AS-AT, NOT A PERIOD FLOW. The figure is a cumulative stock measured at the
   * current date. It is not period-filtered and must never be presented inside
   * a period column, because no complete timestamped all-channel repayment
   * event source exists to period-attribute it (validated 2026-09-11:
   * agent_collections covers 54.2% of repayment, agent_collections +
   * repayments covers 75.5%, and 24.5% is recorded in no event table at all).
   *
   * This is NOT part of reported revenue and does NOT affect operating income,
   * net profit/loss or periodSummary. Nothing is posted to the ledger for it.
   */
  unrecognisedEarnedFeeRevenue: {
    /** Exact display label. Says "As at Current Date" on purpose. */
    label: string;
    /** When the figure was measured. It is a stock at this instant. */
    asAtDate: string;
    /** Hard marker: this figure is NOT period-aware. Always false. */
    periodAware: false;
    /** As-at stock, complete across every repayment channel. */
    earnedToDate: number;
    recognisedToDate: number;
    notYetRecognisedToDate: number;
    basis: string;
    excludedFromProfitAndLoss: boolean;
    /**
     * NOT FOR DISPLAY. Incomplete agent-channel-only period diagnostic, kept
     * for engineering comparison only. Sees 54.2% of repayment activity, so
     * presenting it as a period figure would be false precision. It is
     * deliberately nested and verbosely named so it cannot be bound to a
     * statement line by accident.
     */
    internalIncompleteAgentChannelDiagnostic: {
      doNotDisplay: true;
      isIncomplete: true;
      coverageNote: string;
      agentChannelEarnedInPeriod: number;
      r1RecognisedInPeriod: number;
      agentChannelGapInPeriod: number;
    };
  };
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
    /** Authoritative all-inclusive receivables from get_receivables_total(). */
    totalReceivables: number;
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
        allTimePlatformRes, promissoryNotesRes, receivablesTotalRes,
        accountMapRes, periodCollectionsRes, allTimeFeeRevenueRes,
      ] = await Promise.all([
        supabase.rpc('get_wallet_totals'),
        // amount_repaid / total_repayment / funded_at added for the
        // unrecognised-earned-fee disclosure: they give each plan's fee share
        // and prove it was actually funded. Purely additive to the existing
        // consumers of this row set.
        supabase.from('rent_requests').select('id, rent_amount, access_fee, request_fee, status, tenant_id, agent_id, created_at, amount_repaid, total_repayment, funded_at').limit(10000),
        supabase.from('agent_advances').select('access_fee, access_fee_collected, access_fee_status, status').in('status', ['active', 'overdue']),
        supabase.rpc('get_platform_cash_summary'),
        supabase.from('promissory_notes').select('amount, total_collected, status').in('status', ['pending', 'activated']),
        // Single authoritative Total Receivables (server-side v_receivables_lines).
        supabase.rpc('get_receivables_total'),
        // The account map is the authority on whether a leg is a debit or a
        // credit (`debit_when`). Reading it here lets the statement compute true
        // net movements instead of guessing a category's natural direction.
        // 93 rows, read-only, RLS-gated to the same finance roles that may view
        // these statements.
        supabase.from('ledger_account_map')
          .select('ledger_scope, category, wallet_bucket, account_code, debit_when'),
        // Collections IN THE SELECTED PERIOD, for the unrecognised-earned-fee
        // disclosure. Uses the same p_start/p_end bounds as the ledger sums, so
        // the disclosure moves with the chosen period instead of being a
        // single as-at snapshot. Read-only; no money is derived from this.
        (() => {
          let q = supabase.from('agent_collections').select('rent_request_id, amount');
          if (startDate) q = q.gte('created_at', startDate.toISOString());
          if (endDate) q = q.lte('created_at', endDate.toISOString());
          return q.limit(50000);
        })(),
        // All-time R1 fee revenue, needed for the CUMULATIVE half of the
        // disclosure (the period-scoped sums cannot answer an as-at question).
        // Roughly 300 legs, so this stays cheap.
        supabase.from('general_ledger')
          .select('amount, direction')
          .eq('ledger_scope', 'platform')
          .in('category', ['access_fee_collected', 'registration_fee_collected'])
          .in('classification', ['production', 'legacy_real'])
          .limit(20000),
      ]);

      const walletTotalsData = walletsRes.data as any;
      const wallets = [{ balance: Number(walletTotalsData?.total_balance ?? 0) }];
      const rentRequests = rentRequestsRes.data || [];
      const activeAdvances = advancesRes.data || [];
      const allTimePlatformSummary = allTimePlatformRes.data as any;
      const promissoryNotes = promissoryNotesRes.data || [];
      const authoritativeReceivables = Number((receivablesTotalRes.data as any)?.total ?? 0);


      const excludeSynthetic = (rows: any[]) => rows.filter(r => r.category !== 'opening_balance');
      const sumBy = (rows: any[], cats: string[]) =>
        excludeSynthetic(rows).filter(r => cats.includes(r.category)).reduce((s, r) => s + Number(r.amount), 0);
      /**
       * LEGACY, retained deliberately. Takes a gross one-directional sum and
       * discards the offsetting side, so reversals never reduce a line.
       *
       * The Income Statement no longer uses this — it uses netByCategory below.
       * The Cash Flow statement and the category drilldowns still do, so their
       * figures are unchanged by this pass. Migrating them is a separate
       * decision because cash flow legitimately cares about gross movement in
       * each direction, not net.
       */
      const sumWithDirectionFallback = (
        preferredRows: any[], fallbackRows: any[], categories: string[],
      ) => {
        return categories.reduce((total, cat) => {
          const preferred = sumBy(preferredRows, [cat]);
          return total + (preferred > 0 ? preferred : sumBy(fallbackRows, [cat]));
        }, 0);
      };

      /**
       * (scope|category) -> account + debit_when, from ledger_account_map.
       * Bucket-specific rows (five of them) are keyed with the bucket appended
       * so they never shadow the general mapping for the same category.
       */
      const acctMap = new Map<string, { account: string; debitWhen: string }>();
      for (const m of ((accountMapRes.data ?? []) as any[])) {
        const key = m.wallet_bucket
          ? `${m.ledger_scope}|${m.category}|${m.wallet_bucket}`
          : `${m.ledger_scope}|${m.category}`;
        acctMap.set(key, { account: m.account_code, debitWhen: m.debit_when });
      }

      /**
       * True net movement for a set of categories in one scope.
       *
       * A leg counts positive when its direction equals the account map's
       * `debit_when`, and negative otherwise — the same basis
       * get_treasury_cash_position uses. This replaces
       * sumWithDirectionFallback, which took a GROSS one-directional sum and
       * discarded the offsetting side, so a reversal never reduced its line
       * (registration fee revenue read 1,549,966 gross against a true net of
       * 109,966; agent_commission_earned overstated by 5,630,000).
       *
       * `nature` flips the sign for credit-natured lines (revenue) so callers
       * still receive a positive number for a normal balance. An unmapped
       * category contributes nothing rather than a guessed direction.
       */
      const netByCategory = (
        scope: 'platform' | 'wallet' | 'bridge',
        categories: string[],
        nature: 'debit' | 'credit',
      ) => {
        const inRows = scopedRows(scope, 'cash_in');
        const outRows = scopedRows(scope, 'cash_out');
        return categories.reduce((total, cat) => {
          const debitWhen = acctMap.get(`${scope}|${cat}`)?.debitWhen;
          if (!debitWhen) return total;
          const drRows = debitWhen === 'cash_in' ? inRows : outRows;
          const crRows = debitWhen === 'cash_in' ? outRows : inRows;
          const net = sumBy(drRows, [cat]) - sumBy(crRows, [cat]);
          return total + (nature === 'debit' ? net : -net);
        }, 0);
      };

      /**
       * Net debit balance of a whole account code, across every scope and
       * every category mapped to it. Used only by the reconciliation block, to
       * compare the assembled statement against the trial balance and surface
       * any residual rather than let it pass silently.
       */
      const accountNet = (code: string) => {
        let net = 0;
        for (const [key, m] of acctMap) {
          if (m.account !== code) continue;
          const [scope, cat] = key.split('|');
          if (scope !== 'platform' && scope !== 'wallet' && scope !== 'bridge') continue;
          const drRows = scopedRows(scope, m.debitWhen === 'cash_in' ? 'cash_in' : 'cash_out');
          const crRows = scopedRows(scope, m.debitWhen === 'cash_in' ? 'cash_out' : 'cash_in');
          net += sumBy(drRows, [cat]) - sumBy(crRows, [cat]);
        }
        return net;
      };

      // ══════════════════════════════════════════════════════════════
      // INCOME STATEMENT — Platform scope ONLY (earned revenue & costs)
      // ══════════════════════════════════════════════════════════════
      const accessFees = netByCategory('platform', ['tenant_access_fee', 'access_fee', 'access_fee_collected'], 'credit');
      const requestFees = netByCategory('platform', ['tenant_request_fee', 'request_fee', 'registration_fee_collected'], 'credit');
      const otherServiceIncome = netByCategory('platform', ['platform_service_income', 'landlord_platform_fee', 'management_fee'], 'credit');
      const platformRewards = netByCategory('platform', ['supporter_platform_rewards', 'supporter_reward', 'investment_reward', 'roi_payout', 'roi_expense'], 'debit');
      // Agent commissions = direct payouts only. `agent_commission_earned` (which
      // includes the auto-paid UGX 5,000 listing bonus) is reclassified below as
      // a TRANSACTION EXPENSE — it is a per-event platform cost of acquiring a
      // listing, not a revenue-share commission. It is NEVER counted as revenue.
      const agentCommissions = netByCategory('platform', ['agent_commission_payable', 'agent_commission_payout', 'agent_commission', 'agent_payout', 'agent_approval_bonus'], 'debit');
      // Referral & agent bonuses (production + legacy)
      const referralBonuses = sumBy(walletIn, ['referral_bonus']) + sumBy(platformOut, ['referral_bonus']);
      const agentBonuses = sumBy(walletIn, ['agent_bonus']) + sumBy(platformOut, ['agent_bonus']);
      const totalIncentiveCosts = referralBonuses + agentBonuses;
      // Transaction expenses = per-transaction platform costs. Includes listing
      // bonuses (posted under `agent_commission_earned` by credit-listing-bonus)
      // alongside the dedicated `transaction_platform_expenses` bucket.
      const transactionExpenses = netByCategory('platform', ['transaction_platform_expenses'], 'debit');
      const generalOperating = netByCategory('platform', ['operational_expenses', 'platform_expense'], 'debit');
      // 'employee_advance' deliberately excluded: an advance to an employee is a
      // receivable, not payroll cost. Including it overstated payroll and
      // operating expenses, and understated assets, until the advance was
      // repaid.
      const payrollExpenses = netByCategory('platform', ['salary_payment', 'payroll_expense'], 'debit');
      const agentRequisitions = netByCategory('platform', ['agent_requisition'], 'debit');
      const financialAgentExpenses = netByCategory('platform', ['platform_expense_disbursement'], 'debit');

      // ── GAAP Expense Categories (proper ledger categories) ──
      const marketingExpenseCat = netByCategory('platform', ['marketing_expense'], 'debit');
      const generalAdminCat = netByCategory('platform', ['general_admin_expense'], 'debit');
      const researchDevCat = netByCategory('platform', ['research_development_expense'], 'debit');
      const taxExpenseCat = netByCategory('platform', ['tax_expense'], 'debit');
      const interestExpenseCat = netByCategory('platform', ['interest_expense'], 'debit');
      const equipmentExpenseCat = netByCategory('platform', ['equipment_expense'], 'debit');

      // X4 / X5 -- two expense accounts the statement previously omitted
      // entirely, because it was assembled from category name lists rather
      // than from account codes. Both are real platform costs.
      //   X4 platform_loss_writeoff      -- losses written off
      //   X5 merchant_oop_reimbursement  -- merchant out-of-pocket reimbursed
      const platformLossWriteoff = netByCategory('platform', ['platform_loss_writeoff'], 'debit');
      const merchantOopReimbursement = netByCategory('platform', ['merchant_oop_reimbursement'], 'debit');

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

      // Operating expenses proper: excludes interest, tax and D&A, which belong
      // below operating profit. Previously they were inside this figure while
      // being stripped out again for the EBIT calculation, so the printed
      // "Total Operating Expenses" was not the subtotal the statement used and
      // Gross Profit less that subtotal did not reproduce Operating Income.
      // Operating Income, Net Income and EBITDA are all unchanged by this: the
      // same three amounts are simply removed once here instead of twice.
      // `transactionExpenses` is deliberately NOT included here. It is already
      // a cost of revenue via totalServiceCosts -> grossProfit, and including
      // it again made operatingIncome subtract the same amount twice, deepening
      // the reported loss by its full value.
      const operatingExpensesTotal = totalMarketingExpense + totalGeneralAdmin + totalPayroll + totalRnD + agentRequisitions + financialAgentExpenses + tenantDefaultCharges + debtClearance
        // X4 and X5, previously missing from every total.
        + platformLossWriteoff + merchantOopReimbursement;

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

      // Operating Income = Gross Profit - Operating Expenses (+ adjustments).
      // operatingExpensesTotal now already excludes interest, tax and D&A.
      const operatingIncome = grossProfit - operatingExpensesTotal + adjustmentsTotal;

      // Other income / (expenses): non-operating items, presented between
      // operating profit and tax rather than buried in operating expenses.
      const otherIncomeExpensesNet = interestIncome - interestExpense;

      // Profit Before Tax - the subtotal the statement previously skipped.
      const profitBeforeTax = operatingIncome + otherIncomeExpensesNet;

      // Net Income = Profit Before Tax - Tax
      const netOperatingIncome = profitBeforeTax - taxProvision;

      // EBITDA = Operating Income + D&A (already excludes interest & tax)
      const ebitda = operatingIncome + depreciation + amortization;
      const ebitdaMargin = totalRevenue > 0 ? (ebitda / totalRevenue) * 100 : 0;
      const operatingMargin = totalRevenue > 0 ? (operatingIncome / totalRevenue) * 100 : 0;

      // ══════════════════════════════════════════════════════════════
      // RECONCILIATION — statement vs trial balance
      // ══════════════════════════════════════════════════════════════
      // The statement is assembled from category name lists, so a category
      // added to an expense account after those lists were written is silently
      // invisible. That is exactly how X4 and X5 came to be omitted in full.
      // This block compares the assembled figures against the R1/X1-X5 net
      // balances and surfaces any residual instead of letting it pass.
      //
      // Each component is counted ONCE here. Note transactionExpenses appears
      // in both totalServiceCosts and operatingExpensesTotal in the presented
      // statement; that pre-existing overlap is out of scope for this pass and
      // is deliberately not replicated in this total.
      const statementExpensesTotal =
        platformRewards + agentCommissions + totalIncentiveCosts + transactionExpenses
        + totalMarketingExpense + totalGeneralAdmin + totalPayroll + totalRnD
        + agentRequisitions + financialAgentExpenses + tenantDefaultCharges + debtClearance
        + platformLossWriteoff + merchantOopReimbursement
        + interestExpense + taxProvision + depreciation;

      // R1 is credit-natured, so a negative net debit is positive revenue.
      const ledgerRevenue = -accountNet('R1');
      const ledgerX1 = accountNet('X1');
      const ledgerX2 = accountNet('X2');
      const ledgerX3 = accountNet('X3');
      const ledgerX4 = accountNet('X4');
      const ledgerX5 = accountNet('X5');
      const ledgerExpensesTotal = ledgerX1 + ledgerX2 + ledgerX3 + ledgerX4 + ledgerX5;

      // Excluded on purpose, pending an accounting decision. platform
      // agent_commission_earned is a catch-all whose balance is ~94%
      // cfo_direct_credit (CFO direct credits to agent wallets). It is NOT the
      // rent commission -- that is agent_commission_payable, now counted in
      // agentCommissions. Until its treatment is agreed it is reported here as
      // unclassified rather than assigned to a P&L line.
      const unclassifiedAgentCommissionEarned =
        netByCategory('platform', ['agent_commission_earned'], 'debit');

      const incomeStatementReconciliation = {
        revenue: {
          statement: totalRevenue,
          ledgerR1: ledgerRevenue,
          difference: ledgerRevenue - totalRevenue,
        },
        expenses: {
          statement: statementExpensesTotal,
          ledgerX1toX5: ledgerExpensesTotal,
          byAccount: { X1: ledgerX1, X2: ledgerX2, X3: ledgerX3, X4: ledgerX4, X5: ledgerX5 },
          difference: ledgerExpensesTotal - statementExpensesTotal,
        },
        unclassified: {
          agentCommissionEarnedPlatform: unclassifiedAgentCommissionEarned,
          note: 'platform.agent_commission_earned — ~94% cfo_direct_credit. Excluded from the '
              + 'P&L pending an accounting decision; not the rent commission.',
        },
        /** Residual after allowing for the deliberately unclassified balance. */
        unexplainedExpenseDifference:
          ledgerExpensesTotal - statementExpensesTotal - unclassifiedAgentCommissionEarned,
      };

      // ══════════════════════════════════════════════════════════════
      // DISCLOSURE — earned fee revenue not yet recognised in R1
      // ══════════════════════════════════════════════════════════════
      // REPORTING ONLY. Nothing here posts to the ledger, and this amount is
      // deliberately NOT added to reported revenue, operating income or net
      // profit/loss. It exists so the statement shows that fee revenue has
      // been earned under the existing rule but never reached R1.
      //
      // AS-AT, NOT PERIOD-AWARE. The headline figure is a cumulative stock at
      // the current date. It is NOT period-filtered, and the period selector
      // must not change it. A period-attributed version is not derivable:
      // validated against production on 2026-09-11, no single timestamped
      // event source covers all repayment channels —
      //   agent_collections              254,838,044 of 470,504,196  = 54.2%
      //   + repayments (deduped)         355,447,175 of 470,504,196  = 75.5%
      //   recorded in NO event table     115,057,021                 = 24.5%
      // Only rent_requests.amount_repaid is complete, and it carries no event
      // timestamp, so it can be measured as-at but never sliced by period.
      //
      // WHY IT EXISTS: post_rent_fee_collection only recognises fees for plans
      // inside is_treasury_waterfall_scope(), which requires
      // funded_at >= treasury_waterfall_go_live_at() (2026-09-08). Plans funded
      // before that boundary collect cash and earn fees but post no revenue.
      //
      // HOW IT IS CALCULATED (as-at)
      //   fee share of a plan = (access_fee + request_fee) / total_repayment
      //   earned to date       = SUM(amount_repaid x that plan's share)
      //   recognised to date   = all-time R1 access_fee_collected
      //                          + registration_fee_collected
      //   disclosure           = earned to date - recognised to date (floor 0)
      //
      // Both sides are all-time, so they are measured on the same basis.
      //
      // NO DOUBLE COUNT: all-time recognised R1 fee revenue is subtracted, so
      // any plan already inside the waterfall contributes nothing here.
      //
      // POPULATION — deliberately narrow:
      //   * included: funded plans with status 'completed' or 'repaying'
      //   * EXCLUDED: never-funded plans (quotations on applications; ~382.4m
      //     of priced fees with no contract, no receivable, never revenue)
      //   * EXCLUDED: unearned receivable (fees on future instalments — they
      //     become revenue only as the tenant pays)
      //   * EXCLUDED: funded-then-terminated plans (~19.5m). Their treatment is
      //     an open accounting decision and is NOT classified as a write-off
      //     here.
      const feeShareByPlan = new Map<string, number>();
      for (const r of (rentRequests as any[])) {
        const funded = !!r.funded_at;
        const live = r.status === 'completed' || r.status === 'repaying';
        const total = Number(r.total_repayment || 0);
        const fees = Number(r.access_fee || 0) + Number(r.request_fee || 0);
        if (!funded || !live || total <= 0 || fees <= 0) continue;
        feeShareByPlan.set(r.id, fees / total);
      }

      const agentChannelEarnedFeeInPeriod = ((periodCollectionsRes.data ?? []) as any[])
        .reduce((sum, c) => {
          const share = feeShareByPlan.get(c.rent_request_id);
          if (!share) return sum;                       // excluded population
          return sum + Number(c.amount || 0) * share;
        }, 0);

      const r1RecognisedFeeInPeriod = netByCategory(
        'platform', ['access_fee_collected', 'registration_fee_collected'], 'credit',
      );

      // THE AS-AT FIGURE. This is the only one reported.
      //
      // rent_requests.amount_repaid is the single complete record of repayment:
      // every channel (agent collection, tenant self-pay, deposit settlement,
      // auto-charge, manual collection) updates it. It carries no event
      // timestamp, which is precisely why this figure is as-at and not a
      // period flow.
      //
      // Verified as at 2026-09-11 against production:
      //   earned to date       124,310,292
      //   recognised in R1      12,172,288
      //   not yet recognised   112,138,004
      // Computed live rather than hardcoded, so it stays true as repayment
      // continues; the numbers above are the validation reference point.
      const cumulativeEarnedFee = (rentRequests as any[]).reduce((sum, r) => {
        const share = feeShareByPlan.get(r.id);
        if (!share) return sum;
        return sum + Number(r.amount_repaid || 0) * share;
      }, 0);

      const cumulativeRecognisedFee = ((allTimeFeeRevenueRes.data ?? []) as any[])
        .reduce((sum, g) => sum + (g.direction === 'cash_in'
          ? Number(g.amount || 0) : -Number(g.amount || 0)), 0);

      const unrecognisedEarnedFeeRevenue = {
        label: 'Earned Fee Revenue Not Yet Recognised — As at Current Date',
        asAtDate: new Date().toISOString(),
        /** Literal false: this figure is a stock, never a period flow. */
        periodAware: false as const,

        earnedToDate: cumulativeEarnedFee,
        recognisedToDate: cumulativeRecognisedFee,
        notYetRecognisedToDate: Math.max(0, cumulativeEarnedFee - cumulativeRecognisedFee),

        basis: 'AS-AT, NOT PERIOD-AWARE. Each plan\'s fee share = (access_fee + request_fee) / '
             + 'total_repayment, applied to all-time cash repaid '
             + '(rent_requests.amount_repaid, the only complete repayment record), for FUNDED '
             + 'plans with status completed or repaying, less all-time fee revenue already '
             + 'posted to R1. Excluded: never-funded quotations (no contract, no receivable), '
             + 'unearned future instalments, and funded-then-terminated plans (treatment still '
             + 'an open decision, NOT classified as a write-off). Informational only: excluded '
             + 'from revenue, operating income, net operating income, net profit/loss and the '
             + 'period summary.',
        excludedFromProfitAndLoss: true,

        // NOT FOR DISPLAY. Retained for engineering comparison only. This sees
        // agent_collections alone = 54.2% of repayment activity, so exposing it
        // as a period figure would assert precision the data does not support.
        internalIncompleteAgentChannelDiagnostic: {
          doNotDisplay: true as const,
          isIncomplete: true as const,
          coverageNote: 'INCOMPLETE — agent-channel only, ~54.2% of repayment activity. '
             + 'Diagnostic only. NOT the authoritative Income Statement figure and NOT a '
             + 'complete period flow: tenant self-pay, deposit settlement, auto-charge and '
             + 'manual collection write no agent_collections row, and 24.5% of repayment is '
             + 'recorded in no event table at all.',
          agentChannelEarnedInPeriod: agentChannelEarnedFeeInPeriod,
          r1RecognisedInPeriod: r1RecognisedFeeInPeriod,
          agentChannelGapInPeriod: Math.max(
            0, agentChannelEarnedFeeInPeriod - r1RecognisedFeeInPeriod,
          ),
        },
      };

      // ══════════════════════════════════════════════════════════════
      // PERIOD SUMMARY — earned, spent, profit or loss
      // ══════════════════════════════════════════════════════════════
      // Answers the three questions directly: what did the company earn in
      // this period, what did it spend, and did it make a profit or a loss.
      //
      // Driven by ACCOUNT CODE (R1 revenue, X1-X5 expense) rather than by
      // category name lists, so it is complete by construction: a newly added
      // category reaching an expense account is counted automatically and can
      // never be silently omitted the way X4 and X5 were. It moves with the
      // selected period because it reads the same period-filtered rows.
      //
      // `spentExcludingUnclassified` removes the platform
      // agent_commission_earned catch-all (~94% cfo_direct_credit), which has
      // no agreed P&L treatment yet, so the figure can be read either way.
      const periodEarned = ledgerRevenue;
      const periodSpent = ledgerExpensesTotal;
      const periodSpentExclUnclassified = periodSpent - unclassifiedAgentCommissionEarned;
      const periodProfitOrLoss = periodEarned - periodSpent;
      const periodProfitOrLossExclUnclassified = periodEarned - periodSpentExclUnclassified;

      const periodSummary = {
        periodLabel: formatPeriodLabel(activeFilters),
        startDate: startDate ? startDate.toISOString() : null,
        endDate: endDate ? endDate.toISOString() : null,
        earned: periodEarned,
        spent: periodSpent,
        spentExcludingUnclassified: periodSpentExclUnclassified,
        profitOrLoss: periodProfitOrLoss,
        profitOrLossExcludingUnclassified: periodProfitOrLossExclUnclassified,
        isProfit: periodProfitOrLoss >= 0,
        unclassifiedExcluded: unclassifiedAgentCommissionEarned,
        spentByAccount: {
          X1: ledgerX1, X2: ledgerX2, X3: ledgerX3, X4: ledgerX4, X5: ledgerX5,
        },
      };

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
      const rentRepayments = sumWithDirectionFallback(platformIn, platformOut, ['rent_repayment', 'loan_repayment', 'tenant_repayment', 'tenant_repayment_collected']);
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

      // Total receivables is the authoritative server-side figure, replacing the
      // former partial sum of (outstandingRent + rentReceivablesCreated +
      // advanceAccessFeeReceivables + promissoryNotesReceivable). The individual
      // components above are retained for the detail rows only.
      const totalReceivables = authoritativeReceivables;

      const totalAssets = platformCash + userFundsHeld + totalReceivables;


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
      const currentAssets = platformCash + userFundsHeld + totalReceivables;
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
          otherIncomeExpensesNet,
          profitBeforeTax,
          interestExpense,
          interestIncome,
          taxProvision,
          depreciation,
          amortization,
          netOperatingIncome,
          ebitda,
          ebitdaMargin,
          operatingMargin,
          reconciliation: incomeStatementReconciliation,
          periodSummary,
          // Disclosure only, and AS-AT rather than a period flow.
          // Intentionally NOT folded into revenue.total, operatingIncome,
          // netOperatingIncome, netProfit/loss or periodSummary.
          unrecognisedEarnedFeeRevenue,
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
            advanceAccessFeeReceivables, promissoryNotesReceivable,
            // Authoritative, all-inclusive receivables (get_receivables_total).
            totalReceivables, totalAssets,
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
