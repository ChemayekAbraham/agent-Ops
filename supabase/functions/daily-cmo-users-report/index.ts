// Daily CMO Users Report
// Emails a total-users performance snapshot to CMO recipients.
// Scheduled daily at 23:59 EAT (20:59 UTC) via pg_cron.
//
// Invocation:
//   POST /daily-cmo-users-report               → yesterday's snapshot to default recipients
//   POST /daily-cmo-users-report body:
//     { "date": "YYYY-MM-DD", "recipients": ["a@x"] }

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.4';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const FROM = 'Kalyango Timothy <timothykalyango@gmail.com>';
const REPLY_TO = 'timothykalyango@gmail.com';
const SENDER_HEADER = 'reports@welile.com';
const DEFAULT_RECIPIENTS = ['benjamin@welile.com'];

function todayIsoEAT() {
  // EAT = UTC+3. Report snapshot at 23:59 EAT covers "today" in Kampala.
  const now = new Date();
  const eat = new Date(now.getTime() + 3 * 60 * 60 * 1000);
  return eat.toISOString().slice(0, 10);
}

function dayBoundariesEAT(dateStr: string) {
  // Kampala day → UTC boundaries (EAT is UTC+3, no DST)
  const start = new Date(`${dateStr}T00:00:00.000+03:00`);
  const end = new Date(`${dateStr}T23:59:59.999+03:00`);
  return { startIso: start.toISOString(), endIso: end.toISOString() };
}

function fmtNum(n: number | null | undefined) {
  return Number(n || 0).toLocaleString('en-UG');
}

