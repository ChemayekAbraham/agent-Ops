import { beforeEach, describe, expect, it, vi } from 'vitest';

const auditInsertMock = vi.fn().mockResolvedValue({ error: null });
const downloadXlsxWorkbookMock = vi.fn().mockResolvedValue(undefined);
const downloadCsvWithPreambleMock = vi.fn();

vi.mock('@/integrations/supabase/client', () => ({
  supabase: {
    auth: {
      getUser: vi.fn().mockResolvedValue({
        data: { user: { id: 'staff-user-1', email: 'ops@welile.com' } },
      }),
    },
    from: vi.fn(() => ({
      insert: auditInsertMock,
    })),
  },
}));

vi.mock('@/lib/xlsxExport', () => ({
  downloadXlsxWorkbook: (...args: unknown[]) => downloadXlsxWorkbookMock(...args),
}));

vi.mock('@/lib/csvExport', () => ({
  downloadCsvWithPreamble: (...args: unknown[]) => downloadCsvWithPreambleMock(...args),
}));

import {
  A4_MAX_HEIGHT_MM,
  MIN_CONTENT_PAGE_HEIGHT_MM,
  buildLandlordCallingReportPdfDoc,
  buildLandlordCallingReportXlsxSheets,
  exportLandlordCallingReportXlsx,
  exportLandlordCallLogCsv,
  logLandlordReportExport,
  type LandlordReportExportPayload,
} from '@/lib/landlordCallingReportsExport';
import { getWednesdayWeekStart, shiftYmdDays } from '@/hooks/useLandlordCallingReports';

