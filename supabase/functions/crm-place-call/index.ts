// CRM Call Centre — place an outbound call through Africa's Talking Voice.
//
// Agent-leg-first bridge: AT rings the CRM staff member's OWN phone, and when
// they answer `crm-voice-callback` returns <Dial> XML that bridges the leg to
// the customer. Staff therefore need no softphone or headset — their existing
// handset is the console — and the customer sees the platform's AT number
// rather than a personal one.
//
// Requires three secrets:
//   AFRICASTALKING_API_KEY       — same key already used by the SMS functions
//   AFRICASTALKING_USERNAME      — "sandbox" switches to the sandbox host
//   AFRICASTALKING_VOICE_NUMBER  — a voice-capable AT number, used as `from`
//
// AT must also have this project's `crm-voice-callback` URL set as the Voice
// Callback for that number, or the answered leg will simply hang up.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { toUgandaE164 } from "../_shared/ugandaPhone.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

// Mirrors the SELECT policy on `crm_call_sessions`.
//
// `agent_ops` / `tenant_ops` / `landlord_ops` / `partner_ops` are REAL roles in
// the production `app_role` enum (41 staff hold them) even though the client-side
// `AppRole` union in src/hooks/auth/types.ts does not list them yet. Omitting
// them here would 403 exactly the people the call centre is for.
const ALLOWED_ROLES = [
  "crm",
  "operations", "agent_ops", "tenant_ops", "landlord_ops", "partner_ops",
  "manager", "super_admin", "coo", "ceo", "cto",
];

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });

/** AT wants +2567XXXXXXXX; the shared helper returns bare 2567XXXXXXXX. */
const plus = (e164: string) => `+${e164}`;

interface AtCallEntry {
  phoneNumber?: string;
  status?: string;
  sessionId?: string;
}

