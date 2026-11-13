/**
 * The review sheet (E26) as the desks read it.
 *
 * Shapes follow `pipeline_review_sheet(p_request_id)` exactly; the pipeline RPCs
 * are not in the generated Supabase types yet, so everything here is hand-typed
 * and the calls go through the cast helper in `reviewApi.ts`.
 */

export type Stage = 'service_centre' | 'agent_ops' | 'tenant_ops' | 'landlord_ops' | 'partner_ops' | 'coo';

export type Decision =
  | 'pass'
  | 'send_back'
  | 'reject'
  | 'transfer'
  | 'call_again'
  | 'attach_funder'
  | 'to_coo_bucket'
  | 'fund'
  | 'hold';

/** The status a request carries while it waits at each desk. */
export const STAGE_STATUS: Record<Stage, string> = {
  service_centre: 'service_center_review',
  agent_ops: 'pending',
  tenant_ops: 'agent_ops_approved',
  landlord_ops: 'tenant_ops_approved',
  partner_ops: 'landlord_ops_approved',
  coo: 'partner_ops_approved',
};

/** Desk id (the URL segment) to the pipeline stage it reviews. Desks not listed have no checklist. */
export const DESK_STAGE: Record<string, Stage> = {
  'service-centre': 'service_centre',
  'agent-ops': 'agent_ops',
  'tenant-ops': 'tenant_ops',
  'landlord-ops': 'landlord_ops',
  'partner-ops': 'partner_ops',
  coo: 'coo',
};

/** Mirrors the allow-list inside pipeline_record_review — the server rejects anything else. */
export const STAGE_DECISIONS: Record<Stage, Decision[]> = {
  service_centre: ['pass', 'send_back', 'reject'],
  agent_ops: ['pass', 'send_back', 'reject', 'transfer'],
  tenant_ops: ['pass', 'call_again', 'send_back', 'reject'],
  landlord_ops: ['pass', 'call_again', 'send_back', 'reject'],
  partner_ops: ['attach_funder', 'to_coo_bucket', 'send_back'],
  coo: ['fund', 'hold', 'send_back'],
};

/**
 * Decisions the desks no longer offer, though the server still accepts them.
 * `reject` became "Send back" to the agent in the field (E64), which rejects
 * through `pipeline_send_back_to` with an office and a reason on record.
 * Older ones:
 * `fund` was the COO's budget path (retired 5 Nov — the COO pushes top N to
 * the funders instead); `attach_funder` and `to_coo_bucket` were Partner Ops'.
 */
export const HIDDEN_DECISIONS: Decision[] = ['fund', 'attach_funder', 'to_coo_bucket', 'reject'];

/** The decisions a desk's drawer and board menus offer. */
export function visibleDecisions(stage: Stage): Decision[] {
  return STAGE_DECISIONS[stage].filter((d) => !HIDDEN_DECISIONS.includes(d));
}

/** What each decision is called on screen, per desk — the same word must not mean two things. */
export const DECISION_LABEL: Record<Decision, string> = {
  pass: 'Pass',
  send_back: 'Send back',
  reject: 'Reject',
  transfer: 'Transfer to another agent',
  call_again: 'Call again',
  attach_funder: 'Attach funder and forward',
  to_coo_bucket: 'Send to the COO bucket',
  fund: 'Fund',
  hold: 'Hold',
};

export const DECISION_HELP: Partial<Record<Decision, string>> = {
  send_back: 'Returnsthe request to the agent to correct and resend.',
  call_again: 'Keeps the request here. Log the attempt first.',
  to_coo_bucket: 'Forwards to the COO without a proxy partner — not published to the Funder dashboard.',
  hold: 'Leaves the request in the COO queue for a later decision.',
};

export type CheckResult = 'pass' | 'fail' | 'na';
export type ValueKind = 'number' | 'text' | 'amount' | null;

export type ChecklistItem = {
  code: string;
  stage: Stage;
  label: string;
  question: string;
  method: string;
  weight: number;
  required: boolean;
  on_fail: string;
  value_kind: ValueKind;
  assumption: string | null;
  system_said: string | null;
  system_detail: string | null;
  last: { result: CheckResult; value: unknown; note: string | null; at: string; by: string | null } | null;
};

export type ReviewSheet = {
  request: {
    id: string;
    status: string;
    stage: Stage | null;
    round: number;
    rent_amount: number | null;
    duration_days: number | null;
    created_at: string;
    tenant: { id: string; name: string | null; phone: string | null; occupation: string | null } | null;
    agent: { id: string; name: string | null; phone: string | null } | null;
    landlord: { id: string; name: string | null; phone: string | null; verified: boolean | null } | null;
    lc1: { name: string | null } | null;
    lc_letter: { bucket: string | null; path: string } | null;
    house_photos: string[];
    gps: { lat: number; lng: number } | null;
    funder_visible: boolean;
  };
  checklist: ChecklistItem[];
  history: {
    stage: Stage;
    decision: Decision;
    recommended: Decision | null;
    followed: boolean | null;
    reason_code: string | null;
    note: string | null;
    failed: string[] | null;
    by: string | null;
    staff_ref: string | null;
    at: string;
  }[];
  score: { score?: number | null; confirmed_by_people_pct?: number | null; failed?: unknown } | null;
  recommendation: { recommended: Decision | null; reason_code: string | null; failed: string[] | null } | null;
  can_review: boolean;
  my_staff_ref: string | null;
};

export type ReasonCode = { code: string; desks: string[] | null; meaning: string | null; requires_text: boolean };

export type SuggestedAgent = {
  agent_id: string;
  agent_name: string | null;
  agent_phone: string | null;
  km: number | null;
  in_window_pct: number | null;
  active_tenants: number | null;
  week_start: string | null;
};

/** The result the drawer submits: one entry per checklist item the reviewer touched. */
export type CheckEntry = { code: string; result: CheckResult; value?: unknown; note?: string };
