/**
 * HR careers outreach — one enqueued email per applicant, never a group message.
 *
 * Design rules held deliberately:
 *  - The recipient list is expanded server-side into individual messages. Each
 *    enqueued payload carries exactly one address in `to`. There is no cc and no
 *    bcc field anywhere in this function, and no array is ever assigned to `to`.
 *  - Each message is personalised with that applicant's own name and own
 *    public reference. No other applicant's data is ever placed in a message.
 *  - The existing suppression check (`suppressed_emails`) is reused, fail-closed.
 *  - A failure on one recipient is recorded and the loop continues.
 *  - Nothing here touches inserts into `job_applications`; the public form path
 *    is untouched.
 */
import { createClient } from 'npm:@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers':
    'authorization, x-client-info, apikey, content-type',
};

const SITE_NAME = 'Welile';
const SENDER_DOMAIN = 'notify.welile.com';
const FROM_DOMAIN = 'welile.com';
const DEFAULT_FROM = `${SITE_NAME} <noreply@${FROM_DOMAIN}>`;

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

/** Placeholders this function understands. `public_ref` is a legacy alias of `reference`. */
const SUPPORTED_PLACEHOLDERS = ['name', 'role', 'reference', 'public_ref'];
const ROLE_FALLBACK = 'the role you applied for';

/** Any {{token}} in the text that is not supported, de-duplicated, original casing kept. */
function findUnknownPlaceholders(...texts: string[]): string[] {
  const unknown = new Map<string, string>();
  for (const text of texts) {
    for (const match of text.matchAll(/\{\{\s*([^}\s]+)\s*\}\}/g)) {
      const token = match[1];
      if (!SUPPORTED_PLACEHOLDERS.includes(token.toLowerCase())) {
        unknown.set(token.toLowerCase(), `{{${token}}}`);
      }
    }
  }
  return Array.from(unknown.values());
}

/** Personalised body. Only this recipient's own name, role and reference appear. */
function personalise(
  template: string,
  name: string,
  publicRef: string,
  roleInterest: string | null,
): string {
  const role = roleInterest?.trim() ? roleInterest.trim() : ROLE_FALLBACK;
  return template
    .replace(/\{\{\s*name\s*\}\}/gi, name)
    .replace(/\{\{\s*role\s*\}\}/gi, role)
    .replace(/\{\{\s*reference\s*\}\}/gi, publicRef)
    .replace(/\{\{\s*public_ref\s*\}\}/gi, publicRef);
}

function buildHtml(opts: {
  greetingName: string;
  bodyText: string;
  publicRef: string;
}): string {
  const paragraphs = opts.bodyText
    .split(/\n{2,}/)
    .map((p) => `<p style="margin:0 0 14px;line-height:1.6">${escapeHtml(p).replace(/\n/g, '<br/>')}</p>`)
    .join('');

  return `<!doctype html><html><body style="margin:0;background:#f6f7f9;padding:24px;font-family:Helvetica,Arial,sans-serif;color:#1f2933">
<div style="max-width:560px;margin:0 auto;background:#ffffff;border-radius:12px;padding:28px">
<p style="margin:0 0 18px;font-size:15px">Hello ${escapeHtml(opts.greetingName)},</p>
${paragraphs}
<p style="margin:22px 0 0;font-size:12px;color:#6b7280">Your application reference: <strong>${escapeHtml(opts.publicRef)}</strong></p>
<p style="margin:8px 0 0;font-size:12px;color:#6b7280">${SITE_NAME} — Talent &amp; Recruitment</p>
</div></body></html>`;
}

