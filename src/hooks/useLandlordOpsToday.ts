import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import {
  housesAwaitingVerification,
  landlordsAwaitingVerification,
  lc1AwaitingVerification,
  rentRequestsAwaitingLandlordOps,
  type QueueFilterable,
} from './landlordOpsQueueFilters';

/**
 * Data behind Landlord Ops → Today.
 *
 * The two decisions land in two different tables, and pairing them wrongly is
 * what produced the placeholder figures this replaced:
 *
 *  - **Verified** → `listing_bonus_approvals`, inserted by
 *    `supabase/functions/credit-listing-bonus`. Carries the agent's bonus
 *    `amount` and the deciding operator in `landlord_ops_approved_by`. The
 *    credit has only settled once `status = 'paid'`; earlier statuses are in
 *    flight and `failed` was rolled back.
 *  - **Rejected** → `agent_listing_rejections`, written by the
 *    `reject_house_listing` RPC, which also posts a UGX 4,000
 *    `listing_rejection_penalty` cash_out against the agent's withdrawable
 *    wallet. A rejection therefore *does* move money, in the other direction.
 *
 * `listing_bonus_approvals.rejected_at` is a different event — a rejected bonus
 * approval, not a rejected listing — and is deliberately not counted here.
 */

/**
 * Standard charge applied to the agent when a listing is rejected. Defined in
 * the `reject_house_listing` RPC, which swallows a ledger failure and reports it
 * back as `charged: false` — so this is the charge attempted, not proof that it
 * settled.
 */
export const LISTING_REJECTION_CHARGE = 4000;

/**
 * Bonus credited to the agent when a listing is verified. Mirrors
 * `LISTING_BONUS` in `supabase/functions/credit-listing-bonus`; the authoritative
 * figure is the `amount` written onto the `listing_bonus_approvals` row, so use
 * that wherever a real decision is being displayed and this only to describe
 * what a pending decision will do.
 */
export const LISTING_VERIFICATION_BONUS = 2000;

export type LandlordOpsDecisionKind = 'verified' | 'rejected';

export interface LandlordOpsDecision {
  id: string;
  listingId: string;
  kind: LandlordOpsDecisionKind;
  decidedAt: string;
  /**
   * Verified: the bonus credited to the agent.
   * Rejected: the standard rejection charge debited from the agent.
   */
  amount: number;
  /** Verified only — true once the ledger credit has settled (`status = 'paid'`). */
  creditLanded: boolean;
  /** Raw bonus-approval status; empty string for rejections. */
  status: string;
  rejectionReason: string | null;
  /** Operator who made the call, resolved from profiles. */
  operatorName: string | null;
  listingTitle: string | null;
  district: string | null;
  imageUrl: string | null;
  photoCount: number;
}

export interface LandlordOpsActivityDay {
  /** ISO date (yyyy-mm-dd) for the bucket. */
  date: string;
  verified: number;
  rejected: number;
}

interface ListingLite {
  id: string;
  title: string | null;
  district: string | null;
  image_urls: string[] | null;
}

interface OperatorLite {
  id: string;
  full_name: string | null;
}

/** One decision, normalised across the two source tables. */
interface RawDecision {
  id: string;
  listingId: string;
  kind: LandlordOpsDecisionKind;
  decidedAt: string;
  amount: number;
  creditLanded: boolean;
  status: string;
  rejectionReason: string | null;
  operatorId: string | null;
}

const dayKey = (iso: string) => iso.slice(0, 10);

