import { Gift, CalendarCheck, Sparkles } from 'lucide-react';
import { cn } from '@/lib/utils';

/**
 * Welile "Move-in offer" — every listed house lets a tenant move in TODAY and
 * start paying daily, with the FIRST 7 DAYS FREE (a 7-day discount). This is a
 * platform-wide promise on all listings, so the offer is hard-coded here as the
 * single source of truth and surfaced prominently on every house card/detail.
 *
 * Agents use this to pitch potential tenants: "Move in now, your first week is on us."
 */
export const MOVE_IN_FREE_DAYS = 7;

interface MoveInOfferBadgeProps {
  /** `pill` = tiny chip for cards; `banner` = full explanatory strip for detail views. */
  variant?: 'pill' | 'banner';
  className?: string;
}

export function MoveInOfferBadge({ variant = 'pill', className }: MoveInOfferBadgeProps) {
  if (variant === 'banner') {
    return (
      <div
        className={cn(
          'flex items-center gap-3 rounded-2xl border border-success/30 bg-gradient-to-r from-success/15 via-success/5 to-transparent px-4 py-3',
          className,
        )}
      >
        <div className="shrink-0 grid place-items-center h-9 w-9 rounded-full bg-success/20">
          <Gift className="h-5 w-5 text-success" />
        </div>
        <div className="min-w-0">
          <p className="font-bold text-sm text-success leading-tight flex items-center gap-1">
            Move in today — first {MOVE_IN_FREE_DAYS} days free
            <Sparkles className="h-3.5 w-3.5" />
          </p>
          <p className="text-xs text-muted-foreground leading-snug mt-0.5">
            Start your stay now and only begin daily payments after a {MOVE_IN_FREE_DAYS}-day discount window.
          </p>
        </div>
      </div>
    );
  }

  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-full bg-success/15 border border-success/30 px-2 py-0.5 text-[10px] font-bold text-success leading-none',
        className,
      )}
    >
      <CalendarCheck className="h-3 w-3 shrink-0" />
      First {MOVE_IN_FREE_DAYS} days free
    </span>
  );
}
