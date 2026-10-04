/**
 * The resumes bucket is private, so this never returns a public URL; every
 * call is a read of an applicant's personal document.
 */
import { supabase, unwrap } from '../api/client';

const RESUMES_BUCKET = 'resumes';

export async function getResumeUrl(storagePath: string): Promise<string> {
  const { data, error } = await supabase.storage
    .from(RESUMES_BUCKET)
    .createSignedUrl(storagePath, 60);
  if (error) throw new Error(error.message);
  if (!data?.signedUrl) throw new Error('Could not sign that CV link.');
  return data.signedUrl;
}
