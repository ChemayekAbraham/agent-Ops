import type { CooApprovalResult } from '@/lib/landlordFloatBudget';

/**
 * COO rent-request decisions go through `coo_decide_rent_requests`, which wraps the
 * existing approve/return functions and records, per request, what the system
 * recommended and whether the COO followed it. The server decides everything; this
 * file only handles the "REASON_REQUIRED" retry and reshapes the response.
 */

export type CooDecision = 'approve' | 'return';

export interface CooDecideItem {
  id: string;
  ok: boolean;
  followed?: boolean | null;
  recommended?: string | null;
  system_reason?: string | null;
  result?: unknown;
  error?: string | null;
}

export interface CooDecideResponse {
  decision: CooDecision;
  done: number;
  not_followed: number;
  items: CooDecideItem[];
}

export type ReasonAnswer = { code: string; text?: string } | null;
export type AskReason = (opts: { needsText: boolean; code?: string; message: string }) => Promise<ReasonAnswer>;

type RpcCall = (
  fn: 'coo_decide_rent_requests',
  args: Record<string, unknown>,
) => PromiseLike<{ data: unknown; error: { message: string } | null }>;

export class CooDecisionCancelled extends Error {
  constructor() {
    super('Cancelled — nothing was changed.');
    this.name = 'CooDecisionCancelled';
  }
}

/** What a coo_decide_rent_requests error asks for, if anything. */
export function classifyCooDecideError(message: string | null | undefined): 'reason_required' | 'needs_text' | null {
  const m = (message ?? '').trim();
  if (/needs a short explanation/i.test(m)) return 'needs_text';
  if (m.startsWith('REASON_REQUIRED')) return 'reason_required';
  return null;
}

export interface CooDecideOutcome {
  response: CooDecideResponse;
  reasonCode: string | null;
  reasonText: string | null;
}

/**
 * Call once without a reason. Only when the server says the COO went against the
 * system is `askReason` used, then the call is repeated with the chosen code.
 */
export async function cooDecide(
  call: RpcCall,
  input: { ids: string[]; decision: CooDecision; reasonCode?: string | null; reasonText?: string | null },
  askReason?: AskReason,
): Promise<CooDecideOutcome> {
  let code = input.reasonCode?.trim() || null;
  let text = input.reasonText?.trim() || null;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const args: Record<string, unknown> = { p_request_ids: input.ids, p_decision: input.decision };
    if (code) args.p_reason_code = code;
    if (text) args.p_reason_text = text;
    const { data, error } = await call('coo_decide_rent_requests', args);
    if (!error) return { response: normalizeResponse(data, input.decision), reasonCode: code, reasonText: text };
    const kind = classifyCooDecideError(error.message);
    if (!kind || !askReason) throw new Error(error.message);
    const answer = await askReason({ needsText: kind === 'needs_text', code: code ?? undefined, message: error.message });
    if (!answer?.code) throw new CooDecisionCancelled();
    code = answer.code;
    // For a return, the dialog's reason already rides in p_reason_text; keep it unless the picker gave one.
    text = answer.text?.trim() || text;
  }
  throw new Error('The decision could not be recorded — try again.');
}

export function normalizeResponse(data: unknown, decision: CooDecision): CooDecideResponse {
  const d = (data ?? {}) as Partial<CooDecideResponse>;
  const items = Array.isArray(d.items) ? d.items : [];
  return {
    decision: (d.decision as CooDecision) ?? decision,
    done: Number(d.done ?? items.filter((i) => i.ok).length),
    not_followed: Number(d.not_followed ?? items.filter((i) => i.followed === false).length),
    items,
  };
}

/** Rebuild the familiar coo_approve_rent_requests shape from the per-item results. */
export function mergeApproveResults(res: CooDecideResponse): CooApprovalResult {
  const out: CooApprovalResult = {
    approved: [],
    over_cap: [],
    skipped: [],
    approved_total: 0,
    room_left: 0,
    status: undefined as unknown as CooApprovalResult['status'],
  };
  const seen = { approved: new Set<string>(), over_cap: new Set<string>(), skipped: new Set<string>() };
  for (const item of res.items) {
    const r = item.result as Partial<CooApprovalResult> | undefined;
    if (!item.ok || !r) {
      if (!seen.skipped.has(item.id)) {
        seen.skipped.add(item.id);
        out.skipped.push({ id: item.id, reason: 'error', message: item.error || 'Not approved.' });
      }
      continue;
    }
    for (const a of r.approved ?? []) if (!seen.approved.has(a.id)) { seen.approved.add(a.id); out.approved.push(a); out.approved_total += Number(a.rent_amount) || 0; }
    for (const o of r.over_cap ?? []) if (!seen.over_cap.has(o.id)) { seen.over_cap.add(o.id); out.over_cap.push(o); }
    for (const s of r.skipped ?? []) {
      const key = s.id ?? `${s.reason}:${s.message ?? ''}`;
      if (!seen.skipped.has(key)) { seen.skipped.add(key); out.skipped.push(s); }
    }
    if (r.room_left !== undefined) out.room_left = Number(r.room_left);
    if (r.status) out.status = r.status;
  }
  return out;
}

/** "N done, M against the system (reason: <meaning>)". */
export function cooDecisionSummary(res: CooDecideResponse, reasonMeaning?: string | null): string {
  const base = `${res.done} done, ${res.not_followed} against the system`;
  return res.not_followed > 0 && reasonMeaning ? `${base} (reason: ${reasonMeaning})` : base;
}
