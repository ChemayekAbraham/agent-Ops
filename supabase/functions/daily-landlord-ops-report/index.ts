// Daily Landlord Ops Report
// Aggregates listing metrics for a given day and emails a plain-text report via Mailgun.
// Invocation:
//   POST /daily-landlord-ops-report            → yesterday's report to default recipients
//   POST /daily-landlord-ops-report body: { "date": "YYYY-MM-DD", "recipients": ["a@x", "b@y"] }
//     - "date" defaults to yesterday (UTC)
//     - "recipients" defaults to benjamin@welile.com, pexpert46@gmail.com

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.4';
import { PDFDocument, StandardFonts, rgb } from 'https://esm.sh/pdf-lib@1.17.1';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const FROM_DOMAIN = 'welile.com';
const DEFAULT_FROM = `Welile Reports <reports@${FROM_DOMAIN}>`;
const DEFAULT_RECIPIENTS = ['benjaminmuhanguzi29@gmail.com', 'joshwanda17@gmail.com', 'jlukodda@gmail.com'];

function fmtUgx(n: number | null | undefined) {
  const v = Math.round(Number(n) || 0);
  return `UGX ${v.toLocaleString('en-UG')}`;
}

function pad(s: string, len: number) {
  return s.length >= len ? s.slice(0, len) : s + ' '.repeat(len - s.length);
}

function padLeft(s: string, len: number) {
  return s.length >= len ? s.slice(0, len) : ' '.repeat(len - s.length) + s;
}

function dayBoundaries(dateStr: string) {
  const start = new Date(`${dateStr}T00:00:00.000Z`);
  const end = new Date(`${dateStr}T23:59:59.999Z`);
  return { startIso: start.toISOString(), endIso: end.toISOString() };
}

