import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });

const BOT_MARKERS = ["lovable", "bot@", "[bot]", "noreply@github.com"];

function isBot(email: string | null, login: string | null): boolean {
  const hay = `${(email ?? "").toLowerCase()} ${(login ?? "").toLowerCase()}`;
  return BOT_MARKERS.some((m) => hay.includes(m));
}

function kampalaToday(): string {
  // en-CA yields YYYY-MM-DD
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Africa/Kampala",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

const CLASSES = [
  "ddl",
  "rls",
  "function",
  "trigger",
  "edge_function",
  "ui",
  "config",
] as const;

function classifyPath(path: string, set: Set<string>) {
  if (path.includes("supabase/migrations/")) set.add("ddl");
  if (path.includes("supabase/functions/")) set.add("edge_function");
  if (path.startsWith("src/") && (path.endsWith(".tsx") || path.endsWith(".css"))) {
    set.add("ui");
  }
  const base = path.split("/").pop() ?? "";
  if (
    base === "config.toml" ||
    base === "package.json" ||
    /^tailwind\.config\./.test(base) ||
    /^vite\.config\./.test(base)
  ) {
    set.add("config");
  }
}

function classifySql(sql: string, set: Set<string>) {
  if (/policy|row level security/i.test(sql)) set.add("rls");
  if (/create\s+(or\s+replace\s+)?function/i.test(sql)) set.add("function");
  if (/create\s+trigger/i.test(sql)) set.add("trigger");
}

function parseClaimedNames(sql: string): string[] {
  const names = new Set<string>();
  const re =
    /\b(?:create|alter|drop)\s+(?:or\s+replace\s+)?(?:unique\s+)?(?:table|function|policy|trigger|view|index)\s+(?:if\s+not\s+exists\s+|if\s+exists\s+)?(?:only\s+)?"?([A-Za-z_][A-Za-z0-9_]*)"?(?:\."?([A-Za-z_][A-Za-z0-9_]*)"?)?/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(sql)) !== null) {
    const name = m[2] ?? m[1];
    if (name) names.add(name);
  }
  return [...names];
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  const repo = Deno.env.get("ENGREP_GITHUB_REPO");
  const token = Deno.env.get("ENGREP_GITHUB_TOKEN");
  if (!repo || !token) {
    return json(
      {
        error:
          "engrep-harvest-commits: ENGREP_GITHUB_REPO and ENGREP_GITHUB_TOKEN must both be configured. Nothing was written.",
      },
      500,
    );
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const admin = createClient(supabaseUrl, serviceKey, {
    auth: { persistSession: false },
  });

  try {
    // (a) window: 17:00 EAT yesterday -> 17:00 EAT today == 14:00Z yesterday -> 14:00Z today
    const vDay = kampalaToday();
    const untilISO = `${vDay}T14:00:00Z`;
    const untilMs = Date.parse(untilISO);
    const sinceISO = new Date(untilMs - 24 * 60 * 60 * 1000).toISOString()
      .replace(/\.\d{3}Z$/, "Z");

    // (b) window row
    const { data: windowId, error: winErr } = await admin.rpc(
      "engrep_svc_ensure_window",
      { p_granularity: "day", p_day: vDay },
    );
    if (winErr) throw new Error(`ensure_window: ${winErr.message}`);

    const gh = async (url: string) => {
      const res = await fetch(url, {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.github+json",
          "User-Agent": "welile-engrep-harvest",
        },
      });
      if (!res.ok) {
        throw new Error(`github ${res.status}: ${(await res.text()).slice(0, 300)}`);
      }
      return await res.json();
    };

    // (c) list commits in the window
    const commits: any[] = [];
    for (let page = 1; page <= 20; page++) {
      const batch = await gh(
        `https://api.github.com/repos/${repo}/commits?since=${
          encodeURIComponent(sinceISO)
        }&until=${encodeURIComponent(untilISO)}&per_page=100&page=${page}`,
      );
      if (!Array.isArray(batch) || batch.length === 0) break;
      commits.push(...batch);
      if (batch.length < 100) break;
    }

    let botsExcluded = 0;
    let ingested = 0;
    let claimedNotLive = 0;
    const authorEmails = new Set<string>();

    // engineer lookup by git email
    const { data: engineers } = await admin
      .from("engrep_engineers")
      .select("code, git_emails");

    for (const c of commits) {
      const email: string | null = c?.commit?.author?.email ?? null;
      const login: string | null = c?.author?.login ?? null;
      if (isBot(email, login)) {
        botsExcluded++;
        continue;
      }

      // (e) commit detail for the file list
      const detail = await gh(
        `https://api.github.com/repos/${repo}/commits/${c.sha}`,
      );
      const files: any[] = Array.isArray(detail?.files) ? detail.files : [];
      const paths: string[] = files.map((f) => String(f.filename ?? ""));

      const classes = new Set<string>();
      let migrationSql = "";
      for (const f of files) {
        const path = String(f.filename ?? "");
        classifyPath(path, classes);
        if (path.includes("supabase/migrations/")) {
          migrationSql += `\n${String(f.patch ?? "")}`;
        }
      }
      if (migrationSql.trim().length > 0) classifySql(migrationSql, classes);

      const changeClasses = [...classes].filter((c) =>
        (CLASSES as readonly string[]).includes(c)
      );
      const migrationBearing = paths.some((p) =>
        p.includes("supabase/migrations/")
      );

      // (h) claimed objects
      let claimedObjects: string[] = [];
      if (migrationBearing) {
        const parsed = parseClaimedNames(migrationSql);
        if (parsed.length > 0) {
          const { data: resolved, error: resErr } = await admin.rpc(
            "engrep_resolve_claim",
            { p_names: parsed, p_day: vDay },
          );
          if (resErr) throw new Error(`resolve_claim: ${resErr.message}`);
          claimedObjects = Array.isArray(resolved) ? resolved as string[] : [];
        }
      }
      const claimsSchema = claimedObjects.length > 0;

      // (i) fence check when the author email maps to an engineer
      let fencePath: string | null = null;
      const eng = (engineers ?? []).find((e: any) =>
        email && Array.isArray(e.git_emails) && e.git_emails.includes(email)
      );
      if (eng && paths.length > 0) {
        const { data: fp, error: fenceErr } = await admin.rpc(
          "engrep_check_fence",
          {
            p_engineer_code: (eng as any).code,
            p_paths: paths,
            p_day: vDay,
          },
        );
        if (fenceErr) throw new Error(`check_fence: ${fenceErr.message}`);
        fencePath = (fp as string | null) ?? null;
      }

      // (j) ingest
      const subject = String(c?.commit?.message ?? "").split("\n")[0];
      const { data: rowId, error: ingErr } = await admin.rpc(
        "engrep_svc_ingest_row",
        {
          p_window_id: windowId,
          p_source: "external_commit",
          p_evidence_ref: c.sha,
          p_commit_subject: subject,
          p_change_classes: changeClasses,
          p_engineer_code: null,
          p_author_email: email,
          p_claims_schema: claimsSchema,
          p_migration_bearing: migrationBearing,
          p_fenced_breach: fencePath !== null,
          p_fence_path: fencePath,
          p_claimed_objects: claimedObjects,
        },
      );
      if (ingErr) throw new Error(`ingest_row(${c.sha}): ${ingErr.message}`);
      if (rowId) ingested++;
      if (email) authorEmails.add(email);
      if (claimsSchema) {
        const { data: row } = await admin
          .from("engrep_rows")
          .select("live_verified")
          .eq("id", rowId)
          .maybeSingle();
        if (row && (row as any).live_verified === "no") claimedNotLive++;
      }
    }

    // (k) detection + harvest stamp
    const { data: unclaimed, error: detErr } = await admin.rpc(
      "engrep_svc_detect_unclaimed",
      { p_window_id: windowId },
    );
    if (detErr) throw new Error(`detect_unclaimed: ${detErr.message}`);

    const { error: markErr } = await admin.rpc("engrep_svc_mark_harvested", {
      p_window_id: windowId,
    });
    if (markErr) throw new Error(`mark_harvested: ${markErr.message}`);

    // (l)
    return json({
      window_id: windowId,
      commits_seen: commits.length,
      commits_ingested: ingested,
      bots_excluded: botsExcluded,
      distinct_author_emails: authorEmails.size,
      claimed_not_live: claimedNotLive,
      unclaimed_detected: unclaimed ?? 0,
    });
  } catch (e) {
    return json({ error: String((e as Error)?.message ?? e) }, 500);
  }
});
