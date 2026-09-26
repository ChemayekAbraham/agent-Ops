import "../_shared/smsFooterInterceptor.ts";
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const ALLOWED_ROLES = ['coo', 'ceo', 'cto', 'cmo', 'crm', 'super_admin', 'manager'];
const VALID_AUDIENCES = ['tenant', 'agent', 'landlord', 'tenants_with_balance'] as const;
type Audience = (typeof VALID_AUDIENCES)[number];

function formatPhoneInternational(phone: string): string {
  let digits = (phone || '').replace(/[^0-9]/g, '');
  if (!digits) return '';
  if (digits.startsWith('2560') && digits.length >= 13) digits = `256${digits.slice(4)}`;
  if (digits.startsWith('256')) return `+${digits}`;
  if (digits.startsWith('0')) return `+256${digits.slice(1)}`;
  if (digits.length === 9) return `+256${digits}`;
  return `+${digits}`;
}

function isValidPhone(p: string | null | undefined): boolean {
  if (!p) return false;
  const t = String(p).trim();
  if (!t || t === '-') return false;
  return /^\+256\d{9}$/.test(formatPhoneInternational(t));
}

const toBareDigits = (p: string) => formatPhoneInternational(p).replace(/^\+/, '');

type SmsResult = { accepted: boolean; provider?: string; reason?: string };

function combineFailureReasons(results: SmsResult[]): string {
  const reasons = results
    .filter((r) => !r.accepted && r.reason)
    .map((r) => r.provider ? `${r.provider}:${r.reason}` : r.reason!);
  return Array.from(new Set(reasons)).join(' | ') || 'all_sms_providers_failed';
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function sendViaYoola(phone: string, message: string): Promise<SmsResult> {
  const apiKey = Deno.env.get('YOOLA_SMS_API_KEY')?.trim();
  if (!apiKey) return { accepted: false, provider: 'yoola', reason: 'not_configured' };
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
    return { accepted: false, provider: 'yoola', reason: `${res.status}_${status || 'rejected'}` };
  } catch (e) {
    return { accepted: false, provider: 'yoola', reason: (e as Error).message };
  }
}

async function sendViaAfricasTalking(phone: string, message: string): Promise<SmsResult> {
  const apiKey = Deno.env.get('AFRICASTALKING_API_KEY');
  const username = Deno.env.get('AFRICASTALKING_USERNAME');
  if (!apiKey || !username) return { accepted: false, provider: 'africastalking', reason: 'missing_credentials' };
  const isSandbox = username.toLowerCase() === 'sandbox';
  const url = isSandbox
    ? 'https://api.sandbox.africastalking.com/version1/messaging'
    : 'https://api.africastalking.com/version1/messaging';
  const params = new URLSearchParams({ username, from: "WELILE", to: formatPhoneInternational(phone), message });
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
      return { accepted: false, provider: 'africastalking', reason: `status_${s}` };
    }
    return { accepted: false, provider: 'africastalking', reason: 'no_recipients' };
  } catch (e) {
    return { accepted: false, provider: 'africastalking', reason: (e as Error).message };
  }
}

async function sendViaLana(phone: string, message: string): Promise<SmsResult> {
  const apiKey = Deno.env.get('LANA_SMS_API_KEY')?.trim();
  if (!apiKey) return { accepted: false, provider: 'lana', reason: 'not_configured' };
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
    return { accepted: false, provider: 'lana', reason: `${res.status}_rejected` };
  } catch (e) {
    return { accepted: false, provider: 'lana', reason: (e as Error).message };
  }
}

async function sendSMS(phone: string, message: string): Promise<SmsResult> {
  if (!isValidPhone(phone)) return { accepted: false, reason: 'invalid_ugandan_phone' };
  const failures: SmsResult[] = [];
  const yoola = await sendViaYoola(phone, message);
  if (yoola.accepted) return yoola;
  failures.push(yoola);
  const at = await sendViaAfricasTalking(phone, message);
  if (at.accepted) return at;
  failures.push(at);
  const lana = await sendViaLana(phone, message);
  if (lana.accepted) return lana;
  failures.push(lana);
  return { accepted: false, reason: combineFailureReasons(failures) };
}

