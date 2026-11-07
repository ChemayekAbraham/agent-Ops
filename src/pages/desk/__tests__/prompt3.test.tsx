import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const rpcMock = vi.fn();
vi.mock('@/integrations/supabase/client', () => ({
  supabase: { rpc: (...a: unknown[]) => rpcMock(...a), from: vi.fn(), storage: { from: vi.fn() } },
}));
vi.mock('@/hooks/useAuth', () => ({ useAuth: () => ({ user: null, roles: [] }) }));

import { DESKS } from '../deskConfig';
import { desksFor } from '../scScope';
import { CooBoard, cooTopLine, pushPlan, pushResultLine, type CooRow } from '../CooBoard';
import { opensDrawer, primaryLabel, triesToday, type BoardRow } from '../boardApi';
import { visibleDecisions } from '../reviewTypes';

/* ───────────────────────── fixtures ───────────────────────── */

function cooRow(over: Partial<CooRow>): CooRow {
  return {
    id: 'id',
    req: 'abcd1234',
    tenant: 'Tenant',
    agent: 'Agent',
    agent_grade: 'B',
    landlord: 'Landlord',
    landlord_verified: true,
    rent: 1_000_000,
    days_here: 3,
    ratings: { agent_ops: 80, tenant_ops: 70, landlord_ops: null, average: 75, grade: 'B', partly_rated: true },
    grade: 'B',
    avg: 75,
    flags: { passes: 5, total: 5, failing: [] },
    auto_forwarded: false,
    waiting: null,
    rank: 1,
    ...over,
  };
}

const COO_ROWS: CooRow[] = [
  cooRow({ id: 'r3', rank: 3, grade: 'C', rent: 300_000 }),
  cooRow({ id: 'r1', rank: 1, grade: 'A', rent: 1_000_000 }),
  cooRow({
    id: 'held',
    rank: 2,
    grade: 'A',
    rent: 9_000_000,
    waiting: { reason_code: 'OTHER', owner_kind: 'other', until_at: '2026-11-12T00:00:00Z', expired: false, note: 'FinOps check first', rule_id: 'COO-HOLD' },
  }),
  cooRow({ id: 'r4', rank: 4, grade: 'D', rent: 200_000 }),
];

function boardRow(decision: BoardRow['decision'], attempts: number | null = null): BoardRow {
  return {
    id: 'x', req: 'x', tenant: null, tenant_id: null, tenant_phone: null, agent_id: null, agent: null, agent_phone: null,
    agent_grade: null, agent_grade_week_ago: null, agent_flags: [], landlord: null, landlord_phone: null, rent: null,
    days_here: null, rating: null,
    flags: { passes: 0, total: 0, hard_fail: false, soft_fail: false, failing: [], notes: [], flags: [] },
    decision, rule_id: null, why: null, receiver: null, waiting: null, wait_suggest: null, push: null,
    call: { answered_since_stage: null, attempts_24h: attempts },
  };
}

/* ───────────────────────── 2. Service Centre routing ───────────────────────── */

describe('Service Centre people sign in', () => {
  it('an agent-only account that is an SC person sees only the Service Centre desk', () => {
    const r = desksFor(DESKS, ['agent'], { is_sc_person: true });
    expect(r.scOnly).toBe(true);
    expect(r.desks.map((d) => d.id)).toEqual(['service-centre']);
  });

  it('an agent with no Service Centre requests gets no desk', () => {
    expect(desksFor(DESKS, ['agent'], { is_sc_person: false })).toEqual({ desks: [], scOnly: false });
    expect(desksFor(DESKS, ['agent'], null)).toEqual({ desks: [], scOnly: false });
  });

  it('desk roles still decide for staff, without the SC scope', () => {
    const r = desksFor(DESKS, ['tenant_ops'], { is_sc_person: true });
    expect(r.scOnly).toBe(false);
    expect(r.desks.map((d) => d.id)).toContain('tenant-ops');
    expect(r.desks.map((d) => d.id)).not.toContain('coo');
  });
});

/* ───────────────────────── 3. COO push ───────────────────────── */

