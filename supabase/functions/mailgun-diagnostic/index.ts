const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  const key = Deno.env.get('MAILGUN_API_KEY') ?? '';
  const domain = Deno.env.get('MAILGUN_DOMAIN') ?? '';
  const results: Record<string, unknown> = {
    key_present: key.length > 0,
    key_length: key.length,
    key_prefix: key.slice(0, 4),
    key_has_whitespace: key !== key.trim(),
    domain,
  };

  for (const base of ['https://api.mailgun.net', 'https://api.eu.mailgun.net']) {
    try {
      const res = await fetch(`${base}/v3/domains`, {
        headers: { Authorization: `Basic ${btoa(`api:${key.trim()}`)}` },
      });
      const body = await res.text();
      results[base] = { status: res.status, body: body.slice(0, 400) };
    } catch (e) {
      results[base] = { error: String(e) };
    }
  }

  return new Response(JSON.stringify(results, null, 2), {
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
});
