import { beforeEach, describe, expect, it, vi } from 'vitest';

const rpcMock = vi.fn();
const fromMock = vi.fn();
vi.mock('@/integrations/supabase/client', () => ({
  supabase: { rpc: (...a: unknown[]) => rpcMock(...a), from: (...a: unknown[]) => fromMock(...a), storage: { from: vi.fn() } },
}));
vi.mock('@/hooks/useAuth', () => ({ useAuth: () => ({ user: null, roles: [] }) }));
vi.mock('@/lib/cooDecide', () => ({ cooDecide: vi.fn(), cooDecisionSummary: vi.fn(), mergeApproveResults: vi.fn() }));

import { flagsChip, gradeTrend, ownerWords, primaryLabel, pushRow, setSuggestedWait, type BoardRow } from '../boardApi';
import { progressText } from '../ReadyBoard';
import { badgeFor } from '../agentGrade';

function row(over: Partial<BoardRow> = {}): BoardRow {
  return {
    id: 'req-uuid-1',
    req: '9508661e',
    tenant: 'Tenant',
    tenant_id: 't1',
    tenant_phone: '+256700000001',
    agent_id: 'a1',
    agent: 'Agent',
    agent_phone: '+256700000002',
    agent_grade: 'D',
    agent_grade_week_ago: null,
    agent_flags: [],
    landlord: 'Landlord',
    landlord_phone: '0700000003',
    rent: 500000,
    days_here: 72.5,
    rating: 57,
    flags: {
      passes: 5,
      total: 5,
      hard_fail: false,
      soft_fail: false,
      failing: [],
      notes: [],
      flags: [
        { code: 'repaid_history', label: 'Repaid earlier plans (60%+)', level: 'hard', ok: true, detail: null },
        { code: 'id_on_file', label: 'Tenant ID on file', level: 'soft', ok: true, detail: null },
      ],
    },
    decision: 'transfer',
    rule_id: 'AO-4',
    why: 'Agent D: move to Receiver (B, 0.1 km)',
    receiver: { agent_id: 'r1', name: 'Receiver', grade: 'B', km: 0.1, score: 65.4 },
    waiting: null,
    wait_suggest: null,
    push: {
      decision: 'transfer',
      results: [{ code: 'ao_items_valid', result: 'pass' }, { code: 'ao_agent_performance', result: 'fail' }],
      reason_code: null,
      note: 'AO-4: agent grade D (score 30.5); tenant passes; moved to Receiver (B, 0.1 km).',
      target_agent_id: 'r1',
    },
    call: { answered_since_stage: null, attempts_24h: null },
    ...over,
  };
}

beforeEach(() => {
  rpcMock.mockReset();
  fromMock.mockReset();
});

describe('board row reading', () => {
  it('flags chip: all pass, or the first failing label', () => {
    expect(flagsChip(row().flags).text).toBe('5/5 ✓');
    const f = row().flags;
    const failing = { ...f, passes: 4, flags: [f.flags[0], { ...f.flags[1], ok: false }] };
    expect(flagsChip(failing)).toEqual({ text: '4/5 — Tenant ID on file', ok: false });
  });

  it('grade trend only between A–D grades with a week-ago value', () => {
    expect(gradeTrend('B', 'D')).toBe('up');
    expect(gradeTrend('D', 'B')).toBe('down');
    expect(gradeTrend('C', 'C')).toBe('same');
    expect(gradeTrend('D', null)).toBeNull();
    expect(gradeTrend('N', 'C')).toBeNull();
  });

  it('grade badges', () => {
    expect(badgeFor('N').text).toBe('New');
    expect(badgeFor('X').text).toBe('Blocked');
    expect(badgeFor(null).text).toBe('Not graded');
    expect(badgeFor('A').cls).toMatch(/emerald/);
    expect(badgeFor('B').cls).toMatch(/teal/);
    expect(badgeFor('C').cls).toMatch(/amber/);
    expect(badgeFor('D').cls).toMatch(/red/);
  });

  it('primary button words', () => {
    expect(primaryLabel(row(), 'agent_ops')).toBe('Transfer → Receiver (B, 0.1 km)');
    expect(primaryLabel(row({ decision: 'pass' }), 'agent_ops')).toBe('Pass');
    const wait = row({
      decision: 'wait',
      push: null,
      receiver: null,
      wait_suggest: { reason_code: 'NO_RECEIVER', owner_kind: 'desk_lead', hours: 48, rule_id: 'AO-5', note: 'find a receiving agent' },
    });
    expect(primaryLabel(wait, 'agent_ops')).toBe('Wait 48 h on Agent Ops lead');
    expect(primaryLabel(row({ decision: 'waiting' }), 'agent_ops')).toBeNull();
    expect(ownerWords('landlord', 'agent_ops')).toBe('the landlord');
    expect(ownerWords('agent', 'agent_ops', 'Named Person')).toBe('Named Person');
  });

  it('progress line', () => {
    expect(progressText({ total: 12, done: 7, failed: [{ req: 'x', reason: 'budget' }], skipped: 0 })).toBe('7/12 done, 1 failed (budget)');
    expect(progressText({ total: 3, done: 2, failed: [], skipped: 1 })).toBe('2/3 done, 1 skipped — decision changed');
  });
});

