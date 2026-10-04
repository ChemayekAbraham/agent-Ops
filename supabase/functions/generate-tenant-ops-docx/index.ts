// Welile — Tenant Operations Report (.docx)
//
// Architecture mirrors generate-daily-wallet-report: one edge function that
// (1) computes/collects data from existing sources, (2) builds the document,
// (3) uploads it to the finops-reports bucket, (4) optionally emails it, and
// (5) returns a signed download URL.
//
// Data sources (no new aggregation where one already exists):
//   Receivables       -> RPC public.get_agent_ops_receivables_report()  [untouched]
//   Active tenants    -> tenants_count from that same RPC
//   Registered tenants-> profiles x user_roles(role='tenant', enabled)
//   New tenants       -> profiles.created_at within EAT week / month
//   Payables          -> landlord_payouts in a not-yet-paid state
//                        (+ landlord_account_ledger annual payable, as context)
//
// POST body: { "recipients": ["a@b.com"], "email": true }

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.4';
import {
  Document, Packer, Paragraph, TextRun, Table, TableRow, TableCell,
  HeadingLevel, WidthType, AlignmentType, BorderStyle, ShadingType,
} from 'https://esm.sh/docx@8.5.0';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const FROM = 'Welile Reports <reports@welile.com>';
const DOCX_MIME =
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

const ugx = (n: unknown) =>
  `UGX ${Math.round(Number(n) || 0).toLocaleString('en-UG')}`;
const num = (n: unknown) => (Math.round(Number(n) || 0)).toLocaleString('en-UG');

// ---------- EAT helpers ----------
const EAT_MS = 3 * 60 * 60 * 1000;
const eatNow = () => new Date(Date.now() + EAT_MS);
const eatDateStr = () => eatNow().toISOString().slice(0, 10);
const eatNowLabel = () =>
  eatNow().toISOString().replace('T', ' ').slice(0, 16) + ' EAT';

/** Monday 00:00 EAT of the current EAT week, as a UTC ISO instant. */
function eatWeekStartIso(): { iso: string; label: string } {
  const d = eatNow();
  const dow = (d.getUTCDay() + 6) % 7; // Monday = 0
  const day = new Date(d.getTime() - dow * 24 * 60 * 60 * 1000)
    .toISOString().slice(0, 10);
  return { iso: new Date(`${day}T00:00:00.000+03:00`).toISOString(), label: day };
}

/** 1st of the current EAT month, 00:00 EAT, as a UTC ISO instant. */
function eatMonthStartIso(): { iso: string; label: string } {
  const day = eatDateStr().slice(0, 8) + '01';
  return { iso: new Date(`${day}T00:00:00.000+03:00`).toISOString(), label: day };
}

// ---------- doc building blocks ----------
const BRAND = '0F3D2E';
const MUTED = '5B6770';

const h1 = (text: string) =>
  new Paragraph({
    heading: HeadingLevel.HEADING_1,
    spacing: { before: 320, after: 160 },
    children: [new TextRun({ text, bold: true, size: 30, color: BRAND, font: 'Arial' })],
  });

const h2 = (text: string) =>
  new Paragraph({
    heading: HeadingLevel.HEADING_2,
    spacing: { before: 220, after: 120 },
    children: [new TextRun({ text, bold: true, size: 24, color: BRAND, font: 'Arial' })],
  });

const p = (text: string, opts: { italic?: boolean; bold?: boolean; color?: string; size?: number } = {}) =>
  new Paragraph({
    spacing: { after: 120 },
    children: [new TextRun({
      text,
      italics: opts.italic,
      bold: opts.bold,
      color: opts.color,
      size: opts.size ?? 22,
      font: 'Arial',
    })],
  });

const bullet = (text: string, level = 0) =>
  new Paragraph({
    numbering: { reference: 'bullets', level },
    spacing: { after: 80 },
    children: [new TextRun({ text, size: 22, font: 'Arial' })],
  });

const CELL_BORDER = { style: BorderStyle.SINGLE, size: 1, color: 'CCCCCC' };
const CELL_BORDERS = { top: CELL_BORDER, bottom: CELL_BORDER, left: CELL_BORDER, right: CELL_BORDER };
const CONTENT_W = 9360; // US Letter, 1" margins

