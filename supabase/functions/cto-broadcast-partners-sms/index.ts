import "../_shared/smsFooterInterceptor.ts";
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { isPhoneBlocked } from '../_shared/smsExceptions.ts';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const ALLOWED_ROLES = ['coo', 'ceo', 'cto', 'super_admin', 'manager'];

function formatPhoneInternational(phone: string): string {
  const digits = (phone || '').replace(/[^0-9]/g, '');
  if (!digits) return '';
  if (digits.startsWith('256')) return `+${digits}`;
  if (digits.startsWith('0')) return `+256${digits.slice(1)}`;
  if (digits.length === 9) return `+256${digits}`;
  return `+${digits}`;
}

function isValidPhone(p: string | null | undefined): boolean {
  if (!p) return false;
  const t = String(p).trim();
  if (!t || t === '-') return false;
  return t.replace(/\D/g, '').length >= 7;
}

const toBareDigits = (p: string) => formatPhoneInternational(p).replace(/^\+/, '');

type SmsResult = { accepted: boolean; provider?: string; reason?: string };

// Yoola (primary). Auth is the api_key field in the JSON body only.
async function sendViaYoola(phone: string, message: string): Promise<SmsResult> {
  const apiKey = Deno.env.get('YOOLA_SMS_API_KEY')?.trim();
  if (!apiKey) return { accepted: false, reason: 'yoola_not_configured' };
  try {
    const res = await fetch('https://yoolasms.com/api/v1/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ phone: toBareDigits(phone), message, api_key: apiKey, sender: "WELILE" }),
    });
    const text = await res.text();
    let data: any = {};
    try { data = JSON.parse(text); } catch { /* non-JSON */ }
    const status = String(data?.status ?? '').toLowerCase();
    if (res.ok && (status === 'success' || status === 'ok' || status === 'sent' || status === 'queued')) {
      return { accepted: true, provider: 'yoola' };
    }
    if (res.ok && !data?.error && status === '') return { accepted: true, provider: 'yoola' };
    return { accepted: false, reason: `yoola_${res.status}_${status || 'rejected'}` };
  } catch (e) {
    return { accepted: false, reason: (e as Error).message };
  }
}

// Africa's Talking (fallback).
async function sendViaAfricasTalking(phone: string, message: string): Promise<SmsResult> {
  const apiKey = Deno.env.get('AFRICASTALKING_API_KEY');
  const username = Deno.env.get('AFRICASTALKING_USERNAME');
  if (!apiKey || !username) return { accepted: false, reason: 'missing_credentials' };
  const isSandbox = username.toLowerCase() === 'sandbox';
  const url = isSandbox
    ? 'https://api.sandbox.africastalking.com/version1/messaging'
    : 'https://api.africastalking.com/version1/messaging';
  const params = new URLSearchParams({
    username, from: "WELILE",
    to: formatPhoneInternational(phone),    message,
  });
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', apiKey, Accept: 'application/json' },
      body: params.toString(),
    });
    const data = await res.json().catch(() => null);
    const recipients = data?.SMSMessageData?.Recipients;
    if (recipients && recipients.length > 0) {
      const s = recipients[0].statusCode;
      if (s === 101 || s === 100 || s === 102) return { accepted: true, provider: 'africastalking' };
      return { accepted: false, reason: `at_status_${s}` };
    }
    return { accepted: false, reason: 'at_no_recipients' };
  } catch (e) {
    return { accepted: false, reason: (e as Error).message };
  }
}

// LANA (final fallback).
async function sendViaLana(phone: string, message: string): Promise<SmsResult> {
  const apiKey = Deno.env.get('LANA_SMS_API_KEY')?.trim();
  if (!apiKey) return { accepted: false, reason: 'lana_not_configured' };
  try {
    const res = await fetch('https://api.lanasms.com/v1/send', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ phone: toBareDigits(phone), sender_id: "WELILE", message}),
    });
    const text = await res.text();
    let data: any = {};
    try { data = JSON.parse(text); } catch { /* non-JSON */ }
    const raw = data?.status;
    const s = String(raw ?? '').toLowerCase();
    if (res.ok && (raw === true || s === 'success' || s === 'true' || s === 'ok' || s === 'sent' || s === 'queued')) {
      return { accepted: true, provider: 'lana' };
    }
    return { accepted: false, reason: `lana_${res.status}_rejected` };
  } catch (e) {
    return { accepted: false, reason: (e as Error).message };
  }
}

