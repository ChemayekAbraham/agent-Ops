import { describe, expect, it, vi } from 'vitest';

const invoke = vi.fn();
vi.mock('@/integrations/supabase/client', () => ({
  supabase: { rpc: vi.fn(), from: vi.fn(), functions: { invoke: (...a: unknown[]) => invoke(...a) } },
}));
vi.mock('@/hooks/useAuth', () => ({ useAuth: () => ({ user: null, roles: [] }) }));

import { PERIODS, fundOne, toDashboard, type FundersRow } from '../cfoApi';
import { canFundRow, heldLabel, rating, sortRows, ugx } from '../fundersView';
import { DESKS, DESK_ALIASES } from '../../deskConfig';
import { STRIP_STAGES } from '../../PipelineStrip';

const row = (id: string, over: Partial<FundersRow> = {}): FundersRow => ({
  id,
  req: id.slice(0, 8),
  tenant: null,
  tenant_location: null,
  agent: null,
  landlord: null,
  landlord_phone: null,
  lc1: null,
  rent: 100,
  funding_amount: 100,
  gps: null,
  photos: [],
  days_on_board: 1,
  held: false,
  hold_expires_at: null,
  grade: 'A',
  average: null,
  ratings: null,
  rank_grade: null,
  rank_oldest: null,
  ...over,
});

describe('desk tabs', () => {
  it('shows the top row in the agreed order with the CFO desk named Funders Dashboard', () => {
    expect(DESKS.map((d) => d.name)).toEqual([
      'Command centre', 'Service Centre', 'Agent Ops', 'Tenant Ops', 'Landlord Ops',
      'COO', 'Funders Dashboard', 'Partner Ops', 'Customer Care', 'Ontology',
    ]);
  });
  it('keeps the id cfo and answers to /desk/funders', () => {
    expect(DESKS.find((d) => d.name === 'Funders Dashboard')?.id).toBe('cfo');
    expect(DESK_ALIASES.funders).toBe('cfo');
  });
  it('calls the CFO stage Funders in the strip', () => {
    expect(STRIP_STAGES.find((s) => s.desk === 'cfo')?.label).toBe('Funders');
  });
  it('carries no budget tiles on the Funders Dashboard', () => {
    const cfo = DESKS.find((d) => d.id === 'cfo');
    expect(cfo?.tiles).toEqual([]);
    expect(JSON.stringify(cfo?.question) + cfo?.lead(() => 'x')).not.toMatch(/budget/i);
  });
});

describe('toDashboard', () => {
  it('reads the server shape and defaults what is missing', () => {
    const d = toDashboard({
      generated_at: '2026-11-05T10:00:00Z',
      period: 'today',
      fund_today: { n: 2, ugx: '500' },
      funded: { n: 3, ugx: 900, by_funders: { n: 2, ugx: 600 }, by_welile: { n: 1, ugx: 300 }, avg_days_coo_to_funded: '1.5' },
      can_fund_welile: true,
      rows: [{ id: 'abc', rent: '250', held: true, rank_grade: '2' }],
    });
    expect(d.fund_today).toEqual({ n: 2, ugx: 500 });
    expect(d.held_by_funders).toEqual({ n: 0, ugx: 0 });
    expect(d.funded.by_welile).toEqual({ n: 1, ugx: 300 });
    expect(d.funded.avg_days_coo_to_funded).toBe(1.5);
    expect(d.rows[0]).toMatchObject({ id: 'abc', rent: 250, held: true, rank_grade: 2 });
    expect(toDashboard(null)).toMatchObject({ can_fund_welile: false, rows: [] });
  });
  it('offers five periods with Today first', () => {
    expect(PERIODS.map((p) => p.label)).toEqual(['Today', '7 days', '30 days', '90 days', 'All time']);
  });
});

describe('list helpers', () => {
  const rows = [
    row('a', { rank_grade: 3, rank_oldest: 1 }),
    row('b', { rank_grade: 1, rank_oldest: 3 }),
    row('c', { rank_grade: null, rank_oldest: 2 }),
    row('d', { rank_grade: 2, rank_oldest: null }),
  ];
  it('sorts by grade or by age, unranked last', () => {
    expect(sortRows(rows, 'grade').map((r) => r.id)).toEqual(['b', 'd', 'a', 'c']);
    expect(sortRows(rows, 'oldest').map((r) => r.id)).toEqual(['a', 'c', 'b', 'd']);
  });
  it('offers Welile funding only when allowed and not held', () => {
    expect(canFundRow(row('x'), true)).toBe(true);
    expect(canFundRow(row('x', { held: true }), true)).toBe(false);
    expect(canFundRow(row('x'), false)).toBe(false);
  });
  it('labels a hold with its Kampala end time', () => {
    expect(heldLabel(row('x'))).toBeNull();
    expect(heldLabel(row('x', { held: true, hold_expires_at: '2026-11-05T11:05:00Z' }))).toBe('Held until 14:05');
    expect(heldLabel(row('x', { held: true }))).toBe('Held');
  });
  it('formats money and ratings', () => {
    expect(ugx(1234567)).toBe('UGX 1,234,567');
    expect(ugx(null)).toBe('—');
    expect(rating(null)).toBe('—');
    expect(rating(4.26)).toBe('4.3');
  });
});

describe('fundOne', () => {
  it('calls the existing CFO funding function with the request id', async () => {
    invoke.mockResolvedValueOnce({ data: { success: true }, error: null });
    await expect(fundOne('req-1')).resolves.toEqual({ ok: true });
    expect(invoke).toHaveBeenCalledWith('fund-agent-landlord-float', {
      body: { rent_request_id: 'req-1', notes: 'Funders Dashboard' },
    });
  });
  it("passes the server's refusal through unchanged", async () => {
    const msg = 'A funder already holds this request — Welile funding refused to avoid double funding.';
    invoke.mockResolvedValueOnce({ data: { error: msg }, error: null });
    await expect(fundOne('req-2')).resolves.toEqual({ ok: false, reason: msg });
  });
});
