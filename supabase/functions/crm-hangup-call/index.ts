/**
 * CRM Call Centre — hang up / cancel an outbound call.
 *
 * Two layers, because Africa's Talking has no single reliable "kill this leg"
 * REST call for an outbound leg that is merely ringing:
 *
 *  1. AUTHORITATIVE — `crm_cancel_call` flags the telephony row. The voice
 *     callback (`crm-voice-callback`) then answers the very next provider event
 *     for that session with <Hangup/> and never bridges. This always works, but
 *     it only bites the moment AT posts again (i.e. when the handset answers or
 *     the ring times out).
 *
 *  2. BEST EFFORT — ask the provider to drop the leg now via the Voice
 *     `dequeueInteractiveCall` endpoint for the staff leg and, if already
 *     bridged, the customer leg. AT accepts this only while the leg sits in a
 *     queue/bridge it controls, so a failure here is normal and never fails the
 *     request: the flag from layer 1 still ends the call.
 *
 * Nothing about the caller is trusted from the body beyond the session id — the
 * RPC in layer 1 is the ownership check.
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

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface ProviderAttempt {
  leg: 'staff' | 'target';
  phone: string;
  ok: boolean;
  status: number | null;
  detail: string | null;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);

  const token = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '');
  if (!token) return json({ error: 'unauthorized' }, 401);

  const body = await req.json().catch(() => ({}));
  const callId = String((body as Record<string, unknown>).callId ?? '').trim();
  if (!UUID_RE.test(callId)) return json({ error: 'invalid_call_id' }, 400);

  const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
  const admin = createClient(supabaseUrl, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, {
    auth: { persistSession: false },
  });

  const { data: userData, error: userErr } = await admin.auth.getUser(token);
  if (userErr || !userData?.user) return json({ error: 'unauthorized' }, 401);

  // ---- layer 1: authoritative cancel (also the ownership check) ----
  const userClient = createClient(supabaseUrl, Deno.env.get('SUPABASE_ANON_KEY')!, {
    auth: { persistSession: false },
    global: { headers: { Authorization: `Bearer ${token}` } },
  });

  const { error: cancelErr } = await userClient.rpc('crm_cancel_call', { p_session_id: callId });
  if (cancelErr) {
    console.error('[crm-hangup-call] crm_cancel_call failed', {
      callId,
      code: cancelErr.code,
      message: cancelErr.message,
    });
    return json({ error: 'cancel_failed', message: cancelErr.message }, 400);
  }

  // ---- layer 2: best-effort provider drop ----
  const username = Deno.env.get('AFRICASTALKING_USERNAME');
  const apiKey = Deno.env.get('AFRICASTALKING_API_KEY');
  const attempts: ProviderAttempt[] = [];

  if (username && apiKey) {
    const { data: session } = await admin
      .from('crm_call_sessions')
      .select('staff_phone, target_phone, status')
      .eq('id', callId)
      .maybeSingle();

    const base = username.toLowerCase() === 'sandbox'
      ? 'https://voice.sandbox.africastalking.com'
      : 'https://voice.africastalking.com';

    const legs: Array<{ leg: 'staff' | 'target'; phone: string | null }> = [
      { leg: 'staff', phone: session?.staff_phone ?? null },
      { leg: 'target', phone: session?.target_phone ?? null },
    ];

    for (const { leg, phone } of legs) {
      if (!phone) continue;
      try {
        const res = await fetch(`${base}/dequeueInteractiveCall`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            Accept: 'application/json',
            apiKey,
          },
          body: new URLSearchParams({ username, phoneNumber: phone }),
        });
        const raw = (await res.text()).slice(0, 400);
        attempts.push({ leg, phone, ok: res.ok, status: res.status, detail: raw || null });
      } catch (e) {
        attempts.push({
          leg,
          phone,
          ok: false,
          status: null,
          detail: e instanceof Error ? e.message : 'network_error',
        });
      }
    }

    // Provider refusals are expected for a leg AT is not queueing — log, don't fail.
    console.log('[crm-hangup-call] provider drop attempts', { callId, attempts });
  }

  return json({
    cancelled: true,
    // true only when the provider itself accepted an immediate drop
    providerDropped: attempts.some((a) => a.ok),
    attempts,
  });
});
