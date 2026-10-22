import { describe, expect, it } from 'vitest';
import { generateWeeklyForwardingPdf } from './callingCenterWeeklyForwardingPdf';
import { CALL_KINDS, pivotAllCalls } from './callingCenterAllCalls';

const DAYS = ['2026-10-14', '2026-10-15', '2026-10-16', '2026-10-17', '2026-10-18', '2026-10-19', '2026-10-20'];
const LABELS = DAYS.map((d) => d.slice(5));

describe('weekly forwarding PDF with the all-calls tables', () => {
  it('builds with and without the all-calls figures', async () => {
    const p = pivotAllCalls(
      [
        { caller_id: 'a', caller_name: 'Amina', kampala_day: DAYS[0], subject_kind: 'tenant', source: 'calling_center', answered: true, calls: 5 },
        { caller_id: 'a', caller_name: 'Amina', kampala_day: DAYS[2], subject_kind: 'landlord', source: 'awareness', answered: false, calls: 2 },
      ],
      DAYS,
    );
    const base = {
      dayLabels: LABELS, rows: [], dailyTotals: DAYS.map(() => 0), grandTotal: 0, tiles: [], insights: [], perDayBreakdown: [], note: 'n',
    };
    const meta = { generatedBy: 'T', email: 't@x', generatedAt: new Date(), reportPeriod: 'week' };
    const without = await generateWeeklyForwardingPdf(base, meta);
    const withAll = await generateWeeklyForwardingPdf(
      {
        ...base,
        allCalls: {
          staff: p.staff.map((s) => ({ name: s.name, perDay: s.perDay, total: s.total, kinds: CALL_KINDS.map((k) => ({ label: k.label, perDay: s.kinds[k.kind].perDay, total: s.kinds[k.kind].total })) })),
          dailyTotals: p.dailyTotals, grandTotal: p.grandTotal, summary: ['Calling Center: 5'],
        },
      },
      meta,
    );
    expect(without.size).toBeGreaterThan(1000);
    expect(withAll.size).toBeGreaterThan(without.size);
  });
});
