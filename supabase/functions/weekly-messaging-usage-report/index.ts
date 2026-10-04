// Weekly OTP + SMS Usage Report
// Emails a combined view of OTP usage by category and SMS spend/volume for
// the last 7 days (Wednesday-to-Wednesday, East Africa Time) via Mailgun.
//
// Invocation:
//   POST /weekly-messaging-usage-report                          -> last 7 days to default recipient
//   POST /weekly-messaging-usage-report { "from": "YYYY-MM-DD", "to": "YYYY-MM-DD", "recipients": [...] }
//
// Every figure comes from public.get_messaging_usage_weekly_bundle, which sums
// get_otp_usage_by_category(date) per day (OTP side) and re-derives SMS cost
// from sms_delivery_log using sms_segment_count/sms_cost_ugx (SMS side).

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.4';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const DEFAULT_FROM = 'Welile Reports <reports@welile.com>';
const DEFAULT_RECIPIENTS = ['joshwanda17@gmail.com'];
const TZ = 'Africa/Kampala';

const ugx = (n: unknown) => `UGX ${Math.round(Number(n) || 0).toLocaleString('en-UG')}`;
const num = (n: unknown) => (Number(n) || 0).toLocaleString('en-UG');

function eatToday(): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(new Date());
}
function shiftDays(dateStr: string, days: number): string {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
function dayLabel(dateStr: string) {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: 'UTC', weekday: 'short', day: 'numeric', month: 'short',
  }).format(new Date(`${String(dateStr).slice(0, 10)}T00:00:00Z`));
}

interface OtpCategoryRow {
  category: string; sent: number; send_failed: number; verify_success: number; verify_failed: number;
}
interface SmsProviderRow { provider: string; messages: number; segments: number; cost_ugx: number }
interface SmsSourceRow { source: string; messages: number; segments: number; cost_ugx: number }
interface SmsDailyRow { day: string; messages: number; segments: number; cost_ugx: number }
interface TenantEventRow { event_key: string; sent: number; failed: number; skipped: number; cost_ugx: number }
interface TenantSkipReasonRow { skip_reason: string; n: number }

