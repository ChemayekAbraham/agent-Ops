import { useState } from 'react';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { supabase } from '@/integrations/supabase/client';
import { HouseImageUploader, uploadHouseImages, type HouseImageFile } from '@/components/agent/HouseImageUploader';
import { useQueryClient } from '@tanstack/react-query';
import { useAuth } from '@/hooks/useAuth';

interface Props {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  listingId: string;
  listingTitle: string;
  existingUrls: string[];
  region?: string;
  district?: string;
  village?: string;
  /** Query keys to invalidate after a successful upload. */
  invalidateKeys?: (string | undefined | null)[][];
}

const MAX_TOTAL = 10;

export function ListingPhotoUploadDialog({
  open, onOpenChange, listingId, listingTitle, existingUrls,
  region, district, village, invalidateKeys = [],
}: Props) {
  const qc = useQueryClient();
  const { user } = useAuth();
  const [images, setImages] = useState<HouseImageFile[]>([]);
  const [saving, setSaving] = useState(false);

  const remaining = Math.max(0, MAX_TOTAL - existingUrls.length);

  const handleClose = (v: boolean) => {
    if (saving) return;
    if (!v) {
      images.forEach(i => URL.revokeObjectURL(i.previewUrl));
      setImages([]);
    }
    onOpenChange(v);
  };

  const handleSave = async () => {
    if (!user?.id) { toast.error('Not signed in'); return; }
    if (images.length === 0) { toast.error('Add at least one photo'); return; }
    setSaving(true);
    try {
      const files = images.map(i => i.file);
      const thumbs = images.map(i => i.thumbnailFile);
      const newUrls = await uploadHouseImages(user.id, listingId, files, thumbs);
      if (newUrls.length === 0) throw new Error('Upload failed');

      const merged = [...existingUrls, ...newUrls];
      const { error } = await supabase
        .from('house_listings')
        .update({ image_urls: merged })
        .eq('id', listingId);
      if (error) throw error;

      toast.success(`${newUrls.length} photo(s) added`);
      invalidateKeys.forEach(k => qc.invalidateQueries({ queryKey: k as any }));
      images.forEach(i => URL.revokeObjectURL(i.previewUrl));
      setImages([]);
      onOpenChange(false);
    } catch (e: any) {
      console.error('Listing photo upload failed:', e);
      toast.error(e.message ?? 'Upload failed');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="sm:max-w-md max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="text-base truncate">Add photos · {listingTitle}</DialogTitle>
          <DialogDescription className="text-xs">
            {existingUrls.length} existing · up to {MAX_TOTAL} total · {remaining} slot(s) left
          </DialogDescription>
        </DialogHeader>

        {remaining === 0 ? (
          <p className="text-xs text-muted-foreground py-4 text-center">
            This listing already has the maximum of {MAX_TOTAL} photos. Remove some before adding more.
          </p>
        ) : (
          <HouseImageUploader
            images={images}
            onChange={setImages}
            maxImages={remaining}
            region={region}
            district={district}
            village={village}
          />
        )}

        <DialogFooter className="flex gap-2">
          <Button variant="outline" size="sm" onClick={() => handleClose(false)} disabled={saving}>
            Cancel
          </Button>
          <Button size="sm" onClick={handleSave} disabled={saving || images.length === 0}>
            {saving ? (
              <><Loader2 className="h-4 w-4 mr-1 animate-spin" />Uploading…</>
            ) : (
              `Save ${images.length || ''} photo(s)`.trim()
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}