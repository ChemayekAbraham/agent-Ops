const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * True only for a real uuid string. general_ledger.linked_party is free text ("tenant",
 * "Rent Management Pool", a name) as often as it is a profile id, so filter with this before
 * `.in('id', ids)` on profiles or wallets; one non-uuid value makes Postgres refuse the whole query.
 */
export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_RE.test(value);
}
