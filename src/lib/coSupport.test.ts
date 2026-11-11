import { describe, expect, it } from 'vitest';
import {
  coSupportBlockMessage,
  coSupportErrorMessage,
  coSupportOnboardingPath,
  coSupportShareText,
  coSupportShareUrl,
  coSupportSignInPath,
  coSupportTimeLeft,
  normalizeCoSupportCode,
  rememberCoSupportCode,
  takeCoSupportReturnPath,
  whatsappShareUrl,
} from './coSupport';

function memoryStore() {
  const m = new Map<string, string>();
  return {
    getItem: (k: string) => (m.has(k) ? (m.get(k) as string) : null),
    setItem: (k: string, v: string) => void m.set(k, v),
    removeItem: (k: string) => void m.delete(k),
    raw: m,
  };
}

const BANNED = /\b(loan|lender|interest|ROI|returns?)\b/i;

describe('codes and links', () => {
  it('accepts 12-character codes in any case and trims spaces', () => {
    expect(normalizeCoSupportCode('  ab12cd34ef56 ')).toBe('AB12CD34EF56');
  });
  it('rejects anything else', () => {
    for (const bad of ['', 'short', 'AB12CD34EF56X', "' OR 1=1 --", 'ab12-cd34-ef5', null, undefined]) {
      expect(normalizeCoSupportCode(bad as string)).toBeNull();
    }
  });
  it('builds the branded share link on the share host', () => {
    expect(coSupportShareUrl('AB12CD34EF56')).toBe('https://share.welileapp.com/c/AB12CD34EF56');
  });
  it('sends signed-out people back to the invitation after sign-in', () => {
    expect(coSupportSignInPath('AB12CD34EF56')).toBe('/auth?redirect=%2Fco-support%2FAB12CD34EF56');
  });
  it('sends new people to funder-onboarding with the sharer as referrer', () => {
    expect(coSupportOnboardingPath('AB12CD34EF56', '11111111-2222-4333-8444-555555555555')).toBe(
      '/funder-onboarding?ref=11111111-2222-4333-8444-555555555555&cosupport=AB12CD34EF56',
    );
    expect(coSupportOnboardingPath('AB12CD34EF56')).toBe('/funder-onboarding?cosupport=AB12CD34EF56');
  });
});

describe('share text', () => {
  const text = coSupportShareText({ tenantFirstName: 'Tom', city: 'Kampala', partnerShare: 153000, url: 'https://share.welileapp.com/c/X' });
  it('names the tenant, the city, the half and the link', () => {
    expect(text).toContain("Tom's rent in Kampala");
    expect(text).toContain('UGX 153,000');
    expect(text).toContain('Rent Profit Share');
    expect(text).toContain('48 hours');
    expect(text.endsWith('https://share.welileapp.com/c/X')).toBe(true);
  });
  it('uses approved words only', () => {
    expect(text).not.toMatch(BANNED);
    expect(coSupportShareText({ partnerShare: 1, url: 'u' })).not.toMatch(BANNED);
  });
  it('encodes the WhatsApp link', () => {
    expect(whatsappShareUrl('a b&c')).toBe('https://wa.me/?text=a%20b%26c');
  });
});

describe('coming back after funder-onboarding', () => {
  const now = Date.UTC(2026, 10, 11, 12);
  it('remembers ?cosupport and returns to the invitation once', () => {
    const s = memoryStore();
    expect(rememberCoSupportCode('?ref=x&cosupport=ab12cd34ef56', s, now)).toBe('AB12CD34EF56');
    expect(takeCoSupportReturnPath(s, now + 60_000)).toBe('/co-support/AB12CD34EF56');
    expect(takeCoSupportReturnPath(s, now + 60_000)).toBeNull();
  });
  it('ignores a bad code and keeps nothing', () => {
    const s = memoryStore();
    expect(rememberCoSupportCode('?cosupport=<script>', s, now)).toBeNull();
    expect(s.raw.size).toBe(0);
  });
  it('drops a remembered code after 48 hours', () => {
    const s = memoryStore();
    rememberCoSupportCode('?cosupport=AB12CD34EF56', s, now);
    expect(takeCoSupportReturnPath(s, now + 48 * 3600_000 + 1)).toBeNull();
  });
  it('survives junk in storage and a missing store', () => {
    const s = memoryStore();
    s.setItem('welile.cosupport.pending', '{not json');
    expect(takeCoSupportReturnPath(s, now)).toBeNull();
    s.setItem('welile.cosupport.pending', JSON.stringify({ code: '../../x', at: now }));
    expect(takeCoSupportReturnPath(s, now)).toBeNull();
    expect(takeCoSupportReturnPath(null, now)).toBeNull();
    expect(rememberCoSupportCode('?cosupport=AB12CD34EF56', null, now)).toBeNull();
  });
});

describe('messages', () => {
  it('maps server codes to plain sentences', () => {
    expect(coSupportErrorMessage({ message: 'INVITE_EXPIRED: This invitation has expired.' })).toMatch(/expired/);
    expect(coSupportErrorMessage({ message: 'AGREEMENT_REQUIRED: Sign your partnership agreement first.' })).toBe(
      'Sign your partnership agreement first.',
    );
  });
  it('keeps the amounts of PARTNER_FUNDS_SHORT', () => {
    expect(
      coSupportErrorMessage({
        message: 'PARTNER_FUNDS_SHORT: Your half is UGX 153,000. You have UGX 47,000 of operational float. Add float to your wallet, then accept.',
      }),
    ).toBe('Your half is UGX 153,000. You have UGX 47,000 of operational float. Add float to your wallet, then accept.');
  });
  it('never shows raw technical text', () => {
    expect(coSupportErrorMessage({ message: 'duplicate key value violates unique constraint' })).toBe(
      'Something went wrong. Please try again.',
    );
    expect(coSupportErrorMessage(undefined)).toBe('Something went wrong. Please try again.');
  });
  it('explains why a preview cannot be accepted', () => {
    expect(coSupportBlockMessage({ reason: 'funds_short', float_needed: 27550 })).toBe(
      'Add UGX 27,550 of float to your wallet to take your half.',
    );
    expect(coSupportBlockMessage({ reason: 'invite_completed' })).toMatch(/fully supported/);
    expect(coSupportBlockMessage({ reason: null })).toBeNull();
  });
  it('counts down the 48 hours', () => {
    const now = Date.UTC(2026, 10, 11, 12);
    expect(coSupportTimeLeft(new Date(now + (31 * 60 + 20) * 60_000).toISOString(), now)).toEqual({ expired: false, hours: 31, minutes: 20 });
    expect(coSupportTimeLeft(new Date(now - 1).toISOString(), now).expired).toBe(true);
    expect(coSupportTimeLeft('not a date', now).expired).toBe(true);
  });
});
