import jsPDF from 'jspdf';
import { format } from 'date-fns';
import { supabase } from '@/integrations/supabase/client';

// Shared choke point for bulk PDF extracts across tenant-ops reports
// (TenantOpsDashboard's applied/approved/funded/collected/expected reports,
// the active-tenants report, and the daily collection monitoring export) --
// many rows of tenant/financial data leaving the system in one file, not
// logged before this. Plain client-side insert so the audit_logs
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
    console.warn('[generateTenantOpsExtractPdf] audit log insert failed:', e);
  }
}

export interface ExtractColumn {
  label: string;
  width: number;            // mm
  align?: 'left' | 'right';
  format?: 'number' | 'ugx' | 'date' | 'datetime' | 'text';
}

export interface ExtractKpi {
  label: string;
  value: string;
  color?: [number, number, number];
}

export interface ExtractSection {
  /** Heading rendered above the table. */
  title: string;
  /** Optional one-line note under the heading. */
  note?: string;
  columns: ExtractColumn[];
  rows: (string | number | null | undefined)[][];
  totals?: (string | number | null | undefined)[];
}

export interface ExtractPdfOptions {
  title: string;
  subtitle?: string;
  range?: { from?: Date | null; to?: Date | null };
  kpis?: ExtractKpi[];
  /** Single-table mode (kept for existing reports). */
  columns?: ExtractColumn[];
  rows?: (string | number | null | undefined)[][];
  /** Optional totals row appended after data rows (will be styled). */
  totals?: (string | number | null | undefined)[];
  /** Multi-table mode — each section gets its own heading and table. */
  sections?: ExtractSection[];
  footerNote?: string;
}


