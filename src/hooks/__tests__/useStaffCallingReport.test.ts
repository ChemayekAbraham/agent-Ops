// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/integrations/supabase/client', () => ({
  supabase: {
    rpc: vi.fn(),
  },
}));

import {
  buildCustomDaysPeriodWindow,
  buildIndividualReportData,
  buildMonthPeriodWindow,
  buildTeamCallingReportData,
  buildWeekPeriodWindow,
  CALLING_TEAM_STAFF,
  computeStats,
  enrichRawCallingRows,
  formatCallsMadeHeadline,
  rowFeedbackThemes,
  type RawStaffCallingRow,
} from '../useStaffCallingReport';

const JANE = CALLING_TEAM_STAFF.find((p) => p.short === 'Jane')!;
const WINNIE = CALLING_TEAM_STAFF.find((p) => p.short === 'Winnie')!;
const HANISHA = CALLING_TEAM_STAFF.find((p) => p.short === 'Hanisha')!;

function makeRawRow(overrides: Partial<RawStaffCallingRow> = {}): RawStaffCallingRow {
  return {
    staff_id: HANISHA.id,
    short_name: HANISHA.short,
    staff_name: HANISHA.display,
    day: '2026-10-29',
    hhmm: '10:15',
    ts: '2026-10-29T10:15:00+03:00',
    source: 'Calling Center (Outbound)',
    role: 'landlord',
    name: 'Kato Samuel',
    phone: '0772111222',
    phone9: '772111222',
    answered: true,
    outcome: 'engaged',
    feedback: 'Landlord confirmed tenant and payout details.',
    extra: {},
    rr_id: null,
    person_id: null,
    prio: 1,
    excluded_reveals: 0,
    ...overrides,
  };
}

