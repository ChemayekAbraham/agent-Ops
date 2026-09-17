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

  const fields: Record<string, NationalIdFieldVerdict> = {};
  const rawFields = (r.fields ?? {}) as Record<string, Record<string, unknown>>;
  for (const [key, f] of Object.entries(rawFields)) {
    if (!f || typeof f !== 'object') continue;
    fields[key] = {
      valid: f.valid === true,
      confidence: num(f.confidence),
      note: typeof f.note === 'string' ? f.note : null,
      value: str(f.value) || null,
      raw: str(f.raw) || null,
    };
  }

  /* A field the reader refused (wrong length, odd characters) is left out of
     `data`, but the reader still reports what it saw under `fields`. Prefill
     that too — the person confirms or corrects it instead of typing blind.
     Field-specific cleaning matches what the input itself enforces. */
  const saw = (key: keyof NationalIdData): string => {
    const v = fields[key]?.value ?? fields[key]?.raw ?? '';
    if (!v) return '';
    if (key === 'card_number') return v.toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (key === 'sex') return v.toUpperCase().replace(/[^MF]/g, '');
    if (key === 'nin') return v.toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (key === 'date_of_birth') return toIsoDate(v);
    return v.toUpperCase();
  };

  const rawData = (r.data ?? {}) as Record<string, unknown>;
  const data: NationalIdData = {
    // `id_number` / `given_names` are the older reader's spelling.
    surname: str(rawData.surname) || str(r.surname) || saw('surname'),
    given_name: str(rawData.given_name) || str(r.given_names) || str(r.given_name) || saw('given_name'),
    nin: (str(rawData.nin) || str(r.id_number) || saw('nin')).toUpperCase(),
    date_of_birth: toIsoDate(str(rawData.date_of_birth) || str(r.date_of_birth)) || saw('date_of_birth'),
    card_number: str(rawData.card_number) || saw('card_number'),
    sex: str(rawData.sex).toUpperCase() || saw('sex'),
  };

  // No per-field verdicts (older reader): treat a value that came back as read.
  if (Object.keys(fields).length === 0) {
    for (const [key, value] of Object.entries(data)) {
      fields[key] = { valid: !!value, confidence: null, note: null, value: value || null, raw: null };
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

/* ------------------------------------------------------------------ *
 * Orientation — an upside-down or sideways card
 *
 * A card photographed the wrong way up reads as "not a National ID" or as a
 * card with almost nothing on it, and the person is told to retake a photo that
 * was in fact perfectly sharp. So every poor reading is retried on a rotated
 * copy of the same photo, and when a rotation reads better we keep the
 * straightened copy AND say what was wrong, so the next photo is taken right.
 * ------------------------------------------------------------------ */

export type IdRotation = 0 | 90 | 180 | 270;

export function isSidewaysIdRotation(rotation: IdRotation): boolean {
  return rotation === 90 || rotation === 270;
}

export type IdPhotoOrientation = 'landscape' | 'sideways' | 'unreadable';

/**
 * A National ID is a landscape card. A portrait image means the phone/card was
 * turned 90° or -90°, which makes the small fields much less reliable.
 */
export function classifyIdPhotoOrientation(width: number, height: number): IdPhotoOrientation {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return 'unreadable';
  }
  return width > height ? 'landscape' : 'sideways';
}

/** Reads the decoded dimensions before any OCR call or upload. */
export async function inspectIdPhotoOrientation(file: File): Promise<IdPhotoOrientation> {
  const url = URL.createObjectURL(file);
  try {
    const dimensions = await new Promise<{ width: number; height: number }>((resolve, reject) => {
      const image = new Image();
      image.onload = () => resolve({ width: image.naturalWidth, height: image.naturalHeight });
      image.onerror = () => reject(new Error('Could not open that photo.'));
      image.src = url;
    });
    return classifyIdPhotoOrientation(dimensions.width, dimensions.height);
  } catch {
    return 'unreadable';
  } finally {
    URL.revokeObjectURL(url);
  }
}

export const SIDEWAYS_ID_MESSAGE =
  'This ID photo is sideways. Turn the phone so the photo is wide, keep the card straight, and retake it.';

/** How to hold the card, in the order that fixes the most photos. */
export const ID_POSITION_TIPS: string[] = [
  'Hold the phone upright — no need to turn it sideways.',
  'Lay the card flat and line it up inside the box on screen; it captures on its own once the edges are found.',
  'Keep the writing the right way up. An upside-down photo can be corrected.',
  'Keep the photo of the face on the LEFT of the card.',
  'Fill the box with the card and keep all four corners inside it.',
  'Keep the phone flat above the card, not tilted, and avoid shine from lights.',
];

/** Turns one photo by a quarter, half or three-quarter turn. */
export async function rotateImageFile(file: File, degrees: IdRotation): Promise<File> {
  if (degrees === 0) return file;
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = () => reject(new Error('Could not open that photo.'));
      el.src = url;
    });
    const swap = degrees === 90 || degrees === 270;
    const canvas = document.createElement('canvas');
    canvas.width = swap ? img.naturalHeight : img.naturalWidth;
    canvas.height = swap ? img.naturalWidth : img.naturalHeight;
    const ctx = canvas.getContext('2d');
    if (!ctx) return file;
    ctx.translate(canvas.width / 2, canvas.height / 2);
    ctx.rotate((degrees * Math.PI) / 180);
    ctx.drawImage(img, -img.naturalWidth / 2, -img.naturalHeight / 2);
    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob((b) => resolve(b), 'image/jpeg', 0.92),
    );
    if (!blob) return file;
    return new File([blob], file.name.replace(/\.[^.]+$/, '') + `-turned${degrees}.jpg`, {
      type: 'image/jpeg',
    });
  } catch {
    return file;
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** How good a reading is, so two orientations of the same photo can be compared. */
function readingScore(r: NationalIdReading): number {
  if (r.status === 'invalid') return -100;
  const valid = Object.values(r.fields ?? {}).filter((f) => f?.valid === true).length;
  const seen = (Object.keys(EMPTY_ID_DATA) as (keyof NationalIdData)[])
    .filter((k) => !!String(r.data?.[k] ?? '').trim()).length;
  return (r.status === 'valid' ? 100 : 0) + valid * 10 + seen * 2;
}

export interface OrientedIdReading {
  reading: NationalIdReading;
  /** The turn that read best — 0 when the photo was already the right way up. */
  rotation: IdRotation;
  /** The straightened copy to archive and send. Same file when rotation is 0. */
  file: File;
  /** True when the photo had to be turned to be readable. */
  corrected: boolean;
}

/**
 * Reads the front of a card, correcting an upside-down or sideways photo.
 *
 * The photo as taken is always tried first. Only a poor reading is retried
 * rotated, so a good photo costs exactly one call as before.
 */
export async function readNationalIdPhotoOriented(
  file: File,
): Promise<OrientedIdReading | { error: string }> {
  const first = await readNationalIdPhoto(file);
  if ('error' in first && first.error) return first as { error: string };
  let best: OrientedIdReading = {
    reading: first as NationalIdReading,
    rotation: 0,
    file,
    corrected: false,
  };
  if (best.reading.status === 'valid') return best;

  // Half a turn first: an upside-down card is by far the commonest mistake.
  for (const deg of [180, 270, 90] as IdRotation[]) {
    let turned: File;
    try {
      turned = await rotateImageFile(file, deg);
    } catch {
      continue;
    }
    if (turned === file) continue;
    const res = await readNationalIdPhoto(turned);
    if ('error' in res && res.error) continue;
    const reading = res as NationalIdReading;
    if (readingScore(reading) > readingScore(best.reading)) {
      best = { reading, rotation: deg, file: turned, corrected: true };
    }
    if (reading.status === 'valid') break;
  }
  return best;
}

/** What to tell the person about the way the card was lying. */
export function orientationMessage(rotation: IdRotation): string | null {
  if (rotation === 0) return null;
  if (rotation === 180) {
    return 'Your ID was upside down. We turned it the right way up and read it — check every line below. Next time hold the card with the writing the right way up.';
  }
  return 'Your ID was sideways. We turned it upright and read it — check every line below. Next time keep the card level inside the box — wide, not turned on its side.';
}

/* ------------------------------------------------------------------ *
 * The back of the card
 * ------------------------------------------------------------------ */

export const ID_BACK_TIPS: string[] = [
  'Turn the card over — the back carries the two lines of code at the bottom.',
  'Hold the phone upright and line the card up inside the box, all four corners inside it.',
  'Keep the phone flat above the card so the small print stays sharp.',
];

/** The machine-readable zone: the only self-verifying part of the back. */
export interface IdMrz {
  present: boolean;
  lines?: string[];
  /** Every check digit agreed with its own field. `null` when none were legible. */
  checksums_ok?: boolean | null;
  nin?: string | null;
  document_number?: string | null;
  date_of_birth?: string | null;
  date_of_expiry?: string | null;
  sex?: string | null;
  nationality?: string | null;
  surname?: string | null;
  given_name?: string | null;
}

/** What the back-of-card reader returns, straight from the edge function. */
export interface NationalIdBackDetails {
  is_national_id: boolean;
  side: 'back' | 'front';
  readable: boolean;
  card_number: string | null;
  card_number_agrees: boolean | null;
  date_of_issue: string | null;
  date_of_expiry: string | null;
  date_of_expiry_agrees: boolean | null;
  residence: {
    district: string | null;
    county: string | null;
    subcounty: string | null;
    parish: string | null;
    village: string | null;
  };
  other_fields: { label: string; value: string }[];
  mrz: IdMrz;
}

export interface NationalIdBackReading {
  /** The front was photographed again by mistake. */
  looksLikeFront: boolean;
  /** Everything read off the back, ready to show line by line. */
  details: { label: string; value: string }[];
  rotation: IdRotation;
  /** The straightened copy to archive. */
  file: File;
  corrected: boolean;
  /** The raw extraction, for cross-checking against the front. */
  back: NationalIdBackDetails;
}

/** One call to the back-of-card reader. */
async function invokeBackReader(
  file: File,
): Promise<NationalIdBackDetails | { error: string }> {
  try {
    const imageBase64 = await fileToBase64(file);
    const { data, error } = await supabase.functions.invoke('read-national-id-back', {
      body: { imageBase64 },
    });
    if (error) {
      return { error: 'Could not read the back of your card just now. Your photo is still saved.' };
    }
    const r = (data ?? {}) as Record<string, unknown>;
    if (typeof r.error === 'string' && r.error) return { error: r.error };
    return normaliseBackDetails(r);
  } catch {
    return { error: 'Could not read the back of your card just now. Your photo is still saved.' };
  }
}

/**
 * Normalise the edge function's JSON into the typed back-of-card shape.
 * Shared between the live-file reader and the stored-photo reviewer reader.
 */
function normaliseBackDetails(data: Record<string, unknown>): NationalIdBackDetails {
  const r = data;
  const res = (r.residence ?? {}) as Record<string, unknown>;
  const s = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : null);
  return {
    is_national_id: r.is_national_id !== false,
    side: r.side === 'front' ? 'front' : 'back',
    readable: r.readable !== false,
    card_number: s(r.card_number),
    card_number_agrees: typeof r.card_number_agrees === 'boolean' ? r.card_number_agrees : null,
    date_of_issue: s(r.date_of_issue),
    date_of_expiry: s(r.date_of_expiry),
    date_of_expiry_agrees:
      typeof r.date_of_expiry_agrees === 'boolean' ? r.date_of_expiry_agrees : null,
    residence: {
      district: s(res.district),
      county: s(res.county),
      subcounty: s(res.subcounty),
      parish: s(res.parish),
      village: s(res.village),
    },
    other_fields: Array.isArray(r.other_fields)
      ? (r.other_fields as Record<string, unknown>[])
          .map((f) => ({ label: String(f?.label ?? '').trim(), value: String(f?.value ?? '').trim() }))
          .filter((f) => f.label && f.value)
      : [],
    mrz: (r.mrz ?? { present: false }) as IdMrz,
  };
}

