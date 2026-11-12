/**
 * Special Advances: Pay from Wallet, borrower side (migration 20261117140000).
 * Types for `special_advance_my_advances` / `special_advance_pay_from_wallet`, the amount rules the screen applies
 * before asking the server, and borrower-facing messages for the server's refusals. The server decides everything
 * (balance, outstanding, allocation); these helpers only stop obviously wrong input early and explain refusals.
 */

export interface MyAdvanceInstalment {
  number: number;
  due_date: string | null;
  amount: number;
  paid: number;
  outstanding: number;
  status: 'paid' | 'not_due' | 'overdue' | 'part_paid' | 'due';
}

export interface MyAdvanceRepayment {
  id: string;
  amount: number;
  paid_on: string;
  method: 'wallet' | 'mobile_money' | 'bank_transfer';
  reference: string;
  reversed: boolean;
}

export interface MySpecialAdvance {
  id: string;
  reference: string;
  status: 'disbursed' | 'settled';
  principal: number;
  access_fee: number;
  total_repayable: number;
  payout_date: string | null;
  settled_at: string | null;
  position: {
    outstanding: number;
    total_paid: number;
    overdue_amount: number;
    overdue_instalments: number;
    instalments: MyAdvanceInstalment[];
  };
  repayments: MyAdvanceRepayment[];
}

export interface MySpecialAdvances {
  wallet_available: number;
  advances: MySpecialAdvance[];
}

export interface WalletRepaymentReceipt {
  repayment_id: string;
  receipt_reference: string;
  advance_id: string;
  advance_reference: string;
  amount: number;
  paid_on: string;
  recorded_at: string;
  applied_to_access_fee: number;
  applied_to_principal: number;
  status: 'disbursed' | 'settled';
  outstanding: number;
  wallet_available: number;
  replayed: boolean;
}

export const REPAYMENT_METHOD_LABEL: Record<string, string> = {
  wallet: 'Wallet',
  mobile_money: 'Merchant Line (mobile money)',
  bank_transfer: 'Bank transfer',
};

/** The next instalment still owed (overdue ones first, as they are earliest), or null when nothing is owed. */
export function nextInstalment(a: Pick<MySpecialAdvance, 'position'>): MyAdvanceInstalment | null {
  return a.position.instalments.find((i) => i.outstanding > 0) ?? null;
}

/** The most the borrower can pay from the wallet right now: the lower of what is owed and what the wallet holds. */
export function maxWalletPayment(outstanding: number, walletAvailable: number): number {
  return Math.max(0, Math.min(Math.floor(outstanding), Math.floor(walletAvailable)));
}

export type AmountCheck = { ok: true; amount: number } | { ok: false; message: string };

/** Checks a typed amount against the figures on screen (the server checks again, under lock). */
export function checkWalletAmount(text: string, outstanding: number, walletAvailable: number): AmountCheck {
  const cleaned = text.replace(/[,\s]/g, '');
  if (cleaned === '') return { ok: false, message: 'Enter an amount.' };
  if (!/^\d+$/.test(cleaned)) return { ok: false, message: 'Enter a whole amount in UGX, without decimals.' };
  const amount = Number(cleaned);
  if (amount <= 0) return { ok: false, message: 'Enter an amount greater than zero.' };
  if (amount > outstanding) return { ok: false, message: `That is more than you owe (UGX ${outstanding.toLocaleString('en-US')}).` };
  if (amount > walletAvailable) {
    return { ok: false, message: `Your wallet has UGX ${Math.floor(walletAvailable).toLocaleString('en-US')} available.` };
  }
  return { ok: true, amount };
}

const parseDetail = (d?: string): Record<string, unknown> | null => {
  try { return d ? (JSON.parse(d) as Record<string, unknown>) : null; } catch { return null; }
};

/** What happened, in words for the borrower. Every refusal means nothing was taken from the wallet. */
export function describeWalletPaymentError(err: unknown): { message: string; refresh: boolean } {
  const e = (err ?? {}) as { message?: string; details?: string; detail?: string };
  const msg = e.message ?? '';
  const detail = parseDetail(e.details ?? e.detail);
  const ugx = (n: unknown) => `UGX ${Number(n ?? 0).toLocaleString('en-US')}`;
  if (msg.includes('INSUFFICIENT_WALLET_BALANCE')) {
    return { message: `Your wallet does not have enough available. Available now: ${ugx(detail?.available)}.`, refresh: true };
  }
  if (msg.includes('SPECIAL_ADVANCE_STATE_CHANGED')) {
    return { message: `Your balance changed since you opened this. You now owe ${ugx(detail?.outstanding)}. Check the amount and confirm again.`, refresh: true };
  }
  if (msg.includes('OVERPAYMENT_REFUSED')) return { message: `That is more than you owe (${ugx(detail?.outstanding)}).`, refresh: true };
  if (msg.includes('SPECIAL_ADVANCE_NOT_REPAYABLE')) return { message: 'This Special Advance is not open for repayment.', refresh: true };
  if (msg.includes('SPECIAL_ADVANCE_NOT_FOUND')) return { message: 'This Special Advance was not found on your account.', refresh: true };
  if (msg.includes('IDEMPOTENCY_CONFLICT')) return { message: 'This payment was already sent with a different amount. Start again.', refresh: true };
  if (msg.includes('SPECIAL_ADVANCE_INVALID_REQUEST')) return { message: 'Enter a whole amount greater than zero.', refresh: false };
  if (/AUTH_REQUIRED|permission denied|JWT/i.test(msg)) return { message: 'Please sign in again and retry.', refresh: false };
  return { message: 'The payment could not be completed. Please try again.', refresh: false };
}