/** Both decision streams over one window, newest first. */
async function fetchDecisions(sinceIso: string): Promise<RawDecision[]> {
  const [approvals, rejections] = await Promise.all([
    supabase
      .from('listing_bonus_approvals')
      .select('id, listing_id, amount, status, landlord_ops_approved_at, landlord_ops_approved_by')
      .gte('landlord_ops_approved_at', sinceIso)
      .not('landlord_ops_approved_at', 'is', null)
      .order('landlord_ops_approved_at', { ascending: false }),
    supabase
      .from('agent_listing_rejections')
      .select('id, listing_id, reason, rejected_at, rejected_by')
      .gte('rejected_at', sinceIso)
      .order('rejected_at', { ascending: false }),
  ]);

  if (approvals.error) throw approvals.error;
  if (rejections.error) throw rejections.error;

  const verified: RawDecision[] = (approvals.data ?? [])
    .filter((r) => !!r.landlord_ops_approved_at)
    .map((r) => ({
      id: r.id,
      listingId: r.listing_id,
      kind: 'verified' as const,
      decidedAt: r.landlord_ops_approved_at as string,
      amount: r.amount ?? 0,
      creditLanded: r.status === 'paid',
      status: r.status,
      rejectionReason: null,
      operatorId: r.landlord_ops_approved_by ?? null,
    }));

  const rejected: RawDecision[] = (rejections.data ?? [])
    .filter((r) => !!r.listing_id)
    .map((r) => ({
      id: r.id,
      listingId: r.listing_id as string,
      kind: 'rejected' as const,
      decidedAt: r.rejected_at,
      amount: LISTING_REJECTION_CHARGE,
      creditLanded: false,
      status: '',
      rejectionReason: r.reason,
      operatorId: r.rejected_by ?? null,
    }));

  return [...verified, ...rejected].sort((a, b) => b.decidedAt.localeCompare(a.decidedAt));
}

/**
 * Verified-vs-rejected per day over the trailing `days` window, oldest first.
 * Days with no decisions are returned as zeroes so the chart keeps an even axis.
 */
export function useLandlordOpsActivity(days = 8) {
  return useQuery({
    queryKey: ['landlord-ops-today-activity', days],
    staleTime: 60_000,
    queryFn: async (): Promise<LandlordOpsActivityDay[]> => {
      const since = new Date();
      since.setUTCHours(0, 0, 0, 0);
      since.setUTCDate(since.getUTCDate() - (days - 1));
      const decisions = await fetchDecisions(since.toISOString());

      const buckets = new Map<string, LandlordOpsActivityDay>();
      for (let i = 0; i < days; i++) {
        const d = new Date(since);
        d.setUTCDate(since.getUTCDate() + i);
        const key = d.toISOString().slice(0, 10);
        buckets.set(key, { date: key, verified: 0, rejected: 0 });
      }

      for (const d of decisions) {
        const bucket = buckets.get(dayKey(d.decidedAt));
        if (!bucket) continue;
        if (d.kind === 'verified') bucket.verified += 1;
        else bucket.rejected += 1;
      }

      return Array.from(buckets.values());
    },
  });
}

/**
 * The most recent Landlord Ops verification decisions, enriched with the
 * deciding operator and the listing they were made against.
 */
export function useLandlordOpsRecentDecisions(limit = 6) {
  return useQuery({
    queryKey: ['landlord-ops-today-recent-decisions', limit],
    staleTime: 30_000,
    queryFn: async (): Promise<LandlordOpsDecision[]> => {
      // 30 days back is enough to fill the panel on a quiet week without
      // pulling the whole table.
      const since = new Date();
      since.setUTCDate(since.getUTCDate() - 30);
      const decided = (await fetchDecisions(since.toISOString())).slice(0, limit);

      if (decided.length === 0) return [];

      const listingIds = [...new Set(decided.map((d) => d.listingId).filter(Boolean))];
      const operatorIds = [...new Set(decided.map((d) => d.operatorId).filter((v): v is string => !!v))];

      const [listings, operators] = await Promise.all([
        listingIds.length
          ? supabase.from('house_listings').select('id, title, district, image_urls').in('id', listingIds)
          : Promise.resolve({ data: [] as ListingLite[] }),
        operatorIds.length
          ? supabase.from('profiles').select('id, full_name').in('id', operatorIds)
          : Promise.resolve({ data: [] as OperatorLite[] }),
      ]);

      const listingById = new Map<string, ListingLite>(
        ((listings.data ?? []) as ListingLite[]).map((l) => [l.id, l]),
      );
      const operatorById = new Map<string, string | null>(
        ((operators.data ?? []) as OperatorLite[]).map((p) => [p.id, p.full_name ?? null]),
      );

      return decided.map((d) => {
        const listing = listingById.get(d.listingId);
        const images: string[] = listing?.image_urls ?? [];
        return {
          id: d.id,
          listingId: d.listingId,
          kind: d.kind,
          decidedAt: d.decidedAt,
          amount: d.amount,
          creditLanded: d.creditLanded,
          status: d.status,
          rejectionReason: d.rejectionReason,
          operatorName: d.operatorId ? operatorById.get(d.operatorId) ?? null : null,
          listingTitle: listing?.title ?? null,
          district: listing?.district ?? null,
          imageUrl: images[0] ?? null,
          photoCount: images.length,
        };
      });
    },
  });
}

