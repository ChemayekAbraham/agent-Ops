/**
 * Shared area (district / sub-county / village) matching for house listings.
 *
 * The marketplace filter controls are dataset-backed (ug_districts →
 * ug_subcounties → villages), but the listings themselves were captured over a
 * long period: most rows still carry free-typed text ("LUWEERO", "kampala")
 * and only newer rows carry the official `ug_village_id`. Matching must
 * therefore be:
 *
 *  1. id-based when the listing has been upgraded (ug_village_id), and
 *  2. case/format-insensitive text matching otherwise,
 *
 * so no house disappears from results during the migration phase.
 *
 * IMPORTANT: the list query, the map query and the exact `count: 'exact'`
 * counters all go through the SAME builder here — that is what keeps the list
 * count, the map count and the parity tests in agreement.
 */

export interface ListingAreaSelection {
  district?: string | null;
  /** Official ug_districts id, when the control had one. */
  districtId?: number | null;
  subCounty?: string | null;
  subCountyId?: number | null;
  village?: string | null;
  /** Official ug_villages id — matched directly against house_listings.ug_village_id. */
  villageId?: number | null;
}

/** Strip characters that would break a PostgREST `or=(...)` list. Values are
 *  double-quoted in the clause, so spaces are safe once commas/quotes are gone. */
const safe = (s: string) => s.replace(/[,()*"']/g, ' ').replace(/\s+/g, ' ').trim();

/** Normalise an area name for text comparison (case, spacing, level suffix). */
export function normalizeAreaName(value?: string | null): string {
  return (value ?? '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/\s+(district|county|sub[- ]?county|subcounty|division|parish|village|cell|zone)$/, '')
    .trim();
}

const isSet = (v?: string | null) => !!v && v !== 'all' && v.trim().length > 0;

/**
 * The `or=(...)` clauses for the active area selection. One entry per level,
 * each applied as its own `.or()` so PostgREST ANDs the levels together.
 */
export function buildAreaOrClauses(sel: ListingAreaSelection): string[] {
  const clauses: string[] = [];

  if (isSet(sel.district)) {
    const n = safe(sel.district!);
    clauses.push([`district.ilike."${n}"`, `district.ilike."${n} District"`].join(','));
  }

  if (isSet(sel.subCounty)) {
    const n = safe(sel.subCounty!);
    clauses.push(
      [
        `sub_county.ilike."${n}"`,
        `sub_county.ilike."${n} Sub County"`,
        `sub_county.ilike."${n} Subcounty"`,
        `sub_county.ilike."${n} Division"`,
      ].join(','),
    );
  }

  if (isSet(sel.village) || sel.villageId != null) {
    const parts: string[] = [];
    // Upgraded listings: match the stored official village id directly.
    if (sel.villageId != null) parts.push(`ug_village_id.eq.${sel.villageId}`);
    // Legacy listings: fall back to case-insensitive name matching.
    if (isSet(sel.village)) parts.push(`village.ilike."${safe(sel.village!)}"`);
    if (parts.length) clauses.push(parts.join(','));
  }

  return clauses;
}

/** Apply the area selection to a supabase query builder. */
export function applyAreaFilter<T extends { or: (f: string) => T }>(query: T, sel: ListingAreaSelection): T {
  let q = query;
  for (const clause of buildAreaOrClauses(sel)) q = q.or(clause);
  return q;
}

/** Client-side mirror of the server matching, for already-loaded rows. */
export function matchesArea(
  row: { district?: string | null; sub_county?: string | null; village?: string | null; ug_village_id?: number | null },
  sel: ListingAreaSelection,
): boolean {
  if (isSet(sel.district) && normalizeAreaName(row.district) !== normalizeAreaName(sel.district)) return false;
  if (isSet(sel.subCounty) && normalizeAreaName(row.sub_county) !== normalizeAreaName(sel.subCounty)) return false;
  if (isSet(sel.village) || sel.villageId != null) {
    const byId = sel.villageId != null && row.ug_village_id === sel.villageId;
    const byName = isSet(sel.village) && normalizeAreaName(row.village) === normalizeAreaName(sel.village);
    if (!byId && !byName) return false;
  }
  return true;
}
