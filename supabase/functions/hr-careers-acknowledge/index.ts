/**
 * HR careers automatic acknowledgement — one enqueued email per applicant.
 *
 * Rules held deliberately (mirrors hr-careers-bulk-email):
 *  - Exactly ONE address per enqueued payload. `to` is always a single string.
 *    There is no cc and no bcc field anywhere in this file, and no array is ever
 *    assigned to `to`.
 *  - Each message carries only that applicant's own name and own public_ref.
 *  - Suppression check on `suppressed_emails` is fail-closed (a failed check
 *    aborts that applicant, never sends).
 *  - A failed enqueue is logged and the loop continues; the applicant is NOT
 *    marked acknowledged, so the next run retries them.
 *  - Nothing here runs inside, wraps, or depends on the public insert
 *    transaction on job_applications. No trigger, no RLS change, no schema change.
 *  - Idempotency marker: a job_application_communications row with
 *    channel='email' AND logged_by IS NULL means "already acknowledged".
 */
import { createClient } from 'npm:@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const SITE_NAME = 'Welile';
const SENDER_DOMAIN = 'notify.welile.com';
const FROM_DOMAIN = 'welile.com';
const DEFAULT_FROM = `${SITE_NAME} <noreply@${FROM_DOMAIN}>`;
const BATCH_LIMIT = 100;
const AUTO_PREFIX = 'Automatic acknowledgement — ';
const SUBJECT = 'We have received your application';

const json = (body: unknown, status: number) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });

const escapeHtml = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function generateToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Transactional acknowledgement only. States receipt, gives the reference,
 * explains rolling review and that we contact only those we wish to speak to.
 * Promises no timeline and no decision date. Mentions no other role and
 * nothing promotional.
 */
const BODY_TEMPLATE = `Hello {{name}},

We have received your application for {{role}}. Your reference is {{reference}}.

Applications are reviewed on a rolling basis. We contact the applicants we wish to speak to, and we are not able to reply to everyone individually.

Please keep your reference for any correspondence about this application.

Welile — Talent & Recruitment`;

function personalise(template: string, name: string, role: string | null, reference: string): string {
  const roleValue = role?.trim() ? role.trim() : '';
  let result = template
    .replace(/\{\{\s*name\s*\}\}/gi, name)
    .replace(/\{\{\s*reference\s*\}\}/gi, reference);
  if (roleValue) {
    result = result.replace(/\{\{\s*role\s*\}\}/gi, roleValue);
  } else {
    result = result.replace(/\s+for\s+\{\{\s*role\s*\}\}/gi, '');
  }
  return result;
}

function buildBody(name: string, role: string | null, reference: string): string {
  return personalise(BODY_TEMPLATE, name, role, reference);
}

function buildHtml(opts: { bodyText: string }): string {
  const paragraphs = opts.bodyText
    .split(/\n{2,}/)
    .map((p) => `<p style="margin:0 0 14px;line-height:1.6">${escapeHtml(p).replace(/\n/g, '<br/>')}</p>`)
    .join('');

  return `<!doctype html><html><body style="margin:0;background:#f6f7f9;padding:24px;font-family:Helvetica,Arial,sans-serif;color:#1f2933">
<div style="max-width:560px;margin:0 auto;background:#ffffff;border-radius:12px;padding:28px">
${paragraphs}
</div></body></html>`;
}

