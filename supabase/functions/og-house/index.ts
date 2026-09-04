import { createClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const SITE_URL = "https://welileapp.com";

function formatUGX(amount: number): string {
  return `UGX ${amount.toLocaleString("en-UG")}`;
}

// Escape any listing-derived text before it is embedded in the HTML/meta output
// so a malicious title or location can never inject markup or script.
function esc(s: unknown): string {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  const url = new URL(req.url);
  // Support both ?id=UUID and ?c=SHORT_CODE
  const houseId = url.searchParams.get("id");
  const shortCode = url.searchParams.get("c");

  if (!houseId && !shortCode) {
    return new Response("Missing house id or code", { status: 400 });
  }

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
  );

  let query = supabase
    .from("house_listings")
    .select("id, short_code, title, region, district, daily_rate, image_urls, house_category, number_of_rooms");

  if (shortCode) {
    query = query.eq("short_code", shortCode);
  } else {
    query = query.eq("id", houseId);
  }

  const { data: house } = await query.limit(1).single();

  if (!house) {
    return new Response(null, {
      status: 302,
      headers: { Location: SITE_URL, ...corsHeaders },
    });
  }

  const title = `${house.title} — ${formatUGX(house.daily_rate)}/day | Welile`;
  const description = `${house.house_category?.replace(/_/g, " ")} • ${house.number_of_rooms} rooms in ${house.region}${house.district ? `, ${house.district}` : ""}. ${formatUGX(house.daily_rate)}/day. Pay as you stay with Welile!`;
  const image = house.image_urls?.[0] || `${SITE_URL}/og-image.png`;
  const houseUrl = `${SITE_URL}/house/${house.id}`;

  const html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8" />
  <title>${esc(title)}</title>
  <meta name="description" content="${esc(description)}" />

  <!-- Open Graph -->
  <meta property="og:type" content="website" />
  <meta property="og:url" content="${esc(houseUrl)}" />
  <meta property="og:title" content="${esc(title)}" />
  <meta property="og:description" content="${esc(description)}" />
  <meta property="og:image" content="${esc(image)}" />
  <meta property="og:image:width" content="1200" />
  <meta property="og:image:height" content="630" />
  <meta property="og:site_name" content="Welile" />

  <!-- Twitter -->
  <meta name="twitter:card" content="summary_large_image" />
  <meta name="twitter:title" content="${esc(title)}" />
  <meta name="twitter:description" content="${esc(description)}" />
  <meta name="twitter:image" content="${esc(image)}" />

  <!-- Redirect to the actual app page -->
  <meta http-equiv="refresh" content="0;url=${esc(houseUrl)}" />
</head>
<body>
  <p>Redirecting to <a href="${esc(houseUrl)}">${esc(title)}</a>...</p>
</body>
</html>`;

  return new Response(html, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      ...corsHeaders,
    },
  });
});