/** Read the back of an already-archived identity photo by its storage path.
 *  Used by reviewers so they see the same extracted details the submitter saw. */
export async function readNationalIdBackPhotoFromPath(
  storagePath: string,
): Promise<NationalIdBackDetails | { error: string }> {
  try {
    const { data, error } = await supabase.functions.invoke('read-national-id-back', {
      body: { storagePath },
    });
    if (error) {
      return { error: 'Could not read the back of the stored ID photo.' };
    }
    const r = (data ?? {}) as Record<string, unknown>;
    if (typeof r.error === 'string' && r.error) return { error: r.error };
    return normaliseBackDetails(r);
  } catch {
    return { error: 'Could not read the back of the stored ID photo.' };
  }
}

/** How much was actually extracted, so two orientations can be compared. */
function backScore(b: NationalIdBackDetails): number {
  const residence = Object.values(b.residence).filter(Boolean).length;
  return (
    (b.mrz?.present ? 60 : 0) +
    (b.mrz?.checksums_ok === true ? 30 : 0) +
    (b.card_number ? 15 : 0) +
    (b.date_of_expiry ? 10 : 0) +
    (b.date_of_issue ? 5 : 0) +
    residence * 5 +
    b.other_fields.length
  );
}

/**
 * Reads the back of the card through the dedicated back-side reader.
 *
 * The front reader (PassGate) is a front-side validator and calls a back-side
 * photo "not a National ID", so the back was never really extracted before.
 * This reads the machine-readable lines, card number, dates of issue and
 * expiry, and the place of residence, correcting an upside-down or sideways
 * photo the same way the front does.
 *
 * Nothing here refuses a submission: the back is archived for Financial Ops
 * either way, so an unreadable back is reported, never used to block the
 * person. The one exception is photographing the FRONT twice, which is caught
 * by the caller.
 */
