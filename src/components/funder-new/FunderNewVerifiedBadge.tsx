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
export function FunderNewVerifiedBadge({ className }: { className?: string }) {
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
                  'inline-flex h-6 w-6 items-center justify-center rounded-full bg-success text-success-foreground shadow-sm ring-2 ring-background transition-transform focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring active:scale-95',
                  className,
                )}
              >
                <Check className="h-3.5 w-3.5" strokeWidth={3.5} aria-hidden />
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
