import { describe, expect, it } from 'vitest';
import { recordedRdProjects, rdCashTotals } from '../lib/rdGeneralReportPdf';

describe('R&D recorded report data', () => {
  it('includes the exact cash position totals supplied in the recorded table', () => {
    const rows = [
      { name: 'Welile Car', customers: 19, cashIn: 21000000, cashOut: 38240000 },
      { name: 'Welile Dowry', customers: 4, cashIn: 470000, cashOut: 1065000 },
      { name: 'Welile School of AI', customers: 47, cashIn: 100000, cashOut: 5942000 },
    ];
    const before = structuredClone(rows);
    expect(rdCashTotals(rows)).toEqual({ customers: 70, cashIn: 21570000,
      cashOut: 45247000, net: -23677000 });
    expect(rows).toEqual(before);
  });
  it('retains recorded updates and excludes preset project fields', () => {
    const project = { name: 'Welile Car', progress: 65, cashIn: 4000000,
      updates: [{ date: '2026-10-14', text: 'Met the bank; awaiting its decision.' }] };
    expect(recordedRdProjects([project])).toEqual([{
      name: 'Welile Car', updates: project.updates,
    }]);
  });
  it('does not turn empty updates into report content', () => {
    expect(recordedRdProjects([{ name: 'Welile Dowry', updates: [
      { date: '2026-10-14', text: '   ' },
    ] }])).toEqual([{ name: 'Welile Dowry', updates: [] }]);
  });
});