export async function readNationalIdBackPhoto(
  file: File,
): Promise<NationalIdBackReading | { error: string }> {
  const first = await invokeBackReader(file);
  if ('error' in first) return first;

  let best = { back: first as NationalIdBackDetails, rotation: 0 as IdRotation, file, corrected: false };

  // Only a poor extraction is retried turned, so a good photo costs one call.
  const poor = () => !best.back.mrz?.present && !best.back.card_number;
  if (poor() && best.back.side !== 'front') {
    for (const deg of [180, 270, 90] as IdRotation[]) {
      let turned: File;
      try {
        turned = await rotateImageFile(file, deg);
      } catch {
        continue;
      }
      if (turned === file) continue;
      const res = await invokeBackReader(turned);
      if ('error' in res) continue;
      if (backScore(res) > backScore(best.back)) {
        best = { back: res, rotation: deg, file: turned, corrected: true };
      }
      if (best.back.mrz?.present) break;
    }
  }

  const b = best.back;
  const details: { label: string; value: string }[] = [];
  const push = (label: string, value: string | null | undefined) => {
    const v = String(value ?? '').trim();
    if (v) details.push({ label, value: v });
  };
  push('Card number', b.card_number ?? b.mrz?.document_number);
  push('NIN', b.mrz?.nin);
  push('Date of issue', b.date_of_issue);
  push('Date of expiry', b.date_of_expiry);
  push('Date of birth', b.mrz?.date_of_birth);
  push('Sex', b.mrz?.sex);
  push('Nationality', b.mrz?.nationality);
  push('Village', b.residence.village);
  push('Parish', b.residence.parish);
  push('Subcounty', b.residence.subcounty);
  push('County', b.residence.county);
  push('District', b.residence.district);
  for (const f of b.other_fields) push(f.label, f.value);

  return {
    looksLikeFront: b.side === 'front',
    details,
    rotation: best.rotation,
    file: best.file,
    corrected: best.corrected,
    back: b,
  };
}
