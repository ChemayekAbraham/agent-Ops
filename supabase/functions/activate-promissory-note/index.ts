// Links a promissory note to the signed-in caller through activate_promissory_note (owner-run, bound to
// the caller's JWT). No service-role client: after the Partner Returns cut-off the database refuses direct
// linking, and a pre-cut-off note with an open frozen window links only to a caller whose confirmed phone or
// email matches it (owner decision D3). Built on the security branch's contract (5e2ad5e930): the account
// is always the caller; a user_id in the body is ignored (old and new pages still send it).
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.49.4';
import { mapError } from './mapError.ts';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version',
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  try {
    const jwt = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '').trim();
    if (!jwt) return json({ error: 'Please sign in to activate this note', code: 'AUTH_REQUIRED' }, 401);

    const body = await req.json().catch(() => ({}));
    const token = (body as { token?: unknown })?.token;
    if (!token || typeof token !== 'string') {
      return json({ error: 'Token is required' }, 400);
    }

    const userClient = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_ANON_KEY')!, {
      global: { headers: { Authorization: `Bearer ${jwt}` } },
      auth: { persistSession: false },
    });
    const { data, error } = await userClient.rpc('activate_promissory_note', { p_token: token });
    if (error) {
      const mapped = mapError(error);
      if (mapped.status === 500) console.error('[activate-promissory-note] RPC failed:', error.code, error.message);
      return json(mapped.body, mapped.status);
    }

    // { success, already_active, note_id, amount, status, return_rate, monthly_return, your_rate }.
    // The old page reads only success / already_active.
    return json(data, 200);
  } catch (err) {
    console.error('[activate-promissory-note] failed:', (err as Error)?.message);
    return json({ error: 'Activation failed. Please try again.', code: 'ACTIVATION_FAILED' }, 500);
  }
});
