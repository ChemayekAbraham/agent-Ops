import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  NO_PAYMENT_MAX_DAYS,
  NO_PAYMENT_MIN_DAYS,
  NO_PAYMENT_PRESETS,
  noPaymentDaysError,
} from '@/lib/noPaymentDays';

/**
 * "Days without payment": presets 7 / 14 / 20 / 30 / 45 / 60 plus a custom number (1 to 365). The choice itself
 * is held by the caller (the URL, via useNoPaymentDays); this only collects it.
 */
export function DaysWithoutPaymentControl({
  days,
  onChange,
  idPrefix = 'days',
}: {
  days: number;
  onChange: (days: number) => void;
  idPrefix?: string;
}) {
  const isPreset = (NO_PAYMENT_PRESETS as readonly number[]).includes(days);
  const [custom, setCustom] = useState(isPreset ? '' : String(days));
  const [error, setError] = useState<string | null>(null);

  // Keep the box in step when the number changes from outside (a link, the back button, a preset).
  useEffect(() => {
    setCustom(isPreset ? '' : String(days));
    setError(null);
  }, [days, isPreset]);

  const apply = () => {
    const problem = noPaymentDaysError(custom);
    setError(problem);
    if (!problem) onChange(Number(custom.trim()));
  };

  return (
    <div className="space-y-1.5" data-testid="days-without-payment-control">
      <div className="flex flex-wrap items-center gap-1.5">
        <span id={`${idPrefix}-label`} className="mr-1 text-xs font-medium text-muted-foreground">Days without payment</span>
        <div className="flex flex-wrap gap-1" role="group" aria-labelledby={`${idPrefix}-label`}>
          {NO_PAYMENT_PRESETS.map((n) => (
            <Button
              key={n}
              type="button"
              size="sm"
              variant={days === n ? 'default' : 'outline'}
              className="h-8 min-w-10 px-2.5 text-xs"
              aria-pressed={days === n}
              onClick={() => onChange(n)}
            >
              {n}
            </Button>
          ))}
        </div>
        <form
          className="flex items-center gap-1"
          onSubmit={(e) => { e.preventDefault(); apply(); }}
        >
          <Input
            value={custom}
            onChange={(e) => setCustom(e.target.value)}
            inputMode="numeric"
            placeholder="Custom"
            aria-label={`Custom number of days, ${NO_PAYMENT_MIN_DAYS} to ${NO_PAYMENT_MAX_DAYS}`}
            aria-invalid={error ? true : undefined}
            className="h-8 w-24 text-xs"
          />
          <Button type="submit" size="sm" variant={!isPreset ? 'default' : 'outline'} className="h-8 px-2.5 text-xs">
            Apply
          </Button>
        </form>
      </div>
      {error && <p role="alert" className="text-[11px] text-destructive">{error}</p>}
    </div>
  );
}
