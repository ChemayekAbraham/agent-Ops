import { useEffect, useMemo, useRef, useState } from 'react';
import { buildShareAgreementHtml, type ShareAgreementData } from './shareAgreementTemplate';

/** Live contract preview — same HTML that is rasterised into the emailed PDF. */
export default function ShareAgreementPreview({ data }: { data: ShareAgreementData }) {
  const html = useMemo(() => buildShareAgreementHtml(data), [data]);
  const ref = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState(1400);

  useEffect(() => {
    const iframe = ref.current;
    if (!iframe) return;
    const measure = () => {
      const doc = iframe.contentDocument;
      if (doc?.body) setHeight(Math.max(doc.body.scrollHeight, doc.documentElement.scrollHeight) + 24);
    };
    iframe.addEventListener('load', measure);
    const t = setTimeout(measure, 300);
    return () => { iframe.removeEventListener('load', measure); clearTimeout(t); };
  }, [html]);

  return (
    <div className="w-full overflow-x-auto rounded-lg border bg-muted/30">
      <iframe
        ref={ref}
        title="Shareholders agreement preview"
        srcDoc={html}
        className="block w-full min-w-[820px] border-0"
        style={{ height }}
      />
    </div>
  );
}
