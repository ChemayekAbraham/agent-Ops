/**
 * Company-side booking of a deposit credited to the payer's FLOAT bucket.
 *
 * CFO decision 10 Nov 2026 (accounting only — routing is unchanged):
 *   Money that a NON-AGENT (a Supporter, tenant, or anyone without the `agent` role), or anyone with the
 *   `partnership_deposit` purpose, pays by mobile money or bank transfer is received on the company's own line. It is
 *   the payer's money held for them until it funds a portfolio — not agent float issued from the float cycle.
 *
 *     before:  wallet  agent_float_deposit  cash_in   (DR A2)  +  platform agent_float_deposit cash_out (CR A8)
 *     now:     wallet  agent_float_deposit  cash_in   (DR A2)        <- unchanged: same bucket, same category, same TID
 *              platform agent_float_cash_offset  cash_out (CR A2)    <- the money is not with an agent
 *              platform verified_bank_cash_recognised cash_in (DR A1) <- received on the company's line
 *              platform cash_custody_payable cash_out (CR L1)        <- held for the payer
 *     net:     DR A1 / CR L1. A portfolio funded from that float later posts DR L1 / CR L2, closing it.
 *
 *   Agents' own float deposits keep the existing booking pending the CFO's agent-float policy. Physical cash keeps its
 *   own shape (DR A5 / CR L1) and is not handled here.
 *
 * Every consumer of the deposit's WALLET leg (bucket routing, reversal, withdrawal float checks, TID guard, merchant
 * reports) is unaffected: only the platform legs change.
 */

export interface FloatBookingInput {
  isFloatDeposit: boolean;
  isPhysicalCashChannel: boolean;
  isAgent: boolean;
  purpose: string;
}

/** True when a float-bucket deposit must be booked as the payer's money received (DR A1 / CR L1). */
export function isCustomerMoneyFloatDeposit(i: FloatBookingInput): boolean {
  if (!i.isFloatDeposit || i.isPhysicalCashChannel) return false;
  const purpose = (i.purpose || '').toString().trim().toLowerCase();
  return !i.isAgent || purpose === 'partnership_deposit';
}

export interface DepositLegContext {
  depositId: string;
  amount: number;
  provider: string | null;
  transactionId: string | null;
  transactionDate: string;
}

/** The three platform legs that replace the single `agent_float_deposit` platform leg (CR A8). */
export function customerMoneyFloatPlatformLegs(c: DepositLegContext): Record<string, unknown>[] {
  const via = c.provider || 'mobile money';
  const ref = c.transactionId || c.depositId;
  const base = {
    amount: c.amount,
    ledger_scope: 'platform',
    source_table: 'deposit_requests',
    source_id: c.depositId,
    reference_id: ref,
    currency: 'UGX',
    transaction_date: c.transactionDate,
  };
  return [
    { ...base, direction: 'cash_out', category: 'agent_float_cash_offset',
      description: `Offset: payer's own money received via ${via}, not float held by an agent` },
    { ...base, direction: 'cash_in', category: 'verified_bank_cash_recognised',
      description: `Money received on the company's ${via} line (receipt ${ref})` },
    { ...base, direction: 'cash_out', category: 'cash_custody_payable',
      description: `Payer's money held for them until it funds a portfolio (receipt ${ref})` },
  ];
}
