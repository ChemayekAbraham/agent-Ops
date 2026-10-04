import React, { forwardRef, useMemo } from 'react';

/**
 * motion-lite — a zero-dependency drop-in for the small subset of the
 * framer-motion API this app actually uses.
 *
 * Why: framer-motion ships ~120 KB (38 KB gzip) of JS and drives animated
 * compositing that tears/corrupts on low-end Android GPUs. These components
 * only used framer for entrance fades/slides and hover/tap scaling — all of
 * which CSS does natively and for free.
 *
 * `motion.<tag>` renders the plain DOM tag with every framer-only prop
 * stripped, and applies a light CSS entrance animation when the element
 * declared an `initial`/`animate`. In `html.lite-mode` the global CSS
 * neutralizes these animations entirely, so low-memory phones get instant,
 * tear-free rendering. All non-animation props (className, style, ref,
 * event handlers, aria-*, data-*) pass straight through, so focus order,
 * Escape handling, clicks and layout are unchanged.
 */

const FRAMER_ONLY_PROPS = new Set([
  'initial', 'animate', 'exit', 'variants', 'transition',
  'whileHover', 'whileTap', 'whileFocus', 'whileDrag', 'whileInView',
  'viewport', 'layout', 'layoutId', 'layoutScroll', 'layoutDependency',
  'custom', 'drag', 'dragConstraints', 'dragElastic', 'dragMomentum',
  'dragTransition', 'dragSnapToOrigin', 'dragPropagation', 'dragControls',
  'dragListener', 'onDrag', 'onDragStart', 'onDragEnd', 'onDirectionLock',
  'onAnimationStart', 'onAnimationComplete', 'onUpdate',
  'onHoverStart', 'onHoverEnd', 'onTap', 'onTapStart', 'onTapCancel',
  'onViewportEnter', 'onViewportLeave', 'onLayoutAnimationStart',
  'onLayoutAnimationComplete', 'transformTemplate', 'style_', 'variant',
]);

function useFilteredProps(props: Record<string, unknown>) {
  return useMemo(() => {
    const hasEntrance = 'initial' in props || 'animate' in props;
    const out: Record<string, unknown> = {};
    for (const key in props) {
      if (FRAMER_ONLY_PROPS.has(key)) continue;
      out[key] = props[key];
    }
    if (hasEntrance) {
      // Append a CSS entrance animation (neutralized in lite-mode).
      out.className = [out.className, 'motion-lite-enter'].filter(Boolean).join(' ');
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props]);
}

const componentCache = new Map<string, React.ComponentType<Record<string, unknown>>>();

function getComponent(tag: string) {
  const cached = componentCache.get(tag);
  if (cached) return cached;
  const Comp = forwardRef<unknown, Record<string, unknown>>((props, ref) => {
    const filtered = useFilteredProps(props);
    return React.createElement(tag, { ref, ...filtered });
  });
  Comp.displayName = `motion.${tag}`;
  componentCache.set(tag, Comp as React.ComponentType<Record<string, unknown>>);
  return Comp;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const motion: any = new Proxy({}, {
  get: (target, tag: string | symbol) => {
    // React Refresh / bundler internals probe modules with symbol keys
    // (Symbol.toStringTag, Symbol.toPrimitive, etc.). Never feed those to
    // getComponent — string-concatenating a Symbol throws.
    if (typeof tag !== 'string') {
      return Reflect.get(target, tag);
    }
    return getComponent(tag);
  },
});

export function AnimatePresence({
  children,
}: {
  children?: React.ReactNode;
  // Accept (and ignore) framer-only props so call sites type-check.
  mode?: 'sync' | 'wait' | 'popLayout';
  initial?: boolean;
  onExitComplete?: () => void;
  custom?: unknown;
  presenceAffectsLayout?: boolean;
}) {
  return <>{children}</>;
}

// Hook shims — return static values so callers behave as "no motion".
export const useReducedMotion = () => true;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const useMotionValue = (initial: any) => initial;
export const useTransform = () => 0;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const useSpring = (initial: any) => initial;
export const useScroll = () => ({ scrollY: 0, scrollYProgress: 0 });
export const useAnimation = () => ({ start: () => Promise.resolve(), stop: () => {}, set: () => {} });

// Type shims (compile-time only).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Variants = Record<string, any>;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type PanInfo = any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type MotionProps = any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Transition = any;
