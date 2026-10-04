/**
 * Mirrors the Postgres `public.normalize_momo_tid(text)` function used by
 * `try_link_gmail_for_deposit` to match user-entered TIDs against parsed
 * Gmail mobile-money receipts.
 *
 * Carriers prepend short alpha prefixes to the same underlying numeric
 * reference (MTN -> "MP", Airtel -> "AT", etc.). Receipts and in-app
 * submissions sometimes include the prefix and sometimes don't, so we
 * compare on the digit-tail only.
 *
 * Keep this in sync with the SQL definition. If you change one, change both.
 */
export function normalizeMomoTid(tid: string | null | undefined): string {
  if (!tid) return '';
  return tid.replace(/\D+/g, '');
}

export function momoTidsMatch(
  a: string | null | undefined,
  b: string | null | undefined,
): boolean {
  const na = normalizeMomoTid(a);
  const nb = normalizeMomoTid(b);
  return na.length > 0 && na === nb;
}