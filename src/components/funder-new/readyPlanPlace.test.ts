import { describe, it, expect } from 'vitest';
import { matchesReadyPlanSearch, readyPlanPlace } from './utils';
import type { FunderNewFilters, FunderNewReadyPlan } from './types';

const plan = (over: Partial<FunderNewReadyPlan>): FunderNewReadyPlan =>
  ({
    rent_request_id: 'plan-1',
    funding_amount: 250000,
    request_city: null,
    tenant_location: null,
    ...over,
  }) as FunderNewReadyPlan;

const filters = (search: string): FunderNewFilters => ({
  search,
  location: '',
  amount: 'all',
  sort: 'recommended',
  rentMin: null,
  rentMax: null,
  radiusKm: 'all',
  withinFloat: false,
});

describe('readyPlanPlace', () => {
  it('drops the sub-county the agent recorded, keeping village, district and region', () => {
    expect(
      readyPlanPlace(
        plan({
          request_city: 'Katabi Town Council',
          tenant_location: 'KAWAFU, Katabi Town Council, Wakiso, Central',
        }),
      ),
    ).toBe('KAWAFU, Wakiso, Central');
  });

  it('drops county, division and municipality place parts', () => {
    expect(readyPlanPlace(plan({ tenant_location: 'Bukoto, Busiro County South, Wakiso, Central' }))).toBe(
      'Bukoto, Wakiso, Central',
    );
    expect(readyPlanPlace(plan({ tenant_location: 'Natebi, Kawempe Division, Kampala, Central' }))).toBe(
      'Natebi, Kampala, Central',
    );
    expect(readyPlanPlace(plan({ tenant_location: 'Kabaale, Makindye-Ssabagabo Municipality, Wakiso, Central' }))).toBe(
      'Kabaale, Wakiso, Central',
    );
  });

  it('keeps a town the funder would browse by when it is not the recorded sub-county', () => {
    expect(readyPlanPlace(plan({ request_city: 'Kigishu', tenant_location: 'Kabaale, Entebbe, Wakiso, Central' }))).toBe(
      'Kabaale, Entebbe, Wakiso, Central',
    );
  });

  it('falls back to the recorded city when the tenant has no place on file', () => {
    expect(readyPlanPlace(plan({ request_city: 'Mbale', tenant_location: null }))).toBe('Mbale');
    expect(readyPlanPlace(plan({ request_city: null, tenant_location: null }))).toBe('Location on file');
  });

  it('still finds a plan when the funder searches the hidden sub-county', () => {
    const p = plan({
      request_city: 'Katabi Town Council',
      tenant_location: 'KAWAFU, Katabi Town Council, Wakiso, Central',
    });
    expect(matchesReadyPlanSearch(p, filters('katabi'))).toBe(true);
  });
});
