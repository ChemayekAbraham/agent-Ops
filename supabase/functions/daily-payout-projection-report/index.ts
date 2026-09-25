// Daily Payout Projection Report
// Every evening, emails the CEO (CC Josh) everything scheduled or queued to
// leave the company the following day: Supporter Returns, landlord payouts and
// withdrawals. All figures come from get_next_day_payout_projection — this
// function only formats and sends.
//
// Invocation:
//   POST /daily-payout-projection-report                  → tomorrow (Kampala), default recipients (cron)
//   POST body: { "date": "YYYY-MM-DD", "to": [...], "cc": [...], "dry_run": true }
//     - "date", "to", "cc" and "dry_run" are honoured only for a signed-in
//       executive (CEO/CFO/COO/manager/super_admin). Anyone else gets the
//       default run, so the public anon key can't redirect payout details
//       to an arbitrary inbox or read them back.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.4';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const FROM_DOMAIN = 'welile.com';
const DEFAULT_FROM = `Welile Reports <reports@${FROM_DOMAIN}>`;
const DEFAULT_TO = ['benjaminmuhanguzi29@gmail.com'];
const DEFAULT_CC = ['joshwanda17@gmail.com'];

type Json = Record<string, any>;

function ugx(n: unknown) {
  return `UGX ${Math.round(Number(n) || 0).toLocaleString('en-US')}`;
}

function esc(s: unknown) {
  return String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));
}

function prettyDate(iso: string) {
  const d = new Date(`${iso}T12:00:00Z`);
  return d.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
}

function groupBy<T>(items: T[], key: (t: T) => string): [string, T[]][] {
  const m = new Map<string, T[]>();
  for (const it of items) {
    const k = key(it);
    if (!m.has(k)) m.set(k, []);
    m.get(k)!.push(it);
  }
  return [...m.entries()].sort(([a], [b]) => a.localeCompare(b));
}

function validEmails(v: unknown): string[] | null {
  if (!Array.isArray(v)) return null;
  const out = v.filter((r): r is string => typeof r === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(r));
  return out.length ? out : null;
}

