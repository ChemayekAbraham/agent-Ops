import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const admin = createClient(supabaseUrl, serviceKey);

    // ---- AuthN: caller must be logged in ----
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) return json({ error: "Unauthorized" }, 401);
    const { data: { user: caller }, error: authErr } = await admin.auth.getUser(
      authHeader.replace("Bearer ", "")
    );
    if (authErr || !caller) return json({ error: "Unauthorized" }, 401);

    // ---- AuthZ: manager role required ----
    const { data: roles } = await admin
      .from("user_roles")
      .select("role")
      .eq("user_id", caller.id)
      .eq("role", "manager")
      .eq("enabled", true);
    if (!roles || roles.length === 0) {
      return json({ error: "Forbidden: Manager role required" }, 403);
    }

    const body = await req.json().catch(() => ({}));
    const user_id = body?.user_id as string | undefined;
    const reasonRaw = (body?.reason ?? "").toString().trim();
    const overrideEmail = (body?.email ?? "").toString().trim() || undefined;
    const overridePhone = (body?.phone ?? "").toString().trim() || undefined;

    if (!user_id || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(user_id)) {
      return json({ error: "Valid user_id is required" }, 400);
    }
    if (reasonRaw.length < 10) {
      return json({ error: "Reason must be at least 10 characters" }, 400);
    }

    // ---- Read profile to recover the original email/phone (auth.users values are scrambled) ----
    const { data: profile, error: profileErr } = await admin
      .from("profiles")
      .select("id, full_name, email, phone, tenant_status")
      .eq("id", user_id)
      .maybeSingle();
    if (profileErr) return json({ error: profileErr.message }, 500);
    if (!profile) return json({ error: "Profile not found for that user_id" }, 404);

    const restoredName = (profile.full_name || "").replace(/^\[ARCHIVED\]\s*/i, "").trim() || "Restored User";
    const restoredEmail = overrideEmail || profile.email || undefined;
    const restoredPhone = overridePhone || profile.phone || undefined;

    if (!restoredEmail && !restoredPhone) {
      return json({
        error: "Cannot restore: profile has no original email or phone. Pass `email` or `phone` in the request body to set them.",
      }, 400);
    }

    // ---- 1. Clear auth.users.deleted_at + banned_until ----
    const { data: clearRes, error: clearErr } = await admin.rpc("admin_restore_auth_user", {
      p_user_id: user_id,
    });
    if (clearErr) return json({ error: `Clear deleted_at failed: ${clearErr.message}` }, 500);
    if (!(clearRes as any)?.ok) {
      return json({ error: `Restore failed: ${(clearRes as any)?.reason || "unknown"}` }, 500);
    }

    // ---- 2. Restore email + phone on auth.users via admin SDK ----
    const updates: Record<string, unknown> = {};
    if (restoredEmail) { updates.email = restoredEmail; updates.email_confirm = true; }
    if (restoredPhone) { updates.phone = restoredPhone; updates.phone_confirm = true; }

    const { error: updErr } = await admin.auth.admin.updateUserById(user_id, updates);
    if (updErr) {
      // Common cause: email/phone already taken by another live auth account.
      return json({
        error: `Auth identity restore failed: ${updErr.message}. The original email/phone may already belong to another account — pass a different \`email\` or \`phone\` in the request.`,
      }, 409);
    }

    // ---- 3. Un-archive the profile ----
    const { error: profUpdErr } = await admin
      .from("profiles")
      .update({
        full_name: restoredName,
        tenant_status: profile.tenant_status === "inactive" ? "active" : profile.tenant_status,
        email: restoredEmail ?? profile.email,
        phone: restoredPhone ?? profile.phone,
      })
      .eq("id", user_id);
    if (profUpdErr) {
      console.warn("Profile un-archive failed:", profUpdErr);
    }

    // ---- 4. Audit log ----
    await admin.from("audit_logs").insert({
      user_id: caller.id,
      action_type: "account_restored",
      table_name: "auth.users",
      record_id: user_id,
      metadata: {
        reason: reasonRaw,
        restored_name: restoredName,
        restored_email: restoredEmail,
        restored_phone: restoredPhone,
        previous_deleted_at: (clearRes as any)?.previous_deleted_at,
      },
    });

    // ---- 5. Verification: read back auth.users + profiles and compare ----
    const verification: {
      ok: boolean;
      mismatches: Array<{ field: string; auth: unknown; profile: unknown; note?: string }>;
      auth: { email: string | null; phone: string | null; deleted_at: string | null; banned_until: string | null };
      profile: { full_name: string | null; email: string | null; phone: string | null };
    } = {
      ok: true,
      mismatches: [],
      auth: { email: null, phone: null, deleted_at: null, banned_until: null },
      profile: { full_name: null, email: null, phone: null },
    };

    try {
      const norm = (v: unknown) =>
        v == null ? null : String(v).trim().toLowerCase().replace(/^\+/, "");

      const { data: authRead, error: authReadErr } = await admin.auth.admin.getUserById(user_id);
      const { data: profRead, error: profReadErr } = await admin
        .from("profiles")
        .select("full_name, email, phone")
        .eq("id", user_id)
        .maybeSingle();

      if (authReadErr || !authRead?.user) {
        verification.ok = false;
        verification.mismatches.push({
          field: "auth.user",
          auth: null,
          profile: profRead ?? null,
          note: `Could not read back auth user: ${authReadErr?.message || "not found"}`,
        });
      } else {
        const au = authRead.user as any;
        verification.auth = {
          email: au.email ?? null,
          phone: au.phone ?? null,
          deleted_at: au.deleted_at ?? null,
          banned_until: au.banned_until ?? null,
        };
        verification.profile = {
          full_name: profRead?.full_name ?? null,
          email: profRead?.email ?? null,
          phone: profRead?.phone ?? null,
        };

        // Still soft-deleted?
        if (au.deleted_at) {
          verification.ok = false;
          verification.mismatches.push({
            field: "deleted_at",
            auth: au.deleted_at,
            profile: null,
            note: "auth.users.deleted_at is still set after restore",
          });
        }
        // Still banned?
        if (au.banned_until && new Date(au.banned_until).getTime() > Date.now()) {
          verification.ok = false;
          verification.mismatches.push({
            field: "banned_until",
            auth: au.banned_until,
            profile: null,
            note: "auth.users.banned_until is still in the future",
          });
        }
        // Email mismatch (auth vs profile)
        if (norm(au.email) !== norm(profRead?.email)) {
          verification.ok = false;
          verification.mismatches.push({
            field: "email",
            auth: au.email ?? null,
            profile: profRead?.email ?? null,
          });
        }
        // Phone mismatch
        if (norm(au.phone) !== norm(profRead?.phone)) {
          verification.ok = false;
          verification.mismatches.push({
            field: "phone",
            auth: au.phone ?? null,
            profile: profRead?.phone ?? null,
          });
        }
        // Scrambled-token detection (archive scramble produced long base64-ish blobs)
        const looksScrambled = (s: string | null | undefined) =>
          !!s && /^[A-Za-z0-9_-]{20,}$/.test(s) && !s.includes("@");
        if (looksScrambled(au.email)) {
          verification.ok = false;
          verification.mismatches.push({
            field: "email",
            auth: au.email,
            profile: profRead?.email ?? null,
            note: "auth.users.email still looks like an archive scramble token",
          });
        }
        if (looksScrambled(au.phone)) {
          verification.ok = false;
          verification.mismatches.push({
            field: "phone",
            auth: au.phone,
            profile: profRead?.phone ?? null,
            note: "auth.users.phone still looks like an archive scramble token",
          });
        }
        // Profile still flagged as archived
        if ((profRead?.full_name || "").toUpperCase().startsWith("[ARCHIVED]")) {
          verification.ok = false;
          verification.mismatches.push({
            field: "full_name",
            auth: null,
            profile: profRead?.full_name ?? null,
            note: "profiles.full_name still carries [ARCHIVED] prefix",
          });
        }
      }

      if (profReadErr) {
        verification.ok = false;
        verification.mismatches.push({
          field: "profile",
          auth: verification.auth,
          profile: null,
          note: `Could not read profile: ${profReadErr.message}`,
        });
      }

      // Persist verification result alongside the audit row for traceability
      await admin.from("audit_logs").insert({
        user_id: caller.id,
        action_type: verification.ok ? "account_restore_verified" : "account_restore_verification_failed",
        table_name: "auth.users",
        record_id: user_id,
        metadata: {
          reason: `Auto-verification after restore (${reasonRaw.slice(0, 80)})`,
          verification,
        },
      });
    } catch (verr) {
      console.warn("Post-restore verification crashed:", verr);
      verification.ok = false;
      verification.mismatches.push({
        field: "_runner",
        auth: null,
        profile: null,
        note: verr instanceof Error ? verr.message : "Verification step crashed",
      });
    }

    return json({
      success: true,
      user_id,
      restored_name: restoredName,
      restored_email: restoredEmail,
      restored_phone: restoredPhone,
      previous_deleted_at: (clearRes as any)?.previous_deleted_at,
      verification,
    });
  } catch (e) {
    console.error("restore-archived-account error:", e);
    return json({ error: e instanceof Error ? e.message : "Unknown error" }, 500);
  }
});