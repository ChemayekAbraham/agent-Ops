/**
 * Server-side approval authorization for staff requisitions.
 *
 * Pure decision logic, so it can be dry-run without touching any row.
 * Seeing a requisition never grants authority: the caller must hold the role
 * that owns the current stage (from `user_roles`), and a CFO-stage approval
 * additionally requires `is_cfo_approver` — the existing production controls.
 */
export const NOT_AUTHORIZED_TO_APPROVE = "You are not authorized to approve requisitions.";

const OVERRIDE_ROLES = new Set(["super_admin", "manager"]);
const EXEC_OVERRIDE_ROLES = new Set(["ceo"]);
const SIX_EYES_ORDER = ["supervisor", "coo", "ceo", "cfo"];
const DECIDED_BY_COL: Record<string, string> = {
  supervisor: "supervisor_decided_by",
  coo: "coo_decided_by",
  ceo: "ceo_decided_by",
  cfo: "cfo_decided_by",
};
const STAGE_LABEL: Record<string, string> = {
  supervisor: "department head",
  coo: "COO",
  ceo: "CEO",
  cfo: "CFO",
};

export type ApprovalAuthInput = {
  // deno-lint-ignore no-explicit-any
  row: Record<string, any>;
  actorId: string;
  roles: string[];
  action: "approve" | "reject" | "return_info";
  /** Result of public.is_cfo_approver(actorId); only consulted at the CFO stage. */
  isCfoApprover: boolean;
};

export type ApprovalAuthResult =
  | { allowed: true; execOverride: boolean }
  | { allowed: false; error: string; message: string };

export function authorizeStaffRequisitionDecision(i: ApprovalAuthInput): ApprovalAuthResult {
  const { row, actorId, roles, action } = i;
  const approving = action === "approve";
  const isSixEyes = String(row.request_kind ?? "requisition") === "requisition";
  const holdsStageRole = roles.includes(row.current_approver_role);
  const hasOverride = roles.some((r) => OVERRIDE_ROLES.has(r) || EXEC_OVERRIDE_ROLES.has(r));
  const execOverride = !(isSixEyes && approving) && roles.some((r) => EXEC_OVERRIDE_ROLES.has(r));
  const ownsStage = holdsStageRole || (hasOverride && !(isSixEyes && approving));

  if (!ownsStage) {
    return {
      allowed: false,
      error: "forbidden",
      message: approving ? NOT_AUTHORIZED_TO_APPROVE : `This requisition is with ${row.current_approver_role}.`,
    };
  }
  if (row.requester_id === actorId && (isSixEyes || !roles.some((r) => OVERRIDE_ROLES.has(r)))) {
    return { allowed: false, error: "self_approval_blocked", message: "You cannot decide your own requisition." };
  }
  if (isSixEyes && approving) {
    const prior = SIX_EYES_ORDER.slice(0, SIX_EYES_ORDER.indexOf(row.stage));
    const signed = prior.find((s) => row[DECIDED_BY_COL[s]] === actorId);
    if (signed) {
      return {
        allowed: false,
        error: "same_approver_blocked",
        message: `You already approved this requisition at ${STAGE_LABEL[signed] ?? signed} review. The ${STAGE_LABEL[row.stage] ?? row.stage} approval must come from a different person.`,
      };
    }
  }
  if (row.current_approver_role === "cfo" && !execOverride && !i.isCfoApprover) {
    return {
      allowed: false,
      error: "forbidden",
      message: approving ? NOT_AUTHORIZED_TO_APPROVE : "This request could not be completed.",
    };
  }
  return { allowed: true, execOverride };
}
