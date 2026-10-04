/**
 * Dependency-free PDF writer for plain monospace text pages.
 * Deliberately minimal so it runs unchanged inside the Deno edge runtime
 * (no browser/Node APIs, no npm packages).
 */

const PAGE_W = 595.28; // A4 portrait, points
const PAGE_H = 841.89;
const MARGIN = 40;
const FONT_SIZE = 8.5;
const LINE_H = 11.5;
const LINES_PER_PAGE = Math.floor((PAGE_H - MARGIN * 2) / LINE_H);

function escapeText(text: string): string {
  // Latin-1 only (WinAnsi); drop anything the base font cannot encode.
  return text
    .replace(/[^\x20-\x7E]/g, " ")
    .replace(/\\/g, "\\\\")
    .replace(/\(/g, "\\(")
    .replace(/\)/g, "\\)");
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out.length ? out : [[]];
}

/** Render monospace text lines into a multi-page PDF. Returns raw PDF bytes. */
export function textPdf(lines: string[]): Uint8Array {
  const pages = chunk(lines, LINES_PER_PAGE);
  const objects: string[] = [];
  const add = (body: string) => {
    objects.push(body);
    return objects.length; // 1-based object number
  };

  const fontNo = add("<< /Type /Font /Subtype /Type1 /BaseFont /Courier /Encoding /WinAnsiEncoding >>");
  const pagesNo = objects.length + 1;
  objects.push(""); // placeholder for the Pages node

  const pageNos: number[] = [];
  pages.forEach((pageLines) => {
    const ops = pageLines
      .map((line, i) => {
        const y = PAGE_H - MARGIN - (i + 1) * LINE_H;
        return `BT /F1 ${FONT_SIZE} Tf 1 0 0 1 ${MARGIN} ${y.toFixed(2)} Tm (${escapeText(line)}) Tj ET`;
      })
      .join("\n");
    const streamNo = add(`<< /Length ${ops.length} >>\nstream\n${ops}\nendstream`);
    pageNos.push(
      add(
        `<< /Type /Page /Parent ${pagesNo} 0 R /MediaBox [0 0 ${PAGE_W} ${PAGE_H}] ` +
          `/Resources << /Font << /F1 ${fontNo} 0 R >> >> /Contents ${streamNo} 0 R >>`,
      ),
    );
  });

  objects[pagesNo - 1] =
    `<< /Type /Pages /Count ${pageNos.length} /Kids [${pageNos.map((n) => `${n} 0 R`).join(" ")}] >>`;
  const catalogNo = add(`<< /Type /Catalog /Pages ${pagesNo} 0 R >>`);

  let pdf = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(pdf.length);
    pdf += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xrefStart = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  offsets.forEach((off) => {
    pdf += `${String(off).padStart(10, "0")} 00000 n \n`;
  });
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root ${catalogNo} 0 R >>\nstartxref\n${xrefStart}\n%%EOF`;

  const bytes = new Uint8Array(pdf.length);
  for (let i = 0; i < pdf.length; i++) bytes[i] = pdf.charCodeAt(i) & 0xff;
  return bytes;
}