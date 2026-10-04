// Semrush branded-keyword + backlink tracker for the Welile brand.
//
// On invoke it pulls, through the Lovable Semrush connector gateway:
//   1. Branded keyword metrics (welile, welile.com, welile app, welile receipts)
//   2. The primary domain's organic ranking summary (welileapp.com)
//   3. The domain's backlink profile summary (authority, total links, ref domains)
// It stores a snapshot row for historical tracking and returns the current
// reading plus recent history. Read-only against Semrush; the free plan has a
// small daily API-unit budget, so callers should snapshot sparingly (the weekly
// cron + manual refresh from the CTO dashboard).

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const GATEWAY = "https://connector-gateway.lovable.dev/semrush";
const DOMAIN = "welileapp.com";
const DATABASE = "us";
const BRAND_PHRASES = ["welile", "welile.com", "welile app", "welile receipts"];

function semrushHeaders() {
  const lovableKey = Deno.env.get("LOVABLE_API_KEY");
  const semrushKey = Deno.env.get("SEMRUSH_API_KEY");
  if (!lovableKey || !semrushKey) throw new Error("Semrush connector credentials missing");
  return {
    Authorization: `Bearer ${lovableKey}`,
    "X-Connection-Api-Key": semrushKey,
  };
}

// Semrush report responses use { data: { columnNames, rows } } or an in-band
// "ERROR NN :: NOTHING FOUND" sentinel inside columnNames when a target isn't
// in the index (common for brand-new domains). Normalize both here.
function parseReport(json: any): { columns: string[]; rows: any[][]; note?: string } {
  const cols: string[] = json?.data?.columnNames ?? [];
  const rows: any[][] = json?.data?.rows ?? [];
  const note = cols[0]?.includes("ERROR") ? cols[0] : undefined;
  return { columns: note ? [] : cols, rows, note };
}

async function gwGet(path: string): Promise<{ ok: boolean; status: number; json: any }> {
  const res = await fetch(`${GATEWAY}${path}`, { headers: semrushHeaders() });
  const text = await res.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch { json = { raw: text }; }
  // Detect exhausted quota (surfaced as an error body).
  if (typeof json?.error === "string" && /LIMIT EXCEEDED/i.test(json.error)) {
    return { ok: false, status: 429, json };
  }
  return { ok: res.ok, status: res.status, json };
}

async function fetchBrandKeywords() {
  // phrase_these takes a ;-separated phrase list in a single API call.
  const phrase = encodeURIComponent(BRAND_PHRASES.join(";"));
  const r = await gwGet(
    `/keywords/phrase_these?phrase=${phrase}&database=${DATABASE}&export_columns=Ph,Nq,Cp,Co,Kd`,
  );
  if (!r.ok) return { error: r.json?.error ?? `HTTP ${r.status}`, keywords: [] };
  const { rows, note } = parseReport(r.json);
  const keywords = rows.map((row) => ({
    keyword: row[0],
    volume: Number(row[1] ?? 0),
    cpc: Number(row[2] ?? 0),
    competition: Number(row[3] ?? 0),
    difficulty: Number(row[4] ?? 0),
  }));
  return { note, keywords };
}

async function fetchDomainSummary() {
  const r = await gwGet(
    `/domains/domain_ranks?domain=${DOMAIN}&database=${DATABASE}&export_columns=Db,Dn,Rk,Or,Ot,Oc`,
  );
  if (!r.ok) return { error: r.json?.error ?? `HTTP ${r.status}` };
  const { rows, note } = parseReport(r.json);
  if (note || rows.length === 0) return { indexed: false, note: note ?? "NOTHING FOUND" };
  const row = rows[0];
  return {
    indexed: true,
    rank: Number(row[2] ?? 0),
    organic_keywords: Number(row[3] ?? 0),
    organic_traffic: Number(row[4] ?? 0),
    organic_cost: Number(row[5] ?? 0),
  };
}

async function fetchBacklinks() {
  const r = await gwGet(
    `/backlinks/backlinks_overview?target=${DOMAIN}&target_type=root_domain&export_columns=ascore,total,domains_num,urls_num,follows_num,nofollows_num`,
  );
  if (!r.ok) return { error: r.json?.error ?? `HTTP ${r.status}` };
  const { rows, note } = parseReport(r.json);
  if (note || rows.length === 0) return { indexed: false, note: note ?? "NOTHING FOUND" };
  const row = rows[0];
  return {
    indexed: true,
    authority_score: Number(row[0] ?? 0),
    total_backlinks: Number(row[1] ?? 0),
    referring_domains: Number(row[2] ?? 0),
    referring_urls: Number(row[3] ?? 0),
    follow_links: Number(row[4] ?? 0),
    nofollow_links: Number(row[5] ?? 0),
  };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const admin = createClient(supabaseUrl, serviceKey);

  try {
    let body: any = {};
    try { body = await req.json(); } catch { /* history-only or empty body */ }
    const source: string = body?.source === "cron" ? "cron" : "manual";
    const historyOnly = body?.history_only === true;

    if (!historyOnly) {
      const [brand, domainSummary, backlinks] = await Promise.all([
        fetchBrandKeywords(),
        fetchDomainSummary(),
        fetchBacklinks(),
      ]);

      const snapshot = {
        source,
        domain: DOMAIN,
        brand_keywords: brand.keywords ?? [],
        domain_summary: domainSummary,
        backlinks_summary: backlinks,
        raw: { brand, domainSummary, backlinks },
      };

      const { error: insErr } = await admin.from("semrush_brand_snapshots").insert(snapshot);
      if (insErr) console.error("snapshot insert failed:", insErr.message);
    }

    const { data: history } = await admin
      .from("semrush_brand_snapshots")
      .select("id, captured_at, source, domain, brand_keywords, domain_summary, backlinks_summary")
      .order("captured_at", { ascending: false })
      .limit(30);

    return new Response(
      JSON.stringify({ ok: true, checked_at: new Date().toISOString(), latest: history?.[0] ?? null, history: history ?? [] }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" }, status: 200 },
    );
  } catch (err) {
    console.error("semrush-brand-tracker error:", err);
    return new Response(
      JSON.stringify({ ok: false, error: err instanceof Error ? err.message : String(err) }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" }, status: 500 },
    );
  }
});