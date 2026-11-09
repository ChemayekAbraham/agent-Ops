// What the promissory-note activation page shows, through lookup_promissory_note (anyone holding the link).
// No service-role client: the RPC returns contact HINTS only (never the typed phone/email; the old page's
// whatsapp_number/email keys come back empty), and a note's Returns rate only when it is not a person's
// rate or the note is the caller's own (_promissory_note_rate_view). The caller's Authorization is
// forwarded so a signed-in partner sees their own note's rate; an expired session is retried once with
// the anon key so the note still shows (without linked_to_me).
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.49.4';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version',
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });

interface RpcErrorLike { code?: string | null; message?: string | null }

/** An expired or malformed session (retry as anon). */
function isSessionError(error: RpcErrorLike | null | undefined): boolean {
  const code = String(error?.code ?? '');
  return code === 'PGRST301' || code === 'PGRST302' || String(error?.message ?? '').includes('JWT');
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  try {
    const body = await req.json().catch(() => ({}));
    const token = (body as { token?: unknown })?.token;
    if (!token || typeof token !== 'string') {
      return json({ error: 'Token is required' }, 400);
    }

    const url = Deno.env.get('SUPABASE_URL')!;
    const anonKey = Deno.env.get('SUPABASE_ANON_KEY')!;
    const lookup = (authorization: string) =>
      createClient(url, anonKey, {
        global: { headers: { Authorization: authorization } },
        auth: { persistSession: false },
      }).rpc('lookup_promissory_note', { p_token: token });

    const callerAuth = (req.headers.get('Authorization') ?? '').trim();
    let { data, error } = await lookup(callerAuth || `Bearer ${anonKey}`);
    if (error && callerAuth && isSessionError(error)) {
      ({ data, error } = await lookup(`Bearer ${anonKey}`));
    }

    if (error) {
      console.error('[lookup-promissory-note] RPC failed:', error.code, error.message);
      return json({ error: 'Could not load this note. Please try again.' }, 500);
    }
    if (data === null || data === undefined) {
      return json({ error: 'Note not found' }, 404);
    }

    // Same envelope as before: { note }. Keys: id, partner_name, amount, contribution_type, deduction_day,
    // status, total_collected, created_at, whatsapp_hint, email_hint, whatsapp_number (''), email (''),
    // linked_to_me, return_rate, monthly_return.
    return json({ note: data }, 200);
  } catch (err) {
    console.error('[lookup-promissory-note] failed:', (err as Error)?.message);
    return json({ error: 'Could not load this note. Please try again.' }, 500);
  }
});
