// Weekly Tenant Ops Report
// Emails the consolidated Tenant Operations report for the trailing 7 days
// (Wednesday-to-Wednesday, East Africa Time) via Mailgun.
//
//   POST /weekly-tenant-ops-report                       -> last 7 days, default recipient
//   POST /weekly-tenant-ops-report { from, to, recipients, dry_run }
//
// Every figure comes from public.ops_tenant_ops_weekly_bundle, which reads the
// same base tables the Tenant Ops Extract Center reads: rent_requests and
// agent_collections (joined to profiles for agent capacity).

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
const pct = (a: unknown, b: unknown) => {
  const d = Number(b) || 0;
  if (!d) return '—';
  return `${(((Number(a) || 0) / d) * 100).toFixed(1)}%`;
};

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

interface DailyRow {
  day: string; applied: number; tops_approved: number;
  funded_plans: number; funded_amount: number;
  collected: number; txns: number; expected_daily: number; active_plans: number;
}

const sum = (rows: DailyRow[], key: keyof DailyRow) =>
  rows.reduce((a, r) => a + (Number(r[key]) || 0), 0);

function buildHtml(bundle: any, fromDate: string, toDate: string) {
  const rows: DailyRow[] = bundle.daily ?? [];
  const win = bundle.window ?? {};
  const missed = bundle.missed ?? {};
  const pipe = bundle.pipeline ?? {};
  const lifecycle: any[] = pipe.lifecycle ?? [];
  const capacity: any[] = bundle.capacity ?? [];
  const t = (k: keyof DailyRow) => sum(rows, k);

  const th = 'style="text-align:left;padding:6px 8px;border-bottom:1px solid #ddd;font-size:11px;color:#555;text-transform:uppercase"';
  const td = 'style="padding:6px 8px;border-bottom:1px solid #f0f0f0;font-size:12px"';
  const tdR = 'style="padding:6px 8px;border-bottom:1px solid #f0f0f0;font-size:12px;text-align:right"';

  const kpi = (label: string, value: string, source: string) => `
    <td style="padding:8px;width:25%;vertical-align:top">
      <div style="border:1px solid #d8dcf0;border-radius:6px;padding:10px;background:#f8f9ff">
        <div style="font-size:10px;color:#5a5f7d;text-transform:uppercase;letter-spacing:.4px">${label}</div>
        <div style="font-size:18px;font-weight:700;color:#1e2a78;margin-top:3px">${value}</div>
        <div style="font-size:9px;color:#8b8b8b;margin-top:3px;font-family:monospace">${source}</div>
      </div>
    </td>`;

  const shortDays = rows.filter(r => (Number(r.collected) || 0) < (Number(r.expected_daily) || 0));

  return `<!doctype html><html><body style="margin:0;background:#f6f6f8;font-family:Arial,Helvetica,sans-serif;color:#222">
<div style="max-width:1000px;margin:0 auto;background:#fff">
  <div style="background:#1e2a78;color:#fff;padding:18px 22px">
    <div style="font-size:11px;letter-spacing:1px;opacity:.8">WELILE · TENANT OPERATIONS</div>
    <div style="font-size:20px;font-weight:700;margin-top:4px">Consolidated Weekly Report</div>
    <div style="font-size:12px;opacity:.85;margin-top:4px">Window ${dayLabel(fromDate)} – ${dayLabel(toDate)} (East Africa Time) · source <code>ops_tenant_ops_weekly_bundle</code> over rent_requests + agent_collections</div>
  </div>

  <div style="padding:18px 22px">
    <h3 style="font-size:13px;text-transform:uppercase;letter-spacing:.5px;color:#1e2a78;margin:0 0 8px">Week in one paragraph</h3>
    <p style="font-size:13px;line-height:1.6;margin:0">
      <b>${num(win.applied)} rent plans were applied for</b> (<code>rent_requests.created_at</code>),
      <b>${num(win.tops_approved)} cleared Tenant Ops</b> (<code>tenant_ops_reviewed_at</code>) and
      <b>${num(win.funded_plans)} were funded for ${ugx(win.funded_amount)}</b> (<code>funded_at / rent_amount</code>).
      Collections in the window: <b>${ugx(win.collected)} across ${num(win.txns)} transactions from ${num(win.tenants_paid)} tenants</b>
      (<code>agent_collections</code>). The active book carries <b>${num(missed.active_plans)} funded/repaying plans</b>
      with <b>${num(missed.missed_days_total)} missed days</b> outstanding —
      ${num(missed.critical)} critical (≥5 missed), ${num(missed.warning)} warning, ${num(missed.on_track)} on track.
      Collected fell below expected on <b>${num(shortDays.length)} of ${num(rows.length)} days</b>.
      Open receivables ${ugx(pipe.receivables)}; landlord payables awaiting a payout reference ${ugx(pipe.landlord_payables)}.
    </p>

    <h3 style="font-size:13px;text-transform:uppercase;letter-spacing:.5px;color:#1e2a78;margin:20px 0 4px">Week totals</h3>
    <table width="100%" cellspacing="0" cellpadding="0"><tr>
      ${kpi('Applied', num(win.applied), 'rent_requests.created_at')}
      ${kpi('Tenant Ops approved', num(win.tops_approved), 'tenant_ops_reviewed_at')}
      ${kpi('Funded plans', `${num(win.funded_plans)} · ${ugx(win.funded_amount)}`, 'rent_requests.funded_at')}
      ${kpi('Collected', `${ugx(win.collected)} · ${num(win.txns)} txns`, 'agent_collections.amount')}
    </tr><tr>
      ${kpi('Expected (sum of daily targets)', ugx(t('expected_daily')), 'rent_requests.daily_repayment')}
      ${kpi('Collection rate vs expected', pct(win.collected, t('expected_daily')), 'derived')}
      ${kpi('Missed days outstanding', num(missed.missed_days_total), 'derived from rent_requests')}
      ${kpi('Critical plans (≥5 missed)', num(missed.critical), 'derived from rent_requests')}
    </tr></table>

    <h3 style="font-size:13px;text-transform:uppercase;letter-spacing:.5px;color:#1e2a78;margin:22px 0 4px">Per-day breakdown (EAT day boundaries)</h3>
    <table width="100%" cellspacing="0" cellpadding="0">
      <tr><th ${th}>Day</th><th ${th}>Applied</th><th ${th}>TOps approved</th><th ${th}>Funded plans</th>
        <th ${th}>Funded UGX</th><th ${th}>Collected UGX</th><th ${th}>Txns</th>
        <th ${th}>Expected daily</th><th ${th}>Active plans</th><th ${th}>Coll. vs exp.</th></tr>
      ${rows.map(r => {
        const short = (Number(r.collected) || 0) < (Number(r.expected_daily) || 0);
        const flag = short ? ' style="background:#fff5f5"' : '';
        return `<tr${flag}><td ${td}>${dayLabel(r.day)}${short ? ' <span style="color:#c0392b;font-size:10px">▼ short</span>' : ''}</td>
        <td ${tdR}>${num(r.applied)}</td><td ${tdR}>${num(r.tops_approved)}</td>
        <td ${tdR}>${num(r.funded_plans)}</td><td ${tdR}>${ugx(r.funded_amount)}</td>
        <td ${tdR}>${ugx(r.collected)}</td><td ${tdR}>${num(r.txns)}</td>
        <td ${tdR}>${ugx(r.expected_daily)}</td><td ${tdR}>${num(r.active_plans)}</td>
        <td ${tdR}>${pct(r.collected, r.expected_daily)}</td></tr>`;
      }).join('')}
      <tr style="background:#f8f9ff;font-weight:700"><td ${td}>Total</td>
        <td ${tdR}>${num(t('applied'))}</td><td ${tdR}>${num(t('tops_approved'))}</td>
        <td ${tdR}>${num(t('funded_plans'))}</td><td ${tdR}>${ugx(t('funded_amount'))}</td>
        <td ${tdR}>${ugx(t('collected'))}</td><td ${tdR}>${num(t('txns'))}</td>
        <td ${tdR}>${ugx(t('expected_daily'))}</td><td ${tdR}>—</td>
        <td ${tdR}>${pct(t('collected'), t('expected_daily'))}</td></tr>
    </table>
    <p style="font-size:11px;color:#666">Rows shaded red are days where collected &lt; expected. Active-plan counts are point-in-time per day, so they do not sum.</p>

    <h3 style="font-size:13px;text-transform:uppercase;letter-spacing:.5px;color:#1e2a78;margin:22px 0 4px">Pipeline status (all-time lifecycle)</h3>
    <table width="100%" cellspacing="0" cellpadding="0">
      <tr><th ${th}>Status</th><th ${th}>Plans</th><th ${th}>Rent value</th></tr>
      ${lifecycle.map(s => `<tr><td ${td}>${s.status}</td><td ${tdR}>${num(s.n)}</td><td ${tdR}>${ugx(s.amount)}</td></tr>`).join('')}
    </table>
    <p style="font-size:11px;color:#666">Source: <code>rent_requests.status</code>. Receivables ${ugx(pipe.receivables)} = total_repayment − amount_repaid on funded/disbursed/repaying plans. Landlord payables ${ugx(pipe.landlord_payables)} = funded/disbursed plans with no <code>payout_transaction_reference</code>.</p>

    <h3 style="font-size:13px;text-transform:uppercase;letter-spacing:.5px;color:#1e2a78;margin:22px 0 4px">Agent rent capacity (top 20 by daily target)</h3>
    <table width="100%" cellspacing="0" cellpadding="0">
      <tr><th ${th}>Agent</th><th ${th}>Phone</th><th ${th}>Active plans</th><th ${th}>Expected daily</th><th ${th}>Collected (window)</th><th ${th}>Txns</th></tr>
      ${capacity.map(a => `<tr><td ${td}>${a.agent}</td><td ${td}>${a.phone ?? '—'}</td>
        <td ${tdR}>${num(a.active_plans)}</td><td ${tdR}>${ugx(a.expected_daily)}</td>
        <td ${tdR}>${ugx(a.collected)}</td><td ${tdR}>${num(a.txns)}</td></tr>`).join('')}
    </table>
    <p style="font-size:11px;color:#666">Source: <code>rent_requests.daily_repayment</code> grouped by <code>agent_id</code>, joined to window <code>agent_collections</code>.</p>

    <p style="font-size:11px;color:#888;margin-top:20px">Automated: every Wednesday 13:00 EAT · function <code>weekly-tenant-ops-report</code>. Figures not derivable from these tables are omitted, never estimated.</p>
  </div>
</div></body></html>`;
}