export function generateTenantOpsExtractPdf(opts: ExtractPdfOptions): Blob {
  const doc = new jsPDF({ orientation: 'landscape', unit: 'mm', format: 'a4' });
  const pageWidth = doc.internal.pageSize.getWidth();   // 297
  const pageHeight = doc.internal.pageSize.getHeight(); // 210
  const margin = 12;
  const contentWidth = pageWidth - margin * 2;
  let y = 14;

  const num = (n: any) => {
    const v = Number(n);
    return Number.isFinite(v) ? Math.round(v).toLocaleString() : String(n ?? '');
  };
  const ugx = (n: any) => `UGX ${num(n)}`;
  const fmtDate = (d: any) => { try { return format(new Date(d), 'dd MMM yyyy'); } catch { return String(d ?? ''); } };
  const fmtDateTime = (d: any) => { try { return format(new Date(d), 'dd MMM yyyy HH:mm'); } catch { return String(d ?? ''); } };

  const formatCell = (v: any, fmt?: ExtractColumn['format']) => {
    if (v === null || v === undefined || v === '') return '';
    switch (fmt) {
      case 'number': return num(v);
      case 'ugx': return ugx(v);
      case 'date': return fmtDate(v);
      case 'datetime': return fmtDateTime(v);
      default: return String(v);
    }
  };

  // ===== Header =====
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(11);
  doc.setTextColor(20, 40, 120);
  doc.text('WELILE', margin, y);

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(8);
  doc.setTextColor(100, 100, 100);
  doc.text(format(new Date(), 'dd MMM yyyy, hh:mm a'), pageWidth - margin, y, { align: 'right' });

  y += 8;
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(18);
  doc.setTextColor(15, 23, 42);
  doc.text(opts.title, margin, y);

  if (opts.subtitle) {
    y += 5;
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(8.5);
    doc.setTextColor(110, 110, 120);
    doc.text(opts.subtitle, margin, y, { maxWidth: contentWidth });
  }

  if (opts.range && (opts.range.from || opts.range.to)) {
    y += 4.5;
    doc.setFont('helvetica', 'italic');
    doc.setFontSize(8);
    doc.setTextColor(110, 110, 120);
    doc.text(
      `Period: ${opts.range.from ? fmtDate(opts.range.from) : 'Start'} → ${opts.range.to ? fmtDate(opts.range.to) : 'Today'}`,
      margin,
      y,
    );
  }

  y += 4;
  doc.setDrawColor(225, 227, 232);
  doc.setLineWidth(0.3);
  doc.line(margin, y, pageWidth - margin, y);
  y += 6;

  // ===== KPI cards =====
  if (opts.kpis && opts.kpis.length > 0) {
    const n = opts.kpis.length;
    const gap = 3;
    const cardH = 16;
    const itemsPerRow = n > 6 ? 4 : n;
    const rowCount = Math.ceil(n / itemsPerRow);
    const rowGap = 4;

    for (let idx = 0; idx < n; idx++) {
      const row = Math.floor(idx / itemsPerRow);
      const col = idx % itemsPerRow;
      const itemsInThisRow = Math.min(itemsPerRow, n - row * itemsPerRow);
      const cardW = (contentWidth - gap * (itemsInThisRow - 1)) / itemsInThisRow;
      const x = margin + col * (cardW + gap);
      const cardY = y + row * (cardH + rowGap);

      doc.setFillColor(248, 249, 252);
      doc.setDrawColor(225, 227, 232);
      doc.setLineWidth(0.2);
      (doc as any).roundedRect(x, cardY, cardW, cardH, 2, 2, 'FD');
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(7);
      doc.setTextColor(120, 122, 135);
      doc.text(opts.kpis[idx].label.toUpperCase(), x + 4, cardY + 5.5);
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(12);
      const c = opts.kpis[idx].color ?? [15, 23, 42];
      doc.setTextColor(c[0], c[1], c[2]);
      doc.text(opts.kpis[idx].value, x + 4, cardY + 12.5);
    }
    y += rowCount * (cardH + rowGap) + 2;
  }

  // ===== Tables =====
  const sections: ExtractSection[] = opts.sections && opts.sections.length
    ? opts.sections
    : [{ title: '', columns: opts.columns ?? [], rows: opts.rows ?? [], totals: opts.totals }];

  const rowH = 6.5;
  const bottomLimit = pageHeight - 14;

  sections.forEach((section, sIdx) => {
    if (!section.columns.length) return;

    // Scale column widths to content width.
    const totalDeclared = section.columns.reduce((s, c) => s + c.width, 0) || 1;
    const scale = contentWidth / totalDeclared;
    const colXs: number[] = [];
    const colWs: number[] = [];
    let cursor = margin;
    section.columns.forEach(c => {
      const w = c.width * scale;
      colXs.push(cursor);
      colWs.push(w);
      cursor += w;
    });

    const drawTableHeader = () => {
      doc.setFillColor(146, 52, 234);
      doc.rect(margin, y, contentWidth, 7.5, 'F');
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(8);
      doc.setTextColor(255, 255, 255);
      section.columns.forEach((c, i) => {
        const align = c.align ?? (c.format === 'number' || c.format === 'ugx' ? 'right' : 'left');
        const tx = align === 'right' ? colXs[i] + colWs[i] - 2 : colXs[i] + 2;
        doc.text(c.label, tx, y + 5, { align });
      });
      y += 7.5;
    };

    const drawSectionTitle = () => {
      if (!section.title) return;
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(10);
      doc.setTextColor(15, 23, 42);
      doc.text(section.title, margin, y + 3.5);
      y += 6;
      if (section.note) {
        doc.setFont('helvetica', 'normal');
        doc.setFontSize(7.5);
        doc.setTextColor(120, 122, 135);
        doc.text(section.note, margin, y + 1, { maxWidth: contentWidth });
        y += 4;
      }
    };

    if (sIdx > 0) y += 4;
    // Keep the heading with at least a couple of rows.
    if (y + (section.title ? 10 : 0) + 7.5 + rowH * 2 > bottomLimit) {
      doc.addPage();
      y = 14;
    }
    drawSectionTitle();
    drawTableHeader();

    doc.setFont('helvetica', 'normal');
    doc.setFontSize(8);

    if (!section.rows.length) {
      doc.setFont('helvetica', 'italic');
      doc.setTextColor(130, 132, 145);
      doc.text('No records for the selected period.', margin + 2, y + rowH - 2);
      y += rowH + 2;
    }

    section.rows.forEach((row, i) => {
      if (y + rowH > bottomLimit) {
        doc.addPage();
        y = 14;
        drawTableHeader();
        doc.setFont('helvetica', 'normal');
        doc.setFontSize(8);
      }
      if (i % 2 === 1) {
        doc.setFillColor(248, 249, 252);
        doc.rect(margin, y, contentWidth, rowH, 'F');
      }
      doc.setDrawColor(232, 234, 240);
      doc.setLineWidth(0.12);
      doc.line(margin, y + rowH, margin + contentWidth, y + rowH);

      const baseline = y + rowH - 2;
      section.columns.forEach((c, ci) => {
        const align = c.align ?? (c.format === 'number' || c.format === 'ugx' ? 'right' : 'left');
        const text = formatCell(row[ci], c.format);
        const maxChars = Math.max(6, Math.floor(colWs[ci] / 1.6));
        const trimmed = text.length > maxChars ? text.slice(0, maxChars - 1) + '…' : text;
        const tx = align === 'right' ? colXs[ci] + colWs[ci] - 2 : colXs[ci] + 2;
        doc.setTextColor(40, 47, 70);
        doc.text(trimmed, tx, baseline, { align });
      });
      y += rowH;
    });

    // Totals row
    if (section.totals && section.totals.length === section.columns.length) {
      if (y + rowH + 2 > bottomLimit) { doc.addPage(); y = 14; drawTableHeader(); }
      doc.setFillColor(243, 244, 248);
      doc.rect(margin, y, contentWidth, rowH + 1, 'F');
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(8.5);
      doc.setTextColor(15, 23, 42);
      const baseline = y + rowH - 1.5;
      section.columns.forEach((c, ci) => {
        const align = c.align ?? (c.format === 'number' || c.format === 'ugx' ? 'right' : 'left');
        const text = formatCell(section.totals![ci], c.format);
        const tx = align === 'right' ? colXs[ci] + colWs[ci] - 2 : colXs[ci] + 2;
        doc.text(text, tx, baseline, { align });
      });
      y += rowH + 4;
    } else {
      y += 3;
    }
  });


  if (opts.footerNote) {
    if (y + 8 > bottomLimit) { doc.addPage(); y = 14; }
    doc.setFont('helvetica', 'italic');
    doc.setFontSize(7.5);
    doc.setTextColor(120, 122, 135);
    doc.text(opts.footerNote, margin, y, { maxWidth: contentWidth });
  }

  // Page footer
  const pageCount = (doc as any).internal.getNumberOfPages();
  for (let p = 1; p <= pageCount; p++) {
    doc.setPage(p);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(7);
    doc.setTextColor(150, 150, 158);
    doc.text(`Generated by Welile Technologies Ltd. • ${format(new Date(), 'PPpp')}`, margin, pageHeight - 6);
    doc.text(`Page ${p} of ${pageCount}`, pageWidth - margin, pageHeight - 6, { align: 'right' });
  }

  return doc.output('blob');
}

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