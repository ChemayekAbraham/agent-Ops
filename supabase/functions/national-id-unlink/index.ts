// The holder of a National ID removes someone else attached to it.
// The removal itself happens inside the SECURITY DEFINER RPC (owner-only,
// written reason required); this function only proves who is calling and
// then tells the removed person by SMS. The in-app dialog is driven by the
// notice row the RPC writes.
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

    let body: { member_id?: string; reason?: string };
    try {
      body = await req.json();
    } catch {
      return json({ error: "Invalid request" }, 400);
    }

    const memberId = String(body.member_id ?? "").trim();
    const reason = String(body.reason ?? "").trim();
    if (!/^[0-9a-f-]{36}$/i.test(memberId)) return json({ error: "Choose someone on the ID." }, 400);
    if (reason.length < 10) {
      return json({ error: "Please write a short reason (at least 10 characters)." }, 400);
    }

    // Run the removal as the caller so the RPC's owner check applies to them.
    const userClient = createClient(
      Deno.env.get("SUPABASE_URL") ?? "",
      Deno.env.get("SUPABASE_ANON_KEY") ?? "",
      { global: { headers: { Authorization: `Bearer ${token}` } }, auth: { persistSession: false } },
    );

    const { data, error } = await userClient.rpc("national_id_unlink_member", {
      p_member_id: memberId,
      p_reason: reason,
    });
    if (error) return json({ error: error.message }, 400);

    const res = (data ?? {}) as {
      success?: boolean;
      message?: string;
      member_phone?: string | null;
      masked_nin?: string | null;
      owner_name?: string | null;
    };
    if (!res.success) return json({ error: res.message ?? "Could not remove that person." }, 400);

    let smsSent = false;
    if (res.member_phone) {
      const owner = res.owner_name || "the ID holder";
      const message =
        `Welile: ${owner} has removed your account from National ID ${res.masked_nin ?? ""}. ` +
        `You are no longer linked to it. Open the Welile app for details.`;
      try {
        smsSent = await sendSMS(res.member_phone, message, {
          source: "national-id-unlink",
          userId: memberId,
        } as never);
      } catch (err) {
        console.error("[national-id-unlink] SMS failed", err);
      }
    }

    return json({ success: true, sms_sent: smsSent });
  } catch (err) {
    console.error("[national-id-unlink] error", err);
    return json({ error: (err as Error)?.message ?? "Unexpected error" }, 500);
  }
});
