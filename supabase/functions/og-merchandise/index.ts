import { createClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const SITE_URL = "https://welileapp.com";

function formatUGX(amount: number): string {
  return `UGX ${Number(amount || 0).toLocaleString("en-UG")}`;
}

function esc(s: string): string {
  return String(s || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// Brand fallback used when an item has no photo at all.
const FALLBACK_IMAGE = `${SITE_URL}/welile-logo.png`;

function clamp(s: string, max: number): string {
  const t = String(s || "").replace(/\s+/g, " ").trim();
  return t.length <= max ? t : `${t.slice(0, max - 1).trimEnd()}…`;
}

/**
 * The merchandise storage bucket is PRIVATE, so a crawler hitting
 * /storage/v1/object/public/... gets a 400 "Bucket not found" and WhatsApp
 * falls back to whatever generic image it can find (the Welile logo).
 * Instead we always advertise og:image as this same function with `img=1`,
 * and stream the real item photo ourselves, cropped to an exact 1200x630
 * landscape card via the authenticated storage render endpoint.
 */
function storagePath(raw: string): { bucket: string; path: string } | null {
  const src = String(raw || "").trim();
  const m = src.match(/\/storage\/v1\/(?:object|render\/image)\/(?:public|authenticated|sign)\/([^/]+)\/(.+)$/);
  if (!m) return null;
  return { bucket: m[1], path: m[2].split("?")[0] };
}

async function streamItemImage(raw: string): Promise<Response> {
  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const loc = storagePath(raw);

  const attempts: string[] = [];
  if (loc) {
    attempts.push(
      `${supabaseUrl}/storage/v1/render/image/authenticated/${loc.bucket}/${loc.path}?width=1200&height=630&resize=cover&quality=80`,
      `${supabaseUrl}/storage/v1/object/authenticated/${loc.bucket}/${loc.path}`,
    );
  } else if (/^https?:\/\//i.test(String(raw || "").trim())) {
    attempts.push(String(raw).trim());
  }
  attempts.push(FALLBACK_IMAGE);

  for (const url of attempts) {
    try {
      const isOwn = url.startsWith(supabaseUrl);
      const res = await fetch(url, {
        headers: isOwn ? { Authorization: `Bearer ${serviceKey}`, apikey: serviceKey } : {},
      });
      const type = res.headers.get("content-type") || "";
      if (res.ok && type.startsWith("image/")) {
        const bytes = new Uint8Array(await res.arrayBuffer());
        return new Response(bytes, {
          headers: {
            "Content-Type": type,
            "Cache-Control": "public, max-age=86400",
            ...corsHeaders,
          },
        });
      }
    } catch (_e) {
      // try the next candidate
    }
  }

  return new Response(null, {
    status: 302,
    headers: { Location: FALLBACK_IMAGE, ...corsHeaders },
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  const url = new URL(req.url);
  // Accept ?id=<uuid>, a bare trailing <uuid>, and the readable slug form
  // /og-merchandise/<slug>-<uuid> used by newly shared links.
  const pathId = url.pathname.split("/").filter(Boolean).pop() ?? "";
  const uuidInPath = pathId.match(
    /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i,
  );
  const segments = url.pathname.split("/").filter(Boolean);
  // Short branded links arrive as ?code=<code> (proxied from
  // s.welileapp.com/m/<code>) or as /og-merchandise/m/<code>.
  const shareCode =
    url.searchParams.get("code") ||
    (segments.length >= 2 && segments[segments.length - 2] === "m"
      ? segments[segments.length - 1]
      : null);
  let itemId =
    url.searchParams.get("id") ||
    (uuidInPath ? uuidInPath[1] : /^[0-9a-f-]{16,}$/i.test(pathId) ? pathId : null);
  const source = url.searchParams.get("src");
  // img=1 → stream the item photo itself (used as og:image target).
  const imageMode = url.searchParams.get("img") === "1";
  // verify=1 → preview verification tool: render the same tags but do not
  // record an analytics open, so tests never pollute share stats.
  const verifyMode = url.searchParams.get("verify") === "1";
  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
  );

  if (!itemId && shareCode && /^(welile-)?[a-z0-9]{4,16}$/i.test(shareCode)) {
    const { data: codeRow } = await supabase
      .from("merchandise_share_codes")
      .select("catalog_id")
      .eq("code", shareCode.toLowerCase())
      .maybeSingle();
    itemId = codeRow?.catalog_id ?? null;
  }

  if (!itemId) {
    return new Response("Missing item id", { status: 400, headers: corsHeaders });
  }

  const { data: item } = await supabase
    .from("merchandise_catalog")
    .select("id, item_name, description, unit_price, image_url, image_urls")
    .eq("id", itemId)
    .limit(1)
    .maybeSingle();

  if (imageMode) {
    const imgs: string[] = Array.isArray(item?.image_urls)
      ? (item!.image_urls as string[]).filter((u) => typeof u === "string" && u.trim())
      : [];
    return await streamItemImage(imgs[0] || item?.image_url || "");
  }

  const target = `${SITE_URL}/merchandise?item=${encodeURIComponent(itemId)}`;

  // Analytics: record every time a shared merchandise link is opened, and which
  // item was clicked. Link-preview crawlers are flagged separately from humans.
  const userAgent = req.headers.get("user-agent") ?? "";
  const isBot =
    /bot|crawler|spider|facebookexternalhit|whatsapp|twitterbot|slackbot|telegrambot|linkedinbot|discordbot|preview|embedly|pinterest|vkshare|skypeuripreview|googlebot|bingbot|redditbot/i.test(
      userAgent,
    );
  try {
    if (verifyMode) throw new Error("skip-tracking");
    await supabase.from("merchandise_share_opens").insert({
      catalog_id: itemId,
      item_name: item?.item_name ?? null,
      is_bot: isBot,
      user_agent: userAgent.slice(0, 500),
      referrer: (req.headers.get("referer") ?? "").slice(0, 500) || null,
      source: source ? source.slice(0, 50) : null,
      share_code: shareCode ? shareCode.slice(0, 32).toLowerCase() : null,
    });
  } catch (e) {
    if (!verifyMode) console.error("share open tracking failed", e);
  }

  if (!item) {
    return new Response(null, {
      status: 302,
      headers: { Location: `${SITE_URL}/merchandise`, ...corsHeaders },
    });
  }

  // Humans never need the meta document: send them straight to the store page.
  // Only link-preview crawlers (and the verification tool) get the OG HTML.
  if (!isBot && !verifyMode) {
    return new Response(null, {
      status: 302,
      headers: {
        Location: `${SITE_URL}/merchandise?item=${encodeURIComponent(itemId)}`,
        "Cache-Control": "no-store",
        ...corsHeaders,
      },
    });
  }

  const images: string[] = Array.isArray(item.image_urls)
    ? item.image_urls.filter((u) => typeof u === "string" && u.trim())
    : [];
  const name = clamp(item.item_name || "Welile Merchandise", 70);
  const priceText = formatUGX(Number(item.unit_price));

  const hasPhoto = Boolean(images[0] || item.image_url);
  // Always point crawlers at our own streaming endpoint: it works for private
  // buckets, guarantees a 1200x630 landscape crop, and falls back internally.
  const imageVersion = encodeURIComponent(
    String(images[0] || item.image_url || "").slice(-48),
  );
  const image = hasPhoto
    ? `${Deno.env.get("SUPABASE_URL")}/functions/v1/og-merchandise?id=${encodeURIComponent(itemId)}&img=1&v=${imageVersion}`
    : FALLBACK_IMAGE;
  const picked = hasPhoto
    ? { width: 1200, height: 630, type: "image/jpeg" as string | undefined }
    : { width: undefined as number | undefined, height: undefined as number | undefined, type: "image/png" as string | undefined };

  // Fallback chain so the card is never blank: item title → generic label,
  // item description → generated sentence. Lengths are clamped to what
  // WhatsApp/Facebook actually display before truncating mid-word.
  const title = clamp(`${name} — ${priceText} | Welile Merchandise`, 90);
  const description = clamp(
    item.description ||
      `${name} available on Welile Merchandise for ${priceText}. Pay from your Welile wallet.`,
    200,
  );

  const html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8" />
  <title>${esc(title)}</title>
  <meta name="description" content="${esc(description)}" />

  <meta property="og:type" content="product" />
  <meta property="og:url" content="${esc(target)}" />
  <meta property="og:title" content="${esc(title)}" />
  <meta property="og:description" content="${esc(description)}" />
  <meta property="og:image" content="${esc(image)}" />
  <meta property="og:image:secure_url" content="${esc(image)}" />
${picked.width ? `  <meta property="og:image:width" content="${picked.width}" />\n  <meta property="og:image:height" content="${picked.height}" />\n` : ""}${picked.type ? `  <meta property="og:image:type" content="${picked.type}" />\n` : ""}  <meta property="og:image:alt" content="${esc(name)}" />
  <meta property="og:site_name" content="Welile" />
  <meta property="og:locale" content="en_UG" />
  <meta property="product:price:amount" content="${esc(String(Number(item.unit_price) || 0))}" />
  <meta property="product:price:currency" content="UGX" />

  <meta name="twitter:card" content="${picked.width ? "summary_large_image" : "summary"}" />
  <meta name="twitter:title" content="${esc(title)}" />
  <meta name="twitter:description" content="${esc(description)}" />
  <meta name="twitter:image" content="${esc(image)}" />
  <meta name="twitter:image:alt" content="${esc(name)}" />

  <link rel="canonical" href="${esc(target)}" />
</head>
<body>
  <p>Redirecting to <a href="${esc(target)}">${esc(name)}</a>...</p>
</body>
</html>`;

  return new Response(html, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "public, max-age=300",
      ...corsHeaders,
    },
  });
});
