import { describe, expect, it, vi } from 'vitest';

vi.mock('@/integrations/supabase/client', () => ({
  supabase: { from: vi.fn(), rpc: vi.fn() },
}));

import {
  PROFILE_TYPEAHEAD_MIN_CHARS,
  isPhoneLikeProfileQuery,
  profileTypeaheadFilter,
  sanitizeProfileQuery,
} from '@/lib/profileTypeahead';

describe('profileTypeaheadFilter', () => {
  it('refuses 1–2 character terms that cannot use a trigram index', () => {
    expect(profileTypeaheadFilter('')).toBeNull();
    expect(profileTypeaheadFilter('a')).toBeNull();
    expect(profileTypeaheadFilter('ab')).toBeNull();
    expect(profileTypeaheadFilter('  %  ')).toBeNull();
    expect(PROFILE_TYPEAHEAD_MIN_CHARS).toBe(3);
  });

  it('uses one name column once the term is long enough', () => {
    expect(profileTypeaheadFilter('Jane')).toEqual({
      column: 'full_name',
      pattern: '%Jane%',
    });
  });

  it('matches a phone on the last 9 digits, not a three-column OR', () => {
    expect(isPhoneLikeProfileQuery('+256 772 123 456')).toBe(true);
    expect(isPhoneLikeProfileQuery('WEL-1A2B3C')).toBe(false);
    expect(profileTypeaheadFilter('0772123456')).toEqual({
      column: 'phone',
      pattern: '%772123456',
    });
    expect(profileTypeaheadFilter('+256772123456')).toEqual({
      column: 'phone',
      pattern: '%772123456',
    });
  });

  it('uses an email prefix when the term contains @', () => {
    expect(profileTypeaheadFilter('Ada@Welile.com')).toEqual({
      column: 'email',
      pattern: 'ada@welile.com%',
    });
  });

  it('strips wildcard and filter characters before they reach PostgREST', () => {
    expect(sanitizeProfileQuery(' %Ja,ne()* ')).toBe('Jane');
    expect(profileTypeaheadFilter('%Jane%')).toEqual({
      column: 'full_name',
      pattern: '%Jane%',
    });
  });
});
