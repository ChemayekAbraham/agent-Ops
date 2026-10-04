import {
  effectiveNextRoiDateOnly,
  isPortfolioRoiDue,
  roiCycleKey,
} from "./roiCycleDates.ts";

export interface GatePortfolio {
  id: string;
  next_roi_date: string | null;
  created_at: string;
  payout_day: number | null;
}

export type GateReason =
  | "no_payout_due"
  | "payout_completed"
  | "payout_pending_approval"
  | "payout_due_not_paid"
  | "gate_check_failed";

/**
 * Renewal must never jump ahead of a payout.
 *
 * A portfolio whose ROI cycle is due (today or overdue) may only be renewed
 * AFTER that cycle's payout has actually landed — otherwise `apply_portfolio_renewal`
 * resets `next_roi_date`/`total_roi_earned` and the final-cycle ROI is silently
 * skipped by the payout run's due-date gate.
 *
 * Completion evidence = a `general_ledger` row carrying the cycle idempotency
 * key `roi-cycle-<portfolio>-<cycle date>`. An open (unapproved) ROI
 * `pending_wallet_operations` row means the payout is still in flight, so the
 * renewal defers to the next run.
 */
export async function evaluateRenewalPayoutGate(
  admin: any,
  p: GatePortfolio,
  nowMs?: number,
): Promise<{ allowed: boolean; reason: GateReason; cycleDate: string }> {
  const cycleDate = effectiveNextRoiDateOnly(p.next_roi_date, p.created_at, p.payout_day, nowMs);

  if (!isPortfolioRoiDue(p, nowMs)) {
    return { allowed: true, reason: "no_payout_due", cycleDate };
  }

  try {
    const key = roiCycleKey(p.id, cycleDate);
    const { data: credited } = await admin
      .from("general_ledger")
      .select("id")
      .eq("idempotency_key", key)
      .limit(1)
      .maybeSingle();
    if (credited) return { allowed: true, reason: "payout_completed", cycleDate };

    const { data: openOp } = await admin
      .from("pending_wallet_operations")
      .select("id")
      .eq("source_table", "investor_portfolios")
      .eq("source_id", p.id)
      .eq("category", "roi_payout")
      .in("status", ["pending", "pending_coo_approval", "coo_approved", "awaiting_verification"])
      .limit(1)
      .maybeSingle();
    if (openOp) return { allowed: false, reason: "payout_pending_approval", cycleDate };

    return { allowed: false, reason: "payout_due_not_paid", cycleDate };
  } catch (_e) {
    // Fail safe: never renew when we cannot prove the payout state.
    return { allowed: false, reason: "gate_check_failed", cycleDate };
  }
}
