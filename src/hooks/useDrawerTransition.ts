import { useEffect, useState } from 'react';

/**
 * CSS-only mount/visibility controller that replaces framer-motion's
 * <AnimatePresence> for slide/fade drawers and sheets.
 *
 * - `mounted` stays true through the exit animation so the element can
 *   transition out before it unmounts.
 * - `visible` flips on the next animation frame after mount so the CSS
 *   transition (translate/opacity) actually runs.
 *
 * lite-mode CSS (html.lite-mode) neutralizes the transition durations, so
 * low-end devices get an instant, tear-free open/close.
 */
export function useDrawerTransition(open: boolean, durationMs = 300) {
  const [mounted, setMounted] = useState(open);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (open) {
      setMounted(true);
      const raf = requestAnimationFrame(() => setVisible(true));
      return () => cancelAnimationFrame(raf);
    }
    setVisible(false);
    const t = window.setTimeout(() => setMounted(false), durationMs);
    return () => window.clearTimeout(t);
  }, [open, durationMs]);

  return { mounted, visible };
}
