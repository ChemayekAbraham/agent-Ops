import { useQuery, type QueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { isUnauthenticatedRpcError, requireUserSession, useAuthenticatedAudience } from "@/hooks/useAuthenticatedPoll";
import { trackRequest } from "@/lib/costMonitor";
import { walletBalanceKey, invalidateWalletBalance } from "./useWalletBalance";

export interface PartnerWalletHubRow {
  id: string;
  transaction_date: string;
  amount: number;
  direction: "cash_in" | "cash_out" | "debit" | "credit" | string;
  category: string;
  description: string | null;
  reference_id: string | null;
  linked_party: string | null;
  source_table: string | null;
  source_id: string | null;
  classification?: string | null;
}

export interface PartnerWalletHubData {
  withdrawableAmount: number;
  floatAmount: number;
  advanceAmount: number;
  /** Returns bucket; null when the viewer may not see another person's Returns (migration 4b, D9). */
  roiAmount: number | null;
  depositsAmount: number;
  /** withdrawable + float + Returns earned; null with roiAmount (migration 4b, D9), because a
   *  visible total would give the masked Returns back by subtraction. */
  totalAvailable: number | null;
  pendingHolds: number;
  restrictedHeld: number;
  transactions: PartnerWalletHubRow[];
}

export const partnerWalletHubKey = (userId: string | null | undefined, page: number) =>
  ["partner-wallet-hub", userId ?? "", page] as const;

const PAGE_SIZE = 15;

export async function fetchPartnerWalletHub(
  userId: string,
  page = 0,
): Promise<PartnerWalletHubData> {
  await requireUserSession();
  trackRequest("db", "get_partner_wallet_hub");
  const { data, error } = await supabase.rpc("get_partner_wallet_hub", {
    p_user_id: userId,
    p_limit: PAGE_SIZE,
    p_offset: page * PAGE_SIZE,
  });
  if (error) throw error;
  const row = data?.[0];
  if (!row) {
    return {
      withdrawableAmount: 0,
      floatAmount: 0,
      advanceAmount: 0,
      roiAmount: 0,
      depositsAmount: 0,
      totalAvailable: 0,
      pendingHolds: 0,
      restrictedHeld: 0,
      transactions: [],
    };
  }
  return {
    withdrawableAmount: Number(row.withdrawable_amount ?? 0),
    floatAmount: Number(row.float_amount ?? 0),
    advanceAmount: Number(row.advance_amount ?? 0),
    // A masked value stays null (never shown as 0 Returns).
    roiAmount: row.roi_amount == null ? null : Number(row.roi_amount),
    depositsAmount: Number(row.deposits_amount ?? 0),
    // Masked with roi_amount (4b): stays null, never shown as a 0 total.
    totalAvailable: row.total_available == null ? null : Number(row.total_available),
    pendingHolds: Number(row.pending_holds ?? 0),
    restrictedHeld: Number(row.restricted_held ?? 0),
    transactions: (row.recent_transactions ?? []) as unknown as PartnerWalletHubRow[],
  };
}

export function usePartnerWalletHub(userId: string | null | undefined, page = 0) {
  const signedIn = useAuthenticatedAudience();
  return useQuery<PartnerWalletHubData>({
    queryKey: partnerWalletHubKey(userId, page),
    enabled: signedIn && !!userId,
    queryFn: () => fetchPartnerWalletHub(userId as string, page),
    staleTime: 8_000,
    gcTime: 5 * 60_000,
    refetchOnMount: true,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    retry: (failureCount, error) => failureCount < 1 && !isUnauthenticatedRpcError(error),
  });
}

export function invalidatePartnerWalletHub(
  qc: QueryClient,
  userId: string | null | undefined,
) {
  if (!userId) return;
  qc.invalidateQueries({ queryKey: ["partner-wallet-hub", userId] });
  invalidateWalletBalance(qc, userId);
}
