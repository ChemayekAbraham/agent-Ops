// Deposit Monitoring & Exception Reporting
// -----------------------------------------------------------------------------
// Generates a professional PDF covering EVERY deposit received in the reporting
// window (06:00 / 12:00 / 18:00 EAT) and emails it to Finance.
//
// STRICTLY READ-ONLY: this function never inserts, updates or processes any
// deposit. It only SELECTs and sends an email.
//
// Cron (UTC): 03:00 -> 06:00 EAT slot, 09:00 -> 12:00 EAT, 15:00 -> 18:00 EAT.
// Manual: POST { "period_end": "2026-08-04T12:00:00+03:00", "recipients": [...] }
//         POST { "start": "<iso>", "end": "<iso>" }

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.4';
import { PDFDocument, StandardFonts, rgb } from 'https://esm.sh/pdf-lib@1.17.1';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const FROM = 'Welile Reports <reports@welile.com>';
const DEFAULT_RECIPIENTS = ['joshwanda17@gmail.com'];
const LOGO_URL = 'https://welileapp.com/welile-logo.png';

// Known merchant collection lines. Channel -> merchant code shown on the report.
// Anything not listed is reported as an unmapped merchant (manual review).
const MERCHANT_CODES: Record<string, string> = {
  mtn_momo: 'MTN MoMoPay',
  airtel_money: 'Airtel Pay',
  bank: 'Equity Bank line',
};

const EAT_OFFSET_MS = 3 * 60 * 60 * 1000;
const SLOT_HOURS = [6, 12, 18];

function fmtUgx(n: number) {
  return Math.round(Number(n) || 0).toLocaleString('en-UG');
}

function eatStamp(iso: string | null | undefined) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '—';
  return new Date(d.getTime() + EAT_OFFSET_MS).toISOString().replace('T', ' ').slice(0, 16);
}

/** Resolve [start, end) for the reporting slot that just closed. */
function resolveWindow(nowMs: number, periodEnd?: string) {
  if (periodEnd) {
    const end = new Date(periodEnd);
    const start = previousBoundary(end.getTime());
    return { start, end };
  }
  const end = new Date(latestBoundary(nowMs));
  const start = previousBoundary(end.getTime());
  return { start, end };
}

function boundariesAround(ms: number): number[] {
  const out: number[] = [];
  for (let dayShift = -2; dayShift <= 1; dayShift++) {
    const eatDay = new Date(ms + EAT_OFFSET_MS + dayShift * 86400000).toISOString().slice(0, 10);
    for (const h of SLOT_HOURS) {
      out.push(new Date(`${eatDay}T${String(h).padStart(2, '0')}:00:00.000+03:00`).getTime());
    }
  }
  return [...new Set(out)].sort((a, b) => a - b);
}

function latestBoundary(ms: number): number {
  const b = boundariesAround(ms).filter((t) => t <= ms);
  return b[b.length - 1];
}

function previousBoundary(ms: number): Date {
  const b = boundariesAround(ms).filter((t) => t < ms);
  return new Date(b[b.length - 1]);
}

