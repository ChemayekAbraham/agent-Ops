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
import { UserAvatar } from "@/components/UserAvatar";
import TransactionDetailDrawer from "@/components/transactions/TransactionDetailDrawer";
import WelileItemTotals from "@/components/transactions/WelileItemTotals";
import {
  TX_DATE_OPTIONS,
  TX_ITEM_OPTIONS,
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
  type TxItemFilter,
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
  const [item, setItem] = useState<TxItemFilter>("all");
  const [selected, setSelected] = useState<TxFeedRow | null>(null);

  const filters = useMemo(
    () => ({ date, service, method, item }),
    [date, service, method, item],
  );

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
            // Person-to-person transfer: lead with the other person's photo +
            // name so the receiver sees exactly WHO sent (or got) the item.
            const peer =
              row.category === "wallet_transfer" && row.peer_name
                ? { name: row.peer_name, avatar: row.peer_avatar_url ?? null }
                : null;
            return (
              <button
                key={row.id}
                type="button"
                onClick={() => setSelected({ ...row, balanceAfter })}
                className="flex w-full items-center gap-3 sm:gap-4 rounded-2xl bg-background p-3 sm:p-4 text-left shadow-sm transition-transform active:scale-[0.98]"
              >
                {peer ? (
                  <UserAvatar
                    avatarUrl={peer.avatar}
                    fullName={peer.name}
                    size="md"
                    className="h-10 w-10 sm:h-12 sm:w-12 shrink-0"
                  />
                ) : (
                  <span
                    className={cn(
                      "flex h-10 w-10 sm:h-12 sm:w-12 shrink-0 items-center justify-center rounded-full",
                      tone.bubble,
                    )}
                  >
                    <Icon className={cn("h-4 w-4 sm:h-5 sm:w-5", tone.icon)} />
                  </span>
                )}
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-2">
                    <span className="block truncate text-sm sm:text-base font-bold">{txLabel(row)}</span>
                    <Badge
                      variant="secondary"
                      className={cn(
                        "text-[9px] font-bold uppercase tracking-wide",
                        isIn ? "bg-success/10 text-success" : "bg-destructive/10 text-destructive"
                      )}
                    >
                      {isIn ? "Money In" : "Money Out"}
                    </Badge>
                  </span>
                  {peer ? (
                    <span className="block truncate text-xs sm:text-sm font-bold text-foreground">
                      {isIn ? "From" : "To"} {peer.name}
                    </span>
                  ) : (
                    <span className="block truncate text-xs sm:text-sm font-semibold uppercase text-muted-foreground">
                      {txCounterparty(row) ?? "—"}
                    </span>
                  )}
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
                  {balanceAfter != null && (
                    <span className="block text-xs font-medium tabular-nums text-muted-foreground">
                      Bal: {formatUGX(Number(balanceAfter))}
                    </span>
                  )}
                  <span className="text-xs font-medium text-muted-foreground">UGX</span>
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
