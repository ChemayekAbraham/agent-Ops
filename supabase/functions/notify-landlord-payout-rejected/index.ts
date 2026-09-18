// SMS the agent when Financial Ops rejects one of their landlord payouts.
//
// Single trigger point for "your landlord payout was rejected and your float
// is back": called right after `refund_agent_float_for_payout` and the
// landlord_payouts status update succeed in the FinOps queue (see
// LandlordPayoutsQueue.tsx's handleReject). An SMS failure never reverses the
// rejection/refund — staff can resend by rejecting reasons via the queue
// again is not possible (row is already 'failed'), so this also records
// delivery bookkeeping the same way landlord-rent-receipt does, for support
// to check without re-sending.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.4";
import { sendSMS, formatPhoneInternational, isUgandanPhone } from "../_shared/sendSmsMultiProvider.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function formatUGX(amount: number) {
  return `UGX ${Math.round(Number(amount) || 0).toLocaleString("en-US")}`;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
  const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const admin = createClient(SUPABASE_URL, SERVICE_ROLE);

  try {
    const body = await req.json().catch(() => ({}));
    const payoutId: string | undefined = body?.payout_id;
    const reason: string | undefined = body?.reason;

    if (!payoutId || !/^[0-9a-f-]{36}$/i.test(payoutId)) {
      return json({ error: "payout_id (uuid) is required" }, 400);
    }
    if (!reason || String(reason).trim().length < 10) {
      return json({ error: "reason (min 10 chars) is required" }, 400);
    }

    // ── Auth: a signed-in Financial Ops / CFO / manager / operations user ──
    const token = (req.headers.get("Authorization") || "").replace("Bearer ", "").trim();
    if (!token) return json({ error: "Unauthorized" }, 401);
    const { data: userRes, error: userErr } = await admin.auth.getUser(token);
    const staffUser = userRes?.user;
    if (userErr || !staffUser) return json({ error: "Unauthorized" }, 401);

    const { data: roles } = await admin
      .from("user_roles")
      .select("role")
      .eq("user_id", staffUser.id);
    const allowed = new Set(["operations", "cfo", "manager", "super_admin", "coo"]);
    const isStaff = (roles ?? []).some((r: { role: string }) => allowed.has(r.role));
    if (!isStaff) return json({ error: "Forbidden" }, 403);

    // ── Look up the rejected payout and the agent to notify ────────────────
    const { data: payout, error: payoutErr } = await admin
      .from("landlord_payouts")
      .select("id, agent_id, amount, landlord_name, status")
      .eq("id", payoutId)
      .maybeSingle();
    if (payoutErr) return json({ error: payoutErr.message }, 500);
    if (!payout) return json({ error: "payout_not_found" }, 404);
    if (payout.status !== "failed") {
      // Only ever fire for the FinOps-reject path this function exists for —
      // never mid-flight, and never twice for the same terminal state change.
      return json({ ok: true, sms_sent: false, sms_skipped: "payout_not_rejected" });
    }

    const { data: agentProfile } = await admin
      .from("profiles")
      .select("phone, full_name")
      .eq("id", payout.agent_id)
      .maybeSingle();
    const agentPhone = agentProfile?.phone as string | undefined;
    if (!agentPhone || !isUgandanPhone(agentPhone)) {
      return json({ ok: true, sms_sent: false, sms_skipped: "no_valid_phone" });
    }

    const shortReason = String(reason).trim().slice(0, 140);
    const message =
      `Welile: Your landlord payout of ${formatUGX(payout.amount)} to ${payout.landlord_name ?? "the landlord"} ` +
      `was REJECTED by Financial Ops. Reason: ${shortReason}. Your Landlord Payout Float has been ` +
      `returned — you can withdraw again.`;

    let sent = false;
    let smsError: string | null = null;
    try {
      sent = await sendSMS(formatPhoneInternational(agentPhone), message, {
        admin,
        source: "notify-landlord-payout-rejected",
        reference_id: payout.id,
        recipient_user_id: payout.agent_id,
        recipient_name: agentProfile?.full_name ?? null,
        idempotencyKey: `landlord-payout-rejected-${payout.id}`,
      } as any);
    } catch (e) {
      smsError = (e as Error)?.message ?? String(e);
    }

    return json({ ok: true, sms_sent: sent, sms_error: sent ? null : smsError });
  } catch (e) {
    console.error("[notify-landlord-payout-rejected] failed:", e);
    return json({ error: (e as Error)?.message ?? "Unexpected error" }, 500);
  }
});
