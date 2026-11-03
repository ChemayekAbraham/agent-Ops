import { supabase } from '@/integrations/supabase/client';

/**
 * Safe public shape of a shared Support Plan. This is the ONLY shape the
 * public page may render — the server function already whitelists these
 * fields, and this type + parser are the second lock: anything else the
 * response might carry (phones, full names, GPS, agent or wallet data) is
 * dropped here before it can reach the UI.
 */
export interface PublicSupportPlan {
  planId: string;
  photoUrl: string | null;
  city: string | null;
  houseCategory: string | null;
  tenantFirstName: string | null;
  fundingAmount: number;
  monthlyReturn: number;
  twelveMonthTotal: number;
}

export type PublicSupportPlanResult =
  | { status: 'available'; plan: PublicSupportPlan }
  | { status: 'unavailable' };

const asText = (value: unknown): string | null =>
  typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;

const asAmount = (value: unknown): number => {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) && n >= 0 ? n : 0;
};

/** Parses the server response into the whitelisted shape, discarding every other key. */
export function parsePublicSupportPlan(raw: unknown): PublicSupportPlanResult {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { status: 'unavailable' };
  const obj = raw as Record<string, unknown>;
  if (obj.status !== 'available' || typeof obj.plan_id !== 'string') {
    return { status: 'unavailable' };
  }
  return {
    status: 'available',
    plan: {
      planId: obj.plan_id,
      photoUrl: asText(obj.photo_url),
      city: asText(obj.city),
      houseCategory: asText(obj.house_category),
      tenantFirstName: asText(obj.tenant_first_name),
      fundingAmount: asAmount(obj.funding_amount),
      monthlyReturn: asAmount(obj.monthly_return),
      twelveMonthTotal: asAmount(obj.twelve_month_total),
    },
  };
}

export async function fetchPublicSupportPlan(planId: string): Promise<PublicSupportPlanResult> {
  const { data, error } = await supabase.rpc('public_support_plan', { p_plan_id: planId });
  if (error) return { status: 'unavailable' };
  return parsePublicSupportPlan(data);
}
