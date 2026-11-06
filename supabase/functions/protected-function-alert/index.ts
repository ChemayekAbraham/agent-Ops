import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.49.4';

// Emails the owner, and only the owner, when a protected database function is changed, dropped or put back.
// The database logs the change in protected_function_changes and passes us the row id (see _pf_log).
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const FROM = 'Welile Security <security@welile.com>';
const RECIPIENTS = ['joshwanda17@gmail.com'];

const HEADLINES: Record<string, string> = {
  reverted: 'A protected function was REWRITTEN and has been put back',
  new_overload_removed: 'A new version of a protected function was added and has been removed',
  recreated: 'A protected function was DROPPED or missing and has been re-created',
  drift_reverted: 'A protected function did not match its saved definition and has been put back',
  guard_restored: 'The protection itself was removed or disabled and has been restored',
  allowed_with_unlock: 'A protected function was changed WITH your unlock token',
  dropped_with_unlock: 'A protected function was dropped WITH your unlock token',
  unprotected: 'A function was taken off the protected list',
  token_set: 'The unlock token was set',
  token_changed: 'The unlock token was CHANGED',
  token_change_refused: 'Someone tried to change the unlock token and was refused',
  refused_locked: 'Someone tried to edit the protected list without the unlock token',
};

function eat(iso: string | null) {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('en-GB', { timeZone: 'Africa/Kampala' }) + ' EAT';
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL');
    const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
    const mailgunApiKey = Deno.env.get('MAILGUN_API_KEY');
    const mailgunDomain = Deno.env.get('MAILGUN_DOMAIN');
    const mailgunBaseUrl = Deno.env.get('MAILGUN_API_BASE') || 'https://api.mailgun.net';
    if (!supabaseUrl || !serviceKey) return json({ error: 'Server not configured' }, 500);

    const admin = createClient(supabaseUrl, serviceKey);
    const body = req.method === 'POST' ? await req.json().catch(() => ({})) : {};

    // Only a row id is accepted; everything that goes in the email is read from the database, so a caller cannot put words in it.
    let row: Record<string, unknown> | null = null;
    if (typeof body?.change_id === 'string') {
      const { data } = await admin.from('protected_function_changes').select('*').eq('id', body.change_id).maybeSingle();
      row = data as Record<string, unknown> | null;
    }
    if (!row) return json({ error: 'Change not found' }, 404);
    if (row.notified === true) return json({ ok: true, emailed: false, already: true });

    const outcome = String(row.outcome ?? '');
    const lines = [
      (HEADLINES[outcome] ?? `Protected function event: ${outcome}`).toUpperCase(),
      '',
      `Function:       ${row.identity ?? '—'}`,
      `Command:        ${row.command ?? '—'}`,
      `Outcome:        ${outcome}`,
      `When:           ${eat(row.at as string | null)}`,
      '',
      `Database user:  ${row.db_user ?? '—'}  (session: ${row.session_usr ?? '—'})`,
      `Application:    ${row.app_name ?? '—'}`,
      `Client address: ${row.client_addr ?? '—'}`,
      `API user id:    ${row.jwt_sub ?? '—'}  (role: ${row.jwt_role ?? '—'})`,
      '',
      `Saved definition fingerprint: ${row.old_md5 ?? '—'}`,
      `Attempted fingerprint:        ${row.new_md5 ?? '—'}`,
      row.detail ? `\n${row.detail}` : '',
      '',
      outcome === 'allowed_with_unlock' || outcome === 'dropped_with_unlock' || outcome === 'token_set' || outcome === 'token_changed' || outcome === 'unprotected'
        ? 'This was made with your unlock token. If it was not you, the token is compromised: change it now.'
        : 'The change was undone. If it was not you, find out who ran it from the details above.',
    ];

    if (!(mailgunApiKey && mailgunDomain)) return json({ ok: false, emailed: false, error: 'Mailgun is not configured' }, 200);

    const form = new FormData();
    form.set('from', FROM);
    RECIPIENTS.forEach((r) => form.append('to', r));
    form.set('subject', `Protected function: ${HEADLINES[outcome] ?? outcome}`);
    form.set('text', lines.join('\n'));
    const mg = await fetch(`${mailgunBaseUrl}/v3/${mailgunDomain}/messages`, {
      method: 'POST',
      headers: { Authorization: 'Basic ' + btoa(`api:${mailgunApiKey}`) },
      body: form,
    });
    if (!mg.ok) {
      console.error('mailgun failed', mg.status, await mg.text());
      return json({ ok: false, emailed: false, status: mg.status }, 200);
    }

    await admin.from('protected_function_changes').update({ notified: true }).eq('id', row.id as string);
    return json({ ok: true, emailed: true });
  } catch (e) {
    console.error('protected-function-alert error', e);
    return json({ error: String((e as Error)?.message ?? e) }, 500);
  }
});
