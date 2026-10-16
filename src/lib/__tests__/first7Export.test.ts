import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/integrations/supabase/client', () => ({
  supabase: { auth: { getUser: () => Promise.resolve({ data: { user: { id: 'u-1' } } }) }, from: () => ({ insert: () => Promise.resolve({}) }) },
}));

const pdf = vi.hoisted(() => ({ texts: [] as string[], saved: '' }));
vi.mock('jspdf', async (orig) => {
  const Base = (await orig<{ default: new (...a: unknown[]) => Record<string, (...a: unknown[]) => unknown> }>()).default;
  class Recording extends Base {
    constructor(...a: unknown[]) {
      super(...a);
      const text = this.text.bind(this);
      this.text = (t: unknown, ...rest: unknown[]) => { pdf.texts.push(([] as string[]).concat(t as string | string[]).join(' ')); return text(t, ...rest); };
      this.save = (f: unknown) => { pdf.saved = String(f); };
    }
  }
  return { default: Recording };
});

import { buildFirst7Csv, downloadFirst7Csv, exportDayState, generateFirst7Pdf, first7FilterLines, first7Filename, type First7ExportInput } from '../first7Export';
import type { First7Row } from '../newTenantFirst7';

const row = (over: Partial<First7Row> = {}): First7Row => ({
  rent_request_id: 'rr-1', tenant_id: 't-1', tenant_name: 'Amina Nakato', tenant_phone: '0772000111', agent_id: 'a-1', agent_name: 'Joy Namukasa',
  landlord_paid_on: '2026-10-10', day1: '2026-10-11', frequency: 'daily', daily_due: 10000, total_repayment: 300000,
  day_paid: [10000, 0, 5000, 0, 0, 0, 0], day_due: Array(7).fill(10000), day_state: ['paid', 'missed', 'part', 'missed', 'missed', 'future', 'future'],
  paid_7d: 15000, expected_to_date: 50000, first_paid_day: 1, row_status: 'behind', ...over,
});
const weekly = row({
  rent_request_id: 'rr-2', tenant_name: '=HYPERLINK(1)', frequency: 'weekly', day_paid: [70000, 0, 0, 0, 0, 0, 0], day_due: [70000, 0, 0, 0, 0, 0, 0],
  day_state: ['paid', 'missed', 'not_due', 'not_due', 'future', 'future', 'future'], paid_7d: 70000, expected_to_date: 70000, row_status: 'on_track',
});

const input = (over: Partial<First7ExportInput> = {}): First7ExportInput => ({
  rows: [row(), weekly], totalInRange: 9,
  params: { from: '2026-10-10', to: '2026-10-14', freq: 'daily', q: 'joy', card: 'behind', day: 3, agent: 'a-1' },
  agentName: 'Joy Namukasa', generatedAt: new Date('2026-10-15T11:32:00Z'), ...over,
});

