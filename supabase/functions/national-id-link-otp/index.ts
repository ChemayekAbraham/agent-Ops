/**
 * National ID link request — code to the ID holder.
 *
 * The person asking to be linked never learns the holder's phone number: this
 * function resolves it server-side, has `sms-otp` send the code to it, and then
 * checks the code the asker types. Confirming the code is only half of the
 * consent — the holder must still answer Yes in the app.
 */
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const url = Deno.env.get("SUPABASE_URL")!;
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const admin = createClient(url, serviceKey);

    const token = (req.headers.get("Authorization") ?? "").replace("Bearer ", "");
    const { data: userData } = await admin.auth.getUser(token);
    const uid = userData?.user?.id;
    if (!uid) return json({ error: "Please sign in again." }, 401);

    let body: Record<string, unknown>;
    try {
      body = await req.json();
    } catch {
      return json({ error: "Invalid request body" }, 400);
    }

    const action = String(body.action ?? "");
    const requestId = String(body.request_id ?? "");
    if (!requestId) return json({ error: "Missing request." }, 400);

    // Resolves the holder's number for this request. Refuses when the request is
    // no longer open, so a closed or expired request can never be re-texted.
    const { data: target, error: targetError } = await admin.rpc("national_id_link_send_target", {
      p_request_id: requestId,
      p_requester_id: uid,
    });
    if (targetError) return json({ error: targetError.message }, 400);
    const t = (target ?? {}) as {
      success?: boolean; message?: string; phone?: string; requester_name?: string; nin?: string;
    };
    if (!t.success || !t.phone) return json({ error: t.message ?? "That request is closed." }, 400);

    if (action === "send") {
      const { data, error } = await admin.functions.invoke("sms-otp", {
        body: {
          action: "send",
          phone: t.phone,
          purpose: "national_id_link",
          subject_name: t.requester_name,
          nin_ref: t.nin,
        },
      });
      if (error) return json({ error: "Could not send the code. Please try again." }, 502);
      const res = (data ?? {}) as { success?: boolean; error?: string };
      if (!res.success) return json({ error: res.error ?? "Could not send the code." }, 502);

      // Only now is the code genuinely on its way, so only now is the request
      // marked as "code sent" — a failed send must not show a code box.
      await admin.rpc("national_id_link_mark_code_sent", {
        p_request_id: requestId,
        p_requester_id: uid,
      });
      return json({ success: true });
    }

    if (action === "verify") {
      const code = String(body.code ?? "").replace(/\D/g, "");
      if (code.length !== 6) return json({ error: "Enter the 6-digit code." }, 400);

      const { data, error } = await admin.functions.invoke("sms-otp", {
        body: { action: "verify", phone: t.phone, otp: code },
      });
      if (error) return json({ error: "Could not check that code. Please try again." }, 502);
      const res = (data ?? {}) as { success?: boolean; error?: string };
      if (!res.success) return json({ error: res.error ?? "That code is not right." }, 400);

      const { data: marked, error: markError } = await admin.rpc("national_id_link_mark_code_verified", {
        p_request_id: requestId,
        p_requester_id: uid,
      });
      if (markError) return json({ error: markError.message }, 400);
      const m = (marked ?? {}) as { success?: boolean; message?: string };
      if (!m.success) return json({ error: m.message ?? "That request is closed." }, 400);
      return json({ success: true });
    }

    return json({ error: "Invalid action. Use 'send' or 'verify'." }, 400);
  } catch (e) {
    console.error("[national-id-link-otp]", e);
    return json({ error: "Service temporarily unavailable" }, 500);
  }
});
