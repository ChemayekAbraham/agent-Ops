import { describe, expect, it, vi } from 'vitest';

vi.mock('@/integrations/supabase/client', () => ({
  supabase: {
    rpc: vi.fn(),
  },
}));

import {
  buildMonthPeriodWindow,
  buildTeamCallingReportData,
  buildWeekPeriodWindow,
  canAccessHrStaffReports,
  cleanAscii,
  isCallingTeamHead,
  isCallingTeamStaff,
  JANE_USER_ID,
  MARK_BWAYO_USER_ID,
  WINNIE_USER_ID,
  HANISHA_USER_ID,
  type RawStaffCallingRow,
} from '@/hooks/useStaffCallingReport';
import {
  generateGeneralTeamCallingPdfBlob,
  generateIndividualStaffCallingPdfBlob,
} from '@/lib/staffCallingReportPdf';

describe('staffCallingReport helpers & PDF generation', () => {
  it('sanitizes non-ASCII punctuation to pure 7-bit ASCII without replacement chars', () => {
    const raw = 'Tenant Ops · Calling Center — “Reached” ’test’ … 100%';
    const cleaned = cleanAscii(raw);
    expect(cleaned).toBe('Tenant Ops | Calling Center - "Reached" \'test\' ... 100%');
    for (let i = 0; i < cleaned.length; i += 1) {
      expect(cleaned.charCodeAt(i)).toBeGreaterThanOrEqual(32);
      expect(cleaned.charCodeAt(i)).toBeLessThanOrEqual(126);
    }
  });

  it('snaps any date to its Wednesday-Tuesday week in Africa/Kampala time', () => {
    // Friday 2026-10-23 belongs to Wed 2026-10-21 .. Tue 2026-10-27
    const win = buildWeekPeriodWindow('2026-10-23');
    expect(win.startDay).toBe('2026-10-21');
    expect(win.endDay).toBe('2026-10-27');
    expect(win.fromIso).toBe('2026-10-21T00:00:00+03:00');
    expect(win.toIso).toBe('2026-10-28T00:00:00+03:00');
    expect(win.days).toHaveLength(7);
    expect(win.periodLabel).toContain('Wed 21 Oct 2026 - Tue 27 Oct 2026');
  });

  it('builds a specific month window (e.g. October 2026)', () => {
    const win = buildMonthPeriodWindow('2026-10', '2026-10-23');
    expect(win.startDay).toBe('2026-10-01');
    expect(win.endDay).toBe('2026-10-23');
    expect(win.fromIso).toBe('2026-10-01T00:00:00+03:00');
    expect(win.toIso).toBe('2026-11-01T00:00:00+03:00');
    expect(win.days).toHaveLength(23);
    expect(win.shortLabel).toBe('October 2026');
  });

  it('gates My Reports strictly to the 3 calling staff (with Jane as head) and Staff Reports strictly to HR Mark Bwayo', () => {
    expect(isCallingTeamStaff(JANE_USER_ID)).toBe(true);
    expect(isCallingTeamStaff(WINNIE_USER_ID)).toBe(true);
    expect(isCallingTeamStaff(HANISHA_USER_ID)).toBe(true);
    expect(isCallingTeamStaff(MARK_BWAYO_USER_ID)).toBe(false);

    expect(isCallingTeamHead(JANE_USER_ID)).toBe(true);
    expect(isCallingTeamHead(WINNIE_USER_ID)).toBe(false);
    expect(isCallingTeamHead(HANISHA_USER_ID)).toBe(false);

    expect(canAccessHrStaffReports(MARK_BWAYO_USER_ID, ['employee'])).toBe(true);
    expect(canAccessHrStaffReports('00000000-0000-0000-0000-000000000001', ['hr', 'super_admin', 'ceo'])).toBe(false);
    expect(canAccessHrStaffReports(JANE_USER_ID, ['operations'])).toBe(false);
    expect(canAccessHrStaffReports(WINNIE_USER_ID, ['operations'])).toBe(false);
  });

  it('generates both Individual and General Team PDF blobs with Landlord Calling Center & Rent Pipeline rows', async () => {
    const sampleRows: RawStaffCallingRow[] = [
      {
        staff_id: WINNIE_USER_ID,
        short_name: 'Winnie',
        staff_name: 'Winfred Asiimwe',
        ts: '2026-10-21T09:15:00+03:00',
        day: '2026-10-21',
        hhmm: '09:15',
        source: 'Tenant Ops - Calling Center',
        role: 'tenant',
        name: 'Namukasa Sarah',
        phone: '+256701234567',
        phone9: '701234567',
        answered: true,
        outcome: 'engaged',
        feedback: 'Payment dispute (high) | Tenant says she paid 100k to agent.',
        extra: { category: 'Payment dispute', severity: 'high' },
        rr_id: null,
        person_id: '11111111-1111-1111-1111-111111111111',
        prio: 1,
        excluded_reveals: 3,
      },
      {
        staff_id: JANE_USER_ID,
        short_name: 'Jane',
        staff_name: 'Janehephzibar Gimono',
        ts: '2026-10-22T11:30:00+03:00',
        day: '2026-10-22',
        hhmm: '11:30',
        source: 'Landlord Ops - Calling Center',
        role: 'landlord',
        name: 'Ssemakula Ronald',
        phone: '+256772345678',
        phone9: '772345678',
        answered: true,
        outcome: 'engaged',
        feedback: 'Confirmed payout number | Landlord happy and appreciates Welile.',
        extra: { category: 'Confirmed payout number', severity: 'low', subject_type: 'landlord' },
        rr_id: null,
        person_id: '22222222-2222-2222-2222-222222222222',
        prio: 1,
        excluded_reveals: 1,
      },
      {
        staff_id: JANE_USER_ID,
        short_name: 'Jane',
        staff_name: 'Janehephzibar Gimono',
        ts: '2026-10-22T14:00:00+03:00',
        day: '2026-10-22',
        hhmm: '14:00',
        source: 'Rent Pipeline - Awareness call',
        role: 'landlord',
        name: 'Mugisha Peter',
        phone: '+256782111222',
        phone9: '782111222',
        answered: true,
        outcome: 'answered',
        feedback: 'Verification: Tenant okay | Decision note: Pay landlord',
        extra: {
          aware_30m: 'did_not_know',
          explained: 'yes',
          landlord_consent: 'consents',
          payout_otp: 'knew',
          landlord_ops_comment: 'Pay landlord',
        },
        rr_id: '33333333-3333-3333-3333-333333333333',
        person_id: '44444444-4444-4444-4444-444444444444',
        prio: 2,
        excluded_reveals: 1,
      },
    ];

    const win = buildWeekPeriodWindow('2026-10-23');
    const teamData = buildTeamCallingReportData(sampleRows, win);
    expect(teamData.stats.total).toBe(3);
    expect(teamData.stats.people).toBe(3);

    const janeData = teamData.perStaff.find((s) => s.person.id === JANE_USER_ID)!;
    expect(janeData.stats.total).toBe(2);
    expect(janeData.channels.map((c) => c.source)).toContain('Landlord Ops - Calling Center');

    const indivPdf = await generateIndividualStaffCallingPdfBlob(janeData, win);
    expect(indivPdf.fileName).toBe('Call-Report-Jane-Janehephzibar-Gimono-Week-2026-10-21-to-2026-10-27.pdf');
    expect(indivPdf.blob.size).toBeGreaterThan(1000);

    const teamPdf = await generateGeneralTeamCallingPdfBlob(teamData, win);
    expect(teamPdf.fileName).toBe('Call-Report-Team-Jane-Winnie-Hanisha-Week-2026-10-21-to-2026-10-27.pdf');
    expect(teamPdf.blob.size).toBeGreaterThan(1000);
  });
});
