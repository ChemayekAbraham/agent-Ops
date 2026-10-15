import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { countCsvDataRecords, stripCsvHeader } from "../_shared/csvRecords.ts";
import { EXCLUDED_SECRET_TABLES, parseTableSpec } from "../_shared/fullBackupTables.ts";

// Table-by-table CSV backup of every base table in schema public (doc 224).
//
// MANUAL TRIGGER ONLY (no cron). Additive: touches no existing backup function.
// Why this exists: weekly-database-backup only holds 91 tables and the first
// ~1000 rows of each (PostgREST row cap). This pages EVERY table by primary key
// order with limit/offset, counts the records it actually wrote, and compares
// that to the row count taken before the table started.
//
// An edge function is time-limited, so one run is a chain of invocations: each
// works until DEADLINE_MS, then POSTs its state to itself and returns. State is
// resumable at part boundaries (inside a large table) and table boundaries.
//
// NOT covered (stated in every manifest): auth.users (login accounts), Storage
// file contents (ID photos etc.), schema/functions, and tables created after
// _shared/fullBackupTables.ts was generated. Tables written to during the run can
// drift against their start count (flagged as count_mismatch).

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const BUCKET = "db-backups";
const PAGE_CAP = 1000; // PostgREST max rows per response
// 2026-10-13 first production run died silently inside general_ledger (221/860 tables, no manifest).
// Cause unconfirmed (logs unreachable); a 40 MB part buffered twice plus 4 concurrent pages is the
// prime suspect for the edge memory limit, so parts are small and state is saved after every part.
const PREFETCH = 2; // pages fetched concurrently
const PART_MAX_BYTES = 8 * 1024 * 1024; // small parts: low peak memory, cheap to redo after a kill
const DEADLINE_MS = 70_000; // per invocation, then chain (margin under the hard wall-clock limit)
const STALE_MS = 180_000; // no state write for this long = the chain is dead; resume is allowed
const SIGN_BATCH = 300; // files signed per signed-urls call
const SIGN_MAX_SECONDS = 24 * 60 * 60; // these are bulk personal data: links stay short-lived
const JSON_HEADERS ={ ...corsHeaders, "Content-Type": "application/json" };

type TableResult = {
  table: string;
  status: "ok" | "empty" | "count_mismatch" | "error" | "skipped_no_pk" | "excluded_secret";
  expectedRows?: number;
  writtenRows?: number;
  bytes?: number;
  parts?: number;
  note?: string;
};

type Current = {
  table: string;
  pk: string[];
  expected: number;
  offset: number; // next offset to read
  part: number; // parts already written
  written: number;
  bytes: number;
};

type RunState = {
  runId: string;
  folder: string;
  startedAt: string;
  actor: string;
  queue: string[]; // table names still to start
  cur: Current | null;
  results: TableResult[];
  invocations: number;
  updatedAt?: string; // set on every state save; drives stall detection
};

async function readState(supabaseUrl: string, serviceKey: string, folder: string): Promise<RunState | null> {
  const resp = await fetch(`${supabaseUrl}/storage/v1/object/${BUCKET}/${folder}/_state.json`, {
    headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, "Cache-Control": "no-cache" },
  });
  if (!resp.ok) { await resp.text().catch(() => ""); return null; }
  return (await resp.json().catch(() => null)) as RunState | null;
}

