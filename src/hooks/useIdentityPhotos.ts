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
import { publishAvatarUpdate } from '@/lib/avatarSync';

export const IDENTITY_BUCKET = 'identity-verification';

export type IdentityPhotoKind = 'national-id' | 'selfie';

export interface MyIdentityPhotos {
  national_id_photo_path: string | null;
  selfie_photo_path: string | null;
  identity_photos_submitted_at: string | null;
}

function extensionOf(file: File): string {
  const fromName = file.name.includes('.') ? file.name.split('.').pop() : '';
  const ext = (fromName || file.type.split('/')[1] || 'jpg').toLowerCase();
  return ext.replace(/[^a-z0-9]/g, '') || 'jpg';
}

export function useMyIdentityPhotos() {
  return useQuery({
    queryKey: ['my-identity-photos'],
    staleTime: 60_000,
    queryFn: async (): Promise<MyIdentityPhotos | null> => {
      const { data: auth } = await supabase.auth.getUser();
      const uid = auth.user?.id;
      if (!uid) return null;
      const { data, error } = await supabase
        .from('profiles')
        .select('national_id_photo_path, selfie_photo_path, identity_photos_submitted_at')
        .eq('id', uid)
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
        .select('national_id_photo_path, selfie_photo_path, identity_photos_submitted_at')
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
    mutationFn: async (paths: { idPhotoPath: string; selfiePath: string }) => {
      const { data, error } = await supabase.rpc('submit_identity_photos', {
        p_id_photo_path: paths.idPhotoPath,
        p_selfie_path: paths.selfiePath,
      });
      if (error) throw error;
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
export async function setSelfieAsProfilePhoto(userId: string, croppedFile: File): Promise<string | null> {
  try {
    const path = `${userId}/avatar.${extensionOf(croppedFile)}`;
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
    return avatarUrl;
  } catch {
    return null;
  }
}
