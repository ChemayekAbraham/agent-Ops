import { useState } from 'react';
import { ChevronDown } from 'lucide-react';
import { formatUGX } from '@/lib/rentCalculations';
import { FUNDER_MONTHLY_RATE, type FunderEarnings } from '@/lib/funderEarnings';

interface Props {
  earn: FunderEarnings;
}

/** Per-house line-by-line derivation of the projected earnings. */
export function FunderEarningsBreakdown({ earn }: Props) {
  const [open, setOpen] = useState(false);
  const pct = Math.round(FUNDER_MONTHLY_RATE * 100);

  const rows = [
    { label: 'Monthly rent', formula: 'House rent', value: formatUGX(earn.capital) },
    { label: 'Monthly earning', formula: `Rent × ${pct}%`, value: formatUGX(earn.monthly) },
    { label: '12-month total', formula: 'Monthly × 12', value: formatUGX(earn.annual) },
    { label: 'Daily', formula: `12-month ÷ ${earn.daysInTerm} days`, value: formatUGX(earn.daily) },
    { label: 'Weekly', formula: 'Daily × 7', value: formatUGX(earn.weekly) },
  ];

  return (
    <div className="pt-0.5">
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          setOpen((v) => !v);
        }}
        aria-expanded={open}
        className="w-full flex items-center gap-1 text-[9px] font-semibold text-muted-foreground hover:text-foreground transition-colors touch-manipulation"
      >
        Breakdown
        <ChevronDown className={`h-3 w-3 transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>

      {open && (
        <div className="mt-1.5 space-y-1 rounded-lg bg-background/60 p-2">
          {rows.map((r) => (
            <div key={r.label} className="flex items-baseline justify-between gap-2">
              <div className="min-w-0">
                <p className="text-[9px] font-semibold text-foreground leading-tight truncate">{r.label}</p>
                <p className="text-[8px] text-muted-foreground leading-tight truncate">{r.formula}</p>
              </div>
              <p className="text-[10px] font-black text-foreground shrink-0">{r.value}</p>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
