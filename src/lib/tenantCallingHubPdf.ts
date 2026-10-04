import jsPDF from 'jspdf';
import { format } from 'date-fns';
import { supabase } from '@/integrations/supabase/client';

// Shared choke point for bulk PDF exports across the Tenant/Landlord
// Calling Hub reports (TenantCallReportsPanel.tsx, LandlordCallReportsPanel.
// tsx) -- many rows of call/collection data leaving the system in one file,
// not logged before this. Plain client-side insert so the audit_logs
// IP-capture trigger sees the real browser IP directly. Never blocks the
// actual download.
async function logPdfExport(filename: string) {
  try {
    const { data: { user } } = await supabase.auth.getUser();
    await supabase.from('audit_logs').insert({
      user_id: user?.id ?? null,
      action_type: 'pdf_report_exported',
      table_name: 'export',
      record_id: null,
      metadata: { filename },
    });
  } catch (e) {
    console.warn('[tenantCallingHubPdf] audit log insert failed:', e);
  }
}

/**
 * Branded PDF for the Tenant Ops → Calling Hub reports.
 *
 * Presentation only: mirrors the exact house style used by the other Welile
 * report PDFs (purple header band, rounded KPI block, purple table headers,
 * zebra rows, native charts drawn with jsPDF primitives and the audit footer
 * repeated on every page). Content is Calling Hub specific.
 */

export interface CallingPdfKpi {
  label: string;
  value: string;
  hint?: string;
}

export interface CallingPdfSeriesPoint {
  /** yyyy-MM-dd */
  day: string;
  pending: number;
  closed: number;
  missed: number;
}

export interface CallingPdfShare {
  label: string;
  n: number;
  color: [number, number, number];
}

export interface CallingPdfTable {
  title: string;
  head: string[];
  /** Relative weights; normalised to the content width. */
  widths: number[];
  body: (string | number | null | undefined)[][];
  aligns?: ('left' | 'right')[];
  note?: string;
}

export interface CallingPdfComment {
  when: string;
  who: string;
  status: string;
  tenant: string;
  comment: string;
}

const BRAND: [number, number, number] = [88, 28, 135];
const num = (n: any) => Math.round(Number(n) || 0).toLocaleString('en-US');

