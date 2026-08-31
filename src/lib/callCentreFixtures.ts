/**
 * ⚠️ PLACEHOLDER DATA — delete this file when the voice API is wired.
 *
 * Sample calls so the Call Centre screens can be built and reviewed before the
 * telephony backend exists. Consumed only by `useCrmCallCentre.ts`; no
 * component imports it directly, so removing it touches exactly one file.
 *
 * Deliberately deterministic apart from the window's anchor date: statuses and
 * hangup causes are spelled the way Africa's Talking actually reports them, so
 * `deriveOutcome` is exercised through its real code path rather than a
 * pre-digested "outcome" field.
 */
import type { CalleeRole, CallRecord } from '@/lib/callCentre';

const DAY_MS = 86_400_000;

/** Anchor the window on today so the trend chart always has a right edge. */
const today = new Date();
const at = (daysAgo: number, hour: number, minute = 0) => {
  const d = new Date(today.getTime() - daysAgo * DAY_MS);
  d.setHours(hour, minute, 0, 0);
  return d.toISOString();
};

interface Person {
  id: string;
  name: string;
  phone: string;
  role: CalleeRole;
  location: string | null;
}

const PEOPLE: Person[] = [
  { id: 'p-01', name: 'Aisha Nakato', phone: '+256 700 112 233', role: 'tenant', location: 'Kampala · Nakawa' },
  { id: 'p-02', name: 'Bosco Okello', phone: '+256 701 445 566', role: 'agent', location: 'Gulu · Bardege' },
  { id: 'p-03', name: 'Carol Atim', phone: '+256 772 889 900', role: 'landlord', location: 'Kampala · Kawempe' },
  { id: 'p-04', name: 'Daniel Ssempa', phone: '+256 758 223 344', role: 'tenant', location: 'Wakiso · Kira' },
  { id: 'p-05', name: 'Esther Nabirye', phone: '+256 703 667 788', role: 'partner', location: 'Kampala · Central' },
  { id: 'p-06', name: 'Francis Mugisha', phone: '+256 782 991 002', role: 'employee', location: 'Kampala · HQ' },
  { id: 'p-07', name: 'Grace Akello', phone: '+256 705 334 221', role: 'tenant', location: 'Jinja · Walukuba' },
  { id: 'p-08', name: 'Henry Kato', phone: '+256 774 556 118', role: 'landlord', location: 'Mbarara · Kakoba' },
  { id: 'p-09', name: 'Irene Namutebi', phone: '+256 709 220 447', role: 'agent', location: 'Masaka · Nyendo' },
  { id: 'p-10', name: 'Joseph Waiswa', phone: '+256 787 664 013', role: 'tenant', location: 'Kampala · Rubaga' },
  { id: 'p-11', name: 'Keneth Byaruhanga', phone: '+256 706 881 245', role: 'partner', location: 'Fort Portal' },
  { id: 'p-12', name: 'Lydia Achieng', phone: '+256 771 309 556', role: 'employee', location: 'Kampala · HQ' },
];

const byId = (id: string) => PEOPLE.find((p) => p.id === id)!;

/** Terminal shapes exactly as the provider reports them. */
const ANSWERED = (seconds: number) => ({
  status: 'completed',
  hangupCause: 'NORMAL_CLEARING',
  durationSeconds: seconds,
});
const REJECTED = { status: 'completed', hangupCause: 'CALL_REJECTED', durationSeconds: 0 };
const BUSY = { status: 'completed', hangupCause: 'USER_BUSY', durationSeconds: 0 };
const NO_ANSWER = { status: 'no_answer', hangupCause: 'NO_ANSWER', durationSeconds: 0 };
const OFF_AIR = { status: 'failed', hangupCause: 'SUBSCRIBER_ABSENT', durationSeconds: 0 };

type Seed = {
  person: string;
  when: string;
  outcome: { status: string; hangupCause: string | null; durationSeconds: number };
  staff: string;
  summary?: string;
};

