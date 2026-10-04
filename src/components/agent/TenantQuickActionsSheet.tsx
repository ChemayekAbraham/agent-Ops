import { useState, useRef, useEffect, useCallback, TouchEvent as RTouchEvent } from 'react';
import { Phone, MessageCircle, Banknote, Share2, Loader2, ChevronUp } from 'lucide-react';
import { cn } from '@/lib/utils';
import { hapticTap } from '@/lib/haptics';

interface TenantQuickActionsSheetProps {
  tenantName: string;
  phone: string;
  phoneIntl: string;
  onCollect: () => void;
  onShare: () => void;
  collectDisabled?: boolean;
  shareLoading?: boolean;
}

/**
 * Mobile-only bottom sheet with quick actions.
 * - Collapsed: compact icon row with grip handle.
 * - Expanded: large, accessible action buttons (>=64px tall).
 * - Drag the handle (or swipe) up/down to toggle.
 */
export function TenantQuickActionsSheet({
  tenantName,
  phone,
  phoneIntl,
  onCollect,
  onShare,
  collectDisabled,
  shareLoading,
}: TenantQuickActionsSheetProps) {
  const [expanded, setExpanded] = useState(false);
  const [dragOffset, setDragOffset] = useState(0);
  const startY = useRef<number | null>(null);
  const lockedAxis = useRef<'v' | 'h' | null>(null);

  const toggle = useCallback(() => {
    hapticTap();
    setExpanded((v) => !v);
  }, []);

  const onTouchStart = (e: RTouchEvent<HTMLElement>) => {
    startY.current = e.touches[0].clientY;
    lockedAxis.current = null;
    setDragOffset(0);
  };

  const onTouchMove = (e: RTouchEvent<HTMLElement>) => {
    if (startY.current === null) return;
    const dy = e.touches[0].clientY - startY.current;
    if (lockedAxis.current === null && Math.abs(dy) > 6) {
      lockedAxis.current = 'v';
    }
    if (lockedAxis.current !== 'v') return;
    // Limit drag visual range
    const limited = expanded ? Math.max(0, Math.min(dy, 160)) : Math.max(-160, Math.min(dy, 0));
    setDragOffset(limited);
  };

  const onTouchEnd = () => {
    if (startY.current === null) {
      setDragOffset(0);
      return;
    }
    const threshold = 40;
    if (!expanded && dragOffset < -threshold) {
      hapticTap();
      setExpanded(true);
    } else if (expanded && dragOffset > threshold) {
      hapticTap();
      setExpanded(false);
    }
    startY.current = null;
    lockedAxis.current = null;
    setDragOffset(0);
  };

  // Close on Escape for keyboard users
  useEffect(() => {
    if (!expanded) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setExpanded(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [expanded]);

  return (
    <div
      className="sm:hidden fixed bottom-0 inset-x-0 z-30"
      role="region"
      aria-label="Quick actions"
    >
      <div
        className={cn(
          'mx-auto max-w-2xl border-t border-border/60 bg-background/95 backdrop-blur-md',
          'shadow-[0_-8px_30px_-12px_hsl(var(--foreground)/0.25)] rounded-t-2xl',
          'transition-transform duration-300 ease-out will-change-transform',
        )}
        style={{
          transform: dragOffset ? `translateY(${dragOffset}px)` : undefined,
          transition: dragOffset ? 'none' : undefined,
        }}
      >
        {/* Drag handle */}
        <button
          type="button"
          onClick={toggle}
          onTouchStart={onTouchStart}
          onTouchMove={onTouchMove}
          onTouchEnd={onTouchEnd}
          className="w-full flex flex-col items-center justify-center pt-2 pb-1 select-none touch-none"
          aria-label={expanded ? 'Collapse quick actions' : 'Expand quick actions'}
          aria-expanded={expanded}
          style={{ WebkitTapHighlightColor: 'transparent' }}
        >
          <span className="block h-1.5 w-12 rounded-full bg-muted-foreground/40" />
          <span className="mt-1 flex items-center gap-1 text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">
            {expanded ? 'Swipe down' : 'Swipe up for more'}
            <ChevronUp
              className={cn(
                'h-3 w-3 transition-transform duration-300',
                expanded && 'rotate-180',
              )}
            />
          </span>
        </button>

        {/* Collapsed compact row */}
        {!expanded && (
          <div
            className="grid grid-cols-4 gap-1.5 px-2 pb-[max(0.5rem,env(safe-area-inset-bottom))] pt-1 animate-fade-in"
            role="toolbar"
            aria-label="Compact quick actions"
          >
            <a
              href={`tel:${phone}`}
              className="flex flex-col items-center justify-center gap-1 h-14 rounded-xl bg-primary/10 active:scale-95 transition-transform"
              aria-label={`Call ${tenantName}`}
            >
              <Phone className="h-5 w-5 text-primary" />
              <span className="text-[11px] font-semibold text-primary">Call</span>
            </a>
            <a
              href={`https://wa.me/${phoneIntl}`}
              target="_blank"
              rel="noopener noreferrer"
              className="flex flex-col items-center justify-center gap-1 h-14 rounded-xl bg-success/15 active:scale-95 transition-transform"
              aria-label={`Open WhatsApp chat with ${tenantName}`}
            >
              <MessageCircle className="h-5 w-5 text-success" />
              <span className="text-[11px] font-semibold text-success">WhatsApp</span>
            </a>
            <button
              type="button"
              onClick={onCollect}
              disabled={collectDisabled}
              className="flex flex-col items-center justify-center gap-1 h-14 rounded-xl bg-warning/15 active:scale-95 transition-transform disabled:opacity-40 disabled:active:scale-100"
              aria-label="Collect rent from operations float"
            >
              <Banknote className="h-5 w-5 text-warning" />
              <span className="text-[11px] font-semibold text-warning">Collect</span>
            </button>
            <button
              type="button"
              onClick={onShare}
              disabled={shareLoading}
              className="flex flex-col items-center justify-center gap-1 h-14 rounded-xl bg-muted active:scale-95 transition-transform disabled:opacity-50"
              aria-label="Share tenant profile"
            >
              {shareLoading ? (
                <Loader2 className="h-5 w-5 animate-spin text-foreground" />
              ) : (
                <Share2 className="h-5 w-5 text-foreground" />
              )}
              <span className="text-[11px] font-semibold text-foreground">Share</span>
            </button>
          </div>
        )}

        {/* Expanded large buttons */}
        {expanded && (
          <div
            className="px-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] pt-2 space-y-2 animate-fade-in"
            role="toolbar"
            aria-label="Expanded quick actions"
          >
            <a
              href={`tel:${phone}`}
              onClick={() => setExpanded(false)}
              className="flex items-center gap-3 w-full min-h-[64px] rounded-2xl bg-primary text-primary-foreground px-4 active:scale-[0.98] transition-transform shadow-md"
              aria-label={`Call ${tenantName}`}
            >
              <span className="h-11 w-11 rounded-xl bg-primary-foreground/15 flex items-center justify-center">
                <Phone className="h-6 w-6" />
              </span>
              <span className="flex flex-col items-start">
                <span className="text-base font-bold leading-tight">Call</span>
                <span className="text-xs opacity-80">{phone}</span>
              </span>
            </a>

            <a
              href={`https://wa.me/${phoneIntl}`}
              target="_blank"
              rel="noopener noreferrer"
              onClick={() => setExpanded(false)}
              className="flex items-center gap-3 w-full min-h-[64px] rounded-2xl bg-success text-success-foreground px-4 active:scale-[0.98] transition-transform shadow-md"
              aria-label={`Open WhatsApp chat with ${tenantName}`}
            >
              <span className="h-11 w-11 rounded-xl bg-success-foreground/15 flex items-center justify-center">
                <MessageCircle className="h-6 w-6" />
              </span>
              <span className="flex flex-col items-start">
                <span className="text-base font-bold leading-tight">WhatsApp</span>
                <span className="text-xs opacity-80">Send a message</span>
              </span>
            </a>

            <button
              type="button"
              onClick={() => {
                setExpanded(false);
                onCollect();
              }}
              disabled={collectDisabled}
              className="flex items-center gap-3 w-full min-h-[64px] rounded-2xl bg-warning text-warning-foreground px-4 active:scale-[0.98] transition-transform shadow-md disabled:opacity-40 disabled:active:scale-100"
              aria-label="Collect rent from operations float"
            >
              <span className="h-11 w-11 rounded-xl bg-warning-foreground/15 flex items-center justify-center">
                <Banknote className="h-6 w-6" />
              </span>
              <span className="flex flex-col items-start">
                <span className="text-base font-bold leading-tight">Collect Rent</span>
                <span className="text-xs opacity-80">From operations float</span>
              </span>
            </button>

            <button
              type="button"
              onClick={() => {
                setExpanded(false);
                onShare();
              }}
              disabled={shareLoading}
              className="flex items-center gap-3 w-full min-h-[64px] rounded-2xl bg-muted text-foreground px-4 active:scale-[0.98] transition-transform shadow-sm disabled:opacity-50"
              aria-label="Share tenant profile"
            >
              <span className="h-11 w-11 rounded-xl bg-background flex items-center justify-center">
                {shareLoading ? <Loader2 className="h-6 w-6 animate-spin" /> : <Share2 className="h-6 w-6" />}
              </span>
              <span className="flex flex-col items-start">
                <span className="text-base font-bold leading-tight">Share Profile</span>
                <span className="text-xs opacity-80">WhatsApp / link</span>
              </span>
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
