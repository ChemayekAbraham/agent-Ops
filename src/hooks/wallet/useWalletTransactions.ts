/**
 * useWalletTransactions — paginated wallet transaction history.
 *
 * The canonical `useWalletBalance` hook already ships the LATEST 10
 * transactions alongside the balance (shared cache + realtime channel).
 * When the user asks for more (Load more / Next / Prev), THIS hook is the
 * single source of truth for pages beyond the first 10.
 *
 * Same underlying filter (`general_ledger`, wallet+bridge scope,
 * admin_correction hidden) so the paginated list can never diverge from
 * the recent-10 preview.
 *
 *   staleTime: 0    — every page is a live read
 *   gcTime: 30s     — brief memoization so Prev doesn't refetch instantly
 *   refetchOnWindowFocus: false
 *   refetchOnReconnect: false
 */
import { useCallback, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  fetchWalletTransactionsPage,
  type WalletTxRow,
} from "@/hooks/wallet/useWalletBalance";

export type WalletTxDirection = "all" | "in" | "out";

export interface UseWalletTransactionsOptions {
  pageSize?: number;
  direction?: WalletTxDirection;
  /** Initial page (0-indexed). */
  initialPage?: number;
}

export function useWalletTransactions(
  userId: string | null | undefined,
  opts: UseWalletTransactionsOptions = {},
) {
  const pageSize = opts.pageSize ?? 20;
  const [page, setPage] = useState(opts.initialPage ?? 0);
  const [direction, setDirection] = useState<WalletTxDirection>(opts.direction ?? "all");

  const query = useQuery<{ rows: WalletTxRow[]; total: number; hasMore: boolean }>({
    queryKey: ["wallet-tx-page", userId ?? "", page, pageSize, direction] as const,
    enabled: !!userId,
    queryFn: () =>
      fetchWalletTransactionsPage(userId as string, { page, pageSize, direction }),
    staleTime: 0,
    gcTime: 30_000,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    // Statement timeouts under DB load are transient — back off and retry.
    retry: 3,
    retryDelay: (attempt) => Math.min(4000, 500 * 2 ** attempt),
  });

  const rows = query.data?.rows ?? [];
  const total = query.data?.total ?? 0;
  const totalPages = Math.max(1, page + 1 + (query.data?.hasMore ? 1 : 0));
  const hasNext = !!query.data?.hasMore;
  const hasPrev = page > 0;

  const next = useCallback(() => setPage((p) => p + 1), []);
  const prev = useCallback(() => setPage((p) => Math.max(0, p - 1)), []);
  const goTo = useCallback((p: number) => setPage(Math.max(0, p)), []);
  const changeDirection = useCallback((d: WalletTxDirection) => {
    setDirection(d);
    setPage(0);
  }, []);

  return {
    rows,
    page,
    pageSize,
    total,
    totalPages,
    hasNext,
    hasPrev,
    direction,
    isLoading: query.isLoading,
    isFetching: query.isFetching,
    error: query.error,
    next,
    prev,
    goTo,
    setDirection: changeDirection,
    refetch: query.refetch,
  };
}