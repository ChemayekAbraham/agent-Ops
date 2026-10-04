import "../_shared/smsFooterInterceptor.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { attemptYoolaPrimary } from "../_shared/yoolaPrimary.ts";

// Manual CORS headers (per project convention — never import a cors package).
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });

function formatPhoneInternational(phone: string): string {
  const digits = (phone || "").replace(/[^0-9]/g, "");
  if (!digits) return "";
  if (digits.startsWith("256")) return `+${digits}`;
  if (digits.startsWith("0")) return `+256${digits.slice(1)}`;
  if (digits.length === 9) return `+256${digits}`;
  return `+${digits}`;
}

async function sendSMS(phone: string, message: string): Promise<boolean> {
  if (await attemptYoolaPrimary(phone, message, { source: "expire-subagent-invites" })) return true;
  const apiKey = Deno.env.get("AFRICASTALKING_API_KEY");
  const username = Deno.env.get("AFRICASTALKING_USERNAME");
  if (!apiKey || !username) {
    console.error("[expire-subagent-invites] Missing AT credentials");
    return false;
  }
  const isSandbox = username.toLowerCase() === "sandbox";
  const baseUrl = isSandbox
    ? "https://api.sandbox.africastalking.com/version1/messaging"
    : "https://api.africastalking.com/version1/messaging";
  const to = formatPhoneInternational(phone);
  if (!to) return false;
  try {
    const body = new URLSearchParams({ username, from: "WELILE", to, message });
    const res = await fetch(baseUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        apiKey,
        Accept: "application/json",
      },
      body: body.toString(),
    });
    const raw = await res.text();
    let data: any;
    try { data = JSON.parse(raw); } catch { return false; }
    const recipients = data?.SMSMessageData?.Recipients || [];
    return recipients.some((r: any) => r.statusCode === 100 || r.statusCode === 101);
  } catch (err) {
    console.error("[expire-subagent-invites] SMS send failed:", err);
    return false;
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const admin = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    const nowIso = new Date().toISOString();
    const weekAgoIso = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

    // Pending invites that are past their expiry window. expires_at is normally
    // created_at + 7 days (and is extended on resend), so respect it when set;
    // fall back to a hard 7-day age for legacy rows with no expires_at.
    const { data: stale, error: fetchErr } = await admin
      .from("agent_subagents")
      .select("id, parent_agent_id, sub_agent_id, created_at, expires_at")
      .eq("status", "pending_acceptance")
      .or(`expires_at.lt.${nowIso},and(expires_at.is.null,created_at.lt.${weekAgoIso})`);

    if (fetchErr) return json({ error: fetchErr.message }, 500);

    if (!stale || stale.length === 0) {
      return json({ ok: true, expired: 0, leadsNudged: 0 });
    }

    const ids = stale.map((r) => r.id);

    // Flip to expired. The registration-bonus trigger only fires on the
    // verified transition, so this is safe and pays nothing out.
    const { error: updErr } = await admin
      .from("agent_subagents")
      .update({ status: "expired" })
      .in("id", ids);
    if (updErr) return json({ error: updErr.message }, 500);

    // Group expired invites per lead (parent agent) so each lead gets a single
    // consolidated nudge rather than one message per invite.
    const byParent = new Map<string, number>();
    for (const row of stale) {
      if (!row.parent_agent_id) continue;
      byParent.set(row.parent_agent_id, (byParent.get(row.parent_agent_id) || 0) + 1);
    }

    const parentIds = [...byParent.keys()];
    const { data: parents } = await admin
      .from("profiles")
      .select("id, full_name, phone")
      .in("id", parentIds);
    const profileMap = new Map((parents || []).map((p) => [p.id, p]));

    let leadsNudged = 0;
    for (const [parentId, count] of byParent.entries()) {
      const profile = profileMap.get(parentId);
      const firstName = (profile?.full_name || "Agent").trim().split(/\s+/)[0] || "Agent";
      const plural = count === 1 ? "invite" : "invites";

      // In-app nudge (persists in the bell). Service role bypasses RLS.
      await admin.from("notifications").insert({
        user_id: parentId,
        title: "Sub-agent invite expired",
        message: `${count} sub-agent ${plural} expired before being accepted. Resend to grow your team and keep earning the 2% override.`,
        type: "warning",
        metadata: { source: "expire-subagent-invites", expired_count: count },
      });

      // SMS reminder nudge.
      if (profile?.phone) {
        const sent = await sendSMS(
          profile.phone,
          `Hi ${firstName}, ${count} sub-agent ${plural} you sent on Welile expired before being accepted. Open Welile to resend and keep earning from your team. — Welile`,
        );
        if (sent) leadsNudged++;
      }
    }

    console.log(
      `[expire-subagent-invites] expired=${ids.length} leads=${parentIds.length} smsSent=${leadsNudged}`,
    );

    return json({
      ok: true,
      expired: ids.length,
      leads: parentIds.length,
      leadsNudged,
    });
  } catch (err) {
    console.error("[expire-subagent-invites] error:", err);
    return json({ error: (err as Error)?.message || "Unexpected error" }, 500);
  }
});