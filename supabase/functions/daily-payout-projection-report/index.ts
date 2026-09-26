// Daily Payout Projection Report
// Every evening, emails the CEO (CC Josh) everything scheduled or queued to
// leave the company on the next payout day: Supporter Returns, landlord payouts
// and withdrawals. Returns are not paid on Saturday or Sunday, so the Friday,
// Saturday and Sunday emails all plan Monday and cover every Returns date since
// the last payout day (Sat-Mon). Compounding Returns are listed but never
// counted as cash. A cushion line (default 10%) is added on top of the base.
// All figures come from get_next_day_payout_projection — this function only
// formats and sends.
//
// Invocation:
//   POST /daily-payout-projection-report                  → tomorrow (Kampala), default recipients (cron)
//   POST body: { "date": "YYYY-MM-DD", "from": "YYYY-MM-DD", "cushion_pct": 10,
//                "to": [...], "cc": [...], "dry_run": true }
//     - "date", "from", "cushion_pct", "to", "cc" and "dry_run" are honoured only for a signed-in
//       executive (CEO/CFO/COO/manager/super_admin). Anyone else gets the
//       default run, so the public anon key can't redirect payout details
//       to an arbitrary inbox or read them back.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.4';
import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from 'https://esm.sh/pdf-lib@1.17.1';

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

function shortDate(iso: string) {
  const d = new Date(`${iso}T12:00:00Z`);
  return d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });
}