function render(p: Json) {
  const date: string = p.date;
  const roi: Json[] = p.roi.items;
  const cashRoi = roi.filter((r) => !r.compounding);
  const compRoi = roi.filter((r) => r.compounding);
  const landlord: Json[] = p.landlord.items;
  const wd: Json[] = p.withdrawals.items;
  const cap: Json[] = p.partner_capital.items;
  const grandTotal =
    Number(p.roi.cash_total) + Number(p.landlord.total) + Number(p.withdrawals.total) + Number(p.partner_capital.total);

  const flags: string[] = [];
  for (const r of cashRoi) {
    if (r.early_first_payout) {
      flags.push(`${r.partner_name} (${r.portfolio_code}) — ${ugx(r.amount)} is due only ${
        Math.round((Date.parse(`${date}T00:00:00Z`) - Date.parse(`${r.funded_on}T00:00:00Z`)) / 86400000)
      } day(s) after funding on ${r.funded_on}. Check the payout date before paying.`);
    }
    if (r.channel === 'DESTINATION NOT SET' || !r.destination_number) {
      flags.push(`${r.partner_name} (${r.portfolio_code}) — no payout account/number on file.`);
    }
  }

  const t: string[] = [];
  const h: string[] = [];
  const line = '━━━━━━━━━━━━━━━━━━';

  t.push(`WELILE PAYOUTS PROJECTION — ${prettyDate(date).toUpperCase()}`, line);
  t.push(`TOTAL CASH OUT: ${ugx(grandTotal)}`);
  t.push(`  Supporter Returns: ${p.roi.cash_count} — ${ugx(p.roi.cash_total)}`);
  t.push(`  Landlord payouts: ${p.landlord.count} — ${ugx(p.landlord.total)}`);
  t.push(`  Wallet withdrawals: ${p.withdrawals.count} — ${ugx(p.withdrawals.total)}`);
  t.push(`  Partner capital withdrawals: ${p.partner_capital.count} — ${ugx(p.partner_capital.total)}`);
  t.push(`Compounding (no cash): ${p.roi.compounding_count} — ${ugx(p.roi.compounding_total)}`, line);

  h.push(`<div style="font-family:Arial,Helvetica,sans-serif;max-width:720px;color:#111">`);
  h.push(`<h2 style="margin:0 0 4px">Welile Payouts Projection</h2>`);
  h.push(`<div style="color:#555;margin-bottom:16px">${esc(prettyDate(date))}</div>`);
  h.push(`<table cellpadding="6" style="border-collapse:collapse;width:100%;margin-bottom:16px;border:1px solid #ddd">`);
  const sumRow = (label: string, count: unknown, amt: unknown, bold = false) =>
    h.push(`<tr style="${bold ? 'font-weight:bold;background:#f3f4f6' : ''}"><td style="border-bottom:1px solid #eee">${esc(label)}</td><td align="right" style="border-bottom:1px solid #eee">${esc(count)}</td><td align="right" style="border-bottom:1px solid #eee">${esc(ugx(amt))}</td></tr>`);
  sumRow('Supporter Returns (cash)', p.roi.cash_count, p.roi.cash_total);
  sumRow('Landlord payouts', p.landlord.count, p.landlord.total);
  sumRow('Wallet withdrawals', p.withdrawals.count, p.withdrawals.total);
  sumRow('Partner capital withdrawals', p.partner_capital.count, p.partner_capital.total);
  sumRow('TOTAL CASH OUT', '', grandTotal, true);
  sumRow('Compounding — reinvested, no cash', p.roi.compounding_count, p.roi.compounding_total);
  h.push(`</table>`);

  if (flags.length) {
    t.push('⚠️ CHECK BEFORE PAYING');
    flags.forEach((f) => t.push(`- ${f}`));
    t.push(line);
    h.push(`<div style="background:#fff7ed;border:1px solid #fdba74;padding:10px 12px;margin-bottom:16px"><b>Check before paying</b><ul style="margin:6px 0 0;padding-left:18px">`);
    flags.forEach((f) => h.push(`<li>${esc(f)}</li>`));
    h.push(`</ul></div>`);
  }

  const table = (title: string, headers: string[], rows: string[][]) => {
    h.push(`<h3 style="margin:18px 0 6px">${esc(title)}</h3>`);
    if (!rows.length) {
      h.push(`<div style="color:#777">None.</div>`);
      return;
    }
    h.push(`<table cellpadding="5" style="border-collapse:collapse;width:100%;font-size:13px">`);
    h.push(`<tr style="background:#f3f4f6">${headers.map((x, i) => `<th align="${i === headers.length - 1 ? 'right' : 'left'}">${esc(x)}</th>`).join('')}</tr>`);
    rows.forEach((r) =>
      h.push(`<tr>${r.map((c, i) => `<td style="border-bottom:1px solid #eee" align="${i === r.length - 1 ? 'right' : 'left'}">${esc(c)}</td>`).join('')}</tr>`));
    h.push(`</table>`);
  };

  // Supporter Returns, grouped by bank / network — same shape as the payout sheet.
  t.push('SUPPORTER RETURNS');
  let n = 0;
  for (const [channel, items] of groupBy(cashRoi, (r) => r.channel)) {
    const sub = items.reduce((s, r) => s + Number(r.amount), 0);
    t.push('', `${channel} — ${items.length} — ${ugx(sub)}`);
    for (const r of items) {
      n += 1;
      t.push(`${n}. ${r.partner_name} — ${ugx(r.amount)}`);
      if (r.destination_name) t.push(`   Name: ${r.destination_name}`);
      t.push(`   ${channel.includes('MOBILE') ? 'No' : 'A/C'}: ${r.destination_number ?? 'NOT SET'}`);
    }
    table(`${channel} — ${items.length} — ${ugx(sub)}`, ['Supporter', 'Account name', 'A/C / No.', 'Amount'],
      items.map((r) => [r.partner_name, r.destination_name ?? '', r.destination_number ?? 'NOT SET', ugx(r.amount)]));
  }
  if (!cashRoi.length) t.push('None.');

  if (compRoi.length) {
    t.push('', `COMPOUNDING — NO CASH — ${compRoi.length} — ${ugx(p.roi.compounding_total)}`);
    compRoi.forEach((r) => t.push(`- ${r.partner_name} — ${ugx(r.amount)}`));
    table(`Compounding — reinvested, no cash — ${ugx(p.roi.compounding_total)}`, ['Supporter', 'Portfolio', 'Amount'],
      compRoi.map((r) => [r.partner_name, r.portfolio_code, ugx(r.amount)]));
  }

  t.push(line, `LANDLORD PAYOUTS (queued tonight) — ${p.landlord.count} — ${ugx(p.landlord.total)}`);
  landlord.forEach((l) => t.push(`- ${l.landlord_name ?? 'Unknown landlord'} ${l.landlord_phone ?? ''} — ${ugx(l.amount)}${l.source === 'funded_rent_plan' ? ' (funded Rent Plan, payout not started)' : ''}`));
  if (!landlord.length) t.push('None.');
  table(`Landlord payouts (queued tonight) — ${ugx(p.landlord.total)}`, ['Landlord', 'Phone', 'Stage', 'Amount'],
    landlord.map((l) => [l.landlord_name ?? 'Unknown', l.landlord_phone ?? '', l.source === 'funded_rent_plan' ? 'Funded, not started' : 'Awaiting merchant payout', ugx(l.amount)]));

  t.push(line, `WALLET WITHDRAWALS (open) — ${p.withdrawals.count} — ${ugx(p.withdrawals.total)}`);
  wd.forEach((w) => t.push(`- ${w.name ?? 'Unknown'} — ${w.channel} ${w.destination_number ?? ''} — ${ugx(w.amount)}`));
  if (!wd.length) t.push('None.');
  table(`Wallet withdrawals (open) — ${ugx(p.withdrawals.total)}`, ['Name', 'Channel', 'A/C / No.', 'Amount'],
    wd.map((w) => [w.name ?? 'Unknown', w.channel, w.destination_number ?? '', ugx(w.amount)]));

  t.push(line, `PARTNER CAPITAL WITHDRAWALS (notice period ended) — ${p.partner_capital.count} — ${ugx(p.partner_capital.total)}`);
  cap.forEach((c) => t.push(`- ${c.name ?? 'Unknown'} — ${ugx(c.amount)} (eligible from ${c.earliest_process_date})`));
  if (!cap.length) t.push('None.');
  table(`Partner capital withdrawals — ${ugx(p.partner_capital.total)}`, ['Supporter', 'Eligible from', 'Status', 'Amount'],
    cap.map((c) => [c.name ?? 'Unknown', c.earliest_process_date, c.status, ugx(c.amount)]));

  const b = p.backlog;
  const backlogLines = [
    `Supporter Returns with a payout date already past: ${b.roi_past_due.count} (${ugx(b.roi_past_due.amount)})`,
    `Wallet withdrawals approved more than 7 days ago: ${b.withdrawals_approved_stale.count} (${ugx(b.withdrawals_approved_stale.amount)})`,
    `Failed landlord payouts: ${b.landlord_payouts_failed.count} (${ugx(b.landlord_payouts_failed.amount)})`,
  ];
  t.push(line, 'OLDER BACKLOG — not in the totals above (mostly settled outside the system; review separately)');
  backlogLines.forEach((l) => t.push(`- ${l}`));
  h.push(`<h3 style="margin:18px 0 6px">Older backlog — not in the totals above</h3><ul style="color:#555;font-size:13px">`);
  backlogLines.forEach((l) => h.push(`<li>${esc(l)}</li>`));
  h.push(`</ul><div style="color:#888;font-size:12px;margin-top:18px">Generated ${esc(p.generated_at)} from get_next_day_payout_projection.</div></div>`);

  return {
    subject: `Welile Payouts Projection — ${prettyDate(date)} — ${ugx(grandTotal)}`,
    text: t.join('\n'),
    html: h.join('\n'),
    grandTotal,
    flags,
  };
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  const json = (body: Json, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL');
    const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
    const anonKey = Deno.env.get('SUPABASE_ANON_KEY');
    const mailgunApiKey = Deno.env.get('MAILGUN_API_KEY');
    const mailgunDomain = Deno.env.get('MAILGUN_DOMAIN');
    const mailgunBaseUrl = Deno.env.get('MAILGUN_API_BASE') || 'https://api.mailgun.net';
    if (!supabaseUrl || !serviceKey || !mailgunApiKey || !mailgunDomain) {
      return json({ error: 'Server not configured' }, 500);
    }

    const body: Json = req.method === 'POST' ? await req.json().catch(() => ({})) : {};
    const wantsOverrides = body.date || body.to || body.cc || body.dry_run;

    // Overrides only for a signed-in executive: running the RPC under their own
    // token lets the RPC's role check decide.
    let isExec = false;
    const authHeader = req.headers.get('Authorization') ?? '';
    if (wantsOverrides && anonKey && authHeader.startsWith('Bearer ')) {
      const userClient = createClient(supabaseUrl, anonKey, { global: { headers: { Authorization: authHeader } } });
      const { data: u } = await userClient.auth.getUser();
      if (u?.user) {
        const { error } = await userClient.rpc('get_next_day_payout_projection', { p_date: null });
        isExec = !error;
      }
    }
    if (wantsOverrides && !isExec) {
      return json({ error: 'Overrides (date/to/cc/dry_run) require an executive sign-in' }, 403);
    }

    const date = isExec && typeof body.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(body.date) ? body.date : null;
    const to = (isExec && validEmails(body.to)) || DEFAULT_TO;
    const cc = isExec && body.cc !== undefined ? (validEmails(body.cc) ?? []) : DEFAULT_CC;

    const admin = createClient(supabaseUrl, serviceKey);
    const { data: projection, error } = await admin.rpc('get_next_day_payout_projection', { p_date: date });
    if (error || !projection) {
      console.error('projection rpc failed', error);
      return json({ error: 'projection_failed', details: error?.message }, 500);
    }

    const email = render(projection as Json);
    const summary = {
      date: (projection as Json).date,
      grand_total: email.grandTotal,
      roi_cash: (projection as Json).roi.cash_total,
      landlord: (projection as Json).landlord.total,
      withdrawals: (projection as Json).withdrawals.total,
      partner_capital: (projection as Json).partner_capital.total,
      flags: email.flags,
    };
    if (isExec && body.dry_run) return json({ ok: true, dry_run: true, to, cc, subject: email.subject, summary, text: email.text });

    const form = new FormData();
    form.set('from', DEFAULT_FROM);
    to.forEach((r) => form.append('to', r));
    cc.forEach((r) => form.append('cc', r));
    form.set('subject', email.subject);
    form.set('text', email.text);
    form.set('html', email.html);
    form.set('o:tag', 'payout-projection-daily');

    const mgRes = await fetch(`${mailgunBaseUrl}/v3/${mailgunDomain}/messages`, {
      method: 'POST',
      headers: { Authorization: 'Basic ' + btoa(`api:${mailgunApiKey}`) },
      body: form,
    });
    const mgText = await mgRes.text();
    if (!mgRes.ok) {
      console.error('Mailgun send failed', mgRes.status, mgText);
      return json({ error: 'Mailgun send failed', status: mgRes.status, details: mgText }, 502);
    }
    return json({ ok: true, to, cc, subject: email.subject, summary });
  } catch (e) {
    console.error('daily-payout-projection-report error', e);
    return json({ error: String((e as Error)?.message ?? e) }, 500);
  }
});
