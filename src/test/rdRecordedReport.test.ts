import { describe, expect, it } from 'vitest';
import { recordedRdProjects, rdCashTotals } from '../lib/rdGeneralReportPdf';
import { rdReportIdeaRows } from '../lib/rdReportIdeas';

describe('R&D recorded report data', () => {
  it('includes the saved idea details and all nine recorded canvas fields', () => {
    const idea = { title: 'Transport idea', owner: 'Gloria', date: '2026-10-14', summary: 'Saved description',
      canvas: { partners: 'Bank', activities: 'Marketing', resources: 'Office', value: 'Affordable transport',
        relationships: 'SMS', channels: 'Agents', segments: 'Car owners', costs: 'Maintenance', revenue: 'Registration fees' } };
    expect(rdReportIdeaRows(idea)).toEqual([
      ['Idea name', 'Transport idea'], ['Proposed by', 'Gloria'], ['Date', '2026-10-14'], ['Description', 'Saved description'],
      ['Key Partners', 'Bank'], ['Key Activities', 'Marketing'], ['Key Resources', 'Office'],
      ['Value Proposition', 'Affordable transport'], ['Customer Relationships', 'SMS'], ['Channels', 'Agents'],
      ['Customer Segments', 'Car owners'], ['Cost Structure', 'Maintenance'], ['Revenue Streams', 'Registration fees'],
    ]);
  });
  it('marks empty canvas fields as unrecorded without supplying placeholder claims', () => {
    const rows = rdReportIdeaRows({ title: 'New idea', owner: '', date: '', summary: '', canvas: { partners: '  ', revenue: 123 } });
    expect(rows.slice(4).map((row) => row[1])).toEqual(Array(9).fill('Not recorded'));
  });
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