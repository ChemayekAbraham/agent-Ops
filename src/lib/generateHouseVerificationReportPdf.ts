import jsPDF from 'jspdf';
import { format } from 'date-fns';

/**
 * Comprehensive, audit-grade PDF report for a Landlord Ops house-listing filter
 * (pending / verified / rejected / all).
 *
 * Data source: the `ops_house_listing_report` RPC — one row per house with the
 * full verification trail (who verified/rejected, when, why), location, GPS,
 * agent, landlord payout details, tenant and bonus status.
 *
 * Date semantics: every date range in Landlord Ops is applied to the row's
 * STATE date (`activity_at`): registration date for pending, verification date
 * for verified, rejection date for rejected. The report restates this so the
 * reader can never mistake it for a registration-date report.
 */

export interface HouseReportRow {
  id: string;
  title: string | null;
  house_category: string | null;
  monthly_rent: number | null;
  daily_rate: number | null;
  number_of_rooms: number | null;
  address: string | null;
  district: string | null;
  village: string | null;
  region: string | null;
  latitude: number | null;
  longitude: number | null;
  photo_count: number | null;
  lc1_chairperson_name: string | null;
  lc1_chairperson_phone: string | null;
  lc1_chairperson_village: string | null;
  verified: boolean | null;
  verified_at: string | null;
  verified_by_name: string | null;
  rejection_reason: string | null;
  rejected_at: string | null;
  rejected_by_name: string | null;
  /**
   * Existing review note the operator left when verifying / rejecting this
   * listing (audit_logs.metadata.reason). Not a new field — it is simply
   * surfaced by `ops_house_listing_report`.
   */
  review_comment?: string | null;
  review_comment_at?: string | null;
  review_comment_by_name?: string | null;
  review_comment_action?: string | null;
  /** Existing service-centre vetting comment on the listing. */
  service_center_comment?: string | null;
  activity_at: string | null;
  created_at: string | null;
  updated_at: string | null;
  status: string | null;
  is_hidden: boolean | null;
  listing_bonus_paid: boolean | null;
  listing_bonus_paid_at: string | null;
  agent_name: string | null;
  agent_phone: string | null;
  agent_email: string | null;
  tenant_id: string | null;
  tenant_name: string | null;
  tenant_phone: string | null;
  landlord_name: string | null;
  landlord_phone: string | null;
  landlord_verified: boolean | null;
  landlord_verification_status: string | null;
  mobile_money_name: string | null;
  mobile_money_number: string | null;
  bank_name: string | null;
  account_number: string | null;
  landlord_village: string | null;
  landlord_district: string | null;
  landlord_region: string | null;
}

export type HouseReportScope = 'pending' | 'verified' | 'rejected' | 'all';

/** A single-state section inside a report. `all` reports render one per state. */
type SectionScope = Exclude<HouseReportScope, 'all'>;

const SECTION_ORDER: SectionScope[] = ['verified', 'rejected', 'pending'];

const SECTION_TITLE: Record<SectionScope, string> = {
  pending: 'Pending verification',
  verified: 'Verified houses',
  rejected: 'Rejected houses',
};

const SECTION_BASIS: Record<SectionScope, string> = {
  pending: 'Dates below are the registration date (the house has no decision yet).',
  verified: 'Dates below are the verification date recorded against each house.',
  rejected: 'Dates below are the rejection date recorded against each house.',
};

/** Classifies a row into exactly one state, matching the queue/status scopes. */
const rowSection = (r: HouseReportRow): SectionScope =>
  r.status === 'rejected' ? 'rejected' : r.verified ? 'verified' : 'pending';

export interface HouseReportMeta {
  scope: HouseReportScope;
  quickFilter?: string;
  search?: string | null;
  dateFrom?: string | null;
  dateTo?: string | null;
  /** True DB match count — may exceed rows.length when the export is capped. */
  totalMatches?: number;
  generatedBy?: string | null;
}

const SCOPE_TITLE: Record<HouseReportScope, string> = {
  pending: 'Pending Verification',
  verified: 'Verified Houses',
  rejected: 'Rejected Houses',
  all: 'All Houses',
};

const SCOPE_DATE_BASIS: Record<HouseReportScope, string> = {
  pending: 'date the house was registered by the agent',
  verified: 'date the house was verified by a reviewer',
  rejected: 'date the house was rejected',
  all: 'date the house entered its current state (registered / verified / rejected)',
};

const SCOPE_ACCENT: Record<HouseReportScope, [number, number, number]> = {
  pending: [217, 119, 6],
  verified: [16, 163, 74],
  rejected: [220, 38, 38],
  all: [146, 52, 234],
};

