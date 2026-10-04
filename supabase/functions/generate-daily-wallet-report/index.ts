// Daily Wallet Money Report (v2 — rebuilt 2026-09-25, docs/HANDOVER/131).
// Aggregates via public.compute_wallet_report (v2 payload), stores PDF + XLSX
// to the finops-reports bucket, records a row in public.daily_wallet_reports,
// and emails PDF+XLSX via Mailgun.
//
// v1 reported float WELILE sent to agents as "deposits", only counted wallet
// debits as "payouts", and printed deposits-minus-payouts as a "Closing Wallet
// Balance". v2 separates real money in, cash that actually left, internal
// moves and hand-posted credits, and cross-checks against provider SMS.
//
// Crons: 21:00 UTC = 00:00 EAT (full_day — the just-ended EAT day),
//        03:00 UTC = 06:00 EAT (morning checkpoint — today so far),
//        09:00 UTC = 12:00 EAT (midday checkpoint — today so far).
// Manual POST body: { "window": "full_day|morning|midday|evening",
//                     "date": "YYYY-MM-DD", "recipients": [ ... ], "skipEmail": true }

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.4';
import { PDFDocument, StandardFonts, rgb } from 'https://esm.sh/pdf-lib@1.17.1';
import * as XLSX from 'https://esm.sh/xlsx@0.18.5';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const FROM = 'Welile Reports <reports@welile.com>';
const DEFAULT_RECIPIENTS = [
  'joshwanda17@gmail.com',
  'benjaminmuhanguzi29@gmail.com',
  'benjamin@welile.com',
];

const fmt = (n: number) =>
  `UGX ${Math.round(Number(n) || 0).toLocaleString('en-UG')}`;

type ReportWindow = 'full_day' | 'morning' | 'midday' | 'evening';

const WINDOW_LABEL: Record<ReportWindow, string> = {
  full_day: 'Daily Wallet Money Report',
  morning: 'Wallet Money — Morning Checkpoint (06:00 EAT)',
  midday: 'Wallet Money — Midday Checkpoint (12:00 EAT)',
  evening: 'Wallet Money — Evening Checkpoint (18:00 EAT)',
};

function eatDayToUtcRange(dateStr: string) {
  const startUtc = new Date(`${dateStr}T00:00:00.000+03:00`);
  const endUtc = new Date(startUtc.getTime() + 24 * 60 * 60 * 1000);
  return { startIso: startUtc.toISOString(), endIso: endUtc.toISOString() };
}

function yesterdayEat(): string {
  const nowEatMs = Date.now() + 3 * 60 * 60 * 1000;
  const d = new Date(nowEatMs - 24 * 60 * 60 * 1000);
  return d.toISOString().slice(0, 10);
}

function todaySoFarEatRange(): { startIso: string; endIso: string; dateStr: string } {
  const nowEatMs = Date.now() + 3 * 60 * 60 * 1000;
  const todayEat = new Date(nowEatMs).toISOString().slice(0, 10);
  const { startIso } = eatDayToUtcRange(todayEat);
  return { startIso, endIso: new Date().toISOString(), dateStr: todayEat };
}

function eatNowLabel(): string {
  const d = new Date(Date.now() + 3 * 60 * 60 * 1000);
  return d.toISOString().replace('T', ' ').slice(0, 19) + ' EAT';
}

function eatTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(new Date(iso).getTime() + 3 * 60 * 60 * 1000);
  return d.toISOString().replace('T', ' ').slice(5, 16) + ' EAT';
}

