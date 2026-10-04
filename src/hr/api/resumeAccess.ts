/**
 * Signed URLs for the private `resumes` bucket.
 *
 * The bucket is private by design: an applicant's CV must never be reachable
 * from a public URL. `job_applications.resume_url` stores a bare object key
 * ("<uuid>.<ext>") written by the public form, not a URL, so the stored value
 * is passed straight through to createSignedUrl.
 *
 * The storage policy "HR can read resumes" limits SELECT on this bucket to the
 * `hr` and `super_admin` roles. That policy is the access boundary; nothing in
 * this file re-checks it, and nothing here should be taken as a second gate.
 *
 * Nothing here deletes. Removing a CV is part of an erasure request, which is
 * a separate operation with its own record.
 */
import { supabase } from './client';

const RESUMES_BUCKET = 'resumes';

/** Seconds a signed CV link stays valid. Deliberately short — long enough to open, not to share. */
const RESUME_URL_TTL_SECONDS = 60;

/** Short-lived signed URL for one CV. The bucket is private, so never a public URL. */
export async function getResumeUrl(storagePath: string): Promise<string> {
  const objectKey = (storagePath ?? '').trim();
  if (!objectKey) {
    throw new Error('This application has no CV attached.');
  }

  const { data, error } = await supabase.storage
    .from(RESUMES_BUCKET)
    .createSignedUrl(objectKey, RESUME_URL_TTL_SECONDS);

  if (error) throw new Error(error.message);
  if (!data?.signedUrl) throw new Error('Could not sign that CV link.');
  return data.signedUrl;
}
