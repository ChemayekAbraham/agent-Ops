import { useState } from 'react';
import { Info } from 'lucide-react';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { cn } from '@/lib/utils';
import { FIGURE_LABELS, type FigureKey } from '@/lib/tenantOpsFigureLabels';

/**
 * A figure's name with a one-line explanation of what it includes. The name itself already says whether it is an
 * all-time or period figure, so the explanation is a help, not a requirement; it opens on hover, focus and tap
 * (a plain tooltip does not open on a phone).
 */
export function FigureLabel({ figure, className }: { figure: FigureKey; className?: string }) {
  const [open, setOpen] = useState(false);
  const { label, hint } = FIGURE_LABELS[figure];
  return (
    <span className={cn('inline-flex items-center gap-1 align-middle', className)}>
      <span>{label}</span>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <button
            type="button"
            aria-label={`What is ${label}?`}
            className="inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-full text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
            onMouseEnter={() => setOpen(true)}
            onMouseLeave={() => setOpen(false)}
          >
            <Info className="h-3.5 w-3.5" />
          </button>
        </PopoverTrigger>
        <PopoverContent side="top" className="w-64 p-2.5 text-xs font-normal leading-relaxed normal-case tracking-normal text-foreground">
          {hint}
        </PopoverContent>
      </Popover>
    </span>
  );
}
