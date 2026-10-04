import "../_shared/noSignupPrompt.ts";
import "../_shared/smsFooterInterceptor.ts";
// Cash-with-agent deposit — Step 1.
// The depositor enters an amount and the agent's phone number. We resolve the
// agent, verify they have enough OPERATIONAL FLOAT to cover it, generate a
// 4-digit PIN, and store a pending session. The PIN is shown ONLY on the
// target agent's dashboard (RLS-scoped). The agent reads it back to the
// depositor after receiving the cash; the depositor enters it via
// agent-cash-deposit-confirm, which credits their withdrawable wallet and
// debits the agent's float.
import { confirmYoolaDelivery, extractYoolaMessageId } from "../_shared/yoolaDeliveryConfirm.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

const json = (status: number, payload: Record<string, unknown>) =>
  new Response(JSON.stringify(payload), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });

// Last 9 significant digits — the canonical Ugandan phone identity.
function last9(raw: string): string {
  const digits = String(raw || "").replace(/\D/g, "");
  return digits.slice(-9);
}

function gen4DigitPin(): string {
  const n = crypto.getRandomValues(new Uint32Array(1))[0] % 10000;
  return String(n).padStart(4, "0");
}

// Normalise a Ugandan phone to +256XXXXXXXXX for SMS delivery.
function normalizePhone(raw: string): string {
  let d = String(raw || "").replace(/\D/g, "");
  if (d.startsWith("0")) d = "256" + d.slice(1);
  if (!d.startsWith("256") && d.length === 9) d = "256" + d;
  return "+" + d;
}

// Yoola is the PRIMARY SMS sender; Africa's Talking is the fallback.
// Non-blocking: a failure here must never abort the session creation.
async function sendViaYoola(phone: string, message: string): Promise<{ ok: boolean; reason?: string }> {
  const apiKey = (Deno.env.get("YOOLA_SMS_API_KEY") || "").trim();
  if (!apiKey) return { ok: false, reason: "yoola_not_configured" };
  try {
    const res = await fetch("https://yoolasms.com/api/v1/send", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      // "WELILE" is the registered Yoola sender ID and must be set explicitly.
      body: JSON.stringify({ phone: String(phone || "").replace(/\D/g, ""), message, api_key: apiKey, sender: "WELILE" }),
    });
    const text = await res.text();
    let data: any = null;
    try { data = JSON.parse(text); } catch { /* keep raw text */ }
    const status = String(data?.status ?? "").toLowerCase();
    // Treat any successful HTTP response that Yoola did not explicitly reject as
    // "accepted" so Africa's Talking never double-sends after a real delivery.
    const accepted =
      res.ok &&
      (status === "success" || status === "ok" || status === "sent" || status === "queued" ||
        (!data?.error && status === ""));
    if (!accepted) return { ok: false, reason: `yoola_${res.status}_${status || "rejected"}` };
    // Acceptance is not delivery: the cash code is time-critical, so wait for
    // Yoola's delivery report and hand over to Africa's Talking if the handset
    // is not confirmed inside the window.
    const confirmation = await confirmYoolaDelivery(extractYoolaMessageId(data));
    if (confirmation.outcome === "delivered") return { ok: true };
    console.warn("[agent-cash-create] Yoola accepted but did not confirm delivery:", confirmation.detail);
    return { ok: false, reason: `yoola_unconfirmed_${confirmation.detail ?? confirmation.outcome}` };
  } catch (e) {
    console.error("[agent-cash-create] Yoola error:", e);
    return { ok: false, reason: "network_error" };
  }
}