// ─── v2 payload (see migration 20260925090000) ──────────────────────────────
type CA = { count: number; amount: number };
interface ReportV2 {
  version: 2;
  period_start: string;
  period_end: string;
  money_in: Record<'mtn' | 'airtel' | 'bank' | 'cash' | 'gmail_auto' | 'other', CA>;
  money_in_total: number;
  money_in_from_exec_staff: CA;
  manual_credits: Record<'cfo_direct' | 'ledger_adjustment' | 'manual_recovery' | 'unclassified', CA>;
  manual_credits_total: number;
  float_to_agents: {
    deliveries: CA;
    reconciliations: CA;
    recipients: { name: string; count: number; amount: number }[];
  };
  float_to_agents_total: number;
  payouts: {
    agent_paid: { withdrawals: number; principal: number; fees: number; amount: number };
    treasury_bank_transfer: CA;
    treasury_mtn: CA;
    treasury_airtel: CA;
    treasury_other: CA;
    bank_transfer_banks: { bank: string; count: number; amount: number }[];
  };
  payouts_total: number;
  net_movement: number;
  internal_movements: { wallet_to_rent_plan_portfolios: CA; agent_float_used_for_rent: CA };
  provider_sms: {
    in: Record<'mtn' | 'airtel' | 'bank', CA>;
    out: Record<'mtn' | 'airtel' | 'bank', CA & { fees: number }>;
    in_not_linked: CA;
    top_out: { to: string; channel: string; count: number; amount: number }[];
  };
  phone_float_at_end: {
    mtn: { balance: number; as_of: string } | null;
    airtel: { balance: number; as_of: string } | null;
    total: number;
  };
  top_deposits: { name: string; channel: string; count: number; amount: number; exec_staff: boolean }[];
}

// One presentation model shared by the email, text, XLSX and PDF renderers so
// the four outputs can never disagree.
interface Row { label: string; count?: number | string; amount: number; indent?: boolean }
interface Section { title: string; note?: string; rows: Row[]; total?: { label: string; amount: number } }

const CHANNEL_LABEL: Record<string, string> = {
  mtn: 'MTN', airtel: 'Airtel', bank: 'Bank', cash: 'Cash', gmail_auto: 'Gmail auto-credit', other: 'Other',
  mtn_momo: 'MTN', airtel_money: 'Airtel',
};