function buildText(opts: { bodyText: string }) {
  return opts.bodyText;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders });

  const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY')!;

  const authHeader = req.headers.get('Authorization') || '';
  const bearer = authHeader.replace(/^Bearer\s+/i, '').trim();
  if (!bearer) return json({ error: 'Missing authorization header' }, 401);

  const adminClient = createClient(supabaseUrl, serviceKey);

  // ── GUARD: scheduler (service-role bearer) OR an hr / super_admin caller.
  // The published anon key is NOT accepted, so this is not publicly invokable.
  let invokedBy = 'scheduler';
  if (bearer !== serviceKey) {
    const { data: userData, error: userError } = await createClient(supabaseUrl, anonKey)
      .auth.getUser(bearer);
    const caller = userData?.user;
    if (userError || !caller) return json({ error: 'Unauthorized' }, 401);

    const { data: roles, error: roleError } = await adminClient
      .from('user_roles')
      .select('role')
      .eq('user_id', caller.id)
      .in('role', ['hr', 'super_admin']);
    if (roleError) return json({ error: `Role check failed: ${roleError.message}` }, 500);
    if (!roles?.length) return json({ error: 'Only HR or Super Admin may run acknowledgements' }, 403);
    invokedBy = caller.id;
  }

  // ── ACK_CUTOFF gate: unset means process nothing.
  const cutoffRaw = (Deno.env.get('ACK_CUTOFF') || '').trim();
  if (!cutoffRaw) {
    return json({ processed: 0, sent: 0, note: 'ACK_CUTOFF was unset — nothing processed' }, 200);
  }
  const cutoffDate = new Date(cutoffRaw);
  if (Number.isNaN(cutoffDate.getTime())) {
    return json({ error: `ACK_CUTOFF is not a valid timestamp: ${cutoffRaw}` }, 400);
  }
  const cutoffIso = cutoffDate.toISOString();

  // ── Candidates: new, un-purged, with an email, created at/after the cutoff.
  const { data: candidates, error: fetchError } = await adminClient
    .from('job_applications')
    .select('id, full_name, email, public_ref, role_interest, created_at')
    .is('purged_at', null)
    .not('email', 'is', null)
    .eq('status', 'new')
    .gte('created_at', cutoffIso)
    .order('created_at', { ascending: true })
    .limit(BATCH_LIMIT);
  if (fetchError) return json({ error: `Could not load applications: ${fetchError.message}` }, 500);

  const ids = (candidates ?? []).map((r) => r.id);
  if (!ids.length) {
    return json({ processed: 0, sent: 0, skipped_already_acknowledged: 0, note: 'No pending applications' }, 200);
  }

  // Already-acknowledged set: channel='email' AND logged_by IS NULL.
  const { data: existingAcks, error: ackError } = await adminClient
    .from('job_application_communications')
    .select('application_id')
    .eq('channel', 'email')
    .is('logged_by', null)
    .in('application_id', ids);
  if (ackError) return json({ error: `Could not read communications log: ${ackError.message}` }, 500);
  const acknowledged = new Set((existingAcks ?? []).map((r) => r.application_id));

  const fromAddress = Deno.env.get('CAREERS_FROM') || DEFAULT_FROM;
  const replyTo = Deno.env.get('CAREERS_REPLY_TO') || null;

  let sent = 0;
  let failed = 0;
  let suppressedCount = 0;
  let alreadyDone = 0;
  const failures: { application_id: string; reason: string }[] = [];

  for (const applicant of candidates ?? []) {
    if (acknowledged.has(applicant.id)) { alreadyDone += 1; continue; }

    const name = (applicant.full_name || 'there').trim();
    const publicRef = applicant.public_ref || '—';
    const role = (applicant as any).role_interest ?? null;
    const address = (applicant.email || '').trim().toLowerCase();
    if (!address) continue;

    const bodyText = buildBody(name, role, publicRef);

    try {
      // Suppression: fail-closed, same table and semantics as hr-careers-bulk-email.
      const { data: suppressed, error: suppressionError } = await adminClient
        .from('suppressed_emails')
        .select('id')
        .eq('email', address)
        .maybeSingle();
      if (suppressionError) throw new Error('Suppression check failed');
      if (suppressed) { suppressedCount += 1; continue; }

      // Unsubscribe token: reuse an unused one, otherwise mint one.
      const { data: existingToken, error: tokenLookupError } = await adminClient
        .from('email_unsubscribe_tokens')
        .select('token, used_at')
        .eq('email', address)
        .maybeSingle();
      if (tokenLookupError) throw new Error('Unsubscribe token lookup failed');

      let unsubscribeToken: string;
      if (existingToken && !existingToken.used_at) {
        unsubscribeToken = existingToken.token;
      } else if (existingToken) {
        suppressedCount += 1;
        continue;
      } else {
        unsubscribeToken = generateToken();
        await adminClient
          .from('email_unsubscribe_tokens')
          .upsert({ token: unsubscribeToken, email: address }, { onConflict: 'email', ignoreDuplicates: true });
        const { data: storedToken } = await adminClient
          .from('email_unsubscribe_tokens')
          .select('token')
          .eq('email', address)
          .maybeSingle();
        if (!storedToken?.token) throw new Error('Could not store unsubscribe token');
        unsubscribeToken = storedToken.token;
      }

      const messageId = crypto.randomUUID();
      const html = buildHtml({ bodyText });
      const text = buildText({ bodyText });

      await adminClient.from('email_send_log').insert({
        message_id: messageId,
        template_name: 'careers-acknowledgement',
        recipient_email: address,
        status: 'pending',
        metadata: { subject: SUBJECT, from: fromAddress, ...(replyTo ? { reply_to: replyTo } : {}) },
      });

      const { error: enqueueError } = await adminClient.rpc('enqueue_email', {
        queue_name: 'transactional_emails',
        payload: {
          message_id: messageId,
          // Exactly one address. Never an array, never cc, never bcc.
          to: address,
          from: fromAddress,
          sender_domain: SENDER_DOMAIN,
          ...(replyTo ? { reply_to: replyTo } : {}),
          subject: SUBJECT,
          html,
          text,
          purpose: 'transactional',
          label: 'careers-acknowledgement',
          idempotency_key: messageId,
          unsubscribe_token: unsubscribeToken,
          queued_at: new Date().toISOString(),
        },
      });
      if (enqueueError) throw new Error(enqueueError.message);

      // Mark acknowledged ONLY after a successful enqueue. logged_by NULL is
      // the automatic marker that prevents a second send.
      const { error: logError } = await adminClient.from('job_application_communications').insert({
        application_id: applicant.id,
        channel: 'email',
        message: `${AUTO_PREFIX}${SUBJECT}\n\n${bodyText}`,
        logged_by: null,
      });
      if (logError) {
        console.error(`Ack log insert failed for ${applicant.id}: ${logError.message}`);
        failures.push({ application_id: applicant.id, reason: `log insert failed: ${logError.message}` });
      }

      sent += 1;
    } catch (err) {
      // One failure never aborts the batch, and never marks the row acknowledged.
      failed += 1;
      const reason = err instanceof Error ? err.message : 'Unknown error';
      console.error(`Acknowledgement failed for ${applicant.id}: ${reason}`);
      failures.push({ application_id: applicant.id, reason });
    }
  }

  return json({
    processed: candidates?.length ?? 0,
    sent,
    failed,
    suppressed: suppressedCount,
    skipped_already_acknowledged: alreadyDone,
    cutoff: cutoffIso,
    invoked_by: invokedBy === 'scheduler' ? 'scheduler' : 'user',
    failures,
  }, 200);
});