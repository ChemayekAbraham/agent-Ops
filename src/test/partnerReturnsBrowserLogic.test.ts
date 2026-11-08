/**
 * Partner Returns Phase 4 browser logic (design v2 §3.4.3, §3.5.8, §3.5.9, §6.1): every figure takes
 * the rate the database gives, and an unknown rate shows no number (never a 15 fallback).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ rpc: vi.fn(), maybeSingle: vi.fn() }));
vi.mock('@/integrations/supabase/client', () => ({
  supabase: {
    rpc: (...args: unknown[]) => {
      const r = mocks.rpc(...args);
      return Object.assign(Promise.resolve(r), { maybeSingle: () => mocks.maybeSingle(...args) });
    },
    from: vi.fn(),
  },
}));

import { calcFunderEarnings, calcFunderEarningsAt, sumFunderEarningsAt } from '@/lib/funderEarnings';
import {
  SUPPORT_EXAMPLE_STEPS,
  buildSupportPlanExampleLineAt,
  exampleMonthlyReturnAt,
  supportExampleStepsAt,
} from '@/lib/supportPlanExample';
import { createPlanShareLink, planShareDescription, planShareFallbackDescription } from '@/lib/planShareLink';
import { houseMonthlyReturnAt, houseShareFallbackMessage, houseShareMessageFor } from '@/lib/houseSupportShare';
import { POLICY_CHANGED_MESSAGE, isPolicyChangedError, staffRateRequestFields } from '@/lib/staffPortfolioRate';
import { activationErrorFrom, noteReturnFigures, parseActivationResult } from '@/lib/promissoryNoteActivation';
import { buildNexaOfflineSalesReply, buildNexaSalesContextPrompt, calculateSupporterSalesProjection, generateLocalNexaReply } from '@/lib/nexaSalesEngine';
import { _resetPublicPartnerRateForTests, getPublicPartnerRate } from '@/lib/publicPartnerRate';

const PLAN = { rent_request_id: 'p1', funding_amount: 700_000, house_category: 'single_room', request_city: 'Kampala' };

describe('funder earnings at a given rate', () => {
  it('prices at the rate given and shows nothing without one', () => {
    const start = new Date('2026-01-01T00:00:00Z');
    expect(calcFunderEarningsAt(200_000, start, 10)).toMatchObject({ capital: 200_000, rate: 10, monthly: 20_000, annual: 240_000 });
    const none = calcFunderEarningsAt(200_000, start, null);
    expect(none).toMatchObject({ capital: 200_000, rate: null, monthly: null, weekly: null, daily: null, annual: null });
    expect(sumFunderEarningsAt([100_000, 100_000], start, 15).monthly).toBe(30_000);
  });
  it('keeps the deprecated helper unchanged (15)', () => {
    expect(calcFunderEarnings(200_000, new Date('2026-01-01T00:00:00Z')).monthly).toBe(30_000);
  });
});

describe('support plan example at a given rate', () => {
  it('states figures only with a rate', () => {
    expect(exampleMonthlyReturnAt(100_000, 10)).toBe(10_000);
    expect(exampleMonthlyReturnAt(100_000, null)).toBeNull();
    expect(supportExampleStepsAt(15)).toEqual([...SUPPORT_EXAMPLE_STEPS]);
    expect(supportExampleStepsAt(10)[2]).toBe('You earn UGX 10,000 every month for 12 months (UGX 120,000 total).');
    const blind = supportExampleStepsAt(null).join(' ');
    expect(blind).not.toMatch(/UGX 1[05],000/);
    expect(blind).toContain('at the rate shown in the app');
    expect(buildSupportPlanExampleLineAt(700_000, 10)).toBe('Support UGX 700,000 → earn UGX 70,000/month for 12 months → then renew or withdraw your UGX 700,000');
    expect(buildSupportPlanExampleLineAt(700_000, null)).toBeNull();
    expect(buildSupportPlanExampleLineAt(0, 10)).toBeNull();
  });
});

describe('share text: only SQL composes a Returns figure', () => {
  beforeEach(() => { mocks.rpc.mockReset(); mocks.maybeSingle.mockReset(); });

  it('the fallback description carries no figure', () => {
    const text = planShareFallbackDescription(PLAN);
    expect(text).toContain('earn monthly Returns');
    expect(text).not.toMatch(/105,000|70,000|per month for/);
    expect(planShareFallbackDescription({ ...PLAN, funding_amount: 0 })).toBe("Support a tenant's rent on Welile and earn monthly Returns. Support today.");
    // The deprecated composer is unchanged until its call sites move (release gate).
    expect(planShareDescription(PLAN)).toContain('per month for the next 12 months');
  });

  it('createPlanShareLink returns the description the database composed', async () => {
    mocks.maybeSingle.mockResolvedValue({ data: { code: 'abc', og_description: 'Support this tenant for UGX 700,000 ... earn UGX 70,000 ...' }, error: null });
    const link = await createPlanShareLink('u1', 'p1');
    expect(link.code).toBe('abc');
    expect(link.description).toBe('Support this tenant for UGX 700,000 ... earn UGX 70,000 ...');
  });

  it('house share message uses the database description, and no figure without it', () => {
    const house = { title: 'Single room', place: 'Kira', monthly_rent: 200_000 };
    const withDesc = houseShareMessageFor(house, 'https://share.welileapp.com/s/x', 'Support this available house through Welile. Pay ... and receive UGX 20,000 every month.');
    expect(withDesc.split('\n')[0]).toContain('receive UGX 20,000');
    expect(withDesc.match(/https:\/\//g)).toHaveLength(1);
    const blind = houseShareFallbackMessage(house, 'https://share.welileapp.com/s/x');
    expect(blind).not.toMatch(/Monthly Return:/);
    expect(blind).not.toMatch(/30,000/);
    expect(houseMonthlyReturnAt(200_000, 10)).toBe(20_000);
    expect(houseMonthlyReturnAt(200_000, null)).toBeNull();
  });
});

describe('staff form contract', () => {
  const base = { value: '15', edited: false, policyEnabled: false as boolean | null, policyFromNetwork: true };
  it('switch seen off on the network: sends the field as today', () => {
    expect(staffRateRequestFields(base)).toEqual({ fields: { roi_percentage: 15, policy_enabled_seen: false } });
    expect(staffRateRequestFields({ ...base, value: '' })).toEqual({ fields: { policy_enabled_seen: false } });
  });
  it('switch on: sends a rate only when staff edited it', () => {
    expect(staffRateRequestFields({ ...base, policyEnabled: true, value: '20' })).toEqual({ fields: { policy_enabled_seen: true } });
    expect(staffRateRequestFields({ ...base, policyEnabled: true, value: '20', edited: true })).toEqual({ fields: { roi_percentage: 20, policy_enabled_seen: true } });
  });
  it('unknown or remembered policy counts as on (never the always-send branch)', () => {
    expect(staffRateRequestFields({ ...base, policyFromNetwork: false })).toEqual({ fields: { policy_enabled_seen: false } });
    expect(staffRateRequestFields({ ...base, policyEnabled: null })).toEqual({ fields: { policy_enabled_seen: false } });
  });
  it('an invalid typed rate is an error', () => {
    expect(staffRateRequestFields({ ...base, value: '150', edited: true })).toEqual({ error: 'Monthly Returns rate must be above 0% and at most 100%' });
    expect(staffRateRequestFields({ ...base, value: 'abc', edited: true })).toHaveProperty('error');
  });
  it('recognises the 409 POLICY_CHANGED answer', async () => {
    const res = (status: number, body: unknown) => ({ context: new Response(JSON.stringify(body), { status }) });
    expect(await isPolicyChangedError(res(409, { code: 'POLICY_CHANGED', error: POLICY_CHANGED_MESSAGE }))).toBe(true);
    expect(await isPolicyChangedError(res(409, { error: 'other' }))).toBe(false);
    expect(await isPolicyChangedError(res(400, { code: 'POLICY_CHANGED' }))).toBe(false);
    expect(await isPolicyChangedError(new Error('network'))).toBe(false);
  });
});

describe('promissory note activation page data', () => {
  it('shows a note rate only when the database returned one', () => {
    expect(noteReturnFigures({ return_rate: 15, monthly_return: 150_000, amount: 1_000_000 })).toEqual({ rate: 15, monthlyReturn: 150_000 });
    expect(noteReturnFigures({ return_rate: null, monthly_return: null, amount: 1_000_000 })).toEqual({ rate: null, monthlyReturn: null });
    expect(noteReturnFigures({ amount: 1_000_000 })).toEqual({ rate: null, monthlyReturn: null }); // old lookup: no rate fields
    expect(noteReturnFigures(null)).toEqual({ rate: null, monthlyReturn: null });
  });
  it('reads the activation answer (old function: success only)', () => {
    expect(parseActivationResult({ success: true, already_active: false, return_rate: 10, monthly_return: 50_000, your_rate: 10 }))
      .toEqual({ alreadyActive: false, returnRate: 10, monthlyReturn: 50_000, yourRate: 10 });
    expect(parseActivationResult({ success: true, already_active: true })).toEqual({ alreadyActive: true, returnRate: null, monthlyReturn: null, yourRate: null });
  });
  it('maps refusals to what the page shows', () => {
    expect(activationErrorFrom(401, { error: 'Please sign in to activate this note' }).kind).toBe('sign_in');
    expect(activationErrorFrom(403, { error: 'This note is already linked to another account' }).kind).toBe('linked_elsewhere');
    expect(activationErrorFrom(403, { error: 'This note was written for another phone number or email. Partner Ops can link it for you.' }).kind).toBe('contact_mismatch');
    expect(activationErrorFrom(409, null)).toMatchObject({ kind: 'changed', message: 'This note changed while you were activating it. Please open the link again.' });
    expect(activationErrorFrom(400, { error: 'Note is already fulfilled' })).toMatchObject({ kind: 'not_open', message: 'Note is already fulfilled' });
    expect(activationErrorFrom(500, { error: 'raw database text' })).toMatchObject({ kind: 'failed', message: 'Activation failed. Please try again.' });
    expect(activationErrorFrom(null, null).kind).toBe('failed');
  });
  it('reads the refusal code first (the wording may change; the old function sends no code)', () => {
    expect(activationErrorFrom(403, { error: 'Your verified contacts do not match this note.', code: 'NOTE_CONTACT_MISMATCH' }).kind).toBe('contact_mismatch');
    expect(activationErrorFrom(403, { error: 'Partner Ops already linked it to another account', code: 'NOTE_LINKED_ELSEWHERE' }).kind).toBe('linked_elsewhere');
    expect(activationErrorFrom(403, { code: 'NOTE_CONTACT_MISMATCH' })).toMatchObject({
      kind: 'contact_mismatch',
      message: 'This note was written for another phone number or email. Partner Ops can link it for you.',
    });
  });
});

describe('Nexa sales engine takes the public rate', () => {
  it('projects at the rate given, and gives no figures without one', () => {
    const p = calculateSupporterSalesProjection(100_000, new Date('2026-01-01'), 10);
    expect(p).toMatchObject({ monthly: 10_000, annual: 120_000, totalWithPrincipal: 220_000, monthlyRate: 0.1, capital: 100_000 });
    const none = calculateSupporterSalesProjection(100_000, new Date('2026-01-01'), null);
    expect(none).toMatchObject({ monthly: null, annual: null, weekly: null, daily: null, totalReturns: null, monthlyRate: null });
    expect(none.workedExample[2]).toBe('Illustrative Returns for a new partner are shown in the app.');
    expect(none.workedExample).toHaveLength(5);
  });
  it('the offline supporter reply quotes the rate given and no figure without one', () => {
    const at15 = buildNexaOfflineSalesReply('Support UGX 100,000', false, 15);
    expect(at15).toContain('15% per month');
    expect(at15).toContain('UGX 15,000 a month');
    const blind = buildNexaOfflineSalesReply('Support UGX 100,000');
    expect(blind).not.toMatch(/\d+%/);
    expect(blind).not.toContain('UGX 10,000 a month');
    expect(generateLocalNexaReply('Support UGX 100,000', 10)).toContain('10% per month');
  });
  it('the context prompt states the rate given', () => {
    expect(buildNexaSalesContextPrompt('', 15)).toContain('15% per month');
    expect(buildNexaSalesContextPrompt('')).not.toMatch(/\b10% per month/);
  });
});

describe('getPublicPartnerRate', () => {
  beforeEach(() => { mocks.rpc.mockReset(); _resetPublicPartnerRateForTests(); });

  it('one RPC per page load', async () => {
    mocks.rpc.mockReturnValue({ data: { enabled: false, new_contract_rate: 15 }, error: null });
    expect(await getPublicPartnerRate()).toBe(15);
    expect(await getPublicPartnerRate()).toBe(15);
    expect(mocks.rpc).toHaveBeenCalledTimes(1);
    expect(mocks.rpc).toHaveBeenCalledWith('get_partner_return_policy');
  });

  it('null on an error or a malformed answer, and tries again later', async () => {
    mocks.rpc.mockReturnValueOnce({ data: null, error: { message: 'x' } });
    expect(await getPublicPartnerRate()).toBeNull();
    await Promise.resolve();
    mocks.rpc.mockReturnValueOnce({ data: { enabled: true }, error: null });
    expect(await getPublicPartnerRate()).toBeNull();
    await Promise.resolve();
    mocks.rpc.mockReturnValueOnce({ data: { enabled: true, new_contract_rate: 10 }, error: null });
    expect(await getPublicPartnerRate()).toBe(10);
  });

  it('null when the client throws', async () => {
    mocks.rpc.mockImplementation(() => { throw new Error('no client'); });
    expect(await getPublicPartnerRate()).toBeNull();
  });
});
