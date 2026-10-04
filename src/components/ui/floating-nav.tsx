import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from 'react';
import { cn } from '@/lib/utils';

/**
 * Floating pill navigation primitives.
 *
 * The active indicator is measured off the active child element and moved with
 * a CSS transition (not framer-motion) so it behaves identically wherever
 * `framer-motion` resolves to `src/lib/motion-lite.tsx`, and stays tear-free on
 * low-end Android GPUs.
 */

export const FLOATING_NAV_SHELL =
  'fixed left-3 right-3 rounded-full border border-border/60 bg-background/90 backdrop-blur-xl shadow-[0_10px_34px_-8px_hsl(var(--foreground)/0.3)]';

export const FLOATING_NAV_SHELL_STYLE: CSSProperties = {
  bottom: 'calc(10px + env(safe-area-inset-bottom, 0px))',
};

export const FLOATING_NAV_ITEM =
  'relative z-10 flex flex-col items-center justify-center gap-0.5 flex-1 min-w-0 py-2 rounded-full transition-colors touch-manipulation active:scale-95 outline-none focus-visible:ring-2 focus-visible:ring-primary';

export const FLOATING_NAV_LABEL =
  'text-[10px] font-semibold tracking-wide leading-none truncate max-w-full hidden [@media(min-width:340px)]:block';

export function useSlidingIndicator(activeIndex: number, deps: unknown[] = []) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const itemRefs = useRef<(HTMLElement | null)[]>([]);
  const [indicatorStyle, setIndicatorStyle] = useState<{ width: number; left: number } | null>(null);

  const measure = useCallback(() => {
    const container = containerRef.current;
    const el = activeIndex >= 0 ? itemRefs.current[activeIndex] : null;
    if (!container || !el) {
      setIndicatorStyle(null);
      return;
    }
    const a = el.getBoundingClientRect();
    const b = container.getBoundingClientRect();
    setIndicatorStyle({ width: a.width, left: a.left - b.left });
  }, [activeIndex]);

  useLayoutEffect(() => {
    measure();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [measure, ...deps]);

  useEffect(() => {
    window.addEventListener('resize', measure);
    window.addEventListener('orientationchange', measure);
    return () => {
      window.removeEventListener('resize', measure);
      window.removeEventListener('orientationchange', measure);
    };
  }, [measure]);

  const setItemRef = useCallback(
    (index: number) => (el: HTMLElement | null) => {
      itemRefs.current[index] = el;
    },
    [],
  );

  return { containerRef, setItemRef, indicatorStyle };
}

export function SlidingIndicator({ style }: { style: { width: number; left: number } | null }) {
  return (
    <span
      aria-hidden
      className={cn(
        'absolute left-0 top-1.5 bottom-1.5 rounded-full bg-primary/12 ring-1 ring-primary/15',
        'transition-[transform,width,opacity] duration-300 ease-out',
        style ? 'opacity-100' : 'opacity-0',
      )}
      style={{ width: style?.width ?? 0, transform: `translateX(${style?.left ?? 0}px)` }}
    />
  );
}

export function FloatingNavRow({
  containerRef,
  children,
  className,
}: {
  containerRef: React.RefObject<HTMLDivElement>;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div ref={containerRef} className={cn('relative flex w-full items-center justify-between px-1.5 py-1.5', className)}>
      {children}
    </div>
  );
}
