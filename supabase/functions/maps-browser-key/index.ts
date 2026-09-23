// Hands the Google Maps browser key to the signed-in app.
// The key is referrer-restricted and is only ever used to load the Maps script
// in the browser, so it is a publishable value — but it is kept in the secret
// store rather than the codebase so it can be rotated without a code change.

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
};

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const key = Deno.env.get('GOOGLE_API_KEY') ?? Deno.env.get('GOOGLE_MAPS_BROWSER_KEY');

    if (!key) {
      return new Response(
        JSON.stringify({ error: 'Google Maps key is not configured.' }),
        { status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      );
    }

    return new Response(JSON.stringify({ key }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json', 'Cache-Control': 'private, max-age=3600' },
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error('maps-browser-key failed:', message);
    return new Response(JSON.stringify({ error: message }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
