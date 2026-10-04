import jsPDF from 'jspdf';
import { format } from 'date-fns';

/**
 * Comprehensive, audit-grade PDF report for LC1 chairperson verification.
 *
 * Data source: the `ops_lc1_verification_report` RPC (view
 * `v_lc1_verification_inbox`) — one row per LC1 chairperson with the full
 * decision trail: who registered them, who reviewed, when, why, whether the
 * agent request originated from the field, and the linked landlord count.
 *
 * Date semantics: every date range uses the row's DECISION date
 * (verified_at / resolved_at), falling back to the request date for rows that
 * have not been decided yet.
 */

export interface Lc1ReportRow {
  lc1_id: string;
  request_id: string | null;
  lc1_name: string | null;
  lc1_phone: string | null;
  lc1_village: string | null;
  lc1_district: string | null;
  lc1_region: string | null;
  lc1_parish: string | null;
  lc1_sub_county: string | null;
  status: string | null;
  reason: string | null;
  verified_flag: boolean | null;
  verified_at: string | null;
  reviewer_name: string | null;
  agent_id: string | null;
  agent_name: string | null;
  agent_phone: string | null;
  agent_note: string | null;
  reject_comment: string | null;
  request_status: string | null;
  resolved_at: string | null;
  resolved_by_name: string | null;
  source: string | null;
  requested_at: string | null;
  lc1_created_at: string | null;
  verification_bonus_paid: boolean | null;
  linked_landlords: number | null;
}

export type Lc1ReportScope =
  | 'verified'
  | 'rejected'
  | 'pending'
  | 'agent_requested'
  | 'rent_linked'
  | 'all';

type SectionScope = 'verified' | 'rejected' | 'pending';

const SECTION_ORDER: SectionScope[] = ['verified', 'rejected', 'pending'];

const SECTION_TITLE: Record<SectionScope, string> = {
  verified: 'Approved LC1 chairpersons',
  rejected: 'Rejected LC1 chairpersons',
  pending: 'Awaiting verification',
};

const SECTION_BASIS: Record<SectionScope, string> = {
  verified: 'Dates below are the verification date recorded on the chairperson record.',
  rejected: 'Dates below are the rejection date recorded on the request trail.',
  pending: 'Dates below are the date the chairperson was registered / raised by an agent.',
};

const ACCENT: Record<Lc1ReportScope, [number, number, number]> = {
  verified: [16, 163, 74],
  rejected: [220, 38, 38],
  pending: [217, 119, 6],
  agent_requested: [37, 99, 235],
  rent_linked: [13, 148, 136],
  all: [146, 52, 234],
};

const SCOPE_TITLE: Record<Lc1ReportScope, string> = {
  verified: 'Approved LC1 Chairpersons',
  rejected: 'Rejected LC1 Chairpersons',
  pending: 'LC1 Chairpersons Awaiting Verification',
  agent_requested: 'LC1 Verifications Requested by Agents',
  rent_linked: 'LC1 Verifications Blocking a Rent Application',
  all: 'LC1 Chairperson Verification Register',
};

export interface Lc1ReportMeta {
  scope: Lc1ReportScope;
  search?: string | null;
  dateFrom?: string | null;
  dateTo?: string | null;
  /** True DB match count — may exceed rows.length when the export is capped. */
  totalMatches?: number;
  generatedBy?: string | null;
}

const decisionDate = (r: Lc1ReportRow) => r.verified_at || r.resolved_at || r.requested_at || r.lc1_created_at;

const rowSection = (r: Lc1ReportRow): SectionScope =>
  r.status === 'verified' ? 'verified' : r.status === 'rejected' ? 'rejected' : 'pending';

