import { useState, useEffect, useCallback, useRef } from 'react';
import { StorageImage } from '@/components/ui/StorageImage';
import { motion, AnimatePresence, PanInfo } from 'framer-motion';
import { X, ChevronLeft, ChevronRight, ZoomIn, ZoomOut, Share2, Download, ImageOff, RotateCw, RotateCcw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { toast } from 'sonner';

interface LightboxImage {
  id: string;
  image_url: string;
}

interface ImageLightboxProps {
  images: LightboxImage[];
  initialIndex?: number;
  open: boolean;
  onClose: () => void;
  productName?: string;
  /** Optional stable key (e.g. house id). When set, last viewed index + zoom are restored on reopen. */
  memoryKey?: string;
}

export function ImageLightbox({ 
  images: imagesProp, 
  initialIndex = 0, 
  open, 
  onClose,
  productName = 'Product',
  memoryKey,
}: ImageLightboxProps) {
  // Defensive: drop entries without a usable URL so we never index into
  // `images[i].image_url` and find `undefined`/`null`. This is the root
  // cause of past `Cannot read properties of null (reading 'x')` crashes
  // that blanked the tenant dashboard.
  const images = (imagesProp ?? []).filter(
    (img): img is LightboxImage => !!img && typeof img.image_url === 'string' && img.image_url.length > 0
  );
  const storageKey = memoryKey ? `lightbox:${memoryKey}` : null;
  const readMemory = useCallback(() => {
    if (!storageKey || typeof window === 'undefined') return null;
    try {
      const raw = sessionStorage.getItem(storageKey);
      if (!raw) return null;
      const parsed = JSON.parse(raw) as { index?: number; scale?: number; tx?: number; ty?: number };
      return parsed;
    } catch { return null; }
  }, [storageKey]);

  const initial = (() => {
    const m = readMemory();
    if (m && typeof m.index === 'number' && m.index >= 0 && m.index < images.length) return m;
    return null;
  })();

  const [currentIndex, setCurrentIndex] = useState(initial?.index ?? initialIndex);
  const [direction, setDirection] = useState(0);
  const [scale, setScale] = useState(initial?.scale && initial.scale > 1.05 ? initial.scale : 1);
  const [translate, setTranslate] = useState({ x: initial?.tx ?? 0, y: initial?.ty ?? 0 });
  const restoredOnceRef = useRef(false);
  const lastTouchDist = useRef<number | null>(null);
  const lastTouchCenter = useRef<{ x: number; y: number } | null>(null);
  const imgContainerRef = useRef<HTMLDivElement>(null);
  const swipeStart = useRef<{ x: number; y: number; t: number } | null>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const previouslyFocused = useRef<HTMLElement | null>(null);
  const [loadedIds, setLoadedIds] = useState<Set<string>>(new Set());
  const [erroredIds, setErroredIds] = useState<Set<string>>(new Set());
  const [retryTokens, setRetryTokens] = useState<Record<string, number>>({});

  const markLoaded = useCallback((id: string) => {
    setLoadedIds(prev => prev.has(id) ? prev : new Set(prev).add(id));
  }, []);
  const markErrored = useCallback((id: string) => {
    setErroredIds(prev => prev.has(id) ? prev : new Set(prev).add(id));
  }, []);
  const retryImage = useCallback((id: string, url: string) => {
    setErroredIds(prev => {
      if (!prev.has(id)) return prev;
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
    setLoadedIds(prev => {
      if (!prev.has(id)) return prev;
      const next = new Set(prev);
      next.delete(id);
      return next;
    });
    const token = Date.now();
    setRetryTokens(prev => ({ ...prev, [id]: token }));
    const sep = url.includes('?') ? '&' : '?';
    const el = new Image();
    el.src = `${url}${sep}retry=${token}`;
    el.onload = () => markLoaded(id);
    el.onerror = () => markErrored(id);
  }, [markLoaded, markErrored]);

  // Preload current + neighbour images for instant swipe
  useEffect(() => {
    if (!open || images.length === 0) return;
    const targets = new Set<number>([currentIndex]);
    if (images.length > 1) {
      targets.add((currentIndex + 1) % images.length);
      targets.add((currentIndex - 1 + images.length) % images.length);
    }
    targets.forEach(i => {
      const img = images[i];
      if (!img || loadedIds.has(img.id) || erroredIds.has(img.id)) return;
      const el = new Image();
      el.src = img.image_url;
      el.onload = () => markLoaded(img.id);
      el.onerror = () => markErrored(img.id);
    });
  }, [open, currentIndex, images, loadedIds, erroredIds, markLoaded, markErrored]);

  const isZoomed = scale > 1.05;

  const resetZoom = useCallback(() => {
    setScale(1);
    setTranslate({ x: 0, y: 0 });
    lastTouchDist.current = null;
    lastTouchCenter.current = null;
  }, []);

  const resetMemory = useCallback(() => {
    if (storageKey && typeof window !== 'undefined') {
      try { sessionStorage.removeItem(storageKey); } catch { /* noop */ }
    }
    setCurrentIndex(initialIndex);
    resetZoom();
    toast.success('View reset to start');
  }, [storageKey, initialIndex, resetZoom]);

  // On open: restore from memory if available, else use initialIndex
  useEffect(() => {
    if (!open) { restoredOnceRef.current = false; return; }
    const m = readMemory();
    if (m && typeof m.index === 'number' && m.index >= 0 && m.index < images.length) {
      setCurrentIndex(m.index);
      if (m.scale && m.scale > 1.05) {
        setScale(Math.min(m.scale, 5));
        setTranslate({ x: m.tx ?? 0, y: m.ty ?? 0 });
      } else {
        resetZoom();
      }
    } else {
      setCurrentIndex(initialIndex);
      resetZoom();
    }
    restoredOnceRef.current = true;
  }, [open, initialIndex, images.length, readMemory, resetZoom]);

  // Reset zoom on slide change (but skip the very first restore so saved zoom survives reopen)
  const prevIndexRef = useRef(currentIndex);
  useEffect(() => {
    if (prevIndexRef.current !== currentIndex) {
      resetZoom();
      prevIndexRef.current = currentIndex;
    }
  }, [currentIndex, resetZoom]);

  // Self-heal: if the images list shrinks (or memory restored a stale index),
  // pull currentIndex back into range BEFORE any render reads it.
  useEffect(() => {
    if (images.length === 0) return;
    if (currentIndex < 0 || currentIndex >= images.length) {
      setCurrentIndex(Math.min(Math.max(currentIndex, 0), images.length - 1));
    }
  }, [images.length, currentIndex]);

  // Persist to sessionStorage whenever index or zoom changes while open
  useEffect(() => {
    if (!open || !storageKey || typeof window === 'undefined') return;
    try {
      sessionStorage.setItem(storageKey, JSON.stringify({
        index: currentIndex,
        scale,
        tx: translate.x,
        ty: translate.y,
      }));
    } catch { /* ignore quota */ }
  }, [open, storageKey, currentIndex, scale, translate.x, translate.y]);

  // Keyboard navigation
  useEffect(() => {
    if (!open) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      switch (e.key) {
        case 'Escape': onClose(); break;
        case 'ArrowLeft': goToPrevious(); break;
        case 'ArrowRight': goToNext(); break;
        case 'Home': setDirection(-1); setCurrentIndex(0); break;
        case 'End': setDirection(1); setCurrentIndex(images.length - 1); break;
        case '+': case '=': setScale(s => Math.min(s + 0.5, 5)); break;
        case '-': setScale(s => { const n = Math.max(s - 0.5, 1); if (n === 1) setTranslate({ x: 0, y: 0 }); return n; }); break;
        case '0': resetZoom(); break;
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [open, currentIndex, images.length, onClose, resetZoom]);

  // Focus trap + restore focus on close
  useEffect(() => {
    if (!open) return;
    previouslyFocused.current = document.activeElement as HTMLElement | null;
    // Defer to allow dialog to mount
    const focusTimer = window.setTimeout(() => closeButtonRef.current?.focus(), 0);

    const handleFocusTrap = (e: KeyboardEvent) => {
      if (e.key !== 'Tab') return;
      const root = dialogRef.current;
      if (!root) return;
      const focusables = root.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])'
      );
      if (focusables.length === 0) return;
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      const active = document.activeElement as HTMLElement | null;
      if (e.shiftKey && active === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && active === last) { e.preventDefault(); first.focus(); }
    };
    window.addEventListener('keydown', handleFocusTrap);
    return () => {
      window.clearTimeout(focusTimer);
      window.removeEventListener('keydown', handleFocusTrap);
      previouslyFocused.current?.focus?.();
    };
  }, [open]);

  // Prevent body scroll
  useEffect(() => {
    if (open) document.body.style.overflow = 'hidden';
    else document.body.style.overflow = '';
    return () => { document.body.style.overflow = ''; };
  }, [open]);

  // Pinch-to-zoom
  useEffect(() => {
    if (!open) return;
    const el = imgContainerRef.current;
    if (!el) return;

    const dist = (t: TouchList) => {
      const dx = t[0].clientX - t[1].clientX;
      const dy = t[0].clientY - t[1].clientY;
      return Math.sqrt(dx * dx + dy * dy);
    };
    const center = (t: TouchList) => ({
      x: (t[0].clientX + t[1].clientX) / 2,
      y: (t[0].clientY + t[1].clientY) / 2,
    });

    const onTS = (e: TouchEvent) => {
      if (e.touches.length === 2) {
        e.preventDefault();
        lastTouchDist.current = dist(e.touches);
        lastTouchCenter.current = center(e.touches);
        swipeStart.current = null;
      } else if (e.touches.length === 1 && !isZoomed) {
        swipeStart.current = { x: e.touches[0].clientX, y: e.touches[0].clientY, t: Date.now() };
      }
    };
    const onTM = (e: TouchEvent) => {
      if (e.touches.length === 2 && lastTouchDist.current !== null) {
        e.preventDefault();
        const d = dist(e.touches);
        const c = center(e.touches);
        const delta = d / lastTouchDist.current;
        setScale(prev => Math.min(Math.max(prev * delta, 1), 5));
        if (lastTouchCenter.current) {
          setTranslate(prev => ({
            x: prev.x + c.x - lastTouchCenter.current!.x,
            y: prev.y + c.y - lastTouchCenter.current!.y,
          }));
        }
        lastTouchDist.current = d;
        lastTouchCenter.current = c;
      }
    };
    const onTE = (e: TouchEvent) => {
      if (e.touches.length < 2) {
        lastTouchDist.current = null;
        lastTouchCenter.current = null;
        setScale(prev => {
          if (prev < 1.1) { setTranslate({ x: 0, y: 0 }); return 1; }
          return prev;
        });
      }
      // Native swipe fallback for single-finger horizontal swipes
      if (swipeStart.current && e.changedTouches.length === 1 && images.length > 1 && !isZoomed) {
        const start = swipeStart.current;
        const end = e.changedTouches[0];
        const dx = end.clientX - start.x;
        const dy = end.clientY - start.y;
        const dt = Date.now() - start.t;
        if (Math.abs(dx) > 40 && Math.abs(dx) > Math.abs(dy) * 1.2 && dt < 600) {
          if (dx > 0) goToPrevious(); else goToNext();
        }
        swipeStart.current = null;
      }
    };

    el.addEventListener('touchstart', onTS, { passive: false });
    el.addEventListener('touchmove', onTM, { passive: false });
    el.addEventListener('touchend', onTE);
    return () => {
      el.removeEventListener('touchstart', onTS);
      el.removeEventListener('touchmove', onTM);
      el.removeEventListener('touchend', onTE);
    };
  }, [open, isZoomed, images.length]);

  const goToPrevious = useCallback(() => {
    if (isZoomed) return;
    setDirection(-1);
    setCurrentIndex(prev => (prev === 0 ? images.length - 1 : prev - 1));
  }, [images.length, isZoomed]);

  const goToNext = useCallback(() => {
    if (isZoomed) return;
    setDirection(1);
    setCurrentIndex(prev => (prev === images.length - 1 ? 0 : prev + 1));
  }, [images.length, isZoomed]);

  const handleDragEnd = useCallback((_e: MouseEvent | TouchEvent | PointerEvent, info: PanInfo) => {
    if (isZoomed) return;
    if (info.offset.x > 40 || info.velocity.x > 300) goToPrevious();
    else if (info.offset.x < -40 || info.velocity.x < -300) goToNext();
  }, [goToPrevious, goToNext, isZoomed]);

  const handleToggleZoom = useCallback(() => {
    if (isZoomed) resetZoom();
    else setScale(2.5);
  }, [isZoomed, resetZoom]);

  const handleShare = useCallback(async () => {
    const url = images[Math.min(Math.max(currentIndex, 0), Math.max(images.length - 1, 0))]?.image_url;
    if (!url) return;
    const shareData = {
      title: `${productName} — Photo ${currentIndex + 1}`,
      text: `Check out this photo of ${productName} on Welile!`,
      url,
    };
    if (navigator.share) {
      try { await navigator.share(shareData); } catch {}
    } else {
      await navigator.clipboard.writeText(url);
      toast.success('Image link copied!');
    }
  }, [images, currentIndex, productName]);

  const handleDownload = useCallback(async () => {
    const url = images[Math.min(Math.max(currentIndex, 0), Math.max(images.length - 1, 0))]?.image_url;
    if (!url) return;
    try {
      const res = await fetch(url);
      const blob = await res.blob();
      const blobUrl = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = blobUrl;
      a.download = `${productName}-${currentIndex + 1}.jpg`;
      a.click();
      URL.revokeObjectURL(blobUrl);
    } catch {
      window.open(url, '_blank');
    }
  }, [images, currentIndex, productName]);

  const slideVariants = {
    enter: (d: number) => ({ x: d > 0 ? '100%' : '-100%', opacity: 0 }),
    center: { x: 0, opacity: 1 },
    exit: (d: number) => ({ x: d < 0 ? '100%' : '-100%', opacity: 0 }),
  };

  if (images.length === 0) return null;

  // Clamp currentIndex against the (possibly newly-shrunk) `images` array.
  // sessionStorage memory or rapid prop changes could leave currentIndex
  // pointing past the end, which previously caused `images[currentIndex].id`
  // / `.image_url` to throw and crash the whole tenant dashboard.
  const safeIndex = Math.min(Math.max(currentIndex, 0), images.length - 1);
  const currentImage = images[safeIndex];
  if (!currentImage) return null;

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          ref={dialogRef}
          role="dialog"
          aria-modal="true"
          aria-label={`${productName} photo viewer`}
          aria-describedby="lightbox-status"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.2 }}
          className="fixed inset-0 z-[100] bg-black/95 backdrop-blur-sm flex flex-col"
        >
          {/* Screen reader live region */}
          <div id="lightbox-status" role="status" aria-live="polite" className="sr-only">
            {productName} — Image {currentIndex + 1} of {images.length}
            {isZoomed ? ', zoomed in' : ''}
          </div>
          {/* Header */}
          <div className="flex items-center justify-between p-3 sm:p-4 relative z-10">
            <div className="flex items-center gap-3">
              <span className="text-white/70 text-sm font-medium tabular-nums" aria-hidden="true">
                {currentIndex + 1} / {images.length}
              </span>
              {productName && (
                <span className="text-white/50 text-sm hidden sm:block truncate max-w-[200px]" aria-hidden="true">
                  — {productName}
                </span>
              )}
            </div>
            
            <div className="flex items-center gap-0.5 sm:gap-1">
              <Button variant="ghost" size="icon" onClick={handleShare} aria-label="Share image"
                className="text-white/70 hover:text-white hover:bg-white/10 h-10 w-10" title="Share image">
                <Share2 className="h-5 w-5" />
              </Button>
              <Button variant="ghost" size="icon" onClick={handleDownload} aria-label="Download image"
                className="text-white/70 hover:text-white hover:bg-white/10 h-10 w-10" title="Save image">
                <Download className="h-5 w-5" />
              </Button>
              <Button variant="ghost" size="icon" onClick={handleToggleZoom}
                aria-label={isZoomed ? 'Zoom out' : 'Zoom in'} aria-pressed={isZoomed}
                className="text-white/70 hover:text-white hover:bg-white/10 h-10 w-10" title={isZoomed ? 'Zoom out' : 'Zoom in'}>
                {isZoomed ? <ZoomOut className="h-5 w-5" /> : <ZoomIn className="h-5 w-5" />}
              </Button>
              <Button variant="ghost" size="icon" onClick={resetMemory}
                aria-label="Reset zoom and position"
                className="text-white/70 hover:text-white hover:bg-white/10 h-10 w-10"
                title="Reset zoom & position">
                <RotateCcw className="h-5 w-5" />
              </Button>
              <Button ref={closeButtonRef} variant="ghost" size="icon" onClick={onClose} aria-label="Close photo viewer"
                className="text-white/70 hover:text-white hover:bg-white/10 h-10 w-10">
                <X className="h-6 w-6" />
              </Button>
            </div>
          </div>

          {/* Main Image Area */}
          <div ref={imgContainerRef} className="flex-1 relative overflow-hidden flex items-center justify-center">
            {images.length > 1 && !isZoomed && (
              <>
                <Button variant="ghost" size="icon" onClick={goToPrevious} aria-label="Previous image"
                  className="absolute left-4 z-10 h-12 w-12 rounded-full text-white/70 hover:text-white hover:bg-white/10 hidden md:flex">
                  <ChevronLeft className="h-8 w-8" />
                </Button>
                <Button variant="ghost" size="icon" onClick={goToNext} aria-label="Next image"
                  className="absolute right-4 z-10 h-12 w-12 rounded-full text-white/70 hover:text-white hover:bg-white/10 hidden md:flex">
                  <ChevronRight className="h-8 w-8" />
                </Button>
              </>
            )}

            <AnimatePresence initial={false} custom={direction} mode="popLayout">
              <motion.div
                key={currentIndex}
                custom={direction}
                variants={slideVariants}
                initial="enter"
                animate="center"
                exit="exit"
                transition={{
                  x: { type: 'spring', stiffness: 300, damping: 30 },
                  opacity: { duration: 0.2 },
                }}
                drag={!isZoomed ? 'x' : false}
                dragConstraints={{ left: 0, right: 0 }}
                dragElastic={0.2}
                onDragEnd={handleDragEnd}
                className={cn(
                  'absolute inset-0 flex items-center justify-center p-4 touch-pan-y',
                  !isZoomed && 'cursor-grab active:cursor-grabbing'
                )}
              >
                <motion.img
                  src={(() => {
                    const img = currentImage;
                    const t = retryTokens[img.id];
                    if (!t) return img.image_url;
                    const sep = img.image_url.includes('?') ? '&' : '?';
                    return `${img.image_url}${sep}retry=${t}`;
                  })()}
                  alt={`${productName} - Image ${safeIndex + 1}`}
                  className={cn(
                    'max-h-full max-w-full object-contain select-none',
                    'transition-[filter,transform,opacity] duration-700 ease-out will-change-[filter,transform]',
                    erroredIds.has(currentImage.id) && 'opacity-0'
                  )}
                  style={{
                    transform: loadedIds.has(currentImage.id)
                      ? `scale(${scale}) translate(${translate.x / scale}px, ${translate.y / scale}px)`
                      : `scale(${scale * 1.06}) translate(${translate.x / scale}px, ${translate.y / scale}px)`,
                    filter: loadedIds.has(currentImage.id)
                      ? 'blur(0px)'
                      : 'blur(24px)',
                    transition: isZoomed
                      ? 'filter 600ms ease-out'
                      : 'filter 600ms ease-out, transform 400ms ease-out',
                  }}
                  draggable={false}
                  decoding="async"
                  loading="eager"
                  onLoad={() => markLoaded(currentImage.id)}
                  onError={() => markErrored(currentImage.id)}
                  onDoubleClick={handleToggleZoom}
                  onClick={() => { if (!isZoomed) handleToggleZoom(); }}
                />
                {/* Skeleton + spinner */}
                {!loadedIds.has(currentImage.id) && !erroredIds.has(currentImage.id) && (
                  <div className="absolute inset-0 flex items-center justify-center pointer-events-none" aria-hidden="true">
                    <div className="relative w-[min(80vw,640px)] h-[min(60vh,480px)] rounded-2xl overflow-hidden bg-white/5">
                      <div className="absolute inset-0 -translate-x-full animate-[shimmer_1.4s_infinite] bg-gradient-to-r from-transparent via-white/10 to-transparent" />
                    </div>
                  </div>
                )}
                {/* Error fallback */}
                {erroredIds.has(currentImage.id) && (
                  <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 text-white/70">
                    <ImageOff className="h-10 w-10" aria-hidden="true" />
                    <span className="text-sm">Image failed to load</span>
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        retryImage(currentImage.id, currentImage.image_url);
                      }}
                      className="inline-flex items-center gap-2 rounded-full bg-white/15 hover:bg-white/25 active:bg-white/30 px-4 py-2 text-sm font-medium text-white transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-white/60"
                      aria-label="Retry loading image"
                    >
                      <RotateCw className="h-4 w-4" />
                      Retry
                    </button>
                  </div>
                )}
              </motion.div>
            </AnimatePresence>

            {/* Hints */}
            {!isZoomed && (
              <div className="absolute bottom-20 left-1/2 -translate-x-1/2 flex items-center gap-2 text-white/25 text-[11px] pointer-events-none">
                <ZoomIn className="h-3.5 w-3.5" />
                <span className="hidden md:inline">Double-click to zoom</span>
                <span className="md:hidden">Pinch or tap to zoom</span>
              </div>
            )}
            {images.length > 1 && !isZoomed && (
              <div className="absolute bottom-12 left-1/2 -translate-x-1/2 flex items-center gap-2 text-white/25 text-[11px] md:hidden pointer-events-none">
                <ChevronLeft className="h-3.5 w-3.5" />
                <span>Swipe to navigate</span>
                <ChevronRight className="h-3.5 w-3.5" />
              </div>
            )}
          </div>

          {/* Thumbnails */}
          {images.length > 1 && (
            <div className="p-3 sm:p-4 overflow-x-auto" role="tablist" aria-label="Image thumbnails">
              <div className="flex gap-2 justify-center">
                {images.map((image, index) => (
                  <button
                    key={image.id}
                    role="tab"
                    aria-selected={index === currentIndex}
                    aria-label={`View image ${index + 1} of ${images.length}`}
                    tabIndex={index === currentIndex ? 0 : -1}
                    onClick={() => {
                      setDirection(index > currentIndex ? 1 : -1);
                      setCurrentIndex(index);
                    }}
                    className={cn(
                      'flex-shrink-0 w-14 h-14 sm:w-16 sm:h-16 rounded-lg overflow-hidden border-2 transition-all focus:outline-none focus-visible:ring-2 focus-visible:ring-white',
                      index === currentIndex
                        ? 'border-white opacity-100 scale-105'
                        : 'border-transparent opacity-50 hover:opacity-75'
                    )}
                  >
                    <StorageImage src={image.image_url} alt={`Thumbnail ${index + 1}`} className="w-full h-full object-cover" expandable={false} />
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Dots - Mobile */}
          {images.length > 1 && images.length <= 10 && (
            <div className="flex justify-center gap-1.5 pb-4 md:hidden" aria-hidden="true">
              {images.map((_, index) => (
                <button
                  key={index}
                  tabIndex={-1}
                  onClick={() => {
                    setDirection(index > currentIndex ? 1 : -1);
                    setCurrentIndex(index);
                  }}
                  className={cn(
                    'h-2 rounded-full transition-all',
                    index === currentIndex ? 'w-6 bg-white' : 'w-2 bg-white/40'
                  )}
                />
              ))}
            </div>
          )}
        </motion.div>
      )}
    </AnimatePresence>
  );
}
