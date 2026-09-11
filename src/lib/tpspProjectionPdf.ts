import { formatUGX } from '@/lib/rentCalculations';
import type {
  TpspBreakdownRow, TpspDetailRow, TpspGrain, TpspProjection, TpspSeriesPoint,
} from '@/hooks/useTpspProjection';

/**
 * Read-only PDF for Tenant Ops → Tenant Products & Services → Projections.
 * Every figure comes straight from the projection RPC payload; the only arithmetic
 * done here is totalling and share-of-total on values the server already returned.
 */

const INK: [number, number, number] = [31, 41, 55];
const MUTED: [number, number, number] = [107, 114, 128];
const GREEN: [number, number, number] = [5, 150, 105];
const AMBER: [number, number, number] = [180, 83, 9];
const PURPLE: [number, number, number] = [124, 58, 237];

export interface TpspPdfInput {
  projection: TpspProjection;
  rows: TpspDetailRow[];
  totalRows: number;
  rowCap: number;
  /** Human-readable list of the filters in force, already resolved to labels. */
  filterLines: string[];
  grain: TpspGrain;
}

const grainWord = (g: TpspGrain) => (g === 'month' ? 'month' : g === 'quarter' ? 'quarter' : 'year');
const grainTitle = (g: TpspGrain) => (g === 'month' ? 'Monthly' : g === 'quarter' ? 'Quarterly' : 'Yearly');

const pct = (part: number, whole: number) => (whole > 0 ? `${((part / whole) * 100).toFixed(1)}%` : '—');

const kampalaStamp = () =>
  new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Africa/Kampala',
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date());

