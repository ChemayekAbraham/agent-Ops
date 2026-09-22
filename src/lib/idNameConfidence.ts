/**
 * Confidence check for a name read off a National ID photo.
 *
 * The account name is only ever replaced by an ID name we are confident about.
 * Anything doubtful is flagged for Financial Ops instead of silently
 * overwriting a real person's name with OCR noise.
 */

export type IdNameConfidence = {
  /** True only when the read name is safe to use as the account name. */
  confident: boolean;
  /** Plain-language reason shown to Financial Ops when not confident. */
  reason: string | null;
};

/** Words printed on Ugandan ID cards that are never part of a person's name. */
const CARD_LABEL_WORDS = new Set([
  'republic',
  'uganda',
  'ugandan',
  'national',
  'identity',
  'identification',
  'card',
  'nin',
  'surname',
  'given',
  'names',
  'name',
  'nationality',
  'sex',
  'male',
  'female',
  'date',
  'birth',
  'dob',
  'expiry',
  'issue',
  'signature',
  'holder',
  'specimen',
  'sample',
  'unknown',
  'null',
  'none',
]);

const VOWELS = /[aeiouAEIOU]/;

/** Classic edit distance — small and dependency-free, only ever called on short tokens. */
function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  const prev = new Array(n + 1);
  const curr = new Array(n + 1);
  for (let j = 0; j <= n; j += 1) prev[j] = j;
  for (let i = 1; i <= m; i += 1) {
    curr[0] = i;
    for (let j = 1; j <= n; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(curr[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
    }
    for (let j = 0; j <= n; j += 1) prev[j] = curr[j];
  }
  return prev[n];
}

/**
 * True when a token is a close OCR corruption of a card-label word, not just
 * an exact match — e.g. "STHERNAME" is a fusion of "SURNAME" and "OTHER
 * NAME(S)" (the two adjacent field labels on a Ugandan National ID), close
 * enough in edit distance to either that it is almost certainly a misread
 * label rather than a real name. Exact CARD_LABEL_WORDS membership already
 * catches the clean case; this catches the mangled one.
 */
function looksLikeCardLabel(token: string): boolean {
  const t = token.toLowerCase();
  if (t.length < 5) return false;
  for (const label of CARD_LABEL_WORDS) {
    if (label.length < 5) continue;
    if (t.includes(label) || label.includes(t)) return true;
    const maxDist = label.length <= 6 ? 2 : 3;
    if (levenshtein(t, label) <= maxDist) return true;
  }
  return false;
}

function tokens(name: string): string[] {
  return name
    .replace(/[.,'’\-]/g, ' ')
    .split(/\s+/)
    .map((t) => t.trim())
    .filter(Boolean);
}

/**
 * Judge whether an OCR-read National ID name can be trusted enough to become
 * the account name. Deliberately strict: when in doubt we flag, never replace.
 */
export function assessIdNameConfidence(rawIdName: string | null | undefined): IdNameConfidence {
  const name = String(rawIdName ?? '').trim();

  if (name.length === 0) {
    return { confident: false, reason: 'No name could be read on the ID photo.' };
  }
  if (name.length < 5) {
    return { confident: false, reason: 'Only a few letters could be read, not a full name.' };
  }
  if (name.length > 70) {
    return { confident: false, reason: 'The text read from the ID is too long to be a name.' };
  }
  if (/\d/.test(name)) {
    return { confident: false, reason: 'The text read from the ID contains numbers, so it is not a clean name.' };
  }
  if (!/^[A-Za-z\s.,'’\-]+$/.test(name)) {
    return { confident: false, reason: 'The text read from the ID contains stray marks, so it is not a clean name.' };
  }

  const parts = tokens(name);
  if (parts.length < 2) {
    return { confident: false, reason: 'Only one name could be read — a first and last name are needed.' };
  }
  if (parts.length > 5) {
    return { confident: false, reason: 'Too many words were read from the ID to be a single person\u2019s name.' };
  }

  const usable = parts.filter((p) => p.length >= 2);
  if (usable.length < 2) {
    return { confident: false, reason: 'The words read from the ID are too short to be a name.' };
  }

  const labelHit = parts.find((p) => CARD_LABEL_WORDS.has(p.toLowerCase()));
  if (labelHit) {
    return {
      confident: false,
      reason: `Wording from the card itself ("${labelHit}") was read instead of the person\u2019s name.`,
    };
  }

  // A near-miss OCR corruption of a card label (e.g. "STHERNAME", a fusion of
  // the adjacent "SURNAME" / "OTHER NAME(S)" field labels) is just as much a
  // misread as an exact match \u2014 checked separately from the exact-match
  // labelHit above so a real name that merely resembles a label ("Nakato" is
  // not close to any of these) never gets flagged.
  const fuzzyLabelHit = parts.find((p) => looksLikeCardLabel(p));
  if (fuzzyLabelHit) {
    return {
      confident: false,
      reason: `"${fuzzyLabelHit}" looks like a garbled reading of wording printed on the card itself, not a person\u2019s name.`,
    };
  }

  const noVowel = usable.find((p) => !VOWELS.test(p));
  if (noVowel) {
    return { confident: false, reason: 'The letters read from the ID do not form a readable name.' };
  }

  const repeated = usable.find((p) => /(.)\1{2,}/.test(p));
  if (repeated) {
    return { confident: false, reason: 'The letters read from the ID look like a smudged photo, not a name.' };
  }

  return { confident: true, reason: null };
}
