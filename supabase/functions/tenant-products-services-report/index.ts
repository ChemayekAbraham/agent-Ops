// Tenant Products & Services — Daily Report
// Emails a branded PDF of the same figures the Tenant Ops dashboard shows.
// Invocation:
//   POST /tenant-products-services-report                       → today (EAT) to default recipients
//   POST body: { "date": "YYYY-MM-DD", "to": "YYYY-MM-DD", "recipients": ["a@x"], "label": "Test run" }

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.4';
import { PDFDocument, StandardFonts, rgb } from 'https://esm.sh/pdf-lib@1.17.1';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const DEFAULT_FROM = 'Welile Reports <reports@welile.com>';
const DEFAULT_RECIPIENTS = ['natashakisakye33@gmail.com'];
const TZ = 'Africa/Kampala';
const BRAND = rgb(88 / 255, 28 / 255, 135 / 255);
const INK = rgb(0.16, 0.16, 0.2);
const MUTED = rgb(0.45, 0.45, 0.52);
const LINE = rgb(0.88, 0.88, 0.92);

const ugx = (n: unknown) => `UGX ${Math.round(Number(n) || 0).toLocaleString('en-US')}`;
const num = (n: unknown) => Math.round(Number(n) || 0).toLocaleString('en-US');

/** Current calendar date in Africa/Kampala (EAT, UTC+3). */
function eatToday(): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());
}

function eatNowLabel(): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: TZ, day: '2-digit', month: 'short', year: 'numeric',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(new Date());
}

/** Current hour (0-23) in Africa/Kampala. */
function eatHour(): number {
  return Number(new Intl.DateTimeFormat('en-GB', {
    timeZone: TZ, hour: '2-digit', hour12: false,
  }).format(new Date()));
}

