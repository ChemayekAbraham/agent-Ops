import { useQuery, type QueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
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
  roiAmount: number;
  depositsAmount: number;
  totalAvailable: number;
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
    roiAmount: Number(row.roi_amount ?? 0),
    depositsAmount: Number(row.deposits_amount ?? 0),
    totalAvailable: Number(row.total_available ?? 0),
    pendingHolds: Number(row.pending_holds ?? 0),
    restrictedHeld: Number(row.restricted_held ?? 0),
    transactions: (row.recent_transactions ?? []) as unknown as PartnerWalletHubRow[],
  };
}

export function usePartnerWalletHub(userId: string | null | undefined, page = 0) {
  return useQuery<PartnerWalletHubData>({
    queryKey: partnerWalletHubKey(userId, page),
    enabled: !!userId,
    queryFn: () => fetchPartnerWalletHub(userId as string, page),
    staleTime: 8_000,
    gcTime: 5 * 60_000,
    refetchOnMount: true,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    retry: 1,
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
