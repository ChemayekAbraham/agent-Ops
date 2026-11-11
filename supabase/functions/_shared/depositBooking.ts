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
  /** Record the money came in through (deposit_requests id); omit for flows without one (cfo_direct_credit). */
  sourceId?: string | null;
  /** Defaults to 'deposit_requests'. */
  sourceTable?: string;
  amount: number;
  provider: string | null;
  /** The payment's own reference (MoMo / bank TID). */
  transactionId: string | null;
  /** Ledger reference_id; defaults to transactionId, then sourceId. */
  referenceId?: string | null;
  transactionDate: string;
  /** Extra fields stamped on every leg (e.g. user_id of the operator). */
  extra?: Record<string, unknown>;
}

/** The three platform legs that replace the single `agent_float_deposit` platform leg (CR A8). */
export function customerMoneyFloatPlatformLegs(c: DepositLegContext): Record<string, unknown>[] {
  const via = c.provider || 'mobile money';
  const receipt = c.transactionId || c.referenceId || c.sourceId || 'unreferenced';
  const base: Record<string, unknown> = {
    ...(c.extra ?? {}),
    amount: c.amount,
    ledger_scope: 'platform',
    source_table: c.sourceTable ?? 'deposit_requests',
    ...(c.sourceId ? { source_id: c.sourceId } : {}),
    reference_id: c.referenceId ?? c.transactionId ?? c.sourceId ?? null,
    currency: 'UGX',
    transaction_date: c.transactionDate,
  };
  const ref = receipt;
  return [
    { ...base, direction: 'cash_out', category: 'agent_float_cash_offset',
      description: `Offset: payer's own money received via ${via}, not float held by an agent` },
    { ...base, direction: 'cash_in', category: 'verified_bank_cash_recognised',
      description: `Money received on the company's ${via} line (receipt ${ref})` },
    { ...base, direction: 'cash_out', category: 'cash_custody_payable',
      description: `Payer's money held for them until it funds a portfolio (receipt ${ref})` },
  ];
}

/** Mirror of the payer's-money-received legs, used when a routed inbound payment is reversed (CR A1 / DR L1). */
export function reverseCustomerMoneyLegs(legs: Record<string, unknown>[], reversalRef: string | null): Record<string, unknown>[] {
  return legs.map((l) => ({
    ...l,
    direction: l.direction === 'cash_in' ? 'cash_out' : 'cash_in',
    description: `Reversal${reversalRef ? ` (${reversalRef})` : ''}: ${String(l.description)}`,
  }));
}
