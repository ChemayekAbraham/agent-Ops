import { supabase } from '@/integrations/supabase/client';

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL || '';

// In-memory cache for signed URLs (avoids re-signing on every render)
const signedUrlCache = new Map<string, { url: string; expiresAt: number }>();
const CACHE_TTL_MS = 55 * 60 * 1000; // 55 minutes (URLs valid for 1 hour)

// Pending requests to avoid duplicate fetches
const pendingRequests = new Map<string, Promise<string>>();

/**
 * Parse a Supabase storage public URL to extract bucket and path.
 * Handles: https://xxx.supabase.co/storage/v1/object/public/BUCKET/PATH
 */
export function parseStorageUrl(url: string): { bucket: string; path: string } | null {
  if (!url || typeof url !== 'string') return null;

  try {
    // Match the public object URL pattern
    const match = url.match(/\/storage\/v1\/object\/public\/([^/]+)\/(.+)/);
    if (match) {
      return { bucket: match[1], path: decodeURIComponent(match[2]) };
    }
  } catch {
    // Not a storage URL
  }

  return null;
}

/**
 * Check if a URL is a Supabase storage URL that needs signing
 */
export function isStorageUrl(url: string | null | undefined): boolean {
  if (!url) return false;
  return url.includes('/storage/v1/object/public/');
}

/**
 * Get a signed URL for a storage file. Returns the original URL if not a storage URL.
 * Results are cached in memory for 55 minutes.
 */
export async function getSignedUrl(storedUrl: string): Promise<string> {
  if (!storedUrl) return storedUrl;

  // Check cache first
  const cached = signedUrlCache.get(storedUrl);
  if (cached && Date.now() < cached.expiresAt) {
    return cached.url;
  }

  // Parse the URL
  const parsed = parseStorageUrl(storedUrl);
  if (!parsed) return storedUrl; // Not a storage URL, return as-is

  // Check if there's already a pending request for this URL
  const pending = pendingRequests.get(storedUrl);
  if (pending) return pending;

  // Create the signed URL request
  const request = (async () => {
    try {
      const { data, error } = await supabase.storage
        .from(parsed.bucket)
        .createSignedUrl(parsed.path, 3600); // 1 hour expiry

      if (error || !data?.signedUrl) {
        console.warn('[storageUtils] Failed to sign URL:', parsed.bucket, parsed.path);
        return storedUrl; // Fall back to original URL
      }

      // Cache the result
      signedUrlCache.set(storedUrl, {
        url: data.signedUrl,
        expiresAt: Date.now() + CACHE_TTL_MS,
      });

      return data.signedUrl;
    } catch (err) {
      console.warn('[storageUtils] Error signing URL:', err);
      return storedUrl;
    } finally {
      pendingRequests.delete(storedUrl);
    }
  })();

  pendingRequests.set(storedUrl, request);
  return request;
}

/**
 * Batch sign multiple URLs at once. More efficient than signing one at a time.
 */
export async function batchSignUrls(urls: (string | null | undefined)[]): Promise<Map<string, string>> {
  const result = new Map<string, string>();
  const toSign: string[] = [];

  for (const url of urls) {
    if (!url) continue;
    const cached = signedUrlCache.get(url);
    if (cached && Date.now() < cached.expiresAt) {
      result.set(url, cached.url);
    } else if (isStorageUrl(url)) {
      toSign.push(url);
    } else {
      result.set(url, url);
    }
  }

  // Sign remaining URLs in parallel
  const signed = await Promise.all(toSign.map(url => getSignedUrl(url)));
  toSign.forEach((url, i) => result.set(url, signed[i]));

  return result;
}

/**
 * Clear the signed URL cache (useful on auth state change)
 */
export function clearSignedUrlCache(): void {
  signedUrlCache.clear();
  pendingRequests.clear();
}
