import { describe, expect, it } from 'vitest';
import {
  SELF_SUPPORT_FEE_OFF,
  parseSelfSupportFeePolicy,
  selfSupportGross,
  selfSupportProxyFee,
} from './selfSupportFee';

const ON = { enabled: true, rate: 0.02, roundTo: 100 };

describe('selfSupportGross (mirrors public.self_support_gross)', () => {
  it('adds 2% to a round rent', () => {
    expect(selfSupportGross(300_000, ON)).toBe(306_000);
    expect(selfSupportGross(500_000, ON)).toBe(510_000);
    expect(selfSupportProxyFee(300_000, ON)).toBe(6_000);
  });

  it('rounds the amount the partner pays up to the nearest 100', () => {
    // 255,555 x 1.02 = 260,666.1 -> 260,700
    expect(selfSupportGross(255_555, ON)).toBe(260_700);
    expect(selfSupportProxyFee(255_555, ON)).toBe(5_145);
    // 490,000 x 1.02 = 499,800 exactly: no extra rounding
    expect(selfSupportGross(490_000, ON)).toBe(499_800);
  });

  it('equals the rent while the policy is off', () => {
    expect(selfSupportGross(300_000, SELF_SUPPORT_FEE_OFF)).toBe(300_000);
    expect(selfSupportProxyFee(300_000, SELF_SUPPORT_FEE_OFF)).toBe(0);
  });

  it('leaves zero and bad input alone', () => {
    expect(selfSupportGross(0, ON)).toBe(0);
    expect(selfSupportProxyFee(Number.NaN, ON)).toBe(0);
  });
});

describe('parseSelfSupportFeePolicy', () => {
  it('reads the RPC shape', () => {
    expect(parseSelfSupportFeePolicy({ enabled: true, rate: 0.02, round_to: 100 })).toEqual(ON);
  });

  it('treats off, missing or out-of-range as off', () => {
    expect(parseSelfSupportFeePolicy({ enabled: false, rate: 0.02, round_to: 100 })).toEqual(SELF_SUPPORT_FEE_OFF);
    expect(parseSelfSupportFeePolicy(null)).toEqual(SELF_SUPPORT_FEE_OFF);
    expect(parseSelfSupportFeePolicy({ enabled: true, rate: 0.5, round_to: 100 })).toEqual(SELF_SUPPORT_FEE_OFF);
  });
});