/** "Returns due Sat 26 Sep – Mon 28 Sep" when the range spans more than one day. */
function rangeLabel(p: Json) {
  return Number(p.days) > 1 ? `Returns due ${shortDate(p.from)} – ${shortDate(p.date)}` : '';
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
  const cushionPct = Number(p.plan?.cushion_pct ?? 0);
  const cushion = Number(p.plan?.cushion ?? 0);
  const planTotal = grandTotal + cushion;
  const range = rangeLabel(p);
  const byDay: Json[] = p.roi.by_day ?? [];

  const flags: string[] = [];
  for (const r of cashRoi) {
    if (r.early_first_payout) {
      flags.push(`${r.partner_name} (${r.portfolio_code}) — ${ugx(r.amount)} is due only ${
        Math.round((Date.parse(`${r.due_date ?? date}T00:00:00Z`) - Date.parse(`${r.funded_on}T00:00:00Z`)) / 86400000)
      } day(s) after funding on ${r.funded_on}. Check the payout date before paying.`);
    }
    if (r.channel === 'DESTINATION NOT SET' || !r.destination_number) {
      flags.push(`${r.partner_name} (${r.portfolio_code}) — no payout account/number on file.`);
    }
  }

  const t: string[] = [];
  const h: string[] = [];
  const line = '━━━━━━━━━━━━━━━━━━';

  t.push(`WELILE PAYOUTS PROJECTION — ${prettyDate(date).toUpperCase()}`);
  if (range) t.push(range);
  t.push(line);
  t.push(`TOTAL CASH OUT: ${ugx(grandTotal)}`);
  t.push(`  Supporter Returns: ${p.roi.cash_count} — ${ugx(p.roi.cash_total)}`);
  t.push(`  Landlord payouts: ${p.landlord.count} — ${ugx(p.landlord.total)}`);
  t.push(`  Wallet withdrawals: ${p.withdrawals.count} — ${ugx(p.withdrawals.total)}`);
  t.push(`  Partner capital withdrawals: ${p.partner_capital.count} — ${ugx(p.partner_capital.total)}`);
  if (cushion > 0) {
    t.push(`Cushion (${cushionPct}%): ${ugx(cushion)}`);
    t.push(`HAVE READY: ${ugx(planTotal)}`);
  }
  t.push(`Compounding (no cash): ${p.roi.compounding_count} — ${ugx(p.roi.compounding_total)}`, line);
  if (byDay.length > 1) {
    t.push('SUPPORTER RETURNS BY DUE DATE');
    byDay.forEach((d) => t.push(`  ${shortDate(d.due_date)}: cash ${d.cash_count} — ${ugx(d.cash_total)} | compounding ${d.compounding_count} — ${ugx(d.compounding_total)}`));
    t.push(line);
  }

  h.push(`<div style="font-family:Arial,Helvetica,sans-serif;max-width:720px;color:#111">`);
  h.push(`<h2 style="margin:0 0 4px">Welile Payouts Projection</h2>`);
  h.push(`<div style="color:#555;margin-bottom:16px">${esc(prettyDate(date))}${range ? ` &middot; ${esc(range)}` : ''}</div>`);
  h.push(`<table cellpadding="6" style="border-collapse:collapse;width:100%;margin-bottom:16px;border:1px solid #ddd">`);
  const sumRow = (label: string, count: unknown, amt: unknown, bold = false) =>
    h.push(`<tr style="${bold ? 'font-weight:bold;background:#f3f4f6' : ''}"><td style="border-bottom:1px solid #eee">${esc(label)}</td><td align="right" style="border-bottom:1px solid #eee">${esc(count)}</td><td align="right" style="border-bottom:1px solid #eee">${esc(ugx(amt))}</td></tr>`);
  sumRow('Supporter Returns (cash)', p.roi.cash_count, p.roi.cash_total);
  sumRow('Landlord payouts', p.landlord.count, p.landlord.total);
  sumRow('Wallet withdrawals', p.withdrawals.count, p.withdrawals.total);
  sumRow('Partner capital withdrawals', p.partner_capital.count, p.partner_capital.total);
  sumRow('TOTAL CASH OUT', '', grandTotal, true);
  if (cushion > 0) {
    sumRow(`Cushion (${cushionPct}%)`, '', cushion);
    sumRow('HAVE READY', '', planTotal, true);
  }
  sumRow('Compounding — reinvested, no cash', p.roi.compounding_count, p.roi.compounding_total);
  h.push(`</table>`);
  if (byDay.length > 1) {
    const td = (v: unknown, right = true) => `<td ${right ? 'align="right" ' : ''}style="border-bottom:1px solid #eee">${esc(v)}</td>`;
    h.push(`<h3 style="margin:18px 0 6px">Supporter Returns by due date</h3>`);
    h.push(`<table cellpadding="5" style="border-collapse:collapse;width:100%;font-size:13px;margin-bottom:16px">`);
    h.push(`<tr style="background:#f3f4f6"><th align="left">Due</th><th align="right">Cash payouts</th><th align="right">Cash amount</th><th align="right">Compounding (no cash)</th></tr>`);
    byDay.forEach((d) => h.push(`<tr>${td(shortDate(d.due_date), false)}${td(d.cash_count)}${td(ugx(d.cash_total))}${td(`${d.compounding_count} — ${ugx(d.compounding_total)}`)}</tr>`));
    h.push(`</table>`);
  }

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
      t.push(`${n}. ${r.partner_name} — ${ugx(r.amount)}${range ? ` (due ${shortDate(r.due_date)})` : ''}`);
      if (r.destination_name) t.push(`   Name: ${r.destination_name}`);
      t.push(`   ${channel.includes('MOBILE') ? 'No' : 'A/C'}: ${r.destination_number ?? 'NOT SET'}`);
    }
    table(`${channel} — ${items.length} — ${ugx(sub)}`,
      range ? ['Supporter', 'Due', 'Account name', 'A/C / No.', 'Amount'] : ['Supporter', 'Account name', 'A/C / No.', 'Amount'],
      items.map((r) => range
        ? [r.partner_name, shortDate(r.due_date), r.destination_name ?? '', r.destination_number ?? 'NOT SET', ugx(r.amount)]
        : [r.partner_name, r.destination_name ?? '', r.destination_number ?? 'NOT SET', ugx(r.amount)]));
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
    subject: `Welile Payouts Projection — ${prettyDate(date)}${range ? ` (${range})` : ''} — ${ugx(cushion > 0 ? planTotal : grandTotal)}${cushion > 0 ? ` incl. ${cushionPct}% cushion` : ''}`,
    text: t.join('\n'),
    html: h.join('\n'),
    grandTotal,
    planTotal,
    flags,
  };
}

// ---- Attachments --------------------------------------------------------
// One flat row per payment, shared by the PDF tables and the CSV so the two
// attachments list exactly the same items.
interface PayRow { due?: string; section: string; channel: string; name: string; accountName: string; number: string; reference: string; amount: number; note: string; warn: boolean }

