import { describe, expect, it } from 'vitest';
import { CALL_KINDS, pivotAllCalls, type AllCallsRow } from './callingCenterAllCalls';

const DAYS = ['2026-10-14', '2026-10-15', '2026-10-16', '2026-10-17', '2026-10-18', '2026-10-19', '2026-10-20'];
const row = (o: Partial<AllCallsRow>): AllCallsRow => ({
  caller_id: 'a', caller_name: 'Amina', kampala_day: DAYS[0], subject_kind: 'tenant', source: 'calling_center', answered: true, calls: 1, ...o,
});

const ROWS: AllCallsRow[] = [
  row({ calls: 5 }),
  row({ subject_kind: 'landlord', kampala_day: DAYS[1], calls: 3, source: 'awareness' }),
  row({ subject_kind: 'agent', kampala_day: DAYS[1], calls: 2, answered: false, source: 'awareness' }),
  row({ subject_kind: 'other', kampala_day: DAYS[6], calls: 4, source: 'crm_voice', answered: false }),
  row({ caller_id: 'b', caller_name: 'Brian', calls: 20, source: 'received' }),
  row({ caller_id: 'b', caller_name: 'Brian', subject_kind: 'weird', kampala_day: DAYS[3], calls: 1 }),
  row({ caller_id: 'a', caller_name: 'Amina', kampala_day: '2026-10-21', calls: 99 }), // outside the week: ignored
];

describe('pivotAllCalls', () => {
  const p = pivotAllCalls(ROWS, DAYS);

  it('arranges rows into a staff x day matrix, busiest staff first', () => {
    expect(p.staff.map((s) => s.name)).toEqual(['Brian', 'Amina']);
    const amina = p.staff.find((s) => s.name === 'Amina')!;
    expect(amina.perDay).toEqual([5, 5, 0, 0, 0, 0, 4]);
    expect(amina.total).toBe(14);
  });

  it('subtotal of every staff member equals the sum of the four kinds, per day and for the week', () => {
    for (const s of p.staff) {
      s.perDay.forEach((n, i) => expect(n).toBe(CALL_KINDS.reduce((a, k) => a + s.kinds[k.kind].perDay[i], 0)));
      expect(s.total).toBe(CALL_KINDS.reduce((a, k) => a + s.kinds[k.kind].total, 0));
    }
  });

  it('an unknown kind is counted as Others', () => {
    const brian = p.staff.find((s) => s.name === 'Brian')!;
    expect(brian.kinds.other.total).toBe(1);
    expect(brian.kinds.tenant.total).toBe(20);
  });

  it('daily totals equal the column sums, and the grand total equals both the row and the column sums', () => {
    p.dailyTotals.forEach((n, i) => expect(n).toBe(p.staff.reduce((a, s) => a + s.perDay[i], 0)));
    expect(p.grandTotal).toBe(p.staff.reduce((a, s) => a + s.total, 0));
    expect(p.grandTotal).toBe(p.dailyTotals.reduce((a, b) => a + b, 0));
    expect(p.grandTotal).toBe(35);
    CALL_KINDS.forEach((k) => expect(p.kindTotals[k.kind].total).toBe(p.staff.reduce((a, s) => a + s.kinds[k.kind].total, 0)));
  });

  it('answered and not answered add up to the grand total, and the sources add up to it too', () => {
    expect(p.answered).toBe(29);
    expect(p.notAnswered).toBe(6);
    expect(p.answered + p.notAnswered).toBe(p.grandTotal);
    expect(p.bySource.reduce((a, s) => a + s.calls, 0)).toBe(p.grandTotal);
  });

  it('handles no rows', () => {
    const e = pivotAllCalls([], DAYS);
    expect(e.staff).toEqual([]);
    expect(e.grandTotal).toBe(0);
    expect(e.dailyTotals).toEqual([0, 0, 0, 0, 0, 0, 0]);
  });
});
