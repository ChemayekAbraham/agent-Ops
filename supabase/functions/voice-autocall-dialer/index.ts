/**
 * Automated call centre — the dialer. Service role only (pg_cron, every minute,
 * 07:00–21:59 Kampala; calling hours themselves are enforced in SQL).
 *
 * Each run:
 *   1. voice_autocall_tick() — builds today's audience for campaigns whose
 *      window has opened, expires what can no longer be called, closes stuck
 *      attempts.
 *   2. Checks the Africa's Talking balance (every 10 minutes); below
 *      AUTOCALL_MIN_BALANCE nothing is dialled.
 *   3. voice_autocall_claim(channels) — never more calls than free lines.
 *   4. Places each call with clientRequestId = job id, so every callback maps
 *      back to its job.
 *   5. Copies finished recordings from Africa's Talking into the private
 *      voice-recordings bucket, so playback never depends on AT keeping them.
 *
 * Env: AFRICASTALKING_USERNAME, AFRICASTALKING_API_KEY,
 *      AFRICASTALKING_AUTOCALL_NUMBER (optional; falls back to the CRM number
 *      AFRICASTALKING_VOICE_NUMBER, whose callback forwards robot calls here),
 *      AFRICASTALKING_AUTOCALL_CHANNELS (default 5), AUTOCALL_MIN_BALANCE (default 5000).
 */
import { createClient, type SupabaseClient } from 'npm:@supabase/supabase-js@2';
import { requireServiceRole } from '../_shared/requireServiceRole.ts';

// Manual CORS headers (project standard — do not import corsHeaders).
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });

const BALANCE_EVERY_MS = 10 * 60_000;
const BUCKET = 'voice-recordings';
const RECORDINGS_PER_RUN = 10;

interface ClaimedJob {
  id: string;
  phone: string;
  attempts: number;
  is_test: boolean;
}

async function readBalance(username: string, apiKey: string): Promise<{ amount: number; currency: string } | null> {
  const host = username.toLowerCase() === 'sandbox'
    ? 'https://api.sandbox.africastalking.com'
    : 'https://api.africastalking.com';
  const res = await fetch(`${host}/version1/user?username=${encodeURIComponent(username)}`, {
    headers: { apiKey, Accept: 'application/json' },
  });
  const text = await res.text();
  let raw = '';
  try {
    raw = JSON.parse(text)?.UserData?.balance ?? '';
  } catch {
    raw = '';
  }
  const match = /([A-Z]{3})\s*([\d.,]+)/.exec(String(raw));
  if (!match) return null;
  return { currency: match[1], amount: Number.parseFloat(match[2].replace(/,/g, '')) };
}

async function placeCall(
  admin: SupabaseClient,
  job: ClaimedJob,
  cfg: { username: string; apiKey: string; from: string },
): Promise<'placed' | 'failed'> {
  const endpoint = cfg.username.toLowerCase() === 'sandbox'
    ? 'https://voice.sandbox.africastalking.com/call'
    : 'https://voice.africastalking.com/call';

  const fail = async (reason: string) => {
    await admin.from('voice_autocall_events').insert({
      job_id: job.id, attempt: job.attempts, kind: 'dial_failed', payload: { reason },
    });
    await admin.rpc('voice_autocall_finish_attempt', {
      p_job: job.id, p_status: 'failed', p_failure_reason: reason.slice(0, 300),
    });
    return 'failed' as const;
  };

  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json', apiKey: cfg.apiKey },
      body: new URLSearchParams({ username: cfg.username, from: cfg.from, to: job.phone, clientRequestId: job.id }),
    });
    const raw = await res.text();
    let entry: { sessionId?: string; status?: string; errorMessage?: string } | undefined;
    try {
      entry = JSON.parse(raw)?.entries?.[0];
    } catch {
      entry = undefined;
    }
    const status = (entry?.status ?? '').toLowerCase();
    if (!res.ok || !['queued', 'success', 'ringing'].includes(status)) {
      const detail = entry?.errorMessage && entry.errorMessage !== 'None' ? entry.errorMessage : null;
      return fail(detail ?? (entry?.status ? `provider_status_${entry.status}` : `provider_http_${res.status}`));
    }
    // Only set the session if the answer callback has not already done so.
    await admin.from('voice_autocall_jobs')
      .update({ at_session_id: entry?.sessionId ?? null, updated_at: new Date().toISOString() })
      .eq('id', job.id)
      .is('at_session_id', null);
    await admin.from('voice_autocall_events').insert({
      job_id: job.id, attempt: job.attempts, at_session_id: entry?.sessionId ?? null, kind: 'dial_requested',
      payload: { provider_status: entry?.status ?? null },
    });
    return 'placed';
  } catch (e) {
    return fail(`provider_unreachable: ${String(e).slice(0, 200)}`);
  }
}

/** Download one AT recording into our bucket; returns the storage path. */
async function copyRecording(admin: SupabaseClient, url: string, path: string): Promise<string | null> {
  const res = await fetch(url);
  if (!res.ok) {
    await res.body?.cancel();
    console.warn('[voice-autocall-dialer] recording fetch failed', { path, status: res.status });
    return null;
  }
  const type = res.headers.get('content-type') ?? 'audio/mpeg';
  const ext = type.includes('wav') ? 'wav' : 'mp3';
  const fullPath = `${path}.${ext}`;
  const { error } = await admin.storage.from(BUCKET).upload(fullPath, await res.arrayBuffer(), {
    contentType: type,
    upsert: true,
  });
  if (error) {
    console.warn('[voice-autocall-dialer] recording upload failed', { path: fullPath, message: error.message });
    return null;
  }
  return fullPath;
}

