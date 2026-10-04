/**
 * Welile AI ID — deterministic, non-identifying, shareable identity
 * Encoded from user UUID, no database column needed
 */

export function generateWelileAiId(userId: string): string {
  const hex = userId.replace(/-/g, '').slice(0, 6).toUpperCase();
  return `WEL-${hex}`;
}

export function isValidAiId(aiId: string): boolean {
  return /^WEL-[A-F0-9]{6}$/i.test(aiId.trim());
}

export function normalizeAiId(aiId: string): string {
  return aiId.trim().toUpperCase();
}

export interface AiIdSummary {
  ai_id: string;
  total_rent_facilitated: number;
  total_rent_requests: number;
  funded_requests: number;
  risk_level: string;
  risk_score: number;
  on_time_payment_rate: number;
  estimated_borrowing_limit: number;
  wallet_balance?: number;
  referral_count: number;
  member_since: string;
  last_refreshed_at: string;
  can_lend?: boolean;
}

/** Risk tier display labels */
export function getRiskTierLabel(riskLevel: string): { label: string; color: string } {
  switch (riskLevel?.toLowerCase()) {
    case 'excellent': return { label: 'Excellent', color: 'text-emerald-600' };
    case 'good': return { label: 'Good', color: 'text-green-600' };
    case 'standard': return { label: 'Standard', color: 'text-blue-600' };
    case 'caution': return { label: 'Caution', color: 'text-amber-600' };
    case 'high_risk': return { label: 'High Risk', color: 'text-red-600' };
    case 'new': return { label: 'New Member', color: 'text-muted-foreground' };
    default: return { label: 'Standard', color: 'text-blue-600' };
  }
}
