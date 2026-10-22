import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { configure, Uint8ArrayReader, Uint8ArrayWriter, ZipReader, ZipWriter } from "https://esm.sh/@zip.js/zip.js@2.8.61";
import { DEFAULT_BACKUP_RECIPIENTS, splitCompanyRecipients } from "../_shared/backupDelivery.ts";
import { countCsvDataRecords, stripCsvHeader } from "../_shared/csvRecords.ts";
import { requireServiceRole } from "../_shared/requireServiceRole.ts";
import {
  BACKUP_KEEP_DAYS,
  backupFileName,
  backupFilesToDelete,
  generateBackupPassword,
  kampalaStamp,
  rowDriftAcceptable,
} from "../_shared/partnerTenantBackup.ts";

// Daily AES-256 encrypted backup of Supporter (partner) and tenant data.
// Scheduled by cron (02:00 EAT, migration 20261022120000); service role only.
//
// Order matters, and nothing is deleted until the new backup is proven good:
//   1. export six tables as CSV, paging by id (PostgREST caps responses at 1000 rows)
//   2. zip them with AES-256 under a fresh random password
//   3. upload to the private bucket partner-tenant-backups (never overwrites)
//   4. download it again, decrypt, and check every table's row count
//   5. email the password (not the file) straight through Mailgun, so it is
//      never written to email_send_log or the email queue
//   6. only then delete everything but the newest verified backup of the last 7 days
// A failure deletes the new file, keeps all older ones, and sends a failure
// email with no password. The password is never logged, stored or returned.
//
// One worker cannot do it all: zip.js runs AES in JavaScript, and export +
// encrypt + decrypt together hit WORKER_RESOURCE_LIMIT (first run, 2026-10-22).
// So steps 1-3 run in the "export" stage, which POSTs the password to this
// function's "verify" stage (steps 4-6) in a fresh worker. Each run writes a
// backup_runs row as 'running' first, so a killed worker is still visible; the
// next run marks such rows failed and rotation deletes their unverified files.

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};
const JSON_HEADERS = { ...corsHeaders, "Content-Type": "application/json" };

const BUCKET = "partner-tenant-backups";
const PAGE = 1000; // PostgREST max rows per response
const NEWLINE = 0x0a;
const FROM = "Welile Backups <reports@welile.com>";

configure({ useWebWorkers: false });

type Source = { table: string; label: string; rpc?: string };

// profiles and wallets are filtered to Supporters and tenants by SQL functions;
// the other four tables only hold their rows, so they are exported whole.
const SOURCES: Source[] = [
  { table: "profiles", label: "Profiles (Supporters and tenants)", rpc: "partner_tenant_backup_profiles" },
  { table: "wallets", label: "Wallets", rpc: "partner_tenant_backup_wallets" },
  { table: "investor_portfolios", label: "Supporter portfolios" },
  { table: "rent_requests", label: "Rent Plans" },
  { table: "repayments", label: "Repayments" },
  { table: "agent_collections", label: "Agent collections" },
];

type Manifest = {
  partners: number;
  tenants: number;
  columns: Record<string, string[]>;
  rows: Record<string, number>;
};

type People = { partners: number; tenants: number };

type TableResult = { table: string; label: string; expected: number; written: number };

// Everything the verify stage needs; sent once, in the body of an HTTPS call
// between two invocations of this function, and never stored.
type VerifyJob = {
  runId: string;
  day: string;
  fileName: string;
  password: string;
  recipients: string[];
  people: People;
  results: TableResult[];
};

function pageUrl(base: string, src: Source, select: string, after: string | null, through: string | null): string {
  const q = new URLSearchParams({ select });
  if (src.rpc) {
    q.set("p_limit", String(PAGE));
    if (after) q.set("p_after", after);
    if (through) q.set("p_through", through);
    return `${base}/rest/v1/rpc/${src.rpc}?${q}`;
  }
  q.set("order", "id.asc");
  q.set("limit", String(PAGE));
  if (after) q.append("id", `gt.${after}`);
  if (through) q.append("id", `lte.${through}`);
  return `${base}/rest/v1/${src.table}?${q}`;
}

