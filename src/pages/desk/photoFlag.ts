import { deskWords } from './sendBackItems';

/** The Tenant Ops face-photo check (the catalogue's code). */
export const FACE_PHOTO_CHECK = 'to_passport_is_tenant';

/**
 * E124: when the system's detail on the face-photo check carries "FLAG:", the
 * flag in the desks' words ("FLAG: the tenant photo is the agent's own
 * profile photo"); null otherwise.
 */
export function facePhotoFlag(items: { code: string; system_detail?: string | null; system_said?: string | null }[]): string | null {
  const c = items.find((i) => i.code === FACE_PHOTO_CHECK);
  const text = [c?.system_detail, c?.system_said].find((t) => typeof t === 'string' && t.includes('FLAG:'));
  if (!text) return null;
  return deskWords(text.slice(text.indexOf('FLAG:')).trim());
}