async function placeAtCall(staffE164: string): Promise<{
  ok: boolean;
  sessionId: string | null;
  atStatus: string | null;
  reason?: string;
  raw: unknown;
}> {
  const apiKey = Deno.env.get("AFRICASTALKING_API_KEY");
  const username = Deno.env.get("AFRICASTALKING_USERNAME");
  const voiceNumber = Deno.env.get("AFRICASTALKING_VOICE_NUMBER");

  if (!apiKey || !username) {
    return { ok: false, sessionId: null, atStatus: null, reason: "missing_africastalking_credentials", raw: null };
  }
  if (!voiceNumber) {
    return {
      ok: false,
      sessionId: null,
      atStatus: null,
      // Distinct from missing credentials: SMS works without a voice number, so
      // this is the one secret an SMS-only deployment will not already have.
      reason: "missing_voice_number",
      raw: null,
    };
  }

  const isSandbox = username.toLowerCase() === "sandbox";
  const url = isSandbox
    ? "https://voice.sandbox.africastalking.com/call"
    : "https://voice.africastalking.com/call";

  const body = new URLSearchParams({
    username,
    from: voiceNumber.startsWith("+") ? voiceNumber : `+${voiceNumber.replace(/\D/g, "")}`,
    to: plus(staffE164),
  });

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        apiKey,
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body: body.toString(),
    });

    const text = await res.text();
    let parsed: any = null;
    try { parsed = JSON.parse(text); } catch { /* keep raw */ }

    const entry: AtCallEntry = parsed?.entries?.[0] ?? {};
    const atStatus = entry.status ?? null;
    // AT returns HTTP 200 with a per-entry status; "Queued" is the only accept.
    const accepted = res.ok && String(atStatus).toLowerCase() === "queued";

    return {
      ok: accepted,
      sessionId: entry.sessionId ?? null,
      atStatus,
      reason: accepted
        ? undefined
        : (parsed?.errorMessage && parsed.errorMessage !== "None"
            ? String(parsed.errorMessage)
            : `at_status_${atStatus ?? res.status}`),
      raw: parsed ?? text,
    };
  } catch (e) {
    return {
      ok: false,
      sessionId: null,
      atStatus: null,
      reason: e instanceof Error ? e.message : "at_voice_network_error",
      raw: null,
    };
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) return json({ error: "Missing auth" }, 401);

    const admin = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    const token = authHeader.replace("Bearer ", "");
    const { data: userData, error: userErr } = await admin.auth.getUser(token);
    if (userErr || !userData?.user) return json({ error: "Unauthorized" }, 401);
    const caller = userData.user;

    // `enabled` matters: a revoked role keeps its user_roles row, so omitting
    // this filter would let a stood-down staff member keep placing calls.
    // `has_role()` and `is_ops_role()` both filter on it, so this matches the
    // RLS policy guarding the same table.
    const { data: callerRoles } = await admin
      .from("user_roles").select("role").eq("user_id", caller.id).eq("enabled", true);
    const allowed = (callerRoles || []).some((r: any) => ALLOWED_ROLES.includes(r.role));
    if (!allowed) return json({ error: "Insufficient permissions" }, 403);

    const body = await req.json().catch(() => ({}));
    const targetUserId: string | null = body.target_user_id ? String(body.target_user_id) : null;

    // --- Resolve the staff leg -------------------------------------------------
    // An explicit staff_phone lets someone take the call on a different handset
    // (e.g. a desk phone) without editing their profile.
    let staffPhoneRaw: string | null = body.staff_phone ? String(body.staff_phone) : null;
    let staffName: string | null = null;
    {
      const { data: prof } = await admin
        .from("profiles").select("full_name, phone").eq("id", caller.id).maybeSingle();
      staffName = prof?.full_name ?? null;
      if (!staffPhoneRaw) staffPhoneRaw = prof?.phone ?? null;
    }
    const staffE164 = toUgandaE164(staffPhoneRaw);
    if (!staffE164) {
      return json({
        error: "Your own phone number is missing or invalid, so we cannot ring you first.",
        code: "invalid_staff_phone",
      }, 422);
    }

    // --- Resolve the customer leg ---------------------------------------------
    let targetPhoneRaw: string | null = body.target_phone ? String(body.target_phone) : null;
    let targetName: string | null = body.target_name ? String(body.target_name) : null;
    let targetRole: string | null = body.target_role ? String(body.target_role) : null;

    if (targetUserId) {
      const { data: prof } = await admin
        .from("profiles").select("full_name, phone").eq("id", targetUserId).maybeSingle();
      if (!prof) return json({ error: "That user no longer exists.", code: "target_not_found" }, 404);
      if (!targetPhoneRaw) targetPhoneRaw = prof.phone ?? null;
      targetName = targetName ?? prof.full_name ?? null;

      if (!targetRole) {
        const { data: roles } = await admin
          .from("user_roles").select("role").eq("user_id", targetUserId).eq("enabled", true);
        const held = (roles || []).map((r: any) => r.role);
        // Prefer the public-facing persona over any staff role they also hold.
        targetRole = ["tenant", "landlord", "supporter", "agent"].find((r) => held.includes(r))
          ?? held[0] ?? null;
      }
    }

    const targetE164 = toUgandaE164(targetPhoneRaw);
    if (!targetE164) {
      return json({
        error: "That person has no valid Ugandan phone number on file.",
        code: "invalid_target_phone",
      }, 422);
    }

    if (targetE164 === staffE164) {
      return json({
        error: "The customer number matches your own — the call would dial itself.",
        code: "self_call",
      }, 422);
    }

    // --- Record the intent BEFORE calling AT ---------------------------------
    // Written first so a call that AT accepts but never calls back on is still
    // visible as a stuck row rather than vanishing.
    const { data: session, error: insErr } = await admin
      .from("crm_call_sessions")
      .insert({
        staff_id: caller.id,
        staff_phone: staffE164,
        target_user_id: targetUserId,
        target_role: targetRole,
        target_name: targetName,
        target_phone: targetE164,
        status: "initiating",
      })
      .select("id")
      .single();

    if (insErr || !session) {
      console.error("[crm-place-call] could not open session:", insErr);
      return json({ error: "Could not open a call session." }, 500);
    }

    const at = await placeAtCall(staffE164);

    const failureMessage =
      at.reason === "missing_voice_number"
        ? "No Africa's Talking voice number is configured (AFRICASTALKING_VOICE_NUMBER)."
        : at.reason === "missing_africastalking_credentials"
          ? "Africa's Talking credentials are not configured."
          : null;

    await admin
      .from("crm_call_sessions")
      .update({
        at_session_id: at.sessionId,
        at_call_status: at.atStatus,
        status: at.ok ? "queued" : "failed",
        failure_reason: at.ok ? null : (at.reason ?? "at_call_rejected"),
      })
      .eq("id", session.id);

    try {
      await admin.from("audit_logs").insert({
        user_id: caller.id,
        action_type: "crm_call_placed",
        table_name: "crm_call_sessions",
        record_id: session.id,
        metadata: {
          staff_name: staffName,
          staff_phone: staffE164,
          target_user_id: targetUserId,
          target_role: targetRole,
          target_phone: targetE164,
          at_session_id: at.sessionId,
          at_status: at.atStatus,
          accepted: at.ok,
          failure_reason: at.ok ? null : at.reason,
        },
      });
    } catch (logErr) {
      console.warn("[crm-place-call] audit log failed:", logErr);
    }

    if (!at.ok) {
      return json({
        error: failureMessage ?? "Africa's Talking would not place the call.",
        code: at.reason ?? "at_call_rejected",
        session_id: session.id,
        at_detail: at.raw,
      }, 502);
    }

    return json({
      ok: true,
      session_id: session.id,
      at_session_id: at.sessionId,
      // The UI tells the user to expect their own phone to ring — without this
      // the flow looks broken, because nothing happens on screen.
      ringing: staffE164,
      then_dialing: targetE164,
      message: `Your phone (${plus(staffE164)}) is ringing. Answer it and we will connect ${targetName ?? plus(targetE164)}.`,
    });
  } catch (err) {
    console.error("[crm-place-call] Error:", err);
    return json({ error: (err as Error).message }, 500);
  }
});
