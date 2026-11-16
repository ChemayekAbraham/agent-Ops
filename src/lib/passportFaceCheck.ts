/**
 * Face recognition on a tenant's passport photo.
 *
 * Wraps the `verify-passport-photo` edge function (PassGate). The API key stays
 * on the server; the browser only ever sees the verdict and the SHA-256 of the
 * exact bytes that were graded.
 *
 * WHAT BLOCKS AND WHAT DOES NOT
 * The only blocking outcome is a *definite negative*: the checker answered and
 * found no face. Anything else — the service being down, rate-limited, not
 * configured, unreachable on a bad connection — returns `unavailable`, which
 * warns but lets the registration continue. A face check is a quality gate, not
 * a kill switch: an outage on our side must never stop every agent in the
 * country from registering tenants.
 *
 * Read-only. PassGate stores no photo, and nothing here writes ledger or wallet
 * state — the fingerprint row is written server-side by the edge function.
 */
import { invokeEdgeFunction } from '@/lib/invokeEdgeFunction';

/** `skipped_timeout`: no answer within the time limit (or offline); the agent continues and the office checks it. */
export type FaceCheckStatus = 'checking' | 'ok' | 'no_face' | 'unavailable' | 'skipped_timeout';

export interface PassportFaceCheck {
  status: FaceCheckStatus;
  /** PassGate's overall grade. `review` means a human should look, not that it failed. */
  verdict?: 'pass' | 'review' | 'fail';
  isFace?: boolean;
  isPassportPhoto?: boolean;
  score?: number | null;
  /** SHA-256 of the graded bytes — the fingerprint shown to ops. */
  sha256?: string | null;
  /** Quality problems worth telling the agent about (hat, blur, background…). */
  failures?: { id: string; label: string; severity: string; advice: string }[];
  /** Why the check could not be completed, for the `unavailable` case. */
  unavailableReason?: string;
}

interface VerifyResponse {
  verdict?: 'pass' | 'review' | 'fail';
  is_face?: boolean;
  is_passport_photo?: boolean;
  score?: number | null;
  sha256?: string | null;
  failures?: { id: string; label: string; severity: string; advice: string }[];
}

/** The only two the checker accepts. */
const CHECKER_TYPES = ['image/jpeg', 'image/jpg', 'image/png'];
/**
 * The longest edge of the copy that is graded.
 *
 * It stays at the 1200 the photo is stored at, on purpose. The grader measures
 * the FACE in pixels - its `resolution`, `head_size` and `eye_line` checks - so
 * shrinking the picture would buy speed by making photos fail. What we cut is
 * bytes, never pixels.
 */
const CHECK_MAX_EDGE = 1200;
/**
 * Quality for the copy that is graded. The photo reaching us has already been
 * compressed once on capture, so re-encoding it at a HIGHER quality (this was
 * 0.9) only re-described detail that is no longer in the picture, at about half
 * as many bytes again over a phone connection.
 */
const CHECK_QUALITY = 0.82;
/**
 * A JPEG or PNG at or under this goes to the checker exactly as it is.
 *
 * This is where the wait goes on a cheap handset. The same photo was being
 * decoded and re-encoded for the check, then again for storage, then again at
 * send - each pass a full decode of a phone-camera picture - and the check's
 * copy was the largest of the three. One picture, encoded once, carried
 * through: no second decode, and a quarter fewer bytes on the wire because the
 * bytes no longer travel as base64 inside JSON.
 */
const CHECK_READY_BYTES = 600 * 1024;

/**
 * How a tenant's face photo is encoded on capture, so that ONE encode serves the
 * check, the preview and storage.
 *
 * JPEG, not the WebP the other photos use: the checker reads JPEG and PNG only,
 * so a WebP had to be decoded and re-encoded again before it could be graded -
 * a second full pass over a phone-camera picture, on the handsets least able to
 * afford it. Pass this to optimizeImage() wherever a face photo is taken.
 */
export const FACE_PHOTO_ENCODING = {
  maxWidth: CHECK_MAX_EDGE,
  maxHeight: CHECK_MAX_EDGE,
  quality: CHECK_QUALITY,
  format: 'image/jpeg',
} as const;

/** True when this file can go to the checker untouched (see CHECK_READY_BYTES). */
export function facePhotoIsReadyToSend(file: Blob): boolean {
  return CHECKER_TYPES.includes((file.type || '').toLowerCase()) && file.size > 0 && file.size <= CHECK_READY_BYTES;
}

/** Decode once, draw at the target size, hand back a JPEG. */
async function reencodeJpeg(file: Blob, maxEdge: number, quality: number): Promise<Blob> {
  const objectUrl = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const el = new Image();
      const timer = setTimeout(() => reject(new Error('Image load timed out')), 15000);
      el.onload = () => { clearTimeout(timer); resolve(el); };
      el.onerror = () => { clearTimeout(timer); reject(new Error('Image failed to load')); };
      el.src = objectUrl;
    });

    const ratio = Math.min(1, maxEdge / Math.max(img.width || 1, img.height || 1));
    const width = Math.max(1, Math.round((img.width || maxEdge) * ratio));
    const height = Math.max(1, Math.round((img.height || maxEdge) * ratio));

    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Canvas 2D context not available');
    // A transparent PNG would otherwise flatten to black and hide the face.
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, width, height);
    ctx.drawImage(img, 0, 0, width, height);
    // toBlob, not toDataURL: toDataURL builds the whole picture as one base64
    // string on the main thread, which is what makes the phone stutter here.
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', quality));
    if (!blob) throw new Error('Canvas toBlob returned null');
    return blob;
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

