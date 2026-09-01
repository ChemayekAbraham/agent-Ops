/**
 * Welile Spiro Bike lease pricing.
 *
 * The bike has a fixed base price. The access fee depends on the repayment
 * period the agent chooses, mirroring the Smartphone Advance fee grid.
 */
export const SPIRO_BIKE_BASE_PRICE = 120_000;

/** Repayment periods offered to agents and their access fee percentage. */
export const SPIRO_LEASE_PERIODS = [
  { months: 3, feePct: 33 },
  { months: 6, feePct: 36 },
  { months: 9, feePct: 39 },
  { months: 12, feePct: 42 },
] as const;

/** Share of every wallet credit applied to the bike lease. */
export const BIKE_RECOVERY_RATE = 0.15;

export interface SpiroLeaseSchedule {
  months: number;
  feePct: number;
  base: number;
  /** Total access fee in UGX. */
  accessFee: number;
  /** Base price + access fee. */
  total: number;
  /** Monthly repayment. */
  monthly: number;
  /** Amount recovered per wallet credit at the 15% recovery rate. */
  perCredit: number;
}

export function spiroLeaseSchedule(
  months: number,
  basePrice: number = SPIRO_BIKE_BASE_PRICE,
): SpiroLeaseSchedule {
  const period =
    SPIRO_LEASE_PERIODS.find((p) => p.months === months) ?? SPIRO_LEASE_PERIODS[0];
  const base = Math.max(0, Math.round(Number(basePrice) || 0));
  const accessFee = Math.round((base * period.feePct) / 100);
  const total = base + accessFee;
  return {
    months: period.months,
    feePct: period.feePct,
    base,
    accessFee,
    total,
    monthly: period.months > 0 ? Math.ceil(total / period.months) : total,
    perCredit: Math.round(total * BIKE_RECOVERY_RATE),
  };
}

/** Full 3 / 6 / 9 / 12 month grid for a base price. */
export function spiroLeaseGrid(basePrice: number = SPIRO_BIKE_BASE_PRICE): SpiroLeaseSchedule[] {
  return SPIRO_LEASE_PERIODS.map((p) => spiroLeaseSchedule(p.months, basePrice));
}
