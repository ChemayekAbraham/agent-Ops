import { useEffect, useState } from 'react';
import { formatUGX } from '@/lib/creditFeeCalculations';
import { listRates } from '../api';

export const RATE_TIERS = [
  { tier: 'basic', label: 'Basic' },
  { tier: 'standard', label: 'Standard' },
  { tier: 'advanced', label: 'Advanced' },
  { tier: 'revision', label: 'Revision' },
] as const;

export default function RateStrip({ refreshKey = 0 }: { refreshKey?: number }) {
  const [rates, setRates] = useState<Record<string, number>>({});
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    listRates()
      .then((r: any[]) => {
        if (cancelled) return;
        const map: Record<string, number> = {};
        r.forEach((x) => { if (x.amount_ugx != null) map[x.tier] = Number(x.amount_ugx); });
        setRates(map);
      })
      .catch((e) => { if (!cancelled) setError(e instanceof Error ? e.message : String(e)); });
    return () => { cancelled = true; };
  }, [refreshKey]);

  const allUnset = RATE_TIERS.every((t) => rates[t.tier] == null);

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-2">
        {RATE_TIERS.map(({ tier, label }) => (
          <span key={tier} className="inline-flex items-center gap-1.5 rounded-full border border-border bg-muted/50 px-3 py-1 text-xs">
            <span className="font-medium">{label}</span>
            <span className="text-muted-foreground">{rates[tier] != null ? formatUGX(rates[tier]) : 'Not set'}</span>
          </span>
        ))}
      </div>
      {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
      <p className="text-xs text-muted-foreground">
        {allUnset
          ? 'Rates not set yet — management will set them. You can still upload; pay is fixed when a video is accepted.'
          : 'Pay per accepted video. Set by HR, COO, CEO or CFO.'}
      </p>
    </div>
  );
}
