import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Check, ChevronLeft, ChevronRight, X } from 'lucide-react';
import { WELILE_ITEM_IMAGES } from '@/lib/welileItemImages';

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
  const [index, setIndex] = useState(0);

  useEffect(() => {
    if (!open) return;
    const start = Math.max(0, items.findIndex((i) => i.label === startLabel));
    setIndex(start);
    requestAnimationFrame(() => {
      const el = railRef.current;
      if (el) el.scrollTo({ left: start * el.clientWidth, behavior: 'instant' as ScrollBehavior });
    });
  }, [open, startLabel, items]);

  if (!open) return null;

  const go = (i: number) => {
    const el = railRef.current;
    if (!el) return;
    const n = Math.min(items.length - 1, Math.max(0, i));
    el.scrollTo({ left: n * el.clientWidth, behavior: 'smooth' });
  };

  return createPortal(
    <div className="fixed inset-0 z-[100] bg-background" role="dialog" aria-label="Choose what you are sending">
      <div
        ref={railRef}
        onScroll={(e) => {
          const el = e.currentTarget;
          setIndex(Math.round(el.scrollLeft / Math.max(1, el.clientWidth)));
        }}
        className="flex h-full w-full snap-x snap-mandatory overflow-x-auto overflow-y-hidden [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      >
        {items.map((item) => (
          <div key={item.label} className="relative h-full w-full shrink-0 snap-center">
            {WELILE_ITEM_IMAGES[item.label] && (
              <img
                src={WELILE_ITEM_IMAGES[item.label]}
                alt={item.hint}
                className="absolute inset-0 h-full w-full object-cover"
                draggable={false}
              />
            )}
            <div className="absolute inset-x-0 bottom-0 h-2/3 bg-gradient-to-t from-foreground/90 via-foreground/40 to-transparent" />
            <div className="absolute inset-x-0 bottom-0 px-6 pb-[max(1.5rem,env(safe-area-inset-bottom))]">
              <p className="text-5xl font-extrabold leading-none text-background drop-shadow">{item.hint}</p>
              <button
                type="button"
                onClick={() => onPick(item.label)}
                className="mt-6 flex h-16 w-full items-center justify-center gap-2 rounded-2xl bg-primary text-xl font-bold text-primary-foreground shadow-lg active:scale-[0.98]"
              >
                <Check className="h-6 w-6" /> Send this
              </button>
            </div>
          </div>
        ))}
      </div>

      {/* Top bar: close + dots */}
      <div className="pointer-events-none absolute inset-x-0 top-0 flex items-center justify-between px-4 pt-[max(1rem,env(safe-area-inset-top))]">
        <button
          type="button"
          onClick={onClose}
          aria-label="Close"
          className="pointer-events-auto flex h-12 w-12 items-center justify-center rounded-full bg-background/80 text-foreground shadow"
        >
          <X className="h-6 w-6" />
        </button>
        <div className="flex gap-1.5 rounded-full bg-background/70 px-3 py-2">
          {items.map((it, i) => (
            <span key={it.label} className={`h-2 rounded-full transition-all ${i === index ? 'w-5 bg-primary' : 'w-2 bg-muted-foreground/50'}`} />
          ))}
        </div>
        <span className="w-12" />
      </div>

      {/* Side arrows (helpful on bigger screens) */}
      {index > 0 && (
        <button type="button" aria-label="Previous" onClick={() => go(index - 1)}
          className="absolute left-3 top-1/2 flex h-12 w-12 -translate-y-1/2 items-center justify-center rounded-full bg-background/70 shadow">
          <ChevronLeft className="h-6 w-6" />
        </button>
      )}
      {index < items.length - 1 && (
        <button type="button" aria-label="Next" onClick={() => go(index + 1)}
          className="absolute right-3 top-1/2 flex h-12 w-12 -translate-y-1/2 items-center justify-center rounded-full bg-background/70 shadow animate-pulse">
          <ChevronRight className="h-6 w-6" />
        </button>
      )}
    </div>,
    document.body,
  );
}
