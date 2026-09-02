// Agent Ops Comprehensive Report — daily email at midnight EAT.
//
// Renders the exact same HTML the "Comprehensive Report" button produces
// (shared builder copied into ./_lib/report.ts) for the EAT calendar day that
// has just ended, and emails it via Mailgun.
//
// Invocation:
//   POST /agent-ops-comprehensive-daily-report
//   POST { "date": "YYYY-MM-DD" }              -> single-day window override
//   POST { "from": "...", "to": "...", "recipients": [...], "dry_run": true }

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.4';
import { buildAgentOpsComprehensiveReportHtml } from './_lib/report.ts';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const TZ = 'Africa/Kampala';
const DEFAULT_FROM = 'Welile Reports <reports@welile.com>';
const DEFAULT_RECIPIENTS = ['benjamin@welile.com', 'paphra.me@gmail.com'];

const eatToday = () => new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(new Date());
const shiftDays = (dateStr: string, days: number) => {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};

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

    let body: Record<string, unknown> = {};
    try { body = await req.json(); } catch { /* cron sends a bare body */ }

    // Runs at 00:00 EAT, so the day being reported is the one that just closed.
    const day = (body.date as string) || shiftDays(eatToday(), -1);
    const fromDate = (body.from as string) || day;
    const toDate = (body.to as string) || day;
    const recipients = Array.isArray(body.recipients) && body.recipients.length
      ? (body.recipients as string[]) : DEFAULT_RECIPIENTS;
    const dryRun = body.dry_run === true;

    const admin = createClient(supabaseUrl, serviceKey);

    const spanDays = Math.max(0, Math.round(
      (Date.parse(`${toDate}T00:00:00Z`) - Date.parse(`${fromDate}T00:00:00Z`)) / 86400000,
    ));
    const prevTo = shiftDays(fromDate, -1);
    const prevFrom = shiftDays(prevTo, -spanDays);

    const fetchReport = async (from: string, to: string) => {
      const { data, error } = await admin.rpc('get_agent_products_services_report', {
        p_date: to, p_from: from,
      });
      if (error) throw error;
      return data;
    };

    const [report, prev, population] = await Promise.all([
      fetchReport(fromDate, toDate),
      fetchReport(prevFrom, prevTo).catch(() => null),
      admin.rpc('get_agent_operational_population', { p_as_of: toDate, p_from: fromDate })
        .then((r) => (r.error ? null : r.data)).catch(() => null),
    ]);

    const html = buildAgentOpsComprehensiveReportHtml({
      report,
      prev,
      population,
      fromDate,
      toDate,
      periodLabel: fromDate === toDate ? 'Daily (previous day)' : 'Custom range',
      actor: 'Automated daily report',
    } as never);

    if (dryRun) {
      return new Response(JSON.stringify({ ok: true, dry_run: true, from: fromDate, to: toDate, html_length: html.length }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const subject = fromDate === toDate
      ? `Welile Agent Ops - Comprehensive Report (${toDate})`
      : `Welile Agent Ops - Comprehensive Report (${fromDate} to ${toDate})`;

    const form = new FormData();
    form.set('from', DEFAULT_FROM);
    recipients.forEach((r) => form.append('to', r));
    form.set('subject', subject);
    form.set('text', `${subject}\n\nOpen the HTML version of this email for the full report.`);
    form.set('html', html);
    form.set('o:tag', 'agent-ops-comprehensive-daily');

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
    console.error('agent-ops-comprehensive-daily-report failed', err);
    return new Response(JSON.stringify({ error: String((err as Error)?.message ?? err) }), {
      status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
