const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * True only for a real uuid string. general_ledger.linked_party is free text ("tenant",
 * "Rent Management Pool", a name) as often as it is a profile id, so filter with this before
 * `.in('id', ids)` on profiles or wallets; one non-uuid value makes Postgres refuse the whole query.
 */
export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_RE.test(value);
}

/** Labels and null-like strings are not database identifiers. */
export function uniqueUuidIds(values: readonly unknown[]): string[] {
  return [...new Set(values.filter(isUuid).map(value => value.toLowerCase()))];
}

/** Never issue an ID-list lookup when all inputs were labels or missing IDs. */
export async function withUuidIds<T extends PromiseLike<unknown>>(
  values: readonly unknown[],
  load: (ids: string[]) => T,
): Promise<Awaited<T>> {
  const ids = uniqueUuidIds(values);
  if (ids.length === 0) {
    return { data: [], error: null, count: 0, status: 200, statusText: 'OK' } as Awaited<T>;
  }
  return await load(ids);
}
