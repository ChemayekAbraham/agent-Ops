import { del, get, set } from 'idb-keyval';

/**
 * Photos taken while filling a long form (tenant rent request, agent rent
 * request), kept on this device until the form is sent or closed.
 *
 * Why: opening the phone's camera app sends the browser to the background,
 * and Android often discards the page and reloads it when the camera returns.
 * Without this the form restarts at step 1 with no photos (doc 276).
 * IndexedDB stores File/Blob as-is; localStorage cannot hold them.
 * Every call swallows errors: a private window or full disk must never stop
 * someone from filling the form, it only means nothing is kept.
 */
const k = (key: string) => `form-photos:${key}`;

export async function loadFormPhotos<T>(key: string): Promise<T | null> {
  try {
    return ((await get(k(key))) as T | undefined) ?? null;
  } catch {
    return null;
  }
}

export async function saveFormPhotos(key: string, value: unknown): Promise<void> {
  try {
    await set(k(key), value);
  } catch { /* nothing kept; the form still works */ }
}

export async function clearFormPhotos(key: string): Promise<void> {
  try {
    await del(k(key));
  } catch { /* ignore */ }
}

/** A restored File gets a fresh preview URL (the old one died with the page). */
export function previewOf(file: File | Blob | null | undefined): { file: File; preview: string } | null {
  if (!file) return null;
  const f = file instanceof File ? file : new File([file], 'photo.jpg', { type: file.type || 'image/jpeg' });
  return { file: f, preview: URL.createObjectURL(f) };
}

/** Holds the agent's user id while they have a new rent request open; T4RentRequestHost reopens the form after a reload. */
export const AGENT_RENT_REQUEST_REOPEN_FLAG = 'welile_agent_rent_request_open';
