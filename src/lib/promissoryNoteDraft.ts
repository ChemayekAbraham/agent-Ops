/**
 * Agent-facing promissory note draft checks.
 * Fulfil by is required before create. Existing notes without a date stay
 * valid; the list has a "Missing Fulfils by" filter for them. A database
 * constraint is drafted and not applied.
 */

export function promissoryFulfilmentError(recordedOn: string, fulfilmentDueOn: string): string | null {
  if (!fulfilmentDueOn) return 'Fulfil by date';
  if (recordedOn && fulfilmentDueOn < recordedOn) {
    return 'Fulfilment date must be on or after the recording date';
  }
  return null;
}