async function fetchOk(url: string, serviceKey: string, accept: string): Promise<Response> {
  const resp = await fetch(url, {
    headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, Accept: accept },
  });
  if (!resp.ok) {
    const txt = await resp.text().catch(() => "");
    throw new Error(`read failed ${resp.status}: ${txt.slice(0, 300)}`);
  }
  return resp;
}

/**
 * One table as a single CSV. Each page first reads the next ids (small JSON),
 * then the rows up to the last of them as CSV, so rows inserted mid-run can
 * never shift a page.
 */
async function exportTable(base: string, serviceKey: string, src: Source, columns: string[]) {
  const select = columns.join(",");
  const chunks: Uint8Array[] = [];
  let after: string | null = null;
  let written = 0;
  while (true) {
    const ids = await (await fetchOk(pageUrl(base, src, "id", after, null), serviceKey, "application/json")).json() as { id: string }[];
    if (!ids.length) break;
    const through = ids[ids.length - 1].id;
    const csv = new Uint8Array(await (await fetchOk(pageUrl(base, src, select, after, through), serviceKey, "text/csv")).arrayBuffer());
    const body = chunks.length ? stripCsvHeader(csv) : csv;
    if (body.length) {
      chunks.push(body);
      if (body[body.length - 1] !== NEWLINE) chunks.push(new Uint8Array([NEWLINE]));
    }
    written += countCsvDataRecords(csv);
    after = through;
    if (ids.length < PAGE) break;
  }
  if (!chunks.length) chunks.push(new TextEncoder().encode(select + "\n"));
  const size = chunks.reduce((n, c) => n + c.length, 0);
  const bytes = new Uint8Array(size);
  let off = 0;
  for (const c of chunks) { bytes.set(c, off); off += c.length; }
  return { bytes, written };
}

async function sendMail(to: string, subject: string, html: string, text: string): Promise<string | null> {
  const key = Deno.env.get("MAILGUN_API_KEY");
  const domain = Deno.env.get("MAILGUN_DOMAIN");
  const base = Deno.env.get("MAILGUN_API_BASE") || "https://api.mailgun.net";
  if (!key || !domain) return "Mailgun not configured";
  const form = new URLSearchParams({ from: FROM, to, subject, html, text });
  const res = await fetch(`${base}/v3/${domain}/messages`, {
    method: "POST",
    headers: { Authorization: `Basic ${btoa(`api:${key}`)}`, "Content-Type": "application/x-www-form-urlencoded" },
    body: form,
  });
  const body = await res.text().catch(() => "");
  return res.ok ? null : `Mailgun ${res.status}: ${body.slice(0, 200)}`;
}

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));

function countsTable(results: TableResult[]): string {
  const rows = results.map((r) =>
    `<tr><td style="padding:4px 12px 4px 0">${esc(r.label)}</td><td style="padding:4px 0;text-align:right">${r.written.toLocaleString("en-US")}</td></tr>`
  ).join("");
  return `<table style="border-collapse:collapse;font-size:14px">${rows}</table>`;
}

