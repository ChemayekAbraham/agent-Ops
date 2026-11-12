import { describe, expect, it } from 'vitest';
import {
  coSupportBlockMessage,
  coSupportErrorMessage,
  coSupportFloatWatchState,
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
  /** every string the page can show, functions called with sample values */
  const text = (x: unknown): string =>
    typeof x === 'string' ? x
      : typeof x === 'function' ? `${(x as (a: unknown) => string)('MTN')} ${(x as (a: unknown) => string)(1000)}`
        : Array.isArray(x) ? x.map(text).join(' ')
          : x && typeof x === 'object' ? Object.values(x).map(text).join(' ')
            : '';
  it("speaks to the person by the sharer's name", () => {
    expect(c.leadName).toBe('Benjamin');
    expect(c.leadTagline).toBe('Welile partner · invited you');
    expect(c.leadPhotoAlt).toBe("Benjamin's profile photo");
    expect(c.headline).toBe("Benjamin invited you to support Nakasagga's home together");
    expect(c.intro).toBe("Join Benjamin and support Nakasagga's home together. You both earn Rent Profit Share every month.");
    expect(c.holdLine).toBe('Benjamin is holding this for you for 46h 34m');
    expect([c.holdPrefix, c.holdTime]).toEqual(['Benjamin is holding this for you for', '46h 34m']);
    expect(c.acceptLabel).toBe('Join Benjamin');
    expect(c.declineLabel).toBe('Not this time');
    expect([c.joinAmount, c.joinAmountLabel]).toEqual(['UGX 1,530,000', 'to join']);
    expect([c.earningAmount, c.earningLabel]).toEqual(['UGX 229,500', 'Rent Profit Share a month']);
  });
  it('never says "half" to the person joining', () => {
    for (const reason of [null, 'funds_short'] as const) {
      expect(text(coSupportInviteCopy({ ...pius, reason }, now))).not.toMatch(/\bhalf\b/i);
      expect(text(coSupportInviteCopy({ ...pius, reason, kind: 'house', house_title: 'x' }, now))).not.toMatch(/\bhalf\b/i);
    }
  });
  it('shows a shortfall as "add X to join" with what is free and what is held', () => {
    expect(c.blockTitle).toBe('Add UGX 1,335,514 to join');
    expect(c.floatLines).toEqual([{ label: 'Free in your float', amount: 'UGX 194,486' }]);
    expect(c.floatNotes).toEqual(["UGX 357,000 more is held for Mary's Rent Plan"]);
    expect(c.blockAction).toBe('Add float to join Benjamin');
    expect(c.blockDetail).toBe("You have UGX 194,486 free in your float. UGX 357,000 more is held for Mary's Rent Plan.");
    expect(c.depositTitle).toBe('Add UGX 1,335,514');
  });
  it('names money waiting on something else, and copes without the float breakdown', () => {
    const d = coSupportInviteCopy({ ...pius, float_held_for_your_shares: 0, your_open_shares: [], float_held_other: 50000 }, now);
    expect(d.floatNotes).toEqual(['UGX 50,000 more is waiting on another support']);
    const old = coSupportInviteCopy({ ...pius, float_balance: undefined }, now);
    expect(old.floatLines).toEqual([]);
    expect(old.blockDetail).toBe('Add UGX 1,335,514 of float to join Benjamin.');
  });
  it('lays out what happens when they join, with the first Rent Profit Share 30 days out', () => {
    expect(c.firstRentProfitShareDate).toBe('12 Dec 2026');
    expect(c.timeline.map((s) => [s.when, s.text, s.amount, s.tone])).toEqual([
      ['Today', 'You join with', 'UGX 1,530,000', 'now'],
      ['Today', "Nakasagga's rent is paid to the landlord", null, 'next'],
      ['12 Dec 2026', 'Your first Rent Profit Share:', 'UGX 229,500', 'next'],
      ['Every month after', 'UGX 229,500 Rent Profit Share', null, 'later'],
    ]);
  });
  it('words the add-float sheets', () => {
    expect(c.depositIntro).toBe('Pay Welile with Mobile Money. It lands in your float, then you can join Benjamin.');
    expect(c.waitingDetail('mtn')).toBe("We're matching your MTN payment. This usually takes a few seconds.");
    expect(c.waitingDetail('airtel')).toMatch(/your Airtel payment/);
    expect(c.arrivedDetail(1335514)).toBe('UGX 1,335,514 is in your float. You can join Benjamin now.');
    expect(c.arrivedAction).toBe('Join Benjamin now');
  });
  it('words houses and success differently', () => {
    const h = coSupportInviteCopy({ ...pius, kind: 'house', tenant_first_name: null, house_title: '2-bedroom house', city: 'Wakiso', reason: null }, now);
    expect(h.headline).toBe('Benjamin invited you to support an empty house together');
    expect(h.intro).toBe('Join Benjamin and support this house together. You both earn Rent Profit Share every month.');
    expect([h.houseLine, h.houseSubLine]).toEqual(['2-bedroom house', 'Wakiso · verified, waiting for a tenant']);
    expect(h.timeline).toEqual([]);
    expect(h.successTitle).toBe('You and Benjamin now share this house');
    expect(h.successCard.first).toBe('30 days after approval');
    expect(h.findAnotherLabel).toBe('Find another house');
    expect(h.blockTitle).toBeNull();
    const r = coSupportInviteCopy({ ...pius, reason: null }, now);
    expect(r.successPill).toBe('Benjamin + you · 50/50');
    expect(r.successTitle).toBe("You and Benjamin now support Nakasagga's home together");
    expect(r.successDetail).toBe("Nakasagga's full rent has gone to the agent to pay the landlord. Thank you for joining.");
    expect(r.successCard).toMatchObject({ title: "Nakasagga's Rent Plan", putIn: 'UGX 1,530,000', earning: 'UGX 229,500', first: '12 Dec 2026' });
    expect(r.nextSteps.map((s) => [s.done, s.title])).toEqual([
      [true, "You're in"], [true, 'Rent sent to the agent'], [false, 'Your first Rent Profit Share'],
    ]);
  });
  it('falls back to "your partner" when the sharer has no name', () => {
    const n = coSupportInviteCopy({ ...pius, lead_first_name: null }, now);
    expect(n.headline).toMatch(/^Your partner invited you/);
    expect(n.acceptLabel).toBe('Join your partner');
    expect(n.successPill).toBe('Your partner + you · 50/50');
  });
  it('never uses pronouns for the sharer, banned words or a rate', () => {
    for (const reason of [null, 'funds_short', 'agreement_required', 'not_a_partner', 'paused', 'invite_expired', 'invite_declined', 'invite_completed'] as const) {
      for (const kind of ['rent_plan', 'house'] as const) {
        const all = text(coSupportInviteCopy({ ...pius, reason, kind }, now));
        expect(all).not.toMatch(BANNED);
        expect(all).not.toMatch(/\b(he|she|his|her|him)\b/i);
        expect(all).not.toMatch(/%/);
      }
    }
  });
});