function buildHtml(bundle: any, fromDate: string, toDate: string) {
  const otp = bundle.otp ?? {};
  const sms = bundle.sms ?? {};
  const otpTotals = otp.totals ?? {};
  const otpCats: OtpCategoryRow[] = otp.by_category ?? [];
  const smsTotals = sms.totals ?? {};
  const smsDaily: SmsDailyRow[] = sms.daily ?? [];
  const smsByProvider: SmsProviderRow[] = sms.by_provider ?? [];
  const smsBySource: SmsSourceRow[] = sms.by_source ?? [];
  const tenant = bundle.tenant_notifications ?? {};
  const tenantTotals = tenant.totals ?? {};
  const tenantByEvent: TenantEventRow[] = tenant.by_event ?? [];
  const tenantSkipReasons: TenantSkipReasonRow[] = tenant.skip_reasons ?? [];

  const th = 'style="text-align:left;padding:6px 8px;border-bottom:1px solid #ddd;font-size:11px;color:#555;text-transform:uppercase"';
  const td = 'style="padding:6px 8px;border-bottom:1px solid #f0f0f0;font-size:12px"';
  const tdR = 'style="padding:6px 8px;border-bottom:1px solid #f0f0f0;font-size:12px;text-align:right"';

  const kpi = (label: string, value: string, source: string) => `
    <td style="padding:8px;width:25%;vertical-align:top">
      <div style="border:1px solid #cfe9e5;border-radius:6px;padding:10px;background:#f7fdfc">
        <div style="font-size:10px;color:#5f7d79;text-transform:uppercase;letter-spacing:.4px">${label}</div>
        <div style="font-size:18px;font-weight:700;color:#134e4a;margin-top:3px">${value}</div>
        <div style="font-size:9px;color:#8b8b8b;margin-top:3px;font-family:monospace">${source}</div>
      </div>
    </td>`;

  const uncategorized = otpCats.find((c) => c.category === 'uncategorized');

  return `<!doctype html><html><body style="margin:0;background:#f6f6f8;font-family:Arial,Helvetica,sans-serif;color:#222">
<div style="max-width:1000px;margin:0 auto;background:#fff">
  <div style="background:#0f766e;color:#fff;padding:18px 22px">
    <div style="font-size:11px;letter-spacing:1px;opacity:.8">WELILE · OTP &amp; SMS USAGE</div>
    <div style="font-size:20px;font-weight:700;margin-top:4px">Weekly Messaging Usage Report</div>
    <div style="font-size:12px;opacity:.85;margin-top:4px">Window ${dayLabel(fromDate)} – ${dayLabel(toDate)} (East Africa Time) · queried directly against otp_usage_events, otp_login_audit, wallet_withdrawal_otp_*, landlord_payout_otp_*, sms_delivery_log</div>
  </div>

  <div style="padding:18px 22px">
    <h3 style="font-size:13px;text-transform:uppercase;letter-spacing:.5px;color:#0f766e;margin:0 0 8px">OTP usage by category</h3>
    <table width="100%" cellspacing="0" cellpadding="0"><tr>
      ${kpi('OTPs sent', num(otpTotals.sent), 'sum across all categories')}
      ${kpi('Send failures', num(otpTotals.send_failed), 'send_failed events')}
      ${kpi('Verified OK', num(otpTotals.verify_success), 'verify_success events')}
      ${kpi('Verify failures', num(otpTotals.verify_failed), 'verify_failed events')}
    </tr></table>

    <table width="100%" cellspacing="0" cellpadding="0" style="margin-top:10px">
      <tr><th ${th}>Category</th><th ${th}>Sent</th><th ${th}>Send failed</th><th ${th}>Verified OK</th><th ${th}>Verify failed</th></tr>
      ${otpCats.map((c) => `<tr><td ${td}>${c.category}</td>
        <td ${tdR}>${num(c.sent)}</td><td ${tdR}>${num(c.send_failed)}</td>
        <td ${tdR}>${num(c.verify_success)}</td><td ${tdR}>${num(c.verify_failed)}</td></tr>`).join('')}
      <tr style="background:#f7fdfc;font-weight:700"><td ${td}>Total</td>
        <td ${tdR}>${num(otpTotals.sent)}</td><td ${tdR}>${num(otpTotals.send_failed)}</td>
        <td ${tdR}>${num(otpTotals.verify_success)}</td><td ${tdR}>${num(otpTotals.verify_failed)}</td></tr>
    </table>
    ${uncategorized && (uncategorized.sent > 0 || uncategorized.verify_success > 0)
      ? `<p style="font-size:11px;color:#b91c1c;margin-top:6px">${num(uncategorized.sent + uncategorized.verify_success)} events landed in "uncategorized" this window — a call site is sending or verifying an OTP without a category. See docs/HANDOVER/82-otp-usage-by-category.md.</p>`
      : ''}

    <h3 style="font-size:13px;text-transform:uppercase;letter-spacing:.5px;color:#0f766e;margin:22px 0 4px">SMS spend &amp; volume</h3>
    <table width="100%" cellspacing="0" cellpadding="0"><tr>
      ${kpi('Messages attempted', num(smsTotals.messages), 'sms_delivery_log, status<>skipped')}
      ${kpi('Segments billed', num(smsTotals.segments), 'sms_segment_count(message)')}
      ${kpi('Total cost', ugx(smsTotals.cost_ugx), 'sms_cost_ugx(message, provider)')}
      ${kpi('Sent / failed', `${num(smsTotals.sent)} / ${num(smsTotals.failed)}`, 'status buckets')}
    </tr></table>

    <h3 style="font-size:13px;text-transform:uppercase;letter-spacing:.5px;color:#0f766e;margin:22px 0 4px">Per-day SMS volume &amp; cost</h3>
    <table width="100%" cellspacing="0" cellpadding="0">
      <tr><th ${th}>Day</th><th ${th}>Messages</th><th ${th}>Segments</th><th ${th}>Cost</th></tr>
      ${smsDaily.map((d) => `<tr><td ${td}>${dayLabel(d.day)}</td>
        <td ${tdR}>${num(d.messages)}</td><td ${tdR}>${num(d.segments)}</td><td ${tdR}>${ugx(d.cost_ugx)}</td></tr>`).join('')}
      <tr style="background:#f7fdfc;font-weight:700"><td ${td}>Total</td>
        <td ${tdR}>${num(smsTotals.messages)}</td><td ${tdR}>${num(smsTotals.segments)}</td><td ${tdR}>${ugx(smsTotals.cost_ugx)}</td></tr>
    </table>

    <h3 style="font-size:13px;text-transform:uppercase;letter-spacing:.5px;color:#0f766e;margin:22px 0 4px">By provider</h3>
    <table width="100%" cellspacing="0" cellpadding="0">
      <tr><th ${th}>Provider</th><th ${th}>Messages</th><th ${th}>Segments</th><th ${th}>Cost</th></tr>
      ${smsByProvider.map((p) => `<tr><td ${td}>${p.provider}</td>
        <td ${tdR}>${num(p.messages)}</td><td ${tdR}>${num(p.segments)}</td><td ${tdR}>${ugx(p.cost_ugx)}</td></tr>`).join('')}
    </table>

    <h3 style="font-size:13px;text-transform:uppercase;letter-spacing:.5px;color:#0f766e;margin:22px 0 4px">Top 15 sources by spend</h3>
    <table width="100%" cellspacing="0" cellpadding="0">
      <tr><th ${th}>Source</th><th ${th}>Messages</th><th ${th}>Segments</th><th ${th}>Cost</th></tr>
      ${smsBySource.map((s) => `<tr><td ${td}>${s.source}</td>
        <td ${tdR}>${num(s.messages)}</td><td ${tdR}>${num(s.segments)}</td><td ${tdR}>${ugx(s.cost_ugx)}</td></tr>`).join('')}
    </table>
    <p style="font-size:11px;color:#666">Cost counts every attempted send (a provider-accepted message that later failed handset delivery still consumed credit) and excludes governor/frequency-cap "skipped" rows. sms_delivery_log.cost (the provider's own figure) is not used — see docs/HANDOVER/53-sms-cost-report-and-unlogged-broadcast-gaps.md for why.</p>

    <h3 style="font-size:13px;text-transform:uppercase;letter-spacing:.5px;color:#0f766e;margin:22px 0 4px">Tenant notifications</h3>
    <table width="100%" cellspacing="0" cellpadding="0"><tr>
      ${kpi('Sent', num(tenantTotals.sent), 'tenant_notification_log.status=sent')}
      ${kpi('Failed', num(tenantTotals.failed), 'tenant_notification_log.status=failed')}
      ${kpi('Skipped (governor)', num(tenantTotals.skipped), 'status=skipped, e.g. daily/weekly caps')}
      ${kpi('Cost', ugx(tenantTotals.cost_ugx), 'joined via sms_log_id')}
    </tr></table>

    <table width="100%" cellspacing="0" cellpadding="0" style="margin-top:10px">
      <tr><th ${th}>Event</th><th ${th}>Sent</th><th ${th}>Failed</th><th ${th}>Skipped</th><th ${th}>Cost</th></tr>
      ${tenantByEvent.map((e) => `<tr><td ${td}>${e.event_key}</td>
        <td ${tdR}>${num(e.sent)}</td><td ${tdR}>${num(e.failed)}</td>
        <td ${tdR}>${num(e.skipped)}</td><td ${tdR}>${ugx(e.cost_ugx)}</td></tr>`).join('')}
      <tr style="background:#f7fdfc;font-weight:700"><td ${td}>Total</td>
        <td ${tdR}>${num(tenantTotals.sent)}</td><td ${tdR}>${num(tenantTotals.failed)}</td>
        <td ${tdR}>${num(tenantTotals.skipped)}</td><td ${tdR}>${ugx(tenantTotals.cost_ugx)}</td></tr>
    </table>
    ${tenantSkipReasons.length ? `<p style="font-size:11px;color:#666;margin-top:6px">Skip reasons: ${tenantSkipReasons.map((s) => `${s.skip_reason} (${num(s.n)})`).join(', ')} — these are the governor deliberately not sending (daily/weekly caps, already sent this episode), not failures.</p>` : ''}
    <p style="font-size:11px;color:#666">Source: <code>tenant_notification_log</code>, the catalogue behind <code>tenant-payment-notices</code> / <code>tenant-rent-limit-notices</code> / <code>tenant-relocation-notices</code> / <code>tenant-dashboard-invites</code> and related senders — a fuller breakdown than the generic SMS-by-source table above, which is capped to its top 15 by cost and has no skip visibility.</p>

    <p style="font-size:10px;color:#999;border-top:1px solid #eee;padding-top:10px;margin-top:18px">
      Welile · OTP &amp; SMS Usage · automated weekly report · every Wednesday 13:00 EAT to ${DEFAULT_RECIPIENTS.join(', ')} · all amounts UGX
    </p>
  </div>
</div></body></html>`;
}

