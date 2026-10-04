import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

type MediaRef = { bucket: string; path: string };

function parseMedia(raw: string | null | undefined): MediaRef | null {
  if (!raw) return null;
  const marker = "/storage/v1/object/public/";
  const idx = raw.indexOf(marker);
  if (idx === -1) return null;
  const rest = raw.slice(idx + marker.length);
  const slash = rest.indexOf("/");
  if (slash <= 0) return null;
  const bucket = rest.slice(0, slash);
  const path = decodeURIComponent(rest.slice(slash + 1).split("?")[0]);
  if (!bucket || !path) return null;
  return { bucket, path };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE, { auth: { persistSession: false } });

  let body: Record<string, unknown> = {};
  try { body = await req.json(); } catch { /* cron may send empty body */ }

  const days = Math.max(1, Number(body.days ?? 14));
  const batchSize = Math.min(500, Math.max(10, Number(body.batch_size ?? 200)));
  const maxBatches = Math.min(50, Math.max(1, Number(body.max_batches ?? 5)));
  const triggeredBy = typeof body.triggered_by === "string" ? body.triggered_by : "cron";

  let listingsDeleted = 0;
  let mediaDeleted = 0;
  let bytesFreed = 0;
  let skipped = 0;
  const errors: unknown[] = [];

  try {
    for (let batch = 0; batch < maxBatches; batch++) {
      const { data: rows, error } = await admin.rpc("list_purgeable_rejected_listings", {
        p_days: days,
        p_limit: batchSize,
      });
      if (error) throw new Error(`list_purgeable_rejected_listings: ${error.message}`);
      if (!rows || rows.length === 0) break;

      const ids = (rows as Array<{ id: string; image_urls: string[] | null; video_url: string | null }>).map((r) => r.id);

      // Gather media references from the listing row + listing_photos
      const refs: MediaRef[] = [];
      for (const r of rows as Array<{ image_urls: string[] | null; video_url: string | null }>) {
        for (const url of r.image_urls ?? []) {
          const ref = parseMedia(url);
          if (ref) refs.push(ref);
        }
        const vref = parseMedia(r.video_url);
        if (vref) refs.push(vref);
      }

      const { data: photos, error: photoErr } = await admin
        .from("listing_photos")
        .select("storage_path")
        .in("listing_id", ids);
      if (photoErr) errors.push({ stage: "listing_photos", message: photoErr.message });
      for (const p of photos ?? []) {
        const ref = parseMedia((p as { storage_path: string }).storage_path);
        if (ref) refs.push(ref);
      }

      // Dedupe and group by bucket
      const byBucket = new Map<string, Set<string>>();
      for (const ref of refs) {
        if (!byBucket.has(ref.bucket)) byBucket.set(ref.bucket, new Set());
        byBucket.get(ref.bucket)!.add(ref.path);
      }

      // Measure size before removal so we can report freed bytes
      for (const [bucket, pathSet] of byBucket) {
        const paths = [...pathSet];
        const { data: sizeRows } = await admin.rpc("sum_storage_object_size", {
          p_bucket: bucket,
          p_paths: paths,
        });
        if (typeof sizeRows === "number") bytesFreed += sizeRows;

        for (let i = 0; i < paths.length; i += 100) {
          const chunk = paths.slice(i, i + 100);
          const { data: removed, error: rmErr } = await admin.storage.from(bucket).remove(chunk);
          if (rmErr) {
            errors.push({ stage: "storage.remove", bucket, message: rmErr.message });
          } else {
            mediaDeleted += removed?.length ?? 0;
          }
        }
      }

      // Delete the listing rows (cascades listing_photos, reviews, questions, saved_houses)
      const { data: deleted, error: delErr } = await admin
        .from("house_listings")
        .delete()
        .in("id", ids)
        .select("id");
      if (delErr) {
        errors.push({ stage: "delete_listings", message: delErr.message });
        skipped += ids.length;
        break;
      }
      listingsDeleted += deleted?.length ?? 0;
      if ((deleted?.length ?? 0) < ids.length) skipped += ids.length - (deleted?.length ?? 0);
      if (rows.length < batchSize) break;
    }
  } catch (e) {
    errors.push({ stage: "fatal", message: e instanceof Error ? e.message : String(e) });
  }

  await admin.from("rejected_listing_purge_runs").insert({
    cutoff_days: days,
    listings_deleted: listingsDeleted,
    media_files_deleted: mediaDeleted,
    bytes_freed: bytesFreed,
    skipped,
    errors,
    triggered_by: triggeredBy,
  });

  return new Response(
    JSON.stringify({
      ok: errors.length === 0,
      listings_deleted: listingsDeleted,
      media_files_deleted: mediaDeleted,
      bytes_freed: bytesFreed,
      mb_freed: Number((bytesFreed / 1048576).toFixed(2)),
      skipped,
      errors,
    }),
    { headers: { ...corsHeaders, "Content-Type": "application/json" }, status: errors.length === 0 ? 200 : 500 },
  );
});
