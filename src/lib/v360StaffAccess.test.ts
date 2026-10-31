import { describe, expect, it } from 'vitest';
import {
  V360_STAFF_PRICING_CONTROL,
  V360_STAFF_PRICING_MEANING,
  canChangeV360NewPlans,
  canSeeV360StaffPricingBanner,
} from './v360StaffAccess';

describe('v360 staff pricing access', () => {
  it('shows the status to staff roles and hides it from customer roles', () => {
    for (const role of ['ceo', 'cfo', 'coo', 'cto', 'cmo', 'crm', 'hr', 'rd', 'manager', 'employee', 'operations', 'super_admin', 'tenant_ops', 'landlord_ops', 'agent_ops', 'financial_ops', 'partner_ops']) {
      expect(canSeeV360StaffPricingBanner([role])).toBe(true);
    }
    for (const role of ['tenant', 'agent', 'landlord', 'supporter', 'senior_agent', 'sub_agent']) {
      expect(canSeeV360StaffPricingBanner([role])).toBe(false);
    }
    expect(canSeeV360StaffPricingBanner([])).toBe(false);
    expect(canSeeV360StaffPricingBanner(null)).toBe(false);
  });

  it('lets only cfo, coo and super admin change the switch', () => {
    expect(canChangeV360NewPlans(['cfo'])).toBe(true);
    expect(canChangeV360NewPlans(['coo'])).toBe(true);
    expect(canChangeV360NewPlans(['super_admin'])).toBe(true);
    expect(canChangeV360NewPlans(['ceo'])).toBe(false);
    expect(canChangeV360NewPlans(['manager'])).toBe(false);
    expect(canChangeV360NewPlans(['agent', 'manager'])).toBe(false);
    expect(canChangeV360NewPlans(['agent', 'cfo'])).toBe(true);
    expect(canChangeV360NewPlans(['tenant'])).toBe(false);
  });

  it('keeps the staff explainer free of dash characters used as punctuation', () => {
    expect(V360_STAFF_PRICING_MEANING).toBe(
      'OFF = new Rent Plans use current pricing; ON = new Rent Plans get 360-day Model A. Existing plans are never repriced.',
    );
    expect(V360_STAFF_PRICING_MEANING).not.toMatch(/[—–]/);
    expect(V360_STAFF_PRICING_CONTROL).not.toMatch(/[—–]/);
    expect(V360_STAFF_PRICING_CONTROL).toContain('CFO, COO and super admin');
  });
});