/** Local midnight as an ISO instant — operators read "today" as their own day. */
function startOfLocalDay(): string {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.toISOString();
}

export interface LandlordOpsNewToday {
  houses: number;
  landlords: number;
  lc1: number;
  rentRequests: number;
}

/**
 * Of the items currently sitting in each queue, how many arrived today.
 *
 * Each count applies the same queue filter as the headline it sits under, so it
 * is always a subset and can never exceed it. Without that the cards could read
 * "0 awaiting sign-off / New today: 5" — the sub-label was counting every row
 * created today regardless of status, a different population entirely.
 *
 * Note this is "created today and still queued", not arrivals into the stage:
 * `rent_requests` carries no stage-transition timestamp to key that off.
 */
export function useLandlordOpsNewToday() {
  return useQuery({
    queryKey: ['landlord-ops-today-new'],
    staleTime: 60_000,
    queryFn: async (): Promise<LandlordOpsNewToday> => {
      const since = startOfLocalDay();
      const [houses, landlords, lc1, rentRequests] = await Promise.all([
        housesAwaitingVerification(
          supabase
            .from('house_listings')
            .select('id', { count: 'exact', head: true }) as unknown as QueueFilterable,
        ).gte('created_at', since),
        landlordsAwaitingVerification(
          supabase
            .from('landlords')
            .select('id', { count: 'exact', head: true }) as unknown as QueueFilterable,
        ).gte('created_at', since),
        lc1AwaitingVerification(
          supabase
            .from('v_lc1_verification_inbox')
            .select('lc1_id', { count: 'exact', head: true }) as unknown as QueueFilterable,
        ).gte('requested_at', since),
        rentRequestsAwaitingLandlordOps(
          supabase
            .from('rent_requests')
            .select('id', { count: 'exact', head: true }) as unknown as QueueFilterable,
        ).gte('created_at', since),
      ]);
      return {
        houses: houses.count || 0,
        landlords: landlords.count || 0,
        lc1: lc1.count || 0,
        rentRequests: rentRequests.count || 0,
      };
    },
  });
}

export interface LandlordOpsWalletImpact {
  /** Bonus credits that have settled in the ledger today (`status = 'paid'`). */
  credited: number;
  /** Approved today but the credit has not landed yet — in flight, not owed. */
  pendingCredit: number;
  /** Rejection charges attempted against agents today. */
  charged: number;
  verifiedCount: number;
  rejectedCount: number;
}

/**
 * Wallet consequence of today's verification decisions, in both directions:
 * verifications credit the agent's bonus, rejections debit the standard
 * rejection charge. `credited` counts only what has settled in the ledger.
 */
export function useLandlordOpsWalletImpact() {
  return useQuery({
    queryKey: ['landlord-ops-today-wallet-impact'],
    staleTime: 30_000,
    queryFn: async (): Promise<LandlordOpsWalletImpact> => {
      const decisions = await fetchDecisions(startOfLocalDay());
      let credited = 0;
      let pendingCredit = 0;
      let charged = 0;
      let verifiedCount = 0;
      let rejectedCount = 0;

      for (const d of decisions) {
        if (d.kind === 'rejected') {
          rejectedCount += 1;
          charged += d.amount;
          continue;
        }
        verifiedCount += 1;
        if (d.creditLanded) credited += d.amount;
        // `failed` rows were rolled back — they credited nothing.
        else if (d.status !== 'failed' && d.status !== 'rejected') pendingCredit += d.amount;
      }

      return { credited, pendingCredit, charged, verifiedCount, rejectedCount };
    },
  });
}

/** Houses with no landlord on file — the one Fix-ups backlog that is cheap to count exactly. */
export function useLandlordOpsNoLandlordCount() {
  return useQuery({
    queryKey: ['landlord-ops-no-landlord-count'],
    staleTime: 60_000,
    queryFn: async () => {
      const { count } = await supabase
        .from('house_listings')
        .select('id', { count: 'exact', head: true })
        .is('landlord_id', null)
        .not('status', 'in', '(rejected,delisted)');
      return count || 0;
    },
  });
}
