/**
 * CRM Call Centre — Africa's Talking voice callback (PUBLIC endpoint).
 *
 * OUTBOUND ONLY. This endpoint exists for exactly one purpose: when the staff
 * handset answers, bridge that leg to the customer with <Dial/>. It then records
 * the terminal facts (status, hangup cause, duration, cost, recording).
 *
 * INBOUND IS REJECTED. There is no IVR, no menu, no inbound answering. Anything
 * arriving with direction "Inbound" is logged and hung up.
 *
 * Because AT cannot present our JWT, nothing in the payload is trusted to
 * identify a user: the only key we honour is our own `clientRequestId` (the
 * telephony row id we generated) or the AT `sessionId` we already stored.
 */
import { createClient } from 'npm:@supabase/supabase-js@2';
// Manual CORS headers (project standard — do not import corsHeaders).
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const XML = { ...corsHeaders, 'Content-Type': 'application/xml' };

const xml = (body: string) => new Response(`<?xml version="1.0" encoding="UTF-8"?>${body}`, { headers: XML });

/** Reject the leg — used for inbound and for anything unrecognised. */
const silence = () => xml('<Response><Reject/></Response>');

/**
 * Terminal / already-handled events. AT only needs a 200; returning an empty
 * <Response/> guarantees we never issue a second <Dial> for the same leg
 * (that is what produces an endless redial loop).
 */
const done = () => xml('<Response></Response>');

/** End the leg deliberately (post-bridge, or a duplicate active callback). */
const hangup = () => xml('<Response><Hangup/></Response>');


const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function toE164(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const digits = String(raw).replace(/\D/g, '');
  if (!digits) return null;
  if (/^256[3-9]\d{8}$/.test(digits)) return `+${digits}`;
  if (/^0[3-9]\d{8}$/.test(digits)) return `+256${digits.slice(1)}`;
  if (/^[3-9]\d{8}$/.test(digits)) return `+256${digits}`;
  return null;
}

