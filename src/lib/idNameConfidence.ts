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
