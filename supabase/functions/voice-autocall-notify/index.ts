/**
 * Automated call centre — texts sent when a call reaches its final result.
 * Service role only: called by the voice_autocall_sms_on_call_done trigger.
 *
 * 1. Monitor: one SMS per finished call to each number in
 *    voice_autocall_system_status.call_notify_phones. The idempotency key is
 *    the job id, so a re-fired trigger never texts twice.
 *
 *      "Welile auto-call: Sarah N. (+256701***245) Rent due today - Answered.
 *       Will pay today. Keys 1>1. 40s. 16:07"
 *
 * 2. Tenant self-pay: a tenant who pressed "I will pay today" (T1/T2 key 1)
 *    or "I'm having difficulty" (T2 key 2) is texted how to pay Welile's MoMo
 *    till from their own phone, through the tenant notification engine
 *    (CALL_SELF_PAY_PROMISE / CALL_SELF_PAY_DIFFICULTY), so opt-outs and
 *    caps apply. Till codes come from payment_channels.
 */
// Tenant SMS go to existing customers: no "join Welile" prompt.
import '../_shared/noSignupPrompt.ts';
import { createClient } from 'npm:@supabase/supabase-js@2';
import { requireServiceRole } from '../_shared/requireServiceRole.ts';
import { sendSMS } from '../_shared/sendSmsMultiProvider.ts';
import { routeTenantNotification } from '../_shared/tenantChannelRouter.ts';
import { firstName, loadPaymentChannels, payChannelsPhrase } from '../_shared/tenantTemplates.ts';

/** Call outcome → tenant self-pay SMS event. Only tenant calls are eligible. */
const SELF_PAY_EVENTS: Record<string, string> = {
  promise_to_pay: 'CALL_SELF_PAY_PROMISE',
  difficulty_callback: 'CALL_SELF_PAY_DIFFICULTY',
};

// Manual CORS headers (project standard — do not import corsHeaders).
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });

const STATUS_LABELS: Record<string, string> = {
  completed: 'Answered',
  no_answer: 'No answer',
  busy: 'Busy',
  failed: 'Failed',
};

// Keep in step with AUTOCALL_OUTCOME_LABELS in src/lib/voiceAutocall.ts.
const OUTCOME_LABELS: Record<string, string> = {
  promise_to_pay: 'Will pay today',
  agent_callback: 'Wants agent to call',
  difficulty_callback: 'Difficulty, call back',
  transfer_requested: 'Asked for the team',
  transferred: 'Spoke to the team',
  callback_requested: 'Team busy, call back',
  left_message: 'Left a voice message',
  no_message: 'No message left',
  opted_out: 'Stopped these calls',
  unconfirmed: 'Not confirmed',
  no_choice: 'Pressed nothing',
  listened: 'Listened',
  not_now: 'Not now',
};

// Plain ASCII: SMS is GSM-7, and "•" does not survive every handset.
const maskPhone = (p: string) => (p.length >= 10 ? `${p.slice(0, 7)}***${p.slice(-3)}` : p);

