import { Popover, PopoverTrigger, PopoverContent } from '@/components/ui/popover';
import { Info } from 'lucide-react';

const TIERS = [
  { label: 'Very Good', min: 75, max: null, tone: 'text-emerald-700 bg-emerald-50 border-emerald-200' },
  { label: 'Good', min: 50, max: 74, tone: 'text-emerald-600 bg-emerald-50 border-emerald-200' },
  { label: 'Fair', min: 15, max: 49, tone: 'text-amber-700 bg-amber-50 border-amber-200' },
  { label: 'Bad', min: 5, max: 14, tone: 'text-orange-700 bg-orange-50 border-orange-200' },
  { label: 'Very Bad', min: 0, max: 4, tone: 'text-destructive bg-destructive/5 border-destructive/20' },
] as const;

export function DailyRatingThresholdPopover({ className }: { className?: string }) {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          className={`inline-flex items-center justify-center h-5 w-5 rounded-full border border-border bg-background hover:bg-muted transition-colors ${className || ''}`}
          aria-label="Daily rating thresholds"
        >
          <Info className="h-3 w-3 text-muted-foreground" />
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-64 p-3 space-y-2" align="start" sideOffset={4}>
        <p className="text-xs font-bold text-foreground">Daily Rating Thresholds</p>
        <p className="text-[11px] text-muted-foreground leading-snug">
          Based on <strong className="text-foreground">today&apos;s</strong> collection vs today&apos;s expected daily rent.
        </p>
        <ul className="space-y-1.5">
          {TIERS.map((t) => (
            <li
              key={t.label}
              className={`flex items-center justify-between rounded-md border px-2 py-1 text-[11px] ${t.tone}`}
            >
              <span className="font-bold">{t.label}</span>
              <span className="tabular-nums">
                {t.max !== null ? `${t.min}–${t.max}%` : `≥ ${t.min}%`}
              </span>
            </li>
          ))}
        </ul>
        <p className="text-[10px] text-muted-foreground leading-snug">
          Hit <strong className="text-foreground">≥ 50%</strong> to be unblocked and rated Good.
        </p>
      </PopoverContent>
    </Popover>
  );
}
