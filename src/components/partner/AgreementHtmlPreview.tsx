import { useEffect, useMemo, useRef, useState } from 'react';
import { buildAgreementHtml, type AgreementFillData } from './agreementTemplate';

// The preview is now produced from the SINGLE contract template via
// `buildAgreementHtml`, rendered inside an isolated iframe. The stored/emailed
// PDF is rasterised from the exact same HTML, so they match pixel-for-pixel.
export type AgreementPreviewData = AgreementFillData;

export default function AgreementHtmlPreview({ data }: { data: AgreementPreviewData }) {
  const html = useMemo(() => buildAgreementHtml(data), [data]);
  // Keep the iframe document mounted while editing. Replacing srcDoc reloads
  // the entire contract and can move the reader away from the rate clause.
  const initialHtml = useRef(html);
  const currentHtml = useRef(html);
  currentHtml.current = html;
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState(1400);

  // Auto-size the iframe to its content so the whole document scrolls naturally
  // inside the dialog.
  useEffect(() => {
    const iframe = iframeRef.current;
    if (!iframe) return;
    const onLoad = () => {
      try {
        const doc = iframe.contentDocument;
        if (doc?.body) {
          const next = new DOMParser().parseFromString(currentHtml.current, 'text/html');
          const scrollTop = doc.scrollingElement?.scrollTop ?? 0;
          doc.body.innerHTML = next.body.innerHTML;
          if (doc.scrollingElement) doc.scrollingElement.scrollTop = scrollTop;
          const h = Math.max(doc.body.scrollHeight, doc.documentElement.scrollHeight);
          if (h > 0) setHeight(h + 24);
        }
      } catch {
        /* cross-origin guard — srcDoc is same-origin so this should not throw */
      }
    };
    iframe.addEventListener('load', onLoad);
    // Update the mounted document immediately, without waiting for another
    // iframe navigation or losing the reader's position in the contract.
    onLoad();
    // srcDoc may already be loaded; nudge a measure shortly after.
    const t = setTimeout(onLoad, 250);
    return () => {
      iframe.removeEventListener('load', onLoad);
      clearTimeout(t);
    };
  }, [html]);

  return (
    <iframe
      ref={iframeRef}
      title="Partnership agreement preview"
      srcDoc={initialHtml.current}
      style={{ width: '100%', height, border: 'none', display: 'block', background: '#f8fafc' }}
    />
  );
}
