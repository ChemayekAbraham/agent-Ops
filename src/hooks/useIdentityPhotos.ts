/**
 * Identity verification photos (National ID shot + selfie).
 *
 * Storage layout — the ORIGINAL, uncropped selfie is what Financial Ops must
 * see, so it is the file archived in the private verification bucket. The
 * cropped square is a presentation copy used only as the profile picture.
 *
 *   identity-verification/<userId>/national-id-<ts>.<ext>   (private, ops read)
 *   identity-verification/<userId>/selfie-<ts>.<ext>        (private, ORIGINAL)
 *   avatars/<userId>/avatar.<ext>                           (profile picture, cropped)
 *
 * Every upload keeps its timestamped name, so the bucket folder is the
 * person's verification history; `profiles.selfie_photo_path` points at the
 * latest original. No wallet/ledger state is touched here.
 */
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/hooks/useAuth';
import { publishAvatarUpdate } from '@/lib/avatarSync';
import { extractFromErrorObject } from '@/lib/extractEdgeFunctionError';

export const IDENTITY_BUCKET = 'identity-verification';

export type IdentityPhotoKind = 'national-id' | 'selfie';

export interface MyIdentityPhotos {
  national_id_photo_path: string | null;
  /** The back of the card — required alongside the front. */
  national_id_back_photo_path: string | null;
  selfie_photo_path: string | null;
  identity_photos_submitted_at: string | null;
}

function extensionOf(file: File): string {
  const fromName = file.name.includes('.') ? file.name.split('.').pop() : '';
  const ext = (fromName || file.type.split('/')[1] || 'jpg').toLowerCase();
  return ext.replace(/[^a-z0-9]/g, '') || 'jpg';
}

export function useMyIdentityPhotos() {
  const { user } = useAuth();
  const uid = user?.id;
  return useQuery({
    // Keyed by user id — a bare 'my-identity-photos' key let React Query serve
    // one agent's cached "already on file" thumbnails to the next person who
    // logs into the same device/session without a full page reload, and a
    // resubmit built on those stale paths was silently rejected server-side
    // (paths belong to someone else's storage folder), leaving the new user
    // with nothing recorded despite believing they had submitted.
    queryKey: ['my-identity-photos', uid],
    enabled: !!uid,
    staleTime: 60_000,
    queryFn: async (): Promise<MyIdentityPhotos | null> => {
      const { data, error } = await supabase
        .from('profiles')
        .select('national_id_photo_path, national_id_back_photo_path, selfie_photo_path, identity_photos_submitted_at')
        .eq('id', uid!)
        .maybeSingle();
      if (error) throw error;
      return (data as MyIdentityPhotos) ?? null;
    },
  });
}

/** Reads the two archived paths for any user (storage RLS gates the files). */
export function useIdentityPhotosFor(userId: string | null | undefined) {
  return useQuery({
    queryKey: ['identity-photos-for', userId],
    enabled: !!userId,
    queryFn: async (): Promise<MyIdentityPhotos | null> => {
      const { data, error } = await supabase
        .from('profiles')
        .select('national_id_photo_path, national_id_back_photo_path, selfie_photo_path, identity_photos_submitted_at')
        .eq('id', userId!)
        .maybeSingle();
      if (error) throw error;
      return (data as MyIdentityPhotos) ?? null;
    },
    refetchInterval: (query) => {
      const d = query.state.data as MyIdentityPhotos | null | undefined;
      return d?.national_id_photo_path && d?.selfie_photo_path ? 120_000 : 8_000;
    },
  });
}

/** Uploads one verification photo, keeping its own timestamped history entry. */
export async function uploadIdentityPhoto(
  userId: string,
  kind: IdentityPhotoKind,
  file: File,
): Promise<string> {
  const path = `${userId}/${kind}-${Date.now()}.${extensionOf(file)}`;
  const { error } = await supabase.storage
    .from(IDENTITY_BUCKET)
    .upload(path, file, { upsert: false, contentType: file.type || 'image/jpeg' });
  if (error) throw error;
  return path;
}

/** A short-lived signed link for a private verification photo. */
export async function identityPhotoUrl(path: string | null | undefined): Promise<string | null> {
  if (!path) return null;
  const { data, error } = await supabase.storage.from(IDENTITY_BUCKET).createSignedUrl(path, 300);
  if (error) return null;
  return data?.signedUrl ?? null;
}

export function useSubmitIdentityPhotos() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (paths: {
      idPhotoPath: string;
      selfiePath: string;
      idBackPhotoPath?: string | null;
      nameChangeConsent?: boolean;
      /** Local perceptual fingerprints — used to spot the same face/ID twice. */
      selfieHash?: string | null;
      idHash?: string | null;
    }) => {
      // Routed through the submit-identity-photos edge function rather than
      // calling the RPC directly: it runs an AI-vision check first (does the
      // photo actually show a National ID card?) and rejects obvious
      // non-ID/unreadable photos before they ever reach the verification
      // queue. It forwards the hash recording too, so this is a drop-in
      // replacement for the previous direct RPC calls.
      const { data, error } = await supabase.functions.invoke('submit-identity-photos', {
        body: {
          idPhotoPath: paths.idPhotoPath,
          selfiePath: paths.selfiePath,
          idBackPhotoPath: paths.idBackPhotoPath ?? null,
          nameChangeConsent: paths.nameChangeConsent ?? false,
          selfieHash: paths.selfieHash ?? null,
          idHash: paths.idHash ?? null,
        },
      });
      // The SDK hides the backend's own wording behind "Edge Function returned
      // a non-2xx status code" — read the real reason out of the response body
      // so the screen can show it instead of a guess.
      if (error) throw new Error(await extractFromErrorObject(error, 'Could not send your photos. Please try again.'));
      if (data?.error) throw new Error(data.error);
      return data as { success?: boolean; message?: string } | null;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['my-identity-photos'] });
      qc.invalidateQueries({ queryKey: ['payout-verification-queue'] });
      qc.invalidateQueries({ queryKey: ['identity-photos-for'] });
    },
  });
}