describe('First 7 Days export', () => {
  it('describes every filter in words', () => {
    expect(first7FilterLines(input())).toEqual([
      ['Landlord paid', '10 Oct 2026 – 14 Oct 2026'],
      ['Payment period', 'Daily'],
      ['Agent', 'Joy Namukasa'],
      ['Search', '"joy"'],
      ['Show', 'Behind'],
      ['Day', 'Paid on day 3'],
    ]);
    expect(first7FilterLines(input({ params: { from: '2026-10-14', to: '2026-10-14', freq: 'all', q: '', card: 'all', day: null, agent: null }, agentName: null })))
      .toEqual([['Landlord paid', '14 Oct 2026'], ['Payment period', 'Daily and weekly'], ['Agent', 'All agents'], ['Search', 'None'], ['Show', 'All Rent Plans'], ['Day', 'All days']]);
  });

  it('names the file by the dates', () => {
    expect(first7Filename(input(), 'csv')).toBe('first-7-days-2026-10-10_to_2026-10-14.csv');
    expect(first7Filename(input({ params: { ...input().params, to: '2026-10-10' } }), 'pdf')).toBe('first-7-days-2026-10-10.pdf');
  });

  it('puts the title, the Kampala time and the filters above the header, in Rent Plan wording', () => {
    const { preamble, headers } = buildFirst7Csv(input());
    expect(preamble[0]).toEqual(['First 7 Days: Rent Plans']);
    expect(preamble).toContainEqual(['Generated (Kampala time)', '15 Oct 2026, 14:32 EAT']);
    expect(preamble).toContainEqual(['Rent Plans in this file', '2 of 9']);
    expect(preamble).toContainEqual(['Amounts', 'UGX']);
    expect(preamble).toContainEqual(['Agent', 'Joy Namukasa']);
    expect(headers).toHaveLength(8 + 14 + 3);
    expect(headers.slice(0, 4)).toEqual(['Tenant', 'Phone', 'Agent', 'Payment period']);
    expect(headers.join(' ')).toContain('Day 7 state');
    expect(JSON.stringify(preamble) + headers.join(' ')).not.toMatch(/\bloan|lender|ROI|interest\b/i);
  });

  it('writes each Rent Plan with the server\'s numbers and states; a weekly day that owes nothing is "Not due", never "Missed"', () => {
    const { rows } = buildFirst7Csv(input());
    const [d, w] = rows;
    expect(d.slice(0, 8)).toEqual(['Amina Nakato', '0772000111', 'Joy Namukasa', 'Daily', 10000, 300000, '2026-10-10', '2026-10-11']);
    expect(d.slice(8, 14)).toEqual([10000, 'Paid', 0, 'Missed', 5000, 'Part paid']);
    expect(d.slice(-3)).toEqual([15000, 50000, 'Behind']);
    expect(w.slice(3, 6)).toEqual(['Weekly', 70000, 300000]);
    expect(w.slice(8, 14)).toEqual([70000, 'Paid', 0, 'Not due', 0, 'Not due']);
    expect(w.slice(-3)).toEqual([70000, 70000, 'On track']);
    expect(exportDayState(weekly, 1)).toBe('not_due');
    expect(exportDayState(row({ day_state: ['future', 'future', 'future', 'future', 'future', 'future', 'future'], day_paid: Array(7).fill(0) }), 0)).toBe('future');
  });

  it('downloads a CSV with a byte-order mark, the preamble, the header and the rows (a leading = is made safe)', async () => {
    let blob: Blob | undefined;
    URL.createObjectURL = vi.fn((b: Blob) => { blob = b; return 'blob:x'; });
    URL.revokeObjectURL = vi.fn();
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    downloadFirst7Csv(input());
    expect(click).toHaveBeenCalled();
    const buf = await new Promise<ArrayBuffer>((res) => { const fr = new FileReader(); fr.onload = () => res(fr.result as ArrayBuffer); fr.readAsArrayBuffer(blob as Blob); });
    const text = new TextDecoder('utf-8', { ignoreBOM: true }).decode(buf);
    expect(text.charCodeAt(0)).toBe(0xfeff);
    const lines = text.slice(1).split('\r\n');
    expect(lines[0]).toBe('"First 7 Days: Rent Plans"');
    expect(lines[1]).toBe('"Generated (Kampala time)","15 Oct 2026, 14:32 EAT"');
    expect(lines).toContain('"Search","""joy"""');
    const header = lines.findIndex((l) => l.startsWith('"Tenant","Phone"'));
    expect(header).toBeGreaterThan(6);
    expect(lines[header - 1]).toBe('');
    expect(lines[header + 1]).toContain('"Amina Nakato"');
    expect(lines[header + 2]).toContain(`"'=HYPERLINK(1)"`);
    click.mockRestore();
  });

  it('makes a PDF that carries the title, the Kampala time and the filters, and saves it under the dated name', async () => {
    pdf.texts.length = 0;
    await generateFirst7Pdf(input());
    expect(pdf.saved).toBe('first-7-days-2026-10-10_to_2026-10-14.pdf');
    const all = pdf.texts.join(' | ');
    expect(all).toContain('First 7 Days: Rent Plans');
    expect(all).toContain('Generated 15 Oct 2026, 14:32 EAT (Kampala time)');
    expect(all).toContain('2 of 9 Rent Plans');
    expect(all).toContain('Joy Namukasa');
    expect(all).toContain('Paid on day 3');
    expect(all).not.toMatch(/\bloan|lender|ROI|interest\b/i);
  });
});
