/**
 * Automated call centre — Africa's Talking voice callback (PUBLIC endpoint).
 *
 * Set as the callback URL of the AUTOMATED-CALLS virtual number only
 * (AFRICASTALKING_AUTOCALL_NUMBER), never the CRM Call Centre number.
 *
 * Africa's Talking posts here when the person answers, after each key press
 * (kind=digits), when a menu times out (kind=noinput), after a voice message
 * (kind=record / recnoinput), after a transfer ends (dialStatus), and once more
 * when the call is over (isActive=0).
 *
 * AT cannot present our JWT, so nothing in the payload identifies a person. The
 * only keys honoured are our own job id (clientRequestId / ?job=) and the AT
 * sessionId the dialer stored; a callback whose sessionId does not match the
 * job's is refused. Inbound calls are rejected.
 */
import { createClient } from 'npm:@supabase/supabase-js@2';
import {
  EMPTY_XML,
  HANGUP_XML,
  REJECT_XML,
  type CallbackKind,
  type RenderContext,
  type Script,
  renderFrom,
  resolveMenu,
  terminalStatus,
} from '../_shared/voiceAutocall.ts';

// Manual CORS headers (project standard — do not import corsHeaders).
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const reply = (xml: string) =>
  new Response(xml, { headers: { ...corsHeaders, 'Content-Type': 'application/xml' } });

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Callbacks one call may make before we assume a loop and hang up. */
const MAX_CALLBACKS = 40;

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

const numeric = (raw: string | undefined) => {
  const n = Number.parseInt(raw ?? '', 10);
  return Number.isFinite(n) ? Math.max(0, n) : 0;
};

interface Job {
  id: string;
  status: string;
  attempts: number;
  at_session_id: string | null;
  script_snapshot: Script;
  variables: Record<string, string>;
  current_step: string | null;
  callback_count: number;
  answered_at: string | null;
  record_calls: boolean;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (req.method !== 'POST') return reply(REJECT_XML);

  const url = new URL(req.url);
  const q = {
    job: url.searchParams.get('job') ?? '',
    step: url.searchParams.get('step') ?? '',
    kind: (url.searchParams.get('kind') ?? '') as CallbackKind | '',
    tries: numeric(url.searchParams.get('try') ?? '0'),
  };
  const p = await readPayload(req);
  const sessionId = (p.sessionId ?? '').trim();
  const isActive = (p.isActive ?? '').trim() === '1';

  if ((p.direction ?? '').toLowerCase() === 'inbound') {
    console.warn('[voice-autocall-ivr] inbound call rejected', { sessionId });
    return reply(REJECT_XML);
  }

