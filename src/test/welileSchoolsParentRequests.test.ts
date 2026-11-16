import { describe, it, expect, vi } from 'vitest';

// The test environment has no Supabase URL; these helpers never call it.
vi.mock('@/integrations/supabase/client', () => ({ supabase: {} }));
import { emptyParentRequest, isOpenParentRequest, parentRequestErrorMessage, parentRequestErrors } from '@/lib/welileSchoolsParentRequests';

const ok = { ...emptyParentRequest(), school_id: 's1', child_name: 'Amina Nakato', parent_name: 'Sarah Nakato', parent_phone: '0772 123 456' };

describe('parent fee request form', () => {
  it('accepts a complete request, with or without a term fee', () => {
    expect(parentRequestErrors(ok)).toEqual({});
    expect(parentRequestErrors({ ...ok, term_fee: '850000' })).toEqual({});
  });

  it('asks for the school, names and a real phone number', () => {
    const e = parentRequestErrors(emptyParentRequest());
    expect(Object.keys(e).sort()).toEqual(['child_name', 'parent_name', 'parent_phone', 'school_id']);
    expect(parentRequestErrors({ ...ok, parent_phone: '0772' }).parent_phone).toBeTruthy();
  });

  it('refuses a term fee above the plan limit', () => {
    expect(parentRequestErrors({ ...ok, term_fee: '60000000' }).term_fee).toBeTruthy();
  });

  it('treats only new and contacted requests as open', () => {
    expect(isOpenParentRequest('new')).toBe(true);
    expect(isOpenParentRequest('contacted')).toBe(true);
    expect(isOpenParentRequest('sent_to_welile')).toBe(false);
    expect(isOpenParentRequest('declined')).toBe(false);
  });

  it('turns missing database functions into a plain message', () => {
    expect(parentRequestErrorMessage({ message: 'Could not find the function public.welile_school_partner_schools' })).toBe('Parent requests are not switched on yet. Try again later.');
    expect(parentRequestErrorMessage({ message: 'AUTH_REQUIRED' })).toBe('Sign in to send a request.');
  });
});