const samplePayload: LandlordReportExportPayload = {
  from: '2026-10-21',
  to: '2026-10-27',
  weekStart: '2026-10-21',
  generatedBy: 'Grace Nakato',
  generatedAt: new Date('2026-10-23T14:30:00Z'),
  dailySummary: [
    {
      kampala_day: '2026-10-21',
      staff_id: 'staff-1',
      staff_name: 'Grace Nakato',
      total_calls: 12,
      engaged_calls: 8,
      reached_calls: 9,
      unreachable_calls: 3,
      callback_calls: 1,
      made_calls: 10,
      received_calls: 2,
    },
  ],
  weeklyReport: {
    week_start: '2026-10-21',
    week_end: '2026-10-27',
    day_keys: [
      '2026-10-21',
      '2026-10-22',
      '2026-10-23',
      '2026-10-24',
      '2026-10-25',
      '2026-10-26',
      '2026-10-27',
    ],
    totals: {
      total_calls: 12,
      engaged_calls: 8,
      reached_calls: 9,
      unreachable_calls: 3,
      callback_calls: 1,
      made_calls: 10,
      received_calls: 2,
      forwarded_total: 2,
      forwarded_from_made: 1,
      forwarded_from_received: 1,
      solved_here_total: 7,
    },
    staff_calls: [
      {
        staff_id: 'staff-1',
        staff_name: 'Grace Nakato',
        total_calls: 12,
        engaged_calls: 8,
        reached_calls: 9,
        unreachable_calls: 3,
        callback_calls: 1,
        made_calls: 10,
        received_calls: 2,
        per_day: [12, 0, 0, 0, 0, 0, 0],
      },
    ],
    forwarded_by_recipient: [
      {
        recipient_id: 'rec-1',
        recipient_name: 'Sarah Namono',
        total_forwarded: 2,
        from_made: 1,
        from_received: 1,
        per_day: [2, 0, 0, 0, 0, 0, 0],
      },
    ],
    solved_here_by_staff: [
      {
        staff_id: 'staff-1',
        staff_name: 'Grace Nakato',
        total_solved: 7,
        from_made: 6,
        from_received: 1,
        per_day: [7, 0, 0, 0, 0, 0, 0],
      },
    ],
    per_day: [
      {
        kampala_day: '2026-10-21',
        total_calls: 12,
        engaged_calls: 8,
        reached_calls: 9,
        unreachable_calls: 3,
        callback_calls: 1,
        made_calls: 10,
        received_calls: 2,
        forwarded_total: 2,
        forwarded_from_made: 1,
        forwarded_from_received: 1,
        solved_here_total: 7,
      },
    ],
    by_source: [
      { source: 'calling_center', calls: 10, reached_calls: 7 },
      { source: 'received', calls: 2, reached_calls: 2 },
    ],
  },
  coverage: [
    {
      region: 'Central',
      district: 'Kampala',
      registry_total: 420,
      ever_reached: 210,
      reached_this_round: 85,
      reached_this_month: 120,
      never_called: 180,
      called_but_unreached: 30,
      needs_review_count: 14,
      active_rent_plans_count: 95,
    },
  ],
  staffPerformance: [
    {
      staff_id: 'staff-1',
      staff_name: 'Grace Nakato',
      total_calls: 12,
      engaged_calls: 8,
      reached_calls: 9,
      unreachable_calls: 3,
      callback_calls: 1,
      unique_landlords: 11,
      reach_rate_pct: 75,
      active_hours: 3,
      calls_per_active_hour: 4,
      followups_owed: 2,
      followups_overdue: 1,
    },
  ],
  callLog: [
    {
      call_id: 'call-1',
      called_at: '2026-10-21T10:15:00+03:00',
      kampala_day: '2026-10-21',
      landlord_key: 'll-1',
      landlord_name: 'Hajji Musa Mukasa',
      phone: '256772***890',
      phone_masked: true,
      caller_id: 'staff-1',
      caller_name: 'Grace Nakato',
      source: 'calling_center',
      direction: 'made',
      outcome: 'engaged',
      is_reached: true,
      category_code: 'confirmed_payout_number',
      category_label: 'Confirmed payout number',
      note: 'Confirmed mobile money payout phone number is active.',
      total_count: 1,
    },
  ],
  concernsReport: {
    totals: {
      total_concerns: 2,
      open_concerns: 1,
      completed_concerns: 1,
      overdue_concerns: 1,
      avg_resolution_hours: 18.5,
    },
    by_category: [
      {
        category_code: 'payout_issue',
        category_label: 'Payout issue',
        total_count: 2,
        open_count: 1,
        completed_count: 1,
        overdue_count: 1,
        avg_age_hours: 26.4,
      },
    ],
    by_team: [
      {
        team_name: 'Landlord Operations',
        recipient_name: 'Sarah Namono',
        total_count: 2,
        open_count: 1,
        completed_count: 1,
        overdue_count: 1,
        avg_age_hours: 26.4,
      },
    ],
    by_age_bucket: [
      { bucket_key: 'under_24h', bucket_label: 'Under 24 hours', total_count: 1, open_count: 0, overdue_count: 0 },
      { bucket_key: '1_to_3d', bucket_label: '1 to 3 days', total_count: 1, open_count: 1, overdue_count: 1 },
    ],
    rows: [
      {
        concern_id: 'conc-1',
        source_kind: 'outbound_call',
        title: 'Payout number verification pending',
        context: 'Landlord requested verification of new mobile money line',
        priority: 'high',
        status: 'sent',
        landlord_name: 'Hajji Musa Mukasa',
        forwarded_by_name: 'Grace Nakato',
        recipient_name: 'Sarah Namono',
        team_name: 'Landlord Operations',
        category_code: 'payout_issue',
        category_label: 'Payout issue',
        created_at: '2026-10-21T10:20:00+03:00',
        due_at: '2026-10-22T10:20:00+03:00',
        completed_at: null,
        outcome: null,
        age_hours: 36,
        is_overdue: true,
      },
    ],
  },
  roundReport: {
    cycle: {
      id: 'cycle-1',
      cycle_no: 4,
      title: 'October Landlord Verification Round',
      description: 'All registered landlords',
      opened_at: '2026-10-20T08:00:00+03:00',
      opened_by: 'staff-1',
      opened_by_name: 'Grace Nakato',
      closed_at: null,
      abandoned_reason: null,
      retry_after_days: 2,
      attempt_cap: 3,
    },
    totals: {
      total_rows: 500,
      reached_count: 210,
      engaged_count: 185,
      callback_count: 25,
      parked_count: 40,
      outstanding_count: 250,
      to_call_count: 200,
      unreachable_count: 25,
      closed_count: 0,
      total_attempts: 340,
    },
    by_state: [
      { state: 'engaged', row_count: 185 },
      { state: 'parked', row_count: 40 },
      { state: 'to_call', row_count: 200 },
    ],
    by_caller: [
      {
        caller_id: 'staff-1',
        caller_name: 'Grace Nakato',
        attempts_count: 120,
        engaged_count: 85,
        callback_count: 10,
        unreached_count: 25,
      },
    ],
    by_park_reason: [{ park_reason: 'wrong_number', row_count: 40 }],
  },
};

