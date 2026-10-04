/**
 * Persist a single deposit matcher/poller/approval decision to the
 * `deposit_decision_audit` trail. Fire-and-forget — failures are logged
 * but never thrown, so auditing can never break the deposit flow itself.
 *
 * Records EVERY meaningful decision for a deposit attempt:
 *  - source 'matcher'  → email/MoMo auto-match decisions
 *  - source 'poller'   → Gmail poller decisions (skipped/matched/auto_credited)
 *  - source 'approval' → approve-deposit outcomes & every rejection/block reason
 */
export interface DepositDecisionAudit {
  deposit_request_id?: string | null;
  gmail_transaction_id?: string | null;
  source: "matcher" | "poller" | "approval";
  decision: string; // approved | rejected | blocked | skipped | auto_credited | failed | matched | ...
  reason?: string | null; // e.g. cash_code_required, auto_approve_unverified
  amount?: number | null;
  actor_id?: string | null;
  actor_email?: string | null;
  metadata?: Record<string, unknown>;
}

export async function logDepositDecision(
  // deno-lint-ignore no-explicit-any
  adminClient: any,
  entry: DepositDecisionAudit,
): Promise<void> {
  try {
    await adminClient.from("deposit_decision_audit").insert({
      deposit_request_id: entry.deposit_request_id ?? null,
      gmail_transaction_id: entry.gmail_transaction_id ?? null,
      source: entry.source,
      decision: entry.decision,
      reason: entry.reason ?? null,
      amount: entry.amount ?? null,
      actor_id: entry.actor_id ?? null,
      actor_email: entry.actor_email ?? null,
      metadata: entry.metadata ?? {},
    });
  } catch (err) {
    console.error(`[depositDecisionAudit] failed to log ${entry.source}/${entry.decision}:`, err);
  }
}

/** Bulk variant — persists many decisions in one round-trip. */
export async function logDepositDecisions(
  // deno-lint-ignore no-explicit-any
  adminClient: any,
  entries: DepositDecisionAudit[],
): Promise<void> {
  if (!entries.length) return;
  try {
    await adminClient.from("deposit_decision_audit").insert(
      entries.map((entry) => ({
        deposit_request_id: entry.deposit_request_id ?? null,
        gmail_transaction_id: entry.gmail_transaction_id ?? null,
        source: entry.source,
        decision: entry.decision,
        reason: entry.reason ?? null,
        amount: entry.amount ?? null,
        actor_id: entry.actor_id ?? null,
        actor_email: entry.actor_email ?? null,
        metadata: entry.metadata ?? {},
      })),
    );
  } catch (err) {
    console.error(`[depositDecisionAudit] bulk insert failed (${entries.length} rows):`, err);
  }
}