describe('COO push top N', () => {
  it('top line counts every graded and unrated request', () => {
    expect(cooTopLine({ A: 20, B: 40, C: 30, D: 23, unrated: 0, waiting: 0 })).toBe('113 waiting · A 20 · B 40 · C 30 · D 23');
    expect(cooTopLine({ A: 1, B: 0, C: 0, D: 0, unrated: 2, waiting: 1 })).toBe('3 waiting · A 1 · B 0 · C 0 · D 0 · 2 unrated · 1 on hold');
  });

  it('the confirm sheet lists the best N not on hold, with their total', () => {
    const plan = pushPlan(COO_ROWS, 2);
    expect(plan.rows.map((r) => r.id)).toEqual(['r1', 'r3']);
    expect(plan.totalUgx).toBe(1_300_000);
    expect(pushPlan(COO_ROWS, 10).rows).toHaveLength(3);
  });

  it('result line', () => {
    expect(
      pushResultLine({
        requested: 3,
        picked: 3,
        picked_list: [],
        approved: [{ id: 'a', rent_amount: 1_000_000 }, { id: 'b', rent_amount: 300_000 }],
        approved_total: 1_300_000,
        skipped: [{ id: 'c', reason: 'landlord not verified' }, { id: 'd', message: 'landlord not verified' }],
      }),
    ).toBe("Pushed 2 (UGX 1.3M) to the funders' dashboard; skipped 2 (landlord not verified)");
    expect(pushResultLine({ requested: 1, picked: 1, picked_list: [], approved: [{ id: 'a', rent_amount: 500_000 }], approved_total: 500_000, skipped: [] })).toBe(
      "Pushed 1 (UGX 500K) to the funders' dashboard; skipped 0",
    );
  });

  it('the main view has Push top N and no old Fund buttons', async () => {
    rpcMock.mockImplementation((fn: string) =>
      Promise.resolve(
        fn === 'pipeline_coo_board'
          ? { data: { counts: { A: 2, B: 0, C: 1, D: 1, unrated: 0, waiting: 1 }, can_push: true, room: 0, budget_set: false, rows: COO_ROWS }, error: null }
          : { data: null, error: null },
      ),
    );
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <CooBoard board={false} onOpen={() => {}} />
      </QueryClientProvider>,
    );
    await waitFor(() => expect(screen.getByText(/waiting · A 2/)).toBeTruthy());
    expect(screen.getByRole('button', { name: /Push top 10 to funders/ })).toBeTruthy();
    expect(screen.queryByText(/Fund by score/i)).toBeNull();
    expect(screen.queryByText(/Fund today/i)).toBeNull();
    expect(screen.queryAllByRole('button').filter((b) => /^\s*Fund\b/i.test(b.textContent ?? ''))).toHaveLength(0);
    expect(screen.getAllByText('partly rated').length).toBeGreaterThan(0);
  });

  it('the drawer no longer offers Fund, Attach funder or the COO bucket', () => {
    expect(visibleDecisions('coo')).toEqual(['hold', 'send_back']);
    expect(visibleDecisions('partner_ops')).toEqual(['send_back']);
  });

  it('a pushable row shows "Push to funders" and pushes only that row; a frozen row shows none', async () => {
    rpcMock.mockImplementation((fn: string) =>
      Promise.resolve(
        fn === 'pipeline_coo_board'
          ? {
              data: {
                counts: { A: 1, B: 0, C: 0, D: 0, unrated: 0, waiting: 0, pushable: 1, frozen: 1 },
                can_push: true,
                rows: [
                  cooRow({ id: 'r1', rank: 1, grade: 'A', rent: 1_000_000, pushable: true }),
                  cooRow({
                    id: 'fz',
                    rank: 2,
                    grade: 'B',
                    rent: 500_000,
                    pushable: false,
                    frozen: { reason: 'ID check', since: '2026-11-01T00:00:00Z', returns_to_agent_ops_at: '2026-11-10T00:00:00Z' },
                  }),
                ],
              },
              error: null,
            }
          : fn === 'coo_push_selected'
            ? { data: { requested: 1, approved: [{ id: 'r1', rent_amount: 1_000_000 }], approved_total: 1_000_000, skipped: [] }, error: null }
            : { data: null, error: null },
      ),
    );
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <CooBoard board={false} onOpen={() => {}} />
      </QueryClientProvider>,
    );
    // Only the pushable row carries the button; the frozen row keeps its chip.
    await waitFor(() => expect(screen.getAllByRole('button', { name: 'Push to funders' })).toHaveLength(1));
    expect(screen.getByText(/Frozen — ID check/)).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Push to funders' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('Tenant')).toBeTruthy();
    expect(within(dialog).getByText(/UGX 1,000,000/)).toBeTruthy();

    fireEvent.click(within(dialog).getByRole('button', { name: 'Push to funders' }));
    await waitFor(() => expect(rpcMock).toHaveBeenCalledWith('coo_push_selected', { p_ids: ['r1'], p_comment: null }));
    await screen.findByText("Pushed to the funders' dashboard");
  });
});

/* ───────────────────────── 1. Tenant / Landlord / SC board buttons ───────────────────────── */

describe('board button labels per decision', () => {
  it('Tenant Ops', () => {
    expect(primaryLabel(boardRow('call'), 'tenant_ops')).toBe('Call tenant');
    expect(primaryLabel(boardRow('complete'), 'tenant_ops')).toBe('Finish checks');
    expect(primaryLabel(boardRow('pass'), 'tenant_ops')).toBe('Pass');
    expect(primaryLabel(boardRow('call_again'), 'tenant_ops')).toBe('Call again');
    expect(primaryLabel(boardRow('reject'), 'tenant_ops')).toBe('Reject');
    expect(primaryLabel(boardRow('waiting'), 'tenant_ops')).toBeNull();
  });

  it('Landlord Ops', () => {
    expect(primaryLabel(boardRow('call'), 'landlord_ops')).toBe('Call landlord');
    expect(primaryLabel(boardRow('complete'), 'landlord_ops')).toBe('Finish checks');
  });

  it('Service Centre', () => {
    expect(primaryLabel(boardRow('complete'), 'service_centre')).toBe('Call and fill');
    expect(primaryLabel(boardRow('send_back'), 'service_centre')).toBe('Send back');
  });

  it('call and complete open the drawer; tries today', () => {
    expect(opensDrawer('call')).toBe(true);
    expect(opensDrawer('complete')).toBe(true);
    expect(opensDrawer('pass')).toBe(false);
    expect(triesToday({ answered_since_stage: null, attempts_24h: 3 })).toBe('3 tries today');
    expect(triesToday({ answered_since_stage: null, attempts_24h: 0 })).toBeNull();
    expect(triesToday(null)).toBeNull();
  });
});
