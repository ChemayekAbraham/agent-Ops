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
import { ChevronDown, Loader2, Undo2 } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
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
import { welileItemImage } from "@/lib/welileItemImages";
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

/** Reversal-state filter for person-to-person wallet transfers. */
type TxReversalFilter = "all" | "reversible" | "reversed" | "ineligible";

const TX_REVERSAL_OPTIONS: { value: TxReversalFilter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "reversible", label: "Reversible" },
  { value: "reversed", label: "Reversed" },
  { value: "ineligible", label: "No longer eligible" },
];

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
  const [reversal, setReversal] = useState<TxReversalFilter>("all");
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

  // Reversal filter: resolve the reversal state of every loaded wallet transfer
  // in ONE batched round trip. The server function reuses the exact per-transfer
  // logic the badges and Reverse button use, so a filter match can never
  // disagree with the badge on the same row.
  const transferRefs = useMemo(
    () =>
      [...new Set(rows.map((r) => transferRefOf(r)).filter((r): r is string => r !== null))],
    [rows],
  );
  const states = useQuery({
    queryKey: ["wallet-transfer-reversal-states", userId ?? "", transferRefs] as const,
    enabled: reversal !== "all" && transferRefs.length > 0,
    staleTime: 60_000,
    refetchOnWindowFocus: false,
    queryFn: async () => {
      const { data, error } = await supabase.rpc("wallet_transfer_reversal_states", {
        p_references: transferRefs,
      });
      if (error) throw error;
      const byRef: Record<string, string> = {};
      for (const s of (data ?? []) as { reference_id: string; state: string }[]) {
        byRef[s.reference_id] = s.state;
      }
      return byRef;
    },
  });
  const reversalLoading = reversal !== "all" && states.isLoading;

  const visibleRows = useMemo(() => {
    if (reversal === "all") return rows;
    const byRef = states.data;
    if (!byRef) return [];
    return rows.filter((row) => {
      const ref = transferRefOf(row);
      if (!ref) return false;
      const state = byRef[ref];
      if (reversal === "reversible") return state === "reversible";
      if (reversal === "reversed") return state === "reversed";
      return state === "withdrawn" || state === "nothing_left";
    });
  }, [rows, reversal, states.data]);

  const groups = useMemo(() => groupTxByDay(visibleRows), [visibleRows]);

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
          <FilterPill
            label="Item"
            value={item}
            options={TX_ITEM_OPTIONS}
            onChange={(v) => setItem(v as TxItemFilter)}
          />
        </div>
      )}

      {showFilters && (
        <WelileItemTotals
          userId={userId}
          date={date}
          selected={item}
          onSelect={setItem}
        />
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
            const itemPhoto = welileItemImage(row.description);
            return (
              <div key={row.id} className="space-y-1.5">
              <button
                type="button"
                onClick={() => setSelected({ ...row, balanceAfter })}
                className="flex w-full items-center gap-3 sm:gap-4 rounded-2xl bg-background p-3 sm:p-4 text-left shadow-sm transition-transform active:scale-[0.98]"
              >
                {itemPhoto ? (
                  // Real market photo of the item, with the other person's
                  // face tucked in the corner.
                  <span className="relative h-10 w-10 sm:h-12 sm:w-12 shrink-0">
                    <img
                      src={itemPhoto}
                      alt={row.description?.trim() || txLabel(row)}
                      loading="lazy"
                      width={512}
                      height={512}
                      className="h-full w-full rounded-xl object-cover"
                    />
                    {peer && (
                      <UserAvatar
                        avatarUrl={peer.avatar}
                        fullName={peer.name}
                        size="sm"
                        className="absolute -bottom-1 -right-1 h-5 w-5 border-2 border-background sm:h-6 sm:w-6"
                      />
                    )}
                  </span>
                ) : peer ? (
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
                    <TransferReversalBadge row={row} />
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
              <ReverseTransferRowButton row={row} onOpen={() => setSelected({ ...row, balanceAfter })} />
              <TransferReversalReason row={row} />
              </div>
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

/** Reference of an original (non-reversal) wallet transfer row, else null. */
function transferRefOf(row: TxFeedRow): string | null {
  return row.category === "wallet_transfer" &&
    row.reference_id &&
    !String(row.reference_id).endsWith("-REV")
    ? String(row.reference_id)
    : null;
}

/**
 * Reversal status for a person-to-person wallet transfer. Shared React Query
 * key with ReverseTransferRowButton, so the two components fetch once.
 */
function useTransferReversalStatus(ref: string | null) {
  return useQuery({
    queryKey: ["wallet-transfer-reversal-status", ref],
    enabled: !!ref,
    staleTime: 60_000,
    queryFn: async () => {
      const { data, error } = await supabase.rpc("wallet_transfer_reversal_status", { p_reference: ref as string });
      if (error) throw error;
      return data as {
        state?: "reversible" | "reversed" | "withdrawn" | "nothing_left" | "received" | "not_involved" | "not_found" | "sign_in";
        can_reverse: boolean;
        reason?: string;
        sent?: number;
        reversible?: number;
        /** ISO 8601 — when the transfer was reversed ('reversed' state only). */
        reversed_at?: string;
      };
    },
  });
}

/** Clear status chip on every wallet transfer: Reversible / Reversed / No longer eligible. */
function TransferReversalBadge({ row }: { row: TxFeedRow }) {
  const ref = transferRefOf(row);
  const status = useTransferReversalStatus(ref);
  if (!ref || !status.data) return null;
  const { state } = status.data;
  if (state === "reversible") {
    return (
      <Badge variant="secondary" className="shrink-0 bg-success/10 text-[9px] font-bold uppercase tracking-wide text-success">
        Reversible
      </Badge>
    );
  }
  if (state === "reversed") {
    return (
      <Badge variant="secondary" className="shrink-0 bg-muted text-[9px] font-bold uppercase tracking-wide text-muted-foreground">
        Reversed
      </Badge>
    );
  }
  if (state === "withdrawn" || state === "nothing_left") {
    return (
      <Badge variant="secondary" className="shrink-0 bg-muted text-[9px] font-bold uppercase tracking-wide text-muted-foreground">
        No longer eligible
      </Badge>
    );
  }
  // 'received' (incoming, not reversed), 'not_involved', 'not_found', 'sign_in'
  return null;
}

/**
 * Reversal detail under a transfer row. For a reversed transfer (sender OR
 * recipient): when it was reversed. For an outgoing transfer that can no
 * longer be reversed: why (withdrawn / fully-spent cases — "Reversed"
 * already explains itself, so it gets the timestamp instead).
 */
function TransferReversalReason({ row }: { row: TxFeedRow }) {
  const ref = transferRefOf(row);
  const status = useTransferReversalStatus(ref);
  if (!ref || !status.data) return null;
  const { state, reversed_at } = status.data;
  if (state === "reversed") {
    if (!reversed_at) return null;
    const when = format(parseISO(reversed_at), "MMM d, yyyy 'at' h:mm a");
    return (
      <p className="px-1 text-xs font-medium leading-snug text-muted-foreground">
        Reversed on {when}.
      </p>
    );
  }
  if (row.direction !== "cash_out") return null;
  let reason: string | null = null;
  if (state === "withdrawn") {
    reason = "Can't reverse — the recipient has already withdrawn these funds.";
  } else if (state === "nothing_left") {
    reason = "Can't reverse — the recipient's wallet has nothing left to return.";
  }
  if (!reason) return null;
  return (
    <p className="px-1 text-xs font-medium leading-snug text-muted-foreground">
      {reason}
    </p>
  );
}

/** Shows "Reverse transfer" under an outgoing transfer while the server says it can still be reversed. */
function ReverseTransferRowButton({ row, onOpen }: { row: TxFeedRow; onOpen: () => void }) {
  const ref = transferRefOf(row);
  const status = useTransferReversalStatus(ref);
  if (!ref || !status.data?.can_reverse) return null;
  return (
    <Button
      variant="outline"
      className="h-10 w-full rounded-xl text-sm font-bold text-destructive"
      onClick={onOpen}
    >
      <Undo2 className="mr-1.5 h-4 w-4" />
      Reverse transfer
    </Button>
  );
}

export default TransactionsFeed;