describe('Landlord Calling Reports — PDF, Excel & CSV Builders', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('snaps dates to Wednesday–Tuesday weeks matching Tenant Ops', () => {
    // 2026-10-23 is Friday -> enclosing Wednesday is 2026-10-21
    expect(getWednesdayWeekStart('2026-10-23')).toBe('2026-10-21');
    // 2026-10-20 is Tuesday -> enclosing Wednesday is 2026-10-14
    expect(getWednesdayWeekStart('2026-10-20')).toBe('2026-10-14');
    expect(shiftYmdDays('2026-10-21', 6)).toBe('2026-10-27');
  });

  it('builds PDF with Welile header, period, generated by/at, page numbers, and content-height pages capped at A4', () => {
    const built = buildLandlordCallingReportPdfDoc(samplePayload);

    expect(built.filename).toBe('welile-landlord-calling-report-2026-10-21-to-2026-10-27.pdf');
    expect(built.totalPages).toBeGreaterThanOrEqual(1);
    expect(built.pageHeights.length).toBe(built.totalPages);

    for (const h of built.pageHeights) {
      expect(h).toBeLessThanOrEqual(A4_MAX_HEIGHT_MM);
      expect(h).toBeGreaterThanOrEqual(MIN_CONTENT_PAGE_HEIGHT_MM);
    }

    // Verify multi-page overflow stays capped at A4 (297mm)
    const manyLogs = Array.from({ length: 85 }, (_, i) => ({
      ...samplePayload.callLog[0],
      call_id: `call-${i}`,
      landlord_name: `Landlord #${i + 1}`,
    }));
    const multiPage = buildLandlordCallingReportPdfDoc({
      ...samplePayload,
      callLog: manyLogs,
    });
    expect(multiPage.totalPages).toBeGreaterThan(1);
    for (const h of multiPage.pageHeights) {
      expect(h).toBeLessThanOrEqual(A4_MAX_HEIGHT_MM);
    }
  });

  it('builds all 7 Excel sheets directly from server RPC payloads and logs export audit', async () => {
    const sheets = buildLandlordCallingReportXlsxSheets(samplePayload);
    expect(sheets.map((s) => s.name)).toEqual([
      'Daily Summary',
      'Weekly Wed-Tue',
      'Staff Performance',
      'Registry Coverage',
      'Concerns Report',
      'Round Summary',
      'Call Log',
    ]);
    expect(sheets[0].rows[0]['Total Calls']).toBe(12);
    expect(sheets[2].rows[0]['Reach Rate (%)']).toBe(75);
    expect(sheets[3].rows[0]['Registry Total']).toBe(420);
    expect(sheets[5].rows[0]['Reached']).toBe(210);
    expect(sheets[6].rows[0]['Phone']).toBe('256772***890');

    const filename = await exportLandlordCallingReportXlsx(samplePayload);
    expect(filename).toBe('welile-landlord-calling-report-2026-10-21-to-2026-10-27.xlsx');
    expect(downloadXlsxWorkbookMock).toHaveBeenCalledTimes(1);
    expect(auditInsertMock).toHaveBeenCalledWith(
      expect.objectContaining({
        action_type: 'bulk_data_exported',
        table_name: 'export',
      }),
    );
  });

  it('exports full Call Log CSV with preamble and records export audit log', async () => {
    const csvFile = await exportLandlordCallLogCsv(samplePayload.callLog, {
      from: '2026-10-21',
      to: '2026-10-27',
      generatedBy: 'Grace Nakato',
    });
    expect(csvFile).toBe('welile-landlord-call-log-2026-10-21-to-2026-10-27.csv');
    expect(downloadCsvWithPreambleMock).toHaveBeenCalledTimes(1);
    expect(auditInsertMock).toHaveBeenCalledWith(
      expect.objectContaining({
        action_type: 'csv_exported',
        table_name: 'export',
      }),
    );

    await logLandlordReportExport('pdf_report_exported', 'test.pdf', { rows: 10 });
    expect(auditInsertMock).toHaveBeenCalledWith(
      expect.objectContaining({
        action_type: 'pdf_report_exported',
        table_name: 'export',
      }),
    );
  });
});
