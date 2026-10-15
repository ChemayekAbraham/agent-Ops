import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// Read-only Storage export for the PDPO migration (doc 237). Lets a manager/cto copy the files in
// the app's Storage buckets to another Supabase project without holding a service key:
//   { action: "list", bucket, prefix?, offset? } -> one page of a folder: { files, folders, next }
//   { action: "sign", bucket, paths: [...], expiresIn? } -> time-limited download URLs
// It never writes, deletes or moves anything. The backup and export buckets are refused here
// (full-table-backup already has its own signed-urls action for db-backups).

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};
const JSON_HEADERS = { ...corsHeaders, "Content-Type": "application/json" };

const LIST_PAGE = 1000; // Storage list() max per call
const SIGN_BATCH = 200; // files signed per call
const SIGN_MAX_SECONDS = 6 * 60 * 60; // bulk personal data (ID photos, agreements): short-lived links
const REFUSED_BUCKETS = /^(db-backups|database_export_.*)$/;

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "method not allowed" }, 405);

  const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

  const token = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "").trim();
  if (!token) return json({ error: "unauthorized" }, 401);
  const { data: userRes, error: userErr } = await supabase.auth.getUser(token);
  if (userErr || !userRes?.user) return json({ error: "unauthorized" }, 401);
  const { data: roleRows } = await supabase.from("user_roles").select("role").eq("user_id", userRes.user.id);
  const roles = (roleRows ?? []).map((r: { role: string }) => r.role);
  if (!roles.includes("manager") && !roles.includes("cto")) return json({ error: "forbidden" }, 403);
  const actor = userRes.user.email ?? userRes.user.id;

  const body = await req.json().catch(() => ({}));
  const bucket = typeof body?.bucket === "string" ? body.bucket : "";
  if (!/^[a-z0-9_-]{3,63}$/i.test(bucket) || REFUSED_BUCKETS.test(bucket)) return json({ error: "bad bucket" }, 400);

  if (body?.action === "list") {
    const prefix = typeof body?.prefix === "string" ? body.prefix.replace(/^\/+/, "") : "";
    if (prefix.includes("..")) return json({ error: "bad prefix" }, 400);
    const offset = Math.max(0, Number(body?.offset) || 0);
    const { data, error } = await supabase.storage.from(bucket).list(prefix, {
      limit: LIST_PAGE,
      offset,
      sortBy: { column: "name", order: "asc" },
    });
    if (error) return json({ error: error.message }, 500);
    const rows = data ?? [];
    // Folders come back with id = null; files carry metadata.size.
    const folders = rows.filter((r) => r.id === null).map((r) => r.name);
    const files = rows
      .filter((r) => r.id !== null)
      .map((r) => ({
        path: prefix ? `${prefix}/${r.name}` : r.name,
        size: Number((r.metadata as { size?: number } | null)?.size ?? 0),
      }));
    return json({ bucket, prefix, files, folders, next: rows.length === LIST_PAGE ? offset + LIST_PAGE : null });
  }

  if (body?.action === "sign") {
    const paths: string[] = Array.isArray(body?.paths) ? body.paths.filter((p: unknown) => typeof p === "string") : [];
    if (paths.length === 0 || paths.length > SIGN_BATCH) return json({ error: `1..${SIGN_BATCH} paths per call` }, 400);
    if (paths.some((p) => p.includes(".."))) return json({ error: "bad path" }, 400);
    const expiresIn = Math.min(Math.max(Number(body?.expiresIn) || 1800, 60), SIGN_MAX_SECONDS);
    const { data, error } = await supabase.storage.from(bucket).createSignedUrls(paths, expiresIn);
    if (error) return json({ error: error.message }, 500);
    console.log(`[storage-migration-export] ${actor} signed ${paths.length} in ${bucket}`);
    return json({
      bucket,
      expiresIn,
      files: (data ?? []).map((d) => ({ path: d.path, url: d.signedUrl, error: d.error })),
    });
  }

  return json({ error: "unknown action" }, 400);
});