function yesterdayIso() {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

// Fetch every row for a query in pages of 1000 to bypass PostgREST's default cap.
async function fetchAll<T>(
  build: (from: number, to: number) => any,
): Promise<T[]> {
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
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

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
    const dateStr: string = typeof body?.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(body.date)
      ? body.date
      : yesterdayIso();
    const recipients: string[] = Array.isArray(body?.recipients) && body.recipients.length > 0
      ? body.recipients.filter((r: unknown) => typeof r === 'string' && r.includes('@'))
      : DEFAULT_RECIPIENTS;

    const { startIso, endIso } = dayBoundaries(dateStr);
    const supabase = createClient(supabaseUrl, serviceKey);

    // 1. Listings created that day (paginated to bypass 1000-row cap)
    const listings = await fetchAll<any>((from, to) => supabase
      .from('house_listings')
      .select('id, agent_id, status, verified, verified_at, monthly_rent, region, district, created_at')
      .gte('created_at', startIso)
      .lte('created_at', endIso)
      .range(from, to));

    // 2. Listings verified that day
    const verifiedToday = await fetchAll<any>((from, to) => supabase
      .from('house_listings')
      .select('id, agent_id, monthly_rent, region')
      .gte('verified_at', startIso)
      .lte('verified_at', endIso)
      .range(from, to));

    // 3. Rejections that day
    const rejections = await fetchAll<any>((from, to) => supabase
      .from('agent_listing_rejections')
      .select('id, listing_id, agent_id, rejected_at')
      .gte('rejected_at', startIso)
      .lte('rejected_at', endIso)
      .range(from, to));

    // Enrich rejections with listing monthly_rent
    const rejListingIds = [...new Set(rejections.map(r => r.listing_id).filter(Boolean))] as string[];
    let rejListingMap: Record<string, { monthly_rent: number | null; region: string | null }> = {};
    if (rejListingIds.length > 0) {
      const BATCH = 500;
      for (let i = 0; i < rejListingIds.length; i += BATCH) {
        const slice = rejListingIds.slice(i, i + BATCH);
        const { data: rejL } = await supabase
          .from('house_listings')
          .select('id, monthly_rent, region')
          .in('id', slice);
        (rejL ?? []).forEach((l: any) => { rejListingMap[l.id] = { monthly_rent: l.monthly_rent, region: l.region }; });
      }
    }

    // 4. Listing bonuses (commissions) paid that day.
    // Commissions are ledger-posted with category=agent_commission (cash_in leg)
    // and source_table identifying the trigger:
    //   - house_listings / landlords → listing commission (paid when the agent lists)
    //   - listing_bonus_approvals → verification commission (CFO-approved verified listing)
    const bonusRows = await fetchAll<any>((from, to) => supabase
      .from('general_ledger')
      .select('amount, category, source_table, direction, created_at')
      .in('category', ['agent_commission', 'agent_commission_earned'])
      .in('source_table', ['house_listings', 'landlords', 'listing_bonus_approvals'])
      .eq('direction', 'cash_in')
      .gte('created_at', startIso)
      .lte('created_at', endIso)
      .range(from, to));

    // ---- Aggregations ----
    const all = listings;
    const listedCount = all.length;
    const pendingListings = all.filter(l => !l.verified && l.status !== 'rejected');
    const rejectedInListings = all.filter(l => l.status === 'rejected');
    const verifiedInListings = all.filter(l => l.verified);

    const pendingCount = pendingListings.length;
    const verifiedCountToday = verifiedToday.length;

    const pendingVolume = pendingListings.reduce((s, l) => s + (Number(l.monthly_rent) || 0), 0);
    const verifiedVolume = verifiedToday.reduce((s, l) => s + (Number(l.monthly_rent) || 0), 0);
    const rejectionVolume = rejections.reduce((s, r) => s + (Number(rejListingMap[r.listing_id!]?.monthly_rent) || 0), 0);

    // Commission split by source_table (see query above).
    const listingCommission = bonusRows
      .filter(b => b.source_table === 'house_listings' || b.source_table === 'landlords')
      .reduce((s, b) => s + (Number(b.amount) || 0), 0);
    const verificationCommission = bonusRows
      .filter(b => b.source_table === 'listing_bonus_approvals')
      .reduce((s, b) => s + (Number(b.amount) || 0), 0);

    // Most listed by region (from that day's listings)
    const byRegion = new Map<string, number>();
    all.forEach(l => {
      const r = (l.region || '—').toString();
      byRegion.set(r, (byRegion.get(r) || 0) + 1);
    });
    const regionRanking = [...byRegion.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10);

    // Top listing agents by count
    const byAgent = new Map<string, number>();
    all.forEach(l => {
      if (!l.agent_id) return;
      byAgent.set(l.agent_id, (byAgent.get(l.agent_id) || 0) + 1);
    });
    const topAgentIds = [...byAgent.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10);

    let agentNameMap: Record<string, string> = {};
    if (topAgentIds.length > 0) {
      const { data: profs } = await supabase
        .from('profiles')
        .select('id, full_name')
        .in('id', topAgentIds.map(([id]) => id));
      (profs ?? []).forEach((p: any) => { agentNameMap[p.id] = p.full_name || p.id.slice(0, 8); });
    }

    // ---- Render report ----
    const lines: string[] = [];
    const H = (t: string) => { lines.push(''); lines.push(t.toUpperCase()); lines.push('-'.repeat(t.length)); };

    lines.push('WELILE LANDLORD OPERATIONS');
    lines.push('Daily Report');
    lines.push(`Report date: ${dateStr} (UTC)`);
    lines.push(`Generated:   ${new Date().toISOString().replace('T', ' ').slice(0, 19)} UTC`);

    H('Summary');
    lines.push(`${pad('Houses listed', 32)}${padLeft(String(listedCount), 12)}`);
    lines.push(`${pad('  of which pending', 32)}${padLeft(String(pendingCount), 12)}`);
    lines.push(`${pad('  of which verified same-day', 32)}${padLeft(String(verifiedInListings.length), 12)}`);
    lines.push(`${pad('  of which rejected', 32)}${padLeft(String(rejectedInListings.length), 12)}`);
    lines.push(`${pad('Total verified today', 32)}${padLeft(String(verifiedCountToday), 12)}`);

    H('Amount volume (monthly rent)');
    lines.push(`${pad('Pending listings volume', 32)}${padLeft(fmtUgx(pendingVolume), 24)}`);
    lines.push(`${pad('Verified listings volume', 32)}${padLeft(fmtUgx(verifiedVolume), 24)}`);
    lines.push(`${pad('Rejection volume', 32)}${padLeft(fmtUgx(rejectionVolume), 24)}`);

    H('Commissions');
    lines.push(`${pad('Listing commission', 32)}${padLeft(fmtUgx(listingCommission), 24)}`);
    lines.push(`${pad('Verification commission', 32)}${padLeft(fmtUgx(verificationCommission), 24)}`);
    lines.push(`${pad('Total commission', 32)}${padLeft(fmtUgx(listingCommission + verificationCommission), 24)}`);

    H('Most listed by region (top 10)');
    if (regionRanking.length === 0) {
      lines.push('No listings recorded.');
    } else {
      lines.push(`${pad('Region', 30)}${padLeft('Listings', 12)}`);
      regionRanking.forEach(([region, count]) => {
        lines.push(`${pad(region, 30)}${padLeft(String(count), 12)}`);
      });
    }

    H('Top listing agents (top 10 by count)');
    if (topAgentIds.length === 0) {
      lines.push('No listings recorded.');
    } else {
      lines.push(`${pad('Agent', 30)}${padLeft('Listings', 12)}`);
      topAgentIds.forEach(([id, count]) => {
        lines.push(`${pad(agentNameMap[id] || id.slice(0, 8), 30)}${padLeft(String(count), 12)}`);
      });
    }

    lines.push('');
    lines.push('This is an automated report generated by Welile.');

    const textBody = lines.join('\n');

    // ---- Build PDF ----
    const pdfBytes = await buildPdf({
      dateStr,
      generatedAt: new Date().toISOString().replace('T', ' ').slice(0, 19) + ' UTC',
      kpis: [
        { label: 'Houses Listed', value: String(listedCount), hint: `${pendingCount} pending`, accent: [30, 64, 175] },
        { label: 'Verified Today', value: String(verifiedCountToday), hint: `${verifiedInListings.length} same-day`, accent: [16, 122, 87] },
        { label: 'Rejections', value: String(rejections.length), hint: `${rejectedInListings.length} of today's`, accent: [190, 44, 44] },
        { label: 'Total Commission', value: fmtUgx(listingCommission + verificationCommission), hint: 'listing + verification', accent: [146, 52, 234] },
        { label: 'Pending Volume', value: fmtUgx(pendingVolume), hint: 'monthly rent', accent: [202, 138, 4] },
        { label: 'Verified Volume', value: fmtUgx(verifiedVolume), hint: 'monthly rent', accent: [16, 122, 87] },
        { label: 'Rejection Volume', value: fmtUgx(rejectionVolume), hint: 'monthly rent lost', accent: [190, 44, 44] },
        { label: 'Active Regions', value: String(byRegion.size), hint: `top: ${regionRanking[0]?.[0] ?? '—'}`, accent: [30, 64, 175] },
      ],
      commissionListing: listingCommission,
      commissionVerification: verificationCommission,
      regionRanking,
      topAgents: topAgentIds.map(([id, count]) => ({ name: agentNameMap[id] || id.slice(0, 8), count })),
    });

    // ---- HTML body (executive summary; PDF has the details) ----
    const htmlBody = renderHtml({
      dateStr,
      listedCount,
      verifiedCountToday,
      pendingCount,
      rejectionsCount: rejections.length,
      verifiedVolume,
      pendingVolume,
      rejectionVolume,
      totalCommission: listingCommission + verificationCommission,
      topRegion: regionRanking[0]?.[0] ?? '—',
      topAgent: topAgentIds[0] ? (agentNameMap[topAgentIds[0][0]] || topAgentIds[0][0].slice(0, 8)) : '—',
    });

    // ---- Send via Mailgun (multipart for PDF attachment) ----
    const filename = `welile-landlord-ops-${dateStr}.pdf`;
    const form = new FormData();
    form.set('from', DEFAULT_FROM);
    recipients.forEach(r => form.append('to', r));
    form.set('subject', `Welile Landlord Ops - Daily Report (${dateStr})`);
    form.set('text', textBody);
    form.set('html', htmlBody);
    form.set('o:tag', 'landlord-ops-daily');
    form.append('attachment', new Blob([pdfBytes], { type: 'application/pdf' }), filename);

    const auth = 'Basic ' + btoa(`api:${mailgunApiKey}`);
    const mgRes = await fetch(`${mailgunBaseUrl}/v3/${mailgunDomain}/messages`, {
      method: 'POST',
      headers: { Authorization: auth },
      body: form,
    });
    const mgText = await mgRes.text();
    if (!mgRes.ok) {
      console.error('Mailgun send failed', mgRes.status, mgText);
      return new Response(JSON.stringify({ error: 'Mailgun send failed', status: mgRes.status, details: mgText }), {
        status: 502,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    return new Response(
      JSON.stringify({
        ok: true,
        date: dateStr,
        recipients,
        listedCount,
        pendingCount,
        verifiedCountToday,
        rejectedCount: rejectedInListings.length,
        rejectionCount: rejections.length,
        pendingVolume,
        verifiedVolume,
        rejectionVolume,
        listingCommission,
        verificationCommission,
      }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    );
  } catch (err) {
    console.error('daily-landlord-ops-report failed', err);
    return new Response(JSON.stringify({ error: String((err as any)?.message ?? err) }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
// ============================================================================
// PDF renderer (pdf-lib). KPI cards + tables. No emojis, no third-party fonts.
// ============================================================================

type Kpi = { label: string; value: string; hint?: string; accent: [number, number, number] };

interface PdfArgs {
  dateStr: string;
  generatedAt: string;
  kpis: Kpi[];
  commissionListing: number;
  commissionVerification: number;
  regionRanking: [string, number][];
  topAgents: { name: string; count: number }[];
}

async function buildPdf(a: PdfArgs): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const oblique = await doc.embedFont(StandardFonts.HelveticaOblique);

  const page = doc.addPage([595.28, 841.89]); // A4 portrait pt
  const W = page.getWidth();
  const H = page.getHeight();
  const margin = 36;

  const col = (r: number, g: number, b: number) => rgb(r / 255, g / 255, b / 255);
  const ink = col(17, 17, 17);
  const muted = col(110, 110, 120);
  const line = col(230, 230, 235);
  const brand: [number, number, number] = [88, 28, 135]; // welile purple

  // ---- Header band ----
  page.drawRectangle({ x: 0, y: H - 90, width: W, height: 90, color: col(...brand) });
  page.drawText('WELILE', { x: margin, y: H - 40, size: 11, font: bold, color: col(255, 255, 255) });
  page.drawText('Landlord Operations - Daily Report', { x: margin, y: H - 62, size: 18, font: bold, color: col(255, 255, 255) });
  page.drawText(`Report date: ${a.dateStr} (UTC)`, { x: margin, y: H - 80, size: 9, font, color: col(230, 220, 245) });
  page.drawText(`Generated ${a.generatedAt}`, { x: W - margin - font.widthOfTextAtSize(`Generated ${a.generatedAt}`, 9), y: H - 80, size: 9, font, color: col(230, 220, 245) });

  let y = H - 90 - 24;

  // ---- KPI grid (4 per row) ----
  const gutter = 10;
  const perRow = 4;
  const cardW = (W - margin * 2 - gutter * (perRow - 1)) / perRow;
  const cardH = 68;
  a.kpis.forEach((k, i) => {
    const row = Math.floor(i / perRow);
    const cix = i % perRow;
    const x = margin + cix * (cardW + gutter);
    const cy = y - row * (cardH + gutter);
    // card background
    page.drawRectangle({ x, y: cy - cardH, width: cardW, height: cardH, color: col(250, 250, 252), borderColor: line, borderWidth: 0.6 });
    // accent rail
    page.drawRectangle({ x, y: cy - cardH, width: 3, height: cardH, color: col(...k.accent) });
    // label
    page.drawText(k.label.toUpperCase(), { x: x + 10, y: cy - 16, size: 7.5, font: bold, color: muted });
    // value: auto-shrink font so the full amount always fits (no ellipsis)
    const val = k.value;
    const maxW = cardW - 20;
    let vSize = 14;
    while (vSize > 8 && bold.widthOfTextAtSize(val, vSize) > maxW) vSize -= 0.5;
    page.drawText(val, { x: x + 10, y: cy - 38, size: vSize, font: bold, color: col(...k.accent) });
    if (k.hint) {
      page.drawText(k.hint, { x: x + 10, y: cy - 56, size: 7.5, font, color: muted });
    }
  });
  const kpiRows = Math.ceil(a.kpis.length / perRow);
  y -= kpiRows * (cardH + gutter) + 8;

  // ---- Section: Commissions breakdown ----
  y = drawSection(page, bold, 'COMMISSIONS BREAKDOWN', margin, y, ink);
  y = drawKeyValue(page, font, bold, margin, y, 'Listing commission', fmtUgx(a.commissionListing), ink, muted);
  y = drawKeyValue(page, font, bold, margin, y, 'Verification commission', fmtUgx(a.commissionVerification), ink, muted);
  y = drawKeyValue(page, font, bold, margin, y, 'Total paid to agents', fmtUgx(a.commissionListing + a.commissionVerification), col(...brand), muted, true);
  y -= 12;

  // ---- Section: Regions ----
  y = drawSection(page, bold, 'MOST LISTED BY REGION (TOP 10)', margin, y, ink);
  if (a.regionRanking.length === 0) {
    page.drawText('No listings recorded.', { x: margin, y: y - 12, size: 9, font: oblique, color: muted });
    y -= 24;
  } else {
    y = drawTable(page, font, bold, margin, y, W - margin * 2, ['Region', 'Listings'], a.regionRanking.map(([r, c]) => [r, String(c)]), ink, muted, line);
  }
  y -= 8;

  // ---- Section: Top agents ----
  y = drawSection(page, bold, 'TOP LISTING AGENTS (TOP 10)', margin, y, ink);
  if (a.topAgents.length === 0) {
    page.drawText('No listings recorded.', { x: margin, y: y - 12, size: 9, font: oblique, color: muted });
    y -= 24;
  } else {
    y = drawTable(page, font, bold, margin, y, W - margin * 2, ['Agent', 'Listings'], a.topAgents.map(a => [a.name, String(a.count)]), ink, muted, line);
  }

  // ---- Footer ----
  page.drawLine({ start: { x: margin, y: 40 }, end: { x: W - margin, y: 40 }, color: line, thickness: 0.6 });
  page.drawText('Automated by Welile - welile.com', { x: margin, y: 26, size: 8, font, color: muted });
  page.drawText(`Report ${a.dateStr}`, { x: W - margin - font.widthOfTextAtSize(`Report ${a.dateStr}`, 8), y: 26, size: 8, font, color: muted });

  return await doc.save();
}

function drawSection(page: any, bold: any, label: string, x: number, y: number, ink: any) {
  page.drawText(label, { x, y: y - 12, size: 9, font: bold, color: ink });
  page.drawLine({ start: { x, y: y - 16 }, end: { x: page.getWidth() - x, y: y - 16 }, color: rgb(0.9, 0.9, 0.93), thickness: 0.6 });
  return y - 22;
}

function drawKeyValue(page: any, font: any, bold: any, x: number, y: number, key: string, val: string, ink: any, muted: any, emphasize = false) {
  const size = emphasize ? 11 : 9.5;
  page.drawText(key, { x, y: y - 12, size, font, color: muted });
  const valFont = emphasize ? bold : bold;
  const w = valFont.widthOfTextAtSize(val, size);
  page.drawText(val, { x: page.getWidth() - x - w, y: y - 12, size, font: valFont, color: ink });
  return y - (emphasize ? 18 : 15);
}

function drawTable(page: any, font: any, bold: any, x: number, y: number, width: number, headers: string[], rows: string[][], ink: any, muted: any, line: any) {
  const rowH = 16;
  const colW = [width * 0.7, width * 0.3];
  // header
  page.drawRectangle({ x, y: y - rowH, width, height: rowH, color: rgb(0.96, 0.96, 0.98) });
  page.drawText(headers[0], { x: x + 6, y: y - rowH + 5, size: 8.5, font: bold, color: muted });
  const h1w = bold.widthOfTextAtSize(headers[1], 8.5);
  page.drawText(headers[1], { x: x + width - 6 - h1w, y: y - rowH + 5, size: 8.5, font: bold, color: muted });
  let cy = y - rowH;
  rows.forEach((r, i) => {
    if (i % 2 === 1) {
      page.drawRectangle({ x, y: cy - rowH, width, height: rowH, color: rgb(0.985, 0.985, 0.99) });
    }
    // truncate col 0
    let label = r[0];
    const maxW = colW[0] - 12;
    while (label.length > 3 && font.widthOfTextAtSize(label, 9) > maxW) label = label.slice(0, -1);
    if (label !== r[0]) label = label.slice(0, -1) + '…';
    page.drawText(label, { x: x + 6, y: cy - rowH + 5, size: 9, font, color: ink });
    const vw = bold.widthOfTextAtSize(r[1], 9);
    page.drawText(r[1], { x: x + width - 6 - vw, y: cy - rowH + 5, size: 9, font: bold, color: ink });
    cy -= rowH;
  });
  page.drawRectangle({ x, y: cy, width, height: y - cy, borderColor: line, borderWidth: 0.6, color: undefined as any, opacity: 0 });
  return cy - 4;
}

// ============================================================================
// HTML email body — clean executive summary. PDF holds the full detail.
// ============================================================================
function renderHtml(s: {
  dateStr: string;
  listedCount: number;
  verifiedCountToday: number;
  pendingCount: number;
  rejectionsCount: number;
  verifiedVolume: number;
  pendingVolume: number;
  rejectionVolume: number;
  totalCommission: number;
  topRegion: string;
  topAgent: string;
}) {
  const kpi = (label: string, value: string, accent: string) => `
    <td style="padding:6px;" width="25%" valign="top">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#fafafc;border:1px solid #eceef2;border-radius:6px;">
        <tr><td style="border-left:3px solid ${accent};padding:10px 12px;">
          <div style="font:600 10px -apple-system,Segoe UI,Roboto,Arial;color:#6b7280;letter-spacing:.5px;text-transform:uppercase;">${label}</div>
          <div style="font:700 16px -apple-system,Segoe UI,Roboto,Arial;color:${accent};margin-top:4px;">${value}</div>
        </td></tr>
      </table>
    </td>`;
  return `<!doctype html><html><body style="margin:0;background:#f4f4f7;font-family:-apple-system,Segoe UI,Roboto,Arial;color:#111;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f7;padding:24px 0;">
    <tr><td align="center">
      <table role="presentation" width="640" cellpadding="0" cellspacing="0" style="background:#fff;border-radius:10px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,.06);">
        <tr><td style="background:#581c87;padding:22px 28px;color:#fff;">
          <div style="font-size:11px;letter-spacing:1.5px;opacity:.75;">WELILE</div>
          <div style="font-size:20px;font-weight:700;margin-top:4px;">Landlord Operations - Daily Report</div>
          <div style="font-size:12px;opacity:.85;margin-top:4px;">Report date: ${s.dateStr} (UTC)</div>
        </td></tr>
        <tr><td style="padding:20px 22px 4px;">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
            ${kpi('Houses Listed', String(s.listedCount), '#1e40af')}
            ${kpi('Verified Today', String(s.verifiedCountToday), '#107a57')}
            ${kpi('Rejections', String(s.rejectionsCount), '#be2c2c')}
            ${kpi('Commissions', fmtUgx(s.totalCommission), '#9234ea')}
          </tr><tr>
            ${kpi('Pending Volume', fmtUgx(s.pendingVolume), '#ca8a04')}
            ${kpi('Verified Volume', fmtUgx(s.verifiedVolume), '#107a57')}
            ${kpi('Rejection Volume', fmtUgx(s.rejectionVolume), '#be2c2c')}
            ${kpi('Pending Count', String(s.pendingCount), '#1e40af')}
          </tr></table>
        </td></tr>
        <tr><td style="padding:12px 28px 20px;font-size:13px;color:#374151;line-height:1.55;">
          <p style="margin:12px 0 4px;">Top region today: <strong>${s.topRegion}</strong></p>
          <p style="margin:4px 0;">Top listing agent: <strong>${s.topAgent}</strong></p>
          <p style="margin:16px 0 0;color:#6b7280;font-size:12px;">The full breakdown - including per-region and per-agent tables - is attached as PDF.</p>
        </td></tr>
        <tr><td style="border-top:1px solid #eceef2;padding:14px 28px;font-size:11px;color:#9ca3af;">
          Automated by Welile. welile.com
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;
}