function payRows(p: Json): PayRow[] {
  const rows: PayRow[] = [];
  for (const r of p.roi.items as Json[]) {
    rows.push({
      due: r.due_date,
      section: r.compounding ? 'Compounding (no cash)' : 'Supporter Returns',
      channel: r.compounding ? '' : r.channel, name: r.partner_name, accountName: r.destination_name ?? '',
      number: r.compounding ? '' : (r.destination_number ?? 'NOT SET'), reference: r.portfolio_code,
      amount: Number(r.amount),
      note: r.early_first_payout ? `Funded ${r.funded_on} - check` : (!r.compounding && !r.destination_number ? 'No account' : ''),
      warn: !r.compounding && (r.early_first_payout || !r.destination_number),
    });
  }
  for (const l of p.landlord.items as Json[]) {
    rows.push({
      section: 'Landlord payouts', channel: l.provider ? `${String(l.provider).toUpperCase()} MOBILE MONEY` : 'MOBILE MONEY',
      name: l.landlord_name ?? 'Unknown landlord', accountName: '', number: l.landlord_phone ?? '',
      reference: String(l.id).slice(0, 8), amount: Number(l.amount),
      note: l.source === 'funded_rent_plan' ? 'Funded, not started' : 'Awaiting merchant',
      warn: false,
    });
  }
  for (const w of p.withdrawals.items as Json[]) {
    rows.push({
      section: 'Wallet withdrawals', channel: w.channel, name: w.name ?? 'Unknown', accountName: w.destination_name ?? '',
      number: w.destination_number ?? '', reference: String(w.id).slice(0, 8), amount: Number(w.amount),
      note: w.status === 'pending' ? '' : w.status, warn: false,
    });
  }
  for (const c of p.partner_capital.items as Json[]) {
    rows.push({
      section: 'Partner capital withdrawals', channel: '', name: c.name ?? 'Unknown', accountName: '', number: '',
      reference: String(c.id).slice(0, 8), amount: Number(c.amount), note: `Eligible ${c.earliest_process_date}`, warn: false,
    });
  }
  return rows;
}

function buildCsv(p: Json): string {
  const q = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const lines = [['Due date', 'Section', 'Bank / Network', 'Name', 'Account name', 'A/C / Phone', 'Reference', 'Amount (UGX)', 'Note'].map(q).join(',')];
  for (const r of payRows(p)) {
    // ="0781..." keeps Excel from stripping leading zeros off phone / account numbers.
    lines.push([r.due ?? p.date, r.section, r.channel, r.name, r.accountName, r.number ? `="${r.number}"` : '', r.reference, r.amount, r.note]
      .map((v, i) => (i === 5 && String(v).startsWith('=') ? String(v) : q(v))).join(','));
  }
  return '﻿' + lines.join('\r\n');
}

// Standard PDF fonts are WinAnsi only — strip anything they cannot encode.
function pdfSafe(s: unknown) {
  return String(s ?? '').replace(/[–—]/g, '-').replace(/[^\x20-\x7E -ÿ]/g, '');
}

