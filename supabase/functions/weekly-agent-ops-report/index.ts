// Weekly Agent Ops Report
// Emails the consolidated Agent Operations report for the last 7 days
// (Wednesday-to-Wednesday window in East Africa Time) via Mailgun.
//
// Invocation:
//   POST /weekly-agent-ops-report                          -> last 7 days to default recipient
//   POST /weekly-agent-ops-report { "from": "YYYY-MM-DD", "to": "YYYY-MM-DD", "recipients": [...] }
//
// Every figure comes from public.ops_agent_ops_weekly_bundle, which reads the
// same tables useAgentOpsReportData reads for its 30-day pull:
// agent_collections, wallet_deposits, agent_advance_requests, rent_requests.

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

interface DailyRow {
  day: string;
  collections: number; volume: number; active_agents: number; tenants_paid: number;
  deposits: number; deposits_amount: number;
  advances_raised: number; advances_principal: number; advances_disbursed: number;
  advances_pending_now: number;
}

const sum = (rows: DailyRow[], key: keyof DailyRow) =>
  rows.reduce((a, r) => a + (Number(r[key]) || 0), 0);

function buildHtml(bundle: any, fromDate: string, toDate: string) {
  const rows: DailyRow[] = bundle.daily ?? [];
  const win = bundle.window ?? {};
  const prev = bundle.previous ?? {};
  const tops: any[] = bundle.top_agents ?? [];
  const methods: any[] = bundle.methods ?? [];
  const statuses: any[] = bundle.advance_statuses ?? [];
  const ctx = bundle.context ?? {};
  const t = (k: keyof DailyRow) => sum(rows, k);

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

  const firstPending = Number(rows[0]?.advances_pending_now) || 0;
  const lastPending = Number(rows[rows.length - 1]?.advances_pending_now) || 0;
  const avg = t('collections') > 0 ? t('volume') / t('collections') : 0;
  const silent = Math.max((Number(ctx.agents_with_live_rents) || 0) - (Number(win.agents) || 0), 0);

  return `<!doctype html><html><body style="margin:0;background:#f6f6f8;font-family:Arial,Helvetica,sans-serif;color:#222">
<div style="max-width:1000px;margin:0 auto;background:#fff">
  <div style="background:#0f766e;color:#fff;padding:18px 22px">
    <div style="font-size:11px;letter-spacing:1px;opacity:.8">WELILE · AGENT OPERATIONS</div>
    <div style="font-size:20px;font-weight:700;margin-top:4px">Consolidated Weekly Report</div>
    <div style="font-size:12px;opacity:.85;margin-top:4px">Window ${dayLabel(fromDate)} – ${dayLabel(toDate)} (East Africa Time) · queried directly against agent_collections, wallet_deposits, agent_advance_requests</div>
  </div>

  <div style="padding:18px 22px">
    <h3 style="font-size:13px;text-transform:uppercase;letter-spacing:.5px;color:#0f766e;margin:0 0 8px">Week in one paragraph</h3>
    <p style="font-size:13px;line-height:1.6;margin:0">
      Agents recorded <b>${num(win.collections)} rent collections worth ${ugx(win.volume)}</b>
      (<code>agent_collections.created_at / .amount</code>), reaching <b>${num(win.tenants)} distinct tenants</b>
      through <b>${num(win.agents)} active agents</b>. The preceding equal-length window was
      ${num(prev.collections)} collections / ${ugx(prev.volume)} / ${num(prev.agents)} active agents.
      Average collection size was ${ugx(avg)}.
      <b>${num(ctx.agents_with_live_rents)} agents hold at least one funded or repaying rent request</b>
      (<code>rent_requests.agent_id</code>), so ${num(silent)} agents with live exposure collected nothing in the window.
      Advances: <b>${num(t('advances_raised'))} requests raised for ${ugx(t('advances_principal'))}</b>
      (<code>agent_advance_requests.created_at</code>) and <b>${num(t('advances_disbursed'))} disbursed by the CFO</b>
      (<code>cfo_paid_at</code>). Wallet deposits in the window: <b>${num(t('deposits'))} · ${ugx(t('deposits_amount'))}</b>
      (<code>wallet_deposits.created_at</code>).
    </p>

    <h3 style="font-size:13px;text-transform:uppercase;letter-spacing:.5px;color:#0f766e;margin:20px 0 4px">Week totals</h3>
    <table width="100%" cellspacing="0" cellpadding="0"><tr>
      ${kpi('Collections recorded', num(win.collections), 'agent_collections.created_at')}
      ${kpi('Collection volume', ugx(win.volume), 'agent_collections.amount')}
      ${kpi('Active agents (>=1 collection)', num(win.agents), 'distinct agent_collections.agent_id')}
      ${kpi('Distinct tenants collected from', num(win.tenants), 'distinct agent_collections.tenant_id')}
    </tr><tr>
      ${kpi('Avg collection size', ugx(avg), 'agent_collections')}
      ${kpi('Wallet deposits in window', `${num(t('deposits'))} · ${ugx(t('deposits_amount'))}`, 'wallet_deposits.created_at')}
      ${kpi('Advance requests raised', `${num(t('advances_raised'))} · ${ugx(t('advances_principal'))}`, 'agent_advance_requests.created_at')}
      ${kpi('Advances disbursed by CFO', num(t('advances_disbursed')), 'agent_advance_requests.cfo_paid_at')}
    </tr></table>

    <h3 style="font-size:13px;text-transform:uppercase;letter-spacing:.5px;color:#0f766e;margin:22px 0 4px">Per-day breakdown (EAT day boundaries)</h3>
    <table width="100%" cellspacing="0" cellpadding="0">
      <tr><th ${th}>Day</th><th ${th}>Collections</th><th ${th}>Volume</th><th ${th}>Active agents</th>
        <th ${th}>Tenants paid</th><th ${th}>Wallet deposits</th><th ${th}>Advances raised</th>
        <th ${th}>Advance principal</th><th ${th}>Advances disbursed</th></tr>
      ${rows.map(r => `<tr><td ${td}>${dayLabel(r.day)}</td>
        <td ${tdR}>${num(r.collections)}</td><td ${tdR}>${ugx(r.volume)}</td>
        <td ${tdR}>${num(r.active_agents)}</td><td ${tdR}>${num(r.tenants_paid)}</td>
        <td ${tdR}>${num(r.deposits)}</td><td ${tdR}>${num(r.advances_raised)}</td>
        <td ${tdR}>${ugx(r.advances_principal)}</td><td ${tdR}>${num(r.advances_disbursed)}</td></tr>`).join('')}
      <tr style="background:#f7fdfc;font-weight:700"><td ${td}>Total</td>
        <td ${tdR}>${num(t('collections'))}</td><td ${tdR}>${ugx(t('volume'))}</td>
        <td ${tdR}>${num(win.agents)} uniq</td><td ${tdR}>${num(win.tenants)} uniq</td>
        <td ${tdR}>${num(t('deposits'))}</td><td ${tdR}>${num(t('advances_raised'))}</td>
        <td ${tdR}>${ugx(t('advances_principal'))}</td><td ${tdR}>${num(t('advances_disbursed'))}</td></tr>
    </table>
    <p style="font-size:11px;color:#666">Per-day agent and tenant counts are distinct inside that day; the total row is distinct across the whole window, so day figures do not sum to it.</p>

    <h3 style="font-size:13px;text-transform:uppercase;letter-spacing:.5px;color:#0f766e;margin:22px 0 4px">Top agents by collected volume (window)</h3>
    <table width="100%" cellspacing="0" cellpadding="0">
      <tr><th ${th}>Agent</th><th ${th}>Phone</th><th ${th}>Collections</th><th ${th}>Volume</th><th ${th}>Tenants</th><th ${th}>Days active</th></tr>
      ${tops.map(a => `<tr><td ${td}>${a.agent}</td><td ${td}>${a.phone ?? '—'}</td>
        <td ${tdR}>${num(a.collections)}</td><td ${tdR}>${ugx(a.volume)}</td>
        <td ${tdR}>${num(a.tenants)}</td><td ${tdR}>${num(a.days_active)}/${rows.length}</td></tr>`).join('')}
    </table>
    <p style="font-size:11px;color:#666">Source: <code>agent_collections</code> joined to <code>profiles</code>. Top 15 by volume.</p>

    <h3 style="font-size:13px;text-transform:uppercase;letter-spacing:.5px;color:#0f766e;margin:22px 0 4px">Collection method mix (window)</h3>
    <table width="100%" cellspacing="0" cellpadding="0">
      <tr><th ${th}>Method</th><th ${th}>Collections</th><th ${th}>Volume</th></tr>
      ${methods.map(m => `<tr><td ${td}>${m.method}</td><td ${tdR}>${num(m.n)}</td><td ${tdR}>${ugx(m.amount)}</td></tr>`).join('')}
    </table>
    <p style="font-size:11px;color:#666">Source: <code>agent_collections.payment_method</code>.</p>

    <h3 style="font-size:13px;text-transform:uppercase;letter-spacing:.5px;color:#0f766e;margin:22px 0 4px">Advance requests raised in window, by status now</h3>
    <table width="100%" cellspacing="0" cellpadding="0">
      <tr><th ${th}>Status</th><th ${th}>Requests</th><th ${th}>Principal</th></tr>
      ${statuses.map(s => `<tr><td ${td}>${s.status}</td><td ${tdR}>${num(s.n)}</td><td ${tdR}>${ugx(s.principal)}</td></tr>`).join('')}
      <tr style="background:#f7fdfc;font-weight:700"><td ${td}>Total</td>
        <td ${tdR}>${num(t('advances_raised'))}</td><td ${tdR}>${ugx(t('advances_principal'))}</td></tr>
    </table>

    <h3 style="font-size:13px;text-transform:uppercase;letter-spacing:.5px;color:#0f766e;margin:22px 0 4px">Advance backlog</h3>
    <table width="100%" cellspacing="0" cellpadding="0">
      <tr><th ${th}>Day (close, EAT)</th><th ${th}>Requests created on/before close that are still pending</th></tr>
      ${rows.map(r => `<tr><td ${td}>${dayLabel(r.day)}</td><td ${tdR}>${num(r.advances_pending_now)}</td></tr>`).join('')}
    </table>
    <div style="margin-top:10px;border:1px solid #f2c8c8;background:#fdf6f6;border-radius:6px;padding:10px;font-size:12px;line-height:1.6">
      <b>Backlog flag</b><br>
      Pending advance requests: ${num(firstPending)} → ${num(lastPending)}
      ${lastPending > firstPending
        ? `<b style="color:#b91c1c">(rising +${num(lastPending - firstPending)})</b>`
        : '(not rising)'}<br>
      <span style="color:#666">This is a snapshot of current status, not a historical status replay — <code>agent_advance_requests</code> keeps no status-history table, so an exact end-of-day pending figure for earlier days cannot be reconstructed live.</span>
    </div>

    <h3 style="font-size:13px;text-transform:uppercase;letter-spacing:.5px;color:#0f766e;margin:22px 0 4px">What could not be pulled live</h3>
    <ol style="font-size:12px;line-height:1.6;color:#333;padding-left:18px">
      <li><code>wallet_deposits</code> is a dormant table — ${num(ctx.wallet_deposits_total_rows)} rows in total, newest ${ctx.wallet_deposits_latest ? String(ctx.wallet_deposits_latest).slice(0, 10) : 'n/a'}. A zero in the window is a real query result, not a filter error, but the table is no longer the live deposit path.</li>
      <li><b>Agent Ops Pipeline Hub cannot be date-filtered without a code change.</b> <code>AgentOpsPipelineHub.tsx</code> reads <code>rent_requests</code> with <code>status not in (funded, rejected, cancelled)</code> and a hard 200-row cap — a current-state queue view with no window, so nothing from it is reported here.</li>
      <li><b>Agent Rent Capacity is not window-scoped.</b> <code>AgentRentCapacityPanel.tsx</code> uses all currently active rent requests, a fixed rolling 7-day <code>repayments</code> response rate, and today/yesterday eligibility via <code>get_agent_daily_eligibility</code>. For context only (as-at now, not the window): ${num(ctx.agents_with_live_rents)} agents hold live funded/repaying rent requests and ${num(ctx.active_advances)} agent advances are active for ${ugx(ctx.active_advances_principal)}.</li>
      <li>The existing COO → Reports → Agent Ops page is still hardcoded to a 30-day window; none of the figures above come from it.</li>
    </ol>

    <p style="font-size:10px;color:#999;border-top:1px solid #eee;padding-top:10px;margin-top:18px">
      Welile · Agent Operations · automated weekly report · every Wednesday 13:00 EAT to ${DEFAULT_RECIPIENTS.join(', ')} · all amounts UGX
    </p>
  </div>
</div></body></html>`;
}

