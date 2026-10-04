import "../_shared/smsFooterInterceptor.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { formatPhoneInternational, isUgandanPhone } from "./phone.ts";
import { attemptYoolaPrimary } from "../_shared/yoolaPrimary.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function sendSMSOnce(
  phone: string,
  message: string,
): Promise<{ ok: boolean; retryable: boolean; error: string | null }> {
  if (await attemptYoolaPrimary(phone, message, { source: "notify-merchant-agent-assigned" })) return { ok: true, retryable: false, error: null };
  const apiKey = Deno.env.get("AFRICASTALKING_API_KEY");
  const username = Deno.env.get("AFRICASTALKING_USERNAME");
  if (!apiKey || !username) {
    return { ok: false, retryable: false, error: "SMS provider not configured" };
  }
  if (!isUgandanPhone(phone)) {
    return { ok: false, retryable: false, error: "Invalid Ugandan phone number" };
  }
  const isSandbox = username.toLowerCase() === "sandbox";
  const baseUrl = isSandbox
    ? "https://api.sandbox.africastalking.com/version1/messaging"
    : "https://api.africastalking.com/version1/messaging";
  try {
    const body = new URLSearchParams({
      username, from: "WELILE",
      to: formatPhoneInternational(phone),      message,
    });
    const res = await fetch(baseUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        apiKey,
        Accept: "application/json",
      },
      body: body.toString(),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      const retryable = res.status >= 500 || res.status === 429;
      return {
        ok: false,
        retryable,
        error: `Provider HTTP ${res.status}${text ? `: ${text.slice(0, 200)}` : ""}`,
      };
    }
    const data = await res.json();
    const recipients = data?.SMSMessageData?.Recipients || [];
    const accepted = recipients.some(
      (r: any) => r.statusCode === 101 || r.statusCode === 100,
    );
    if (accepted) return { ok: true, retryable: false, error: null };
    const reason = recipients.map((r: any) => `${r.number}:${r.status}`).join(", ");
    return {
      ok: false,
      retryable: false,
      error: reason ? `Provider rejected (${reason})` : "Provider returned no accepted recipients",
    };
  } catch (err) {
    return { ok: false, retryable: true, error: `Network error: ${(err as Error)?.message || err}` };
  }
}

async function sendSMSWithRetry(
  phone: string,
  message: string,
  maxAttempts = 3,
): Promise<{ sent: boolean; attempts: number; error: string | null }> {
  let lastError: string | null = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const r = await sendSMSOnce(phone, message);
    if (r.ok) return { sent: true, attempts: attempt, error: null };
    lastError = r.error;
    console.warn(`[notify-merchant-agent-assigned] SMS attempt ${attempt}/${maxAttempts} failed: ${r.error}`);
    if (!r.retryable || attempt === maxAttempts) return { sent: false, attempts: attempt, error: lastError };
    await sleep(500 * 2 ** (attempt - 1));
  }
  return { sent: false, attempts: maxAttempts, error: lastError };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

    // Authenticate caller — must be a logged-in CFO/manager who just assigned the merchant.
    const authHeader = req.headers.get("Authorization") || "";
    const userClient = createClient(supabaseUrl, Deno.env.get("SUPABASE_ANON_KEY")!, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: { user }, error: authErr } = await userClient.auth.getUser();
    if (authErr || !user) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const admin = createClient(supabaseUrl, serviceKey);

    // Caller must hold a privileged role allowed to assign merchant agents.
    const { data: roles } = await admin
      .from("user_roles")
      .select("role")
      .eq("user_id", user.id);
    const allowed = (roles || []).some((r: any) =>
      ["cfo", "manager", "super_admin", "coo", "ceo"].includes(r.role),
    );
    if (!allowed) {
      return new Response(JSON.stringify({ error: "Forbidden" }), {
        status: 403,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const body = await req.json().catch(() => ({}));
    const agentId = typeof body?.agent_id === "string" ? body.agent_id : null;
    if (!agentId) {
      return new Response(JSON.stringify({ error: "agent_id required" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Confirm the target is actually an active merchant agent now.
    const { data: merchantRow } = await admin
      .from("cashout_agents")
      .select("id, label, is_active")
      .eq("agent_id", agentId)
      .maybeSingle();
    if (!merchantRow || !merchantRow.is_active) {
      return new Response(JSON.stringify({ error: "Not an active merchant agent" }), {
        status: 404,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const { data: profile } = await admin
      .from("profiles")
      .select("full_name, phone")
      .eq("id", agentId)
      .maybeSingle();

    const name = ((profile as any)?.full_name || "").trim().split(" ")[0] || "there";
    const rawPhone = ((profile as any)?.phone || "").trim();

    if (!isUgandanPhone(rawPhone)) {
      return new Response(
        JSON.stringify({ ok: false, sent: false, error: "No valid Ugandan phone on file" }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    const smsMsg =
      `WELILE: Congratulations ${name}! You are now a Welile Merchant Agent (cash-out). ` +
      `You can start claiming and processing withdrawal requests and earn 0.5% commission per payout. ` +
      `Open your dashboard: https://welileapp.com/ZQhyGb`;

    const result = await sendSMSWithRetry(rawPhone, smsMsg);

    // In-app notification too.
    try {
      await admin.from("notifications").insert({
        user_id: agentId,
        type: "success",
        title: "You are now a Merchant Agent",
        message:
          "You can now claim and process cash-out withdrawal requests and earn 0.5% commission per payout.",
        metadata: { kind: "merchant_agent_assigned" },
      });
    } catch (e) {
      console.warn("[notify-merchant-agent-assigned] notification insert failed:", e);
    }

    return new Response(
      JSON.stringify({ ok: true, sent: result.sent, attempts: result.attempts, error: result.error }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (err: any) {
    console.error("[notify-merchant-agent-assigned] error:", err);
    return new Response(JSON.stringify({ error: err?.message || "Internal error" }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});