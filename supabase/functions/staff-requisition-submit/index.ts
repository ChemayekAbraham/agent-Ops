import { createClient } from "npm:@supabase/supabase-js@2";
import { sendSMS } from "../_shared/sendSmsMultiProvider.ts";
import { requisitionSmsRecipients } from "../_shared/requisitionSmsPolicy.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const REVIEW_URL = "https://welileapp.com";

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
    const requester = userData.user;

    const { data: staffCheck } = await admin.rpc("is_welile_staff", { _user_id: requester.id });
    let allowed = !!staffCheck;
    if (!allowed) {
      // Agents explicitly granted Agents' Space access may also raise requisitions
      const { data: spaceGrant } = await admin
        .from("staff_permissions")
        .select("id")
        .eq("user_id", requester.id)
        .eq("permitted_dashboard", "agents-space")
        .is("revoked_at", null)
        .maybeSingle();
      allowed = !!spaceGrant;
    }
    if (!allowed) return json({ error: "Only Welile staff or authorized agents can raise requisitions" }, 403);

    const body = await req.json().catch(() => ({}));
    const resubmitId = body.requisition_id ? String(body.requisition_id) : null;
    const title = String(body.title || "").trim();
    const amount = Math.round(Number(body.amount) * 100) / 100;
    const reason = String(body.reason || "").trim();
    const category = body.category ? String(body.category).trim().slice(0, 100) : null;
    const neededBy = body.needed_by ? String(body.needed_by) : null;
    const attachments = Array.isArray(body.attachment_urls)
      ? body.attachment_urls.slice(0, 10).map((u: unknown) => String(u))
      : [];

    // A staff loan is the same request, routed and approved identically, but it is
    // repaid: 28% per month on the amount still owing, over 1-12 months.
