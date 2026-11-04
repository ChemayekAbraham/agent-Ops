import { describe, it, expect, vi } from 'vitest';
vi.mock('@/integrations/supabase/client', () => ({ supabase: {} }));
import { enrollmentIdBlockers } from '@/lib/welileHomesTenantDrafts';

const base = { phone: '0772123456', fullName: 'John Doe', existingTenant: false, nin: 'CM12345678901A', hasPhoto: true, ninInUse: false };

describe('Welile Homes enrolment requires full tenant ID', () => {
  it('is ready only with phone, name, valid NIN and photo', () => {
    expect(enrollmentIdBlockers(base)).toEqual([]);
  });
  it('blocks without a passport photo', () => {
    expect(enrollmentIdBlockers({ ...base, hasPhoto: false })).toContain('Passport photo');
  });
  it('blocks a NIN not starting with CM or CF', () => {
    expect(enrollmentIdBlockers({ ...base, nin: 'CX12345678901A' }).length).toBe(1);
  });
  it('blocks a NIN already used by another tenant', () => {
    expect(enrollmentIdBlockers({ ...base, ninInUse: true })).toEqual(['NIN not used by another tenant']);
  });
  it('existing tenant missing ID must still provide it', () => {
    expect(enrollmentIdBlockers({ ...base, existingTenant: true, fullName: '', nin: '', hasPhoto: false }).length).toBe(2);
  });
  it('existing tenant with complete ID only needs phone', () => {
    expect(enrollmentIdBlockers({ ...base, existingTenant: true, nin: '', hasPhoto: false, idAlreadyComplete: true })).toEqual([]);
  });
});

describe('NIN check limit', () => {
  it('blocks enrolment with the rate-limit message', () => {
    expect(enrollmentIdBlockers({ ...base, ninLimited: true })).toEqual(['Too many ID checks – try again later']);
  });
});
