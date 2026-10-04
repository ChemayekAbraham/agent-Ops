import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const SIGNED_URL_TTL_SECONDS = 60 * 60 * 24 * 7;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  const adminClient = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  try {
    // Auth — staff only (manager OR cto)
    const authHeader = req.headers.get("Authorization") ?? "";
    const token = authHeader.replace("Bearer ", "");
    const { data: userRes, error: userErr } = await adminClient.auth.getUser(token);
    if (userErr || !userRes?.user) {
      return new Response(JSON.stringify({ error: "unauthorized" }), {
        status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    const { data: roleRows } = await adminClient
      .from("user_roles").select("role").eq("user_id", userRes.user.id);
    const roles = (roleRows ?? []).map((r: any) => r.role);
    if (!roles.includes("manager") && !roles.includes("cto")) {
      return new Response(JSON.stringify({ error: "forbidden" }), {
        status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const body = await req.json().catch(() => ({}));
    const recipients: string[] = Array.isArray(body.recipients) && body.recipients.length
      ? body.recipients
      : ["joshwanda17@gmail.com", "weliletechnologies@gmail.com"];
    const note: string | undefined = typeof body.note === "string" ? body.note : "Re-sent after a delivery issue was reported.";
    let storagePath: string | undefined = body.storagePath;

    // If no path provided, pick the most recent successful run
    if (!storagePath) {
      const { data: latest, error: lErr } = await adminClient
        .from("backup_runs")
        .select("storage_path,size_bytes,created_at,status")
        .eq("status", "success")
        .eq("backup_kind", "full_database")
        .not("storage_path", "is", null)
        .order("created_at", { ascending: false })
        .limit(1).maybeSingle();
      if (lErr || !latest?.storage_path) {
        return new Response(JSON.stringify({ error: "No completed backup found" }), {
          status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      storagePath = latest.storage_path as string;
    }

    // Resolve metadata for the chosen path
    const { data: runMeta } = await adminClient
      .from("backup_runs")
      .select("size_bytes,created_at")
      .eq("storage_path", storagePath)
      .order("created_at", { ascending: false })
      .limit(1).maybeSingle();

    const sizeBytes = Number(runMeta?.size_bytes ?? 0);
    const sizeMb = (sizeBytes / (1024 * 1024)).toFixed(2);
    const generatedAt = (runMeta?.created_at as string) ?? new Date().toISOString();
    const fileName = storagePath.split("/").pop() ?? "welile_export.sql";

    const { data: signed, error: signErr } = await adminClient.storage
      .from("db-backups")
      .createSignedUrl(storagePath, SIGNED_URL_TTL_SECONDS);
    if (signErr || !signed) {
      return new Response(JSON.stringify({ error: signErr?.message ?? "sign failed" }), {
        status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const sent: { email: string; ok: boolean; error?: string }[] = [];
    for (const email of recipients) {
      try {
        const { error: invErr } = await adminClient.functions.invoke("send-transactional-email", {
          body: {
            templateName: "database-backup-link",
            recipientEmail: email,
            idempotencyKey: `db-backup-resend-${stamp}-${email}`,
            templateData: {
              downloadUrl: signed.signedUrl,
              fileName,
              sizeMb,
              generatedAt,
              expiresInHours: 168,
              note,
            },
          },
        });
        if (invErr) sent.push({ email, ok: false, error: String(invErr.message ?? invErr) });
        else sent.push({ email, ok: true });
      } catch (e: any) {
        sent.push({ email, ok: false, error: String(e?.message ?? e) });
      }
    }

    return new Response(JSON.stringify({
      success: true,
      storagePath,
      fileName,
      signedUrl: signed.signedUrl,
      sent,
    }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return new Response(JSON.stringify({ success: false, error: msg }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});