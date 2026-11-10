import { describe, expect, it, vi } from 'vitest';

vi.mock('@/integrations/supabase/client', () => ({ supabase: { rpc: vi.fn() } }));

import {
  FB_DEFAULT_REASON,
  FB_REASONS,
  awaitingRentRequestIds,
  countFull,
  demoteReasonOk,
  demoteSummary,
  demotedByText,
  demotionReason,
  parseCooDemoted,
  parseCounter,
  parseCounterList,
  parseDemoteResult,
  parseHeadline,
  ugxFull,
} from './fundersBoard';

describe('E58 funders board: shared rules', () => {
  it('UGX in whole shillings with thousands separators; unknown is a dash, never 0', () => {
    expect(ugxFull(32_400_000)).toBe('UGX 32,400,000');
    expect(ugxFull(0)).toBe('UGX 0');
    expect(ugxFull(null)).toBe('—');
    expect(countFull(1234)).toBe('1,234');
    expect(countFull(undefined)).toBe('—');
  });

  it('headline: on/off and the three figures', () => {
    expect(parseHeadline({ on: true, houses_waiting: 137, amount_needed_ugx: '52300000', avg_monthly_rent: 381752 })).toMatchObject({
      on: true,
      houses_waiting: 137,
      amount_needed_ugx: 52_300_000,
      avg_monthly_rent: 381_752,
    });
    expect(parseHeadline(null).on).toBe(false);
  });

  it('reason chips in order, FB_NOT_QUALIFIED by default; OTHER needs 10+ characters', () => {
    expect(FB_REASONS.map((r) => r.code)).toEqual(['FB_NOT_QUALIFIED', 'FB_PHOTOS_POOR', 'FB_DETAILS_WRONG', 'FB_NOT_AVAILABLE', 'FB_DUPLICATE', 'OTHER']);
    expect(FB_DEFAULT_REASON).toBe('FB_NOT_QUALIFIED');
    expect(demoteReasonOk('FB_PHOTOS_POOR', '')).toBe(true);
    expect(demoteReasonOk('OTHER', 'too short')).toBe(false);
    expect(demoteReasonOk('OTHER', '  landlord moved  ')).toBe(true);
  });

  it('demote result: "X demoted · Y skipped" with each skip message', () => {
    const r = parseDemoteResult({
      demoted: [{ id: 'a' }, { id: 'b' }],
      demoted_count: 2,
      skipped: [{ kind: 'house_listing', id: 'c', reason: 'funder_holding', message: 'A funder has reserved or funded this house, so it cannot be demoted' }],
      headline: { on: true, houses_waiting: 135 },
    });
    expect(demoteSummary(r)).toBe('2 demoted · 1 skipped');
    expect(r.skipped[0].message).toMatch(/cannot be demoted/);
    expect(r.headline?.houses_waiting).toBe(135);
  });

  it('COO board: awaiting, decided, levels per kind, and who demoted it', () => {
    const b = parseCooDemoted({
      can_decide: true,
      awaiting: [
        { id: 'd1', kind: 'rent_request', item_id: 'rr-1', tag: 'verified', title: 'Achieng', amount: 600000, demoted_by_name: 'Agnes', demoted_staff_ref: 'EMP-014', demoted_position: 'coo', reason_code: 'FB_PHOTOS_POOR', reason_label: 'Photos not good enough to show funders', days_waiting: 1.5, moved_by_system: true },
        { id: 'd2', kind: 'house_listing', item_id: 'h-1', tag: 'empty_house', title: 'Single room' },
      ],
      decided: [],
      levels: { rent_request: [{ code: 'coo', label: 'COO queue', hint: 'Stays in your graded queue' }], house_listing: [{ code: 'parked', label: 'Parked off the board' }] },
      counts: { awaiting: 2, awaiting_ugx: 900000 },
    });
    expect(b.can_decide).toBe(true);
    expect(b.awaiting[0]).toMatchObject({ tag_label: 'Verified', moved_by_system: true, short_id: 'rr-1' });
    expect(b.awaiting[1].tag_label).toBe('Empty house');
    expect(b.levels.rent_request[0].hint).toBe('Stays in your graded queue');
    expect(demotedByText(b.awaiting[0])).toBe('Agnes · EMP-014 · COO');
    expect(demotionReason(b.awaiting[0])).toBe('Photos not good enough to show funders');
    expect([...awaitingRentRequestIds(b)]).toEqual(['rr-1']);
  });

  it('counter and its lists', () => {
    const c = parseCounter({ houses_waiting: 137, amount_needed_ugx: 52300000, baseline_houses: 140, added_by_push: 3, removed: 6, switch_on: true });
    expect(c).toMatchObject({ houses_waiting: 137, baseline_houses: 140, added_by_push: 3, removed: 6, restored: 0, switch_on: true });
    const l = parseCounterList([{ event_id: 7, kind: 'house_listing', item_id: 'h-1', tag_label: 'Empty house', title: 'Single room', amount: 250000 }]);
    expect(l[0]).toMatchObject({ event_id: '7', short_id: 'h-1', title: 'Single room', amount: 250000 });
    expect(parseCounterList(null)).toEqual([]);
  });
});
