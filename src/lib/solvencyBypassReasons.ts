/**
 * Structured reason codes for wallet legs that bypass the strict-balance
 * guard (`enforce_no_negative_wallet_ledger`).
 *
 * Required by:
 *   - DB trigger: stamped on every `cash_out` wallet leg whose
 *     classification = 'admin_correction' or category = 'platform_loss_writeoff'.
 *   - Edge function `cfo-direct-credit` whenever `allow_overdraw: true`.
 *
 * Keep this list in sync with the Postgres enum `public.solvency_bypass_reason`
 * and the SOLVENCY_BYPASS_REASONS Set inside the edge function.
 */
export const SOLVENCY_BYPASS_REASONS = [
  {
    code: 'legacy_offline_paid',
    label: 'Legacy — already paid offline',
    help: 'Funds already moved off-platform (cash, MoMo). Ledger is catching up to reality.',
  },
  {
    code: 'write_off',
    label: 'Write-off (uncollectible)',
    help: 'Balance is uncollectible and is being written off the platform.',
  },
  {
    code: 'admin_correction_seed',
    label: 'Admin correction / seed',
    help: 'One-time wallet seed or migration entry.',
  },
  {
    code: 'legacy_real_backfill',
    label: 'Legacy real backfill',
    help: 'Backfill of a real pre-platform event into the ledger.',
  },
  {
    code: 'dispute_resolution',
    label: 'Dispute resolution',
    help: 'Settling a customer / agent / partner dispute.',
  },
  {
    code: 'regulatory_adjustment',
    label: 'Regulatory adjustment',
    help: 'Forced by BOU / CMA or another regulator/counterparty.',
  },
  {
    code: 'duplicate_reversal',
    label: 'Duplicate reversal',
    help: 'Rolling back a duplicate posting.',
  },
  {
    code: 'other_with_note',
    label: 'Other (note required, ≥30 chars)',
    help: 'Catch-all. The free-text reason must be at least 30 characters.',
  },
] as const;

export type SolvencyBypassReasonCode = (typeof SOLVENCY_BYPASS_REASONS)[number]['code'];

export const SOLVENCY_BYPASS_REASON_CODES: readonly SolvencyBypassReasonCode[] =
  SOLVENCY_BYPASS_REASONS.map((r) => r.code);

export function isSolvencyBypassReasonCode(value: unknown): value is SolvencyBypassReasonCode {
  return typeof value === 'string' && (SOLVENCY_BYPASS_REASON_CODES as readonly string[]).includes(value);
}