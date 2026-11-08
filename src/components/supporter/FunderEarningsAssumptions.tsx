import { useState } from 'react';
import { ChevronDown, Info } from 'lucide-react';
import { format } from 'date-fns';
import { formatRatePct } from '@/lib/partnerReturnPolicy';

interface Props {
  startDate: Date;
  endDate: Date;
  daysInTerm: number;
  /** The monthly Returns rate the projections use (e.g. 15), or null when unknown. */
  rate: number | null;
}

/** Minimal, professional note explaining how funder projections are computed. */
export function FunderEarningsAssumptions({ startDate, endDate, daysInTerm, rate }: Props) {
  const [open, setOpen] = useState(false);
  // The rate as "15%"; null when unknown, and the formula line is then left out (never a guessed rate).
  const pct = formatRatePct(rate);

  return (
    <div className="rounded-2xl border border-border/60 bg-muted/30">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="w-full flex items-center gap-2 px-3 py-2.5 text-left touch-manipulation"
      >
        <Info className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
        <span className="text-[11px] font-semibold text-foreground">
          How these projections are calculated
        </span>
        <ChevronDown
          className={`ml-auto h-3.5 w-3.5 text-muted-foreground transition-transform ${open ? 'rotate-180' : ''}`}
        />
      </button>

      {open && (
        <div className="px-3 pb-3 pt-0 space-y-1.5">
          {[
            ...(pct ? [`Monthly earning = house monthly rent × ${pct}.`] : []),
            `12-month total = monthly earning × 12 months.`,
            `Daily = 12-month total ÷ ${daysInTerm} days (the actual days from ${format(startDate, 'd MMM yyyy')} to ${format(endDate, 'd MMM yyyy')}).`,
            'Weekly = daily × 7.',
            'Capital required = one month of rent per house, paid to the landlord on move-in.',
            'Earnings accrue as the tenant repays. Figures are projections, not a guaranteed return.',
          ].map((line) => (
            <p key={line} className="text-[10px] leading-relaxed text-muted-foreground flex gap-1.5">
              <span className="text-primary">•</span>
              <span>{line}</span>
            </p>
          ))}
        </div>
      )}
    </div>
  );
}
