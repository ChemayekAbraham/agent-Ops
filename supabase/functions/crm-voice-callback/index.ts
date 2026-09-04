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
  /**
   * Set by Africa's Talking ONLY when the leg originated in a browser voice
   * client (`client.call("+256…")`). It is the number the CRM user dialled, and
   * it is how we recognise a WebRTC call: the browser cannot send us a
   * clientRequestId, so the number + the pending row is the correlation key.
   */
  const clientDialedNumber = toE164(
    p.clientDialedNumber || p.clientDialledNumber || p.dialedNumber || null,
  );

  if (!atSessionId && !clientRequestId && !clientDialedNumber) {
    console.warn('[crm-voice-callback] unrecognised payload, ignoring');
    return silence();
  }

  // ---- INBOUND: never dial, never bridge, never play a menu. ----
  // A browser-client leg can arrive flagged Inbound (the call enters AT *from*
  // our client), so it is exempted — it is still an outbound CRM call.
  if ((p.direction ?? '').toLowerCase() === 'inbound' && !clientDialedNumber) {
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

  const COLS =
    'id, target_phone, status, at_session_id, cancel_requested_at, transport, answered_at, ended_at, at_client_name';

  // ---- locate our row ----
  let session: {
    id: string;
    target_phone: string | null;
    status: string | null;
    at_session_id: string | null;
    cancel_requested_at: string | null;
    transport: string | null;
    answered_at: string | null;
    ended_at: string | null;
    at_client_name: string | null;
  } | null = null;

  if (UUID_RE.test(clientRequestId)) {
    const { data } = await admin.from('crm_call_sessions').select(COLS).eq('id', clientRequestId).maybeSingle();
    session = data ?? null;
  }

  if (!session && atSessionId) {
    const { data } = await admin
      .from('crm_call_sessions')
      .select(COLS)
      .eq('at_session_id', atSessionId)
      .maybeSingle();
    session = data ?? null;
  }

  // Browser-originated leg: match the newest still-live WebRTC row the CRM user
  // opened for that number (created by `crm_start_webrtc_call`).
  if (!session && clientDialedNumber) {
    const { data } = await admin
      .from('crm_call_sessions')
      .select(COLS)
      .eq('transport', 'webrtc')
      .eq('target_phone', clientDialedNumber)
      .is('ended_at', null)
      .gte('created_at', new Date(Date.now() - 5 * 60_000).toISOString())
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    session = data ?? null;
  }

  if (!session) {
    console.warn('[crm-voice-callback] no matching session', {
      atSessionId,
      clientRequestId,
      clientDialedNumber,
    });
    return clientDialedNumber
      // Never leave a live browser leg hanging with no instruction.
      ? xml(`<Response><Dial phoneNumbers="${clientDialedNumber}"/></Response>`)
      : done();
  }

  /** Stable non-null handle, so closures below keep the narrowing. */
  const row = session;

  /** Patch helper — every write is checked and logged. */
  const patch = async (values: Record<string, unknown>, label: string) => {
    const { error } = await admin.from('crm_call_sessions').update(values).eq('id', row.id);
    if (error) {
      console.error(`[crm-voice-callback] ${label} update failed`, {
        callId: row.id,
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
  const isWebrtc = (session.transport ?? 'pstn') === 'webrtc';
  /** A call is finalised exactly once — whoever gets there first wins. */
  const alreadyEnded = Boolean(session.ended_at);

  const numeric = (raw: string | undefined) => {
    const n = Number.parseInt(raw ?? '', 10);
    return Number.isFinite(n) ? Math.max(0, n) : null;
  };
  const costOf = () => {
    const n = Number.parseFloat((p.amount ?? '').replace(/[^\d.]/g, ''));
    return Number.isFinite(n) ? n : null;
  };

  /** Africa's Talking callSessionState / dialStatus → our internal status. */
  const mapState = (state: string, answered: boolean): string => {
    switch (state.trim().toLowerCase()) {
      case 'dialing':
        return 'ringing';
      case 'ringing':
        return 'ringing';
      case 'bridged':
        return 'active';
      case 'active':
        return 'active';
      case 'completed':
        return answered ? 'completed' : 'not_answered';
      case 'notanswered':
      case 'noanswer':
        return 'not_answered';
      case 'busy':
        return 'busy';
      case 'rejected':
        return 'rejected';
      case 'expired':
      case 'failed':
        return 'failed';
      default:
        return answered ? 'completed' : 'not_answered';
    }
  };

  const endedByFor = (cause: string | null): string => {
    if (row.cancel_requested_at) return 'crm_user';
    switch ((cause ?? '').toUpperCase()) {
      case 'CALL_REJECTED':
      case 'USER_BUSY':
      case 'NO_ANSWER':
      case 'NO_USER_RESPONSE':
      case 'SUBSCRIBER_ABSENT':
        return 'remote_party';
      case 'SERVICE_UNAVAILABLE':
      case 'USER_NOT_REGISTERED':
      case 'UNALLOCATED_NUMBER':
      case 'NORMAL_TEMPORARY_FAILURE':
      case 'RECOVERY_ON_TIMER_EXPIRE':
        return 'network';
      default:
        // NORMAL_CLEARING alone does not say which side hung up.
        return 'unknown';
    }
  };

  // ---------------- CANCELLED BY STAFF (honour it before anything else) ----
  // For a PSTN leg the only way to end it is to answer its callback with
  // <Hangup/>. For a WebRTC leg the browser's own `client.hangup()` ends it,
  // but the flag still guarantees we never bridge a dropped call.
  if (session.cancel_requested_at && !alreadyEnded) {
    console.log('[crm-voice-callback] cancel requested — hanging up leg', {
      callId: session.id,
      atSessionId,
      isActive,
      transport: session.transport,
      dialStatus: dialStatus || null,
    });

    if (!isActive) {
      await patch(
        {
          status: 'cancelled',
          hangup_cause: (p.hangupCause ?? '').trim() || 'ORIGINATOR_CANCEL',
          duration_seconds: numeric(p.durationInSeconds ?? p.callDuration) ?? 0,
          cost_amount: costOf(),
          cost_currency: p.currencyCode || null,
          is_active: false,
          ended_at: new Date().toISOString(),
          ended_by: 'crm_user',
        },
        'cancelled_terminal',
      );
      return done();
    }

    return hangup();
  }

  // A leg may only be dialled while it is still in a pre-bridge state. Anything
  // else (already bridged, or already terminal) must never dial again — that is
  // the redial loop.
  const st = (session.status ?? '').toLowerCase();
  const dialable = !alreadyEnded && ['initiating', 'ringing_staff', 'ringing'].includes(st);
  // 'bridged' is not dialable, but a post-dial outcome may still be recorded on it.
  const recordable = dialable || ['bridged', 'active'].includes(st);
  const alreadyBridged = !dialable;


  // ---------------- terminal event ----------------
  // Authoritative: callSessionState = Completed / NotAnswered, or isActive = 0.
  if (!isActive) {
    const duration = numeric(p.durationInSeconds ?? p.callDuration) ?? 0;
    const rawState = (p.callSessionState ?? p.status ?? '').trim();
    const answered =
      Boolean(session.answered_at) ||
      duration > 0 ||
      dialStatus.toLowerCase() === 'completed';
    const mapped = mapState(rawState, answered);
    // AT frequently omits `hangupCause` on the session-level terminal event.
    // Leaving it null loses the reason in call history, so derive it from what
    // the provider did tell us.
    const hangupCause =
      (p.hangupCause ?? '').trim().toUpperCase() ||
      (session.cancel_requested_at
        ? 'ORIGINATOR_CANCEL'
        : dialStatus.toLowerCase() === 'busy'
          ? 'USER_BUSY'
          : answered
            ? 'NORMAL_CLEARING'
            : mapped === 'not_answered'
              ? 'NO_ANSWER'
              : mapped === 'failed'
                ? 'SERVICE_UNAVAILABLE'
                : null);


    console.log('[crm-voice-callback] terminal event', {
      callId: session.id,
      atSessionId,
      rawState,
      mapped,
      hangupCause,
      dialStatus: dialStatus || null,
      duration,
      alreadyEnded,
    });

    // Duplicate callbacks (AT retries) must not rewrite the outcome. The
    // provider's duration/cost/recording are still worth absorbing, since AT's
    // `durationInSeconds` is the authoritative talk time.
    await patch(
      alreadyEnded
        ? {
            ...(duration > 0 ? { duration_seconds: duration } : {}),
            ...(p.recordingUrl ? { recording_url: p.recordingUrl } : {}),
            // Backfill only what is still missing — never rewrite an outcome.
            ...(!(session as any).hangup_cause && hangupCause ? { hangup_cause: hangupCause } : {}),
            ...(costOf() !== null ? { cost_amount: costOf(), cost_currency: p.currencyCode || null } : {}),

          }
        : {
            status: mapped,
            hangup_cause: hangupCause,
            duration_seconds: duration,
            recording_url: p.recordingUrl || null,
            cost_amount: costOf(),
            cost_currency: p.currencyCode || null,
            is_active: false,
            ended_at: new Date().toISOString(),
            ended_by: endedByFor(hangupCause),
            ...(dialStatus && dialStatus.toLowerCase() !== 'completed'
              ? { failure_reason: `dial_${dialStatus.toLowerCase()}`.slice(0, 300) }
              : {}),
          },
      alreadyEnded ? 'terminal_duplicate' : 'terminal',
    );

    return done();
  }

  // ---------------- dial ANSWERED (pick-up), not yet finished ----------------
  // The moment the customer picks up, AT re-posts with the leg still active and
  // a dial destination but NO `dialStatus` (that only arrives once the dial is
  // over). Treating that as "post-dial" used to hang the bridge up about two
  // seconds after pick-up and file the call as not answered. It is a pick-up:
  // record it and answer with an empty <Response/> so the bridge keeps talking.
  const dialDestination = p.dialDestinationNumber || p.dialDestinationPhoneNumber || '';
  const dialAnswered = Boolean(dialDestination) && !dialStatus;

  if (dialAnswered && !alreadyEnded) {
    console.log('[crm-voice-callback] dial answered — keeping the bridge up', {
      callId: session.id,
      atSessionId,
      sessionStatus: session.status,
      transport: session.transport,
      dialDestination,
    });

    await patch(
      {
        status: 'active',
        is_active: true,
        ...(session.answered_at ? {} : { answered_at: new Date().toISOString() }),
      },
      'dial_answered',
    );

    return done();
  }

  // ---------------- post-<Dial> callback (LOOP GUARD) ----------------
  // Once <Dial> finishes AT re-posts to this URL with the leg still active and
  // dial* fields populated. Issuing <Dial> again here is what causes an endless
  // redial loop, so we record the outcome and end the leg instead.
  const isPostDial = Boolean(dialStatus || dialDestination);

  if (isPostDial || alreadyBridged) {
    const dialDuration = numeric(p.dialDurationInSeconds) ?? 0;
    const ok = dialStatus.toLowerCase() === 'completed';

    console.log('[crm-voice-callback] ending leg without redial', {
      callId: session.id,
      atSessionId,
      sessionStatus: session.status,
      transport: session.transport,
      dialStatus: dialStatus || null,
      dialDuration,
      isPostDial,
    });

    // Only a real post-dial event may move the row. A stray active callback on an
    // already-terminal call is answered with <Hangup/> and nothing is overwritten.
    if (isPostDial && recordable && !alreadyEnded) {
      // A WebRTC leg has no second "staff handset" step: once the dial to the
      // customer is over, the CRM call itself is over. Talk time (or a stored
      // answered_at from the pick-up event) proves it connected.
      const connected = ok || dialDuration > 0 || Boolean(session.answered_at);
      const webrtcTerminal = isWebrtc
        ? {
            status: mapState(dialStatus || 'Completed', connected),
            is_active: false,
            ended_at: new Date().toISOString(),
            ended_by: session.cancel_requested_at ? 'crm_user' : connected ? 'unknown' : 'remote_party',
          }
        : { status: ok || !dialStatus ? 'bridged' : 'bridge_failed' };

      await patch(
        {
          ...webrtcTerminal,
          ...(dialStatus && !ok ? { failure_reason: `dial_${dialStatus.toLowerCase()}`.slice(0, 300) } : {}),
          ...(dialDuration > 0 ? { duration_seconds: dialDuration } : {}),
        },
        'post_dial',
      );
    }

    return hangup();
  }


  // ---------------- BROWSER (WebRTC) leg → dial the customer ----------------
  // The CRM user's browser client is already connected; AT is asking what to do
  // with it. Bridge it straight to the number the client dialled.
  if (isWebrtc || clientDialedNumber) {
    const dest = clientDialedNumber ?? toE164(session.target_phone);
    if (!dest) {
      await patch(
        { status: 'failed', failure_reason: 'invalid_target_phone', is_active: false, ended_at: new Date().toISOString(), ended_by: 'network' },
        'webrtc_invalid_target',
      );
      return hangup();
    }

    await patch({ status: 'ringing', is_active: true }, 'webrtc_ringing');

    const recordWebrtc = (Deno.env.get('CRM_CALL_RECORDING') ?? '').toLowerCase() === 'true';
    console.log('[crm-voice-callback] dialling customer for browser client', {
      callId: session.id,
      atSessionId,
      dest,
    });

    return xml(
      `<Response><Dial phoneNumbers="${dest}"${recordWebrtc ? ' record="true"' : ''}/></Response>`,
    );
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
