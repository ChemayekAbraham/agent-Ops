import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  buildWithdrawalAssignedSms,
  buildWithdrawalReleasedSms,
  ensureWithdrawalTrackingToken,
  isValidTrackingToken,
  withdrawalTrackingUrl,
  generateTrackingToken,
  WITHDRAWAL_TRACKING_BASE_URL,
  type TrackingTokenStore,
} from '../../supabase/functions/_shared/withdrawalTracking';

const fnSource = (rel: string) =>
  fs.readFileSync(path.resolve(__dirname, '../../supabase/functions', rel), 'utf8');

/**
 * Source with comments stripped — the banned-wording checks below are about what
 * we SEND, and the comments in these files legitimately quote the old wording to
 * explain why it was dropped.
 */
const fnCode = (rel: string) =>
  fnSource(rel)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');

/** In-memory stand-in for withdrawal_requests.receipt_token (unique, set-once). */
function memoryStore(initial: Record<string, string | null> = {}) {
  const tokens = new Map<string, string | null>(Object.entries(initial));
  let writes = 0;
  const store: TrackingTokenStore = {
    async read(id) {
      return tokens.has(id) ? tokens.get(id) ?? null : null;
    },
    async setIfMissing(id, token) {
      if (!tokens.has(id)) throw new Error('withdrawal not found');
      if (tokens.get(id)) return; // WHERE receipt_token IS NULL
      if ([...tokens.values()].includes(token)) throw new Error('23505 unique violation');
      writes++;
      tokens.set(id, token);
    },
  };
  return { store, tokens, writes: () => writes };
}

const PROMISE_OR_SENT = /arrive shortly|has been sent to you|money has been sent|payment successful|withdrawal successful|sent to your/i;

describe('Defect A: claim SMS is an assignment acknowledgement only', () => {
  const url = `${WITHDRAWAL_TRACKING_BASE_URL}${'a'.repeat(32)}`;

  it('#1 says "assigned for processing" and promises a later confirmation, never that money was sent', () => {
    const sms = buildWithdrawalAssignedSms(250000, url);
    expect(sms).toContain('Your withdrawal of UGX 250,000 has been assigned for processing.');
    expect(sms).toContain('You will receive another confirmation once payment has been sent.');
    expect(sms).toContain(url);
    expect(sms).toContain('0748747134');
    expect(sms).not.toMatch(PROMISE_OR_SENT);
    expect(sms).not.toMatch(/being processed/i);
  });

  it('released SMS does not promise when money arrives either', () => {
    const sms = buildWithdrawalReleasedSms(250000, url);
    expect(sms).not.toMatch(PROMISE_OR_SENT);
    expect(sms).toContain(url);
  });

  it('no tracking line at all rather than a shared placeholder when a link is unavailable', () => {
    const sms = buildWithdrawalAssignedSms(1000, null);
    expect(sms).not.toContain('Track your transaction');
    expect(sms).not.toContain('welileapp.com');
  });

  it('the URL is on its own line so no punctuation is glued to it', () => {
    const sms = buildWithdrawalAssignedSms(1000, url);
    expect(sms).toContain(`\n${url}\n`);
  });

  it('claim and release functions use the shared builders, not hard-coded copy or links', () => {
    const claimed = fnCode('notify-withdrawal-claimed/index.ts');
    const released = fnCode('notify-withdrawal-released/index.ts');
    for (const src of [claimed, released]) {
      expect(src).not.toMatch(/arrive shortly/i);
      expect(src).not.toContain('welileapp.com/ZQhyGb');
      expect(src).not.toContain('https://welileapp.com/auth');
    }
    expect(claimed).toContain('buildWithdrawalAssignedSms(');
    expect(released).toContain('buildWithdrawalReleasedSms(');
    // One message string feeds every provider in the fallback chain.
    expect(claimed.match(/sendSMSWithRetry\(smsRecipient, smsMsg\)/g)?.length).toBe(1);
  });
});

describe('Defect A: completion confirmation stays tied to settlement', () => {
  it('#2 the claim function never sends a payment confirmation', () => {
    const claimed = fnSource('notify-withdrawal-claimed/index.ts');
    expect(claimed).not.toMatch(/Withdrawal Successful|Payout Completed/);
  });

  it('#2 approve-withdrawal builds the "Withdrawal Successful" SMS only after the completion write', () => {
    const approve = fnSource('approve-withdrawal/index.ts');
    const completionWrite = approve.indexOf('.update(completionPayload)');
    const successSms = approve.indexOf('WELILE: Withdrawal Successful.');
    expect(completionWrite).toBeGreaterThan(0);
    expect(successSms).toBeGreaterThan(completionWrite);
  });
});

describe('Defect B: per-withdrawal tracking links', () => {
  it('#3 different withdrawals get different tracking URLs', async () => {
    const { store } = memoryStore({ w1: 'a'.repeat(32), w2: 'b'.repeat(32), w3: null, w4: null });
    const urls = await Promise.all(
      ['w1', 'w2', 'w3', 'w4'].map(async (id) => withdrawalTrackingUrl((await ensureWithdrawalTrackingToken(store, id))!)),
    );
    expect(new Set(urls).size).toBe(4);
  });

  it('#4 retries for the same withdrawal return the same URL (existing token)', async () => {
    const { store, writes } = memoryStore({ w1: 'c'.repeat(32) });
    const first = await ensureWithdrawalTrackingToken(store, 'w1');
    const second = await ensureWithdrawalTrackingToken(store, 'w1');
    expect(first).toBe('c'.repeat(32));
    expect(second).toBe(first);
    expect(writes()).toBe(0);
  });

  it('#4 a missing token is generated once and then reused, even by concurrent senders', async () => {
    const { store, writes } = memoryStore({ w9: null });
    const [a, b, c] = await Promise.all([
      ensureWithdrawalTrackingToken(store, 'w9'),
      ensureWithdrawalTrackingToken(store, 'w9'),
      ensureWithdrawalTrackingToken(store, 'w9'),
    ]);
    expect(a).toBeTruthy();
    expect(b).toBe(a);
    expect(c).toBe(a);
    expect(writes()).toBe(1);
    expect(await ensureWithdrawalTrackingToken(store, 'w9')).toBe(a);
  });

  it('a unique-index collision on generation retries with a fresh token', async () => {
    const { store } = memoryStore({ taken: 'd'.repeat(32), w5: null });
    const seq = ['d'.repeat(32), 'e'.repeat(32)];
    const token = await ensureWithdrawalTrackingToken(store, 'w5', () => seq.shift()!);
    expect(token).toBe('e'.repeat(32));
  });

  it('an unknown withdrawal yields no link (never a shared fallback)', async () => {
    const { store } = memoryStore({});
    expect(await ensureWithdrawalTrackingToken(store, 'nope')).toBeNull();
  });

  it('URLs expose only the opaque token — no internal id — and reject malformed tokens', () => {
    const token = generateTrackingToken();
    expect(token).toMatch(/^[0-9a-f]{32}$/);
    expect(isValidTrackingToken(token)).toBe(true);
    expect(withdrawalTrackingUrl(token)).toBe(`https://welileapp.com/r/${token}`);
    expect(() => withdrawalTrackingUrl('../../etc')).toThrow();
    expect(() => withdrawalTrackingUrl('3f27ab5d-d737-4440-9e69-cf77cd7e9be9')).toThrow();
    expect(isValidTrackingToken('short')).toBe(false);
  });

  it('generated tokens do not repeat', () => {
    const seen = new Set(Array.from({ length: 2000 }, () => generateTrackingToken()));
    expect(seen.size).toBe(2000);
  });
});
