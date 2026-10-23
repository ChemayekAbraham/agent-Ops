/**
 * Automated call centre — text a summary when a call reaches its final result.
 * Service role only: called by the voice_autocall_sms_on_call_done trigger.
 *
 * One SMS per finished call to each number in
 * voice_autocall_system_status.call_notify_phones. The idempotency key is the
 * job id, so a re-fired trigger never texts twice.
 *
 *   "Welile auto-call: Sarah N. (+256701***245) Rent due today - Answered.
 *    Will pay today. Keys 1>1. 40s. 16:07"
 */
import { createClient } from 'npm:@supabase/supabase-js@2';
import { requireServiceRole } from '../_shared/requireServiceRole.ts';
import { sendSMS } from '../_shared/sendSmsMultiProvider.ts';

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
      .select('id, status, outcome, person_name, phone, is_test, total_duration_seconds, ended_at, campaign_id, voice_autocall_scripts(name)')
      .eq('id', jobId).maybeSingle(),
    admin.from('voice_autocall_system_status').select('call_notify_phones').eq('id', 1).maybeSingle(),
    admin.from('voice_autocall_responses').select('digits').eq('job_id', jobId).not('digits', 'is', null).order('id'),
  ]);
  if (!job) return json({ error: 'job_not_found' }, 404);
  if (!STATUS_LABELS[job.status]) return json({ skipped: 'not_final', status: job.status });

  const phones: string[] = (sys?.call_notify_phones ?? []).filter(Boolean);
  if (!phones.length) return json({ skipped: 'no_notify_phones' });

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

  return json({ sent: results.filter(Boolean).length, to: phones.length });
});