...
    const loanRate = requestKind === "staff_loan" ? 0.28 : null;

    if (requestKind === "staff_loan") {
      const { data: empRole } = await admin
        .from("user_roles")
        .select("id, enabled")
        .eq("user_id", requester.id)
        .eq("role", "employee")
        .maybeSingle();
      if (!empRole || empRole.enabled === false) {
        return json({ error: "Only staff with an active employee role can request a staff loan" }, 403);
      }
    }

    if (title.length < 3) return json({ error: "Title is required (min 3 characters)" }, 400);
    if (!Number.isFinite(amount) || amount <= 0) return json({ error: "A valid amount is required" }, 400);
    if (reason.length < 10) return json({ error: "Please provide a reason (min 10 characters)" }, 400);

    const { data: profile } = await admin
      .from("profiles")
      .select("full_name, phone, email")
      .eq("id", requester.id)
      .maybeSingle();
    const requesterName = profile?.full_name || requester.email || "Staff";

    // ── Resubmission of a returned requisition ───────────────────────────────
    if (resubmitId) {
      const { data: existing } = await admin
        .from("staff_requisitions")
        .select("id, requester_id, stage, returned_from_stage, requisition_code, department_id")
        .eq("id", resubmitId)
        .maybeSingle();
      if (!existing) return json({ error: "Requisition not found" }, 404);
      if (existing.requester_id !== requester.id) return json({ error: "Not your requisition" }, 403);
      if (existing.stage !== "returned") return json({ error: "Only returned requisitions can be resubmitted" }, 409);

      const backTo = existing.returned_from_stage || "supervisor";
      const approverRole = await approverRoleForStage(admin, backTo, existing.department_id);

      const { data: updated, error: upErr } = await admin
        .from("staff_requisitions")
        .update({
          title, amount, reason, category,
          request_kind: requestKind,
          loan_months: loanMonths,
          loan_monthly_rate: loanRate,
          needed_by: neededBy,
          attachment_urls: attachments,
          stage: backTo,
          current_approver_role: approverRole,
          returned_from_stage: null,
          rejection_reason: null,
        })
        .eq("id", resubmitId)
        .select("*")
        .single();
      if (upErr) throw upErr;

      await admin.from("staff_requisition_events").insert({
        requisition_id: resubmitId,
        actor_id: requester.id,
        actor_name: requesterName,
        action: "resubmitted",
        stage: backTo,
        comment: reason.slice(0, 2000),
        metadata: { amount, title },
      });
      await notifyApprovers(admin, approverRole, updated, requesterName);
      await emitEvent(admin, "requisition.resubmitted", updated);
      return json({ ok: true, requisition: updated }, 200);
    }

    // ── New submission ───────────────────────────────────────────────────────
    const { data: routeRows, error: routeErr } = await admin
      .rpc("staff_requisition_route", { _user_id: requester.id });
    if (routeErr) throw routeErr;
    let route = Array.isArray(routeRows) ? routeRows[0] : routeRows;
    if (!route?.department_id && !staffCheck) {
      // Agents' Space agents have no HR department: route through Agent Operations
      const { data: agentOpsDept } = await admin
        .from("hr_departments")
        .select("id, key, name")
        .eq("key", "agent_ops")
        .eq("active", true)
        .maybeSingle();
      if (agentOpsDept) {
        route = {
          department_id: agentOpsDept.id,
          department_key: agentOpsDept.key,
          department_name: agentOpsDept.name,
          stage: "supervisor",
          approver_role: "agent_ops",
          final_stage: "cfo",
        };
      }
    }
    const primaryRole = (await primaryRoleOf(admin, requester.id)) ?? null;

    if (!route?.department_id) {
      // Staff with no active department assignment must still be able to raise a
      // requisition: it goes straight to the COO, who can reassign it if needed.
      // Nobody reviews their own money, so a COO's own request starts at the CFO.
      const selfIsCoo = primaryRole === "coo";
      route = {
        department_id: null,
        department_key: null,
        department_name: "Unassigned",
        stage: selfIsCoo ? "cfo" : "coo",
        approver_role: selfIsCoo ? "cfo" : "coo",
        final_stage: "cfo",
      };
    }

    const { data: inserted, error: insErr } = await admin
      .from("staff_requisitions")
      .insert({
        requester_id: requester.id,
        requester_name: requesterName,
        requester_role: primaryRole,
        department_id: route.department_id,
        department_key: route.department_key,
        title, amount, reason, category,
        request_kind: requestKind,
        loan_months: loanMonths,
        loan_monthly_rate: loanRate,
        needed_by: neededBy,
        attachment_urls: attachments,
        stage: route.stage,
        current_approver_role: route.approver_role,
        final_stage: route.final_stage,
      })
      .select("*")
      .single();
    if (insErr || !inserted) throw new Error(insErr?.message || "Failed to create requisition");

    await admin.from("staff_requisition_events").insert({
      requisition_id: inserted.id,
      actor_id: requester.id,
      actor_name: requesterName,
      actor_role: primaryRole,
      action: "created",
      stage: route.stage,
      comment: reason.slice(0, 2000),
      metadata: { amount, title, department: route.department_name },
    });

    await admin.from("audit_logs").insert({
      user_id: requester.id,
      action_type: "staff_requisition_created",
      table_name: "staff_requisitions",
      record_id: inserted.id,
      reason: reason.slice(0, 200),
      metadata: { amount, title, stage: route.stage, approver_role: route.approver_role },
    });

    await notifyApprovers(admin, route.approver_role, inserted, requesterName);
    await emitEvent(admin, "requisition.submitted", inserted);

    return json({ ok: true, requisition: inserted }, 200);
  } catch (e) {
    console.error("staff-requisition-submit error", e);
    return json({ error: String((e as Error).message ?? e) }, 500);
  }
});

// deno-lint-ignore no-explicit-any
async function primaryRoleOf(admin: any, userId: string): Promise<string | null> {
  const { data } = await admin.from("user_roles").select("role").eq("user_id", userId).eq("enabled", true);
  const roles = (data || []).map((r: { role: string }) => r.role);
  const order = ["ceo", "coo", "cfo", "cto", "cmo", "crm", "hr", "operations", "manager", "employee"];
  return order.find((r) => roles.includes(r)) ?? roles[0] ?? null;
}