describe('one push = the drawer’s two calls', () => {
  it('records the review with the push values, then transfers to the target agent', async () => {
    rpcMock.mockResolvedValue({ data: null, error: null });
    const out = await pushRow(row(), 'agent_ops', 'staff-1');
    expect(out.kind).toBe('moved');
    expect(rpcMock.mock.calls.map((c) => c[0])).toEqual(['pipeline_record_review', 'ops_transfer_pipeline_request_agent']);
    expect(rpcMock.mock.calls[0][1]).toMatchObject({
      p_request_id: 'req-uuid-1',
      p_stage: 'agent_ops',
      p_decision: 'transfer',
      p_target_agent_id: 'r1',
      p_note: row().push!.note,
    });
    expect(rpcMock.mock.calls[0][1].p_results).toHaveLength(2);
    expect(rpcMock.mock.calls[1][1]).toMatchObject({ p_request_id: 'req-uuid-1', p_to_agent_id: 'r1' });
  });

  it('never moves when the review fails', async () => {
    rpcMock.mockResolvedValueOnce({ data: null, error: { message: 'no staff id' } });
    const out = await pushRow(row(), 'agent_ops', 'staff-1');
    expect(out).toEqual({ kind: 'review_failed', message: 'no staff id' });
    expect(rpcMock).toHaveBeenCalledTimes(1);
  });

  it('a failed move leaves the review in and reports move_failed', async () => {
    rpcMock.mockResolvedValueOnce({ data: null, error: null }).mockResolvedValueOnce({ data: null, error: { message: 'agent full' } });
    const out = await pushRow(row(), 'agent_ops', 'staff-1');
    expect(out).toEqual({ kind: 'move_failed', message: 'agent full' });
  });

  it('a suggested wait is one pipeline_set_waiting call, never a move', async () => {
    rpcMock.mockResolvedValue({ data: null, error: null });
    const wait = row({
      decision: 'wait',
      push: null,
      wait_suggest: { reason_code: 'NO_RECEIVER', owner_kind: 'desk_lead', hours: 48, rule_id: 'AO-5', note: 'find a receiving agent' },
    });
    const r = await setSuggestedWait(wait, 'agent_ops');
    expect(r.ok).toBe(true);
    expect(rpcMock).toHaveBeenCalledTimes(1);
    expect(rpcMock).toHaveBeenCalledWith('pipeline_set_waiting', {
      p_request_id: 'req-uuid-1',
      p_desk: 'agent_ops',
      p_reason_code: 'NO_RECEIVER',
      p_owner_kind: 'desk_lead',
      p_hours: 48,
      p_note: 'find a receiving agent',
      p_rule_id: 'AO-5',
      p_owner_user_id: null,
    });
  });
});
