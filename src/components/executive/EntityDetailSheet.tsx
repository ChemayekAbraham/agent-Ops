import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { useEffect, useRef, useState } from 'react';
import { Check, Link2, X } from 'lucide-react';
import { toast } from 'sonner';
import { useIsMobile } from '@/hooks/use-mobile';
import { cn } from '@/lib/utils';

export interface DetailField {
  label: string;
  value: React.ReactNode;
}

interface EntityDetailSheetProps {
  open: boolean;
  onClose: () => void;
  title: string;
  subtitle?: React.ReactNode;
  icon?: React.ReactNode;
  fields?: DetailField[];
  /** When provided, a "Copy link" button shares this deep link to the record */
  shareUrl?: string;
  /** Render as a full smartphone-height screen on mobile devices */
  fullScreenOnMobile?: boolean;
  /** Extra content (e.g. contact CTAs, tenant lists) shown below the fields */
  children?: React.ReactNode;
}

export function EntityDetailSheet({
  open,
  onClose,
  title,
  subtitle,
  icon,
  fields = [],
  shareUrl,
  fullScreenOnMobile = false,
  children,
}: EntityDetailSheetProps) {
  const [copied, setCopied] = useState(false);
  const isMobile = useIsMobile();
  const fullScreen = fullScreenOnMobile && isMobile;

  // Focus return: remember whatever element opened the sheet (e.g. the
  // "View landlord profile" button) and restore focus to it on any dismiss
  // path — swipe-down, Escape, Close button, backdrop, or confirm.
  const triggerRef = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (open) {
      triggerRef.current = document.activeElement as HTMLElement | null;
      return;
    }
    const el = triggerRef.current;
    triggerRef.current = null;
    if (!el) return;
    // Wait for the sheet to unmount so focus isn't stolen back, then restore
    // focus only if the trigger is still in the DOM and focusable.
    requestAnimationFrame(() => {
      if (el.isConnected && typeof el.focus === 'function') {
        el.focus();
      }
    });
  }, [open]);

  // Swipe-down-to-close for the full-screen mobile view.
  const touchStart = useRef<{ x: number; y: number; t: number } | null>(null);
  const [dragY, setDragY] = useState(0);

  const handleTouchStart = (e: React.TouchEvent) => {
    // Only start a drag when the scroll container is at the top, so the
    // gesture never fights with normal content scrolling.
    if (e.currentTarget.scrollTop > 0) {
      touchStart.current = null;
      return;
    }
    const t = e.touches[0];
    touchStart.current = { x: t.clientX, y: t.clientY, t: Date.now() };
  };

  const handleTouchMove = (e: React.TouchEvent) => {
    if (!touchStart.current) return;
    const t = e.touches[0];
    const dy = t.clientY - touchStart.current.y;
    const dx = t.clientX - touchStart.current.x;
    // Ignore mostly-horizontal moves and upward drags.
    if (dy <= 0 || Math.abs(dx) > Math.abs(dy)) {
      setDragY(0);
      return;
    }
    setDragY(dy);
  };

  const handleTouchEnd = () => {
    if (!touchStart.current) return;
    const dropped = dragY;
    touchStart.current = null;
    setDragY(0);
    if (dropped > 120) onClose();
  };

  const handleShare = async () => {
    if (!shareUrl) return;
    try {
      if (navigator.share) {
        await navigator.share({ title, url: shareUrl });
        return;
      }
    } catch {
      /* user cancelled native share — fall through to clipboard */
    }
    try {
      await navigator.clipboard.writeText(shareUrl);
      setCopied(true);
      toast.success('Link copied to clipboard');
      setTimeout(() => setCopied(false), 2000);
    } catch {
      toast.error('Could not copy link');
    }
  };

  return (
    <Sheet open={open} onOpenChange={(o) => { if (!o) onClose(); }}>
      <SheetContent
        side="bottom"
        className={cn(
          // z-[160] keeps this above dialogs (z-[150]) so the profile opens
          // on top of the find-house dialog instead of behind it.
          'z-[160] overflow-y-auto',
          fullScreen
            ? 'h-[100dvh] max-h-[100dvh] rounded-none'
            : 'max-h-[90vh] rounded-t-2xl',
        )}
        overlayClassName="z-[155]"
        onTouchStart={fullScreen ? handleTouchStart : undefined}
        onTouchMove={fullScreen ? handleTouchMove : undefined}
        onTouchEnd={fullScreen ? handleTouchEnd : undefined}
        onEscapeKeyDown={(e) => { e.preventDefault(); onClose(); }}
        style={
          fullScreen && dragY > 0
            ? { transform: `translateY(${dragY}px)`, transition: 'none' }
            : undefined
        }
      >
        {fullScreen && (
          <>
            <div className="mx-auto -mt-1 mb-2 h-1.5 w-12 shrink-0 rounded-full bg-muted-foreground/30" />
            <button
              type="button"
              onClick={onClose}
              aria-label="Close profile"
              className="mb-2 flex items-center gap-1.5 self-start rounded-lg border border-border bg-muted/40 px-3 py-1.5 text-xs font-semibold text-foreground transition-colors hover:bg-muted active:scale-[0.99] touch-manipulation"
            >
              <X className="h-3.5 w-3.5" />
              Close
            </button>
          </>
        )}
        <SheetHeader className="text-left">
          <SheetTitle className="flex items-center gap-2 text-base">
            {icon}
            <span className="truncate">{title}</span>
          </SheetTitle>
          {subtitle && <p className="text-xs text-muted-foreground">{subtitle}</p>}
        </SheetHeader>

        {shareUrl && (
          <button
            onClick={handleShare}
            className="mt-3 flex w-full items-center justify-center gap-2 rounded-lg border border-border bg-muted/40 px-3 py-2 text-xs font-semibold text-foreground transition-colors hover:bg-muted active:scale-[0.99] touch-manipulation"
          >
            {copied ? <Check className="h-3.5 w-3.5 text-emerald-600" /> : <Link2 className="h-3.5 w-3.5" />}
            {copied ? 'Copied' : 'Copy share link'}
          </button>
        )}

        {fields.length > 0 && (
          <dl className="mt-4 divide-y divide-border rounded-xl border border-border bg-card">
            {fields.map((f, i) => (
              <div key={i} className="flex items-start justify-between gap-3 px-3 py-2.5">
                <dt className="text-xs font-medium text-muted-foreground shrink-0">{f.label}</dt>
                <dd className="text-xs font-semibold text-foreground text-right break-words min-w-0">{f.value}</dd>
              </div>
            ))}
          </dl>
        )}

        {children && <div className="mt-4 space-y-3">{children}</div>}
      </SheetContent>
    </Sheet>
  );
}

export default EntityDetailSheet;