export function generateLc1VerificationReportPdf(rows: Lc1ReportRow[], meta: Lc1ReportMeta): Blob {
  const doc = new jsPDF({ orientation: 'landscape', unit: 'mm', format: 'a4' });
  const pageWidth = doc.internal.pageSize.getWidth();
  const pageHeight = doc.internal.pageSize.getHeight();
  const margin = 10;
  const contentWidth = pageWidth - margin * 2;
  const accent = ACCENT[meta.scope];
  let y = 14;

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
  const pct = (a: number, b: number) => (b > 0 ? `${Math.round((a / b) * 100)}%` : '—');

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
    'Dates use the decision date (verification / rejection); undecided rows use the request date.',
    margin, y,
  );

  y += 4.2;
  const filterBits: string[] = [
    `Period: ${meta.dateFrom ? dt(meta.dateFrom) : 'All time'} → ${meta.dateTo ? dt(meta.dateTo) : 'Today'}`,
  ];
  if (meta.search) filterBits.push(`Search: "${meta.search}"`);
  if (meta.generatedBy) filterBits.push(`Prepared by: ${meta.generatedBy}`);
  doc.setFont('helvetica', 'italic');
  doc.text(filterBits.join('   •   '), margin, y);

  if (typeof meta.totalMatches === 'number' && meta.totalMatches > rows.length) {
    y += 4.2;
    doc.setFont('helvetica', 'bold');
    doc.setTextColor(220, 38, 38);
    doc.text(
      `Note: ${meta.totalMatches.toLocaleString()} chairpersons match these filters; this export lists the ${rows.length.toLocaleString()} most recent. Narrow the date range for a complete set.`,
      margin, y,
    );
    doc.setTextColor(110, 110, 120);
  }

  y += 4;
  doc.setDrawColor(225, 227, 232);
  doc.setLineWidth(0.3);
  doc.line(margin, y, pageWidth - margin, y);
  y += 6;

  const sectionHeading = (label: string, size = 10) => {
    ensure(16);
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(size);
    doc.setTextColor(15, 23, 42);
    doc.text(label, margin, y);
    y += 4;
  };

  const drawSectionBanner = (sec: SectionScope, sectionRows: Lc1ReportRow[]) => {
    ensure(30);
    const bandH = 9;
    doc.setFillColor(...ACCENT[sec]);
    (doc as any).roundedRect(margin, y, contentWidth, bandH, 1.5, 1.5, 'F');
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(10);
    doc.setTextColor(255, 255, 255);
    doc.text(SECTION_TITLE[sec].toUpperCase(), margin + 3, y + 6.2);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(8);
    doc.text(
      `${num(sectionRows.length)} of ${num(rows.length)} chairpersons in this export`,
      pageWidth - margin - 3, y + 6.2, { align: 'right' },
    );
    y += bandH + 3.5;
    doc.setFont('helvetica', 'italic');
    doc.setFontSize(7.5);
    doc.setTextColor(110, 110, 120);
    doc.text(SECTION_BASIS[sec], margin, y);
    y += 5;
  };

  // ─── KPI cards ───
  const drawKpiCards = (sectionRows: Lc1ReportRow[]) => {
    const total = sectionRows.length;
    const withPhone = sectionRows.filter(r => txt(r.lc1_phone, '') !== '').length;
    const fromAgents = sectionRows.filter(r => r.source === 'agent_request').length;
    const districts = new Set(sectionRows.map(r => txt(r.lc1_district, '')).filter(Boolean)).size;
    const villages = new Set(sectionRows.map(r => txt(r.lc1_village, '')).filter(Boolean)).size;
    const agents = new Set(sectionRows.map(r => txt(r.agent_name, '')).filter(Boolean)).size;
    const reviewers = new Set(sectionRows.map(r => txt(r.reviewer_name || r.resolved_by_name, '')).filter(Boolean)).size;
    const landlords = sectionRows.reduce((s, r) => s + Number(r.linked_landlords || 0), 0);

    const cards = [
      { label: 'CHAIRPERSONS', value: num(total) },
      { label: 'DISTRICTS', value: num(districts) },
      { label: 'VILLAGES', value: num(villages) },
      { label: 'REGISTERING AGENTS', value: num(agents) },
      { label: 'REVIEWERS', value: num(reviewers) },
      { label: 'RAISED BY AGENTS', value: `${num(fromAgents)} (${pct(fromAgents, total)})` },
      { label: 'WITH PHONE', value: `${num(withPhone)} (${pct(withPhone, total)})` },
      { label: 'LINKED LANDLORDS', value: num(landlords) },
    ];

    ensure(22);
    const gap = 2.5;
    const cardW = (contentWidth - gap * (cards.length - 1)) / cards.length;
    const cardH = 16;
    cards.forEach((c, i) => {
      const x = margin + i * (cardW + gap);
      doc.setFillColor(248, 249, 252);
      doc.setDrawColor(225, 227, 232);
      doc.setLineWidth(0.2);
      (doc as any).roundedRect(x, y, cardW, cardH, 2, 2, 'FD');
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(6);
      doc.setTextColor(120, 122, 135);
      doc.text(c.label, x + 3, y + 5.5);
      doc.setFontSize(9);
      doc.setTextColor(15, 23, 42);
      doc.text(clip(c.value, 20), x + 3, y + 12);
    });
    y += cardH + 6;
  };

  /** Horizontal bar chart for a label→value ranking. */
  const drawBarChart = (
    heading: string,
    data: { label: string; value: number }[],
    color: [number, number, number],
    limit = 10,
  ) => {
    const top = data.slice(0, limit);
    if (!top.length) return;
    const rowH = 6;
    ensure(12 + top.length * rowH);
    sectionHeading(heading);
    const max = Math.max(...top.map(d => d.value), 1);
    const labelW = 55;
    const trackW = contentWidth * 0.45;
    top.forEach((d) => {
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(7.5);
      doc.setTextColor(60, 64, 78);
      doc.text(clip(d.label, 34), margin, y + 3.6);
      doc.setFillColor(238, 240, 245);
      (doc as any).roundedRect(margin + labelW, y + 0.6, trackW, 3.6, 1, 1, 'F');
      const w = Math.max((d.value / max) * trackW, 0.6);
      doc.setFillColor(...color);
      (doc as any).roundedRect(margin + labelW, y + 0.6, w, 3.6, 1, 1, 'F');
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(7.5);
      doc.setTextColor(15, 23, 42);
      doc.text(num(d.value), margin + labelW + trackW + 3, y + 3.6);
      y += rowH;
    });
    y += 3;
  };

  /** Vertical column chart for a monthly trend. */
  const drawTrendChart = (
    heading: string,
    data: { label: string; value: number }[],
    color: [number, number, number],
  ) => {
    if (!data.length) return;
    const chartH = 30;
    ensure(chartH + 18);
    sectionHeading(heading);
    const max = Math.max(...data.map(d => d.value), 1);
    const slots = data.length;
    const chartW = Math.min(contentWidth, slots * 22);
    const slotW = chartW / slots;
    const barW = Math.min(slotW * 0.55, 12);
    const baseline = y + chartH;

    doc.setDrawColor(225, 227, 232);
    doc.setLineWidth(0.2);
    doc.line(margin, baseline, margin + chartW, baseline);

    data.forEach((d, i) => {
      const h = Math.max((d.value / max) * (chartH - 6), 0.8);
      const x = margin + i * slotW + (slotW - barW) / 2;
      doc.setFillColor(...color);
      (doc as any).roundedRect(x, baseline - h, barW, h, 1, 1, 'F');
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(6.5);
      doc.setTextColor(15, 23, 42);
      doc.text(num(d.value), x + barW / 2, baseline - h - 1.5, { align: 'center' });
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(6.5);
      doc.setTextColor(120, 122, 135);
      doc.text(clip(d.label, 8), x + barW / 2, baseline + 4, { align: 'center' });
    });
    y = baseline + 9;
  };

  /** Stacked composition bar: how the export splits across states. */
  const drawCompositionBar = (allRows: Lc1ReportRow[]) => {
    const counts = SECTION_ORDER.map(sec => ({ sec, n: allRows.filter(r => rowSection(r) === sec).length }));
    const total = allRows.length || 1;
    ensure(24);
    sectionHeading('Verification mix');
    const barH = 7;
    let x = margin;
    counts.forEach(({ sec, n }) => {
      if (!n) return;
      const w = (n / total) * contentWidth;
      doc.setFillColor(...ACCENT[sec]);
      doc.rect(x, y, w, barH, 'F');
      if (w > 18) {
        doc.setFont('helvetica', 'bold');
        doc.setFontSize(6.5);
        doc.setTextColor(255, 255, 255);
        doc.text(`${SECTION_TITLE[sec].split(' ')[0]} ${pct(n, total)}`, x + 2, y + 4.7);
      }
      x += w;
    });
    y += barH + 4;
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(7.5);
    doc.setTextColor(110, 110, 120);
    doc.text(
      counts.map(({ sec, n }) => `${SECTION_TITLE[sec]}: ${num(n)} (${pct(n, total)})`).join('   •   '),
      margin, y,
    );
    y += 6;
  };

  /** Generic table renderer. */
  const drawTable = (
    heading: string,
    cols: { label: string; w: number; align?: 'left' | 'right' }[],
    body: string[][],
    color: [number, number, number],
  ) => {
    if (!body.length) return;
    const tableW = cols.reduce((s, c) => s + c.w, 0);
    const head = () => {
      doc.setFillColor(...color);
      doc.rect(margin, y, tableW, 6, 'F');
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(7);
      doc.setTextColor(255, 255, 255);
      let x = margin;
      cols.forEach(c => {
        doc.text(c.label, c.align === 'right' ? x + c.w - 2 : x + 2, y + 4.1, { align: c.align === 'right' ? 'right' : 'left' });
        x += c.w;
      });
      y += 6;
    };
    ensure(20);
    sectionHeading(heading);
    head();
    body.forEach((r, i) => {
      ensure(6, () => head());
      if (i % 2 === 0) {
        doc.setFillColor(250, 251, 253);
        doc.rect(margin, y, tableW, 5.6, 'F');
      }
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(6.8);
      doc.setTextColor(40, 44, 58);
      let x = margin;
      cols.forEach((c, ci) => {
        const cell = r[ci] ?? '—';
        const maxChars = Math.max(6, Math.floor(c.w / 1.5));
        doc.text(
          clip(cell, maxChars),
          c.align === 'right' ? x + c.w - 2 : x + 2,
          y + 3.9,
          { align: c.align === 'right' ? 'right' : 'left' },
        );
        x += c.w;
      });
      y += 5.6;
    });
    y += 5;
  };

  const groupCount = (sectionRows: Lc1ReportRow[], key: (r: Lc1ReportRow) => string) => {
    const m = new Map<string, number>();
    sectionRows.forEach(r => {
      const k = key(r);
      m.set(k, (m.get(k) || 0) + 1);
    });
    return Array.from(m.entries())
      .map(([label, value]) => ({ label, value }))
      .sort((a, b) => b.value - a.value);
  };

  const monthlyTrend = (sectionRows: Lc1ReportRow[]) => {
    const m = new Map<string, number>();
    sectionRows.forEach(r => {
      const d = decisionDate(r);
      if (!d) return;
      let key: string;
      try { key = format(new Date(d), 'MMM yy'); } catch { return; }
      m.set(key, (m.get(key) || 0) + 1);
    });
    return Array.from(m.entries())
      .map(([label, value]) => ({ label, value, ts: new Date(`01 ${label}`).getTime() }))
      .sort((a, b) => a.ts - b.ts)
      .slice(-12)
      .map(({ label, value }) => ({ label, value }));
  };

  const drawSectionBody = (sec: SectionScope, sectionRows: Lc1ReportRow[]) => {
    const color = ACCENT[sec];
    drawKpiCards(sectionRows);
    drawTrendChart(
      sec === 'pending' ? 'Registrations per month' : `${SECTION_TITLE[sec]} per month`,
      monthlyTrend(sectionRows), color,
    );
    drawBarChart('Top districts', groupCount(sectionRows, r => txt(r.lc1_district, 'Unknown district')), color);
    drawBarChart('Top villages', groupCount(sectionRows, r => txt(r.lc1_village, 'Unknown village')), color, 8);
    drawBarChart('Top registering agents', groupCount(sectionRows, r => txt(r.agent_name, 'Unattributed')), color, 8);
    if (sec !== 'pending') {
      drawBarChart('Reviewers (decisions taken)', groupCount(sectionRows, r => txt(r.reviewer_name || r.resolved_by_name, 'Unrecorded')), color, 8);
    }

    // District summary table
    const byDistrict = groupCount(sectionRows, r => txt(r.lc1_district, 'Unknown district'));
    drawTable(
      'District summary',
      [
        { label: 'District', w: 60 },
        { label: 'Chairpersons', w: 28, align: 'right' },
        { label: 'Share', w: 20, align: 'right' },
        { label: 'Villages', w: 24, align: 'right' },
        { label: 'Linked landlords', w: 32, align: 'right' },
      ],
      byDistrict.map(d => {
        const rowsIn = sectionRows.filter(r => txt(r.lc1_district, 'Unknown district') === d.label);
        return [
          d.label,
          num(d.value),
          pct(d.value, sectionRows.length),
          num(new Set(rowsIn.map(r => txt(r.lc1_village, '')).filter(Boolean)).size),
          num(rowsIn.reduce((s, r) => s + Number(r.linked_landlords || 0), 0)),
        ];
      }),
      color,
    );

    // Detail register
    drawTable(
      `${SECTION_TITLE[sec]} — full register`,
      [
        { label: 'Chairperson', w: 42 },
        { label: 'Phone', w: 24 },
        { label: 'Village', w: 30 },
        { label: 'District', w: 28 },
        { label: 'Registering agent', w: 36 },
        { label: 'Agent phone', w: 24 },
        { label: 'Source', w: 20 },
        { label: sec === 'pending' ? 'Requested' : 'Decision date', w: 24 },
        { label: 'Reviewer', w: 30 },
        { label: 'Reason / comment', w: 60 },
      ],
      sectionRows.map(r => [
        txt(r.lc1_name),
        txt(r.lc1_phone),
        txt(r.lc1_village),
        txt(r.lc1_district),
        txt(r.agent_name),
        txt(r.agent_phone),
        r.source === 'agent_request' ? 'Agent request' : 'Registration',
        dt(sec === 'pending' ? r.requested_at : decisionDate(r)),
        txt(r.reviewer_name || r.resolved_by_name),
        txt(r.reason || r.reject_comment || r.agent_note),
      ]),
      color,
    );
  };

  // ─── Body ───
  if (!rows.length) {
    doc.setFont('helvetica', 'italic');
    doc.setFontSize(10);
    doc.setTextColor(110, 110, 120);
    doc.text('No LC1 chairpersons match the selected filters.', margin, y + 6);
  } else if (meta.scope === 'all') {
    drawCompositionBar(rows);
    SECTION_ORDER.forEach(sec => {
      const sectionRows = rows.filter(r => rowSection(r) === sec);
      if (!sectionRows.length) return;
      ensure(40);
      drawSectionBanner(sec, sectionRows);
      drawSectionBody(sec, sectionRows);
    });
  } else {
    drawSectionBody(
      meta.scope === 'verified' || meta.scope === 'rejected' ? meta.scope : 'pending',
      rows,
    );
  }

  // ─── Footer on every page ───
  const pages = doc.getNumberOfPages();
  for (let p = 1; p <= pages; p++) {
    doc.setPage(p);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(6.8);
    doc.setTextColor(150, 152, 165);
    doc.text('Welile · Landlord Operations · LC1 verification register — confidential', margin, pageHeight - 6);
    doc.text(`Page ${p} of ${pages}`, pageWidth - margin, pageHeight - 6, { align: 'right' });
    doc.setDrawColor(...accent);
    doc.setLineWidth(0.6);
    doc.line(margin, pageHeight - 8.6, pageWidth - margin, pageHeight - 8.6);
  }

  return doc.output('blob');
}

export function lc1ReportFileName(scope: Lc1ReportScope): string {
  return `welile-lc1-${scope}-verification-${format(new Date(), 'yyyy-MM-dd-HHmm')}.pdf`;
}