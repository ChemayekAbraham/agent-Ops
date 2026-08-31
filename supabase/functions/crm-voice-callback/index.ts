// CRM Call Centre — Africa's Talking Voice callback.
//
// AT posts here twice per call placed by `crm-place-call`:
//
//   1. isActive=1  — the CRM staff member has answered their own phone. We reply
//                    with <Dial> XML, which bridges the leg to the customer.
//   2. isActive=0  — the call is over. We record duration, cost, hangup cause
//                    and (when recording is enabled) the recording URL.
//
// This endpoint is PUBLIC — AT sends no JWT, so `verify_jwt = false` in
// config.toml. It is therefore written to be safe when called by anyone: it
// only ever acts on a sessionId that already exists in `crm_call_sessions`,
// and it never dials a number supplied in the request. The number it bridges to
// comes from the stored row, written earlier by the authenticated
// `crm-place-call`. An unknown sessionId gets an empty hangup response.
//
// Set this function's URL as the Voice Callback for the AT number named by
// AFRICASTALKING_VOICE_NUMBER, or answered calls will hang up immediately.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const xml = (body: string) =>
  new Response(`<?xml version="1.0" encoding="UTF-8"?>\n${body}`, {
    status: 200,
    headers: { ...corsHeaders, "Content-Type": "application/xml" },
  });

/** Nothing to bridge — say so and end the leg rather than leaving dead air. */
const rejectXml = (spoken: string) =>
  xml(`<Response><Say voice="woman">${escapeXml(spoken)}</Say><Reject/></Response>`);

function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/**
 * Call recording is OFF unless CRM_CALL_RECORDING=true.
 *
 * Deliberate default: the <Say> below is heard only by the staff member, who is
 * already connected — the customer joins at <Dial> and would never hear a
 * recording notice. Recording both parties without notifying the customer is a
 * consent problem, so enabling this flag should come with a spoken notice to
 * the customer (or an IVR preamble on the customer leg).
 */
const recordingEnabled = () =>
  (Deno.env.get("CRM_CALL_RECORDING") ?? "").toLowerCase() === "true";

async function readParams(req: Request): Promise<Record<string, string>> {
  const contentType = req.headers.get("content-type") ?? "";
  const raw = await req.text();
  const out: Record<string, string> = {};

  if (contentType.includes("application/json")) {
    try {
      const parsed = JSON.parse(raw);
      for (const [k, v] of Object.entries(parsed ?? {})) out[k] = String(v ?? "");
      return out;
    } catch { /* fall through to form parsing */ }
  }

  for (const [k, v] of new URLSearchParams(raw).entries()) out[k] = v;
  return out;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const p = await readParams(req);

    const sessionId = p.sessionId ?? p.sessionid ?? "";
    const isActive = String(p.isActive ?? p.isactive ?? "").trim();
    const destinationNumber = p.destinationNumber ?? p.destinationnumber ?? "";

    console.log("[crm-voice-callback]", {
      sessionId,
      isActive,
      destinationNumber,
      hangupCause: p.hangupCause ?? null,
      durationInSeconds: p.durationInSeconds ?? null,
    });

    const admin = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    // --- Locate the session --------------------------------------------------
    // Primary key is AT's sessionId, written by crm-place-call. The fallback
    // covers the case where AT's /call response omitted a sessionId: match the
    // newest still-live leg for the number AT says it is talking to.
    let row: {
      id: string;
      target_phone: string;
      target_name: string | null;
      status: string;
    } | null = null;

    if (sessionId) {
      const { data } = await admin
        .from("crm_call_sessions")
        .select("id, target_phone, target_name, status")
        .eq("at_session_id", sessionId)
        .maybeSingle();
      row = data ?? null;
    }

    if (!row && destinationNumber) {
      const bare = destinationNumber.replace(/\D/g, "");
      const { data } = await admin
        .from("crm_call_sessions")
        .select("id, target_phone, target_name, status")
        .eq("staff_phone", bare)
        .in("status", ["initiating", "queued", "ringing_staff"])
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      row = data ?? null;

      // Adopt the sessionId so the terminal callback matches on the fast path.
      if (row && sessionId) {
        await admin.from("crm_call_sessions")
          .update({ at_session_id: sessionId }).eq("id", row.id);
      }
    }

    // --- Terminal callback ---------------------------------------------------
    if (isActive !== "1") {
      if (!row) return new Response("", { status: 200, headers: corsHeaders });

      const duration = Number.parseInt(p.durationInSeconds ?? "", 10);
      const hasDuration = Number.isFinite(duration) && duration > 0;
      const amount = Number.parseFloat(p.amount ?? "");

      // Talk time is the only honest signal that the two legs actually met. A
      // zero-duration call is "not reached" regardless of the hangup cause,
      // which is kept in `hangup_cause` for diagnosis.
      const status = hasDuration ? "completed" : "no_answer";

      await admin
        .from("crm_call_sessions")
        .update({
          status,
          duration_seconds: hasDuration ? duration : 0,
          hangup_cause: p.hangupCause ?? null,
          recording_url: p.recordingUrl || null,
          cost_amount: Number.isFinite(amount) ? amount : null,
          cost_currency: p.currencyCode || null,
          at_call_status: p.callSessionState || p.status || null,
        })
        .eq("id", row.id);

      return new Response("", { status: 200, headers: corsHeaders });
    }

    // --- Staff answered: bridge to the customer ------------------------------
    if (!row) {
      // Someone (or AT, for an unrelated number) hit this endpoint with no
      // matching session. Never dial anything in this case.
      console.warn("[crm-voice-callback] no session for", { sessionId, destinationNumber });
      return rejectXml("This number does not accept incoming calls. Goodbye.");
    }

    await admin
      .from("crm_call_sessions")
      .update({ status: "bridged" })
      .eq("id", row.id);

    const customer = `+${row.target_phone.replace(/\D/g, "")}`;
    const who = row.target_name ? ` to ${row.target_name}` : "";
    const record = recordingEnabled() ? ' record="true"' : "";

    return xml(
      `<Response>` +
        `<Say voice="woman">${escapeXml(`Welile call centre. Connecting you${who} now.`)}</Say>` +
        // maxDuration caps runaway cost if a leg is left open.
        `<Dial phoneNumbers="${escapeXml(customer)}"${record} maxDuration="1800"/>` +
      `</Response>`,
    );
  } catch (err) {
    console.error("[crm-voice-callback] Error:", err);
    // Must still be valid XML, or AT drops the call with dead air.
    return rejectXml("We could not connect this call. Goodbye.");
  }
});