  const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, {
    auth: { persistSession: false },
  });

  const COLS =
    'id, status, attempts, at_session_id, script_snapshot, variables, current_step, callback_count, answered_at, record_calls';
  const jobId = UUID_RE.test(q.job) ? q.job : UUID_RE.test(p.clientRequestId ?? '') ? p.clientRequestId : '';
  let job: Job | null = null;
  if (jobId) {
    const { data } = await admin.from('voice_autocall_jobs').select(COLS).eq('id', jobId).maybeSingle();
    job = (data as Job | null) ?? null;
  }
  if (!job && sessionId) {
    const { data } = await admin.from('voice_autocall_jobs').select(COLS).eq('at_session_id', sessionId).maybeSingle();
    job = (data as Job | null) ?? null;
  }
  if (!job) {
    console.warn('[voice-autocall-ivr] no matching job', { jobId, sessionId });
    return reply(isActive ? HANGUP_XML : EMPTY_XML);
  }
  const row = job;

  // A forged or stale callback for someone else's session.
  if (sessionId && row.at_session_id && row.at_session_id !== sessionId) {
    console.warn('[voice-autocall-ivr] session mismatch', { jobId: row.id, sessionId });
    return reply(isActive ? HANGUP_XML : EMPTY_XML);
  }

  const { sessionId: _s, ...logged } = p;
  const logEvent = (kind: string, step: string | null) =>
    admin.from('voice_autocall_events').insert({
      job_id: row.id,
      attempt: row.attempts,
      at_session_id: sessionId || row.at_session_id,
      kind,
      step,
      payload: logged,
    });

  const patch = async (values: Record<string, unknown>, label: string) => {
    const { error } = await admin
      .from('voice_autocall_jobs')
      .update({ ...values, updated_at: new Date().toISOString() })
      .eq('id', row.id);
    if (error) console.error(`[voice-autocall-ivr] ${label} update failed`, { jobId: row.id, message: error.message });
  };

  // ---------------- call over ----------------
  if (!isActive) {
    await logEvent('terminal', row.current_step);
    const duration = numeric(p.durationInSeconds ?? p.callDuration);
    const cost = Number.parseFloat((p.amount ?? '').replace(/[^\d.]/g, ''));
    const status = terminalStatus(p.callSessionState ?? p.status ?? '', Boolean(row.answered_at), duration);
    const { error } = await admin.rpc('voice_autocall_finish_attempt', {
      p_job: row.id,
      p_status: status,
      p_duration: duration,
      p_cost: Number.isFinite(cost) ? cost : null,
      p_currency: p.currencyCode || null,
      p_hangup_cause: (p.hangupCause ?? '').trim().toUpperCase() || null,
      p_provider_recording_url: p.recordingUrl || null,
      p_failure_reason: status === 'failed' ? `provider_${(p.callSessionState ?? 'failed').toLowerCase()}` : null,
    });
    if (error) console.error('[voice-autocall-ivr] finish_attempt failed', { jobId: row.id, message: error.message });
    return reply(EMPTY_XML);
  }

  // ---------------- call live ----------------
  if (!['dialing', 'in_progress'].includes(row.status)) {
    await logEvent('ignored_not_live', q.step || null);
    return reply(HANGUP_XML);
  }
  if (row.callback_count >= MAX_CALLBACKS) {
    await logEvent('loop_guard', q.step || null);
    return reply(HANGUP_XML);
  }

  const script = row.script_snapshot;
  const base = `${Deno.env.get('SUPABASE_URL')}/functions/v1/voice-autocall-ivr`;
  const ctx: RenderContext = {
    script,
    variables: row.variables ?? {},
    callbackUrl: (kind, step, tries) =>
      `${base}?job=${row.id}&step=${encodeURIComponent(step)}&kind=${kind}&try=${tries}`,
    transferNumbers: Deno.env.get('AUTOCALL_TRANSFER_NUMBERS') ?? '',
    recordTransfers: row.record_calls,
    recordWholeCall: row.record_calls && (Deno.env.get('AUTOCALL_RECORD_WHOLE_CALL') ?? '').toLowerCase() === 'true',
  };

  const saveResponse = (step: string, digits: string | null, outcome: string | null, action: string | null, rec: string | null) =>
    admin.rpc('voice_autocall_record_response', {
      p_job: row.id,
      p_step: step,
      p_digits: digits,
      p_outcome: outcome,
      p_action: action,
      p_provider_recording_url: rec,
    });

  /** Render, then remember where the call is waiting. */
  const go = async (stepKey: string, tries: number, kind: string, isFirst = false) => {
    const r = renderFrom(stepKey, ctx, tries, isFirst);
    await patch(
      {
        current_step: r.step,
        callback_count: row.callback_count + 1,
        ...(r.outcome ? { outcome: r.outcome } : {}),
        ...(isFirst ? { status: 'in_progress', answered_at: new Date().toISOString(), at_session_id: sessionId || row.at_session_id } : {}),
      },
      kind,
    );
    return reply(r.xml);
  };

  const step = q.step ? script.steps?.[q.step] : undefined;

  // Key press on a menu.
  if (q.kind === 'digits' || q.kind === 'noinput') {
    if (!step || step.type !== 'menu') return go(script.start, 0, 'bad_step');
    const digits = q.kind === 'digits' ? (p.dtmfDigits ?? '').trim() || null : null;
    const r = resolveMenu(step, digits, q.tries);
    await logEvent(q.kind, q.step);
    await saveResponse(q.step, digits, r.outcome, r.action, null);
    return go(r.next, r.tries, q.kind);
  }

  // Voice message finished, or nothing was said.
  if (q.kind === 'record' || q.kind === 'recnoinput') {
    if (!step || step.type !== 'record') return go(script.start, 0, 'bad_step');
    await logEvent(q.kind, q.step);
    const rec = (p.recordingUrl ?? '').trim();
    if (rec) {
      await saveResponse(q.step, null, step.outcome ?? 'left_message', null, rec);
      return go(step.next ?? '', 0, q.kind);
    }
    await saveResponse(q.step, null, step.no_input?.outcome ?? 'no_message', null, null);
    return go(step.no_input?.next ?? step.next ?? '', 0, q.kind);
  }

  // A transfer to the live team ended.
  const dialStatus = (p.dialStatus ?? '').trim().toLowerCase();
  const current = row.current_step ? script.steps?.[row.current_step] : undefined;
  if (dialStatus && current?.type === 'transfer') {
    await logEvent('transfer_ended', row.current_step);
    if (dialStatus === 'completed' || numeric(p.dialDurationInSeconds) > 0) return reply(HANGUP_XML);
    return go(current.fallback_next ?? '', 0, 'transfer_failed');
  }

  // First callback of this attempt: the person picked up.
  if (!row.answered_at && row.status === 'dialing') {
    await logEvent('answered', script.start);
    return go(script.start, 0, 'answered', true);
  }

  // Anything else on a live call (AT retries, transfer pick-up) — keep going.
  await logEvent('ignored', row.current_step);
  return reply(EMPTY_XML);
});
