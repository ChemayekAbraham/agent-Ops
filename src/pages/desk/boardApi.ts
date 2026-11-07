import { keepPreviousData, useQuery } from '@tanstack/react-query';
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

export type BoardDecision =
  | 'pass'
  | 'transfer'
  | 'send_back'
  | 'reject'
  | 'wait'
  | 'waiting'
  /** Service Centre: items missing — call and fill them in the drawer. Tenant/Landlord Ops: checks left to finish. */
  | 'complete'
  /** Tenant/Landlord Ops: no answered call yet — call first. */
  | 'call'
  | 'call_again';

export type BoardFlag = { code: string; label: string; level: 'hard' | 'soft' | 'info'; ok: boolean; detail: string | null };

export type BoardPush = {
  decision: Decision;
  results: CheckEntry[];
  reason_code: string | null;
  note: string | null;
  target_agent_id: string | null;
};

export type WaitSuggest = { reason_code: string; owner_kind: string; hours: number; rule_id: string | null; note: string | null };

/**
 * The live wait on a row whose decision is 'waiting'. Unlike pipeline_waiting_list
 * rows it carries no owner_name or hours_left: time left is worked out from until_at.
 */
export type BoardWaiting = {
  reason_code: string;
  owner_kind: string;
  until_at: string;
  expired: boolean;
  note: string | null;
  rule_id: string | null;
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
  /** Service Centre: the request is from the August 2026 batch. */
  batch?: boolean;
};

/** Service Centre only: which requests the board shows. Other stages ignore it. */
export type BoardScope = 'new' | 'batch' | 'all';

export type Board = {
  stage: Stage;
  can_act: boolean;
  staff_ref: string | null;
  sc_only: boolean;
  counts: Partial<Record<BoardDecision, number>>;
  rows: BoardRow[];
  /** Service Centre: the scope the server applied, and how many requests each scope holds. */
  scope: BoardScope;
  scope_counts: { new: number | null; batch: number | null } | null;
};

export const BOARD_LIMIT = 150;
/** The Service Centre carries the August batch, so it reads more rows at once. */
export const SC_BOARD_LIMIT = 300;

export const boardLimit = (stage: Stage) => (stage === 'service_centre' ? SC_BOARD_LIMIT : BOARD_LIMIT);

export const boardKey = (stage: Stage, scope?: BoardScope) =>
  stage === 'service_centre' ? ['desk-feed', 'board', stage, scope ?? 'new'] : ['desk-feed', 'board', stage];

/** The RPC arguments: `p_scope` only on the Service Centre, where it means something. */
export function boardArgs(stage: Stage, scope?: BoardScope): Record<string, unknown> {
  const args: Record<string, unknown> = { p_stage: stage, p_limit: boardLimit(stage) };
  if (stage === 'service_centre') args.p_scope = scope ?? 'new';
  return args;
}

export async function loadBoard(stage: Stage, scope?: BoardScope): Promise<Board> {
  const { data, error } = await rpc('pipeline_desk_board', boardArgs(stage, scope));
  if (error) throw error;
  const b = (data ?? {}) as Partial<Board>;
  return {
    stage,
    can_act: b.can_act === true,
    staff_ref: b.staff_ref ?? null,
    sc_only: b.sc_only === true,
    counts: b.counts ?? {},
    rows: Array.isArray(b.rows) ? b.rows : [],
    scope: b.scope ?? scope ?? 'new',
    scope_counts: b.scope_counts ?? null,
  };
}

/** "New (213) · August batch (3,580) · All" — the switch's labels, from scope_counts. */
export function scopeLabels(counts: Board['scope_counts']): Record<BoardScope, string> {
  const n = (v: number | null | undefined) => (v === null || v === undefined ? '' : ` (${Number(v).toLocaleString('en')})`);
  return { new: `New${n(counts?.new)}`, batch: `August batch${n(counts?.batch)}`, all: 'All' };
}

/** How many requests the current scope holds, for "Showing 300 of 3,580". Null when unknown. */
export function scopeTotal(scope: BoardScope, counts: Board['scope_counts']): number | null {
  if (!counts) return null;
  if (scope === 'new') return counts.new ?? null;
  if (scope === 'batch') return counts.batch ?? null;
  return counts.new === null || counts.batch === null ? null : Number(counts.new) + Number(counts.batch);
}

export function useDeskBoard(stage: Stage, enabled = true, scope?: BoardScope) {
  return useQuery({
    queryKey: boardKey(stage, scope),
    enabled,
    queryFn: () => loadBoard(stage, scope),
    // Switching scope keeps the last board on screen (switch included) until the new one arrives.
    placeholderData: keepPreviousData,
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

/** The decision groups each board shows, in the order the desk works them. */
export const STAGE_GROUPS: Partial<Record<Stage, BoardDecision[]>> = {
  service_centre: ['pass', 'send_back', 'complete', 'waiting'],
  agent_ops: ['pass', 'transfer', 'send_back', 'reject', 'wait', 'waiting'],
  tenant_ops: ['call', 'complete', 'pass', 'call_again', 'reject', 'waiting'],
  landlord_ops: ['call', 'complete', 'pass', 'call_again', 'reject', 'waiting'],
};

export const GROUP_ORDER: BoardDecision[] = STAGE_GROUPS.agent_ops as BoardDecision[];

export function groupsFor(stage: Stage): BoardDecision[] {
  return STAGE_GROUPS[stage] ?? GROUP_ORDER;
}

/** Decisions whose button opens the drawer instead of pushing: the reviewer has work to do first. */
export function opensDrawer(d: BoardDecision): boolean {
  return d === 'complete' || d === 'call';
}

/** "3 tries today", or null when nobody has tried in 24 hours. */
export function triesToday(call: BoardRow['call']): string | null {
  const n = call?.attempts_24h ?? 0;
  if (!n || n <= 0) return null;
  return n === 1 ? '1 try today' : `${n} tries today`;
}

export const GROUP_LABEL: Record<BoardDecision, string> = {
  pass: 'Pass',
  transfer: 'Transfer',
  send_back: 'Send back',
  reject: 'Reject',
  wait: 'Wait',
  waiting: 'Waiting',
  complete: 'Complete',
  call: 'Call',
  call_again: 'Call again',
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

/** Hours until `until_at` (negative once past), or null when it cannot be read. */
export function hoursUntil(untilAt: string | null | undefined, now = Date.now()): number | null {
  if (!untilAt) return null;
  const t = Date.parse(untilAt);
  return Number.isNaN(t) ? null : (t - now) / 3_600_000;
}

const OWNER_LABEL: Record<string, string> = {
  agent: 'Agent',
  tenant: 'Tenant',
  landlord: 'Landlord',
  coo: 'COO',
  cfo: 'CFO',
  funder: 'Funder',
  other: 'Other',
};

/** owner_kind as a label: desk_lead → "Agent Ops lead" (this desk's lead), other → "Other". */
export function ownerLabel(kind: string | null | undefined, stage: Stage): string {
  if (kind === 'desk_lead') return STAGE_LEAD[stage];
  return OWNER_LABEL[kind ?? ''] ?? (kind || 'Other');
}

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
    case 'call_again':
      return 'Call again';
    case 'call':
      return stage === 'landlord_ops' ? 'Call landlord' : 'Call tenant';
    case 'complete':
      return stage === 'service_centre' ? 'Call and fill' : 'Finish checks';
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
