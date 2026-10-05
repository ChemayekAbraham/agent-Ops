/**
 * Turns a standalone report HTML document (the exact same markup the on-screen
 * iframe preview shows) into a multi-page A4 PDF, so preview and download match.
 *
 * html2canvas (~200 KB) and jspdf (~340 KB) are imported on demand — report
 * screens must paint long before anyone asks for a PDF.
 *
 * Rendering is done from a host mounted in the parent document (off-screen but
 * in layout): html2canvas rasterises off-screen iframes as blank pages on most
 * browsers, which is why the same approach is used for partner contracts.
 */

function splitHtml(html: string): { styles: string; body: string } {
  const styles = Array.from(html.matchAll(/<style[^>]*>[\s\S]*?<\/style>/gi))
    .map((m) => m[0])
    .join('\n');
  const bodyMatch = html.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
  return { styles, body: bodyMatch ? bodyMatch[1] : html };
}

/** Renders the report HTML and saves it as an A4 PDF. */
export async function downloadReportPdf(html: string, filename: string): Promise<void> {
  const [{ default: html2canvas }, { jsPDF }] = await Promise.all([
    import('html2canvas'),
    import('jspdf'),
  ]);

  const { styles, body } = splitHtml(html);
  const RENDER_WIDTH = 794; // ~210mm at 96dpi

  const host = document.createElement('div');
  host.setAttribute('aria-hidden', 'true');
  host.style.cssText = [
    'position:fixed',
    'left:-10000px',
    'top:0',
    `width:${RENDER_WIDTH}px`,
    'background:#ffffff',
    'z-index:-1',
    'pointer-events:none',
  ].join(';');
  host.innerHTML = `${styles}<div class="report-print-root" style="width:${RENDER_WIDTH}px;background:#ffffff;">${body}</div>`;
  document.body.appendChild(host);

  try {
    // Neutralise the screen-only page frame so the capture is edge-to-edge.
    host.querySelectorAll<HTMLElement>('.page').forEach((el) => {
      el.style.width = '100%';
      el.style.minHeight = '0';
      el.style.margin = '0';
      el.style.boxShadow = 'none';
      el.style.padding = '24px';
    });

    await new Promise((r) => setTimeout(r, 150));
    if ((document as unknown as { fonts?: { ready?: Promise<unknown> } }).fonts?.ready) {
      try {
        await (document as unknown as { fonts: { ready: Promise<unknown> } }).fonts.ready;
      } catch {
        /* ignore font loading failures */
      }
    }

    const target = host.querySelector<HTMLElement>('.page') || (host.firstElementChild as HTMLElement) || host;
    const canvas = await html2canvas(target, {
      scale: 2,
      backgroundColor: '#ffffff',
      useCORS: true,
      logging: false,
      windowWidth: RENDER_WIDTH,
    });

    const pdf = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });
    const pageW = pdf.internal.pageSize.getWidth();
    const pageH = pdf.internal.pageSize.getHeight();
    const margin = 6;
    const usableW = pageW - margin * 2;
    const usableH = pageH - margin * 2;

    // Slice the tall capture into page-height strips.
    const pxPerMm = canvas.width / usableW;
    const sliceHeight = Math.floor(usableH * pxPerMm);
    let offset = 0;
    let page = 0;

    while (offset < canvas.height) {
      const height = Math.min(sliceHeight, canvas.height - offset);
      const slice = document.createElement('canvas');
      slice.width = canvas.width;
      slice.height = height;
      const ctx = slice.getContext('2d');
      if (!ctx) break;
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, slice.width, slice.height);
      ctx.drawImage(canvas, 0, offset, canvas.width, height, 0, 0, canvas.width, height);

      if (page > 0) pdf.addPage();
      pdf.addImage(slice.toDataURL('image/jpeg', 0.92), 'JPEG', margin, margin, usableW, height / pxPerMm, undefined, 'FAST');

      offset += height;
      page += 1;
    }

    pdf.save(filename.endsWith('.pdf') ? filename : `${filename}.pdf`);
  } finally {
    document.body.removeChild(host);
  }
}
