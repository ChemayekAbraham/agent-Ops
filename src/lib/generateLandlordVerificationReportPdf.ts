import jsPDF from 'jspdf';
import { format } from 'date-fns';
import type { LandlordReportRow } from '@/hooks/useLandlordOps';

/**
 * Comprehensive, audit-grade PDF report for a Landlord Ops LANDLORD filter
 * (pending / verified / rejected / resubmitted / has_tenants / no_tenants / all).
 *
 * Deliberately mirrors `generateHouseVerificationReportPdf` so the Landlords tab
 * reads exactly like the Houses verification queue report.
 *
 * Data source: the `ops_landlord_report` RPC via the `landlord-ops` edge
 * function — one row per landlord with the full verification trail.
 *
 * Date semantics: every date range in Landlord Ops is applied to the row's
 * STATE date: registration date for pending, decision date for
 * verified / rejected / resubmitted.
 */

export type LandlordReportScope =
  | 'all' | 'verified' | 'pending' | 'rejected' | 'resubmitted' | 'has_tenants' | 'no_tenants';

type SectionScope = 'verified' | 'rejected' | 'resubmitted' | 'pending';

const SECTION_ORDER: SectionScope[] = ['verified', 'rejected', 'resubmitted', 'pending'];

const SECTION_TITLE: Record<SectionScope, string> = {
  pending: 'Pending verification',
  verified: 'Verified landlords',
  rejected: 'Rejected landlords',
  resubmitted: 'Resubmitted landlords',
};

const SECTION_BASIS: Record<SectionScope, string> = {
  pending: 'Dates below are the registration date (the landlord has no decision yet).',
  verified: 'Dates below are the verification date recorded against each landlord.',
  rejected: 'Dates below are the rejection date recorded against each landlord.',
  resubmitted: 'Dates below are the date the landlord was resubmitted for review.',
};

const SCOPE_TITLE: Record<LandlordReportScope, string> = {
  all: 'All Landlords',
  verified: 'Verified Landlords',
  pending: 'Pending Verification',
  rejected: 'Rejected Landlords',
  resubmitted: 'Resubmitted Landlords',
  has_tenants: 'Landlords With Tenants',
  no_tenants: 'Landlords Without Tenants',
};

const SCOPE_DATE_BASIS: Record<LandlordReportScope, string> = {
  all: 'date the landlord entered its current state (registered / verified / rejected)',
  verified: 'date the landlord was verified by a reviewer',
  pending: 'date the landlord was registered',
  rejected: 'date the landlord was rejected',
  resubmitted: 'date the landlord was resubmitted for review',
  has_tenants: 'date the landlord entered its current state',
  no_tenants: 'date the landlord entered its current state',
};

const SECTION_ACCENT: Record<SectionScope, [number, number, number]> = {
  pending: [217, 119, 6],
  verified: [16, 163, 74],
  rejected: [220, 38, 38],
  resubmitted: [37, 99, 235],
};

const SCOPE_ACCENT: Record<LandlordReportScope, [number, number, number]> = {
  pending: SECTION_ACCENT.pending,
  verified: SECTION_ACCENT.verified,
  rejected: SECTION_ACCENT.rejected,
  resubmitted: SECTION_ACCENT.resubmitted,
  all: [146, 52, 234],
  has_tenants: [2, 132, 199],
  no_tenants: [234, 88, 12],
};

/** Multi-state scopes render one full section per state, like the "all" house report. */
const MULTI_STATE: LandlordReportScope[] = ['all', 'has_tenants', 'no_tenants'];

const rowSection = (r: LandlordReportRow): SectionScope => {
  const s = (r.status || 'pending') as SectionScope;
  return SECTION_ORDER.includes(s) ? s : 'pending';
};

const sourceLabel = (s: string | null | undefined) => {
  const v = (s || '').trim();
  if (!v || v === 'unspecified') return 'Unspecified';
  if (v === 'pipeline_auto') return 'Auto (rent pipeline)';
  return v.replace(/_/g, ' ');
};

