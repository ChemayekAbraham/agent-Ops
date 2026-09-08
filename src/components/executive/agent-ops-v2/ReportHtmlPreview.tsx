import { useEffect, useRef, useState } from 'react';

/**
 * Renders a standalone report HTML document inside an isolated, auto-sized
 * iframe — the same single-HTML pipeline used for partner contracts, so the
 * preview and the downloaded PDF are the same document.
 */
export default function ReportHtmlPreview({ html, title }: { html: string; title: string }) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState(900);

  useEffect(() => {
    const iframe = iframeRef.current;
    if (!iframe) return;
    const measure = () => {
      try {
        const doc = iframe.contentDocument;
        if (doc?.body) {
          const h = Math.max(doc.body.scrollHeight, doc.documentElement.scrollHeight);
          if (h > 0) setHeight(h + 24);
        }
      } catch {
        /* srcDoc is same-origin; guard anyway */
      }
    };
    iframe.addEventListener('load', measure);
    const t = setTimeout(measure, 300);
    return () => {
      iframe.removeEventListener('load', measure);
      clearTimeout(t);
    };
  }, [html]);

  return (
    <div className="overflow-x-auto rounded-lg border border-border bg-muted/40">
      <iframe
        ref={iframeRef}
        title={title}
        srcDoc={html}
        style={{ width: '100%', minWidth: 360, height, border: 'none', display: 'block', background: '#e2e8f0' }}
      />
    </div>
  );
}
