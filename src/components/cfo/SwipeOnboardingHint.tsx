import { useEffect, useState } from 'react';
import { MoveHorizontal, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

const STORAGE_KEY = 'dashboard:swipeHintSeen';

/**
 * One-time, mobile-only coach mark teaching the user they can swipe left/right
 * to move between dashboard sections. Once dismissed (or auto-hidden), the flag
 * is stored in localStorage so it never shows again on this device.
 */
export function SwipeOnboardingHint({ enabled }: { enabled: boolean }) {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (!enabled) return;
    try {
      if (window.localStorage.getItem(STORAGE_KEY) === '1') return;
    } catch {
      return;
    }
    // Small delay so it appears after the dashboard settles.
    const t = setTimeout(() => setVisible(true), 600);
    return () => clearTimeout(t);
  }, [enabled]);

  const dismiss = () => {
    setVisible(false);
    try {
      window.localStorage.setItem(STORAGE_KEY, '1');
    } catch {
      /* storage unavailable */
    }
  };

  if (!enabled || !visible) return null;

  return (
    <div
      role="status"
      aria-live="polite"
      className={cn(
        'mb-3 flex items-center gap-3 rounded-xl border border-primary/30 bg-primary/5 p-3',
        'animate-in fade-in slide-in-from-top-2 duration-300',
      )}
    >
      <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-primary/15 text-primary">
        <MoveHorizontal className="h-5 w-5 animate-pulse" />
      </div>
      <div className="min-w-0 flex-1">
        <p className="text-sm font-semibold text-foreground">Swipe to navigate</p>
        <p className="text-xs text-muted-foreground">
          Swipe left or right to move between dashboard sections.
        </p>
      </div>
      <Button size="sm" variant="default" className="shrink-0" onClick={dismiss}>
        Got it
      </Button>
      <Button
        size="icon"
        variant="ghost"
        className="h-8 w-8 shrink-0"
        aria-label="Dismiss swipe hint"
        onClick={dismiss}
      >
        <X className="h-4 w-4" />
      </Button>
    </div>
  );
}
