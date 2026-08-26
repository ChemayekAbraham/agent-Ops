import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/hooks/useAuth';

export type LandlordFloatAllocation = {
  id: string;
  agent_id: string;
  tenant_id: string | null;
  rent_request_id: string | null;
  landlord_id: string | null;
  landlord_name: string;
  landlord_phone: string | null;
  mobile_money_provider: string | null;
  allocated_amount: number;
  paid_out_amount: number;
  remaining_amount: number;
  status: 'open' | 'partially_paid' | 'fully_paid' | 'cancelled';
  source: string;
  created_at: string;
  /** Tenant this earmark pays a landlord FOR — used so agents can find the row by tenant. */
  tenant_name: string | null;
  /**
   * A payout the agent has ALREADY submitted for this allocation that is still
   * working its way through the merchant queue.
   *
   * The allocation row itself does not tell us this. `paid_out_amount` is only
   * incremented by `apply_landlord_payout_to_allocation`, which fires at
   * 'pending_finops_disbursement' and later — NOT at 'pending_merchant_payout'.
   * So for the whole time a payout waits for a merchant to claim it (hours, and
   * on the current queue sometimes days) the allocation still reads
   * `status: 'open'`, `remaining_amount: <full>` — i.e. it looks like untouched
   * work. Agents then re-open it, find the payout wizard blocked at "Available
   * to pay: UGX 0" (the float is correctly ring-fenced against the payout they
   * already submitted), and conclude the app has swallowed their float.
   *
   * Carrying the in-flight payout here lets the UI say "sent — waiting for a
   * merchant" instead of offering a payment form that cannot be submitted.
   */
  inflight_payout: InflightPayout | null;
};

/** The subset of `landlord_payouts` the agent-facing UI needs to explain a hold. */
export type InflightPayout = {
  id: string;
  amount: number;
  status: string;
  created_at: string;
};

/** `InflightPayout` plus the keys used to match it back to an allocation. */
type PayoutMatchRow = InflightPayout & {
  rent_request_id: string | null;
  landlord_id: string | null;
};

/**
 * Payout states that mean "the agent has committed this allocation and the
 * money is in motion" — everything from OTP verification up to the landlord's
 * receipt being filed. Deliberately excludes 'failed', 'refunded' and
 * 'escalated': those release the float and the allocation really is payable
 * again.
 */
const INFLIGHT_PAYOUT_STATUSES = [
  'otp_verified',
  'pending_merchant_payout',
  'pending_finops_disbursement',
  'disbursing',
  'awaiting_agent_receipt',
  'completed',
];

/**
 * Plain-language status for an already-submitted payout, written for the agent
 * holding the phone — the point is that they have NOT lost their float and do
 * NOT need to pay again.
 */
export function describeInflightPayout(p: InflightPayout): {
  label: string;
  detail: string;
  /** true once the money has actually reached the landlord. */
  settled: boolean;
} {
  switch (p.status) {
    case 'otp_verified':
      return {
        label: 'Sending…',
        detail: 'The landlord approved the OTP. This payment is being queued now.',
        settled: false,
      };
    case 'pending_merchant_payout':
      return {
        label: 'Waiting for a merchant',
        detail:
          'You already sent this payment. It is in the Cash, Mobile Money & Bank queue waiting for a merchant to pay the landlord. Your float is held for it — do not pay again.',
        settled: false,
      };
    case 'pending_finops_disbursement':
    case 'disbursing':
      return {
        label: 'Being paid out',
        detail:
          'A merchant has picked this up and is sending the money to the landlord. Nothing more for you to do.',
        settled: false,
      };
    case 'awaiting_agent_receipt':
      return {
        label: 'Paid — upload receipt',
        detail: 'The landlord has been paid. Upload the receipt to close this off.',
        settled: true,
      };
    case 'completed':
      return { label: 'Paid', detail: 'This landlord has been paid.', settled: true };
    default:
      return {
        label: 'In progress',
        detail: 'You already sent this payment and it is still being processed.',
        settled: false,
      };
  }
}

/**
 * Fetches the agent's per-tenant landlord float allocations.
 * Each row represents one CFO disbursement targeted at a specific tenant→landlord pair.
 * Used by the agent payout flow to drill from "total float" → "tenant" → "withdraw".
 */
