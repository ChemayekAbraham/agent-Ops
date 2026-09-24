import { createClient } from "npm:@supabase/supabase-js@2";
import { creditRequisitionWallet } from "../_shared/requisitionWalletCredit.ts";
import { sendSMS } from "../_shared/sendSmsMultiProvider.ts";
import { guardCfoApprover, cfoApproverDenied, isCfoApprover } from "../_shared/cfoApprovalGate.ts";
import { maySendRequisitionSms } from "../_shared/requisitionSmsPolicy.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const OVERRIDE_ROLES = new Set(["super_admin", "manager"]);
/** Executive override: the CEO may approve or decline at any stage, including
 *  CFO stage, without being a designated CFO approver. Deciding your own
 *  requisition stays blocked for the CEO like everyone else.
 *  Ordinary requisitions are six-eyes (see below): there the overrides may
 *  only decline or send back, never approve. */
const EXEC_OVERRIDE_ROLES = new Set(["ceo"]);

/** Six-eyes: an ordinary requisition needs COO, CEO and CFO sign-off from three
 *  different people, in that order (after the department head, if any). The
 *  database guard staff_requisition_six_eyes_guard enforces the same rule. */
const SIX_EYES_NEXT: Record<string, string> = { supervisor: "coo", coo: "ceo", ceo: "cfo" };
const DECIDED_BY_COL: Record<string, string> = {
  supervisor: "supervisor_decided_by",
  coo: "coo_decided_by",
  ceo: "ceo_decided_by",
  cfo: "cfo_decided_by",
};
const SIX_EYES_ORDER = ["supervisor", "coo", "ceo", "cfo"];

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function fmtUGX(n: number) {
  return `UGX ${Math.round(n).toLocaleString("en-US")}`;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  try {
    const admin = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    const token = req.headers.get("Authorization")?.replace("Bearer ", "") ?? "";
    const { data: userData, error: authErr } = await admin.auth.getUser(token);
    if (authErr || !userData?.user) return json({ error: "Not authenticated" }, 401);
    const actor = userData.user;

    // Facilitation and staff-loan rows are protected by database guards that read
    // auth.uid() — a service-key write has no identity and is refused outright.
    // Those writes must go through a client carrying the approver's own session.
    const asActor = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_ANON_KEY")!,
      { global: { headers: { Authorization: `Bearer ${token}` } } },
    );
    const GATED_KINDS = new Set(["facilitation", "staff_loan"]);


    const body = await req.json().catch(() => ({}));
    const requisitionId = String(body.requisition_id || "");
    const action = String(body.action || "");
    const comment = String(body.comment || "").trim();
    if (!requisitionId || !["approve", "reject", "return_info"].includes(action)) {
      return json({ error: "bad_request" }, 400);
    }
    if (action !== "approve" && comment.length < 10) {
      return json({ error: "A comment of at least 10 characters is required" }, 400);
    }

    // High-stakes transition: always read the live row, never a cached one.
    const { data: row, error: rowErr } = await admin
      .from("staff_requisitions")
      .select("*")
      .eq("id", requisitionId)
      .maybeSingle();
    if (rowErr) throw rowErr;
    if (!row) return json({ error: "Requisition not found" }, 404);
    if (["approved", "rejected"].includes(row.stage)) {
      return json({ error: "already_final", message: `This requisition is already ${row.stage}.` }, 409);
    }
    if (row.stage === "returned") {
      return json({ error: "awaiting_requester", message: "This requisition is back with the requester." }, 409);
    }

    // Guarded kinds are written as the approver; ordinary requisitions stay on the
    // service-role client so existing behaviour is unchanged.
    const writer = GATED_KINDS.has(String(row.request_kind ?? "requisition")) ? asActor : admin;


    const { data: roleRows } = await admin
      .from("user_roles")
      .select("role")
      .eq("user_id", actor.id)
      .eq("enabled", true);
    const roles = (roleRows || []).map((r: { role: string }) => r.role);
    const isSixEyes = String(row.request_kind ?? "requisition") === "requisition";
    const holdsStageRole = roles.includes(row.current_approver_role);
    const hasOverride = roles.some((r: string) => OVERRIDE_ROLES.has(r))
      || roles.some((r: string) => EXEC_OVERRIDE_ROLES.has(r));
    // Six-eyes: overrides can stop money (decline / send back) at any stage,
    // but approving needs the stage's own role. Other kinds keep the old rule.
    const isExecOverride = !(isSixEyes && action === "approve")
      && roles.some((r: string) => EXEC_OVERRIDE_ROLES.has(r));
    const ownsStage = holdsStageRole || (hasOverride && !(isSixEyes && action === "approve"));
    if (!ownsStage) {
      return json({
        error: "forbidden",
        message: isSixEyes && action === "approve" && hasOverride
          ? `Only a ${String(row.current_approver_role).toUpperCase()} can approve at this stage. Every requisition needs COO, CEO and CFO sign-off from three different people.`
          : `This requisition is with ${row.current_approver_role}.`,
      }, 403);
    }
    if (row.requester_id === actor.id && (isSixEyes || !roles.some((r: string) => OVERRIDE_ROLES.has(r)))) {
      return json({ error: "self_approval_blocked", message: "You cannot decide your own requisition." }, 403);
    }

    // Six eyes means three different people: whoever signed an earlier stage
    // cannot sign this one too, even when they hold both roles.
    if (isSixEyes && action === "approve") {
      const priorStages = SIX_EYES_ORDER.slice(0, SIX_EYES_ORDER.indexOf(row.stage));
      const signedEarlier = priorStages.find((s) => row[DECIDED_BY_COL[s]] === actor.id);
      if (signedEarlier) {
        return json({
          error: "same_approver_blocked",
          message: `You already approved this requisition at ${stageLabel(signedEarlier)} review. The ${stageLabel(row.stage)} approval must come from a different person.`,
        }, 403);
      }
    }

    // CFO-stage decisions are restricted; refusal is deliberately non-disclosing.
    // The CEO's executive override passes this gate (except six-eyes approvals).
    if (row.current_approver_role === "cfo" && !isExecOverride && !(await isCfoApprover(admin, actor.id))) {
      return json({
        error: "forbidden",
        message: "This request could not be completed.",
      }, 403);
    }

    const { data: actorProfile } = await admin
      .from("profiles").select("full_name").eq("id", actor.id).maybeSingle();
    const actorName = actorProfile?.full_name || actor.email || "Approver";
    const now = new Date().toISOString();
    const stageKey = row.stage as "supervisor" | "coo" | "cfo" | "ceo";
    const decisionCols = stageKey === "supervisor"
      ? { supervisor_decided_by: actor.id, supervisor_decided_at: now, supervisor_note: comment || null }
      : stageKey === "coo"
      ? { coo_decided_by: actor.id, coo_decided_at: now, coo_note: comment || null }
      : stageKey === "ceo"
      ? { ceo_decided_by: actor.id, ceo_decided_at: now, ceo_note: comment || null }
      : { cfo_decided_by: actor.id, cfo_decided_at: now, cfo_note: comment || null };

    // ── Reject ───────────────────────────────────────────────────────────────
    if (action === "reject") {
      const { data: updated, error: upErr } = await writer
        .from("staff_requisitions")
        .update({
          ...decisionCols,
          stage: "rejected",
          current_approver_role: null,
          rejection_reason: comment,
          decided_at: now,
        })
        .eq("id", requisitionId)
        .eq("stage", stageKey)
        .select("*")
        .maybeSingle();
      if (upErr) return guardRefused(upErr);
      if (!updated) return stageMoved();
      await logEvent(admin, requisitionId, actor.id, actorName, "rejected", stageKey, comment, { amount: row.amount });
      await auditLog(admin, actor.id, requisitionId, "staff_requisition_rejected", comment);
      await setGrowthClaimStatus(admin, requisitionId, "rejected");
      await notifyRequester(admin, updated, `Requisition ${row.requisition_code} was declined at ${stageLabel(stageKey)} review: ${comment}`);
      return json({ ok: true, requisition: updated }, 200);
    }

    // ── Send back for more information ───────────────────────────────────────
    if (action === "return_info") {
      const { data: updated, error: upErr } = await writer
        .from("staff_requisitions")
        .update({
          ...decisionCols,
          stage: "returned",
          returned_from_stage: stageKey,
          current_approver_role: null,
        })
        .eq("id", requisitionId)
        .eq("stage", stageKey)
        .select("*")
        .maybeSingle();
      if (upErr) return guardRefused(upErr);
      if (!updated) return stageMoved();
      await logEvent(admin, requisitionId, actor.id, actorName, "returned", stageKey, comment, {});
      await auditLog(admin, actor.id, requisitionId, "staff_requisition_returned", comment);
      await notifyRequester(admin, updated, `Requisition ${row.requisition_code} needs more information: ${comment}`);
      return json({ ok: true, requisition: updated }, 200);
    }

    // ── Approve ──────────────────────────────────────────────────────────────
    let approvedAmount: number | null = null;
    if (body.amount != null) {
      const n = Math.round(Number(body.amount) * 100) / 100;
      if (!Number.isFinite(n) || n <= 0) return json({ error: "invalid_amount" }, 400);
      // Six-eyes: a later approver may lower the amount, never raise it above
      // what the earlier approvers saw.
      const ceiling = Number(row.approved_amount ?? row.amount);
      if (isSixEyes && n > ceiling) {
        return json({
          error: "amount_above_prior_approval",
          message: `You can lower this requisition but not raise it above ${fmtUGX(ceiling)}. To ask for more, send it back to the requester.`,
        }, 400);
      }
      approvedAmount = n;
    }

    const isFinalStage = isSixEyes ? stageKey === "cfo" : stageKey === row.final_stage;

    if (!isFinalStage) {
      const nextStage = isSixEyes
        ? SIX_EYES_NEXT[stageKey]
        : stageKey === "supervisor"
        ? "coo"
        : stageKey === "ceo" && row.final_stage === "cfo"
        ? "cfo"
        : row.final_stage;
      const { data: updated, error: upErr } = await writer
        .from("staff_requisitions")
        .update({
          ...decisionCols,
          stage: nextStage,
          current_approver_role: nextStage,
          ...(approvedAmount != null ? { approved_amount: approvedAmount } : {}),
        })
        .eq("id", requisitionId)
        .eq("stage", stageKey)
        .select("*")
        .maybeSingle();
      if (upErr) return guardRefused(upErr);
      if (!updated) return stageMoved();
      await logEvent(admin, requisitionId, actor.id, actorName, "approved", stageKey, comment, {
        next_stage: nextStage, approved_amount: approvedAmount,
      });
      await auditLog(admin, actor.id, requisitionId, "staff_requisition_stage_approved", comment || `Approved at ${stageKey}`);
      await notifyApprovers(admin, nextStage, updated);
      await notifyRequester(admin, updated, `Requisition ${row.requisition_code} passed ${stageLabel(stageKey)} review and is now with ${nextStage.toUpperCase()}.`);
      return json({ ok: true, requisition: updated }, 200);
    }

    // Final approval -> wallet credit (idempotent, ledger-backed)
    if (row.wallet_credit_status === "credited") {
      return json({ ok: true, already_credited: true, requisition: row }, 200);
    }

    const finalAmount = approvedAmount ?? Number(row.approved_amount ?? row.amount);

    const { data: approvedRow, error: apprErr } = await writer
      .from("staff_requisitions")
      .update({
        ...decisionCols,
        stage: "approved",
        current_approver_role: null,
        approved_amount: finalAmount,
        decided_at: now,
        rejection_reason: null,
      })
      .eq("id", requisitionId)
      .eq("stage", stageKey)
      .select("*")
      .maybeSingle();
    if (apprErr) return guardRefused(apprErr);
    if (!approvedRow) return stageMoved();

    const credit = await creditRequisitionWallet({
      admin,
      sourceTable: "staff_requisitions",
      requisitionId,
      requisitionCode: row.requisition_code,
      userId: row.requester_id,
      approverId: actor.id,
      approverName: actorName,
      amount: finalAmount,
      currency: row.currency || "UGX",
      purpose: row.title,
      category: row.category,
      status: "approved",
      approvedAt: now,
      ipAddress: req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null,
      deviceInfo: req.headers.get("user-agent") ?? null,
    });

    if (!credit.ok) {
      // No approved-but-uncredited limbo: roll the stage back to this approver.
      await writer
        .from("staff_requisitions")
        .update({
          stage: stageKey,
          current_approver_role: stageKey,
          decided_at: null,
          wallet_credit_status: "failed",
        })
        .eq("id", requisitionId);
      await logEvent(admin, requisitionId, actor.id, actorName, "credit_failed", stageKey, credit.message, {
        stage_detail: credit.stage, error: credit.error,
      });
      return json({ ok: false, error: credit.error, message: credit.message, rolled_back: true }, 400);
    }

    await logEvent(admin, requisitionId, actor.id, actorName, "credited", stageKey, comment || "Approved and credited", {
      amount: finalAmount, wallet_transaction_id: credit.wallet_transaction_id,
    });
    await auditLog(admin, actor.id, requisitionId, "staff_requisition_approved_credited", comment || `Credited ${fmtUGX(finalAmount)}`);
    // Growth commission claims: releasing the claim moves the counter baseline forward.
    await setGrowthClaimStatus(admin, requisitionId, "released", now);

    try {
      await admin.from("system_events").insert({
        event_type: "requisition.credited",
        payload: {
          source: "staff_requisitions",
          id: requisitionId,
          code: row.requisition_code,
          amount: finalAmount,
          wallet_transaction_id: credit.wallet_transaction_id,
        },
      });
    } catch (_) { /* non-fatal */ }

    return json({ ok: true, requisition: approvedRow, wallet_credit: credit }, 200);
  } catch (e) {
    console.error("staff-requisition-decide error", e);
    return json({ error: String((e as Error).message ?? e) }, 500);
  }
});

