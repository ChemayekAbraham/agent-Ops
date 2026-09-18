// Finance Operations decides on a request from an ID holder to remove someone
// attached to their National ID.
//
// The decision itself happens inside the SECURITY DEFINER RPC
// `decide_national_id_unlink` (approver-only; approval performs the removal and
// writes the in-app notice). This function only proves who is calling and then
// tells the removed person by SMS.
import "../_shared/smsFooterInterceptor.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { sendSMS } from "../_shared/sendSmsMultiProvider.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const token = req.headers.get("Authorization")?.replace(/^Bearer\s+/i, "");
    if (!token) return json({ error: "Unauthorized" }, 401);

    const adminClient = createClient(
      Deno.env.get("SUPABASE_URL") ?? "",
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
      { auth: { persistSession: false } },
    );

    const { data: userData, error: userErr } = await adminClient.auth.getUser(token);
    const caller = userData?.user;
    if (userErr || !caller) return json({ error: "Unauthorized" }, 401);

    let body: { request_id?: string; approve?: boolean; note?: string };
    try {
      body = await req.json();
    } catch {
      return json({ error: "Invalid request" }, 400);
    }

    const requestId = String(body.request_id ?? "").trim();
    const approve = body.approve === true;
    const note = String(body.note ?? "").trim();
    if (!/^[0-9a-f-]{36}$/i.test(requestId)) return json({ error: "Choose a removal request." }, 400);

    // Run the decision as the caller so the RPC's approver check applies to them.
    const userClient = createClient(
      Deno.env.get("SUPABASE_URL") ?? "",
      Deno.env.get("SUPABASE_ANON_KEY") ?? "",
      { global: { headers: { Authorization: `Bearer ${token}` } }, auth: { persistSession: false } },
    );

    const { data, error } = await userClient.rpc("decide_national_id_unlink", {
      p_request_id: requestId,
      p_approve: approve,
      p_note: note || null,
    });
    if (error) return json({ error: error.message }, 400);

    const res = (data ?? {}) as {
      success?: boolean;
      message?: string;
      status?: string;
      member_id?: string | null;
      member_phone?: string | null;
      masked_nin?: string | null;
      owner_name?: string | null;
    };
    if (!res.success) return json({ error: res.message ?? "Could not record that decision." }, 400);

    let smsSent = false;
    if (res.status === "approved" && res.member_phone) {
      const owner = res.owner_name || "the ID holder";
      const message =
        `Welile: ${owner} has removed your account from National ID ${res.masked_nin ?? ""}. ` +
        `You are no longer linked to it. Open the Welile app for details.`;
      try {
        smsSent = await sendSMS(res.member_phone, message, {
          admin: adminClient,
          source: "national-id-unlink",
          recipient_user_id: res.member_id ?? undefined,
          reference_id: `national-id-unlink:${requestId}`,
        });
      } catch (err) {
        console.error("[national-id-unlink] SMS failed", err);
      }
    }

    return json({ success: true, status: res.status ?? (approve ? "approved" : "rejected"), sms_sent: smsSent });
  } catch (err) {
    console.error("[national-id-unlink] error", err);
    return json({ error: (err as Error)?.message ?? "Unexpected error" }, 500);
  }
});
