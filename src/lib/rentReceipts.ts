/**
 * Shared receipt pairing rule for rent repayment reads.
 *
 * `repayments` and `agent_collections` overlap: the agent collection flow writes
 * both legs for the same money. A repayment row is only an extra receipt when no
 * collection on the same plan carries the same amount within five minutes — the
 * same pairing the reconciliation reads use. Everything else is a tenant
 * self-payment (or another supported channel) that the agent never keyed in.
 *
 * Extracted from Tenant Ops → Agent Monitoring so read-only views (Calling
 * Center tenant details) show the very same receipt set without a second rule.
 */

export interface ReceiptMatchable {
  rent_request_id: string | null;
  amount: number | null;
  created_at: string;
}

export const MATCH_WINDOW_MS = 5 * 60 * 1000;

export function unmatchedRepayments<T extends ReceiptMatchable>(
  repayments: T[],
  collections: ReceiptMatchable[],
): T[] {
  const byPlan = new Map<string, { amount: number; time: number }[]>();
  collections.forEach((row) => {
    if (!row.rent_request_id) return;
    const list = byPlan.get(row.rent_request_id) ?? [];
    list.push({ amount: Number(row.amount ?? 0), time: new Date(row.created_at).getTime() });
    byPlan.set(row.rent_request_id, list);
  });
  return repayments.filter((row) => {
    if (!row.rent_request_id) return false;
    const candidates = byPlan.get(row.rent_request_id) ?? [];
    const amount = Number(row.amount ?? 0);
    const time = new Date(row.created_at).getTime();
    return !candidates.some((c) => c.amount === amount && Math.abs(c.time - time) < MATCH_WINDOW_MS);
  });
}
