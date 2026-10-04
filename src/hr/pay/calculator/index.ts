import type {
  Applicability,
  CalculationResult,
  PayComponentInput,
  PayslipLine,
  RuleVersion,
} from './types';
import { computePaye, selectBand } from './paye';
import { computeNssfEmployee, computeNssfEmployer } from './nssf';

export function roundAmount(value: number, roundingRule: string): number {
  void roundingRule;
  const sign = value < 0 ? -1 : 1;
  return sign * Math.round(Math.abs(value));
}

export function calculatePayslip(
  components: PayComponentInput[],
  rule: RuleVersion,
  lstMonthly: number,
  otherDeductions = 0,
  applicability: Applicability = {
    payeApplicable: true,
    nssfApplicable: true,
    lstApplicable: true,
  },
): CalculationResult {
  const earnings = components.filter((c) => c.kind === 'earning');

  const gross = earnings.reduce((sum, c) => sum + c.amount, 0);
  const nssfableGross = earnings.filter((c) => c.nssfAble).reduce((sum, c) => sum + c.amount, 0);
  const taxableGross = earnings.filter((c) => c.taxable).reduce((sum, c) => sum + c.amount, 0);

  const nssfEmployee = applicability.nssfApplicable
    ? computeNssfEmployee(nssfableGross, rule)
    : 0;
  const nssfEmployer = applicability.nssfApplicable
    ? computeNssfEmployer(nssfableGross, rule)
    : 0;

  const chargeableIncome = rule.nssfReducesPayeBase ? taxableGross - nssfEmployee : taxableGross;

  const paye = applicability.payeApplicable ? computePaye(chargeableIncome, rule) : 0;
  const lst = applicability.lstApplicable ? lstMonthly : 0;
  const net = gross - paye - nssfEmployee - lst - otherDeductions;
  const employerCost = gross + nssfEmployer;

  const lines: PayslipLine[] = components.map((c) => ({
    componentCode: c.code,
    name: c.name,
    kind: c.kind,
    amount: c.amount,
    taxableAtRun: c.taxable,
  }));

  if (paye > 0) {
    lines.push({
      componentCode: 'PAYE',
      name: 'PAYE',
      kind: 'deduction',
      amount: paye,
      taxableAtRun: false,
    });
  }
  if (nssfEmployee > 0) {
    lines.push({
      componentCode: 'NSSF_EE',
      name: 'NSSF employee contribution',
      kind: 'deduction',
      amount: nssfEmployee,
      taxableAtRun: false,
    });
  }
  if (lst > 0) {
    lines.push({
      componentCode: 'LST',
      name: 'Local Service Tax',
      kind: 'deduction',
      amount: lst,
      taxableAtRun: false,
    });
  }
  if (nssfEmployer > 0) {
    lines.push({
      componentCode: 'NSSF_ER',
      name: 'NSSF employer contribution',
      kind: 'employer_cost',
      amount: nssfEmployer,
      taxableAtRun: false,
    });
  }

  const band =
    applicability.payeApplicable && chargeableIncome > 0
      ? selectBand(chargeableIncome, rule)
      : null;
  const payeSentence = !applicability.payeApplicable
    ? 'PAYE was not applied because PAYE does not apply to this worker.'
    : band
      ? `PAYE is ${paye}, from the band above ${band.lowerBound} up to ${
          band.upperBound === null ? 'no upper limit' : band.upperBound
        }: fixed amount ${band.fixedAmount} plus ${band.rate * 100}% of (${chargeableIncome} minus ${band.lowerBound}).`
      : `PAYE is ${paye} because no tax band applies to a chargeable income of ${chargeableIncome}.`;

  const trace: string[] = [
    `Gross pay is ${gross}, the sum of all earning components.`,
    `NSSF-able gross is ${nssfableGross}, the sum of earning components marked NSSF-able.`,
    `Taxable gross is ${taxableGross}, the sum of earning components marked taxable.`,
    applicability.nssfApplicable
      ? `NSSF employee contribution is ${nssfEmployee} and NSSF employer contribution is ${nssfEmployer}, both taken on the NSSF-able gross of ${nssfableGross}.`
      : 'NSSF was not applied because NSSF does not apply to this worker.',
    rule.nssfReducesPayeBase
      ? `NSSF reduced the PAYE base: chargeable income is ${chargeableIncome}, taxable gross ${taxableGross} minus NSSF employee ${nssfEmployee}.`
      : `NSSF did not reduce the PAYE base: chargeable income is ${chargeableIncome}, equal to the taxable gross.`,
    payeSentence,
    applicability.lstApplicable
      ? `Local Service Tax for the month is ${lst}.`
      : 'Local Service Tax was not applied because LST does not apply to this worker.',
    `Net pay is ${net}, gross ${gross} minus PAYE ${paye} minus NSSF employee ${nssfEmployee} minus LST ${lst} minus other deductions ${otherDeductions}.`,
    `Total employer cost is ${employerCost}, gross ${gross} plus NSSF employer ${nssfEmployer}.`,
  ];

  return {
    gross,
    chargeableIncome,
    paye,
    nssfEmployee,
    nssfEmployer,
    lst,
    otherDeductions,
    net,
    employerCost,
    lines,
    trace,
  };
}

export { computePaye } from './paye';
export { computeNssfEmployee, computeNssfEmployer } from './nssf';