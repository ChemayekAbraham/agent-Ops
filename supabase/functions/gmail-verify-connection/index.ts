// Verifies Gmail connector credentials via the Lovable connector gateway
// and records the attempt + outcome in `gmail_reconnect_audit` for the
// staff audit trail (timestamps, latency, error details).
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.0';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers':
    'authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version',
};

const VERIFY_URL = 'https://connector-gateway.lovable.dev/api/v1/verify_credentials';

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  const adminClient = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  );

  // Identify caller for the audit row
  let initiatedBy: string | null = null;
  let initiatedByEmail: string | null = null;
  try {
    const auth = req.headers.get('Authorization') ?? '';
    const token = auth.replace(/^Bearer\s+/i, '');
    if (token) {
      const { data: u } = await adminClient.auth.getUser(token);
      initiatedBy = u?.user?.id ?? null;
      initiatedByEmail = u?.user?.email ?? null;
    }
  } catch { /* anonymous */ }

  let action: 'verify' | 'reconnect_initiated' = 'verify';
  try {
    const body = await req.clone().json();
    if (body?.action === 'reconnect_initiated') action = 'reconnect_initiated';
  } catch { /* no body */ }

  // For a "reconnect_initiated" event we just record it and return — the
  // actual reconnect is performed in the Lovable agent surface.
  if (action === 'reconnect_initiated') {
    await adminClient.from('gmail_reconnect_audit').insert({
      action,
      outcome: 'initiated',
      initiated_by: initiatedBy,
      initiated_by_email: initiatedByEmail,
    });
    return new Response(JSON.stringify({ ok: true, action, outcome: 'initiated' }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  const LOVABLE_API_KEY = Deno.env.get('LOVABLE_API_KEY');
  const GOOGLE_MAIL_API_KEY = Deno.env.get('GOOGLE_MAIL_API_KEY');
  if (!LOVABLE_API_KEY || !GOOGLE_MAIL_API_KEY) {
    const err = !LOVABLE_API_KEY ? 'LOVABLE_API_KEY missing' : 'GOOGLE_MAIL_API_KEY missing (Gmail not connected)';
    await adminClient.from('gmail_reconnect_audit').insert({
      action,
      outcome: 'error',
      error_message: err,
      initiated_by: initiatedBy,
      initiated_by_email: initiatedByEmail,
    });
    return new Response(JSON.stringify({ ok: false, error: err }), {
      status: 400,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  const startedAt = Date.now();
  let outcome: 'verified' | 'skipped' | 'failed' | 'error' = 'error';
  let latencyMs: number | null = null;
  let errorMessage: string | null = null;
  let raw: unknown = null;

  try {
    const res = await fetch(VERIFY_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${LOVABLE_API_KEY}`,
        'X-Connection-Api-Key': GOOGLE_MAIL_API_KEY,
        'Content-Type': 'application/json',
      },
    });
    const text = await res.text();
    try { raw = JSON.parse(text); } catch { raw = { body: text }; }
    latencyMs = Date.now() - startedAt;

    if (res.ok) {
      const oc = (raw as any)?.outcome;
      if (oc === 'verified' || oc === 'skipped' || oc === 'failed') {
        outcome = oc;
        if (oc === 'failed') errorMessage = (raw as any)?.error ?? 'verification failed';
      } else {
        outcome = 'error';
        errorMessage = `unexpected outcome: ${oc ?? 'none'}`;
      }
    } else {
      outcome = 'error';
      errorMessage = `gateway ${res.status}: ${(raw as any)?.message ?? text.slice(0, 300)}`;
    }
  } catch (e) {
    latencyMs = Date.now() - startedAt;
    outcome = 'error';
    errorMessage = e instanceof Error ? e.message : String(e);
  }

  await adminClient.from('gmail_reconnect_audit').insert({
    action,
    outcome,
    latency_ms: latencyMs,
    error_message: errorMessage,
    raw_response: raw as any,
    initiated_by: initiatedBy,
    initiated_by_email: initiatedByEmail,
  });

  return new Response(
    JSON.stringify({ ok: outcome === 'verified' || outcome === 'skipped', outcome, latency_ms: latencyMs, error: errorMessage }),
    { headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
  );
});