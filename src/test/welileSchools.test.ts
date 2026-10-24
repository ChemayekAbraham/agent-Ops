import { describe, it, expect } from 'vitest';
import { buildSchoolSignupLink, smartphoneFields, toIntlDigits } from '@/lib/welileSchools';
import { computeSchoolKpis } from '@/components/executive/agent-ops-v2/WelileSchoolsOps';

describe('Welile Schools rules', () => {
  it('builds the sign-up link with agent, school and profile', () => {
    expect(buildSchoolSignupLink('a1', 's1', 'p1')).toBe('https://welileapp.com/auth?ref=a1&school=s1&profile=p1');
  });
  it('no smartphone queues a free smartphone as Requested', () => {
    expect(smartphoneFields(false)).toEqual({ has_smartphone: false, needs_free_smartphone: true, smartphone_status: 'Requested' });
  });
  it('has smartphone does not join the free smartphone queue', () => {
    expect(smartphoneFields(true).needs_free_smartphone).toBe(false);
  });
  it('normalises local numbers for WhatsApp', () => {
    expect(toIntlDigits('0700 000 000')).toBe('256700000000');
  });
  it('pending delivery counts Requested and Approved, not Delivered', () => {
    const k = computeSchoolKpis([], [
      { id: '1', school_id: 's', role: 'pupil', needs_free_smartphone: true, smartphone_status: 'Requested' },
      { id: '2', school_id: 's', role: 'parent', needs_free_smartphone: true, smartphone_status: 'Delivered' },
    ]);
    expect(k.phonesRequested).toBe(2);
    expect(k.phonesPending).toBe(1);
  });
});
