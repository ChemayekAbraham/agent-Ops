/**
 * Unified 360-Day Contract Engine (pricing_version 'v360'), NEW Rent Plans only.
 * Pure functions; existing plans keep their original pricing.
 *
 * Approved 30-day cycle (exact shillings, matching waterfall.py on every
 * published example). Rail is max(3500, the 2.5% of P rounded up to a shilling)
 * and Gross is CEIL((P * 1.15 + Rail) / 0.83). Daily is CEIL(Gross / 30).
 * Multi-month compound quotes stay on the previous formula and are not the
 * approved cycle.
 *
 * Per cycle, of Gross: sub-agent floor(6%), general agent floor(2%), Cover Pool
 * floor(2%) plus the rounding residual, Welile floor(7%). Tithe is floor(10%)
 * of Welile's 7% and comes only from that share. The Daily*30 surplus joins the
 * Cover Pool. The Proxy Agent (Platform Sales Officer) is paid once, on cycle 1,
 * round-half-even(2% of P), from that cycle's Cover Pool contribution.
 */
export const PRICING_VERSION_V360 = 'v360' as const;
export const PARTNER_MONTHLY_RATE = 0.15;
export const CONTRACT_DAYS = 360;
export const CONTRACT_MONTHS = 12;
export const V360_ECONOMICS_VERSION = 'v360-2026-11-02' as const;

function wholeShillings(principal: number): number {
  if (!(principal > 0) || !Number.isFinite(principal)) throw new Error('Rent amount must be above zero');
  return Math.round(principal);
}

/** Half to even, on an exact ratio. Matches Python round() for positive values. */
function roundHalfEven(numerator: number, denominator: number): number {
  const q = Math.floor(numerator / denominator);
  const rem = numerator % denominator;
  if (rem * 2 < denominator) return q;
  if (rem * 2 > denominator) return q + 1;
  return q % 2 === 0 ? q : q + 1;
}

function ceilDiv(numerator: number, denominator: number): number {
  return Math.floor((numerator + denominator - 1) / denominator);
}

export interface V360CycleWaterfall {
  principal: number;
  cycle: number;
  rail: number;
  gross: number;
  daily: number;
  collected: number;
  surplus: number;
  residual: number;
  agentSub: number;
  agentGeneral: number;
  coverPoolPercent: number;
  coverPool: number;
  proxy: number;
  coverPoolRetained: number;
  welile: number;
  tithe: number;
  welileNet: number;
  landlord: number;
  partnerMargin: number;
}

/** Canonical 30-day cycle. Cycle 1 retains Cover Pool after the one-off proxy fee. */
export function v360CycleWaterfall(principal: number, cycle = 1): V360CycleWaterfall {
  const P = wholeShillings(principal);
  if (!(cycle >= 1 && cycle <= CONTRACT_MONTHS)) throw new Error('Cycle must be between 1 and 12');
  const rail = Math.max(3500, ceilDiv(P, 40));
  const gross = ceilDiv(115 * P + 100 * rail, 83);
  const daily = ceilDiv(gross, 30);
  const collected = daily * 30;
  const agentSub = Math.floor((gross * 6) / 100);
  const agentGeneral = Math.floor((gross * 2) / 100);
  const coverPoolPercent = Math.floor((gross * 2) / 100);
  const welile = Math.floor((gross * 7) / 100);
  const tithe = Math.floor(welile / 10);
  const welileNet = welile - tithe;
  const landlord = P;
  const partnerMargin = roundHalfEven(P * 15, 100);
  const residual = gross - (agentSub + agentGeneral + coverPoolPercent + welile + rail + landlord + partnerMargin);
  const surplus = collected - gross;
  const coverPool = coverPoolPercent + residual + surplus;
  const proxy = cycle === 1 ? roundHalfEven(P * 2, 100) : 0;
  if (proxy > coverPool) throw new Error('Proxy Agent fee exceeds the cycle 1 Cover Pool');
  const coverPoolRetained = coverPool - proxy;
  return {
    principal: P,
    cycle,
    rail,
    gross,
    daily,
    collected,
    surplus,
    residual,
    agentSub,
    agentGeneral,
    coverPoolPercent,
    coverPool,
    proxy,
    coverPoolRetained,
    welile,
    tithe,
    welileNet,
    landlord,
    partnerMargin,
  };
}

/** Largest-remainder split of a collection. A full cycle (cash = collected) is exact. */
export function allocateV360Collection(
  principal: number,
  cash: number,
  cycle = 1,
  proxyAlreadyRecorded = false,
): V360CycleWaterfall & { cash: number; provisional: boolean } {
  const wf = v360CycleWaterfall(principal, cycle);
  const amount = wholeShillings(cash);
  if (!(amount > 0)) throw new Error('Amount must be above zero');
  const payProxy = cycle === 1 && !proxyAlreadyRecorded;
  const weights = [
    wf.agentSub,
    wf.agentGeneral,
    wf.rail,
    wf.landlord,
    wf.partnerMargin,
    payProxy ? wf.coverPoolRetained : wf.coverPool,
    payProxy ? wf.proxy : 0,
    wf.welile,
  ];
  const total = weights.reduce((sum, part) => sum + part, 0);
  if (total !== wf.collected) throw new Error('Cycle waterfall does not add up to collections');
  const floors = weights.map((part) => Math.floor((part * amount) / total));
  let left = amount - floors.reduce((sum, part) => sum + part, 0);
  const order = floors
    .map((part, index) => ({ index, frac: (weights[index] * amount) / total - part }))
    .sort((a, b) => b.frac - a.frac || a.index - b.index);
  for (const slot of order) {
    if (left <= 0) break;
    floors[slot.index] += 1;
    left -= 1;
  }
  const [agentSub, agentGeneral, rail, landlord, partnerMargin, coverPoolRetained, proxy, welile] = floors;
  const coverPool = coverPoolRetained + proxy;
  return {
    ...wf,
    cash: amount,
    provisional: amount !== wf.collected,
    agentSub,
    agentGeneral,
    rail,
    landlord,
    partnerMargin,
    coverPool,
    proxy,
    coverPoolRetained,
    welile,
    tithe: amount === wf.collected ? wf.tithe : Math.floor(welile / 10),
    welileNet: welile - (amount === wf.collected ? wf.tithe : Math.floor(welile / 10)),
  };
}