export interface LandlordReportMeta {
  scope: LandlordReportScope;
  quickFilter?: string;
  search?: string | null;
  dateFrom?: string | null;
  dateTo?: string | null;
  /** True DB match count — may exceed rows.length when the export is capped. */
  totalMatches?: number;
  generatedBy?: string | null;
}

export function generateLandlordVerificationReportPdf(
  rows: LandlordReportRow[],
  meta: LandlordReportMeta,
): Blob {
  const doc = new jsPDF({ orientation: 'landscape', unit: 'mm', format: 'a4' });
  const pageWidth = doc.internal.pageSize.getWidth();
  const pageHeight = doc.internal.pageSize.getHeight();
  const margin = 10;
  const contentWidth = pageWidth - margin * 2;
  const accent = SCOPE_ACCENT[meta.scope];
  let y = 14;

  const ugx = (n: number | null | undefined) => `UGX ${Math.round(Number(n || 0)).toLocaleString()}`;
  const num = (n: number | null | undefined) => Math.round(Number(n || 0)).toLocaleString();
  const dt = (d: string | null | undefined, withTime = false) => {
    if (!d) return '—';
    try { return format(new Date(d), withTime ? 'dd MMM yyyy HH:mm' : 'dd MMM yyyy'); } catch { return '—'; }
  };
  const txt = (s: string | null | undefined, fallback = '—') => {
    const v = (s ?? '').toString().trim();
    return v.length ? v : fallback;
  };
  const clip = (s: string, max: number) => (s.length > max ? `${s.slice(0, max - 1)}…` : s);

  const bottomLimit = pageHeight - 12;
  const newPage = () => { doc.addPage(); y = 14; };
  const ensure = (needed: number, onNewPage?: () => void) => {
    if (y + needed > bottomLimit) { newPage(); onNewPage?.(); }
  };

  // ─── Header ───
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(10);
  doc.setTextColor(20, 40, 120);
  doc.text('WELILE', margin, y);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(8);
  doc.setTextColor(110, 110, 120);
  doc.text(format(new Date(), 'dd MMM yyyy, hh:mm a'), pageWidth - margin, y, { align: 'right' });

  y += 8;
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(19);
  doc.setTextColor(15, 23, 42);
  doc.text(`Landlord Operations — ${SCOPE_TITLE[meta.scope]}`, margin, y);

  y += 5;
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(8);
  doc.setTextColor(110, 110, 120);
  doc.text(`Dates in this report use the ${SCOPE_DATE_BASIS[meta.scope]}.`, margin, y);

  y += 4.2;
  const filterBits: string[] = [
    `Period: ${meta.dateFrom ? dt(meta.dateFrom) : 'All time'} → ${meta.dateTo ? dt(meta.dateTo) : 'Today'}`,
  ];
  if (meta.search) filterBits.push(`Search: "${meta.search}"`);
  if (meta.quickFilter && meta.quickFilter !== 'all') filterBits.push(`Quick filter: ${meta.quickFilter.replace(/_/g, ' ')}`);
  if (meta.generatedBy) filterBits.push(`Prepared by: ${meta.generatedBy}`);
  doc.setFont('helvetica', 'italic');
  doc.text(filterBits.join('   •   '), margin, y);

  if (typeof meta.totalMatches === 'number' && meta.totalMatches > rows.length) {
    y += 4.2;
    doc.setFont('helvetica', 'bold');
    doc.setTextColor(220, 38, 38);
    doc.text(
      `Note: ${meta.totalMatches.toLocaleString()} landlords match these filters; this export lists the ${rows.length.toLocaleString()} most recent. Narrow the date range for a complete set.`,
      margin, y,
    );
    doc.setTextColor(110, 110, 120);
  }

  y += 4;
  doc.setDrawColor(225, 227, 232);
  doc.setLineWidth(0.3);
  doc.line(margin, y, pageWidth - margin, y);
  y += 6;

  // ─── Reusable section builders ───────────────────────────────────────────
  const sectionHeading = (label: string, size = 10) => {
    ensure(16);
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(size);
    doc.setTextColor(15, 23, 42);
    doc.text(label, margin, y);
    y += 4;
  };

  const drawSectionBanner = (sec: SectionScope, sectionRows: LandlordReportRow[]) => {
    ensure(30);
    const bandH = 9;
    doc.setFillColor(...SECTION_ACCENT[sec]);
    (doc as any).roundedRect(margin, y, contentWidth, bandH, 1.5, 1.5, 'F');
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(10);
    doc.setTextColor(255, 255, 255);
    doc.text(SECTION_TITLE[sec].toUpperCase(), margin + 3, y + 6.2);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(8);
    doc.text(
      `${num(sectionRows.length)} of ${num(rows.length)} landlords in this export`,
      pageWidth - margin - 3, y + 6.2, { align: 'right' },
    );
    y += bandH + 3.5;
    doc.setFont('helvetica', 'italic');
    doc.setFontSize(7.5);
    doc.setTextColor(110, 110, 120);
    doc.text(SECTION_BASIS[sec], margin, y);
    y += 5;
  };

  const drawKpiCards = (sectionRows: LandlordReportRow[]) => {
    const totalRent = sectionRows.reduce((s, r) => s + Number(r.monthly_rent || 0), 0);
    const withTenants = sectionRows.filter(r => !!r.has_tenant).length;
    const tenants = sectionRows.reduce((s, r) => s + Number(r.tenant_count || 0), 0);
    const withPhone = sectionRows.filter(r => txt(r.phone, '').replace(/\D/g, '').length >= 9).length;
    const withPayout = sectionRows.filter(
      r => txt(r.mobile_money_number, '') !== '' || txt(r.account_number, '') !== '',
    ).length;
    const smartphones = sectionRows.filter(r => r.has_smartphone === true).length;
    const districts = new Set(sectionRows.map(r => txt(r.district, '')).filter(Boolean)).size;
    const agents = new Set(sectionRows.map(r => txt(r.agent_name, '')).filter(Boolean)).size;

    const cards: { label: string; value: string }[] = [
      { label: 'LANDLORDS', value: num(sectionRows.length) },
      { label: 'WITH TENANTS', value: `${num(withTenants)} / ${num(sectionRows.length)}` },
      { label: 'TENANTS LINKED', value: num(tenants) },
      { label: 'MONTHLY RENT', value: ugx(totalRent) },
      { label: 'WITH PHONE', value: `${num(withPhone)} / ${num(sectionRows.length)}` },
      { label: 'PAYOUT ON FILE', value: `${num(withPayout)} / ${num(sectionRows.length)}` },
      { label: 'SMARTPHONES', value: num(smartphones) },
      { label: 'DISTRICTS / AGENTS', value: `${num(districts)} / ${num(agents)}` },
    ];

    ensure(22);
    const cardGap = 2.5;
    const cardW = (contentWidth - cardGap * (cards.length - 1)) / cards.length;
    const cardH = 16;
    cards.forEach((c, i) => {
      const x = margin + i * (cardW + cardGap);
      doc.setFillColor(248, 249, 252);
      doc.setDrawColor(225, 227, 232);
      doc.setLineWidth(0.2);
      (doc as any).roundedRect(x, y, cardW, cardH, 2, 2, 'FD');
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(6);
      doc.setTextColor(120, 122, 135);
      doc.text(c.label, x + 3, y + 5.5);
      doc.setFontSize(9.5);
      doc.setTextColor(15, 23, 42);
      doc.text(clip(c.value, 18), x + 3, y + 12);
    });
    y += cardH + 6;
  };

  const drawDistrictBreakdown = (
    sectionRows: LandlordReportRow[],
    sectionAccent: [number, number, number],
    limit: number,
    heading: string,
  ) => {
    const byDistrict = new Map<string, { landlords: number; rent: number; tenants: number; withTenants: number }>();
    sectionRows.forEach(r => {
      const key = txt(r.district, 'Unknown district');
      const cur = byDistrict.get(key) || { landlords: 0, rent: 0, tenants: 0, withTenants: 0 };
      cur.landlords += 1;
      cur.rent += Number(r.monthly_rent || 0);
      cur.tenants += Number(r.tenant_count || 0);
      if (r.has_tenant) cur.withTenants += 1;
      byDistrict.set(key, cur);
    });
    const districtRows = Array.from(byDistrict.entries()).sort((a, b) => b[1].landlords - a[1].landlords);
    if (!districtRows.length) return;

    ensure(20);
    sectionHeading(heading);

    const dCols = [
      { label: 'District', w: 60, align: 'left' as const },
      { label: 'Landlords', w: 24, align: 'right' as const },
      { label: 'With tenants', w: 26, align: 'right' as const },
      { label: 'Tenants', w: 22, align: 'right' as const },
      { label: 'Monthly rent (UGX)', w: 40, align: 'right' as const },
    ];
    const dWidth = dCols.reduce((s, c) => s + c.w, 0);
    const dHead = () => {
      doc.setFillColor(...sectionAccent);
      doc.rect(margin, y, dWidth, 6, 'F');
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(7.5);
      doc.setTextColor(255, 255, 255);
      let x = margin;
      dCols.forEach(c => {
        doc.text(c.label, c.align === 'right' ? x + c.w - 1.5 : x + 1.5, y + 4, { align: c.align });
        x += c.w;
      });
      y += 6;
    };
    dHead();
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(7.5);
    districtRows.slice(0, limit).forEach(([name, v], i) => {
      ensure(6, dHead);
      if (i % 2 === 1) {
        doc.setFillColor(248, 249, 252);
        doc.rect(margin, y, dWidth, 5.2, 'F');
      }
      doc.setTextColor(30, 35, 50);
      let x = margin;
      const vals = [clip(name, 32), num(v.landlords), num(v.withTenants), num(v.tenants), num(v.rent)];
      dCols.forEach((c, ci) => {
        doc.text(vals[ci], c.align === 'right' ? x + c.w - 1.5 : x + 1.5, y + 3.7, { align: c.align });
        x += c.w;
      });
      y += 5.2;
    });
    if (districtRows.length > limit) {
      doc.setFont('helvetica', 'italic');
      doc.setTextColor(120, 122, 135);
      doc.text(`+ ${districtRows.length - limit} more districts (see detail below)`, margin, y + 3.5);
      y += 6;
    }
    y += 5;
  };

  type Col = { label: string; w: number; align?: 'left' | 'right'; get: (r: LandlordReportRow, i: number) => string };

  const baseCols: Col[] = [
    { label: '#', w: 8, get: (_r, i) => `${i + 1}` },
    { label: 'Landlord', w: 40, get: r => clip(txt(r.name), 26) },
    { label: 'Phone', w: 24, get: r => clip(txt(r.phone), 15) },
    { label: 'Location (village / district)', w: 46, get: r => clip(`${txt(r.village, '?')} / ${txt(r.district, '?')}`, 30) },
    { label: 'Rent', w: 20, align: 'right', get: r => num(r.monthly_rent) },
    { label: 'Tenants', w: 16, align: 'right', get: r => num(r.tenant_count) },
    { label: 'Agent', w: 32, get: r => clip(txt(r.agent_name), 21) },
    { label: 'Payout', w: 26, get: r => (txt(r.mobile_money_number, '') !== '' ? 'MoMo' : txt(r.account_number, '') !== '' ? 'Bank' : 'None') },
  ];

  const stateCols = (sec: SectionScope): Col[] =>
    sec === 'verified'
      ? [
          { label: 'Verified by', w: 30, get: r => clip(txt(r.verified_by_name, 'System / pipeline'), 20) },
          { label: 'Verified on', w: 26, get: r => dt(r.verification_updated_at, true) },
          { label: 'Source', w: 28, get: r => clip(sourceLabel(r.source), 18) },
        ]
      : sec === 'rejected'
        ? [
            { label: 'Rejected on', w: 26, get: r => dt(r.verification_updated_at, true) },
            { label: 'Reason', w: 58, get: r => clip(txt(r.verification_reason, 'No reason recorded'), 46) },
          ]
        : sec === 'resubmitted'
          ? [
              { label: 'Resubmitted on', w: 28, get: r => dt(r.verification_updated_at, true) },
              { label: 'Registered', w: 24, get: r => dt(r.created_at) },
              { label: 'Last note', w: 42, get: r => clip(txt(r.verification_reason, '—'), 34) },
            ]
          : [
              { label: 'Registered', w: 24, get: r => dt(r.created_at) },
              {
                label: 'Waiting',
                w: 18,
                align: 'right',
                get: r => {
                  if (!r.created_at) return '—';
                  const days = Math.max(0, Math.floor((Date.now() - new Date(r.created_at).getTime()) / 86400000));
                  return `${days}d`;
                },
              },
              { label: 'Address', w: 34, get: r => clip(txt(r.property_address), 24) },
              { label: 'Phone OK', w: 18, get: r => (txt(r.phone, '').replace(/\D/g, '').length >= 9 ? 'Yes' : 'No') },
            ];

  const drawDetailTable = (
    sectionRows: LandlordReportRow[],
    cols: Col[],
    sectionAccent: [number, number, number],
    heading: string,
  ) => {
    ensure(24);
    sectionHeading(heading);

    if (!sectionRows.length) {
      doc.setFont('helvetica', 'italic');
      doc.setFontSize(7.5);
      doc.setTextColor(120, 122, 135);
      doc.text('No landlords in this state for the selected filters.', margin, y + 2);
      y += 7;
      return;
    }

    const tableW = cols.reduce((s, c) => s + c.w, 0);
    const drawHead = () => {
      doc.setFillColor(...sectionAccent);
      doc.rect(margin, y, tableW, 6.5, 'F');
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(7);
      doc.setTextColor(255, 255, 255);
      let x = margin;
      cols.forEach(c => {
        doc.text(c.label, c.align === 'right' ? x + c.w - 1.5 : x + 1.5, y + 4.3, { align: c.align || 'left' });
        x += c.w;
      });
      y += 6.5;
    };
    drawHead();

    doc.setFont('helvetica', 'normal');
    doc.setFontSize(7);
    const rowH = 5.2;

    sectionRows.forEach((r, i) => {
      ensure(rowH + 1, () => { drawHead(); doc.setFont('helvetica', 'normal'); doc.setFontSize(7); });
      if (i % 2 === 1) {
        doc.setFillColor(248, 249, 252);
        doc.rect(margin, y, tableW, rowH, 'F');
      }
      doc.setDrawColor(234, 236, 242);
      doc.setLineWidth(0.12);
      doc.line(margin, y + rowH, margin + tableW, y + rowH);
      let x = margin;
      cols.forEach(c => {
        doc.setTextColor(30, 35, 50);
        doc.text(c.get(r, i), c.align === 'right' ? x + c.w - 1.5 : x + 1.5, y + 3.7, { align: c.align || 'left' });
        x += c.w;
      });
      y += rowH;
    });
  };

  /** Full, untruncated rejection reasons. */
  const drawRejectionAppendix = (sectionRows: LandlordReportRow[], heading: string) => {
    const withReason = sectionRows.filter(r => txt(r.verification_reason, '') !== '');
    if (!withReason.length) return;
    y += 6;
    ensure(16);
    sectionHeading(heading);
    y += 1;
    doc.setFontSize(7.5);
    withReason.forEach((r, i) => {
      const head = `${i + 1}. ${txt(r.name)} (${txt(r.phone)}) — ${txt(r.village, '?')}, ${txt(r.district, '?')} — rejected on ${dt(r.verification_updated_at, true)}`;
      const lines = doc.splitTextToSize(txt(r.verification_reason), contentWidth - 4) as string[];
      ensure(4 + lines.length * 3.4 + 2);
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(7.5);
      doc.setTextColor(15, 23, 42);
      doc.text(clip(head, 175), margin, y);
      y += 3.6;
      doc.setFont('helvetica', 'normal');
      doc.setTextColor(80, 85, 100);
      lines.forEach(ln => { doc.text(ln, margin + 3, y); y += 3.4; });
      y += 1.6;
    });
  };

  /**
   * The existing review comment recorded against a landlord: the decision
   * reason captured by the verification write path, otherwise the existing
   * service-centre verification comment. Returns null when no comment exists.
   */
  const reviewCommentOf = (r: LandlordReportRow): { text: string; label: string } | null => {
    if (txt(r.verification_reason, '') !== '') {
      return {
        text: txt(r.verification_reason),
        label: r.status === 'rejected' ? 'Rejection reason' : r.status === 'verified' ? 'Verification note' : 'Review note',
      };
    }
    if (txt(r.service_center_comment, '') !== '') {
      return { text: txt(r.service_center_comment), label: 'Service centre comment' };
    }
    return null;
  };

  /**
   * Review comments recorded against each landlord in this section, verbatim.
   * Landlords with no recorded comment are omitted (no placeholders).
   */
  const drawReviewCommentsAppendix = (sectionRows: LandlordReportRow[], heading: string) => {
    const withComment = sectionRows
      .map(r => ({ r, c: reviewCommentOf(r) }))
      .filter((x): x is { r: LandlordReportRow; c: { text: string; label: string } } => x.c !== null);
    if (!withComment.length) return;
    y += 6;
    ensure(16);
    sectionHeading(heading);
    y += 1;
    doc.setFontSize(7.5);
    withComment.forEach(({ r, c }, i) => {
      const who = txt(r.verified_by_name, '') !== '' ? ` by ${txt(r.verified_by_name)}` : '';
      const when = r.verification_updated_at ? ` on ${dt(r.verification_updated_at, true)}` : '';
      const head = `${i + 1}. ${txt(r.name)} (${txt(r.phone)}) — ${txt(r.village, '?')}, ${txt(r.district, '?')} — ${c.label}${who}${when}`;
      const lines = doc.splitTextToSize(c.text, contentWidth - 4) as string[];
      ensure(4 + lines.length * 3.4 + 2);
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(7.5);
      doc.setTextColor(15, 23, 42);
      doc.text(clip(head, 175), margin, y);
      y += 3.6;
      doc.setFont('helvetica', 'normal');
      doc.setTextColor(80, 85, 100);
      lines.forEach(ln => { doc.text(ln, margin + 3, y); y += 3.4; });
      y += 1.6;
    });
  };

  /** Payout readiness for the supplied rows. */
  const drawPayoutAppendix = (sectionRows: LandlordReportRow[], heading: string) => {
    const missingPayout = sectionRows.filter(
      r => txt(r.mobile_money_number, '') === '' && txt(r.account_number, '') === '',
    );
    y += 6;
    ensure(16);
    sectionHeading(heading);
    y += 1;
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(7.5);
    doc.setTextColor(80, 85, 100);
    if (!missingPayout.length) {
      doc.text('Every landlord in this section has at least one payout destination on file (mobile money or bank).', margin, y);
      y += 4;
      return;
    }
    doc.text(
      `${missingPayout.length} landlord${missingPayout.length === 1 ? '' : 's'} in this section have NO payout destination on file:`,
      margin, y,
    );
    y += 4;
    missingPayout.slice(0, 60).forEach((r, i) => {
      ensure(4);
      doc.text(
        `${i + 1}. ${txt(r.name)} (${txt(r.phone)}) — ${txt(r.village, '?')}, ${txt(r.district, '?')} — ${num(r.tenant_count)} tenant(s)`,
        margin + 3, y,
      );
      y += 3.6;
    });
    if (missingPayout.length > 60) {
      doc.setFont('helvetica', 'italic');
      doc.setTextColor(120, 122, 135);
      doc.text(`+ ${missingPayout.length - 60} more landlords without a payout destination.`, margin + 3, y);
      y += 4;
    }
  };

  /** Verified attribution: reviewer decisions vs automatic pipeline flips. */
  const drawAttribution = (sectionRows: LandlordReportRow[]) => {
    const auto = sectionRows.filter(r => (r.source || '') === 'pipeline_auto').length;
    const human = sectionRows.length - auto;
    y += 4;
    ensure(12);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(7.5);
    doc.setTextColor(80, 85, 100);
    doc.text(
      `Verification attribution: ${num(human)} verified by a reviewer · ${num(auto)} auto-verified by rent pipeline approval.`,
      margin, y,
    );
    y += 4;
  };

  const drawStateSection = (sec: SectionScope, sectionRows: LandlordReportRow[]) => {
    const sectionAccent = SECTION_ACCENT[sec];
    drawSectionBanner(sec, sectionRows);
    drawKpiCards(sectionRows);
    drawDistrictBreakdown(sectionRows, sectionAccent, 20, `${SECTION_TITLE[sec]} — breakdown by district`);
    drawDetailTable(sectionRows, [...baseCols, ...stateCols(sec)], sectionAccent, `${SECTION_TITLE[sec]} — landlord-by-landlord detail`);
    if (sec === 'rejected') drawRejectionAppendix(sectionRows, 'Rejected landlords — full rejection reasons');
    if (sec !== 'rejected') drawReviewCommentsAppendix(sectionRows, `${SECTION_TITLE[sec]} — review comments`);
    if (sec === 'verified') { drawAttribution(sectionRows); drawPayoutAppendix(sectionRows, 'Verified landlords — payout readiness'); }
    y += 8;
  };

  // ─── Body ───────────────────────────────────────────────────────────────
  if (MULTI_STATE.includes(meta.scope)) {
    const grouped: Record<SectionScope, LandlordReportRow[]> =
      { verified: [], rejected: [], resubmitted: [], pending: [] };
    rows.forEach(r => { grouped[rowSection(r)].push(r); });

    drawKpiCards(rows);

    sectionHeading('Composition by state');
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(7.5);
    const mixW = contentWidth / 4 - 3.5;
    SECTION_ORDER.forEach((sec, i) => {
      const x = margin + i * (mixW + 4.5);
      const list = grouped[sec];
      const share = rows.length ? Math.round((list.length / rows.length) * 100) : 0;
      doc.setFillColor(248, 249, 252);
      doc.setDrawColor(...SECTION_ACCENT[sec]);
      doc.setLineWidth(0.5);
      (doc as any).roundedRect(x, y, mixW, 14, 2, 2, 'FD');
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(7);
      doc.setTextColor(...SECTION_ACCENT[sec]);
      doc.text(SECTION_TITLE[sec].toUpperCase(), x + 3, y + 5);
      doc.setFontSize(9);
      doc.setTextColor(15, 23, 42);
      doc.text(`${num(list.length)} (${share}%)`, x + 3, y + 11);
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(7);
      doc.setTextColor(110, 110, 120);
      doc.text(
        ugx(list.reduce((s, r) => s + Number(r.monthly_rent || 0), 0)),
        x + mixW - 3, y + 11, { align: 'right' },
      );
    });
    y += 20;

    drawDistrictBreakdown(rows, accent, 40, 'Portfolio breakdown by district');

    SECTION_ORDER.forEach(sec => drawStateSection(sec, grouped[sec]));
  } else {
    const sec = meta.scope as SectionScope;
    drawKpiCards(rows);
    drawDistrictBreakdown(rows, accent, 40, 'Breakdown by district');
    drawDetailTable(rows, [...baseCols, ...stateCols(sec)], accent, 'Landlord-by-landlord detail');
    if (sec === 'rejected') drawRejectionAppendix(rows, 'Appendix — full rejection reasons');
    if (sec !== 'rejected') drawReviewCommentsAppendix(rows, 'Appendix — review comments');
    if (sec === 'verified') { drawAttribution(rows); drawPayoutAppendix(rows, 'Appendix — payout readiness'); }
  }

  // ─── Footer ───
  const pageCount = (doc as any).internal.getNumberOfPages();
  for (let p = 1; p <= pageCount; p++) {
    doc.setPage(p);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(6.5);
    doc.setTextColor(150, 150, 158);
    doc.text(
      `Welile Technologies Ltd. — Landlord Operations ${SCOPE_TITLE[meta.scope]} report • generated ${format(new Date(), 'PPpp')} • internal & confidential`,
      margin, pageHeight - 6,
    );
    doc.text(`Page ${p} of ${pageCount}`, pageWidth - margin, pageHeight - 6, { align: 'right' });
  }

  return doc.output('blob');
}
