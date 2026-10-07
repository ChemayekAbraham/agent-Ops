import { describe, it, expect, vi, beforeEach } from 'vitest';

const csv = vi.fn();
const xlsx = vi.fn();
vi.mock('@/lib/csvExport', () => ({ downloadCsv: (...a: unknown[]) => csv(...a) }));
vi.mock('@/lib/xlsxExport', () => ({ downloadXlsxWorkbook: (...a: unknown[]) => xlsx(...a) }));
vi.mock('@/integrations/supabase/client', () => ({ supabase: { rpc: vi.fn() } }));

import {
  AWARENESS_LOG_HEADERS, awarenessLogRows, describeAwarenessFilters, exportAwarenessLogCsv, exportAwarenessLogXlsx,
} from './awarenessCallsExport';
import { EMPTY_AWARENESS_FILTERS, type AwarenessFilters, type AwarenessLogRow } from '@/hooks/useAwarenessMonitoring';

const filters: AwarenessFilters = { startIso: '2026-10-05T21:00:00.000Z', endIso: '2026-10-07T20:59:59.999Z', ...EMPTY_AWARENESS_FILTERS };
const row: AwarenessLogRow = {
  id: 'c-1', rent_request_id: 'rr-1', plan_code: '94d31512', subject_type: 'landlord', subject_name: 'Mr Okello', subject_phone: '0700333444',
  caller_id: 'u-1', caller_name: 'Grace Namukasa', caller_team: 'service_centre', pipeline_stage: 'service_center_review', current_status: 'pending',
  region: 'Central', call_result: 'answered', aware_30m: 'heard', aware_merchant_codes: 'did_not_know', explained: 'partly', note: 'Wants the codes in writing',
  day: '2026-10-06', dial_started_at: '2026-10-06T20:59:00Z', recorded_at: '2026-10-07T05:10:00Z',
};

describe('awarenessLogRows', () => {
  it('writes each call in words, with Kampala times (20:59 UTC is 23:59 on the same day)', () => {
    const [r] = awarenessLogRows([row]);
    expect(r).toHaveLength(AWARENESS_LOG_HEADERS.length);
    expect(r.slice(0, 3)).toEqual(['06 Oct 2026', '06 Oct 23:59', '07 Oct 08:10']);
    expect(r.slice(3, 17)).toEqual([
      '94d31512', 'Landlord', 'Mr Okello', '0700333444', 'Grace Namukasa', 'Service centre', 'Service centre review', 'Pending', 'Central',
      'Answered', 'Heard but unsure', 'Did not know', 'Partly explained', 'Wants the codes in writing',
    ]);
  });

  it('leaves the answers blank for an unanswered call', () => {
    const [r] = awarenessLogRows([{ ...row, call_result: 'no_answer', aware_30m: null, aware_merchant_codes: null, explained: null, note: null, region: null }]);
    expect(r.slice(11, 17)).toEqual(['', 'No answer', '', '', '', '']);
  });
});

describe('exports', () => {
  beforeEach(() => vi.clearAllMocks());

  it('describes the filters in words', () => {
    const d = Object.fromEntries(describeAwarenessFilters({ ...filters, team: 'agent_ops', result: 'answered', answer: 'explained:no', status: 'service_center_review' }));
    expect(d).toMatchObject({ From: '06 Oct 2026', To: '07 Oct 2026', Team: 'Agent Ops', 'Call result': 'Answered', 'Answer choice': 'Explained on the call: Not explained', 'Rent Plan status now': 'Service centre review', Region: 'All' });
  });

  it('CSV: one file per Kampala date range, headers then a row per call', () => {
    exportAwarenessLogCsv([row, row], filters);
    expect(csv).toHaveBeenCalledTimes(1);
    const [name, headers, rows] = csv.mock.calls[0];
    expect(name).toBe('Welile_Awareness_Calls_2026-10-06_2026-10-07.csv');
    expect(headers).toEqual(AWARENESS_LOG_HEADERS);
    expect(rows).toHaveLength(2);
  });

  it('Excel: a call log sheet and a filters sheet that records what the file holds', async () => {
    await exportAwarenessLogXlsx([row], filters);
    const [name, sheets] = xlsx.mock.calls[0];
    expect(name).toBe('Welile_Awareness_Calls_2026-10-06_2026-10-07.xlsx');
    expect(sheets.map((s: { name: string }) => s.name)).toEqual(['Call log', 'Filters']);
    expect(sheets[0].rows).toHaveLength(1);
    expect(sheets[1].rows.some((r: unknown[]) => r[0] === 'Calls in this file' && r[1] === 1)).toBe(true);
    expect(JSON.stringify(sheets)).not.toMatch(/\b(loan|lender|ROI|interest)\b/i);
  });
});
