// Merchant Float Morning Report — cash-flow planning only.
//
// Deliberately narrow: exactly three sections.
//   1. Phone Money — Right Now (MTN + Airtel + cash at hand)
//   2. Merchant Float — Right Now (every ACTIVE merchant desk, ascending)
//   3. Yesterday's Agent Activity (float received, payouts made, commission)
//
// Read-only. No deposits, no general withdrawals, no anomalies.
// Cron: 04:00 UTC = 07:00 EAT.
// Manual POST body: { "date": "YYYY-MM-DD", "recipients": [...], "skipEmail": true }

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.4';
import { PDFDocument, StandardFonts, rgb } from 'https://esm.sh/pdf-lib@1.17.1';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const FROM = 'Welile Reports <reports@welile.com>';
// Same recipient list as generate-daily-wallet-report.
const DEFAULT_RECIPIENTS = [
  'joshwanda17@gmail.com',
  'benjaminmuhanguzi29@gmail.com',
  'benjamin@welile.com',
];

// Operational-float funding categories. Confirmed from BOTH credit paths:
//  - record_merchant_float_delivery (outbound-SMS auto-credit) → agent_float_deposit
//  - cfo-direct-credit FLOAT_ROUTE_CATEGORIES → agent_float_deposit,
//    agent_float_assignment, agent_float_topup, agent_float_funding
const FLOAT_CREDIT_CATEGORIES = [
  'agent_float_deposit',
  'agent_float_assignment',
  'agent_float_topup',
  'agent_float_funding',
];

const fmt = (n: number) => `UGX ${Math.round(Number(n) || 0).toLocaleString('en-UG')}`;

