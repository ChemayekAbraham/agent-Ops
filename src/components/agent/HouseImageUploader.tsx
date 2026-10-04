import { useState, useRef } from 'react';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Camera, X, Loader2, Image, FolderOpen, AlertTriangle, RotateCcw } from 'lucide-react';
import { supabase } from '@/integrations/supabase/client';
import { toast } from 'sonner';
import { optimizeImage, generateThumbnail } from '@/lib/imageOptimizer';
import { ExistingPropertyPhotosDialog } from './ExistingPropertyPhotosDialog';

export interface HouseImageFile {
  id: string;
  previewUrl: string;
  file: File;
  thumbnailFile?: File;
  source?: 'camera' | 'gallery' | 'existing';
}

interface FailedPhoto {
  id: string;
  file: File;
  name: string;
  source: 'camera' | 'gallery';
  reason: string;
}

interface HouseImageUploaderProps {
  images: HouseImageFile[];
  onChange: (images: HouseImageFile[]) => void;
  maxImages?: number;
  region?: string;
  district?: string;
  village?: string;
  /** When true, only camera capture is allowed (no gallery / existing photos). */
  cameraOnly?: boolean;
  /** Minimum number of photos expected (used for the helper caption only). */
  minImages?: number;
}

export function HouseImageUploader({ images, onChange, maxImages = 5, region, district, village, cameraOnly = false, minImages = 0 }: HouseImageUploaderProps) {
  const [compressing, setCompressing] = useState(false);
  const [showExisting, setShowExisting] = useState(false);
  const [failed, setFailed] = useState<FailedPhoto[]>([]);
  const cameraInputRef = useRef<HTMLInputElement>(null);
  const galleryInputRef = useRef<HTMLInputElement>(null);

  const processFiles = async (files: File[], source: 'camera' | 'gallery') => {
    const remaining = maxImages - images.length;
    if (files.length > remaining) {
      toast.error(`You can only add ${remaining} more photo(s)`);
      return;
    }

    setCompressing(true);
    const newImages: HouseImageFile[] = [];
    const newFailed: FailedPhoto[] = [];

    try {
      for (const file of files) {
        const failId = `fail-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        if (!file.type.startsWith('image/')) {
          newFailed.push({ id: failId, file, name: file.name || 'This file', source, reason: 'Not a supported image format' });
          continue;
        }
        if (file.size > 10 * 1024 * 1024) {
          newFailed.push({ id: failId, file, name: file.name || 'Photo', source, reason: 'Larger than 10MB' });
          continue;
        }

        try {
          const optimized = await optimizeImage(file, { maxWidth: 1200, maxHeight: 1200, quality: 0.8 });
          let thumbnailFile: File | undefined;
          try {
            thumbnailFile = (await generateThumbnail(file, 300)).file;
          } catch (thumbErr) {
            console.warn('Thumbnail generation failed, continuing without it:', thumbErr);
          }

          const saved = Math.round((1 - optimized.compressedSize / optimized.originalSize) * 100);
          if (saved > 10) {
            console.log(`[ImageOptimizer] ${file.name}: ${(optimized.originalSize/1024).toFixed(0)}KB → ${(optimized.compressedSize/1024).toFixed(0)}KB (${saved}% smaller)`);
          }

          newImages.push({
            id: `img-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            previewUrl: optimized.previewUrl,
            file: optimized.file,
            thumbnailFile,
            source,
          });
        } catch (err) {
          console.error('Image optimization failed:', err);
          newFailed.push({
            id: failId,
            file,
            name: file.name || 'Photo',
            source,
            reason: 'Could not be opened or compressed',
          });
        }
      }
    } catch (err) {
      console.error('Unexpected error while adding photos:', err);
      toast.error('Something went wrong adding photos. Please try again.');
    } finally {
      setCompressing(false);
    }

    if (newImages.length) onChange([...images, ...newImages]);
    if (newFailed.length) setFailed(prev => [...prev, ...newFailed]);
  };

  const retryFailed = async (id: string) => {
    const item = failed.find(f => f.id === id);
    if (!item) return;
    setFailed(prev => prev.filter(f => f.id !== id));
    await processFiles([item.file], item.source);
  };

  const dismissFailed = (id: string) => {
    setFailed(prev => prev.filter(f => f.id !== id));
  };

  const handleCameraCapture = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || []);
    if (files.length) await processFiles(files, 'camera');
    if (cameraInputRef.current) cameraInputRef.current.value = '';
  };

  const handleGallerySelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || []);
    if (files.length) await processFiles(files, 'gallery');
    if (galleryInputRef.current) galleryInputRef.current.value = '';
  };

  const handleExistingSelect = (existingImages: HouseImageFile[]) => {
    const remaining = maxImages - images.length;
    const toAdd = existingImages.slice(0, remaining);
    onChange([...images, ...toAdd]);
  };

  const remove = (id: string) => {
    const img = images.find(i => i.id === id);
    if (img) URL.revokeObjectURL(img.previewUrl);
    onChange(images.filter(i => i.id !== id));
  };

  const allFromExisting = images.length > 0 && images.every(i => i.source === 'existing');
  const remaining = maxImages - images.length;

  return (
    <div className="space-y-2">
      <Label className="text-xs">Photos ({images.length}/{maxImages})</Label>

      {/* Hidden file inputs */}
      <input
        ref={cameraInputRef}
        type="file"
        accept="image/*"
        capture="environment"
        onChange={handleCameraCapture}
        className="hidden"
      />
      <input
        ref={galleryInputRef}
        type="file"
        accept="image/*"
        multiple
        onChange={handleGallerySelect}
        className="hidden"
      />

      {/* Image preview strip */}
      {images.length > 0 && (
        <div className="flex gap-2 overflow-x-auto pb-1 snap-x">
          {images.map(img => (
            <div key={img.id} className="relative shrink-0 w-20 h-20 rounded-lg overflow-hidden border border-border">
              <img src={img.previewUrl} alt="" className="w-full h-full object-cover" />
              {img.source === 'existing' && (
                <div className="absolute bottom-0 left-0 right-0 bg-amber-500/80 text-[8px] text-center text-white font-medium py-0.5">
                  Reused
                </div>
              )}
              <button
                type="button"
                onClick={() => remove(img.id)}
                className="absolute top-0.5 right-0.5 bg-destructive text-destructive-foreground rounded-full p-0.5"
              >
                <X className="h-3 w-3" />
              </button>
            </div>
          ))}
        </div>
      )}

      {/* Failed photos — per-photo error with retry */}
      {failed.length > 0 && (
        <div className="space-y-1.5">
          {failed.map(f => (
            <div
              key={f.id}
              className="flex items-center gap-2 p-2 rounded-lg bg-destructive/10 border border-destructive/20"
            >
              <AlertTriangle className="h-4 w-4 text-destructive shrink-0" />
              <div className="min-w-0 flex-1">
                <p className="text-[11px] font-medium text-destructive truncate">{f.name}</p>
                <p className="text-[10px] text-destructive/80">{f.reason}. Tap retry or pick another photo.</p>
              </div>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="h-7 px-2 shrink-0"
                onClick={() => retryFailed(f.id)}
                disabled={compressing}
              >
                <RotateCcw className="h-3 w-3 mr-1" />
                Retry
              </Button>
              <button
                type="button"
                onClick={() => dismissFailed(f.id)}
                className="shrink-0 text-destructive/70 hover:text-destructive"
                aria-label="Dismiss"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
          ))}
        </div>
      )}

      {/* Freshness warning */}
      {allFromExisting && (
        <div className="flex items-center gap-2 p-2 rounded-lg bg-amber-500/10 border border-amber-500/20">
          <AlertTriangle className="h-4 w-4 text-amber-500 shrink-0" />
          <p className="text-[10px] text-amber-700 dark:text-amber-400">
            All photos are from existing listings. At least one recent photo is recommended for verification.
          </p>
        </div>
      )}

      {/* Three action buttons */}
      {remaining > 0 && (
        <div className="flex flex-col gap-1.5">
          {compressing ? (
            <Button type="button" variant="outline" size="sm" className="w-full min-h-[44px]" disabled>
              <Loader2 className="h-4 w-4 mr-2 animate-spin" />
              Optimizing...
            </Button>
          ) : (
            <>
              <Button
                type="button"
                variant="default"
                size="sm"
                className="w-full min-h-[44px] bg-primary text-primary-foreground hover:bg-primary/90"
                onClick={() => cameraInputRef.current?.click()}
              >
                <Camera className="h-4 w-4 mr-2" />
                Take Photo
              </Button>
              {!cameraOnly && (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="w-full border-dashed min-h-[44px]"
                  onClick={() => galleryInputRef.current?.click()}
                >
                  <Image className="h-4 w-4 mr-2" />
                  Upload from Gallery
                </Button>
              )}
              {!cameraOnly && region && (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="w-full border-dashed min-h-[44px]"
                  onClick={() => setShowExisting(true)}
                >
                  <FolderOpen className="h-4 w-4 mr-2" />
                  Use Existing Photos
                </Button>
              )}
            </>
          )}
        </div>
      )}

      <p className="text-[10px] text-muted-foreground">
        {cameraOnly
          ? `Take ${minImages > 0 ? `${minImages}–${maxImages}` : `up to ${maxImages}`} photos with your camera · max 5MB each`
          : 'Photos help tenants find your listing · max 5MB each'}
      </p>

      {/* Existing photos dialog */}
      {!cameraOnly && region && (
        <ExistingPropertyPhotosDialog
          open={showExisting}
          onOpenChange={setShowExisting}
          region={region}
          village={village || ''}
          onSelect={handleExistingSelect}
          maxSelectable={remaining}
        />
      )}
    </div>
  );
}

/** Upload images to storage and return public URLs. Images are already optimized client-side. */
export async function uploadHouseImages(
  userId: string,
  listingId: string,
  files: File[],
  thumbnailFiles?: (File | undefined)[]
): Promise<string[]> {
  const urls: string[] = [];

  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    const ext = file.name.split('.').pop() || 'webp';
    const baseName = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const path = `${userId}/${listingId}/${baseName}.${ext}`;

    const { error } = await supabase.storage
      .from('house-images')
      .upload(path, file, { cacheControl: '86400', upsert: false });

    if (error) {
      console.error('Upload error:', error);
      continue;
    }

    // Upload thumbnail alongside
    const thumbFile = thumbnailFiles?.[i];
    if (thumbFile) {
      const thumbExt = thumbFile.name.split('.').pop() || 'webp';
      const thumbPath = `${userId}/${listingId}/thumb_${baseName}.${thumbExt}`;
      await supabase.storage
        .from('house-images')
        .upload(thumbPath, thumbFile, { cacheControl: '86400', upsert: false })
        .catch(e => console.warn('Thumbnail upload failed:', e));
    }

    const { data } = supabase.storage.from('house-images').getPublicUrl(path);
    urls.push(data.publicUrl);
  }

  return urls;
}