function slotLabel(end: Date) {
  const eat = new Date(end.getTime() + EAT_OFFSET_MS).toISOString();
  return `${eat.slice(0, 10)} ${eat.slice(11, 16)} EAT`;
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

// ---------- deposit-notification parsing (read-only, best effort) ----------
function last9(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const d = String(raw).replace(/[^0-9]/g, '');
  return d.length >= 9 ? d.slice(-9) : null;
}

function parseNotification(text: string | null | undefined) {
  const t = (text || '').replace(/\s+/g, ' ').trim();
  const res: { senderName: string | null; senderPhone: string | null; reference: string | null } = {
    senderName: null, senderPhone: null, reference: null,
  };
  if (!t) return res;

  // Airtel: "RECEIVED. TID... UGX 30,000 from 730328173 reference0757229748."
  const airtel = t.match(/from\s+((?:\+?256|0)?\d{9})\b/i);
  if (airtel) res.senderPhone = airtel[1];
  const ref = t.match(/reference\s*[:#]?\s*([A-Za-z0-9._-]{1,32})/i);
  if (ref) res.reference = ref[1];

  // MTN: "You have received UGX 1000000 from (MERCY ALOBO) 256776104927."
  const mtn = t.match(/from\s*\(([^)]{2,60})\)\s*((?:\+?256|0)?\d{9,12})?/i);
  if (mtn) {
    res.senderName = mtn[1].trim();
    if (mtn[2] && !res.senderPhone) res.senderPhone = mtn[2];
  }
  if (!res.senderName) {
    const named = t.match(/from\s+([A-Z][A-Za-z'`.-]+(?:\s+[A-Z][A-Za-z'`.-]+){1,3})\b/);
    if (named) res.senderName = named[1].trim();
  }
  return res;
}

type Section = 'processed' | 'pending' | 'unmatched' | 'failed';

interface Row {
  receivedAt: string;
  senderName: string;
  senderPhone: string;
  network: string;
  merchantCode: string;
  tid: string;
  amount: number;
  currency: string;
  reference: string;
  status: string;
  walletCredited: boolean;
  userExists: boolean;
  walletExists: boolean;
  matched: boolean;
  processor: string;
  processedAt: string;
  exception: string;
  section: Section;
  reviewReasons: string[];
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
    const recipients: string[] = Array.isArray(body?.recipients) && body.recipients.length > 0
      ? body.recipients.filter((r: unknown) => typeof r === 'string' && (r as string).includes('@'))
      : DEFAULT_RECIPIENTS;

    let start: Date, end: Date;
    if (typeof body?.start === 'string' && typeof body?.end === 'string') {
      start = new Date(body.start); end = new Date(body.end);
    } else {
      ({ start, end } = resolveWindow(Date.now(), typeof body?.period_end === 'string' ? body.period_end : undefined));
    }
    const startIso = start.toISOString();
    const endIso = end.toISOString();

    const supabase = createClient(supabaseUrl, serviceKey);

    // ---------- 1. incoming money notifications ----------
    const gmailRows = await fetchAll<any>((f, t) => supabase
      .from('gmail_transactions')
      .select('id, internal_date, created_at, amount, transaction_id, channel, counterparty, from_name, subject, snippet, raw_body, direction, linked_deposit_request_id, auto_matched_at, auto_match_method, is_bulk_bank_payout, dedup_hash')
      .eq('direction', 'in')
      .gte('internal_date', startIso)
      .lt('internal_date', endIso)
      .order('internal_date', { ascending: true })
      .range(f, t));

    // ---------- 2. deposit requests raised in the window ----------
    const depositRows = await fetchAll<any>((f, t) => supabase
      .from('deposit_requests')
      .select('id, user_id, agent_id, amount, status, provider, transaction_id, transaction_date, created_at, approved_at, rejected_at, rejection_reason, notes, audit_flagged, auto_approved, auto_match_audit, auto_credit_review_status, deposit_purpose')
      .gte('created_at', startIso)
      .lt('created_at', endIso)
      .order('created_at', { ascending: true })
      .range(f, t));

    // Deposit requests referenced by the window's notifications (may pre-date it)
    const linkedIds = [...new Set(gmailRows.map((g) => g.linked_deposit_request_id).filter(Boolean))];
    const knownDeposit = new Map<string, any>();
    depositRows.forEach((d) => knownDeposit.set(d.id, d));
    const missingLinked = linkedIds.filter((id) => !knownDeposit.has(id));
    for (let i = 0; i < missingLinked.length; i += 200) {
      const { data } = await supabase
        .from('deposit_requests')
        .select('id, user_id, agent_id, amount, status, provider, transaction_id, transaction_date, created_at, approved_at, rejected_at, rejection_reason, notes, audit_flagged, auto_approved, auto_match_audit, auto_credit_review_status, deposit_purpose')
        .in('id', missingLinked.slice(i, i + 200));
      (data ?? []).forEach((d: any) => knownDeposit.set(d.id, d));
    }

    // ---------- 3. wallet credit proof (ledger) ----------
    const depositIds = [...knownDeposit.keys()];
    const creditedAt = new Map<string, string>();
    for (let i = 0; i < depositIds.length; i += 200) {
      const { data } = await supabase
        .from('general_ledger')
        .select('source_id, created_at')
        .eq('source_table', 'deposit_requests')
        .eq('ledger_scope', 'wallet')
        .eq('direction', 'cash_in')
        .in('source_id', depositIds.slice(i, i + 200));
      (data ?? []).forEach((l: any) => {
        if (!creditedAt.has(l.source_id)) creditedAt.set(l.source_id, l.created_at);
      });
    }

    // ---------- 4. resolve users / wallets ----------
    const parsedByGmail = new Map<string, ReturnType<typeof parseNotification>>();
    const phoneKeys = new Set<string>();
    for (const g of gmailRows) {
      const p = parseNotification(g.raw_body || g.snippet);
      if (!p.senderPhone && g.counterparty) {
        const l9 = last9(g.counterparty);
        if (l9) p.senderPhone = l9;
      }
      parsedByGmail.set(g.id, p);
      const l9 = last9(p.senderPhone);
      if (l9) phoneKeys.add(l9);
    }

    const profileByPhone = new Map<string, { id: string; full_name: string | null; phone: string | null }>();
    const phoneList = [...phoneKeys];
    for (let i = 0; i < phoneList.length; i += 20) {
      const chunk = phoneList.slice(i, i + 20);
      const clause = chunk.flatMap((p) => [`phone.ilike.%${p}`, `mobile_money_number.ilike.%${p}`]).join(',');
      const { data } = await supabase
        .from('profiles')
        .select('id, full_name, phone, mobile_money_number')
        .or(clause)
        .limit(1000);
      (data ?? []).forEach((pr: any) => {
        for (const cand of [pr.phone, pr.mobile_money_number]) {
          const l9 = last9(cand);
          if (l9 && chunk.includes(l9) && !profileByPhone.has(l9)) {
            profileByPhone.set(l9, { id: pr.id, full_name: pr.full_name, phone: pr.phone });
          }
        }
      });
    }

    const ownerIds = new Set<string>();
    knownDeposit.forEach((d) => { if (d.user_id) ownerIds.add(d.user_id); });
    profileByPhone.forEach((p) => ownerIds.add(p.id));
    const ownerList = [...ownerIds];

    const profileById = new Map<string, { full_name: string | null; phone: string | null }>();
    const hasWallet = new Set<string>();
    for (let i = 0; i < ownerList.length; i += 300) {
      const slice = ownerList.slice(i, i + 300);
      const [{ data: profs }, { data: wals }] = await Promise.all([
        supabase.from('profiles').select('id, full_name, phone').in('id', slice),
        supabase.from('wallets').select('user_id').in('user_id', slice),
      ]);
      (profs ?? []).forEach((p: any) => profileById.set(p.id, { full_name: p.full_name, phone: p.phone }));
      (wals ?? []).forEach((w: any) => hasWallet.add(w.user_id));
    }

    // ---------- 5. build unified rows ----------
    const rows: Row[] = [];
    const tidCounts = new Map<string, number>();
    const countTid = (tid: string | null) => {
      if (!tid) return;
      tidCounts.set(tid, (tidCounts.get(tid) || 0) + 1);
    };
    gmailRows.forEach((g) => countTid(g.transaction_id));
    depositRows.forEach((d) => { if (!gmailRows.some((g) => g.linked_deposit_request_id === d.id)) countTid(d.transaction_id); });

    const networkOf = (channel: string | null) =>
      channel === 'mtn_momo' ? 'MTN' : channel === 'airtel_money' ? 'Airtel' : channel === 'bank' ? 'Bank' : (channel || 'Unknown');

    const buildRow = (args: {
      receivedAt: string; senderName: string | null; senderPhone: string | null; channel: string | null;
      tid: string | null; amount: number; reference: string | null; dep: any | null; sourceLabel: string;
      autoMatchMethod?: string | null; autoMatchedAt?: string | null; bulk?: boolean;
    }): Row => {
      const dep = args.dep;
      const l9 = last9(args.senderPhone);
      const matchedProfile = dep?.user_id
        ? { id: dep.user_id, full_name: profileById.get(dep.user_id)?.full_name ?? null }
        : (l9 ? profileByPhone.get(l9) ?? null : null);

      const userExists = !!matchedProfile;
      const walletExists = matchedProfile ? hasWallet.has(matchedProfile.id) : false;
      const credited = dep ? creditedAt.has(dep.id) : false;
      const matched = !!dep && !!dep.user_id;

      const status = dep
        ? String(dep.status || 'unknown')
        : (args.bulk ? 'bulk payout inflow' : 'unprocessed notification');

      let section: Section;
      if (credited && dep && dep.status === 'approved') section = 'processed';
      else if (dep && ['failed', 'rejected', 'reversed'].includes(String(dep.status))) section = 'failed';
      else if (dep && String(dep.status) === 'pending') section = 'pending';
      else if (!dep && !userExists) section = 'unmatched';
      else if (!dep) section = 'pending';
      else section = 'pending';

      if (section !== 'processed' && section !== 'failed' && userExists && !walletExists) section = 'unmatched';
      if (!userExists && section === 'pending' && !dep) section = 'unmatched';

      const exceptions: string[] = [];
      if (dep?.rejection_reason) exceptions.push(String(dep.rejection_reason));
      if (dep && dep.status === 'approved' && !credited) exceptions.push('Approved but no wallet ledger credit found');
      if (!dep && !args.bulk) exceptions.push('No deposit record created for this inflow');
      if (!userExists) exceptions.push('Sender does not match a registered user');
      else if (!walletExists) exceptions.push('Matched user has no wallet');
      if (!args.senderPhone) exceptions.push('Sender phone number missing');
      if (!args.tid) exceptions.push('Transaction ID missing');
      if (!args.reference) exceptions.push('Payment reference missing');
      if (args.tid && (tidCounts.get(args.tid) || 0) > 1) exceptions.push('Duplicate transaction ID in window');
      if (!MERCHANT_CODES[args.channel || '']) exceptions.push('Merchant code not mapped');
      if (dep?.audit_flagged) exceptions.push('Flagged by audit');
      if (dep?.auto_credit_review_status && dep.auto_credit_review_status !== 'approved') {
        exceptions.push(`Auto-credit review: ${dep.auto_credit_review_status}`);
      }

      const reviewReasons = exceptions.filter((e) =>
        /Duplicate|missing|not mapped|no wallet|does not match|audit|review|no wallet ledger|No deposit record/i.test(e));

      const processor = dep
        ? (dep.auto_approved || args.autoMatchMethod
            ? `gmail-poll-transactions -> auto_create_deposits_from_gmail${args.autoMatchMethod ? ` (${args.autoMatchMethod})` : ''}`
            : 'approve-deposit')
        : '—';

      const processedAt = credited ? creditedAt.get(dep!.id)! : (dep?.approved_at || dep?.rejected_at || args.autoMatchedAt || null);

      return {
        receivedAt: eatStamp(args.receivedAt),
        senderName: (matchedProfile?.full_name || args.senderName || '—').slice(0, 40),
        senderPhone: args.senderPhone || '—',
        network: networkOf(args.channel),
        merchantCode: MERCHANT_CODES[args.channel || ''] || 'Unmapped',
        tid: args.tid || '—',
        amount: Number(args.amount) || 0,
        currency: 'UGX',
        reference: args.reference || '—',
        status,
        walletCredited: credited,
        userExists,
        walletExists,
        matched,
        processor,
        processedAt: eatStamp(processedAt),
        exception: exceptions.length ? exceptions.join('; ') : '—',
        section,
        reviewReasons,
      };
    };

    for (const g of gmailRows) {
      const p = parsedByGmail.get(g.id)!;
      const dep = g.linked_deposit_request_id ? knownDeposit.get(g.linked_deposit_request_id) ?? null : null;
      rows.push(buildRow({
        receivedAt: g.internal_date || g.created_at,
        senderName: p.senderName,
        senderPhone: p.senderPhone,
        channel: g.channel,
        tid: g.transaction_id,
        amount: g.amount,
        reference: p.reference,
        dep,
        sourceLabel: 'momo-feed',
        autoMatchMethod: g.auto_match_method,
        autoMatchedAt: g.auto_matched_at,
        bulk: !!g.is_bulk_bank_payout,
      }));
    }

    const gmailLinked = new Set(gmailRows.map((g) => g.linked_deposit_request_id).filter(Boolean));
    for (const d of depositRows) {
      if (gmailLinked.has(d.id)) continue; // already represented by its notification
      const owner = d.user_id ? profileById.get(d.user_id) : null;
      rows.push(buildRow({
        receivedAt: d.transaction_date || d.created_at,
        senderName: owner?.full_name ?? null,
        senderPhone: owner?.phone ?? null,
        channel: d.provider === 'mtn' ? 'mtn_momo' : d.provider === 'airtel' ? 'airtel_money' : d.provider,
        tid: d.transaction_id,
        amount: d.amount,
        reference: d.notes ? String(d.notes).slice(0, 24) : null,
        dep: d,
        sourceLabel: 'deposit-request',
      }));
    }

    rows.sort((a, b) => a.receivedAt.localeCompare(b.receivedAt));

    const bySection = (s: Section) => rows.filter((r) => r.section === s);
    const processed = bySection('processed');
    const pending = bySection('pending');
    const unmatched = bySection('unmatched');
    const failed = bySection('failed');
    const manual = rows.filter((r) => r.reviewReasons.length > 0);

    const sum = (list: Row[]) => list.reduce((s, r) => s + r.amount, 0);
    const summary = {
      totalCount: rows.length,
      totalAmount: sum(rows),
      processedCount: processed.length, processedAmount: sum(processed),
      pendingCount: pending.length, pendingAmount: sum(pending),
      failedCount: failed.length, failedAmount: sum(failed),
      unmatchedCount: unmatched.length, unmatchedAmount: sum(unmatched),
      manualCount: manual.length, manualAmount: sum(manual),
      awaitingAmount: sum(pending) + sum(unmatched) + sum(failed),
    };

    const periodLabel = `${slotLabel(new Date(start.getTime()))} -> ${slotLabel(end)}`;

    let logoBytes: Uint8Array | null = null;
    try {
      const lr = await fetch(LOGO_URL);
      if (lr.ok) logoBytes = new Uint8Array(await lr.arrayBuffer());
    } catch (_e) { /* wordmark fallback */ }

    const pdfBytes = await buildPdf({
      periodLabel,
      generatedAt: eatStamp(new Date().toISOString()) + ' EAT',
      summary,
      logoBytes,
      sections: [
        { title: '1. Successfully Processed Deposits', rows: processed },
        { title: '2. Pending Deposits', rows: pending },
        { title: '3. Unmatched Deposits', rows: unmatched },
        { title: '4. Failed Deposits', rows: failed },
        { title: '5. Manual Review Required', rows: manual },
      ],
    });

    const html = `
      <div style="font-family:-apple-system,Segoe UI,Arial,sans-serif;color:#111">
        <h2 style="margin:0 0 4px">Welile — Deposit Monitoring Report</h2>
        <p style="color:#666;margin:0 0 16px">Reporting period: ${periodLabel}</p>
        <table style="border-collapse:collapse">
          <tr><td style="padding:4px 12px;color:#666">Total deposits received</td><td style="padding:4px 12px"><b>${summary.totalCount}</b></td></tr>
          <tr><td style="padding:4px 12px;color:#666">Total amount received</td><td style="padding:4px 12px"><b>UGX ${fmtUgx(summary.totalAmount)}</b></td></tr>
          <tr><td style="padding:4px 12px;color:#666">Successfully processed</td><td style="padding:4px 12px">${summary.processedCount} · UGX ${fmtUgx(summary.processedAmount)}</td></tr>
          <tr><td style="padding:4px 12px;color:#666">Pending</td><td style="padding:4px 12px">${summary.pendingCount} · UGX ${fmtUgx(summary.pendingAmount)}</td></tr>
          <tr><td style="padding:4px 12px;color:#666">Failed</td><td style="padding:4px 12px">${summary.failedCount} · UGX ${fmtUgx(summary.failedAmount)}</td></tr>
          <tr><td style="padding:4px 12px;color:#666">Unmatched</td><td style="padding:4px 12px">${summary.unmatchedCount} · UGX ${fmtUgx(summary.unmatchedAmount)}</td></tr>
          <tr><td style="padding:4px 12px;color:#666">Manual review required</td><td style="padding:4px 12px">${summary.manualCount} · UGX ${fmtUgx(summary.manualAmount)}</td></tr>
          <tr><td style="padding:4px 12px;color:#666">Total value awaiting action</td><td style="padding:4px 12px"><b>UGX ${fmtUgx(summary.awaitingAmount)}</b></td></tr>
        </table>
        <p style="margin-top:16px;color:#666">Full deposit-by-deposit breakdown attached as PDF. This report is read-only; no deposit was modified.</p>
      </div>`;

    const filename = `welile-deposit-monitoring-${slotLabel(end).replace(/[ :]/g, '-')}.pdf`;

    // dry_run: return the PDF without emailing (used for QA / on-demand download)
    if (body?.dry_run === true) {
      return new Response(pdfBytes, {
        headers: { ...corsHeaders, 'Content-Type': 'application/pdf', 'Content-Disposition': `attachment; filename="${filename}"` },
      });
    }

    const form = new FormData();
    form.set('from', FROM);
    recipients.forEach((r) => form.append('to', r));
    form.set('subject', `Welile Deposit Monitoring Report – ${periodLabel}`);
    form.set('text', `Deposit monitoring report for ${periodLabel}.\nDeposits: ${summary.totalCount}\nTotal: UGX ${fmtUgx(summary.totalAmount)}\nAwaiting action: UGX ${fmtUgx(summary.awaitingAmount)}\nSee attached PDF.`);
    form.set('html', html);
    form.set('o:tag', 'deposit-monitoring');
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

    return new Response(JSON.stringify({ ok: true, period: periodLabel, recipients, summary }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  } catch (err) {
    console.error('deposit-monitoring-report failed', err);
    return new Response(JSON.stringify({ error: String((err as any)?.message ?? err) }), {
      status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});

// ---------------------------------- PDF ----------------------------------
interface PdfArgs {
  periodLabel: string;
  generatedAt: string;
  summary: Record<string, number>;
  logoBytes: Uint8Array | null;
  sections: { title: string; rows: Row[] }[];
}

async function buildPdf(a: PdfArgs): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  let logo: any = null;
  if (a.logoBytes) { try { logo = await doc.embedPng(a.logoBytes); } catch (_e) { logo = null; } }

  // A4 landscape
  const PAGE_W = 841.89, PAGE_H = 595.28;
  const margin = 28;
  const col = (r: number, g: number, b: number) => rgb(r / 255, g / 255, b / 255);
  const ink = col(17, 17, 17);
  const muted = col(110, 110, 120);
  const line = col(228, 228, 234);
  const brand = col(88, 28, 135);
  const white = col(255, 255, 255);

  const HEADER_H = 62;
  const FOOTER_H = 22;
  const ROW_H = 13;
  const SUB_H = 11;

  const headers = ['Received (EAT)', 'Sender', 'Phone', 'Net', 'Merchant', 'TID', 'Amount', 'Cur', 'Reference', 'Status', 'Credited'];
  const widths = [86, 116, 78, 34, 84, 92, 74, 28, 82, 78, 50];
  const colX: number[] = [];
  let acc = margin;
  for (const w of widths) { colX.push(acc); acc += w; }

  let page = doc.addPage([PAGE_W, PAGE_H]);
  let pageNum = 1;
  let y = PAGE_H;

  const truncate = (s: string, w: number, size: number, f: any) => {
    if (!s) return '';
    // WinAnsi-safe: drop characters the standard PDF font cannot encode.
    let out = String(s).replace(/[^\x20-\x7E\xA0-\xFF\u2013\u2014\u2018\u2019\u201C\u201D\u2022\u2026]/g, '?');
    while (out.length > 0 && f.widthOfTextAtSize(out, size) > w - 5) out = out.slice(0, -1);
    if (out.length < s.length && out.length > 1) out = out.slice(0, -1) + '…';
    return out;
  };

  const drawHeader = () => {
    page.drawRectangle({ x: 0, y: PAGE_H - HEADER_H, width: PAGE_W, height: HEADER_H, color: brand });
    let textX = margin;
    if (logo) {
      const h = 22, w = (logo.width / logo.height) * h;
      page.drawImage(logo, { x: margin, y: PAGE_H - 40, width: w, height: h });
      textX = margin + w + 12;
    } else {
      page.drawText('WELILE', { x: margin, y: PAGE_H - 34, size: 14, font: bold, color: white });
      textX = margin + 70;
    }
    page.drawText('Deposit Monitoring & Exception Report', { x: textX, y: PAGE_H - 30, size: 14, font: bold, color: white });
    page.drawText(`Reporting period: ${a.periodLabel}`, { x: textX, y: PAGE_H - 46, size: 8.5, font, color: col(226, 214, 245) });
    const g = `Generated ${a.generatedAt}`;
    page.drawText(g, { x: PAGE_W - margin - font.widthOfTextAtSize(g, 8.5), y: PAGE_H - 46, size: 8.5, font, color: col(226, 214, 245) });
  };

  const drawFooter = () => {
    const t = `Page ${pageNum}`;
    page.drawText(t, { x: PAGE_W - margin - font.widthOfTextAtSize(t, 8), y: 12, size: 8, font, color: muted });
    page.drawText('Welile — automated deposit monitoring • read-only • confidential', { x: margin, y: 12, size: 8, font, color: muted });
  };

  const newPage = () => {
    drawFooter();
    page = doc.addPage([PAGE_W, PAGE_H]);
    pageNum += 1;
    drawHeader();
    y = PAGE_H - HEADER_H - 14;
  };

  const ensure = (needed: number) => { if (y - needed < FOOTER_H + 6) newPage(); };

  const drawTableHeader = () => {
    page.drawRectangle({ x: margin, y: y - 17, width: PAGE_W - 2 * margin, height: 17, color: col(244, 241, 250) });
    headers.forEach((h, i) => page.drawText(h, { x: colX[i] + 3, y: y - 12, size: 7.5, font: bold, color: ink }));
    y -= 17;
  };

  // ---- cover / summary dashboard ----
  drawHeader();
  y = PAGE_H - HEADER_H - 24;
  page.drawText('Summary Dashboard', { x: margin, y, size: 13, font: bold, color: ink });
  y -= 18;

  const cards: [string, string, [number, number, number]][] = [
    ['Total deposits received', String(a.summary.totalCount), [88, 28, 135]],
    ['Total amount received', `UGX ${fmtUgx(a.summary.totalAmount)}`, [88, 28, 135]],
    ['Successfully processed', `${a.summary.processedCount} · UGX ${fmtUgx(a.summary.processedAmount)}`, [22, 128, 72]],
    ['Pending', `${a.summary.pendingCount} · UGX ${fmtUgx(a.summary.pendingAmount)}`, [180, 120, 12]],
    ['Failed', `${a.summary.failedCount} · UGX ${fmtUgx(a.summary.failedAmount)}`, [176, 42, 42]],
    ['Unmatched', `${a.summary.unmatchedCount} · UGX ${fmtUgx(a.summary.unmatchedAmount)}`, [176, 42, 42]],
    ['Manual review required', `${a.summary.manualCount} · UGX ${fmtUgx(a.summary.manualAmount)}`, [180, 120, 12]],
    ['Total value awaiting action', `UGX ${fmtUgx(a.summary.awaitingAmount)}`, [176, 42, 42]],
  ];
  const CARD_W = (PAGE_W - 2 * margin - 3 * 10) / 4;
  const CARD_H = 48;
  cards.forEach((c, i) => {
    const cx = margin + (i % 4) * (CARD_W + 10);
    const cy = y - Math.floor(i / 4) * (CARD_H + 10) - CARD_H;
    page.drawRectangle({ x: cx, y: cy, width: CARD_W, height: CARD_H, color: col(250, 249, 253), borderColor: line, borderWidth: 0.7 });
    page.drawRectangle({ x: cx, y: cy, width: 3, height: CARD_H, color: col(...c[2]) });
    page.drawText(truncate(c[0], CARD_W - 14, 8, font), { x: cx + 10, y: cy + CARD_H - 17, size: 8, font, color: muted });
    page.drawText(truncate(c[1], CARD_W - 14, 12, bold), { x: cx + 10, y: cy + 14, size: 12, font: bold, color: ink });
  });
  y -= 2 * (CARD_H + 10) + 10;

  page.drawText('This report is generated read-only. No deposit was created, modified or processed during generation.', {
    x: margin, y, size: 8, font, color: muted,
  });
  y -= 20;

  // ---- sections ----
  for (const section of a.sections) {
    ensure(70);
    page.drawRectangle({ x: margin, y: y - 20, width: PAGE_W - 2 * margin, height: 20, color: col(240, 237, 248) });
    page.drawText(section.title, { x: margin + 6, y: y - 14, size: 10, font: bold, color: brand });
    const secTotal = section.rows.reduce((s, r) => s + r.amount, 0);
    const rt = `${section.rows.length} deposits · UGX ${fmtUgx(secTotal)}`;
    page.drawText(rt, { x: PAGE_W - margin - font.widthOfTextAtSize(rt, 9) - 6, y: y - 14, size: 9, font: bold, color: ink });
    y -= 26;

    if (section.rows.length === 0) {
      page.drawText('None in this reporting period.', { x: margin + 4, y: y - 10, size: 8.5, font, color: muted });
      y -= 26;
      continue;
    }

    drawTableHeader();

    section.rows.forEach((r, i) => {
      if (y - (ROW_H + SUB_H) < FOOTER_H + 6) { newPage(); drawTableHeader(); }
      if (i % 2 === 1) {
        page.drawRectangle({ x: margin, y: y - (ROW_H + SUB_H), width: PAGE_W - 2 * margin, height: ROW_H + SUB_H, color: col(251, 251, 253) });
      }
      const cells = [
        r.receivedAt, r.senderName, r.senderPhone, r.network, r.merchantCode,
        r.tid, fmtUgx(r.amount), r.currency, r.reference, r.status, r.walletCredited ? 'Yes' : 'No',
      ];
      cells.forEach((c, ci) => {
        page.drawText(truncate(String(c), widths[ci], 7.5, ci === 6 ? bold : font), {
          x: colX[ci] + 3, y: y - 9.5, size: 7.5, font: ci === 6 ? bold : font,
          color: ci === 10 ? (r.walletCredited ? col(22, 128, 72) : col(176, 42, 42)) : ink,
        });
      });
      const detail = `User account: ${r.userExists ? 'Yes' : 'No'} · Wallet: ${r.walletExists ? 'Yes' : 'No'} · Matched to user: ${r.matched ? 'Yes' : 'No'} · Processor: ${r.processor} · Processed: ${r.processedAt} · Exception: ${r.exception}`;
      page.drawText(truncate(detail, PAGE_W - 2 * margin - 8, 6.8, font), {
        x: margin + 4, y: y - ROW_H - 7.5, size: 6.8, font, color: muted,
      });
      page.drawLine({ start: { x: margin, y: y - (ROW_H + SUB_H) }, end: { x: PAGE_W - margin, y: y - (ROW_H + SUB_H) }, thickness: 0.3, color: line });
      y -= ROW_H + SUB_H;
    });

    ensure(24);
    const tot = `Section total: ${section.rows.length} deposits · UGX ${fmtUgx(secTotal)}`;
    page.drawText(tot, { x: PAGE_W - margin - bold.widthOfTextAtSize(tot, 8.5), y: y - 13, size: 8.5, font: bold, color: ink });
    y -= 28;
  }

  drawFooter();
  return await doc.save();
}