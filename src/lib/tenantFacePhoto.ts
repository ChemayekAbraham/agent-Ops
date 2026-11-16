/**
 * The tenant's face photo in the agent's post and resubmit chats: one name, what a return
 * reason points at, and plain words for a refused photo. Pure; no Supabase import.
 */

/** The one name for the photo, everywhere in the post and resubmit chats. */
export const TENANT_FACE_PHOTO = 'Tenant’s face photo (head and shoulders)';

/** The face check gives up after this long; the agent can continue and the office checks it. */
export const FACE_CHECK_TIMEOUT_MS = 15_000;

/** Said when the face check did not answer in time or the phone is offline. */
export const FACE_CHECK_SLOW_MESSAGE = 'Couldn’t check the face — slow network. You can continue; the office will check it.';

/** The items a return reason or a desk's failed check can point at, in the order they are asked. */
export const REASON_ITEMS = [
  'rent', 'landlord', 'photos', 'tenantPhoto', 'idFront', 'idBack', 'gps', 'lcLetter', 'familySize', 'work',
] as const;
export type ReasonItem = typeof REASON_ITEMS[number];

const HOUSE_PHOTO = /\bhouse\s+(?:photo|picture|image|pic)s?\b|\b(?:photo|picture|image|pic)s?\s+of\s+the\s+(?:house|room|building|property)\b/;
const ID_PHOTO = /\b(?:national\s+)?id\s*(?:card\s*)?(?:photo|picture|image|pic)s?\b|\b(?:photo|picture|image)s?\s+of\s+the\s+(?:national\s+)?id\b/;
const LC1_PHOTO = /\blc\s?1\s+letter\s*\(?\s*(?:photo|picture|image)\)?|\bletter\s*\(?\s*(?:photo|picture|image)\)?/;
/** Removes every match (a fresh global copy, so no lastIndex is shared between calls). */
const strip = (t: string, re: RegExp, by: string) => t.replace(new RegExp(re.source, 'g'), by);

/**
 * The items the texts mention (a return reason, the server's still-missing lines), in
 * REASON_ITEMS order. A bare "photo", "face" or "passport" means the tenant's face photo;
 * house, ID and LC1 letter photos are told apart first.
 */
export function itemsMentioned(texts: (string | null | undefined)[]): ReasonItem[] {
  const found = new Set<ReasonItem>();
  for (const raw of texts) {
    if (!raw?.trim()) continue;
    let t = ` ${raw.toLowerCase().replace(/[’`]/g, "'")} `;
    if (HOUSE_PHOTO.test(t)) found.add('photos');
    t = strip(t, HOUSE_PHOTO, ' ');
    if (LC1_PHOTO.test(t) || /\blc\s?1\b|\blc\s+letter\b|\bchairperson\b|\bletter\b/.test(t)) found.add('lcLetter');
    t = strip(t, LC1_PHOTO, ' lc1 letter ');
    const idPhoto = ID_PHOTO.test(t);
    t = strip(t, ID_PHOTO, ' national id ');
    if (idPhoto || /\bnational\s+id\b|\bnin\b|\bid\b/.test(t)) {
      const front = /\bfront\b/.test(t);
      const back = /\bid\s*\(?\s*back\b|\bback\s+(?:of|side)\b/.test(t);
      if (front || !back) found.add('idFront');
      if (back) found.add('idBack');
    }
    if (/\b(?:photo|picture|image|pic|selfie|portrait|face|passport|head\s+and\s+shoulders)s?\b/.test(t)) found.add('tenantPhoto');
    if (/\blandlord/.test(t)) found.add('landlord');
    if (/\b(?:monthly\s+)?rent\b(?!\s*(?:plan|request))/.test(t)) found.add('rent');
    if (/\bgps\b|\bcoordinates\b|\blocation\b/.test(t.replace(/\bwork\s+location\b/g, ' work '))) found.add('gps');
    if (/\bfamily\b|\bhousehold\b/.test(t)) found.add('familySize');
    if (/\bwork\b|\bbusiness\b|\boccupation\b|\bjob\b/.test(t)) found.add('work');
  }
  return REASON_ITEMS.filter((k) => found.has(k));
}

/**
 * A refusal about the tenant's face photo, said plainly; null when the message is about
 * something else. Used when the server (or the upload) refuses a post or a resubmit.
 */
export function facePhotoRefusal(message: string | null | undefined): string | null {
  const m = (message ?? '').toLowerCase();
  if (!m) return null;
  const aboutFace = /tenant_photo|tenant photo|tenant's photo|tenant’s photo|passport|face|selfie|identity_photo|head and shoulders/.test(m)
    || (/\bphoto\b/.test(m) && itemsMentioned([message]).includes('tenantPhoto'));
  if (!aboutFace) return null;
  if (/upload|connection|network|timed? ?out|fetch/.test(m)) {
    return 'The tenant’s face photo didn’t upload — the network is slow. Check your connection and send it again, or retake the photo.';
  }
  if (/same (picture|photo|image)|duplicate|already used|another (person|tenant|agent)|agent'?s own/.test(m)) {
    return 'This face photo is already used for someone else. Take a new photo of this tenant: head and shoulders, face clear.';
  }
  if (/no face|not a face|face not|unclear|blur|dark|quality/.test(m)) {
    return 'The tenant’s face can’t be seen clearly in the photo. Retake it: head and shoulders, face clear, good light, no hat.';
  }
  if (/missing|required|must|needs?|without|null/.test(m)) {
    return 'The tenant’s face photo is missing. Take it now: head and shoulders, face clear.';
  }
  return 'The office couldn’t accept the tenant’s face photo. Retake it: head and shoulders, face clear, good light, no hat.';
}
