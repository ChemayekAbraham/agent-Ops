/**
 * Agent-facing promissory note draft checks.
 * Fulfil by is required before create. Existing notes without a date stay
 * valid; the list has a "Missing Fulfils by" filter for them. A database
 * constraint is drafted and not applied.
 */

export function promissoryFulfilmentError(
  recordedOn: string,
  fulfilmentDueOn: string,
  /** The latest fulfilment date allowed (YYYY-MM-DD, get_partner_return_policy.note_due_by), or null. */
  noteDueBy: string | null = null,
): string | null {
  if (!fulfilmentDueOn) return 'Fulfil by date';
  if (recordedOn && fulfilmentDueOn < recordedOn) {
    return 'Fulfilment date must be on or after the recording date';
  }
  if (noteDueBy && (!recordedOn || recordedOn <= noteDueBy) && fulfilmentDueOn > noteDueBy) {
    return `Fulfilment date must be on or before ${formatDueBy(noteDueBy)}`;
  }
  return null;
}

/** 2026-12-31 -> "31 Dec 2026". */
export function formatDueBy(isoDate: string): string {
  const [y, m, d] = isoDate.split('-').map(Number);
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${d} ${months[m - 1]} ${y}`;
}

/** The database refusal (FULFILMENT_AFTER_DEADLINE: ...) without its code, for a toast. */
export function noteDueByMessage(message: string): string | null {
  const m = /FULFILMENT_AFTER_DEADLINE:\s*(.*)$/.exec(message);
  return m ? m[1] : null;
}
