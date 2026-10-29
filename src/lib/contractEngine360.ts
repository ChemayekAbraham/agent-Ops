/**
 * Unified 360-Day Contract Engine (pricing_version 'v360'), NEW Rent Plans only.
 * Pure functions; existing plans keep their original pricing.
 *
 * G_m   = CEIL((P * 1.15^m + Rail_m) / (0.90 - 0.07 * m)),  Rail_m = max(3500*m, 0.025*m*P)
 * Daily = CEIL(G_m / (30 * m))
 * Buckets per 30-day cycle (m = 1): Landlord P, Partner 15% of P, Agent 10% of G
 * (8% sub agent + 2% general, on cash collected only), Rail, Welile fixed 7% of G.
 */
export const PRICING_VERSION_V360 = 'v360' as const;
export const PARTNER_MONTHLY_RATE = 0.15;
export const CONTRACT_DAYS = 360;
export const CONTRACT_MONTHS = 12;

export function railFee(principal: number, months = 1): number {
  return Math.max(3500 * months, 0.025 * months * principal);
}

export function grossForMonths(principal: number, months = 1): number {
  if (!(principal > 0)) throw new Error('Rent amount must be above zero');
  if (!(months >= 1 && months <= 12)) throw new Error('Months must be between 1 and 12');
  const denom = 0.9 - 0.07 * months;
  if (denom <= 0) throw new Error('Months too long for this pricing');
  return Math.ceil((principal * Math.pow(1.15, months) + railFee(principal, months)) / denom);
}

export function dailyRate(principal: number, months = 1): number {
  return Math.ceil(grossForMonths(principal, months) / (30 * months));
}

export interface V360Quote {
  principal: number;
  gross: number;
  daily: number;
  buckets: { landlord: number; partner: number; agent: number; agentSub: number; agentGeneral: number; rail: number; welile: number };
  partnerMonthly: number;
  partnerTwelveMonths: number;
  receivable360: number;
}

export function quoteV360(principal: number): V360Quote {
  const gross = grossForMonths(principal, 1);
  const daily = dailyRate(principal, 1);
  const partner = Math.round(principal * PARTNER_MONTHLY_RATE);
  const agentSub = Math.round(gross * 0.08);
  const agentGeneral = Math.round(gross * 0.02);
  const rail = Math.round(railFee(principal, 1));
  const welile = Math.round(gross * 0.07);
  return {
    principal, gross, daily,
    buckets: { landlord: principal, partner, agent: agentSub + agentGeneral, agentSub, agentGeneral, rail, welile },
    partnerMonthly: partner,
    partnerTwelveMonths: partner * CONTRACT_MONTHS,
    receivable360: CONTRACT_DAYS * daily,
  };
}

/** Worked example for new-quote screens. It does not price an existing Rent Plan. */
const _modelA = quoteV360(100_000);
export const V360_MODEL_A_EXAMPLE = {
  principal: 100_000,
  gross: _modelA.gross,
  daily: _modelA.daily,
  partnerMonthly: _modelA.partnerMonthly,
  partnerTwelveMonths: _modelA.partnerTwelveMonths,
} as const;

/** Contract horizon: missed and vacant days postpone the end, never write off paid days. */
export function contractEndDay(missedDays: number, vacantDays: number): number {
  return CONTRACT_DAYS + Math.max(0, missedDays) + Math.max(0, vacantDays);
}

export function remainingReceivable(daily: number, paidDays: number): number {
  return Math.max(0, CONTRACT_DAYS - Math.max(0, paidDays)) * daily;
}

/**
 * Day-30 settlement: Partner 15% and next Landlord principal are always paid.
 * Cash available after agent 10% and rail is used first; any shortfall is drawn
 * from the buffer pool (A_buffer).
 */
export function day30Settlement(q: V360Quote, cashCollected: number) {
  const agent = Math.round(cashCollected * 0.1);
  const net = Math.max(0, cashCollected - agent - q.buckets.rail);
  const owed = q.partnerMonthly + q.principal;
  const bufferDraw = Math.max(0, owed - net);
  return { partnerPaid: q.partnerMonthly, landlordPaid: q.principal, agentPaid: agent, bufferDraw, surplus: Math.max(0, net - owed) };
}
