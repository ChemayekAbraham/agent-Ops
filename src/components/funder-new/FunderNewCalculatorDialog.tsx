import { useSelfSupportFeePolicy } from '@/hooks/useSelfSupportFeePolicy';
import { useMemo, useState } from 'react';
import { Calculator, Home, Info, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { formatDynamic } from '@/lib/currencyFormat';
import type { FunderNewEmptyHouse, FunderNewFilters, FunderNewOrigin } from './types';
import { emptyHousePlace, emptyHouseTitle, itemAmount } from './utils';
import { useFunderNewRecommendations } from './useFunderNewOpportunities';
import { useOwnNewPortfolioRate } from '@/hooks/usePartnerQuoteRate';
import { formatRatePct, monthlyReturnFor } from '@/lib/partnerReturnPolicy';

type Mode = 'per_house' | 'total_budget';

/**
 * Decision support for /dashboard/funder-new. Nothing here funds anything, and
 * recommendations never change the user's selection on their own.
 */
export function FunderNewCalculatorDialog({
  open,
  onOpenChange,
  filters,
  origin,
  onOpenHouse,
  onSelectRecommended,
  hasExistingSelection,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  filters: FunderNewFilters;
  origin: FunderNewOrigin | null;
  onOpenHouse: (id: string) => void;
  onSelectRecommended: (houses: FunderNewEmptyHouse[], replaceExisting: boolean) => void;
  hasExistingSelection: boolean;
}) {
  // Field Care: the partner amount is pay(rent) (= rent while the switch is off).
  const { pay: partnerPay } = useSelfSupportFeePolicy();
  const [mode, setMode] = useState<Mode>('per_house');
  const [amountText, setAmountText] = useState('');
  const [housesText, setHousesText] = useState('3');
  // A planning estimate for this partner's next portfolio: their own rate (partner_quote_rate('me')).
  // null while it loads or on error: no figure.
  const { rate: ownRate } = useOwnNewPortfolioRate();
  const ownRatePct = formatRatePct(ownRate);

  const entered = Math.max(0, Number(amountText.replace(/[^\d]/g, '')) || 0);
  const houses = Math.max(1, Math.min(50, Number(housesText.replace(/[^\d]/g, '')) || 1));

  // The two modes are explicit — the same number is never treated as both.
  const perHouse = mode === 'per_house' ? entered : Math.floor(entered / houses);
  const hypotheticalTotal = mode === 'per_house' ? entered * houses : entered;
  const hypotheticalMonthly = monthlyReturnFor(hypotheticalTotal, ownRate);

  const recommendations = useFunderNewRecommendations(perHouse, houses, filters, origin, open);
  const matches = recommendations.data?.items ?? [];

  const actual = useMemo(() => {
    const total = matches.reduce((sum, house) => sum + itemAmount('empty', house, partnerPay), 0);
    // Priced at the partner's own rate, not the list's partner_monthly_return (quoted at the public
    // new-partner rate). A house without a rent adds nothing, as before; null when the rate is unknown.
    const monthly =
      ownRate === null
        ? null
        : matches.reduce((sum, house) => sum + (monthlyReturnFor(itemAmount('empty', house, partnerPay), ownRate) ?? 0), 0);
    return { total, monthly };
  }, [matches, ownRate, partnerPay]);

  const searchScope = [
    `homes at or under ${formatDynamic(perHouse)} each`,
    origin ? (origin.source === 'device' ? 'nearest to you first' : 'nearest to your chosen area first') : 'lowest amount first',
    filters.location.trim() ? `in ${filters.location.trim()}` : null,
  ]
    .filter(Boolean)
    .join(', ');

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[92vh] max-w-2xl overflow-y-auto rounded-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-base sm:text-lg">
            <Calculator className="h-5 w-5 text-primary" aria-hidden /> Return calculator
          </DialogTitle>
          <DialogDescription>
            A planning estimate{ownRatePct ? ` at your current ${ownRatePct} rate` : ''}. Nothing is funded from this screen.
          </DialogDescription>
        </DialogHeader>

        <Tabs value={mode} onValueChange={(value) => setMode(value as Mode)}>
          <TabsList className="h-auto w-full flex-wrap justify-start gap-1 rounded-xl p-1">
            <TabsTrigger value="per_house" className="rounded-lg px-3 py-2 text-sm">
              Amount per house
            </TabsTrigger>
            <TabsTrigger value="total_budget" className="rounded-lg px-3 py-2 text-sm">
              Total budget
            </TabsTrigger>
          </TabsList>
        </Tabs>

        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="funder-new-calc-amount" className="text-sm">
              {mode === 'per_house' ? 'Amount per house (UGX)' : 'Total budget (UGX)'}
            </Label>
            <Input
              id="funder-new-calc-amount"
              inputMode="numeric"
              value={amountText}
              onChange={(event) => setAmountText(event.target.value)}
              placeholder="e.g. 500000"
              className="h-12 rounded-xl text-base"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="funder-new-calc-houses" className="text-sm">
              Number of houses
            </Label>
            <Input
              id="funder-new-calc-houses"
              inputMode="numeric"
              value={housesText}
              onChange={(event) => setHousesText(event.target.value)}
              className="h-12 rounded-xl text-base"
            />
          </div>
        </div>

        <div className="rounded-2xl border bg-primary/5 p-4">
          <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">If you supported that</p>
          <div className="mt-2 grid gap-3 sm:grid-cols-2">
            <div>
              <p className="text-xs text-muted-foreground">Total support</p>
              <p className="break-words text-xl font-bold">{formatDynamic(hypotheticalTotal)}</p>
              {mode === 'total_budget' && perHouse > 0 ? (
                <p className="mt-0.5 text-xs text-muted-foreground">
                  About {formatDynamic(perHouse)} for each of {houses}
                </p>
              ) : null}
            </div>
            <div>
              <p className="text-xs text-muted-foreground">Projected Rent profit share each month{ownRatePct ? ` (${ownRatePct})` : ''}</p>
              <p className="break-words text-xl font-bold text-success">{hypotheticalMonthly === null ? '—' : formatDynamic(hypotheticalMonthly)}</p>
              <p className="mt-0.5 text-xs text-muted-foreground">
                Hypothetical scenario, returns only — your support amount is not included.
              </p>
            </div>
          </div>
        </div>

        <div className="space-y-2">
          <p className="text-sm font-semibold">Actual homes that match</p>

          {perHouse <= 0 ? (
            <p className="rounded-2xl border bg-muted/40 p-4 text-sm text-muted-foreground">
              Enter an amount to search for real homes in your range.
            </p>
          ) : recommendations.isLoading ? (
            <p className="flex items-center gap-2 rounded-2xl border bg-muted/40 p-4 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> Searching {searchScope}\u2026
            </p>
          ) : recommendations.error ? (
            <p className="rounded-2xl border bg-muted/40 p-4 text-sm text-muted-foreground">
              These homes could not be searched right now. Your estimate above is unaffected.
            </p>
          ) : matches.length === 0 ? (
            <p className="rounded-2xl border bg-muted/40 p-4 text-sm text-muted-foreground">
              No homes were found at or under {formatDynamic(perHouse)} each. Searched {searchScope}. Try a higher
              amount or a wider area.
            </p>
          ) : (
            <>
              <p className="text-xs text-muted-foreground">
                Searched {searchScope}. Found {matches.length} of the {houses} you asked for.
              </p>
              <div className="grid gap-2 rounded-2xl border bg-card p-3 sm:grid-cols-2">
                <p className="text-sm">
                  <span className="text-muted-foreground">Their real combined amount </span>
                  <span className="font-semibold">{formatDynamic(actual.total)}</span>
                </p>
                <p className="text-sm">
                  <span className="text-muted-foreground">Their real monthly return </span>
                  <span className="font-semibold text-success">{actual.monthly === null ? '—' : formatDynamic(actual.monthly)}</span>
                </p>
              </div>
              <ul className="space-y-2">
                {matches.map((house) => (
                  <li
                    key={house.house_id}
                    className="flex flex-wrap items-center gap-3 rounded-2xl border bg-card p-3"
                  >
                    <span className="flex h-10 w-10 flex-none items-center justify-center rounded-xl bg-primary/10 text-primary">
                      <Home className="h-5 w-5" aria-hidden />
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-semibold">{emptyHouseTitle(house)}</p>
                      <p className="truncate text-xs text-muted-foreground">{emptyHousePlace(house)}</p>
                    </div>
                    <p className="text-sm font-semibold">{formatDynamic(itemAmount('empty', house, partnerPay))}</p>
                    <Button
                      variant="soft"
                      size="sm"
                      className="h-10 rounded-xl"
                      onClick={() => onOpenHouse(house.house_id)}
                    >
                      View
                    </Button>
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>

        <p className="flex items-start gap-2 rounded-2xl border bg-muted/40 p-4 text-xs text-muted-foreground">
          <Info className="mt-0.5 h-4 w-4 flex-none" aria-hidden />
          Rent profit share figures are projections{ownRatePct ? ` at your current ${ownRatePct} rate` : ''}, not a guarantee. Selecting homes here is planning only.
        </p>

        {matches.length > 0 ? (
          <DialogFooter className="gap-2 sm:justify-start">
            <Button
              className="h-11 rounded-xl"
              onClick={() => onSelectRecommended(matches, false)}
            >
              {hasExistingSelection ? 'Add these to my selection' : 'Select recommended homes'}
            </Button>
            {hasExistingSelection ? (
              <Button variant="outline" className="h-11 rounded-xl" onClick={() => onSelectRecommended(matches, true)}>
                Replace my selection
              </Button>
            ) : null}
          </DialogFooter>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

export default FunderNewCalculatorDialog;