async function countRows(
  supabase: ReturnType<typeof createClient>,
  table: string,
  build?: (q: any) => any,
): Promise<number> {
  let q: any = supabase.from(table).select('id', { count: 'exact', head: true });
  if (build) q = build(q);
  const { count, error } = await q;
  if (error) throw error;
  return count || 0;
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
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const body = req.method === 'POST' ? await req.json().catch(() => ({})) : {};
    const dateStr: string =
      typeof body?.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(body.date)
        ? body.date
        : todayIsoEAT();
    const recipients: string[] =
      Array.isArray(body?.recipients) && body.recipients.length > 0
        ? body.recipients.filter((r: unknown) => typeof r === 'string' && r.includes('@'))
        : DEFAULT_RECIPIENTS;

    const { startIso, endIso } = dayBoundariesEAT(dateStr);
    const supabase = createClient(supabaseUrl, serviceKey);

    // 7-day and 30-day windows (rolling, ending at endIso)
    const end = new Date(endIso);
    const sevenAgo = new Date(end.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString();
    const thirtyAgo = new Date(end.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString();

    // Core counts
    const [
      totalUsers,
      newToday,
      new7d,
      new30d,
      cumulativeAsOfEnd,
      totalTenants,
      totalAgents,
      totalLandlords,
      totalSupporters,
      totalMerchants,
    ] = await Promise.all([
      countRows(supabase, 'profiles'),
      countRows(supabase, 'profiles', (q) => q.gte('created_at', startIso).lte('created_at', endIso)),
      countRows(supabase, 'profiles', (q) => q.gte('created_at', sevenAgo).lte('created_at', endIso)),
      countRows(supabase, 'profiles', (q) => q.gte('created_at', thirtyAgo).lte('created_at', endIso)),
      countRows(supabase, 'profiles', (q) => q.lte('created_at', endIso)),
      countRows(supabase, 'user_roles', (q) => q.eq('role', 'tenant')),
      countRows(supabase, 'user_roles', (q) => q.eq('role', 'agent')),
      countRows(supabase, 'user_roles', (q) => q.eq('role', 'landlord')),
      countRows(supabase, 'user_roles', (q) => q.eq('role', 'supporter')),
      countRows(supabase, 'cashout_agents', (q) => q.eq('is_active', true)).catch(() => 0),
    ]);

    // Growth vs previous same-length window (yesterday for daily, prior 7d, prior 30d)
    const prevDayStart = new Date(new Date(startIso).getTime() - 24 * 60 * 60 * 1000).toISOString();
    const prevDayEnd = new Date(new Date(endIso).getTime() - 24 * 60 * 60 * 1000).toISOString();
    const prev7Start = new Date(end.getTime() - 14 * 24 * 60 * 60 * 1000).toISOString();
    const prev30Start = new Date(end.getTime() - 60 * 24 * 60 * 60 * 1000).toISOString();

    const [prevDay, prev7d, prev30d] = await Promise.all([
      countRows(supabase, 'profiles', (q) => q.gte('created_at', prevDayStart).lte('created_at', prevDayEnd)),
      countRows(supabase, 'profiles', (q) => q.gte('created_at', prev7Start).lt('created_at', sevenAgo)),
      countRows(supabase, 'profiles', (q) => q.gte('created_at', prev30Start).lt('created_at', thirtyAgo)),
    ]);

    const pct = (curr: number, prev: number) => {
      if (prev === 0) return curr === 0 ? '0.0%' : '+∞%';
      const d = ((curr - prev) / prev) * 100;
      return `${d >= 0 ? '+' : ''}${d.toFixed(1)}%`;
    };

    const nice = new Date(`${dateStr}T00:00:00+03:00`).toLocaleDateString('en-GB', {
      weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
    });

    const subject = `Welile CMO — Daily Users Report — ${dateStr} — ${fmtNum(newToday)} new (${pct(newToday, prevDay)})`;

    const text = [
      `WELILE — CMO DAILY USERS REPORT`,
      `${nice} (EAT)`,
      ``,
      `Prepared by: Kalyango Timothy — Chief Marketing Officer`,
      `Delivered to: ${recipients.join(', ')}`,
      ``,
      `================= HEADLINE =================`,
      `Total registered users (all-time): ${fmtNum(totalUsers)}`,
      `New users today:                   ${fmtNum(newToday)}   (${pct(newToday, prevDay)} vs yesterday)`,
      `New users last 7 days:             ${fmtNum(new7d)}     (${pct(new7d, prev7d)} vs prior 7d)`,
      `New users last 30 days:            ${fmtNum(new30d)}    (${pct(new30d, prev30d)} vs prior 30d)`,
      `Cumulative users as of ${dateStr}: ${fmtNum(cumulativeAsOfEnd)}`,
      ``,
      `================= ROLE MIX =================`,
      `Tenants:            ${fmtNum(totalTenants)}`,
      `Agents:             ${fmtNum(totalAgents)}`,
      `Landlords:          ${fmtNum(totalLandlords)}`,
      `Supporters:         ${fmtNum(totalSupporters)}`,
      `Merchant Agents:    ${fmtNum(totalMerchants)}`,
      ``,
      `--`,
      `This is an automated daily brief from the Welile platform.`,
      `Sender tagged: Kalyango Timothy <timothykalyango@gmail.com>`,
    ].join('\n');

    const html = `
      <div style="font-family:Inter,Arial,sans-serif;color:#0f172a;max-width:640px;margin:0 auto;padding:24px;background:#ffffff;">
        <div style="border-bottom:3px solid #0f172a;padding-bottom:16px;margin-bottom:20px;">
          <div style="font-size:11px;font-weight:700;letter-spacing:2px;color:#64748b;text-transform:uppercase;">Welile Daily Brief</div>
          <h1 style="margin:6px 0 4px;font-size:22px;font-weight:800;">CMO — Daily Users Report</h1>
          <div style="font-size:13px;color:#475569;">${nice} · East Africa Time</div>
        </div>

        <div style="background:#0f172a;color:#f8fafc;border-radius:12px;padding:20px;margin-bottom:20px;">
          <div style="font-size:11px;letter-spacing:2px;text-transform:uppercase;color:#94a3b8;font-weight:700;">Total Registered Users</div>
          <div style="font-size:36px;font-weight:800;margin-top:6px;">${fmtNum(totalUsers)}</div>
          <div style="font-size:12px;color:#cbd5e1;margin-top:4px;">
            +${fmtNum(newToday)} today (${pct(newToday, prevDay)} vs yesterday)
          </div>
        </div>

        <table role="presentation" style="width:100%;border-collapse:separate;border-spacing:8px 0;margin-bottom:20px;">
          <tr>
            ${[
              ['New Today', fmtNum(newToday), pct(newToday, prevDay)],
              ['Last 7 Days', fmtNum(new7d), pct(new7d, prev7d)],
              ['Last 30 Days', fmtNum(new30d), pct(new30d, prev30d)],
            ]
              .map(
                ([label, val, delta]) => `
              <td style="background:#f1f5f9;border-radius:10px;padding:14px;text-align:center;">
                <div style="font-size:10px;font-weight:700;letter-spacing:1.5px;text-transform:uppercase;color:#64748b;">${label}</div>
                <div style="font-size:22px;font-weight:800;color:#0f172a;margin-top:4px;">${val}</div>
                <div style="font-size:11px;color:${delta.startsWith('-') ? '#dc2626' : '#059669'};margin-top:2px;">${delta}</div>
              </td>`,
              )
              .join('')}
          </tr>
        </table>

        <h2 style="font-size:14px;font-weight:800;text-transform:uppercase;letter-spacing:1.5px;color:#334155;margin:20px 0 10px;">Role Mix</h2>
        <table role="presentation" style="width:100%;border-collapse:collapse;font-size:14px;">
          ${[
            ['Tenants', totalTenants],
            ['Agents', totalAgents],
            ['Landlords', totalLandlords],
            ['Supporters', totalSupporters],
            ['Merchant Agents', totalMerchants],
          ]
            .map(
              ([label, val]) => `
            <tr>
              <td style="padding:8px 0;border-bottom:1px solid #e2e8f0;color:#475569;">${label}</td>
              <td style="padding:8px 0;border-bottom:1px solid #e2e8f0;text-align:right;font-weight:700;color:#0f172a;">${fmtNum(val as number)}</td>
            </tr>`,
            )
            .join('')}
        </table>

        <div style="margin-top:24px;padding-top:16px;border-top:1px solid #e2e8f0;font-size:11px;color:#94a3b8;line-height:1.6;">
          Prepared by <b style="color:#334155;">Kalyango Timothy</b> — Chief Marketing Officer,
          Welile Technologies Limited. Automated brief generated at 23:59 EAT.
        </div>
      </div>
    `;

    // Send via Mailgun
    const form = new URLSearchParams();
    form.append('from', FROM);
    for (const r of recipients) form.append('to', r);
    form.append('h:Reply-To', REPLY_TO);
    form.append('h:Sender', SENDER_HEADER);
    form.append('subject', subject);
    form.append('text', text);
    form.append('html', html);

    const auth = btoa(`api:${mailgunApiKey}`);
    const mgRes = await fetch(`${mailgunBaseUrl}/v3/${mailgunDomain}/messages`, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${auth}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: form.toString(),
    });

    if (!mgRes.ok) {
      const errBody = await mgRes.text();
      console.error(`[daily-cmo-users-report] Mailgun ${mgRes.status}: ${errBody}`);
      return new Response(
        JSON.stringify({ error: 'mailgun_failed', status: mgRes.status, details: errBody }),
        { status: 502, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      );
    }

    return new Response(
      JSON.stringify({
        ok: true,
        date: dateStr,
        recipients,
        metrics: {
          totalUsers,
          newToday,
          new7d,
          new30d,
          totalTenants,
          totalAgents,
          totalLandlords,
          totalSupporters,
          totalMerchants,
        },
      }),
      { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    );
  } catch (e) {
    console.error('[daily-cmo-users-report] error', e);
    return new Response(JSON.stringify({ error: (e as Error).message }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});