/** "Sarah Namubiru Kato" → "Sarah N." */
const shortName = (full: string | null) => {
  const parts = (full ?? '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return 'Unknown';
  return parts.length > 1 ? `${parts[0]} ${parts[1][0].toUpperCase()}.` : parts[0];
};

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  const refused = await requireServiceRole(req, corsHeaders);
  if (refused) return refused;

  const body = await req.json().catch(() => ({}));
  const jobId = typeof body?.job === 'string' ? body.job : '';
  if (!jobId) return json({ error: 'job_required' }, 400);

  const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, {
    auth: { persistSession: false },
  });

  const [{ data: job }, { data: sys }, { data: presses }] = await Promise.all([
    admin.from('voice_autocall_jobs')
      .select('id, status, outcome, category, person_id, person_name, phone, variables, is_test, total_duration_seconds, ended_at, notified_at, campaign_id, voice_autocall_scripts(name)')
      .eq('id', jobId).maybeSingle(),
    admin.from('voice_autocall_system_status').select('call_notify_phones').eq('id', 1).maybeSingle(),
    admin.from('voice_autocall_responses').select('digits').eq('job_id', jobId).not('digits', 'is', null).order('id'),
  ]);
  if (!job) return json({ error: 'job_not_found' }, 404);
  if (!STATUS_LABELS[job.status]) return json({ skipped: 'not_final', status: job.status });
  if (job.notified_at) return json({ skipped: 'already_notified' });

  const selfPay = await sendTenantSelfPay(admin, job).catch((e) => {
    console.error('[voice-autocall-notify] self-pay sms failed', { jobId, message: String(e) });
    return { sent: false, reason: 'error' };
  });

  // Handled from here on: the dialer's retry sweep only re-sends unmarked calls.
  const markNotified = () =>
    admin.from('voice_autocall_jobs').update({ notified_at: new Date().toISOString() }).eq('id', job.id);

  const phones: string[] = (sys?.call_notify_phones ?? []).filter(Boolean);
  if (!phones.length) {
    await markNotified();
    return json({ skipped: 'no_notify_phones', self_pay: selfPay });
  }

  const script = (job as unknown as { voice_autocall_scripts?: { name?: string } }).voice_autocall_scripts?.name ?? 'Call';
  const keys = (presses ?? []).map((r) => r.digits).join('>');
  const at = new Date(job.ended_at ?? Date.now()).toLocaleTimeString('en-GB', {
    timeZone: 'Africa/Kampala', hour: '2-digit', minute: '2-digit',
  });
  const outcome = job.outcome ? OUTCOME_LABELS[job.outcome] ?? job.outcome.replace(/_/g, ' ') : null;

  const message = [
    `Welile auto-call${job.is_test ? ' (test)' : ''}: ${shortName(job.person_name)} (${maskPhone(job.phone)}) ${script} - ${STATUS_LABELS[job.status]}.`,
    outcome && job.status === 'completed' ? `${outcome}.` : null,
    keys ? `Keys ${keys}.` : null,
    job.total_duration_seconds ? `${job.total_duration_seconds}s.` : null,
    at,
  ].filter(Boolean).join(' ');

  const results = await Promise.all(phones.map((phone) =>
    sendSMS(phone, message, {
      admin,
      source: 'voice-autocall-notify',
      reference_id: job.id,
      recipient_name: 'Automated calls monitor',
      idempotencyKey: `autocall-done-${job.id}-${phone}`,
    }).catch((e) => {
      console.error('[voice-autocall-notify] sms failed', { jobId, message: String(e) });
      return false;
    })
  ));

  await markNotified();
  return json({ sent: results.filter(Boolean).length, to: phones.length, self_pay: selfPay });
});

interface FinishedJob {
  id: string;
  status: string;
  outcome: string | null;
  category: string;
  person_id: string | null;
  person_name: string | null;
  phone: string;
  variables: Record<string, string> | null;
}

/** Text the tenant how to pay directly, when their key press asked for it. */
async function sendTenantSelfPay(
  // deno-lint-ignore no-explicit-any
  admin: any,
  job: FinishedJob,
): Promise<{ sent: boolean; reason: string | null }> {
  const eventKey = job.outcome ? SELF_PAY_EVENTS[job.outcome] : undefined;
  if (!eventKey || job.category !== 'tenant' || job.status !== 'completed') return { sent: false, reason: 'not_eligible' };
  if (!job.person_id) return { sent: false, reason: 'no_tenant' };

  const channels = await loadPaymentChannels(admin);
  // The message is the codes; without them it would read "on MTN  or Airtel".
  if (!channels.mtn && !channels.airtel) return { sent: false, reason: 'no_payment_channels' };

  const amount = String(job.variables?.amount ?? '').trim();
  if (eventKey === 'CALL_SELF_PAY_PROMISE' && !amount) return { sent: false, reason: 'no_amount' };

  const outcome = await routeTenantNotification({
    admin,
    tenantId: job.person_id,
    eventKey,
    episodeKey: `call:${job.id}`,
    vars: { name: firstName(job.person_name), amount, pay_channels: payChannelsPhrase(channels) },
    // The number we called is the profile phone the till payment is matched on.
    phone: job.phone,
    tenantName: job.person_name,
    payload: { autocall_job_id: job.id, outcome: job.outcome, mtn_code: channels.mtn, airtel_code: channels.airtel },
    linkPath: null,
  });
  return { sent: outcome.smsSent, reason: outcome.reason };
}
