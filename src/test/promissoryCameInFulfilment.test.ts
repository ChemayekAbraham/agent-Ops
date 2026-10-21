import { describe, it, expect } from 'vitest';
import { applyCameInFulfilment, fulfilmentKpis, type PromissoryNoteRow } from '@/hooks/usePromissoryOpsReport';

const note = (o: Partial<PromissoryNoteRow>) =>
  ({ amount: 1_000_000, total_collected: 0, outstanding: 1_000_000, status: 'activated', came_in: false, portfolio_amount: 0, ...o }) as PromissoryNoteRow;

describe('promissory fulfilment from came-in partners', () => {
  it('marks a note fulfilled when the came-in partner portfolio covers the promise', () => {
    const [n] = applyCameInFulfilment([note({ came_in: true, portfolio_amount: 1_500_000 })]);
    expect(n.status).toBe('fulfilled');
    expect(n.total_collected).toBe(1_000_000);
    expect(n.outstanding).toBe(0);
  });
  it('counts partial portfolio money but keeps the note open', () => {
    const [n] = applyCameInFulfilment([note({ came_in: true, portfolio_amount: 400_000 })]);
    expect(n.status).toBe('activated');
    expect(n.total_collected).toBe(400_000);
  });
  it('ignores portfolio money when the partner has not come in', () => {
    const [n] = applyCameInFulfilment([note({ came_in: false, portfolio_amount: 900_000 })]);
    expect(n.total_collected).toBe(0);
  });
  it('totals fulfilled and receivable', () => {
    const k = fulfilmentKpis(applyCameInFulfilment([
      note({ came_in: true, portfolio_amount: 1_000_000 }), note({ came_in: true, portfolio_amount: 300_000 }),
    ]));
    expect(k.fulfilled_total).toBe(1_300_000);
    expect(k.receivable).toBe(700_000);
  });
});
