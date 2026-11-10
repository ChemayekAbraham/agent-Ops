/**
 * Self-support agent facilitation fee (owner design 2026-11-10).
 *
 * A partner who supports a tenant or an empty house themselves pays rent + the fee (2%). Their
 * principal (Returns, maturity) is that amount; the landlord gets the rent; at Partner Ops
 * approval the fee pays the partner's proxy agent once. The tenant's Rent Plan stays on the rent.
 *
 * The database is authoritative: self_support_gross(rent) prices every portfolio, and
 * get_self_support_fee_policy() returns the policy. These helpers mirror that rule so a screen
 * can show the same figure before the partner confirms. While the policy is off (or unknown)
 * every amount equals the rent.
 */

export interface SelfSupportFeePolicy {
  enabled: boolean;
  /** Fraction, e.g. 0.02 for 2%. */
  rate: number;
  /** The amount the partner pays is rounded UP to a multiple of this (UGX). */
  roundTo: number;
}

export const SELF_SUPPORT_FEE_OFF: SelfSupportFeePolicy = { enabled: false, rate: 0, roundTo: 100 };

/** Parse get_self_support_fee_policy(); anything malformed reads as "off". */
export function parseSelfSupportFeePolicy(raw: unknown): SelfSupportFeePolicy {
  if (!raw || typeof raw !== 'object') return SELF_SUPPORT_FEE_OFF;
  const r = raw as Record<string, unknown>;
  const rate = Number(r.rate);
  const roundTo = Number(r.round_to);
  if (r.enabled !== true || !Number.isFinite(rate) || rate <= 0 || rate >= 0.1) {
    return SELF_SUPPORT_FEE_OFF;
  }
  return { enabled: true, rate, roundTo: Number.isFinite(roundTo) && roundTo >= 1 ? roundTo : 100 };
}

/**
 * What the partner pays for a rent: rent + fee, rounded up to policy.roundTo.
 * Mirrors public.self_support_gross(). Integer maths in cents avoids 0.1 + 0.2 drift.
 */
export function selfSupportGross(rent: number, policy: SelfSupportFeePolicy): number {
  if (!Number.isFinite(rent) || rent <= 0) return rent;
  if (!policy.enabled || policy.rate <= 0) return rent;
  const step = policy.roundTo;
  // rent * (1 + rate) computed on integers (rate has at most 4 decimals in practice).
  const scaled = Math.round(rent * Math.round((1 + policy.rate) * 10000));
  const raw = scaled / 10000;
  return Math.ceil(raw / step - 1e-9) * step;
}

/** The fee part of what the partner pays (0 while the policy is off). */
export function selfSupportProxyFee(rent: number, policy: SelfSupportFeePolicy): number {
  const gross = selfSupportGross(rent, policy);
  return Number.isFinite(gross) && Number.isFinite(rent) ? Math.max(0, gross - rent) : 0;
}
