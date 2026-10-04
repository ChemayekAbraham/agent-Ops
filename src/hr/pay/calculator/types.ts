export interface TaxBand {
  bandOrder: number;
  lowerBound: number;
  upperBound: number | null;
  rate: number;
  fixedAmount: number;
}

export interface RuleVersion {
  code: string;
  effectiveFrom: string;
  nssfEmployeeRate: number;
  nssfEmployerRate: number;
  nssfReducesPayeBase: boolean;
  roundingRule: string;
  bands: TaxBand[];
}

export interface PayComponentInput {
  code: string;
  name: string;
  kind: string;
  amount: number;
  taxable: boolean;
  nssfAble: boolean;
  lstAble: boolean;
}

export interface PayslipLine {
  componentCode: string;
  name: string;
  kind: string;
  amount: number;
  taxableAtRun: boolean;
}

export interface CalculationResult {
  gross: number;
  chargeableIncome: number;
  paye: number;
  nssfEmployee: number;
  nssfEmployer: number;
  lst: number;
  otherDeductions: number;
  net: number;
  employerCost: number;
  lines: PayslipLine[];
  trace: string[];
}

export interface Applicability {
  payeApplicable: boolean;
  nssfApplicable: boolean;
  lstApplicable: boolean;
}