// Renders the approved report HTML to PDF as-is.
//
// No redesign happens here: the HTML produced by
// `buildAgentOpsComprehensiveReportHtml` is parsed and walked in document
// order, and each node is drawn with the equivalent PDF primitive
// (headings -> headings, tables -> tables, paragraphs -> paragraphs,
// <article> -> one page). Nothing is added, removed or reordered.

import { DOMParser, type Element } from 'https://deno.land/x/deno_dom@v0.1.45/deno-dom-wasm.ts';
import { jsPDF } from 'https://esm.sh/jspdf@2.5.1';
import autoTable from 'https://esm.sh/jspdf-autotable@3.8.2';

type RGB = [number, number, number];
const BRAND: RGB = [108, 33, 196];
const INK: RGB = [30, 27, 46];
const MUTED: RGB = [120, 116, 132];
const BORDER: RGB = [230, 225, 240];

const text = (el: Element | null | undefined) =>
  (el?.textContent ?? '').replace(/\s+/g, ' ').trim();

const isBlock = (tag: string) =>
  ['DIV', 'P', 'H1', 'H2', 'H3', 'H4', 'TABLE', 'UL', 'OL', 'LI', 'SECTION', 'HEADER', 'FOOTER', 'ARTICLE'].includes(tag);

interface Ctx {
  doc: any;
  margin: number;
  width: number;
  height: number;
  y: number;
}

function ensureSpace(ctx: Ctx, needed: number) {
  if (ctx.y + needed > ctx.height - ctx.margin - 8) {
    ctx.doc.addPage();
    ctx.y = ctx.margin;
  }
}

function writeText(
  ctx: Ctx,
  value: string,
  opts: { size: number; bold?: boolean; color?: RGB; gapBefore?: number; gapAfter?: number; upper?: boolean },
) {
  if (!value) return;
  const { doc } = ctx;
  const body = opts.upper ? value.toUpperCase() : value;
  doc.setFont('helvetica', opts.bold ? 'bold' : 'normal');
  doc.setFontSize(opts.size);
  doc.setTextColor(...(opts.color ?? INK));
  const lines: string[] = doc.splitTextToSize(body, ctx.width - ctx.margin * 2);
  const lineHeight = opts.size * 0.42;
  ctx.y += opts.gapBefore ?? 0;
  ensureSpace(ctx, lines.length * lineHeight);
  for (const line of lines) {
    ctx.y += lineHeight;
    doc.text(line, ctx.margin, ctx.y);
  }
  ctx.y += opts.gapAfter ?? 2;
}

function rowCells(row: Element) {
  return Array.from(row.querySelectorAll('th,td')).map((c) => {
    const cell = c as unknown as Element;
    const span = Number(cell.getAttribute('colspan') || 1) || 1;
    const cls = cell.getAttribute('class') || '';
    return {
      content: text(cell),
      colSpan: span,
      styles: {
        halign: cls.includes('right') ? 'right' : cell.tagName === 'TH' ? 'left' : 'left',
        fontStyle: cell.tagName === 'TH' ? 'bold' : 'normal',
      } as Record<string, unknown>,
    };
  });
}