async function sendSMSWithRetries(phone: string, message: string, attempts = 3): Promise<SmsResult> {
  let last: SmsResult = { accepted: false, reason: 'not_attempted' };
  for (let attempt = 1; attempt <= attempts; attempt++) {
    last = await sendSMS(phone, message);
    if (last.accepted) return last;
    if (attempt < attempts) await delay(750 * attempt);
  }
  return last;
}

async function fetchRoleUserPhones(admin: any, role: Audience): Promise<{ user_id: string; phone: string }[]> {
  const out: { user_id: string; phone: string }[] = [];

  // "Agents" means real, working field/referral agents — anyone who has ever
  // collected rent or been assigned as the agent on a rent request — not
  // everyone who merely holds the 'agent' row in user_roles. Most accounts in
  // this system carry {tenant, agent, landlord, supporter} simultaneously, so
  // a raw role-table query for 'agent' returns ~58,755 users (essentially the
  // whole platform) instead of the ~233 who actually are one. Reuses the same
  // canonical definition agent_ops_strict_agent_ids() already uses elsewhere
  // (get_agent_ops_overview, get_agent_ops_top_agents) so this can't drift
  // from what the rest of the product calls an agent.
  // "Tenants with balances" means tenants who currently owe rent — anyone whose
  // outstanding balance in the canonical day-state view is above zero. This is
  // the same source the payment-notice messages use for their {{balance}} line,
  // so the audience can't drift from what the product calls a balance.
  if (role === 'tenants_with_balance') {
    const { data, error } = await admin.rpc('get_tenant_payment_day_state', {});
    if (error) throw error;
    const userIds = Array.from(new Set(
      (data || []).filter((r: any) => Number(r.outstanding) > 0).map((r: any) => r.tenant_id).filter(Boolean),
    ));
    const CHUNK = 200;
    for (let i = 0; i < userIds.length; i += CHUNK) {
      const slice = userIds.slice(i, i + CHUNK);
      const { data: profs } = await admin.from('profiles').select('id, phone').in('id', slice).is('deleted_at', null);
      for (const p of profs || []) out.push({ user_id: p.id, phone: p.phone });
    }
    return out;
  }

  if (role === 'agent') {
    const { data, error } = await admin.rpc('agent_ops_strict_agent_ids');
    if (error) throw error;
    const userIds = Array.from(new Set((data || []).map((r: any) => r.agent_id).filter(Boolean)));
    const CHUNK = 200;
    for (let i = 0; i < userIds.length; i += CHUNK) {
      const slice = userIds.slice(i, i + CHUNK);
      const { data: profs } = await admin.from('profiles').select('id, phone').in('id', slice);
      for (const p of profs || []) out.push({ user_id: p.id, phone: p.phone });
    }
    return out;
  }

  const PAGE = 1000;
  let from = 0;
  const userIds: string[] = [];
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const { data, error } = await admin
      .from('user_roles').select('user_id').eq('role', role).range(from, from + PAGE - 1);
    if (error) throw error;
    if (!data || data.length === 0) break;
    for (const r of data) if (r.user_id) userIds.push(r.user_id);
    if (data.length < PAGE) break;
    from += PAGE;
  }
  const uniq = Array.from(new Set(userIds));
  const CHUNK = 200;
  for (let i = 0; i < uniq.length; i += CHUNK) {
    const slice = uniq.slice(i, i + CHUNK);
    const { data: profs } = await admin.from('profiles').select('id, phone').in('id', slice);
    for (const p of profs || []) out.push({ user_id: p.id, phone: p.phone });
  }
  return out;
}

