// Weekly Landlord Ops Report
// Emails the consolidated Landlord Operations report for the last 7 days
// (Wednesday-to-Wednesday window in East Africa Time) via Mailgun.
//
// Invocation:
//   POST /weekly-landlord-ops-report                          -> last 7 days to default recipient
//   POST /weekly-landlord-ops-report { "from": "YYYY-MM-DD", "to": "YYYY-MM-DD", "recipients": [...] }
//
// Every figure comes from public.ops_landlord_ops_weekly_bundle, which reads the
// same tables/columns the Landlord Ops dashboard + Extract Center read:
// landlords, house_listings, lc1_chairpersons, landlord_verification_requests,
// lc1_verification_requests, rent_requests (funded_at), landlord_payouts.

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

/** Today's date in East Africa Time as YYYY-MM-DD. */
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
  }).format(new Date(`${dateStr}T00:00:00Z`));
}

interface DailyRow {
  day: string;
  landlords_new: number; landlords_verified: number;
  houses_new: number; houses_verified: number;
  lc1_new: number; lc1_verified: number;
  requests_funded: number; landlords_funded: number; funded_amount: number;
  payouts_queued: number; payouts_queued_amount: number;
  payouts_disbursed: number; payouts_disbursed_amount: number;
  payout_receipts: number;
  lvr_raised: number; lvr_verified: number; lvr_rejected: number;
  lc1r_raised: number; lc1r_verified: number; lc1r_rejected: number;
  landlords_pending: number; houses_pending: number; lc1_pending: number;
}

function sum(rows: DailyRow[], key: keyof DailyRow) {
  return rows.reduce((a, r) => a + (Number(r[key]) || 0), 0);
}

