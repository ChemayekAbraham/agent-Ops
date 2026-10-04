import { useState, useEffect, useRef } from 'react';
import { getSignedUrl, isStorageUrl } from '@/lib/storageUtils';

/**
 * Hook that automatically converts a Supabase storage public URL to a signed URL.
 * Returns the original URL if it's not a storage URL.
 * Caches results in memory for 55 minutes.
 */
export function useSignedUrl(storedUrl: string | null | undefined): string | undefined {
  const [signedUrl, setSignedUrl] = useState<string | undefined>(() => {
    // If not a storage URL, return it immediately (no async needed)
    if (!storedUrl) return undefined;
    if (!isStorageUrl(storedUrl)) return storedUrl;
    return undefined;
  });
  const urlRef = useRef(storedUrl);

  useEffect(() => {
    urlRef.current = storedUrl;

    if (!storedUrl) {
      setSignedUrl(undefined);
      return;
    }

    if (!isStorageUrl(storedUrl)) {
      setSignedUrl(storedUrl);
      return;
    }

    let cancelled = false;
    getSignedUrl(storedUrl).then(url => {
      if (!cancelled && urlRef.current === storedUrl) {
        setSignedUrl(url);
      }
    });

    return () => { cancelled = true; };
  }, [storedUrl]);

  return signedUrl;
}
