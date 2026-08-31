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
import { corsHeaders } from 'npm:@supabase/supabase-js@2/cors';

const XML = { ...corsHeaders, 'Content-Type': 'application/xml' };

const xml = (body: string) => new Response(`<?xml version="1.0" encoding="UTF-8"?>${body}`, { headers: XML });

/** Nothing to say — used for inbound and for anything unrecognised. */
const silence = () => xml('<Response><Reject/></Response>');

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

  const { data: session } = await query.maybeSingle();

  if (!session) {
    console.warn('[crm-voice-callback] no matching session', { atSessionId, clientRequestId });
    return silence();
  }

  // Keep the provider session id attached the first time we see it.
  if (atSessionId && session.at_session_id !== atSessionId) {
    await admin.from('crm_call_sessions').update({ at_session_id: atSessionId }).eq('id', session.id);
  }

  const isActive = (p.isActive ?? '').trim() === '1';

  // ---------------- terminal event ----------------
  if (!isActive) {
    const duration = Number.parseInt(p.durationInSeconds ?? p.callDuration ?? '0', 10);
    const cost = Number.parseFloat((p.amount ?? '').replace(/[^\d.]/g, ''));
    const state = (p.callSessionState ?? p.status ?? '').trim() || 'completed';
    const hangupCause = (p.hangupCause ?? '').trim() || null;

    await admin
      .from('crm_call_sessions')
      .update({
        status: state.toLowerCase(),
        hangup_cause: hangupCause,
        duration_seconds: Number.isFinite(duration) ? Math.max(0, duration) : 0,
        recording_url: p.recordingUrl || null,
        cost_amount: Number.isFinite(cost) ? cost : null,
        cost_currency: p.currencyCode || null,
      })
      .eq('id', session.id);

    return silence();
  }

  // ---------------- staff leg answered → bridge to the customer ----------------
  const target = toE164(session.target_phone);
  if (!target) {
    await admin
      .from('crm_call_sessions')
      .update({ status: 'failed', failure_reason: 'invalid_target_phone' })
      .eq('id', session.id);
    return silence();
  }

  await admin.from('crm_call_sessions').update({ status: 'bridged' }).eq('id', session.id);

  // Recording is OFF unless explicitly enabled. The spoken notice would only
  // ever reach the staff leg, never the customer, so enabling it without a
  // customer-side notice would be a consent problem.
  const record = (Deno.env.get('CRM_CALL_RECORDING') ?? '').toLowerCase() === 'true';

  return xml(
    `<Response><Dial phoneNumbers="${target}"${record ? ' record="true"' : ''}/></Response>`,
  );
});
