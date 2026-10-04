/**
 * Humanises server-side withdrawal errors so agents/proxy partners never see a
 * raw Postgres trigger message.
 *
 * The fraud trigger `enforce_no_fraud_withdrawal_request` on
 * `withdrawal_requests` fires against the BENEFICIARY (not the person clicking),
 * so a proxy partner approving a payout for a frozen account previously saw a
 * database-level string with no indication of whose account was blocked.
 */
export function humanizeWithdrawalError(
  message: string | undefined | null,
  beneficiaryName?: string | null,
): string {
  const raw = String(message || '').trim();
  const lower = raw.toLowerCase();

  const isFrozen =
    lower.includes('fraud_blocked_withdrawal') ||
    lower.includes('frozen') ||
    lower.includes('fraud block');

  if (isFrozen) {
    const who = (beneficiaryName || '').trim();
    return `Beneficiary ${who || 'account'} is frozen and cannot receive payouts — contact CTO/compliance to review the freeze before retrying. If this request is no longer valid, cancel it instead.`;
  }

  return raw || 'Something went wrong. Check the details and try again.';
}
