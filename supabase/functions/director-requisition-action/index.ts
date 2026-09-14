import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { sendSMS } from "../_shared/sendSmsMultiProvider.ts";
import { creditRequisitionWallet } from "../_shared/requisitionWalletCredit.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const REVIEW_URL = "https://welileapp.com/director/dashboard";
// Roles that may act as the Director until a dedicated Director dashboard exists.
const DIRECTOR_ROLES = ["ceo", "super_admin", "manager"];

const ACTION_MAP: Record<string, { status: string; event: string; label: string }> = {
  approve: { status: "approved", event: "approved", label: "Approved" },
  reject: { status: "rejected", event: "rejected", label: "Rejected" },
  request_info: { status: "more_info", event: "more_info_requested", label: "More Information Required" },
};

function fmtUGX(n: number) {
  return `UGX ${Math.round(n).toLocaleString("en-US")}`;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const admin = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    const token = req.headers.get("Authorization")?.replace("Bearer ", "") ?? "";
    const { data: userData, error: userErr } = await admin.auth.getUser(token);
    if (userErr || !userData?.user) {
      return new Response(JSON.stringify({ error: "Not authenticated" }), { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }
    const director = userData.user;

    const { data: roleRows } = await admin.from("user_roles").select("role").eq("user_id", director.id).eq("enabled", true);
    const directorRoles = (roleRows || []).map((r: any) => r.role);
    if (!directorRoles.some((r: string) => DIRECTOR_ROLES.includes(r))) {
      return new Response(JSON.stringify({ error: "Only the Director can act on requisitions" }), { status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    const body = await req.json().catch(() => ({}));
    const requisitionId = String(body.requisition_id || "");
    const action = String(body.action || "");
    const comment = String(body.comment || "").trim();

    const mapped = ACTION_MAP[action];
    if (!mapped) return new Response(JSON.stringify({ error: "Invalid action" }), { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    if (!requisitionId) return new Response(JSON.stringify({ error: "requisition_id is required" }), { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    if (comment.length < 10) return new Response(JSON.stringify({ error: "A comment (min 10 characters) is required for the audit trail" }), { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });

    // Fetch fresh
    const { data: reqRow, error: fetchErr } = await admin.from("director_requisitions").select("*").eq("id", requisitionId).maybeSingle();
    if (fetchErr || !reqRow) return new Response(JSON.stringify({ error: "Requisition not found" }), { status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    if (reqRow.status === "approved" || reqRow.status === "rejected") {
      return new Response(JSON.stringify({ error: `This requisition is already ${reqRow.status} and cannot be changed` }), { status: 409, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    const { data: dProfile } = await admin.from("profiles").select("full_name").eq("id", director.id).maybeSingle();
    const directorName = dProfile?.full_name || director.email || "Director";
    const decidedAt = new Date();

    const isFinal = action === "approve" || action === "reject";
    const { data: updated, error: updErr } = await admin
      .from("director_requisitions")
      .update({
        status: mapped.status,
        director_comment: comment,
        approver_id: director.id,
        approver_name: directorName,
        decided_at: isFinal ? decidedAt.toISOString() : reqRow.decided_at,
      })
      .eq("id", requisitionId)
      .select()
      .single();
    if (updErr || !updated) throw new Error(updErr?.message || "Failed to update requisition");

    await admin.from("director_requisition_events").insert({
      requisition_id: requisitionId,
      actor_id: director.id,
      actor_name: directorName,
      action: mapped.event,
      comment,
      metadata: { status: mapped.status },
    });
    await admin.from("audit_logs").insert({
      user_id: director.id,
      action_type: `director_requisition_${mapped.event}`,
      table_name: "director_requisitions",
      record_id: requisitionId,
      reason: comment.slice(0, 200),
      metadata: { requisition_code: reqRow.requisition_code, status: mapped.status },
    });

    // Approved -> credit the requester's wallet (idempotent, ledger-backed).
    let walletCredit: { ok: boolean; message: string; wallet_transaction_id?: string | null; already_credited?: boolean; error?: string } | null = null;
    if (action === "approve") {
      walletCredit = await creditRequisitionWallet({
        admin,
        sourceTable: "director_requisitions",
        requisitionId,
        requisitionCode: reqRow.requisition_code,
        userId: reqRow.requester_id,
        approverId: director.id,
        approverName: directorName,
        amount: Number(updated.amount),
        currency: "UGX",
        purpose: reqRow.title,
        category: reqRow.requester_role,
        status: "approved",
        approvedAt: decidedAt.toISOString(),
        ipAddress: req.headers.get("x-forwarded-for") || req.headers.get("cf-connecting-ip"),
        deviceInfo: req.headers.get("user-agent"),
      });
    }

    // Notify requester
    const { data: requesterProfile } = await admin.from("profiles").select("id, full_name, phone, email").eq("id", reqRow.requester_id).maybeSingle();
    const decidedAtStr = decidedAt.toLocaleString("en-GB", { timeZone: "Africa/Kampala", dateStyle: "medium", timeStyle: "short" });

    if (requesterProfile) {
      await admin.from("notifications").insert({
        user_id: requesterProfile.id,
        type: "director_requisition",
        title: `Requisition ${mapped.label}: ${reqRow.requisition_code}`,
        message: `${directorName} marked "${reqRow.title}" (${fmtUGX(Number(reqRow.amount))}) as ${mapped.label}. Comment: ${comment}`,
        metadata: { requisition_id: requisitionId, requisition_code: reqRow.requisition_code, status: mapped.status, review_url: REVIEW_URL },
      });

      if (requesterProfile.phone) {
        await sendSMS(
          requesterProfile.phone,
          `Welile: Your requisition ${reqRow.requisition_code} (${fmtUGX(Number(reqRow.amount))}) is now ${mapped.label}. ${comment}`,
          { admin, source: "director-requisition-action", reference_id: requisitionId, recipient_user_id: requesterProfile.id, recipient_name: requesterProfile.full_name, idempotencyKey: `req-status-${requisitionId}-${mapped.status}` },
        ).catch((e) => console.error("SMS failed", e));
      }

      if (requesterProfile.email) {
        await admin.functions.invoke("send-transactional-email", {
          body: {
            templateName: "director-requisition-status",
            recipientEmail: requesterProfile.email,
            idempotencyKey: `req-status-${requisitionId}-${mapped.status}`,
            templateData: {
              requester_name: requesterProfile.full_name || "there",
              requisition_code: reqRow.requisition_code,
              title: reqRow.title,
              amount: fmtUGX(Number(reqRow.amount)),
              status_label: mapped.label,
              decided_by: directorName,
              decided_at: decidedAtStr,
              comment,
              review_url: REVIEW_URL,
            },
          },
        }).catch((e) => console.error("Email failed", e));
      }
    }

    return new Response(JSON.stringify({ success: true, requisition: updated, wallet_credit: walletCredit }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
  } catch (err) {
    console.error("director-requisition-action error", err);
    return new Response(JSON.stringify({ error: (err as Error).message || "Unexpected error" }), { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }
});
