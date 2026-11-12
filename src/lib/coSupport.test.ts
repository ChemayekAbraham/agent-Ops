import { describe, expect, it } from 'vitest';
import {
  coSupportBlockMessage,
  coSupportErrorMessage,
  coSupportInviteCopy,
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
  it('describes an empty house when sharing a house', () => {
    const h = coSupportShareText({ kind: 'house', houseTitle: '2-bedroom house', city: 'Wakiso', partnerShare: 153000, url: 'u' });
    expect(h).toContain('an empty house (2-bedroom house) in Wakiso');
    expect(h).toContain('UGX 153,000');
    expect(h).not.toMatch(BANNED);
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

describe('invitation page wording', () => {
  const now = Date.UTC(2026, 10, 12, 6);
  // The real case from 12 Nov 2026: half 1,530,000; 551,486 float; 357,000 held for own share.
  const pius = {
    found: true, kind: 'rent_plan' as const, status: 'open' as const, lead_first_name: 'Benjamin',
    tenant_first_name: 'Nakasagga', your_share: 1530000, your_monthly_rent_profit_share: 229500,
    expires_at: new Date(now + (46 * 60 + 34) * 60_000).toISOString(),
    reason: 'funds_short' as const, float_available: 194486, float_needed: 1335514, float_balance: 551486,
    float_held_for_your_shares: 357000, float_held_other: 0,
    your_open_shares: [{ id: 'x', kind: 'rent_plan' as const, title: "Mary's Rent Plan", held: 357000, expires_at: '' }],
  };
  const c = coSupportInviteCopy(pius, now);
  it('speaks to the person by the sharer\'s name', () => {
    expect(c.headline).toBe("Benjamin invited you to support Nakasagga's home together");
    expect(c.intro).toMatch(/^Benjamin has already set aside one half\./);
    expect(c.holdLine).toBe('Benjamin is holding this for you for 46h 34m');
    expect(c.acceptLabel).toBe('Join Benjamin');
    expect(c.yourHalf).toBe('Your half: UGX 1,530,000');
    expect(c.yourEarning).toBe("You'd earn UGX 229,500 a month in Rent Profit Share");
  });
  it('explains a shortfall with the float that is set aside', () => {
    expect(c.blockTitle).toBe("You're UGX 1,335,514 short of your half");
    expect(c.blockDetail).toBe(
      "You have UGX 551,486 of float. UGX 357,000 is set aside for Mary's Rent Plan that you're sharing, so UGX 194,486 is free right now. " +
        'Add UGX 1,335,514 to your wallet, then open this link again to join Benjamin.',
    );
    expect(c.blockAction).toBe('Add float to your wallet');
  });
  it('offers to free the own share only when that would be enough', () => {
    const d = coSupportInviteCopy({ ...pius, your_share: 500000, float_needed: 305514 }, now);
    expect(d.blockDetail).toMatch(/Or stop sharing your own plan to free UGX 357,000\./);
  });
  it('says plainly when there is no float at all', () => {
    expect(coSupportInviteCopy({ ...pius, float_balance: 0, float_available: 0, float_held_for_your_shares: 0 }, now).blockDetail)
      .toMatch(/^You don't have any float in your wallet yet\./);
  });
  it('words houses and success differently', () => {
    const h = coSupportInviteCopy({ ...pius, kind: 'house', tenant_first_name: null, house_title: '2-bedroom house', reason: null }, now);
    expect(h.headline).toBe('Benjamin invited you to support an empty house together');
    expect(h.intro).toMatch(/Partner Ops approve shared houses before any money moves\./);
    expect(h.successTitle).toBe('You and Benjamin have shared this house (2-bedroom house)');
    expect(h.blockTitle).toBeNull();
    expect(coSupportInviteCopy({ ...pius, reason: null }, now).successDetail).toBe(
      'Your portfolio: UGX 1,530,000. You earn UGX 229,500 a month in Rent Profit Share.',
    );
  });
  it('never uses pronouns for the sharer, banned words or a rate', () => {
    for (const reason of [null, 'funds_short', 'agreement_required', 'not_a_partner', 'paused', 'invite_expired', 'invite_declined', 'invite_completed'] as const) {
      const all = Object.values(coSupportInviteCopy({ ...pius, reason }, now)).filter(Boolean).join(' ');
      expect(all).not.toMatch(BANNED);
      expect(all).not.toMatch(/\b(he|she|his|her|him)\b/i);
      expect(all).not.toMatch(/%/);
    }
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
  it('explains house and Partner Ops refusals', () => {
    expect(coSupportErrorMessage({ message: 'HOUSE_NOT_AVAILABLE: Another partner is already sharing this house.' })).toMatch(/house is no longer available/);
    expect(coSupportErrorMessage({ message: 'PENDING_APPROVAL: x' })).toMatch(/Reject it from the approval queue/);
    expect(coSupportErrorMessage({ message: 'LANDLORD_ALREADY_PAID: x' })).toMatch(/already been paid/);
  });
  it('never shows raw technical text', () => {
    expect(coSupportErrorMessage({ message: 'duplicate key value violates unique constraint' })).toBe(
      'Something went wrong. Please try again.',
    );
    expect(coSupportErrorMessage(undefined)).toBe('Something went wrong. Please try again.');
  });
  it('explains why a preview cannot be accepted', () => {
    expect(coSupportBlockMessage({ reason: 'funds_short', float_needed: 27550 })).toBe(
      'Add UGX 27,550 to your wallet, then open this link again to join your partner.',
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
