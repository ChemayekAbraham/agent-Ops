/**
 * Client-side mirrors of the database's double-submission comparison, used only
 * to *explain* on screen why a case was grouped under Double submissions.
 * The grouping itself is decided in the database (identity_double_submission).
 *
 * normalizeNationalIdFuzzy mirrors public.normalize_national_id_fuzzy:
 * strip everything that is not a letter or digit, upper-case, then fold the
 * characters people and OCR confuse: O->0, I->1, L->1, S->5, B->8, Z->2.
 */
const CONFUSABLES: Record<string, string> = {
  O: '0',
  I: '1',
  L: '1',
  S: '5',
  B: '8',
  Z: '2',
};

export function normalizeNationalIdFuzzy(value: string | null | undefined): string {
  const cleaned = (value ?? '').replace(/[^A-Za-z0-9]/g, '').toUpperCase();
  return cleaned.replace(/[OILSBZ]/g, (c) => CONFUSABLES[c] ?? c);
}

/** Last 9 digits of a phone number — how the database compares numbers. */
export function phoneLastNine(value: string | null | undefined): string {
  const digits = (value ?? '').replace(/[^0-9]/g, '');
  return digits.slice(-9);
}

/** Characters that were folded, so the screen can name them ("O read as 0"). */
export function foldedCharacters(value: string | null | undefined): string[] {
  const cleaned = (value ?? '').replace(/[^A-Za-z0-9]/g, '').toUpperCase();
  const seen = new Set<string>();
  const out: string[] = [];
  for (const c of cleaned) {
    if (CONFUSABLES[c] && !seen.has(c)) {
      seen.add(c);
      out.push(`${c} read as ${CONFUSABLES[c]}`);
    }
  }
  return out;
}
