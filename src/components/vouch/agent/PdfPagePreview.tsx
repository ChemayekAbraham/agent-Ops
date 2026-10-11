import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { ChevronLeft, ChevronRight, Loader2, Minus, Plus } from 'lucide-react';

const MIN = 0.6;
const MAX = 3;

/** Renders a PDF blob URL page by page with page navigation and zoom. */
export default function PdfPagePreview({ url }: { url: string }) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const docRef = useRef<any>(null);
  const [pages, setPages] = useState(0);
  const [page, setPage] = useState(1);
  const [zoom, setZoom] = useState(1);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true); setError(false); setPage(1); setZoom(1);
    (async () => {
      try {
        const pdfjs = await import('pdfjs-dist');
        const worker = (await import('pdfjs-dist/build/pdf.worker.min.mjs?url')).default;
        pdfjs.GlobalWorkerOptions.workerSrc = worker;
        const data = await (await fetch(url)).arrayBuffer();
        const doc = await pdfjs.getDocument({ data }).promise;
        if (cancelled) return;
        docRef.current = doc;
        setPages(doc.numPages);
        setLoading(false);
      } catch { if (!cancelled) { setError(true); setLoading(false); } }
    })();
    return () => { cancelled = true; docRef.current?.destroy?.(); docRef.current = null; };
  }, [url]);

  useEffect(() => {
    const doc = docRef.current;
    if (!doc || !pages) return;
    let task: any; let cancelled = false;
    (async () => {
      const p = await doc.getPage(page);
      if (cancelled) return;
      const base = p.getViewport({ scale: 1 });
      const width = (wrapRef.current?.clientWidth || 320) - 8;
      const dpr = window.devicePixelRatio || 1;
      const vp = p.getViewport({ scale: (width / base.width) * zoom * dpr });
      const c = canvasRef.current; if (!c) return;
      c.width = vp.width; c.height = vp.height;
      c.style.width = `${vp.width / dpr}px`; c.style.height = `${vp.height / dpr}px`;
      task = p.render({ canvasContext: c.getContext('2d')!, viewport: vp });
      try { await task.promise; } catch { /* superseded */ }
    })();
    return () => { cancelled = true; task?.cancel?.(); };
  }, [page, zoom, pages]);

  useEffect(() => { wrapRef.current?.scrollTo({ top: 0, left: 0 }); }, [page]);

  return (
    <div className="flex-1 min-h-0 flex flex-col gap-2">
      <div className="flex items-center justify-between gap-1">
        <div className="flex items-center gap-1">
          <Button size="icon" variant="outline" className="h-10 w-10" aria-label="Previous page" disabled={page <= 1} onClick={() => setPage((n) => n - 1)}><ChevronLeft className="h-4 w-4" /></Button>
          <span className="text-xs font-medium min-w-[64px] text-center">{pages ? `Page ${page} of ${pages}` : '…'}</span>
          <Button size="icon" variant="outline" className="h-10 w-10" aria-label="Next page" disabled={page >= pages} onClick={() => setPage((n) => n + 1)}><ChevronRight className="h-4 w-4" /></Button>
        </div>
        <div className="flex items-center gap-1">
          <Button size="icon" variant="outline" className="h-10 w-10" aria-label="Zoom out" disabled={zoom <= MIN} onClick={() => setZoom((z) => Math.max(MIN, +(z - 0.25).toFixed(2)))}><Minus className="h-4 w-4" /></Button>
          <Button variant="outline" className="h-10 px-2 text-xs" aria-label="Reset zoom" onClick={() => setZoom(1)}>{Math.round(zoom * 100)}%</Button>
          <Button size="icon" variant="outline" className="h-10 w-10" aria-label="Zoom in" disabled={zoom >= MAX} onClick={() => setZoom((z) => Math.min(MAX, +(z + 0.25).toFixed(2)))}><Plus className="h-4 w-4" /></Button>
        </div>
      </div>
      <div ref={wrapRef} className="flex-1 min-h-0 overflow-auto rounded-md border bg-muted p-1 touch-pan-x touch-pan-y">
        {loading && <div className="flex h-full items-center justify-center"><Loader2 className="h-5 w-5 animate-spin" /></div>}
        {error && <p className="p-4 text-xs text-center">Couldn't show the preview here. Tap "Open full" to see the statement.</p>}
        <canvas ref={canvasRef} className={loading || error ? 'hidden' : 'mx-auto block bg-white'} />
      </div>
    </div>
  );
}
