import { useMemo, useState } from 'react';
import { Minus, Plus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { calculateRentRepayment, formatUGX } from '@/lib/rentCalculations';

const RATES = [0.23, 0.28, 0.33] as const;
const MIN_RENT = 50_000;
const MAX_RENT = 20_000_000;
const MIN_DAYS = 7;
const MAX_DAYS = 120;

/** One compact Rent Plan calculator, shared by the assistant Home tab and chat cards. */
export function RentPlanCalculatorCard({ id, className = '' }: { id?: string; className?: string }) {
  const [rentText, setRentText] = useState('500,000');
  const [days, setDays] = useState(30);
  const [rate, setRate] = useState<number>(0.33);
  const rent = Number(rentText.replace(/[^\d]/g, '')) || 0;
  const valid = rent >= MIN_RENT && rent <= MAX_RENT;
  const result = useMemo(() => (valid ? calculateRentRepayment(rent, days, rate) : null), [valid, rent, days, rate]);
  const step = (delta: number) => setDays(d => Math.min(MAX_DAYS, Math.max(MIN_DAYS, d + delta)));

  return <div id={id} className={`rounded-2xl border border-border bg-card p-4 text-card-foreground shadow-sm ${className}`}>
    <p className="text-sm font-semibold">Rent Plan calculator</p>
    <div className="mt-3 grid gap-3">
      <label className="grid gap-1 text-xs text-muted-foreground">Rent amount (UGX)
        <Input inputMode="numeric" value={rentText} aria-invalid={!valid} onChange={e => { const n = e.target.value.replace(/[^\d]/g, ''); setRentText(n ? Number(n).toLocaleString('en-US') : ''); }} className="h-10 text-base text-foreground" />
      </label>
      {!valid && <p role="status" className="-mt-1 text-xs text-destructive">Between UGX 50,000 and UGX 20,000,000</p>}
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs text-muted-foreground">Duration</span>
        <div className="flex items-center gap-2">
          <Button type="button" variant="outline" size="icon-sm" className="rounded-full" aria-label="Fewer days" disabled={days <= MIN_DAYS} onClick={() => step(-1)}><Minus /></Button>
          <span className="min-w-16 text-center text-sm font-medium tabular-nums" aria-live="polite">{days} days</span>
          <Button type="button" variant="outline" size="icon-sm" className="rounded-full" aria-label="More days" disabled={days >= MAX_DAYS} onClick={() => step(1)}><Plus /></Button>
        </div>
      </div>
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs text-muted-foreground">Rate</span>
        <div className="flex gap-1.5" role="radiogroup" aria-label="Monthly rate">
          {RATES.map(r => <Button key={r} type="button" role="radio" aria-checked={rate === r} variant={rate === r ? 'default' : 'outline'} size="sm" className="h-8 rounded-full px-3" onClick={() => setRate(r)}>{Math.round(r * 100)}%</Button>)}
        </div>
      </div>
    </div>
    <div className="mt-4 grid grid-cols-3 gap-2 border-t border-border pt-3 text-center">
      {[['Daily', result?.dailyRepayment], ['Total', result?.totalRepayment], ['Access fee', result?.accessFee]].map(([label, value]) => <div key={label as string} className="min-w-0">
        <p className="text-[11px] text-muted-foreground">{label}</p>
        <p className="truncate text-sm font-bold tabular-nums sm:text-base">{value != null ? formatUGX(value as number) : '—'}</p>
      </div>)}
    </div>
  </div>;
}
