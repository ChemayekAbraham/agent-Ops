// Daily Wallet Inflows Report — per-user (not per-category).
// Aggregates every general_ledger cash_in leg for the previous EAT day,
// grouped by recipient user, and emails a PDF via Mailgun.
//
// Cron: 21:00 UTC daily = 00:00 EAT next day (covers the just-ended EAT day).
// Manual: POST { "date": "YYYY-MM-DD" (EAT day), "recipients": ["a@b"] }

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.4';
import { PDFDocument, StandardFonts, rgb } from 'https://esm.sh/pdf-lib@1.17.1';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const FROM = 'Welile Reports <reports@welile.com>';
const DEFAULT_RECIPIENTS = ['joshwanda17@gmail.com', 'benjaminmuhanguzi29@gmail.com'];

function fmtUgx(n: number) {
  return `UGX ${Math.round(Number(n) || 0).toLocaleString('en-UG')}`;
}

// EAT day → UTC window: [date 00:00 EAT, date+1 00:00 EAT) = [date-1 21:00Z, date 21:00Z)
function eatDayToUtcRange(dateStr: string) {
  const startUtc = new Date(`${dateStr}T00:00:00.000+03:00`);
  const endUtc = new Date(startUtc.getTime() + 24 * 60 * 60 * 1000);
  return { startIso: startUtc.toISOString(), endIso: endUtc.toISOString() };
}

function yesterdayEat(): string {
  // "Now" in EAT, minus 1 day, formatted YYYY-MM-DD.
  const nowEatMs = Date.now() + 3 * 60 * 60 * 1000;
  const d = new Date(nowEatMs - 24 * 60 * 60 * 1000);
  return d.toISOString().slice(0, 10);
}

