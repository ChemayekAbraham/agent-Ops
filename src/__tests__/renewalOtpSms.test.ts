import { beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

// The edge function opts out of the sign-up prompt with this side-effect import; the test does the same so the footer behaves as it does there.
import '../../supabase/functions/_shared/noSignupPrompt';
import { appendSupportFooter } from '../../supabase/functions/_shared/smsFooter';
import {
  buildRenewalSms,
  formatUgx,
  renewalBindingKey,
  renewalCodeHash,
  SMS_MAX_CHARS,
  type RenewalSmsInput,
} from '../../supabase/functions/_shared/renewalOtp';

// smsFooter.ts is written for Deno; this declaration lets the app's type-check accept it when the test pulls it in.
declare global {
  // eslint-disable-next-line no-var
  var Deno: { env: { get(key: string): string | undefined } };
}

// smsFooter reads SUPPORT_PHONE through Deno.env; absent here, so the default support number applies.
beforeAll(() => {
  (globalThis as any).Deno = { env: { get: () => undefined } };
});

// Stand-in for sendSmsMultiProvider.toGsm7 (that module pulls in network code): the input here is already ASCII, so only the allowed-set filter matters.
const toGsm7 = (s: string) => s.replace(/[^\x20-\x7E\n\r£]/g, '').replace(/[ \t]{2,}/g, ' ').trim();
const deps = { toGsm7, appendSupportFooter: (s: string) => appendSupportFooter(s) };
const SUPPORT = '0748747134';

const base: RenewalSmsInput = { agentName: 'Grace Nakato', code: '123456', rent: 450000, days: 60, daily: 9100, supportPhone: SUPPORT };
const transmitted = (i: RenewalSmsInput) => toGsm7(appendSupportFooter(buildRenewalSms(i, deps)));

describe('renewal OTP SMS', () => {
  it('states the NEW rent, the NEW days and the NEW daily payment, and the code', () => {
    const sms = buildRenewalSms(base, deps);
    expect(sms).toContain('UGX 450,000');
    expect(sms).toContain('60 days');
    expect(sms).toContain('UGX 9,100/day');
    expect(sms).toContain('Code 123456');
    expect(sms).toContain('Rent Plan renewal');
    expect(sms.startsWith('Welile:')).toBe(true);
  });

  it('is one SMS part once the support footer logic has run, and the footer is not added twice', () => {
    const sms = buildRenewalSms(base, deps);
    expect(transmitted(base).length).toBeLessThanOrEqual(SMS_MAX_CHARS);
    expect(toGsm7(appendSupportFooter(sms))).toBe(toGsm7(sms));
    expect(sms).toMatch(/Contact Welile Support on 0748747134$/);
  });

  it('changes with the figures: a different rent or different days is a different message', () => {
    const a = buildRenewalSms(base, deps);
    expect(buildRenewalSms({ ...base, rent: 600000, daily: 12000 }, deps)).not.toBe(a);
    expect(buildRenewalSms({ ...base, days: 90, daily: 7000 }, deps)).toContain('90 days');
    expect(buildRenewalSms({ ...base, days: 90, daily: 7000 }, deps)).not.toBe(a);
  });

  it('keeps every figure and the code when space is short: only the agent name gives way', () => {
    const long = { ...base, agentName: 'Bartholomew Wasswa Kiggundu-Ssemakula The Third', rent: 30000000, days: 364, daily: 99999999 };
    const sms = buildRenewalSms(long, deps);
    expect(transmitted(long).length).toBeLessThanOrEqual(SMS_MAX_CHARS);
    for (const part of ['UGX 30,000,000', '364 days', 'UGX 99,999,999/day', 'Code 123456']) expect(sms).toContain(part);
    const short = buildRenewalSms({ ...base, agentName: 'Joy' }, deps);
    expect(short).toContain('Agent Joy:');
  });

  it('copes with an agent name that has no usable characters (falls back to no name)', () => {
    const sms = buildRenewalSms({ ...base, agentName: '✅️✅️' }, deps);
    expect(transmitted({ ...base, agentName: '✅️✅️' }).length).toBeLessThanOrEqual(SMS_MAX_CHARS);
    expect(sms).toContain('UGX 450,000');
  });

  it('uses the regulatory wording: Rent Plan, never loan / lender / interest / ROI', () => {
    const sms = buildRenewalSms(base, deps);
    expect(sms).not.toMatch(/\b(loan|lender|interest|roi)\b/i);
  });

  it('formats amounts as "UGX 1,234" in whole shillings', () => {
    expect(formatUgx(1234)).toBe('UGX 1,234');
    expect(formatUgx(450000)).toBe('UGX 450,000');
    expect(formatUgx(1234567.6)).toBe('UGX 1,234,568');
    expect(formatUgx(0)).toBe('UGX 0');
  });
});

describe('renewal OTP binding', () => {
  const prev = '6c22418c-c068-4960-bd83-47207dbe5527';

  it('the same plan, rent, days and code give the same hash', async () => {
    expect(await renewalCodeHash(prev, 450000, 60, '123456')).toBe(await renewalCodeHash(prev, 450000, 60, '123456'));
  });

  it('a different rent gives a different hash (the code is bound to the amount)', async () => {
    expect(await renewalCodeHash(prev, 460000, 60, '123456')).not.toBe(await renewalCodeHash(prev, 450000, 60, '123456'));
  });

  it('different days give a different hash (the code is bound to the day count)', async () => {
    expect(await renewalCodeHash(prev, 450000, 90, '123456')).not.toBe(await renewalCodeHash(prev, 450000, 60, '123456'));
  });

  it('a different plan or a different code gives a different hash', async () => {
    const h = await renewalCodeHash(prev, 450000, 60, '123456');
    expect(await renewalCodeHash('d009b0b2-c89a-4a69-b6d3-24d447daac41', 450000, 60, '123456')).not.toBe(h);
    expect(await renewalCodeHash(prev, 450000, 60, '654321')).not.toBe(h);
  });

  it('a number and its numeric string are the same binding (the database returns numerics as either)', async () => {
    expect(await renewalCodeHash(prev, '450000.00', '60', '123456')).toBe(await renewalCodeHash(prev, 450000, 60, '123456'));
    expect(renewalBindingKey('450000.00', 60)).toBe('450000:60');
  });

  it('cannot be satisfied by moving digits between the rent and the days', async () => {
    expect(await renewalCodeHash(prev, 4500, 600, '123456')).not.toBe(await renewalCodeHash(prev, 45000, 60, '123456'));
  });
});

describe('rent-renewal-otp edge function wiring', () => {
  const src = fs
    .readFileSync(path.resolve(__dirname, '../../supabase/functions/rent-renewal-otp/index.ts'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');

  it('asks the context function for the NEW rent and days, and stores the binding with the code', () => {
    expect(src).toContain('p_new_rent');
    expect(src).toContain('p_new_days');
    expect(src).toMatch(/new_rent_amount:\s*c\.new_rent_amount/);
    expect(src).toMatch(/new_duration_days:\s*c\.new_days/);
    expect(src).toMatch(/code_hash:\s*await renewalCodeHash\(prevId, c\.new_rent_amount, c\.new_days, code\)/);
  });

  it('checks the binding and the hash again when the code is verified', () => {
    expect(src).toMatch(/Number\(otp\.new_rent_amount\) !== Number\(c\.new_rent_amount\)/);
    expect(src).toMatch(/Number\(otp\.new_duration_days\) !== Number\(c\.new_days\)/);
    expect(src).toMatch(/\(await renewalCodeHash\(prevId, c\.new_rent_amount, c\.new_days, code\)\) !== otp\.code_hash/);
  });

  it('sends the text through the shared sender (sender ID WELILE) with the figures from the context', () => {
    expect(src).toMatch(/rent:\s*Number\(c\.new_rent_amount\)/);
    expect(src).toMatch(/days:\s*Number\(c\.new_days\)/);
    expect(src).toMatch(/daily:\s*Number\(c\.new_daily_repayment\)/);
    const sender = fs.readFileSync(path.resolve(__dirname, '../../supabase/functions/_shared/sendSmsMultiProvider.ts'), 'utf8');
    expect(sender).toContain('sender: "WELILE"');
    expect(src).not.toMatch(/\b(loan|lender|interest|ROI)\b/i);
  });
});
