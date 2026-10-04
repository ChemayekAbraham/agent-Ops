/**
 * Shared matcher for the Service Center vetting search box.
 * Case-insensitive substring match across the given fields; an empty query matches everything.
 */
export function matchesVettingQuery(query: string, ...fields: Array<string | null | undefined>): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return fields.some((f) => (f ?? '').toLowerCase().includes(q));
}