export function generateTenantCallingHubPdf(opts: {
  reportTitle: string;
  subtitle: string;
  periodLabel: string;
  scopeLabel: string;
  filterLabel?: string;
  actor: string;
  kpis: CallingPdfKpi[];
  series?: CallingPdfSeriesPoint[];
  statusShare?: CallingPdfShare[];
  tables: CallingPdfTable[];
  comments?: CallingPdfComment[];
  generatedAt?: string;
  /** Hub name for the header/footer band — defaults to the tenant hub. */
  hubName?: string;
  /** Footer source line — defaults to the tenant call sources. */
  sourceNote?: string;
}): Blob {
  const hubName = opts.hubName || 'Tenant Calling Hub';
  const sourceNote = opts.sourceNote || 'Welile tenant call reports, rent requests & agent collections';

  const doc = new jsPDF({ orientation: 'landscape', unit: 'mm', format: 'a4' });
  const pageWidth = doc.internal.pageSize.getWidth();
  const pageHeight = doc.internal.pageSize.getHeight();
  const margin = 12;
  const contentWidth = pageWidth - margin * 2;
  let y = 14;

  const newPage = () => { doc.addPage(); y = 16; };
  const ensure = (h: number) => { if (y + h > pageHeight - 16) newPage(); };
  const fmtDay = (d: string) => { try { return format(new Date(`${d}T00:00:00`), 'dd MMM'); } catch { return d; } };

  // ===== Header band =====
  doc.setFillColor(BRAND[0], BRAND[1], BRAND[2]);
  doc.rect(0, 0, pageWidth, 26, 'F');
  doc.setTextColor(255, 255, 255);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(9);
  doc.text('WELILE', margin, 10);
  doc.setFontSize(13);
  doc.text(`${hubName.toUpperCase()} — ${opts.reportTitle.toUpperCase()}`, margin, 17.5);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(8);
  doc.text(`Period: ${opts.periodLabel}  ·  ${opts.subtitle}`, margin, 22.5);
  y = 33;

  doc.setTextColor(90, 90, 100);
  doc.setFontSize(7.5);
  doc.text(`Rows: ${opts.scopeLabel}${opts.filterLabel ? `  ·  Filter: ${opts.filterLabel}` : ''}`, margin, y);
  doc.text(`Reported by: ${opts.actor}`, pageWidth - margin, y, { align: 'right' });
  y += 6;

  // ===== KPI block =====
  if (opts.kpis.length) {
    const perRow = 4;
    const rowsN = Math.ceil(opts.kpis.length / perRow);
    const boxH = 8 + rowsN * 13;
    ensure(boxH + 4);
    doc.setDrawColor(225, 225, 235);
    doc.setFillColor(248, 246, 252);
    doc.roundedRect(margin, y, contentWidth, boxH, 2, 2, 'FD');
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(8);
    doc.setTextColor(BRAND[0], BRAND[1], BRAND[2]);
    doc.text('CALLING KPIs', margin + 3, y + 5.5);
    const cellW = (contentWidth - 6) / perRow;
    opts.kpis.forEach((k, i) => {
      const cx = margin + 3 + (i % perRow) * cellW;
      const cy = y + 12 + Math.floor(i / perRow) * 13;
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(7);
      doc.setTextColor(115, 115, 125);
      doc.text(k.label, cx, cy, { maxWidth: cellW - 4 });
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(11);
      doc.setTextColor(35, 35, 45);
      doc.text(k.value, cx, cy + 5.6, { maxWidth: cellW - 4 });
      if (k.hint) {
        doc.setFont('helvetica', 'normal');
        doc.setFontSize(6.4);
        doc.setTextColor(130, 130, 140);
        doc.text(k.hint, cx, cy + 9.4, { maxWidth: cellW - 4 });
      }
    });
    y += boxH + 5;
  }

  const sectionTitle = (t: string) => {
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(8.5);
    doc.setTextColor(BRAND[0], BRAND[1], BRAND[2]);
    doc.text(t, margin, y);
    y += 4;
  };

  // ===== Charts row: daily stacked bars + status donut =====
  const series = opts.series || [];
  const share = (opts.statusShare || []).filter(s => s.n > 0);
  if (series.length || share.length) {
    const chartH = 42;
    ensure(chartH + 16);
    const leftW = share.length ? contentWidth * 0.66 : contentWidth;

    if (series.length) {
      sectionTitle('CALLS PER DAY (stacked by status)');
      const top = y;
      doc.setDrawColor(230, 230, 238);
      doc.rect(margin, top, leftW, chartH);
      const max = Math.max(...series.map(s => s.pending + s.closed + s.missed), 1);
      const step = (leftW - 4) / series.length;
      const barW = Math.max(1.2, Math.min(10, step - 1.6));
      const stack: Array<[keyof CallingPdfSeriesPoint, [number, number, number]]> = [
        ['closed', [16, 145, 105]],
        ['pending', [217, 150, 20]],
        ['missed', [200, 45, 55]],
      ];
      series.forEach((s, i) => {
        const x = margin + 2 + i * step;
        let base = top + chartH - 2;
        stack.forEach(([key, color]) => {
          const v = Number(s[key]) || 0;
          if (!v) return;
          const h = (v / max) * (chartH - 6);
          doc.setFillColor(color[0], color[1], color[2]);
          doc.rect(x, base - h, barW, h, 'F');
          base -= h;
        });
      });
      // axis labels + legend
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(6.5);
      doc.setTextColor(120, 120, 130);
      doc.text(fmtDay(series[0].day), margin, top + chartH + 4);
      doc.text(`peak ${num(max)} calls/day`, margin + leftW / 2, top + chartH + 4, { align: 'center' });
      doc.text(fmtDay(series[series.length - 1].day), margin + leftW, top + chartH + 4, { align: 'right' });
      let lx = margin;
      const legend: Array<[string, [number, number, number]]> = [
        ['Closed', [16, 145, 105]], ['Pending', [217, 150, 20]], ['Missed', [200, 45, 55]],
      ];
      legend.forEach(([label, color]) => {
        doc.setFillColor(color[0], color[1], color[2]);
        doc.rect(lx, top + chartH + 6.4, 3, 3, 'F');
        doc.setTextColor(90, 90, 100);
        doc.text(label, lx + 4.2, top + chartH + 9);
        lx += 22;
      });
    }

    if (share.length) {
      const rightW = contentWidth - leftW;
      const rOuter = Math.min(chartH / 2 - 1, 17);
      const rInner = rOuter * 0.55;
      const cx = margin + contentWidth - rOuter - 3;
      const cy = y + chartH / 2;
      const total = share.reduce((a, b) => a + b.n, 0) || 1;
      let angle = -Math.PI / 2;
      share.forEach(s => {
        const sweep = (s.n / total) * Math.PI * 2;
        doc.setFillColor(s.color[0], s.color[1], s.color[2]);
        // Approximate the ring segment with thin radial slices.
        const steps = Math.max(2, Math.ceil((sweep / (Math.PI * 2)) * 90));
        for (let i = 0; i < steps; i += 1) {
          const a1 = angle + (sweep * i) / steps;
          const a2 = angle + (sweep * (i + 1)) / steps;
          doc.triangle(
            cx + rInner * Math.cos(a1), cy + rInner * Math.sin(a1),
            cx + rOuter * Math.cos(a1), cy + rOuter * Math.sin(a1),
            cx + rOuter * Math.cos(a2), cy + rOuter * Math.sin(a2),
            'F',
          );
          doc.triangle(
            cx + rInner * Math.cos(a1), cy + rInner * Math.sin(a1),
            cx + rOuter * Math.cos(a2), cy + rOuter * Math.sin(a2),
            cx + rInner * Math.cos(a2), cy + rInner * Math.sin(a2),
            'F',
          );
        }
        angle += sweep;
      });
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(8.5);
      doc.setTextColor(BRAND[0], BRAND[1], BRAND[2]);
      doc.text('STATUS MIX', margin + leftW + 4, y - 0.5);
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(6.6);
      let ly = y + 7;
      const legendMax = Math.max(20, rightW - rOuter * 2 - 12);
      share.forEach(s => {
        doc.setFillColor(s.color[0], s.color[1], s.color[2]);
        doc.rect(margin + leftW + 4, ly - 2.4, 3, 3, 'F');
        doc.setTextColor(90, 90, 100);
        doc.text(
          `${s.label} ${num(s.n)} (${((s.n / total) * 100).toFixed(1)}%)`,
          margin + leftW + 8.4,
          ly,
          { maxWidth: legendMax },
        );
        ly += 5;
      });
    }

    y += chartH + 18;

  }

  // ===== Tables =====
  const drawTable = (t: CallingPdfTable) => {
    const totalW = t.widths.reduce((a, b) => a + b, 0) || 1;
    const widths = t.widths.map(w => (w / totalW) * contentWidth);
    const aligns = t.aligns || [];
    const header = () => {
      doc.setFillColor(BRAND[0], BRAND[1], BRAND[2]);
      doc.rect(margin, y, contentWidth, 6, 'F');
      doc.setTextColor(255, 255, 255);
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(7.2);
      let x = margin + 2;
      t.head.forEach((h, i) => {
        const align = aligns[i] === 'right' ? 'right' : 'left';
        doc.text(h, align === 'right' ? x + widths[i] - 4 : x, y + 4, { align });
        x += widths[i];
      });
      y += 6;
      doc.setFont('helvetica', 'normal');
      doc.setTextColor(35, 35, 45);
    };

    ensure(18);
    sectionTitle(t.title);
    if (t.note) {
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(6.6);
      doc.setTextColor(125, 125, 135);
      doc.text(t.note, margin, y);
      y += 3.6;
    }
    header();
    t.body.forEach((r, idx) => {
      if (y + 5 > pageHeight - 16) { newPage(); header(); }
      if (idx % 2 === 1) {
        doc.setFillColor(248, 248, 252);
        doc.rect(margin, y, contentWidth, 5, 'F');
      }
      let cx = margin + 2;
      r.forEach((cell, i) => {
        const align = aligns[i] === 'right' ? 'right' : 'left';
        const text = String(cell ?? '');
        const maxChars = Math.floor(widths[i] / 1.45);
        const shown = text.length > maxChars ? `${text.slice(0, Math.max(1, maxChars - 1))}…` : text;
        doc.setFontSize(6.9);
        doc.setTextColor(35, 35, 45);
        doc.text(shown, align === 'right' ? cx + widths[i] - 4 : cx, y + 3.5, { align });
        cx += widths[i];
      });
      y += 5;
    });
    y += 5;
  };

  opts.tables.filter(t => t.body.length).forEach(drawTable);

  // ===== Comment narrative =====
  if (opts.comments?.length) {
    ensure(16);
    sectionTitle(`CALL COMMENTS (${num(opts.comments.length)})`);
    doc.setFont('helvetica', 'normal');
    opts.comments.forEach(c => {
      const lines = doc.splitTextToSize(c.comment, contentWidth - 6) as string[];
      const blockH = 4.4 + lines.length * 3.4 + 2;
      if (y + blockH > pageHeight - 16) newPage();
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(6.9);
      doc.setTextColor(BRAND[0], BRAND[1], BRAND[2]);
      doc.text(`${c.tenant} · ${c.status} · ${c.when} · ${c.who}`, margin, y, { maxWidth: contentWidth });
      y += 3.8;
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(6.9);
      doc.setTextColor(45, 45, 55);
      lines.forEach(l => { doc.text(l, margin + 3, y); y += 3.4; });
      y += 2.2;
    });
  }

  // ===== Audit footer on every page =====
  const pages = doc.getNumberOfPages();
  const generated = (() => {
    try { return format(opts.generatedAt ? new Date(opts.generatedAt) : new Date(), 'dd MMM yyyy HH:mm:ss'); }
    catch { return opts.generatedAt || ''; }
  })();
  for (let p = 1; p <= pages; p += 1) {
    doc.setPage(p);
    doc.setDrawColor(230, 230, 238);
    doc.line(margin, pageHeight - 12, pageWidth - margin, pageHeight - 12);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(6.5);
    doc.setTextColor(120, 120, 130);
    doc.text(
      `${hubName} — ${opts.reportTitle} · Period ${opts.periodLabel} · Rows ${opts.scopeLabel} · Generated ${generated} · Reported by ${opts.actor} · Export PDF · Source: ${sourceNote}`,
      margin,
      pageHeight - 8,
      { maxWidth: contentWidth },
    );
    doc.text(`Page ${p} of ${pages}`, pageWidth - margin, pageHeight - 4, { align: 'right' });
  }

  return doc.output('blob');
}

/** Trigger a browser download for a generated PDF blob. */
export function downloadPdfBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);

  void logPdfExport(filename);
}
