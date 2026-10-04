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

/** Returns the rendered contract as a base64 (no data: prefix) PDF string. */
export async function renderAgreementPdfBase64(
  html: string,
  opts?: { format?: 'a4' | 'letter' },
): Promise<string> {
  const format = opts?.format ?? 'a4';
  const [{ default: html2canvas }, { jsPDF }] = await Promise.all([
    import('html2canvas'),
    import('jspdf'),
  ]);
  // Mount the contract inside the parent document (off-screen but in-layout)
  // so html2canvas can walk real computed styles. Rendering into an off-screen
  // <iframe> produced blank pages on Chromium/WebKit.
  const { styles, body } = splitAgreementHtml(html);

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
  host.innerHTML = `${styles}<div class="agreement-print-root" style="width:900px;background:#ffffff;">${body}</div>`;
  document.body.appendChild(host);

  try {
    // Allow layout + webfonts/images to settle.
    await new Promise((r) => setTimeout(r, 150));
    await waitForImages(host);
    if ((document as any).fonts?.ready) {
      try { await (document as any).fonts.ready; } catch { /* ignore */ }
    }

    const sections = Array.from(host.querySelectorAll<HTMLElement>('.page-section'));
    const targets = sections.length
      ? sections
      : [host.querySelector<HTMLElement>('.document-wrapper') || (host.firstElementChild as HTMLElement) || host];

    const pdf = new jsPDF({ orientation: 'portrait', unit: 'mm', format });
    const pageW = pdf.internal.pageSize.getWidth();
    const pageH = pdf.internal.pageSize.getHeight();
    const margin = 8;
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

    const dataUri = pdf.output('datauristring');
    const comma = dataUri.indexOf(',');
    return comma >= 0 ? dataUri.slice(comma + 1) : dataUri;
  } finally {
    document.body.removeChild(host);
  }
}
