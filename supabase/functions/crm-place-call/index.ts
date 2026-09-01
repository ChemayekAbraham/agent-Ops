/**
 * CRM Call Centre — place an OUTBOUND call (agent-leg-first bridge).
 *
 * Africa's Talking rings the STAFF member's own handset first. Success here
 * therefore means "your handset is about to ring", NOT "the customer is
 * connected". The bridge to the customer happens in `crm-voice-callback`, which
 * answers AT with <Dial phoneNumbers="…"/> once the staff leg picks up.
 */
import { createClient } from 'npm:@supabase/supabase-js@2';
// Manual CORS headers (project standard — do not import corsHeaders).
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });

/** Uganda-aware E.164 normaliser. Returns `+256…` or null. */
function toE164(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const digits = String(raw).replace(/\D/g, '');
  if (!digits) return null;
  if (/^256[3-9]\d{8}$/.test(digits)) return `+${digits}`;
  if (/^0[3-9]\d{8}$/.test(digits)) return `+256${digits.slice(1)}`;
  if (/^[3-9]\d{8}$/.test(digits)) return `+256${digits}`;
  return null;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);

  const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  const admin = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } });

  // ---- auth ----
  const token = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '');
  if (!token) return json({ error: 'unauthenticated' }, 401);
  const { data: userData, error: userErr } = await admin.auth.getUser(token);
  const staff = userData?.user;
  if (userErr || !staff) return json({ error: 'unauthenticated' }, 401);

  const { data: allowed } = await admin.rpc('crm_call_centre_authorized', { _user_id: staff.id });
  if (allowed !== true) return json({ error: 'not_authorized' }, 403);

  // ---- input ----
  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return json({ error: 'invalid_json' }, 400);
  }

  const targetUserId = typeof body.targetUserId === 'string' ? body.targetUserId : null;
  const targetName = typeof body.targetName === 'string' ? body.targetName.slice(0, 160) : '';
  const targetRole = typeof body.targetRole === 'string' ? body.targetRole : 'tenant';
  const targetLocation = typeof body.targetLocation === 'string' ? body.targetLocation.slice(0, 160) : null;

  if (!targetUserId && typeof body.targetPhone !== 'string') {
    return json({ error: 'target_required' }, 400);
  }

  // Resolve the number server-side from the person id — the client is never
  // trusted with, nor required to hold, the raw phone number. NOTE: read the
  // profile directly; the `crm_reveal_target_phone` RPC gates on auth.uid(),
  // which is NULL under the service-role client and would always throw.
  let targetPhone: string | null = null;
  if (targetUserId) {
    const { data: prof } = await admin
      .from('profiles')
      .select('phone')
      .eq('id', targetUserId)
      .maybeSingle();
    targetPhone = toE164(typeof prof?.phone === 'string' ? prof.phone : null);
  }
  if (!targetPhone && typeof body.targetPhone === 'string') targetPhone = toE164(body.targetPhone);
  if (!targetPhone) return json({ error: 'invalid_target_phone' }, 400);


  // ---- the staff leg ----
  const { data: staffProfile } = await admin
    .from('profiles')
    .select('phone, full_name')
    .eq('id', staff.id)
    .maybeSingle();

  const staffPhone = toE164(staffProfile?.phone ?? null);
  if (!staffPhone) {
    return json(
      { error: 'staff_phone_missing', message: 'Add your own phone number in Settings before making calls.' },
      400,
    );
  }

  const voiceNumber = Deno.env.get('AFRICASTALKING_VOICE_NUMBER');
  const username = Deno.env.get('AFRICASTALKING_USERNAME');
  const apiKey = Deno.env.get('AFRICASTALKING_API_KEY');
  if (!voiceNumber || !username || !apiKey) {
    return json({ error: 'voice_not_configured' }, 503);
  }

  // ---- telephony row first, so a provider failure is still recorded ----
  const { data: session, error: insertErr } = await admin
    .from('crm_call_sessions')
    .insert({
      staff_id: staff.id,
      staff_phone: staffPhone,
      target_user_id: targetUserId,
      target_role: targetRole,
      target_name: targetName,
      target_phone: targetPhone,
      target_location: targetLocation,
      direction: 'Outbound',
      status: 'initiating',
    })
    .select('id')
    .single();

  if (insertErr || !session) {
    console.error('[crm-place-call] insert failed', insertErr);
    return json({ error: 'could_not_record_call' }, 500);
  }

  // ---- ring the staff handset ----
  const isSandbox = username.toLowerCase() === 'sandbox';
  const endpoint = isSandbox
    ? 'https://voice.sandbox.africastalking.com/call'
    : 'https://voice.africastalking.com/call';

  try {
    const form = new URLSearchParams({
      username,
      from: voiceNumber,
      to: staffPhone,
      clientRequestId: session.id,
    });

    const res = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
        apiKey,
      },
      body: form,
    });

    const raw = await res.text();
    let payload: {
      entries?: Array<{ sessionId?: string; status?: string; errorMessage?: string; phoneNumber?: string }>;
      errorMessage?: string;
    } | null = null;
    try {
      payload = JSON.parse(raw);
    } catch {
      payload = null;
    }

    const entry = payload?.entries?.[0];
    const entryStatus = (entry?.status ?? '').toLowerCase();
    // AT reports acceptance as Queued (occasionally Success / Ringing).
    const providerOk = res.ok && ['queued', 'success', 'ringing'].includes(entryStatus);

    if (!providerOk) {
      // Full provider echo — a bare "None" errorMessage is useless on its own.
      console.error('[crm-place-call] provider rejected', {
        callId: session.id,
        httpStatus: res.status,
        entryStatus: entry?.status ?? null,
        body: raw.slice(0, 800),
      });
      const detail = entry?.errorMessage && entry.errorMessage !== 'None' ? entry.errorMessage : null;
      const reason =
        detail ??
        (payload?.errorMessage && payload.errorMessage !== 'None' ? payload.errorMessage : null) ??
        (entry?.status ? `provider_status_${entry.status}` : `provider_http_${res.status}`);

      // Operator-readable mapping for the statuses that actually happen.
      const known: Record<string, { code: string; message: string; http: number }> = {
        insufficientcredit: {
          code: 'voice_insufficient_credit',
          message: 'Voice calling is out of credit. Top up the Africa\u2019s Talking voice account, then retry.',
          http: 402,
        },
        invalidphonenumber: {
          code: 'invalid_staff_phone',
          message: 'Your own phone number is not a valid number Africa\u2019s Talking can ring.',
          http: 400,
        },
        throttled: {
          code: 'provider_throttled',
          message: 'Africa\u2019s Talking is throttling calls. Wait a moment and try again.',
          http: 429,
        },
      };
      const mapped = known[entryStatus];

      await admin
        .from('crm_call_sessions')
        .update({
          status: 'failed',
          failure_reason: String(mapped?.code ?? reason).slice(0, 300),
        })
        .eq('id', session.id);

      return json(
        {
          error: mapped?.code ?? 'provider_rejected',
          message: mapped?.message ?? String(reason),
          providerStatus: entry?.status ?? null,
          callId: session.id,
        },
        mapped?.http ?? 502,
      );

    }

    console.log('[crm-place-call] provider accepted', {
      callId: session.id,
      atSessionId: entry?.sessionId ?? null,
      entryStatus,
    });


    await admin
      .from('crm_call_sessions')
      .update({ at_session_id: entry?.sessionId ?? null, status: 'ringing_staff' })
      .eq('id', session.id);

    return json({
      callId: session.id,
      atSessionId: entry?.sessionId ?? null,
      staffPhone,
      // Deliberate wording: the staff handset rings first.
      message: 'Your handset is about to ring. Answer it and we will connect the call.',
    });
  } catch (e) {
    console.error('[crm-place-call] provider error', e);
    await admin
      .from('crm_call_sessions')
      .update({ status: 'failed', failure_reason: 'provider_unreachable' })
      .eq('id', session.id);
    return json({ error: 'provider_unreachable', callId: session.id }, 502);
  }
});
