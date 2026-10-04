import type { PayComponentInput, RuleVersion } from './types';


export const PROVISIONAL_RULE: RuleVersion = {
  code: 'UG-2026-07-PROV',
  effectiveFrom: '2026-07-01',
  nssfEmployeeRate: 0.05,
  nssfEmployerRate: 0.1,
  nssfReducesPayeBase: false,
  roundingRule: 'nearest_1',
  bands: [
    { bandOrder: 1, lowerBound: 0, upperBound: 235000, rate: 0, fixedAmount: 0 },
    { bandOrder: 2, lowerBound: 235000, upperBound: 335000, rate: 0.1, fixedAmount: 0 },
    { bandOrder: 3, lowerBound: 335000, upperBound: 410000, rate: 0.2, fixedAmount: 10000 },
    { bandOrder: 4, lowerBound: 410000, upperBound: 10000000, rate: 0.3, fixedAmount: 25000 },
    { bandOrder: 5, lowerBound: 10000000, upperBound: null, rate: 0.4, fixedAmount: 2902000 },
  ],
};

export const TEST_CASES: {
  id: number;
  name: string;
  inputs: PayComponentInput[];
  lstMonthly: number;
  expected: {
    paye: number;
    nssfEmployee: number;
    nssfEmployer: number;
    net: number;
    employerCost: number;
  };
}[] = [
  {
    id: 1,
    name: 'Below threshold',
    inputs: [
      {
        code: 'BASIC',
        name: 'Basic salary',
        kind: 'earning',
        amount: 200000,
        taxable: true,
        nssfAble: true,
        lstAble: true,
      },
    ],
    lstMonthly: 0,
    expected: { paye: 0, nssfEmployee: 10000, nssfEmployer: 20000, net: 190000, employerCost: 220000 },
  },
  {
    id: 2,
    name: 'At threshold',
    inputs: [
      {
        code: 'BASIC',
        name: 'Basic salary',
        kind: 'earning',
        amount: 235000,
        taxable: true,
        nssfAble: true,
        lstAble: true,
      },
    ],
    lstMonthly: 0,
    expected: { paye: 0, nssfEmployee: 11750, nssfEmployer: 23500, net: 223250, employerCost: 258500 },
  },
  {
    id: 3,
    name: 'Just above threshold',
    inputs: [
      {
        code: 'BASIC',
        name: 'Basic salary',
        kind: 'earning',
        amount: 236000,
        taxable: true,
        nssfAble: true,
        lstAble: true,
      },
    ],
    lstMonthly: 0,
    expected: { paye: 100, nssfEmployee: 11800, nssfEmployer: 23600, net: 224100, employerCost: 259600 },
  },
  {
    id: 4,
    name: 'Second band',
    inputs: [
      {
        code: 'BASIC',
        name: 'Basic salary',
        kind: 'earning',
        amount: 300000,
        taxable: true,
        nssfAble: true,
        lstAble: true,
      },
    ],
    lstMonthly: 0,
    expected: { paye: 6500, nssfEmployee: 15000, nssfEmployer: 30000, net: 278500, employerCost: 330000 },
  },
  {
    id: 5,
    name: 'Second boundary',
    inputs: [
      {
        code: 'BASIC',
        name: 'Basic salary',
        kind: 'earning',
        amount: 335000,
        taxable: true,
        nssfAble: true,
        lstAble: true,
      },
    ],
    lstMonthly: 0,
    expected: { paye: 10000, nssfEmployee: 16750, nssfEmployer: 33500, net: 308250, employerCost: 368500 },
  },
  {
    id: 6,
    name: 'Third band',
    inputs: [
      {
        code: 'BASIC',
        name: 'Basic salary',
        kind: 'earning',
        amount: 380000,
        taxable: true,
        nssfAble: true,
        lstAble: true,
      },
    ],
    lstMonthly: 0,
    expected: { paye: 19000, nssfEmployee: 19000, nssfEmployer: 38000, net: 342000, employerCost: 418000 },
  },
  {
    id: 7,
    name: 'Third boundary',
    inputs: [
      {
        code: 'BASIC',
        name: 'Basic salary',
        kind: 'earning',
        amount: 410000,
        taxable: true,
        nssfAble: true,
        lstAble: true,
      },
    ],
    lstMonthly: 0,
    expected: { paye: 25000, nssfEmployee: 20500, nssfEmployer: 41000, net: 364500, employerCost: 451000 },
  },
  {
    id: 8,
    name: 'Typical staff',
    inputs: [
      {
        code: 'BASIC',
        name: 'Basic salary',
        kind: 'earning',
        amount: 1500000,
        taxable: true,
        nssfAble: true,
        lstAble: true,
      },
    ],
    lstMonthly: 0,
    expected: { paye: 352000, nssfEmployee: 75000, nssfEmployer: 150000, net: 1073000, employerCost: 1650000 },
  },
  {
    id: 9,
    name: 'Senior',
    inputs: [
      {
        code: 'BASIC',
        name: 'Basic salary',
        kind: 'earning',
        amount: 4000000,
        taxable: true,
        nssfAble: true,
        lstAble: true,
      },
    ],
    lstMonthly: 0,
    expected: { paye: 1102000, nssfEmployee: 200000, nssfEmployer: 400000, net: 2698000, employerCost: 4400000 },
  },
  {
    id: 10,
    name: 'Surtax boundary',
    inputs: [
      {
        code: 'BASIC',
        name: 'Basic salary',
        kind: 'earning',
        amount: 10000000,
        taxable: true,
        nssfAble: true,
        lstAble: true,
      },
    ],
    lstMonthly: 0,
    expected: { paye: 2902000, nssfEmployee: 500000, nssfEmployer: 1000000, net: 6598000, employerCost: 11000000 },
  },
  {
    id: 11,
    name: 'Above surtax',
    inputs: [
      {
        code: 'BASIC',
        name: 'Basic salary',
        kind: 'earning',
        amount: 12000000,
        taxable: true,
        nssfAble: true,
        lstAble: true,
      },
    ],
    lstMonthly: 0,
    expected: { paye: 3702000, nssfEmployee: 600000, nssfEmployer: 1200000, net: 7698000, employerCost: 13200000 },
  },
  {
    id: 12,
    name: 'With allowances',
    inputs: [
      {
        code: 'BASIC',
        name: 'Basic salary',
        kind: 'earning',
        amount: 1500000,
        taxable: true,
        nssfAble: true,
        lstAble: true,
      },
      {
        code: 'TRANSPORT',
        name: 'Transport allowance',
        kind: 'earning',
        amount: 300000,
        taxable: true,
        nssfAble: true,
        lstAble: true,
      },
      {
        code: 'AIRTIME',
        name: 'Airtime allowance',
        kind: 'earning',
        amount: 200000,
        taxable: true,
        nssfAble: true,
        lstAble: true,
      },
    ],
    lstMonthly: 0,
    expected: { paye: 502000, nssfEmployee: 100000, nssfEmployer: 200000, net: 1398000, employerCost: 2200000 },
  },
];