function buildText(opts: { greetingName: string; bodyText: string; publicRef: string }) {
  return `Hello ${opts.greetingName},\n\n${opts.bodyText}\n\nYour application reference: ${opts.publicRef}\n\n${SITE_NAME} — Talent & Recruitment`;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders });

  const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY')!;

  const authHeader = req.headers.get('Authorization');
  if (!authHeader) return json({ error: 'Missing authorization header' }, 401);

  const adminClient = createClient(supabaseUrl, serviceKey);
  const { data: userData, error: userError } = await createClient(supabaseUrl, anonKey)
    .auth.getUser(authHeader.replace('Bearer ', ''));
  const caller = userData?.user;
  if (userError || !caller) return json({ error: 'Unauthorized' }, 401);

  const { data: roles, error: roleError } = await adminClient
    .from('user_roles')
    .select('role')
    .eq('user_id', caller.id)
    .in('role', ['hr', 'manager', 'super_admin', 'ceo', 'coo']);
  if (roleError) return json({ error: `Role check failed: ${roleError.message}` }, 500);
  if (!roles?.length) {
    return json({ error: 'Only HR, Manager or Super Admin can send careers emails' }, 403);
  }

  const body = (await req.json().catch(() => ({}))) as {
    applicationIds?: string[];
    subject?: string;
    body?: string;
  };

  const subject = (body.subject ?? '').trim();
  const messageTemplate = (body.body ?? '').trim();
  const ids = Array.from(new Set((body.applicationIds ?? []).filter(Boolean)));

  if (!subject) return json({ error: 'A subject is required' }, 400);
  if (messageTemplate.length < 10) return json({ error: 'Write a message body first' }, 400);
  if (!ids.length) return json({ error: 'Select at least one applicant' }, 400);
  if (ids.length > 200) return json({ error: 'Select 200 applicants or fewer per send' }, 400);

  // Unrecognised placeholders stop the whole batch before anything is sent.
  const unknownPlaceholders = findUnknownPlaceholders(subject, messageTemplate);
  if (unknownPlaceholders.length) {
    return json(
      {
        success: false,
        unknownPlaceholders,
        supportedPlaceholders: ['{{name}}', '{{role}}', '{{reference}}'],
        error: `Unrecognised placeholder(s): ${unknownPlaceholders.join(', ')}`,
        requested: ids.length,
        sent: 0,
        suppressed: 0,
        failed: 0,
        missing_email: 0,
      },
      200,
    );
  }

  const { data: applicants, error: fetchError } = await adminClient
    .from('job_applications')
    .select('id, full_name, email, public_ref, role_interest')
    .in('id', ids)
    .is('purged_at', null);
  if (fetchError) return json({ error: `Could not load applicants: ${fetchError.message}` }, 500);

  const fromAddress = Deno.env.get('CAREERS_FROM') || DEFAULT_FROM;
  const replyTo = Deno.env.get('CAREERS_REPLY_TO') || null;

  let sent = 0;
  let suppressedCount = 0;
  let failed = 0;
  let missingEmail = 0;
  const failures: { applicant: string; reason: string }[] = [];
  const seen = new Set<string>();

  for (const applicant of applicants ?? []) {
    const name = (applicant.full_name || 'there').trim();
    const publicRef = applicant.public_ref || '—';
    const address = (applicant.email || '').trim().toLowerCase();

    // Log helper — one row per attempt, always with the body actually composed.
    const logComm = async (message: string) => {
      await adminClient.from('job_application_communications').insert({
        application_id: applicant.id,
        channel: 'email',
        message,
        logged_by: caller.id,
      });
    };

    if (!address) {
      missingEmail += 1;
      await logComm(`[email not sent — no address on file] ${subject}`);
      continue;
    }
    // A duplicate address must not receive two copies, and must never be merged
    // into another message. It is skipped outright.
    if (seen.has(address)) continue;
    seen.add(address);

    const roleInterest = (applicant as { role_interest?: string | null }).role_interest ?? null;
    const personalisedBody = personalise(messageTemplate, name, publicRef, roleInterest);
    const personalisedSubject = personalise(subject, name, publicRef, roleInterest);

    try {
      // Suppression: fail-closed, same table and semantics as send-transactional-email.
      const { data: suppressed, error: suppressionError } = await adminClient
        .from('suppressed_emails')
        .select('id')
        .eq('email', address)
        .maybeSingle();
      if (suppressionError) throw new Error('Suppression check failed');

      if (suppressed) {
        suppressedCount += 1;
        await logComm(`[email skipped — address suppressed] ${personalisedSubject}\n\n${personalisedBody}`);
        continue;
      }

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
        // Token already used but address not suppressed — treat as opted out.
        suppressedCount += 1;
        await logComm(`[email skipped — recipient unsubscribed] ${personalisedSubject}`);
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
      const html = buildHtml({ greetingName: name, bodyText: personalisedBody, publicRef });
      const text = buildText({ greetingName: name, bodyText: personalisedBody, publicRef });

      await adminClient.from('email_send_log').insert({
        message_id: messageId,
        template_name: 'careers-outreach',
        recipient_email: address,
        status: 'pending',
        metadata: { subject: personalisedSubject, from: fromAddress, ...(replyTo ? { reply_to: replyTo } : {}) },
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
          subject: personalisedSubject,
          html,
          text,
          purpose: 'transactional',
          label: 'careers-outreach',
          idempotency_key: messageId,
          unsubscribe_token: unsubscribeToken,
          queued_at: new Date().toISOString(),
        },
      });

      if (enqueueError) throw new Error(enqueueError.message);

      sent += 1;
      await logComm(`${personalisedSubject}\n\n${personalisedBody}`);
    } catch (err) {
      // One failure never aborts the batch.
      failed += 1;
      const reason = err instanceof Error ? err.message : 'Unknown error';
      failures.push({ applicant: name, reason });
      await adminClient.from('email_send_log').insert({
        message_id: crypto.randomUUID(),
        template_name: 'careers-outreach',
        recipient_email: address,
        status: 'failed',
        error_message: reason,
      });
      await logComm(`[email failed — ${reason}] ${personalisedSubject}`);
    }
  }

  return json(
    {
      success: true,
      requested: ids.length,
      sent,
      suppressed: suppressedCount,
      failed,
      missing_email: missingEmail,
      from: fromAddress,
      used_careers_from: Boolean(Deno.env.get('CAREERS_FROM')),
      failures: failures.slice(0, 20),
    },
    200,
  );
});