/** Build and download the comprehensive projections PDF for the filters on screen. */
export async function downloadTpspProjectionPdf(input: TpspPdfInput): Promise<void> {
  const { jsPDF } = await import('jspdf');
  const autoTableMod: any = await import('jspdf-autotable');
  const autoTable = autoTableMod.default ?? autoTableMod;

  const { projection, rows, totalRows, rowCap, filterLines, grain } = input;
  const s = projection.summary;
  const series: TpspSeriesPoint[] = projection.series || [];
  const breakdown: TpspBreakdownRow[] = [...(projection.breakdown || [])].sort(
    (a, b) => Number(b.monthly_tenant_rent) - Number(a.monthly_tenant_rent),
  );

  const doc = new jsPDF({ orientation: 'landscape', unit: 'pt', format: 'a4' });
  const pageWidth = doc.internal.pageSize.getWidth();
  const pageHeight = doc.internal.pageSize.getHeight();
  const margin = 40;
  const scopeLine = filterLines.length ? filterLines.join(' · ') : 'Whole portfolio — no filters applied';

  // ---------- Header ----------
  doc.setFillColor(...INK);
  doc.rect(0, 0, pageWidth, 74, 'F');
  doc.setTextColor(255, 255, 255);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(16);
  doc.text('Welile · Rent Projections — next 12 months', margin, 32);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(9);
  doc.text(
    `${grainTitle(grain)} view · from ${projection.start_month} · ${projection.timezone || 'Africa/Kampala'} · generated ${kampalaStamp()} · read-only`,
    margin,
    50,
  );
  doc.text(doc.splitTextToSize(`Scope: ${scopeLine}`, pageWidth - margin * 2)[0], margin, 64);

  doc.setTextColor(...MUTED);
  doc.setFontSize(8);
  const basis = doc.splitTextToSize(
    projection.basis ||
      'Active tenant plans normalised to a 30-day month and assumed to continue across the horizon.',
    pageWidth - margin * 2,
  );
  doc.text(basis, margin, 90);

  // ---------- Headline figures ----------
  let y = 90 + basis.length * 11 + 8;
  const tiles: Array<{ label: string; value: string; tone?: [number, number, number] }> = [
    { label: 'Tenant rent / month', value: formatUGX(s.monthly_tenant_rent), tone: GREEN },
    { label: 'Landlord rent / month', value: formatUGX(s.monthly_landlord_cost), tone: AMBER },
    { label: 'Margin / month', value: formatUGX(s.monthly_margin), tone: PURPLE },
    { label: '12-month tenant rent', value: formatUGX(s.horizon_tenant_rent), tone: GREEN },
    { label: '12-month landlord rent', value: formatUGX(s.horizon_landlord_cost), tone: AMBER },
    { label: '12-month margin', value: formatUGX(s.horizon_margin), tone: PURPLE },
    { label: 'Occupied houses', value: Number(s.plans).toLocaleString() },
    { label: 'Active tenants', value: Number(s.tenants).toLocaleString() },
    { label: 'Landlords', value: Number(s.landlords).toLocaleString() },
    { label: 'Houses', value: Number(s.houses).toLocaleString() },
    { label: 'Agents', value: Number(s.agents).toLocaleString() },
    { label: 'Unmapped plans', value: Number(s.unmapped_plans).toLocaleString() },
  ];
  const perRow = 6;
  const tileW = (pageWidth - margin * 2 - 8 * (perRow - 1)) / perRow;
  const tileH = 44;
  tiles.forEach((t, i) => {
    const col = i % perRow;
    const row = Math.floor(i / perRow);
    const x = margin + col * (tileW + 8);
    const ty = y + row * (tileH + 8);
    doc.setDrawColor(226, 232, 240);
    doc.setFillColor(249, 250, 251);
    doc.roundedRect(x, ty, tileW, tileH, 4, 4, 'FD');
    doc.setFontSize(6.5);
    doc.setTextColor(...MUTED);
    doc.setFont('helvetica', 'normal');
    doc.text(t.label.toUpperCase(), x + 8, ty + 15);
    doc.setFontSize(10);
    doc.setFont('helvetica', 'bold');
    doc.setTextColor(...(t.tone ?? INK));
    doc.text(doc.splitTextToSize(t.value, tileW - 16)[0], x + 8, ty + 32);
  });
  y += Math.ceil(tiles.length / perRow) * (tileH + 8) + 6;

  /** Stamped once at the end so the page count is final on every page. */
  const stampFooters = () => {
    const pageCount = doc.getNumberOfPages();
    for (let pageNumber = 1; pageNumber <= pageCount; pageNumber += 1) {
      doc.setPage(pageNumber);
      doc.setFontSize(7);
      doc.setFont('helvetica', 'normal');
      doc.setTextColor(...MUTED);
      doc.text(
        doc.splitTextToSize(
          `Welile · Rent projections (read-only, from recorded active plans) · ${scopeLine}`,
          pageWidth - margin * 2 - 90,
        )[0],
        margin,
        pageHeight - 18,
      );
      doc.text(`Page ${pageNumber} of ${pageCount}`, pageWidth - margin, pageHeight - 18, { align: 'right' });
    }
  };

  const sectionTitle = (title: string, startY: number) => {
    doc.setFontSize(11);
    doc.setFont('helvetica', 'bold');
    doc.setTextColor(...INK);
    doc.text(title, margin, startY);
    return startY + 8;
  };

  const tableTheme = {
    margin: { left: margin, right: margin, bottom: 34 },
    showHead: 'everyPage' as const,
    styles: { fontSize: 7.5, cellPadding: 4, overflow: 'linebreak' as const },
    headStyles: { fillColor: INK, textColor: 255, fontStyle: 'bold' as const, fontSize: 7.5 },
    alternateRowStyles: { fillColor: [248, 250, 252] as [number, number, number] },
  };

  // ---------- Period table ----------
  y = sectionTitle(`Projection by ${grainWord(grain)}`, y + 8);
  const seriesBody = series.map((p) => [
    p.label,
    formatUGX(p.tenant_rent),
    formatUGX(p.landlord_cost),
    formatUGX(p.margin),
    pct(Number(p.margin), Number(p.tenant_rent)),
  ]);
  seriesBody.push([
    'TOTAL (12 months)',
    formatUGX(s.horizon_tenant_rent),
    formatUGX(s.horizon_landlord_cost),
    formatUGX(s.horizon_margin),
    pct(Number(s.horizon_margin), Number(s.horizon_tenant_rent)),
  ]);
  const seriesTotalIndex = seriesBody.length - 1;
  autoTable(doc, {
    ...tableTheme,
    startY: y,
    head: [[grainTitle(grain).replace('ly', ''), 'Tenant rent', 'Landlord rent', 'Margin', 'Margin %']],
    body: seriesBody,
    columnStyles: {
      1: { halign: 'right', textColor: GREEN },
      2: { halign: 'right', textColor: AMBER },
      3: { halign: 'right' },
      4: { halign: 'right' },
    },
    didParseCell: (h: any) => {
      if (h.section === 'body' && h.row.index === seriesTotalIndex) h.cell.styles.fontStyle = 'bold';
    },
  });

  // ---------- Breakdown table ----------
  const level = breakdown[0]?.level ?? 'region';
  const levelLabel = level.charAt(0).toUpperCase() + level.slice(1);
  y = sectionTitle(
    `Monthly projection by ${level}`,
    ((doc as any).lastAutoTable?.finalY ?? y) + 24,
  );
  autoTable(doc, {
    ...tableTheme,
    startY: y,
    head: [[levelLabel, 'Houses', 'Tenant rent / month', 'Landlord rent / month', 'Margin / month', 'Share of tenant rent']],
    body: breakdown.length
      ? breakdown.map((b) => [
          b.label,
          Number(b.plans).toLocaleString(),
          formatUGX(b.monthly_tenant_rent),
          formatUGX(b.monthly_landlord_cost),
          formatUGX(b.monthly_margin),
          pct(Number(b.monthly_tenant_rent), Number(s.monthly_tenant_rent)),
        ])
      : [['No active plans match these filters.', '', '', '', '', '']],
    columnStyles: {
      1: { halign: 'right' },
      2: { halign: 'right', textColor: GREEN },
      3: { halign: 'right', textColor: AMBER },
      4: { halign: 'right' },
      5: { halign: 'right' },
    },
  });

  // ---------- Plan detail ----------
  doc.addPage();
  y = sectionTitle('House-level projection', 50);
  doc.setFontSize(8);
  doc.setFont('helvetica', 'normal');
  doc.setTextColor(...MUTED);
  const note =
    rows.length < totalRows
      ? `Showing the first ${rows.length.toLocaleString()} of ${totalRows.toLocaleString()} matching plans (cap ${rowCap.toLocaleString()}). Narrow the filters or use the CSV export for the full list.`
      : `All ${rows.length.toLocaleString()} plans matching these filters.`;
  doc.text(note, margin, y + 10);
  y += 20;

  autoTable(doc, {
    ...tableTheme,
    startY: y,
    head: [[
      '#', 'Tenant', 'Phone', 'House', 'Location', 'Agent', 'Landlord', 'Status',
      'Cycle ends', 'Tenant / month', 'Landlord / month', 'Margin / month', '12-month rent',
    ]],
    body: rows.length
      ? rows.map((r, i) => [
          String(i + 1),
          r.tenant_name,
          r.tenant_phone || '—',
          r.house_label || '—',
          `${r.location_label || '—'}${r.unmapped ? ' (Unmapped)' : ''}`,
          r.agent_name || '—',
          r.landlord_name || '—',
          r.plan_status,
          r.cycle_end_date || '—',
          formatUGX(r.monthly_tenant_rent),
          formatUGX(r.monthly_landlord_cost),
          formatUGX(r.monthly_margin),
          formatUGX(r.horizon_tenant_rent),
        ])
      : [['', 'No active tenant plans match these filters.', '', '', '', '', '', '', '', '', '', '', '']],
    columnStyles: {
      0: { cellWidth: 24 },
      8: { halign: 'center' },
      9: { halign: 'right', textColor: GREEN },
      10: { halign: 'right', textColor: AMBER },
      11: { halign: 'right' },
      12: { halign: 'right' },
    },
    didParseCell: (h: any) => {
      if (h.section !== 'body') return;
      const row = rows[h.row.index];
      if (row?.unmapped && h.column.index === 4) {
        h.cell.styles.textColor = MUTED;
        h.cell.styles.fontStyle = 'italic';
      }
    },
  });

  stampFooters();
  doc.save(`welile-rent-projections-${grain}-${projection.start_month}.pdf`);
}
