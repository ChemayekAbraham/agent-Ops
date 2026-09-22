import { useMemo, useState } from 'react';
import { Calculator, Home, Info } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { formatDynamic } from '@/lib/currencyFormat';
import type { FunderNewCategory, FunderNewEmptyHouse, FunderNewReadyPlan } from './types';
import { emptyHousePlace, emptyHouseTitle, itemAmount, readyPlanPlace, readyPlanTitle } from './utils';

const MONTHLY_RATE = 0.15;

/**
 * Decision-support calculator for /dashboard/funder-new.
 * Estimates only — it never triggers any funding action.
 */
export function FunderNewCalculatorDialog({
  open,
  onOpenChange,
  category,
  items,
  onOpenHouse,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  category: FunderNewCategory;
  items: Array<FunderNewEmptyHouse | FunderNewReadyPlan>;
  onOpenHouse: (id: string) => void;
}) {
  const [amountText, setAmountText] = useState('');
  const [housesText, setHousesText] = useState('1');

  const amount = Math.max(0, Number(amountText.replace(/[^\d]/g, '')) || 0);
  const houses = Math.max(1, Math.min(50, Number(housesText.replace(/[^\d]/g, '')) || 1));

  const total = amount * houses;
  const monthly = Math.round(total * MONTHLY_RATE);
  const annual = monthly * 12;

  const recommended = useMemo(() => {
    if (amount <= 0) return [];
    const withAmounts = items.map((item) => ({
      item,
      id:
        category === 'empty'
          ? (item as FunderNewEmptyHouse).house_id
          : (item as FunderNewReadyPlan).rent_request_id,
      value: itemAmount(category, item),
    }));
    return withAmounts
      .filter((entry) => entry.value > 0)
      .sort((a, b) => Math.abs(a.value - amount) - Math.abs(b.value - amount))
      .slice(0, houses);
  }, [amount, houses, items, category]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[92vh] max-w-2xl overflow-y-auto rounded-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Calculator className="h-5 w-5 text-primary" /> Return calculator
          </DialogTitle>
          <DialogDescription>
            Estimate what your support could return. This is a planning tool only — nothing is funded here.
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor="funder-new-calc-amount">Amount per house (UGX)</Label>
            <Input
              id="funder-new-calc-amount"
              inputMode="numeric"
              value={amountText}
              onChange={(event) => setAmountText(event.target.value)}
              placeholder="e.g. 500000"
              className="h-12 rounded-xl text-base"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="funder-new-calc-houses">Number of houses</Label>
            <Input
              id="funder-new-calc-houses"
              inputMode="numeric"
              value={housesText}
              onChange={(event) => setHousesText(event.target.value)}
              className="h-12 rounded-xl text-base"
            />
          </div>
        </div>

        <div className="grid gap-3 sm:grid-cols-3">
          <div className="rounded-2xl bg-primary p-4 text-primary-foreground">
            <p className="text-xs font-medium uppercase tracking-wide text-primary-foreground/75">Total support</p>
            <p className="mt-1 break-words text-2xl font-semibold">{formatDynamic(total)}</p>
          </div>
          <div className="rounded-2xl bg-primary/5 p-4">
            <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Monthly return (15%)</p>
            <p className="mt-1 break-words text-2xl font-semibold">{formatDynamic(monthly)}</p>
          </div>
          <div className="rounded-2xl bg-primary/5 p-4">
            <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Over 12 months</p>
            <p className="mt-1 break-words text-2xl font-semibold">{formatDynamic(annual)}</p>
          </div>
        </div>

        <div className="space-y-3">
          <p className="text-sm font-semibold">
            Recommended homes {recommended.length > 0 ? `(${recommended.length})` : ''}
          </p>
          {amount <= 0 ? (
            <p className="rounded-2xl border bg-muted/40 p-4 text-sm text-muted-foreground">
              Enter an amount to see homes that match your budget.
            </p>
          ) : recommended.length === 0 ? (
            <p className="rounded-2xl border bg-muted/40 p-4 text-sm text-muted-foreground">
              No homes in the current list match that amount. Try a different amount or clear your filters.
            </p>
          ) : (
            <ul className="space-y-2">
              {recommended.map(({ item, id, value }) => {
                const title =
                  category === 'empty'
                    ? emptyHouseTitle(item as FunderNewEmptyHouse)
                    : readyPlanTitle(item as FunderNewReadyPlan);
                const place =
                  category === 'empty'
                    ? emptyHousePlace(item as FunderNewEmptyHouse)
                    : readyPlanPlace(item as FunderNewReadyPlan);
                return (
                  <li key={id} className="flex flex-wrap items-center gap-3 rounded-2xl border bg-card p-3">
                    <span className="flex h-10 w-10 flex-none items-center justify-center rounded-xl bg-primary/10 text-primary">
                      <Home className="h-5 w-5" />
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-semibold">{title}</p>
                      <p className="truncate text-xs text-muted-foreground">{place}</p>
                    </div>
                    <p className="text-sm font-semibold">{formatDynamic(value)}</p>
                    <Button variant="soft" size="sm" className="h-10 rounded-xl" onClick={() => onOpenHouse(id)}>
                      View
                    </Button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        <p className="flex items-start gap-2 rounded-2xl border bg-muted/40 p-4 text-sm text-muted-foreground">
          <Info className="mt-0.5 h-4 w-4 flex-none" />
          Figures are estimates at the current 15% rate, and recommendations come from the homes currently loaded with
          your filters.
        </p>
      </DialogContent>
    </Dialog>
  );
}

export default FunderNewCalculatorDialog;