async function readPayload(req: Request): Promise<Record<string, string>> {
  const contentType = req.headers.get('content-type') ?? '';
  if (contentType.includes('application/json')) {
    const parsed = await req.json().catch(() => ({}));
    return Object.fromEntries(
      Object.entries(parsed as Record<string, unknown>).map(([k, v]) => [k, v == null ? '' : String(v)]),
    );
  }
  const form = await req.formData().catch(() => null);
  if (!form) return {};
  const out: Record<string, string> = {};
  for (const [k, v] of form.entries()) out[k] = typeof v === 'string' ? v : '';
  return out;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (req.method !== 'POST') return silence();

  const p = await readPayload(req);

  // Minimal shape validation — an AT voice payload always carries a sessionId.
  const atSessionId = p.sessionId ?? '';
  const clientRequestId = p.clientRequestId ?? '';
  if (!atSessionId && !clientRequestId) {
    console.warn('[crm-voice-callback] unrecognised payload, ignoring');
    return silence();
  }

  // ---- INBOUND: never dial, never bridge, never play a menu. ----
  if ((p.direction ?? '').toLowerCase() === 'inbound') {
    console.warn('[crm-voice-callback] inbound call rejected', {
      sessionId: atSessionId,
      caller: p.callerNumber ?? null,
    });
    return silence();
  }

  const admin = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    { auth: { persistSession: false } },
  );

  // ---- locate our row ----
  let query = admin
    .from('crm_call_sessions')
    .select('id, target_phone, status, at_session_id')
    .limit(1);

  query = UUID_RE.test(clientRequestId)
    ? query.eq('id', clientRequestId)
    : query.eq('at_session_id', atSessionId);

  const { data: session, error: lookupErr } = await query.maybeSingle();

  if (lookupErr) {
    console.error('[crm-voice-callback] session lookup failed', {
      atSessionId,
      clientRequestId,
      code: lookupErr.code,
      message: lookupErr.message,
    });
    return done();
  }

  if (!session) {
    console.warn('[crm-voice-callback] no matching session', { atSessionId, clientRequestId });
    return done();
  }

  /** Patch helper — every write is checked and logged. */
  const patch = async (values: Record<string, unknown>, label: string) => {
    const { error } = await admin.from('crm_call_sessions').update(values).eq('id', session.id);
    if (error) {
      console.error(`[crm-voice-callback] ${label} update failed`, {
        callId: session.id,
        code: error.code,
        message: error.message,
      });
    }
  };

  // Keep the provider session id attached the first time we see it.
  if (atSessionId && session.at_session_id !== atSessionId) {
    await patch({ at_session_id: atSessionId }, 'at_session_id');
  }

  const isActive = (p.isActive ?? '').trim() === '1';
  const dialStatus = (p.dialStatus ?? '').trim();
  // A leg may only be dialled while it is still in a pre-bridge state. Anything
  // else (already bridged, or already terminal) must never dial again — that is
  // the redial loop.
  const st = (session.status ?? '').toLowerCase();
  const dialable = ['initiating', 'ringing_staff'].includes(st);
  // 'bridged' is not dialable, but a post-dial outcome may still be recorded on it.
  const recordable = dialable || st === 'bridged';
  const alreadyBridged = !dialable;


  // ---------------- terminal event ----------------
  if (!isActive) {
    const duration = Number.parseInt(p.durationInSeconds ?? p.callDuration ?? '0', 10);
    const cost = Number.parseFloat((p.amount ?? '').replace(/[^\d.]/g, ''));
    const state = (p.callSessionState ?? p.status ?? '').trim() || 'completed';
    const hangupCause = (p.hangupCause ?? '').trim() || null;

    console.log('[crm-voice-callback] terminal event', {
      callId: session.id,
      atSessionId,
      state,
      hangupCause,
      dialStatus: dialStatus || null,
      duration,
    });

    await patch(
      {
        status: state.toLowerCase(),
        hangup_cause: hangupCause,
        duration_seconds: Number.isFinite(duration) ? Math.max(0, duration) : 0,
        recording_url: p.recordingUrl || null,
        cost_amount: Number.isFinite(cost) ? cost : null,
        cost_currency: p.currencyCode || null,
        ...(dialStatus && dialStatus.toLowerCase() !== 'completed'
          ? { failure_reason: `dial_${dialStatus.toLowerCase()}`.slice(0, 300) }
          : {}),
      },
      'terminal',
    );

    return done();
  }

  // ---------------- post-<Dial> callback (LOOP GUARD) ----------------
  // Once <Dial> finishes AT re-posts to this URL with the leg still active and
  // dial* fields populated. Issuing <Dial> again here is what causes an endless
  // redial loop, so we record the outcome and end the leg instead.
  const isPostDial = Boolean(dialStatus || p.dialDestinationNumber || p.dialDestinationPhoneNumber);

  if (isPostDial || alreadyBridged) {
    const dialDuration = Number.parseInt(p.dialDurationInSeconds ?? '0', 10);
    const ok = dialStatus.toLowerCase() === 'completed';

    console.log('[crm-voice-callback] ending leg without redial', {
      callId: session.id,
      atSessionId,
      sessionStatus: session.status,
      dialStatus: dialStatus || null,
      dialDuration,
      isPostDial,
    });

    // Only a real post-dial event may move the row. A stray active callback on an
    // already-terminal call is answered with <Hangup/> and nothing is overwritten.
    if (isPostDial && recordable) {
      await patch(
        {
          status: ok || !dialStatus ? 'bridged' : 'bridge_failed',
          ...(dialStatus && !ok ? { failure_reason: `dial_${dialStatus.toLowerCase()}`.slice(0, 300) } : {}),
          ...(Number.isFinite(dialDuration) && dialDuration > 0 ? { duration_seconds: dialDuration } : {}),
        },
        'post_dial',
      );
    }

    return hangup();
  }


  // ---------------- staff leg answered → bridge to the customer ----------------
  const target = toE164(session.target_phone);
  if (!target) {
    console.error('[crm-voice-callback] invalid target phone, cannot bridge', { callId: session.id });
    await patch({ status: 'failed', failure_reason: 'invalid_target_phone' }, 'invalid_target');
    return hangup();
  }

  await patch({ status: 'bridged' }, 'bridged');

  // Recording is OFF unless explicitly enabled. The spoken notice would only
  // ever reach the staff leg, never the customer, so enabling it without a
  // customer-side notice would be a consent problem.
  const record = (Deno.env.get('CRM_CALL_RECORDING') ?? '').toLowerCase() === 'true';

  console.log('[crm-voice-callback] bridging staff leg to target', {
    callId: session.id,
    atSessionId,
    record,
  });

  return xml(
    `<Response><Dial phoneNumbers="${target}"${record ? ' record="true"' : ''}/></Response>`,
  );

});
