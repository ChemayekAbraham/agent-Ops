/**
 * Location text helpers shared by the ops review queues.
 *
 * Addresses in this system are stored as separate administrative columns
 * (`district`, `sub_county`, `parish`, `village`, `city`/`town`, `region`,
 * `landmark`, plus free-text `property_address`). Reviewers need to both
 * SEE the full address and SEARCH it, so these two helpers keep the
 * display string and the searchable string consistent everywhere.
 */

/** Human-readable address line: "Village, Parish, Sub-county, District". */
export function formatLocation(parts: (string | null | undefined)[]): string {
  const seen = new Set<string>();
  const clean: string[] = [];
  for (const p of parts) {
    const v = (p || '').trim();
    if (!v) continue;
    const key = v.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    clean.push(v);
  }
  return clean.join(', ');
}

/** Lowercased haystack for substring search across every location part. */
export function locationHaystack(parts: (string | null | undefined)[]): string {
  return parts.filter(Boolean).join(' ').toLowerCase();
}