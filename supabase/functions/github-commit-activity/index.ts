import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

const DEFAULT_OWNER = "weliletenants-sys";
const DEFAULT_REPO = "welilereceipts-com-98bba33b";
const ALLOWED_ROLES = ["cto", "ceo", "super_admin", "manager"];

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

interface GhCommit {
  sha: string;
  html_url: string;
  commit: {
    message: string;
    author: { name?: string; email?: string; date?: string } | null;
  };
  author: { login?: string; avatar_url?: string; html_url?: string } | null;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const adminClient = createClient(supabaseUrl, serviceKey);

    const authHeader = req.headers.get("authorization") || req.headers.get("Authorization") || "";
    if (!authHeader.startsWith("Bearer ")) return json({ error: "Unauthorized" }, 401);

    const token = authHeader.replace("Bearer ", "");
    const { data: { user }, error: authError } = await adminClient.auth.getUser(token);
    if (authError || !user) return json({ error: "Unauthorized" }, 401);

    const { data: roles, error: roleError } = await adminClient
      .from("user_roles")
      .select("role")
      .eq("user_id", user.id)
      .in("role", ALLOWED_ROLES);
    if (roleError) return json({ error: roleError.message }, 500);
    if (!roles?.length) return json({ error: "Insufficient permissions" }, 403);

    let days = 30;
    let page = 1;
    const perPage = 20;
    let owner = DEFAULT_OWNER;
    let repo = DEFAULT_REPO;
    let authorFilter: string | null = null;
    if (req.method === "POST") {
      try {
        const body = await req.json();
        if (body && typeof body === "object") {
          const d = Number((body as Record<string, unknown>).days);
          if (Number.isFinite(d) && d >= 0 && d <= 3650) days = Math.floor(d);
          const p = Number((body as Record<string, unknown>).page);
          if (Number.isFinite(p) && p >= 1 && p <= 1000) page = Math.floor(p);
          const a = (body as Record<string, unknown>).author;
          if (typeof a === "string" && a.trim() && a.length <= 200) authorFilter = a.trim();
          const o = (body as Record<string, unknown>).owner;
          const r = (body as Record<string, unknown>).repo;
          if (typeof o === "string" && /^[A-Za-z0-9._-]{1,100}$/.test(o)) owner = o;
          if (typeof r === "string" && /^[A-Za-z0-9._-]{1,120}$/.test(r)) repo = r;
        }
      } catch {
        /* no body — use defaults */
      }
    }

    const ghToken = Deno.env.get("GITHUB_TOKEN");
    if (!ghToken) {
      return json({
        error: "github_not_configured",
        message: "No GitHub access is saved yet, so commits cannot be read for this private repository.",
      }, 424);
    }

