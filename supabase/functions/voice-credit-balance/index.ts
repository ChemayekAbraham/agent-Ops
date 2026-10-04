/**
 * Voice / SMS credit balance — reads the Africa's Talking account balance.
 *
 * Read-only. Restricted to technology / executive roles via
 * `public.voice_call_log_authorized`.
 */
import { createClient } from 'npm:@supabase/supabase-js@2';

// Manual CORS headers (project standard — do not import corsHeaders).
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  const admin = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    { auth: { persistSession: false } },
  );

  const token = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '');
  if (!token) return json({ error: 'unauthenticated' }, 401);
  const { data: userData, error: userErr } = await admin.auth.getUser(token);
  if (userErr || !userData?.user) return json({ error: 'unauthenticated' }, 401);

  const { data: allowed } = await admin.rpc('voice_call_log_authorized', { _user_id: userData.user.id });
  if (allowed !== true) return json({ error: 'not_authorized' }, 403);

  const username = Deno.env.get('AFRICASTALKING_USERNAME');
  const apiKey = Deno.env.get('AFRICASTALKING_API_KEY');
  if (!username || !apiKey) return json({ error: 'provider_not_configured' }, 200);

  const host = username === 'sandbox'
    ? 'https://api.sandbox.africastalking.com'
    : 'https://api.africastalking.com';

  try {
    const res = await fetch(`${host}/version1/user?username=${encodeURIComponent(username)}`, {
      headers: { apiKey, Accept: 'application/json' },
    });
    const text = await res.text();
    if (!res.ok) return json({ error: 'provider_error', status: res.status, detail: text.slice(0, 400) }, 200);

    let balanceRaw = '';
    try {
      balanceRaw = JSON.parse(text)?.UserData?.balance ?? '';
    } catch {
      balanceRaw = '';
    }
    const match = /([A-Z]{3})\s*([\d.,]+)/.exec(String(balanceRaw));
    return json({
      balance_raw: balanceRaw,
      currency: match?.[1] ?? null,
      amount: match ? Number(match[2].replace(/,/g, '')) : null,
      checked_at: new Date().toISOString(),
    });
  } catch (e) {
    return json({ error: 'fetch_failed', detail: String(e).slice(0, 300) }, 200);
  }
});