function buildHtml(bundle: any, fromDate: string, toDate: string) {
  const rows: DailyRow[] = bundle.daily ?? [];
  const snap = bundle.snapshot ?? {};
  const funded = bundle.funded ?? {};
  const prev = bundle.funded_previous ?? {};
  const districts: any[] = bundle.by_district ?? [];

  const t = (k: keyof DailyRow) => sum(rows, k);
  const first = rows[0];
  const last = rows[rows.length - 1];
  const rising = (a?: number, b?: number) => (Number(b) || 0) > (Number(a) || 0);

  const backlogFlags = [
    ['Landlords pending verification', first?.landlords_pending, last?.landlords_pending],
    ['Houses pending verification', first?.houses_pending, last?.houses_pending],
    ['LC1 chairpersons pending verification', first?.lc1_pending, last?.lc1_pending],
  ] as [string, number, number][];

  const th = 'style="text-align:left;padding:6px 8px;border-bottom:1px solid #ddd;font-size:11px;color:#555;text-transform:uppercase"';
  const td = 'style="padding:6px 8px;border-bottom:1px solid #f0f0f0;font-size:12px"';
  const tdR = 'style="padding:6px 8px;border-bottom:1px solid #f0f0f0;font-size:12px;text-align:right"';

  const kpi = (label: string, value: string, source: string) => `
    <td style="padding:8px;width:25%;vertical-align:top">
      <div style="border:1px solid #e5d5f0;border-radius:6px;padding:10px;background:#faf7fd">
        <div style="font-size:10px;color:#7a6a86;text-transform:uppercase;letter-spacing:.4px">${label}</div>
        <div style="font-size:18px;font-weight:700;color:#241a2e;margin-top:3px">${value}</div>
        <div style="font-size:9px;color:#8b8b8b;margin-top:3px;font-family:monospace">${source}</div>
      </div>
    </td>`;

  return `<!doctype html><html><body style="margin:0;background:#f6f6f8;font-family:Arial,Helvetica,sans-serif;color:#222">
<div style="max-width:1000px;margin:0 auto;background:#fff">
  <div style="background:#4c1d95;color:#fff;padding:18px 22px">
    <div style="font-size:11px;letter-spacing:1px;opacity:.8">WELILE · LANDLORD OPERATIONS</div>
    <div style="font-size:20px;font-weight:700;margin-top:4px">Consolidated Weekly Report</div>
    <div style="font-size:12px;opacity:.85;margin-top:4px">Window ${dayLabel(fromDate)} – ${dayLabel(toDate)} (East Africa Time) · source: Landlord Ops dashboard date-range filter and the Extract Center report set</div>
  </div>

  <div style="padding:18px 22px">
    <h3 style="font-size:13px;text-transform:uppercase;letter-spacing:.5px;color:#4c1d95;margin:0 0 8px">Week in one paragraph</h3>
    <p style="font-size:13px;line-height:1.6;margin:0">
      Agents registered <b>${num(t('landlords_new'))} new landlords</b> and <b>${num(t('houses_new'))} new houses</b>
      (<code>landlords.created_at</code>, <code>house_listings.created_at</code>), while Landlord Ops verified
      <b>${num(t('landlords_verified'))} landlords</b> and <b>${num(t('houses_verified'))} houses</b>
      (<code>landlords.verified_at</code>, <code>house_listings.verified_at</code>).
      <b>${num(t('lc1_new'))} LC1 chairpersons</b> were registered and <b>${num(t('lc1_verified'))}</b> were verified
      (<code>lc1_chairpersons.verified_at</code>); <b>${num(t('lc1r_raised'))}</b> LC1 verification requests were raised
      (<code>lc1_verification_requests</code>).
      On the money side, <b>${num(funded.reqs)} rent requests were funded for ${num(funded.landlords)} distinct landlords</b>,
      committing <b>${ugx(funded.rent)}</b> of capital against <b>${ugx(funded.repay)}</b> of booked repayment
      (<code>rent_requests.funded_at</code>) — against ${num(prev.reqs)} requests / ${ugx(prev.rent)} in the preceding
      equal-length window. Payout execution: <b>${num(t('payouts_queued'))} payouts queued for ${ugx(t('payouts_queued_amount'))}</b>
      and <b>${num(t('payouts_disbursed'))} disbursed for ${ugx(t('payouts_disbursed_amount'))}</b>, with
      <b>${num(t('payout_receipts'))} payout receipts uploaded</b>
      (<code>landlord_payouts.created_at / disbursed_at / receipt_uploaded_at</code>).
    </p>

    <h3 style="font-size:13px;text-transform:uppercase;letter-spacing:.5px;color:#4c1d95;margin:20px 0 4px">Week totals</h3>
    <table width="100%" cellspacing="0" cellpadding="0"><tr>
      ${kpi('New landlords registered', num(t('landlords_new')), 'landlords.created_at')}
      ${kpi('Landlords verified', num(t('landlords_verified')), 'landlords.verified_at')}
      ${kpi('New houses listed', num(t('houses_new')), 'house_listings.created_at')}
      ${kpi('Houses verified', num(t('houses_verified')), 'house_listings.verified_at')}
    </tr><tr>
      ${kpi('New LC1 chairpersons', num(t('lc1_new')), 'lc1_chairpersons.created_at')}
      ${kpi('LC1 verifications', num(t('lc1_verified')), 'lc1_chairpersons.verified_at')}
      ${kpi('Landlords funded', num(funded.landlords), 'rent_requests.funded_at')}
      ${kpi('Requests funded', num(funded.reqs), 'rent_requests.funded_at')}
    </tr><tr>
      ${kpi('Capital committed', ugx(funded.rent), 'rent_requests.rent_amount')}
      ${kpi('Total repayment booked', ugx(funded.repay), 'rent_requests.total_repayment')}
      ${kpi('Payouts queued', `${num(t('payouts_queued'))} · ${ugx(t('payouts_queued_amount'))}`, 'landlord_payouts.created_at')}
      ${kpi('Payouts disbursed', `${num(t('payouts_disbursed'))} · ${ugx(t('payouts_disbursed_amount'))}`, 'landlord_payouts.disbursed_at')}
    </tr></table>

    <h3 style="font-size:13px;text-transform:uppercase;letter-spacing:.5px;color:#4c1d95;margin:22px 0 4px">Per-day breakdown (EAT day boundaries)</h3>
    <table width="100%" cellspacing="0" cellpadding="0">
      <tr><th ${th}>Day</th><th ${th}>Landlords new</th><th ${th}>Landlords verified</th><th ${th}>Houses new</th>
        <th ${th}>Houses verified</th><th ${th}>LC1 new</th><th ${th}>LC1 verified</th><th ${th}>Requests funded</th>
        <th ${th}>Capital funded</th><th ${th}>Payouts queued</th><th ${th}>Payouts disbursed</th></tr>
      ${rows.map(r => `<tr>
        <td ${td}>${dayLabel(r.day)}</td>
        <td ${tdR}>${num(r.landlords_new)}</td><td ${tdR}>${num(r.landlords_verified)}</td>
        <td ${tdR}>${num(r.houses_new)}</td><td ${tdR}>${num(r.houses_verified)}</td>
        <td ${tdR}>${num(r.lc1_new)}</td><td ${tdR}>${num(r.lc1_verified)}</td>
        <td ${tdR}>${num(r.requests_funded)}</td><td ${tdR}>${ugx(r.funded_amount)}</td>
        <td ${tdR}>${num(r.payouts_queued)} · ${ugx(r.payouts_queued_amount)}</td>
        <td ${tdR}>${num(r.payouts_disbursed)} · ${ugx(r.payouts_disbursed_amount)}</td></tr>`).join('')}
      <tr style="background:#faf7fd;font-weight:700">
        <td ${td}>Total</td>
        <td ${tdR}>${num(t('landlords_new'))}</td><td ${tdR}>${num(t('landlords_verified'))}</td>
        <td ${tdR}>${num(t('houses_new'))}</td><td ${tdR}>${num(t('houses_verified'))}</td>
        <td ${tdR}>${num(t('lc1_new'))}</td><td ${tdR}>${num(t('lc1_verified'))}</td>
        <td ${tdR}>${num(t('requests_funded'))}</td><td ${tdR}>${ugx(t('funded_amount'))}</td>
        <td ${tdR}>${num(t('payouts_queued'))} · ${ugx(t('payouts_queued_amount'))}</td>
        <td ${tdR}>${num(t('payouts_disbursed'))} · ${ugx(t('payouts_disbursed_amount'))}</td></tr>
    </table>

    <h3 style="font-size:13px;text-transform:uppercase;letter-spacing:.5px;color:#4c1d95;margin:22px 0 4px">Verification request queues (agent-raised)</h3>
    <table width="100%" cellspacing="0" cellpadding="0">
      <tr><th ${th}>Day</th><th ${th}>Landlord requests raised</th><th ${th}>Landlord verified</th><th ${th}>Landlord rejected</th>
        <th ${th}>LC1 requests raised</th><th ${th}>LC1 verified</th><th ${th}>LC1 rejected</th></tr>
      ${rows.map(r => `<tr><td ${td}>${dayLabel(r.day)}</td>
        <td ${tdR}>${num(r.lvr_raised)}</td><td ${tdR}>${num(r.lvr_verified)}</td><td ${tdR}>${num(r.lvr_rejected)}</td>
        <td ${tdR}>${num(r.lc1r_raised)}</td><td ${tdR}>${num(r.lc1r_verified)}</td><td ${tdR}>${num(r.lc1r_rejected)}</td></tr>`).join('')}
      <tr style="background:#faf7fd;font-weight:700"><td ${td}>Total</td>
        <td ${tdR}>${num(t('lvr_raised'))}</td><td ${tdR}>${num(t('lvr_verified'))}</td><td ${tdR}>${num(t('lvr_rejected'))}</td>
        <td ${tdR}>${num(t('lc1r_raised'))}</td><td ${tdR}>${num(t('lc1r_verified'))}</td><td ${tdR}>${num(t('lc1r_rejected'))}</td></tr>
    </table>
    <p style="font-size:11px;color:#666">Source: <code>landlord_verification_requests</code> and <code>lc1_verification_requests</code> (created_at for raised, resolved_at + status for decided).</p>

    <h3 style="font-size:13px;text-transform:uppercase;letter-spacing:.5px;color:#4c1d95;margin:22px 0 4px">Backlog at end of each day</h3>
    <table width="100%" cellspacing="0" cellpadding="0">
      <tr><th ${th}>Day (close, EAT)</th><th ${th}>Landlords pending verification</th><th ${th}>Houses pending verification</th><th ${th}>LC1 pending verification</th></tr>
      ${rows.map(r => `<tr><td ${td}>${dayLabel(r.day)}</td>
        <td ${tdR}>${num(r.landlords_pending)}</td><td ${tdR}>${num(r.houses_pending)}</td><td ${tdR}>${num(r.lc1_pending)}</td></tr>`).join('')}
    </table>
    <div style="margin-top:10px;border:1px solid #f2c8c8;background:#fdf6f6;border-radius:6px;padding:10px;font-size:12px;line-height:1.6">
      <b>Backlog flags</b><br>
      ${backlogFlags.map(([label, a, b]) => `${label}: ${num(a)} → ${num(b)} ${rising(a, b) ? `<b style="color:#b91c1c">(rising +${num((Number(b) || 0) - (Number(a) || 0))})</b>` : '(not rising)'}`).join('<br>')}
      <br><span style="color:#666">Computed as created on or before day close and not verified as at day close, excluding rejected.</span>
    </div>

    <h3 style="font-size:13px;text-transform:uppercase;letter-spacing:.5px;color:#4c1d95;margin:22px 0 4px">Current status snapshot (all-time, for scope)</h3>
    <table width="100%" cellspacing="0" cellpadding="0">
      <tr><th ${th}>Register</th><th ${th}>Total</th><th ${th}>Verified</th><th ${th}>Pending</th><th ${th}>Rejected</th></tr>
      <tr><td ${td}>Landlords <code>landlords</code></td><td ${tdR}>${num(snap.l_total)}</td><td ${tdR}>${num(snap.l_verified)}</td><td ${tdR}>${num(snap.l_pending)}</td><td ${tdR}>${num(snap.l_rejected)}</td></tr>
      <tr><td ${td}>Houses <code>house_listings</code></td><td ${tdR}>${num(snap.h_total)}</td><td ${tdR}>${num(snap.h_verified)}</td><td ${tdR}>${num(snap.h_pending)}</td><td ${tdR}>${num(snap.h_rejected)}</td></tr>
      <tr><td ${td}>LC1 chairpersons <code>lc1_chairpersons</code></td><td ${tdR}>${num(snap.c_total)}</td><td ${tdR}>${num(snap.c_verified)}</td><td ${tdR}>${num(snap.c_pending)}</td><td ${tdR}>${num(snap.c_rejected)}</td></tr>
    </table>

    <h3 style="font-size:13px;text-transform:uppercase;letter-spacing:.5px;color:#4c1d95;margin:22px 0 4px">Landlords funded — district breakdown (window)</h3>
    <table width="100%" cellspacing="0" cellpadding="0">
      <tr><th ${th}>District</th><th ${th}>Requests funded</th><th ${th}>Landlords funded</th><th ${th}>Capital funded</th></tr>
      ${districts.map(d => `<tr><td ${td}>${d.district}</td><td ${tdR}>${num(d.reqs)}</td><td ${tdR}>${num(d.landlords)}</td><td ${tdR}>${ugx(d.rent)}</td></tr>`).join('')}
    </table>
    <p style="font-size:11px;color:#666">District uses the Landlords Funded fallback chain: <code>landlords.district</code> → tenant <code>profiles.district</code> → <code>house_listings.district</code> → Unspecified.</p>

    <h3 style="font-size:13px;text-transform:uppercase;letter-spacing:.5px;color:#4c1d95;margin:22px 0 4px">What could not be pulled live</h3>
    <ol style="font-size:12px;line-height:1.6;color:#333;padding-left:18px">
      <li><code>ops_landlord_funded_stats</code> and <code>ops_lc1_verification_report</code> are ops-role gated, so this automated job reads their underlying tables directly with the same definitions instead of calling the RPCs.</li>
      <li><code>agent_landlord_payouts</code> is empty in production; all payout figures come from <code>landlord_payouts</code>.</li>
      <li>Payout receipts count rows with <code>receipt_uploaded_at</code> inside the window only — a zero means no uploads that week, not a missing pull.</li>
    </ol>

    <p style="font-size:10px;color:#999;border-top:1px solid #eee;padding-top:10px;margin-top:18px">
      Welile · Landlord Operations · automated weekly report · every Wednesday 13:00 EAT to ${DEFAULT_RECIPIENTS.join(', ')} · all amounts UGX
    </p>
  </div>
</div></body></html>`;
}

