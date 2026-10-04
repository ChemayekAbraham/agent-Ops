import { useRef, useState } from 'react';
import { StorageImage } from '@/components/ui/StorageImage';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import {
  ImagePlus, Loader2, Star, Trash2, ChevronLeft, ChevronRight, Image as ImageIcon, Camera,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { toast } from 'sonner';
import { useListingPhotos, useListingPhotoActions, type ListingPhoto } from '@/hooks/useListingPhotos';

/**
 * Airbnb/Booking.com-style photo manager for a single listing.
 * Lazy-loaded thumbnail strip + add (camera/gallery), set cover, reorder, delete, lightbox.
 */
export function ListingPhotoGallery({ listingId, enabled = true }: { listingId: string; enabled?: boolean }) {
  const { data: photos, isLoading } = useListingPhotos(listingId, enabled);
  const { upload, remove, setCover, swap } = useListingPhotoActions(listingId);
  const cameraRef = useRef<HTMLInputElement>(null);
  const galleryRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState<'upload' | string | null>(null);
  const [lightbox, setLightbox] = useState<number | null>(null);

  const list: ListingPhoto[] = photos ?? [];

  const handleFiles = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || []);
    e.target.value = '';
    if (!files.length) return;
    setBusy('upload');
    try {
      await upload(files);
      toast.success(`${files.length} photo${files.length === 1 ? '' : 's'} added`);
    } catch (err: any) {
      toast.error(err?.message || 'Upload failed');
    } finally {
      setBusy(null);
    }
  };

  const act = async (id: string, fn: () => Promise<void>, ok: string) => {
    setBusy(id);
    try { await fn(); toast.success(ok); }
    catch (err: any) { toast.error(err?.message || 'Action failed'); }
    finally { setBusy(null); }
  };

  return (
    <div className="mt-2 rounded-lg border border-border/60 bg-muted/20 p-2">
      <div className="flex items-center justify-between mb-1.5">
        <span className="flex items-center gap-1 text-[11px] font-semibold text-muted-foreground">
          <ImageIcon className="h-3.5 w-3.5" /> Photos {list.length > 0 && `(${list.length})`}
        </span>
        <div className="flex items-center gap-1">
          <input ref={cameraRef} type="file" accept="image/*" capture="environment" onChange={handleFiles} className="hidden" />
          <input ref={galleryRef} type="file" accept="image/*" multiple onChange={handleFiles} className="hidden" />
          <Button variant="outline" size="sm" className="h-6 px-2 text-[10px] gap-1" disabled={busy === 'upload'} onClick={() => cameraRef.current?.click()}>
            {busy === 'upload' ? <Loader2 className="h-3 w-3 animate-spin" /> : <Camera className="h-3 w-3" />} Take
          </Button>
          <Button variant="outline" size="sm" className="h-6 px-2 text-[10px] gap-1" disabled={busy === 'upload'} onClick={() => galleryRef.current?.click()}>
            <ImagePlus className="h-3 w-3" /> Add
          </Button>
        </div>
      </div>

      {isLoading ? (
        <div className="flex gap-2 overflow-x-auto pb-1">
          {Array.from({ length: 3 }).map((_, i) => <div key={i} className="h-20 w-20 shrink-0 rounded-md bg-muted animate-pulse" />)}
        </div>
      ) : list.length === 0 ? (
        <p className="text-[10px] text-muted-foreground py-2 text-center">No photos yet — add some so tenants can see this house.</p>
      ) : (
        <div className="flex gap-2 overflow-x-auto pb-1 snap-x">
          {list.map((p, i) => {
            const isBusy = busy === p.id;
            return (
              <div key={p.id} className={cn('relative shrink-0 w-20 h-20 rounded-md overflow-hidden border snap-start', p.is_cover ? 'border-primary ring-1 ring-primary/40' : 'border-border')}>
                <button type="button" onClick={() => setLightbox(i)} className="block w-full h-full">
                  <StorageImage
                    src={p.storage_path}
                    alt={`Listing photo ${i + 1}`}
                    loading="lazy"
                    className="w-full h-full object-cover"
                    fallback={<div className="w-full h-full flex items-center justify-center bg-muted"><ImageIcon className="h-4 w-4 text-muted-foreground" /></div>}
                  />
                </button>
                {p.is_cover && (
                  <span className="absolute top-0.5 left-0.5 bg-primary text-primary-foreground rounded px-1 text-[8px] font-bold flex items-center gap-0.5">
                    <Star className="h-2 w-2 fill-current" /> Cover
                  </span>
                )}
                {isBusy && <div className="absolute inset-0 bg-background/60 flex items-center justify-center"><Loader2 className="h-4 w-4 animate-spin" /></div>}
                <div className="absolute bottom-0 inset-x-0 flex items-stretch bg-background/80 backdrop-blur-sm">
                  <button type="button" title="Move left" disabled={i === 0 || isBusy}
                    onClick={() => act(p.id, () => swap(p, list[i - 1]), 'Reordered')}
                    className="flex-1 py-0.5 disabled:opacity-30 hover:bg-muted flex items-center justify-center"><ChevronLeft className="h-3 w-3" /></button>
                  {!p.is_cover && (
                    <button type="button" title="Set as cover" disabled={isBusy}
                      onClick={() => act(p.id, () => setCover(p.id), 'Cover photo set')}
                      className="flex-1 py-0.5 hover:bg-muted flex items-center justify-center"><Star className="h-3 w-3" /></button>
                  )}
                  <button type="button" title="Delete" disabled={isBusy}
                    onClick={() => act(p.id, () => remove(p.id), 'Photo removed')}
                    className="flex-1 py-0.5 hover:bg-destructive/10 text-destructive flex items-center justify-center"><Trash2 className="h-3 w-3" /></button>
                  <button type="button" title="Move right" disabled={i === list.length - 1 || isBusy}
                    onClick={() => act(p.id, () => swap(p, list[i + 1]), 'Reordered')}
                    className="flex-1 py-0.5 disabled:opacity-30 hover:bg-muted flex items-center justify-center"><ChevronRight className="h-3 w-3" /></button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      <Dialog open={lightbox !== null} onOpenChange={(v) => { if (!v) setLightbox(null); }}>
        <DialogContent className="max-w-3xl p-2 gap-0">
          {lightbox !== null && list[lightbox] && (
            <div className="relative">
              <StorageImage src={list[lightbox].storage_path} alt="Listing photo" className="w-full max-h-[75vh] object-contain rounded-md" />
              {list.length > 1 && (
                <>
                  <button type="button" onClick={() => setLightbox((lightbox - 1 + list.length) % list.length)}
                    className="absolute left-2 top-1/2 -translate-y-1/2 bg-background/80 rounded-full p-1.5 hover:bg-background"><ChevronLeft className="h-5 w-5" /></button>
                  <button type="button" onClick={() => setLightbox((lightbox + 1) % list.length)}
                    className="absolute right-2 top-1/2 -translate-y-1/2 bg-background/80 rounded-full p-1.5 hover:bg-background"><ChevronRight className="h-5 w-5" /></button>
                  <span className="absolute bottom-2 left-1/2 -translate-x-1/2 bg-background/80 rounded-full px-2 py-0.5 text-[11px] font-medium">{lightbox + 1} / {list.length}</span>
                </>
              )}
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}