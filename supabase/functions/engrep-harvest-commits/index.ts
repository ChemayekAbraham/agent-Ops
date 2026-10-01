import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

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

// Lovable authors its commits as its own app identity and co-attributes the workspace
// member who triggered them via a Co-authored-by trailer. Test LOVABLE first: lovable-dev[bot]
// would otherwise match the generic "[bot]" marker and be discarded.
const LOVABLE_MARKERS = ["lovable-dev", "gpt-engineer-app", "lovable"];
const OTHER_BOT_MARKERS = ["bot@", "[bot]", "dependabot", "github-actions", "web-flow"];
// Deliberately NOT a bot marker: a member's GitHub email may be
// username@users.noreply.github.com and must never be treated as a bot.

function hay(email: string | null, login: string | null): string {
  return `${(email ?? "").toLowerCase()} ${(login ?? "").toLowerCase()}`;
}
function isLovable(email: string | null, login: string | null): boolean {
  const h = hay(email, login);
  return LOVABLE_MARKERS.some((m) => h.includes(m));
}
function isOtherBot(email: string | null, login: string | null): boolean {
  const h = hay(email, login);
  return OTHER_BOT_MARKERS.some((m) => h.includes(m));
}

function coAuthorEmails(message: string): string[] {
  const out = new Set<string>();
  const re = /^\s*co-authored-by:\s*[^<]*<([^>]+)>\s*$/gim;
  let m: RegExpExecArray | null;
  while ((m = re.exec(message)) !== null) {
    const email = (m[1] ?? "").trim().toLowerCase();
    if (!email) continue;
    if (isLovable(email, null) || isOtherBot(email, null)) continue;
    if (email.includes("noreply@anthropic.com")) continue;
    out.add(email);
  }
  return [...out];
}

function lovableEditId(message: string): string | null {
  const m = /^\s*x-lovable-edit-id:\s*(\S+)\s*$/im.exec(message);
  return m ? m[1].trim() : null;
}

