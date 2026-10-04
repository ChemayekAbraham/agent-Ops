import { supabase } from '@/integrations/supabase/client';

/**
 * Rent plans a partner has reserved or already funded (self-managed funding).
 *
 * The company/CFO landlord-float route must never touch these — a DB trigger
 * (`trg_guard_partner_reserved_float_allocation`) is the hard fence; this helper
 * keeps them out of the funding queues so operators never see a plan they cannot
 * fund. Deliberately returns IDs only: the partner's identity is never exposed.
 *
 * One round trip for the whole page (no N+1).
 */
export type PartnerReservedStage =
  | 'partner_held'
  | 'partner_committed'
  | 'partner_funded'
  | 'promissory_booked';

export const PARTNER_RESERVED_LABEL: Record<PartnerReservedStage, string> = {
  partner_held: 'PARTNER CLAIMED',
  partner_committed: 'PARTNER CLAIMED',
  partner_funded: 'PARTNER FUNDED',
  promissory_booked: 'PARTNER BOOKED',
};

export const PARTNER_RESERVED_HINT: Record<PartnerReservedStage, string> = {
  partner_held: 'A partner is selecting this plan for self-managed funding. Company float cannot fund it.',
  partner_committed:
    'A partner has committed this plan and is awaiting Partner Ops approval. On approval the principal goes straight to the agent’s landlord float — do not disburse from company float.',
  partner_funded: 'Already paid for by a partner — the principal is in the agent’s landlord float.',
  promissory_booked:
    'Booked on a partner promissory note for 7 days. Company float cannot fund it — if the partner does not fund in time it is released back to this queue automatically.',
};

/** Reserved stage per rent request (IDs + stage only, never the partner identity). */
export async function fetchPartnerReservedStages(
  rentRequestIds: string[],
): Promise<Map<string, PartnerReservedStage>> {
  const out = new Map<string, PartnerReservedStage>();
  if (!rentRequestIds.length) return out;
  const { data, error } = await supabase.rpc('psm_reserved_plan_ids' as any, {
    p_rent_request_ids: rentRequestIds,
  });
  if (error) {
    console.warn('[partnerReservedPlans] lookup failed:', error.message);
    return out;
  }
  for (const r of (data ?? []) as any[]) {
    out.set(r.rent_request_id as string, r.reserved_stage as PartnerReservedStage);
  }
  return out;
}

export async function fetchPartnerReservedPlanIds(
  rentRequestIds: string[],
): Promise<Set<string>> {
  return new Set((await fetchPartnerReservedStages(rentRequestIds)).keys());
}

/** Drops partner-reserved plans from a list of rent-request-shaped rows. */
export async function excludePartnerReservedPlans<T extends { id: string }>(
  rows: T[],
): Promise<T[]> {
  const reserved = await fetchPartnerReservedPlanIds(rows.map((r) => r.id));
  return reserved.size ? rows.filter((r) => !reserved.has(r.id)) : rows;
}