function eatDayToUtcRange(dateStr: string) {
  const startUtc = new Date(`${dateStr}T00:00:00.000+03:00`);
  const endUtc = new Date(startUtc.getTime() + 24 * 60 * 60 * 1000);
  return { startIso: startUtc.toISOString(), endIso: endUtc.toISOString() };
}
function yesterdayEat(): string {
  const nowEatMs = Date.now() + 3 * 60 * 60 * 1000;
  return new Date(nowEatMs - 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
}
function eatNowLabel(): string {
  return new Date(Date.now() + 3 * 60 * 60 * 1000).toISOString().replace('T', ' ').slice(0, 19) + ' EAT';
}

interface PhoneMoney {
  mtn: number;
  airtel: number;
  cashAtHand: number;
  total: number;
  mtnLastSmsAt: string | null;
  airtelLastSmsAt: string | null;
}
interface FloatRow {
  deskId: string;
  agentId: string;
  name: string;
  phone: string;
  label: string;
  /** "Float they can spend now" on the Financial Ops board (evidenced_amount). */
  floatHeld: number;
  /** "Our cash still on their phones" (company_cash_with_agent). */
  companyCash: number;
  /** "Money we must send back to them" (owed_to_agent). */
  owed: number;
  /**
   * Own-money claims filed but not yet confirmed by the merchant
   * (own_cash_under_review). NOT payable and never added into `owed` -- but a
   * desk reading 0 owed can be carrying millions here, so the report must show
   * it or it reports a working day of own-pocket payouts as no debt at all.
   */
  underReview: number;
}
interface ActivityRow {
  agentId: string;
  name: string;
  floatReceived: number;
  /** Float that left the desk for reasons OTHER than settling a customer payout
   *  (float re-assigned to another user, bucket reclassifications, float used
   *  for rent). Without this column, received − paid out never reconciles with
   *  the closing float and the report looks wrong. */
  floatMovedOn: number;
  payoutCount: number;
  payoutAmount: number;
  commission: number;
  floatHeld: number;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  let dateStr = yesterdayEat();
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

    const body = req.method === 'POST' ? await req.json().catch(() => ({})) : {};
    if (typeof body?.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(body.date)) dateStr = body.date;
    const recipients: string[] =
      Array.isArray(body?.recipients) && body.recipients.length > 0
        ? body.recipients.filter((r: unknown) => typeof r === 'string' && (r as string).includes('@'))
        : DEFAULT_RECIPIENTS;
    const skipEmail = body?.skipEmail === true;

    const { startIso, endIso } = eatDayToUtcRange(dateStr);
    const supabase = createClient(supabaseUrl, serviceKey);

    // ── Section 1: Phone Money — Right Now ───────────────────────────────
    const [{ data: phoneRecon, error: phoneErr }, { data: cashRow, error: cashErr }] =
      await Promise.all([
        supabase.rpc('get_phone_platform_reconciliation'),
        supabase.rpc('get_cash_at_hand_total_system'),
      ]);
    if (phoneErr) throw phoneErr;
    if (cashErr) throw cashErr;
    const mtn = Number((phoneRecon as any)?.mtn_balance ?? 0);
    const airtel = Number((phoneRecon as any)?.airtel_balance ?? 0);
    const cashAtHand = Number((cashRow as any)?.cash_at_hand_total ?? 0);
    const phone: PhoneMoney = {
      mtn, airtel, cashAtHand,
      total: mtn + airtel + cashAtHand,
      mtnLastSmsAt: (phoneRecon as any)?.mtn_last_sms_at ?? null,
      airtelLastSmsAt: (phoneRecon as any)?.airtel_last_sms_at ?? null,
    };

    // ── Section 2: Merchant Float — Right Now (all ACTIVE desks) ─────────
    // MUST use the SAME source and the SAME three measures as the Financial Ops
    // "Money With Merchant Agents" card, otherwise the report and the board
    // disagree: `get_merchant_float_positions` + active desks only, with
    // evidenced_amount / company_cash_with_agent / owed_to_agent clamped at 0
    // exactly like MoneyWithAgentsCard does.
    const { data: posData, error: posErr } = await supabase.rpc('get_merchant_float_positions');
    if (posErr) throw posErr;
    const floats: FloatRow[] = (posData ?? [])
      .filter((r: any) => !!r.is_active)
      .map((r: any) => ({
        deskId: String(r.desk_id),
        agentId: String(r.agent_id),
        name: String(r.agent_name || 'Unnamed agent'),
        phone: String(r.agent_phone || ''),
        label: String(r.label || ''),
        floatHeld: Math.max(0, Number(r.evidenced_amount || 0)),
        companyCash: Math.max(0, Number(r.company_cash_with_agent || 0)),
        owed: Number(r.owed_to_agent || 0),
        underReview: Math.max(0, Number(r.own_cash_under_review || 0)),
      }))
      .sort((a: FloatRow, b: FloatRow) => a.floatHeld - b.floatHeld);
    const floatTotal = floats.reduce((s, r) => s + r.floatHeld, 0);
    const companyCashTotal = floats.reduce((s, r) => s + r.companyCash, 0);
    const owedTotal = floats.reduce((s, r) => s + r.owed, 0);
    const underReviewTotal = floats.reduce((s, r) => s + r.underReview, 0);
    const agentIds = [...new Set(floats.map((f) => f.agentId))];
    const deskIds = [...new Set(floats.map((f) => f.deskId))];
    const byAgent = new Map(floats.map((f) => [f.agentId, f]));
    const deskToAgent = new Map(floats.map((f) => [f.deskId, f.agentId]));

    // ── Section 3: Yesterday's Agent Activity ────────────────────────────
    const floatReceived = new Map<string, number>();
    const floatMovedOn = new Map<string, number>();
    const payouts = new Map<string, { count: number; amount: number }>();
    const commissions = new Map<string, number>();

    if (agentIds.length > 0) {
      // Float received (both the CFO-funding path and the outbound-SMS auto-credit path).
      let from = 0;
      const PAGE = 1000;
      while (true) {
        const { data, error } = await supabase
          .from('general_ledger')
          .select('user_id, amount')
          .eq('direction', 'cash_in')
          .eq('ledger_scope', 'wallet')
          .in('category', FLOAT_CREDIT_CATEGORIES)
          .neq('classification', 'admin_correction')
          .in('user_id', agentIds)
          .gte('transaction_date', startIso)
          .lt('transaction_date', endIso)
          .range(from, from + PAGE - 1);
        if (error) throw error;
        for (const r of data ?? []) {
          const k = String((r as any).user_id);
          floatReceived.set(k, (floatReceived.get(k) ?? 0) + Number((r as any).amount || 0));
        }
        if (!data || data.length < PAGE) break;
        from += PAGE;
      }

      // Float that left the desk WITHOUT settling a payout. `agent_float_settlement`
      // is the payout deduction and is already represented by "Paid out", so it is
      // excluded here to avoid double counting.
      from = 0;
      while (true) {
        const { data, error } = await supabase
          .from('general_ledger')
          .select('user_id, amount')
          .eq('direction', 'cash_out')
          .eq('ledger_scope', 'wallet')
          .eq('wallet_bucket', 'float')
          .neq('category', 'agent_float_settlement')
          .neq('classification', 'admin_correction')
          .in('user_id', agentIds)
          .gte('transaction_date', startIso)
          .lt('transaction_date', endIso)
          .range(from, from + PAGE - 1);
        if (error) throw error;
        for (const r of data ?? []) {
          const k = String((r as any).user_id);
          floatMovedOn.set(k, (floatMovedOn.get(k) ?? 0) + Number((r as any).amount || 0));
        }
        if (!data || data.length < PAGE) break;
        from += PAGE;
      }

      // Payouts settled yesterday. Settlement = status 'completed' + processed_at
      // in window. The settling agent is identified by assigned_cashout_agent_id
      // (desk) or processed_by (agent user). There is no finops_disbursed_by column.
      from = 0;
      while (true) {
        const { data, error } = await supabase
          .from('withdrawal_requests')
          .select('id, amount, processed_by, assigned_cashout_agent_id')
          .eq('status', 'completed')
          .gte('processed_at', startIso)
          .lt('processed_at', endIso)
          .range(from, from + PAGE - 1);
        if (error) throw error;
        for (const r of data ?? []) {
          const desk = (r as any).assigned_cashout_agent_id
            ? deskToAgent.get(String((r as any).assigned_cashout_agent_id))
            : undefined;
          const pb = (r as any).processed_by ? String((r as any).processed_by) : undefined;
          const key = desk ?? (pb && byAgent.has(pb) ? pb : undefined);
          if (!key) continue;
          const cur = payouts.get(key) ?? { count: 0, amount: 0 };
          cur.count += 1;
          cur.amount += Number((r as any).amount || 0);
          payouts.set(key, cur);
        }
        if (!data || data.length < PAGE) break;
        from += PAGE;
      }

      // Commission earned yesterday.
      from = 0;
      while (true) {
        const { data, error } = await supabase
          .from('merchant_commission_awards')
          .select('agent_id, commission_amount')
          .in('agent_id', agentIds)
          .gte('created_at', startIso)
          .lt('created_at', endIso)
          .range(from, from + PAGE - 1);
        if (error) throw error;
        for (const r of data ?? []) {
          const k = String((r as any).agent_id);
          commissions.set(k, (commissions.get(k) ?? 0) + Number((r as any).commission_amount || 0));
        }
        if (!data || data.length < PAGE) break;
        from += PAGE;
      }
    }

    const activity: ActivityRow[] = floats.map((f) => ({
      agentId: f.agentId,
      name: f.name,
      floatReceived: floatReceived.get(f.agentId) ?? 0,
      floatMovedOn: floatMovedOn.get(f.agentId) ?? 0,
      payoutCount: payouts.get(f.agentId)?.count ?? 0,
      payoutAmount: payouts.get(f.agentId)?.amount ?? 0,
      commission: commissions.get(f.agentId) ?? 0,
      floatHeld: f.floatHeld,
    })).sort((a, b) => b.payoutAmount - a.payoutAmount || b.floatReceived - a.floatReceived);

    const totals = {
      floatReceived: activity.reduce((s, r) => s + r.floatReceived, 0),
      floatMovedOn: activity.reduce((s, r) => s + r.floatMovedOn, 0),
      payoutCount: activity.reduce((s, r) => s + r.payoutCount, 0),
      payoutAmount: activity.reduce((s, r) => s + r.payoutAmount, 0),
      commission: activity.reduce((s, r) => s + r.commission, 0),
    };

    const generatedAtLabel = eatNowLabel();
    const pdfBytes = await buildPdf({ dateStr, generatedAtLabel, phone, floats, floatTotal, companyCashTotal, owedTotal, underReviewTotal, activity, totals });

    const baseName = `welile-merchant-float-morning-${dateStr}`;
    const pdfPath = `${dateStr}/${baseName}.pdf`;
    const up = await supabase.storage.from('finops-reports').upload(pdfPath, pdfBytes, {
      contentType: 'application/pdf', upsert: true,
    });
    if (up.error) throw up.error;

    const { data: saved, error: saveErr } = await supabase
      .from('merchant_float_morning_reports')
      .upsert(
        { report_date: dateStr, generated_at: new Date().toISOString(), pdf_path: pdfPath },
        { onConflict: 'report_date' },
      )
      .select()
      .single();
    if (saveErr) throw saveErr;

    if (!skipEmail) {
      const form = new FormData();
      form.set('from', FROM);
      recipients.forEach((r) => form.append('to', r));
      form.set('subject', `Merchant Float Morning Report – ${dateStr} (EAT)`);
      form.set('text', renderText({ dateStr, generatedAtLabel, phone, floats, floatTotal, companyCashTotal, owedTotal, underReviewTotal, activity, totals }));
      form.set('html', renderHtml({ dateStr, generatedAtLabel, phone, floats, floatTotal, companyCashTotal, owedTotal, underReviewTotal, activity, totals }));
      form.set('o:tag', 'merchant-float-morning');
      form.append('attachment', new Blob([pdfBytes], { type: 'application/pdf' }), `${baseName}.pdf`);

      const mgRes = await fetch(`${mailgunBaseUrl}/v3/${mailgunDomain}/messages`, {
        method: 'POST',
        headers: { Authorization: 'Basic ' + btoa(`api:${mailgunApiKey}`) },
        body: form,
      });
      const mgText = await mgRes.text();
      if (!mgRes.ok) {
        console.error('Mailgun send failed', mgRes.status, mgText);
        return new Response(JSON.stringify({ ok: true, date: dateStr, id: saved?.id, emailError: mgText, emailStatus: mgRes.status }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }
      await supabase
        .from('merchant_float_morning_reports')
        .update({ emailed_at: new Date().toISOString() })
        .eq('id', saved.id);
    }

    return new Response(
      JSON.stringify({
        ok: true,
        date: dateStr,
        id: saved.id,
        pdf_path: pdfPath,
        phone_money_total: phone.total,
        active_desks: floats.length,
        merchant_float_total: floatTotal,
        company_cash_with_agents_total: companyCashTotal,
        owed_to_agents_total: owedTotal,
        own_cash_under_review_total: underReviewTotal,
        yesterday: totals,
      }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    );
  } catch (err) {
    console.error('generate-merchant-float-morning-report failed', err);
    try {
      const supabaseUrl = Deno.env.get('SUPABASE_URL');
      const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
      if (supabaseUrl && serviceKey) {
        const admin = createClient(supabaseUrl, serviceKey);
        await admin.from('system_events').insert({
          event_type: 'report_generation_failed',
          metadata: {
            report: 'merchant_float_morning',
            date: dateStr,
            error: String((err as any)?.message ?? err),
          },
        });
      }
    } catch (logErr) {
      console.error('failed to record report_generation_failed event', logErr);
    }
    return new Response(JSON.stringify({ error: String((err as any)?.message ?? err) }), {
      status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});

interface Payload {
  dateStr: string;
  generatedAtLabel: string;
  phone: PhoneMoney;
  floats: FloatRow[];
  floatTotal: number;
  companyCashTotal: number;
  owedTotal: number;
  underReviewTotal: number;
  activity: ActivityRow[];
  totals: { floatReceived: number; floatMovedOn: number; payoutCount: number; payoutAmount: number; commission: number };
}

function renderHtml(p: Payload) {
  const td = 'padding:4px 10px;border-bottom:1px solid #eee';
  const tdr = `${td};text-align:right;font-variant-numeric:tabular-nums`;
  const floatRows = p.floats
    .map((f) => `<tr><td style="${td}">${esc(f.name)}${f.label ? ` <span style="color:#888">(${esc(f.label)})</span>` : ''}</td><td style="${td}">${esc(f.phone)}</td><td style="${tdr}">${fmt(f.floatHeld)}</td><td style="${tdr}">${fmt(f.companyCash)}</td><td style="${tdr}">${fmt(f.owed)}</td><td style="${tdr}">${fmt(f.underReview)}</td></tr>`)
    .join('');
  const actRows = p.activity
    .map((a) => `<tr><td style="${td}">${esc(a.name)}</td><td style="${tdr}">${fmt(a.floatReceived)}</td><td style="${tdr}">${fmt(a.floatMovedOn)}</td><td style="${tdr}">${a.payoutCount}</td><td style="${tdr}">${fmt(a.payoutAmount)}</td><td style="${tdr}">${fmt(a.commission)}</td><td style="${tdr}">${fmt(a.floatHeld)}</td></tr>`)
    .join('');
  return `
  <div style="font-family:-apple-system,Segoe UI,Arial,sans-serif;color:#111">
    <h2 style="margin:0 0 4px">Merchant Float Morning Report</h2>
    <p style="color:#666;margin:0 0 16px">Activity day: ${p.dateStr} (EAT) • Balances as at ${p.generatedAtLabel} • Currency: UGX</p>

    <h3 style="margin:18px 0 6px">1. Phone Money — Right Now</h3>
    <table style="border-collapse:collapse;min-width:420px">
      <tr><td style="${td}">MTN MoMo balance</td><td style="${tdr}">${fmt(p.phone.mtn)}</td></tr>
      <tr><td style="${td}">Airtel Money balance</td><td style="${tdr}">${fmt(p.phone.airtel)}</td></tr>
      <tr><td style="${td}">Cash at hand (verified)</td><td style="${tdr}">${fmt(p.phone.cashAtHand)}</td></tr>
      <tr><td style="padding:6px 10px"><b>Total available now</b></td><td style="${tdr}"><b>${fmt(p.phone.total)}</b></td></tr>
    </table>

    <h3 style="margin:18px 0 6px">2. Merchant Float — Right Now (${p.floats.length} active agents, lowest first)</h3>
    <table style="border-collapse:collapse;min-width:640px">
      <tr>
        <th style="${td};text-align:left">Agent</th>
        <th style="${td};text-align:left">Float phone</th>
        <th style="${td};text-align:right">Can spend now</th>
        <th style="${td};text-align:right">Our cash on their phone</th>
        <th style="${td};text-align:right">We owe them</th>
        <th style="${td};text-align:right">Awaiting their confirmation</th>
      </tr>
      ${floatRows}
      <tr>
        <td style="padding:6px 10px"><b>Totals</b></td>
        <td></td>
        <td style="${tdr}"><b>${fmt(p.floatTotal)}</b></td>
        <td style="${tdr}"><b>${fmt(p.companyCashTotal)}</b></td>
        <td style="${tdr}"><b>${fmt(p.owedTotal)}</b></td>
        <td style="${tdr}"><b>${fmt(p.underReviewTotal)}</b></td>
      </tr>
    </table>
    <p style="color:#666;margin:6px 0 0;font-size:12px">"Awaiting their confirmation" is own money the merchant has not yet attested to. It is not payable yet and is not included in "We owe them". These totals are the same measures shown on the Financial Ops "Money With Merchant Agents" card, from the same source.</p>

    <h3 style="margin:18px 0 6px">3. Yesterday's Agent Activity (${p.dateStr} EAT)</h3>
    <table style="border-collapse:collapse;min-width:640px">
      <tr>
        <th style="${td};text-align:left">Agent</th>
        <th style="${td};text-align:right">Float received</th>
        <th style="${td};text-align:right">Moved on</th>
        <th style="${td};text-align:right">Payouts</th>
        <th style="${td};text-align:right">Paid out</th>
        <th style="${td};text-align:right">Commission</th>
        <th style="${td};text-align:right">Float now</th>
      </tr>
      ${actRows}
      <tr>
        <td style="padding:6px 10px"><b>Total</b></td>
        <td style="${tdr}"><b>${fmt(p.totals.floatReceived)}</b></td>
        <td style="${tdr}"><b>${fmt(p.totals.floatMovedOn)}</b></td>
        <td style="${tdr}"><b>${p.totals.payoutCount}</b></td>
        <td style="${tdr}"><b>${fmt(p.totals.payoutAmount)}</b></td>
        <td style="${tdr}"><b>${fmt(p.totals.commission)}</b></td>
        <td style="${tdr}"><b>${fmt(p.floatTotal)}</b></td>
      </tr>
    </table>
    <p style="color:#666;margin:16px 0 0">"Moved on" is float that left the desk without settling a payout (re-assigned to another user, bucket reclassification, float used for rent). Float received − moved on − paid out explains the closing float. Full report attached as PDF. Scope: active merchant desks only.</p>
  </div>`;
}

function esc(s: string) {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] as string));
}

function renderText(p: Payload) {
  const lines = [
    'Merchant Float Morning Report',
    `Activity day: ${p.dateStr} (EAT) — balances as at ${p.generatedAtLabel}`,
    '',
    '1. PHONE MONEY — RIGHT NOW',
    `  MTN: ${fmt(p.phone.mtn)}`,
    `  Airtel: ${fmt(p.phone.airtel)}`,
    `  Cash at hand: ${fmt(p.phone.cashAtHand)}`,
    `  TOTAL: ${fmt(p.phone.total)}`,
    '',
    `2. MERCHANT FLOAT — RIGHT NOW (${p.floats.length} active agents, lowest first)`,
    ...p.floats.map((f) => `  ${f.name}: can spend ${fmt(f.floatHeld)} | our cash on phone ${fmt(f.companyCash)} | we owe ${fmt(f.owed)} | awaiting their confirmation ${fmt(f.underReview)}`),
    `  TOTALS: can spend ${fmt(p.floatTotal)} | our cash on phones ${fmt(p.companyCashTotal)} | we owe ${fmt(p.owedTotal)} | awaiting their confirmation ${fmt(p.underReviewTotal)}`,
    '',
    `3. YESTERDAY'S AGENT ACTIVITY (${p.dateStr} EAT)`,
    ...p.activity.map(
      (a) =>
        `  ${a.name}: received ${fmt(a.floatReceived)} | moved on ${fmt(a.floatMovedOn)} | payouts ${a.payoutCount} (${fmt(a.payoutAmount)}) | commission ${fmt(a.commission)} | float now ${fmt(a.floatHeld)}`,
    ),
    `  TOTAL: received ${fmt(p.totals.floatReceived)} | moved on ${fmt(p.totals.floatMovedOn)} | payouts ${p.totals.payoutCount} (${fmt(p.totals.payoutAmount)}) | commission ${fmt(p.totals.commission)}`,
  ];
  return lines.join('\n');
}

async function buildPdf(p: Payload): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const PAGE_W = 595.28, PAGE_H = 841.89, M = 44;
  const CW = PAGE_W - M * 2;
  const col = (r: number, g: number, b: number) => rgb(r / 255, g / 255, b / 255);
  const ink = col(24, 24, 27);
  const soft = col(82, 82, 91);
  const muted = col(140, 140, 150);
  const brand = col(88, 28, 135);
  const brandLite = col(243, 240, 250);
  const line = col(228, 228, 234);
  const white = col(255, 255, 255);

  const pages: any[] = [];
  let page = doc.addPage([PAGE_W, PAGE_H]);
  pages.push(page);
  let y = 0;

  const header = (continued = false) => {
    const H = 104;
    page.drawRectangle({ x: 0, y: PAGE_H - H, width: PAGE_W, height: H, color: brand });
    page.drawRectangle({ x: 0, y: PAGE_H - H, width: PAGE_W, height: 3, color: col(196, 168, 255) });
    page.drawText('WELILE  ·  FINANCIAL OPERATIONS', {
      x: M, y: PAGE_H - 34, size: 8.5, font: bold, color: col(214, 197, 245),
    });
    page.drawText(`Merchant Float Morning Report${continued ? ' (cont.)' : ''}`, {
      x: M, y: PAGE_H - 58, size: 18, font: bold, color: white,
    });
    page.drawText(`Activity day ${p.dateStr} (EAT)   ·   Balances as at ${p.generatedAtLabel}`, {
      x: M, y: PAGE_H - 78, size: 9, font, color: col(226, 214, 248),
    });
    page.drawText('Currency UGX   ·   Scope: active merchant desks only', {
      x: M, y: PAGE_H - 92, size: 8.5, font, color: col(200, 184, 232),
    });
    y = PAGE_H - H - 26;
  };
  header();

  const newPage = () => {
    page = doc.addPage([PAGE_W, PAGE_H]);
    pages.push(page);
    header(true);
  };
  let repeatHead: (() => void) | null = null;
  const ensure = (need: number) => {
    if (y - need < M + 34) {
      newPage();
      if (repeatHead) repeatHead();
    }
  };

  const section = (n: string, t: string, sub?: string) => {
    ensure(46);
    page.drawRectangle({ x: M, y: y - 5, width: 3, height: 17, color: brand });
    page.drawText(`${n}.  ${t}`, { x: M + 11, y, size: 12.5, font: bold, color: ink });
    y -= sub ? 14 : 20;
    if (sub) {
      page.drawText(sub, { x: M + 11, y, size: 8.5, font, color: muted });
      y -= 16;
    }
  };

  // KPI cards
  const kpis = [
    { label: 'PHONE MONEY NOW', value: fmt(p.phone.total) },
    { label: 'CAN SPEND NOW', value: fmt(p.floatTotal) },
    { label: 'OUR CASH ON THEIR PHONES', value: fmt(p.companyCashTotal) },
    { label: 'WE OWE THEM', value: fmt(p.owedTotal) },
    { label: 'AWAITING CONFIRMATION', value: fmt(p.underReviewTotal) },
    { label: `PAID OUT ${p.dateStr.slice(5)}`, value: fmt(p.totals.payoutAmount) },
  ];
  const cardW = (CW - 4 * 8) / 5, cardH = 52;
  ensure(cardH + 14);
  kpis.forEach((k, i) => {
    const x = M + i * (cardW + 8);
    page.drawRectangle({
      x, y: y - cardH + 12, width: cardW, height: cardH,
      color: brandLite, borderColor: col(226, 216, 246), borderWidth: 0.8,
    });
    let ls = 6.6;
    while (bold.widthOfTextAtSize(k.label, ls) > cardW - 14 && ls > 4.4) ls -= 0.2;
    page.drawText(k.label, { x: x + 9, y: y - 4, size: ls, font: bold, color: brand });
    let vs = 12.5;
    while (bold.widthOfTextAtSize(k.value, vs) > cardW - 18 && vs > 7) vs -= 0.5;
    page.drawText(k.value, { x: x + 9, y: y - 25, size: vs, font: bold, color: ink });
  });
  y -= cardH + 22;

  type Cell = { text: string; x?: number; right?: number; b?: boolean; size?: number; c?: any };
  const rowH = 16.5;
  const drawCells = (cells: Cell[], size = 9) => {
    for (const c of cells) {
      const f = c.b ? bold : font;
      const s = c.size ?? size;
      const x = c.right != null ? c.right - f.widthOfTextAtSize(c.text, s) : (c.x ?? M);
      page.drawText(c.text, { x, y, size: s, font: f, color: c.c ?? ink });
    }
  };
  const headRow = (cells: Cell[], size = 8.2) => {
    repeatHead = null;
    ensure(rowH + 6);
    page.drawRectangle({ x: M, y: y - 5, width: CW, height: rowH, color: col(38, 20, 60) });
    for (const c of cells) {
      const s = c.size ?? size;
      const x = c.right != null ? c.right - bold.widthOfTextAtSize(c.text, s) : (c.x ?? M);
      page.drawText(c.text.toUpperCase(), { x, y, size: s, font: bold, color: col(226, 214, 248) });
    }
    y -= rowH + 3;
    repeatHead = () => headRow(cells, size);
  };
  const bodyRow = (cells: Cell[], zebra: boolean, size = 9) => {
    ensure(rowH + 4);
    if (zebra) page.drawRectangle({ x: M, y: y - 5, width: CW, height: rowH, color: col(249, 248, 252) });
    drawCells(cells, size);
    page.drawLine({ start: { x: M, y: y - 5.5 }, end: { x: M + CW, y: y - 5.5 }, thickness: 0.4, color: line });
    y -= rowH;
  };
  const totalRow = (cells: Cell[], size = 9) => {
    ensure(rowH + 8);
    page.drawRectangle({ x: M, y: y - 6, width: CW, height: rowH + 3, color: brandLite });
    page.drawLine({ start: { x: M, y: y + 12 }, end: { x: M + CW, y: y + 12 }, thickness: 1, color: brand });
    drawCells(cells.map((c) => ({ ...c, b: true, c: brand })), size);
    y -= rowH + 12;
    repeatHead = null;
  };

  const R = M + CW - 14;
  const L = M + 10;

  // 1. Phone money
  section('1', 'Phone Money — Right Now', 'Company lines and verified cash immediately available for payouts.');
  headRow([{ text: 'Line', x: L }, { text: 'Balance', right: R }]);
  const phoneRows: [string, number][] = [
    ['MTN MoMo', p.phone.mtn],
    ['Airtel Money', p.phone.airtel],
    ['Cash at hand (verified)', p.phone.cashAtHand],
  ];
  phoneRows.forEach(([label, v], i) =>
    bodyRow([{ text: label, x: L }, { text: fmt(v), right: R }], i % 2 === 1),
  );
  totalRow([{ text: 'Total available now', x: L }, { text: fmt(p.phone.total), right: R }]);

  // 2. Merchant float
  section('2', 'Merchant Float — Right Now', `${p.floats.length} active desks, lowest float first. Same measures as the Financial Ops board. "Not confirmed" is own money the merchant has not yet attested to -- not payable, and not inside "We owe them".`);
  // Six numeric-ish columns now, so the x positions are tighter than the
  // five-column layout this table used before `underReview` was added.
  const cSpend = M + 245, cCash = M + 330, cOwed = M + 432;
  headRow([
    { text: 'Agent', x: L },
    { text: 'Float phone', x: M + 120 },
    { text: 'Can spend', right: cSpend },
    { text: 'Our cash', right: cCash },
    { text: 'We owe them', right: cOwed },
    { text: 'Not confirmed', right: R },
  ], 7.6);
  p.floats.forEach((f, i) =>
    bodyRow([
      { text: clip(f.name || '—', 16), x: L },
      { text: clip(f.phone || '—', 13), x: M + 120, c: soft },
      { text: fmt(f.floatHeld), right: cSpend },
      { text: fmt(f.companyCash), right: cCash },
      { text: fmt(f.owed), right: cOwed },
      { text: fmt(f.underReview), right: R },
    ], i % 2 === 1, 8.4),
  );
  totalRow([
    { text: 'Totals', x: L },
    { text: fmt(p.floatTotal), right: cSpend },
    { text: fmt(p.companyCashTotal), right: cCash },
    { text: fmt(p.owedTotal), right: cOwed },
    { text: fmt(p.underReviewTotal), right: R },
  ], 8.4);

  // 3. Activity
  section('3', `Yesterday's Agent Activity`, `Movements on ${p.dateStr} (EAT). Float recd less moved on less paid out explains the closing float. Moved on = float that left the desk without settling a payout.`);
  const cFloatRecd = M + 175, cMoved = M + 250, cCount = M + 272, cPaid = M + 355, cComm = M + 436;
  headRow([
    { text: 'Agent', x: L },
    { text: 'Float recd', right: cFloatRecd },
    { text: 'Moved on', right: cMoved },
    { text: '#', right: cCount },
    { text: 'Paid out', right: cPaid },
    { text: 'Commission', right: cComm },
    { text: 'Float now', right: R },
  ], 7.6);
  p.activity.forEach((a, i) =>
    bodyRow([
      { text: clip(a.name || '—', 19), x: L },
      { text: fmt(a.floatReceived), right: cFloatRecd },
      { text: fmt(a.floatMovedOn), right: cMoved },
      { text: String(a.payoutCount), right: cCount },
      { text: fmt(a.payoutAmount), right: cPaid },
      { text: fmt(a.commission), right: cComm },
      { text: fmt(a.floatHeld), right: R },
    ], i % 2 === 1, 8.4),
  );
  totalRow([
    { text: 'Total', x: L },
    { text: fmt(p.totals.floatReceived), right: cFloatRecd },
    { text: fmt(p.totals.floatMovedOn), right: cMoved },
    { text: String(p.totals.payoutCount), right: cCount },
    { text: fmt(p.totals.payoutAmount), right: cPaid },
    { text: fmt(p.totals.commission), right: cComm },
    { text: fmt(p.floatTotal), right: R },
  ], 8.4);

  // Footer on every page
  pages.forEach((pg, i) => {
    pg.drawLine({ start: { x: M, y: M + 16 }, end: { x: M + CW, y: M + 16 }, thickness: 0.6, color: line });
    pg.drawText('Cash-flow planning report · read-only · excludes deposits, general withdrawals and anomalies', {
      x: M, y: M + 5, size: 7.4, font, color: muted,
    });
    const pn = `Page ${i + 1} of ${pages.length}`;
    pg.drawText(pn, { x: M + CW - font.widthOfTextAtSize(pn, 7.4), y: M + 5, size: 7.4, font, color: muted });
  });

  return await doc.save();
}

function clip(s: string, n: number) {
  const t = String(s ?? '');
  return t.length > n ? t.slice(0, n - 1) + '…' : t;
}