function kampalaToday(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Africa/Kampala",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

const CLASSES = ["ddl","rls","function","trigger","edge_function","ui","config"] as const;

function classifyPath(path: string, set: Set<string>) {
  if (isMigrationPath(path)) set.add("ddl");
  if (path.includes("supabase/functions/")) set.add("edge_function");
  if (path.startsWith("src/") && (path.endsWith(".tsx") || path.endsWith(".css"))) set.add("ui");
  const base = path.split("/").pop() ?? "";
  if (base === "config.toml" || base === "package.json" ||
      /^tailwind\.config\./.test(base) || /^vite\.config\./.test(base)) set.add("config");
}

function classifySql(sql: string, set: Set<string>) {
  if (/policy|row level security/i.test(sql)) set.add("rls");
  if (/create\s+(or\s+replace\s+)?function/i.test(sql)) set.add("function");
  if (/create\s+trigger/i.test(sql)) set.add("trigger");
}

function parseClaimedNames(sql: string): string[] {
  const names = new Set<string>();
  const re = /\b(?:create|alter|drop)\s+(?:or\s+replace\s+)?(?:unique\s+)?(?:table|function|policy|trigger|view|index)\s+(?:if\s+not\s+exists\s+|if\s+exists\s+)?(?:only\s+)?"?([A-Za-z_][A-Za-z0-9_]*)"?(?:\."?([A-Za-z_][A-Za-z0-9_]*)"?)?/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(sql)) !== null) {
    const name = m[2] ?? m[1];
    if (name) names.add(name);
  }
  return [...names];
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  // An optional day lets a stranded window be re-harvested. The cron caller sends no
  // body, so it keeps defaulting to today.
  const body: any = await req.json().catch(() => ({}));
  const requestedDay = typeof body?.day === "string" && /^\d{4}-\d{2}-\d{2}$/.test(body.day)
    ? body.day
    : null;


  const repo = Deno.env.get("ENGREP_GITHUB_REPO");
  const token = Deno.env.get("ENGREP_GITHUB_TOKEN");
  if (!repo || !token) {
    return json({ error: "engrep-harvest-commits: ENGREP_GITHUB_REPO and ENGREP_GITHUB_TOKEN must both be configured. Nothing was written." }, 500);
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const admin = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } });

  let runId: string | null = null;
  let windowId: string | null = null;

  // Wall-clock budget: the invocation must always reach engrep_svc_run_finish, so we
  // stop taking on new commits well before the platform kills us.
  const startedAt = Date.now();
  const BUDGET_MS = 110_000;
  const DETAIL_BATCH = 8;

  let budgetExhausted = false;
  let skippedForBudget = 0;
  let failed = 0;
  let stats: Record<string, unknown> | null = null;
  let fatalError: string | null = null;

  try {
    const { data: startedId, error: startErr } = await admin.rpc("engrep_svc_run_start", { p_zone: "external_commit" });
    if (startErr) throw new Error(`run_start: ${startErr.message}`);
    runId = (startedId as string) ?? null;

    const vDay = requestedDay ?? kampalaToday();
    const untilISO = `${vDay}T14:00:00Z`;
    const untilMs = Date.parse(untilISO);
    const sinceISO = new Date(untilMs - 24 * 60 * 60 * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");

    const { data: wid, error: winErr } = await admin.rpc("engrep_svc_ensure_window", { p_granularity: "day", p_day: vDay });
    if (winErr) throw new Error(`ensure_window: ${winErr.message}`);
    windowId = wid as string;

    const gh = async (url: string) => {
      const res = await fetch(url, {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.github+json",
          "User-Agent": "welile-engrep-harvest",
        },
      });
      if (!res.ok) throw new Error(`github ${res.status}: ${(await res.text()).slice(0, 300)}`);
      return await res.json();
    };

    const commits: any[] = [];
    for (let page = 1; page <= 20; page++) {
      const batch = await gh(`https://api.github.com/repos/${repo}/commits?since=${encodeURIComponent(sinceISO)}&until=${encodeURIComponent(untilISO)}&per_page=100&page=${page}`);
      if (!Array.isArray(batch) || batch.length === 0) break;
      commits.push(...batch);
      if (batch.length < 100) break;
    }

    let botsExcluded = 0;
    let mergesExcluded = 0;
    let noAuthorEmail = 0;
    let ingested = 0;
    let lovableIngested = 0;
    let lovableUntagged = 0;
    let claimedNotLive = 0;
    let editIdsCaptured = 0;
    let fileTouchesRecorded = 0;
    const failures: Array<{ sha: string; error: string }> = [];
    const authorEmails = new Set<string>();
    const coauthorSeen = new Set<string>();

    const { data: engineers } = await admin.from("engrep_engineers").select("id, code, git_emails");

    // Attribution pass: no network, so exclusions are decided for every commit even if
    // the detail pass later runs out of budget.
    type Prepared = { c: any; source: string; attributedEmail: string | null; untagged: boolean; fullMessage: string };
    const prepared: Prepared[] = [];
    for (const c of commits) {
      const email: string | null = c?.commit?.author?.email ?? null;
      const login: string | null = c?.author?.login ?? null;
      const fullMessage = String(c?.commit?.message ?? "");

      const lovable = isLovable(email, login);
      if (!lovable && isOtherBot(email, login)) { botsExcluded++; continue; }

      // A merge commit inherits the merged branch's file list, so it claims schema
      // effect it did not author and would be zeroed unfairly. Parent count, never
      // the subject line.
      if (Array.isArray(c.parents) && c.parents.length > 1) { mergesExcluded++; continue; }

      let source: string;
      let attributedEmail: string | null;
      let untagged = false;

      if (lovable) {
        source = "lovable_edit";
        const cands = coAuthorEmails(fullMessage);
        for (const e of cands) coauthorSeen.add(e);
        if (cands.length === 1) {
          attributedEmail = cands[0];
        } else {
          // none: member has no connected GitHub account. more than one: ambiguous,
          // and ambiguity must never resolve to a guess. Either way, §4 scores zero.
          attributedEmail = null;
          untagged = true;
          lovableUntagged++;
        }
      } else {
        source = "external_commit";
        if (!email) { noAuthorEmail++; continue; }
        attributedEmail = email;
      }

      prepared.push({ c, source, attributedEmail, untagged, fullMessage });
    }

    for (let start = 0; start < prepared.length; start += DETAIL_BATCH) {
      if (Date.now() - startedAt > BUDGET_MS) {
        budgetExhausted = true;
        skippedForBudget = prepared.length - start;
        break;
      }

      const slice = prepared.slice(start, start + DETAIL_BATCH);
      const details = await Promise.all(slice.map(async (p) => {
        try {
          return { ok: true as const, detail: await gh(`https://api.github.com/repos/${repo}/commits/${p.c.sha}`) };
        } catch (e) {
          return { ok: false as const, error: String((e as Error)?.message ?? e) };
        }
      }));

      for (let i = 0; i < slice.length; i++) {
        const { c, source, attributedEmail, untagged, fullMessage } = slice[i];
        try {
          const got = details[i];
          if (!got.ok) throw new Error(got.error);
          const detail = got.detail;
          const files: any[] = Array.isArray(detail?.files) ? detail.files : [];
          const paths: string[] = files.map((f) => String(f.filename ?? ""));

          const classes = new Set<string>();
          let migrationSql = "";
          for (const f of files) {
            const path = String(f.filename ?? "");
            classifyPath(path, classes);
            if (isMigrationPath(path)) migrationSql += `\n${String(f.patch ?? "")}`;
          }
          if (migrationSql.trim().length > 0) classifySql(migrationSql, classes);

          const changeClasses = [...classes].filter((x) => (CLASSES as readonly string[]).includes(x));
          const migrationBearing = paths.some((p) => isMigrationPath(p));

          let claimedObjects: string[] = [];
          if (migrationBearing) {
            const parsed = parseClaimedNames(migrationSql);
            if (parsed.length > 0) {
              const { data: resolved, error: resErr } = await admin.rpc("engrep_resolve_claim", { p_names: parsed, p_day: vDay });
              if (resErr) throw new Error(`resolve_claim: ${resErr.message}`);
              claimedObjects = Array.isArray(resolved) ? resolved as string[] : [];
            }
          }
          const claimsSchema = claimedObjects.length > 0;

          let fencePath: string | null = null;
          const eng = (engineers ?? []).find((e: any) =>
            attributedEmail && Array.isArray(e.git_emails) && e.git_emails.includes(attributedEmail)
          );
          if (eng && paths.length > 0) {
            const { data: fp, error: fenceErr } = await admin.rpc("engrep_check_fence", { p_engineer_code: (eng as any).code, p_paths: paths, p_on: vDay });
            if (fenceErr) throw new Error(`check_fence: ${fenceErr.message}`);
            fencePath = (fp as string | null) ?? null;
          }

          const subject = fullMessage.split("\n")[0];
          const { data: rowId, error: ingErr } = await admin.rpc("engrep_svc_ingest_row", {
            p_window_id: windowId,
            p_source: source,
            p_evidence_ref: c.sha,
            p_commit_subject: subject,
            p_change_classes: changeClasses,
            p_engineer_code: null,
            p_author_email: attributedEmail,
            p_claims_schema: claimsSchema,
            p_migration_bearing: migrationBearing,
            p_untagged: untagged,
            p_fenced_breach: fencePath !== null,
            p_fence_path: fencePath,
            p_claimed_objects: claimedObjects,
            p_paths: paths,
            p_committed_at: c?.commit?.author?.date ?? null,
          });
          if (ingErr) throw new Error(`ingest_row: ${ingErr.message}`);
          if (rowId) {
            ingested++;
            if (source === "lovable_edit") lovableIngested++;
          }
          if (rowId) {
            // A blob SHA that moves and stays moved is, for a UI or logic file, the same
            // evidence a fingerprint move is for a function. Best-effort: a file-touch
            // failure must never abort a harvested commit.
            try {
              const touchPayload = files
                .map((f) => ({ path: String(f.filename ?? ""), blob_sha: String(f.sha ?? "") }))
                .filter((t) => t.path && t.blob_sha);
              if (touchPayload.length > 0) {
                const { data: n, error: touchErr } = await admin.rpc("engrep_svc_record_file_touches", {
                  p_window_id: windowId,
                  p_evidence_ref: c.sha,
                  p_source: source,
                  p_engineer_id: (eng as any)?.id ?? null,
                  p_touched_at: c?.commit?.author?.date ?? null,
                  p_files: touchPayload,
                });
                if (touchErr) throw new Error(touchErr.message);
                fileTouchesRecorded += Number(n ?? 0);
              }
            } catch (_touchErr) { /* file-touch evidence is best-effort */ }
          }
          if (rowId && source === "lovable_edit") {
            // The join key to Lovable's own edit feed. A metadata failure must never
            // abort a harvested commit: the row and its liveness verdict matter more.
            try {
              const editId = lovableEditId(fullMessage);
              if (editId) {
                const { error: metaErr } = await admin.rpc("engrep_svc_set_edit_meta", { p_evidence_ref: c.sha, p_edit_id: editId });
                if (metaErr) throw new Error(metaErr.message);
                editIdsCaptured++;
              }
            } catch (_metaErr) { /* title key is best-effort */ }
          }
          if (attributedEmail) authorEmails.add(attributedEmail);
          if (claimsSchema) {
            const { data: row } = await admin.from("engrep_rows").select("live_verified").eq("id", rowId).maybeSingle();
            if (row && (row as any).live_verified === "no") claimedNotLive++;
          }
        } catch (inner) {
          failed++;
          failures.push({ sha: String(c?.sha ?? "unknown"), error: String((inner as Error)?.message ?? inner) });
          continue;
        }
      }
    }

    const { data: unclaimed, error: detErr } = await admin.rpc("engrep_svc_detect_unclaimed", { p_window_id: windowId });
    if (detErr) throw new Error(`detect_unclaimed: ${detErr.message}`);

    // A partial window must never be stamped complete.
    if (!budgetExhausted) {
      const { error: markErr } = await admin.rpc("engrep_svc_mark_harvested", { p_window_id: windowId });
      if (markErr) throw new Error(`mark_harvested: ${markErr.message}`);
    }

    stats = {
      window_id: windowId,
      commits_seen: commits.length,
      commits_ingested: ingested,
      lovable_edits_ingested: lovableIngested,
      lovable_untagged: lovableUntagged,
      bots_excluded: botsExcluded,
      merges_excluded: mergesExcluded,
      no_author_email: noAuthorEmail,
      distinct_author_emails: authorEmails.size,
      coauthor_emails_seen: [...coauthorSeen],
      claimed_not_live: claimedNotLive,
      edit_ids_captured: editIdsCaptured,
      file_touches_recorded: fileTouchesRecorded,
      unclaimed_detected: unclaimed ?? 0,
      failed,
      failures,
      budget_exhausted: budgetExhausted,
      skipped_for_budget: skippedForBudget,
    };
  } catch (e) {
    fatalError = String((e as Error)?.message ?? e);
  } finally {
    if (runId) {
      try {
        await admin.rpc("engrep_svc_run_finish", {
          p_run_id: runId,
          p_window_id: windowId,
          p_outcome: fatalError ? "failed" : (failed > 0 || budgetExhausted ? "partial" : "ok"),
          p_stats: fatalError ? null : stats,
          p_error: fatalError,
        });
      } catch (_logErr) { /* a logging failure must not mask the harvest result */ }
    }
  }

  if (fatalError) return json({ error: fatalError }, 500);
  return json(stats ?? {});
});
