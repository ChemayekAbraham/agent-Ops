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
  tenant_id: string | null;
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
 * Statuses eligible for the legacy no-rent_request_id fallback match (see
 * `payoutByTenantLandlord` below). Deliberately excludes the terminal
 * `awaiting_agent_receipt` / `completed` states — a payout that already
 * finished should not permanently mask a *different*, later allocation for
 * the same tenant+landlord that has no rent_request_id linking it to that
 * old payout. `INFLIGHT_PAYOUT_STATUSES` above stays the full list for the
 * primary rent_request_id match, where a completed/awaiting-receipt payout
 * for the SAME cycle is exactly what should keep showing "upload receipt".
 */
const FALLBACK_ELIGIBLE_STATUSES = new Set([
  'otp_verified',
  'pending_merchant_payout',
  'pending_finops_disbursement',
  'disbursing',
]);

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
              // Only the Landlord-Ops-approved payout number is ever read here.
              // `mobile_money_number`/`phone` are freely editable and are NOT the
              // number money goes to — showing them made the displayed number
              // appear to "shuffle" at payout time.
              .select('id, name, verified_mobile_money_number, verification_status')
              .in('id', landlordIds)
          : Promise.resolve({ data: [] as any[] }),
        rentRequestIds.length || landlordIds.length
          ? supabase
              .from('landlord_payouts')
              .select('id, amount, status, created_at, rent_request_id, landlord_id, tenant_id')
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
      // Legacy-only fallback, keyed by tenant+landlord (not landlord alone —
      // one landlord can have many tenants, and matching on landlord_id alone
      // let a payout for tenant A mask a completely unrelated allocation for
      // tenant B). Only ever consulted for allocations with no rent_request_id.
      const payoutByTenantLandlord = new Map<string, PayoutMatchRow>();
      for (const p of payoutRows) {
        if (p.rent_request_id && !payoutByRentRequest.has(p.rent_request_id)) {
          payoutByRentRequest.set(p.rent_request_id, p);
        }
        if (p.tenant_id && p.landlord_id && FALLBACK_ELIGIBLE_STATUSES.has(p.status)) {
          const key = `${p.tenant_id}|${p.landlord_id}`;
          if (!payoutByTenantLandlord.has(key)) payoutByTenantLandlord.set(key, p);
        }
      }

      // Belt-and-braces against a double payment: a row whose remaining amount
      // has been fully paid out is not payable work, whatever its status text
      // says. Only applied to the payable ("onlyOpen") view so history/report
      // callers still see closed allocations.
      const payableRows =
        opts?.onlyOpen === false
          ? rows
          : rows.filter((r) => (Number(r.remaining_amount) || 0) > 0);

      return payableRows.map((r) => {
        const live = r.landlord_id ? landlordById.get(r.landlord_id) : null;
        const payout =
          (r.rent_request_id ? payoutByRentRequest.get(r.rent_request_id) : null) ??
          // Only ever fall back when THIS allocation has no rent_request_id of
          // its own (legacy rows). A renewal always gets a fresh
          // rent_request_id, so it must never inherit a prior cycle's payout
          // just because it shares a landlord — that was misattributing
          // UGX 19.55M across 22 open allocations to stale, already-closed
          // payouts (agent saw "Paid — upload receipt" for rent it hadn't
          // been paid for yet, with no way back to the OTP/pay screen).
          (!r.rent_request_id && r.tenant_id && r.landlord_id
            ? payoutByTenantLandlord.get(`${r.tenant_id}|${r.landlord_id}`)
            : null) ??
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
    // Money screen: never serve a cached allocation list. A row that was paid
    // out elsewhere (wizard on another device, merchant approval, ops action)
    // must not stay tappable here — that is how a landlord gets paid twice.
    staleTime: 0,
    refetchOnMount: 'always',
    refetchOnWindowFocus: true,
  });
}