function buildText(bundle: any, fromDate: string, toDate: string) {
  const rows: DailyRow[] = bundle.daily ?? [];
  const win = bundle.window ?? {};
  const missed = bundle.missed ?? {};
  const lines = [
    `WELILE TENANT OPS - WEEKLY REPORT ${fromDate} to ${toDate} (EAT)`,
    '',
    `Applied: ${num(win.applied)} (rent_requests.created_at)`,
    `Tenant Ops approved: ${num(win.tops_approved)} (tenant_ops_reviewed_at)`,
    `Funded: ${num(win.funded_plans)} plans / ${ugx(win.funded_amount)} (funded_at)`,
    `Collected: ${ugx(win.collected)} across ${num(win.txns)} txns (agent_collections)`,
    `Expected in window: ${ugx(sum(rows, 'expected_daily'))} (daily_repayment)`,
    `Active plans: ${num(missed.active_plans)} · missed days ${num(missed.missed_days_total)} · critical ${num(missed.critical)}`,
    '',
    'Per-day (day | applied | approved | funded | collected | expected):',
    ...rows.map(r => ` ${String(r.day).slice(0, 10)} | ${num(r.applied)} | ${num(r.tops_approved)} | ${num(r.funded_plans)} | ${ugx(r.collected)} | ${ugx(r.expected_daily)}${(Number(r.collected) || 0) < (Number(r.expected_daily) || 0) ? '  << SHORT' : ''}`),
  ];
  return lines.join('\n');
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders });

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

    const toDate: string = body.to || eatToday();
    const fromDate: string = body.from || shiftDays(toDate, -7);
    const recipients: string[] = Array.isArray(body.recipients) && body.recipients.length
      ? body.recipients : DEFAULT_RECIPIENTS;
    const dryRun = body.dry_run === true;

    const admin = createClient(supabaseUrl, serviceKey);
    const { data, error } = await admin.rpc('ops_tenant_ops_weekly_bundle', {
      p_from: new Date(`${fromDate}T00:00:00+03:00`).toISOString(),
      p_to: new Date(`${toDate}T23:59:59.999+03:00`).toISOString(),
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
    recipients.forEach(r => form.append('to', r));
    form.set('subject', `Welile Tenant Ops - Weekly Report (${fromDate} to ${toDate})`);
    form.set('text', text);
    form.set('html', html);
    form.set('o:tag', 'tenant-ops-weekly');

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
    console.error('weekly-tenant-ops-report failed', err);
    return new Response(JSON.stringify({ error: String((err as any)?.message ?? err) }), {
      status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