function buildText(bundle: any, fromDate: string, toDate: string) {
  const rows: DailyRow[] = bundle.daily ?? [];
  const win = bundle.window ?? {};
  const prev = bundle.previous ?? {};
  const t = (k: keyof DailyRow) => sum(rows, k);
  return [
    `WELILE - AGENT OPS WEEKLY REPORT (${fromDate} to ${toDate}, EAT)`,
    '',
    `Collections: ${num(win.collections)} | Volume: ${ugx(win.volume)} | Active agents: ${num(win.agents)} | Tenants: ${num(win.tenants)}`,
    `Previous equal window: ${num(prev.collections)} collections / ${ugx(prev.volume)} / ${num(prev.agents)} agents`,
    `Wallet deposits: ${num(t('deposits'))} (${ugx(t('deposits_amount'))})`,
    `Advances raised: ${num(t('advances_raised'))} (${ugx(t('advances_principal'))}) | Disbursed: ${num(t('advances_disbursed'))}`,
    '',
    'PER DAY (day | collections | volume | agents | tenants | advances raised | advances disbursed)',
    ...rows.map(r => `${String(r.day).slice(0, 10)} | ${r.collections} | ${ugx(r.volume)} | ${r.active_agents} | ${r.tenants_paid} | ${r.advances_raised} | ${r.advances_disbursed}`),
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

    const toDate: string = body.to || eatToday();
    const fromDate: string = body.from || shiftDays(toDate, -7);
    const recipients: string[] = Array.isArray(body.recipients) && body.recipients.length
      ? body.recipients : DEFAULT_RECIPIENTS;
    const dryRun = body.dry_run === true;

    const admin = createClient(supabaseUrl, serviceKey);
    const { data, error } = await admin.rpc('ops_agent_ops_weekly_bundle', {
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
    form.set('subject', `Welile Agent Ops - Weekly Report (${fromDate} to ${toDate})`);
    form.set('text', text);
    form.set('html', html);
    form.set('o:tag', 'agent-ops-weekly');

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
    console.error('weekly-agent-ops-report failed', err);
    return new Response(JSON.stringify({ error: String((err as any)?.message ?? err) }), {
      status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
