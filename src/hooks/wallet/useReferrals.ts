/**
 * useReferralCount / useReferralsList — direct React Query replacements for
 * the referrals slice of useUserSnapshot (an IndexedDB cache with its own
 * 60s TTL, invalidated independently of React Query). The two caches never
 * synchronized with each other, which is why MyReferralsCount and
 * WalletBreakdown could show different referral numbers on screen at the
 * same time. Retiring useUserSnapshot for this slice (rather than wiring
 * cross-cache invalidation) fixes that at the source instead of adding a
 * second thing to remember to invalidate.
 *
 * Mirrors the exact query supabase/functions/user-snapshot/index.ts already
 * runs against the `referrals` table (referrer_id = userId), including its
 * profile-enrichment shape (`referred_name`/`referred_phone`/`referred_city`/
 * `referral_status`), so migrating onto this doesn't change what's shown —
 * only how it's fetched/cached.
 *
 * useUserSnapshot itself is untouched and stays in place for its other,
 * non-wallet-adjacent consumers.
 */
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { trackRequest } from "@/lib/costMonitor";

const REFERRALS_STALE_MS = 15_000;
const REFERRALS_GC_MS = 5 * 60_000;

export interface ReferralRow {
  id: string;
  referred_id: string;
  bonus_amount: number | null;
  credited: boolean;
  credited_at: string | null;
  created_at: string;
  first_transaction_bonus_amount: number | null;
  first_transaction_bonus_credited: boolean | null;
  referred_name: string;
  referred_phone: string | null;
  referred_city: string | null;
  referral_status: "completed" | "incomplete";
}

export const referralCountKey = (userId: string | null | undefined) =>
  ["referral-count", userId ?? ""] as const;

export const referralsListKey = (userId: string | null | undefined) =>
  ["referrals-list", userId ?? ""] as const;

async function fetchReferralCount(userId: string): Promise<number> {
  trackRequest("db", "referral_count");
  const { count, error } = await supabase
    .from("referrals")
    .select("*", { count: "exact", head: true })
    .eq("referrer_id", userId);
  if (error) throw error;
  return count ?? 0;
}

async function fetchReferralsList(userId: string): Promise<ReferralRow[]> {
  trackRequest("db", "referrals_list");
  const { data, error } = await supabase
    .from("referrals")
    .select(
      "id, referred_id, bonus_amount, credited, credited_at, created_at, first_transaction_bonus_amount, first_transaction_bonus_credited",
    )
    .eq("referrer_id", userId)
    .order("created_at", { ascending: false })
    .limit(50);
  if (error) throw error;
  const rows = data ?? [];
  if (rows.length === 0) return [];

  const referredIds = rows.map((r) => r.referred_id);
  const { data: referredProfiles } = await supabase
    .from("profiles")
    .select("id, full_name, phone, city")
    .in("id", referredIds);

  const profileMap = new Map((referredProfiles ?? []).map((p) => [p.id, p]));

  return rows.map((r) => {
    const profile = profileMap.get(r.referred_id);
    return {
      ...r,
      referred_name:
        profile?.full_name ||
        (r.referred_id ? `Onboarding incomplete · …${String(r.referred_id).slice(-6)}` : "Onboarding incomplete"),
      referred_phone: profile?.phone ?? null,
      referred_city: profile?.city ?? null,
      referral_status: profile ? "completed" : "incomplete",
    } as ReferralRow;
  });
}

export function useReferralCount(userId: string | null | undefined) {
  const query = useQuery<number>({
    queryKey: referralCountKey(userId),
    enabled: !!userId,
    queryFn: () => fetchReferralCount(userId as string),
    staleTime: REFERRALS_STALE_MS,
    gcTime: REFERRALS_GC_MS,
    refetchOnWindowFocus: false,
  });
  return { count: query.data ?? 0, isLoading: query.isLoading, refetch: query.refetch };
}

export function useReferralsList(userId: string | null | undefined) {
  const query = useQuery<ReferralRow[]>({
    queryKey: referralsListKey(userId),
    enabled: !!userId,
    queryFn: () => fetchReferralsList(userId as string),
    staleTime: REFERRALS_STALE_MS,
    gcTime: REFERRALS_GC_MS,
    refetchOnWindowFocus: false,
  });
  return { referrals: query.data ?? [], isLoading: query.isLoading, refetch: query.refetch };
}