    const gh = (path: string) =>
      fetch(`https://api.github.com/repos/${owner}/${repo}/${path}`, {
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${ghToken}`,
          "User-Agent": "welile-cto-dashboard",
          "X-GitHub-Api-Version": "2022-11-28",
        },
      });

    const since = days > 0 ? new Date(Date.now() - days * 86_400_000).toISOString() : null;

    // Every branch is scanned, not just the default one — collaborators who only
    // ever push to their own branch would otherwise be invisible here.
    const branchNames: string[] = [];
    for (let page = 1; page <= 3; page++) {
      const res = await gh(`branches?per_page=100&page=${page}`);
      if (!res.ok) {
        const details = await res.text();
        console.error(`GitHub branches request failed [${res.status}]: ${details}`);
        return json({ error: "github_request_failed", status: res.status, details }, res.status);
      }
      const batch = (await res.json()) as Array<{ name: string }>;
      branchNames.push(...batch.map((b) => b.name));
      if (batch.length < 100) break;
    }
    // Default branch first, then the rest (bounded so one repo cannot fan out forever).
    const branches = branchNames.length ? branchNames.slice(0, 40) : [""];

    const seen = new Set<string>();
    const commits: GhCommit[] = [];
    let truncated = false;

    for (const branch of branches) {
      for (let page = 1; page <= 5; page++) {
        const params = new URLSearchParams({ per_page: "100", page: String(page) });
        if (since) params.set("since", since);
        if (branch) params.set("sha", branch);
        const res = await gh(`commits?${params.toString()}`);
        if (!res.ok) {
          // A single unreadable branch must not blank out the whole panel.
          const details = await res.text();
          console.error(`GitHub commits request failed [${res.status}] on ${branch}: ${details}`);
          if (res.status === 401 || res.status === 403 || res.status === 404) {
            if (!commits.length) {
              return json({ error: "github_request_failed", status: res.status, details }, res.status);
            }
          }
          break;
        }
        const batch = (await res.json()) as GhCommit[];
        for (const c of batch) {
          if (seen.has(c.sha)) continue;
          seen.add(c.sha);
          commits.push(c);
        }
        if (batch.length < 100) break;
        if (page === 5) truncated = true;
      }
      if (commits.length >= 5000) {
        truncated = true;
        break;
      }
    }

    commits.sort((a, b) => {
      const da = a.commit?.author?.date ?? "";
      const db = b.commit?.author?.date ?? "";
      return db.localeCompare(da);
    });

    const feed = commits.map((c) => ({
      sha: c.sha,
      short_sha: c.sha.slice(0, 7),
      message: (c.commit?.message || "").split("\n")[0].slice(0, 200),
      author_login: c.author?.login ?? null,
      author_name: c.commit?.author?.name ?? c.author?.login ?? "Unknown",
      avatar_url: c.author?.avatar_url ?? null,
      profile_url: c.author?.html_url ?? null,
      date: c.commit?.author?.date ?? null,
      html_url: c.html_url,
    }));

    const byAuthor = new Map<string, {
      key: string;
      name: string;
      login: string | null;
      avatar_url: string | null;
      profile_url: string | null;
      commits: number;
      last_commit_at: string | null;
      first_commit_at: string | null;
    }>();
    for (const c of feed) {
      const key = c.author_login || c.author_name;
      const hit = byAuthor.get(key);
      if (hit) {
        hit.commits += 1;
        if (c.date && (!hit.last_commit_at || c.date > hit.last_commit_at)) hit.last_commit_at = c.date;
        if (c.date && (!hit.first_commit_at || c.date < hit.first_commit_at)) hit.first_commit_at = c.date;
      } else {
        byAuthor.set(key, {
          key,
          name: c.author_name,
          login: c.author_login,
          avatar_url: c.avatar_url,
          profile_url: c.profile_url,
          commits: 1,
          last_commit_at: c.date,
          first_commit_at: c.date,
        });
      }
    }

    // Everyone who has ever committed to the repository is listed, even when they
    // have nothing inside the selected window (they show as 0).
    try {
      const contribRes = await gh("contributors?per_page=100&anon=0");
      if (contribRes.ok) {
        const all = (await contribRes.json()) as Array<{
          login?: string;
          avatar_url?: string;
          html_url?: string;
        }>;
        for (const person of all) {
          const key = person.login;
          if (!key || byAuthor.has(key)) continue;
          byAuthor.set(key, {
            key,
            name: key,
            login: key,
            avatar_url: person.avatar_url ?? null,
            profile_url: person.html_url ?? null,
            commits: 0,
            last_commit_at: null,
            first_commit_at: null,
          });
        }
      } else {
        console.error(`GitHub contributors request failed [${contribRes.status}]`);
      }
    } catch (e) {
      console.error("GitHub contributors lookup failed:", e);
    }

    // "Committing since" for people whose first commit predates the scanned window:
    // walk to the last page of their own commit list and read the oldest date.
    const needSince = [...byAuthor.values()].filter((p) => p.login && !p.first_commit_at).slice(0, 12);
    for (const person of needSince) {
      try {
        const probe = await gh(`commits?author=${encodeURIComponent(person.login!)}&per_page=1`);
        if (!probe.ok) continue;
        const link = probe.headers.get("link") || "";
        const lastPage = Number(link.match(/[?&]page=(\d+)>; rel="last"/)?.[1] ?? 1);
        const firstBatch = (await probe.json()) as GhCommit[];
        if (lastPage > 1) {
          const tail = await gh(`commits?author=${encodeURIComponent(person.login!)}&per_page=1&page=${lastPage}`);
          if (tail.ok) {
            const rows = (await tail.json()) as GhCommit[];
            person.first_commit_at = rows[0]?.commit?.author?.date ?? null;
            if (!person.last_commit_at) person.last_commit_at = firstBatch[0]?.commit?.author?.date ?? null;
            continue;
          }
        }
        person.first_commit_at = firstBatch[0]?.commit?.author?.date ?? null;
        if (!person.last_commit_at) person.last_commit_at = person.first_commit_at;
      } catch (e) {
        console.error("GitHub first-commit lookup failed:", e);
      }
    }

    const filteredFeed = authorFilter
      ? feed.filter((c) => (c.author_login || c.author_name) === authorFilter)
      : feed;

    const totalPages = Math.max(1, Math.ceil(filteredFeed.length / perPage));
    const safePage = Math.min(page, totalPages);
    const pagedCommits = filteredFeed.slice((safePage - 1) * perPage, safePage * perPage);

    return json({
      repo: `${owner}/${repo}`,
      repo_url: `https://github.com/${owner}/${repo}`,
      days,
      branches_scanned: branchNames.length,
      total_commits: feed.length,
      author: authorFilter,
      filtered_commits: filteredFeed.length,
      truncated,
      page: safePage,
      per_page: perPage,
      total_pages: totalPages,
      contributors: [...byAuthor.values()].sort((a, b) => b.commits - a.commits),
      commits: pagedCommits,
    });
  } catch (e) {
    console.error("github-commit-activity failed:", e);
    return json({ error: (e as Error).message }, 500);
  }
});