async function buildPdf(p: Json, grandTotal: number, flags: string[]): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const W = 841.89, H = 595.28, M = 32; // A4 landscape
  const ink = rgb(0.07, 0.07, 0.09), muted = rgb(0.42, 0.42, 0.47), brand = rgb(0.33, 0.13, 0.55), line = rgb(0.88, 0.88, 0.9);
  let page: PDFPage = doc.addPage([W, H]);
  let y = H - M;
  const pages: PDFPage[] = [page];

  const text = (s: string, x: number, yy: number, size = 9, f: PDFFont = font, color = ink) =>
    page.drawText(pdfSafe(s), { x, y: yy, size, font: f, color });
  const fit = (s: string, width: number, size: number, f: PDFFont) => {
    let t = pdfSafe(s);
    while (t.length > 1 && f.widthOfTextAtSize(t, size) > width) t = t.slice(0, -2) + '.';
    return t;
  };
  const newPage = () => { page = doc.addPage([W, H]); pages.push(page); y = H - M; };
  const ensure = (h: number) => { if (y - h < M + 20) newPage(); };

  // Header band
  page.drawRectangle({ x: 0, y: H - 78, width: W, height: 78, color: brand });
  text('WELILE', M, H - 30, 10, bold, rgb(1, 1, 1));
  text(`Payouts Projection - ${prettyDate(p.date)}${rangeLabel(p) ? ` (${rangeLabel(p)})` : ''}`, M, H - 52, 17, bold, rgb(1, 1, 1));
  text(`Generated ${new Date(p.generated_at).toISOString().replace('T', ' ').slice(0, 16)} UTC`, M, H - 68, 8, font, rgb(0.9, 0.86, 0.96));
  y = H - 100;

  // Summary
  const summary: [string, unknown, number][] = [
    ['Supporter Returns (cash)', p.roi.cash_count, Number(p.roi.cash_total)],
    ['Landlord payouts (queued)', p.landlord.count, Number(p.landlord.total)],
    ['Wallet withdrawals (open)', p.withdrawals.count, Number(p.withdrawals.total)],
    ['Partner capital withdrawals', p.partner_capital.count, Number(p.partner_capital.total)],
  ];
  for (const [label, count, amt] of summary) {
    text(label, M, y, 10); text(String(count), M + 260, y, 10); text(ugx(amt), M + 420 - font.widthOfTextAtSize(ugx(amt), 10), y, 10);
    y -= 15;
  }
  page.drawLine({ start: { x: M, y: y + 10 }, end: { x: M + 420, y: y + 10 }, thickness: 0.6, color: line });
  text('TOTAL CASH OUT', M, y - 4, 11, bold); text(ugx(grandTotal), M + 420 - bold.widthOfTextAtSize(ugx(grandTotal), 11), y - 4, 11, bold);
  y -= 20;
  if (Number(p.plan?.cushion ?? 0) > 0) {
    const c = Number(p.plan.cushion), tot = grandTotal + c;
    text(`Cushion (${p.plan.cushion_pct}%)`, M, y, 10); text(ugx(c), M + 420 - font.widthOfTextAtSize(ugx(c), 10), y, 10);
    y -= 15;
    text('HAVE READY', M, y, 11, bold); text(ugx(tot), M + 420 - bold.widthOfTextAtSize(ugx(tot), 11), y, 11, bold);
    y -= 20;
  }
  text(`Compounding - reinvested, no cash: ${p.roi.compounding_count} - ${ugx(p.roi.compounding_total)}`, M, y, 9, font, muted);
  y -= 22;

  if (flags.length) {
    ensure(18 + flags.length * 12);
    text('CHECK BEFORE PAYING', M, y, 10, bold, rgb(0.72, 0.33, 0.04)); y -= 14;
    for (const f of flags) { ensure(12); text(`- ${fit(f, W - 2 * M - 10, 8.5, font)}`, M + 4, y, 8.5); y -= 12; }
    y -= 8;
  }

  // Tables, one per section, grouped by bank / network
  const cols = [
    { h: '#', w: 24 }, { h: 'Name', w: 180 }, { h: 'Account name', w: 170 }, { h: 'A/C / Phone', w: 105 },
    { h: 'Reference', w: 80 }, { h: 'Note', w: 129 }, { h: 'Amount (UGX)', w: 84, right: true },
  ];
  const header = () => {
    page.drawRectangle({ x: M, y: y - 4, width: W - 2 * M, height: 15, color: rgb(0.95, 0.95, 0.97) });
    let x = M + 3;
    for (const c of cols) { text(c.h, (c as any).right ? x + c.w - bold.widthOfTextAtSize(c.h, 8) - 4 : x, y, 8, bold, muted); x += c.w; }
    y -= 16;
  };
  const rows = payRows(p);
  const sections = ['Supporter Returns', 'Landlord payouts', 'Wallet withdrawals', 'Partner capital withdrawals', 'Compounding (no cash)'];
  let n = 0;
  for (const section of sections) {
    const inSection = rows.filter((r) => r.section === section);
    ensure(50);
    const secTotal = inSection.reduce((s, r) => s + r.amount, 0);
    text(`${section.toUpperCase()} - ${inSection.length} - ${ugx(secTotal)}`, M, y, 11, bold, brand); y -= 16;
    if (!inSection.length) { text('None.', M, y, 9, font, muted); y -= 20; continue; }
    for (const [channel, items] of groupBy(inSection, (r) => r.channel || ' ')) {
      ensure(40);
      if (channel.trim()) {
        text(`${channel} - ${items.length} - ${ugx(items.reduce((s, r) => s + r.amount, 0))}`, M, y, 9, bold); y -= 14;
      }
      header();
      for (const r of items) {
        ensure(14); if (y > H - M - 2) header();
        n += 1;
        const vals = [String(n), r.name, r.accountName, r.number, r.reference, r.note, ugx(r.amount).replace('UGX ', '')];
        let x = M + 3;
        cols.forEach((c, i) => {
          const v = fit(vals[i], c.w - 6, 8.5, font);
          text(v, (c as any).right ? x + c.w - font.widthOfTextAtSize(v, 8.5) - 4 : x, y, 8.5, font, r.warn && i === 5 ? rgb(0.72, 0.33, 0.04) : i === 5 ? muted : ink);
          x += c.w;
        });
        page.drawLine({ start: { x: M, y: y - 4 }, end: { x: W - M, y: y - 4 }, thickness: 0.3, color: line });
        y -= 14;
      }
      y -= 8;
    }
    y -= 6;
  }

  // Backlog
  const b = p.backlog;
  ensure(60);
  text('OLDER BACKLOG - not in the totals above', M, y, 10, bold, muted); y -= 14;
  for (const l of [
    `Supporter Returns with a payout date already past: ${b.roi_past_due.count} (${ugx(b.roi_past_due.amount)})`,
    `Wallet withdrawals approved more than 7 days ago: ${b.withdrawals_approved_stale.count} (${ugx(b.withdrawals_approved_stale.amount)})`,
    `Failed landlord payouts: ${b.landlord_payouts_failed.count} (${ugx(b.landlord_payouts_failed.amount)})`,
  ]) { text(`- ${l}`, M + 4, y, 8.5, font, muted); y -= 12; }

  pages.forEach((pg, i) => {
    const s = `Page ${i + 1} of ${pages.length}`;
    pg.drawText('Welile - confidential payout schedule', { x: M, y: 16, size: 7.5, font, color: muted });
    pg.drawText(s, { x: W - M - font.widthOfTextAtSize(s, 7.5), y: 16, size: 7.5, font, color: muted });
  });
  return await doc.save();
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
    const wantsOverrides = body.date || body.from || body.cushion_pct !== undefined || body.to || body.cc || body.dry_run;

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

    const isoDate = (v: unknown) => (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null);
    const date = isExec ? isoDate(body.date) : null;
    const from = isExec ? isoDate(body.from) : null;
    const cushionPct = isExec && body.cushion_pct !== undefined && Number.isFinite(Number(body.cushion_pct))
      ? Math.max(0, Number(body.cushion_pct)) : 10;
    const to = (isExec && validEmails(body.to)) || DEFAULT_TO;
    const cc = isExec && body.cc !== undefined ? (validEmails(body.cc) ?? []) : DEFAULT_CC;

    const admin = createClient(supabaseUrl, serviceKey);
    const { data: projection, error } = await admin.rpc('get_next_day_payout_projection', {
      p_date: date, p_from: from, p_cushion_pct: cushionPct,
    });
    if (error || !projection) {
      console.error('projection rpc failed', error);
      return json({ error: 'projection_failed', details: error?.message }, 500);
    }

    const email = render(projection as Json);
    const summary = {
      date: (projection as Json).date,
      from: (projection as Json).from,
      grand_total: email.grandTotal,
      cushion: (projection as Json).plan?.cushion ?? 0,
      plan_total: email.planTotal,
      roi_cash: (projection as Json).roi.cash_total,
      landlord: (projection as Json).landlord.total,
      withdrawals: (projection as Json).withdrawals.total,
      partner_capital: (projection as Json).partner_capital.total,
      flags: email.flags,
    };
    const pdfBytes = await buildPdf(projection as Json, email.grandTotal, email.flags);
    const csv = buildCsv(projection as Json);
    const attachments = [`welile-payouts-${summary.date}.pdf`, `welile-payouts-${summary.date}.csv`];
    if (isExec && body.dry_run) {
      return json({ ok: true, dry_run: true, to, cc, subject: email.subject, summary, attachments, pdf_bytes: pdfBytes.length, text: email.text });
    }

    const form = new FormData();
    form.set('from', DEFAULT_FROM);
    to.forEach((r) => form.append('to', r));
    cc.forEach((r) => form.append('cc', r));
    form.set('subject', email.subject);
    form.set('text', email.text);
    form.set('html', email.html);
    form.set('o:tag', 'payout-projection-daily');
    form.append('attachment', new Blob([pdfBytes], { type: 'application/pdf' }), attachments[0]);
    form.append('attachment', new Blob([csv], { type: 'text/csv' }), attachments[1]);

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
    return json({ ok: true, to, cc, subject: email.subject, summary, attachments });
  } catch (e) {
    console.error('daily-payout-projection-report error', e);
    return json({ error: String((e as Error)?.message ?? e) }, 500);
  }
});