function table(headers: string[], rows: string[][], widths: number[]) {
  const cell = (text: string, w: number, opts: { head?: boolean; right?: boolean } = {}) =>
    new TableCell({
      width: { size: w, type: WidthType.DXA },
      borders: CELL_BORDERS,
      margins: { top: 80, bottom: 80, left: 120, right: 120 },
      shading: opts.head ? { fill: 'EAF2EE', type: ShadingType.CLEAR } : undefined,
      children: [new Paragraph({
        alignment: opts.right ? AlignmentType.RIGHT : AlignmentType.LEFT,
        children: [new TextRun({ text, bold: opts.head, size: 20, font: 'Arial' })],
      })],
    });

  return new Table({
    width: { size: CONTENT_W, type: WidthType.DXA },
    columnWidths: widths,
    rows: [
      new TableRow({
        tableHeader: true,
        children: headers.map((hh, i) => cell(hh, widths[i], { head: true, right: i > 0 })),
      }),
      ...rows.map((r) => new TableRow({
        children: r.map((v, i) => cell(v, widths[i], { right: i > 0 })),
      })),
    ],
  });
}

interface Receivables {
  tenants_count?: number;
  active_plans_count?: number;
  tenants_receivable?: number;
  portfolio_billed?: number;
  portfolio_repaid?: number;
  daily_expected?: number;
  plans_funded?: number;
  plans_repaying?: number;
  plans_not_started?: number;
  plans_cleared?: number;
  bands?: { label: string; plans: number; outstanding: number }[];
}

interface Payables {
  source: string;
  by_status: { status: string; count: number; amount: number }[];
  total: number;
  annual_ledger_total: number;
  annual_ledger_rows: number;
}

interface Counts {
  registered_total: number;
  new_this_week: number;
  new_this_month: number;
  week_start: string;
  month_start: string;
}

const PAYABLE_STATUS_LABEL: Record<string, string> = {
  pending_merchant_payout: 'Pending merchant payout',
  awaiting_agent_receipt: 'Awaiting agent receipt confirmation',
  pending: 'Pending',
  queued: 'Queued',
  processing: 'Processing',
  approved: 'Approved, not yet paid',
};