async function syncRecordings(admin: SupabaseClient): Promise<number> {
  const since = new Date(Date.now() - 3 * 86_400_000).toISOString();
  let copied = 0;

  const { data: jobs } = await admin.from('voice_autocall_jobs')
    .select('id, provider_recording_url, created_at')
    .not('provider_recording_url', 'is', null)
    .is('recording_path', null)
    .gte('created_at', since)
    .limit(RECORDINGS_PER_RUN);
  for (const j of jobs ?? []) {
    const day = String(j.created_at).slice(0, 10);
    const path = await copyRecording(admin, j.provider_recording_url, `${day}/${j.id}/call`);
    if (path) {
      await admin.from('voice_autocall_jobs').update({ recording_path: path }).eq('id', j.id);
      copied++;
    }
  }

  const { data: responses } = await admin.from('voice_autocall_responses')
    .select('id, job_id, provider_recording_url, created_at')
    .not('provider_recording_url', 'is', null)
    .is('recording_path', null)
    .gte('created_at', since)
    .limit(RECORDINGS_PER_RUN);
  for (const r of responses ?? []) {
    const day = String(r.created_at).slice(0, 10);
    const path = await copyRecording(admin, r.provider_recording_url, `${day}/${r.job_id}/message-${r.id}`);
    if (path) {
      await admin.from('voice_autocall_responses').update({ recording_path: path }).eq('id', r.id);
      copied++;
    }
  }
  return copied;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  const refused = await requireServiceRole(req, corsHeaders);
  if (refused) return refused;

  const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, {
    auth: { persistSession: false },
  });
  const setStatus = (values: Record<string, unknown>) =>
    admin.from('voice_autocall_system_status').update({ ...values, updated_at: new Date().toISOString() }).eq('id', 1);

  const { data: tick, error: tickErr } = await admin.rpc('voice_autocall_tick');
  if (tickErr) {
    await setStatus({ last_tick_at: new Date().toISOString(), last_error: `tick: ${tickErr.message}`.slice(0, 500) });
    return json({ error: 'tick_failed', message: tickErr.message }, 500);
  }

  const username = Deno.env.get('AFRICASTALKING_USERNAME') ?? '';
  const apiKey = Deno.env.get('AFRICASTALKING_API_KEY') ?? '';
  // The CRM Call Centre number is shared: crm-voice-callback forwards robot-call
  // callbacks here, so a dedicated number is optional.
  const from = Deno.env.get('AFRICASTALKING_AUTOCALL_NUMBER') || Deno.env.get('AFRICASTALKING_VOICE_NUMBER') || '';
  if (!username || !apiKey || !from) {
    await setStatus({
      last_tick_at: new Date().toISOString(),
      last_tick_result: tick,
      configured: false,
      last_error: 'No Africa’s Talking voice number is set; no automated calls will be placed',
    });
    return json({ tick, dialled: 0, configured: false });
  }

  // ---- airtime ----
  const { data: status } = await admin.from('voice_autocall_system_status')
    .select('balance_checked_at, low_balance').eq('id', 1).maybeSingle();
  let lowBalance = Boolean(status?.low_balance);
  const checkedAt = status?.balance_checked_at ? Date.parse(status.balance_checked_at) : 0;
  if (Date.now() - checkedAt > BALANCE_EVERY_MS) {
    try {
      const bal = await readBalance(username, apiKey);
      const min = Number.parseFloat(Deno.env.get('AUTOCALL_MIN_BALANCE') ?? '5000');
      if (bal) {
        lowBalance = bal.amount < min;
        await setStatus({
          balance_amount: bal.amount,
          balance_currency: bal.currency,
          balance_checked_at: new Date().toISOString(),
          low_balance: lowBalance,
        });
      }
    } catch (e) {
      console.warn('[voice-autocall-dialer] balance check failed', String(e));
    }
  }

  let dialled = 0;
  let failed = 0;
  const channels = Number.parseInt(Deno.env.get('AFRICASTALKING_AUTOCALL_CHANNELS') ?? '5', 10) || 5;
  if (!lowBalance) {
    const { data: claimed, error: claimErr } = await admin.rpc('voice_autocall_claim', { p_channels: channels });
    if (claimErr) {
      await setStatus({ last_tick_at: new Date().toISOString(), last_error: `claim: ${claimErr.message}`.slice(0, 500) });
      return json({ error: 'claim_failed', message: claimErr.message }, 500);
    }
    const results = await Promise.all(
      ((claimed ?? []) as ClaimedJob[]).map((j) => placeCall(admin, j, { username, apiKey, from })),
    );
    dialled = results.filter((r) => r === 'placed').length;
    failed = results.length - dialled;
  }

  let recordings = 0;
  try {
    recordings = await syncRecordings(admin);
  } catch (e) {
    console.warn('[voice-autocall-dialer] recording sync failed', String(e));
  }

  const result = { ...(tick as Record<string, unknown>), dialled, failed, recordings, low_balance: lowBalance };
  await setStatus({
    last_tick_at: new Date().toISOString(),
    last_tick_result: result,
    configured: true,
    channels,
    last_error: null,
  });
  return json(result);
});