function buildText(bundle: any, fromDate: string, toDate: string) {
  const otp = bundle.otp ?? {};
  const sms = bundle.sms ?? {};
  const tenant = bundle.tenant_notifications ?? {};
  const otpTotals = otp.totals ?? {};
  const smsTotals = sms.totals ?? {};
  const tenantTotals = tenant.totals ?? {};
  const otpCats: OtpCategoryRow[] = otp.by_category ?? [];
  const tenantByEvent: TenantEventRow[] = tenant.by_event ?? [];
  return [
    `WELILE - WEEKLY MESSAGING USAGE REPORT (${fromDate} to ${toDate}, EAT)`,
    '',
    `OTP: ${num(otpTotals.sent)} sent | ${num(otpTotals.send_failed)} send failed | ${num(otpTotals.verify_success)} verified | ${num(otpTotals.verify_failed)} verify failed`,
    ...otpCats.map((c) => `  ${c.category}: sent ${c.sent}, send_failed ${c.send_failed}, verified ${c.verify_success}, verify_failed ${c.verify_failed}`),
    '',
    `SMS: ${num(smsTotals.messages)} messages | ${num(smsTotals.segments)} segments | ${ugx(smsTotals.cost_ugx)} | sent ${num(smsTotals.sent)} / failed ${num(smsTotals.failed)}`,
    '',
    `TENANT NOTIFICATIONS: ${num(tenantTotals.sent)} sent | ${num(tenantTotals.failed)} failed | ${num(tenantTotals.skipped)} skipped (governor) | ${ugx(tenantTotals.cost_ugx)}`,
    ...tenantByEvent.map((e) => `  ${e.event_key}: sent ${e.sent}, failed ${e.failed}, skipped ${e.skipped}, ${ugx(e.cost_ugx)}`),
  ].join('\n');
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL');
    const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
    const mailgunApiKey = Deno.env.get('MAILGUN_API_KEY');
    const mailgunDomain = Deno.env.get('MAILGUN_DOMAIN');
    const mailgunBaseUrl = Deno.env.get('MAILGUN_API_BASE') || 'https://api.mailgun.net';
    if (!supabaseUrl || !serviceKey || !mailgunApiKey || !mailgunDomain) {
      return new Response(JSON.stringify({ error: 'Server not configured' }), {
        status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    let body: any = {};
    try { body = await req.json(); } catch { /* cron sends a bare body */ }

    const toDate: string = body.to || shiftDays(eatToday(), -1);
    const fromDate: string = body.from || shiftDays(toDate, -6);
    const recipients: string[] = Array.isArray(body.recipients) && body.recipients.length
      ? body.recipients : DEFAULT_RECIPIENTS;
    const dryRun = body.dry_run === true;

    const admin = createClient(supabaseUrl, serviceKey);
    const { data, error } = await admin.rpc('get_messaging_usage_weekly_bundle', {
      p_start: fromDate,
      p_end: toDate,
    });
    if (error) throw error;

    const bundle = data as any;
    const html = buildHtml(bundle, fromDate, toDate);
    const text = buildText(bundle, fromDate, toDate);

    if (dryRun) {
      return new Response(JSON.stringify({ ok: true, dry_run: true, from: fromDate, to: toDate, bundle }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const form = new FormData();
    form.set('from', DEFAULT_FROM);
    recipients.forEach((r) => form.append('to', r));
    form.set('subject', `Welile Messaging Usage - Weekly Report (${fromDate} to ${toDate})`);
    form.set('text', text);
    form.set('html', html);
    form.set('o:tag', 'messaging-usage-weekly');

    const mgRes = await fetch(`${mailgunBaseUrl}/v3/${mailgunDomain}/messages`, {
      method: 'POST',
      headers: { Authorization: 'Basic ' + btoa(`api:${mailgunApiKey}`) },
      body: form,
    });
    const mgText = await mgRes.text();
    if (!mgRes.ok) {
      console.error('Mailgun send failed', mgRes.status, mgText);
      return new Response(JSON.stringify({ error: 'Mailgun send failed', status: mgRes.status, details: mgText }), {
        status: 502, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    return new Response(JSON.stringify({ ok: true, from: fromDate, to: toDate, recipients }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  } catch (err) {
    console.error('weekly-messaging-usage-report failed', err);
    return new Response(JSON.stringify({ error: String((err as any)?.message ?? err) }), {
      status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