export function useLandlordFloatAllocations(opts?: { onlyOpen?: boolean }) {
  const { user } = useAuth();

  return useQuery({
    queryKey: ['landlord-float-allocations', user?.id, opts?.onlyOpen ?? true],
    queryFn: async (): Promise<LandlordFloatAllocation[]> => {
      if (!user) return [];
      let q = supabase
        .from('agent_landlord_float_allocations' as any)
        .select('*')
        .eq('agent_id', user.id)
        .order('created_at', { ascending: false })
        .limit(200);
      if (opts?.onlyOpen !== false) {
        q = q.in('status', ['open', 'partially_paid']);
      }
      const { data, error } = await q;
      if (error) throw error;
      const rows = (data ?? []) as any[];

      // The allocation row stores a NAME SNAPSHOT taken at disbursement time.
      // If the landlord record is later edited/merged (name or MoMo number
      // changed), that snapshot goes stale and the agent sees an unrecognizable
      // name in the payout list ("why isn't my tenant here?"). Re-hydrate the
      // landlord name/phone from the live record, and attach the tenant name so
      // the agent can identify the payout by the tenant it belongs to.
      const tenantIds = [...new Set(rows.map((r) => r.tenant_id).filter(Boolean))];
      const landlordIds = [...new Set(rows.map((r) => r.landlord_id).filter(Boolean))];

      // Payouts the agent has already submitted against these allocations.
      // Matched on rent_request_id first (how the payout is created) and
      // landlord_id as a fallback for older rows with no rent request.
      const rentRequestIds = [...new Set(rows.map((r) => r.rent_request_id).filter(Boolean))];

      const [tenantsRes, landlordsRes, payoutsRes] = await Promise.all([
        tenantIds.length
          ? supabase.from('profiles').select('id, full_name').in('id', tenantIds)
          : Promise.resolve({ data: [] as any[] }),
        landlordIds.length
          ? supabase
              .from('landlords')
              .select('id, name, mobile_money_number, phone')
              .in('id', landlordIds)
          : Promise.resolve({ data: [] as any[] }),
        rentRequestIds.length || landlordIds.length
          ? supabase
              .from('landlord_payouts')
              .select('id, amount, status, created_at, rent_request_id, landlord_id')
              .eq('agent_id', user.id)
              .in('status', INFLIGHT_PAYOUT_STATUSES)
              .order('created_at', { ascending: false })
          : Promise.resolve({ data: [] as PayoutMatchRow[] }),
      ]);

      const tenantById = new Map<string, string>(
        ((tenantsRes as any).data ?? []).map((t: any) => [t.id, t.full_name]),
      );
      const landlordById = new Map<string, any>(
        ((landlordsRes as any).data ?? []).map((l: any) => [l.id, l]),
      );

      // Newest-first, so the first match per key is the current attempt.
      const payoutRows = ((payoutsRes.data ?? []) as unknown) as PayoutMatchRow[];
      const payoutByRentRequest = new Map<string, PayoutMatchRow>();
      const payoutByLandlord = new Map<string, PayoutMatchRow>();
      for (const p of payoutRows) {
        if (p.rent_request_id && !payoutByRentRequest.has(p.rent_request_id)) {
          payoutByRentRequest.set(p.rent_request_id, p);
        }
        if (p.landlord_id && !payoutByLandlord.has(p.landlord_id)) {
          payoutByLandlord.set(p.landlord_id, p);
        }
      }

      return rows.map((r) => {
        const live = r.landlord_id ? landlordById.get(r.landlord_id) : null;
        const payout =
          (r.rent_request_id ? payoutByRentRequest.get(r.rent_request_id) : null) ??
          (r.landlord_id ? payoutByLandlord.get(r.landlord_id) : null) ??
          null;
        return {
          ...r,
          landlord_name: live?.name || r.landlord_name,
          landlord_phone: live?.mobile_money_number || live?.phone || r.landlord_phone,
          tenant_name: r.tenant_id ? tenantById.get(r.tenant_id) ?? null : null,
          allocated_amount: Number(r.allocated_amount) || 0,
          paid_out_amount: Number(r.paid_out_amount) || 0,
          remaining_amount: Number(r.remaining_amount) || 0,
          inflight_payout: payout
            ? {
                id: payout.id,
                amount: Number(payout.amount) || 0,
                status: payout.status,
                created_at: payout.created_at,
              }
            : null,
        };
      }) as LandlordFloatAllocation[];
    },
    enabled: !!user,
    staleTime: 15_000,
    refetchOnWindowFocus: true,
  });
}
