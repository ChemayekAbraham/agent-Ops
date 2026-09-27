import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.49.4';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const FROM = 'Welile Security <security@welile.com>';
const RECIPIENTS = ['joshwanda17@gmail.com', 'ssenkaali.pius@welile.com', 'markbwayo@gmail.com'];

function eat(iso: string | null) {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('en-GB', { timeZone: 'Africa/Kampala' }) + ' EAT';
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL');
    const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
    const mailgunApiKey = Deno.env.get('MAILGUN_API_KEY');
    const mailgunDomain = Deno.env.get('MAILGUN_DOMAIN');
    const mailgunBaseUrl = Deno.env.get('MAILGUN_API_BASE') || 'https://api.mailgun.net';
    if (!supabaseUrl || !serviceKey) return json({ error: 'Server not configured' }, 500);

    const admin = createClient(supabaseUrl, serviceKey);
    const body = req.method === 'POST' ? await req.json().catch(() => ({})) : {};

    // The database logs the violation and passes us the row id.
    let row: Record<string, unknown> | null = null;
    if (typeof body?.violation_id === 'string') {
      const { data } = await admin
        .from('financial_ops_security_violations')
        .select('*')
        .eq('id', body.violation_id)
        .maybeSingle();
      row = data as Record<string, unknown> | null;
    }
    if (!row) return json({ error: 'Violation not found' }, 404);

    const lines = [
      'UNAUTHORIZED FINANCIAL OPS EDIT ATTEMPT',
      '',
      `Full name:      ${row.full_name ?? '—'}`,
      `Phone number:   ${row.phone ?? '—'}`,
      `User ID:        ${row.user_id ?? '—'}`,
      `Role(s):        ${Array.isArray(row.roles) && row.roles.length ? (row.roles as string[]).join(', ') : 'none'}`,
      `Action:         ${row.attempted_action ?? '—'}`,
      `Timestamp:      ${eat(row.created_at as string | null)}`,
      `IP address:     ${row.ip_address ?? '—'}`,
      `Device / agent: ${row.user_agent ?? '—'}`,
      '',
      `Context: ${JSON.stringify(row.context ?? {})}`,
      '',
      'The edit was blocked at the database level. No financial data was changed.',
    ];

    if (mailgunApiKey && mailgunDomain) {
      const form = new FormData();
      form.set('from', FROM);
      RECIPIENTS.forEach((r) => form.append('to', r));
      form.set('subject', 'Unauthorized Financial Ops Edit Attempt');
      form.set('text', lines.join('\n'));
      const mg = await fetch(`${mailgunBaseUrl}/v3/${mailgunDomain}/messages`, {
        method: 'POST',
        headers: { Authorization: 'Basic ' + btoa(`api:${mailgunApiKey}`) },
        body: form,
      });
      if (!mg.ok) {
        const txt = await mg.text();
        console.error('mailgun failed', mg.status, txt);
        return json({ ok: false, emailed: false, status: mg.status }, 200);
      }
    }

    await admin
      .from('financial_ops_security_violations')
      .update({ notified: true })
      .eq('id', row.id as string);

    return json({ ok: true, emailed: Boolean(mailgunApiKey && mailgunDomain) });
  } catch (e) {
    console.error('financial-ops-security-alert error', e);
    return json({ error: String((e as Error)?.message ?? e) }, 500);
  }
});