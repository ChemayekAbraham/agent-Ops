/**
 * CRM Call Centre — issue a short-lived Africa's Talking WebRTC capability token.
 *
 * The browser voice client needs a token to register with Africa's Talking. The
 * API KEY NEVER LEAVES THIS FUNCTION: the browser receives only the temporary
 * capability token, which is scoped to one client name and expires.
 *
 * Outgoing only (`outgoing: true`, `incoming: false`) — the CRM never answers
 * inbound calls.
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

/** Token lifetime. Short enough to be safe, long enough for a shift of calls. */
const EXPIRE_SECONDS = 3600;

/** Stable, space-free client name derived from the user id. */
const clientNameFor = (userId: string) => `welile_crm_${userId.replace(/[^a-zA-Z0-9]/g, '')}`.slice(0, 60);

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);

  const admin = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    { auth: { persistSession: false } },
  );

  // ---- authenticate ----
  const token = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '');
  if (!token) return json({ error: 'unauthenticated' }, 401);

  const { data: userData, error: userErr } = await admin.auth.getUser(token);
  const staff = userData?.user;
  if (userErr || !staff) return json({ error: 'unauthenticated' }, 401);

  // ---- authorise: only call-centre users may hold a voice token ----
  const { data: allowed } = await admin.rpc('crm_call_centre_authorized', { _user_id: staff.id });
  if (allowed !== true) return json({ error: 'not_authorized' }, 403);

  const username = Deno.env.get('AFRICASTALKING_USERNAME');
  const apiKey = Deno.env.get('AFRICASTALKING_API_KEY');
  const voiceNumber = Deno.env.get('AFRICASTALKING_VOICE_NUMBER');
  if (!username || !apiKey || !voiceNumber) {
    return json({ error: 'voice_not_configured' }, 503);
  }

  const clientName = clientNameFor(staff.id);

  // Africa's Talking is picky about this payload and its exact requirements have
  // varied between accounts (string vs boolean flags, with/without phoneNumber).
  // Try the known-good shapes in order and keep the first that yields a token.
  const digits = voiceNumber.replace(/[^0-9]/g, '');
  const e164 = voiceNumber.startsWith('+') ? voiceNumber : `+${digits}`;
  const candidates: Record<string, unknown>[] = [
    { username, clientName, phoneNumber: e164, incoming: 'false', outgoing: 'true', expire: String(EXPIRE_SECONDS) },
    { username, clientName, phoneNumber: e164, incoming: 'true', outgoing: 'true', expire: String(EXPIRE_SECONDS) },
    { username, clientName, incoming: 'false', outgoing: 'true', expire: String(EXPIRE_SECONDS) },
    { username, clientName, phoneNumber: e164, incoming: 'false', outgoing: 'true', lifeTimeSec: String(EXPIRE_SECONDS) },
  ];

  try {
    let res!: Response;
    let raw = '';
    let payload: { token?: string; clientName?: string; lifeTimeSec?: string; message?: string } | null = null;

    for (const [i, body] of candidates.entries()) {
      res = await fetch('https://webrtc.africastalking.com/capability-token/request', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json', apiKey },
        body: JSON.stringify(body),
      });
      raw = await res.text();
      try {
        payload = JSON.parse(raw);
      } catch {
        payload = null;
      }
      if (res.ok && payload?.token) break;
      console.error('[crm-voice-capability-token] attempt failed', {
        attempt: i,
        httpStatus: res.status,
        body: raw.slice(0, 200),
        numberShape: `${e164.length}chars`,
      });
    }


    if (!res.ok || !payload?.token) {
      // Never log the token itself; a truncated body is enough to diagnose.
      console.error('[crm-voice-capability-token] provider rejected', {
        httpStatus: res.status,
        body: raw.slice(0, 300),
      });
      return json(
        {
          error: 'token_request_failed',
          message:
            payload?.message ??
            'Africa\u2019s Talking would not issue a voice token. Check the voice number and WebRTC setup.',
        },
        502,
      );
    }

    const lifeTimeSec = Number.parseInt(payload.lifeTimeSec ?? '', 10);
    console.log('[crm-voice-capability-token] issued', {
      clientName,
      lifeTimeSec: Number.isFinite(lifeTimeSec) ? lifeTimeSec : EXPIRE_SECONDS,
    });

    // Only what the browser needs. The API key stays here.
    return json({
      token: payload.token,
      clientName: payload.clientName ?? clientName,
      expiresInSeconds: Number.isFinite(lifeTimeSec) ? lifeTimeSec : EXPIRE_SECONDS,
    });
  } catch (e) {
    console.error('[crm-voice-capability-token] provider unreachable', e);
    return json({ error: 'provider_unreachable' }, 502);
  }
});
