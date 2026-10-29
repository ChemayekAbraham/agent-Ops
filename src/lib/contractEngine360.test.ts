import { describe, expect, it } from 'vitest';
import { contractEndDay, day30Settlement, grossForMonths, quoteV360, remainingReceivable } from './contractEngine360';

describe('360-day contract engine', () => {
  it('prices UGX 100,000 for 30 days at 142,771 gross and 4,760 a day', () => {
    expect(grossForMonths(100000)).toBe(142771);
    expect(quoteV360(100000).daily).toBe(4760);
  });
  it('pays the Partner 15,000 a month for 12 months, 180,000 in total', () => {
    const q = quoteV360(100000);
    expect(q.partnerMonthly).toBe(15000);
    expect(q.partnerTwelveMonths).toBe(180000);
  });
  it('sets the 360-day receivable to 360 x daily rate', () => {
    expect(quoteV360(100000).receivable360).toBe(360 * 4760);
  });
  it('uses the 3,500 rail floor and 7% Welile share of gross', () => {
    const b = quoteV360(100000).buckets;
    expect(b.rail).toBe(3500);
    expect(b.welile).toBe(Math.round(142771 * 0.07));
  });
  it('still pays Partner and Landlord on Day 30 after missed days, using the buffer', () => {
    const q = quoteV360(100000);
    const s = day30Settlement(q, 20 * q.daily);
    expect(s.partnerPaid).toBe(15000);
    expect(s.landlordPaid).toBe(100000);
    expect(s.bufferDraw).toBeGreaterThan(0);
  });
  it('extends the horizon by missed and vacant days without writing off paid days', () => {
    expect(contractEndDay(4, 3)).toBe(367);
    expect(remainingReceivable(4760, 30)).toBe(330 * 4760);
  });
});
