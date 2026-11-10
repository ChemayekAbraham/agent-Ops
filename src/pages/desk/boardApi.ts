import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { rpc } from './reviewApi';
import { runMove, type MoveResult } from './deskActions';
import { SEND_BACK_STAGES, SUGGESTED_OFFICE, sendBackTo } from './sendBackApi';
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
  | 'call_again'
  /** Agent Ops: the house photos need a reviewer before the request can move. */
  | 'review_photos';

/** Agent Ops: whether the agent may collect on a new plan (collected 50%+ of what was due, or a new agent under the limit). */
export type Eligibility = {
  eligible: boolean;
  /** Whole percentage, 0-100, of what was due that the agent collected. */
  pct: number | null;
  /** True for an agent too new to have a collection record. */
  new: boolean;
  /** Open requests the agent holds (a new agent may hold up to NEW_AGENT_LIMIT). */
  open: number | null;
};

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
  receiver: { agent_id: string; name: string | null; grade: string | null; km: number | null; score: number | null; pct?: number | null } | null;
  waiting: BoardWaiting | null;
  wait_suggest: WaitSuggest | null;
  push: BoardPush | null;
  call: { answered_since_stage: string | null; attempts_24h: number | null } | null;
  /** Service Centre: the request is from the August 2026 batch. */
  batch?: boolean;
  /** Agent Ops: the agent's collection eligibility. */
  eligibility?: Eligibility | null;
  /** Agent Ops: intake items the agent did not send (family size, work, LC1 confirmation...). */
  items_missing?: string[] | null;
  /** Agent Ops: the house photos have been reviewed and pass. */
  photos_ok?: boolean | null;
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

/**
 * A transfer to an agent the reviewer picked instead of the suggested one.
 * Same review and same move; only the target and the note differ.
 */
export type PushOverride = { targetAgentId: string; note: string };

/** The push values with any override applied. */
export function effectivePush(row: BoardRow, override?: PushOverride): BoardPush | null {
  const p = row.push;
  if (!p) return null;
  if (!override) return p;
  return { ...p, decision: 'transfer', target_agent_id: override.targetAgentId, note: override.note };
}

/** The move half of a push, with the push's own values — also the "retry the move only" path. */
export function moveFor(row: BoardRow, stage: Stage, userId: string, override?: PushOverride): Promise<MoveResult> {
  const p = effectivePush(row, override) as BoardPush;
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

/** True when this push is a send-back that goes through `pipeline_send_back_to` (E63). */
export function isSendBackPush(p: Pick<BoardPush, 'decision'> | null | undefined, stage: Stage): boolean {
  return p?.decision === 'send_back' && SEND_BACK_STAGES.has(stage);
}

/**
 * Exactly what the drawer does: record the review, then run the move.
 *
 * A send-back at Agent / Tenant / Landlord Ops or the COO is one server call,
 * `pipeline_send_back_to`, to the field agent with the server's reason code
 * and note (E63) — it records the review and moves the request together, so
 * it never leaves a review without a move.
 */
export async function pushRow(row: BoardRow, stage: Stage, userId: string, override?: PushOverride): Promise<PushOutcome> {
  const p = effectivePush(row, override);
  if (!p) return { kind: 'review_failed', message: 'Nothing to push on this row.' };
  if (isSendBackPush(p, stage)) {
    const out = await sendBackTo({ requestId: row.id, stage, to: SUGGESTED_OFFICE, reasonCode: p.reason_code, note: p.note });
    return out.ok ? { kind: 'moved', message: out.message } : { kind: 'review_failed', message: out.message };
  }
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
  const moved = await moveFor(row, stage, userId, override);
  return moved.ok ? { kind: 'moved', message: moved.message } : { kind: 'move_failed', message: moved.message };
}

/** The suggested wait, set as `pipeline_set_waiting` takes it. Never a move. */
export async function setSuggestedWait(row: BoardRow, stage: Stage): Promise<{ ok: boolean; message: string }> {
  return setWait(row.id, stage, row.wait_suggest);
}

/** Set a server-suggested wait on a request — from the board, or from the drawer's "Wait 24 h on agent". */
export async function setWait(requestId: string, stage: Stage, w: WaitSuggest | null | undefined): Promise<{ ok: boolean; message: string }> {
  if (!w) return { ok: false, message: 'No wait is suggested for this row.' };
  const { error } = await rpc('pipeline_set_waiting', {
    p_request_id: requestId,
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
  agent_ops: ['pass', 'transfer', 'complete', 'review_photos', 'send_back', 'reject', 'wait', 'waiting'],
  tenant_ops: ['call', 'complete', 'pass', 'call_again', 'reject', 'waiting'],
  landlord_ops: ['call', 'complete', 'pass', 'call_again', 'reject', 'waiting'],
};

export const GROUP_ORDER: BoardDecision[] = STAGE_GROUPS.agent_ops as BoardDecision[];

export function groupsFor(stage: Stage): BoardDecision[] {
  return STAGE_GROUPS[stage] ?? GROUP_ORDER;
}

/** Decisions whose button opens the drawer instead of pushing: the reviewer has work to do first. */
export function opensDrawer(d: BoardDecision): boolean {
  return d === 'complete' || d === 'call' || d === 'review_photos';
}

/** What the drawer opens on, for a decision that opens it. */
export function drawerStartFor(d: BoardDecision): 'call' | 'complete' | 'photos' | undefined {
  if (d === 'call') return 'call';
  if (d === 'complete') return 'complete';
  if (d === 'review_photos') return 'photos';
  return undefined;
}

/** A new agent may hold this many open requests before they stop being eligible. */
export const NEW_AGENT_LIMIT = 3;

/** "62% collected ✓", red "31% — below 50%", or "New agent · 2 open (limit 3)". */
export function eligibilityChip(e: Eligibility | null | undefined): { text: string; tone: 'ok' | 'bad' | 'idle' } | null {
  if (!e) return null;
  if (e.new) {
    const open = Number(e.open ?? 0);
    return { text: `New agent · ${open} open (limit ${NEW_AGENT_LIMIT})`, tone: e.eligible ? 'idle' : 'bad' };
  }
  if (e.pct === null || e.pct === undefined) return { text: 'No collection record', tone: 'idle' };
  const p = Math.round(Number(e.pct));
  return e.eligible ? { text: `${p}% collected ✓`, tone: 'ok' } : { text: `${p}% — below 50%`, tone: 'bad' };
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
  review_photos: 'Review photos',
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
      // Tenant Ops' pass sends the request on to Landlord Ops; same push as any pass.
      return stage === 'tenant_ops' ? 'Forward to Landlord Ops' : stage === 'landlord_ops' ? 'Forward to COO' : 'Pass';
    case 'send_back':
      return 'Send back';
    case 'reject':
      return 'Reject';
    case 'call_again':
      return 'Call again';
    case 'call':
      return stage === 'landlord_ops' ? 'Call landlord' : 'Call tenant';
    case 'complete':
      return stage === 'service_centre' || stage === 'agent_ops' ? 'Call and fill' : 'Finish checks';
    case 'review_photos':
      return 'Review photos';
    case 'transfer': {
      const r = row.receiver;
      if (!r) return 'Transfer';
      // The receiver's collection rate when the board sends it; its grade otherwise.
      const first = r.pct !== null && r.pct !== undefined ? `${Math.round(Number(r.pct))}%` : r.grade;
      const bits = [first, r.km === null || r.km === undefined ? null : `${Number(r.km).toFixed(1)} km`].filter(Boolean).join(', ');
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
