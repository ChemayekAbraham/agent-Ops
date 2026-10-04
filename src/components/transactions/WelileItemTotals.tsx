/**
 * WelileItemTotals — per-item money in / money out summary for Welile item
 * transfers (Rent, Bread, Chapati, Eggs, Fuel, Reward, Boda fees, tax).
 * Tapping a card filters the list to that item.
 */
import { useQuery } from "@tanstack/react-query";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { formatUGX } from "@/lib/rentCalculations";
import {
  fetchWelileItemTotals,
  type TxDateFilter,
  type TxItemFilter,
} from "@/lib/transactionsFeed";

export interface WelileItemTotalsProps {
  userId: string | null | undefined;
  date?: TxDateFilter;
  selected?: TxItemFilter;
  onSelect?: (item: TxItemFilter) => void;
  className?: string;
}

export function WelileItemTotals({
  userId,
  date = "all",
  selected = "all",
  onSelect,
  className,
}: WelileItemTotalsProps) {
  const query = useQuery({
    queryKey: ["welile-item-totals", userId ?? "", date] as const,
    enabled: !!userId,
    queryFn: () => fetchWelileItemTotals(userId as string, date),
    staleTime: 30_000,
    refetchOnWindowFocus: false,
  });

  if (query.isLoading) {
    return (
      <div className={cn("grid grid-cols-2 gap-2 sm:grid-cols-4", className)}>
        {Array.from({ length: 4 }).map((_, i) => (
          <Skeleton key={i} className="h-20 rounded-2xl" />
        ))}
      </div>
    );
  }

  const totals = (query.data ?? []).filter((t) => t.count > 0);
  if (totals.length === 0) return null;

  return (
    <div className={cn("space-y-2", className)}>
      <h2 className="text-sm font-bold text-muted-foreground">Totals by item</h2>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        {totals.map((t) => {
          const active = selected === t.item;
          return (
            <button
              key={t.item}
              type="button"
              onClick={() => onSelect?.(active ? "all" : t.item)}
              className={cn(
                "rounded-2xl bg-background p-3 text-left shadow-sm transition-transform active:scale-[0.98]",
                active && "ring-2 ring-primary",
              )}
            >
              <span className="block truncate text-xs font-bold">{t.item}</span>
              {t.inAmount > 0 && (
                <span className="mt-1 block text-sm font-bold tabular-nums text-success">
                  +{formatUGX(t.inAmount)}
                </span>
              )}
              {t.outAmount > 0 && (
                <span className="block text-sm font-bold tabular-nums text-destructive">
                  −{formatUGX(t.outAmount)}
                </span>
              )}
              <span className="mt-1 block text-[11px] font-medium text-muted-foreground">
                {t.count} transfer{t.count === 1 ? "" : "s"}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

export default WelileItemTotals;
