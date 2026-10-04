import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function normalizePhone(raw: string): string {
  const digits = (raw || "").replace(/\D/g, "");
  if (!digits) return "";
  if (digits.startsWith("256")) return `+${digits}`;
  if (digits.startsWith("0")) return `+256${digits.slice(1)}`;
  if (digits.length === 9) return `+256${digits}`;
  return `+${digits}`;
}

function cleanReason(reason: unknown): string {
  const text = String(reason ?? "").trim();
  return text.length >= 10
    ? text
    : "Fraud risk: repeated withdrawal attempts after completed cash-out approvals.";
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const admin = createClient(supabaseUrl, serviceKey);

    const authHeader = req.headers.get("Authorization");
    if (!authHeader) return json({ error: "Unauthorized" }, 401);

    const { data: { user: caller }, error: authErr } = await admin.auth.getUser(
      authHeader.replace("Bearer ", ""),
    );
    if (authErr || !caller) return json({ error: "Unauthorized" }, 401);

    const { data: roles } = await admin
      .from("user_roles")
      .select("role")
      .eq("user_id", caller.id)
      .eq("enabled", true)
      .in("role", ["manager", "super_admin"]);
    if (!roles?.length) return json({ error: "Forbidden: manager required" }, 403);

    const body = await req.json().catch(() => ({}));
    const userId = String(body.user_id || "").trim();
    const reason = cleanReason(body.reason);
    const extraIdentifiers = body.extra_identifiers && typeof body.extra_identifiers === "object"
      ? body.extra_identifiers
      : {};

    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(userId)) {
      return json({ error: "Valid user_id is required" }, 400);
    }

    const { data: profile, error: profileErr } = await admin
      .from("profiles")
      .select("id, full_name, email, phone, mobile_money_number")
      .eq("id", userId)
      .maybeSingle();
    if (profileErr) return json({ error: profileErr.message }, 500);
    if (!profile) return json({ error: "Profile not found" }, 404);

    const blockRes = await admin.rpc("fraud_block_user_identifiers", {
      p_user_id: userId,
      p_reason: reason,
      p_blocked_by: caller.id,
      p_extra_identifiers: extraIdentifiers,
    });
    if (blockRes.error) return json({ error: blockRes.error.message }, 500);

    // Remove active/pending withdrawal paths so frozen users cannot keep recycling payouts.
    await admin
      .from("withdrawal_requests")
      .update({
        status: "rejected",
        rejection_reason: reason,
        processed_by: caller.id,
        processed_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq("user_id", userId)
      .in("status", ["pending", "requested", "manager_approved", "processing"]);

    // Ban the auth user so existing sessions/token refreshes are cut off.
    await admin.auth.admin.updateUserById(userId, {
      ban_duration: "876000h",
      user_metadata: {
        fraud_blocked: true,
        fraud_blocked_at: new Date().toISOString(),
      },
    } as any);

    const warningMessage =
      "WELILE FORMAL FRAUD NOTICE: Your account has been permanently restricted after suspicious withdrawal activity. " +
      "Do not create another Welile account or use related phone/email/mobile-money details. Further attempts will be recorded and may be escalated to recovery, legal, and law-enforcement channels.";

    const smsTargets = new Set<string>();
    if (profile.phone) smsTargets.add(normalizePhone(profile.phone));
    if (profile.mobile_money_number) smsTargets.add(normalizePhone(profile.mobile_money_number));
    for (const p of (extraIdentifiers as any)?.phones ?? []) smsTargets.add(normalizePhone(String(p)));
    for (const p of (extraIdentifiers as any)?.mobile_money_numbers ?? []) smsTargets.add(normalizePhone(String(p)));

    const smsResults: Array<{ phone: string; ok: boolean; error?: string }> = [];
    for (const phone of [...smsTargets].filter(Boolean)) {
      try {
        const { data, error } = await admin.functions.invoke("sms-otp", {
          body: { action: "send_custom", phone, message: warningMessage },
        });
        smsResults.push({ phone, ok: !error && !!(data as any)?.success, error: error?.message });
      } catch (e) {
        smsResults.push({ phone, ok: false, error: e instanceof Error ? e.message : String(e) });
      }
    }

    await admin.from("audit_logs").insert({
      user_id: caller.id,
      action_type: "fraud_cutoff_notice_sent",
      action: "fraud_cutoff_notice_sent",
      table_name: "profiles",
      record_id: userId,
      metadata: {
        reason,
        profile_name: profile.full_name,
        email: profile.email,
        sms_targets: [...smsTargets],
        sms_results: smsResults,
        message: warningMessage,
      },
    });

    return json({
      success: true,
      user_id: userId,
      blocked: blockRes.data,
      sms_results: smsResults,
      message: warningMessage,
    });
  } catch (e) {
    console.error("[fraud-cutoff-account] error:", e);
    return json({ error: e instanceof Error ? e.message : "Unknown error" }, 500);
  }
});