function buildText(bundle: any, fromDate: string, toDate: string) {
  const rows: DailyRow[] = bundle.daily ?? [];
  const funded = bundle.funded ?? {};
  const t = (k: keyof DailyRow) => sum(rows, k);
  const lines = [
    `WELILE - LANDLORD OPS WEEKLY REPORT (${fromDate} to ${toDate}, EAT)`,
    '',
    `New landlords: ${num(t('landlords_new'))} | Landlords verified: ${num(t('landlords_verified'))}`,
    `New houses: ${num(t('houses_new'))} | Houses verified: ${num(t('houses_verified'))}`,
    `New LC1: ${num(t('lc1_new'))} | LC1 verified: ${num(t('lc1_verified'))}`,
    `Requests funded: ${num(funded.reqs)} for ${num(funded.landlords)} landlords | Capital ${ugx(funded.rent)} | Repayment ${ugx(funded.repay)}`,
    `Payouts queued: ${num(t('payouts_queued'))} (${ugx(t('payouts_queued_amount'))}) | Disbursed: ${num(t('payouts_disbursed'))} (${ugx(t('payouts_disbursed_amount'))}) | Receipts: ${num(t('payout_receipts'))}`,
    '',
    'PER DAY (day | landlords new/verified | houses new/verified | LC1 new/verified | funded | capital)',
    ...rows.map(r => `${r.day} | ${r.landlords_new}/${r.landlords_verified} | ${r.houses_new}/${r.houses_verified} | ${r.lc1_new}/${r.lc1_verified} | ${r.requests_funded} | ${ugx(r.funded_amount)}`),
    '',
    'BACKLOG (day close: landlords / houses / LC1 pending)',
    ...rows.map(r => `${r.day} | ${r.landlords_pending} / ${r.houses_pending} / ${r.lc1_pending}`),
  ];
  return lines.join('\n');
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
    const { data, error } = await admin.rpc('ops_landlord_ops_weekly_bundle', {
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
    form.set('subject', `Welile Landlord Ops - Weekly Report (${fromDate} to ${toDate})`);
    form.set('text', text);
    form.set('html', html);
    form.set('o:tag', 'landlord-ops-weekly');

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
    console.error('weekly-landlord-ops-report failed', err);
    return new Response(JSON.stringify({ error: String((err as any)?.message ?? err) }), {
      status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
