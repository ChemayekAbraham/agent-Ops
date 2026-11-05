import { useQuery } from '@tanstack/react-query';
import { rpc } from './reviewApi';
import { runMove, type MoveResult } from './deskActions';
import type { CheckEntry, Decision, Stage } from './reviewTypes';

/**
 * `pipeline_desk_board(p_stage, p_limit)` — the "Ready for your push" board.
 *
 * The server has already run the desk's rules on every row: `decision` is what
 * it would do, `why` says why, and `push` is the exact review the drawer would
 * record for that decision. A push here is the drawer's two calls with those
 * values, nothing more.
 */

export type BoardDecision = 'pass' | 'transfer' | 'send_back' | 'reject' | 'wait' | 'waiting';

export type BoardFlag = { code: string; label: string; level: 'hard' | 'soft' | 'info'; ok: boolean; detail: string | null };

export type BoardPush = {
  decision: Decision;
  results: CheckEntry[];
  reason_code: string | null;
  note: string | null;
  target_agent_id: string | null;
};

export type WaitSuggest = { reason_code: string; owner_kind: string; hours: number; rule_id: string | null; note: string | null };

/** The live wait on a row whose decision is 'waiting' (same fields as pipeline_waiting_list). */
export type BoardWaiting = {
  reason_code?: string | null;
  owner_kind?: string | null;
  owner_name?: string | null;
  until_at?: string | null;
  hours_left?: number | null;
  expired?: boolean | null;
  note?: string | null;
};

export type BoardRow = {
  id: string;
  req: string;
  tenant: string | null;
  tenant_id: string | null;
  tenant_phone: string | null;
  agent_id: string | null;
  agent: string | null;
  agent_phone: string | null;
  agent_grade: string | null;
  agent_grade_week_ago: string | null;
  agent_flags: string[];
  landlord: string | null;
  landlord_phone: string | null;
  rent: number | null;
  days_here: number | null;
  rating: number | null;
  flags: { passes: number; total: number; hard_fail: boolean; soft_fail: boolean; failing: string[]; notes: string[]; flags: BoardFlag[] };
  decision: BoardDecision;
  rule_id: string | null;
  why: string | null;
  receiver: { agent_id: string; name: string | null; grade: string | null; km: number | null; score: number | null } | null;
  waiting: BoardWaiting | null;
  wait_suggest: WaitSuggest | null;
  push: BoardPush | null;
  call: { answered_since_stage: string | null; attempts_24h: number | null } | null;
};

export type Board = {
  stage: Stage;
  can_act: boolean;
  staff_ref: string | null;
  sc_only: boolean;
  counts: Partial<Record<BoardDecision, number>>;
  rows: BoardRow[];
};

export const BOARD_LIMIT = 150;

export const boardKey = (stage: Stage) => ['desk-feed', 'board', stage];

export async function loadBoard(stage: Stage): Promise<Board> {
  const { data, error } = await rpc('pipeline_desk_board', { p_stage: stage, p_limit: BOARD_LIMIT });
  if (error) throw error;
  const b = (data ?? {}) as Partial<Board>;
  return {
    stage,
    can_act: b.can_act === true,
    staff_ref: b.staff_ref ?? null,
    sc_only: b.sc_only === true,
    counts: b.counts ?? {},
    rows: Array.isArray(b.rows) ? b.rows : [],
  };
}

export function useDeskBoard(stage: Stage, enabled = true) {
  return useQuery({
    queryKey: boardKey(stage),
    enabled,
    queryFn: () => loadBoard(stage),
    refetchInterval: 60_000,
    staleTime: 20_000,
    retry: 1,
  });
}

/* ───────────────────────── one push ───────────────────────── */

export type PushOutcome =
  | { kind: 'moved'; message: string }
  /** The review is in; only the move failed. Retry the move, never the review. */
  | { kind: 'move_failed'; message: string }
  | { kind: 'review_failed'; message: string };

/** The move half of a push, with the push's own values — also the "retry the move only" path. */
export function moveFor(row: BoardRow, stage: Stage, userId: string): Promise<MoveResult> {
  const p = row.push as BoardPush;
  return runMove({
    requestId: row.id,
    stage,
    decision: p.decision,
    userId,
    note: p.note ?? '',
    targetAgentId: p.target_agent_id,
    reasonCode: p.reason_code,
  });
}

