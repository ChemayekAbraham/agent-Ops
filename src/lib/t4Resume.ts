import { clearFormPhotos, loadFormPhotos, saveFormPhotos } from '@/lib/formPhotoDraft';
import type { FunnelForm } from '@/lib/formFunnel';
import type { T4Request } from '@/lib/t4RentRequest';

/**
 * The T4 chat kept across an app update (appUpdate.ts): what opened it, every answer, the step
 * it was on, and its photos. Answers go to localStorage; new photos (files) to IndexedDB, and
 * photos already on the server (a URL only) with the answers. After the reload,
 * T4RentRequestHost reopens the chat with `resume: true` and the chat puts it all back.
 */

export const T4_RESUME_KEY = 'welile_t4_update_resume';
/** A kept chat older than this is not reopened (the agent has moved on). */
export const T4_RESUME_MAX_AGE_MS = 30 * 60 * 1000;

type PhotoLike = { file: File | null; preview: string } | null;

export interface T4ResumePhotos<T = PhotoLike> {
  house: T[];
  tenantPhoto: T;
  idFront: T;
  idBack: T;
  lcLetter: T;
}

export interface T4ResumeRecord {
  userId: string;
  at: number;
  /** What opened the chat, without its callbacks. */
  request: T4Request;
  /** The funnel's form and session, so the chat logs on in the same session. */
  form: FunnelForm;
  session: string;
  /** Every answer and the step, as the chat wrote them. */
  state: Record<string, unknown>;
  /** Photos stored on the server already (URL only), by slot; new photos are in IndexedDB. */
  photoUrls: T4ResumePhotos<string | null>;
}

const photoKey = (userId: string) => `${T4_RESUME_KEY}:${userId}`;

/** What opened the chat, as plain data: no callbacks, and a saved draft's photos are in the snapshot. */
export function plainRequest(req: T4Request | null | undefined): T4Request {
  if (!req) return { mode: 'new' };
  const { onDone, ...rest } = req as T4Request & { key?: number };
  delete (rest as { key?: number }).key;
  if (rest.mode === 'new' && rest.draft) {
    // The draft's answers and photos are in the snapshot; its id goes in the state.
    const { draft, ...plain } = rest;
    return JSON.parse(JSON.stringify({ ...plain, entry: 'app_update' }));
  }
  return JSON.parse(JSON.stringify({ ...rest, entry: 'app_update' }));
}

const fileOf = (p: PhotoLike) => p?.file ?? null;
const urlOf = (p: PhotoLike) => (p && !p.file && p.preview && !p.preview.startsWith('blob:') ? p.preview : null);

/** Keeps the chat. True when it is kept (answers and photos); false when it could not be. */
export async function saveT4Resume(input: {
  userId: string;
  request: T4Request | null | undefined;
  form: FunnelForm;
  session: string;
  state: Record<string, unknown>;
  photos: T4ResumePhotos;
  now?: number;
}): Promise<boolean> {
  const record: T4ResumeRecord = {
    userId: input.userId,
    at: input.now ?? Date.now(),
    request: plainRequest(input.request),
    form: input.form,
    session: input.session,
    state: JSON.parse(JSON.stringify(input.state)),
    photoUrls: {
      house: input.photos.house.map(urlOf),
      tenantPhoto: urlOf(input.photos.tenantPhoto),
      idFront: urlOf(input.photos.idFront),
      idBack: urlOf(input.photos.idBack),
      lcLetter: urlOf(input.photos.lcLetter),
    },
  };
  const files: T4ResumePhotos<File | null> = {
    house: input.photos.house.map(fileOf),
    tenantPhoto: fileOf(input.photos.tenantPhoto),
    idFront: fileOf(input.photos.idFront),
    idBack: fileOf(input.photos.idBack),
    lcLetter: fileOf(input.photos.lcLetter),
  };
  const hasFiles = files.house.some(Boolean) || !!(files.tenantPhoto || files.idFront || files.idBack || files.lcLetter);
  try {
    localStorage.setItem(T4_RESUME_KEY, JSON.stringify(record));
  } catch {
    return false;
  }
  if (hasFiles) {
    await saveFormPhotos(photoKey(input.userId), files);
    // A phone that cannot keep the photos keeps the chat on this build instead of losing them.
    const back = await loadFormPhotos<T4ResumePhotos<File | null>>(photoKey(input.userId));
    if (!back) { clearT4Resume(input.userId); return false; }
  }
  return true;
}

/** The kept chat for this agent, if there is a fresh one. */
export function readT4Resume(userId: string | null | undefined, now = Date.now()): T4ResumeRecord | null {
  if (!userId) return null;
  try {
    const r = JSON.parse(localStorage.getItem(T4_RESUME_KEY) ?? 'null') as T4ResumeRecord | null;
    if (!r || r.userId !== userId || !r.request || now - Number(r.at) > T4_RESUME_MAX_AGE_MS) return null;
    return r;
  } catch {
    return null;
  }
}

/** The kept photos as files (null slots when none). */
export async function loadT4ResumePhotos(userId: string): Promise<T4ResumePhotos<File | null> | null> {
  return loadFormPhotos<T4ResumePhotos<File | null>>(photoKey(userId));
}

export function clearT4Resume(userId?: string | null): void {
  try { localStorage.removeItem(T4_RESUME_KEY); } catch { /* ignore */ }
  if (userId) void clearFormPhotos(photoKey(userId));
}

/** What T4RentRequestHost opens after the reload, or null. */
export function resumeRequestFor(userId: string | null | undefined, now = Date.now()): T4Request | null {
  const r = readT4Resume(userId, now);
  return r ? ({ ...r.request, resume: true } as T4Request) : null;
}
