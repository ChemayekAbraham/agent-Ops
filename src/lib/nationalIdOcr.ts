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
  /** What the reader saw even when `valid` is false (e.g. a 10-digit card
      number). Prefilled for the person to confirm rather than typed blind. */
  value: string | null;
  raw: string | null;
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
  /** Returned by the reader but not required for `valid`. */
  nationality: string | null;
  /** ISO. The reader's `card_not_expired` cross-check is date arithmetic on this. */
  date_of_expiry: string | null;
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
    return normaliseReading(data);
  } catch {
    return { error: 'Could not read that photo automatically.' };
  }
}

/**
 * Give every caller the same shape, whatever came back.
 *
 * Two things make this necessary rather than defensive padding. Edge functions
 * in this project are deployed by hand, so the browser and the function can be
 * different versions for hours - the older reader returned `id_number` and no
 * `consistency` at all, and a render that trusted the new shape crashed on it.
 * And the response crosses a network, so its shape is an assumption either way.
 *
 * Missing arrays become empty, missing fields become empty strings, and an
 * older response is mapped onto the six-field form so the person still gets a
 * prefill instead of a blank one.
 */
/**
 * Coerce a printed date to ISO `YYYY-MM-DD`.
 *
 * PassGate already returns ISO and its value passes through untouched. The
 * older reader returned the card's own spelling - `14.06.1990` - and a date
 * input silently refuses anything that is not ISO, so the field simply appeared
 * blank with no explanation. Day-first is assumed because that is how Ugandan
 * National IDs print, and a value that is not a real date is dropped rather
 * than guessed.
 */
function toIsoDate(v: string): string {
  const raw = (v || '').trim();
  if (!raw) return '';
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;

  const m = /^(\d{1,2})[.\/\- ](\d{1,2})[.\/\- ](\d{4})$/.exec(raw);
  if (!m) return '';
  const [, d, mo, y] = m;
  const day = Number(d), month = Number(mo), year = Number(y);
  if (month < 1 || month > 12 || day < 1 || day > 31) return '';
  if (year < 1900 || year > new Date().getFullYear()) return '';
  const iso = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  // Reject the impossible (31 February) rather than let the browser roll it over.
  const probe = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(probe.getTime()) || probe.getUTCDate() !== day) return '';
  return iso;
}

export function normaliseReading(raw: unknown): NationalIdReading {
  const r = (raw ?? {}) as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '');
  const num = (v: unknown) => (typeof v === 'number' ? v : null);

  const rawData = (r.data ?? {}) as Record<string, unknown>;
  const data: NationalIdData = {
    // `id_number` / `given_names` are the older reader's spelling.
    surname: str(rawData.surname) || str(r.surname),
    given_name: str(rawData.given_name) || str(r.given_names) || str(r.given_name),
    nin: (str(rawData.nin) || str(r.id_number)).toUpperCase(),
    date_of_birth: toIsoDate(str(rawData.date_of_birth) || str(r.date_of_birth)),
    card_number: str(rawData.card_number),
    sex: str(rawData.sex).toUpperCase(),
  };

  const fields: Record<string, NationalIdFieldVerdict> = {};
  const rawFields = (r.fields ?? {}) as Record<string, Record<string, unknown>>;
  for (const [key, f] of Object.entries(rawFields)) {
    if (!f || typeof f !== 'object') continue;
    fields[key] = {
      valid: f.valid === true,
      confidence: num(f.confidence),
      note: typeof f.note === 'string' ? f.note : null,
    };
  }
  // No per-field verdicts (older reader): treat a value that came back as read.
  if (Object.keys(fields).length === 0) {
    for (const [key, value] of Object.entries(data)) {
      fields[key] = { valid: !!value, confidence: null, note: null };
    }
  }

  const missing = Array.isArray(r.missing)
    ? (r.missing as unknown[]).map(str).filter(Boolean)
    : (Object.keys(data) as (keyof NationalIdData)[]).filter((k) => !data[k]);

  const consistency = Array.isArray(r.consistency)
    ? (r.consistency as Record<string, unknown>[])
        .filter((c) => c && typeof c === 'object')
        .map((c) => ({ id: str(c.id), detail: str(c.detail) }))
    : [];

  const isNationalId = r.is_national_id !== false;
  const status: NationalIdStatus =
    r.status === 'valid' || r.status === 'incomplete' || r.status === 'invalid'
      ? r.status
      : !isNationalId
        ? 'invalid'
        : missing.length === 0
          ? 'valid'
          : 'incomplete';

  return {
    status,
    is_national_id: isNationalId,
    confidence: num(r.confidence),
    sha256: str(r.sha256) || null,
    full_name: str(r.full_name) || [data.given_name, data.surname].filter(Boolean).join(' '),
    data,
    fields,
    missing,
    consistency,
    message: str(r.message) || null,
    nationality: str(rawData.nationality) || str(r.nationality) || null,
    date_of_expiry: toIsoDate(str(rawData.date_of_expiry) || str(r.date_of_expiry)) || null,
    account_name: str(r.account_name),
    account_national_id: str(r.account_national_id) || null,
    name_match_score: num(r.name_match_score),
  };
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
  if (r.status === 'incomplete' && r.missing.length >= 5) {
    return 'Almost nothing could be read on that card. Hold it upright (landscape), fill the frame, and keep it square to the camera.';
  }
  if (r.status === 'incomplete') {
    const names = (r.missing ?? []).map((m) => ID_FIELD_LABEL[m as keyof NationalIdData] ?? m);
    const list = names.length ? names.join(', ') : 'some details';
    return `We could not read ${list} on this card. Retake the photo of the same card in better light, or type ${
      names.length === 1 ? 'it' : 'them'
    } in yourself.`;
  }
  return null;
}
