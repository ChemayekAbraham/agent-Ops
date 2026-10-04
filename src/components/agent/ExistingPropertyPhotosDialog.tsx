import { useState, useEffect } from 'react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Loader2, ImageIcon, AlertTriangle } from 'lucide-react';
import { supabase } from '@/integrations/supabase/client';
import { toast } from 'sonner';
import type { HouseImageFile } from './HouseImageUploader';

interface ExistingPropertyPhotosDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  region: string;
  village: string;
  onSelect: (images: HouseImageFile[]) => void;
  maxSelectable: number;
}

interface ListingWithPhotos {
  id: string;
  title: string;
  image_urls: string[];
}

export function ExistingPropertyPhotosDialog({
  open,
  onOpenChange,
  region,
  village,
  onSelect,
  maxSelectable,
}: ExistingPropertyPhotosDialogProps) {
  const [listings, setListings] = useState<ListingWithPhotos[]>([]);
  const [loading, setLoading] = useState(false);
  const [selectedUrls, setSelectedUrls] = useState<Set<string>>(new Set());
  const [importing, setImporting] = useState(false);
  const [confirmed, setConfirmed] = useState(false);

  useEffect(() => {
    if (!open || !region) return;
    setSelectedUrls(new Set());
    setConfirmed(false);
    fetchListings();
  }, [open, region, village]);

  const fetchListings = async () => {
    setLoading(true);
    try {
      let query = supabase
        .from('house_listings')
        .select('id, title, image_urls')
        .eq('region', region)
        .not('image_urls', 'is', null)
        .limit(20);

      if (village) {
        query = query.ilike('village', `%${village}%`);
      }

      const { data, error } = await query;
      if (error) throw error;

      const filtered = (data || []).filter(
        (l: any) => l.image_urls && Array.isArray(l.image_urls) && l.image_urls.length > 0
      ) as ListingWithPhotos[];

      setListings(filtered);
    } catch (err: any) {
      console.error('Failed to fetch existing photos:', err);
      toast.error('Failed to load existing photos');
    } finally {
      setLoading(false);
    }
  };

  const toggleUrl = (url: string) => {
    setSelectedUrls(prev => {
      const next = new Set(prev);
      if (next.has(url)) {
        next.delete(url);
      } else if (next.size < maxSelectable) {
        next.add(url);
      } else {
        toast.error(`You can select up to ${maxSelectable} photos`);
      }
      return next;
    });
  };

  const handleImport = async () => {
    if (!confirmed) {
      toast.error('Please confirm the photos represent the current state');
      return;
    }
    setImporting(true);
    const images: HouseImageFile[] = [];

    for (const url of selectedUrls) {
      try {
        const response = await fetch(url);
        const blob = await response.blob();
        const ext = url.split('.').pop()?.split('?')[0] || 'jpg';
        const file = new File([blob], `existing-${Date.now()}.${ext}`, { type: blob.type || 'image/jpeg' });
        images.push({
          id: `img-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          previewUrl: URL.createObjectURL(blob),
          file,
          source: 'existing',
        });
      } catch (err) {
        console.warn('Failed to fetch image:', url, err);
      }
    }

    if (images.length > 0) {
      onSelect(images);
      toast.success(`${images.length} photo(s) added from existing listings`);
    }
    onOpenChange(false);
    setImporting(false);
  };

  const totalPhotos = listings.reduce((sum, l) => sum + l.image_urls.length, 0);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg max-h-[80vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ImageIcon className="h-5 w-5 text-primary" />
            Existing Property Photos
          </DialogTitle>
          <DialogDescription>
            Select photos from other listings in {region}{village ? `, ${village}` : ''}
          </DialogDescription>
        </DialogHeader>

        {loading ? (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
          </div>
        ) : listings.length === 0 ? (
          <div className="text-center py-8 text-muted-foreground text-sm">
            No existing photos found for this area
          </div>
        ) : (
          <div className="space-y-4">
            <p className="text-xs text-muted-foreground">
              {totalPhotos} photo(s) from {listings.length} listing(s) · Select up to {maxSelectable}
            </p>

            {listings.map(listing => (
              <div key={listing.id} className="space-y-2">
                <p className="text-xs font-medium text-foreground truncate">{listing.title}</p>
                <div className="grid grid-cols-3 gap-2">
                  {listing.image_urls.map((url, idx) => {
                    const isSelected = selectedUrls.has(url);
                    return (
                      <button
                        key={`${listing.id}-${idx}`}
                        type="button"
                        onClick={() => toggleUrl(url)}
                        className={`relative aspect-square rounded-lg overflow-hidden border-2 transition-colors ${
                          isSelected ? 'border-primary ring-2 ring-primary/30' : 'border-border hover:border-primary/50'
                        }`}
                      >
                        <img src={url} alt="" className="w-full h-full object-cover" loading="lazy" />
                        {isSelected && (
                          <div className="absolute top-1 right-1 bg-primary text-primary-foreground rounded-full w-5 h-5 flex items-center justify-center text-xs font-bold">
                            ✓
                          </div>
                        )}
                      </button>
                    );
                  })}
                </div>
              </div>
            ))}

            {selectedUrls.size > 0 && (
              <div className="space-y-3 pt-2 border-t border-border">
                <div className="flex items-start gap-2 p-3 rounded-lg bg-amber-500/10 border border-amber-500/20">
                  <AlertTriangle className="h-4 w-4 text-amber-500 mt-0.5 shrink-0" />
                  <div className="space-y-2">
                    <p className="text-xs text-amber-700 dark:text-amber-400">
                      Please confirm these photos accurately represent the <strong>current state</strong> of the property.
                    </p>
                    <label className="flex items-center gap-2 cursor-pointer">
                      <Checkbox checked={confirmed} onCheckedChange={v => setConfirmed(!!v)} />
                      <span className="text-xs font-medium">I confirm these photos are accurate</span>
                    </label>
                  </div>
                </div>
              </div>
            )}
          </div>
        )}

        <DialogFooter className="flex gap-2">
          <Button variant="outline" size="sm" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            size="sm"
            onClick={handleImport}
            disabled={selectedUrls.size === 0 || !confirmed || importing}
          >
            {importing ? (
              <>
                <Loader2 className="h-4 w-4 mr-1 animate-spin" />
                Importing...
              </>
            ) : (
              `Add ${selectedUrls.size} Photo(s)`
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
