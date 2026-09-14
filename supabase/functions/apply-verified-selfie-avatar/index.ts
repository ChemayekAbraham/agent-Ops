// The moment Financial Ops verifies a payout destination, the person's stored
// verification selfie becomes their profile picture automatically.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

const FINANCE_ROLES = ["financial_ops", "cfo", "manager", "super_admin"];

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const adminClient = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    const authHeader = req.headers.get("authorization") || req.headers.get("Authorization") || "";
    if (!authHeader.startsWith("Bearer ")) return json({ error: "Unauthorized" }, 401);
    const { data: { user }, error: authError } = await adminClient.auth.getUser(
      authHeader.replace("Bearer ", ""),
    );
    if (authError || !user) return json({ error: "Unauthorized" }, 401);

    const body = await req.json().catch(() => null) as { userId?: string } | null;
    const targetId = (body?.userId || "").trim();
    if (!targetId) return json({ error: "userId is required" }, 400);

    // Only the holder themselves or Financial Ops may trigger this.
    if (targetId !== user.id) {
      const { data: roles } = await adminClient
        .from("user_roles")
        .select("role")
        .eq("user_id", user.id)
        .in("role", FINANCE_ROLES);
      if (!roles?.length) return json({ error: "Insufficient permissions" }, 403);
    }

    const { data: profile, error: profErr } = await adminClient
      .from("profiles")
      .select("selfie_photo_path, avatar_url")
      .eq("id", targetId)
      .maybeSingle();
    if (profErr) return json({ error: profErr.message }, 500);

    const selfiePath = profile?.selfie_photo_path;
    if (!selfiePath) return json({ skipped: "no_selfie" });

    // Prefer the crop the holder confirmed for their profile picture; fall back
    // to the stored original selfie when no crop was archived.
    let sourcePath = selfiePath;
    const { data: objects } = await adminClient.storage
      .from("identity-verification")
      .list(targetId, { limit: 100, sortBy: { column: "name", order: "desc" } });
    const crop = (objects ?? []).find((o) => o.name.startsWith("profile-crop-"));
    if (crop) sourcePath = `${targetId}/${crop.name}`;

    const { data: file, error: dlErr } = await adminClient.storage
      .from("identity-verification")
      .download(sourcePath);
    if (dlErr || !file) return json({ error: "Could not open the stored selfie." }, 400);

    const ext = (sourcePath.split(".").pop() || "jpg").toLowerCase();

    const avatarPath = `${targetId}/avatar.${ext}`;
    const { error: upErr } = await adminClient.storage
      .from("avatars")
      .upload(avatarPath, file, { upsert: true, contentType: file.type || "image/jpeg" });
    if (upErr) return json({ error: upErr.message }, 500);

    const { data: pub } = adminClient.storage.from("avatars").getPublicUrl(avatarPath);
    const avatarUrl = `${pub.publicUrl}?t=${Date.now()}`;

    const { error: updErr } = await adminClient
      .from("profiles")
      .update({ avatar_url: avatarUrl })
      .eq("id", targetId);
    if (updErr) return json({ error: updErr.message }, 500);

    await adminClient.from("audit_logs").insert({
      user_id: user.id,
      action_type: "verified_selfie_set_as_avatar",
      action: "Verified selfie applied as profile picture",
      table_name: "profiles",
      record_id: targetId,
      reason: "Selfie verified by Financial Ops; profile picture updated automatically",
      new_values: {
        selfie_path: selfiePath,
        avatar_path: avatarPath,
        avatar_url: avatarUrl,
        previous_avatar_url: profile?.avatar_url ?? null,
      },
      metadata: { source: "apply-verified-selfie-avatar" },
    });

    return json({ success: true, avatar_url: avatarUrl });
  } catch (e) {
    console.error("apply-verified-selfie-avatar failed", e);
    return json({ error: "Could not update the profile picture." }, 500);
  }
});
