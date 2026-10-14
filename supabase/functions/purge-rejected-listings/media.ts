/**
 * Which storage objects the rejected-listing purge may delete.
 *
 * The purge runs with the service role, so Storage enforces nothing: this
 * module is the only thing standing between a listing's media URLs and a
 * delete. It used to take the bucket from the URL text itself, so a rejected
 * listing whose image_urls pointed at any public object (a meal photo, another
 * bucket's files) had that object deleted.
 *
 * Now a URL is deleted only when ALL of these hold:
 *   - it parses as an http(s) URL on THIS project's own Storage host;
 *   - its path is /storage/v1/object/public/<bucket>/<object path>;
 *   - <bucket> is an explicitly authorised listing bucket;
 *   - every object-path segment is non-empty, not "." or "..", and contains no
 *     slash, backslash or control character once decoded (so encoded
 *     separators cannot climb out of the path).
 * Anything else is refused and reported, never deleted.
 *
 * Pure: no Deno or network APIs, so it is unit-tested from vitest.
 */

/**
 * Buckets that hold listing media. Every listing-photo upload in the code base
 * writes to `house-images` (RentRequestForm, AgentRentRequestDialog,
 * AgentEditRentRequestDialog, submit-tenant-form, tenant-self-onboarding).
 * Listing videos are external YouTube/Drive links and are never in Storage.
 * Add a bucket here only when listing media is genuinely stored in it.
 */
export const PURGE_ALLOWED_BUCKETS: readonly string[] = ['house-images'];

const PUBLIC_OBJECT_PREFIX = '/storage/v1/object/public/';
const MAX_PATH_LENGTH = 1024;
/** True when the text holds a C0 control character or DEL. */
function hasControlChar(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c < 0x20 || c === 0x7f) return true;
  }
  return false;
}

export type MediaRef = { bucket: string; path: string };

export type RefusalReason =
  | 'not_a_url'
  | 'foreign_host'
  | 'malformed_path'
  | 'bucket_not_allowed';

export type MediaDecision =
  | { kind: 'delete'; ref: MediaRef }
  | { kind: 'not_storage' }                       // e.g. a YouTube link: nothing to delete
  | { kind: 'refused'; reason: RefusalReason; bucket?: string };

function decodeSegment(seg: string): string | null {
  try {
    return decodeURIComponent(seg);
  } catch {
    return null;                                  // malformed %-escape
  }
}

/** Decide what, if anything, may be deleted for one stored media URL. */
export function decideListingMedia(raw: unknown, projectUrl: string): MediaDecision {
  if (typeof raw !== 'string' || raw.trim() === '') return { kind: 'not_storage' };

  let url: URL;
  let project: URL;
  try {
    url = new URL(raw.trim());
    project = new URL(projectUrl);
  } catch {
    // a relative path or junk: it might still name a storage object, but
    // nothing proves which project or bucket, so it is never deleted
    return raw.includes(PUBLIC_OBJECT_PREFIX)
      ? { kind: 'refused', reason: 'not_a_url' }
      : { kind: 'not_storage' };
  }

  const isStorageShaped = url.pathname.startsWith(PUBLIC_OBJECT_PREFIX);
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    return isStorageShaped ? { kind: 'refused', reason: 'not_a_url' } : { kind: 'not_storage' };
  }
  if (url.host !== project.host) {
    // another site's URL: harmless to ignore, but a storage-shaped path on a
    // foreign host is a deliberate-looking attempt, so report it
    return isStorageShaped ? { kind: 'refused', reason: 'foreign_host' } : { kind: 'not_storage' };
  }
  if (!isStorageShaped) return { kind: 'not_storage' };

  // url.pathname is already normalised by the URL parser ("a/../b" -> "b"),
  // so a path cannot climb from one bucket into another undetected.
  const rest = url.pathname.slice(PUBLIC_OBJECT_PREFIX.length);
  const rawSegments = rest.split('/');
  const bucket = decodeSegment(rawSegments[0] ?? '');
  if (!bucket || !/^[a-z0-9][a-z0-9_-]{0,62}$/.test(bucket)) {
    return { kind: 'refused', reason: 'malformed_path' };
  }
  if (!PURGE_ALLOWED_BUCKETS.includes(bucket)) {
    return { kind: 'refused', reason: 'bucket_not_allowed', bucket };
  }

  const segments: string[] = [];
  for (const rawSeg of rawSegments.slice(1)) {
    const seg = decodeSegment(rawSeg);
    if (seg === null || seg === '' || seg === '.' || seg === '..'
        || seg.includes('/') || seg.includes('\\') || hasControlChar(seg)) {
      return { kind: 'refused', reason: 'malformed_path', bucket };
    }
    segments.push(seg);
  }
  const path = segments.join('/');
  if (path === '' || path.length > MAX_PATH_LENGTH) {
    return { kind: 'refused', reason: 'malformed_path', bucket };
  }
  return { kind: 'delete', ref: { bucket, path } };
}

export interface MediaDeletionPlan {
  /** Allowed bucket -> distinct object paths to delete. */
  byBucket: Map<string, Set<string>>;
  /** How many references were refused, by reason and bucket (no URLs kept). */
  refused: Array<{ reason: RefusalReason; bucket?: string; count: number }>;
}

/** Group every deletable reference by bucket; count (never delete) the rest. */
export function planListingMediaDeletion(raws: unknown[], projectUrl: string): MediaDeletionPlan {
  const byBucket = new Map<string, Set<string>>();
  const refusedCounts = new Map<string, { reason: RefusalReason; bucket?: string; count: number }>();
  for (const raw of raws) {
    const d = decideListingMedia(raw, projectUrl);
    if (d.kind === 'delete') {
      if (!byBucket.has(d.ref.bucket)) byBucket.set(d.ref.bucket, new Set());
      byBucket.get(d.ref.bucket)!.add(d.ref.path);
    } else if (d.kind === 'refused') {
      const key = `${d.reason}|${d.bucket ?? ''}`;
      const hit = refusedCounts.get(key);
      if (hit) hit.count += 1;
      else refusedCounts.set(key, { reason: d.reason, bucket: d.bucket, count: 1 });
    }
  }
  return { byBucket, refused: [...refusedCounts.values()] };
}