function successEmail(day: string, fileName: string, password: string, m: People, results: TableResult[]) {
  const subject = `Welile Supporter & tenant backup ready: ${day}`;
  const html = `<div style="font-family:Arial,sans-serif;color:#1a1a1a;max-width:560px">
<h2 style="margin:0 0 12px">Daily Supporter &amp; tenant backup: ${esc(day)}</h2>
<p>Tonight's backup was saved, opened again and checked. It covers ${m.partners.toLocaleString("en-US")} Supporters and ${m.tenants.toLocaleString("en-US")} tenants.</p>
<p style="margin:16px 0 4px"><strong>Password for this file only:</strong></p>
<p style="font-family:Consolas,monospace;font-size:20px;letter-spacing:1px;background:#f3f4f6;padding:10px 14px;border-radius:6px;display:inline-block;margin:0">${esc(password)}</p>
<p style="margin:16px 0 4px"><strong>File:</strong> ${esc(fileName)}<br>
<strong>Where:</strong> Supabase dashboard, Storage, bucket <em>${BUCKET}</em></p>
${countsTable(results)}
<p style="margin-top:16px">Open it with 7-Zip (Windows) or Keka (Mac). The built-in Windows zip opener cannot read AES-256 files.</p>
<p style="color:#6b7280;font-size:12px">Each backup has its own password. The newest backup of each of the last ${BACKUP_KEEP_DAYS} days is kept; older ones are deleted automatically. Do not forward this email.</p>
</div>`;
  const text = [
    `Daily Supporter & tenant backup: ${day}`,
    `Password for this file only: ${password}`,
    `File: ${fileName} (Supabase dashboard, Storage, ${BUCKET})`,
    ...results.map((r) => `${r.label}: ${r.written}`),
    "Open with 7-Zip (Windows) or Keka (Mac). Do not forward this email.",
  ].join("\n");
  return { subject, html, text };
}

function failureEmail(day: string, error: string) {
  const subject = `Welile Supporter & tenant backup FAILED: ${day}`;
  const html = `<div style="font-family:Arial,sans-serif;color:#1a1a1a;max-width:560px">
<h2 style="margin:0 0 12px">Daily Supporter &amp; tenant backup failed: ${esc(day)}</h2>
<p>No new backup was kept tonight. All earlier backups are untouched.</p>
<p style="font-family:Consolas,monospace;font-size:13px;background:#fef2f2;padding:10px 14px;border-radius:6px">${esc(error)}</p>
<p>It will run again tomorrow at 02:00.</p></div>`;
  return { subject, html, text: `Backup failed: ${day}\n${error}\nAll earlier backups are untouched.` };
}


// deno-lint-ignore no-explicit-any
type Ctx = { base: string; serviceKey: string; supabase: any };

const STALE_RUN_MS = 60 * 60 * 1000; // a 'running' row older than this was killed

async function failRun(ctx: Ctx, runId: string, day: string, fileName: string | null, recipients: string[], msg: string) {
  console.error("[partner-tenant-daily-backup] failed:", msg);
  if (fileName) {
    const { error } = await ctx.supabase.storage.from(BUCKET).remove([fileName]);
    if (error) console.error("[partner-tenant-daily-backup] could not remove failed file", error.message);
  }
  await ctx.supabase.from("backup_runs").update({ status: "failed", error_message: msg }).eq("id", runId);
  const mail = failureEmail(day, msg);
  for (const to of recipients) await sendMail(to, mail.subject, mail.html, mail.text);
}

