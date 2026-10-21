/**
 * Sequential multi-file upload that survives a retry.
 *
 * A usage report uploads each receipt as it goes, so when file 6 of 8 fails the
 * first five are already stored and attached. Retrying from scratch would store
 * them again and push the requisition toward its attachment cap. The cache maps
 * a file's identity to the path it already uploaded to, so a retry only sends
 * what is missing.
 */

export type UploadCache = Map<string, string>;

/** Identity of a picked file. Two picks of the same photo share a key. */
export function fileKey(scope: string, file: File): string {
  return `${scope}:${file.name}:${file.size}:${file.lastModified}`;
}

/**
 * Uploads `files` in order, skipping any already in `cache`. Returns the paths
 * in the same order as `files`, or null as soon as one upload fails. Paths
 * uploaded before the failure stay in `cache` for the next attempt.
 */
export async function uploadAllResumable(
  files: File[],
  scope: string,
  cache: UploadCache,
  uploadOne: (file: File) => Promise<string | null>,
): Promise<string[] | null> {
  const paths: string[] = [];
  for (const file of files) {
    const key = fileKey(scope, file);
    let path = cache.get(key) ?? null;
    if (!path) {
      path = await uploadOne(file);
      if (!path) return null;
      cache.set(key, path);
    }
    paths.push(path);
  }
  return paths;
}

/** Drops cached uploads for files the user removed, so they are not reported. */
export function pruneCache(cache: UploadCache, scope: string, keep: File[]): void {
  const live = new Set(keep.map((f) => fileKey(scope, f)));
  const prefix = `${scope}:`;
  for (const key of Array.from(cache.keys())) {
    if (key.startsWith(prefix) && !live.has(key)) cache.delete(key);
  }
}