/**
 * The bytes to grade.
 *
 * A JPEG or PNG already small enough is passed straight through, untouched - no
 * decode at all. Anything else (the WebP the capture produces, the HEIC an
 * iPhone hands us, a 12-megapixel original) is decoded once and re-encoded as a
 * JPEG the checker can read.
 */
export async function facePhotoForCheck(file: Blob): Promise<Blob> {
  if (facePhotoIsReadyToSend(file)) return file;
  return reencodeJpeg(file, CHECK_MAX_EDGE, CHECK_QUALITY);
}

/**
 * Re-encode any image the browser can decode into a JPEG data URL.
 *
 * Kept for the older edge function, which takes the photo as base64 inside
 * JSON. The checker accepts JPEG and PNG only, while agents' photos are
 * compressed to WebP on capture and iPhones hand us HEIC; going through a
 * canvas normalises all of them.
 */
export async function fileToJpegDataUrl(file: File, maxEdge = CHECK_MAX_EDGE, quality = CHECK_QUALITY): Promise<string> {
  const blob = await reencodeJpeg(file, maxEdge, quality);
  return await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error('The photo could not be read'));
    reader.readAsDataURL(blob);
  });
}

/**
 * Grade one passport photo.
 *
 * @param subjectUserId  the person IN the photo, when their account already
 *   exists. Omit for a tenant who has no account yet — the fingerprint is then
 *   filed under the caller and moved across by
 *   `link_identity_photo_fingerprint` once the rent request exists.
 */
export async function runPassportFaceCheck(
  file: File,
  opts: { source: string; subjectUserId?: string | null } = { source: 'tenant_onboarding' },
): Promise<PassportFaceCheck> {
  let image: Blob;
  try {
    image = await facePhotoForCheck(file);
  } catch {
    return { status: 'unavailable', unavailableReason: 'This photo could not be opened on this device' };
  }

  // The picture goes up as the picture. Base64 inside JSON costs a third more
  // bytes on a connection that is already the slow part, and makes both ends
  // build the whole image as a string first.
  let { data, error } = await invokeEdgeFunction<VerifyResponse>('verify-passport-photo', {
    body: image,
    headers: {
      'Content-Type': image.type || 'image/jpeg',
      'x-photo-source': opts.source,
      ...(opts.subjectUserId ? { 'x-subject-user-id': opts.subjectUserId } : {}),
    },
    silent: true,
  });

  // A deployment that predates the binary body reads the request as JSON and
  // answers "Invalid request body". Say it again the old way rather than tell
  // the agent their photo could not be checked.
  if (error && /invalid request body|no photo was sent/i.test(error.message)) {
    // `image` is already a JPEG or PNG the checker reads, so this only re-wraps
    // the same bytes as text; the picture is not encoded a second time.
    const imageBase64 = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(new Error('read failed'));
      reader.readAsDataURL(image);
    }).catch(() => null);
    if (imageBase64) {
      ({ data, error } = await invokeEdgeFunction<VerifyResponse>('verify-passport-photo', {
        body: {
          image_base64: imageBase64,
          source: opts.source,
          ...(opts.subjectUserId ? { subject_user_id: opts.subjectUserId } : {}),
        },
        silent: true,
      }));
    }
  }

  if (error || !data) {
    return { status: 'unavailable', unavailableReason: error?.message || 'The face checker did not answer' };
  }

  // `is_face` is only trustworthy as a hard no when the checker actually said
  // false. An absent field means it did not reach a conclusion.
  const isFace = data.is_face;
  const status: FaceCheckStatus = isFace === false ? 'no_face' : isFace === true ? 'ok' : 'unavailable';

  return {
    status,
    verdict: data.verdict,
    isFace,
    isPassportPhoto: data.is_passport_photo,
    score: data.score ?? null,
    sha256: data.sha256 ?? null,
    failures: data.failures ?? [],
    ...(status === 'unavailable' ? { unavailableReason: 'The face checker gave no verdict' } : {}),
  };
}

/**
 * runPassportFaceCheck with a time limit. Offline, or no answer within `ms`, gives
 * `skipped_timeout` straight away: the agent can continue, and the office checks the photo.
 * A late answer is ignored.
 */
export async function runPassportFaceCheckWithin(
  file: File,
  opts: { source: string; subjectUserId?: string | null },
  ms: number,
  run: typeof runPassportFaceCheck = runPassportFaceCheck,
): Promise<PassportFaceCheck> {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    return { status: 'skipped_timeout', unavailableReason: 'offline' };
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<PassportFaceCheck>((resolve) => {
    timer = setTimeout(() => resolve({ status: 'skipped_timeout', unavailableReason: 'timeout' }), ms);
  });
  try {
    return await Promise.race([run(file, opts), timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * The one-line reason a photo may not go forward, or null if it may.
 *
 * Used by step validation, so the rule is identical wherever it is applied.
 */
export function faceCheckBlocker(check: PassportFaceCheck | null): string | null {
  if (!check) return null;
  if (check.status === 'checking') return 'Wait for the face check on the tenant’s face photo to finish';
  if (check.status === 'no_face') {
    return 'No face was found in the tenant’s face photo — retake it: head and shoulders, face clearly visible';
  }
  return null;
}
