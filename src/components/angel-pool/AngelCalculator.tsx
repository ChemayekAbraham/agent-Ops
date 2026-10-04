import { useState } from 'react';
import { Calculator, TrendingUp } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Slider } from '@/components/ui/slider';
import { Button } from '@/components/ui/button';
import {
  TOTAL_SHARES, PRICE_PER_SHARE, POOL_PERCENT, VALUATIONS, UGX_PER_USD,
  type CurrencyView, formatCurrencyCompact,
} from './constants';

export function AngelCalculator() {
  const [amount, setAmount] = useState(1_000_000);
  const [selectedValuation, setSelectedValuation] = useState<number | null>(null);
  const [view, setView] = useState<CurrencyView>('UGX');

  const formatCompact = (n: number) => formatCurrencyCompact(n, view);

  // Fractional shares — UGX 50,000 → 2.5 shares, no truncation.
  const shares = amount / PRICE_PER_SHARE;
  const poolOwnership = (shares / TOTAL_SHARES) * 100;
  const companyOwnership = (POOL_PERCENT / TOTAL_SHARES) * shares;
  const sharesLabel = shares.toLocaleString(undefined, { maximumFractionDigits: 4 });

  const handleAmountChange = (val: string) => {
    const num = parseFloat(val.replace(/[^0-9.]/g, ''));
    if (!isNaN(num)) {
      const ugx = view === 'USD' ? num * UGX_PER_USD : num;
      setAmount(Math.min(Math.round(ugx), 500_000_000));
    } else setAmount(0);
  };

  const estimatedValue = selectedValuation
    ? (companyOwnership / 100) * selectedValuation * UGX_PER_USD
    : null;

  return (
    <Card className="border-primary/20">
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between gap-2">
          <CardTitle className="text-base flex items-center gap-2">
            <div className="p-1.5 rounded-lg bg-primary/10">
              <Calculator className="h-4 w-4 text-primary" />
            </div>
            Investment Calculator
          </CardTitle>
          <div className="flex items-center rounded-full border border-border bg-muted/40 p-0.5">
            {(['UGX', 'USD'] as CurrencyView[]).map((c) => (
              <button
                key={c}
                type="button"
                onClick={() => setView(c)}
                className={`px-2.5 py-1 text-[11px] font-bold rounded-full transition-colors ${
                  view === c ? 'bg-primary text-primary-foreground' : 'text-muted-foreground'
                }`}
              >
                {c}
              </button>
            ))}
          </div>
        </div>
        <p className="text-[10px] text-muted-foreground pt-1">1 share = UGX 20,000 = US$5</p>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Amount input */}
        <div>
          <label className="text-xs text-muted-foreground font-medium mb-1.5 block">Investment Amount ({view})</label>
          <Input
            type="text"
            value={(view === 'USD' ? amount / UGX_PER_USD : amount).toLocaleString(undefined, { maximumFractionDigits: 2 })}
            onChange={(e) => handleAmountChange(e.target.value)}
            className="text-lg font-bold"
          />
          <Slider
            value={[amount]}
            onValueChange={([v]) => setAmount(v)}
            min={PRICE_PER_SHARE}
            max={50_000_000}
            step={PRICE_PER_SHARE}
            className="mt-3"
          />
          <div className="flex justify-between text-[10px] text-muted-foreground mt-1">
            <span>{formatCompact(PRICE_PER_SHARE)}</span>
            <span>{formatCompact(50_000_000)}</span>
          </div>
        </div>

        {/* Results */}
        <div className="grid grid-cols-3 gap-2">
          <div className="p-3 rounded-2xl bg-primary/5 text-center">
            <p className="text-xl font-black text-primary">{sharesLabel}</p>
            <p className="text-[10px] text-muted-foreground font-medium">Shares</p>
          </div>
          <div className="p-3 rounded-2xl bg-primary/5 text-center">
            <p className="text-xl font-black text-primary">{poolOwnership.toFixed(2)}%</p>
            <p className="text-[10px] text-muted-foreground font-medium">Pool %</p>
          </div>
          <div className="p-3 rounded-2xl bg-primary/5 text-center">
            <p className="text-xl font-black text-primary">{companyOwnership.toFixed(4)}%</p>
            <p className="text-[10px] text-muted-foreground font-medium">Company %</p>
          </div>
        </div>

        {/* Future Value Simulator */}
        <div className="pt-2 border-t border-border/60">
          <div className="flex items-center gap-2 mb-3">
            <TrendingUp className="h-3.5 w-3.5 text-muted-foreground" />
            <span className="text-xs font-semibold text-muted-foreground">Future Value Simulator</span>
          </div>
          <div className="flex gap-2">
            {VALUATIONS.map((v) => (
              <Button
                key={v.label}
                variant={selectedValuation === v.value ? 'default' : 'outline'}
                size="sm"
                onClick={() => setSelectedValuation(selectedValuation === v.value ? null : v.value)}
                className="flex-1 text-xs"
              >
                {v.label}
              </Button>
            ))}
          </div>
          {estimatedValue !== null && (
            <div className="mt-3 p-3 rounded-2xl bg-success/10 border border-success/20">
              <p className="text-[10px] text-muted-foreground font-medium">
                Estimated value at {VALUATIONS.find(v => v.value === selectedValuation)?.label} valuation
              </p>
              <p className="text-lg font-black text-success">{formatCompact(estimatedValue)}</p>
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