async function fetchLandlordTablePhones(admin: any): Promise<{ user_id: string; phone: string }[]> {
  const out: { user_id: string; phone: string }[] = [];
  const PAGE = 1000;
  let from = 0;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const { data, error } = await admin
      .from('landlords').select('id, phone').range(from, from + PAGE - 1);
    if (error) throw error;
    if (!data || data.length === 0) break;
    for (const r of data) out.push({ user_id: r.id, phone: r.phone });
    if (data.length < PAGE) break;
    from += PAGE;
  }
  return out;
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
    // Optional campaign key enables idempotent, resumable, background sending.
    // With a campaign_key set, already-sent numbers are skipped on retries and
    // the send runs in the background so the client never times out.
    const campaignKey = (body.campaign_key || '').toString().trim();
    const audiences: Audience[] = Array.isArray(body.audiences)
      ? body.audiences.filter((a: string) => VALID_AUDIENCES.includes(a as Audience))
      : [];

    if (!isTest && audiences.length === 0) {
      return new Response(JSON.stringify({ error: 'Select at least one audience' }), {
        status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }
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
      const raw: { user_id: string; phone: string }[] = [];
      for (const aud of audiences) {
        raw.push(...await fetchRoleUserPhones(admin, aud));
        if (aud === 'landlord') raw.push(...await fetchLandlordTablePhones(admin));
      }
      for (const r of raw) {
        if (!isValidPhone(r.phone)) continue;
        const intl = formatPhoneInternational(r.phone);
        if (!intl || phones.has(intl)) continue;
        phones.add(intl);
        recipients.push({ user_id: r.user_id, phone: intl });
      }
    }

    if (dryRun) {
      return new Response(JSON.stringify({ success: true, dry_run: true, recipient_count: recipients.length }), {
        status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // Honour SMS exceptions (block list)
    if (!isTest) {
      const { data: exRows } = await admin
        .from('sms_message_exceptions').select('phone')
        .in('message_type', ['all', 'partner_broadcast']);
      const blocked = new Set((exRows || []).map((r: any) => formatPhoneInternational(r.phone)));
      if (blocked.size > 0) {
        for (let i = recipients.length - 1; i >= 0; i--) {
          if (blocked.has(recipients[i].phone)) recipients.splice(i, 1);
        }
      }
    }

    // ---- Idempotent + background mode (campaign_key provided) ----
    if (campaignKey && !isTest) {
      // Record / refresh the campaign summary row (drives the CTO status page).
      await admin
        .from('sms_broadcast_campaigns')
        .upsert({
          campaign_key: campaignKey,
          message,
          audiences,
          total_recipients: recipients.length,
          status: 'running',
          last_run_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        }, { onConflict: 'campaign_key' })
        .then(() => {})
        .catch(() => {});
      // Increment run_count (each invocation is a send/retry pass).
      await admin.rpc('increment_broadcast_run', { p_campaign_key: campaignKey })
        .then(() => {})
        .catch(() => {});

      // Load phones already marked sent for this campaign and skip them.
      const alreadySent = new Set<string>();
      const PAGE = 1000;
      let from = 0;
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const { data, error } = await admin
          .from('sms_broadcast_log')
          .select('phone')
          .eq('campaign_key', campaignKey)
          .eq('status', 'sent')
          .range(from, from + PAGE - 1);
        if (error) break;
        if (!data || data.length === 0) break;
        for (const r of data) alreadySent.add(r.phone);
        if (data.length < PAGE) break;
        from += PAGE;
      }

      const pending = recipients.filter((r) => !alreadySent.has(r.phone));

      // Older runs accepted loose phone formats (for example +2560...). Those
      // rows cannot be flipped by a normalized retry because the unique key is
      // campaign_key + phone. Preserve the audit row, but stop counting stale
      // malformed/non-audience rows as retryable failures on the status page.
      const validCampaignPhones = new Set(recipients.map((r) => r.phone));
      const staleFailedIds: string[] = [];
      from = 0;
      while (true) {
        const { data, error } = await admin
          .from('sms_broadcast_log')
          .select('id, phone')
          .eq('campaign_key', campaignKey)
          .eq('status', 'failed')
          .range(from, from + PAGE - 1);
        if (error || !data || data.length === 0) break;
        for (const r of data) {
          if (!validCampaignPhones.has(r.phone)) {
            staleFailedIds.push(r.id);
          }
        }
        if (data.length < PAGE) break;
        from += PAGE;
      }
      for (let i = 0; i < staleFailedIds.length; i += 200) {
        await admin
          .from('sms_broadcast_log')
          .update({ status: 'invalid', reason: 'invalid_or_stale_phone' })
          .in('id', staleFailedIds.slice(i, i + 200))
          .then(() => {})
          .catch(() => {});
      }

      const process = async () => {
        const BATCH = 8;
        for (let i = 0; i < pending.length; i += BATCH) {
          const batch = pending.slice(i, i + BATCH);
          const results = await Promise.all(batch.map((r) => sendSMSWithRetries(r.phone, message)));
          const rows = batch.map((r, idx) => ({
            campaign_key: campaignKey,
            phone: r.phone,
            status: results[idx].accepted ? 'sent' : 'failed',
            provider: results[idx].provider ?? null,
            reason: results[idx].reason ?? null,
          }));
          // Upsert so retries flip failed -> sent and never duplicate.
          await admin
            .from('sms_broadcast_log')
            .upsert(rows, { onConflict: 'campaign_key,phone' })
            .then(() => {})
            .catch(() => {});
          // Also write to sms_delivery_log — the platform-wide send record every
          // cost/usage report reads from. sms_broadcast_log alone made every
          // audience broadcast invisible to Yoola spend reporting; this is
          // additive, not a replacement (campaign resumability still keys off
          // sms_broadcast_log's campaign_key+phone unique constraint).
          await admin
            .from('sms_delivery_log')
            .insert(batch.map((r, idx) => ({
              recipient_phone: r.phone,
              recipient_user_id: r.user_id,
              message,
              status: results[idx].accepted ? 'sent' : 'failed',
              provider: results[idx].provider ?? 'none',
              error: results[idx].accepted ? null : (results[idx].reason ?? null),
              reference_id: campaignKey,
              source: 'broadcast_audience',
            })))
            .then(() => {})
            .catch(() => {});
          await delay(500);
        }
        // Mark the campaign as complete once this pass drains its pending set.
        await admin
          .from('sms_broadcast_campaigns')
          .update({ status: 'complete', updated_at: new Date().toISOString() })
          .eq('campaign_key', campaignKey)
          .then(() => {})
          .catch(() => {});
      };

      // Nothing left to send — campaign is already fully delivered.
      if (pending.length === 0) {
        await admin
          .from('sms_broadcast_campaigns')
          .update({ status: 'complete', updated_at: new Date().toISOString() })
          .eq('campaign_key', campaignKey)
          .then(() => {})
          .catch(() => {});
      }

      // Run in the background so the client connection can close immediately
      // without aborting the send.
      // @ts-ignore EdgeRuntime is provided by the Supabase edge runtime.
      if (typeof EdgeRuntime !== 'undefined' && EdgeRuntime?.waitUntil) {
        // @ts-ignore
        EdgeRuntime.waitUntil(process());
      } else {
        process();
      }

      return new Response(JSON.stringify({
        success: true,
        started: true,
        campaign_key: campaignKey,
        total_recipients: recipients.length,
        already_sent: alreadySent.size,
        pending: pending.length,
      }), { status: 202, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    // ---- Legacy synchronous mode (test sends / small partner broadcasts) ----
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
      // This path previously left zero database trace of the send — neither
      // sms_broadcast_log (campaign-only) nor sms_delivery_log. Every attempt,
      // including test sends, now has a row so Yoola spend reporting is complete.
      await admin
        .from('sms_delivery_log')
        .insert(batch.map((r, idx) => ({
          recipient_phone: r.phone,
          recipient_user_id: r.user_id,
          message,
          status: results[idx].accepted ? 'sent' : 'failed',
          provider: results[idx].provider ?? 'none',
          error: results[idx].accepted ? null : (results[idx].reason ?? null),
          source: isTest ? 'broadcast_audience_test' : 'broadcast_audience',
        })))
        .then(() => {})
        .catch(() => {});
    }

    return new Response(JSON.stringify({
      success: true, sent, failed, total: recipients.length,
      sample_errors: Array.from(new Set(errors)).slice(0, 5),
    }), { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  } catch (e) {
    return new Response(JSON.stringify({ error: (e as Error).message }), {
      status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
