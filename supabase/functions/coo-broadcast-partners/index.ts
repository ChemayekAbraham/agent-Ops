import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers':
    'authorization, x-client-info, apikey, content-type',
};

const SENDER_DOMAIN = 'notify.welile.com';
const FROM_DOMAIN = 'welile.com';
const FROM_HEADER = `Welile Partnerships <partnership@${FROM_DOMAIN}>`;
const ALLOWED_ROLES = ['coo', 'ceo', 'cto', 'super_admin', 'manager'];
const LOGO_URL = 'https://welileapp.com/welile-logo.png';
const NOTIFICATION_TYPE_DEFAULT = 'Partner Communication';

function generateToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join('');
}

function escapeHtml(s: string) {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function sanitizeHtml(input: string): string {
  // strip <script>, <style>, on* handlers, javascript: urls
  let html = input || '';
  html = html.replace(/<script[\s\S]*?<\/script>/gi, '');
  html = html.replace(/<style[\s\S]*?<\/style>/gi, '');
  html = html.replace(/ on[a-z]+="[^"]*"/gi, '');
  html = html.replace(/ on[a-z]+='[^']*'/gi, '');
  html = html.replace(/javascript:/gi, '');
  return html;
}

function htmlToText(html: string): string {
  return html
    .replace(/<\/(p|div|li|h\d|br)>/gi, '\n')
    .replace(/<br\s*\/?\s*>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function renderPartnerEmail(opts: {
  emailTitle: string;
  notificationType: string;
  partnerName: string;
  messageBodyHtml: string;
  notificationDate: string;
  unsubscribeUrl: string;
}): string {
  const {
    emailTitle, notificationType, partnerName,
    messageBodyHtml, notificationDate, unsubscribeUrl,
  } = opts;
  return `<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Transitional//EN" "http://www.w3.org/TR/xhtml1/DTD/xhtml1-transitional.dtd">
<html xmlns="http://www.w3.org/1999/xhtml">
<head>
  <meta http-equiv="Content-Type" content="text/html; charset=UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${escapeHtml(emailTitle)}</title>
  <style type="text/css">
    body, table, td, a { -webkit-text-size-adjust: 100%; -ms-text-size-adjust: 100%; }
    table, td { mso-table-lspace: 0pt; mso-table-rspace: 0pt; }
    img { -ms-interpolation-mode: bicubic; border: 0; height: auto; line-height: 100%; outline: none; text-decoration: none; }
    table { border-collapse: collapse !important; }
    body { height: 100% !important; margin: 0 !important; padding: 0 !important; width: 100% !important; }
    a { color: #7b19d4; text-decoration: none; font-weight: 600; }
    a:hover { color: #5a129e; text-decoration: underline; }
    .message-content p { margin: 0 0 15px 0; }
    .message-content p:last-child { margin: 0; }
    .message-content ul, .message-content ol { margin: 0 0 15px 0; padding-left: 20px; }
    .message-content li { margin-bottom: 5px; }
    @media screen and (max-width: 600px) {
      .responsive-table { width: 100% !important; max-width: 100% !important; }
      .padding-mobile { padding: 25px 20px !important; }
      .td-block { display: block !important; width: 100% !important; text-align: left !important; }
      .hide-mobile { display: none !important; }
      .mobile-center { text-align: center !important; }
      .mobile-padding-bottom { padding-bottom: 15px !important; }
    }
  </style>
</head>
<body style="margin: 0; padding: 0; background-color: #f4f7f9; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; -webkit-font-smoothing: antialiased;">
  <table width="100%" border="0" cellpadding="0" cellspacing="0" style="background-color: #f4f7f9;">
    <tr><td align="center" style="padding: 40px 10px;">
      <table width="600" border="0" cellpadding="0" cellspacing="0" class="responsive-table" style="background-color: #ffffff; border-radius: 12px; overflow: hidden; box-shadow: 0 4px 15px rgba(0,0,0,0.05);">
        <tr><td height="6" style="background-color: #7b19d4; background-image: linear-gradient(90deg, #7b19d4 0%, #a855f7 100%);"></td></tr>
        <tr><td style="padding: 30px 40px; border-bottom: 1px solid #f1f5f9;" class="padding-mobile">
          <table width="100%" border="0" cellpadding="0" cellspacing="0"><tr>
            <td align="left" valign="middle">
              <img src="${LOGO_URL}" alt="WELILE TECHNOLOGIES LTD" width="130" style="display: block; max-width: 130px; height: auto;" />
            </td>
            <td align="right" valign="middle" style="font-size: 11px; color: #94a3b8; font-weight: 700; text-transform: uppercase; letter-spacing: 1.5px;" class="hide-mobile">
              ${escapeHtml(notificationType)}
            </td>
          </tr></table>
        </td></tr>
        <tr><td align="center" style="padding: 40px 40px 20px 40px;" class="padding-mobile">
          <h1 style="margin: 0; color: #0f172a; font-size: 24px; font-weight: 800; letter-spacing: -0.5px;">${escapeHtml(emailTitle)}</h1>
        </td></tr>
        <tr><td align="left" style="padding: 0 40px 25px 40px;" class="padding-mobile">
          <p style="margin: 0 0 15px 0; color: #0f172a; font-size: 16px; font-weight: 600;">Dear ${escapeHtml(partnerName)},</p>
          <div class="message-content" style="margin: 0; color: #475569; font-size: 15px; line-height: 24px;">
            ${messageBodyHtml}
          </div>
        </td></tr>
        <tr><td align="center" style="padding: 0 40px 30px 40px;" class="padding-mobile">
          <table border="0" cellpadding="0" cellspacing="0"><tr>
            <td align="center" style="border-radius: 8px; background-color: #7b19d4;">
              <a href="tel:+256748747134" style="display: inline-block; padding: 14px 28px; color: #ffffff; font-size: 16px; font-weight: 600; text-decoration: none; border-radius: 8px; border: 1px solid #7b19d4;">
                <img src="https://img.icons8.com/ios-filled/50/ffffff/phone.png" alt="Call" width="18" style="vertical-align: middle; margin-right: 8px;" />
                <span style="vertical-align: middle;">+256 748 747 134</span>
              </a>
            </td>
          </tr></table>
        </td></tr>
        <tr><td style="padding: 0 40px 40px 40px;" class="padding-mobile">
          <p style="margin: 0 0 15px 0; color: #475569; font-size: 15px; line-height: 24px;"><strong>Date:</strong> ${escapeHtml(notificationDate)}</p>
          <p style="margin: 0; color: #475569; font-size: 15px; line-height: 24px;">Thank you for your continued trust and partnership with WELILE TECHNOLOGIES LTD.</p>
          <p style="margin: 25px 0 0 0; color: #0f172a; font-size: 15px; font-weight: 600;">Warm regards,<br /><span style="font-weight: 400; color: #475569;">WELILE TECHNOLOGIES LTD Team</span></p>
        </td></tr>
        <tr><td style="padding: 20px 40px; text-align: center; border-top: 1px solid #e5e7eb;">
          <i><q style="margin: 0; color: #94a3b8; font-size: 12px; line-height: 18px; font-weight: 500;">Welile is turning rent into an asset.</q></i>
        </td></tr>
      </table>
      <table width="600" border="0" cellpadding="0" cellspacing="0" class="responsive-table" style="margin-top: 30px;">
        <tr><td align="center" style="padding: 0 20px;">
          <table border="0" cellpadding="0" cellspacing="0" style="margin-bottom: 25px;"><tr>
            <td style="padding: 0 12px;"><a href="https://x.com/Welile2025"><img src="https://img.icons8.com/ios-filled/50/94a3b8/twitter.png" alt="Twitter" width="22" style="display: block; opacity: 0.8;" /></a></td>
            <td style="padding: 0 12px;"><a href="https://ug.linkedin.com/company/welile"><img src="https://img.icons8.com/ios-filled/50/94a3b8/linkedin.png" alt="LinkedIn" width="22" style="display: block; opacity: 0.8;" /></a></td>
            <td style="padding: 0 12px;"><a href="https://www.facebook.com/profile.php?id=61578974799814"><img src="https://img.icons8.com/ios-filled/50/94a3b8/facebook-new.png" alt="Facebook" width="22" style="display: block; opacity: 0.8;" /></a></td>
            <td style="padding: 0 12px;"><a href="https://www.instagram.com/welile_technologies/"><img src="https://img.icons8.com/ios-filled/50/94a3b8/instagram-new.png" alt="Instagram" width="22" style="display: block; opacity: 0.8;" /></a></td>
          </tr></table>
          <p style="margin: 0 0 12px 0; color: #94a3b8; font-size: 14px; font-weight: 700;">WELILE TECHNOLOGIES LTD</p>
          <p style="margin: 0 0 20px 0; font-size: 13px;"><a href="https://maps.app.goo.gl/zfmsP2m2cCXEJXPe9" style="color: #a855f7; text-decoration: none;">Palm Lane Kabaale, Entebbe</a></p>
          <p style="margin: 0 0 20px 0; color: #94a3b8; font-size: 12px; line-height: 18px;">You are receiving this email because you are a registered partner at Welile.<br />This is a communication notification. Please do not reply directly to this email.</p>
          <p style="margin: 0 0 15px 0;">
            <a href="https://welile.com/company-profile" style="color: #94a3b8; font-size: 12px; text-decoration: underline; margin: 0 10px;">Privacy Policy</a>
            <a href="https://welile.com/company-profile" style="color: #94a3b8; font-size: 12px; text-decoration: underline; margin: 0 10px;">Terms of Service</a>
            <a href="${unsubscribeUrl}" style="color: #94a3b8; font-size: 12px; text-decoration: underline; margin: 0 10px;">Unsubscribe</a>
          </p>
          <p style="margin: 0; color: #cbd5e1; font-size: 12px;">&copy; 2026 Welile. All rights reserved.</p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  try {
    const authHeader = req.headers.get('Authorization');
    if (!authHeader) {
      return new Response(JSON.stringify({ error: 'Missing auth' }), {
        status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const admin = createClient(supabaseUrl, serviceKey);

    const token = authHeader.replace(/^Bearer\s+/i, '');
    const { data: userData, error: userErr } = await admin.auth.getUser(token);
    if (userErr || !userData?.user) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), {
        status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }
    const caller = userData.user;

    const { data: roles } = await admin
      .from('user_roles').select('role').eq('user_id', caller.id);
    const allowed = (roles || []).some((r: any) => ALLOWED_ROLES.includes(r.role));
    if (!allowed) {
      return new Response(JSON.stringify({ error: 'Insufficient permissions. COO/CEO/super_admin only.' }), {
        status: 403, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const body = await req.json().catch(() => ({}));
    const subject = (body.subject || '').toString().trim();
    const rawHtml = (body.html || '').toString();
    const dryRun = !!body.dry_run;
    const notificationType = ((body.notification_type || '').toString().trim() || NOTIFICATION_TYPE_DEFAULT).slice(0, 60);
    const testEmailRaw = (body.test_email || '').toString().trim().toLowerCase();
    const isTest = !!testEmailRaw;
    if (isTest && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(testEmailRaw)) {
      return new Response(JSON.stringify({ error: 'Invalid test_email address' }), {
        status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    if (!subject || subject.length > 200) {
      return new Response(JSON.stringify({ error: 'Subject is required (max 200 chars)' }), {
        status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }
    const bodyHtml = sanitizeHtml(rawHtml);
    const plainProbe = htmlToText(bodyHtml);
    if (!plainProbe || plainProbe.length < 2) {
      return new Response(JSON.stringify({ error: 'Message body cannot be empty' }), {
        status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }
    if (bodyHtml.length > 100000) {
      return new Response(JSON.stringify({ error: 'Message body too large' }), {
        status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const CHUNK = 100;
    const emails = new Set<string>();
    const recipients: { user_id: string; email: string; full_name: string }[] = [];
    const suppressed = new Set<string>();

    if (isTest) {
      // Single-recipient test send — bypass partner lookup and suppressions.
      const { data: prof } = await admin
        .from('profiles').select('id, full_name').eq('email', testEmailRaw).maybeSingle();
      recipients.push({
        user_id: (prof as any)?.id || caller.id,
        email: testEmailRaw,
        full_name: ((prof as any)?.full_name || '').toString().trim() || 'Partner',
      });
      emails.add(testEmailRaw);
    } else {
      // Resolve all distinct users who hold one or more portfolio (not just supporter role)
      const { data: portRows, error: portErr } = await admin
        .from('investor_portfolios').select('investor_id');
      if (portErr) throw portErr;
      const userIds = Array.from(new Set((portRows || []).map((r: any) => r.investor_id))).filter(Boolean);
      for (let i = 0; i < userIds.length; i += CHUNK) {
        const slice = userIds.slice(i, i + CHUNK);
        const { data: profs, error: profErr } = await admin
          .from('profiles').select('id, email, full_name').in('id', slice);
        if (profErr) throw profErr;
        for (const p of profs || []) {
          const e = (p.email || '').toString().trim().toLowerCase();
          if (!e || !e.includes('@') || e.endsWith('.welile.user') || e.endsWith('.noapp.welile.user')) continue;
          if (emails.has(e)) continue;
          emails.add(e);
          recipients.push({ user_id: p.id, email: e, full_name: ((p as any).full_name || '').toString().trim() || 'Partner' });
        }
      }
      const allEmails = recipients.map((r) => r.email);
      if (allEmails.length) {
        for (let i = 0; i < allEmails.length; i += CHUNK) {
          const slice = allEmails.slice(i, i + CHUNK);
          const { data: sup } = await admin
            .from('email_suppressions').select('email').in('email', slice);
          for (const s of sup || []) suppressed.add((s as any).email);
        }
      }
    }
    const finalRecipients = recipients.filter((r) => !suppressed.has(r.email));

    if (dryRun) {
      return new Response(JSON.stringify({
        success: true, dry_run: true,
        recipient_count: finalRecipients.length,
        suppressed_count: suppressed.size,
      }), { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    const unsubBase = `${supabaseUrl.replace('.supabase.co', '.supabase.co')}/functions/v1/handle-email-unsubscribe`;
    const notificationDate = new Date().toLocaleDateString('en-GB', {
      day: '2-digit', month: 'long', year: 'numeric',
    });

    let queued = 0;
    const errors: string[] = [];
    for (const r of finalRecipients) {
      const messageId = crypto.randomUUID();
      // upsert unsubscribe token
      let unsubToken = '';
      const { data: existing } = await admin
        .from('email_unsubscribe_tokens').select('token, used_at').eq('email', r.email).maybeSingle();
      if (existing && !(existing as any).used_at) {
        unsubToken = (existing as any).token;
      } else {
        unsubToken = generateToken();
        await admin.from('email_unsubscribe_tokens').upsert(
          { token: unsubToken, email: r.email },
          { onConflict: 'email', ignoreDuplicates: true },
        );
        const { data: stored } = await admin
          .from('email_unsubscribe_tokens').select('token').eq('email', r.email).maybeSingle();
        if (stored) unsubToken = (stored as any).token;
      }
      const unsubUrl = `${unsubBase}?token=${encodeURIComponent(unsubToken)}`;

      const html = renderPartnerEmail({
        emailTitle: subject,
        notificationType,
        partnerName: r.full_name,
        messageBodyHtml: bodyHtml,
        notificationDate,
        unsubscribeUrl: unsubUrl,
      });
      const text = `${subject}\n\n${htmlToText(bodyHtml)}\n\nUnsubscribe: ${unsubUrl}`;

      await admin.from('email_send_log').insert({
        message_id: messageId,
        template_name: 'coo-partner-broadcast',
        recipient_email: r.email,
        status: 'pending',
      });

      const { error: enqErr } = await admin.rpc('enqueue_email', {
        queue_name: 'transactional_emails',
        payload: {
          message_id: messageId,
          to: r.email,
          from: FROM_HEADER,
          sender_domain: SENDER_DOMAIN,
          reply_to: `partnership@${FROM_DOMAIN}`,
          subject,
          html,
          text,
          purpose: 'transactional',
          label: 'coo-partner-broadcast',
          idempotency_key: messageId,
          unsubscribe_token: unsubToken,
          queued_at: new Date().toISOString(),
        },
      });

      if (enqErr) {
        errors.push(`${r.email}: ${enqErr.message}`);
        await admin.from('email_send_log').insert({
          message_id: messageId,
          template_name: 'coo-partner-broadcast',
          recipient_email: r.email,
          status: 'failed',
          error_message: 'enqueue_email failed',
        });
      } else {
        queued++;
      }
    }

    await admin.from('audit_logs').insert({
      user_id: caller.id,
      action_type: isTest ? 'coo_partner_broadcast_test' : 'coo_partner_broadcast_sent',
      table_name: 'email_send_log',
      record_id: caller.id,
      reason: isTest ? 'COO partner broadcast TEST send' : 'COO mass broadcast to partners',
      metadata: {
        subject,
        queued,
        suppressed: suppressed.size,
        total_partner_emails: recipients.length,
        errors_count: errors.length,
        test_email: isTest ? testEmailRaw : null,
      },
    });

    return new Response(JSON.stringify({
      success: true,
      test: isTest,
      queued,
      suppressed: suppressed.size,
      total: recipients.length,
      errors: errors.slice(0, 10),
    }), { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  } catch (e: any) {
    console.error('coo-broadcast-partners error:', e);
    return new Response(JSON.stringify({ error: e?.message || 'Internal error' }), {
      status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
