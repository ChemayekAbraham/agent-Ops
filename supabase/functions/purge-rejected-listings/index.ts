import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { planListingMediaDeletion, type RefusalReason } from "./media.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

// Which objects may be deleted is decided ONLY by ./media.ts: this project's
// own Storage host, an authorised listing bucket, and a clean object path.
// Everything else is refused, counted and reported, never deleted.

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
  const refusedMedia = new Map<string, { reason: RefusalReason; bucket?: string; count: number }>();

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
      const raws: unknown[] = [];
      for (const r of rows as Array<{ image_urls: string[] | null; video_url: string | null }>) {
        raws.push(...(r.image_urls ?? []), r.video_url);
      }

      const { data: photos, error: photoErr } = await admin
        .from("listing_photos")
        .select("storage_path")
        .in("listing_id", ids);
      if (photoErr) errors.push({ stage: "listing_photos", message: photoErr.message });
      for (const p of photos ?? []) raws.push((p as { storage_path: string }).storage_path);

      // Dedupe and group by bucket: authorised listing buckets only
      const { byBucket, refused } = planListingMediaDeletion(raws, SUPABASE_URL);
      for (const r of refused) {
        const key = `${r.reason}|${r.bucket ?? ""}`;
        const hit = refusedMedia.get(key);
        if (hit) hit.count += r.count;
        else refusedMedia.set(key, { ...r });
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

  // Refused media is recorded in the run log for review, but is not a failure
  // of the run: the listing is still purged, only the object is left alone.
  const failed = errors.length > 0;
  const mediaRefused = [...refusedMedia.values()];
  if (mediaRefused.length > 0) errors.push({ stage: "media_refused", refused: mediaRefused });

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
      ok: !failed,
      listings_deleted: listingsDeleted,
      media_files_deleted: mediaDeleted,
      bytes_freed: bytesFreed,
      mb_freed: Number((bytesFreed / 1048576).toFixed(2)),
      skipped,
      media_refused: mediaRefused,
      errors,
    }),
    { headers: { ...corsHeaders, "Content-Type": "application/json" }, status: failed ? 500 : 200 },
  );
});