// deno-lint-ignore no-explicit-any
async function approverRoleForStage(admin: any, stage: string, departmentId: string | null) {
  if (stage === "coo") return "coo";
  if (stage === "cfo") return "cfo";
  if (stage === "ceo") return "ceo";
  if (!departmentId) return "coo";
  const { data } = await admin
    .from("staff_requisition_department_routes")
    .select("approver_role")
    .eq("department_id", departmentId)
    .maybeSingle();
  return data?.approver_role ?? "coo";
}

// deno-lint-ignore no-explicit-any
async function emitEvent(admin: any, eventType: string, row: any) {
  try {
    await admin.from("system_events").insert({
      event_type: eventType,
      payload: {
        source: "staff_requisitions",
        id: row.id,
        code: row.requisition_code,
        amount: row.amount,
        stage: row.stage,
      },
    });
  } catch (_) { /* non-fatal */ }
}

const EXEC_APPROVER_ROLES = new Set(["ceo", "cto", "cfo", "coo"]);

/**
 * In-app + SMS + email fan-out to everyone holding the reviewing role.
 * Review notifications only ever reach the exec team (CEO/CTO/CFO/COO) —
 * department-level approver roles (agent_ops, tenant_ops, hr, cmo, ...)
 * still own the stage and can act on it, they just aren't pinged.
 */
// deno-lint-ignore no-explicit-any
async function notifyApprovers(admin: any, approverRole: string, row: any, requesterName: string) {
  if (!EXEC_APPROVER_ROLES.has(approverRole)) return;
  try {
    const { data: holders } = await admin
      .from("user_roles")
      .select("user_id")
      .eq("role", approverRole)
      .eq("enabled", true)
      .limit(20);
    const ids = (holders || []).map((r: { user_id: string }) => r.user_id);
    if (ids.length === 0) return;

    const message = `${requesterName} • ${fmtUGX(Number(row.amount))} — ${row.title}`;
    await admin.from("notifications").insert(
      ids.map((id: string) => ({
        user_id: id,
        type: "staff_requisition",
        title: `Requisition ${row.requisition_code} needs your review`,
        message,
        metadata: { requisition_id: row.id, stage: row.stage },
      })),
    );

    const { data: profiles } = await admin
      .from("profiles")
      .select("id, full_name, phone, email")
      .in("id", ids);

    // Everyone above was notified in-app. Only senior/finance roles get the
    // text message — see _shared/requisitionSmsPolicy.ts.
    const smsAllowed = await requisitionSmsRecipients(admin, ids);

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

    for (const p of profiles || []) {
      if (p.phone && smsAllowed.has(p.id)) {
        try {
          await sendSMS(p.phone, `Welile: Requisition ${row.requisition_code} (${fmtUGX(Number(row.amount))}) from ${requesterName} awaits your review.`, {
            admin,
            source: "staff-requisition-submit",
            reference_id: row.id,
            recipient_user_id: p.id,
            recipient_name: p.full_name,
            idempotencyKey: `staff-req-${row.id}-${row.stage}-${p.id}`,
          });
        } catch (_) { /* non-fatal */ }
      }
      if (p.email) {
        try {
          await fetch(`${supabaseUrl}/functions/v1/send-email`, {
            method: "POST",
            headers: {
              Authorization: `Bearer ${serviceKey}`,
              apikey: serviceKey,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              to: p.email,
              subject: `Requisition ${row.requisition_code} awaits your review`,
              html: `<p>Hello ${p.full_name || "there"},</p>
<p><b>${requesterName}</b> raised requisition <b>${row.requisition_code}</b> for <b>${fmtUGX(Number(row.amount))}</b>.</p>
<p><b>${row.title}</b><br/>${String(row.reason || "").slice(0, 800)}</p>
<p>Review it in your dashboard: <a href="${REVIEW_URL}">${REVIEW_URL}</a></p>`,
            }),
          });
        } catch (_) { /* non-fatal */ }
      }
    }
  } catch (e) {
    console.error("notifyApprovers failed (non-fatal)", e);
  }
}