function renderTable(ctx: Ctx, table: Element) {
  const headRows = Array.from(table.querySelectorAll('thead tr')).map((r) => rowCells(r as unknown as Element));
  const bodySource = table.querySelectorAll('tbody tr').length
    ? Array.from(table.querySelectorAll('tbody tr'))
    : Array.from(table.querySelectorAll('tr')).filter(
        (r) => !((r as unknown as Element).closest('thead') || (r as unknown as Element).closest('tfoot')),
      );
  const bodyRows = bodySource.map((r) => rowCells(r as unknown as Element));
  const footRows = Array.from(table.querySelectorAll('tfoot tr')).map((r) => rowCells(r as unknown as Element));
  if (!headRows.length && !bodyRows.length && !footRows.length) return;

  const isMeta = (table.getAttribute('class') || '').includes('pdf-header-meta-table');

  autoTable(ctx.doc, {
    startY: ctx.y + 3,
    head: headRows.length ? headRows : undefined,
    body: [...bodyRows, ...footRows],
    theme: isMeta ? 'plain' : 'grid',
    styles: { fontSize: isMeta ? 8.5 : 8, cellPadding: isMeta ? 1.2 : 1.8, textColor: INK, lineColor: BORDER, lineWidth: isMeta ? 0 : 0.1, overflow: 'linebreak' },
    headStyles: { fillColor: BRAND, textColor: [255, 255, 255], fontStyle: 'bold', fontSize: 8 },
    alternateRowStyles: { fillColor: [250, 248, 255] },
    margin: { left: ctx.margin, right: ctx.margin },
    tableWidth: isMeta ? 'wrap' : 'auto',
  });
  ctx.y = (ctx.doc as any).lastAutoTable.finalY + 3;
}

function walk(ctx: Ctx, el: Element) {
  const children = Array.from(el.children) as unknown as Element[];
  const hasBlockChild = children.some((c) => isBlock(c.tagName));

  if (!hasBlockChild) {
    const cls = el.getAttribute('class') || '';
    const value = text(el);
    if (!value) return;
    if (cls.includes('company-name')) return writeText(ctx, value, { size: 8.5, bold: true, color: MUTED, upper: true, gapAfter: 1 });
    if (cls.includes('report-title-main') || el.tagName === 'H1') return writeText(ctx, value, { size: 15, bold: true, color: BRAND, gapAfter: 3 });
    if (cls.includes('section-title') || el.tagName === 'H2') return writeText(ctx, value, { size: 10.5, bold: true, color: BRAND, upper: true, gapBefore: 3, gapAfter: 1 });
    if (el.tagName === 'H3' || el.tagName === 'H4') return writeText(ctx, value, { size: 9.5, bold: true, gapBefore: 2, gapAfter: 1 });
    if (cls.includes('section-subtitle') || el.tagName === 'FOOTER') return writeText(ctx, value, { size: 7.5, color: MUTED, gapAfter: 2 });
    if (el.tagName === 'LI') return writeText(ctx, `•  ${value}`, { size: 8.5, gapAfter: 0.5 });
    return writeText(ctx, value, { size: 8.5, gapAfter: 2 });
  }

  for (const child of children) {
    if (child.tagName === 'TABLE') renderTable(ctx, child);
    else if (child.tagName === 'ARTICLE') {
      ctx.doc.addPage();
      ctx.y = ctx.margin;
      walk(ctx, child);
    } else walk(ctx, child);
  }
}

export function renderReportHtmlToPdf(html: string): Uint8Array {
  const dom = new DOMParser().parseFromString(html, 'text/html');
  if (!dom) throw new Error('Could not parse report HTML');

  const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });
  const ctx: Ctx = {
    doc,
    margin: 12,
    width: doc.internal.pageSize.getWidth(),
    height: doc.internal.pageSize.getHeight(),
    y: 12,
  };

  const articles = Array.from(dom.querySelectorAll('article')) as unknown as Element[];
  if (articles.length) {
    articles.forEach((article, i) => {
      if (i > 0) {
        doc.addPage();
        ctx.y = ctx.margin;
      }
      walk(ctx, article);
    });
  } else {
    const body = dom.querySelector('body') as unknown as Element | null;
    if (body) walk(ctx, body);
  }

  // Page numbers, mirroring the HTML footer.
  const pages = doc.getNumberOfPages();
  for (let p = 1; p <= pages; p += 1) {
    doc.setPage(p);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(7);
    doc.setTextColor(...MUTED);
    doc.text(`Page ${p} of ${pages}`, ctx.width - ctx.margin, ctx.height - 6, { align: 'right' });
  }

  return new Uint8Array(doc.output('arraybuffer'));
}
