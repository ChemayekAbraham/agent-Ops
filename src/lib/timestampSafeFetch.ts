/** Postgres permits short +HH offsets; JavaScript requires +HH:MM. */
export function timestampToIso(value: string): string {
  return new Date(value.replace(/([+-]\d{2})$/, '$1:00')).toISOString();
}

/** Normalize timestamp comparisons before URL form decoding can lose a + offset. */
export function timestampSafeUrl(input: string): string {
  let url: URL;
  try { url = new URL(input); } catch { return input; }
  if (!url.pathname.includes('/rest/v1/')) return input;
  let changed = false;
  for (const [key, value] of [...url.searchParams.entries()]) {
    if (key !== 'created_at') continue;
    const match = /^(gt|gte|lt|lte)\.(\d{4}-\d{2}-\d{2}[T ][\s\S]+)$/.exec(value);
    if (!match) continue;
    // Raw +00 in a manually built query is decoded as " 00". Support the
    // database's short +HH offset as well as ISO's +HH:MM representation.
    const timestamp = match[2]
      .replace(/ (\d{2}(?::?\d{2})?)$/, '+$1')
      .replace(/([+-]\d{2})$/, '$1:00');
    const date = new Date(timestamp);
    if (!Number.isFinite(date.getTime())) continue;
    const normalized = `${match[1]}.${date.toISOString()}`;
    if (normalized === value) continue;
    url.searchParams.set(key, normalized);
    changed = true;
  }
  return changed ? url.toString() : input;
}

/** Preserve request headers/body, including the caller's JWT; never change auth. */
export const timestampSafeFetch: typeof fetch = (input, init) => {
  const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  const safe = timestampSafeUrl(raw);
  if (safe === raw) return globalThis.fetch(input, init);
  return globalThis.fetch(input instanceof Request ? new Request(safe, input) : safe, init);
};