async function sendViaAfricasTalking(phone: string, message: string): Promise<{ ok: boolean; reason?: string }> {
  const apiKey = Deno.env.get("AFRICASTALKING_API_KEY");
  const username = Deno.env.get("AFRICASTALKING_USERNAME");
  if (!apiKey || !username) {
    console.warn("[agent-cash-create] Missing Africa's Talking creds — skipping AT");
    return { ok: false, reason: "missing_credentials" };
  }
  const isSandbox = username.toLowerCase() === "sandbox";
  const baseUrl = isSandbox
    ? "https://api.sandbox.africastalking.com/version1/messaging"
    : "https://api.africastalking.com/version1/messaging";
  try {
    const params = new URLSearchParams({ username, from: "WELILE", to: phone, message });
    const res = await fetch(baseUrl, {
      method: "POST",
      headers: { apiKey, "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body: params.toString(),
    });
    return res.ok ? { ok: true } : { ok: false, reason: `at_http_${res.status}` };
  } catch (e) {
    console.error("[agent-cash-create] AT SMS error:", e);
    return { ok: false, reason: "network_error" };
  }
}

interface ProviderAttempt {
  provider: string;
  accepted: boolean;
  reason?: string;
  started_at: string;
  finished_at: string;
  attempted: boolean;
}
interface SmsOutcome {
  ok: boolean;
  reason?: string;
  provider?: string;
  attempts: ProviderAttempt[];
}
function wasSkipped(reason?: string): boolean {
  return reason === "missing_credentials" ||
    (typeof reason === "string" && reason.endsWith("not_configured"));
}

// Yoola (primary) → Africa's Talking (fallback), one at a time. Every attempt
// is timestamped so the delivery log proves there is never a double-send.
async function sendSms(phone: string, message: string): Promise<SmsOutcome> {
  const attempts: ProviderAttempt[] = [];
  const run = async (provider: string, fn: () => Promise<{ ok: boolean; reason?: string }>) => {
    const started_at = new Date().toISOString();
    const r = await fn();
    const finished_at = new Date().toISOString();
    attempts.push({ provider, accepted: r.ok, reason: r.reason, started_at, finished_at, attempted: !wasSkipped(r.reason) });
    return r;
  };
  const yoola = await run("yoola", () => sendViaYoola(phone, message));
  if (yoola.ok) return { ok: true, provider: "yoola", attempts };
  console.warn("[agent-cash-create] Yoola not accepted — falling back to Africa's Talking");
  const at = await run("africastalking", () => sendViaAfricasTalking(phone, message));
  if (at.ok) return { ok: true, provider: "africastalking", attempts };
  const reason = (yoola.reason && yoola.reason !== "yoola_not_configured") ? yoola.reason : at.reason;
  return { ok: false, reason, attempts };
}

async function logSmsAttempts(
  admin: ReturnType<typeof createClient>,
  ctx: { phone: string; message: string; userId?: string | null; name?: string | null; referenceId?: string | null; source: string },
  outcome: SmsOutcome,
): Promise<void> {
  try {
    if (!outcome.attempts.length) return;
    const rows = outcome.attempts.map((a, i) => ({
      recipient_phone: ctx.phone,
      recipient_user_id: ctx.userId ?? null,
      recipient_name: ctx.name ?? null,
      message: ctx.message,
      provider: a.provider,
      status: a.accepted ? "accepted" : (a.attempted ? "failed" : "skipped"),
      error: a.accepted ? null : (a.reason ?? null),
      reference_id: ctx.referenceId ?? null,
      source: ctx.source,
      provider_response: {
        attempt_sequence: i + 1,
        total_attempts: outcome.attempts.length,
        started_at: a.started_at,
        finished_at: a.finished_at,
        reason: a.reason ?? null,
        final_provider: outcome.provider ?? null,
        final_accepted: outcome.ok,
      },
    }));
    await admin.from("sms_delivery_log").insert(rows);
  } catch (e) {
    console.warn("[agent-cash-create] sms_delivery_log insert failed (non-critical):", e);
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const admin = createClient(supabaseUrl, serviceKey);

    const authHeader = req.headers.get("Authorization") ?? "";
    const token = authHeader.replace(/^Bearer\s+/i, "");
    const { data: authData, error: authErr } = await admin.auth.getUser(token);
    if (authErr || !authData?.user) return json(401, { error: "Unauthorized" });
    const depositor = authData.user;

    const body = await req.json().catch(() => ({}));
    const amount = Number(body?.amount);
    const agentPhoneRaw = typeof body?.agent_phone === "string" ? body.agent_phone.trim() : "";

    if (!Number.isFinite(amount) || amount <= 0) {
      return json(400, { error: "invalid_amount", message: "Enter a valid amount" });
    }
    if (amount < 500) {
      return json(400, { error: "amount_too_small", message: "Minimum cash deposit is UGX 500" });
    }
    // No upper cash deposit limit — deposits of any size are accepted.
    const phone9 = last9(agentPhoneRaw);
    if (phone9.length !== 9) {
      return json(400, { error: "invalid_phone", message: "Enter a valid agent phone number" });
    }

    // ── Resolve the agent by phone (try common stored formats) ──
    const candidates = [phone9, `0${phone9}`, `256${phone9}`, `+256${phone9}`];
    const { data: profileRows } = await admin
      .from("profiles")
      .select("id, full_name, phone")
      .in("phone", candidates);

    // Defensive: also match by normalised suffix in case stored format differs.
    let agentProfile = (profileRows ?? []).find((p: any) => last9(p.phone) === phone9) ?? null;
    if (!agentProfile) {
      return json(404, { error: "agent_not_found", message: "No Welile agent found with that phone number" });
    }

    if (agentProfile.id === depositor.id) {
      return json(400, { error: "self_deposit", message: "You cannot deposit cash to yourself" });
    }

    // Verify the resolved user actually holds the agent role.
    const { data: roleRows } = await admin
      .from("user_roles")
      .select("role")
      .eq("user_id", agentProfile.id);
    const isAgent = (roleRows ?? []).some((r: any) => r.role === "agent");
    if (!isAgent) {
      return json(400, { error: "not_an_agent", message: "That phone number does not belong to a Welile agent" });
    }

    // ── Float sufficiency: agent must have enough operational float ──
    const { data: floatData, error: floatErr } = await admin.rpc("get_agent_float_balance", {
      p_agent_id: agentProfile.id,
    });
    if (floatErr) {
      console.error("[agent-cash-create] float lookup failed", floatErr);
      return json(500, { error: "float_lookup_failed", message: "Could not verify the agent's float" });
    }
    const agentFloat = Number(floatData ?? 0);
    if (agentFloat < amount) {
      return json(400, {
        error: "insufficient_agent_float",
        message: "This agent does not have enough float to give you this amount right now.",
      });
    }

    // ── Block stacking: avoid multiple live pending sessions for same pair ──
    const { data: existing } = await admin
      .from("agent_cash_deposit_sessions")
      .select("id")
      .eq("depositor_id", depositor.id)
      .eq("agent_id", agentProfile.id)
      .eq("status", "pending")
      .gt("expires_at", new Date().toISOString())
      .limit(1);
    if (existing && existing.length > 0) {
      return json(409, {
        error: "session_in_progress",
        message: "You already have a pending cash deposit with this agent. Finish or cancel it first.",
        session_id: (existing[0] as any).id,
      });
    }

    const { data: depositorProfile } = await admin
      .from("profiles").select("full_name").eq("id", depositor.id).maybeSingle();

    const pin = gen4DigitPin();
    const expiresAt = new Date(Date.now() + 5 * 60 * 1000).toISOString();
    const { data: session, error: insErr } = await admin
      .from("agent_cash_deposit_sessions")
      .insert({
        depositor_id: depositor.id,
        depositor_name: depositorProfile?.full_name ?? depositor.email ?? "Welile user",
        agent_id: agentProfile.id,
        agent_phone: agentProfile.phone ?? agentPhoneRaw,
        amount,
        pin,
        status: "pending",
        expires_at: expiresAt,
      } as any)
      .select("id, expires_at")
      .single();

    if (insErr || !session) {
      console.error("[agent-cash-create] insert failed", insErr);
      return json(400, { error: "create_failed", message: insErr?.message || "Could not start the deposit" });
    }

    // ── Send the 4-digit confirmation code to the SELECTED agent's phone ──
    // The depositor searched & tapped this agent; the code is texted to that
    // exact number so the agent can confirm and release the cash. Float is
    // debited on confirm (agent-cash-deposit-confirm).
    const agentPhoneForSms = normalizePhone(agentProfile.phone ?? agentPhoneRaw);
    const smsBody = `Welile: ${depositorProfile?.full_name ?? "A user"} is collecting UGX ${amount.toLocaleString()} cash from your float. Confirmation code: ${pin}. Share it ONLY after handing over the cash. Your float will reduce by this amount.`;
    const smsOutcome = await sendSms(agentPhoneForSms, smsBody);
    await logSmsAttempts(admin, {
      phone: agentPhoneForSms,
      message: smsBody,
      userId: agentProfile.id,
      name: agentProfile.full_name ?? null,
      referenceId: (session as any).id ?? null,
      source: "agent-cash-deposit-create",
    }, smsOutcome);
    const smsSent = smsOutcome.ok;

    return json(200, {
      ok: true,
      session_id: (session as any).id,
      agent_name: agentProfile.full_name ?? "Welile agent",
      expires_at: (session as any).expires_at,
      sms_sent: smsSent,
    });
  } catch (e) {
    console.error("[agent-cash-create] error", e);
    return json(500, { error: "server_error", message: String((e as Error)?.message ?? e) });
  }
});