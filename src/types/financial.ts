export type TransactionDirection = 'cash_in' | 'cash_out';

export type CashInCategory = 
  | 'tenant_access_fee'
  | 'tenant_request_fee'
  | 'rent_repayment'
  | 'supporter_facilitation_capital'
  | 'agent_remittance'
  | 'platform_service_income';

export type CashOutCategory = 
  | 'rent_facilitation_payout'
  | 'supporter_platform_rewards'
  | 'agent_commission_payout'
  | 'transaction_platform_expenses'
  | 'operational_expenses';

export type TransactionCategory = CashInCategory | CashOutCategory;

export type LinkedParty = 'tenant' | 'agent' | 'supporter' | 'platform';

export interface Transaction {
  id: string;
  date: Date;
  amount: number;
  direction: TransactionDirection;
  category: TransactionCategory;
  linkedParty: LinkedParty;
  referenceId: string;
  description?: string;
}

export interface IncomeStatement {
  period: string;
  revenue: {
    accessFees: number;
    requestFees: number;
    otherServiceIncome: number;
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
  operatingExpenses: number;
  netOperatingIncome: number;
}

export interface CashFlowStatement {
  period: string;
  operatingActivities: {
    tenantFeesReceived: number;
    rentRepayments: number;
    platformRewardsPaid: number;
    agentCommissionsPaid: number;
    netOperating: number;
  };
  investingActivities: {
    systemInfrastructure: number;
    netInvesting: number;
  };
  financingActivities: {
    supporterCapitalInflows: number;
    supporterCapitalWithdrawals: number;
    netFinancing: number;
  };
  netCashMovement: number;
  openingBalance: number;
  closingBalance: number;
}

export interface BalanceSheet {
  assets: {
    cashAndEquivalents: number;
    receivables: number;
    platformInfrastructure: number;
    totalAssets: number;
  };
  platformObligations: {
    pendingRentFacilitation: number;
    accruedPlatformRewards: number;
    agentCommissionsPayable: number;
    totalObligations: number;
  };
  platformEquity: {
    retainedOperatingSurplus: number;
    totalEquity: number;
  };
}

export interface FacilitatedVolumeStatement {
  totalFacilitatedRentVolume: number;
  utilizedCapital: number;
  unutilizedCapital: number;
  activeTenants: number;
  activeAgents: number;
  averageAccessPerTenant: number;
}

export interface DashboardMetrics {
  facilitatedRentVolume: number;
  utilizedCapital: number;
  activeTenants: number;
  activeAgents: number;
  platformRevenue: number;
  netOperatingIncome: number;
}

export const CASH_IN_CATEGORIES: { value: CashInCategory; label: string }[] = [
  { value: 'tenant_access_fee', label: 'Tenant Access Fee' },
  { value: 'tenant_request_fee', label: 'Tenant Request Fee' },
  { value: 'rent_repayment', label: 'Rent Repayment' },
  { value: 'supporter_facilitation_capital', label: 'Supporter Facilitation Capital' },
  { value: 'agent_remittance', label: 'Agent Remittance' },
  { value: 'platform_service_income', label: 'Platform Service Income' },
];

export const CASH_OUT_CATEGORIES: { value: CashOutCategory; label: string }[] = [
  { value: 'rent_facilitation_payout', label: 'Rent Facilitation Payout' },
  { value: 'supporter_platform_rewards', label: 'Supporter Platform Rewards' },
  { value: 'agent_commission_payout', label: 'Agent Commission Payout' },
  { value: 'transaction_platform_expenses', label: 'Transaction & Platform Expenses' },
  { value: 'operational_expenses', label: 'Operational Expenses' },
];

export const LINKED_PARTIES: { value: LinkedParty; label: string }[] = [
  { value: 'tenant', label: 'Tenant' },
  { value: 'agent', label: 'Agent' },
  { value: 'supporter', label: 'Supporter' },
  { value: 'platform', label: 'Platform' },
];
