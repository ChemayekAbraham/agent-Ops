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

export type FaceCheckStatus = 'checking' | 'ok' | 'no_face' | 'unavailable';

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

/**
 * Re-encode any image the browser can decode into a JPEG data URL.
 *
 * The checker accepts JPEG and PNG only, while agents' photos are compressed to
 * WebP on capture and iPhones hand us HEIC. Going through a canvas normalises
 * all of them, and means the bytes we grade are bytes we know are readable.
 */
export async function fileToJpegDataUrl(file: File, maxEdge = 1200, quality = 0.9): Promise<string> {
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
    return canvas.toDataURL('image/jpeg', quality);
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
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
  let imageBase64: string;
  try {
    imageBase64 = await fileToJpegDataUrl(file);
  } catch {
    return { status: 'unavailable', unavailableReason: 'This photo could not be opened on this device' };
  }

  const { data, error } = await invokeEdgeFunction<VerifyResponse>('verify-passport-photo', {
    body: {
      image_base64: imageBase64,
      source: opts.source,
      ...(opts.subjectUserId ? { subject_user_id: opts.subjectUserId } : {}),
    },
    silent: true,
  });

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
 * The one-line reason a photo may not go forward, or null if it may.
 *
 * Used by step validation, so the rule is identical wherever it is applied.
 */
export function faceCheckBlocker(check: PassportFaceCheck | null): string | null {
  if (!check) return null;
  if (check.status === 'checking') return 'Wait for the face check on the passport photo to finish';
  if (check.status === 'no_face') {
    return "No face was found in the tenant's passport photo — retake it with the tenant's face clearly visible";
  }
  return null;
}
