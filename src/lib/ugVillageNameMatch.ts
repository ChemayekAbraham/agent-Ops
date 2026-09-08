/**
 * Bulk name → official village matcher for imports.
 *
 * Spreadsheet imports type village names by hand, so they cannot use the
 * interactive picker. This helper attaches the approved dataset link where the
 * typed name resolves to exactly ONE official village, in a SINGLE round trip
 * (no per-row lookups). Ambiguous or unknown names are left as plain text —
 * we never guess, and legacy text is never rewritten to the wrong place.
 */
import { supabase } from '@/integrations/supabase/client';

export interface UgVillageMatch {
  villageId: number;
  village: string;
  parish: string | null;
  subcounty: string | null;
  county: string | null;
  district: string | null;
  region: string | null;
}

/** Same normalisation shape the dataset uses: trimmed, collapsed, lowercase. */
export const normalizeVillageName = (s: string) =>
  s.trim().toLowerCase().replace(/\s+/g, ' ');

/**
 * @returns map keyed by normalised name. Value is the single match, or null
 *          when the name is unknown or matches more than one village.
 */
export async function matchUgVillagesByName(
  names: string[],
): Promise<Map<string, UgVillageMatch | null>> {
  const out = new Map<string, UgVillageMatch | null>();
  const wanted = Array.from(
    new Set(names.map((n) => n.trim()).filter((n) => n.length > 0)),
  );
  if (wanted.length === 0) return out;

  const { data, error } = await supabase
    .from('ug_villages')
    .select(
      'id, name, parish:ug_parishes(name, subcounty:ug_subcounties(name, county:ug_counties(name, district:ug_districts(name, region))))',
    )
    .in('name', wanted);

  if (error) throw error;

  const seen = new Map<string, UgVillageMatch | null>();
  for (const row of (data ?? []) as any[]) {
    const key = normalizeVillageName(String(row.name ?? ''));
    if (seen.has(key)) {
      seen.set(key, null); // ambiguous — more than one official village
      continue;
    }
    const parish = row.parish ?? null;
    const subcounty = parish?.subcounty ?? null;
    const county = subcounty?.county ?? null;
    const district = county?.district ?? null;
    seen.set(key, {
      villageId: row.id as number,
      village: String(row.name),
      parish: parish?.name ?? null,
      subcounty: subcounty?.name ?? null,
      county: county?.name ?? null,
      district: district?.name ?? null,
      region: district?.region ?? null,
    });
  }

  for (const n of wanted) {
    const key = normalizeVillageName(n);
    out.set(key, seen.get(key) ?? null);
  }
  return out;
}
