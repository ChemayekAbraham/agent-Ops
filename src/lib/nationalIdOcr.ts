/**
 * Reading a Ugandan National ID card.
 *
 * Wraps the `read-national-id` edge function, which calls PassGate
 * `POST /v1/id/read`. The reader validates every field against its format and
 * reports an unreadable one as *missing* rather than guessing — a wrong NIN
 * that parses cannot be detected downstream, while a refusal can simply be
 * retried.
 *
 * So there are three outcomes, and the screen must branch on `status`:
 *
 *   valid       all six fields read and well-formed — prefill and let the
 *               person confirm
 *   incomplete  it IS a National ID but some fields could not be read — name
 *               them, ask for a better photo of the SAME card
 *   invalid     not a Ugandan National ID at all — ask for the right document
 *
 * `valid` means "the six fields were read and are well-formed". It does not
 * mean the card is genuine, and nothing here checks NIRA's register.
 */
import { supabase } from '@/integrations/supabase/client';

export type NationalIdStatus = 'valid' | 'incomplete' | 'invalid';

/** The six fields printed on the card. */
export interface NationalIdData {
  surname: string;
  given_name: string;
  nin: string;
  /** ISO `YYYY-MM-DD`, already parsed by the reader. Never re-parse as DD.MM.YYYY. */
  date_of_birth: string;
  card_number: string;
  /** `M` or `F`. */
  sex: string;
}

export interface NationalIdFieldVerdict {
  valid: boolean;
  confidence: number | null;
  note: string | null;
}

export interface NationalIdReading {
  status: NationalIdStatus;
  is_national_id: boolean;
  /** The LOWEST required-field confidence, not an average. */
  confidence: number | null;
  sha256: string | null;
  full_name: string;
  data: NationalIdData;
  fields: Record<string, NationalIdFieldVerdict>;
  /** Names of the required fields that could not be read. */
  missing: string[];
  /** Cross-checks that FAILED — a reason for a human to look, never proof of forgery. */
  consistency: { id: string; detail: string }[];
  message: string | null;
  account_name: string;
  account_national_id: string | null;
  name_match_score: number | null;
}

export const EMPTY_ID_DATA: NationalIdData = {
  surname: '', given_name: '', nin: '', date_of_birth: '', card_number: '', sex: '',
};

/** What each field is called on screen. */
export const ID_FIELD_LABEL: Record<keyof NationalIdData, string> = {
  surname: 'Surname',
  given_name: 'Given name',
  nin: 'NIN',
  date_of_birth: 'Date of birth',
  card_number: 'Card number',
  sex: 'Sex',
};

async function fileToBase64(file: File): Promise<string> {
  return await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(new Error('Could not read that photo.'));
    reader.readAsDataURL(file);
  });
}

/**
 * Reads one National ID photo.
 * Never throws: a failure returns `{ error }` so the person can still type
 * their details by hand.
 */
export async function readNationalIdPhoto(file: File): Promise<NationalIdReading | { error: string }> {
  try {
    const imageBase64 = await fileToBase64(file);
    const { data, error } = await supabase.functions.invoke('read-national-id', {
      body: { imageBase64 },
    });
    if (error) return { error: 'Could not read that photo automatically.' };
    if (data && typeof data === 'object' && 'error' in data && (data as { error?: string }).error) {
      return { error: String((data as { error: string }).error) };
    }
    return data as NationalIdReading;
  } catch {
    return { error: 'Could not read that photo automatically.' };
  }
}

/** Plain-language verdict on how well the ID name matches the account name. */
export function idNameVerdict(score: number | null): 'match' | 'partial' | 'mismatch' | 'unknown' {
  if (score == null) return 'unknown';
  if (score >= 0.8) return 'match';
  if (score >= 0.5) return 'partial';
  return 'mismatch';
}

/** One sentence telling the person what to do about this reading. */
export function readingGuidance(r: NationalIdReading): string | null {
  if (r.status === 'invalid') {
    return 'That photo is not a Ugandan National ID card. Take a photo of the front of your National ID.';
  }
  if (r.status === 'incomplete') {
    const names = r.missing.map((m) => ID_FIELD_LABEL[m as keyof NationalIdData] ?? m);
    const list = names.length ? names.join(', ') : 'some details';
    return `We could not read ${list} on this card. Retake the photo of the same card in better light, or type ${
      names.length === 1 ? 'it' : 'them'
    } in yourself.`;
  }
  return null;
}
