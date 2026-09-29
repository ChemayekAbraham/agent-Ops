import { useEffect, useRef, useState } from 'react';
import { Check, ChevronLeft, ChevronRight, X } from 'lucide-react';
import { WELILE_ITEM_IMAGES } from '@/lib/welileItemImages';
import { Button } from '@/components/ui/button';

interface Item { label: string; hint: string }

interface Props {
  open: boolean;
  items: readonly Item[];
  startLabel?: string;
  onPick: (label: string) => void;
  onClose: () => void;
}

/** Full-screen, one-item-per-screen picker. Swipe sideways for the next item. */
export function ItemSwipePicker({ open, items, startLabel, onPick, onClose }: Props) {
  const railRef = useRef<HTMLDivElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const previouslyFocusedRef = useRef<HTMLElement | null>(null);
  const [index, setIndex] = useState(0);
  const touchX = useRef<number | null>(null);

  const reduceMotion = () =>
    document.documentElement.classList.contains('reduce-motion') ||
    window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  // Pin the surrounding Send Money dialog while the picker is open so the
  // full-screen picture sits exactly over the phone screen, hide the dialog's
  // own close button underneath, and restore everything on close.
  const rootRef = useRef<HTMLDivElement>(null);
  const [frame, setFrame] = useState<React.CSSProperties>({});
  useEffect(() => {
    if (!open) return;
    const host = rootRef.current?.parentElement?.closest('[role="dialog"]') as HTMLElement | null;
    if (!host) return;
    const prevOverflow = host.style.overflow;
    const prevScroll = host.scrollTop;
    const closeBtn = host.querySelector(':scope > button') as HTMLElement | null;
    const prevDisplay = closeBtn?.style.display ?? '';
    host.scrollTop = 0;
    host.style.overflow = 'hidden';
    if (closeBtn) closeBtn.style.display = 'none';
    // Any animated wrapper with a transform becomes the "screen" for a fixed
    // element, so measure where we actually landed and shift back to 0,0.
    const place = () => {
      const el = rootRef.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      const curTop = parseFloat(el.style.top || '0') || 0;
      const curLeft = parseFloat(el.style.left || '0') || 0;
      setFrame({ top: curTop - r.top, left: curLeft - r.left, width: window.innerWidth, height: window.innerHeight, right: 'auto', bottom: 'auto' });
    };
    place();
    const raf = requestAnimationFrame(place);
    window.addEventListener('resize', place);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('resize', place);
      host.style.overflow = prevOverflow;
      host.scrollTop = prevScroll;
      if (closeBtn) closeBtn.style.display = prevDisplay;
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    previouslyFocusedRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const start = Math.max(0, items.findIndex((i) => i.label === startLabel));
    setIndex(start);
    requestAnimationFrame(() => {
      const el = railRef.current;
      if (el) el.scrollTo({ left: start * el.clientWidth, behavior: 'instant' as ScrollBehavior });
      closeButtonRef.current?.focus();
    });
    return () => previouslyFocusedRef.current?.focus();
  }, [open, startLabel, items]);

  if (!open) return null;

  const go = (i: number) => {
    const el = railRef.current;
    if (!el) return;
    const n = Math.min(items.length - 1, Math.max(0, i));
    setIndex(n);
    el.scrollTo({ left: n * el.clientWidth, behavior: reduceMotion() ? 'instant' as ScrollBehavior : 'smooth' });
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Tab') {
      const focusable = Array.from(
        rootRef.current?.querySelectorAll<HTMLElement>('button:not(:disabled), [href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])') ?? [],
      );
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (!first || !last) return;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    } else if (event.key === 'ArrowRight') {
      event.preventDefault();
      go(index + 1);
    } else if (event.key === 'ArrowLeft') {
      event.preventDefault();
      go(index - 1);
    } else if (event.key === 'Home') {
      event.preventDefault();
      go(0);
    } else if (event.key === 'End') {
      event.preventDefault();
      go(items.length - 1);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      onClose();
    }
  };

  // Rendered inside the Send Money dialog (not portalled to <body>): the dialog blocks
  // touches and scrolling outside itself, which stopped swiping and the Send this button.
  return (
    <div ref={rootRef} data-item-picker style={frame} className="pointer-events-auto fixed inset-0 z-[100] bg-background" role="dialog" aria-modal="true" aria-labelledby="item-picker-title" aria-describedby="item-picker-help" onKeyDown={handleKeyDown}
      onTouchStart={(e) => { touchX.current = e.touches[0]?.clientX ?? null; }}
      onTouchEnd={(e) => {
          // Backup swipe: some phones don't scroll a rail inside a locked dialog.
          const start = touchX.current; touchX.current = null;
          const end = e.changedTouches[0]?.clientX;
          if (start == null || end == null) return;
          const dx = end - start;
          if (Math.abs(dx) > 40) go(index + (dx < 0 ? 1 : -1));
        }}
    >
      <div
        ref={railRef}
        data-item-rail
        onScroll={(e) => {
          const el = e.currentTarget;
          setIndex(Math.round(el.scrollLeft / Math.max(1, el.clientWidth)));
        }}
        className="flex h-full w-full overscroll-contain snap-x snap-mandatory overflow-x-hidden overflow-y-hidden [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      >
        <div className="sr-only">
          <h2 id="item-picker-title">Choose what you are sending</h2>
          <p id="item-picker-help">Use the left and right arrow keys to browse items, then choose the item you want.</p>
        </div>
        {items.map((item) => (
          <div key={item.label} className="relative h-full w-full shrink-0 snap-center" aria-hidden={items[index]?.label !== item.label}>
            {WELILE_ITEM_IMAGES[item.label] && (
              <img
                src={WELILE_ITEM_IMAGES[item.label]}
                alt={`${item.label} item`}
                className="absolute inset-0 h-full w-full object-cover"
                draggable={false}
              />
            )}
            <div className="absolute inset-x-0 bottom-0 h-2/3 bg-gradient-to-t from-foreground/90 via-foreground/40 to-transparent" />
            <div className="absolute inset-x-0 bottom-0 px-6 pb-[max(1.5rem,env(safe-area-inset-bottom))]">
              <p className="text-5xl font-extrabold leading-none text-background drop-shadow">{item.label}</p>
              <Button
                type="button"
                onClick={() => onPick(item.label)}
                aria-label={`Choose ${item.label}`}
                disabled={items[index]?.label !== item.label}
                tabIndex={items[index]?.label === item.label ? 0 : -1}
                className="mt-6 h-16 w-full rounded-2xl text-xl font-bold shadow-lg motion-reduce:transition-none motion-reduce:active:scale-100"
              >
                <Check className="h-6 w-6" aria-hidden="true" /> Choose this
              </Button>
            </div>
          </div>
        ))}
      </div>

      <p className="sr-only" aria-live="polite" aria-atomic="true">
        {items[index]?.label}. Item {index + 1} of {items.length}.
      </p>

      {/* Top bar: close + dots */}
      <div className="pointer-events-none absolute inset-x-0 top-0 flex items-center justify-between px-4 pt-[max(1rem,env(safe-area-inset-top))]">
        <Button
          ref={closeButtonRef}
          type="button"
          onClick={onClose}
          aria-label="Close item picker"
          variant="ghost"
          size="icon-lg"
          className="pointer-events-auto rounded-full bg-background/80 text-foreground shadow motion-reduce:transition-none motion-reduce:active:scale-100"
        >
          <X className="h-6 w-6" aria-hidden="true" />
        </Button>
        <div className="flex gap-1.5 rounded-full bg-background/70 px-3 py-2" aria-hidden="true">
          {items.map((it, i) => (
            <span key={it.label} className={`h-2 rounded-full transition-all motion-reduce:transition-none ${i === index ? 'w-5 bg-primary' : 'w-2 bg-muted-foreground/50'}`} />
          ))}
        </div>
        <span className="w-12" />
      </div>

      {/* Side arrows (helpful on bigger screens) */}
      {index > 0 && (
        <Button type="button" aria-label={`Previous item: ${items[index - 1]?.label}`} onClick={() => go(index - 1)} variant="ghost" size="icon-lg"
          className="absolute left-3 top-1/2 -translate-y-1/2 rounded-full bg-background/70 shadow motion-reduce:transition-none motion-reduce:active:scale-100">
          <ChevronLeft className="h-6 w-6" aria-hidden="true" />
        </Button>
      )}
      {index < items.length - 1 && (
        <Button type="button" aria-label={`Next item: ${items[index + 1]?.label}`} onClick={() => go(index + 1)} variant="ghost" size="icon-lg"
          className="absolute right-3 top-1/2 -translate-y-1/2 rounded-full bg-background/70 shadow animate-pulse motion-reduce:animate-none motion-reduce:transition-none motion-reduce:active:scale-100">
          <ChevronRight className="h-6 w-6" aria-hidden="true" />
        </Button>
      )}
    </div>
  );
}
