/**
 * Requisition-credit label override — shared by every wallet statement
 * surface (TransactionsFeed, WalletLedgerStatement, ...).
 *
 * `cfo-direct-credit` posts every requisition payout's WALLET leg with the
 * generic ledger category `wallet_deposit` (expense categories like
 * `payroll_expense` are intentionally collapsed to `wallet_deposit` there so
 * the strict user-facing wallet view doesn't filter the row out — see that
 * function's `EXPENSE_CATEGORIES` handling). That collapse throws away the
 * one piece of information the recipient actually wants: WHY they got the
 * money. The real reason survives only in the free-text `description`,
 * always written as:
 *   "Welile Technologies Finance [Requisition Credit] → {dept}: Requisition {CODE}: {purpose}"
 * (see supabase/functions/_shared/requisitionWalletCredit.ts).
 *
 * Rather than change ledger routing (high blast radius — touches every
 * requisition payout in production), recover the requisition code from the
 * description for display purposes only.
 */
const REQUISITION_CREDIT_RE = /\[Requisition Credit\].*?Requisition\s+([A-Za-z]+-\d+)/;

/** The requisition code (e.g. "SRQ-00035") if this row is a requisition credit, else null. */
export function requisitionCodeFromDescription(description: string | null | undefined): string | null {
  if (!description) return null;
  const match = REQUISITION_CREDIT_RE.exec(description);
  return match ? match[1] : null;
}

/** Display label override for a requisition-credit row, else null (fall through to the normal category label). */
export function requisitionEntryLabel(description: string | null | undefined): string | null {
  const code = requisitionCodeFromDescription(description);
  return code ? `Requisition ${code}` : null;
}
