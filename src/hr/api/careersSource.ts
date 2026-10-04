/**
 * Single source of truth for reading job_applications.source.
 *
 * The public careers form writes source as:
 *   'welile.com/careers'                      - the general form, no campaign
 *   'welile.com/careers?c=' + public_slug      - a campaign link
 * Rows migrated by hand in August 2026 carry a suffixed variant of the base
 * string and are reported as 'Legacy'.
 *
 * Nothing here hardcodes a campaign slug. The slug is parsed out of the stored
 * value, so a new posting appears on HR screens with no code change. A gate that
 * defaulted to a hardcoded 'sales' slug closed all professional intake from
 * 17 to 26 August 2026; that is the failure this file exists to avoid repeating.
 *
 * Known duplication, recorded rather than fixed: src/hr/api/recruitment.ts also
 * builds and strips this prefix inline (two occurrences), and
 * src/hr/components/RecruitmentHub.tsx renders the campaign href inline. Those
 * are owed a follow-up that routes them through the constants below. Do not add
 * a further copy anywhere.
 */

export const CAREERS_BASE = 'welile.com/careers';
export const CAREERS_CAMPAIGN_PREFIX = 'welile.com/careers?c=';

/** Sentinel for the "no filter applied" option. Not a stored value. */
export const SEGMENT_ALL = '__all__';

export type CareersSegmentKind = 'campaign' | 'general' | 'legacy' | 'unknown';

export type CareersSegment = {
  kind: CareersSegmentKind;
  /** The campaign public_slug, or null for every other kind. */
  slug: string | null;
  /** Stable value for filter state. Never displayed. */
  key: string;
  /** Human-readable label for a table cell or a filter option. */
  label: string;
};

const UNKNOWN: CareersSegment = {
  kind: 'unknown',
  slug: null,
  key: 'unknown',
  label: 'Unknown',
};

const GENERAL: CareersSegment = {
  kind: 'general',
  slug: null,
  key: 'general',
  label: 'General',
};

const LEGACY: CareersSegment = {
  kind: 'legacy',
  slug: null,
  key: 'legacy',
  label: 'Legacy',
};

/**
 * Classify one stored source value. Never throws; an unrecognised or absent
 * value is reported as Unknown rather than dropped, so a row is always visible
 * somewhere.
 */
export function segmentOfSource(source: string | null | undefined): CareersSegment {
  const raw = (source ?? '').trim();
  if (raw === '') return UNKNOWN;

  if (raw.startsWith(CAREERS_CAMPAIGN_PREFIX)) {
    const slug = raw.slice(CAREERS_CAMPAIGN_PREFIX.length).trim();
    if (slug === '') return UNKNOWN;
    return {
      kind: 'campaign',
      slug,
      key: `campaign:${slug}`,
      label: `Campaign: ${slug}`,
    };
  }

  if (raw === CAREERS_BASE) return GENERAL;
  if (raw.startsWith(CAREERS_BASE)) return LEGACY;

  return UNKNOWN;
}

/** Stable filter key for one stored source value. */
export function segmentKeyOfSource(source: string | null | undefined): string {
  return segmentOfSource(source).key;
}

/** Display label for one stored source value. */
export function segmentLabelOfSource(source: string | null | undefined): string {
  return segmentOfSource(source).label;
}

const KIND_ORDER: Record<CareersSegmentKind, number> = {
  campaign: 0,
  general: 1,
  legacy: 2,
  unknown: 3,
};

function kindOfKey(key: string): CareersSegmentKind {
  if (key.startsWith('campaign:')) return 'campaign';
  if (key === 'general' || key === 'legacy' || key === 'unknown') return key;
  return 'unknown';
}

/**
 * Build the filter option list from the source values actually present in the
 * fetched rows. Deliberately derived from the data and not written in code, so a
 * segment nobody anticipated appears rather than vanishing. Does not include the
 * SEGMENT_ALL option; the caller prepends that.
 */
export function segmentOptionsFrom(
  sources: (string | null | undefined)[],
): { value: string; label: string }[] {
  const seen = new Map<string, string>();
  for (const s of sources) {
    const seg = segmentOfSource(s);
    if (!seen.has(seg.key)) seen.set(seg.key, seg.label);
  }
  return Array.from(seen.entries())
    .map(([value, label]) => ({ value, label }))
    .sort((a, b) => {
      const d = KIND_ORDER[kindOfKey(a.value)] - KIND_ORDER[kindOfKey(b.value)];
      return d !== 0 ? d : a.label.localeCompare(b.label);
    });
}