const SEEDS: Seed[] = [
  // ---- today: the "most called today" list has real repeats ----
  { person: 'p-01', when: at(0, 9, 5), outcome: NO_ANSWER, staff: 'Sarah N.' },
  { person: 'p-01', when: at(0, 11, 20), outcome: ANSWERED(214), staff: 'Sarah N.', summary: 'Confirmed she will clear the two-day arrears on Friday after her salary lands. Asked for an SMS reminder on Thursday. Tone cooperative — no escalation needed.' },
  { person: 'p-01', when: at(0, 15, 40), outcome: ANSWERED(96), staff: 'Sarah N.', summary: 'Follow-up: reminder SMS confirmed received. Nothing outstanding.' },
  { person: 'p-04', when: at(0, 9, 30), outcome: REJECTED, staff: 'Sarah N.' },
  { person: 'p-04', when: at(0, 13, 15), outcome: REJECTED, staff: 'Peter M.' },
  { person: 'p-04', when: at(0, 16, 50), outcome: ANSWERED(43), staff: 'Peter M.', summary: 'Said he was in a meeting both earlier times. Agreed to a callback tomorrow 10:00. Do not call before then.' },
  { person: 'p-07', when: at(0, 10, 10), outcome: ANSWERED(320), staff: 'Peter M.', summary: 'Long call. Disputes the late fee on her August receipt — believes payment was made on the 3rd. Escalating to Finance to check the ledger, promised a call back within 48h.' },
  { person: 'p-02', when: at(0, 10, 45), outcome: ANSWERED(158), staff: 'Sarah N.', summary: 'Agent onboarding check-in. Has 3 houses listed, needs help with photo verification. Sent him the guide.' },
  { person: 'p-03', when: at(0, 12, 0), outcome: OFF_AIR, staff: 'Peter M.' },
  { person: 'p-03', when: at(0, 14, 25), outcome: OFF_AIR, staff: 'Peter M.' },
  { person: 'p-10', when: at(0, 8, 40), outcome: ANSWERED(77), staff: 'Sarah N.' },
  { person: 'p-05', when: at(0, 11, 55), outcome: ANSWERED(265), staff: 'Peter M.', summary: 'Partner quarterly check-in. Happy with returns statement. Asked about increasing their commitment next cycle.' },
  { person: 'p-12', when: at(0, 17, 5), outcome: ANSWERED(52), staff: 'Sarah N.' },
  { person: 'p-06', when: at(0, 16, 15), outcome: BUSY, staff: 'Sarah N.' },

  // ---- previous days: gives the trend chart shape ----
  { person: 'p-02', when: at(1, 10, 0), outcome: ANSWERED(180), staff: 'Sarah N.' },
  { person: 'p-08', when: at(1, 11, 30), outcome: REJECTED, staff: 'Peter M.' },
  { person: 'p-09', when: at(1, 14, 0), outcome: ANSWERED(142), staff: 'Peter M.', summary: 'Reviewed her collection numbers. Behind on two tenants, will follow up this week.' },
  { person: 'p-11', when: at(1, 15, 45), outcome: NO_ANSWER, staff: 'Sarah N.' },

  { person: 'p-07', when: at(2, 9, 15), outcome: ANSWERED(210), staff: 'Sarah N.' },
  { person: 'p-01', when: at(2, 10, 30), outcome: REJECTED, staff: 'Peter M.' },
  { person: 'p-03', when: at(2, 13, 40), outcome: ANSWERED(95), staff: 'Peter M.', summary: 'Landlord confirmed the unit is vacant and ready for listing.' },
  { person: 'p-10', when: at(2, 16, 20), outcome: NO_ANSWER, staff: 'Sarah N.' },
  { person: 'p-04', when: at(2, 17, 0), outcome: BUSY, staff: 'Sarah N.' },

  { person: 'p-05', when: at(3, 11, 0), outcome: ANSWERED(300), staff: 'Peter M.' },
  { person: 'p-06', when: at(3, 12, 20), outcome: ANSWERED(64), staff: 'Sarah N.' },
  { person: 'p-08', when: at(3, 14, 50), outcome: REJECTED, staff: 'Peter M.' },
  { person: 'p-09', when: at(3, 15, 30), outcome: REJECTED, staff: 'Peter M.' },

  { person: 'p-11', when: at(4, 9, 45), outcome: ANSWERED(133), staff: 'Sarah N.', summary: 'Partner asked for the mid-year statement. Emailed it during the call.' },
  { person: 'p-12', when: at(4, 10, 55), outcome: ANSWERED(88), staff: 'Sarah N.' },
  { person: 'p-02', when: at(4, 13, 10), outcome: NO_ANSWER, staff: 'Peter M.' },

  { person: 'p-01', when: at(5, 10, 5), outcome: ANSWERED(175), staff: 'Sarah N.' },
  { person: 'p-07', when: at(5, 11, 40), outcome: REJECTED, staff: 'Peter M.' },
  { person: 'p-10', when: at(5, 15, 0), outcome: ANSWERED(112), staff: 'Peter M.' },

  { person: 'p-03', when: at(6, 9, 20), outcome: ANSWERED(240), staff: 'Peter M.' },
  { person: 'p-04', when: at(6, 12, 45), outcome: OFF_AIR, staff: 'Sarah N.' },
  { person: 'p-08', when: at(6, 16, 30), outcome: ANSWERED(69), staff: 'Sarah N.' },

  { person: 'p-05', when: at(8, 10, 15), outcome: ANSWERED(190), staff: 'Sarah N.' },
  { person: 'p-09', when: at(8, 14, 20), outcome: REJECTED, staff: 'Peter M.' },
  { person: 'p-06', when: at(9, 11, 10), outcome: ANSWERED(58), staff: 'Peter M.' },
  { person: 'p-11', when: at(10, 15, 25), outcome: NO_ANSWER, staff: 'Sarah N.' },
  { person: 'p-12', when: at(11, 9, 50), outcome: ANSWERED(126), staff: 'Sarah N.' },
  { person: 'p-02', when: at(12, 13, 35), outcome: ANSWERED(203), staff: 'Peter M.' },
  { person: 'p-07', when: at(13, 10, 40), outcome: REJECTED, staff: 'Sarah N.' },
];

export const CALL_CENTRE_FIXTURES: CallRecord[] = SEEDS.map((seed, i) => {
  const person = byId(seed.person);
  return {
    id: `fx-${String(i + 1).padStart(3, '0')}`,
    calleeId: person.id,
    calleeName: person.name,
    calleePhone: person.phone,
    calleeAvatarUrl: null,
    calleeRole: person.role,
    location: person.location,
    status: seed.outcome.status,
    hangupCause: seed.outcome.hangupCause,
    durationSeconds: seed.outcome.durationSeconds,
    calledAt: seed.when,
    staffId: null,
    staffName: seed.staff,
    summary: seed.summary ?? null,
  };
});
