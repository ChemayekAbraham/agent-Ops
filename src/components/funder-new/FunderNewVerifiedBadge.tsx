import { Check } from 'lucide-react';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { cn } from '@/lib/utils';

const LABEL = 'House verified by Welile';
const EXPLANATION =
  'A Welile agent has checked this house on site. It is not a guarantee of Returns, insurance, or anyone\u2019s identity.';

/**
 * One small check badge, shown only when the HOUSE itself is verified.
 * Tap works for touch users; hover/focus works for pointer and keyboard.
 */
export function FunderNewVerifiedBadge({
  className,
  variant = 'pill',
}: {
  className?: string;
  /** `icon` is the compact browse-list check; `pill` is the labelled badge. */
  variant?: 'pill' | 'icon';
}) {
  return (
    <TooltipProvider delayDuration={200}>
      <Popover>
        <Tooltip>
          <TooltipTrigger asChild>
            <PopoverTrigger asChild>
              <button
                type="button"
                aria-label={LABEL}
                className={cn(
                  // A labelled pill, not a bare tick: a plain check circle read
                  // like a "selected" state on the photo.
                  'inline-flex items-center gap-1 rounded-full bg-success px-2 py-0.5 text-[11px] font-semibold text-success-foreground shadow-sm ring-1 ring-background/60 transition-transform focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring active:scale-95',
                  className,
                )}
              >
                <Check className="h-3 w-3" strokeWidth={3.5} aria-hidden />
                Verified
              </button>

            </PopoverTrigger>
          </TooltipTrigger>
          <TooltipContent side="top" className="max-w-56 text-xs">
            {LABEL}
          </TooltipContent>
        </Tooltip>
        <PopoverContent side="top" align="start" className="w-64 text-xs leading-relaxed">
          <p className="text-sm font-semibold">{LABEL}</p>
          <p className="mt-1 text-muted-foreground">{EXPLANATION}</p>
        </PopoverContent>
      </Popover>
    </TooltipProvider>
  );
}

export default FunderNewVerifiedBadge;