/** The database guards (six-eyes, staff-loan, facilitation) refuse with a
 *  readable message; surface it instead of a bare 500. */
function guardRefused(err: { message?: string }) {
  return json({ error: "refused", message: String(err?.message ?? err) }, 409);
}

/** Another approver acted first (or the requester reduced / withdrew it). */
function stageMoved() {
  return json({
    error: "stage_changed",
    message: "This requisition has moved on since you opened it. Refresh to see where it is now.",
  }, 409);
}

function stageLabel(stage: string) {
  return stage === "supervisor" ? "department" : stage.toUpperCase();
}

// deno-lint-ignore no-explicit-any
async function logEvent(
  admin: any, requisitionId: string, actorId: string, actorName: string,
  action: string, stage: string, comment: string | null, metadata: Record<string, unknown>,
) {
  try {
    await admin.from("staff_requisition_events").insert({
      requisition_id: requisitionId,
      actor_id: actorId,
      actor_name: actorName,
      action,
      stage,
      comment: comment ? comment.slice(0, 2000) : null,
      metadata,
    });
  } catch (e) {
    console.error("logEvent failed (non-fatal)", e);
  }
}

// deno-lint-ignore no-explicit-any
async function auditLog(admin: any, actorId: string, requisitionId: string, actionType: string, reason: string) {
  try {
    await admin.from("audit_logs").insert({
      user_id: actorId,
      action_type: actionType,
      table_name: "staff_requisitions",
      record_id: requisitionId,
      reason: (reason || actionType).slice(0, 300),
    });
  } catch (e) {
    console.error("auditLog failed (non-fatal)", e);
  }
}

