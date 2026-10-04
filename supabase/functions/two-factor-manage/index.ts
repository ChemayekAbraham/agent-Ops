// Turn two-step verification (2MFA) on or off for the calling user.
//
// Enable rules:
//   * The account MUST have a real inbox (synthetic phone placeholders rejected).
//   * The device that turns it on becomes the ONLY trusted device.
//   * Every other device session record is dropped; the client additionally
//     revokes the other auth sessions with signOut({ scope: 'others' }).
import { createClient } from "npm:@supabase/supabase-js@2";
import { isUnusableEmail, maskEmail } from "../_shared/twoFactorEmail.ts";

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
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  const admin = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  try {
    const token = (req.headers.get("Authorization") ?? "").replace("Bearer ", "");
    if (!token) return json({ error: "Not signed in" }, 401);
    const { data: userData, error: userErr } = await admin.auth.getUser(token);
    const user = userData?.user;
    if (userErr || !user) return json({ error: "Not signed in" }, 401);

    const body = await req.json().catch(() => ({}));
    const action = String(body?.action ?? "");
    const deviceId = String(body?.device_id ?? "").trim();
    const deviceLabel = String(body?.device_label ?? "").trim().slice(0, 60) || null;

    if (!deviceId) return json({ error: "Missing device id" }, 400);

    if (action === "enable") {
      // Resolve a usable inbox: prefer the auth email, fall back to the profile.
      let email = user.email ?? null;
      if (isUnusableEmail(email)) {
        const { data: profile } = await admin
          .from("profiles")
          .select("email")
          .eq("id", user.id)
          .maybeSingle();
        email = profile?.email ?? null;
      }
      if (isUnusableEmail(email)) {
        return json(
          {
            error:
              "Add a real email address to your account before turning on two-step verification. Codes cannot be sent to a placeholder address.",
            code: "no_email",
          },
          400,
        );
      }

      const { error: upErr } = await admin.from("user_two_factor").upsert(
        {
          user_id: user.id,
          enabled: true,
          email: email!.toLowerCase(),
          enabled_at: new Date().toISOString(),
          enabled_device_id: deviceId,
          disabled_at: null,
          updated_at: new Date().toISOString(),
        },
        { onConflict: "user_id" },
      );
      if (upErr) return json({ error: upErr.message }, 500);

      // Only this device stays trusted.
      await admin
        .from("user_2fa_trusted_devices")
        .delete()
        .eq("user_id", user.id)
        .neq("device_id", deviceId);
      await admin.from("user_2fa_trusted_devices").upsert(
        {
          user_id: user.id,
          device_id: deviceId,
          device_label: deviceLabel,
          approved_at: new Date().toISOString(),
          last_verified_at: new Date().toISOString(),
        },
        { onConflict: "user_id,device_id" },
      );

      // Drop the other device session records so the UI reflects the sign-out.
      const { count: removed } = await admin
        .from("user_device_sessions")
        .delete({ count: "exact" })
        .eq("user_id", user.id)
        .neq("device_id", deviceId);

      return json({
        success: true,
        enabled: true,
        email_masked: maskEmail(email!),
        devices_signed_out: removed ?? 0,
      });
    }

    if (action === "disable") {
      // Only a trusted device may switch protection off.
      const { data: trusted } = await admin
        .from("user_2fa_trusted_devices")
        .select("id")
        .eq("user_id", user.id)
        .eq("device_id", deviceId)
        .maybeSingle();
      const { data: config } = await admin
        .from("user_two_factor")
        .select("enabled")
        .eq("user_id", user.id)
        .maybeSingle();
      if (config?.enabled && !trusted) {
        return json(
          { error: "Only a verified device can turn two-step verification off." },
          403,
        );
      }

      const { error: offErr } = await admin
        .from("user_two_factor")
        .update({
          enabled: false,
          disabled_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        })
        .eq("user_id", user.id);
      if (offErr) return json({ error: offErr.message }, 500);

      await admin.from("user_2fa_trusted_devices").delete().eq("user_id", user.id);
      return json({ success: true, enabled: false });
    }

    return json({ error: "Unknown action" }, 400);
  } catch (err) {
    console.error("[two-factor-manage] failed:", err);
    return json({ error: (err as Error)?.message ?? "Unexpected error" }, 500);
  }
});
