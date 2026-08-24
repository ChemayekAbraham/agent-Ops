/**
 * /transactions-test — customer transaction history prototype.
 * 15 rows per fetch, keyset "Load more" (one query per page, no N+1).
 */
import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useInfiniteQuery } from "@tanstack/react-query";
import { format, parseISO } from "date-fns";
import { ArrowLeft, ChevronDown, Download, Loader2, Wallet } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useAuth } from "@/hooks/useAuth";
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
  txLabel,
  txMaskedNumber,
  txMethodLabel,
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

export default function TransactionsTest() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const [date, setDate] = useState<TxDateFilter>("all");
  const [service, setService] = useState<TxServiceFilter>("all");
  const [method, setMethod] = useState<TxMethodFilter>("all");
  const [selected, setSelected] = useState<TxFeedRow | null>(null);

  const filters = useMemo(() => ({ date, service, method }), [date, service, method]);

  const query = useInfiniteQuery({
    queryKey: ["tx-feed", user?.id ?? "", filters] as const,
    enabled: !!user?.id,
    initialPageParam: null as string | null,
    queryFn: ({ pageParam }) => fetchTxFeedPage(user!.id, filters, pageParam),
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
    <div className="min-h-screen bg-muted/40">
      <header className="sticky top-0 z-30 bg-background">
        <div className="flex items-center gap-3 px-4 py-4">
          <button
            type="button"
            onClick={() => navigate(-1)}
            aria-label="Go back"
            className="flex h-9 w-9 items-center justify-center rounded-full transition-transform active:scale-90"
          >
            <ArrowLeft className="h-6 w-6" />
          </button>
          <h1 className="flex-1 text-2xl font-bold tracking-tight">Transaction History</h1>
          <Button className="h-11 rounded-2xl px-4 font-bold">
            <Download className="mr-2 h-4 w-4" />
            Statement
          </Button>
        </div>
        <div className="flex gap-3 overflow-x-auto border-t border-border/60 px-4 py-3">
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
      </header>

      <main className="space-y-6 px-4 py-5 pb-24">
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
            <h2 className="text-lg font-bold">
              {format(parseISO(group.day), "EEEE, MMM d, yyyy")}
            </h2>
            {group.rows.map((row) => {
              const isIn = row.direction === "cash_in";
              const masked = txMaskedNumber(row);
              return (
                <button
                  key={row.id}
                  type="button"
                  onClick={() => setSelected(row)}
                  className="flex w-full items-center gap-4 rounded-2xl bg-background p-4 text-left transition-transform active:scale-[0.98]"
                >
                  <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-primary/10">
                    <Wallet className="h-5 w-5 text-primary" />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-bold">{txLabel(row)}</span>
                    <span className="block truncate text-sm font-semibold uppercase text-muted-foreground">
                      {txCounterparty(row) ?? "—"}
                    </span>
                    <span className="mt-1 flex items-center gap-2">
                      <Badge variant="secondary" className="text-[10px] font-bold">
                        {txMethodLabel(row)}
                      </Badge>
                      {masked && (
                        <span className="text-xs font-medium text-muted-foreground">{masked}</span>
                      )}
                    </span>
                  </span>
                  <span className="shrink-0 text-right">
                    <span
                      className={cn(
                        "block text-lg font-bold tabular-nums",
                        isIn ? "text-success" : "text-foreground",
                      )}
                    >
                      {isIn ? "+" : "−"}
                      {formatUGX(Number(row.amount)).replace(/^UGX\s*/, "")}
                    </span>
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
      </main>

      <TransactionDetailDrawer
        row={selected}
        open={!!selected}
        onOpenChange={(open) => !open && setSelected(null)}
      />
    </div>
  );
}