/** Yesterday's calendar date in Africa/Kampala. */
function eatYesterday(): string {
  const d = new Date(`${eatToday()}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

function fmtDay(d: string): string {
  try {
    return new Intl.DateTimeFormat('en-GB', {
      timeZone: 'UTC', day: '2-digit', month: 'short', year: 'numeric',
    }).format(new Date(`${d}T00:00:00Z`));
  } catch { return d; }
}

function pctLabel(current: unknown, previous: unknown): string {
  const c = Number(current) || 0;
  const p = Number(previous) || 0;
  if (p === 0) return c === 0 ? '0.0%' : 'new';
  const v = ((c - p) / p) * 100;
  return `${v > 0 ? '+' : ''}${v.toFixed(1)}%`;
}

interface Metrics {
  new_tenants: number; total_tenants: number; applications: number;
  accepted: number; rejected: number; active_tenants: number;
  collected: number; payments: number; payables: number; payable_tenants: number;
}

interface Report {
  period: { from: string; to: string; days: number; timezone: string; previous_from: string; previous_to: string };
  current: Metrics;
  previous: Metrics;
  outstanding_payables: number;
  outstanding_payables_count: number;
  tenant_register_total: number;
  series: Array<Record<string, any>>;
  application_status: Array<{ status: string; n: number }>;
  districts: Array<{ district: string; paying_tenants: number; collected: number }>;
  generated_at: string;
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
    const isDate = (v: unknown) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v);
    // Defensive default: an automated run just after EAT midnight is reporting on
    // the day that just ended, not the fresh one.
    const from: string = isDate(body?.date)
      ? body.date
      : (eatHour() < 2 ? eatYesterday() : eatToday());
    const to: string = isDate(body?.to) ? body.to : from;
    const recipients: string[] = Array.isArray(body?.recipients) && body.recipients.length
      ? body.recipients.filter((r: unknown) => typeof r === 'string' && (r as string).includes('@'))
      : DEFAULT_RECIPIENTS;
    const label: string | null = typeof body?.label === 'string' ? body.label : null;

    const supabase = createClient(supabaseUrl, serviceKey);

    const { data: reportData, error: reportError } = await supabase.rpc(
      'ops_tenant_products_services_report', { p_from: from, p_to: to },
    );
    if (reportError) throw reportError;
    const report = reportData as unknown as Report;

    // Detail rows — paginated so nothing is silently truncated.
    const rows: any[] = [];
    const PAGE = 1000;
    for (let offset = 0; ; offset += PAGE) {
      const { data, error } = await supabase.rpc('ops_tenant_products_services_rows', {
        p_from: from, p_to: to, p_search: null, p_district: 'all', p_agent: null,
        p_status: 'all', p_payment: 'all', p_limit: PAGE, p_offset: offset,
      });
      if (error) throw error;
      const batch = (data || []) as any[];
      rows.push(...batch);
      if (batch.length < PAGE || rows.length >= 20000) break;
    }

    const periodLabel = from === to ? fmtDay(from) : `${fmtDay(from)} - ${fmtDay(to)}`;
    const prevLabel = report.period.previous_from === report.period.previous_to
      ? fmtDay(report.period.previous_from)
      : `${fmtDay(report.period.previous_from)} - ${fmtDay(report.period.previous_to)}`;
    const generatedLabel = `${eatNowLabel()} EAT`;

    const pdfBytes = await buildPdf({ report, rows, periodLabel, prevLabel, generatedLabel, label });

    const c = report.current;
    const p = report.previous;
    const textLines = [
      'WELILE — TENANT PRODUCTS & SERVICES DAILY REPORT',
      `Period: ${periodLabel} (${TZ})`,
      `Compared with: ${prevLabel}`,
      `Generated: ${generatedLabel}`,
      label ? `Run: ${label}` : '',
      '',
      `New tenants added:        ${num(c.new_tenants)}  (${pctLabel(c.new_tenants, p.new_tenants)})`,
      `Active tenants (paid):    ${num(c.active_tenants)}  (${pctLabel(c.active_tenants, p.active_tenants)})`,
      `Total tenants:            ${num(c.total_tenants)}`,
      `Applications:             ${num(c.applications)}  (${pctLabel(c.applications, p.applications)})`,
      `Accepted:                 ${num(c.accepted)}  (${pctLabel(c.accepted, p.accepted)})`,
      `Rejected:                 ${num(c.rejected)}  (${pctLabel(c.rejected, p.rejected)})`,
      `Total rent collected:     ${ugx(c.collected)}  (${pctLabel(c.collected, p.collected)})`,
      `Landlord payables:        ${ugx(c.payables)}  (${pctLabel(c.payables, p.payables)})`,
      `Outstanding payables:     ${ugx(report.outstanding_payables)} across ${num(report.outstanding_payables_count)} payouts`,
      '',
      `Tenant records in the attached PDF: ${num(rows.length)}`,
      'Full KPI tables, daily breakdown, districts and tenant detail are in the attached PDF.',
      '',
      'Automated report generated by Welile.',
    ].filter(Boolean);

    const htmlBody = renderHtml({ report, periodLabel, prevLabel, generatedLabel, label, rowCount: rows.length });

    const filename = `welile-tenant-products-services-${from === to ? from : `${from}_to_${to}`}.pdf`;
    const form = new FormData();
    form.set('from', DEFAULT_FROM);
    recipients.forEach(r => form.append('to', r));
    form.set('subject', `Welile Tenant Products & Services — Daily Report (${periodLabel})${label ? ` — ${label}` : ''}`);
    form.set('text', textLines.join('\n'));
    form.set('html', htmlBody);
    form.set('o:tag', 'tenant-products-services-daily');
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
      ok: true, period: { from, to }, recipients, rows: rows.length, current: c, filename,
    }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  } catch (err) {
    console.error('tenant-products-services-report failed', err);
    return new Response(JSON.stringify({ error: String((err as any)?.message ?? err) }), {
      status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});

// ============================================================================
// PDF renderer (pdf-lib). Purple Welile branding, KPI cards + tables.
// ============================================================================
async function buildPdf(args: {
  report: Report;
  rows: any[];
  periodLabel: string;
  prevLabel: string;
  generatedLabel: string;
  label: string | null;
}): Promise<Uint8Array> {
  const { report, rows, periodLabel, prevLabel, generatedLabel, label } = args;
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);

  const W = 595.28;
  const H = 841.89;
  const M = 36;
  const CW = W - M * 2;

  let page = doc.addPage([W, H]);
  let y = H;

  const clean = (s: string) => String(s ?? '').replace(/[^\x20-\x7E]/g, ' ');

  const text = (s: string, x: number, ty: number, size: number, f = font, color = INK) => {
    page.drawText(clean(s), { x, y: ty, size, font: f, color });
  };
  const textRight = (s: string, xRight: number, ty: number, size: number, f = font, color = INK) => {
    const str = clean(s);
    const w = f.widthOfTextAtSize(str, size);
    page.drawText(str, { x: xRight - w, y: ty, size, font: f, color });
  };
  const truncate = (s: string, size: number, maxW: number, f = font) => {
    let str = clean(s);
    if (f.widthOfTextAtSize(str, size) <= maxW) return str;
    while (str.length > 1 && f.widthOfTextAtSize(`${str}...`, size) > maxW) str = str.slice(0, -1);
    return `${str}...`;
  };

  const header = () => {
    page.drawRectangle({ x: 0, y: H - 74, width: W, height: 74, color: BRAND });
    text('WELILE', M, H - 24, 9, bold, rgb(1, 1, 1));
    text('TENANT PRODUCTS & SERVICES - DAILY REPORT', M, H - 42, 14, bold, rgb(1, 1, 1));
    text(`Period: ${periodLabel}  |  ${report.period.days} day(s)  |  ${report.period.timezone}`, M, H - 58, 8.5, font, rgb(0.92, 0.88, 1));
    text(`Compared with ${prevLabel}${label ? `  |  ${label}` : ''}`, M, H - 69, 8, font, rgb(0.86, 0.82, 1));
    y = H - 92;
  };

  const newPage = () => { page = doc.addPage([W, H]); header(); };
  const ensure = (h: number) => { if (y - h < 60) newPage(); };

  header();

  // ---- KPI cards ----
  const kpis: Array<[string, string, string]> = [
    ['New Tenants Added', num(report.current.new_tenants), pctLabel(report.current.new_tenants, report.previous.new_tenants)],
    ['Active Tenants (paid)', num(report.current.active_tenants), pctLabel(report.current.active_tenants, report.previous.active_tenants)],
    ['Total Tenants', num(report.current.total_tenants), pctLabel(report.current.total_tenants, report.previous.total_tenants)],
    ['Applications', num(report.current.applications), pctLabel(report.current.applications, report.previous.applications)],
    ['Accepted', num(report.current.accepted), pctLabel(report.current.accepted, report.previous.accepted)],
    ['Rejected', num(report.current.rejected), pctLabel(report.current.rejected, report.previous.rejected)],
    ['Rent Collected', ugx(report.current.collected), pctLabel(report.current.collected, report.previous.collected)],
    ['Landlord Payables', ugx(report.current.payables), pctLabel(report.current.payables, report.previous.payables)],
  ];
  const cols = 4;
  const cardW = (CW - 6 * (cols - 1)) / cols;
  const cardH = 46;
  kpis.forEach((k, i) => {
    const row = Math.floor(i / cols);
    const col = i % cols;
    if (col === 0) ensure(cardH + 8);
    const x = M + col * (cardW + 6);
    const cy = y - row * 0 - cardH;
    page.drawRectangle({
      x, y: cy, width: cardW, height: cardH,
      color: rgb(0.976, 0.972, 0.992), borderColor: LINE, borderWidth: 0.6,
    });
    text(truncate(k[0].toUpperCase(), 6.5, cardW - 10, bold), x + 5, cy + cardH - 13, 6.5, bold, BRAND);
    text(truncate(k[1], 11, cardW - 10, bold), x + 5, cy + cardH - 29, 11, bold, INK);
    text(`vs prev ${k[2]}`, x + 5, cy + 7, 6.5, font, MUTED);
    if (col === cols - 1) y = cy - 6;
  });
  if (kpis.length % cols !== 0) y -= cardH + 6;
  y -= 6;

  // ---- Table helper ----
  const table = (
    title: string,
    head: string[],
    widths: number[],
    body: string[][],
    rightAlign: boolean[] = [],
  ) => {
    ensure(40);
    text(title, M, y, 9, bold, BRAND);
    y -= 12;
    const drawHead = () => {
      page.drawRectangle({ x: M, y: y - 12, width: CW, height: 14, color: BRAND });
      let x = M + 4;
      head.forEach((h, i) => {
        if (rightAlign[i]) textRight(h, x + widths[i] - 6, y - 8, 7, bold, rgb(1, 1, 1));
        else text(truncate(h, 7, widths[i] - 6, bold), x, y - 8, 7, bold, rgb(1, 1, 1));
        x += widths[i];
      });
      y -= 16;
    };
    drawHead();
    body.forEach((r, idx) => {
      if (y < 56) { newPage(); text(`${title} (continued)`, M, y, 9, bold, BRAND); y -= 12; drawHead(); }
      if (idx % 2 === 1) page.drawRectangle({ x: M, y: y - 3.5, width: CW, height: 12, color: rgb(0.973, 0.973, 0.984) });
      let x = M + 4;
      r.forEach((cell, i) => {
        if (rightAlign[i]) textRight(truncate(cell, 6.8, widths[i] - 6), x + widths[i] - 6, y, 6.8);
        else text(truncate(cell, 6.8, widths[i] - 6), x, y, 6.8);
        x += widths[i];
      });
      y -= 12;
    });
    y -= 10;
  };

  const c = report.current;
  const pv = report.previous;

  table(
    'KPI SUMMARY AND PERIOD-ON-PERIOD CHANGE',
    ['Metric', 'This period', 'Previous', 'Change'],
    [220, 110, 110, CW - 440],
    [
      ['New tenants added', num(c.new_tenants), num(pv.new_tenants), pctLabel(c.new_tenants, pv.new_tenants)],
      ['Active tenants (paid rent in period)', num(c.active_tenants), num(pv.active_tenants), pctLabel(c.active_tenants, pv.active_tenants)],
      ['Total tenants (register)', num(c.total_tenants), num(pv.total_tenants), pctLabel(c.total_tenants, pv.total_tenants)],
      ['Applications', num(c.applications), num(pv.applications), pctLabel(c.applications, pv.applications)],
      ['Accepted', num(c.accepted), num(pv.accepted), pctLabel(c.accepted, pv.accepted)],
      ['Rejected', num(c.rejected), num(pv.rejected), pctLabel(c.rejected, pv.rejected)],
      ['Payments recorded', num(c.payments), num(pv.payments), pctLabel(c.payments, pv.payments)],
    ],
    [false, true, true, true],
  );

  const avg = c.active_tenants > 0 ? Number(c.collected) / c.active_tenants : 0;
  const prevAvg = pv.active_tenants > 0 ? Number(pv.collected) / pv.active_tenants : 0;
  table(
    'FINANCIAL SUMMARY - RECEIVABLES AND PAYABLES',
    ['Item', 'Value', 'Previous', 'Change'],
    [220, 110, 110, CW - 440],
    [
      ['Receivables - total rent collected', ugx(c.collected), ugx(pv.collected), pctLabel(c.collected, pv.collected)],
      ['Average collection per paying tenant', ugx(avg), ugx(prevAvg), pctLabel(avg, prevAvg)],
      ['Payables - landlord payouts raised', ugx(c.payables), ugx(pv.payables), pctLabel(c.payables, pv.payables)],
      ['Tenants / houses behind payables', num(c.payable_tenants), num(pv.payable_tenants), pctLabel(c.payable_tenants, pv.payable_tenants)],
      ['Net position (receivables - payables)', ugx(Number(c.collected) - Number(c.payables)), '-', '-'],
      ['Outstanding payables (all time)', ugx(report.outstanding_payables), `${num(report.outstanding_payables_count)} payouts`, '-'],
      ['Acceptance rate', c.applications > 0 ? `${((c.accepted / c.applications) * 100).toFixed(1)}%` : '0.0%', '-', '-'],
      ['Rejection rate', c.applications > 0 ? `${((c.rejected / c.applications) * 100).toFixed(1)}%` : '0.0%', '-', '-'],
    ],
    [false, true, true, true],
  );

  if ((report.series || []).length > 1) {
    table(
      'DAILY BREAKDOWN',
      ['Day', 'New', 'Apps', 'Acc', 'Rej', 'Paid tenants', 'Collected', 'Payables'],
      [78, 40, 40, 40, 40, 70, 100, CW - 408],
      report.series.map(s => [
        fmtDay(String(s.day)), num(s.new_tenants), num(s.applications), num(s.accepted),
        num(s.rejected), num(s.paid_tenants), ugx(s.collected), ugx(s.payables),
      ]),
      [false, true, true, true, true, true, true, true],
    );
  }

  if ((report.application_status || []).length) {
    table(
      'APPLICATION STATUS DISTRIBUTION',
      ['Status', 'Applications', 'Share'],
      [240, 120, CW - 360],
      report.application_status.map(a => [
        String(a.status || '-').replace(/_/g, ' '),
        num(a.n),
        c.applications > 0 ? `${((Number(a.n) / c.applications) * 100).toFixed(1)}%` : '0.0%',
      ]),
      [false, true, true],
    );
  }

  if ((report.districts || []).length) {
    table(
      'TOP DISTRICTS BY COLLECTIONS',
      ['District', 'Paying tenants', 'Collected'],
      [240, 120, CW - 360],
      report.districts.map(d => [d.district || 'Unmapped', num(d.paying_tenants), ugx(d.collected)]),
      [false, true, true],
    );
  }

  if (rows.length) {
    table(
      `TENANT ACTIVITY DETAIL (${num(rows.length)} records)`,
      ['Tenant', 'Phone', 'District', 'Agent', 'Status', 'Collected', 'Outstanding'],
      [104, 70, 60, 76, 62, 74, CW - 446],
      rows.map(r => [
        r.tenant_name || '-', r.tenant_phone || '-', r.district || '-', r.agent_name || '-',
        String(r.application_status || '-').replace(/_/g, ' '),
        ugx(r.paid_in_period), ugx(r.outstanding),
      ]),
      [false, false, false, false, false, true, true],
    );
  }

  // ---- Audit footer on every page ----
  const pages = doc.getPages();
  pages.forEach((pg, i) => {
    pg.drawLine({ start: { x: M, y: 46 }, end: { x: W - M, y: 46 }, thickness: 0.6, color: LINE });
    const foot = `Tenant Products & Services Daily Report | Period ${periodLabel} | Generated ${generatedLabel} | Automated by Welile`;
    pg.drawText(clean(foot), { x: M, y: 34, size: 6.5, font, color: MUTED });
    pg.drawText(clean('Sources: tenant register, rent_requests, agent_collections, landlord_payouts'), {
      x: M, y: 25, size: 6.5, font, color: MUTED,
    });
    const pageLabel = `Page ${i + 1} of ${pages.length}`;
    pg.drawText(pageLabel, {
      x: W - M - font.widthOfTextAtSize(pageLabel, 6.5), y: 25, size: 6.5, font, color: MUTED,
    });
  });

  return await doc.save();
}

function renderHtml(args: {
  report: Report;
  periodLabel: string;
  prevLabel: string;
  generatedLabel: string;
  label: string | null;
  rowCount: number;
}): string {
  const { report, periodLabel, prevLabel, generatedLabel, label, rowCount } = args;
  const c = report.current;
  const p = report.previous;
  const tile = (title: string, value: string, change: string) => `
    <td style="padding:6px;">
      <div style="border:1px solid #e6e3f0;border-radius:8px;background:#faf8ff;padding:10px;">
        <div style="font:700 10px Arial;color:#581c87;letter-spacing:.5px;text-transform:uppercase;">${title}</div>
        <div style="font:700 17px Arial;color:#1f1f28;margin-top:4px;">${value}</div>
        <div style="font:400 10px Arial;color:#6b6b78;margin-top:2px;">vs previous ${change}</div>
      </div>
    </td>`;
  const row = (l: string, v: string, prev: string, ch: string) => `
    <tr>
      <td style="padding:6px 8px;border-bottom:1px solid #eee;font:400 12px Arial;color:#2b2b33;">${l}</td>
      <td style="padding:6px 8px;border-bottom:1px solid #eee;font:700 12px Arial;text-align:right;">${v}</td>
      <td style="padding:6px 8px;border-bottom:1px solid #eee;font:400 11px Arial;text-align:right;color:#6b6b78;">${prev}</td>
      <td style="padding:6px 8px;border-bottom:1px solid #eee;font:400 11px Arial;text-align:right;color:#6b6b78;">${ch}</td>
    </tr>`;

  return `<!doctype html><html><body style="margin:0;background:#f4f2f9;padding:16px;">
  <div style="max-width:660px;margin:0 auto;background:#fff;border-radius:12px;overflow:hidden;border:1px solid #e6e3f0;">
    <div style="background:#581c87;padding:18px 20px;">
      <div style="font:700 11px Arial;color:#d8ccf5;letter-spacing:2px;">WELILE</div>
      <div style="font:700 18px Arial;color:#fff;margin-top:4px;">Tenant Products &amp; Services — Daily Report</div>
      <div style="font:400 12px Arial;color:#d8ccf5;margin-top:4px;">${periodLabel} · ${report.period.timezone} · compared with ${prevLabel}</div>
      ${label ? `<div style="font:400 11px Arial;color:#c4b0ef;margin-top:2px;">${label}</div>` : ''}
    </div>
    <div style="padding:14px 14px 4px;">
      <table width="100%" cellpadding="0" cellspacing="0"><tr>
        ${tile('New Tenants', num(c.new_tenants), pctLabel(c.new_tenants, p.new_tenants))}
        ${tile('Active Tenants', num(c.active_tenants), pctLabel(c.active_tenants, p.active_tenants))}
      </tr><tr>
        ${tile('Rent Collected', ugx(c.collected), pctLabel(c.collected, p.collected))}
        ${tile('Landlord Payables', ugx(c.payables), pctLabel(c.payables, p.payables))}
      </tr></table>
    </div>
    <div style="padding:8px 20px 4px;font:700 12px Arial;color:#581c87;">CORE DAILY METRICS</div>
    <table width="100%" cellpadding="0" cellspacing="0" style="padding:0 12px;">
      <tr>
        <th style="text-align:left;padding:6px 8px;font:700 10px Arial;color:#6b6b78;">Metric</th>
        <th style="text-align:right;padding:6px 8px;font:700 10px Arial;color:#6b6b78;">This period</th>
        <th style="text-align:right;padding:6px 8px;font:700 10px Arial;color:#6b6b78;">Previous</th>
        <th style="text-align:right;padding:6px 8px;font:700 10px Arial;color:#6b6b78;">Change</th>
      </tr>
      ${row('New tenants added', num(c.new_tenants), num(p.new_tenants), pctLabel(c.new_tenants, p.new_tenants))}
      ${row('Active tenants (paid rent)', num(c.active_tenants), num(p.active_tenants), pctLabel(c.active_tenants, p.active_tenants))}
      ${row('Total tenants', num(c.total_tenants), num(p.total_tenants), pctLabel(c.total_tenants, p.total_tenants))}
      ${row('Applications', num(c.applications), num(p.applications), pctLabel(c.applications, p.applications))}
      ${row('Accepted', num(c.accepted), num(p.accepted), pctLabel(c.accepted, p.accepted))}
      ${row('Rejected', num(c.rejected), num(p.rejected), pctLabel(c.rejected, p.rejected))}
      ${row('Total rent collected', ugx(c.collected), ugx(p.collected), pctLabel(c.collected, p.collected))}
      ${row('Landlord payables', ugx(c.payables), ugx(p.payables), pctLabel(c.payables, p.payables))}
      ${row('Outstanding payables (all time)', ugx(report.outstanding_payables), `${num(report.outstanding_payables_count)} payouts`, '-')}
    </table>
    <div style="padding:14px 20px;font:400 11px Arial;color:#6b6b78;line-height:1.55;border-top:1px solid #eee;margin-top:10px;">
      The attached PDF contains the full KPI tables, daily breakdown, application status split, district performance and
      ${num(rowCount)} tenant detail record(s).<br/>
      Generated ${generatedLabel} · Sources: tenant register, rent requests, agent collections, landlord payouts.<br/>
      Automated report generated by Welile.
    </div>
  </div></body></html>`;
}
