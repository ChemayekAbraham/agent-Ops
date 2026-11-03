import { describe, expect, it } from 'vitest';
import {
  allocateV360Collection,
  contractEndDay,
  day30Settlement,
  grossForMonths,
  quoteV360,
  remainingReceivable,
  v360CycleWaterfall,
} from './contractEngine360';

const PUBLISHED = [
  {
    P: 100000, R: 3500, Gross: 142772, Daily: 4760, Collected: 142800, Surplus: 28, Resid: 2,
    Sub6: 8566, Gen2: 2855, CP2: 2855, CoverPool: 2885, Proxy: 2000, CP1: 885,
    Welile7: 9994, Tithe: 999, WelNet: 8995, Landlord: 100000, Margin: 15000,
  },
  {
    P: 300000, R: 7500, Gross: 424699, Daily: 14157, Collected: 424710, Surplus: 11, Resid: 4,
    Sub6: 25481, Gen2: 8493, CP2: 8493, CoverPool: 8508, Proxy: 6000, CP1: 2508,
    Welile7: 29728, Tithe: 2972, WelNet: 26756, Landlord: 300000, Margin: 45000,
  },
  {
    P: 500000, R: 12500, Gross: 707832, Daily: 23595, Collected: 707850, Surplus: 18, Resid: 3,
    Sub6: 42469, Gen2: 14156, CP2: 14156, CoverPool: 14177, Proxy: 10000, CP1: 4177,
    Welile7: 49548, Tithe: 4954, WelNet: 44594, Landlord: 500000, Margin: 75000,
  },
  {
    P: 1000000, R: 25000, Gross: 1415663, Daily: 47189, Collected: 1415670, Surplus: 7, Resid: 2,
    Sub6: 84939, Gen2: 28313, CP2: 28313, CoverPool: 28322, Proxy: 20000, CP1: 8322,
    Welile7: 99096, Tithe: 9909, WelNet: 89187, Landlord: 1000000, Margin: 150000,
  },
] as const;

function expectWaterfall(P: number, row: (typeof PUBLISHED)[number]) {
  const first = v360CycleWaterfall(P, 1);
  const later = v360CycleWaterfall(P, 2);
  expect(first).toMatchObject({
    rail: row.R,
    gross: row.Gross,
    daily: row.Daily,
    collected: row.Collected,
    surplus: row.Surplus,
    residual: row.Resid,
    agentSub: row.Sub6,
    agentGeneral: row.Gen2,
    coverPoolPercent: row.CP2,
    coverPool: row.CoverPool,
    proxy: row.Proxy,
    coverPoolRetained: row.CP1,
    welile: row.Welile7,
    tithe: row.Tithe,
    welileNet: row.WelNet,
    landlord: row.Landlord,
    partnerMargin: row.Margin,
  });
  const pieces = (wf: typeof first, proxy: number, pool: number) =>
    wf.agentSub + wf.agentGeneral + wf.rail + wf.landlord + wf.partnerMargin + pool + proxy + wf.welile;
  expect(pieces(first, first.proxy, first.coverPoolRetained)).toBe(first.collected);
  expect(pieces(later, 0, later.coverPool)).toBe(later.collected);
  expect(first.tithe + first.welileNet).toBe(first.welile);
  expect(later.proxy).toBe(0);
  expect(later.coverPoolRetained).toBe(later.coverPool);
}

describe('360-day cycle waterfall', () => {
  it('matches the published shilling examples, including P = 100,000', () => {
    for (const row of PUBLISHED) expectWaterfall(row.P, row);
    expect(grossForMonths(100000)).toBe(142772);
    expect(quoteV360(100000).daily).toBe(4760);
    expect(quoteV360(100000).buckets.agent).toBe(8566 + 2855);
    expect(quoteV360(100000).buckets.agentSub).toBe(8566);
    expect(quoteV360(100000).receivable360).toBe(360 * 4760);
  });

  it('uses half-to-even for the 2% proxy and 15% margin', () => {
    expect(v360CycleWaterfall(13425).proxy).toBe(268);
    expect(v360CycleWaterfall(14110).partnerMargin).toBe(2116);
  });

  it('balances every cycle from UGX 10,000 to UGX 2,000,000', () => {
    for (let principal = 10_000; principal <= 2_000_000; principal += 1_337) {
      for (const cycle of [1, 6, 12]) {
        const wf = v360CycleWaterfall(principal, cycle);
        const proxy = cycle === 1 ? wf.proxy : 0;
        const pool = wf.coverPool - proxy;
        const sum = wf.agentSub + wf.agentGeneral + wf.rail + wf.landlord + wf.partnerMargin + pool + proxy + wf.welile;
        expect(sum).toBe(wf.collected);
        expect(wf.tithe + wf.welileNet).toBe(wf.welile);
        expect(wf.proxy).toBeLessThanOrEqual(wf.coverPool);
        expect(wf.welile).toBe(Math.floor((wf.gross * 7) / 100));
      }
    }
  });

  it('allocates a full cycle collection to the canonical shillings', () => {
    const wf = v360CycleWaterfall(100000, 1);
    const split = allocateV360Collection(100000, wf.collected, 1, false);
    expect(split.provisional).toBe(false);
    expect(split.agentSub).toBe(8566);
    expect(split.agentGeneral).toBe(2855);
    expect(split.proxy).toBe(2000);
    expect(split.coverPoolRetained).toBe(885);
    expect(split.welile).toBe(9994);
    expect(split.tithe).toBe(999);
    const later = allocateV360Collection(100000, wf.collected, 2, false);
    expect(later.proxy).toBe(0);
    expect(later.coverPool).toBe(2885);
  });

  it('pays Partner and Landlord targets on a full cycle and limits a short cycle to the Cover Pool', () => {
    const q = quoteV360(100000);
    const full = day30Settlement(q, q.daily * 30);
    expect(full.fullyCovered).toBe(true);
    expect(full.partnerTarget).toBe(15000);
    expect(full.landlordTarget).toBe(100000);
    expect(full.bufferDraw).toBe(0);
    const short = day30Settlement(q, 20 * q.daily);
    expect(short.partnerTarget).toBe(15000);
    expect(short.landlordTarget).toBe(100000);
    expect(short.bufferDraw).toBe(885);
    expect(short.fullyCovered).toBe(false);
    expect(short.uncoveredShortfall).toBeGreaterThan(0);
  });

  it('extends the horizon by missed and vacant days without writing off paid days', () => {
    expect(contractEndDay(4, 3)).toBe(367);
    expect(remainingReceivable(4760, 30)).toBe(330 * 4760);
  });
});
