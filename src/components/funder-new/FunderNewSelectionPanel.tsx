import { Home, Info, ShieldCheck, Trash2, X } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { formatDynamic } from '@/lib/currencyFormat';
import type { FunderNewCategory, FunderNewSelectionItem } from './types';
import { categoryLabel } from './utils';

const MONTHLY_RATE = 0.15;

const monthlyAt15 = (total: number) => Math.round(total * MONTHLY_RATE);

/** Sticky bar — rendered only while at least one compatible home is selected. */
export function FunderNewSelectionBar({
  items,
  category,
  onClear,
  onReview,
}: {
  items: FunderNewSelectionItem[];
  category: FunderNewCategory | null;
  onClear: () => void;
  onReview: () => void;
}) {
  if (items.length === 0 || !category) return null;
  const total = items.reduce((sum, item) => sum + item.amount, 0);

  return (
    <div className="fixed inset-x-0 bottom-0 z-40 border-t bg-card/95 shadow-[0_-8px_30px_-12px_hsl(var(--primary)/0.35)] backdrop-blur pb-safe">
      <div className="mx-auto flex max-w-7xl flex-col gap-3 px-4 py-3 sm:px-6 lg:flex-row lg:items-center lg:justify-between lg:px-8">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
          <p className="text-sm font-semibold">
            {items.length} {items.length === 1 ? 'home' : 'homes'} selected
          </p>
          <p className="text-sm">
            <span className="text-muted-foreground">Total </span>
            <span className="font-semibold">{formatDynamic(total)}</span>
          </p>
          <p className="text-sm">
            <span className="text-muted-foreground">Monthly at 15% </span>
            <span className="font-semibold text-success">{formatDynamic(monthlyAt15(total))}</span>
          </p>
        </div>
        <div className="flex gap-2">
          <Button variant="ghost" className="h-12 flex-1 rounded-xl lg:flex-none" onClick={onClear}>
            <X className="h-4 w-4" />
            Clear
          </Button>
          <Button className="h-12 flex-1 rounded-xl lg:flex-none lg:px-8" onClick={onReview}>
            <ShieldCheck className="h-4 w-4" />
            Review support plan
          </Button>
        </div>
      </div>
    </div>
  );
}

export function FunderNewReviewDialog({
  open,
  onOpenChange,
  items,
  available,
  walletLoading,
  walletError,
  onRemove,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  items: FunderNewSelectionItem[];
  available: number | null;
  walletLoading: boolean;
  walletError: unknown;
  onRemove: (item: FunderNewSelectionItem) => void;
}) {
  const total = items.reduce((sum, item) => sum + item.amount, 0);
  const shortfall = available === null ? null : Math.max(0, total - available);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[92vh] max-w-2xl overflow-y-auto rounded-2xl">
        <DialogHeader>
          <DialogTitle>Your support plan</DialogTitle>
          <DialogDescription>
            Check the homes you picked. Nothing is submitted from this screen.
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-3 sm:grid-cols-3">
          <div className="rounded-2xl bg-primary p-4 text-primary-foreground">
            <p className="text-xs font-medium uppercase tracking-wide text-primary-foreground/75">Total support</p>
            <p className="mt-1 break-words text-2xl font-semibold">{formatDynamic(total)}</p>
          </div>
          <div className="rounded-2xl bg-primary/5 p-4">
            <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Monthly at 15%</p>
            <p className="mt-1 break-words text-2xl font-semibold">{formatDynamic(monthlyAt15(total))}</p>
          </div>
          <div className="rounded-2xl bg-primary/5 p-4">
            <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Available balance</p>
            <p className="mt-1 break-words text-2xl font-semibold">
              {walletError || available === null ? 'Unavailable' : walletLoading ? 'Loading…' : formatDynamic(available)}
            </p>
            {shortfall !== null ? (
              <p className="mt-1 text-xs text-muted-foreground">
                {shortfall > 0 ? `${formatDynamic(shortfall)} short` : 'Fully covered'}
              </p>
            ) : null}
          </div>
        </div>

        <ul className="space-y-2">
          {items.map((item) => (
            <li
              key={`${item.category}:${item.id}`}
              className="flex flex-wrap items-center gap-3 rounded-2xl border bg-card p-3"
            >
              {item.imageUrl ? (
                <img src={item.imageUrl} alt={item.title} className="h-14 w-14 flex-none rounded-xl object-cover" />
              ) : (
                <span className="flex h-14 w-14 flex-none items-center justify-center rounded-xl bg-primary/10 text-primary">
                  <Home className="h-6 w-6" />
                </span>
              )}
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-semibold">{item.title}</p>
                <p className="truncate text-xs text-muted-foreground">{item.place}</p>
                <p className="mt-1 text-sm font-semibold">{formatDynamic(item.amount)}</p>
              </div>
              <Badge variant="outline" className="rounded-full">
                {categoryLabel(item.category)}
              </Badge>
              <Button
                variant="ghost"
                size="icon"
                className="h-10 w-10 rounded-xl"
                aria-label={`Remove ${item.title}`}
                onClick={() => onRemove(item)}
              >
                <Trash2 className="h-4 w-4" />
              </Button>
            </li>
          ))}
        </ul>

        <p className="flex items-start gap-2 rounded-2xl border bg-muted/40 p-4 text-sm text-muted-foreground">
          <Info className="mt-0.5 h-4 w-4 flex-none" />
          Selecting and reviewing homes is planning only. Support starts after you confirm and the usual approval step is
          completed. Returns shown are estimates at the current 15% rate.
        </p>
      </DialogContent>
    </Dialog>
  );
}

export default FunderNewSelectionBar;
