// html2canvas (~200 KB) and jspdf (~340 KB) are loaded on demand inside
// renderAgreementPdfBase64 — this module is imported by contract screens that
// must paint long before anyone asks for a PDF.

// Rasterise the SAME filled contract HTML the admin previews into a multi-page
// A4 PDF. Each `.page-section` becomes its own page, so the stored/emailed PDF
// is pixel-identical to the on-screen preview (single HTML -> PDF pipeline).
async function waitForImages(root: ParentNode): Promise<void> {
  const imgs = Array.from(root.querySelectorAll('img'));
  await Promise.all(
    imgs.map((img) =>
      img.complete && img.naturalWidth > 0
        ? Promise.resolve()
        : new Promise<void>((resolve) => {
            img.addEventListener('load', () => resolve(), { once: true });
            img.addEventListener('error', () => resolve(), { once: true });
          }),
    ),
  );
}

// Extract the <body> inner HTML + collected <style> blocks so we can mount the
// contract inside the parent document (html2canvas rasterises off-screen
// iframes as blank pages in most browsers — see uploaded blank PDF report).
function splitAgreementHtml(html: string): { styles: string; body: string } {
  const styleMatches = Array.from(html.matchAll(/<style[^>]*>[\s\S]*?<\/style>/gi)).map((m) => m[0]);
  const bodyMatch = html.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
  return {
    styles: styleMatches.join('\n'),
    body: bodyMatch ? bodyMatch[1] : html,
  };
}

/** Remove every `@media ... { ... }` block (balanced braces). */
function stripMediaBlocks(css: string): string {
  let out = '';
  let i = 0;
  while (i < css.length) {
    const at = css.indexOf('@media', i);
    if (at === -1) { out += css.slice(i); break; }
    out += css.slice(i, at);
    const open = css.indexOf('{', at);
    if (open === -1) break;
    let depth = 1;
    let j = open + 1;
    while (j < css.length && depth > 0) {
      if (css[j] === '{') depth++;
      else if (css[j] === '}') depth--;
      j++;
    }
    i = j;
  }
  return out;
}

/**
 * Confine a full-page stylesheet (html/body/:root/* rules) to the off-screen
 * print root, so mounting it does not restyle the running app, and drop media
 * queries so the phone viewport cannot trigger the responsive rules.
 */