function buildDoc(r: Receivables, c: Counts, pay: Payables) {
  const bands = (r.bands ?? []).map((b) => [
    b.label, num(b.plans), ugx(b.outstanding),
  ]);
  const generatedAt = eatNowLabel();

  const children: any[] = [
    // ---- Title block ----
    new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { before: 1200, after: 120 },
      children: [new TextRun({ text: 'Welile', bold: true, size: 56, color: BRAND, font: 'Arial' })],
    }),
    new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { after: 200 },
      children: [new TextRun({ text: 'Tenant Operations Report', size: 36, color: BRAND, font: 'Arial' })],
    }),
    new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { after: 80 },
      children: [new TextRun({ text: `Generated ${generatedAt}`, size: 22, color: MUTED, font: 'Arial' })],
    }),
    new Paragraph({
      alignment: AlignmentType.CENTER,
      spacing: { after: 1200 },
      children: [new TextRun({
        text: 'Confidential — prepared for Welile executive and Tenant Operations use only. Not for external distribution.',
        italics: true, size: 20, color: MUTED, font: 'Arial',
      })],
    }),
    new Paragraph({ pageBreakBefore: true, children: [] }),

    // ---- 1. Products & services ----
    h1('1. Tenant Products & Services'),
    p('This section is business copy, not computed data. It is reproduced from the platform README ("For Tenants") and MUST be reviewed and edited by the requester before this report is treated as final or shared outside Welile.',
      { italic: true, color: 'B45309' }),
    h2('Rent Financing (Rent Plan)'),
    bullet('Welile pays the landlord up front; the tenant repays daily over 7–120 days.'),
    bullet('Structured installments instead of a single lump-sum rent payment.'),
    h2('Trust Profiles'),
    bullet('Tenants build a verifiable Welile Trust Score from observed behaviour.'),
    bullet('A stronger score qualifies a tenant for larger Rent Plans and better terms.'),
    h2('Mobile Wallet'),
    bullet('Deposits, withdrawals and rent payments on MTN and Airtel Mobile Money.'),
    bullet('Every movement is double-entry accounted through the central ledger.'),
    p('[Review required] Confirm wording, product names and any terms above before circulation.',
      { italic: true, color: 'B45309' }),

    // ---- 2. Tenant counts ----
    h1('2. Tenant Counts'),
    p('Two distinct figures are reported. They answer different questions and are deliberately not combined.'),
    table(
      ['Measure', 'Count'],
      [
        ['Total registered tenants (all-time)', num(c.registered_total)],
        ['Tenants with a live Rent Plan (funded / repaying, tenancy not ended)', num(r.tenants_count)],
        ['Active Rent Plans', num(r.active_plans_count)],
      ],
      [6960, 2400],
    ),
    p(''),
    bullet('"Total registered tenants" = every profile holding an enabled tenant role, regardless of activity.'),
    bullet('"Live Rent Plan" comes from the receivables engine and is scoped to funded/repaying plans on active tenancies.'),

    // ---- 3. New tenants ----
    h1('3. New Tenants'),
    p(`Registration windows use the East Africa Time (EAT, UTC+3) calendar. Week runs Monday to today; month runs from the 1st to today.`),
    table(
      ['Window', 'From (EAT)', 'New tenants'],
      [
        ['This week', c.week_start, num(c.new_this_week)],
        ['This month', c.month_start, num(c.new_this_month)],
      ],
      [3360, 3000, 3000],
    ),

    // ---- 4. Receivables ----
    h1('4. Receivables'),
    p('Source: the existing Agent Ops receivables engine (get_agent_ops_receivables_report). Outstanding = total repayment billed minus amount repaid, floored at zero, across funded and repaying plans on active tenancies.'),
    table(
      ['Measure', 'Value'],
      [
        ['Total outstanding owed by tenants', ugx(r.tenants_receivable)],
        ['Total billed (portfolio)', ugx(r.portfolio_billed)],
        ['Total repaid (portfolio)', ugx(r.portfolio_repaid)],
        ['Expected daily collection', ugx(r.daily_expected)],
        ['Plans — funded', num(r.plans_funded)],
        ['Plans — repaying', num(r.plans_repaying)],
        ['Plans — no repayment yet', num(r.plans_not_started)],
        ['Plans — cleared (nil outstanding)', num(r.plans_cleared)],
      ],
      [6360, 3000],
    ),
    h2('Outstanding balance bands'),
    table(['Band', 'Plans', 'Outstanding'], bands, [4360, 2000, 3000]),

    // ---- 5. Payables ----
    h1('5. Payables'),
    p('Definition used in this report: amounts Welile currently owes landlords as a direct consequence of tenant rent already collected or committed but not yet disbursed. Operationally this is every landlord payout record that has not reached a completed/disbursed state.'),
    p(`Source used: ${pay.source}.`, { bold: true }),
    table(
      ['Payout state', 'Records', 'Amount'],
      [
        ...pay.by_status.map((s) => [
          PAYABLE_STATUS_LABEL[s.status] ?? s.status,
          num(s.count),
          ugx(s.amount),
        ]),
        ['Total outstanding payables', num(pay.by_status.reduce((a, s) => a + s.count, 0)), ugx(pay.total)],
      ],
      [4360, 2000, 3000],
    ),
    p(''),
    p(`Context (not part of the figure above): the admin-side landlord sub-ledger (landlord_account_ledger) records ${num(pay.annual_ledger_rows)} annualised landlord payable entries totalling ${ugx(pay.annual_ledger_total)}. That is a 12-month forward commitment view for landlord account statements — it is not cash currently due, and it never drives wallet balances or solvency, so it is reported separately rather than as the payables figure.`,
      { size: 20, color: MUTED }),
    p('Excluded from payables: payouts already completed/disbursed, and failed payouts (which require re-issue rather than settlement).',
      { size: 20, color: MUTED }),

    new Paragraph({
      spacing: { before: 400 },
      children: [new TextRun({
        text: `Confidential — Welile Tenant Operations Report · generated ${generatedAt} · figures are live at generation time.`,
        italics: true, size: 18, color: MUTED, font: 'Arial',
      })],
    }),
  ];

  return new Document({
    styles: { default: { document: { run: { font: 'Arial', size: 22 } } } },
    numbering: {
      config: [{
        reference: 'bullets',
        levels: [{
          level: 0, format: 'bullet', text: '\u2022', alignment: AlignmentType.LEFT,
          style: { paragraph: { indent: { left: 720, hanging: 360 } } },
        }],
      }],
    },
    sections: [{
      properties: {
        page: {
          size: { width: 12240, height: 15840 },
          margin: { top: 1440, right: 1440, bottom: 1440, left: 1440 },
        },
      },
      children,
    }],
  });
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders });

  try {
    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    );

    let body: any = {};
    try { body = await req.json(); } catch { /* no body */ }
    const recipients: string[] = Array.isArray(body?.recipients) ? body.recipients : [];
    const wantsEmail = body?.email === true && recipients.length > 0;

    console.log('stage: start');
    // 1) Receivables (existing RPC — untouched)
    const { data: rpcData, error: rpcErr } = await supabase.rpc('get_agent_ops_receivables_report');
    if (rpcErr) throw new Error(`get_agent_ops_receivables_report failed: ${rpcErr.message}`);
    const receivables = (rpcData ?? {}) as Receivables;

    console.log('stage: receivables ok');
    // 2) Registered tenants + new tenants (EAT windows)
    const week = eatWeekStartIso();
    const month = eatMonthStartIso();

    // Registered total: enabled tenant role rows (unique per user_id, role).
    const countRegisteredTenants = async () => {
      const { count, error } = await supabase
        .from('user_roles')
        .select('user_id', { count: 'exact', head: true })
        .eq('role', 'tenant')
        .eq('enabled', true);
      if (error) throw error;
      return count ?? 0;
    };

    // New tenants: profiles created in the window that hold an enabled tenant
    // role. Window sets are small, so we resolve them in id chunks rather than
    // joining (embedded-join counts time out on a 56k-row role table).
    const countNewTenants = async (sinceIso: string) => {
      const { data: rows, error } = await supabase
        .from('profiles')
        .select('id')
        .gte('created_at', sinceIso)
        .limit(20000);
      if (error) throw error;
      const ids = (rows ?? []).map((r: any) => r.id);
      let total = 0;
      for (let i = 0; i < ids.length; i += 200) {
        const { count, error: cErr } = await supabase
          .from('user_roles')
          .select('user_id', { count: 'exact', head: true })
          .eq('role', 'tenant')
          .eq('enabled', true)
          .in('user_id', ids.slice(i, i + 200));
        if (cErr) throw cErr;
        total += count ?? 0;
      }
      return total;
    };

    const registered_total = await countRegisteredTenants();
    const new_this_week = await countNewTenants(week.iso);
    const new_this_month = await countNewTenants(month.iso);

    const counts: Counts = {
      registered_total,
      new_this_week,
      new_this_month,
      week_start: week.label,
      month_start: month.label,
    };

    console.log('stage: counts ok', counts);
    // 3) Payables — landlord_payouts not yet settled
    const SETTLED = ['completed', 'disbursed', 'failed', 'cancelled', 'rejected'];
    const { data: payoutRows, error: payErr } = await supabase
      .from('landlord_payouts')
      .select('status, amount')
      .not('status', 'in', `(${SETTLED.join(',')})`);
    if (payErr) throw payErr;

    const byStatusMap = new Map<string, { status: string; count: number; amount: number }>();
    for (const row of (payoutRows ?? []) as any[]) {
      const key = String(row.status ?? 'unknown');
      const cur = byStatusMap.get(key) ?? { status: key, count: 0, amount: 0 };
      cur.count += 1;
      cur.amount += Number(row.amount) || 0;
      byStatusMap.set(key, cur);
    }
    const by_status = Array.from(byStatusMap.values()).sort((a, b) => b.amount - a.amount);

    const { data: lalRows, error: lalErr } = await supabase
      .from('landlord_account_ledger')
      .select('amount')
      .eq('entry_type', 'payable');
    if (lalErr) throw lalErr;

    const payables: Payables = {
      source: 'landlord_payouts (records not yet completed/disbursed)',
      by_status,
      total: by_status.reduce((a, s) => a + s.amount, 0),
      annual_ledger_total: (lalRows ?? []).reduce((a: number, r: any) => a + (Number(r.amount) || 0), 0),
      annual_ledger_rows: (lalRows ?? []).length,
    };

    console.log('stage: payables ok', payables.total);
    // 4) Build the .docx
    const doc = buildDoc(receivables, counts, payables);
    const blob = await Packer.toBlob(doc);
    const bytes = new Uint8Array(await blob.arrayBuffer());

    console.log('stage: docx built', bytes.length);
    // 5) Upload + signed URL
    const dateStr = eatDateStr();
    const stamp = eatNow().toISOString().slice(11, 16).replace(':', '');
    const path = `tenant-ops/${dateStr}/welile-tenant-operations-report-${dateStr}-${stamp}.docx`;
    const up = await supabase.storage.from('finops-reports').upload(path, bytes, {
      contentType: DOCX_MIME, upsert: true,
    });
    if (up.error) throw up.error;

    const { data: signed, error: signErr } = await supabase.storage
      .from('finops-reports')
      .createSignedUrl(path, 60 * 60 * 24 * 7);
    if (signErr) throw signErr;

    // 6) Optional email
    let emailError: string | null = null;
    if (wantsEmail) {
      const key = Deno.env.get('MAILGUN_API_KEY');
      const domain = Deno.env.get('MAILGUN_DOMAIN');
      const base = Deno.env.get('MAILGUN_BASE_URL') || 'https://api.mailgun.net';
      if (!key || !domain) {
        emailError = 'Mailgun is not configured';
      } else {
        const form = new FormData();
        form.set('from', FROM);
        recipients.forEach((r) => form.append('to', r));
        form.set('subject', `Welile Tenant Operations Report — ${dateStr}`);
        form.set('text', [
          `Welile Tenant Operations Report — generated ${eatNowLabel()}.`,
          '',
          `Registered tenants: ${num(counts.registered_total)}`,
          `Tenants with a live Rent Plan: ${num(receivables.tenants_count)}`,
          `New tenants this week: ${num(counts.new_this_week)} · this month: ${num(counts.new_this_month)}`,
          `Tenant receivable outstanding: ${ugx(receivables.tenants_receivable)}`,
          `Landlord payables outstanding: ${ugx(payables.total)}`,
          '',
          'The Word document is attached. Section 1 (Products & Services) needs review before external use.',
          'Confidential — prepared for Welile executive and Tenant Operations use only.',
        ].join('\n'));
        form.set('o:tag', 'tenant-ops-report');
        form.append('attachment', new Blob([bytes], { type: DOCX_MIME }), path.split('/').pop()!);
        const res = await fetch(`${base}/v3/${domain}/messages`, {
          method: 'POST',
          headers: { Authorization: 'Basic ' + btoa(`api:${key}`) },
          body: form,
        });
        if (!res.ok) emailError = `[${res.status}] ${await res.text()}`;
      }
    }

    return new Response(JSON.stringify({
      ok: true,
      path,
      download_url: signed?.signedUrl,
      filename: path.split('/').pop(),
      generated_at: eatNowLabel(),
      summary: {
        registered_tenants: counts.registered_total,
        active_plan_tenants: Number(receivables.tenants_count) || 0,
        new_this_week: counts.new_this_week,
        new_this_month: counts.new_this_month,
        tenants_receivable: Number(receivables.tenants_receivable) || 0,
        payables_total: payables.total,
        payables_source: payables.source,
      },
      emailed: wantsEmail && !emailError,
      emailError,
    }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  } catch (e) {
    const detail = (e as any)?.message || (e as any)?.error_description ||
      (() => { try { return JSON.stringify(e); } catch { return String(e); } })();
    console.error('generate-tenant-ops-docx failed', detail, (e as any)?.stack);
    return new Response(JSON.stringify({ ok: false, error: detail }), {
      status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