describe("waiting for float after \"I've paid\"", () => {
  const t0 = Date.UTC(2026, 10, 12, 6);
  it('is idle until a deposit is submitted', () => {
    expect(coSupportFloatWatchState({ submittedAt: null, preview: { can_accept: true } })).toBe('idle');
  });
  it('waits, then says it is slow after two minutes', () => {
    const short = { reason: 'funds_short' as const, float_needed: 10 };
    expect(coSupportFloatWatchState({ submittedAt: t0, preview: short, depositStatus: 'pending', now: t0 + 5_000 })).toBe('waiting');
    expect(coSupportFloatWatchState({ submittedAt: t0, preview: short, depositStatus: 'pending', now: t0 + 120_000 })).toBe('slow');
  });
  it('arrives once the server says they can join', () => {
    expect(coSupportFloatWatchState({ submittedAt: t0, preview: { can_accept: true, reason: null }, depositStatus: 'approved', now: t0 })).toBe('arrived');
  });
  it('stops on a rejected deposit, but keeps waiting while still short after approval', () => {
    const short = { reason: 'funds_short' as const, float_needed: 10 };
    expect(coSupportFloatWatchState({ submittedAt: t0, preview: short, depositStatus: 'rejected', now: t0 })).toBe('rejected');
    expect(coSupportFloatWatchState({ submittedAt: t0, preview: short, depositStatus: 'approved', now: t0 })).toBe('waiting');
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
      'Add UGX 27,550 of float to join your partner.',
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