// Stage 1: export, encrypt, upload, then hand the password to stage 2.
async function exportStage(ctx: Ctx, runId: string, startedAt: Date, recipients: string[]) {
  const { day } = kampalaStamp(startedAt);
  const fileName = backupFileName(startedAt);
  let uploaded = false;
  try {
    const { data: manifestData, error: mErr } = await ctx.supabase.rpc("partner_tenant_backup_manifest");
    if (mErr || !manifestData) throw new Error(`manifest failed: ${mErr?.message ?? "empty"}`);
    const manifest = manifestData as Manifest;

    // AES-256 is zip.js encryptionStrength 3. One CSV per table.
    const password = generateBackupPassword();
    const zipWriter = new ZipWriter(new Uint8ArrayWriter(), { password, encryptionStrength: 3, level: 6 });
    const results: TableResult[] = [];
    for (const src of SOURCES) {
      const columns = manifest.columns[src.table];
      if (!columns?.length) throw new Error(`no columns for ${src.table}`);
      const { bytes, written } = await exportTable(ctx.base, ctx.serviceKey, src, columns);
      const expected = manifest.rows[src.table] ?? 0;
      if (!rowDriftAcceptable(expected, written)) {
        throw new Error(`${src.table}: wrote ${written} rows, expected about ${expected}`);
      }
      results.push({ table: src.table, label: src.label, expected, written });
      await zipWriter.add(`${src.table}.csv`, new Uint8ArrayReader(bytes));
    }
    const readme = [
      `Welile Supporter & tenant backup`,
      `Generated: ${startedAt.toISOString()} (Kampala date ${day})`,
      `Supporters: ${manifest.partners}  Tenants: ${manifest.tenants}`,
      ``,
      ...results.map((r) => `${r.table}.csv  ${r.written} rows (${r.label})`),
      ``,
      `profiles.csv and wallets.csv hold only Supporters and tenants. The other files are whole tables.`,
      `investor_portfolios.portfolio_pin and activation_token are left out on purpose.`,
      `Restore a table with: \\copy public.<table> (<header columns>) FROM '<table>.csv' WITH (FORMAT csv, HEADER true)`,
    ].join("\n");
    await zipWriter.add("README.txt", new Uint8ArrayReader(new TextEncoder().encode(readme)));
    const zipBytes = await zipWriter.close();

    const { error: upErr } = await ctx.supabase.storage.from(BUCKET)
      .upload(fileName, zipBytes, { contentType: "application/zip", upsert: false });
    if (upErr) throw new Error(`upload failed: ${upErr.message}`);
    uploaded = true;
    await ctx.supabase.from("backup_runs").update({
      size_bytes: zipBytes.length,
      table_count: results.length,
      row_count: results.reduce((n, r) => n + r.written, 0),
    }).eq("id", runId);

    const job: VerifyJob = {
      runId, day, fileName, password, recipients,
      people: { partners: manifest.partners, tenants: manifest.tenants },
      results,
    };
    const resp = await fetch(`${ctx.base}/functions/v1/partner-tenant-daily-backup`, {
      method: "POST",
      headers: { Authorization: `Bearer ${ctx.serviceKey}`, apikey: ctx.serviceKey, "Content-Type": "application/json" },
      body: JSON.stringify({ stage: "verify", job }),
    });
    if (!resp.ok) throw new Error(`verify hand-off failed (${resp.status}): ${(await resp.text()).slice(0, 200)}`);
    await resp.text();
  } catch (err) {
    await failRun(ctx, runId, day, uploaded ? fileName : null, recipients, err instanceof Error ? err.message : String(err));
  }
}

