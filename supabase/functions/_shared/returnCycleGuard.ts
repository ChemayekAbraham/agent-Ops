/**
 * Partner Return cycle guard — the approval side (migration 20261024140000_return_cycle_guard).
 *
 * A portfolio may receive ONE Return per cycle, and a cycle is the calendar month of its scheduled Return date.
 * The database reserves the cycle when the payout is requested (pending_wallet_operations insert) and refuses a
 * second reservation for the same portfolio and month, whatever its execution date, description or retry. At
 * approval this asks the database for the reservation this request holds (creating it for a request queued before
 * the guard existed) and gets back the only ledger key the ledger will accept for it:
 * `return-cycle:<claim>:cash`.
 *
 * Decisions:
 *   post                    reservation held, nothing posted under it yet: post with `ledgerKey`
 *   already_posted          this request's Return is already in the ledger (a retry): post nothing, touch no wallet
 *   blocked                 the database refused: `duplicate` = the cycle already has a Return (reject the request);
 *                           otherwise not due yet / needs an override / request changed (leave it pending)
 *   fail_closed             anything unexpected (RPC missing, network): post nothing, leave the request pending
 *   not_a_portfolio_return  not a portfolio Return (no portfolio source): the cycle guard does not apply
 *
 * No path here moves money: the caller only posts on `post`.
 */

export interface ReturnCycleReservation {
  applies: boolean;
  claim_id?: string;
  kind?: 'payout' | 'split' | 'compound';
  cycle_date?: string;
  cycle_month?: string;
  claim_seq?: number;
  ledger_key?: string;
  already_posted?: boolean;
  advance_next_roi_date?: boolean;
}

export type ReturnCycleDecision =
  | { action: 'not_a_portfolio_return' }
  | { action: 'post'; reservation: ReturnCycleReservation; ledgerKey: string }
  | { action: 'already_posted'; reservation: ReturnCycleReservation; ledgerKey: string }
  | { action: 'blocked'; duplicate: boolean; message: string; code: string }
  | { action: 'fail_closed'; message: string };

interface RpcError { message?: string; code?: string; details?: string; hint?: string }
interface RpcClient {
  rpc: (fn: string, args: Record<string, unknown>) => PromiseLike<{ data: unknown; error: RpcError | null }>;
}

const LEDGER_KEY = /^return-cycle:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:cash$/;

/** Refusals the database raises on purpose; anything else is treated as "unknown" and fails closed. */
const DUPLICATE_CODES = new Set(['23505']);
const REFUSAL_CODES = new Set(['23505', '23514', '42501', '22023', 'P0002']);

export async function reserveReturnCycle(admin: RpcClient, operationId: string): Promise<ReturnCycleDecision> {
  let data: unknown;
  let error: RpcError | null;
  try {
    ({ data, error } = await admin.rpc('claim_return_cycle_for_operation', { p_operation_id: operationId }));
  } catch (e) {
    return { action: 'fail_closed', message: `Return cycle check unavailable: ${(e as Error)?.message || e}` };
  }
  if (error) {
    const code = String(error.code || '');
    if (REFUSAL_CODES.has(code)) {
      return { action: 'blocked', duplicate: DUPLICATE_CODES.has(code), code, message: error.message || 'Return refused' };
    }
    return { action: 'fail_closed', message: `Return cycle check failed: ${error.message || code || 'unknown error'}` };
  }

  const r = (data ?? {}) as ReturnCycleReservation;
  if (r.applies === false) return { action: 'not_a_portfolio_return' };
  if (r.applies !== true || !r.ledger_key || !LEDGER_KEY.test(r.ledger_key)) {
    return { action: 'fail_closed', message: 'Return cycle check returned an unexpected answer' };
  }
  if (r.already_posted) return { action: 'already_posted', reservation: r, ledgerKey: r.ledger_key };
  return { action: 'post', reservation: r, ledgerKey: r.ledger_key };
}

/**
 * A credit coded as a Partner Return (wallet roi_wallet_credit / roi_payout, or platform roi_expense). These must
 * go through the Return payout flow, which reserves the portfolio's cycle; cfo-direct-credit (and the scheduled
 * payouts that call it) name no portfolio or cycle, so they refuse such credits. Debits are not Returns paid.
 */
export function isPartnerReturnCredit(op: string, walletCategory: string, platformCategory: string): boolean {
  return op === 'credit'
    && (walletCategory === 'roi_wallet_credit' || walletCategory === 'roi_payout' || platformCategory === 'roi_expense');
}

/**
 * create_ledger_transaction returns the EXISTING group, posting nothing, when the key was already used. If the
 * first row under the key is older than this call, a concurrent approval of the same request posted it, and the
 * caller must stop before any wallet recovery step.
 */
export function wasPostedBeforeThisCall(firstRowCreatedAt: string | null | undefined, callStartedMs: number): boolean {
  if (!firstRowCreatedAt) return false;
  const t = new Date(firstRowCreatedAt).getTime();
  return Number.isFinite(t) && t < callStartedMs - 1500;
}
