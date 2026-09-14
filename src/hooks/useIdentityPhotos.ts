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
  return useQuery({
    queryKey: ['my-identity-photos', user?.id],
    enabled: !!user?.id,
    staleTime: 60_000,
    queryFn: async (): Promise<MyIdentityPhotos | null> => {
      const { data, error } = await supabase
        .from('profiles')
        .select('national_id_photo_path, selfie_photo_path, identity_photos_submitted_at')
        .eq('id', user!.id)
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

/** Uploads one photo into the caller's own folder and returns its path. */
export async function uploadIdentityPhoto(
  userId: string,
  kind: IdentityPhotoKind,
  file: File,
): Promise<string> {
  const path = `${userId}/${kind}-${Date.now()}.${extensionFor(file)}`;
  const { error } = await supabase.storage.from(IDENTITY_BUCKET).upload(path, file, {
    contentType: file.type || 'image/jpeg',
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