async function fetchAll<T>(build: (from: number, to: number) => any): Promise<T[]> {
  const PAGE = 1000;
  const out: T[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await build(from, from + PAGE - 1);
    if (error) throw error;
    if (!data || data.length === 0) break;
    out.push(...(data as T[]));
    if (data.length < PAGE) break;
  }
  return out;
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

    const body = req.method === 'POST' ? await req.json().catch(() => ({})) : {};
    const dateStr: string = typeof body?.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(body.date)
      ? body.date : yesterdayEat();
    const recipients: string[] = Array.isArray(body?.recipients) && body.recipients.length > 0
      ? body.recipients.filter((r: unknown) => typeof r === 'string' && r.includes('@'))
      : DEFAULT_RECIPIENTS;

    const { startIso, endIso } = eatDayToUtcRange(dateStr);
    const supabase = createClient(supabaseUrl, serviceKey);

    // Pull all cash_in wallet-scope legs for the day.
    // scope='wallet' filters to user wallet movements (excludes platform legs).
    const rows = await fetchAll<any>((from, to) => supabase
      .from('general_ledger')
      .select('user_id, amount, category, wallet_bucket, classification')
      .eq('direction', 'cash_in')
      .eq('ledger_scope', 'wallet')
      .gte('created_at', startIso)
      .lt('created_at', endIso)
      .neq('classification', 'admin_correction')
      .neq('category', 'system_balance_correction')
      .range(from, to));

    // Aggregate by user
    type Agg = {
      user_id: string;
      total: number;
      withdrawable: number;
      float: number;
      advance: number;
      txCount: number;
      topCategory: string;
      catTotals: Map<string, number>;
    };
    const byUser = new Map<string, Agg>();
    for (const r of rows) {
      if (!r.user_id) continue;
      const amt = Number(r.amount) || 0;
      let a = byUser.get(r.user_id);
      if (!a) {
        a = { user_id: r.user_id, total: 0, withdrawable: 0, float: 0, advance: 0, txCount: 0, topCategory: '', catTotals: new Map() };
        byUser.set(r.user_id, a);
      }
      a.total += amt;
      a.txCount += 1;
      if (r.wallet_bucket === 'withdrawable') a.withdrawable += amt;
      else if (r.wallet_bucket === 'float') a.float += amt;
      else if (r.wallet_bucket === 'advance') a.advance += amt;
      const cat = r.category || 'uncategorized';
      a.catTotals.set(cat, (a.catTotals.get(cat) || 0) + amt);
    }
    // Compute top category per user
    for (const a of byUser.values()) {
      let top = '', topAmt = -1;
      for (const [c, v] of a.catTotals) if (v > topAmt) { top = c; topAmt = v; }
      a.topCategory = top;
    }

    // Fetch profile names for all users
    const userIds = [...byUser.keys()];
    const nameMap: Record<string, { name: string; phone: string }> = {};
    const BATCH = 500;
    for (let i = 0; i < userIds.length; i += BATCH) {
      const slice = userIds.slice(i, i + BATCH);
      const { data } = await supabase.from('profiles').select('id, full_name, phone').in('id', slice);
      (data ?? []).forEach((p: any) => { nameMap[p.id] = { name: p.full_name || p.id.slice(0, 8), phone: p.phone || '' }; });
    }

    const perUser = [...byUser.values()].sort((a, b) => b.total - a.total);
    const totalInflow = perUser.reduce((s, u) => s + u.total, 0);
    const totalWithdrawable = perUser.reduce((s, u) => s + u.withdrawable, 0);
    const totalFloat = perUser.reduce((s, u) => s + u.float, 0);
    const totalAdvance = perUser.reduce((s, u) => s + u.advance, 0);
    const totalTx = perUser.reduce((s, u) => s + u.txCount, 0);

    const pdfBytes = await buildPdf({
      dateStr,
      generatedAt: new Date().toISOString().replace('T', ' ').slice(0, 19) + ' UTC',
      totalInflow, totalWithdrawable, totalFloat, totalAdvance,
      totalTx, userCount: perUser.length,
      rows: perUser.map(u => ({
        name: nameMap[u.user_id]?.name || u.user_id.slice(0, 8),
        phone: nameMap[u.user_id]?.phone || '',
        total: u.total,
        withdrawable: u.withdrawable,
        float: u.float,
        advance: u.advance,
        txCount: u.txCount,
        topCategory: u.topCategory,
      })),
    });

    const html = `
      <div style="font-family:-apple-system,Segoe UI,Arial,sans-serif;color:#111">
        <h2 style="margin:0 0 4px">Welile — Daily Wallet Inflows</h2>
        <p style="color:#666;margin:0 0 16px">Report date: ${dateStr} (EAT)</p>
        <table style="border-collapse:collapse">
          <tr><td style="padding:4px 12px;color:#666">Users credited</td><td style="padding:4px 12px"><b>${perUser.length}</b></td></tr>
          <tr><td style="padding:4px 12px;color:#666">Transactions</td><td style="padding:4px 12px"><b>${totalTx}</b></td></tr>
          <tr><td style="padding:4px 12px;color:#666">Total inflow</td><td style="padding:4px 12px"><b>${fmtUgx(totalInflow)}</b></td></tr>
          <tr><td style="padding:4px 12px;color:#666">Withdrawable</td><td style="padding:4px 12px">${fmtUgx(totalWithdrawable)}</td></tr>
          <tr><td style="padding:4px 12px;color:#666">Float</td><td style="padding:4px 12px">${fmtUgx(totalFloat)}</td></tr>
          <tr><td style="padding:4px 12px;color:#666">Advance</td><td style="padding:4px 12px">${fmtUgx(totalAdvance)}</td></tr>
        </table>
        <p style="margin-top:16px;color:#666">Full per-user breakdown attached as PDF.</p>
      </div>`;

    const filename = `welile-wallet-inflows-${dateStr}.pdf`;
    const form = new FormData();
    form.set('from', FROM);
    recipients.forEach(r => form.append('to', r));
    form.set('subject', `Welile — Daily Wallet Inflows (${dateStr} EAT)`);
    form.set('text', `Per-user wallet inflows for ${dateStr} EAT.\nUsers credited: ${perUser.length}\nTotal inflow: ${fmtUgx(totalInflow)}\nSee attached PDF.`);
    form.set('html', html);
    form.set('o:tag', 'wallet-inflows-daily');
    form.append('attachment', new Blob([pdfBytes], { type: 'application/pdf' }), filename);

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

    return new Response(JSON.stringify({
      ok: true, date: dateStr, recipients,
      users: perUser.length, transactions: totalTx, totalInflow,
    }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  } catch (err) {
    console.error('daily-wallet-inflows-report failed', err);
    return new Response(JSON.stringify({ error: String((err as any)?.message ?? err) }), {
      status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});

// ---------- PDF ----------
interface PdfRow {
  name: string; phone: string; total: number;
  withdrawable: number; float: number; advance: number;
  txCount: number; topCategory: string;
}
interface PdfArgs {
  dateStr: string; generatedAt: string;
  totalInflow: number; totalWithdrawable: number; totalFloat: number; totalAdvance: number;
  totalTx: number; userCount: number;
  rows: PdfRow[];
}

async function buildPdf(a: PdfArgs): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);

  const PAGE_W = 595.28, PAGE_H = 841.89;
  const margin = 32;
  const col = (r: number, g: number, b: number) => rgb(r / 255, g / 255, b / 255);
  const ink = col(17, 17, 17);
  const muted = col(110, 110, 120);
  const line = col(230, 230, 235);
  const brand: [number, number, number] = [88, 28, 135];

  // Columns: Name | Phone | Total | Withdrawable | Float | Advance | Tx | Top category
  const colX = [margin, margin + 130, margin + 240, margin + 320, margin + 400, margin + 460, margin + 510, margin + 535];
  const colW = [128, 108, 78, 78, 58, 48, 24, PAGE_W - margin - (margin + 535)];
  const headers = ['User', 'Phone', 'Total (UGX)', 'Withdrawable', 'Float', 'Advance', 'Tx', 'Top category'];

  const ROW_H = 14;
  const HEADER_H = 100;
  const TABLE_HDR_H = 20;
  const FOOTER_H = 18;

  let page = doc.addPage([PAGE_W, PAGE_H]);
  let y = PAGE_H;
  let pageNum = 1;

  const drawHeader = () => {
    page.drawRectangle({ x: 0, y: PAGE_H - HEADER_H, width: PAGE_W, height: HEADER_H, color: col(...brand) });
    page.drawText('WELILE', { x: margin, y: PAGE_H - 32, size: 10, font: bold, color: col(255, 255, 255) });
    page.drawText('Daily Wallet Inflows — Per User', { x: margin, y: PAGE_H - 54, size: 17, font: bold, color: col(255, 255, 255) });
    page.drawText(`Report date: ${a.dateStr} (EAT)`, { x: margin, y: PAGE_H - 72, size: 9, font, color: col(230, 220, 245) });
    const genT = `Generated ${a.generatedAt}`;
    page.drawText(genT, { x: PAGE_W - margin - font.widthOfTextAtSize(genT, 9), y: PAGE_H - 72, size: 9, font, color: col(230, 220, 245) });
    // Summary strip
    const summary = `${a.userCount} users • ${a.totalTx} transactions • Total ${fmtUgx(a.totalInflow)}  |  Withdrawable ${fmtUgx(a.totalWithdrawable)} • Float ${fmtUgx(a.totalFloat)} • Advance ${fmtUgx(a.totalAdvance)}`;
    page.drawText(summary, { x: margin, y: PAGE_H - 90, size: 8.5, font, color: col(255, 255, 255) });
  };

  const drawTableHeader = (yy: number) => {
    page.drawRectangle({ x: margin, y: yy - TABLE_HDR_H, width: PAGE_W - 2 * margin, height: TABLE_HDR_H, color: col(245, 243, 250) });
    headers.forEach((h, i) => {
      page.drawText(h, { x: colX[i] + 3, y: yy - 14, size: 8, font: bold, color: ink });
    });
    return yy - TABLE_HDR_H;
  };

  const drawFooter = () => {
    const t = `Page ${pageNum}`;
    page.drawText(t, { x: PAGE_W - margin - font.widthOfTextAtSize(t, 8), y: 14, size: 8, font, color: muted });
    page.drawText('Welile — automated report • confidential', { x: margin, y: 14, size: 8, font, color: muted });
  };

  const truncate = (s: string, w: number, size: number, f: any) => {
    if (!s) return '';
    let out = s;
    while (out.length > 0 && f.widthOfTextAtSize(out, size) > w - 4) out = out.slice(0, -1);
    if (out.length < s.length && out.length > 1) out = out.slice(0, -1) + '…';
    return out;
  };

  drawHeader();
  y = PAGE_H - HEADER_H - 10;
  y = drawTableHeader(y);

  if (a.rows.length === 0) {
    page.drawText('No wallet inflows recorded for this day.', { x: margin, y: y - 20, size: 10, font, color: muted });
  }

  for (let i = 0; i < a.rows.length; i++) {
    const r = a.rows[i];
    if (y - ROW_H < FOOTER_H + 8) {
      drawFooter();
      page = doc.addPage([PAGE_W, PAGE_H]);
      pageNum += 1;
      drawHeader();
      y = PAGE_H - HEADER_H - 10;
      y = drawTableHeader(y);
    }
    // zebra
    if (i % 2 === 1) {
      page.drawRectangle({ x: margin, y: y - ROW_H, width: PAGE_W - 2 * margin, height: ROW_H, color: col(251, 251, 253) });
    }
    const cells = [
      truncate(r.name, colW[0], 8, font),
      truncate(r.phone, colW[1], 8, font),
      fmtUgx(r.total).replace('UGX ', ''),
      fmtUgx(r.withdrawable).replace('UGX ', ''),
      fmtUgx(r.float).replace('UGX ', ''),
      fmtUgx(r.advance).replace('UGX ', ''),
      String(r.txCount),
      truncate(r.topCategory, colW[7], 8, font),
    ];
    cells.forEach((c, ci) => {
      const f = ci === 2 ? bold : font;
      page.drawText(c, { x: colX[ci] + 3, y: y - 10, size: 8, font: f, color: ink });
    });
    // row divider
    page.drawLine({ start: { x: margin, y: y - ROW_H }, end: { x: PAGE_W - margin, y: y - ROW_H }, thickness: 0.3, color: line });
    y -= ROW_H;
  }

  drawFooter();
  return await doc.save();
}