describe('useStaffCallingReport — Prompt 1 fixes', () => {
  describe('(1) Headline Calls made split & exclusions', () => {
    it('formats the headline Calls made label with recorded and awaiting-result counts', () => {
      expect(formatCallsMadeHeadline(252, 245, 7)).toBe(
        'Calls made: 252 (245 recorded, 7 awaiting a result)',
      );
      expect(formatCallsMadeHeadline(100, 100, 0)).toBe(
        'Calls made: 100 (100 recorded, 0 awaiting a result)',
      );
    });

    it('computes callsMade = recordedCalls + awaitingResultCalls and keeps reviewOnly separate', () => {
      const rawRows = [
        makeRawRow({
          day: '2026-10-28',
          phone: '0772000001',
          answered: true,
          outcome: 'engaged',
          extra: {
            excluded_cross_source_dupes: 3,
            excluded_test_contacts: 1,
          },
        }),
        makeRawRow({
          day: '2026-10-28',
          phone: '0772000002',
          answered: false,
          outcome: 'phone_off',
          feedback: '',
        }),
        makeRawRow({
          day: '2026-10-29',
          phone: '0772000003',
          answered: false,
          outcome: 'awaiting_result',
          feedback: 'Phone dialed; call outcome not yet submitted',
        }),
        makeRawRow({
          day: '2026-10-29',
          phone: '0772000004',
          source: 'Landlord Ops Verification / Review',
          answered: null,
          outcome: 'review recorded',
          feedback: 'Approved for COO review',
        }),
      ];

      const enriched = enrichRawCallingRows(rawRows, '2026-10-28', '2026-10-29');
      const stats = computeStats(enriched);

      expect(stats.callsMade).toBe(3);
      expect(stats.recordedCalls).toBe(2);
      expect(stats.awaitingResultCalls).toBe(1);
      expect(stats.reviewOnly).toBe(1);
      expect(stats.total).toBe(4);
      expect(stats.reached).toBe(1);
      expect(stats.notReached).toBe(1);
      expect(stats.reachPct).toBe(50);
      expect(stats.headlineCallsMadeLabel).toBe('Calls made: 3 (2 recorded, 1 awaiting a result)');
      expect(stats.excludedCrossSourceDupes).toBe(3);
      expect(stats.excludedTestContacts).toBe(1);
    });
  });

  describe('(2) Custom days calendar range & exact Week/Month boundary parity', () => {
    it('matches the exact RPC date bounds and day list when Custom days equals a Wed-Tue week', () => {
      const weekWin = buildWeekPeriodWindow('2026-10-28');
      const customWin = buildCustomDaysPeriodWindow('2026-10-28', '2026-11-03');

      expect(customWin.mode).toBe('custom');
      expect(customWin.startDay).toBe(weekWin.startDay);
      expect(customWin.endDay).toBe(weekWin.endDay);
      expect(customWin.fromIso).toBe(weekWin.fromIso);
      expect(customWin.toIso).toBe(weekWin.toIso);
      expect(customWin.days).toEqual(weekWin.days);
      expect(customWin.periodLabel).toContain('Custom days: 28 Oct 2026 - 03 Nov 2026');
      expect(customWin.periodLabel).not.toContain('Week:');
    });

    it('matches the exact RPC date bounds and day list when Custom days equals a full month', () => {
      const monthWin = buildMonthPeriodWindow('2026-10', '2026-11-04');
      const customWin = buildCustomDaysPeriodWindow('2026-10-01', '2026-10-31');

      expect(customWin.startDay).toBe(monthWin.startDay);
      expect(customWin.endDay).toBe(monthWin.endDay);
      expect(customWin.fromIso).toBe(monthWin.fromIso);
      expect(customWin.toIso).toBe(monthWin.toIso);
      expect(customWin.days).toEqual(monthWin.days);
      expect(customWin.shortLabel).toBe('01 Oct 2026 - 31 Oct 2026');
    });

    it('normalizes reversed start/end dates automatically', () => {
      const customWin = buildCustomDaysPeriodWindow('2026-11-03', '2026-10-28');
      expect(customWin.startDay).toBe('2026-10-28');
      expect(customWin.endDay).toBe('2026-11-03');
      expect(customWin.days).toHaveLength(7);
    });
  });

  describe('(3) Wrong number and Phone off in Section 5 feedback themes', () => {
    it('maps outcome === wrong_number and outcome === phone_off into their own feedback theme rows with officer notes', () => {
      const rawRows = [
        makeRawRow({
          staff_id: WINNIE.id,
          short_name: WINNIE.short,
          staff_name: WINNIE.display,
          answered: false,
          outcome: 'wrong_number',
          feedback: 'Wrong number; corrected landlord contact is 0782999888',
          extra: { feedback_category: 'wrong_number' },
        }),
        makeRawRow({
          staff_id: HANISHA.id,
          short_name: HANISHA.short,
          staff_name: HANISHA.display,
          answered: false,
          outcome: 'phone_off',
          feedback: '',
          extra: { feedback_category: 'phone_off' },
        }),
        makeRawRow({
          staff_id: JANE.id,
          short_name: JANE.short,
          staff_name: JANE.display,
          answered: false,
          outcome: 'wrong_number',
          feedback: "Declined: Landlord's number doesn't exist",
          extra: { feedback_category: 'wrong_number' },
        }),
      ];

      const enriched = enrichRawCallingRows(rawRows, '2026-10-28', '2026-11-03');
      expect(rowFeedbackThemes(enriched[0])).toContain('Wrong number');
      expect(rowFeedbackThemes(enriched[1])).toContain('Phone off');

      const periodWindow = buildCustomDaysPeriodWindow('2026-10-28', '2026-11-03');
      const teamReport = buildTeamCallingReportData(rawRows, periodWindow);
      const wrongNumberTheme = teamReport.themes.find((t) => t.label === 'Wrong number');
      const phoneOffTheme = teamReport.themes.find((t) => t.label === 'Phone off');

      expect(wrongNumberTheme).toBeDefined();
      expect(wrongNumberTheme?.value).toBe(2);
      expect(wrongNumberTheme?.byStaff.Winnie).toBe(1);
      expect(wrongNumberTheme?.byStaff.Jane).toBe(1);
      expect(wrongNumberTheme?.sampleNotes).toEqual(
        expect.arrayContaining([
          expect.stringContaining('Wrong number; corrected landlord contact is 0782999888'),
          expect.stringContaining("Declined: Landlord's number doesn't exist"),
        ]),
      );

      expect(phoneOffTheme).toBeDefined();
      expect(phoneOffTheme?.value).toBe(1);
      expect(phoneOffTheme?.byStaff.Hanisha).toBe(1);

      const winnieIndividual = buildIndividualReportData(WINNIE, enriched);
      const winnieWrongNo = winnieIndividual.themes.find((t) => t.label === 'Wrong number');
      expect(winnieWrongNo?.value).toBe(1);
      expect(winnieWrongNo?.sampleNotes?.[0]).toContain(
        'Wrong number; corrected landlord contact is 0782999888',
      );
    });
  });
});
