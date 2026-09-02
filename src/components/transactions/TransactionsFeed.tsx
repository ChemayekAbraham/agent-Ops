/**
 * TransactionsFeed — the canonical customer transaction history UI.
 *
 * Single source of truth for the transaction list surface: used by the
 * /transactions page and by the Wallet Statement sheet. Keyset pagination
 * (15 rows per fetch, one query per page — no N+1).
 */
import { useMemo, useState } from "react";
import { useInfiniteQuery } from "@tanstack/react-query";
import { format, parseISO } from "date-fns";
import { ChevronDown, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { formatUGX } from "@/lib/rentCalculations";
import TransactionDetailDrawer from "@/components/transactions/TransactionDetailDrawer";
import {
  TX_DATE_OPTIONS,
  TX_METHOD_OPTIONS,
  TX_SERVICE_OPTIONS,
  fetchTxFeedPage,
  groupTxByDay,
  txCounterparty,
  txIcon,
  txLabel,
  txMaskedNumber,
  txMethodLabel,
  txTone,
  type TxDateFilter,
  type TxFeedRow,
  type TxMethodFilter,
  type TxServiceFilter,
} from "@/lib/transactionsFeed";

function FilterPill({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: readonly { value: string; label: string }[];
  onChange: (v: string) => void;
}) {
  const active = value !== "all";
  const current = options.find((o) => o.value === value);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className={cn(
            "inline-flex shrink-0 items-center gap-1.5 rounded-full px-4 py-2.5 text-sm font-semibold transition-colors",
            active
              ? "bg-primary text-primary-foreground"
              : "bg-muted text-foreground hover:bg-muted/80",
          )}
        >
          {active ? current?.label : label}
          <ChevronDown className="h-4 w-4 opacity-70" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="z-50">
        {options.map((o) => (
          <DropdownMenuItem key={o.value} onClick={() => onChange(o.value)}>
            {o.label}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export interface TransactionsFeedProps {
  userId: string | null | undefined;
  /** Hide the date / service / method filter row. */
  showFilters?: boolean;
  className?: string;
  /**
   * Wallet balance immediately after each row's transaction, keyed by row id.
   * Computed by the caller over the full unfiltered ledger history (a running
   * balance is only coherent there — this feed's own query is paginated and
   * filterable). Optional: undefined on surfaces (e.g. /transactions) that
   * don't supply it.
   */
  balanceAfterById?: Record<string, number>;
}

export function TransactionsFeed({
  userId,
  showFilters = true,
  className,
  balanceAfterById,
}: TransactionsFeedProps) {
  const [date, setDate] = useState<TxDateFilter>("all");
  const [service, setService] = useState<TxServiceFilter>("all");
  const [method, setMethod] = useState<TxMethodFilter>("all");
  const [selected, setSelected] = useState<TxFeedRow | null>(null);

  const filters = useMemo(() => ({ date, service, method }), [date, service, method]);

  const query = useInfiniteQuery({
    queryKey: ["tx-feed", userId ?? "", filters] as const,
    enabled: !!userId,
    initialPageParam: null as string | null,
    queryFn: ({ pageParam }) => fetchTxFeedPage(userId as string, filters, pageParam),
    getNextPageParam: (last) => last.nextCursor,
    staleTime: 15_000,
    refetchOnWindowFocus: false,
  });

  const rows = useMemo(
    () => (query.data?.pages ?? []).flatMap((p) => p.rows),
    [query.data],
  );
  const groups = useMemo(() => groupTxByDay(rows), [rows]);

  return (
    <div className={cn("space-y-6", className)}>
      {showFilters && (
        <div className="flex gap-3 overflow-x-auto pb-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          <FilterPill
            label="Date"
            value={date}
            options={TX_DATE_OPTIONS}
            onChange={(v) => setDate(v as TxDateFilter)}
          />
          <FilterPill
            label="Services"
            value={service}
            options={TX_SERVICE_OPTIONS}
            onChange={(v) => setService(v as TxServiceFilter)}
          />
          <FilterPill
            label="Method"
            value={method}
            options={TX_METHOD_OPTIONS}
            onChange={(v) => setMethod(v as TxMethodFilter)}
          />
        </div>
      )}

      {query.isLoading && (
        <div className="space-y-3">
          {Array.from({ length: 5 }).map((_, i) => (
            <Skeleton key={i} className="h-[86px] w-full rounded-2xl" />
          ))}
        </div>
      )}

      {!query.isLoading && rows.length === 0 && (
        <div className="rounded-2xl bg-background p-10 text-center">
          <p className="font-semibold">No transactions</p>
          <p className="mt-1 text-sm text-muted-foreground">
            Nothing matches these filters yet.
          </p>
        </div>
      )}

      {groups.map((group) => (
        <section key={group.day} className="space-y-3">
          <h2 className="text-base font-bold sm:text-lg">
            {format(parseISO(group.day), "EEEE, MMM d, yyyy")}
          </h2>
          {group.rows.map((row) => {
            const isIn = row.direction === "cash_in";
            const masked = txMaskedNumber(row);
            const tone = txTone(row);
            const Icon = txIcon(row);
            const balanceAfter = balanceAfterById?.[row.id] ?? row.balanceAfter;
            return (
              <button
                key={row.id}
                type="button"
                onClick={() => setSelected({ ...row, balanceAfter })}
                className="flex w-full items-center gap-3 sm:gap-4 rounded-2xl bg-background p-3.5 sm:p-4 text-left shadow-sm transition-transform active:scale-[0.98] border border-border/40 hover:border-border"
              >
                <span
                  className={cn(
                    "flex h-10 w-10 sm:h-12 sm:w-12 shrink-0 items-center justify-center rounded-full",
                    tone.bubble,
                  )}
                >
                  <Icon className={cn("h-4 w-4 sm:h-5 sm:w-5", tone.icon)} />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-1.5 sm:gap-2 flex-wrap">
                    <span className="truncate text-sm sm:text-base font-bold text-foreground">
                      {txLabel(row)}
                    </span>
                    <span
                      className={cn(
                        "inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-bold uppercase tracking-wider",
                        isIn
                          ? "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400"
                          : "bg-rose-500/10 text-rose-700 dark:text-rose-400",
                      )}
                    >
                      {isIn ? "Money In" : "Money Out"}
                    </span>
                  </span>
                  <span className="block truncate text-xs sm:text-sm font-semibold uppercase text-muted-foreground mt-0.5">
                    {txCounterparty(row) ?? "—"}
                  </span>
                  <span className="mt-1 flex items-center gap-2 flex-wrap">
                    <Badge variant="secondary" className="text-[10px] font-bold px-1.5 py-0">
                      {txMethodLabel(row)}
                    </Badge>
                    {masked && (
                      <span className="text-xs font-medium text-muted-foreground">{masked}</span>
                    )}
                  </span>
                </span>
                <span className="shrink-0 text-right space-y-0.5">
                  <span className={cn("block text-base sm:text-lg font-bold tabular-nums", tone.amount)}>
                    {isIn ? "+" : "−"}
                    {formatUGX(Number(row.amount)).replace(/^UGX\s*/, "")}
                  </span>
                  <span className="block text-[10px] font-semibold text-muted-foreground uppercase">UGX</span>
                  {balanceAfter !== undefined && (
                    <span className="block text-[11px] font-medium text-muted-foreground tabular-nums pt-0.5">
                      Bal: <span className="font-bold text-foreground/90">{formatUGX(balanceAfter)}</span>
                    </span>
                  )}
                </span>
              </button>
            );
          })}
        </section>
      ))}

      {query.hasNextPage && (
        <Button
          variant="outline"
          className="h-12 w-full rounded-2xl bg-background font-bold"
          disabled={query.isFetchingNextPage}
          onClick={() => query.fetchNextPage()}
        >
          {query.isFetchingNextPage && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
          Load more
        </Button>
      )}

      <TransactionDetailDrawer
        row={selected}
        open={!!selected}
        onOpenChange={(open) => !open && setSelected(null)}
      />
    </div>
  );
}

export default TransactionsFeed;
