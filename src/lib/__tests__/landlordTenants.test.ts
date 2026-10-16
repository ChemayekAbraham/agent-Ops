import { describe, expect, it } from 'vitest';
import {
  FUNDING_STAGE_TONE,
  fundingStageClass,
  formatUgx,
  landlordTenantsErrorMessage,
  planStatusLabel,
  summariseTenants,
  toInternationalPhone,
  type LandlordTenantRow,
} from '../landlordTenants';

const row = (over: Partial<LandlordTenantRow> = {}): LandlordTenantRow => ({
  rent_request_id: 'r1', tenant_id: 't1', tenant_name: 'Grace Nakato', tenant_phone: '0772123456', rent_amount: 300000, daily_repayment: 11000, total_repayment: 330000,
  amount_repaid: 110000, balance_left: 220000, plan_status: 'repaying', funded_at: '2026-09-01T00:00:00Z', assigned_agent_id: 'a1', assigned_agent_name: 'Joy Agent',
  assigned_agent_phone: '0701000000', registering_agent_id: 'a1', registering_agent_name: 'Joy Agent', funding_stage: 'Repaying', ...over,
});

describe('formatUgx', () => {
  it('shows whole shillings as "UGX 1,234,000", always in UGX', () => {
    expect(formatUgx(1234000)).toBe('UGX 1,234,000');
    expect(formatUgx(0)).toBe('UGX 0');
    expect(formatUgx('450000')).toBe('UGX 450,000');
    expect(formatUgx(999.6)).toBe('UGX 1,000');
    expect(formatUgx(null)).toBe('UGX 0');
    expect(formatUgx(undefined)).toBe('UGX 0');
    expect(formatUgx(-2500)).toBe('UGX -2,500');
  });
});

describe('toInternationalPhone', () => {
  it('turns local numbers into +256 numbers and leaves international ones alone', () => {
    expect(toInternationalPhone('0772 123 456')).toBe('+256772123456');
    expect(toInternationalPhone('+256772123456')).toBe('+256772123456');
    expect(toInternationalPhone('256772123456')).toBe('+256772123456');
    expect(toInternationalPhone('772123456')).toBe('+256772123456');
    expect(toInternationalPhone('0772-123-456')).toBe('+256772123456');
  });
});

describe('planStatusLabel', () => {
  it('puts the status in words', () => {
    expect(planStatusLabel('service_center_review')).toBe('Service center review');
    expect(planStatusLabel('repaying')).toBe('Repaying');
    expect(planStatusLabel('')).toBe('Unknown');
    expect(planStatusLabel(null)).toBe('Unknown');
  });
});

describe('funding stage colours', () => {
  it('knows all six stages the server returns (with the en dash) and renders an unknown one neutrally', () => {
    expect(Object.keys(FUNDING_STAGE_TONE)).toEqual(['In review', 'Funded – money with agent', 'Landlord paid', 'Repaying', 'Completed', 'Rejected/Cancelled']);
    const classes = Object.keys(FUNDING_STAGE_TONE).map(fundingStageClass);
    expect(new Set(classes).size).toBe(6);
    expect(fundingStageClass('Something new')).toContain('bg-muted');
  });
});

describe('summariseTenants', () => {
  it('counts different tenants, sums rent and balance, and leaves rejected or cancelled plans out of the totals', () => {
    const rows = [
      row({ rent_request_id: 'a', tenant_id: 't1', rent_amount: 300000, balance_left: 220000 }),
      row({ rent_request_id: 'b', tenant_id: 't1', funding_stage: 'Completed', rent_amount: 200000, balance_left: 0 }),
      row({ rent_request_id: 'c', tenant_id: 't2', funding_stage: 'In review', rent_amount: 400000, balance_left: 440000 }),
      row({ rent_request_id: 'd', tenant_id: 't3', funding_stage: 'Rejected/Cancelled', rent_amount: 999999, balance_left: 0 }),
    ];
    expect(summariseTenants(rows)).toEqual({ tenants: 2, plans: 3, totalRent: 900000, totalBalance: 660000, excludedPlans: 1 });
  });
  it('is all zeros for no rows, and copes with a missing tenant id', () => {
    expect(summariseTenants([])).toEqual({ tenants: 0, plans: 0, totalRent: 0, totalBalance: 0, excludedPlans: 0 });
    expect(summariseTenants([row({ tenant_id: null, rent_request_id: 'x' }), row({ tenant_id: null, rent_request_id: 'y' })]).tenants).toBe(2);
  });
});

describe('landlordTenantsErrorMessage', () => {
  it('says what went wrong in one sentence, with no banned words', () => {
    expect(landlordTenantsErrorMessage(new Error('NOT_AUTHORISED: only Landlord Ops'))).toMatch(/don't have access/);
    expect(landlordTenantsErrorMessage({ message: 'LANDLORD_REQUIRED: choose a landlord' })).toBe('No landlord was chosen.');
    const generic = landlordTenantsErrorMessage(new Error('network down'));
    expect(generic).toMatch(/couldn't load/);
    expect(`${generic}${landlordTenantsErrorMessage('x')}`).not.toMatch(/\b(loan|lender|interest|ROI)\b/i);
  });
});
