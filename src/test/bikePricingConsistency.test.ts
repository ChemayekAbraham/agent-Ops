import { describe, it, expect, vi } from 'vitest';

vi.mock('@/integrations/supabase/client', () => ({
  supabase: {
    from: () => ({ select: () => Promise.resolve({ data: [] }) }),
  },
}));

import { resolveBikeBasePrice } from '@/hooks/useBikeCatalogCosts';
import { spiroLeaseSchedule } from '@/lib/spiroBikeLease';

describe('Bike Pricing Consistency across Catalog, Dashboard, and Agent Ops', () => {
  it('resolves genuine catalog base price when stored valuation is base price', () => {
    // Spiro Ekocycle base price 145,000
    const resolved = resolveBikeBasePrice(145000, 23, 'Spiro Ekocycle', 145000);
    expect(resolved).toBe(145000);

    const schedule = spiroLeaseSchedule(23, resolved);
    expect(schedule.base).toBe(145000);
    expect(schedule.feePct).toBe(336);
    expect(schedule.total).toBe(632200);
    expect(schedule.monthly).toBe(27487);
  });

  it('recovers base price when stored valuation was mistakenly saved as schedule.total (e.g. 632,200)', () => {
    // When order was placed, schedule.total (632,200) was stored as valuation_amount
    const storedValuation = 632200;
    const term = 23;
    const catalogBase = 145000;

    const resolved = resolveBikeBasePrice(storedValuation, term, 'Spiro Ekocycle', catalogBase);
    expect(resolved).toBe(145000);

    // Schedule computed with resolved base price matches the catalog terms exactly
    const schedule = spiroLeaseSchedule(term, resolved);
    expect(schedule.base).toBe(145000);
    expect(schedule.total).toBe(632200);
    expect(schedule.monthly).toBe(27487);
    expect(schedule.accessFee).toBe(487200);
  });

  it('matches Spiro Commando base price and terms', () => {
    // Spiro Commando base price 185,000, 12 months
    const resolved = resolveBikeBasePrice(185000, 12, 'Spiro Commando', 185000);
    expect(resolved).toBe(185000);

    const schedule = spiroLeaseSchedule(12, resolved);
    expect(schedule.base).toBe(185000);
    expect(schedule.feePct).toBe(182);
    expect(schedule.total).toBe(521700);
  });
});
