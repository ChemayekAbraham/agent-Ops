import { describe, expect, it } from 'vitest';
import { recordedRdProjects } from '../lib/rdGeneralReportPdf';

describe('R&D recorded report data', () => {
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