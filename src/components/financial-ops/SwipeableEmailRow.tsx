import { useRef, useState, type ReactNode } from 'react';

/**
 * Config for the single primary action revealed when an email row is swiped
 * left on a touch device. `onAction` fires the same handler the on-row CTA
 * would (route a deposit / charge a payout) — no full-details drilldown.
 */
export interface SwipeAction {
  label: string;
  /** Short label shown while the row is being dragged (before threshold). */
  hint: string;
  icon: ReactNode;
  /** Tailwind background class for the revealed action panel. */
  colorClass: string;
  onAction: () => void;
  /**
   * Accessible name for the keyboard/screen-reader trigger. Defaults to
   * `label`, but callers should pass a descriptive string that includes the
   * amount / counterparty so the action is unambiguous out of visual context.
   */
  ariaLabel?: string;
}

const TRIGGER_THRESHOLD = 88; // px of left-drag needed to fire the action
const MAX_DRAG = 132; // px the row can travel while dragging

/**
 * Wraps a single email transaction row and adds a left-swipe gesture on touch
 * devices. Dragging the row left reveals a colored action panel; releasing
 * past the threshold triggers the primary routing/charging action directly.
 *
 * On non-touch / desktop the wrapper is inert — the row renders normally and
 * the existing on-row buttons remain the interaction path.
 */
export function SwipeableEmailRow({
  action,
  secondaryAction,
  children,
}: {
  action?: SwipeAction | null;
  /** Optional action revealed by swiping the row RIGHT (e.g. mark resolved). */
  secondaryAction?: SwipeAction | null;
  children: ReactNode;
}) {
  const [dx, setDx] = useState(0);
  const [animating, setAnimating] = useState(false);
  const startX = useRef<number | null>(null);
  const startY = useRef<number | null>(null);
  const dragging = useRef(false);

  if (!action && !secondaryAction) return <>{children}</>;

  const armed = Math.abs(dx) >= TRIGGER_THRESHOLD;
  // Which action the current drag direction targets.
  const activeAction = dx < 0 ? action : dx > 0 ? secondaryAction : null;

  const reset = () => {
    setAnimating(true);
    setDx(0);
    startX.current = null;
    startY.current = null;
    dragging.current = false;
    window.setTimeout(() => setAnimating(false), 180);
  };

  const onTouchStart = (e: React.TouchEvent) => {
    const t = e.touches[0];
    startX.current = t.clientX;
    startY.current = t.clientY;
    dragging.current = false;
    setAnimating(false);
  };

  const onTouchMove = (e: React.TouchEvent) => {
    if (startX.current == null || startY.current == null) return;
    const t = e.touches[0];
    const deltaX = t.clientX - startX.current;
    const deltaY = t.clientY - startY.current;
    if (!dragging.current) {
      // Only engage on a clearly horizontal swipe (left → primary action,
      // right → secondary action); otherwise let the list scroll vertically.
      const wantsLeft = deltaX < -8 && !!action;
      const wantsRight = deltaX > 8 && !!secondaryAction;
      if ((wantsLeft || wantsRight) && Math.abs(deltaX) > Math.abs(deltaY)) {
        dragging.current = true;
      } else if (Math.abs(deltaY) > 8) {
        startX.current = null;
        return;
      } else {
        return;
      }
    }
    const clamped = Math.max(
      action ? -MAX_DRAG : 0,
      Math.min(secondaryAction ? MAX_DRAG : 0, deltaX),
    );
    setDx(clamped);
    if (e.cancelable) e.preventDefault();
  };

  const onTouchEnd = () => {
    const fire = Math.abs(dx) >= TRIGGER_THRESHOLD ? activeAction : null;
    if (fire) {
      try {
        (navigator as unknown as { vibrate?: (n: number) => void }).vibrate?.(12);
      } catch { /* haptics best-effort */ }
      fire.onAction();
    }
    reset();
  };

  return (
    <div className="relative overflow-hidden">
      {/*
        Keyboard + screen-reader equivalent of the touch swipe. Visually hidden
        until focused (Tab), then it surfaces as a real button so keyboard and
        assistive-tech users can trigger the same primary action without a
        swipe gesture.
      */}
      {[action, secondaryAction].map((a, i) =>
        a ? (
          <button
            key={i}
            type="button"
            onClick={a.onAction}
            aria-label={a.ariaLabel ?? a.label}
            className={`sr-only focus:not-sr-only focus:absolute focus:left-2 focus:z-10 focus:inline-flex focus:items-center focus:gap-1.5 focus:rounded-md focus:px-3 focus:py-2 focus:text-xs focus:font-semibold focus:text-white focus:shadow-lg focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 min-h-11 ${i === 0 ? 'focus:top-2' : 'focus:top-16'} ${a.colorClass}`}
          >
            <span aria-hidden className="inline-flex items-center gap-1.5">
              {a.icon}
              {a.label}
            </span>
          </button>
        ) : null,
      )}
      {/* Revealed action panel behind the row — right edge for the primary
          (left-swipe) action, left edge for the secondary (right-swipe) one. */}
      {action && (
        <div
          aria-hidden
          className={`absolute inset-y-0 right-0 flex items-center justify-end gap-2 pr-5 pl-8 text-white transition-opacity ${action.colorClass} ${
            dx < -4 ? 'opacity-100' : 'opacity-0'
          }`}
          style={{ width: MAX_DRAG + 24 }}
        >
          <div
            className={`flex flex-col items-center gap-0.5 transition-transform ${armed ? 'scale-110' : 'scale-95'}`}
          >
            {action.icon}
            <span className="text-[10px] font-semibold uppercase tracking-wide">
              {armed ? action.label : action.hint}
            </span>
          </div>
        </div>
      )}
      {secondaryAction && (
        <div
          aria-hidden
          className={`absolute inset-y-0 left-0 flex items-center justify-start gap-2 pl-5 pr-8 text-white transition-opacity ${secondaryAction.colorClass} ${
            dx > 4 ? 'opacity-100' : 'opacity-0'
          }`}
          style={{ width: MAX_DRAG + 24 }}
        >
          <div
            className={`flex flex-col items-center gap-0.5 transition-transform ${armed ? 'scale-110' : 'scale-95'}`}
          >
            {secondaryAction.icon}
            <span className="text-[10px] font-semibold uppercase tracking-wide">
              {armed ? secondaryAction.label : secondaryAction.hint}
            </span>
          </div>
        </div>
      )}
      {/* Foreground row content — translates with the drag. */}
      <div
        onTouchStart={onTouchStart}
        onTouchMove={onTouchMove}
        onTouchEnd={onTouchEnd}
        onTouchCancel={reset}
        style={{
          transform: `translateX(${dx}px)`,
          transition: animating ? 'transform 0.18s ease-out' : 'none',
          touchAction: 'pan-y',
        }}
        className="relative bg-card"
      >
        {children}
      </div>
    </div>
  );
}