async function saveState(supabaseUrl: string, serviceKey: string, state: RunState) {
  state.updatedAt = new Date().toISOString();
  try {
    const resp = await fetch(`${supabaseUrl}/storage/v1/object/${BUCKET}/${state.folder}/_state.json`, {
      method: "POST",
      headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, "Content-Type": "application/json", "x-upsert": "true" },
      body: JSON.stringify(state),
    });
    await resp.text().catch(() => "");
  } catch (e) {
    console.error("[full-table-backup] state save failed (run continues, resume may lose last part):", e);
  }
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const supabase = createClient(supabaseUrl, serviceKey);

  // Auth: our own service-role chained call, or a manager/cto.
  const token = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "").trim();
  if (!token) return json({ error: "unauthorized" }, 401);
  let actor = "System (chained run)";
  if (token !== serviceKey) {
    const { data: userRes, error: userErr } = await supabase.auth.getUser(token);
    if (userErr || !userRes?.user) return json({ error: "unauthorized" }, 401);
    const { data: roleRows } = await supabase.from("user_roles").select("role").eq("user_id", userRes.user.id);
    const roles = (roleRows ?? []).map((r: { role: string }) => r.role);
    if (!roles.includes("manager") && !roles.includes("cto")) return json({ error: "forbidden" }, 403);
    actor = userRes.user.email ?? userRes.user.id;
  }

  const body = await req.json().catch(() => ({}));

  // Progress poll for the dashboard. backup_runs is readable by `manager` only, but this function
  // also admits `cto`, so the status read goes through here (already authorised above).
  if (body?.action === "status") {
    const folder = typeof body?.folder === "string" ? body.folder : "";
    if (!/^full_tables\/\d{4}\/[0-9TZ-]+$/.test(folder)) return json({ error: "bad folder" }, 400);
    const { data: run } = await supabase
      .from("backup_runs")
      .select("status,table_count,row_count,size_bytes,error_message,created_at")
      .eq("backup_kind", "full_tables")
      .eq("storage_path", folder)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (run) return json({ finished: true, run });
    // Still running, or dead: the per-part checkpoint says which. A run with no checkpoint update
    // for STALE_MS has lost its chain (killed invocation); the dashboard offers `resume`.
    const saved = await readState(supabaseUrl, serviceKey, folder);
    if (!saved) return json({ finished: false, stalled: false, progress: null });
    const ageMs = Date.now() - Date.parse(saved.updatedAt ?? saved.startedAt);
    return json({
      finished: false,
      stalled: ageMs > STALE_MS,
      progress: {
        tablesDone: saved.results.length,
        tablesLeft: saved.queue.length + (saved.cur ? 1 : 0),
        current: saved.cur?.table ?? null,
        ageSeconds: Math.round(ageMs / 1000),
      },
    });
  }

  // Time-limited download links for a run's files, so the CSVs can be pulled without bucket access.
  // Paged (SIGN_BATCH files per call; pass back `next`) so a 2,000-part run never signs in one request.
  // Part paths come from the run's own manifest (or checkpoint while it is still running), never from
  // caller input, so a caller can only ever sign files that belong to the named run.
  if (body?.action === "signed-urls") {
    const folder = typeof body?.folder === "string" ? body.folder : "";
    if (!/^full_tables\/\d{4}\/[0-9TZ-]+$/.test(folder)) return json({ error: "bad folder" }, 400);
    const expiresIn = Math.min(Math.max(Number(body?.expiresIn) || 3600, 60), SIGN_MAX_SECONDS);
    const cursor = Math.max(Number(body?.cursor) || 0, 0);
    const only: string[] | null = Array.isArray(body?.tables) ? body.tables : null;

    let results: TableResult[] | null = null;
    const m = await fetch(`${supabaseUrl}/storage/v1/object/${BUCKET}/${folder}/manifest.json`, {
      headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, "Cache-Control": "no-cache" },
    });
    if (m.ok) results = ((await m.json().catch(() => null))?.results ?? null) as TableResult[] | null;
    else await m.text().catch(() => "");
    if (!results) results = (await readState(supabaseUrl, serviceKey, folder))?.results ?? null;
    if (!results) return json({ error: "no manifest or checkpoint for this run" }, 404);

    const paths: string[] = [`${folder}/manifest.json`];
    for (const r of results) {
      if (!r.parts || (only && !only.includes(r.table))) continue;
      for (let p = 1; p <= r.parts; p++) {
        paths.push(`${folder}/${r.table}/${r.table}_part${String(p).padStart(3, "0")}.csv`);
      }
    }
    const slice = paths.slice(cursor, cursor + SIGN_BATCH);
    const { data: signed, error: signErr } = await supabase.storage.from(BUCKET).createSignedUrls(slice, expiresIn);
    if (signErr) return json({ error: `signing failed: ${signErr.message}` }, 500);
    console.log(`[full-table-backup] signed-urls by ${actor}: ${slice.length} files from ${folder}, ${expiresIn}s`);
    const next = cursor + slice.length < paths.length ? cursor + slice.length : null;
    return json({
      folder,
      total: paths.length,
      expiresIn,
      next,
      files: (signed ?? []).map((s: { path: string | null; signedUrl: string; error: string | null }) => ({
        path: s.path, url: s.signedUrl, error: s.error,
      })),
    });
  }

  let state: RunState;

  // Restart a run whose chain died, from its last saved part. Refused while the chain looks alive,
  // so two chains never write the same folder.
  let resumed: RunState | null = null;
  if (body?.action === "resume") {
    const folder = typeof body?.folder === "string" ? body.folder : "";
    if (!/^full_tables\/\d{4}\/[0-9TZ-]+$/.test(folder)) return json({ error: "bad folder" }, 400);
    resumed = await readState(supabaseUrl, serviceKey, folder);
    if (!resumed) return json({ error: "no saved state for this run (started before checkpointing)" }, 404);
    const ageMs = Date.now() - Date.parse(resumed.updatedAt ?? resumed.startedAt);
    if (ageMs <= STALE_MS) return json({ error: "run still active", ageSeconds: Math.round(ageMs / 1000) }, 409);
    const { data: done } = await supabase.from("backup_runs").select("id").eq("backup_kind", "full_tables").eq("storage_path", folder).limit(1);
    if (done?.length) return json({ error: "run already finished" }, 409);
  }

  if (resumed) {
    state = resumed;
  } else if (body?.action === "continue" && body?.state) {
    state = body.state as RunState;
  } else {
    const startedAt = new Date();
    const stamp = startedAt.toISOString().replace(/[:.]/g, "-");
    const only: string[] | null = Array.isArray(body?.tables) ? body.tables : null; // optional subset (testing)
    const specs = parseTableSpec().filter((t) => !only || only.includes(t.name));
    state = {
      runId: crypto.randomUUID(),
      folder: `full_tables/${startedAt.getUTCFullYear()}/${stamp}`,
      startedAt: startedAt.toISOString(),
      actor,
      queue: specs.map((t) => t.name),
      cur: null,
      results: [],
      invocations: 0,
    };
  }

  // Respond immediately; the work continues in the background of this invocation.
  const job = work(state, supabaseUrl, serviceKey, supabase).catch((e) => console.error("[full-table-backup] unhandled:", e));
  // deno-lint-ignore no-explicit-any
  const rt = (globalThis as any).EdgeRuntime;
  if (rt?.waitUntil) rt.waitUntil(job); // otherwise the promise still runs; it just isn't pinned
  return json({ accepted: true, runId: state.runId, folder: state.folder, queued: state.queue.length }, 202);
});