function buildSections(r: ReportV2): Section[] {
  const n = (x: number) => Number(x) || 0;
  const s: Section[] = [];

  s.push({
    title: '1. Money in — credited to user wallets',
    note: 'Real money received on the MTN / Airtel lines, the bank account or as cash, and credited to a wallet.',
    rows: [
      { label: 'MTN', count: r.money_in.mtn.count, amount: n(r.money_in.mtn.amount) },
      { label: 'Airtel', count: r.money_in.airtel.count, amount: n(r.money_in.airtel.amount) },
      { label: 'Bank', count: r.money_in.bank.count, amount: n(r.money_in.bank.amount) },
      { label: 'Cash', count: r.money_in.cash.count, amount: n(r.money_in.cash.amount) },
      { label: 'Gmail auto-credit', count: r.money_in.gmail_auto.count, amount: n(r.money_in.gmail_auto.amount) },
      { label: 'Other deposit requests', count: r.money_in.other.count, amount: n(r.money_in.other.amount) },
      {
        label: 'of which deposited by executive / finance staff accounts',
        count: r.money_in_from_exec_staff.count,
        amount: n(r.money_in_from_exec_staff.amount),
        indent: true,
      },
    ],
    total: { label: 'Total money in', amount: n(r.money_in_total) },
  });

  const p = r.payouts;
  const bankRows: Row[] = (p.bank_transfer_banks ?? []).map((b) => ({
    label: b.bank, count: b.count, amount: n(b.amount), indent: true,
  }));
  s.push({
    title: '2. Money paid out — cash that actually left',
    note: 'Withdrawals paid by cashout agents from float (counted when paid), plus withdrawals treasury paid directly.',
    rows: [
      { label: 'Paid by agents from float', count: `${p.agent_paid.withdrawals} wd`, amount: n(p.agent_paid.principal) },
      { label: 'Telecom fees on agent payouts', amount: n(p.agent_paid.fees), indent: true },
      { label: 'Bank transfers paid by treasury', count: p.treasury_bank_transfer.count, amount: n(p.treasury_bank_transfer.amount) },
      ...bankRows,
      { label: 'MTN paid by treasury', count: p.treasury_mtn.count, amount: n(p.treasury_mtn.amount) },
      { label: 'Airtel paid by treasury', count: p.treasury_airtel.count, amount: n(p.treasury_airtel.amount) },
      { label: 'Other', count: p.treasury_other.count, amount: n(p.treasury_other.amount) },
    ],
    total: { label: 'Total paid out', amount: n(r.payouts_total) },
  });

  s.push({
    title: '3. Net movement',
    note: 'Money in minus money paid out for the period. This is a movement, not a balance anyone holds.',
    rows: [],
    total: { label: 'Net movement', amount: n(r.net_movement) },
  });

  s.push({
    title: '4. Internal moves — not income, not payouts',
    note: 'WELILE money moved between its own lines, agents and Rent Plan portfolios.',
    rows: [
      { label: 'Float sent to agents', count: r.float_to_agents.deliveries.count, amount: n(r.float_to_agents.deliveries.amount) },
      { label: 'Float reconciliations', count: r.float_to_agents.reconciliations.count, amount: n(r.float_to_agents.reconciliations.amount) },
      ...(r.float_to_agents.recipients ?? []).map((x) => ({ label: x.name, count: x.count, amount: n(x.amount), indent: true })),
      { label: 'Wallet → Rent Plan portfolios', count: r.internal_movements.wallet_to_rent_plan_portfolios.count, amount: n(r.internal_movements.wallet_to_rent_plan_portfolios.amount) },
      { label: 'Agent float used for rent collection', count: r.internal_movements.agent_float_used_for_rent.count, amount: n(r.internal_movements.agent_float_used_for_rent.amount) },
    ],
  });

  s.push({
    title: '5. Manual credits — posted by hand',
    note: 'Credits a staff member posted. They are not new money by themselves.',
    rows: [
      { label: 'CFO direct credit', count: r.manual_credits.cfo_direct.count, amount: n(r.manual_credits.cfo_direct.amount) },
      { label: 'Ledger adjustment', count: r.manual_credits.ledger_adjustment.count, amount: n(r.manual_credits.ledger_adjustment.amount) },
      { label: 'Manual recovery', count: r.manual_credits.manual_recovery.count, amount: n(r.manual_credits.manual_recovery.amount) },
      { label: 'Unclassified', count: r.manual_credits.unclassified.count, amount: n(r.manual_credits.unclassified.amount) },
    ],
    total: { label: 'Total manual credits', amount: n(r.manual_credits_total) },
  });

  const ps = r.provider_sms;
  s.push({
    title: '6. Cross-check — provider SMS on company lines',
    note: 'What MTN, Airtel and the bank reported, independent of the ledger.',
    rows: [
      { label: 'In — MTN', count: ps.in.mtn.count, amount: n(ps.in.mtn.amount) },
      { label: 'In — Airtel', count: ps.in.airtel.count, amount: n(ps.in.airtel.amount) },
      { label: 'In — Bank', count: ps.in.bank.count, amount: n(ps.in.bank.amount) },
      { label: 'In, not linked to any deposit', count: ps.in_not_linked.count, amount: n(ps.in_not_linked.amount), indent: true },
      { label: 'Out — MTN', count: ps.out.mtn.count, amount: n(ps.out.mtn.amount) },
      { label: 'Out — Airtel', count: ps.out.airtel.count, amount: n(ps.out.airtel.amount) },
      { label: 'Out — Bank', count: ps.out.bank.count, amount: n(ps.out.bank.amount) },
      { label: 'Telecom charges on outgoing', amount: n(ps.out.mtn.fees) + n(ps.out.airtel.fees) + n(ps.out.bank.fees), indent: true },
      ...(ps.top_out ?? []).map((x) => ({
        label: `→ ${x.to} (${CHANNEL_LABEL[x.channel] ?? x.channel})`, count: x.count, amount: n(x.amount), indent: true,
      })),
    ],
  });

  const pf = r.phone_float_at_end;
  s.push({
    title: '7. Phone line float at end of period',
    note: 'Last balance reported by each provider SMS at or before the period end.',
    rows: [
      { label: `MTN (as of ${eatTime(pf.mtn?.as_of)})`, amount: n(pf.mtn?.balance ?? 0) },
      { label: `Airtel (as of ${eatTime(pf.airtel?.as_of)})`, amount: n(pf.airtel?.balance ?? 0) },
    ],
    total: { label: 'Total phone float', amount: n(pf.total) },
  });

  s.push({
    title: '8. Largest deposits',
    rows: (r.top_deposits ?? []).map((d) => ({
      label: `${d.name} (${CHANNEL_LABEL[d.channel] ?? d.channel})${d.exec_staff ? ' — staff account' : ''}`,
      count: d.count,
      amount: n(d.amount),
    })),
  });

  return s;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  let windowParam: ReportWindow = 'full_day';
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
    windowParam =
      body?.window === 'morning' || body?.window === 'midday' || body?.window === 'evening'
        ? body.window
        : 'full_day';

    let startIso: string;
    let endIso: string;
    let dateStr: string;
    if (windowParam === 'full_day') {
      dateStr =
        typeof body?.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(body.date)
          ? body.date
          : yesterdayEat();
      ({ startIso, endIso } = eatDayToUtcRange(dateStr));
    } else {
      ({ startIso, endIso, dateStr } = todaySoFarEatRange());
    }
    const title = WINDOW_LABEL[windowParam];
    const recipients: string[] =
      Array.isArray(body?.recipients) && body.recipients.length > 0
        ? body.recipients.filter((r: unknown) => typeof r === 'string' && (r as string).includes('@'))
        : DEFAULT_RECIPIENTS;
    const skipEmail = body?.skipEmail === true;

    const supabase = createClient(supabaseUrl, serviceKey);

    const { data: rpcData, error: rpcErr } = await supabase.rpc('compute_wallet_report', {
      _start: startIso,
      _end: endIso,
    });
    if (rpcErr) throw rpcErr;
    const r = rpcData as ReportV2;
    if (!r || r.version !== 2) {
      // The edge function and the RPC ship together; refuse to render a v1
      // payload with v2 labels rather than print misleading numbers.
      throw new Error(`compute_wallet_report returned version ${(r as any)?.version ?? 1}; expected 2 — apply migration 20260925090000`);
    }

    const sections = buildSections(r);
    const generatedAtLabel = eatNowLabel();
    const pdfBytes = await buildPdf({ dateStr, generatedAtLabel, sections, title });
    const xlsxBytes = buildXlsx({ dateStr, generatedAtLabel, sections, title });

    const baseName =
      windowParam === 'full_day'
        ? `welile-wallet-money-${dateStr}`
        : `welile-wallet-money-${dateStr}-${windowParam}`;
    const pdfPath = `${dateStr}/${baseName}.pdf`;
    const xlsxPath = `${dateStr}/${baseName}.xlsx`;

    const up1 = await supabase.storage.from('finops-reports').upload(pdfPath, pdfBytes, {
      contentType: 'application/pdf', upsert: true,
    });
    if (up1.error) throw up1.error;
    const up2 = await supabase.storage.from('finops-reports').upload(xlsxPath, xlsxBytes, {
      contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      upsert: true,
    });
    if (up2.error) throw up2.error;

    const row = {
      report_date: dateStr,
      run_window: windowParam,
      period_start: r.period_start,
      period_end: r.period_end,
      deposits_by_source: r.money_in,
      payouts_by_channel: {
        agent_paid: { count: r.payouts.agent_paid.withdrawals, amount: r.payouts.agent_paid.amount },
        treasury_bank_transfer: r.payouts.treasury_bank_transfer,
        treasury_mtn: r.payouts.treasury_mtn,
        treasury_airtel: r.payouts.treasury_airtel,
        treasury_other: r.payouts.treasury_other,
      },
      total_deposited: r.money_in_total,
      total_paid_out: r.payouts_total,
      closing_balance: r.net_movement,
      report: r,
      report_version: 2,
      pdf_path: pdfPath,
      xlsx_path: xlsxPath,
      generated_by: 'system',
      generated_at: new Date().toISOString(),
      email_recipients: skipEmail ? [] : recipients,
      email_sent_at: null as string | null,
    };
    const { data: saved, error: saveErr } = await supabase
      .from('daily_wallet_reports')
      .upsert(row, { onConflict: 'report_date,run_window' })
      .select()
      .single();
    if (saveErr) throw saveErr;

    if (!skipEmail) {
      const form = new FormData();
      form.set('from', FROM);
      recipients.forEach((to) => form.append('to', to));
      form.set('subject', `${title} – ${dateStr}`);
      form.set('text', renderEmailText(dateStr, sections, title));
      form.set('html', renderEmailHtml(dateStr, sections, title));
      form.set('o:tag', 'daily-wallet-summary');
      form.append('attachment', new Blob([pdfBytes], { type: 'application/pdf' }), `${baseName}.pdf`);
      form.append(
        'attachment',
        new Blob([xlsxBytes], {
          type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        }),
        `${baseName}.xlsx`,
      );

      const mgRes = await fetch(`${mailgunBaseUrl}/v3/${mailgunDomain}/messages`, {
        method: 'POST',
        headers: { Authorization: 'Basic ' + btoa(`api:${mailgunApiKey}`) },
        body: form,
      });
      const mgText = await mgRes.text();
      if (!mgRes.ok) {
        console.error('Mailgun send failed', mgRes.status, mgText);
        return new Response(
          JSON.stringify({ ok: true, date: dateStr, saved: saved?.id, emailError: mgText, emailStatus: mgRes.status }),
          { headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
        );
      }
      await supabase
        .from('daily_wallet_reports')
        .update({ email_sent_at: new Date().toISOString() })
        .eq('id', saved.id);
    }

    return new Response(
      JSON.stringify({
        ok: true,
        date: dateStr,
        window: windowParam,
        id: saved.id,
        money_in_total: r.money_in_total,
        payouts_total: r.payouts_total,
        net_movement: r.net_movement,
      }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    );
  } catch (err) {
    console.error('generate-daily-wallet-report failed', windowParam, err);
    try {
      const supabaseUrl = Deno.env.get('SUPABASE_URL');
      const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
      if (supabaseUrl && serviceKey) {
        const admin = createClient(supabaseUrl, serviceKey);
        await admin.from('system_events').insert({
          event_type: 'report_generation_failed',
          metadata: {
            report: 'daily_wallet_summary',
            window: windowParam,
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

const esc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function renderEmailHtml(dateStr: string, sections: Section[], title: string) {
  const body = sections.map((sec) => {
    const rows = sec.rows.map((r) => `
      <tr>
        <td style="padding:3px 12px 3px ${r.indent ? 28 : 12}px;${r.indent ? 'color:#555' : ''}">${esc(r.label)}</td>
        <td style="padding:3px 12px;text-align:right;color:#666">${r.count ?? ''}</td>
        <td style="padding:3px 12px;text-align:right;${r.indent ? 'color:#555' : ''}">${fmt(r.amount)}</td>
      </tr>`).join('');
    const total = sec.total
      ? `<tr><td style="padding:6px 12px;border-top:1px solid #ccc"><b>${esc(sec.total.label)}</b></td><td style="border-top:1px solid #ccc"></td><td style="padding:6px 12px;border-top:1px solid #ccc;text-align:right"><b>${fmt(sec.total.amount)}</b></td></tr>`
      : '';
    return `
      <h3 style="margin:18px 0 2px">${esc(sec.title)}</h3>
      ${sec.note ? `<p style="color:#666;margin:0 0 6px;font-size:12px">${esc(sec.note)}</p>` : ''}
      <table style="border-collapse:collapse;min-width:460px;font-size:13px">${rows}${total}</table>`;
  }).join('');
  return `
  <div style="font-family:-apple-system,Segoe UI,Arial,sans-serif;color:#111">
    <h2 style="margin:0 0 4px">${esc(title)}</h2>
    <p style="color:#666;margin:0 0 8px">Reporting Period: ${dateStr} (EAT) • Currency: UGX</p>
    ${body}
    <p style="color:#666;margin:18px 0 0;font-size:12px">PDF and Excel attached. Sections 1–5 come from the ledger; sections 6–7 come from provider SMS.</p>
  </div>`;
}

function renderEmailText(dateStr: string, sections: Section[], title: string) {
  const lines = [title, `Reporting Period: ${dateStr} (EAT)`, ''];
  for (const sec of sections) {
    lines.push(sec.title);
    for (const r of sec.rows) {
      lines.push(`${r.indent ? '    ' : '  '}${r.label}${r.count !== undefined ? ` (${r.count})` : ''}: ${fmt(r.amount)}`);
    }
    if (sec.total) lines.push(`  ${sec.total.label}: ${fmt(sec.total.amount)}`);
    lines.push('');
  }
  lines.push('PDF and Excel attached.');
  return lines.join('\n');
}

function buildXlsx(a: { dateStr: string; generatedAtLabel: string; sections: Section[]; title: string }): Uint8Array {
  const { dateStr, generatedAtLabel, sections, title } = a;
  const rows: (string | number)[][] = [];
  rows.push([title]);
  rows.push(['Reporting Period', `${dateStr} (EAT)`]);
  rows.push(['Generated At', generatedAtLabel]);
  rows.push(['Generated By', 'System']);
  rows.push(['Currency', 'UGX']);
  for (const sec of sections) {
    rows.push([]);
    rows.push([sec.title, 'Count', 'Amount (UGX)']);
    if (sec.note) rows.push([sec.note]);
    for (const r of sec.rows) {
      rows.push([`${r.indent ? '    ' : ''}${r.label}`, r.count ?? '', Math.round(r.amount)]);
    }
    if (sec.total) rows.push([sec.total.label, '', Math.round(sec.total.amount)]);
  }
  const ws = XLSX.utils.aoa_to_sheet(rows);
  ws['!cols'] = [{ wch: 56 }, { wch: 12 }, { wch: 20 }];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Summary');
  const out = XLSX.write(wb, { bookType: 'xlsx', type: 'array' }) as ArrayBuffer;
  return new Uint8Array(out);
}

async function buildPdf(a: { dateStr: string; generatedAtLabel: string; sections: Section[]; title: string }): Promise<Uint8Array> {
  const { dateStr, generatedAtLabel, sections, title } = a;
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const PAGE_W = 595.28, PAGE_H = 841.89;
  const margin = 40;
  const col = (r: number, g: number, b: number) => rgb(r / 255, g / 255, b / 255);
  const ink = col(17, 17, 17);
  const muted = col(110, 110, 120);
  const brand: [number, number, number] = [88, 28, 135];
  // Helvetica in pdf-lib is WinAnsi-only; swap glyphs it cannot encode.
  const safe = (s: string) => s.replace(/→/g, '->').replace(/[—–]/g, '-').replace(/[^\x20-\x7E\xA0-\xFF]/g, '?');

  let page = doc.addPage([PAGE_W, PAGE_H]);
  page.drawRectangle({ x: 0, y: PAGE_H - 100, width: PAGE_W, height: 100, color: col(...brand) });
  page.drawText('WELILE - Financial Operations', { x: margin, y: PAGE_H - 34, size: 10, font: bold, color: col(255, 255, 255) });
  page.drawText(safe(title), { x: margin, y: PAGE_H - 58, size: 17, font: bold, color: col(255, 255, 255) });
  page.drawText(`Reporting Period: ${dateStr} (EAT)`, { x: margin, y: PAGE_H - 78, size: 10, font, color: col(230, 220, 245) });
  page.drawText(`Generated: ${generatedAtLabel}  |  Currency: UGX  |  Generated By: System`, {
    x: margin, y: PAGE_H - 92, size: 8.5, font, color: col(230, 220, 245),
  });
  let y = PAGE_H - 128;

  const ensure = (h: number) => {
    if (y - h < margin) {
      page = doc.addPage([PAGE_W, PAGE_H]);
      y = PAGE_H - margin;
    }
  };
  const right = (s: string, f: typeof font, size: number) => PAGE_W - margin - f.widthOfTextAtSize(s, size) - 4;

  for (const sec of sections) {
    ensure(44);
    page.drawText(safe(sec.title), { x: margin, y, size: 11.5, font: bold, color: ink });
    y -= 14;
    if (sec.note) {
      page.drawText(safe(sec.note), { x: margin, y, size: 8, font, color: muted, maxWidth: PAGE_W - margin * 2 });
      y -= 14;
    }
    for (const r of sec.rows) {
      ensure(14);
      const x = margin + (r.indent ? 20 : 6);
      const c = r.indent ? muted : ink;
      const label = safe(r.label);
      page.drawText(label.length > 70 ? label.slice(0, 69) + '.' : label, { x, y, size: 9, font, color: c });
      if (r.count !== undefined) page.drawText(String(r.count), { x: margin + 360, y, size: 9, font, color: muted });
      const amt = fmt(r.amount);
      page.drawText(amt, { x: right(amt, font, 9), y, size: 9, font, color: c });
      y -= 13;
    }
    if (sec.total) {
      ensure(22);
      page.drawLine({ start: { x: margin, y: y + 9 }, end: { x: PAGE_W - margin, y: y + 9 }, thickness: 0.5, color: col(180, 180, 190) });
      page.drawText(safe(sec.total.label), { x: margin + 6, y, size: 10, font: bold, color: ink });
      const t = fmt(sec.total.amount);
      page.drawText(t, { x: right(t, bold, 10), y, size: 10, font: bold, color: ink });
      y -= 20;
    }
    y -= 10;
  }

  ensure(20);
  page.drawText('Sections 1-5: immutable financial ledger. Sections 6-7: provider SMS on company lines.', {
    x: margin, y, size: 8, font, color: muted,
  });

  return await doc.save();
}
