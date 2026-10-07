// Daily CTO Report
// Executive-level technology report emailed daily at 00:00 EAT via pg_cron.
//
// Invocation:
//   POST /daily-cto-report
//   POST /daily-cto-report { "date": "YYYY-MM-DD", "recipients": ["a@x"] }

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.4';
import { PDFDocument, StandardFonts, rgb } from 'https://esm.sh/pdf-lib@1.17.1';
import { composeBoard, buildBoardMemoPdf, boardPlainText } from './boardMemo.ts';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const FROM = 'Welile CTO Office <reports@welile.com>';
const REPLY_TO = 'reports@welile.com';
// Engineering distribution list for the full technical diagnostic report.
const TECH_RECIPIENTS = ['joshwanda17@gmail.com'];
// CEO / Board distribution list for the condensed board memo.
const BOARD_RECIPIENTS = ['joshwanda17@gmail.com'];

const C = {
  ink: '#0f172a',
  muted: '#64748b',
  line: '#e2e8f0',
  bg: '#f8fafc',
  good: '#0f9d58',
  warn: '#c77700',
  bad: '#c0392b',
  brand: '#0b5fff',
};

function yesterdayIsoEAT() {
  const eat = new Date(Date.now() + 3 * 60 * 60 * 1000);
  eat.setUTCDate(eat.getUTCDate() - 1);
  return eat.toISOString().slice(0, 10);
}
const n = (v: unknown) => Number(v || 0);
const fmt = (v: unknown) => n(v).toLocaleString('en-UG');
const pct = (a: number, b: number) => (b > 0 ? (a / b) * 100 : 0);
const esc = (s: unknown) =>
  String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] as string));
const bytes = (b: unknown) => {
  const v = n(b);
  if (v >= 1e9) return `${(v / 1e9).toFixed(2)} GB`;
  if (v >= 1e6) return `${(v / 1e6).toFixed(1)} MB`;
  return `${(v / 1e3).toFixed(0)} KB`;
};
const delta = (cur: number, prev: number) => {
  if (prev <= 0) return cur > 0 ? '+100%' : '0%';
  const d = ((cur - prev) / prev) * 100;
  return `${d >= 0 ? '+' : ''}${d.toFixed(0)}%`;
};

type Tone = 'good' | 'warn' | 'bad' | 'neutral';
const toneColor = (t: Tone) => (t === 'good' ? C.good : t === 'warn' ? C.warn : t === 'bad' ? C.bad : C.ink);

function kpi(label: string, value: string, sub = '', tone: Tone = 'neutral') {
  return `
    <td style="padding:6px;width:25%;vertical-align:top;">
      <div style="border:1px solid ${C.line};border-radius:10px;padding:12px 14px;background:#fff;">
        <div style="font-size:10px;letter-spacing:.08em;text-transform:uppercase;color:${C.muted};font-weight:700;">${esc(label)}</div>
        <div style="font-size:22px;font-weight:800;color:${toneColor(tone)};margin-top:4px;">${esc(value)}</div>
        ${sub ? `<div style="font-size:11px;color:${C.muted};margin-top:3px;">${esc(sub)}</div>` : ''}
      </div>
    </td>`;
}
function kpiRows(cards: string[]) {
  let out = '';
  for (let i = 0; i < cards.length; i += 4) {
    const row = cards.slice(i, i + 4);
    while (row.length < 4) row.push('<td style="width:25%"></td>');
    out += `<tr>${row.join('')}</tr>`;
  }
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:separate;">${out}</table>`;
}
function section(title: string, num: number, body: string) {
  return `
    <div style="margin-top:26px;">
      <div style="font-size:13px;font-weight:800;color:${C.ink};letter-spacing:.04em;text-transform:uppercase;border-bottom:2px solid ${C.ink};padding-bottom:6px;">${num}. ${esc(title)}</div>
      <div style="margin-top:12px;">${body}</div>
    </div>`;
}
function table(headers: string[], rows: string[][]) {
  if (!rows.length) return `<div style="font-size:12px;color:${C.muted};">No records for this period.</div>`;
  return `
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;font-size:12px;">
    <tr>${headers.map((h) => `<th align="left" style="padding:7px 8px;background:${C.bg};border-bottom:1px solid ${C.line};font-size:10px;text-transform:uppercase;letter-spacing:.06em;color:${C.muted};">${esc(h)}</th>`).join('')}</tr>
    ${rows.map((r) => `<tr>${r.map((c) => `<td style="padding:7px 8px;border-bottom:1px solid ${C.line};color:${C.ink};">${c}</td>`).join('')}</tr>`).join('')}
  </table>`;
}
function bar(label: string, value: number, max: number, tone: Tone = 'neutral') {
  const w = max > 0 ? Math.max(2, Math.round((value / max) * 100)) : 2;
  return `
    <tr>
      <td style="padding:3px 8px 3px 0;font-size:11px;color:${C.muted};white-space:nowrap;width:130px;">${esc(label)}</td>
      <td style="padding:3px 0;">
        <div style="background:${C.bg};border-radius:4px;height:12px;width:100%;">
          <div style="background:${toneColor(tone)};height:12px;width:${w}%;border-radius:4px;"></div>
        </div>
      </td>
      <td style="padding:3px 0 3px 8px;font-size:11px;font-weight:700;color:${C.ink};text-align:right;width:70px;">${fmt(value)}</td>
    </tr>`;
}
function chart(rows: string) {
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;">${rows}</table>`;
}
function riskCell(level: 'Low' | 'Medium' | 'High') {
  const bg = level === 'High' ? '#fdecea' : level === 'Medium' ? '#fff4e0' : '#e9f7ef';
  const fg = level === 'High' ? C.bad : level === 'Medium' ? C.warn : C.good;
  return `<span style="background:${bg};color:${fg};font-weight:700;padding:2px 8px;border-radius:99px;font-size:11px;">${level}</span>`;
}

// ---- Diagnostics helpers ----------------------------------------------------
const shareLine = (m: Record<string, unknown> | undefined | null) => {
  const entries = Object.entries(m || {}).map(([k, v]) => [k, Number(v) || 0] as [string, number]).filter(([, v]) => v > 0);
  const total = entries.reduce((s, [, v]) => s + v, 0);
  if (!total) return 'not captured';
  return entries.sort((a, b) => b[1] - a[1]).slice(0, 4)
    .map(([k, v]) => `${Math.round((v / total) * 100)}% ${k}`).join(', ');
};
const ts = (s: unknown) => (typeof s === 'string' && s.length >= 16 ? s.slice(0, 16).replace('T', ' ') : '-');
const sevBadge = (s: string) => {
  const bg = s === 'Critical' ? '#fdecea' : s === 'High' ? '#fff4e0' : s === 'Medium' ? '#eef2ff' : '#e9f7ef';
  const fg = s === 'Critical' ? C.bad : s === 'High' ? C.warn : s === 'Medium' ? C.ink : C.good;
  return `<span style="background:${bg};color:${fg};font-weight:700;padding:2px 8px;border-radius:99px;font-size:11px;">${esc(s)}</span>`;
};
const yesNo = (v: unknown) => (v === true ? 'Yes' : 'No');
const subLabel = (t: string) =>
  `<div style="font-size:11px;font-weight:700;color:${C.muted};text-transform:uppercase;letter-spacing:.06em;margin:14px 0 6px;">${esc(t)}</div>`;

