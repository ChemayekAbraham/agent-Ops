/**
 * help-center-sync — copies help.welileapp.com into public.help_center_articles so the assistant
 * can search it without browsing the web while someone is chatting.
 *
 * Trust model:
 *   - Callable only with a service-role key (cron or an operator). Anyone else: 401.
 *     The caller's token is accepted if it equals this function's SUPABASE_SERVICE_ROLE_KEY, or if it
 *     passes an admin-only Auth call (only a real service-role key can). That second path keeps the
 *     function working when the runtime's copy of the key differs from the dashboard's (rotation,
 *     legacy vs new key format). An anon/authenticated token fails the admin call: 401.
 *   - Fetches ONE fixed host. The sitemap decides which pages, but a URL on any other host, any
 *     non-https URL, /search and /tags/ pages are skipped, and redirects off-host are refused.
 *   - Page text is stored as plain text (scripts, styles and markup removed). Nothing from a page
 *     is ever executed or treated as an instruction; the assistant fences it as untrusted data.
 *   - If the sitemap cannot be read or looks wrong, nothing is deleted; the last good copy stays.
 */
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const HOST = "help.welileapp.com";
const SITEMAP = `https://${HOST}/sitemap.xml`;
const MAX_PAGES = 300;
const MAX_PAGE_BYTES = 1_500_000;
const MAX_BODY_CHARS = 40_000;
const CONCURRENCY = 5;
const MIN_SITEMAP_URLS = 20; // below this the sitemap is presumed broken: keep what we have

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** True only for a genuine service-role credential. */
async function isServiceRole(token: string, envKey: string): Promise<boolean> {
  if (!token) return false;
  if (envKey && timingSafeEqual(token, envKey)) return true;
  try {
    const probe = createClient(Deno.env.get("SUPABASE_URL")!, token, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    // The Auth admin API rejects every key that is not service-role.
    const { error } = await probe.auth.admin.listUsers({ page: 1, perPage: 1 });
    return !error;
  } catch {
    return false;
  }
}

function allowedUrl(raw: string): URL | null {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    return null;
  }
  if (u.protocol !== "https:" || u.hostname !== HOST) return null;
  if (/^\/(search|tags)(\/|$)/.test(u.pathname)) return null;
  u.hash = "";
  u.search = "";
  return u;
}

async function fetchText(url: string): Promise<string | null> {
  const res = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(10_000), headers: { "User-Agent": "WelileAssistantSync/1.0" } });
  // A redirect is followed by hand, only if it stays on the same host.
  if (res.status >= 300 && res.status < 400) {
    const loc = res.headers.get("location");
    const next = loc ? allowedUrl(new URL(loc, url).toString()) : null;
    if (!next) return null;
    return fetchText(next.toString());
  }
  if (!res.ok) return null;
  const len = Number(res.headers.get("content-length") ?? 0);
  if (len > MAX_PAGE_BYTES) return null;
  const text = await res.text();
  return text.length > MAX_PAGE_BYTES ? null : text;
}

const ENTITIES: Record<string, string> = { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#39;": "'", "&nbsp;": " " };

function htmlToText(html: string): { title: string; body: string } {
  const h1 = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i)?.[1];
  const titleTag = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1];
  const strip = (s: string) => s.replace(/<[^>]+>/g, " ").replace(/&(?:amp|lt|gt|quot|#39|nbsp);/g, (m) => ENTITIES[m] ?? " ").replace(/\s+/g, " ").trim();
  const title = strip(h1 ?? titleTag ?? "").replace(/\s*\|\s*[^|]*$/, "").slice(0, 200);

  // Prefer the article; fall back to main. Remove everything that is not reading content.
  let region = html.match(/<article[\s\S]*?<\/article>/i)?.[0] ?? html.match(/<main[\s\S]*?<\/main>/i)?.[0] ?? "";
  region = region
    .replace(/<(script|style|noscript|svg|nav|footer|aside|button|form)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<\/(p|div|li|h[1-6]|tr|br)>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n");
  const body = region
    .replace(/<[^>]+>/g, " ")
    .replace(/&(?:amp|lt|gt|quot|#39|nbsp);/g, (m) => ENTITIES[m] ?? " ")
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n+/g, "\n")
    .trim()
    .slice(0, MAX_BODY_CHARS);
  return { title, body };
}

async function sha256(text: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  const envKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  const token = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "").trim();
  if (!(await isServiceRole(token, envKey))) return json({ error: "unauthorized" }, 401);

  // Writes use the runtime's own key when present, otherwise the caller's verified service-role token.
  const db = createClient(Deno.env.get("SUPABASE_URL")!, envKey || token, { auth: { persistSession: false, autoRefreshToken: false } });

  const sitemap = await fetchText(SITEMAP).catch(() => null);
  const urls = [...new Set(
    [...(sitemap ?? "").matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)]
      .map((m) => allowedUrl(m[1].replace(/&amp;/g, "&"))?.toString())
      .filter((u): u is string => !!u),
  )].slice(0, MAX_PAGES);

  if (urls.length < MIN_SITEMAP_URLS) {
    return json({ ok: false, reason: "sitemap_unusable", urls: urls.length }, 502);
  }

  const { data: existing, error: readError } = await db.from("help_center_articles").select("url, content_hash");
  if (readError) return json({ ok: false, reason: "read_failed" }, 500);
  const known = new Map((existing ?? []).map((r: { url: string; content_hash: string }) => [r.url, r.content_hash]));

  let added = 0, changed = 0, unchanged = 0, failed = 0;
  const reached = new Set<string>();

  for (let i = 0; i < urls.length; i += CONCURRENCY) {
    await Promise.all(urls.slice(i, i + CONCURRENCY).map(async (url) => {
      try {
        const html = await fetchText(url);
        if (!html) { failed++; return; }
        const { title, body } = htmlToText(html);
        if (!title || body.length < 80) { failed++; return; } // an empty shell is not an article
        reached.add(url);
        const hash = await sha256(`${title}\n${body}`);
        const prev = known.get(url);
        const now = new Date().toISOString();
        if (prev === hash) {
          unchanged++;
          await db.from("help_center_articles").update({ fetched_at: now }).eq("url", url);
          return;
        }
        const { error } = await db.from("help_center_articles").upsert(
          { url, path: new URL(url).pathname, title, body, content_hash: hash, fetched_at: now, changed_at: now },
          { onConflict: "url" },
        );
        if (error) { failed++; return; }
        prev ? changed++ : added++;
      } catch {
        failed++;
      }
    }));
  }

  // Remove pages that left the sitemap, but only when this run reached most of it.
  let removed = 0;
  if (reached.size >= urls.length * 0.8) {
    const live = new Set(urls);
    const gone = [...known.keys()].filter((u) => !live.has(u));
    if (gone.length) {
      const { error } = await db.from("help_center_articles").delete().in("url", gone);
      if (!error) removed = gone.length;
    }
  }

  return json({ ok: true, sitemap_urls: urls.length, added, changed, unchanged, failed, removed });
});