// ---------------------------------------------------------------------------

async function work(
  state: RunState,
  supabaseUrl: string,
  serviceKey: string,
  // deno-lint-ignore no-explicit-any
  supabase: any,
) {
  const t0 = Date.now();
  state.invocations++;
  await saveState(supabaseUrl, serviceKey, state); // first checkpoint, so a run that dies early is still visible
  const specByName = new Map(parseTableSpec().map((t) => [t.name, t]));
  const restHeaders = { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` };

  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  async function getCsvPage(table: string, pk: string[], offset: number): Promise<Uint8Array> {
    const url =
      `${supabaseUrl}/rest/v1/${table}?select=*&order=${pk.join(",")}&limit=${PAGE_CAP}&offset=${offset}`;
    for (let attempt = 1; ; attempt++) {
      try {
        const resp = await fetch(url, { headers: { ...restHeaders, Accept: "text/csv" } });
        if (resp.ok) return new Uint8Array(await resp.arrayBuffer());
        const txt = await resp.text().catch(() => "");
        if (attempt >= 3) throw new Error(`page ${table}@${offset} failed (${resp.status}): ${txt.slice(0, 200)}`);
      } catch (e) {
        if (attempt >= 3) throw e;
      }
      await sleep(500 * attempt);
    }
  }

  async function countRows(table: string, pk: string[]): Promise<number> {
    const col = pk[0] ?? "*";
    const resp = await fetch(`${supabaseUrl}/rest/v1/${table}?select=${col}&limit=1`, {
      headers: { ...restHeaders, Prefer: "count=exact", Range: "0-0" },
    });
    if (!resp.ok && resp.status !== 206) {
      throw new Error(`count ${table} failed (${resp.status}): ${(await resp.text().catch(() => "")).slice(0, 200)}`);
    }
    await resp.text().catch(() => "");
    const total = Number((resp.headers.get("content-range") ?? "").split("/")[1]);
    if (!Number.isFinite(total)) throw new Error(`count ${table}: no content-range`);
    return total;
  }

  async function upload(path: string, bytes: Uint8Array) {
    for (let attempt = 1; ; attempt++) {
      try {
        const resp = await fetch(`${supabaseUrl}/storage/v1/object/${BUCKET}/${path}`, {
          method: "POST",
          headers: { ...restHeaders, "Content-Type": "text/csv", "x-upsert": "true" },
          body: bytes,
        });
        if (resp.ok) { await resp.text(); return; }
        const txt = await resp.text().catch(() => "");
        if (attempt >= 3) throw new Error(`upload ${path} failed (${resp.status}): ${txt.slice(0, 200)}`);
      } catch (e) {
        if (attempt >= 3) throw e;
      }
      await sleep(1000 * attempt);
    }
  }

  // Reads pages from cur.offset until the part is full, the table ends, or time is up.
  // Returns true when the whole table has been read.
  async function writeNextPart(cur: Current): Promise<boolean> {
    const chunks: Uint8Array[] = [];
    let partBytes = 0;
    let tableDone = false;

    while (partBytes < PART_MAX_BYTES && !tableDone) {
      const offsets: number[] = [];
      for (let i = 0; i < PREFETCH; i++) {
        const o = cur.offset + i * PAGE_CAP;
        if (o < Math.max(cur.expected, cur.offset + 1)) offsets.push(o);
      }
      const pages = await Promise.all(offsets.map((o) => getCsvPage(cur.table, cur.pk, o)));
      for (const page of pages) {
        const rows = countCsvDataRecords(page);
        if (rows > 0) {
          const data = chunks.length === 0 ? page : stripCsvHeader(page);
          chunks.push(data);
          partBytes += data.length;
          cur.written += rows;
        }
        cur.offset += PAGE_CAP;
        if (rows < PAGE_CAP) { tableDone = true; break; } // short page = end of table
      }
      if (cur.offset >= cur.expected + PAGE_CAP) tableDone = true; // safety stop
    }

    if (partBytes > 0) {
      const out = new Uint8Array(partBytes);
      let off = 0;
      for (const c of chunks) { out.set(c, off); off += c.length; }
      cur.part++;
      const name = `${cur.table}_part${String(cur.part).padStart(3, "0")}.csv`;
      await upload(`${state.folder}/${cur.table}/${name}`, out);
      cur.bytes += partBytes;
    }
    return tableDone;
  }

  try {
    while (true) {
      if (!state.cur) {
        const name = state.queue.shift();
        if (!name) break; // all tables processed
        const spec = specByName.get(name);
        if (!spec) { state.results.push({ table: name, status: "error", note: "not in spec" }); continue; }
        if (EXCLUDED_SECRET_TABLES.has(name)) {
          state.results.push({ table: name, status: "excluded_secret", note: "credential material not copied" });
          continue;
        }
        if (!spec.pk.length) {
          // cannot be paged deterministically; only safe if it fits in one page
          try {
            const n = await countRows(name, spec.pk);
            if (n === 0) { state.results.push({ table: name, status: "empty", expectedRows: 0 }); continue; }
            state.results.push({ table: name, status: "skipped_no_pk", expectedRows: n, note: "no primary key; not exported" });
          } catch (e) {
            state.results.push({ table: name, status: "error", note: String((e as Error).message ?? e) });
          }
          continue;
        }
        try {
          const expected = await countRows(name, spec.pk);
          if (expected === 0) { state.results.push({ table: name, status: "empty", expectedRows: 0 }); continue; }
          state.cur = { table: name, pk: spec.pk, expected, offset: 0, part: 0, written: 0, bytes: 0 };
        } catch (e) {
          state.results.push({ table: name, status: "error", note: String((e as Error).message ?? e) });
          continue;
        }
      }

      // Work on the current table, one part at a time, so we can checkpoint.
      const cur = state.cur!;
      let done = false;
      try {
        done = await writeNextPart(cur);
      } catch (e) {
        state.results.push({
          table: cur.table, status: "error", expectedRows: cur.expected, writtenRows: cur.written,
          bytes: cur.bytes, parts: cur.part, note: String((e as Error).message ?? e),
        });
        state.cur = null;
        continue;
      }
      if (done) {
        state.results.push({
          table: cur.table,
          status: cur.written === cur.expected ? "ok" : "count_mismatch",
          expectedRows: cur.expected, writtenRows: cur.written, bytes: cur.bytes, parts: cur.part,
        });
        state.cur = null;
      }

      // Checkpoint after every part: this is what makes a killed run resumable and detectable.
      await saveState(supabaseUrl, serviceKey, state);

      if (Date.now() - t0 > DEADLINE_MS && (state.cur || state.queue.length)) {
        // Hand the rest to a fresh invocation.
        const resp = await fetch(`${supabaseUrl}/functions/v1/full-table-backup`, {
          method: "POST",
          headers: { Authorization: `Bearer ${serviceKey}`, apikey: serviceKey, "Content-Type": "application/json" },
          body: JSON.stringify({ action: "continue", state }),
        });
        if (!resp.ok) throw new Error(`chain call failed (${resp.status}): ${(await resp.text()).slice(0, 200)}`);
        await resp.text();
        return;
      }
    }
    await finish(state, supabase, supabaseUrl, serviceKey, null);
  } catch (e) {
    console.error("[full-table-backup] aborted:", e);
    await finish(state, supabase, supabaseUrl, serviceKey, String((e as Error).message ?? e));
  }
}

async function finish(
  state: RunState,
  // deno-lint-ignore no-explicit-any
  supabase: any,
  supabaseUrl: string,
  serviceKey: string,
  abortReason: string | null,
) {
  const ok = state.results.filter((r) => r.status === "ok");
  const problems = state.results.filter((r) => ["error", "count_mismatch", "skipped_no_pk"].includes(r.status));
  const rows = state.results.reduce((n, r) => n + (r.writtenRows ?? 0), 0);
  const bytes = state.results.reduce((n, r) => n + (r.bytes ?? 0), 0);
  const status = abortReason ? "failed" : problems.length ? "partial" : "success";

  const manifest = {
    kind: "full_tables",
    runId: state.runId,
    startedAt: state.startedAt,
    finishedAt: new Date().toISOString(),
    invocations: state.invocations,
    actor: state.actor,
    status,
    abortReason,
    tablesOk: ok.length,
    tablesWithProblems: problems.length,
    unprocessedAtAbort: abortReason ? [state.cur?.table, ...state.queue].filter(Boolean) : [],
    totalRowsWritten: rows,
    totalBytes: bytes,
    notCovered: [
      "auth.users (login accounts)",
      "Storage file contents (ID photos, receipts, documents)",
      "database schema, functions, policies",
      "tables created after _shared/fullBackupTables.ts was generated",
    ],
    excludedSecretTables: [...EXCLUDED_SECRET_TABLES],
    results: state.results,
  };

  try {
    const resp = await fetch(`${supabaseUrl}/storage/v1/object/${BUCKET}/${state.folder}/manifest.json`, {
      method: "POST",
      headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, "Content-Type": "application/json", "x-upsert": "true" },
      body: JSON.stringify(manifest, null, 1),
    });
    await resp.text();
  } catch (e) {
    console.error("[full-table-backup] manifest upload failed:", e);
  }

  const { error } = await supabase.from("backup_runs").insert({
    backup_kind: "full_tables",
    storage_path: state.folder,
    size_bytes: bytes,
    table_count: ok.length,
    row_count: rows,
    status,
    error_message: abortReason ?? (problems.length ? `${problems.length} table(s) need attention; see manifest` : null),
    recipients: [],
  });
  if (error) console.error("[full-table-backup] backup_runs insert failed:", error.message);
}
