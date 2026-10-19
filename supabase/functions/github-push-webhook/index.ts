import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// GitHub "push" webhook receiver. Records every push (who pushed, which branch,
// the commits and files) in public.github_push_events so the CTO dashboard can
// show push history that survives force-pushes and deleted branches.
//
// Called by GitHub, not by a signed-in user, so verify_jwt is off and the only
// gate is the HMAC signature over the raw body (X-Hub-Signature-256) computed
// with GITHUB_WEBHOOK_SECRET — the same secret entered on the GitHub webhook.

const MAX_MESSAGE = 1000;

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

async function hmacHex(secret: string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));
  return Array.from(new Uint8Array(sig)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

interface GhPushCommit {
  id: string;
  message?: string;
  timestamp?: string;
  url?: string;
  distinct?: boolean;
  author?: { name?: string; email?: string; username?: string };
  added?: string[];
  removed?: string[];
  modified?: string[];
}

interface GhPushPayload {
  ref: string;
  before?: string;
  after?: string;
  created?: boolean;
  deleted?: boolean;
  forced?: boolean;
  compare?: string;
  commits?: GhPushCommit[];
  head_commit?: { message?: string } | null;
  repository?: { full_name?: string };
  pusher?: { name?: string; email?: string };
  sender?: { login?: string; avatar_url?: string };
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  const secret = Deno.env.get("GITHUB_WEBHOOK_SECRET");
  if (!secret) {
    console.error("GITHUB_WEBHOOK_SECRET is not set");
    return json({ error: "not_configured" }, 500);
  }

  const raw = await req.text();
  const header = req.headers.get("x-hub-signature-256") ?? "";
  const expected = `sha256=${await hmacHex(secret, raw)}`;
  if (!timingSafeEqual(header, expected)) return json({ error: "invalid_signature" }, 401);

  const event = req.headers.get("x-github-event") ?? "";
  const deliveryId = req.headers.get("x-github-delivery") ?? "";
  if (event === "ping") return json({ ok: true, pong: true });
  if (event !== "push") return json({ ok: true, ignored: event }, 202);
  if (!deliveryId) return json({ error: "missing_delivery_id" }, 400);

  let p: GhPushPayload;
  try {
    p = JSON.parse(raw);
  } catch {
    return json({ error: "invalid_json" }, 400);
  }
  if (!p?.ref) return json({ error: "missing_ref" }, 400);

  const isTag = p.ref.startsWith("refs/tags/");
  const branch = p.ref.replace(/^refs\/(heads|tags)\//, "");

  let filesAdded = 0, filesRemoved = 0, filesModified = 0;
  const commits = (p.commits ?? []).map((c) => {
    filesAdded += c.added?.length ?? 0;
    filesRemoved += c.removed?.length ?? 0;
    filesModified += c.modified?.length ?? 0;
    return {
      sha: c.id,
      message: (c.message ?? "").slice(0, MAX_MESSAGE),
      author_name: c.author?.name ?? null,
      author_email: c.author?.email ?? null,
      author_login: c.author?.username ?? null,
      timestamp: c.timestamp ?? null,
      url: c.url ?? null,
      distinct: c.distinct ?? true,
      added: c.added ?? [],
      removed: c.removed ?? [],
      modified: c.modified ?? [],
    };
  });

  const admin = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  const { error } = await admin.from("github_push_events").upsert(
    {
      delivery_id: deliveryId,
      repo_full_name: p.repository?.full_name ?? "unknown",
      ref: p.ref,
      branch,
      is_tag: isTag,
      pusher_name: p.pusher?.name ?? null,
      pusher_email: p.pusher?.email ?? null,
      sender_login: p.sender?.login ?? null,
      sender_avatar_url: p.sender?.avatar_url ?? null,
      before_sha: p.before ?? null,
      after_sha: p.after ?? null,
      created: !!p.created,
      deleted: !!p.deleted,
      forced: !!p.forced,
      compare_url: p.compare ?? null,
      commit_count: commits.length,
      distinct_commit_count: commits.filter((c) => c.distinct).length,
      head_commit_message: p.head_commit?.message?.split("\n")[0].slice(0, 200) ?? null,
      commits,
      files_added: filesAdded,
      files_removed: filesRemoved,
      files_modified: filesModified,
    },
    { onConflict: "delivery_id", ignoreDuplicates: true },
  );

  if (error) {
    // 500 makes GitHub mark the delivery failed, so it can be redelivered.
    console.error("github_push_events insert failed:", error.message);
    return json({ error: "store_failed" }, 500);
  }

  return json({ ok: true, delivery_id: deliveryId, branch, commits: commits.length });
});