/** Full diagnostic dossier for a single error signature. */
function errorCard(e: any, idx: number) {
  const row = (k: string, v: string) =>
    `<tr><td style="padding:3px 10px 3px 0;font-size:11px;color:${C.muted};white-space:nowrap;vertical-align:top;width:150px;">${esc(k)}</td><td style="padding:3px 0;font-size:11.5px;color:${C.ink};word-break:break-word;">${v}</td></tr>`;
  const routes = Array.isArray(e.routes)
    ? e.routes.slice(0, 4).map((r: any) => `${esc(String(r.route))} (${fmt(r.n)})`).join(', ')
    : esc(String(e.route || '-'));
  return `
  <div style="border:1px solid ${C.line};border-left:4px solid ${e.severity === 'Critical' ? C.bad : e.severity === 'High' ? C.warn : C.line};border-radius:10px;padding:12px 14px;margin-bottom:12px;">
    <div style="font-size:12.5px;font-weight:800;color:${C.ink};margin-bottom:2px;">${idx}. ${esc(String(e.message || '').slice(0, 160))}</div>
    <div style="margin-bottom:8px;">${sevBadge(String(e.severity || 'Low'))} <span style="font-size:11px;color:${C.muted};">${esc(String(e.category || ''))} · ${esc(String(e.feature_area || ''))}</span></div>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;">
      ${row('Occurrences', `${fmt(e.occurrences_today)} today · ${fmt(e.occurrences_prev_day)} yesterday · ${fmt(e.occurrences_7d)} over 7 days`)}
      ${row('Affected users', `${fmt(e.affected_users_today)} today · ${fmt(e.affected_users_7d)} over 7 days`)}
      ${row('First / last seen', `${esc(ts(e.first_seen))} → ${esc(ts(e.last_seen))} UTC`)}
      ${row('Routes', routes)}
      ${row('Source file', esc(String(e.source_file || 'not captured')) + (e.source_line ? `:${esc(String(e.source_line))}:${esc(String(e.source_column || '0'))}` : ''))}
      ${row('Component', esc(String(e.component || e.boundary_label || 'not captured')))}
      ${row('Capture point', esc(String(e.capture_source || 'unknown')))}
      ${row('Browsers', esc(shareLine(e.browsers)))}
      ${row('Operating systems', esc(shareLine(e.operating_systems)))}
      ${row('Devices', esc(shareLine(e.devices)))}
      ${row('Sample user id', esc(String(e.sample_user_id || 'anonymous')))}
      ${row('Actor role', esc(String(e.actor_role || 'unknown')))}
      ${e.stack ? row('Stack', `<span style="font-family:ui-monospace,Menlo,Consolas,monospace;font-size:10.5px;color:${C.muted};">${esc(String(e.stack).slice(0, 500))}</span>`) : row('Stack', 'not captured (see action item on source maps)')}
      ${row('Root cause', esc(String(e.root_cause || '')))}
      ${row('Recommended fix', esc(String(e.suggested_fix || '')))}
      ${row('Owner', `${esc(String(e.owner_team || 'Engineering'))} · ${esc(String(e.expected_resolution || ''))}`)}
      ${row('Business impact', `Revenue exposed: ${yesNo(e.revenue_exposed)} · Data integrity risk: ${yesNo(e.data_integrity_risk)} · Blocking production: ${yesNo(e.production_blocking)}`)}
    </table>
  </div>`;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL');
    const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
    const mgKey = Deno.env.get('MAILGUN_API_KEY');
    const mgDomain = Deno.env.get('MAILGUN_DOMAIN');
    const mgBase = Deno.env.get('MAILGUN_API_BASE') || 'https://api.mailgun.net';
    if (!supabaseUrl || !serviceKey || !mgKey || !mgDomain) {
      return new Response(JSON.stringify({ error: 'Server not configured' }), {
        status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const body = req.method === 'POST' ? await req.json().catch(() => ({})) : {};
    const dateStr: string =
      typeof body?.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(body.date) ? body.date : yesterdayIsoEAT();
    // One data pass, two renderers: 'board' = condensed memo, 'tech' = full diagnostics.
    const boardMode: boolean = body?.report_type === 'board';
    const reportType: 'board' | 'tech' = boardMode ? 'board' : 'tech';
    const recipients: string[] =
      Array.isArray(body?.recipients) && body.recipients.length
        ? body.recipients.filter((r: unknown) => typeof r === 'string' && (r as string).includes('@'))
        : reportType === 'board' ? BOARD_RECIPIENTS : TECH_RECIPIENTS;

    const supabase = createClient(supabaseUrl, serviceKey);

    // Board memo: rebuilt (doc 201) on its own RPC, get_board_tech_memo, which
    // computes the 7 days ending dateStr straight from the source tables. It no
    // longer sums seven get_cto_daily_report payloads, so the rest of this
    // handler (which still carries the old board assembly) is tech-report only.
    if (reportType === 'board') {
      const { data: bd, error: bdErr } = await supabase.rpc('get_board_tech_memo', { p_date: dateStr });
      if (bdErr || !bd) {
        console.error('[daily-cto-report] board rpc failed', bdErr);
        return new Response(JSON.stringify({ error: 'board_metrics_failed', details: bdErr?.message ?? 'empty payload' }), {
          status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }
      const memo = composeBoard(bd);
      const memoPdf = await buildBoardMemoPdf(memo);
      const memoName = `Welile_Board_Technology_Report_Week_Ending_${dateStr}.pdf`;
      if (body?.preview === true) {
        return new Response(memoPdf as unknown as BodyInit, {
          status: 200,
          headers: { ...corsHeaders, 'Content-Type': 'application/pdf', 'Content-Disposition': `attachment; filename="${memoName}"` },
        });
      }
      const memoHtml = `
      <div style="font-family:Helvetica,Arial,sans-serif;color:${C.ink};max-width:680px;">
        <h2 style="margin:0 0 6px;font-size:19px;">Board Report: Technology &amp; Customer Reach</h2>
        <div style="font-size:12px;color:${C.muted};margin-bottom:14px;">${esc(memo.periodLabel)} (EAT)</div>
        <p style="font-size:13.5px;line-height:1.65;margin:0 0 12px;">${esc(memo.summary)}</p>
        ${memo.decide.length ? `<h4 style="font-size:13px;margin:12px 0 6px;">Decide</h4><ul style="font-size:13px;line-height:1.7;padding-left:18px;margin:0;">${memo.decide.map((b) => `<li>${esc(b)}</li>`).join('')}</ul>` : ''}
        <h4 style="font-size:13px;margin:12px 0 6px;">Note</h4>
        <ul style="font-size:13px;line-height:1.7;padding-left:18px;margin:0;">${memo.notes.map((b) => `<li>${esc(b)}</li>`).join('')}</ul>
        <p style="font-size:12px;color:${C.muted};margin:14px 0 0;">The full report is attached as a PDF.</p>
      </div>`;
      const mform = new FormData();
      mform.append('from', FROM);
      for (const r of recipients) mform.append('to', r);
      mform.append('h:Reply-To', REPLY_TO);
      mform.append('subject', `Welile Board Report: Technology & Customer Reach, week ending ${dateStr}`);
      mform.append('text', boardPlainText(memo));
      mform.append('html', memoHtml);
      mform.append('attachment', new Blob([memoPdf as unknown as BlobPart], { type: 'application/pdf' }), memoName);
      const mRes = await fetch(`${mgBase}/v3/${mgDomain}/messages`, {
        method: 'POST',
        headers: { Authorization: `Basic ${btoa(`api:${mgKey}`)}` },
        body: mform,
      });
      if (!mRes.ok) {
        const errBody = await mRes.text();
        console.error(`[daily-cto-report] Mailgun ${mRes.status}: ${errBody}`);
        return new Response(JSON.stringify({ error: 'mailgun_failed', status: mRes.status, details: errBody }), {
          status: 502, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
      }
      return new Response(JSON.stringify({ ok: true, date: dateStr, period: memo.periodLabel, report_type: 'board', recipients, attachment: memoName, pdf_bytes: memoPdf.length }), {
        status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const { data, error } = await supabase.rpc('get_cto_daily_report', { p_date: dateStr });
    if (error) {
      console.error('[daily-cto-report] rpc failed', error);
      return new Response(JSON.stringify({ error: 'metrics_failed', details: error.message }), {
        status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    // Deep technical diagnostics (best-effort: the summary report still ships if this fails)
    let diag: any = {};
    try {
      const { data: dg, error: dgErr } = await supabase.rpc('get_cto_diagnostics', { p_date: dateStr });
      if (dgErr) console.error('[daily-cto-report] diagnostics rpc failed', dgErr);
      else diag = dg || {};
    } catch (e) {
      console.error('[daily-cto-report] diagnostics threw', e);
    }

    // Engineering issue intelligence (ranked, fully diagnosed issues)
    let intel: any = {};
    try {
      const { data: it, error: itErr } = await supabase.rpc('get_cto_issue_intelligence', { p_date: dateStr });
      if (itErr) console.error('[daily-cto-report] intelligence rpc failed', itErr);
      else intel = it || {};
    } catch (e) {
      console.error('[daily-cto-report] intelligence threw', e);
    }

    // Same-day engineering addendum (strictly 24h scoped diagnostics)
    let addendum: any = {};
    try {
      const { data: ad, error: adErr } = await supabase.rpc('get_cto_daily_addendum', { p_date: dateStr });
      if (adErr) console.error('[daily-cto-report] addendum rpc failed', adErr);
      else addendum = ad || {};
    } catch (e) {
      console.error('[daily-cto-report] addendum threw', e);
    }
    const adFailedJobs: any[] = Array.isArray(addendum.failed_jobs) ? addendum.failed_jobs : [];
    const adJobsSummary: any = addendum.jobs_summary || {};
    const adUserErrors: any[] = Array.isArray(addendum.user_errors) ? addendum.user_errors : [];
    const adErrSummary: any = addendum.errors_summary || {};
    const adDbExceptions: any[] = Array.isArray(addendum.db_exceptions) ? addendum.db_exceptions : [];
    const adAntiBot: any = addendum.anti_bot || {};
    const adAbReasons: any[] = Array.isArray(adAntiBot.reasons) ? adAntiBot.reasons : [];
    const adAbIps: any[] = Array.isArray(adAntiBot.repeat_ips) ? adAntiBot.repeat_ips : [];
    const adAbDevices: any[] = Array.isArray(adAntiBot.repeat_devices) ? adAntiBot.repeat_devices : [];
    const adAuthErrors: any[] = Array.isArray(addendum.auth_errors) ? addendum.auth_errors : [];
    const adOtpErrors: any[] = Array.isArray(addendum.otp_errors) ? addendum.otp_errors : [];

    // OTP usage by category -- login, withdraw, landlord payout, signup, and
    // every other flow that gates on an SMS code (best-effort: the report
    // still ships if this RPC fails).
    let otpUsage: any = {};
    try {
      const { data: ou, error: ouErr } = await supabase.rpc('get_otp_usage_by_category', { p_date: dateStr });
      if (ouErr) console.error('[daily-cto-report] otp usage rpc failed', ouErr);
      else otpUsage = ou || {};
    } catch (e) {
      console.error('[daily-cto-report] otp usage threw', e);
    }
    const otpByCategory: any[] = Array.isArray(otpUsage.by_category) ? otpUsage.by_category : [];
    const otpTotals: any = otpUsage.totals || {};

    const d: any = data || {};
    const P = d.platform || {}, E = d.errors || {}, A = d.auth || {}, S = d.security || {},
      I = d.infra || {}, B = d.backups || {}, J = d.jobs || {}, M = d.email || {},
      R = d.roles || {}, SMS = d.sms || {}, OTP = d.otp || {}, SI = d.signin || {};


    // ---- Derived executive indicators -------------------------------------
    // Error rate must be a bounded percentage. The old formula divided total
    // error EVENTS (client_error_reports rows, 1,255 on 2026-08-07) by recorded
    // system events (588) which is a different, smaller population -> 213.44%.
    // Correct denominator = the active-user population for the period, and the
    // numerator = distinct users who hit an error (8 / 98 = 8.16%).
    const activeUsersForRate = Math.max(n(P.active_24h), n(E.affected_users_today));
    const errRate = pct(n(E.affected_users_today), Math.max(1, activeUsersForRate)); // share of active users hitting >=1 error
    // Unbounded volume indicator kept separately (never presented as a percentage).
    const errorsPer1kEvents = n(P.events_today) > 0 ? (n(E.today) / n(P.events_today)) * 1000 : 0;
    const loginFailRate = pct(n(A.login_failures_today), Math.max(1, n(A.login_events_today)));
    const jobFailRate = pct(n(J.failed_24h), Math.max(1, n(J.runs_24h)));
    const emailFailRate = pct(n(M.failed_today), Math.max(1, n(M.sent_today)));
    const connSat = pct(n(I.connections), Math.max(1, n(I.max_connections)));
    const rlsCoverage = pct(n(S.rls_tables), Math.max(1, n(S.public_tables)));
    const cacheHit = n(I.cache_hit_pct);
    // ---- Backup recency (intended cadence: weekly-database-backup, Sun 02:00 UTC) ----
    const BACKUP_CADENCE_HOURS = 168;      // weekly
    const BACKUP_WARN_HOURS = 180;         // ~7.5 days: window slipped
    const BACKUP_RED_HOURS = 192;          // ~8 days: a full cycle missed
    const latestBackupAt = B.latest?.created_at && String(B.latest.status) === 'success'
      ? new Date(String(B.latest.created_at))
      : null;
    const backupAgeHours = latestBackupAt
      ? Math.max(0, (Date.now() - latestBackupAt.getTime()) / 3_600_000)
      : Number.POSITIVE_INFINITY;
    const backupAgeLabel = Number.isFinite(backupAgeHours)
      ? `${Math.floor(backupAgeHours / 24)}d ${Math.round(backupAgeHours % 24)}h old`
      : 'no successful backup on record';
    const backupFresh = backupAgeHours <= BACKUP_CADENCE_HOURS;
    const backupStaleTone: Tone = backupAgeHours > BACKUP_RED_HOURS ? 'bad' : backupAgeHours > BACKUP_WARN_HOURS ? 'warn' : 'good';
    // Zero failures inside a window that has not actually produced a recent
    // success is not evidence of health, so recency now gates the verdict.
    const backupOk = n(B.runs_7d) > 0 && n(B.failures_7d) === 0 && backupFresh;
    // Same rule, parameterised so the weekly rollup can evaluate each day
    // against its own backup state (now that the RPC returns backups.latest
    // / runs_7d / failures_7d scoped to that day) instead of reusing today's
    // backupOk for all seven days.
    const computeBackupOk = (b: any, referenceMs: number): boolean => {
      const at = b?.latest?.created_at && String(b.latest.status) === 'success' ? new Date(String(b.latest.created_at)).getTime() : null;
      const ageHours = at != null ? Math.max(0, (referenceMs - at) / 3_600_000) : Number.POSITIVE_INFINITY;
      return n(b?.runs_7d) > 0 && n(b?.failures_7d) === 0 && ageHours <= BACKUP_CADENCE_HOURS;
    };

    // Weighted technology health score (0-100)
    const scoreParts = [
      { label: 'Reliability', w: 25, v: Math.max(0, 100 - errRate * 12) },
      { label: 'Authentication', w: 15, v: Math.max(0, 100 - loginFailRate * 1.6) },
      { label: 'Automation', w: 15, v: Math.max(0, 100 - jobFailRate * 4) },
      { label: 'Infrastructure', w: 20, v: Math.min(100, cacheHit * 0.7 + Math.max(0, 100 - connSat) * 0.3) },
      { label: 'Security', w: 15, v: rlsCoverage },
      { label: 'Continuity', w: 10, v: backupOk ? 100 : 45 },
    ];
    const health = Math.round(scoreParts.reduce((s, p) => s + (p.v * p.w) / 100, 0));
    const healthTone: Tone = health >= 85 ? 'good' : health >= 70 ? 'warn' : 'bad';
    const healthLabel = health >= 85 ? 'Healthy' : health >= 70 ? 'Watch' : 'At risk';

    // ---- Section 1: Executive Summary -------------------------------------
    const summaryPoints: string[] = [];
    summaryPoints.push(`Platform served ${fmt(P.active_24h)} active users in the last 24 hours across ${fmt(P.events_today)} recorded system events and ${fmt(P.txn_today)} ledger postings.`);
    summaryPoints.push(`Client-side errors ${n(E.today) <= n(E.prev_day) ? 'improved' : 'increased'} to ${fmt(E.today)} (${delta(n(E.today), n(E.prev_day))} vs prior day), affecting ${fmt(E.affected_users_today)} users.`);
    summaryPoints.push(`Authentication success rate stands at ${(100 - loginFailRate).toFixed(1)}% with median sign-in latency of ${fmt(A.median_login_ms_today)} ms (average ${fmt(A.avg_login_ms_today)} ms${n(A.login_attempts_over_60s_today) > 0 ? `, skewed by ${fmt(A.login_attempts_over_60s_today)} attempts over 60s affecting ${fmt(A.login_users_over_60s_today)} users` : ''}).`);
    summaryPoints.push(`${fmt(J.total_scheduled)} scheduled automations executed ${fmt(J.runs_24h)} runs with a ${jobFailRate.toFixed(1)}% failure rate.`);
    summaryPoints.push(`Database is ${bytes(I.db_size_bytes)} with ${cacheHit.toFixed(2)}% cache hit ratio and ${connSat.toFixed(0)}% connection saturation.`);

    const execSummary = `
      <div style="border:1px solid ${C.line};border-radius:12px;padding:16px;background:#fff;">
        <table role="presentation" width="100%"><tr>
          <td style="vertical-align:middle;width:130px;">
            <div style="border:3px solid ${toneColor(healthTone)};border-radius:12px;padding:12px;text-align:center;">
              <div style="font-size:34px;font-weight:800;color:${toneColor(healthTone)};line-height:1;">${health}</div>
              <div style="font-size:10px;text-transform:uppercase;letter-spacing:.08em;color:${C.muted};margin-top:6px;font-weight:700;">Health score</div>
              <div style="font-size:11px;color:${toneColor(healthTone)};font-weight:700;margin-top:2px;">${healthLabel}</div>
            </div>
          </td>
          <td style="vertical-align:top;padding-left:16px;">
            <ul style="margin:0;padding-left:18px;font-size:12.5px;color:${C.ink};line-height:1.7;">
              ${summaryPoints.map((p) => `<li>${esc(p)}</li>`).join('')}
            </ul>
          </td>
        </tr></table>
        <div style="margin-top:14px;">
          ${chart(scoreParts.map((p) => bar(`${p.label} (${p.w}%)`, Math.round(p.v), 100, p.v >= 85 ? 'good' : p.v >= 70 ? 'warn' : 'bad')).join(''))}
        </div>
      </div>`;

    // ---- Section 2: Platform Health ---------------------------------------
    const platformCards = kpiRows([
      kpi('Total users', fmt(P.total_users), `${fmt(P.new_users_today)} joined today`),
      kpi('Active 24h', fmt(P.active_24h), `${fmt(P.active_7d)} weekly · ${fmt(P.active_30d)} monthly`),
      kpi('System events', fmt(P.events_today), `${delta(n(P.events_today), n(P.events_prev_day))} vs prior day`),
      kpi('Ledger postings', fmt(P.txn_today), 'financial transactions today'),
      kpi('Error rate', `${errRate.toFixed(2)}%`, 'share of active users hitting an error', errRate < 1 ? 'good' : errRate < 3 ? 'warn' : 'bad'),
      kpi('Error volume', `${errorsPer1kEvents.toFixed(0)}`, 'error reports per 1,000 system events'),
      kpi('Errors today', fmt(E.today), `${delta(n(E.today), n(E.prev_day))} vs prior day`, n(E.today) <= n(E.prev_day) ? 'good' : 'warn'),
      kpi('Affected users', fmt(E.affected_users_today), 'distinct users hitting errors'),
      kpi('Browser compat events', fmt(E.compat_events_7d), 'last 7 days'),
    ]);
    const trend: any[] = Array.isArray(E.daily_trend) ? E.daily_trend : [];
    const trendMax = Math.max(1, ...trend.map((t) => n(t.n)));
    const trendChart = trend.length
      ? `<div style="margin-top:14px;"><div style="font-size:11px;font-weight:700;color:${C.muted};text-transform:uppercase;letter-spacing:.06em;margin-bottom:6px;">Client error trend — last 14 days</div>${chart(trend.map((t) => bar(String(t.d), n(t.n), trendMax, n(t.n) > trendMax * 0.6 ? 'bad' : 'neutral')).join(''))}</div>`
      : '';

    // ---- Section 3: Infrastructure ----------------------------------------
    const infraCards = kpiRows([
      kpi('Database size', bytes(I.db_size_bytes), 'total on-disk'),
      kpi('Cache hit ratio', `${cacheHit.toFixed(2)}%`, 'target above 99%', cacheHit >= 99 ? 'good' : 'warn'),
      kpi('Connections', `${fmt(I.connections)} / ${fmt(I.max_connections)}`, `${connSat.toFixed(0)}% saturation`, connSat < 60 ? 'good' : connSat < 85 ? 'warn' : 'bad'),
      kpi('Uptime', `${fmt(I.uptime_hours)} h`, 'since last restart'),
      kpi('Deadlocks', fmt(I.deadlocks), 'cumulative since boot', n(I.deadlocks) < 100 ? 'good' : 'warn'),
      kpi('Rolled-back txns', I.rollback_trustworthy === true ? fmt(I.rollbacks) : 'Unavailable',
        I.rollback_trustworthy === true ? `${fmt(I.commits)} commits` : 'No trustworthy same-day snapshot pair'),
      kpi('Scheduled jobs', fmt(J.total_scheduled), `${fmt(J.runs_24h)} runs in 24h`),
      kpi('Job failure rate', `${jobFailRate.toFixed(1)}%`, `${fmt(J.failed_24h)} failed runs`, jobFailRate < 1 ? 'good' : jobFailRate < 5 ? 'warn' : 'bad'),
    ]);
    const largest: any[] = Array.isArray(I.largest_tables) ? I.largest_tables : [];
    const largestMax = Math.max(1, ...largest.map((t) => n(t.bytes)));
    const storageChart = largest.length
      ? `<div style="margin-top:14px;"><div style="font-size:11px;font-weight:700;color:${C.muted};text-transform:uppercase;letter-spacing:.06em;margin-bottom:6px;">Storage footprint — largest tables</div>
         ${chart(largest.map((t) => `
          <tr>
            <td style="padding:3px 8px 3px 0;font-size:11px;color:${C.muted};width:180px;">${esc(t.table_name)}</td>
            <td style="padding:3px 0;"><div style="background:${C.bg};border-radius:4px;height:12px;"><div style="background:${C.brand};height:12px;width:${Math.max(2, Math.round((n(t.bytes) / largestMax) * 100))}%;border-radius:4px;"></div></div></td>
            <td style="padding:3px 0 3px 8px;font-size:11px;font-weight:700;text-align:right;width:80px;">${bytes(t.bytes)}</td>
          </tr>`).join(''))}</div>`
      : '';
    const failingJobs: any[] = Array.isArray(J.failing) ? J.failing : [];
    const jobTable = table(
      ['Automation', 'Failures 24h', 'Last error'],
      failingJobs.map((j) => [esc(j.jobname), `<b style="color:${C.bad}">${fmt(j.n)}</b>`, `<span style="color:${C.muted}">${esc(j.last_error)}</span>`]),
    );

    // ---- Section 4: Engineering Performance --------------------------------
    const topRoutes: any[] = Array.isArray(E.top_routes) ? E.top_routes : [];
    const topMsgs: any[] = Array.isArray(E.top_messages) ? E.top_messages : [];
    const slow: any[] = Array.isArray(d.slow_queries) ? d.slow_queries : [];
    const engCards = kpiRows([
      kpi('Errors 7d', fmt(E.last_7d), 'client-reported defects'),
      kpi('Defect hotspots', String(topRoutes.length), 'routes with recurring errors'),
      kpi('Slowest query', slow.length ? `${fmt(slow[0]?.mean_ms)} ms` : 'n/a', 'mean execution time', slow.length && n(slow[0]?.mean_ms) > 500 ? 'warn' : 'good'),
      kpi('Audit writes', fmt(S.audit_writes_today), 'change records logged today'),
    ]);
    const routeTable = table(['Route', 'Errors (7d)'], topRoutes.map((r) => [esc(r.route), fmt(r.n)]));
    const msgTable = table(['Most frequent error', 'Occurrences (7d)'], topMsgs.map((m) => [esc(m.message), fmt(m.n)]));
    const slowTable = table(['Query (truncated)', 'Mean ms', 'Calls'],
      slow.map((q) => [`<code style="font-size:11px;color:${C.muted}">${esc(q.query)}</code>`, `<b>${fmt(q.mean_ms)}</b>`, fmt(q.calls)]));

    // ---- Section 5: Cybersecurity -----------------------------------------
    const secCards = kpiRows([
      kpi('RLS coverage', `${rlsCoverage.toFixed(1)}%`, `${fmt(S.rls_tables)} of ${fmt(S.public_tables)} tables`, rlsCoverage >= 95 ? 'good' : 'warn'),
      kpi('Privileged accounts', fmt(S.privileged_accounts), 'executive and admin roles', n(S.privileged_accounts) <= 25 ? 'good' : 'warn'),
      kpi('Active fraud blocks', fmt(S.fraud_blocks_active), `${fmt(S.fraud_blocks_today)} raised today`),
      kpi('Blocked signup IPs', fmt(S.blocked_ips_total), 'cumulative'),
      kpi('Signup attempts', fmt(S.signup_attempts_today), `${fmt(S.signup_blocked_today)} rejected today`),
      kpi('Login failures', fmt(A.login_failures_today), `${loginFailRate.toFixed(1)}% of attempts`, loginFailRate < 20 ? 'good' : loginFailRate < 40 ? 'warn' : 'bad'),
      kpi('OTP attempts', fmt(A.otp_attempts_today), `${fmt(A.otp_failures_today)} failed`),
      kpi('Audit trail writes', fmt(S.audit_writes_today), 'immutable change log'),
    ]);

    // ---- Section 6: Product Development ------------------------------------
    const prodCards = kpiRows([
      kpi('Events 7d', fmt(P.events_7d), 'feature usage signal'),
      kpi('New users 24h', fmt(P.new_users_today), 'acquisition into product'),
      kpi('Weekly actives', fmt(P.active_7d), `${pct(n(P.active_7d), Math.max(1, n(P.total_users))).toFixed(1)}% of base`),
      kpi('Monthly actives', fmt(P.active_30d), `${pct(n(P.active_30d), Math.max(1, n(P.total_users))).toFixed(1)}% of base`),
    ]);

    // ---- Section 7: Customer Technology Experience --------------------------
    const cxCards = kpiRows([
      kpi('Sign-in latency', `${fmt(A.median_login_ms_today)} ms median (avg ${fmt(A.avg_login_ms_today)} ms)`, n(A.login_attempts_over_60s_today) > 0 ? `${fmt(A.login_attempts_over_60s_today)} attempts over 60s (${fmt(A.login_users_over_60s_today)} users) skew the average` : 'average today', n(A.median_login_ms_today) < 1500 ? 'good' : n(A.median_login_ms_today) < 3000 ? 'warn' : 'bad'),
      kpi('Auth success', `${(100 - loginFailRate).toFixed(1)}%`, `${fmt(A.login_events_today)} attempts`, loginFailRate < 20 ? 'good' : 'warn'),
      kpi('Users hitting errors', fmt(E.affected_users_today), `${pct(n(E.affected_users_today), Math.max(1, n(P.active_24h))).toFixed(2)}% of actives`),
      kpi('Notification delivery', `${(100 - emailFailRate).toFixed(1)}%`, `${fmt(M.sent_today)} emails sent today`, emailFailRate < 5 ? 'good' : 'warn'),
    ]);

    // ---- Section 8: System Monitoring ---------------------------------------
    const monCards = kpiRows([
      kpi('Automation runs 24h', fmt(J.runs_24h), `${fmt(J.failed_24h)} failed`),
      kpi('Email sent 7d', fmt(M.sent_7d), `${fmt(M.failed_today)} failed today`),
      kpi('Backups 7d', fmt(B.runs_7d), `${fmt(B.failures_7d)} failures`, backupOk ? 'good' : 'bad'),
      kpi('Latest backup', B.latest?.status ? String(B.latest.status) : 'none', B.latest?.created_at ? String(B.latest.created_at).slice(0, 16).replace('T', ' ') : 'no run recorded', backupOk ? 'good' : 'bad'),
    ]);

    // ---- Section 9: Data & Analytics ----------------------------------------
    const dataCards = kpiRows([
      kpi('Public tables', fmt(S.public_tables), 'modelled entities'),
      kpi('Ledger volume', fmt(P.txn_today), 'postings today'),
      kpi('Largest table', largest[0]?.table_name ? String(largest[0].table_name) : 'n/a', largest[0] ? bytes(largest[0].bytes) : ''),
      kpi('Total storage', bytes(I.db_size_bytes), 'database on disk'),
    ]);

    // ---- Section 11: Risk register / heat map --------------------------------
    type Risk = { area: string; risk: string; likelihood: 'Low' | 'Medium' | 'High'; impact: 'Low' | 'Medium' | 'High'; action: string };
    const risks: Risk[] = [];
    if (jobFailRate >= 1) risks.push({ area: 'Automation', risk: `${fmt(J.failed_24h)} scheduled job failures in 24h`, likelihood: jobFailRate > 5 ? 'High' : 'Medium', impact: 'High', action: 'Triage failing crons and restore green runs' });
    if (errRate >= 1) risks.push({ area: 'Reliability', risk: `Client error rate at ${errRate.toFixed(2)}%`, likelihood: errRate > 3 ? 'High' : 'Medium', impact: 'Medium', action: 'Fix top defect route and redeploy' });
    if (loginFailRate >= 20) risks.push({ area: 'Access', risk: `Sign-in failure rate at ${loginFailRate.toFixed(1)}%`, likelihood: 'High', impact: 'High', action: 'Investigate credential and OTP failure causes' });
    if (rlsCoverage < 98) risks.push({ area: 'Security', risk: `${fmt(n(S.public_tables) - n(S.rls_tables))} tables without row level security`, likelihood: 'Medium', impact: 'High', action: 'Enable RLS and policies on exposed tables' });
    if (!backupOk) risks.push({ area: 'Continuity', risk: 'Backup coverage incomplete in the last 7 days', likelihood: 'Medium', impact: 'High', action: 'Restore backup schedule and verify restorability' });
    if (connSat >= 70) risks.push({ area: 'Capacity', risk: `Connection saturation at ${connSat.toFixed(0)}%`, likelihood: 'Medium', impact: 'Medium', action: 'Increase database compute or pool limits' });
    if (n(I.deadlocks) > 100) risks.push({ area: 'Concurrency', risk: `${fmt(I.deadlocks)} deadlocks since boot`, likelihood: 'Low', impact: 'Medium', action: 'Review lock ordering in high-contention writes' });
    if (!risks.length) risks.push({ area: 'General', risk: 'No material technology risk detected today', likelihood: 'Low', impact: 'Low', action: 'Maintain current controls' });
    const riskTable = table(['Area', 'Risk', 'Likelihood', 'Impact', 'Mitigation'],
      risks.map((r) => [esc(r.area), esc(r.risk), riskCell(r.likelihood), riskCell(r.impact), esc(r.action)]));

    // ---- Section 12: Compliance ----------------------------------------------
    const compTable = table(['Control', 'Status', 'Evidence'], [
      ['Row level security enforced', rlsCoverage >= 98 ? `<b style="color:${C.good}">Compliant</b>` : `<b style="color:${C.warn}">Partial</b>`, `${fmt(S.rls_tables)} of ${fmt(S.public_tables)} public tables`],
      ['Immutable audit trail', n(S.audit_writes_today) > 0 ? `<b style="color:${C.good}">Active</b>` : `<b style="color:${C.warn}">No writes today</b>`, `${fmt(S.audit_writes_today)} entries logged`],
      ['Data backup and retention', backupOk ? `<b style="color:${C.good}">Compliant</b>` : `<b style="color:${C.bad}">Attention</b>`, `${fmt(B.runs_7d)} runs, ${fmt(B.failures_7d)} failures in 7 days`],
      ['Privileged access review', n(S.privileged_accounts) <= 25 ? `<b style="color:${C.good}">Within limit</b>` : `<b style="color:${C.warn}">Review needed</b>`, `${fmt(S.privileged_accounts)} privileged accounts`],
      ['Fraud and AML controls', `<b style="color:${C.good}">Operating</b>`, `${fmt(S.fraud_blocks_active)} active identity blocks`],
      ['Double-entry financial integrity', `<b style="color:${C.good}">Enforced</b>`, `${fmt(P.txn_today)} balanced ledger postings today`],
    ]);

    // ---- Section 13: CTO KPIs -------------------------------------------------
    const kpiTable = table(['KPI', 'Today', 'Target', 'Status'], [
      ['Technology health score', String(health), '85+', health >= 85 ? `<b style="color:${C.good}">On target</b>` : `<b style="color:${C.warn}">Below target</b>`],
      ['Client error rate', `${errRate.toFixed(2)}%`, 'Below 1%', errRate < 1 ? `<b style="color:${C.good}">On target</b>` : `<b style="color:${C.warn}">Above target</b>`],
      ['Authentication success', `${(100 - loginFailRate).toFixed(1)}%`, '90%+', loginFailRate < 10 ? `<b style="color:${C.good}">On target</b>` : `<b style="color:${C.warn}">Below target</b>`],
      ['Automation success', `${(100 - jobFailRate).toFixed(1)}%`, '99%+', jobFailRate < 1 ? `<b style="color:${C.good}">On target</b>` : `<b style="color:${C.warn}">Below target</b>`],
      ['Database cache hit', `${cacheHit.toFixed(2)}%`, '99%+', cacheHit >= 99 ? `<b style="color:${C.good}">On target</b>` : `<b style="color:${C.warn}">Below target</b>`],
      ['Connection headroom', `${(100 - connSat).toFixed(0)}%`, '40%+', connSat <= 60 ? `<b style="color:${C.good}">On target</b>` : `<b style="color:${C.warn}">Tight</b>`],
      ['Notification delivery', `${(100 - emailFailRate).toFixed(1)}%`, '95%+', emailFailRate < 5 ? `<b style="color:${C.good}">On target</b>` : `<b style="color:${C.warn}">Below target</b>`],
    ]);

    // ---- Section 14: Recommendations -------------------------------------------
    const recs: string[] = [];
    if (failingJobs.length) recs.push(`Restore ${failingJobs.length} failing automation${failingJobs.length > 1 ? 's' : ''}, starting with ${esc(failingJobs[0].jobname)} (${fmt(failingJobs[0].n)} failures in 24h).`);
    if (topRoutes.length) recs.push(`Prioritise a defect fix on ${esc(topRoutes[0].route)}, which produced ${fmt(topRoutes[0].n)} client errors this week.`);
    if (loginFailRate >= 20) recs.push(`Run an authentication reliability review: ${loginFailRate.toFixed(1)}% of sign-in attempts failed today.`);
    if (rlsCoverage < 98) recs.push(`Close the security gap on ${fmt(n(S.public_tables) - n(S.rls_tables))} tables that do not yet enforce row level security.`);
    if (slow.length && n(slow[0]?.mean_ms) > 500) recs.push(`Index or refactor the slowest query path (${fmt(slow[0].mean_ms)} ms mean over ${fmt(slow[0].calls)} calls).`);
    if (!backupOk) recs.push('Re-establish verified daily backups and complete a restore drill this week.');
    if (connSat >= 70) recs.push(`Plan a compute upgrade: connection saturation is at ${connSat.toFixed(0)}%.`);
    if (emailFailRate >= 5) recs.push(`Investigate notification delivery: ${fmt(M.failed_today)} of ${fmt(M.sent_today)} emails failed today.`);
    if (!recs.length) recs.push('No corrective action required. Maintain current engineering and reliability posture.');
    const recsHtml = `<ol style="margin:0;padding-left:18px;font-size:12.5px;line-height:1.8;color:${C.ink};">${recs.map((r) => `<li>${r}</li>`).join('')}</ol>`;

    const innovation = `
      <table role="presentation" width="100%"><tr>
        <td style="vertical-align:top;padding-right:8px;width:50%;">
          <div style="border:1px solid ${C.line};border-radius:10px;padding:14px;background:#fff;">
            <div style="font-size:11px;font-weight:800;text-transform:uppercase;letter-spacing:.06em;color:${C.muted};">Active initiatives</div>
            <ul style="margin:8px 0 0;padding-left:18px;font-size:12px;line-height:1.7;color:${C.ink};">
              <li>Ledger-first wallet architecture with strict withdrawable enforcement</li>
              <li>Trust scoring engine driving credit and vouch limits</li>
              <li>Agent field operations with geo-verified visit capture</li>
              <li>Automated financial reconciliation and drift detection</li>
            </ul>
          </div>
        </td>
        <td style="vertical-align:top;padding-left:8px;width:50%;">
          <div style="border:1px solid ${C.line};border-radius:10px;padding:14px;background:#fff;">
            <div style="font-size:11px;font-weight:800;text-transform:uppercase;letter-spacing:.06em;color:${C.muted};">Research focus</div>
            <ul style="margin:8px 0 0;padding-left:18px;font-size:12px;line-height:1.7;color:${C.ink};">
              <li>Predictive default and collection-risk modelling</li>
              <li>Low-bandwidth performance for field agents</li>
              <li>Automated anomaly detection on financial flows</li>
              <li>Scale readiness toward multi-million user load</li>
            </ul>
          </div>
        </td>
      </tr></table>`;

    // ---- Deep diagnostics rendering ---------------------------------------
    const DG: any = diag || {};
    const dSum: any = DG.summary || {};
    const dErrors: any[] = Array.isArray(DG.errors) ? DG.errors : [];
    const dFront: any = DG.frontend || {};
    const dApi: any[] = Array.isArray(DG.api_failures) ? DG.api_failures : [];
    const dDb: any = DG.database || {};
    const dJobs: any[] = Array.isArray(DG.automations) ? DG.automations : [];
    const dAuth: any = DG.auth || {};
    const dInfra: any[] = Array.isArray(DG.infrastructure) ? DG.infrastructure : [];
    const dSec: any = DG.security || {};
    const dReg: any = DG.regression || {};
    const dActions: any[] = Array.isArray(DG.action_items) ? DG.action_items : [];
    const arr = (v: unknown) => (Array.isArray(v) ? v : []);

    const diagOverview = kpiRows([
      kpi('Client errors today', fmt(dSum.client_errors_today)),
      kpi('Users affected', fmt(dSum.affected_users_today)),
      kpi('Distinct signatures', fmt(dSum.distinct_signatures)),
      kpi('Critical signatures', fmt(dSum.critical_signatures), '', n(dSum.critical_signatures) > 0 ? 'bad' : 'good'),
      kpi('Failing automations', fmt(dSum.failing_automations), '', n(dSum.failing_automations) > 0 ? 'warn' : 'good'),
      kpi('Failing endpoints', fmt(dSum.failing_endpoints), '', n(dSum.failing_endpoints) > 0 ? 'warn' : 'good'),
      kpi('Breached infra alerts', fmt(dSum.breached_infra_alerts), '', n(dSum.breached_infra_alerts) > 0 ? 'bad' : 'good'),
      kpi('Open action items', fmt(dSum.open_action_items)),
    ]);

    const errorDossier = dErrors.length
      ? dErrors.slice(0, 8).map((e, i) => errorCard(e, i + 1)).join('')
      : `<div style="font-size:12px;color:${C.muted};">No client error signatures recorded for this day.</div>`;

    const criticalTable = table(
      ['Error', 'Severity', 'Occurrences', 'Users', 'Feature area', 'Revenue risk', 'Owner', 'Target'],
      dErrors.slice(0, 20).map((e) => [
        esc(String(e.message || '').slice(0, 90)), sevBadge(String(e.severity || 'Low')),
        fmt(e.occurrences_today), fmt(e.affected_users_today), esc(String(e.feature_area || '-')),
        yesNo(e.revenue_exposed), esc(String(e.owner_team || '-')), esc(String(e.expected_resolution || '-')),
      ]),
    );

    const apiTable = table(
      ['Endpoint', 'Method', 'Failures', 'Users', 'Status', 'First seen', 'Last seen', 'Root cause and fix'],
      dApi.map((a: any) => [
        esc(String(a.endpoint || '-')), esc(String(a.method || '-')), fmt(a.failed_requests), fmt(a.affected_users),
        esc(String(a.status_codes || '-')), esc(ts(a.first_seen)), esc(ts(a.last_seen)),
        `${esc(String(a.root_cause || ''))} <span style="color:${C.muted};">${esc(String(a.recommended_fix || ''))}</span>`,
      ]),
    );

    const dbSection = [
      subLabel('Slowest statements with tuning guidance'),
      table(['Statement', 'Calls', 'Mean ms', 'Max ms', 'Cache hit', 'Disk reads', 'Recommendation'],
        arr(dDb.slow_queries).map((q: any) => [
          `<span style="font-family:ui-monospace,Menlo,Consolas,monospace;font-size:10.5px;">${esc(String(q.query || '').slice(0, 260))}</span>`,
          fmt(q.calls), fmt(q.mean_ms), fmt(q.max_ms), `${fmt(q.cache_hit_pct)}%`, fmt(q.disk_reads),
          esc(String(q.recommendation || '')),
        ])),
      subLabel('Tables dominated by sequential scans (missing index candidates)'),
      table(['Table', 'Seq scans', 'Rows read sequentially', 'Index scans', 'Live rows', 'Recommendation'],
        arr(dDb.missing_indexes).map((m: any) => [
          esc(String(m.table)), fmt(m.sequential_scans), fmt(m.rows_read_sequentially), fmt(m.index_scans), fmt(m.live_rows),
          esc(String(m.recommendation || '')),
        ])),
      subLabel(`Lock contention — ${fmt(dDb.lock_waits)} ungranted locks`),
      table(['PID', 'Wait event', 'Waiting (s)', 'Query'],
        arr(dDb.blocked_queries).map((b: any) => [
          esc(String(b.pid)), esc(String(b.wait_event)), fmt(b.waiting_for),
          `<span style="font-family:ui-monospace,Menlo,Consolas,monospace;font-size:10.5px;">${esc(String(b.query || '').slice(0, 160))}</span>`,
        ])),
      subLabel('Vacuum / bloat candidates'),
      table(['Table', 'Dead rows', 'Live rows', 'Last autovacuum'],
        arr(dDb.bloat_candidates).map((b: any) => [
          esc(String(b.table)), fmt(b.dead_rows), fmt(b.live_rows), esc(ts(b.last_autovacuum)),
        ])),
      `<div style="font-size:11px;color:${C.muted};margin-top:8px;">${esc(String(dDb.note || ''))}</div>`,
    ].join('');

    const jobDetailTable = table(
      ['Automation', 'Schedule', 'Failures / runs', 'Last failure', 'Last success', 'Exception', 'Retry status', 'Fix'],
      dJobs.map((j: any) => [
        esc(String(j.automation)), esc(String(j.schedule || '-')), `${fmt(j.failures_24h)} / ${fmt(j.runs_24h)}`,
        esc(ts(j.last_failure_at)), esc(ts(j.last_success_at)),
        `<span style="font-family:ui-monospace,Menlo,Consolas,monospace;font-size:10.5px;">${esc(String(j.exception || 'not captured').slice(0, 260))}</span>`,
        esc(String(j.retry_status || '')), esc(String(j.recommended_fix || '')),
      ]),
    );

    const frontendSection = [
      subLabel('Errors by route'),
      table(['Route', 'Errors', 'Users'], arr(dFront.by_route).map((r: any) => [esc(String(r.route)), fmt(r.n), fmt(r.users)])),
      subLabel('Errors by browser'),
      table(['Browser', 'Errors', 'Users'], arr(dFront.by_browser).map((r: any) => [esc(String(r.browser)), fmt(r.n), fmt(r.users)])),
      subLabel('Errors by operating system and device'),
      table(['Segment', 'Errors'], [
        ...arr(dFront.by_os).map((r: any) => [esc(String(r.os)), fmt(r.n)]),
        ...arr(dFront.by_device).map((r: any) => [esc(String(r.device)), fmt(r.n)]),
      ]),
      subLabel('Errors by component and source file'),
      table(['Component or file', 'Errors'], [
        ...arr(dFront.by_component).map((r: any) => [esc(String(r.component)), fmt(r.n)]),
        ...arr(dFront.by_file).map((r: any) => [esc(String(r.file)), fmt(r.n)]),
      ]),
      subLabel('Browser compatibility events'),
      table(['Event', 'Count', 'Sample'], arr(dFront.compat_events).map((r: any) => [esc(String(r.event_type)), fmt(r.n), esc(String(r.sample || '-'))])),
    ].join('');

    const authSection = [
      kpiRows([
        kpi('Sign-in attempts', fmt(dAuth.login_attempts)),
        kpi('Sign-in failures', fmt(dAuth.login_failures), '', n(dAuth.login_failures) > 0 ? 'warn' : 'good'),
        kpi('OTP identity mismatches', fmt(dAuth.otp_identity_mismatch), '', n(dAuth.otp_identity_mismatch) > 0 ? 'bad' : 'good'),
      ]),
      subLabel('Failure reasons'),
      table(['Reason', 'Occurrences', 'Users'], arr(dAuth.failure_breakdown).map((r: any) => [esc(String(r.reason)), fmt(r.n), fmt(r.users)])),
      subLabel('Slowest authentication phases'),
      table(['Phase', 'Average ms', 'Max ms', 'Samples'], arr(dAuth.slowest_phases).map((r: any) => [esc(String(r.phase)), fmt(r.avg_ms), fmt(r.max_ms), fmt(r.n)])),
      subLabel('One-time password outcomes'),
      table(['Outcome', 'Reason', 'Stage', 'Count'], arr(dAuth.otp_breakdown).map((r: any) => [esc(String(r.outcome)), esc(String(r.reason)), esc(String(r.stage)), fmt(r.n)])),
      subLabel('Device and installation issues'),
      table(['Event', 'Platform', 'Count'], arr(dAuth.device_issues).map((r: any) => [esc(String(r.event_type)), esc(String(r.platform)), fmt(r.n)])),
    ].join('');

    const infraAlertTable = table(
      ['Metric', 'Current', 'Threshold', 'Status', 'Root cause', 'Impact', 'Action'],
      dInfra.map((i: any) => [
        esc(String(i.metric)), esc(String(i.current)), esc(String(i.threshold)),
        i.status === 'Breached' ? riskCell('High') : i.status === 'Watch' ? riskCell('Medium') : riskCell('Low'),
        esc(String(i.root_cause)), esc(String(i.impact)), esc(String(i.action)),
      ]),
    );

    const securitySection = [
      kpiRows([
        kpi('Signup attempts', fmt(dSec.signup_attempts)),
        kpi('Signups blocked', fmt(dSec.signup_blocked)),
        kpi('IPs blocked today', fmt(dSec.blocked_ips_added_today)),
        kpi('Fraud identity blocks', fmt(dSec.fraud_blocks_today)),
        kpi('Authorisation violations', fmt(dSec.authorization_violations), '', n(dSec.authorization_violations) > 0 ? 'warn' : 'good'),
        kpi('Injection probes', fmt(dSec.injection_probes), '', n(dSec.injection_probes) > 0 ? 'bad' : 'good'),
      ]),
      subLabel('Suspicious IP addresses — last 7 days'),
      table(['IP address', 'Attempts', 'Distinct identities', 'Last seen'],
        arr(dSec.suspicious_ips).map((r: any) => [esc(String(r.ip)), fmt(r.attempts), fmt(r.distinct_identities), esc(ts(r.last_seen))])),
      subLabel('Possible brute-force identities'),
      table(['Identity', 'Failed attempts', 'Last attempt'],
        arr(dSec.brute_force_candidates).map((r: any) => [esc(String(r.identity)), fmt(r.failed_attempts), esc(ts(r.last_attempt))])),
      subLabel('Privilege and access changes'),
      table(['Action', 'Table', 'Count', 'Last change'],
        arr(dSec.privilege_changes).map((r: any) => [esc(String(r.action_type)), esc(String(r.table_name)), fmt(r.n), esc(ts(r.last_at))])),
      `<div style="font-size:11px;color:${C.muted};margin-top:8px;">${esc(String(dSec.note || ''))}</div>`,
    ].join('');

    const regressionSection = [
      subLabel('New errors introduced today'),
      table(['Error', 'Occurrences today'], arr(dReg.new_errors).map((r: any) => [esc(String(r.error)), fmt(r.today)])),
      subLabel('Errors resolved since yesterday'),
      table(['Error', 'Occurrences yesterday'], arr(dReg.resolved_errors).map((r: any) => [esc(String(r.error)), fmt(r.yesterday)])),
      subLabel('Worsening errors'),
      table(['Error', 'Yesterday', 'Today', 'Change'], arr(dReg.worsening).map((r: any) => [esc(String(r.error)), fmt(r.yesterday), fmt(r.today), delta(n(r.today), n(r.yesterday))])),
      subLabel('Improving errors'),
      table(['Error', 'Yesterday', 'Today', 'Change'], arr(dReg.improving).map((r: any) => [esc(String(r.error)), fmt(r.yesterday), fmt(r.today), delta(n(r.today), n(r.yesterday))])),
      subLabel('Recurring errors present on both days'),
      table(['Error', 'Yesterday', 'Today'], arr(dReg.recurring).map((r: any) => [esc(String(r.error)), fmt(r.yesterday), fmt(r.today)])),
    ].join('');

    const actionTable = table(
      ['Priority', 'Issue', 'Recommended action', 'Team', 'Owner', 'Due date', 'Status', 'Blockers'],
      dActions.map((a: any) => [
        `<strong>${esc(String(a.priority))}</strong>`, esc(String(a.issue)), esc(String(a.action || '')),
        esc(String(a.team || '-')), esc(String(a.owner || '-')), esc(String(a.due_date || '-')),
        esc(String(a.status || 'Open')), esc(String(a.blockers || '-')),
      ]),
    );

    const businessImpact = table(
      ['Signature', 'Feature area', 'Users affected', 'Revenue exposed', 'Data integrity risk', 'Blocking production'],
      dErrors.filter((e: any) => e.revenue_exposed || e.data_integrity_risk || e.production_blocking).slice(0, 12).map((e: any) => [
        esc(String(e.message || '').slice(0, 90)), esc(String(e.feature_area || '-')), fmt(e.affected_users_today),
        yesNo(e.revenue_exposed), yesNo(e.data_integrity_risk), yesNo(e.production_blocking),
      ]),
    );

    // =====================================================================
    // ENGINEERING OPERATIONS LAYER — every metric becomes a diagnosed issue
    // =====================================================================
    const IN: any = intel || {};
    const inIssues: any[] = Array.isArray(IN.issues) ? IN.issues : [];
    const inAutos: any[] = Array.isArray(IN.automations) ? IN.automations : [];
    const inSlow: any[] = Array.isArray(IN.slow_queries) ? IN.slow_queries : [];
    const inApis: any[] = Array.isArray(IN.api_failures) ? IN.api_failures : [];
    const inNotif: any = IN.notifications || {};
    const inAuth: any = IN.auth || {};

    type Issue = {
      key: string; domain: string; title: string; severity: string; priority: string;
      execSummary: string; techSummary: string; rootCause: string; timeline: string; frequency: string;
      trendY: string; trend7: string; trend30: string;
      systems: string; services: string; apis: string; tables: string; functions: string; files: string;
      businessImpact: string; userImpact: string; usersAffected: number; revenueRisk: string;
      owner: string; team: string; fix: string; effort: string; status: string;
      isNew: boolean; isRecurring: boolean; daysActive: number; previouslyFixed: boolean;
      gettingWorse: boolean; blockingProd: boolean; investigating: boolean; eta: string;
      score: number; extra: [string, string][];
    };
    const sevRank = (s: string) => (s === 'Critical' ? 3 : s === 'High' ? 2 : s === 'Medium' ? 1 : 0);
    const signed = (v: number) => (v > 0 ? `+${fmt(v)}` : v < 0 ? `${fmt(v)}` : 'no change');
    const issues: Issue[] = [];

    // --- Client / frontend error issues
    for (const e of inIssues) {
      issues.push({
        key: String(e.key), domain: 'Client errors', title: String(e.title || 'Unlabelled error'),
        severity: String(e.severity || 'Low'), priority: String(e.priority || 'P4'),
        execSummary: String(e.executive_summary || ''), techSummary: String(e.technical_summary || ''),
        rootCause: String(e.root_cause || ''), timeline: String(e.timeline || ''), frequency: String(e.frequency || ''),
        trendY: signed(n(e.trend_yesterday)), trend7: signed(n(e.trend_7d)), trend30: signed(n(e.trend_30d)),
        systems: String(e.systems_affected || ''), services: String(e.services_affected || ''),
        apis: String(e.apis_affected || ''), tables: String(e.tables_involved || ''),
        functions: String(e.functions_involved || ''), files: String(e.source_files || ''),
        businessImpact: String(e.business_impact || ''), userImpact: String(e.user_impact || ''),
        usersAffected: n(e.users_affected), revenueRisk: String(e.revenue_risk || 'Low'),
        owner: String(e.owner || 'Engineering'), team: String(e.team || 'Engineering'),
        fix: String(e.suggested_fix || ''), effort: String(e.effort || ''), status: String(e.status || 'Open'),
        isNew: e.is_new === true, isRecurring: e.is_recurring === true, daysActive: n(e.days_active),
        previouslyFixed: e.previously_fixed === true, gettingWorse: e.getting_worse === true,
        blockingProd: e.blocking_production === true, investigating: e.investigation_active === true,
        eta: String(e.resolution_eta || 'Next sprint'), score: n(e.impact_score),
        extra: [
          ['Browsers', shareLine(e.browsers)],
          ['Operating systems', shareLine(e.operating_systems)],
          ['Devices', shareLine(e.devices)],
          ['Routes', Array.isArray(e.routes) ? e.routes.slice(0, 5).map((r: any) => `${r.route} (${fmt(r.n)})`).join(', ') : '-'],
          ['Source map', String(e.source_map_location || 'not available')],
          ['Sample session user', String(e.sample_session_user || 'anonymous')],
          ['Actor role', String(e.actor_role || 'unknown')],
          ['Stack trace', e.stack ? String(e.stack).slice(0, 600) : 'not captured — upload source maps to resolve'],
          ['Screenshot', 'not captured — client screenshot capture is not enabled'],
        ],
      });
    }

    // --- Automation issues
    for (const j of inAutos) {
      const cons = n(j.consecutive_failures);
      issues.push({
        key: `automation:${j.automation}`, domain: 'Automation', title: `Scheduled job "${j.automation}" is failing`,
        severity: String(j.severity || 'Medium'),
        priority: cons >= 5 ? 'P1' : n(j.failures_today) >= 3 ? 'P2' : 'P3',
        execSummary: `The automation "${j.automation}" failed ${fmt(j.failures_today)} time(s) today and ${fmt(j.failures_7d)} time(s) this week, with ${fmt(cons)} consecutive failures. Purpose: ${String(j.purpose || '')}.`,
        techSummary: `Trigger: ${String(j.trigger || 'pg_cron')} on schedule "${String(j.schedule || '-')}". Average run duration ${fmt(j.avg_duration_seconds)} s over ${fmt(j.runs_30d)} runs in 30 days. Command: ${String(j.command || '').slice(0, 200)}`,
        rootCause: String(j.error_message || 'not captured').slice(0, 400),
        timeline: `Last success ${ts(j.last_success_at)} · last failure ${ts(j.last_failure_at)} (UTC).`,
        frequency: `${fmt(j.failures_today)} today · ${fmt(j.failures_7d)} in 7 days · ${fmt(j.failures_30d)} in 30 days`,
        trendY: signed(n(j.trend_yesterday)), trend7: `${fmt(j.failures_7d)} failures in 7 days`,
        trend30: `${fmt(j.failures_30d)} of ${fmt(j.runs_30d)} runs failed in 30 days`,
        systems: 'Postgres scheduler (pg_cron)', services: String(j.downstream_affected || '-'),
        apis: String(j.dependencies || '-'), tables: 'cron.job_run_details and the job target tables',
        functions: String(j.automation), files: 'supabase/functions and database routines invoked by the job',
        businessImpact: `Downstream area affected: ${String(j.downstream_affected || 'scheduled maintenance')}.`,
        userImpact: cons > 0 ? 'Silent — users are not notified when a scheduled job stops running.' : 'None observed.',
        usersAffected: 0,
        revenueRisk: /wallet|ledger|advance|sweep|payout|drift/i.test(String(j.automation)) ? 'High' : 'Low',
        owner: 'Backend / Platform', team: 'Backend / Platform',
        fix: String(j.recovery_recommendation || ''),
        effort: cons >= 5 ? '0.5-1 engineer day' : '1-3 engineer hours',
        status: String(j.status || 'Failing'),
        isNew: cons > 0 && n(j.failures_30d) === n(j.failures_today), isRecurring: n(j.failures_30d) > n(j.failures_today),
        daysActive: Math.min(30, Math.ceil(n(j.failures_30d) / Math.max(1, n(j.failures_today) || 1))),
        previouslyFixed: j.last_success_at != null && cons > 0, gettingWorse: n(j.trend_yesterday) > 0,
        blockingProd: cons >= 5 && /wallet|ledger|advance|sweep|payout|drift/i.test(String(j.automation)),
        investigating: false,
        eta: cons >= 5 ? 'Today' : 'This week',
        score: 300 + cons * 12 + n(j.failures_today) * 5 + (/wallet|ledger|advance|payout/i.test(String(j.automation)) ? 250 : 0),
        extra: [
          ['Schedule', String(j.schedule || '-')],
          ['Consecutive failures', fmt(cons)],
          ['Last successful execution', ts(j.last_success_at)],
          ['Last failed execution', ts(j.last_failure_at)],
          ['Complete error message', String(j.error_message || 'not captured')],
          ['Stack trace', String(j.error_message || 'not captured')],
          ['Dependencies', String(j.dependencies || '-')],
          ['Downstream systems affected', String(j.downstream_affected || '-')],
          ['Retry attempts', String(j.retry_attempts || '-')],
          ['Recovery recommendation', String(j.recovery_recommendation || '-')],
        ],
      });
    }

    // --- Slow query issues (only those above threshold)
    // pg_stat_statements is a lifetime-cumulative counter (since the last
    // stats reset), not a same-day figure — the RPC now caps severity at
    // 'Medium'/P3 and never marks these production-blocking or "Today" for
    // exactly that reason (see get_cto_issue_intelligence). Read its
    // classification instead of re-deriving urgency here from mean_ms alone,
    // which previously ignored the RPC's own severity for blockingProd/eta.
    for (const q of inSlow.filter((x: any) => n(x.mean_ms) > 200 || n(x.total_ms) > 600000)) {
      const sev = String(q.severity || 'Medium');
      const priority = String(q.priority || (sev === 'Critical' ? 'P1' : sev === 'High' ? 'P2' : 'P3'));
      const blockingProd = q.blocking_production === true;
      const eta = String(q.resolution_eta || 'Ongoing - chronic performance debt, not a same-day incident');
      // Real per-statement age from pg_stat_statements.stats_since (PG14+)
      // instead of a hardcoded placeholder — this is what made the report
      // show identical "30 days active, recurring" text for every slow
      // query forever, regardless of whether it actually started
      // yesterday or months ago.
      const statsSince = q.stats_since ? new Date(String(q.stats_since)) : null;
      const statsSinceValid = !!statsSince && !isNaN(statsSince.getTime());
      const daysActive = statsSinceValid ? Math.max(0, Math.floor((Date.now() - statsSince!.getTime()) / 86400000)) : 30;
      const isNew = statsSinceValid ? daysActive < 2 : false;
      const isRecurring = statsSinceValid ? daysActive >= 2 : true;
      const timeline = statsSinceValid
        ? `Statement first appeared in pg_stat_statements on ${statsSince!.toISOString().slice(0, 10)} (~${daysActive} days ago). Figures below are cumulative since then, not a same-day volume.`
        : 'Cumulative since the last statistics reset (exact start date unavailable).';
      issues.push({
        key: `slow_query:${String(q.statement).slice(0, 60)}`, domain: 'Database performance',
        title: `Slow statement: ${String(q.statement).replace(/\s+/g, ' ').slice(0, 90)}`,
        severity: sev, priority,
        execSummary: `A database statement averages ${fmt(q.mean_ms)} ms across ${fmt(q.calls)} lifetime calls (cumulative since the last stats reset, not today's volume), consuming ${fmt(Math.round(n(q.total_ms) / 1000))} seconds of database time in total.`,
        techSummary: `${String(q.plan_note || '')} Cache hit ${fmt(q.cache_hit_pct)}%, ${fmt(q.disk_reads)} disk block reads, ${fmt(q.rows_per_call)} rows returned per call.`,
        rootCause: String(q.plan_note || ''),
        timeline,
        frequency: `${fmt(q.calls)} executions`,
        trendY: 'cumulative counter — no daily delta available',
        trend7: 'cumulative counter — no 7 day delta available',
        trend30: 'cumulative counter — no 30 day delta available',
        systems: 'Postgres primary', services: 'Data API and edge functions issuing this statement',
        apis: 'PostgREST / RPC callers', tables: 'See the FROM clause in the statement below',
        functions: 'Database function or client query', files: 'Callers in src/ and supabase/functions/',
        businessImpact: 'Chronic performance debt — adds latency to every caller of this path; same-day severity cannot be assessed from a lifetime counter.',
        userImpact: 'All users exercising the affected feature path.', usersAffected: 0,
        revenueRisk: 'Low',
        owner: 'Backend / Database', team: 'Backend / Database',
        fix: String(q.optimization_recommendation || ''),
        effort: '2-6 engineer hours including EXPLAIN ANALYZE and index rollout',
        status: 'Open', isNew, isRecurring, daysActive, previouslyFixed: false,
        gettingWorse: false, blockingProd, investigating: false,
        eta,
        score: 150 + n(q.mean_ms) / 5,
        extra: [
          ['Complete SQL statement', String(q.statement || '')],
          ['Query execution plan', String(q.plan_note || '') + ' (run EXPLAIN ANALYZE, BUFFERS for the full plan)'],
          ['Blocks scanned', fmt(q.blocks_scanned)],
          ['Rows returned', `${fmt(q.rows_returned)} total · ${fmt(q.rows_per_call)} per call`],
          ['Indexes used', n(q.cache_hit_pct) >= 99 ? 'Index-served (fully cached)' : 'Likely partial or missing index coverage'],
          ['Missing indexes', n(q.disk_reads) > n(q.blocks_scanned) / 2 ? 'Candidate: add a covering index on the filter and join columns' : 'None detected'],
          ['CPU time', `${fmt(q.cpu_ms_estimate)} ms`],
          ['Memory usage', String(q.memory_pressure || '-')],
          ['Temp blocks', fmt(q.temp_blocks)],
          ['Lock waits', `${fmt(dDb.lock_waits)} ungranted locks observed on the instance`],
          ['Blocking sessions', arr(dDb.blocked_queries).length ? arr(dDb.blocked_queries).map((b: any) => `pid ${b.pid} (${b.wait_event})`).join(', ') : 'none'],
          ['Optimization recommendation', String(q.optimization_recommendation || '')],
        ],
      });
    }

    // --- API / edge function failure issues
    for (const ap of inApis.filter((x: any) => n(x.failed_today) > 0)) {
      const sev = String(ap.severity || 'Medium');
      const totalReq = n(ap.failed_today);
      issues.push({
        key: `api:${ap.endpoint}:${ap.status_code}`, domain: 'API failures',
        title: `API failures on ${String(ap.endpoint || 'unattributed request')}`,
        severity: sev, priority: sev === 'Critical' ? 'P1' : sev === 'High' ? 'P2' : 'P3',
        execSummary: `${fmt(ap.failed_today)} failed calls to ${String(ap.endpoint)} today affecting ${fmt(ap.affected_users)} users (status ${String(ap.status_code)}).`,
        techSummary: `Method ${String(ap.method)} · status ${String(ap.status_code)} · ${fmt(ap.failed_7d)} failures in 7 days · ${fmt(ap.failed_30d)} in 30 days.`,
        rootCause: String(ap.failure_reason || ''),
        timeline: `First seen ${ts(ap.first_seen)} · last seen ${ts(ap.last_seen)} (UTC).`,
        frequency: `${fmt(ap.failed_today)} today · ${fmt(ap.failed_7d)} in 7 days · ${fmt(ap.failed_30d)} in 30 days`,
        trendY: signed(n(ap.trend_yesterday)), trend7: `${fmt(ap.failed_7d)} failures in 7 days`,
        trend30: `${fmt(ap.failed_30d)} failures in 30 days`,
        systems: 'Edge function runtime and Data API', services: String(ap.endpoint || '-'),
        apis: `${String(ap.method)} ${String(ap.endpoint)}`, tables: 'Tables written by this endpoint',
        functions: String(ap.endpoint || '-'), files: `supabase/functions/${String(ap.endpoint || '')}/index.ts`,
        businessImpact: 'Failed calls abandon the user action that triggered them.',
        userImpact: `${fmt(ap.affected_users)} users affected today.`, usersAffected: n(ap.affected_users),
        revenueRisk: /wallet|withdraw|deposit|payout|advance/i.test(String(ap.endpoint || '')) ? 'High' : 'Medium',
        owner: 'Backend', team: 'Backend', fix: String(ap.remediation || ''),
        effort: '3-8 engineer hours', status: 'Open',
        isNew: n(ap.failed_30d) === n(ap.failed_today), isRecurring: n(ap.failed_30d) > n(ap.failed_today),
        daysActive: n(ap.failed_30d) > n(ap.failed_7d) ? 30 : 7, previouslyFixed: false,
        gettingWorse: n(ap.trend_yesterday) > 0, blockingProd: sev === 'Critical', investigating: false,
        eta: sev === 'Critical' ? 'Today' : 'This week',
        score: 200 + n(ap.affected_users) * 6 + totalReq * 1.5,
        extra: [
          ['Endpoint', String(ap.endpoint || '-')],
          ['Request method', String(ap.method || '-')],
          ['Status code', String(ap.status_code || '-')],
          ['Failure reason', String(ap.failure_reason || '-')],
          ['Failed requests', fmt(ap.failed_today)],
          ['Affected clients', String(ap.affected_clients || '-')],
          ['Suggested remediation', String(ap.remediation || '-')],
          ['Response times', 'Per-call latency is not captured client-side — enable timing headers on the gateway'],
        ],
      });
    }

    // --- Notification delivery issue
    if (n(inNotif.failed_today) > 0) {
      const tmpl = Array.isArray(inNotif.by_template) ? inNotif.by_template : [];
      const sev = n(inNotif.failed_today) >= 50 ? 'High' : 'Medium';
      issues.push({
        key: 'notifications', domain: 'Notification failures', title: 'Outbound notification delivery failures',
        severity: sev, priority: sev === 'High' ? 'P2' : 'P3',
        execSummary: `${fmt(inNotif.failed_today)} of ${fmt(inNotif.sent_today)} notifications failed to deliver today.`,
        techSummary: `${fmt(inNotif.failed_7d)} failures in 7 days and ${fmt(inNotif.failed_30d)} in 30 days across ${tmpl.length} templates.`,
        rootCause: tmpl.length ? String(tmpl[0].error || 'provider rejection') : 'Provider rejection or invalid recipient address.',
        timeline: 'Continuous — evaluated per send attempt.',
        frequency: `${fmt(inNotif.failed_today)} today · ${fmt(inNotif.failed_7d)} in 7 days · ${fmt(inNotif.failed_30d)} in 30 days`,
        trendY: signed(n(inNotif.failed_today) - n(inNotif.failed_prev)),
        trend7: `${fmt(inNotif.failed_7d)} in 7 days`, trend30: `${fmt(inNotif.failed_30d)} in 30 days`,
        systems: 'Mailgun delivery pipeline', services: tmpl.map((t: any) => t.template).slice(0, 5).join(', ') || 'email templates',
        apis: 'Mailgun messages API', tables: 'email_send_log', functions: 'send-* edge functions',
        files: 'supabase/functions/send-*/index.ts',
        businessImpact: 'Users miss payout, deposit and reminder notifications, driving support load.',
        userImpact: 'Recipients of the failing templates.', usersAffected: n(inNotif.failed_today),
        revenueRisk: 'Medium', owner: 'Backend / Notifications', team: 'Backend / Notifications',
        fix: 'Inspect the provider error per template, validate recipient addresses at write time, and add a retry queue with dead-lettering.',
        effort: '4-8 engineer hours', status: 'Open', isNew: false, isRecurring: n(inNotif.failed_30d) > n(inNotif.failed_today),
        daysActive: 30, previouslyFixed: false, gettingWorse: n(inNotif.failed_today) > n(inNotif.failed_prev),
        blockingProd: false, investigating: false, eta: 'This week',
        score: 120 + n(inNotif.failed_today) * 2,
        extra: tmpl.slice(0, 8).map((t: any) => [`Template ${String(t.template)}`, `${fmt(t.failures)} failures — ${String(t.error || '')}`] as [string, string]),
      });
    }

    // --- Authentication / signup rejection issue
    if (n(inAuth.failed_today) > 0) {
      const reasons = Array.isArray(inAuth.reasons) ? inAuth.reasons : [];
      const rate = pct(n(inAuth.failed_today), Math.max(1, n(inAuth.attempts_today)));
      const sev = rate >= 60 ? 'High' : rate >= 30 ? 'Medium' : 'Low';
      issues.push({
        key: 'auth_rejections', domain: 'Authentication failures',
        title: 'Sign-up and sign-in attempts rejected',
        severity: sev, priority: sev === 'High' ? 'P2' : 'P3',
        execSummary: `${fmt(inAuth.failed_today)} of ${fmt(inAuth.attempts_today)} registration attempts were rejected today (${rate.toFixed(1)}%).`,
        techSummary: `Top rejection reason: ${reasons.length ? String(reasons[0].reason) : 'unspecified'}. ${fmt(inAuth.failed_7d)} rejections in 7 days, ${fmt(inAuth.failed_30d)} in 30 days.`,
        rootCause: reasons.length ? `Guard "${String(reasons[0].reason)}" fired on ${fmt(reasons[0].n)} attempts from ${fmt(reasons[0].ips)} distinct IP addresses.` : 'Anti-fraud guards rejected the attempts.',
        timeline: 'Evaluated at every registration attempt.',
        frequency: `${fmt(inAuth.failed_today)} today · ${fmt(inAuth.failed_7d)} in 7 days · ${fmt(inAuth.failed_30d)} in 30 days`,
        trendY: signed(n(inAuth.failed_today) - n(inAuth.failed_prev)),
        trend7: `${fmt(inAuth.failed_7d)} in 7 days`, trend30: `${fmt(inAuth.failed_30d)} in 30 days`,
        systems: 'Authentication and signup guard', services: 'Registration flow',
        apis: 'Auth sign-up, OTP verification', tables: 'signup_attempts, blocked_signup_ips',
        functions: 'signupGuard, verify-otp', files: 'src/lib/signupGuard.ts, supabase/functions/verify-otp/index.ts',
        businessImpact: 'Legitimate rejections protect the platform; false positives block genuine acquisition.',
        userImpact: `${fmt(inAuth.failed_today)} attempts blocked today.`, usersAffected: n(inAuth.failed_today),
        revenueRisk: rate >= 60 ? 'Medium' : 'Low', owner: 'Auth', team: 'Auth',
        fix: 'Review the dominant rejection reason and confirm the guard threshold is not blocking genuine users sharing an IP or device.',
        effort: '2-4 engineer hours', status: 'Monitoring', isNew: false, isRecurring: true, daysActive: 30,
        previouslyFixed: false, gettingWorse: n(inAuth.failed_today) > n(inAuth.failed_prev),
        blockingProd: false, investigating: false, eta: rate >= 60 ? 'This week' : 'Next sprint',
        score: 90 + rate * 2,
        extra: reasons.slice(0, 8).map((r: any) => [`Reason ${String(r.reason)}`, `${fmt(r.n)} attempts from ${fmt(r.ips)} IP addresses`] as [string, string]),
      });
    }

    // --- Infrastructure alert issues (breached thresholds only)
    for (const inf of dInfra.filter((x: any) => x.status === 'Breached' || x.status === 'Watch')) {
      const sev = inf.status === 'Breached' ? 'High' : 'Medium';
      issues.push({
        key: `infra:${inf.metric}`, domain: 'Infrastructure alerts', title: `Infrastructure threshold: ${String(inf.metric)}`,
        severity: sev, priority: sev === 'High' ? 'P2' : 'P3',
        execSummary: `${String(inf.metric)} is at ${String(inf.current)} against a threshold of ${String(inf.threshold)} (${String(inf.status)}).`,
        techSummary: String(inf.impact || ''), rootCause: String(inf.root_cause || ''),
        timeline: 'Sampled at report generation time.', frequency: 'Continuous',
        trendY: 'point-in-time sample', trend7: 'point-in-time sample', trend30: 'point-in-time sample',
        systems: 'Database instance', services: 'All services sharing the primary',
        apis: 'All', tables: 'Instance-wide', functions: 'Instance-wide', files: 'Infrastructure configuration',
        businessImpact: String(inf.impact || ''), userImpact: 'Platform-wide latency or availability risk.',
        usersAffected: 0, revenueRisk: sev === 'High' ? 'High' : 'Medium',
        owner: 'Platform / Infrastructure', team: 'Platform / Infrastructure', fix: String(inf.action || ''),
        effort: '1-2 engineer hours to apply, longer if a resize is required', status: String(inf.status || 'Watch'),
        isNew: false, isRecurring: true, daysActive: 1, previouslyFixed: false,
        gettingWorse: inf.status === 'Breached', blockingProd: inf.status === 'Breached', investigating: false,
        eta: inf.status === 'Breached' ? 'Today' : 'This week',
        score: inf.status === 'Breached' ? 420 : 160,
        extra: [['Current value', String(inf.current)], ['Threshold', String(inf.threshold)], ['Action', String(inf.action || '')]],
      });
    }

    // --- Security incident issues
    if (n(dSec.injection_probes) > 0 || n(dSec.authorization_violations) > 0 || arr(dSec.brute_force_candidates).length > 0) {
      const sev = n(dSec.injection_probes) > 0 ? 'High' : 'Medium';
      issues.push({
        key: 'security_events', domain: 'Security incidents', title: 'Security probes and access-control violations',
        severity: sev, priority: sev === 'High' ? 'P1' : 'P2',
        execSummary: `${fmt(dSec.injection_probes)} injection probes, ${fmt(dSec.authorization_violations)} authorisation violations and ${arr(dSec.brute_force_candidates).length} possible brute-force identities were observed.`,
        techSummary: `${arr(dSec.suspicious_ips).length} suspicious IP addresses in the last 7 days; ${fmt(dSec.blocked_ips_added_today)} IPs blocked today.`,
        rootCause: 'Automated scanners and credential-stuffing attempts against public endpoints.',
        timeline: 'Continuous, detected from application telemetry.',
        frequency: `${fmt(dSec.signup_attempts)} signup attempts, ${fmt(dSec.signup_blocked)} blocked today`,
        trendY: 'see security section', trend7: `${arr(dSec.suspicious_ips).length} suspicious IPs in 7 days`,
        trend30: 'monitored continuously',
        systems: 'Public web surface and Data API', services: 'Auth, signup, public routes',
        apis: 'Auth endpoints', tables: 'signup_attempts, blocked_signup_ips, fraud_identity_blocks',
        functions: 'signup guard, RLS policies', files: 'src/lib/signupGuard.ts and RLS policy definitions',
        businessImpact: 'Successful abuse would expose customer data and funds.',
        userImpact: 'No confirmed user compromise; controls held.', usersAffected: 0, revenueRisk: 'High',
        owner: 'Backend Security', team: 'Backend Security',
        fix: 'Rate-limit the probed endpoints at the edge, keep the offending IPs blocked, and re-verify RLS coverage on every table touched by the violations.',
        effort: '1 engineer day', status: 'Contained', isNew: false, isRecurring: true, daysActive: 7,
        previouslyFixed: false, gettingWorse: false, blockingProd: false, investigating: true, eta: 'This week',
        score: 380,
        extra: [
          ['Suspicious IP addresses', arr(dSec.suspicious_ips).slice(0, 5).map((r: any) => `${r.ip} (${fmt(r.attempts)})`).join(', ') || 'none'],
          ['Brute-force identities', arr(dSec.brute_force_candidates).slice(0, 5).map((r: any) => `${r.identity} (${fmt(r.failed_attempts)})`).join(', ') || 'none'],
          ['Authorisation violations', fmt(dSec.authorization_violations)],
          ['Injection probes', fmt(dSec.injection_probes)],
        ],
      });
    }

    issues.sort((x, y) => sevRank(y.severity) - sevRank(x.severity) || y.score - x.score);
    const top10 = issues.slice(0, 10);

    // --- Rendering: Top 10 table
    const top10Table = top10.length
      ? table(
          ['#', 'Issue', 'Severity', 'Business impact', 'Users affected', 'Revenue risk', 'Root cause', 'Team', 'Resolution', 'Status'],
          top10.map((i, idx) => [
            String(idx + 1),
            `<b>${esc(i.title.slice(0, 90))}</b><div style="font-size:10.5px;color:${C.muted};">${esc(i.domain)}</div>`,
            sevBadge(i.severity), esc(i.businessImpact.slice(0, 120)), fmt(i.usersAffected),
            riskCell(i.revenueRisk === 'High' ? 'High' : i.revenueRisk === 'Medium' ? 'Medium' : 'Low'),
            esc(i.rootCause.slice(0, 140)), esc(i.team), esc(i.eta), esc(i.status),
          ]),
        )
      : `<div style="font-size:12px;color:${C.muted};">No issues crossed the engineering attention threshold today.</div>`;

    // --- Rendering: full diagnostic dossier per issue
    const dossier = (i: Issue, idx: number) => {
      const row = (k: string, v: string) =>
        `<tr><td style="padding:3px 10px 3px 0;font-size:11px;color:${C.muted};white-space:nowrap;vertical-align:top;width:180px;">${esc(k)}</td><td style="padding:3px 0;font-size:11.5px;color:${C.ink};word-break:break-word;">${v}</td></tr>`;
      const flag = (b: boolean) => (b ? `<b style="color:${C.bad}">Yes</b>` : 'No');
      return `
      <div style="border:1px solid ${C.line};border-left:4px solid ${i.severity === 'Critical' ? C.bad : i.severity === 'High' ? C.warn : C.line};border-radius:10px;padding:12px 14px;margin-bottom:14px;">
        <div style="font-size:12.5px;font-weight:800;color:${C.ink};">${idx}. ${esc(i.title.slice(0, 150))}</div>
        <div style="margin:4px 0 8px;">${sevBadge(i.severity)} <span style="font-size:11px;color:${C.muted};">${esc(i.domain)} · ${esc(i.priority)} · owner ${esc(i.owner)}</span></div>
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;">
          ${row('Executive summary', esc(i.execSummary))}
          ${row('Technical summary', esc(i.techSummary))}
          ${row('Root cause', esc(i.rootCause))}
          ${row('Timeline', esc(i.timeline))}
          ${row('Severity', esc(i.severity))}
          ${row('Frequency', esc(i.frequency))}
          ${row('Trend vs yesterday', esc(i.trendY))}
          ${row('Trend vs last 7 days', esc(i.trend7))}
          ${row('Trend vs last 30 days', esc(i.trend30))}
          ${row('Systems affected', esc(i.systems))}
          ${row('Services affected', esc(i.services))}
          ${row('APIs affected', esc(i.apis))}
          ${row('Database tables involved', esc(i.tables))}
          ${row('Functions involved', esc(i.functions))}
          ${row('Source files involved', esc(i.files))}
          ${row('Estimated business impact', esc(i.businessImpact))}
          ${row('Estimated user impact', esc(i.userImpact))}
          ${row('Recommended owner', esc(i.owner))}
          ${row('Suggested fix', esc(i.fix))}
          ${row('Estimated effort', esc(i.effort))}
          ${row('Priority', esc(i.priority))}
          ${row('Current status', esc(i.status))}
          ${row('Recurrence', `New: ${flag(i.isNew)} · Recurring: ${flag(i.isRecurring)} · Days active: ${fmt(i.daysActive)} · Previously fixed then returned: ${flag(i.previouslyFixed)} · Getting worse: ${flag(i.gettingWorse)} · Blocking production: ${flag(i.blockingProd)} · Active investigation: ${i.investigating ? 'Yes' : 'No'} · Owning team: ${esc(i.team)}`)}
          ${i.extra.map(([k, v]) => row(k, `<span style="font-family:ui-monospace,Menlo,Consolas,monospace;font-size:10.5px;">${esc(String(v).slice(0, 900))}</span>`)).join('')}
        </table>
      </div>`;
    };
    const dossiersHtml = issues.length
      ? issues.slice(0, 14).map((i, idx) => dossier(i, idx + 1)).join('')
      : `<div style="font-size:12px;color:${C.muted};">No diagnosable issues detected for this reporting day.</div>`;

    // --- Rendering: CTO Engineering Action Plan
    // eta is the authoritative same-day-urgency signal set deliberately per
    // issue type (see the push sites above) — every type already sets
    // eta:'Today' when it means same-day, INCLUDING when severity is
    // Critical, except slow queries, which are intentionally never 'Today'
    // (pg_stat_statements is lifetime-cumulative, not a daily figure).
    // Falling back to `|| i.severity === 'Critical'` here used to override
    // that and force chronic 30+ day old slow queries into "Today" anyway.
    const today = issues.filter((i) => i.eta === 'Today');
    const thisWeek = issues.filter((i) => !today.includes(i) && i.eta === 'This week');
    const nextSprint = issues.filter((i) => !today.includes(i) && !thisWeek.includes(i));
    const prodRisks = issues.filter((i) => i.blockingProd || i.revenueRisk === 'High');
    const planList = (items: Issue[], empty: string) =>
      items.length
        ? `<ol style="margin:0;padding-left:18px;font-size:12px;line-height:1.8;color:${C.ink};">${items.slice(0, 10).map((i) => `<li><b>${esc(i.title.slice(0, 100))}</b> — ${esc(i.fix.slice(0, 200))} <span style="color:${C.muted};">(${esc(i.team)}, ${esc(i.effort)})</span></li>`).join('')}</ol>`
        : `<div style="font-size:12px;color:${C.muted};">${esc(empty)}</div>`;
    const architectural = [
      'Upload production source maps so client stack traces resolve to real components instead of "Script error".',
      'Introduce a structured API telemetry table capturing endpoint, status code and latency for every edge-function call.',
      'Add retry with dead-lettering to every scheduled automation so a single failed tick does not silently skip a day.',
      'Move heavy reporting reads to materialised views refreshed off-peak to remove them from the interactive query path.',
      'Adopt per-route error budgets with automatic alerting when a route exceeds its budget for two consecutive days.',
    ];
    const actionPlan = `
      ${subLabel('Fix today')}${planList(today, 'Nothing requires same-day engineering intervention.')}
      ${subLabel('Fix this week')}${planList(thisWeek, 'No items queued for this week.')}
      ${subLabel('Defer to the next sprint')}${planList(nextSprint, 'No deferred items.')}
      ${subLabel('Immediate production risks')}
      ${prodRisks.length
        ? table(['Risk', 'Severity', 'Revenue risk', 'Owner'], prodRisks.slice(0, 8).map((i) => [esc(i.title.slice(0, 110)), sevBadge(i.severity), esc(i.revenueRisk), esc(i.team)]))
        : `<div style="font-size:12px;color:${C.muted};">No immediate production risk identified.</div>`}
      ${subLabel('Long-term architectural improvements')}
      <ol style="margin:0;padding-left:18px;font-size:12px;line-height:1.8;color:${C.ink};">${architectural.map((x) => `<li>${esc(x)}</li>`).join('')}</ol>`;

    const html = `
<div style="background:${C.bg};padding:22px 0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;">
  <div style="max-width:860px;margin:0 auto;background:#fff;border:1px solid ${C.line};border-radius:14px;padding:26px 28px;">
    <div style="border-bottom:3px solid ${C.ink};padding-bottom:14px;">
      <div style="font-size:11px;letter-spacing:.16em;text-transform:uppercase;color:${C.muted};font-weight:800;">Welile Technologies Limited</div>
      <div style="font-size:24px;font-weight:800;color:${C.ink};margin-top:4px;">Daily Chief Technology Officer Report</div>
      <div style="font-size:12px;color:${C.muted};margin-top:4px;">Reporting day ${esc(dateStr)} (East Africa Time) · Prepared for the Chief Executive Officer and Board of Directors</div>
    </div>

    ${section('Executive Summary', 1, execSummary)}
    ${section('Top 10 Issues Requiring Immediate Engineering Attention', 2, top10Table)}
    ${section('CTO Engineering Action Plan', 3, actionPlan)}
    ${section('Full Diagnostic Dossiers', 4, dossiersHtml)}
    ${section('Platform Health Dashboard', 5, platformCards + trendChart)}
    ${section('Infrastructure Operations', 6, infraCards + storageChart + `<div style="margin-top:14px;"><div style="font-size:11px;font-weight:700;color:${C.muted};text-transform:uppercase;letter-spacing:.06em;margin-bottom:6px;">Failing automations — last 24 hours</div>${jobTable}</div>`)}
    ${section('Engineering Performance', 7, engCards + `<div style="margin-top:14px;">${routeTable}</div><div style="margin-top:14px;">${msgTable}</div><div style="margin-top:14px;"><div style="font-size:11px;font-weight:700;color:${C.muted};text-transform:uppercase;letter-spacing:.06em;margin-bottom:6px;">Slowest database operations</div>${slowTable}</div>`)}
    ${section('Cybersecurity Dashboard', 8, secCards)}
    ${section('Product Development', 9, prodCards)}
    ${section('Customer Technology Experience', 10, cxCards)}
    ${section('System Monitoring', 11, monCards)}
    ${section('Data and Analytics', 12, dataCards)}
    ${section('Innovation and Research', 13, innovation)}
    ${section('Technology Risk Register', 14, riskTable)}
    ${section('Compliance', 15, compTable)}
    ${section('CTO Executive KPIs', 16, kpiTable)}
    ${section('Strategic Recommendations and Action Items', 17, recsHtml)}
    ${section('Technical Diagnostics Overview', 18, diagOverview)}
    ${section('Detailed Error Analysis', 19, errorDossier)}
    ${section('Critical Errors Ranked by Impact', 20, criticalTable)}
    ${section('API and Edge Function Failure Report', 21, apiTable)}
    ${section('Database Diagnostics', 22, dbSection)}
    ${section('Automation Failure Details', 23, jobDetailTable)}
    ${section('Frontend Error Report', 24, frontendSection)}
    ${section('Authentication Diagnostics', 25, authSection)}
    ${section('Infrastructure Alerts', 26, infraAlertTable)}
    ${section('Security Events', 27, securitySection)}
    ${section('Regression Report', 28, regressionSection)}
    ${section('Engineering Action Items', 29, actionTable)}
    ${section('Business Impact of Open Defects', 30, businessImpact)}
    ${section('Daily Scheduled Job Failures (today only)', 31,
      `<div style="font-size:12px;color:${C.muted};margin-bottom:8px;">${fmt(adJobsSummary.runs_today)} scheduled runs today, ${fmt(adJobsSummary.failures_today)} failed across ${fmt(adJobsSummary.jobs_failing)} job(s); ${fmt(adJobsSummary.jobs_broken_all_day)} never succeeded today.</div>` +
      table(['Job', 'Schedule', 'What it does', 'Today', 'Failures', 'Last success', 'Error', 'How to fix'],
        adFailedJobs.map((j: any) => [
          esc(String(j.jobname)), esc(String(j.schedule || '-')), esc(String(j.what_it_does || '')),
          esc(String(j.today_status || '')), `${fmt(j.failures_today)} / ${fmt(j.runs_today)}`,
          esc(String(j.last_success_eat || 'none today')),
          esc(String(j.last_error || '').slice(0, 240)), esc(String(j.how_to_fix || '')),
        ])))}
    ${section('User-Facing Error Breakdown (today only)', 32,
      `<div style="font-size:12px;color:${C.muted};margin-bottom:8px;">${fmt(adErrSummary.total_today)} errors today across ${fmt(adErrSummary.distinct_signatures)} distinct signatures, affecting ${fmt(adErrSummary.users_today)} users.</div>` +
      table(['Error', 'Times', 'Users', 'What the user experienced', 'Route', 'Role', 'Browser / device', 'Window', 'Engineering action'],
        adUserErrors.map((e2: any) => [
          esc(String(e2.signature || '')), fmt(e2.occurrences), fmt(e2.users),
          esc(String(e2.user_impact || '')), esc(String(e2.top_route || '-')), esc(String(e2.top_role || '-')),
          `${esc(String(e2.top_browser || '-'))} / ${esc(String(e2.top_device || '-'))}`,
          `${esc(String(e2.first_seen_eat || '-'))}-${esc(String(e2.last_seen_eat || '-'))}`,
          esc(String(e2.engineering_action || '')),
        ])))}
    ${section('Database Exception and Rolled-Back Transaction Register (today only)', 33,
      table(['Source', 'Exception', 'Occurrences', 'Last seen'],
        adDbExceptions.map((x: any) => [
          esc(String(x.src || '')), esc(String(x.signature || '')), fmt(x.occurrences), ts(x.last_seen),
        ])))}
    ${section('Anti-Bot and Signup Abuse (today only)', 34,
      `<div style="font-size:12px;color:${C.muted};margin-bottom:8px;">${fmt(adAntiBot.attempts_today)} signup attempts, ${fmt(adAntiBot.rejected_today)} rejected, ${fmt(adAntiBot.distinct_ips)} IP addresses, ${fmt(adAntiBot.distinct_devices)} devices, ${fmt(adAntiBot.ips_blocked_today)} IPs blocked today.</div>` +
      subLabel('Rejection reasons') +
      table(['Reason', 'Attempts', 'IPs', 'Devices'], adAbReasons.map((r: any) => [esc(String(r.reason)), fmt(r.n), fmt(r.ips), fmt(r.devices)])) +
      subLabel('Repeat IP addresses') +
      table(['IP', 'Attempts', 'Rejected', 'Identities', 'Devices'], adAbIps.map((r: any) => [esc(String(r.ip)), fmt(r.attempts), fmt(r.rejected), fmt(r.identities), fmt(r.devices)])) +
      subLabel('Repeat devices') +
      table(['Device fingerprint', 'Attempts', 'IPs', 'Identities'], adAbDevices.map((r: any) => [esc(String(r.device_fp).slice(0, 24)), fmt(r.attempts), fmt(r.ips), fmt(r.identities)])))}
    ${section('Authentication Errors Users Faced (today only)', 35,
      table(['What the user hit', 'Times', 'Users', 'Stage'],
        adAuthErrors.map((r: any) => [esc(String(r.reason)), fmt(r.n), fmt(r.users), esc(String(r.worst_phase || '-'))])) +
      subLabel('One-time password failures') +
      table(['Reason', 'Stage', 'Times', 'Phones'],
        adOtpErrors.map((r: any) => [esc(String(r.reason)), esc(String(r.stage)), fmt(r.n), fmt(r.phones)])))}
    ${section('OTP Usage by Category', 36,
      `<div style="font-size:12px;color:${C.muted};margin-bottom:8px;">${fmt(otpTotals.sent)} sent, ${fmt(otpTotals.send_failed)} send failures, ${fmt(otpTotals.verify_success)} verified, ${fmt(otpTotals.verify_failed)} failed verification across every flow that gates on an SMS code.</div>` +
      table(['Category', 'Sent', 'Send failed', 'Verified', 'Verify failed'],
        otpByCategory.map((r: any) => [
          esc(String(r.category).replace(/_/g, ' ')), fmt(r.sent), fmt(r.send_failed), fmt(r.verify_success), fmt(r.verify_failed),
        ])) +
      (otpByCategory.some((r: any) => r.category === 'uncategorized')
        ? `<div style="font-size:11px;color:${C.muted};margin-top:8px;">"uncategorized" is a generic-flow OTP send/verify that didn't tag a category — check the calling component passes { category } to sms-otp.</div>`
        : ''))}

    <div style="margin-top:26px;border-top:1px solid ${C.line};padding-top:12px;font-size:11px;color:${C.muted};">
      Generated automatically from live production telemetry at ${esc(String(d.generated_at || '').slice(0, 19).replace('T', ' '))} UTC. Overall technology health score: ${health} of 100 (${healthLabel}).
    </div>
  </div>
</div>`;

    const text = [
      `Daily CTO Report — ${dateStr}`,
      `Technology health score: ${health}/100 (${healthLabel})`,
      `Active 24h: ${fmt(P.active_24h)} | Events: ${fmt(P.events_today)} | Ledger postings: ${fmt(P.txn_today)}`,
      `Errors today: ${fmt(E.today)} (${delta(n(E.today), n(E.prev_day))}) | Error rate: ${errRate.toFixed(2)}%`,
      `Auth success: ${(100 - loginFailRate).toFixed(1)}% | Median sign-in: ${fmt(A.median_login_ms_today)} ms (avg ${fmt(A.avg_login_ms_today)} ms)`,
      `Jobs: ${fmt(J.runs_24h)} runs, ${fmt(J.failed_24h)} failed (${jobFailRate.toFixed(1)}%)`,
      `Database: ${bytes(I.db_size_bytes)} | Cache hit ${cacheHit.toFixed(2)}% | Connections ${fmt(I.connections)}/${fmt(I.max_connections)}`,
      `OTP usage: ${fmt(otpTotals.sent)} sent, ${fmt(otpTotals.verify_success)} verified, ${fmt(otpTotals.verify_failed)} failed across ${fmt(otpByCategory.length)} categories`,
      '',
      'Recommendations:',
      ...recs.map((r, i) => `${i + 1}. ${r.replace(/<[^>]+>/g, '')}`),
      '',
      'Top 10 issues requiring immediate engineering attention:',
      ...top10.map((i, idx) => `${idx + 1}. [${i.severity}/${i.priority}] ${i.title} — ${i.usersAffected} users, revenue risk ${i.revenueRisk}, owner ${i.team}, resolve ${i.eta}. Cause: ${i.rootCause}`),
      '',
      `Action plan — today: ${today.length} item(s); this week: ${thisWeek.length}; next sprint: ${nextSprint.length}; immediate production risks: ${prodRisks.length}.`,
    ].join('\n');

    // ---- Downloadable PDF attachment ------------------------------------
    const techArgs: PdfArgs = {
      dateStr,
      generatedAt: String(d.generated_at || '').slice(0, 19).replace('T', ' '),
      health, healthLabel,
      scoreParts: scoreParts.map((p) => ({ label: p.label, weight: p.w, value: Math.round(p.v) })),
      summaryPoints,
      platform: [
        ['Total users', fmt(P.total_users)], ['New users today', fmt(P.new_users_today)],
        ['Active 24h', fmt(P.active_24h)], ['Active 7d', fmt(P.active_7d)],
        ['Active 30d', fmt(P.active_30d)], ['System events today', fmt(P.events_today)],
        ['Events vs prior day', delta(n(P.events_today), n(P.events_prev_day))],
        ['Ledger postings today', fmt(P.txn_today)],
        ['Client errors today', fmt(E.today)], ['Client error rate', `${errRate.toFixed(2)}%`],
        ['Users affected by errors', fmt(E.affected_users_today)], ['Browser compat events 7d', fmt(E.compat_events_7d)],
      ],
      errorTrend: trend.map((t: any) => ({ label: String(t.d), value: n(t.n) })),
      infra: [
        ['Database size', bytes(I.db_size_bytes)], ['Cache hit ratio', `${cacheHit.toFixed(2)}%`],
        ['Connections', `${fmt(I.connections)} / ${fmt(I.max_connections)}`], ['Connection saturation', `${connSat.toFixed(0)}%`],
        ['Uptime hours', fmt(I.uptime_hours)], ['Deadlocks since boot', fmt(I.deadlocks)],
        ['Commits', I.rollback_trustworthy === true ? fmt(I.commits) : 'Unavailable'],
        ['Rolled-back transactions', I.rollback_trustworthy === true ? fmt(I.rollbacks) : 'Unavailable'],
        ['Scheduled automations', fmt(J.total_scheduled)], ['Automation runs 24h', fmt(J.runs_24h)],
        ['Failed runs 24h', fmt(J.failed_24h)], ['Automation failure rate', `${jobFailRate.toFixed(1)}%`],
      ],
      largestTables: largest.map((t: any) => ({ label: String(t.table_name), value: n(t.bytes), display: bytes(t.bytes) })),
      failingJobs: failingJobs.map((j: any) => [String(j.jobname), fmt(j.n), String(j.last_error || '').replace(/\s+/g, ' ')]),
      topRoutes: topRoutes.map((r: any) => [String(r.route), fmt(r.n)]),
      topMessages: topMsgs.map((m: any) => [String(m.message), fmt(m.n)]),
      slowQueries: slow.map((q: any) => [String(q.query).replace(/\s+/g, ' '), fmt(q.mean_ms), fmt(q.calls)]),
      security: [
        ['RLS coverage', `${rlsCoverage.toFixed(1)}%`], ['Tables with RLS', `${fmt(S.rls_tables)} of ${fmt(S.public_tables)}`],
        ['Privileged accounts', fmt(S.privileged_accounts)], ['Active fraud blocks', fmt(S.fraud_blocks_active)],
        ['Fraud blocks raised today', fmt(S.fraud_blocks_today)], ['Blocked signup IPs', fmt(S.blocked_ips_total)],
        ['Signup attempts today', fmt(S.signup_attempts_today)], ['Signups rejected today', fmt(S.signup_blocked_today)],
        ['Login failures today', fmt(A.login_failures_today)], ['Login failure rate', `${loginFailRate.toFixed(1)}%`],
        ['OTP attempts today', fmt(A.otp_attempts_today)], ['Audit writes today', fmt(S.audit_writes_today)],
      ],
      experience: [
        ['Median sign-in latency', `${fmt(A.median_login_ms_today)} ms`], ['Average sign-in latency', `${fmt(A.avg_login_ms_today)} ms`],
        ['Authentication success', `${(100 - loginFailRate).toFixed(1)}%`],
        ['Weekly active share', `${pct(n(P.active_7d), Math.max(1, n(P.total_users))).toFixed(1)}%`],
        ['Monthly active share', `${pct(n(P.active_30d), Math.max(1, n(P.total_users))).toFixed(1)}%`],
        ['Emails sent today', fmt(M.sent_today)], ['Emails failed today', fmt(M.failed_today)],
        ['Notification delivery', `${(100 - emailFailRate).toFixed(1)}%`], ['Emails sent 7d', fmt(M.sent_7d)],
        ['Backup runs 7d', fmt(B.runs_7d)], ['Backup failures 7d', fmt(B.failures_7d)],
        ['Latest backup status', B.latest?.status ? String(B.latest.status) : 'none'],
        ['Latest backup at', B.latest?.created_at ? String(B.latest.created_at).slice(0, 16).replace('T', ' ') : 'no run recorded'],
      ],
      risks: risks.map((r) => [r.area, r.risk, r.likelihood, r.impact, r.action]),
      compliance: [
        ['Row level security enforced', rlsCoverage >= 98 ? 'Compliant' : 'Partial', `${fmt(S.rls_tables)} of ${fmt(S.public_tables)} public tables`],
        ['Immutable audit trail', n(S.audit_writes_today) > 0 ? 'Active' : 'No writes today', `${fmt(S.audit_writes_today)} entries logged`],
        ['Data backup and retention', backupOk ? 'Compliant' : 'Attention', `${fmt(B.runs_7d)} runs, ${fmt(B.failures_7d)} failures in 7 days`],
        ['Privileged access review', n(S.privileged_accounts) <= 25 ? 'Within limit' : 'Review needed', `${fmt(S.privileged_accounts)} privileged accounts`],
        ['Fraud and AML controls', 'Operating', `${fmt(S.fraud_blocks_active)} active identity blocks`],
        ['Double-entry financial integrity', 'Enforced', `${fmt(P.txn_today)} balanced ledger postings today`],
      ],
      kpis: [
        ['Technology health score', String(health), '85+'],
        ['Client error rate', `${errRate.toFixed(2)}%`, 'Below 1%'],
        ['Authentication success', `${(100 - loginFailRate).toFixed(1)}%`, '90%+'],
        ['Automation success', `${(100 - jobFailRate).toFixed(1)}%`, '99%+'],
        ['Database cache hit', `${cacheHit.toFixed(2)}%`, '99%+'],
        ['Connection headroom', `${(100 - connSat).toFixed(0)}%`, '40%+'],
        ['Notification delivery', `${(100 - emailFailRate).toFixed(1)}%`, '95%+'],
      ],
      recommendations: recs.map((r) => r.replace(/<[^>]+>/g, '')),
      diagSections: [
        {
          title: 'Daily Scheduled Job Failures (today only)',
          headers: ['Job', 'Schedule', 'What it does', 'Today', 'Fail/Runs', 'Last success', 'Error', 'How to fix'],
          weights: [0.13, 0.08, 0.16, 0.1, 0.07, 0.07, 0.21, 0.18],
          rows: adFailedJobs.map((j: any) => [
            String(j.jobname), String(j.schedule || '-'), String(j.what_it_does || ''),
            String(j.today_status || ''), `${fmt(j.failures_today)}/${fmt(j.runs_today)}`,
            String(j.last_success_eat || 'none'), String(j.last_error || '').slice(0, 220),
            String(j.how_to_fix || ''),
          ]),
        },
        {
          title: 'User-Facing Error Breakdown (today only)',
          headers: ['Error', 'Times', 'Users', 'User experience', 'Route', 'Role', 'Browser/device', 'Window', 'Action'],
          weights: [0.19, 0.05, 0.05, 0.19, 0.11, 0.06, 0.09, 0.07, 0.19],
          rows: adUserErrors.map((e2: any) => [
            String(e2.signature || '').slice(0, 120), fmt(e2.occurrences), fmt(e2.users),
            String(e2.user_impact || ''), String(e2.top_route || '-'), String(e2.top_role || '-'),
            `${e2.top_browser || '-'} / ${e2.top_device || '-'}`,
            `${e2.first_seen_eat || '-'}-${e2.last_seen_eat || '-'}`,
            String(e2.engineering_action || ''),
          ]),
        },
        {
          title: 'Database Exceptions and Rolled-Back Transactions (today only)',
          headers: ['Source', 'Exception', 'Occurrences', 'Last seen'],
          weights: [0.14, 0.58, 0.11, 0.17],
          rows: adDbExceptions.map((x: any) => [
            String(x.src || ''), String(x.signature || ''), fmt(x.occurrences), ts(x.last_seen),
          ]),
        },
        {
          title: 'Anti-Bot and Signup Abuse (today only)',
          headers: ['Signal', 'Detail', 'Attempts', 'Rejected', 'IPs/Devices', 'Identities'],
          weights: [0.16, 0.32, 0.12, 0.12, 0.14, 0.14],
          rows: [
            ['Summary', `${fmt(adAntiBot.attempts_today)} attempts today, ${fmt(adAntiBot.ips_blocked_today)} IPs blocked`,
              fmt(adAntiBot.attempts_today), fmt(adAntiBot.rejected_today),
              `${fmt(adAntiBot.distinct_ips)} / ${fmt(adAntiBot.distinct_devices)}`, '-'],
            ...adAbReasons.map((r: any) => ['Rejection reason', String(r.reason), fmt(r.n), fmt(r.n), `${fmt(r.ips)} / ${fmt(r.devices)}`, '-']),
            ...adAbIps.map((r: any) => ['Repeat IP', String(r.ip), fmt(r.attempts), fmt(r.rejected), `${fmt(r.devices)} devices`, fmt(r.identities)]),
            ...adAbDevices.map((r: any) => ['Repeat device', String(r.device_fp).slice(0, 28), fmt(r.attempts), '-', `${fmt(r.ips)} IPs`, fmt(r.identities)]),
          ],
        },
        {
          title: 'Authentication Errors Users Faced (today only)',
          headers: ['What the user hit', 'Times', 'Users', 'Stage'],
          weights: [0.5, 0.11, 0.11, 0.28],
          rows: [
            ...adAuthErrors.map((r: any) => [String(r.reason), fmt(r.n), fmt(r.users), String(r.worst_phase || '-')]),
            ...adOtpErrors.map((r: any) => [`OTP: ${r.reason}`, fmt(r.n), `${fmt(r.phones)} phones`, String(r.stage || '-')]),
          ],
        },
        {
          title: 'Top 10 Issues Requiring Immediate Engineering Attention',
          headers: ['#', 'Issue', 'Severity', 'Users', 'Revenue risk', 'Root cause', 'Team', 'Resolution', 'Status'],
          weights: [0.03, 0.24, 0.08, 0.06, 0.09, 0.24, 0.11, 0.08, 0.07],
          rows: top10.map((i, idx) => [
            String(idx + 1), `${i.title.slice(0, 110)} (${i.domain})`, i.severity, fmt(i.usersAffected),
            i.revenueRisk, i.rootCause.slice(0, 160), i.team, i.eta, i.status,
          ]),
        },
        {
          title: 'CTO Engineering Action Plan',
          headers: ['Horizon', 'Issue', 'Action', 'Team', 'Effort'],
          weights: [0.12, 0.26, 0.4, 0.12, 0.1],
          rows: [
            ...today.slice(0, 10).map((i) => ['Today', i.title.slice(0, 110), i.fix.slice(0, 220), i.team, i.effort]),
            ...thisWeek.slice(0, 10).map((i) => ['This week', i.title.slice(0, 110), i.fix.slice(0, 220), i.team, i.effort]),
            ...nextSprint.slice(0, 10).map((i) => ['Next sprint', i.title.slice(0, 110), i.fix.slice(0, 220), i.team, i.effort]),
            ...prodRisks.slice(0, 6).map((i) => ['Production risk', i.title.slice(0, 110), `Revenue risk ${i.revenueRisk}. ${i.fix.slice(0, 180)}`, i.team, i.effort]),
            ...architectural.map((x) => ['Architecture', 'Long-term improvement', x, 'Engineering', 'Roadmap']),
          ],
        },
        {
          title: 'Issue Diagnostics - Cause, Impact and Ownership',
          headers: ['Issue', 'Severity', 'Frequency and trend', 'Root cause', 'Suggested fix', 'Owner', 'Priority'],
          weights: [0.19, 0.07, 0.16, 0.21, 0.21, 0.1, 0.06],
          rows: issues.slice(0, 20).map((i) => [
            i.title.slice(0, 110), i.severity,
            `${i.frequency} | vs yesterday ${i.trendY}`,
            i.rootCause.slice(0, 200), i.fix.slice(0, 200), i.team, i.priority,
          ]),
        },
        {
          title: 'Issue Recurrence Register',
          headers: ['Issue', 'New', 'Recurring', 'Days active', 'Previously fixed', 'Worsening', 'Blocking production', 'Team'],
          weights: [0.3, 0.07, 0.1, 0.1, 0.13, 0.11, 0.12, 0.07],
          rows: issues.slice(0, 20).map((i) => [
            i.title.slice(0, 110), i.isNew ? 'Yes' : 'No', i.isRecurring ? 'Yes' : 'No', String(i.daysActive),
            i.previouslyFixed ? 'Yes' : 'No', i.gettingWorse ? 'Yes' : 'No', i.blockingProd ? 'Yes' : 'No', i.team,
          ]),
        },
        {
          title: 'Failing Automations - Full Diagnostic',
          headers: ['Automation', 'Schedule', 'Consecutive failures', 'Last success', 'Error message', 'Recovery'],
          weights: [0.17, 0.1, 0.09, 0.12, 0.29, 0.23],
          rows: inAutos.map((j: any) => [
            String(j.automation), String(j.schedule || '-'), fmt(j.consecutive_failures), ts(j.last_success_at),
            String(j.error_message || 'not captured').replace(/\s+/g, ' ').slice(0, 300),
            String(j.recovery_recommendation || ''),
          ]),
        },
        {
          title: 'Slow Queries - Full Diagnostic',
          headers: ['Statement', 'Calls', 'Mean ms', 'Rows/call', 'Cache hit', 'Memory', 'Optimisation'],
          weights: [0.32, 0.07, 0.08, 0.08, 0.08, 0.14, 0.23],
          rows: inSlow.map((q: any) => [
            String(q.statement || '').replace(/\s+/g, ' ').slice(0, 300), fmt(q.calls), fmt(q.mean_ms),
            fmt(q.rows_per_call), `${fmt(q.cache_hit_pct)}%`, String(q.memory_pressure || ''),
            String(q.optimization_recommendation || ''),
          ]),
        },
        {
          title: 'Detailed Error Analysis',
          headers: ['Signature', 'Severity', 'Today / 7d', 'Users', 'Source', 'Browsers', 'Root cause and recommended fix'],
          weights: [0.24, 0.08, 0.09, 0.06, 0.14, 0.14, 0.25],
          rows: dErrors.slice(0, 12).map((e: any) => [
            String(e.message || '').slice(0, 120),
            String(e.severity || 'Low'),
            `${fmt(e.occurrences_today)} / ${fmt(e.occurrences_7d)}`,
            fmt(e.affected_users_today),
            `${String(e.source_file || 'n/a')}${e.source_line ? ':' + e.source_line : ''} ${String(e.component || '')}`.trim(),
            shareLine(e.browsers),
            `${String(e.root_cause || '')} Fix: ${String(e.suggested_fix || '')} Owner: ${String(e.owner_team || '')} (${String(e.expected_resolution || '')})`,
          ]),
        },
        {
          title: 'API and Edge Function Failures',
          headers: ['Endpoint', 'Failures', 'Users', 'Status', 'Root cause and fix'],
          weights: [0.26, 0.1, 0.09, 0.1, 0.45],
          rows: dApi.map((a: any) => [
            String(a.endpoint || '-'), fmt(a.failed_requests), fmt(a.affected_users), String(a.status_codes || '-'),
            `${String(a.root_cause || '')} ${String(a.recommended_fix || '')}`,
          ]),
        },
        {
          title: 'Database Diagnostics - Slow Statements',
          headers: ['Statement', 'Calls', 'Mean ms', 'Recommendation'],
          weights: [0.42, 0.09, 0.1, 0.39],
          rows: arr(dDb.slow_queries).map((q: any) => [
            String(q.query || '').replace(/\s+/g, ' ').slice(0, 220), fmt(q.calls), fmt(q.mean_ms), String(q.recommendation || ''),
          ]),
        },
        {
          title: 'Database Diagnostics - Missing Index Candidates',
          headers: ['Table', 'Seq scans', 'Rows read', 'Index scans', 'Recommendation'],
          weights: [0.2, 0.11, 0.13, 0.11, 0.45],
          rows: arr(dDb.missing_indexes).map((m: any) => [
            String(m.table), fmt(m.sequential_scans), fmt(m.rows_read_sequentially), fmt(m.index_scans), String(m.recommendation || ''),
          ]),
        },
        {
          title: 'Automation Failure Details',
          headers: ['Automation', 'Failures / runs', 'Last failure', 'Exception', 'Retry status'],
          weights: [0.22, 0.12, 0.14, 0.34, 0.18],
          rows: dJobs.map((j: any) => [
            String(j.automation), `${fmt(j.failures_24h)} / ${fmt(j.runs_24h)}`, ts(j.last_failure_at),
            String(j.exception || 'not captured').replace(/\s+/g, ' ').slice(0, 200), String(j.retry_status || ''),
          ]),
        },
        {
          title: 'Frontend Errors by Route, Browser and Device',
          headers: ['Segment', 'Type', 'Errors'],
          weights: [0.6, 0.22, 0.18],
          rows: [
            ...arr(dFront.by_route).map((r: any) => [String(r.route), 'Route', fmt(r.n)]),
            ...arr(dFront.by_browser).map((r: any) => [String(r.browser), 'Browser', fmt(r.n)]),
            ...arr(dFront.by_os).map((r: any) => [String(r.os), 'Operating system', fmt(r.n)]),
            ...arr(dFront.by_device).map((r: any) => [String(r.device), 'Device', fmt(r.n)]),
            ...arr(dFront.by_component).map((r: any) => [String(r.component), 'Component', fmt(r.n)]),
          ],
        },
        {
          title: 'Authentication Diagnostics',
          headers: ['Item', 'Type', 'Count', 'Detail'],
          weights: [0.36, 0.18, 0.12, 0.34],
          rows: [
            ...arr(dAuth.failure_breakdown).map((r: any) => [String(r.reason), 'Sign-in failure', fmt(r.n), `${fmt(r.users)} users`]),
            ...arr(dAuth.slowest_phases).map((r: any) => [String(r.phase), 'Latency', fmt(r.n), `avg ${fmt(r.avg_ms)} ms, max ${fmt(r.max_ms)} ms`]),
            ...arr(dAuth.otp_breakdown).map((r: any) => [`${r.outcome} / ${r.reason}`, 'One-time password', fmt(r.n), String(r.stage || '-')]),
            ...arr(dAuth.device_issues).map((r: any) => [String(r.event_type), 'Device', fmt(r.n), String(r.platform || '-')]),
          ],
        },
        {
          title: 'Infrastructure Alerts',
          headers: ['Metric', 'Current', 'Threshold', 'Status', 'Action'],
          weights: [0.2, 0.16, 0.13, 0.11, 0.4],
          rows: dInfra.map((i: any) => [String(i.metric), String(i.current), String(i.threshold), String(i.status), String(i.action)]),
        },
        {
          title: 'Security Events',
          headers: ['Item', 'Type', 'Count', 'Detail'],
          weights: [0.32, 0.2, 0.13, 0.35],
          rows: [
            ['Signup attempts', 'Volume', fmt(dSec.signup_attempts), `${fmt(dSec.signup_blocked)} blocked`],
            ['Authorisation violations', 'Access control', fmt(dSec.authorization_violations), 'Row level security or permission denials'],
            ['Injection probes', 'Attack surface', fmt(dSec.injection_probes), 'Detected in application error signatures'],
            ['Identity mismatch attempts', 'Fraud', fmt(dSec.identity_mismatch_attempts), 'One-time password bound to a different account'],
            ...arr(dSec.suspicious_ips).map((r: any) => [String(r.ip), 'Suspicious IP', fmt(r.attempts), `${fmt(r.distinct_identities)} identities`]),
            ...arr(dSec.brute_force_candidates).map((r: any) => [String(r.identity), 'Brute force', fmt(r.failed_attempts), ts(r.last_attempt)]),
            ...arr(dSec.privilege_changes).map((r: any) => [String(r.action_type), 'Privilege change', fmt(r.n), String(r.table_name)]),
          ],
        },
        {
          title: 'Regression Report',
          headers: ['Error', 'Movement', 'Yesterday', 'Today'],
          weights: [0.52, 0.18, 0.15, 0.15],
          rows: [
            ...arr(dReg.new_errors).map((r: any) => [String(r.error), 'New', '0', fmt(r.today)]),
            ...arr(dReg.worsening).map((r: any) => [String(r.error), 'Worsening', fmt(r.yesterday), fmt(r.today)]),
            ...arr(dReg.improving).map((r: any) => [String(r.error), 'Improving', fmt(r.yesterday), fmt(r.today)]),
            ...arr(dReg.resolved_errors).map((r: any) => [String(r.error), 'Resolved', fmt(r.yesterday), '0']),
          ],
        },
        {
          title: 'Engineering Action Items',
          headers: ['Priority', 'Issue', 'Action', 'Team', 'Due date'],
          weights: [0.08, 0.28, 0.36, 0.14, 0.14],
          rows: dActions.map((a: any) => [
            String(a.priority), String(a.issue), String(a.action || ''), String(a.team || '-'), String(a.due_date || '-'),
          ]),
        },
        {
          title: 'Business Impact of Open Defects',
          headers: ['Signature', 'Feature area', 'Users', 'Revenue', 'Data integrity', 'Blocking'],
          weights: [0.36, 0.18, 0.1, 0.12, 0.14, 0.1],
          rows: dErrors.filter((e: any) => e.revenue_exposed || e.data_integrity_risk || e.production_blocking).slice(0, 12).map((e: any) => [
            String(e.message || '').slice(0, 110), String(e.feature_area || '-'), fmt(e.affected_users_today),
            yesNo(e.revenue_exposed), yesNo(e.data_integrity_risk), yesNo(e.production_blocking),
          ]),
        },
      ],
    };

    // ---- Board framing (same data, business language) ---------------------
    const rollbackRate = pct(n(I.rollbacks), Math.max(1, n(I.commits) + n(I.rollbacks)));

    // ---- Weekly roll-up: the board memo fires weekly, so it reports the
    // trailing 7 days rather than a single day's snapshot. -------------------
    const shiftDay = (iso: string, back: number) => {
      const dt = new Date(`${iso}T00:00:00Z`);
      dt.setUTCDate(dt.getUTCDate() - back);
      return dt.toISOString().slice(0, 10);
    };

    // The rollback rate is only a real daily figure if the previous snapshot
    // in db_stat_snapshots is actually from the day before. Otherwise commits
    // and rollbacks silently accumulate over however many days separate the
    // two snapshots (a 14-day gap once produced a false "elevated rollback
    // rate" board item at 16.52% for what was really a single-day non-issue).
    const rollbackBaselineOk = (baselineAt: unknown, dayIso: string): boolean => {
      if (!baselineAt) return false;
      const baselineDay = String(baselineAt).slice(0, 10);
      return baselineDay === shiftDay(dayIso, 1);
    };
    const rollbackTrustworthy = rollbackBaselineOk(I.rollback_baseline_at, dateStr);
    const weekDates = Array.from({ length: 7 }, (_, i) => shiftDay(dateStr, 6 - i));
    const weekStart = weekDates[0];
    const boardPeriodLabel = `${weekStart} to ${dateStr}`;
    type DayRoll = {
      d: string; health: number; errUsers: number; active: number;
      loginFail: number; loginEvents: number; emailFailed: number; emailSent: number;
      jobRuns: number; jobFailed: number; rollbacks: number; commits: number; rls: number;
      rollbackOk: boolean;
    };
    const weekDays: DayRoll[] = [];
    if (boardMode) {
      const results = await Promise.all(
        weekDates.map(async (dy) => {
          if (dy === dateStr) return { dy, payload: d };
          try {
            const { data: dd, error: de } = await supabase.rpc('get_cto_daily_report', { p_date: dy });
            if (de) { console.error('[daily-cto-report] weekly rpc failed', dy, de); return null; }
            return { dy, payload: dd || {} };
          } catch (e) { console.error('[daily-cto-report] weekly rpc threw', dy, e); return null; }
        }),
      );
      for (const r of results) {
        if (!r) continue;
        const x: any = r.payload || {};
        const xP = x.platform || {}, xE = x.errors || {}, xA = x.auth || {}, xI = x.infra || {},
          xJ = x.jobs || {}, xM = x.email || {}, xS = x.security || {}, xB = x.backups || {};
        const dErr = pct(n(xE.affected_users_today), Math.max(1, Math.max(n(xP.active_24h), n(xE.affected_users_today))));
        const dLogin = pct(n(xA.login_failures_today), Math.max(1, n(xA.login_events_today)));
        const dJob = pct(n(xJ.failed_24h), Math.max(1, n(xJ.runs_24h)));
        const dConn = pct(n(xI.connections), Math.max(1, n(xI.max_connections)));
        const dRls = pct(n(xS.rls_tables), Math.max(1, n(xS.public_tables)));
        const dCache = n(xI.cache_hit_pct);
        // Each day's own backup state (end-of-day EAT), not today's — the RPC
        // now scopes backups.latest/runs_7d/failures_7d to p_date, so reusing
        // the outer backupOk here would silently repeat today's continuity
        // verdict across all seven days.
        const dBackupOk = computeBackupOk(xB, new Date(`${r.dy}T23:59:59.999+03:00`).getTime());
        const dHealth = Math.round(
          (Math.max(0, 100 - dErr * 12) * 25 + Math.max(0, 100 - dLogin * 1.6) * 15 + Math.max(0, 100 - dJob * 4) * 15 +
            Math.min(100, dCache * 0.7 + Math.max(0, 100 - dConn) * 0.3) * 20 + dRls * 15 + (dBackupOk ? 100 : 45) * 10) / 100,
        );
        weekDays.push({
          d: r.dy, health: dHealth, errUsers: n(xE.affected_users_today), active: n(xP.active_24h),
          loginFail: n(xA.login_failures_today), loginEvents: n(xA.login_events_today),
          emailFailed: n(xM.failed_today), emailSent: n(xM.sent_today),
          jobRuns: n(xJ.runs_24h), jobFailed: n(xJ.failed_24h),
          rollbacks: n(xI.rollbacks), commits: n(xI.commits), rls: dRls,
          rollbackOk: rollbackBaselineOk(xI.rollback_baseline_at, r.dy),
        });
      }
      weekDays.sort((a2, b2) => (a2.d < b2.d ? -1 : 1));
    }
    const sum = (k: keyof DayRoll) => weekDays.reduce((s, r) => s + Number(r[k] || 0), 0);
    const weeklyMode = boardMode && weekDays.length > 1;
    const wHealth = weeklyMode ? Math.round(sum('health') / weekDays.length) : health;
    const wHealthLabel = wHealth >= 85 ? 'Healthy' : wHealth >= 70 ? 'Watch' : 'At risk';
    const wHealthFirst = weekDays.length ? weekDays[0].health : health;
    const wHealthLast = weekDays.length ? weekDays[weekDays.length - 1].health : health;
    const wHealthTrend = wHealthLast - wHealthFirst;
    const wErrRate = weeklyMode ? Math.min(100, pct(sum('errUsers'), Math.max(1, n(P.active_7d)))) : errRate;
    const wAuthSuccess = weeklyMode ? 100 - pct(sum('loginFail'), Math.max(1, sum('loginEvents'))) : 100 - loginFailRate;
    const wNotifDelivery = weeklyMode ? 100 - pct(sum('emailFailed'), Math.max(1, sum('emailSent'))) : 100 - emailFailRate;
    const wJobFailRate = weeklyMode ? pct(sum('jobFailed'), Math.max(1, sum('jobRuns'))) : jobFailRate;
    const wFailedRuns = weeklyMode ? sum('jobFailed') : n(J.failed_24h);
    const wRollbackRate = weeklyMode ? pct(sum('rollbacks'), Math.max(1, sum('commits') + sum('rollbacks'))) : rollbackRate;
    // Trustworthy only if every day in the window had a same-day-before
    // snapshot to diff against — one gap anywhere poisons the sum for the
    // whole period, since rollbacks/commits from the missing days land on
    // whichever day the gap was finally closed.
    const wRollbackTrustworthy = weeklyMode ? weekDays.every((wd) => wd.rollbackOk) : rollbackTrustworthy;
    const wAffectedUsers = weeklyMode ? sum('errUsers') : n(E.affected_users_today);
    const wLedgerNote = weeklyMode ? `${fmt(P.active_7d)} active customers over the week` : `${fmt(P.active_24h)} active customers today`;
    const periodWord = weeklyMode ? 'this week' : 'today';

    const GUARDRAIL_RE = /advance|recover|guardrail|bonus|trust|wallet|ledger|payout|commission|deposit|solvency|drift|receivable/i;
    const guardrailJobs = failingJobs.filter((j: any) => GUARDRAIL_RE.test(String(j.jobname || '')));
    // J.total_scheduled counts rows in cron.job only. failingJobs also
    // includes ad-hoc/unscheduled invocations (e.g. email_queue_dispatch,
    // triggered via cron.schedule_in_background rather than a fixed
    // schedule) that were never part of that count — subtracting all of
    // failingJobs from total_scheduled understated "N of 165 scheduled"
    // even on a day where every actually-scheduled job succeeded.
    const scheduledFailingJobs = failingJobs.filter((j: any) => j.unscheduled !== true);
    // Name up to four failing jobs, then count the remainder. Naming three of
    // eleven silently understated the problem in earlier memos.
    const jobList = (jobs: any[]) => {
      const names = jobs.map((j: any) => String(j.jobname || 'unnamed'));
      const shown = names.slice(0, 4).join(', ');
      const rest = names.length - Math.min(4, names.length);
      return rest > 0 ? `${shown}, and ${rest} other${rest === 1 ? '' : 's'}` : shown;
    };
    const brokenAllDay = n(adJobsSummary.jobs_broken_all_day);
    const notifDelivery = 100 - emailFailRate;
    const authSuccess = 100 - loginFailRate;

    // ---- Authoritative board metrics from the RPC's new blocks -------------
    const siAttempts = n(SI.attempts_7d);
    const siSuccess = n(SI.success_7d);
    const siUnknown = n(SI.unknown_account_7d);
    const siWrong = n(SI.wrong_credentials_7d);
    const siPlat = n(SI.platform_failures_7d);
    const siPlatRate = pct(siPlat, Math.max(1, siAttempts));
    const siSuccessRate = pct(siSuccess, Math.max(1, siAttempts));
    const siUsersTried = n(SI.signin_sessions_tried_7d ?? SI.users_tried_7d);
    const siUsersIn = n(SI.signin_sessions_succeeded_7d ?? SI.users_eventually_signed_in_7d);
    const siEventualRate = pct(siUsersIn, Math.max(1, siUsersTried));

    const smsTotal = n(SMS.total_30d);
    const smsAccepted = n(SMS.sent) + n(SMS.accepted) + n(SMS.delivered_confirmed);
    const smsAcceptedRate = pct(smsAccepted, Math.max(1, smsTotal));
    const smsConfirmed = n(SMS.delivered_confirmed);
    const smsConfirmedRate = pct(smsConfirmed, Math.max(1, smsTotal));
    // No row in sms_delivery_log has ever reached status 'delivered', even
    // though 94% of traffic is Yoola and 21,299 rows carry a provider message
    // id — the every-10-minute sweep is running but never promoting anything.
    // Until that is fixed, 0.0% means "not being recorded", not "not received",
    // and must never be shown to the board as a delivery failure.
    const smsConfirmBroken = smsConfirmed === 0 && n(SMS.dlr_capable) > 0;
    const smsConfirmCell = smsConfirmBroken
      ? 'Not being recorded'
      : `${smsConfirmedRate.toFixed(1)}% of ${fmt(smsTotal)} over 30 days`;
    const smsUnresolved = n(SMS.pending) + n(SMS.queued);
    const smsFailed = n(SMS.failed);

    const otpSends = n(OTP.sends_30d);
    const otpAccepted = n(OTP.sends_accepted_30d);
    const otpVerifyTotal = n(OTP.verify_total_30d);
    const otpVerifyOk = n(OTP.verify_success_30d);
    const otpNoAccount = n(OTP.verify_no_account_30d);

    // True e-mail delivery: sent over every queued row, 30 days. The old
    // failed/sent ratio reported ~100% while half of all mail sat in 'pending'.
    const em30 = n(M.total_30d);
    const em30ok = n(M.delivered_30d);
    const em30pending = n(M.pending_30d);
    const em30Rate = pct(em30ok, Math.max(1, em30));
    const em30PendingRate = pct(em30pending, Math.max(1, em30));

    const num = (a: number, b: number) => `${fmt(a)} of ${fmt(b)} (${pct(a, Math.max(1, b)).toFixed(1)}%)`;


    const ragTone = (v: number): Tone => (v >= 85 ? 'good' : v >= 65 ? 'warn' : 'bad');
    // Same 85/65 bands as ragTone, so a pillar's color and its status word
    // never disagree. Security and Customer used to carry their own tighter
    // thresholds (98/90, 95/85) that only fed the text, not the color, so a
    // 92% security score rendered a green-colored "Amber" to the board.
    const ragLabel = (v: number): string => (v >= 85 ? 'Green' : v >= 65 ? 'Amber' : 'Red');
    const pillarScores = {
      // An untrustworthy rollback figure must not drag the score down (or
      // prop it up) on a number that isn't really this period's rate.
      reliability: Math.max(0, Math.min(100, 100 - (wRollbackTrustworthy ? wRollbackRate : 0) * 6 - wErrRate * 10)),
      controls: Math.max(0, 100 - guardrailJobs.length * 22 - Math.max(0, failingJobs.length - guardrailJobs.length) * 6),
      security: Math.min(100, rlsCoverage),
      // Customer experience scores on people who eventually got in and on true
      // e-mail delivery (sent/queued), not on the old failed/sent ratio.
      customer: Math.min(100, siEventualRate * 0.6 + em30Rate * 0.4),

      continuity: backupOk ? 100 : 45,
    };
    const boardPillars: { label: string; status: string; tone: Tone; note: string }[] = [
      {
        label: 'Platform Reliability',
        status: ragLabel(pillarScores.reliability),
        tone: ragTone(pillarScores.reliability),
        note: `${wRollbackTrustworthy ? `${wRollbackRate.toFixed(2)}% of database transactions rolled back ${periodWord}` : 'Transaction rollback rate not trustworthy this period — the daily report has gaps in its snapshot history'}; ${wErrRate.toFixed(2)}% of active customers hit an app error (${fmt(wAffectedUsers)} ${weeklyMode ? 'affected user-days' : 'users'}).`,
      },
      {
        label: 'Financial Controls Automation',
        status: ragLabel(pillarScores.controls),
        tone: ragTone(pillarScores.controls),
        note: guardrailJobs.length
          ? `${guardrailJobs.length} financial-control automation${guardrailJobs.length > 1 ? 's' : ''} not completing (${jobList(guardrailJobs)}); ${brokenAllDay} job(s) had no successful run today.`
          : `All ${fmt(J.total_scheduled)} automated controls completing; ${wJobFailRate.toFixed(1)}% run failure rate ${periodWord} across ${fmt(wFailedRuns)} failed run${wFailedRuns === 1 ? '' : 's'}.`,

      },
      {
        label: 'Security & Compliance',
        status: ragLabel(pillarScores.security),
        tone: ragTone(pillarScores.security),
        note: `Access controls enforced on ${rlsCoverage.toFixed(1)}% of data tables; ${fmt(S.fraud_blocks_active)} fraud blocks active; ${fmt(P.txn_today)} balanced ledger postings.`,
      },
      {
        label: 'Customer Experience',
        status: ragLabel(pillarScores.customer),
        tone: ragTone(pillarScores.customer),
        note: `${siEventualRate.toFixed(1)}% of the ${fmt(siUsersTried)} people who tried to sign in ${periodWord} got in (${siPlatRate.toFixed(2)}% of attempts failed for platform reasons); ${em30Rate.toFixed(1)}% of ${fmt(em30)} e-mails over 30 days were delivered and ${em30PendingRate.toFixed(1)}% never left the queue. E-mail only — SMS is not included in this figure.`,
      },
      {
        label: 'Business Continuity',
        status: backupOk ? 'Green' : backupStaleTone === 'bad' ? 'Red' : 'Amber',
        tone: backupOk ? 'good' : backupStaleTone === 'bad' ? 'bad' : 'warn',
        note: `${fmt(B.runs_7d)} backup${n(B.runs_7d) === 1 ? '' : 's'} in the last 7 days with ${fmt(B.failures_7d)} failure${n(B.failures_7d) === 1 ? '' : 's'}; latest successful backup ${B.latest?.created_at ? String(B.latest.created_at).slice(0, 16).replace('T', ' ') : 'not recorded'} (${backupAgeLabel}, weekly cadence).`,
      },
    ];




    // Section 2 — who the platform actually serves. Behaviour-derived counts,
    // not permission grants: nearly every account holds four role rows.
    const boardServeRows: string[][] = [
      ['Agents with real activity', fmt(R.agents_active), 'Listed a verified house, carried an approved rent plan, or collected rent'],
      ['— verified house listing', num(n(R.agents_verified_listing), n(R.agents_active)), 'Of all active agents'],
      ['— approved rent plan', num(n(R.agents_approved_rent_request), n(R.agents_active)), 'Of all active agents'],
      ['— collecting rent', num(n(R.agents_collecting_rent), n(R.agents_active)), 'Of all active agents'],
      ['— doing all three', num(n(R.agents_fully_productive), n(R.agents_active)), 'Fully productive agents'],
      ['Tenants on a funded rent plan', fmt(R.tenants_active), 'Rent plan funded, repaying or completed'],
      ['Tenant applications in intake', fmt(R.tenants_intake_queue), 'Awaiting service-centre review; not yet customers'],
      ['Funders holding a portfolio', fmt(R.funders_with_portfolio), 'Distinct funders with at least one portfolio'],
      ['Funders who accepted the agreement', fmt(R.funders_agreement_accepted), 'Signed the supporter agreement'],
      ['Landlord counterparties engaged', fmt(R.landlords_engaged), 'Counterparties on a listing or rent plan — not app users; approximate'],
      ['Landlord records on file', fmt(R.landlords_on_file), 'Directory size, not a user count'],
    ];

    // Section 3 — reach and admission. Provider-accepted is deliberately kept
    // apart from handset-confirmed; only Yoola traffic can ever be confirmed.
    const boardDeliveryRows: string[][] = [
      ['SMS accepted by a provider (30 days)', num(smsAccepted, smsTotal), 'Handed to the network — not proof of receipt'],
      ['SMS confirmed on the handset (30 days)', smsConfirmBroken ? 'Not being recorded' : num(smsConfirmed, smsTotal), smsConfirmBroken ? 'Delivery-report sweep is running but has never recorded a confirmation — a measurement fault, not a delivery failure' : `Only delivery-report-capable traffic can confirm (${num(n(SMS.dlr_capable), smsTotal)})`],
      ['SMS still unresolved (30 days)', num(smsUnresolved, smsTotal), 'Neither confirmed nor failed'],
      ['SMS rejected outright (30 days)', num(smsFailed, smsTotal), 'Provider refused the message'],
      ['OTP messages accepted (30 days)', num(otpAccepted, otpSends), 'Login codes handed to a provider'],
      ['OTP verifications succeeded (30 days)', num(otpVerifyOk, otpVerifyTotal), `${fmt(otpNoAccount)} attempts had no matching account`],
      ['E-mail delivered (30 days)', num(em30ok, em30), 'Excludes SMS entirely'],
      ['E-mail still queued (30 days)', num(em30pending, em30), 'Never left the queue'],
      ['Sign-in attempts succeeded (7 days)', num(siSuccess, siAttempts), 'All attempts, including customer mistakes'],
      ['— unknown account', num(siUnknown, siAttempts), 'No account for that identifier'],
      ['— wrong credentials', num(siWrong, siAttempts), 'Account exists, credentials rejected'],
      ['— platform-attributable failure', `${fmt(siPlat)} of ${fmt(siAttempts)} (${siPlatRate.toFixed(2)}%)`, 'Rate-limited by us, or the attempt never resolved'],
      ['Sign-in sessions that eventually succeeded (7 days)', num(siUsersIn, siUsersTried), 'A person retrying within one session counts once'],
    ];

    const boardTables: { title: string; headers: string[]; rows: string[][] }[] = [
      { title: 'Who the platform serves', headers: ['Segment', 'Figure', 'Basis'], rows: boardServeRows },
      { title: 'Reach, messaging and admission', headers: ['Measure', 'Figure', 'What it means'], rows: boardDeliveryRows },
    ];

    const boardHeadline: string[] = [
      `The platform served ${wLedgerNote} with no revenue-impacting outage, and financial ledger integrity held across ${fmt(P.txn_today)} balanced postings on the closing day.`,
      `Active participation stands at ${fmt(R.agents_active)} agents with real field activity, ${fmt(R.tenants_active)} tenants on a funded rent plan and ${fmt(R.funders_with_portfolio)} funders holding a portfolio.`,
      `Sign-in eventually worked in ${siEventualRate.toFixed(1)}% of the ${fmt(siUsersTried)} sign-in sessions over the week, and only ${siPlatRate.toFixed(2)}% of ${fmt(siAttempts)} attempts failed for reasons attributable to the platform; the remainder were unknown accounts or wrong credentials.`,
      `Messaging reach is only partly verifiable: ${smsAcceptedRate.toFixed(1)}% of ${fmt(smsTotal)} SMS were accepted by a provider but handset confirmation is currently not being recorded at all (the delivery-report sweep is running yet has never marked a single message delivered), and ${em30Rate.toFixed(1)}% of ${fmt(em30)} e-mails were delivered with ${em30PendingRate.toFixed(1)}% still queued.`,
      ...(weeklyMode
        ? [`Technology health closed at ${wHealthLast} out of 100 and averaged ${wHealth} across the seven days, ${wHealthTrend > 0 ? `improving ${wHealthTrend} points` : wHealthTrend < 0 ? `declining ${Math.abs(wHealthTrend)} points` : 'flat'} from ${wHealthFirst} on ${weekStart} to ${wHealthLast} on ${dateStr}.`]
        : []),
      guardrailJobs.length
        ? `One item needs board visibility: ${guardrailJobs.length} automated job${guardrailJobs.length > 1 ? 's' : ''} enforcing financial controls (${jobList(guardrailJobs)}) ${guardrailJobs.length > 1 ? 'have' : 'has'} not completed successfully in the last 24 hours, so those controls are currently running on manual oversight rather than automatically.`
        : `No financial-control automation is currently failing; all scheduled control jobs completed in the last 24 hours.`,
      wRollbackTrustworthy && wRollbackRate >= 5
        ? `Separately, ${wRollbackRate.toFixed(2)}% of database transactions were rolled back ${periodWord}, above the internal tolerance — this signals wasted processing and retried customer actions rather than lost money.`
        : !wRollbackTrustworthy
          ? `Separately, the transaction rollback rate cannot be trusted this period because the daily snapshot history has a gap; that figure is being suppressed rather than reported as an anomaly.`
          : `Overall technology health stands at ${wHealth} out of 100 (${wHealthLabel}); no other item requires a board decision this cycle.`,
    ];

    const boardDecisions: string[] = [];
    if (guardrailJobs.length)
      boardDecisions.push(`Approve prioritising a remediation sprint for the ${guardrailJobs.length} financial-guardrail automation${guardrailJobs.length > 1 ? 's' : ''} (${jobList(guardrailJobs)}) so financial controls run without manual oversight.`);
    if (wRollbackTrustworthy && wRollbackRate >= 5)
      boardDecisions.push(`Note the elevated transaction rollback rate (${wRollbackRate.toFixed(2)}% ${periodWord}) and the engineering commitment to bring it back within tolerance.`);
    else if (!wRollbackTrustworthy)
      boardDecisions.push(`Note that the transaction rollback rate is not being reported this cycle: the daily report has a gap in its snapshot history, so any percentage would span an unknown number of days rather than ${periodWord}. Restoring the daily run is the fix, not the rollback rate itself.`);
    if (!backupOk)
      boardDecisions.push(`Note that the last successful backup is ${backupAgeLabel} against a weekly cadence; continuity assurance requires attention before the next cycle.`);
    if (smsConfirmBroken)
      boardDecisions.push(`Note that handset delivery confirmation for SMS is not being recorded: the sweep that collects delivery reports runs every ten minutes but has never marked a single message as delivered, so we currently cannot evidence receipt of any customer SMS. This is a measurement fault to be fixed, not evidence that messages are failing.`);
    else if (smsConfirmedRate < 50)
      boardDecisions.push(`Note that only ${smsConfirmedRate.toFixed(1)}% of SMS can be confirmed as received because delivery reports are collected from one provider only; the remaining traffic is unverifiable rather than known-failed.`);
    if (em30PendingRate >= 5)
      boardDecisions.push(`Be aware that ${em30PendingRate.toFixed(1)}% of e-mails over 30 days never left the queue, which increases support load.`);
    if (!boardDecisions.length)
      boardDecisions.push('No decision required this cycle. All five pillars are within tolerance; the technology team continues on planned work.');

    const boardKpis: string[][] = [
      [weeklyMode ? 'Technology health score (closing day)' : 'Technology health score', `${wHealthLast}/100`, '85 or above', wHealthLast >= 85 ? 'On target' : 'Below target'],
      ...(weeklyMode ? [['Technology health score (7-day mean)', `${wHealth}/100 (${wHealthLabel})`, '85 or above', wHealth >= 85 ? 'On target' : 'Below target']] : []),
      ...(weeklyMode ? [['Health trend across the week', `${wHealthFirst} to ${wHealthLast} (${wHealthTrend >= 0 ? '+' : ''}${wHealthTrend})`, 'Flat or improving', wHealthTrend >= 0 ? 'On target' : 'Below target']] : []),
      ['Customers affected by an error', `${wErrRate.toFixed(2)}% of active customers`, 'Below 1.00%', wErrRate < 1 ? 'On target' : 'Below target'],
      ['Sign-in failures caused by the platform', `${siPlatRate.toFixed(2)}% of ${fmt(siAttempts)} attempts`, 'Below 0.50%', siPlatRate < 0.5 ? 'On target' : 'Below target'],
      ['Sign-in sessions that eventually succeeded (7 days)', num(siUsersIn, siUsersTried), '95.0% or above', siEventualRate >= 95 ? 'On target' : 'Below target'],
      ['Sign-in attempts succeeding first time', `${siSuccessRate.toFixed(1)}%`, '80.0% or above (customer error included)', siSuccessRate >= 80 ? 'On target' : 'Below target'],
      ['Automation success rate', `${(100 - wJobFailRate).toFixed(1)}%`, '99.0% or above', wJobFailRate <= 1 ? 'On target' : 'Below target'],
      ...(weeklyMode ? [['Failed automation runs (cumulative)', `${fmt(wFailedRuns)} over 7 days`, '5 or fewer over 7 days', wFailedRuns <= 5 ? 'On target' : 'Below target']] : []),
      ['E-mail delivery (excludes SMS)', `${em30Rate.toFixed(1)}% of ${fmt(em30)} over 30 days`, '95.0% or above', em30Rate >= 95 ? 'On target' : 'Below target'],
      ['SMS accepted by a provider', `${smsAcceptedRate.toFixed(1)}% of ${fmt(smsTotal)} over 30 days`, '95.0% or above', smsAcceptedRate >= 95 ? 'On target' : 'Below target'],
      ['SMS confirmed on the handset', smsConfirmCell, smsConfirmBroken ? 'Measurement fault — being fixed' : `Confirmable traffic only (${num(n(SMS.dlr_capable), smsTotal)})`, smsConfirmBroken ? 'Not measured' : (smsConfirmedRate >= 50 ? 'On target' : 'Below target')],
      ['Transaction rollback rate', wRollbackTrustworthy ? `${wRollbackRate.toFixed(2)}%` : 'Not trustworthy', wRollbackTrustworthy ? 'Below 5.00%' : 'Snapshot history has a gap', wRollbackTrustworthy ? (wRollbackRate < 5 ? 'On target' : 'Below target') : 'Not measured'],
      ['Financial controls automated', `${fmt(Math.max(0, n(J.total_scheduled) - scheduledFailingJobs.length))} of ${fmt(J.total_scheduled)}`, 'All scheduled jobs', scheduledFailingJobs.length ? 'Below target' : 'On target'],
    ];


    const pdfBytes = boardMode
      ? await buildBoardPdf({
          dateStr: weeklyMode ? boardPeriodLabel : dateStr,
          health: wHealth,
          healthLabel: wHealthLabel,
          healthClosing: wHealthLast,
          healthMean: wHealth,
          weekly: weeklyMode,
          headline: boardHeadline,
          pillars: boardPillars,
          decisions: boardDecisions,
          tables: boardTables,
          kpis: boardKpis,
        })
      : await buildTechPdf(techArgs);
    const pdfName = boardMode
      ? `Welile_Board_Technology_Memo_Week_Ending_${dateStr}.pdf`
      : `Welile_Daily_CTO_Report_${dateStr}.pdf`;

    const htmlTable = (t: { title: string; headers: string[]; rows: string[][] }) => `
        <h4 style="font-size:13px;margin:14px 0 6px;">${esc(t.title)}</h4>
        <table style="width:100%;border-collapse:collapse;font-size:12px;">
          <tr>${t.headers.map((h) => `<th style="text-align:left;background:${C.ink};color:#fff;padding:5px 7px;font-size:11px;">${esc(h)}</th>`).join('')}</tr>
          ${t.rows.map((r, i) => `<tr style="background:${i % 2 ? '#f8fafc' : '#fff'};">${r.map((c, ci) => `<td style="padding:5px 7px;border-bottom:1px solid ${C.line};${ci ? `color:${C.muted};` : ''}">${esc(c)}</td>`).join('')}</tr>`).join('')}
        </table>`;

    const boardHtml = `
      <div style="font-family:Helvetica,Arial,sans-serif;color:${C.ink};max-width:680px;">
        <h2 style="margin:0 0 6px;font-size:19px;">Board Technology Memo — week ending ${dateStr}</h2>
        <div style="font-size:12px;color:${C.muted};margin-bottom:14px;">Reporting period ${esc(weeklyMode ? boardPeriodLabel : dateStr)} (EAT) · Technology health ${wHealthLast}/100 on the closing day${weeklyMode ? ` · ${wHealth}/100 seven-day mean (${wHealthLabel})` : ` (${wHealthLabel})`}</div>

        <h3 style="font-size:14px;margin:18px 0 8px;">1. Headline and decisions</h3>
        ${boardHeadline.map((p) => `<p style="font-size:13.5px;line-height:1.65;margin:0 0 10px;">${esc(p)}</p>`).join('')}
        <ul style="font-size:13px;line-height:1.7;padding-left:18px;margin:0;">
          ${boardDecisions.map((b) => `<li>${esc(b)}</li>`).join('')}
        </ul>

        <h3 style="font-size:14px;margin:20px 0 8px;">2. Who the platform serves</h3>
        ${htmlTable(boardTables[0])}
        <p style="font-size:11px;color:${C.muted};margin:6px 0 0;">Counts are derived from real activity, not from permission grants. Landlords are counterparties on listings and rent plans, not application users, so their figures are approximate.</p>

        <h3 style="font-size:14px;margin:20px 0 8px;">3. Reach, messaging and admission</h3>
        ${htmlTable(boardTables[1])}
        <p style="font-size:11px;color:${C.muted};margin:6px 0 0;">E-mail delivery excludes SMS. SMS accepted by a provider is not proof of receipt, and delivery reports are collected from one provider only, so unconfirmed traffic is unverifiable rather than known-failed.</p>

        <h3 style="font-size:14px;margin:20px 0 8px;">4. Platform health, controls and continuity</h3>
        <ul style="font-size:13px;line-height:1.7;padding-left:18px;margin:0 0 10px;">
          ${boardPillars.map((p) => `<li><b>${esc(p.label)}: <span style="color:${toneColor(p.tone)}">${esc(p.status)}</span></b> — ${esc(p.note)}</li>`).join('')}
        </ul>
        ${htmlTable({ title: 'Key indicators versus target', headers: ['Indicator', 'Figure', 'Target', 'Status'], rows: boardKpis })}
        <p style="font-size:11.5px;color:${C.muted};margin-top:18px;">The full engineering diagnostic report is issued separately to the technology team.</p>
      </div>`;
    const textTable = (t: { title: string; rows: string[][] }) => [
      '',
      `${t.title}:`,
      ...t.rows.map((r) => `- ${r[0]}: ${r[1]}${r[2] ? ` (${r[2]})` : ''}`),
    ];
    const boardText = [
      `Board Technology Memo — week ending ${dateStr}`,
      `Reporting period: ${weeklyMode ? boardPeriodLabel : dateStr} (EAT)`,
      `Technology health: ${wHealthLast}/100 closing day${weeklyMode ? `, ${wHealth}/100 seven-day mean (${wHealthLabel})` : ` (${wHealthLabel})`}`,
      '',
      '1. Headline and decisions',
      ...boardHeadline,
      '',
      ...boardDecisions.map((b, i) => `${i + 1}. ${b}`),
      '',
      '2. Who the platform serves',
      ...textTable(boardTables[0]).slice(2),
      '',
      '3. Reach, messaging and admission',
      ...textTable(boardTables[1]).slice(2),
      'Note: e-mail delivery excludes SMS; SMS confirmation is only possible for delivery-report-capable traffic.',
      '',
      '4. Platform health, controls and continuity',
      ...boardPillars.map((p) => `- ${p.label}: ${p.status} — ${p.note}`),
      ...textTable({ title: 'Key indicators versus target', rows: boardKpis.map((r) => [r[0], r[1], `target ${r[2]}; ${r[3]}`]) }),
    ].join('\n');


    // Preview mode: return the PDF itself instead of emailing it.
    if (body?.preview === true) {
      return new Response(pdfBytes as unknown as BodyInit, {
        status: 200,
        headers: { ...corsHeaders, 'Content-Type': 'application/pdf', 'Content-Disposition': `attachment; filename="${pdfName}"` },
      });
    }

    const form = new FormData();
    form.append('from', FROM);
    for (const r of recipients) form.append('to', r);
    form.append('h:Reply-To', REPLY_TO);
    form.append(
      'subject',
      reportType === 'board'
        ? `Welile Weekly Board Technology Update — week ending ${dateStr} — Health ${wHealth}/100 (${wHealthLabel})`
        : `Welile Daily Tech Diagnostic Report — ${dateStr} — Health ${health}/100 (${healthLabel})`,
    );
    form.append('text', reportType === 'board' ? boardText : text);
    form.append('html', reportType === 'board' ? boardHtml : html);
    form.append('attachment', new Blob([pdfBytes as unknown as BlobPart], { type: 'application/pdf' }), pdfName);

    const mgRes = await fetch(`${mgBase}/v3/${mgDomain}/messages`, {
      method: 'POST',
      headers: { Authorization: `Basic ${btoa(`api:${mgKey}`)}` },
      body: form,
    });
    if (!mgRes.ok) {
      const errBody = await mgRes.text();
      console.error(`[daily-cto-report] Mailgun ${mgRes.status}: ${errBody}`);
      return new Response(JSON.stringify({ error: 'mailgun_failed', status: mgRes.status, details: errBody }), {
        status: 502, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    return new Response(JSON.stringify({ ok: true, date: dateStr, period: reportType === 'board' ? boardPeriodLabel : dateStr, weekly: weeklyMode, report_type: reportType, recipients, health: reportType === 'board' ? wHealth : health, risks: risks.length, attachment: pdfName, pdf_bytes: pdfBytes.length }), {
      status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  } catch (e) {
    console.error('[daily-cto-report] error', e);
    return new Response(JSON.stringify({ error: (e as Error).message }), {
      status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});

// ============================================================================
// PDF renderer (pdf-lib). A4 portrait, auto page-break, no emojis, no images.
// ============================================================================

interface PdfArgs {
  dateStr: string;
  generatedAt: string;
  health: number;
  healthLabel: string;
  scoreParts: { label: string; weight: number; value: number }[];
  summaryPoints: string[];
  platform: [string, string][];
  errorTrend: { label: string; value: number }[];
  infra: [string, string][];
  largestTables: { label: string; value: number; display: string }[];
  failingJobs: string[][];
  topRoutes: string[][];
  topMessages: string[][];
  slowQueries: string[][];
  security: [string, string][];
  experience: [string, string][];
  risks: string[][];
  compliance: string[][];
  kpis: string[][];
  recommendations: string[];
  diagSections?: { title: string; headers: string[]; rows: string[][]; weights: number[] }[];
}

async function buildTechPdf(a: PdfArgs): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);

  const W = 595.28, H = 841.89, margin = 40;
  const col = (r: number, g: number, b: number) => rgb(r / 255, g / 255, b / 255);
  const ink = col(15, 23, 42);
  const muted = col(100, 116, 139);
  const line = col(226, 232, 240);
  const soft = col(248, 250, 252);
  const brand = col(11, 95, 255);
  const good = col(15, 157, 88);
  const warn = col(199, 119, 0);
  const bad = col(192, 57, 43);
  const tone = (v: number) => (v >= 85 ? good : v >= 70 ? warn : bad);

  let page = doc.addPage([W, H]);
  let y = 0;
  let pageNo = 0;

  const clip = (s: string, f: any, size: number, maxW: number) => {
    let t = String(s ?? '');
    if (f.widthOfTextAtSize(t, size) <= maxW) return t;
    while (t.length > 1 && f.widthOfTextAtSize(t + '...', size) > maxW) t = t.slice(0, -1);
    return t + '...';
  };
  const wrap = (s: string, f: any, size: number, maxW: number) => {
    const raw = String(s ?? '').split(/\s+/);
    // hard-break tokens longer than the column (SQL text, identifiers)
    const words: string[] = [];
    for (const w of raw) {
      let t = w;
      while (f.widthOfTextAtSize(t, size) > maxW) {
        let cut = 1;
        while (cut < t.length && f.widthOfTextAtSize(t.slice(0, cut + 1), size) <= maxW) cut += 1;
        words.push(t.slice(0, cut));
        t = t.slice(cut);
      }
      if (t) words.push(t);
    }
    const lines: string[] = [];
    let cur = '';
    for (const w of words) {
      const t = cur ? `${cur} ${w}` : w;
      if (f.widthOfTextAtSize(t, size) > maxW && cur) { lines.push(cur); cur = w; } else { cur = t; }
    }
    if (cur) lines.push(cur);
    return lines;
  };

  const header = () => {
    pageNo += 1;
    page.drawRectangle({ x: 0, y: H - 86, width: W, height: 86, color: ink });
    page.drawText('WELILE TECHNOLOGIES LIMITED', { x: margin, y: H - 34, size: 8.5, font: bold, color: col(148, 163, 184) });
    page.drawText('Daily Chief Technology Officer Report', { x: margin, y: H - 56, size: 16, font: bold, color: col(255, 255, 255) });
    page.drawText(`Reporting day ${a.dateStr} (EAT)  |  Health score ${a.health}/100 (${a.healthLabel})`, { x: margin, y: H - 74, size: 8.5, font, color: col(203, 213, 225) });
    const pn = `Page ${pageNo}`;
    page.drawText(pn, { x: W - margin - bold.widthOfTextAtSize(pn, 8.5), y: H - 74, size: 8.5, font: bold, color: col(203, 213, 225) });
    y = H - 86 - 24;
  };
  const footer = () => {
    page.drawLine({ start: { x: margin, y: 38 }, end: { x: W - margin, y: 38 }, color: line, thickness: 0.6 });
    page.drawText('Confidential - prepared for the Chief Executive Officer and Board of Directors', { x: margin, y: 25, size: 7.5, font, color: muted });
  };
  const newPage = () => { footer(); page = doc.addPage([W, H]); header(); };
  const ensure = (h: number) => { if (y - h < 56) newPage(); };

  header();

  const sectionTitle = (num: number, label: string) => {
    ensure(34);
    page.drawText(`${num}. ${label.toUpperCase()}`, { x: margin, y: y - 11, size: 9.5, font: bold, color: ink });
    page.drawLine({ start: { x: margin, y: y - 17 }, end: { x: W - margin, y: y - 17 }, color: ink, thickness: 1.2 });
    y -= 28;
  };

  const bars = (rows: { label: string; value: number; display?: string }[], maxOverride?: number, toned = false) => {
    const max = maxOverride ?? Math.max(1, ...rows.map((r) => r.value));
    const labelW = 140, valW = 62;
    const trackW = W - margin * 2 - labelW - valW;
    for (const r of rows) {
      ensure(16);
      page.drawText(clip(r.label, font, 8, labelW - 6), { x: margin, y: y - 9, size: 8, font, color: muted });
      page.drawRectangle({ x: margin + labelW, y: y - 12, width: trackW, height: 9, color: soft });
      const w = Math.max(2, (r.value / max) * trackW);
      page.drawRectangle({ x: margin + labelW, y: y - 12, width: w, height: 9, color: toned ? tone(r.value) : brand });
      const disp = r.display ?? r.value.toLocaleString('en-UG');
      page.drawText(disp, { x: W - margin - bold.widthOfTextAtSize(disp, 8), y: y - 9, size: 8, font: bold, color: ink });
      y -= 14;
    }
    y -= 6;
  };

  const kpiGrid = (items: [string, string][]) => {
    const perRow = 3, gutter = 8;
    const cardW = (W - margin * 2 - gutter * (perRow - 1)) / perRow;
    const cardH = 42;
    for (let i = 0; i < items.length; i += perRow) {
      ensure(cardH + 8);
      const row = items.slice(i, i + perRow);
      row.forEach((it, ix) => {
        const x = margin + ix * (cardW + gutter);
        page.drawRectangle({ x, y: y - cardH, width: cardW, height: cardH, color: soft, borderColor: line, borderWidth: 0.6 });
        page.drawRectangle({ x, y: y - cardH, width: 2.5, height: cardH, color: brand });
        page.drawText(clip(it[0].toUpperCase(), bold, 6.5, cardW - 14), { x: x + 9, y: y - 15, size: 6.5, font: bold, color: muted });
        let vs = 12;
        while (vs > 7 && bold.widthOfTextAtSize(it[1], vs) > cardW - 18) vs -= 0.5;
        page.drawText(it[1], { x: x + 9, y: y - 32, size: vs, font: bold, color: ink });
      });
      y -= cardH + gutter;
    }
    y -= 2;
  };

  const grid = (headers: string[], rows: string[][], weights: number[]) => {
    if (!rows.length) {
      ensure(18);
      page.drawText('No records for this period.', { x: margin, y: y - 10, size: 8.5, font, color: muted });
      y -= 20;
      return;
    }
    const tw = W - margin * 2;
    const colW = weights.map((w) => tw * w);
    const drawHead = () => {
      ensure(18);
      page.drawRectangle({ x: margin, y: y - 15, width: tw, height: 15, color: soft });
      let cx = margin;
      headers.forEach((h, i) => {
        page.drawText(clip(h.toUpperCase(), bold, 7, colW[i] - 10), { x: cx + 5, y: y - 11, size: 7, font: bold, color: muted });
        cx += colW[i];
      });
      y -= 15;
    };
    drawHead();
    rows.forEach((r, ri) => {
      const cellLines = r.map((c, i) => wrap(String(c ?? ''), i === 0 ? bold : font, 8, colW[i] - 10).slice(0, 3));
      const rowH = Math.max(15, 4 + cellLines.reduce((m, l) => Math.max(m, l.length), 1) * 9.5);
      if (y - rowH < 56) { newPage(); drawHead(); }
      if (ri % 2 === 1) page.drawRectangle({ x: margin, y: y - rowH, width: tw, height: rowH, color: col(252, 252, 254) });
      let cx = margin;
      cellLines.forEach((lines, i) => {
        lines.forEach((ln, li) => {
          page.drawText(ln, { x: cx + 5, y: y - 11 - li * 9.5, size: 8, font: i === 0 ? bold : font, color: ink });
        });
        cx += colW[i];
      });
      page.drawLine({ start: { x: margin, y: y - rowH }, end: { x: W - margin, y: y - rowH }, color: line, thickness: 0.5 });
      y -= rowH;
    });
    y -= 10;
  };

  // 1. Executive summary
  sectionTitle(1, 'Executive Summary');
  ensure(70);
  const boxH = 56;
  page.drawRectangle({ x: margin, y: y - boxH, width: 120, height: boxH, color: soft, borderColor: tone(a.health), borderWidth: 2 });
  page.drawText(String(a.health), { x: margin + 12, y: y - 36, size: 28, font: bold, color: tone(a.health) });
  page.drawText('/ 100', { x: margin + 12 + bold.widthOfTextAtSize(String(a.health), 28) + 5, y: y - 36, size: 10, font: bold, color: muted });
  page.drawText(`HEALTH: ${a.healthLabel.toUpperCase()}`, { x: margin + 12, y: y - 50, size: 7, font: bold, color: muted });
  let sy = y - 8;
  for (const p of a.summaryPoints.slice(0, 3)) {
    for (const ln of wrap(p, font, 8, W - margin * 2 - 136)) {
      page.drawText(ln, { x: margin + 132, y: sy - 4, size: 8, font, color: ink });
      sy -= 10;
    }
    sy -= 2;
  }
  y = Math.min(y - boxH, sy) - 12;
  for (const p of a.summaryPoints.slice(3)) {
    for (const ln of wrap(`- ${p}`, font, 8, W - margin * 2)) {
      ensure(12);
      page.drawText(ln, { x: margin, y: y - 8, size: 8, font, color: ink });
      y -= 10;
    }
  }
  y -= 8;
  bars(a.scoreParts.map((s) => ({ label: `${s.label} (${s.weight}%)`, value: s.value, display: String(s.value) })), 100, true);

  // 2. Platform health
  sectionTitle(2, 'Platform Health Dashboard');
  kpiGrid(a.platform);
  if (a.errorTrend.length) {
    ensure(20);
    page.drawText('CLIENT ERROR TREND - LAST 14 DAYS', { x: margin, y: y - 9, size: 7, font: bold, color: muted });
    y -= 16;
    bars(a.errorTrend);
  }

  // 3. Infrastructure
  sectionTitle(3, 'Infrastructure Operations');
  kpiGrid(a.infra);
  if (a.largestTables.length) {
    ensure(20);
    page.drawText('STORAGE FOOTPRINT - LARGEST TABLES', { x: margin, y: y - 9, size: 7, font: bold, color: muted });
    y -= 16;
    bars(a.largestTables);
  }
  ensure(20);
  page.drawText('FAILING AUTOMATIONS - LAST 24 HOURS', { x: margin, y: y - 9, size: 7, font: bold, color: muted });
  y -= 16;
  grid(['Automation', 'Failures', 'Last error'], a.failingJobs, [0.3, 0.12, 0.58]);

  // 4. Engineering performance
  sectionTitle(4, 'Engineering Performance');
  grid(['Route', 'Errors (7d)'], a.topRoutes, [0.75, 0.25]);
  grid(['Most frequent error', 'Occurrences (7d)'], a.topMessages, [0.75, 0.25]);
  grid(['Slowest database operation', 'Mean ms', 'Calls'], a.slowQueries, [0.62, 0.19, 0.19]);

  // 5. Cybersecurity
  sectionTitle(5, 'Cybersecurity Dashboard');
  kpiGrid(a.security);

  // 6-9. Experience, monitoring, data
  sectionTitle(6, 'Customer Experience, Monitoring and Data');
  kpiGrid(a.experience);

  // 7. Risk register
  sectionTitle(7, 'Technology Risk Register');
  grid(['Area', 'Risk', 'Likelihood', 'Impact', 'Mitigation'], a.risks, [0.14, 0.32, 0.13, 0.11, 0.3]);

  // 8. Compliance
  sectionTitle(8, 'Compliance');
  grid(['Control', 'Status', 'Evidence'], a.compliance, [0.36, 0.19, 0.45]);

  // 9. KPIs
  sectionTitle(9, 'CTO Executive KPIs');
  grid(['KPI', 'Today', 'Target'], a.kpis, [0.5, 0.25, 0.25]);

  // 10. Recommendations
  sectionTitle(10, 'Strategic Recommendations and Action Items');
  a.recommendations.forEach((r, i) => {
    const lines = wrap(`${i + 1}. ${r}`, font, 8.5, W - margin * 2 - 10);
    ensure(lines.length * 11 + 6);
    lines.forEach((ln, li) => {
      page.drawText(ln, { x: margin + (li ? 12 : 0), y: y - 9, size: 8.5, font: li ? font : bold, color: ink });
      y -= 11;
    });
    y -= 4;
  });

  ensure(24);
  page.drawText(`Generated from live production telemetry at ${a.generatedAt} UTC.`, { x: margin, y: y - 10, size: 7.5, font, color: muted });

  // 11+. Deep technical diagnostics
  let dn = 10;
  for (const s of a.diagSections || []) {
    if (!s.rows.length) continue;
    dn += 1;
    sectionTitle(dn, s.title);
    grid(s.headers, s.rows, s.weights);
  }

  footer();

  return await doc.save();
}

// ============================================================================
// Board memo renderer — 1-2 pages, business framing, no engineering detail.
// ============================================================================

interface BoardArgs {
  dateStr: string;
  health: number;
  healthLabel: string;
  healthClosing?: number;
  healthMean?: number;
  weekly?: boolean;
  headline: string[];
  pillars: { label: string; status: string; tone: Tone; note: string }[];
  decisions: string[];
  tables?: { title: string; headers: string[]; rows: string[][] }[];
  kpis: string[][];
}


async function buildBoardPdf(a: BoardArgs): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);

  const W = 595.28, H = 841.89, margin = 46;
  const col = (r: number, g: number, b: number) => rgb(r / 255, g / 255, b / 255);
  const ink = col(15, 23, 42);
  const muted = col(100, 116, 139);
  const line = col(226, 232, 240);
  const soft = col(248, 250, 252);
  const good = col(15, 157, 88);
  const warn = col(199, 119, 0);
  const bad = col(192, 57, 43);
  const statusColor = (t: Tone) => (t === 'good' ? good : t === 'warn' ? warn : t === 'bad' ? bad : muted);

  let page = doc.addPage([W, H]);
  let y = 0;
  let pageNo = 0;

  const wrap = (s: string, f: any, size: number, maxW: number) => {
    const words = String(s ?? '').split(/\s+/);
    const lines: string[] = [];
    let cur = '';
    for (const w of words) {
      const t = cur ? `${cur} ${w}` : w;
      if (f.widthOfTextAtSize(t, size) > maxW && cur) { lines.push(cur); cur = w; } else { cur = t; }
    }
    if (cur) lines.push(cur);
    return lines;
  };

  const header = () => {
    pageNo += 1;
    page.drawRectangle({ x: 0, y: H - 92, width: W, height: 92, color: ink });
    page.drawText('WELILE TECHNOLOGIES LIMITED', { x: margin, y: H - 34, size: 8.5, font: bold, color: col(148, 163, 184) });
    page.drawText('Board of Directors — Technology Memo', { x: margin, y: H - 58, size: 17, font: bold, color: col(255, 255, 255) });
    const closing = a.healthClosing ?? a.health;
    const meanTxt = a.weekly && a.healthMean !== undefined ? `  |  7-day mean ${a.healthMean}/100 (${a.healthLabel})` : ` (${a.healthLabel})`;
    page.drawText(`Reporting period ${a.dateStr} (EAT)  |  Health ${closing}/100 on closing day${meanTxt}`, { x: margin, y: H - 78, size: 9, font, color: col(203, 213, 225) });


    const pn = `Page ${pageNo}`;
    page.drawText(pn, { x: W - margin - bold.widthOfTextAtSize(pn, 8.5), y: H - 78, size: 8.5, font: bold, color: col(203, 213, 225) });
    y = H - 92 - 26;
  };
  const footer = () => {
    page.drawLine({ start: { x: margin, y: 38 }, end: { x: W - margin, y: 38 }, color: line, thickness: 0.6 });
    page.drawText('Confidential - prepared for the Chief Executive Officer and Board of Directors. Full engineering diagnostics issued separately.', { x: margin, y: 25, size: 7.5, font, color: muted });
  };
  const newPage = () => { footer(); page = doc.addPage([W, H]); header(); };
  const ensure = (h: number) => { if (y - h < 56) newPage(); };

  header();

  const sectionTitle = (label: string) => {
    ensure(32);
    page.drawText(label.toUpperCase(), { x: margin, y: y - 11, size: 9.5, font: bold, color: ink });
    page.drawLine({ start: { x: margin, y: y - 17 }, end: { x: W - margin, y: y - 17 }, color: ink, thickness: 1.2 });
    y -= 28;
  };

  const para = (s: string, size = 10.5) => {
    for (const l of wrap(s, font, size, W - margin * 2)) {
      ensure(size + 5);
      page.drawText(l, { x: margin, y: y - size, size, font, color: ink });
      y -= size + 4.5;
    }
    y -= 5;
  };

  const bullet = (s: string, size = 10) => {
    const maxW = W - margin * 2 - 14;
    const lines = wrap(s, font, size, maxW);
    lines.forEach((l, i) => {
      ensure(size + 5);
      if (i === 0) page.drawText('-', { x: margin, y: y - size, size, font: bold, color: muted });
      page.drawText(l, { x: margin + 14, y: y - size, size, font, color: ink });
      y -= size + 4;
    });
    y -= 3;
  };

  // Generic table renderer: every cell wraps and each row is sized to its
  // tallest cell, so long indicator names and targets can no longer collide
  // with the next column or spill outside the row band.
  const table = (headers: string[], weights: number[], rows: string[][], size = 8.5) => {
    const totalW = W - margin * 2;
    const colX = (i: number) => margin + weights.slice(0, i).reduce((s, w) => s + w * totalW, 0);
    const colW = (i: number) => weights[i] * totalW - 12;
    const drawHead = () => {
      page.drawRectangle({ x: margin, y: y - 18, width: totalW, height: 18, color: ink });
      headers.forEach((h, i) => page.drawText(h, { x: colX(i) + 6, y: y - 13, size, font: bold, color: col(255, 255, 255) }));
      y -= 18;
    };
    ensure(18 + 30);
    drawHead();
    rows.forEach((row, ri) => {
      const cells = row.map((c, i) => wrap(String(c ?? ''), i === row.length - 1 ? bold : font, size, colW(i)));
      const rowH = Math.max(16, 6 + Math.max(...cells.map((c) => c.length)) * (size + 3.2));
      if (y - rowH < 56) { newPage(); drawHead(); }
      if (ri % 2 === 1) page.drawRectangle({ x: margin, y: y - rowH, width: totalW, height: rowH, color: soft });
      cells.forEach((lines, i) => {
        const isStatus = i === row.length - 1 && headers[i] === 'Status';
        const c = isStatus ? (String(row[i]) === 'On target' ? good : warn) : i === 0 ? ink : muted;
        lines.forEach((l, li) => {
          page.drawText(l, { x: colX(i) + 6, y: y - 11 - li * (size + 3.2), size, font: isStatus || i === 0 ? bold : font, color: c });
        });
      });
      page.drawLine({ start: { x: margin, y: y - rowH }, end: { x: W - margin, y: y - rowH }, color: line, thickness: 0.5 });
      y -= rowH;
    });
    y -= 8;
  };

  // ---- 1. Headline and decisions ----------------------------------------
  sectionTitle('1. Headline and decisions');
  for (const p of a.headline) para(p);
  for (const b of a.decisions) bullet(b);

  // ---- 2. Who the platform serves ---------------------------------------
  const serve = a.tables?.[0];
  if (serve) {
    sectionTitle('2. Who the platform serves');
    table(serve.headers, [0.36, 0.22, 0.42], serve.rows);
    para('Counts are derived from real activity, not from permission grants. Landlords are counterparties on listings and rent plans rather than application users, so those figures are approximate.', 8.5);
  }

  // ---- 3. Reach, messaging and admission --------------------------------
  const reach = a.tables?.[1];
  if (reach) {
    sectionTitle('3. Reach, messaging and admission');
    table(reach.headers, [0.38, 0.24, 0.38], reach.rows);
    para('E-mail delivery excludes SMS. Acceptance by an SMS provider is not proof of receipt, and delivery reports are collected from one provider only, so unconfirmed traffic is unverifiable rather than known-failed.', 8.5);
  }

  // ---- 4. Platform health, controls and continuity -----------------------
  sectionTitle('4. Platform health, controls and continuity');
  for (const p of a.pillars) {
    const noteLines = wrap(p.note, font, 9, W - margin * 2 - 182);
    const blockH = Math.max(30, 16 + noteLines.length * 12);
    ensure(blockH + 6);
    page.drawRectangle({ x: margin, y: y - blockH, width: W - margin * 2, height: blockH, color: soft });
    page.drawRectangle({ x: margin, y: y - blockH, width: 4, height: blockH, color: statusColor(p.tone) });
    wrap(p.label, bold, 10, 150).forEach((l, i) => {
      page.drawText(l, { x: margin + 12, y: y - 15 - i * 11, size: 10, font: bold, color: ink });
    });
    page.drawText(p.status.toUpperCase(), { x: margin + 12, y: y - blockH + 8, size: 9, font: bold, color: statusColor(p.tone) });
    noteLines.forEach((l, i) => {
      page.drawText(l, { x: margin + 182, y: y - 15 - i * 12, size: 9, font, color: muted });
    });
    y -= blockH + 8;
  }
  y -= 4;

  table(['Indicator', 'Figure', 'Target', 'Status'], [0.34, 0.24, 0.24, 0.18], a.kpis);

  footer();
  return await doc.save();

}