export function scopeStylesToRoot(styles: string): string {
  const ROOT = '.agreement-print-root';
  return stripMediaBlocks(styles)
    .replace(/:root\s*\{/g, `${ROOT} {`)
    .replace(/(^|[}\s])html\s*,\s*body\s*\{/g, `$1${ROOT} {`)
    .replace(
      /\*\s*,\s*\*::before\s*,\s*\*::after\s*\{/g,
      `${ROOT} *, ${ROOT} *::before, ${ROOT} *::after {`,
    );
}

const REPORT_FONTS_HREF =
  'https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700;800;900&family=JetBrains+Mono:wght@400;500;600;700&display=swap';

/**
 * The report templates are set in Inter / JetBrains Mono. The print window loads
 * them itself, but the off-screen render lives in the app page, so load them
 * here too (best effort, bounded) or the PDF falls back to a system font and
 * stops matching the template.
 */
async function ensureReportFonts(): Promise<void> {
  try {
    if (!document.querySelector('link[data-welile-report-fonts]')) {
      const link = document.createElement('link');
      link.rel = 'stylesheet';
      link.href = REPORT_FONTS_HREF;
      link.setAttribute('data-welile-report-fonts', '');
      document.head.appendChild(link);
    }
    const fonts = (document as any).fonts;
    if (!fonts?.load) return;
    const wanted = [
      '400 10px Inter', '500 10px Inter', '600 10px Inter', '700 10px Inter', '800 10px Inter', '900 10px Inter',
      '400 10px "JetBrains Mono"', '600 10px "JetBrains Mono"', '700 10px "JetBrains Mono"',
    ];
    await Promise.race([
      Promise.all(wanted.map((f) => fonts.load(f).catch(() => null))),
      new Promise((r) => setTimeout(r, 4000)),
    ]);
  } catch { /* fall back to system fonts */ }
}

/**
 * Pin each report page to exactly A4 on screen (the template centres a fluid
 * page inside a padded wrapper), so the raster is the page itself, edge to
 * edge, with no wrapper padding or shadow around it.
 */
const REPORT_PAGE_OVERRIDES = `<style>
.agreement-print-root .document-wrapper { width: 210mm; max-width: 210mm; margin: 0; padding: 0; }
.agreement-print-root .report-page { width: 210mm; max-width: 210mm; margin: 0; box-shadow: none; }
</style>`;

async function renderToPdf(
  html: string,
  opts?: { format?: 'a4' | 'letter'; scopeStyles?: boolean },
) {
  const format = opts?.format ?? 'a4';
  const [{ default: html2canvas }, { jsPDF }] = await Promise.all([
    import('html2canvas'),
    import('jspdf'),
  ]);
  // Mount the contract inside the parent document (off-screen but in-layout)
  // so html2canvas can walk real computed styles. Rendering into an off-screen
  // <iframe> produced blank pages on Chromium/WebKit.
  const split = splitAgreementHtml(html);
  const styles = opts?.scopeStyles ? scopeStylesToRoot(split.styles) : split.styles;
  const body = split.body;
  const overrides = opts?.scopeStyles ? REPORT_PAGE_OVERRIDES : '';
  if (opts?.scopeStyles) await ensureReportFonts();

  const host = document.createElement('div');
  host.setAttribute('aria-hidden', 'true');
  host.style.cssText = [
    'position:fixed',
    'left:-10000px',
    'top:0',
    'width:900px',
    'background:#ffffff',
    'z-index:-1',
    'pointer-events:none',
  ].join(';');
  host.innerHTML = `${styles}${overrides}<div class="agreement-print-root" style="width:900px;background:#ffffff;">${body}</div>`;
  document.body.appendChild(host);

  try {
    // Allow layout + webfonts/images to settle.
    await new Promise((r) => setTimeout(r, 150));
    await waitForImages(host);
    if ((document as any).fonts?.ready) {
      try { await (document as any).fonts.ready; } catch { /* ignore */ }
    }

    const sections = Array.from(host.querySelectorAll<HTMLElement>('.page-section, .report-page'));
    const targets = sections.length
      ? sections
      : [host.querySelector<HTMLElement>('.document-wrapper') || (host.firstElementChild as HTMLElement) || host];

    const pdf = new jsPDF({ orientation: 'portrait', unit: 'mm', format });
    const pageW = pdf.internal.pageSize.getWidth();
    const pageH = pdf.internal.pageSize.getHeight();
    // Reports are already laid out as full A4 pages (with their own padding), so
    // they go on edge to edge; the contract keeps its 8mm page margin.
    const margin = opts?.scopeStyles ? 0 : 8;
    const maxW = pageW - margin * 2;
    const maxH = pageH - margin * 2;

    for (let i = 0; i < targets.length; i++) {
      const canvas = await html2canvas(targets[i], {
        scale: 2,
        backgroundColor: '#ffffff',
        useCORS: true,
        logging: false,
        windowWidth: 900,
      });
      const imgData = canvas.toDataURL('image/jpeg', 0.92);

      let w = maxW;
      let h = (canvas.height / canvas.width) * w;
      if (h > maxH) {
        h = maxH;
        w = (canvas.width / canvas.height) * h;
      }
      const x = (pageW - w) / 2;
      const y = margin;
      if (i > 0) pdf.addPage();
      pdf.addImage(imgData, 'JPEG', x, y, w, h, undefined, 'FAST');
    }

    return pdf;
  } finally {
    document.body.removeChild(host);
  }
}

/** Returns the rendered contract as a base64 (no data: prefix) PDF string. */
export async function renderAgreementPdfBase64(
  html: string,
  opts?: { format?: 'a4' | 'letter' },
): Promise<string> {
  const pdf = await renderToPdf(html, opts);
  const dataUri = pdf.output('datauristring');
  const comma = dataUri.indexOf(',');
  return comma >= 0 ? dataUri.slice(comma + 1) : dataUri;
}

/**
 * Rasterise a report built from `.report-page` articles into a PDF blob, one
 * A4 page per article. The report's own stylesheet is confined to the
 * off-screen root while it renders.
 */
export async function renderReportPdfBlob(html: string): Promise<Blob> {
  const pdf = await renderToPdf(html, { scopeStyles: true });
  return pdf.output('blob');
}
