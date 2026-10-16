import * as tus from 'tus-js-client';
import { supabase } from '@/integrations/supabase/client';

export async function resumableUpload(file: File, storagePath: string, onProgress?: (p: number) => void): Promise<void> {
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  if (!token) throw new Error('Please sign in again before uploading');

  await new Promise<void>((resolve, reject) => {
    const upload = new tus.Upload(file, {
      endpoint: `${import.meta.env.VITE_SUPABASE_URL}/storage/v1/upload/resumable`,
      retryDelays: [0, 3000, 5000, 10000, 20000],
      headers: {
        authorization: `Bearer ${token}`,
        apikey: import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY,
        'x-upsert': 'false',
      },
      uploadDataDuringCreation: true,
      removeFingerprintOnSuccess: true,
      chunkSize: 6 * 1024 * 1024,
      metadata: { bucketName: 'ops-tutorials', objectName: storagePath, contentType: 'video/mp4', cacheControl: '3600' },
      onProgress: (sent, total) => onProgress?.(total ? sent / total : 0),
      onSuccess: () => resolve(),
      onError: (err) => {
        const res = (err as tus.DetailedError).originalResponse;
        const body = res?.getBody?.();
        reject(new Error(body ? `Upload failed: ${body}` : `Upload failed: ${err.message}`));
      },
    });
    upload.findPreviousUploads()
      .then((previous) => {
        if (previous.length) upload.resumeFromPreviousUpload(previous[0]);
        upload.start();
      })
      .catch((e) => reject(new Error(`Upload failed: ${e instanceof Error ? e.message : String(e)}`)));
  });
}