export function generateHouseVerificationReportPdf(
  rows: HouseReportRow[],
  meta: HouseReportMeta,
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
  doc.text(
    `Dates in this report use the ${SCOPE_DATE_BASIS[meta.scope]}.`,
    margin, y,
  );

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
      `Note: ${meta.totalMatches.toLocaleString()} houses match these filters; this export lists the ${rows.length.toLocaleString()} most recent. Narrow the date range for a complete set.`,
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
  // Every block below renders for an arbitrary row set and state so that the
  // "all" report can reuse the exact same, fully comprehensive layout the
  // independent verified / rejected / pending reports use.

  const sectionHeading = (label: string, size = 10) => {
    ensure(16);
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(size);
    doc.setTextColor(15, 23, 42);
    doc.text(label, margin, y);
    y += 4;
  };

  /** Coloured band that opens a state section in the "all" report. */
  const drawSectionBanner = (sec: SectionScope, sectionRows: HouseReportRow[]) => {
    ensure(30);
    const bandH = 9;
    doc.setFillColor(...SCOPE_ACCENT[sec]);
    (doc as any).roundedRect(margin, y, contentWidth, bandH, 1.5, 1.5, 'F');
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(10);
    doc.setTextColor(255, 255, 255);
    doc.text(SECTION_TITLE[sec].toUpperCase(), margin + 3, y + 6.2);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(8);
    doc.text(
      `${num(sectionRows.length)} of ${num(rows.length)} houses in this export`,
      pageWidth - margin - 3, y + 6.2, { align: 'right' },
    );
    y += bandH + 3.5;
    doc.setFont('helvetica', 'italic');
    doc.setFontSize(7.5);
    doc.setTextColor(110, 110, 120);
    doc.text(SECTION_BASIS[sec], margin, y);
    y += 5;
  };

  const drawKpiCards = (sectionRows: HouseReportRow[], sec: SectionScope | 'all') => {
    const totalRent = sectionRows.reduce((s, r) => s + Number(r.monthly_rent || 0), 0);
    const withGps = sectionRows.filter(r => r.latitude != null && r.longitude != null).length;
    const withPhotos = sectionRows.filter(r => Number(r.photo_count || 0) > 0).length;
    const withLc1 = sectionRows.filter(r => txt(r.lc1_chairperson_name, '') !== '').length;
    const hidden = sectionRows.filter(r => !!r.is_hidden).length;
    const occupied = sectionRows.filter(r => !!r.tenant_id).length;
    const agents = new Set(sectionRows.map(r => txt(r.agent_name, '')).filter(Boolean)).size;
    const landlords = new Set(sectionRows.map(r => txt(r.landlord_name, '')).filter(Boolean)).size;

    const cards: { label: string; value: string }[] = [
      { label: 'HOUSES', value: num(sectionRows.length) },
      { label: 'LANDLORDS', value: num(landlords) },
      { label: 'AGENTS', value: num(agents) },
      { label: 'MONTHLY RENT', value: ugx(totalRent) },
      { label: 'WITH GPS', value: `${num(withGps)} / ${num(sectionRows.length)}` },
      { label: 'WITH PHOTOS', value: `${num(withPhotos)} / ${num(sectionRows.length)}` },
      { label: 'WITH LC1', value: `${num(withLc1)} / ${num(sectionRows.length)}` },
      sec === 'pending'
        ? { label: 'OCCUPIED', value: num(occupied) }
        : { label: 'HIDDEN (SUBSET)', value: num(hidden) },
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
    sectionRows: HouseReportRow[],
    sectionAccent: [number, number, number],
    limit: number,
    heading: string,
  ) => {
    const byDistrict = new Map<string, { houses: number; rent: number; hidden: number; occupied: number }>();
    sectionRows.forEach(r => {
      const key = txt(r.district, 'Unknown district');
      const cur = byDistrict.get(key) || { houses: 0, rent: 0, hidden: 0, occupied: 0 };
      cur.houses += 1;
      cur.rent += Number(r.monthly_rent || 0);
      if (r.is_hidden) cur.hidden += 1;
      if (r.tenant_id) cur.occupied += 1;
      byDistrict.set(key, cur);
    });
    const districtRows = Array.from(byDistrict.entries()).sort((a, b) => b[1].houses - a[1].houses);
    if (!districtRows.length) return;

    ensure(20);
    sectionHeading(heading);

    const dCols = [
      { label: 'District', w: 60, align: 'left' as const },
      { label: 'Houses', w: 22, align: 'right' as const },
      { label: 'Occupied', w: 24, align: 'right' as const },
      { label: 'Hidden', w: 22, align: 'right' as const },
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
      const vals = [clip(name, 32), num(v.houses), num(v.occupied), num(v.hidden), num(v.rent)];
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

  type Col = { label: string; w: number; align?: 'left' | 'right'; get: (r: HouseReportRow, i: number) => string };

  /**
   * The existing review comment for a listing, in the system's own order of
   * precedence: the rejection reason for a rejected listing, otherwise the
   * reviewer's note captured on the verification decision, otherwise the
   * service-centre vetting comment. Never invented — returns null when the
   * record genuinely carries no comment.
   */
  const reviewCommentOf = (
    r: HouseReportRow,
  ): { text: string; label: string; by: string | null; at: string | null } | null => {
    if (r.status === 'rejected' && txt(r.rejection_reason, '') !== '') {
      return { text: txt(r.rejection_reason), label: 'Rejection reason', by: r.rejected_by_name ?? null, at: r.rejected_at ?? null };
    }
    if (txt(r.review_comment, '') !== '') {
      return {
        text: txt(r.review_comment),
        label: r.review_comment_action === 'listing_rejected' ? 'Rejection note' : 'Verification note',
        by: r.review_comment_by_name ?? null,
        at: r.review_comment_at ?? null,
      };
    }
    if (txt(r.service_center_comment, '') !== '') {
      return { text: txt(r.service_center_comment), label: 'Service centre comment', by: null, at: null };
    }
    return null;
  };

  const baseCols: Col[] = [
    { label: '#', w: 8, get: (_r, i) => `${i + 1}` },
    { label: 'House', w: 40, get: r => clip(txt(r.title), 26) },
    { label: 'Location (village / district)', w: 46, get: r => clip(`${txt(r.village, '?')} / ${txt(r.district, '?')}`, 30) },
    { label: 'Rent', w: 20, align: 'right', get: r => num(r.monthly_rent) },
    { label: 'Landlord', w: 34, get: r => clip(txt(r.landlord_name), 22) },
    { label: 'Landlord phone', w: 24, get: r => clip(txt(r.landlord_phone), 15) },
    { label: 'Agent', w: 32, get: r => clip(txt(r.agent_name), 21) },
  ];

  /** State-specific trailing columns — identical to the standalone reports. */
  const stateCols = (sec: SectionScope): Col[] =>
    sec === 'verified'
      ? [
          { label: 'Verified by', w: 32, get: r => clip(txt(r.verified_by_name, 'System / pipeline'), 21) },
          { label: 'Verified on', w: 26, get: r => dt(r.verified_at, true) },
          { label: 'Visibility', w: 18, get: r => (r.is_hidden ? 'Hidden' : 'Live') },
          { label: 'Bonus', w: 16, get: r => (r.listing_bonus_paid ? 'Paid' : '—') },
          { label: 'GPS', w: 12, get: r => (r.latitude != null && r.longitude != null ? 'Yes' : 'No') },
        ]
      : sec === 'rejected'
        ? [
            { label: 'Rejected by', w: 30, get: r => clip(txt(r.rejected_by_name, 'Unknown'), 20) },
            { label: 'Rejected on', w: 24, get: r => dt(r.rejected_at, true) },
            { label: 'Reason', w: 50, get: r => clip(txt(r.rejection_reason, 'No reason recorded'), 40) },
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
            { label: 'Photos', w: 16, align: 'right', get: r => num(r.photo_count) },
            { label: 'GPS', w: 12, get: r => (r.latitude != null && r.longitude != null ? 'Yes' : 'No') },
            { label: 'LC1', w: 26, get: r => clip(txt(r.lc1_chairperson_name), 17) },
          ];

  const drawDetailTable = (
    sectionRows: HouseReportRow[],
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
      doc.text('No houses in this state for the selected filters.', margin, y + 2);
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

  /** Full, untruncated rejection reasons for the supplied rows. */
  const drawRejectionAppendix = (sectionRows: HouseReportRow[], heading: string) => {
    const withReason = sectionRows.filter(r => txt(r.rejection_reason, '') !== '');
    if (!withReason.length) return;
    y += 6;
    ensure(16);
    sectionHeading(heading);
    y += 1;
    doc.setFontSize(7.5);
    withReason.forEach((r, i) => {
      const head = `${i + 1}. ${txt(r.title)} — ${txt(r.village, '?')}, ${txt(r.district, '?')} — rejected by ${txt(r.rejected_by_name, 'Unknown')} on ${dt(r.rejected_at, true)}`;
      const lines = doc.splitTextToSize(txt(r.rejection_reason), contentWidth - 4) as string[];
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
   * Review comments recorded against each house in this section, verbatim.
   * Houses with no recorded comment are simply omitted (no placeholders).
   */
  const drawReviewCommentsAppendix = (sectionRows: HouseReportRow[], heading: string) => {
    const withComment = sectionRows
      .map(r => ({ r, c: reviewCommentOf(r) }))
      .filter((x): x is { r: HouseReportRow; c: NonNullable<ReturnType<typeof reviewCommentOf>> } => x.c !== null);
    if (!withComment.length) return;
    y += 6;
    ensure(16);
    sectionHeading(heading);
    y += 1;
    doc.setFontSize(7.5);
    withComment.forEach(({ r, c }, i) => {
      const who = c.by ? ` by ${c.by}` : '';
      const when = c.at ? ` on ${dt(c.at, true)}` : '';
      const head = `${i + 1}. ${txt(r.title)} — ${txt(r.village, '?')}, ${txt(r.district, '?')} — ${c.label}${who}${when}`;
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

  /** Landlord payout readiness for the supplied (verified) rows. */
  const drawPayoutAppendix = (sectionRows: HouseReportRow[], heading: string) => {
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
      `${missingPayout.length} verified house${missingPayout.length === 1 ? '' : 's'} belong to landlords with NO payout destination on file:`,
      margin, y,
    );
    y += 4;
    missingPayout.slice(0, 60).forEach((r, i) => {
      ensure(4);
      doc.text(
        `${i + 1}. ${txt(r.landlord_name)} (${txt(r.landlord_phone)}) — ${txt(r.title)} — ${txt(r.village, '?')}, ${txt(r.district, '?')}`,
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

  /** One complete, self-contained state section (used by the "all" report). */
  const drawStateSection = (sec: SectionScope, sectionRows: HouseReportRow[]) => {
    const sectionAccent = SCOPE_ACCENT[sec];
    drawSectionBanner(sec, sectionRows);
    drawKpiCards(sectionRows, sec);
    drawDistrictBreakdown(sectionRows, sectionAccent, 20, `${SECTION_TITLE[sec]} — breakdown by district`);
    drawDetailTable(sectionRows, [...baseCols, ...stateCols(sec)], sectionAccent, `${SECTION_TITLE[sec]} — house-by-house detail`);
    if (sec === 'rejected') drawRejectionAppendix(sectionRows, 'Rejected houses — full rejection reasons');
    if (sec !== 'rejected') drawReviewCommentsAppendix(sectionRows, `${SECTION_TITLE[sec]} — review comments`);
    if (sec === 'verified') drawPayoutAppendix(sectionRows, 'Verified houses — landlord payout readiness');
    y += 8;
  };

  // ─── Body ───────────────────────────────────────────────────────────────
  if (meta.scope === 'all') {
    // Portfolio-wide overview first, then a fully organised section per state
    // so verified / rejected / pending each read like their own report.
    const grouped: Record<SectionScope, HouseReportRow[]> = { verified: [], rejected: [], pending: [] };
    rows.forEach(r => { grouped[rowSection(r)].push(r); });

    drawKpiCards(rows, 'all');

    // State mix so the reader can see the composition before drilling in.
    sectionHeading('Composition by state');
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(7.5);
    const mixW = contentWidth / 3 - 3;
    SECTION_ORDER.forEach((sec, i) => {
      const x = margin + i * (mixW + 4.5);
      const list = grouped[sec];
      const share = rows.length ? Math.round((list.length / rows.length) * 100) : 0;
      doc.setFillColor(248, 249, 252);
      doc.setDrawColor(...SCOPE_ACCENT[sec]);
      doc.setLineWidth(0.5);
      (doc as any).roundedRect(x, y, mixW, 14, 2, 2, 'FD');
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(7);
      doc.setTextColor(...SCOPE_ACCENT[sec]);
      doc.text(SECTION_TITLE[sec].toUpperCase(), x + 3, y + 5);
      doc.setFontSize(9);
      doc.setTextColor(15, 23, 42);
      doc.text(`${num(list.length)} houses  (${share}%)`, x + 3, y + 11);
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
    drawKpiCards(rows, sec);
    drawDistrictBreakdown(rows, accent, 40, 'Breakdown by district');
    drawDetailTable(rows, [...baseCols, ...stateCols(sec)], accent, 'House-by-house detail');
    if (sec === 'rejected') drawRejectionAppendix(rows, 'Appendix — full rejection reasons');
    if (sec !== 'rejected') drawReviewCommentsAppendix(rows, 'Appendix — review comments');
    if (sec === 'verified') drawPayoutAppendix(rows, 'Appendix — landlord payout readiness');
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