/** Exactly what the drawer does: record the review, then run the move. */
export async function pushRow(row: BoardRow, stage: Stage, userId: string): Promise<PushOutcome> {
  const p = row.push;
  if (!p) return { kind: 'review_failed', message: 'Nothing to push on this row.' };
  const { error } = await rpc('pipeline_record_review', {
    p_request_id: row.id,
    p_stage: stage,
    p_results: p.results,
    p_decision: p.decision,
    p_reason_code: p.reason_code,
    p_note: p.note,
    p_target_agent_id: p.decision === 'transfer' ? p.target_agent_id : null,
  });
  if (error) return { kind: 'review_failed', message: error.message };
  const moved = await moveFor(row, stage, userId);
  return moved.ok ? { kind: 'moved', message: moved.message } : { kind: 'move_failed', message: moved.message };
}

/** The suggested wait, set as `pipeline_set_waiting` takes it. Never a move. */
export async function setSuggestedWait(row: BoardRow, stage: Stage): Promise<{ ok: boolean; message: string }> {
  const w = row.wait_suggest;
  if (!w) return { ok: false, message: 'No wait is suggested for this row.' };
  const { error } = await rpc('pipeline_set_waiting', {
    p_request_id: row.id,
    p_desk: stage,
    p_reason_code: w.reason_code,
    p_owner_kind: w.owner_kind,
    p_hours: w.hours,
    p_note: w.note,
    p_rule_id: w.rule_id,
    p_owner_user_id: null,
  });
  return error ? { ok: false, message: error.message } : { ok: true, message: `Waiting ${w.hours} h.` };
}

/* ───────────────────────── reading a row ───────────────────────── */

/** The groups "Push all" works on. */
export const PUSHABLE: BoardDecision[] = ['pass', 'transfer', 'send_back', 'reject'];

export const GROUP_ORDER: BoardDecision[] = ['pass', 'transfer', 'send_back', 'reject', 'wait', 'waiting'];

export const GROUP_LABEL: Record<BoardDecision, string> = {
  pass: 'Pass',
  transfer: 'Transfer',
  send_back: 'Send back',
  reject: 'Reject',
  wait: 'Wait',
  waiting: 'Waiting',
};

/** "5/5 ✓", or "4/5 — <first failing label>". */
export function flagsChip(f: BoardRow['flags']): { text: string; ok: boolean } {
  if (f.passes >= f.total) return { text: `${f.passes}/${f.total} ✓`, ok: true };
  const first = f.flags.find((x) => !x.ok && x.level !== 'info') ?? f.flags.find((x) => !x.ok);
  const label = first?.label ?? f.failing[0] ?? 'a check failed';
  return { text: `${f.passes}/${f.total} — ${label}`, ok: false };
}

const GRADE_RANK: Record<string, number> = { A: 4, B: 3, C: 2, D: 1 };

/** Up when the agent's grade improved on a week ago; null when there is nothing to compare. */
export function gradeTrend(now: string | null, weekAgo: string | null): 'up' | 'down' | 'same' | null {
  if (!now || !weekAgo) return null;
  const a = GRADE_RANK[now];
  const b = GRADE_RANK[weekAgo];
  if (a === undefined || b === undefined) return null;
  return a > b ? 'up' : a < b ? 'down' : 'same';
}

const OWNER_WORDS: Record<string, string> = {
  agent: 'the agent',
  tenant: 'the tenant',
  landlord: 'the landlord',
  coo: 'the COO',
  cfo: 'the CFO',
  funder: 'the funder',
  other: 'someone else',
};

const STAGE_LEAD: Record<Stage, string> = {
  service_centre: 'Service Centre lead',
  agent_ops: 'Agent Ops lead',
  tenant_ops: 'Tenant Ops lead',
  landlord_ops: 'Landlord Ops lead',
  partner_ops: 'Partner Ops lead',
  coo: 'COO',
};

export function ownerWords(kind: string | null | undefined, stage: Stage, name?: string | null): string {
  if (name) return name;
  if (kind === 'desk_lead') return STAGE_LEAD[stage];
  return OWNER_WORDS[kind ?? ''] ?? (kind || 'someone');
}

/** The primary button's words for a row, or null when the row has no button (waiting). */
export function primaryLabel(row: BoardRow, stage: Stage): string | null {
  switch (row.decision) {
    case 'pass':
      return 'Pass';
    case 'send_back':
      return 'Send back';
    case 'reject':
      return 'Reject';
    case 'transfer': {
      const r = row.receiver;
      if (!r) return 'Transfer';
      const bits = [r.grade, r.km === null || r.km === undefined ? null : `${Number(r.km).toFixed(1)} km`].filter(Boolean).join(', ');
      return `Transfer → ${r.name ?? 'agent'}${bits ? ` (${bits})` : ''}`;
    }
    case 'wait': {
      const w = row.wait_suggest;
      return w ? `Wait ${w.hours} h on ${ownerWords(w.owner_kind, stage)}` : 'Wait';
    }
    default:
      return null;
  }
}
