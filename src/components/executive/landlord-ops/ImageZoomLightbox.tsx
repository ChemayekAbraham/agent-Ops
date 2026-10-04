import { useEffect, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight, X, ZoomIn, ZoomOut } from 'lucide-react';

interface Props {
  images: string[];
  startIndex: number | null;
  open: boolean;
  onClose: () => void;
  altPrefix?: string;
  captions?: string[];
}

export function ImageZoomLightbox({ images, startIndex, open, onClose, altPrefix = 'Photo', captions }: Props) {
  const [current, setCurrent] = useState(startIndex ?? 0);
  const [scale, setScale] = useState(1);
  const [tx, setTx] = useState(0);
  const [ty, setTy] = useState(0);

  // gesture refs
  const pointers = useRef<Map<number, { x: number; y: number }>>(new Map());
  const gestureStart = useRef<{ dist: number; scale: number; cx: number; cy: number; tx: number; ty: number } | null>(null);
  const panStart = useRef<{ x: number; y: number; tx: number; ty: number } | null>(null);
  const swipeStart = useRef<{ x: number; y: number; t: number } | null>(null);
  const lastTap = useRef<number>(0);

  const resetZoom = () => { setScale(1); setTx(0); setTy(0); };

  const goPrev = () => { resetZoom(); setCurrent(c => (c > 0 ? c - 1 : images.length - 1)); };
  const goNext = () => { resetZoom(); setCurrent(c => (c < images.length - 1 ? c + 1 : 0)); };

  useEffect(() => {
    if (open && startIndex !== null) { setCurrent(startIndex); resetZoom(); }
  }, [open, startIndex]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
      if (e.key === 'ArrowLeft') goPrev();
      if (e.key === 'ArrowRight') goNext();
      if (e.key === '+' || e.key === '=') setScale(s => Math.min(s + 0.5, 5));
      if (e.key === '-') setScale(s => Math.max(s - 0.5, 1));
      if (e.key === '0') resetZoom();
    };
    document.addEventListener('keydown', onKey);
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = '';
    };
  }, [open, onClose, images.length]);

  if (!open || startIndex === null) return null;

  const dist = (a: { x: number; y: number }, b: { x: number; y: number }) =>
    Math.hypot(a.x - b.x, a.y - b.y);

  const onPointerDown = (e: React.PointerEvent<HTMLImageElement>) => {
    (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.current.size === 2) {
      const [p1, p2] = Array.from(pointers.current.values());
      gestureStart.current = {
        dist: dist(p1, p2),
        scale,
        cx: (p1.x + p2.x) / 2,
        cy: (p1.y + p2.y) / 2,
        tx, ty,
      };
      panStart.current = null;
      swipeStart.current = null;
    } else if (pointers.current.size === 1) {
      if (scale > 1) {
        panStart.current = { x: e.clientX, y: e.clientY, tx, ty };
        swipeStart.current = null;
      } else {
        swipeStart.current = { x: e.clientX, y: e.clientY, t: Date.now() };
        panStart.current = null;
      }
    }
  };

  const onPointerMove = (e: React.PointerEvent<HTMLImageElement>) => {
    if (!pointers.current.has(e.pointerId)) return;
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.current.size === 2 && gestureStart.current) {
      const [p1, p2] = Array.from(pointers.current.values());
      const newDist = dist(p1, p2);
      const factor = newDist / gestureStart.current.dist;
      setScale(Math.max(1, Math.min(5, gestureStart.current.scale * factor)));
    } else if (pointers.current.size === 1 && panStart.current) {
      setTx(panStart.current.tx + (e.clientX - panStart.current.x));
      setTy(panStart.current.ty + (e.clientY - panStart.current.y));
    }
  };

  const onPointerUp = (e: React.PointerEvent<HTMLImageElement>) => {
    pointers.current.delete(e.pointerId);
    if (pointers.current.size < 2) gestureStart.current = null;
    if (pointers.current.size === 0) {
      // swipe detection (only when not zoomed)
      if (swipeStart.current && scale === 1) {
        const dx = e.clientX - swipeStart.current.x;
        const dy = e.clientY - swipeStart.current.y;
        const dt = Date.now() - swipeStart.current.t;
        if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy) * 1.5 && dt < 600 && images.length > 1) {
          if (dx < 0) goNext(); else goPrev();
        }
      }
      // double-tap zoom
      const now = Date.now();
      if (now - lastTap.current < 280) {
        if (scale > 1) resetZoom();
        else setScale(2.5);
        lastTap.current = 0;
      } else {
        lastTap.current = now;
      }
      panStart.current = null;
      swipeStart.current = null;
      if (scale === 1) { setTx(0); setTy(0); }
    }
  };

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/90 backdrop-blur-sm"
      onClick={onClose}
    >
      <button
        onClick={onClose}
        className="absolute top-3 right-3 z-10 flex h-10 w-10 items-center justify-center rounded-full bg-white/10 text-white hover:bg-white/20 transition"
        aria-label="Close zoom"
      >
        <X className="h-5 w-5" />
      </button>

      <div className="absolute top-3 left-1/2 -translate-x-1/2 z-10 rounded-full bg-white/10 px-3 py-1 text-xs text-white">
        {current + 1} / {images.length}
      </div>

      {captions?.[current] && (
        <div
          className="absolute bottom-16 left-1/2 -translate-x-1/2 z-10 max-w-[90vw] rounded-lg bg-black/60 px-3 py-1.5 text-center text-xs text-white shadow-lg"
          onClick={(e) => e.stopPropagation()}
        >
          {captions[current]}
        </div>
      )}

      <div className="absolute bottom-3 left-1/2 -translate-x-1/2 z-10 flex items-center gap-2" onClick={(e) => e.stopPropagation()}>
        <button
          onClick={() => setScale(s => Math.max(1, s - 0.5))}
          className="flex h-10 w-10 items-center justify-center rounded-full bg-white/10 text-white hover:bg-white/20 transition"
          aria-label="Zoom out"
        >
          <ZoomOut className="h-4 w-4" />
        </button>
        <span className="rounded-full bg-white/10 px-3 py-1 text-[11px] text-white tabular-nums">
          {Math.round(scale * 100)}%
        </span>
        <button
          onClick={() => setScale(s => Math.min(5, s + 0.5))}
          className="flex h-10 w-10 items-center justify-center rounded-full bg-white/10 text-white hover:bg-white/20 transition"
          aria-label="Zoom in"
        >
          <ZoomIn className="h-4 w-4" />
        </button>
      </div>

      {images.length > 1 && (
        <button
          onClick={(e) => { e.stopPropagation(); goPrev(); }}
          className="absolute left-2 z-10 flex h-10 w-10 items-center justify-center rounded-full bg-white/10 text-white hover:bg-white/20 transition"
          aria-label="Previous photo"
        >
          <ChevronLeft className="h-5 w-5" />
        </button>
      )}

      <img
        src={images[current]}
        alt={`${altPrefix} photo ${current + 1}`}
        draggable={false}
        className="max-h-[85vh] max-w-[95vw] rounded-lg object-contain shadow-2xl select-none touch-none"
        style={{
          transform: `translate(${tx}px, ${ty}px) scale(${scale})`,
          transition: pointers.current.size === 0 ? 'transform 150ms ease-out' : 'none',
          cursor: scale > 1 ? 'grab' : 'zoom-in',
        }}
        onClick={(e) => e.stopPropagation()}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
      />

      {images.length > 1 && (
        <button
          onClick={(e) => { e.stopPropagation(); goNext(); }}
          className="absolute right-2 z-10 flex h-10 w-10 items-center justify-center rounded-full bg-white/10 text-white hover:bg-white/20 transition"
          aria-label="Next photo"
        >
          <ChevronRight className="h-5 w-5" />
        </button>
      )}
    </div>
  );
}
