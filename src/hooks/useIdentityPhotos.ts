/**
 * Identity photo verification for payouts.
 *
 * Before any withdrawal, the person must record a photo of their National ID
 * card and a selfie. The files live in the private `identity-verification`
 * bucket under `<user id>/…` (storage policies keep each person to their own
 * folder; Financial Ops and finance leadership can read all of them), and the
 * paths are recorded by the `submit_identity_photos` RPC — never by a direct
 * table write from the client.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/hooks/useAuth';
import { optimizeImage } from '@/lib/imageOptimizer';

export const IDENTITY_BUCKET = 'identity-verification';
export type IdentityPhotoKind = 'national-id' | 'selfie';

export interface MyIdentityPhotos {
  national_id_photo_path: string | null;
  selfie_photo_path: string | null;
  identity_photos_submitted_at: string | null;
}

/** What the signed-in user has already recorded. */
export function useMyIdentityPhotos() {
  const { user } = useAuth();
  return useIdentityPhotosFor(user?.id);
}

/**
 * Photos for any one user. Storage policies restrict reads to the owner and
 * to Financial Ops / finance leadership, so this only returns data for those
 * callers.
 */
export function useIdentityPhotosFor(userId?: string | null) {
  return useQuery({
    queryKey: ['my-identity-photos', userId],
    enabled: !!userId,
    staleTime: 60_000,
    // While either photo is missing, keep checking so the verification panel
    // (and the Verify button) update the moment the user finishes recording —
    // no page refresh needed. Once both exist, poll quietly to catch retakes.
    refetchInterval: (query) => {
      const d = query.state.data;
      return d?.national_id_photo_path && d?.selfie_photo_path ? 120_000 : 8_000;
    },
    queryFn: async (): Promise<MyIdentityPhotos | null> => {
      const { data, error } = await supabase
        .from('profiles')
        .select('national_id_photo_path, selfie_photo_path, identity_photos_submitted_at')
        .eq('id', userId!)
        .maybeSingle();
      if (error) throw error;
      return (data ?? null) as MyIdentityPhotos | null;
    },
  });
}

function extensionFor(file: File): string {
  const fromName = file.name.split('.').pop()?.toLowerCase();
  if (fromName && /^[a-z0-9]{2,5}$/.test(fromName)) return fromName;
  if (file.type === 'image/png') return 'png';
  if (file.type === 'image/webp') return 'webp';
  return 'jpg';
}

/**
 * Uploads one photo into the caller's own folder and returns its path.
 *
 * Compressed client-side before it ever reaches storage — raw camera shots
 * from a phone routinely run 3-10MB, and these are captured directly via
 * `capture=` on a file input (see IdentityPhotoCapture.tsx), so nothing
 * upstream already shrinks them. Same resize+re-encode (WebP with JPEG
 * fallback) already used for other document photos in this codebase; the
 * ID card gets the higher-quality setting used for other legibility-
 * sensitive documents (passports) so small print stays readable, the
 * selfie gets the standard setting since it only needs to be
 * face-recognizable. This upload gates withdrawal, so a compression
 * failure (corrupt/unusual image, no canvas support) falls back to the
 * original file rather than blocking a legitimate submission.
 */
export async function uploadIdentityPhoto(
  userId: string,
  kind: IdentityPhotoKind,
  file: File,
): Promise<string> {
  const optimizedFile = await optimizeImage(file, {
    maxWidth: 1200,
    maxHeight: 1200,
    quality: kind === 'national-id' ? 0.85 : 0.8,
  })
    .then((r) => r.file)
    .catch(() => file);
  const path = `${userId}/${kind}-${Date.now()}.${extensionFor(optimizedFile)}`;
  const { error } = await supabase.storage.from(IDENTITY_BUCKET).upload(path, optimizedFile, {
    contentType: optimizedFile.type || 'image/jpeg',
    upsert: true,
  });
  if (error) throw new Error(error.message);
  return path;
}

/** Records both paths through the RPC once the two uploads succeeded. */
export function useSubmitIdentityPhotos() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { idPhotoPath: string; selfiePath: string }) => {
      const { data, error } = await supabase.rpc('submit_identity_photos', {
        p_id_photo_path: input.idPhotoPath,
        p_selfie_path: input.selfiePath,
      });
      if (error) throw new Error(error.message);
      const res = (data ?? {}) as { success?: boolean; message?: string };
      if (!res.success) throw new Error(res.message || 'Could not save your photos.');
      return res;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['my-identity-photos'] });
      qc.invalidateQueries({ queryKey: ['payout-verification-queue'] });
    },
  });
}

/** Short-lived link so Financial Ops (or the owner) can look at a photo. */
export async function identityPhotoUrl(path?: string | null): Promise<string | null> {
  if (!path) return null;
  const { data, error } = await supabase.storage
    .from(IDENTITY_BUCKET)
    .createSignedUrl(path, 300);
  if (error) return null;
  return data?.signedUrl ?? null;
}

/**
 * The selfie doubles as the person's profile picture.
 *
 * The identity bucket is private (Financial Ops only), so we upload a second
 * copy of the same shot into the public `avatars` bucket — the same place the
 * Settings screen writes to — and point `profiles.avatar_url` at it. Failure
 * here must never block the verification submission, so callers treat it as
 * best-effort.
 */
export async function setSelfieAsProfilePhoto(userId: string, file: File): Promise<string | null> {
  // Compressed and downsized for avatar display (400px is generous for how
  // large an avatar ever actually renders) — no reason to push a multi-MB
  // camera shot into a public, globally-served bucket. Best-effort: if
  // optimisation fails for any reason, fall back to the raw file rather than
  // losing the avatar entirely — this path must never block the identity
  // verification submission it rides alongside.
  const avatarFile = await optimizeImage(file, { maxWidth: 400, maxHeight: 400, quality: 0.8 })
    .then((r) => r.file)
    .catch(() => file);
  const path = `${userId}/avatar.${extensionFor(avatarFile)}`;
  await supabase.storage.from('avatars').remove([path]);
  const { error: upErr } = await supabase.storage.from('avatars').upload(path, avatarFile, {
    contentType: avatarFile.type || 'image/jpeg',
    upsert: true,
  });
  if (upErr) return null;
  const { data } = supabase.storage.from('avatars').getPublicUrl(path);
  const publicUrl = data?.publicUrl ? `${data.publicUrl}?t=${Date.now()}` : null;
  if (!publicUrl) return null;
  const { error: updErr } = await supabase
    .from('profiles')
    .update({ avatar_url: publicUrl })
    .eq('id', userId);
  if (updErr) return null;
  return publicUrl;
}
