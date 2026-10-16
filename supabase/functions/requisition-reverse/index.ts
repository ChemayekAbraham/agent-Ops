/**
 * CFO-only reversal of a paid requisition.
 *
 * Takes the requisition amount back out of the receiver's withdrawable balance and
 * returns it to the company, through CFO Direct Debit (cfo-direct-credit, operation
 * "debit") called with the CFO's OWN session — so the CFO-approver gate, treasury
 * guard and strict withdrawable-balance check all apply. No forced overdraw: if the
 * receiver has already withdrawn/spent the money the reversal is refused.
 *
 * Exactly-once: the credit row is claimed atomically (credited -> reversing) before
 * any money moves; a failed debit puts it back to credited.
 */
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";
import { sendSMS } from "../_shared/sendSmsMultiProvider.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  const url = Deno.env.get("SUPABASE_URL")!;
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const admin = createClient(url, serviceKey);

  try {
    const authHeader = req.headers.get("authorization") || "";
    const token = authHeader.replace("Bearer ", "");
    const { data: { user }, error: authErr } = await admin.auth.getUser(token);
    if (authErr || !user) return json({ error: "Unauthorized" }, 401);

    const { data: roles } = await admin.from("user_roles")
      .select("role, enabled").eq("user_id", user.id).eq("role", "cfo");
    if (!roles?.some((r: { enabled?: boolean | null }) => r.enabled !== false)) {
      return json({ error: "Only the CFO can reverse a requisition payment." }, 403);
    }

    const body = await req.json().catch(() => ({}));
    const sourceTable = String(body?.source_table ?? "");
    const requisitionId = String(body?.requisition_id ?? "");
    const reason = String(body?.reason ?? "").trim();
    if (!["staff_requisitions", "employee_requisitions", "director_requisitions"].includes(sourceTable) || !requisitionId) {
      return json({ error: "Unknown requisition." }, 400);
    }
    if (reason.length < 10) return json({ error: "Please give a reason of at least 10 characters." }, 400);

    // Atomic claim — only a paid (credited) row can be reversed, once.
    const { data: claimed } = await admin.from("requisition_wallet_credits")
      .update({ status: "reversing", reversal_reason: reason, reversed_by: user.id })
      .eq("source_table", sourceTable).eq("requisition_id", requisitionId).eq("status", "credited")
      .select("id, user_id, amount, requisition_code").maybeSingle();
    if (!claimed) return json({ error: "This requisition is not paid, or has already been reversed." }, 409);

    const amount = Number(claimed.amount);
    const res = await fetch(`${url}/functions/v1/cfo-direct-credit`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, apikey: serviceKey, "Content-Type": "application/json" },
      body: JSON.stringify({
        target_user_id: claimed.user_id,
        amount,
        operation: "debit",
        recipient_type: "user",
        wallet_category: "payroll_expense",
        platform_category: "payroll_expense",
        financial_impact: "expense",
        category_label: "Requisition Reversal",
        sub_category: `requisition_reversal:${sourceTable}:${requisitionId}`,
        reason: `Reversed requisition ${claimed.requisition_code ?? requisitionId}: ${reason}`,
        manual_credit: true,
      }),
    });
    const raw = await res.text();
    let out: Record<string, unknown> = {};
    try { out = raw ? JSON.parse(raw) : {}; } catch { out = { error: raw.slice(0, 300) }; }

    if (!res.ok || out?.error) {
      await admin.from("requisition_wallet_credits")
        .update({ status: "credited", reversal_reason: null, reversed_by: null })
        .eq("id", claimed.id).eq("status", "reversing");
      const msg = String(out?.error ?? `HTTP ${res.status}`);
      const friendly = msg.includes("INSUFFICIENT")
        ? "The receiver no longer has enough money in their wallet to take this back. Nothing was reversed."
        : `Reversal failed: ${msg}. Nothing was reversed.`;
      return json({ error: friendly, code: out?.code ?? null }, 422);
    }

    const reference = (out?.reference_id as string) ?? null;
    const now = new Date().toISOString();
    await admin.from("requisition_wallet_credits")
      .update({ status: "reversed", reversed_at: now, reversal_reference: reference })
      .eq("id", claimed.id);
    await admin.from(sourceTable).update({ wallet_credit_status: "reversed" }).eq("id", requisitionId);
    await admin.from("audit_logs").insert({
      user_id: user.id,
      action_type: "requisition_wallet_credit_reversed",
      table_name: sourceTable,
      record_id: requisitionId,
      reason: reason.slice(0, 300),
      metadata: { amount, receiver_id: claimed.user_id, reversal_reference: reference, at: now },
    });
    try {
      await admin.from("system_events").insert({
        event_type: "wallet_transfer",
        user_id: claimed.user_id,
        metadata: { kind: "requisition_reversed", source_table: sourceTable, requisition_id: requisitionId, amount, by: user.id },
      });
    } catch (_) { /* best effort */ }
    // Tell the requester right away (bell updates live on notification inserts).
    try {
      const code = claimed.requisition_code ?? requisitionId.slice(0, 8).toUpperCase();
      await admin.from("notifications").insert({
        user_id: claimed.user_id,
        title: `Requisition ${code} payment reversed`,
        message: `UGX ${Math.round(amount).toLocaleString("en-US")} paid for requisition ${code} was taken back from your wallet and returned to the company. Reason: ${reason.slice(0, 300)}. You do not need to submit a usage report for it.`,
        type: "requisition_reversed",
        is_read: false,
        metadata: { requisition_id: requisitionId, source_table: sourceTable, amount, reversal_reference: reference, stage: "reversed" },
      });
    } catch (_) { /* best effort — never undo a completed reversal */ }
    // SMS to the requester themselves (their own money, so the approver-only
    // requisition SMS role policy does not apply). Best effort; never undoes the reversal.
    try {
      const code = claimed.requisition_code ?? requisitionId.slice(0, 8).toUpperCase();
      const { data: prof } = await admin.from("profiles").select("phone, full_name").eq("id", claimed.user_id).maybeSingle();
      const sms = `Welile: UGX ${Math.round(amount).toLocaleString("en-US")} paid for requisition ${code} has been reversed from your wallet and returned to the company. Reason: ${reason.slice(0, 120)}. No usage report is needed for it.`;
      await sendSMS(String(prof?.phone ?? ""), sms, {
        admin,
        source: "requisition_reversal",
        reference_id: reference ?? claimed.id,
        recipient_user_id: claimed.user_id,
        recipient_name: prof?.full_name ?? null,
        idempotencyKey: `requisition_reversal_sms:${claimed.id}`,
      });
    } catch (_) { /* best effort */ }

    return json({ ok: true, reversal_reference: reference });
  } catch (e) {
    return json({ error: String((e as Error).message ?? e) }, 500);
  }
});
