import { useMemo, useState } from 'react';
import { Check, Filter, MapPin, Search, Wallet } from 'lucide-react';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { cn } from '@/lib/utils';
import { formatDynamic } from '@/lib/currencyFormat';
import type { FunderNewFilters } from '@/components/funder-new/types';
import type { FunderNewDistrictOption } from '@/components/funder-new/FunderNewFilterChips';

const PRESETS: Array<{ label: string; min: number | null; max: number | null }> = [
  { label: 'Any', min: null, max: null },
  { label: 'Under 300K', min: null, max: 300_000 },
  { label: '300K – 600K', min: 300_000, max: 600_000 },
  { label: '600K – 1M', min: 600_000, max: 1_000_000 },
  { label: 'Over 1M', min: 1_000_000, max: null },
];

const parseAmount = (raw: string): number | null => {
  const digits = raw.replace(/[^0-9]/g, '');
  const value = Number(digits);
  return digits && Number.isFinite(value) && value > 0 ? value : null;
};

interface Props {
  filters: FunderNewFilters;
  districts: FunderNewDistrictOption[];
  availableBalance: number | null;
  floatBalance: number | null;
  resultCount: number;
  onChange: (next: Partial<FunderNewFilters>) => void;
}

/** Funnel button + dialog holding district, amount range and within-balance filters. */
export function FunderPreviewFilterDialog({ filters, districts, availableBalance, floatBalance, resultCount, onChange }: Props) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');

  const activeCount =
    (filters.location.trim() ? 1 : 0) +
    (filters.rentMin !== null || filters.rentMax !== null ? 1 : 0) +
    (filters.withinFloat ? 1 : 0);

  const shownDistricts = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q ? districts.filter((d) => d.label.toLowerCase().includes(q)) : districts;
  }, [districts, query]);

  const total = districts.reduce((sum, d) => sum + d.count, 0);
  const pill = (on: boolean) =>
    cn(
      'inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs font-semibold transition-colors',
      on ? 'border-primary bg-primary text-primary-foreground' : 'border-border bg-card text-foreground hover:bg-muted',
    );

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label={`More filters${activeCount ? `, ${activeCount} on` : ''}`}
        className={cn(
          'relative inline-flex h-8 w-9 flex-none items-center justify-center rounded-md border transition-colors',
          activeCount ? 'border-primary bg-primary text-primary-foreground' : 'border-border bg-background text-foreground hover:bg-muted',
        )}
      >
        <Filter className="h-4 w-4" aria-hidden />
        {activeCount ? (
          <span className="absolute -right-1.5 -top-1.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-foreground px-1 text-[10px] font-bold text-background">
            {activeCount}
          </span>
        ) : null}
      </button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="flex max-h-[88vh] w-[calc(100vw-1.5rem)] max-w-md flex-col gap-0 overflow-hidden rounded-2xl p-0">
          <DialogHeader className="space-y-1 border-b bg-primary/5 px-5 pb-4 pt-5 text-left">
            <DialogTitle className="flex items-center gap-2 text-lg">
              <span className="flex h-8 w-8 items-center justify-center rounded-full bg-primary text-primary-foreground">
                <Filter className="h-4 w-4" aria-hidden />
              </span>
              Find your homes
            </DialogTitle>
            <DialogDescription>Pick a place, a price range and what fits your balance.</DialogDescription>
          </DialogHeader>

          <div className="flex-1 space-y-6 overflow-y-auto px-5 py-5">
            <section className="space-y-3">
              <h3 className="flex items-center gap-1.5 text-sm font-semibold">
                <MapPin className="h-4 w-4 text-primary" aria-hidden /> Where
              </h3>
              <div className="relative">
                <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
                <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search district" className="h-9 pl-9 text-sm" />
              </div>
              <div className="flex max-h-40 flex-wrap gap-2 overflow-y-auto pr-1">
                <button type="button" className={pill(!filters.location.trim())} onClick={() => onChange({ location: '' })}>
                  All districts <span className="opacity-70">{total.toLocaleString()}</span>
                </button>
                {shownDistricts.map((d) => {
                  const on = filters.location === d.value;
                  return (
                    <button key={d.value} type="button" className={pill(on)} onClick={() => onChange({ location: on ? '' : d.value })}>
                      {on ? <Check className="h-3 w-3" aria-hidden /> : null}
                      {d.label} <span className="opacity-70">{d.count.toLocaleString()}</span>
                    </button>
                  );
                })}
              </div>
            </section>

            <section className="space-y-3">
              <h3 className="text-sm font-semibold">Amount needed</h3>
              <div className="flex flex-wrap gap-2">
                {PRESETS.map((p) => (
                  <button
                    key={p.label}
                    type="button"
                    className={pill(filters.rentMin === p.min && filters.rentMax === p.max)}
                    onClick={() => onChange({ rentMin: p.min, rentMax: p.max, amount: 'all' })}
                  >
                    {p.label}
                  </button>
                ))}
              </div>
              <div className="flex items-center gap-2">
                <Input
                  inputMode="numeric"
                  placeholder="Min"
                  aria-label="Minimum amount"
                  value={filters.rentMin === null ? '' : filters.rentMin.toLocaleString()}
                  onChange={(e) => onChange({ rentMin: parseAmount(e.target.value) })}
                  className="h-10 text-sm"
                />
                <span className="text-muted-foreground">–</span>
                <Input
                  inputMode="numeric"
                  placeholder="Max"
                  aria-label="Maximum amount"
                  value={filters.rentMax === null ? '' : filters.rentMax.toLocaleString()}
                  onChange={(e) => onChange({ rentMax: parseAmount(e.target.value) })}
                  className="h-10 text-sm"
                />
              </div>
            </section>

            <label
              className={cn(
                'flex cursor-pointer items-center gap-3 rounded-xl border p-4 transition-colors',
                filters.withinFloat ? 'border-primary bg-primary/10' : 'border-border bg-card',
                availableBalance === null && 'cursor-not-allowed opacity-60',
              )}
            >
              <span className="flex h-10 w-10 flex-none items-center justify-center rounded-full bg-primary/15 text-primary">
                <Wallet className="h-5 w-5" aria-hidden />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block text-sm font-semibold">Within my float limit</span>
                <span className="block text-xs text-muted-foreground">
                  Only homes you can fund now · {floatBalance === null ? '…' : formatDynamic(floatBalance)}
                </span>
              </span>
              <Switch
                checked={filters.withinFloat}
                disabled={availableBalance === null}
                onCheckedChange={(checked) => onChange({ withinFloat: checked })}
              />
            </label>
          </div>

          <div className="flex items-center gap-2 border-t bg-background px-5 py-3">
            <Button
              variant="ghost"
              onClick={() => onChange({ location: '', rentMin: null, rentMax: null, amount: 'all', withinFloat: false })}
            >
              Clear
            </Button>
            <Button className="flex-1" onClick={() => setOpen(false)}>
              Show {resultCount.toLocaleString()} {resultCount === 1 ? 'home' : 'homes'}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}

export default FunderPreviewFilterDialog;
