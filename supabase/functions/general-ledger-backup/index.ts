import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// Dedicated, verified backup of public.general_ledger, emailed to Josh.
//
// Why this exists separately from weekly-database-backup: PostgREST caps every
// response at 1000 rows, and that function asks for each table in one request,
// so its "success" runs have only ever held the first 1000 rows of each table.
// Here the ledger is paged by primary key using boundaries from
// general_ledger_backup_boundaries(), pages are fetched a few at a time but
// written in id order, and the exported row count is checked against the count
// taken at the start. Output is plain CSV, split into parts of ~PART_MAX_BYTES so
// no single upload hits the storage object limit. Postgres builds the CSV; the
// worker only strips the repeated header lines and forwards bytes.

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const BUCKET = "db-backups";
const PAGE_STEP = 900; // rows per boundary; below the 1000-row PostgREST cap
const PAGE_CAP = 1000; // PostgREST max rows per response
const CONCURRENCY = 6;
const PART_MAX_BYTES = 40 * 1024 * 1024;
const SIGNED_URL_TTL_SECONDS = 60 * 60 * 24 * 7;
const NEWLINE = 0x0a;

type Page = { bytes: Uint8Array; rows: number };

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const supabase = createClient(supabaseUrl, serviceKey);

  let actorName = "System (scheduled cron)";
  try {
    const token = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "").trim();
    if (token) {
      const { data: userData } = await supabase.auth.getUser(token);
      const uid = userData?.user?.id;
      if (uid) {
        const { data: profile } = await supabase
          .from("profiles").select("full_name, email").eq("id", uid).maybeSingle();
        actorName = profile?.full_name || profile?.email || userData.user.email || uid;
      }
    }
  } catch (_) { /* fall back to system actor */ }

  const body = await req.json().catch(() => ({}));
  const skipEmail = body?.skipEmail === true;

  const startedAt = new Date();
  const stamp = startedAt.toISOString().replace(/[:.]/g, "-");
  const folder = `general_ledger/${startedAt.getUTCFullYear()}/${stamp}`;

  try {
    const { data: bounds, error: bErr } = await supabase.rpc("general_ledger_backup_boundaries", {
      p_step: PAGE_STEP,
    });
    if (bErr || !bounds) throw new Error(`Boundaries failed: ${bErr?.message ?? "no data"}`);
    const snapshotRows = Number(bounds.total) || 0;
    const boundaries: string[] = bounds.boundaries ?? [];

    // Page i covers (lower, upper]; the first has no lower bound, the last no upper
    // bound, so rows inserted after the snapshot are still picked up somewhere.
    const ranges: Array<[string | null, string | null]> = [];
    let prev: string | null = null;
    for (const b of boundaries) { ranges.push([prev, b]); prev = b; }
    ranges.push([prev, null]);

    const restHeaders = {
      apikey: serviceKey,
      Authorization: `Bearer ${serviceKey}`,
      Accept: "text/csv",
      "Range-Unit": "items",
      Prefer: "count=exact",
    };

    const fetchSlice = async (filter: string, from: number) => {
      const url = `${supabaseUrl}/rest/v1/general_ledger?select=*&order=id.asc${filter}`;
      for (let attempt = 1; ; attempt++) {
        const resp = await fetch(url, { headers: { ...restHeaders, Range: `${from}-${from + PAGE_CAP - 1}` } });
        if (resp.ok || resp.status === 206) {
          const total = Number((resp.headers.get("content-range") || "").split("/")[1]) || 0;
          return { total, bytes: new Uint8Array(await resp.arrayBuffer()) };
        }
        // 416 = requested range past the end (0 rows in this slice)
        if (resp.status === 416) return { total: 0, bytes: new Uint8Array() };
        const txt = await resp.text().catch(() => "");
        if (attempt >= 3) throw new Error(`Page fetch failed (${resp.status}): ${txt.slice(0, 300)}`);
        await new Promise((r) => setTimeout(r, 500 * attempt));
      }
    };

    // Returns the CSV body without its header line, ending in "\n" (or empty).
    const stripHeader = (b: Uint8Array) => {
      const nl = b.indexOf(NEWLINE);
      if (nl < 0) return new Uint8Array();
      return b.subarray(nl + 1);
    };
    let headerLine: Uint8Array | null = null;

    const fetchPage = async ([lo, hi]: [string | null, string | null]): Promise<Page> => {
      const filter = (lo ? `&id=gt.${lo}` : "") + (hi ? `&id=lte.${hi}` : "");
      const first = await fetchSlice(filter, 0);
      if (!headerLine && first.bytes.length) {
        const nl = first.bytes.indexOf(NEWLINE);
        headerLine = nl < 0 ? first.bytes.slice() : first.bytes.slice(0, nl + 1);
      }
      const chunks = [stripHeader(first.bytes)];
      // More than 1000 rows in a range (e.g. the open-ended last page, or inserts
      // since the snapshot): keep going until the whole range is read.
      for (let from = PAGE_CAP; from < first.total; from += PAGE_CAP) {
        chunks.push(stripHeader((await fetchSlice(filter, from)).bytes));
      }
      const parts = chunks.filter((c) => c.length);
      const len = parts.reduce((n, c) => n + c.length + 1, 0);
      const out = new Uint8Array(len);
      let off = 0;
      for (const c of parts) {
        out.set(c, off); off += c.length;
        if (c[c.length - 1] !== NEWLINE) out[off++] = NEWLINE;
      }
      return { bytes: out.subarray(0, off), rows: first.total };
    };

    // In-order iterator with a prefetch window of CONCURRENCY pages.
    let nextToStart = 0;
    let nextToYield = 0;
    const inflight = new Map<number, Promise<Page>>();
    const fill = () => {
      while (nextToStart < ranges.length && inflight.size < CONCURRENCY) {
        inflight.set(nextToStart, fetchPage(ranges[nextToStart]));
        nextToStart++;
      }
    };
    const nextPage = async (): Promise<Page | null> => {
      if (nextToYield >= ranges.length) return null;
      fill();
      const p = inflight.get(nextToYield)!;
      const page = await p;
      inflight.delete(nextToYield);
      nextToYield++;
      fill();
      return page;
    };

    const partsOut: Array<{ fileName: string; path: string; rows: number; sizeBytes: number }> = [];
    let exportedRows = 0;
    let totalBytes = 0;
    let exhausted = false;

    while (!exhausted) {
      const partNo = partsOut.length + 1;
      const fileName = `general_ledger_part${String(partNo).padStart(2, "0")}.csv`;
      const path = `${folder}/${fileName}`;
      let partBytes = 0;
      let partRows = 0;
      let wroteHeader = false;

      // Pull-based: pages are only fetched as fast as storage consumes them.
      const stream = new ReadableStream<Uint8Array>({
        async pull(controller) {
          try {
            while (true) {
              if (partBytes >= PART_MAX_BYTES) { controller.close(); return; }
              const page = await nextPage();
              if (!page) { exhausted = true; controller.close(); return; }
              if (!page.bytes.length) continue;
              if (!wroteHeader && headerLine) {
                controller.enqueue(headerLine);
                partBytes += headerLine.length;
                wroteHeader = true;
              }
              controller.enqueue(page.bytes);
              partBytes += page.bytes.length;
              partRows += page.rows;
              return;
            }
          } catch (e) {
            controller.error(e);
          }
        },
      });

      const up = await fetch(`${supabaseUrl}/storage/v1/object/${BUCKET}/${path}`, {
        method: "POST",
        headers: {
          apikey: serviceKey,
          Authorization: `Bearer ${serviceKey}`,
          "Content-Type": "text/csv",
          "x-upsert": "false",
        },
        body: stream,
        // @ts-ignore - Deno fetch supports duplex for streaming bodies
        duplex: "half",
      });
      if (!up.ok) throw new Error(`Upload of ${fileName} failed: ${up.status} ${await up.text()}`);
      await up.text();

      if (partBytes === 0) {
        // Nothing left after the previous part closed: drop the empty object.
        await supabase.storage.from(BUCKET).remove([path]);
        break;
      }
      partsOut.push({ fileName, path, rows: partRows, sizeBytes: partBytes });
      exportedRows += partRows;
      totalBytes += partBytes;
    }

    const durationSec = Math.round((Date.now() - startedAt.getTime()) / 1000);
    // The ledger is append-only, so a complete export has at least the rows
    // counted at the start (more if postings landed while it ran).
    const status = exportedRows >= snapshotRows && partsOut.length > 0 ? "success" : "partial";

    const manifest = {
      table: "public.general_ledger",
      generatedAt: startedAt.toISOString(),
      durationSec,
      status,
      snapshotRows,
      exportedRows,
      totalBytes,
      order: "id asc",
      parts: partsOut.map(({ fileName, rows, sizeBytes }) => ({ fileName, rows, sizeBytes })),
    };
    const manifestPath = `${folder}/manifest.json`;
    const { error: mErr } = await supabase.storage.from(BUCKET).upload(
      manifestPath,
      new Blob([JSON.stringify(manifest, null, 2)], { type: "application/json" }),
      { upsert: false },
    );
    if (mErr) throw new Error(`Manifest upload failed: ${mErr.message}`);

    const { data: signedParts, error: sErr } = await supabase.storage
      .from(BUCKET)
      .createSignedUrls([...partsOut.map((p) => p.path), manifestPath], SIGNED_URL_TTL_SECONDS);
    if (sErr || !signedParts) throw new Error(`Sign failed: ${sErr?.message}`);
    const urlFor = (path: string) => signedParts.find((s) => s.path === path)?.signedUrl ?? "";

    const mb = (n: number) => (n / (1024 * 1024)).toFixed(2);
    let emailed = false;
    if (!skipEmail) {
      const { error: eErr } = await supabase.functions.invoke("send-transactional-email", {
        body: {
          templateName: "general-ledger-backup-ready",
          idempotencyKey: `gl-backup-${stamp}`,
          templateData: {
            parts: partsOut.map((p) => ({ fileName: p.fileName, url: urlFor(p.path), rows: p.rows, sizeMb: mb(p.sizeBytes) })),
            manifestUrl: urlFor(manifestPath),
            exportedRows,
            snapshotRows,
            sizeMb: mb(totalBytes),
            generatedAt: startedAt.toISOString(),
            durationSec,
            expiresInHours: SIGNED_URL_TTL_SECONDS / 3600,
            status,
            actorName,
          },
        },
      });
      if (eErr) console.error("Email failed:", eErr);
      emailed = !eErr;
    }

    await supabase.from("backup_runs").insert({
      backup_kind: "general_ledger",
      storage_path: manifestPath,
      size_bytes: totalBytes,
      table_count: 1,
      row_count: exportedRows,
      status,
      error_message: status === "success" ? null : `exported ${exportedRows} of ${snapshotRows} rows`,
      recipients: skipEmail ? [] : ["joshwanda17@gmail.com"],
    });

    return new Response(JSON.stringify({ success: status === "success", emailed, ...manifest, folder }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("General ledger backup failed:", msg);
    await supabase.from("backup_runs").insert({
      backup_kind: "general_ledger", storage_path: folder, table_count: 1,
      status: "failed", error_message: msg, recipients: ["joshwanda17@gmail.com"],
    });
    if (!skipEmail) {
      // A failed backup must not be silent.
      await supabase.functions.invoke("send-transactional-email", {
        body: {
          templateName: "general-ledger-backup-ready",
          idempotencyKey: `gl-backup-failed-${stamp}`,
          templateData: { parts: [], exportedRows: 0, snapshotRows: 0, status: "failed", generatedAt: startedAt.toISOString(), actorName },
        },
      }).catch(() => {});
    }
    return new Response(JSON.stringify({ success: false, error: msg }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
