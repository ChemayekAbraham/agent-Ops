import { describe, it, expect } from 'vitest';
import { parsePublicSupportPlan } from '@/lib/publicSupportPlan';

const safePayload = {
  status: 'available',
  plan_id: 'plan-1',
  photo_url: 'https://example.com/house.jpg',
  city: 'Kampala',
  house_category: 'Shop',
  tenant_first_name: 'Test',
  funding_amount: 450000,
  monthly_return: 67500,
  twelve_month_total: 810000,
};

describe('public support plan parsing', () => {
  it('keeps only the whitelisted safe fields', () => {
    const result = parsePublicSupportPlan(safePayload);
    expect(result.status).toBe('available');
    if (result.status !== 'available') return;
    expect(result.plan).toEqual({
      planId: 'plan-1',
      photoUrl: 'https://example.com/house.jpg',
      city: 'Kampala',
      houseCategory: 'Shop',
      tenantFirstName: 'Test',
      fundingAmount: 450000,
      monthlyReturn: 67500,
      twelveMonthTotal: 810000,
    });
  });

  it('drops phone numbers, full names, GPS and wallet data even if the payload carries them', () => {
    const leaky = {
      ...safePayload,
      tenant_phone: '+256700000000',
      landlord_phone: '0700000001',
      tenant_full_name: 'Test Tenant Fullname',
      landlord_name: 'Landlord Fullname',
      national_id: 'CM1234567890AB',
      request_latitude: 0.34,
      request_longitude: 32.58,
      proxy_agent_phone: '+256711111111',
      available_balance: 999999,
      wallet_balance: 12345,
    };
    const result = parsePublicSupportPlan(leaky);
    expect(result.status).toBe('available');
    if (result.status !== 'available') return;
    const serialized = JSON.stringify(result.plan);
    expect(serialized).not.toMatch(/700000000|700000001|711111111|Fullname|CM1234567890AB|0\.34|32\.58|999999|12345/);
    expect(Object.keys(result.plan).sort()).toEqual([
      'city',
      'fundingAmount',
      'houseCategory',
      'monthlyReturn',
      'photoUrl',
      'planId',
      'tenantFirstName',
      'twelveMonthTotal',
    ]);
  });

  it('treats unavailable, malformed and error payloads as unavailable', () => {
    expect(parsePublicSupportPlan({ status: 'unavailable' })).toEqual({ status: 'unavailable' });
    expect(parsePublicSupportPlan(null)).toEqual({ status: 'unavailable' });
    expect(parsePublicSupportPlan('nope')).toEqual({ status: 'unavailable' });
    expect(parsePublicSupportPlan({ status: 'available' })).toEqual({ status: 'unavailable' });
  });
});