// Provider chain: Yoola (primary) -> Africa's Talking -> LANA.
async function sendSMS(phone: string, message: string): Promise<SmsResult> {
  const yoola = await sendViaYoola(phone, message);
  if (yoola.accepted) return yoola;
  const at = await sendViaAfricasTalking(phone, message);
  if (at.accepted) return at;
  const lana = await sendViaLana(phone, message);
  if (lana.accepted) return lana;
  if (yoola.reason && yoola.reason !== 'yoola_not_configured') return yoola;
  if (at.reason && at.reason !== 'missing_credentials') return at;
  return lana;
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

    const { data: roles } = await admin.from('user_roles').select('role').eq('user_id', caller.id);
    const allowed = (roles || []).some((r: any) => ALLOWED_ROLES.includes(r.role));
    if (!allowed) {
      return new Response(JSON.stringify({ error: 'Insufficient permissions' }), {
        status: 403, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const body = await req.json().catch(() => ({}));
    const message = (body.message || '').toString().trim();
    const dryRun = !!body.dry_run;
    const testPhoneRaw = (body.test_phone || '').toString().trim();
    const isTest = !!testPhoneRaw;

    if (!isTest && !dryRun && (!message || message.length < 2)) {
      return new Response(JSON.stringify({ error: 'Message body is required' }), {
        status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }
    if (message.length > 800) {
      return new Response(JSON.stringify({ error: 'Message too long (max 800 chars / 5 SMS segments)' }), {
        status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // Build audience: every distinct portfolio-holding partner with a valid phone.
    const CHUNK = 100;
    const phones = new Set<string>();
    const recipients: { user_id: string; phone: string }[] = [];

    if (isTest) {
      const p = formatPhoneInternational(testPhoneRaw);
      if (!p || p.replace(/\D/g, '').length < 9) {
        return new Response(JSON.stringify({ error: 'Invalid test phone' }), {
          status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }
      recipients.push({ user_id: caller.id, phone: p });
    } else {
      const { data: portRows, error: portErr } = await admin
        .from('investor_portfolios').select('investor_id');
      if (portErr) throw portErr;
      const userIds = Array.from(new Set((portRows || []).map((r: any) => r.investor_id))).filter(Boolean);
      for (let i = 0; i < userIds.length; i += CHUNK) {
        const slice = userIds.slice(i, i + CHUNK);
        const { data: profs } = await admin
          .from('profiles').select('id, phone').in('id', slice);
        for (const prof of profs || []) {
          if (!isValidPhone((prof as any).phone)) continue;
          const intl = formatPhoneInternational((prof as any).phone);
          if (!intl || phones.has(intl)) continue;
          phones.add(intl);
          recipients.push({ user_id: (prof as any).id, phone: intl });
        }
      }
    }

    if (dryRun) {
      return new Response(JSON.stringify({
        success: true, dry_run: true, recipient_count: recipients.length,
      }), { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    // Drop recipients blocked from partner broadcasts via CTO SMS exceptions.
    if (!isTest) {
      const { data: exRows } = await admin
        .from('sms_message_exceptions')
        .select('phone')
        .in('message_type', ['all', 'partner_broadcast']);
      const blocked = new Set((exRows || []).map((r: any) => formatPhoneInternational(r.phone)));
      if (blocked.size > 0) {
        for (let i = recipients.length - 1; i >= 0; i--) {
          if (blocked.has(recipients[i].phone)) recipients.splice(i, 1);
        }
      }
    }

    // Send per-recipient via the Yoola-first provider chain, in parallel batches.
    const BATCH = 50;
    let sent = 0, failed = 0;
    const errors: string[] = [];
    for (let i = 0; i < recipients.length; i += BATCH) {
      const batch = recipients.slice(i, i + BATCH);
      const results = await Promise.all(batch.map((r) => sendSMS(r.phone, message)));
      for (const result of results) {
        if (result.accepted) sent++;
        else { failed++; if (result.reason) errors.push(result.reason); }
      }
    }

    await admin.from('audit_logs').insert({
      user_id: caller.id,
      action_type: isTest ? 'cto_partner_sms_broadcast_test' : 'cto_partner_sms_broadcast_sent',
      table_name: 'profiles',
      record_id: caller.id,
      reason: isTest
        ? 'CTO partner SMS broadcast TEST send'
        : 'CTO partner SMS broadcast to portfolio-holding partners',
      metadata: {
        message_length: message.length,
        segments: Math.max(1, Math.ceil(message.length / 160)),
        sent, failed,
        total: recipients.length,
        test_phone: isTest ? testPhoneRaw : null,
        errors_sample: errors.slice(0, 5),
      },
    });

    return new Response(JSON.stringify({
      success: true,
      test: isTest,
      sent, failed,
      total: recipients.length,
    }), { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  } catch (e: any) {
    console.error('cto-broadcast-partners-sms error:', e);
    return new Response(JSON.stringify({ error: e?.message || 'Internal error' }), {
      status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});