/**
 * Sets the CROPPED selfie as the profile picture. Best-effort: the archived
 * original in the verification bucket is what matters for verification, so a
 * failure here never blocks the submission.
 */
export async function setSelfieAsProfilePhoto(
  userId: string,
  croppedFile: File,
  originalSelfiePath?: string,
): Promise<string | null> {
  try {
    const ext = extensionOf(croppedFile);
    // Archive the cropped copy too, so verification history can show the
    // original selfie next to the exact picture that became the profile photo.
    // The avatar itself is overwritten on every change, so it cannot be history.
    let cropPath: string | null = null;
    try {
      const candidate = `${userId}/profile-crop-${Date.now()}.${ext}`;
      const { error } = await supabase.storage
        .from(IDENTITY_BUCKET)
        .upload(candidate, croppedFile, {
          upsert: false,
          contentType: croppedFile.type || 'image/jpeg',
        });
      if (!error) cropPath = candidate;
    } catch { /* history copy is best-effort */ }

    const path = `${userId}/avatar.${ext}`;
    const { error: upErr } = await supabase.storage
      .from('avatars')
      .upload(path, croppedFile, { upsert: true, contentType: croppedFile.type || 'image/jpeg' });
    if (upErr) return null;
    const { data } = supabase.storage.from('avatars').getPublicUrl(path);
    const avatarUrl = `${data.publicUrl}?t=${Date.now()}`;
    const { error: profErr } = await supabase
      .from('profiles')
      .update({ avatar_url: avatarUrl })
      .eq('id', userId);
    if (profErr) return null;
    publishAvatarUpdate(userId, avatarUrl);

    // Audit trail: which original selfie was archived and which cropped copy
    // became the profile picture. Best-effort — never blocks the submission.
    if (originalSelfiePath) {
      try {
        await supabase.rpc('log_verification_selfie_crop', {
          p_selfie_path: originalSelfiePath,
          p_crop_path: cropPath,
          p_avatar_url: avatarUrl,
        });
      } catch { /* audit entry is best-effort */ }
    }

    return avatarUrl;
  } catch {
    return null;
  }
}


/** One archived verification file. */
export interface VerificationHistoryFile {
  path: string;
  kind: IdentityPhotoKind | 'profile-crop' | 'other';
  createdAt: string | null;
  url: string | null;
}

/** A selfie submission paired with the cropped picture it produced. */
export interface VerificationHistoryEntry {
  id: string;
  submittedAt: string | null;
  original: VerificationHistoryFile | null;
  cropped: VerificationHistoryFile | null;
  nationalId: VerificationHistoryFile | null;
}

function kindOf(name: string): VerificationHistoryFile['kind'] {
  if (name.startsWith('profile-crop-')) return 'profile-crop';
  if (name.startsWith('selfie-')) return 'selfie';
  if (name.startsWith('national-id-')) return 'national-id';
  return 'other';
}

/**
 * Verification history for one person: every archived file in their folder,
 * newest first, with signed thumbnails. Storage RLS restricts reads to the
 * owner plus finance roles, so no extra role check is needed here.
 */
export function useVerificationHistory(userId: string | null | undefined) {
  return useQuery({
    queryKey: ['verification-history', userId],
    enabled: !!userId,
    staleTime: 60_000,
    queryFn: async (): Promise<VerificationHistoryEntry[]> => {
      const { data: list, error } = await supabase.storage
        .from(IDENTITY_BUCKET)
        .list(userId!, { limit: 200, sortBy: { column: 'name', order: 'desc' } });
      if (error) throw error;

      const files: VerificationHistoryFile[] = (list || [])
        .filter((o) => !!o.name && !o.name.startsWith('.'))
        .map((o) => ({
          path: `${userId}/${o.name}`,
          kind: kindOf(o.name),
          createdAt: (o.created_at as string | undefined) || null,
          url: null,
        }));

      if (files.length === 0) return [];

      const { data: signed } = await supabase.storage
        .from(IDENTITY_BUCKET)
        .createSignedUrls(files.map((f) => f.path), 600);
      const urlByPath = new Map<string, string>();
      (signed || []).forEach((s) => {
        if (s.path && s.signedUrl) urlByPath.set(s.path, s.signedUrl);
      });
      files.forEach((f) => { f.url = urlByPath.get(f.path) ?? null; });

      const stamp = (f: VerificationHistoryFile) => {
        const m = f.path.match(/-(\d{10,})\./);
        return m ? Number(m[1]) : 0;
      };
      const desc = (a: VerificationHistoryFile, b: VerificationHistoryFile) => stamp(b) - stamp(a);

      const selfies = files.filter((f) => f.kind === 'selfie').sort(desc);
      const crops = files.filter((f) => f.kind === 'profile-crop').sort(desc);
      const ids = files.filter((f) => f.kind === 'national-id').sort(desc);

      const rows = Math.max(selfies.length, crops.length, ids.length);
      const entries: VerificationHistoryEntry[] = [];
      for (let i = 0; i < rows; i += 1) {
        const original = selfies[i] ?? null;
        const cropped = crops[i] ?? null;
        const nationalId = ids[i] ?? null;
        const source = original || cropped || nationalId;
        entries.push({
          id: source?.path ?? `entry-${i}`,
          submittedAt:
            source?.createdAt ??
            (source && stamp(source) ? new Date(stamp(source)).toISOString() : null),
          original,
          cropped,
          nationalId,
        });
      }
      return entries;
    },
  });
}

