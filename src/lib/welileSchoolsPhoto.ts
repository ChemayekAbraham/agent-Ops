/**
 * Student face photos for Welile Schools registrations.
 *
 * Photos live in the private `welile-school-photos` bucket at
 * <school_id>/<profile_id>.jpg and the path is saved on
 * welile_school_profiles.photo_path. Agents often work offline at the gate, so a
 * photo that cannot upload is kept on the phone and sent with the next flush.
 */
import { supabase } from '@/integrations/supabase/client';

// welile_school_profiles.photo_path is not in the generated Supabase types yet.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const db = supabase as any;

export const STUDENT_PHOTO_BUCKET = 'welile-school-photos';
export const OUTPUT_SIZE = 480;
export const JPEG_QUALITY = 0.82;
const PHOTO_QUEUE_KEY = 'welile:schools:pending-photos';

/**
 * The square crop around the oval guide in the middle of the frame. The oval
 * covers ~64% of the shorter side; 86% keeps the whole head and a little shoulder.
 */
export function cropFaceSquare(videoWidth: number, videoHeight: number) {
  const side = Math.round(Math.min(videoWidth, videoHeight) * 0.86);
  return { sx: Math.round((videoWidth - side) / 2), sy: Math.round((videoHeight - side) / 2), side };
}

export function studentPhotoPath(schoolId: string, profileId: string) {
  return `${schoolId}/${profileId}.jpg`;
}

interface PendingPhoto { clientRef: string; path: string; dataUrl: string }

function readQueue(): PendingPhoto[] {
  try { return JSON.parse(localStorage.getItem(PHOTO_QUEUE_KEY) || '[]'); } catch { return []; }
}
function writeQueue(rows: PendingPhoto[]) {
  try { localStorage.setItem(PHOTO_QUEUE_KEY, JSON.stringify(rows)); } catch { /* storage full: the photo is lost, the profile is not */ }
}
export function pendingPhotoCount() { return readQueue().length; }

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });
}
async function dataUrlToBlob(dataUrl: string): Promise<Blob> {
  return (await fetch(dataUrl)).blob();
}

async function upload(path: string, blob: Blob): Promise<boolean> {
  const { error } = await supabase.storage.from(STUDENT_PHOTO_BUCKET).upload(path, blob, { contentType: 'image/jpeg', upsert: true });
  return !error;
}

/**
 * Uploads the photo now if it can. Returns the storage path when uploaded, or
 * null after queueing it on the phone for later.
 */
export async function uploadStudentPhoto(schoolId: string, profileId: string, clientRef: string, blob: Blob): Promise<string | null> {
  const path = studentPhotoPath(schoolId, profileId);
  if (navigator.onLine !== false && await upload(path, blob)) return path;
  const dataUrl = await blobToDataUrl(blob);
  writeQueue([...readQueue().filter((p) => p.clientRef !== clientRef), { clientRef, path, dataUrl }]);
  return null;
}

/** Sends queued photos and links each to its profile. Run after profiles are flushed. */
export async function flushPendingPhotos(): Promise<number> {
  const queue = readQueue();
  if (!queue.length) return 0;
  const left: PendingPhoto[] = [];
  let sent = 0;
  for (const p of queue) {
    try {
      if (!(await upload(p.path, await dataUrlToBlob(p.dataUrl)))) { left.push(p); continue; }
      const { data, error } = await db.from('welile_school_profiles').update({ photo_path: p.path }).eq('client_ref', p.clientRef).select('id');
      // No row yet means the profile itself is still queued: keep the photo for the next run.
      if (error || !data?.length) left.push(p); else sent++;
    } catch {
      left.push(p);
    }
  }
  writeQueue(left);
  return sent;
}

/** A short-lived link to show a student's photo to agents and ops. */
export async function studentPhotoUrl(path: string): Promise<string | null> {
  const { data, error } = await supabase.storage.from(STUDENT_PHOTO_BUCKET).createSignedUrl(path, 600);
  return error ? null : data?.signedUrl ?? null;
}