// deno-lint-ignore no-explicit-any
async function notifyRequester(admin: any, row: any, message: string) {
  if (!row?.requester_id) return;
  try {
    await admin.from("notifications").insert({
      user_id: row.requester_id,
      type: "staff_requisition",
      title: `Requisition ${row.requisition_code}`,
      message,
      metadata: { requisition_id: row.id, stage: row.stage },
    });
  } catch (_) { /* non-fatal */ }
  try {
    const { data: p } = await admin.from("profiles").select("phone, full_name").eq("id", row.requester_id).maybeSingle();
    if (p?.phone) {
      // The requester always gets the in-app notification above; the text
      // message is restricted to senior/finance roles.
      if (!(await maySendRequisitionSms(admin, row.requester_id))) return;
      await sendSMS(p.phone, `Welile: ${message}`, {
        admin,
        source: "staff-requisition-decide",
        reference_id: row.id,
        recipient_user_id: row.requester_id,
        recipient_name: p.full_name,
        idempotencyKey: `staff-req-decide-${row.id}-${row.stage}`,
      });
    }
  } catch (_) { /* non-fatal */ }
}

const EXEC_APPROVER_ROLES = new Set(["ceo", "cto", "cfo", "coo"]);

// deno-lint-ignore no-explicit-any
async function notifyApprovers(admin: any, approverRole: string, row: any) {
  if (!EXEC_APPROVER_ROLES.has(approverRole)) return;
  try {
    const { data: holders } = await admin
      .from("user_roles").select("user_id").eq("role", approverRole).eq("enabled", true).limit(20);
    const ids = (holders || []).map((r: { user_id: string }) => r.user_id);
    if (!ids.length) return;
    await admin.from("notifications").insert(ids.map((id: string) => ({
      user_id: id,
      type: "staff_requisition",
      title: `Requisition ${row.requisition_code} needs your review`,
      message: `${row.requester_name} • ${fmtUGX(Number(row.approved_amount ?? row.amount))} — ${row.title}`,
      metadata: { requisition_id: row.id, stage: row.stage },
    })));
  } catch (e) {
    console.error("notifyApprovers failed (non-fatal)", e);
  }
}

/**
 * Growth commission claims own their counting window. Releasing a claim is what
 * moves the "new platform users since" baseline forward; a rejected claim frees
 * its window so those users are counted again on the next claim.
 */
// deno-lint-ignore no-explicit-any
async function setGrowthClaimStatus(
  admin: any, requisitionId: string, status: "rejected" | "released", creditedAt?: string,
) {
  try {
    await admin
      .from("growth_commission_claims")
      .update({ status, ...(creditedAt ? { credited_at: creditedAt } : {}) })
      .eq("requisition_id", requisitionId);
  } catch (e) {
    console.error("setGrowthClaimStatus failed (non-fatal)", e);
  }
}
