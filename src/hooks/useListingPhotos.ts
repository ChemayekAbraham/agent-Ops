import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { optimizeImage } from '@/lib/imageOptimizer';

export interface ListingPhoto {
  id: string;
  listing_id: string;
  storage_path: string;
  position: number;
  is_cover: boolean;
  uploaded_by: string | null;
  created_at: string;
}

const BUCKET = 'house-images';

/**
 * Photos for a single house listing (Airbnb/Booking.com pattern: a child table,
 * not columns). Keeps an ordered list with a single cover photo.
 */
export function useListingPhotos(listingId: string | null, enabled = true) {
  return useQuery({
    queryKey: ['listing-photos', listingId],
    enabled: enabled && !!listingId,
    staleTime: 30_000,
    queryFn: async (): Promise<ListingPhoto[]> => {
      const { data, error } = await supabase
        .from('listing_photos')
        .select('id, listing_id, storage_path, position, is_cover, uploaded_by, created_at')
        .eq('listing_id', listingId!)
        .order('is_cover', { ascending: false })
        .order('position', { ascending: true })
        .order('created_at', { ascending: true });
      if (error) throw error;
      return (data ?? []) as ListingPhoto[];
    },
  });
}

export function useListingPhotoActions(listingId: string | null) {
  const qc = useQueryClient();
  const invalidate = useCallback(() => {
    qc.invalidateQueries({ queryKey: ['listing-photos', listingId] });
  }, [qc, listingId]);

  /** Optimize (1200px WebP) + upload to storage + insert a row. */
  const upload = useCallback(async (files: File[]) => {
    if (!listingId) throw new Error('No listing selected');
    const { data: auth } = await supabase.auth.getUser();
    const uid = auth.user?.id ?? null;

    for (const file of files) {
      if (!file.type.startsWith('image/')) continue;
      let toUpload: File = file;
      try {
        const optimized = await optimizeImage(file, { maxWidth: 1200, maxHeight: 1200, quality: 0.8 });
        toUpload = optimized.file;
      } catch {
        // fall back to original on optimization failure
      }
      const ext = toUpload.name.split('.').pop() || 'webp';
      const base = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
      const path = `${uid ?? 'ops'}/${listingId}/${base}.${ext}`;
      const { error: upErr } = await supabase.storage
        .from(BUCKET)
        .upload(path, toUpload, { cacheControl: '86400', upsert: false });
      if (upErr) throw upErr;
      const { data: pub } = supabase.storage.from(BUCKET).getPublicUrl(path);
      const { error: insErr } = await supabase
        .from('listing_photos')
        .insert({ listing_id: listingId, storage_path: pub.publicUrl, uploaded_by: uid });
      if (insErr) throw insErr;
    }
    invalidate();
  }, [listingId, invalidate]);

  const remove = useCallback(async (photoId: string) => {
    const { error } = await supabase.from('listing_photos').delete().eq('id', photoId);
    if (error) throw error;
    invalidate();
  }, [invalidate]);

  const setCover = useCallback(async (photoId: string) => {
    if (!listingId) return;
    const { error: clearErr } = await supabase
      .from('listing_photos')
      .update({ is_cover: false })
      .eq('listing_id', listingId)
      .neq('id', photoId);
    if (clearErr) throw clearErr;
    const { error } = await supabase
      .from('listing_photos')
      .update({ is_cover: true })
      .eq('id', photoId);
    if (error) throw error;
    invalidate();
  }, [listingId, invalidate]);

  /** Swap positions of two photos to reorder. */
  const swap = useCallback(async (a: ListingPhoto, b: ListingPhoto) => {
    const { error: e1 } = await supabase.from('listing_photos').update({ position: b.position }).eq('id', a.id);
    if (e1) throw e1;
    const { error: e2 } = await supabase.from('listing_photos').update({ position: a.position }).eq('id', b.id);
    if (e2) throw e2;
    invalidate();
  }, [invalidate]);

  return { upload, remove, setCover, swap };
}