// Stage 2: open the stored file with the password, recount, email, rotate.
async function verifyStage(ctx: Ctx, job: VerifyJob) {
  try {
    const { data: blob, error: dlErr } = await ctx.supabase.storage.from(BUCKET).download(job.fileName);
    if (dlErr || !blob) throw new Error(`verify download failed: ${dlErr?.message ?? "empty"}`);
    const reader = new ZipReader(new Uint8ArrayReader(new Uint8Array(await blob.arrayBuffer())), { password: job.password });
    const entries = await reader.getEntries();
    for (const r of job.results) {
      const entry = entries.find((e) => e.filename === `${r.table}.csv`);
      if (!entry || entry.directory) throw new Error(`verify: ${r.table}.csv missing from zip`);
      if (!entry.encrypted) throw new Error(`verify: ${r.table}.csv is not encrypted`);
      const count = countCsvDataRecords(await entry.getData(new Uint8ArrayWriter()));
      if (count !== r.written) throw new Error(`verify: ${r.table}.csv has ${count} rows, wrote ${r.written}`);
    }
    await reader.close();

    // If nobody got the password, the file can never be opened.
    const mail = successEmail(job.day, job.fileName, job.password, job.people, job.results);
    const mailErrors: string[] = [];
    for (const to of job.recipients) {
      const err = await sendMail(to, mail.subject, mail.html, mail.text);
      if (err) mailErrors.push(`${to}: ${err}`);
    }
    if (mailErrors.length === job.recipients.length) {
      throw new Error(`password email failed for every recipient: ${mailErrors.join("; ")}`);
    }
    await ctx.supabase.from("backup_runs").update({
      status: "success",
      error_message: mailErrors.length ? `password email failed for: ${mailErrors.join("; ")}` : null,
    }).eq("id", job.runId);

    // Rotate only now. backup_runs says which files were verified; anything else is a leftover.
    const { data: runs, error: runsErr } = await ctx.supabase.from("backup_runs")
      .select("storage_path, status").eq("backup_kind", "partner_tenant").in("status", ["success", "running"]);
    const { data: listed, error: lsErr } = await ctx.supabase.storage.from(BUCKET).list("", { limit: 1000 });
    if (runsErr || lsErr) {
      console.error("[partner-tenant-daily-backup] rotation skipped", runsErr?.message ?? lsErr?.message);
      return;
    }
    const rows = (runs ?? []) as { storage_path: string; status: string }[];
    const namesWith = (status: string) =>
      new Set(rows.filter((r) => r.status === status).map((r) => r.storage_path.replace(`${BUCKET}/`, "")));
    const files = ((listed ?? []) as { name: string }[]).map((o) => o.name);
    const deleted = backupFilesToDelete(files, namesWith("success"), namesWith("running"));
    if (deleted.length) {
      const { error: rmErr } = await ctx.supabase.storage.from(BUCKET).remove(deleted);
      if (rmErr) console.error("[partner-tenant-daily-backup] rotation delete failed", rmErr.message);
    }
    console.log("[partner-tenant-daily-backup] done", job.fileName, "deleted", deleted);
  } catch (err) {
    await failRun(ctx, job.runId, job.day, job.fileName, job.recipients, err instanceof Error ? err.message : String(err));
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  const refused = await requireServiceRole(req, corsHeaders);
  if (refused) return refused;

  const base = Deno.env.get("SUPABASE_URL")!;
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const ctx: Ctx = { base, serviceKey, supabase: createClient(base, serviceKey) };
  const body = await req.json().catch(() => ({}));

  let work: Promise<void>;
  let reply: Record<string, unknown>;
  if (body?.stage === "verify" && body.job) {
    const job = body.job as VerifyJob;
    work = verifyStage(ctx, job);
    reply = { accepted: true, stage: "verify", file: job.fileName };
  } else {
    // Cron sends no body. A manual run may name recipients (company mailboxes only).
    const requested: unknown[] = Array.isArray(body?.recipients) && body.recipients.length
      ? body.recipients
      : DEFAULT_BACKUP_RECIPIENTS;
    const { allowed: recipients } = splitCompanyRecipients(requested);
    if (!recipients.length) {
      return new Response(JSON.stringify({ error: "recipients must be company (@welile.com) addresses" }), {
        status: 400, headers: JSON_HEADERS,
      });
    }

    // A run killed mid-way never updated its row; close those out first.
    await ctx.supabase.from("backup_runs")
      .update({ status: "failed", error_message: "worker stopped before finishing; no password was sent" })
      .eq("backup_kind", "partner_tenant").eq("status", "running")
      .lt("created_at", new Date(Date.now() - STALE_RUN_MS).toISOString());

    const startedAt = new Date();
    const fileName = backupFileName(startedAt);
    const { data: run, error: runErr } = await ctx.supabase.from("backup_runs").insert({
      backup_kind: "partner_tenant",
      storage_path: `${BUCKET}/${fileName}`,
      status: "running",
      recipients,
    }).select("id").single();
    if (runErr || !run) {
      return new Response(JSON.stringify({ error: `could not log run: ${runErr?.message}` }), {
        status: 500, headers: JSON_HEADERS,
      });
    }
    work = exportStage(ctx, run.id, startedAt, recipients);
    reply = { accepted: true, stage: "export", runId: run.id, file: fileName };
  }

  // Reply at once; the work continues in the background of this invocation.
  const pinned = work.catch((e) => console.error("[partner-tenant-daily-backup] unhandled:", e));
  // deno-lint-ignore no-explicit-any
  const rt = (globalThis as any).EdgeRuntime;
  if (rt?.waitUntil) rt.waitUntil(pinned);
  return new Response(JSON.stringify(reply), { status: 202, headers: JSON_HEADERS });
});