export function railFee(principal: number, months = 1): number {
  if (months === 1) return v360CycleWaterfall(principal, 1).rail;
  return Math.max(3500 * months, 0.025 * months * principal);
}

export function grossForMonths(principal: number, months = 1): number {
  if (!(principal > 0)) throw new Error('Rent amount must be above zero');
  if (!(months >= 1 && months <= 12)) throw new Error('Months must be between 1 and 12');
  if (months === 1) return v360CycleWaterfall(principal, 1).gross;
  const denom = 0.9 - 0.07 * months;
  if (denom <= 0) throw new Error('Months too long for this pricing');
  return Math.ceil((principal * Math.pow(1.15, months) + railFee(principal, months)) / denom);
}

export function dailyRate(principal: number, months = 1): number {
  if (months === 1) return v360CycleWaterfall(principal, 1).daily;
  return Math.ceil(grossForMonths(principal, months) / (30 * months));
}

export interface V360Quote {
  principal: number;
  gross: number;
  daily: number;
  buckets: {
    landlord: number;
    partner: number;
    agent: number;
    agentSub: number;
    agentGeneral: number;
    rail: number;
    welile: number;
    coverPool: number;
    proxy: number;
    coverPoolRetained: number;
    tithe: number;
    welileNet: number;
  };
  partnerMonthly: number;
  partnerTwelveMonths: number;
  receivable360: number;
  waterfall: V360CycleWaterfall;
}

export function quoteV360(principal: number): V360Quote {
  const wf = v360CycleWaterfall(principal, 1);
  return {
    principal: wf.principal,
    gross: wf.gross,
    daily: wf.daily,
    buckets: {
      landlord: wf.landlord,
      partner: wf.partnerMargin,
      agent: wf.agentSub + wf.agentGeneral,
      agentSub: wf.agentSub,
      agentGeneral: wf.agentGeneral,
      rail: wf.rail,
      welile: wf.welile,
      coverPool: wf.coverPool,
      proxy: wf.proxy,
      coverPoolRetained: wf.coverPoolRetained,
      tithe: wf.tithe,
      welileNet: wf.welileNet,
    },
    partnerMonthly: wf.partnerMargin,
    partnerTwelveMonths: wf.partnerMargin * CONTRACT_MONTHS,
    receivable360: CONTRACT_DAYS * wf.daily,
    waterfall: wf,
  };
}

/** Worked example for new-quote screens. It does not price an existing Rent Plan. */
const _modelA = quoteV360(100_000);
export const V360_MODEL_A_EXAMPLE = {
  principal: 100_000,
  gross: _modelA.gross,
  daily: _modelA.daily,
  collected: _modelA.waterfall.collected,
  partnerMonthly: _modelA.partnerMonthly,
  partnerTwelveMonths: _modelA.partnerTwelveMonths,
  agentSub: _modelA.buckets.agentSub,
  agentGeneral: _modelA.buckets.agentGeneral,
  rail: _modelA.buckets.rail,
  landlord: _modelA.buckets.landlord,
  coverPool: _modelA.buckets.coverPool,
  proxy: _modelA.buckets.proxy,
  coverPoolRetained: _modelA.buckets.coverPoolRetained,
  welile: _modelA.buckets.welile,
  tithe: _modelA.buckets.tithe,
  welileNet: _modelA.buckets.welileNet,
} as const;

/** Contract horizon: missed and vacant days postpone the end, never write off paid days. */
export function contractEndDay(missedDays: number, vacantDays: number): number {
  return CONTRACT_DAYS + Math.max(0, missedDays) + Math.max(0, vacantDays);
}

export function remainingReceivable(daily: number, paidDays: number): number {
  return Math.max(0, CONTRACT_DAYS - Math.max(0, paidDays)) * daily;
}

/**
 * Day-30 cover for a v360 cycle. Partner margin and landlord principal are
 * targets. The Cover Pool pays a shortfall only up to the shillings it holds
 * after the cycle-1 Proxy Agent fee. Welile's 7% is not used to fill a gap.
 */
export function day30Settlement(q: V360Quote, cashCollected: number, cycle = 1) {
  const wf = v360CycleWaterfall(q.principal, cycle);
  const shortfall = Math.max(0, wf.collected - Math.max(0, Math.round(cashCollected)));
  const bufferDraw = Math.min(shortfall, wf.coverPoolRetained);
  const uncoveredShortfall = shortfall - bufferDraw;
  const fullyCovered = uncoveredShortfall === 0;
  return {
    partnerTarget: wf.partnerMargin,
    landlordTarget: wf.landlord,
    bufferDraw,
    uncoveredShortfall,
    fullyCovered,
    surplus: Math.max(0, Math.round(cashCollected) - wf.collected),
  };
}
