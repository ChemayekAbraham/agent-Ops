import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { ImageLightbox } from '@/components/marketplace/ImageLightbox';
import { formatUGX } from '@/lib/rentCalculations';
import { Home, MapPin, Droplets, Zap, ShieldCheck, Car, Sofa, Image as ImageIcon } from 'lucide-react';

export interface HouseDetailsExtra {
  label: string;
  value: string | null | undefined;
}

interface HouseDetailsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** When present the full listing row is loaded so every field is visible. */
  listingId?: string | null;
  title?: string | null;
  /** Photos already known to the caller (used as-is when no listingId). */
  images?: string[] | null;
  /** Extra rows shown above the listing fields (agent, tenant, plan, etc.). */
  extras?: HouseDetailsExtra[];
}

const LISTING_SELECT =
  'id, title, description, house_category, number_of_rooms, monthly_rent, daily_rate, address, village, sub_county, district, region, latitude, longitude, image_urls, video_url, has_water, has_electricity, has_security, has_parking, is_furnished, amenities, lc1_chairperson_name, lc1_chairperson_phone, lc1_chairperson_village, verified, status, created_at';

/**
 * Full house view — every photo plus every captured detail. Used by the Service
 * Centre vetting queues (houses and tenant rent requests) so a manager reviews
 * exactly what a tenant would later see.
 */
export function HouseDetailsDialog({
  open, onOpenChange, listingId, title, images, extras = [],
}: HouseDetailsDialogProps) {
  const [lightbox, setLightbox] = useState<number | null>(null);

  const { data: listing, isLoading } = useQuery({
    queryKey: ['service-center-house-details', listingId],
    enabled: open && !!listingId,
    staleTime: 60_000,
    queryFn: async () => {
      const { data, error } = await supabase
        .from('house_listings')
        .select(LISTING_SELECT)
        .eq('id', listingId!)
        .maybeSingle();
      if (error) throw new Error(error.message);
      return data as any;
    },
  });

  const photos: string[] = (listing?.image_urls?.length ? listing.image_urls : images) ?? [];
  const heading = listing?.title ?? title ?? 'House details';

  const amenityFlags = [
    { on: listing?.has_water, label: 'Water', Icon: Droplets },
    { on: listing?.has_electricity, label: 'Power', Icon: Zap },
    { on: listing?.has_security, label: 'Security', Icon: ShieldCheck },
    { on: listing?.has_parking, label: 'Parking', Icon: Car },
    { on: listing?.is_furnished, label: 'Furnished', Icon: Sofa },
  ].filter((a) => !!a.on);

  const rows: HouseDetailsExtra[] = [
    ...extras,
    ...(listing
      ? [
          { label: 'Type', value: listing.house_category ? String(listing.house_category).replace(/_/g, ' ') : null },
          { label: 'Rooms', value: listing.number_of_rooms ? String(listing.number_of_rooms) : null },
          { label: 'Monthly rent', value: listing.monthly_rent ? formatUGX(Number(listing.monthly_rent)) : null },
          { label: 'Daily rate', value: listing.daily_rate ? formatUGX(Number(listing.daily_rate)) : null },
          { label: 'Village', value: listing.village },
          { label: 'Sub-county', value: listing.sub_county },
          { label: 'District', value: listing.district },
          { label: 'Region', value: listing.region },
          { label: 'Address', value: listing.address },
          {
            label: 'GPS',
            value: listing.latitude && listing.longitude
              ? `${Number(listing.latitude).toFixed(5)}, ${Number(listing.longitude).toFixed(5)}`
              : 'Not captured',
          },
          { label: 'LC1 chairperson', value: listing.lc1_chairperson_name },
          { label: 'LC1 phone', value: listing.lc1_chairperson_phone },
          { label: 'LC1 village', value: listing.lc1_chairperson_village },
          { label: 'Status', value: listing.status },
          { label: 'Listed on', value: listing.created_at ? new Date(listing.created_at).toLocaleString() : null },
        ]
      : []),
  ].filter((r) => r.value !== null && r.value !== undefined && String(r.value).trim() !== '');

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-base">
            <Home className="h-4 w-4" /> {heading}
          </DialogTitle>
        </DialogHeader>

        {/* Photos — inside and outside shots as submitted */}
        {photos.length === 0 ? (
          <div className="flex h-40 items-center justify-center rounded-lg bg-muted text-xs text-muted-foreground">
            <ImageIcon className="mr-1.5 h-4 w-4" /> No photos submitted for this house
          </div>
        ) : (
          <>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
              {photos.map((url, i) => (
                <button
                  key={`${url}-${i}`}
                  type="button"
                  onClick={() => setLightbox(i)}
                  className="relative h-28 overflow-hidden rounded-lg bg-muted"
                >
                  <img src={url} alt={`${heading} photo ${i + 1}`} loading="lazy" className="h-full w-full object-cover" />
                  <span className="absolute bottom-1 right-1 rounded bg-background/80 px-1 text-[10px] font-medium">
                    {i + 1}/{photos.length}
                  </span>
                </button>
              ))}
            </div>
            <ImageLightbox
              images={photos.map((url, i) => ({ id: String(i), image_url: url }))}
              initialIndex={lightbox ?? 0}
              open={lightbox !== null}
              onClose={() => setLightbox(null)}
              productName={heading}
              memoryKey={`sc-house:${listingId ?? heading}`}
            />
          </>
        )}

        {!!amenityFlags.length && (
          <div className="flex flex-wrap gap-1.5">
            {amenityFlags.map(({ label, Icon }) => (
              <Badge key={label} variant="secondary" className="gap-1 text-[10px]">
                <Icon className="h-3 w-3" /> {label}
              </Badge>
            ))}
          </div>
        )}

        {isLoading && !!listingId ? (
          <div className="space-y-2">
            {[0, 1, 2].map((i) => <Skeleton key={i} className="h-5 w-full" />)}
          </div>
        ) : (
          <dl className="grid gap-x-4 gap-y-1.5 text-xs sm:grid-cols-2">
            {rows.map((r) => (
              <div key={r.label} className="flex justify-between gap-2 border-b border-border/50 py-1">
                <dt className="text-muted-foreground">{r.label}</dt>
                <dd className="text-right font-medium text-foreground break-words">{r.value}</dd>
              </div>
            ))}
          </dl>
        )}

        {listing?.description && (
          <div className="rounded-lg bg-muted/40 p-2.5">
            <p className="mb-1 text-[11px] font-semibold text-foreground">Description</p>
            <p className="text-xs leading-relaxed text-muted-foreground">{listing.description}</p>
          </div>
        )}

        {(listing?.latitude && listing?.longitude) && (
          <a
            href={`https://www.google.com/maps/search/?api=1&query=${listing.latitude},${listing.longitude}`}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 text-xs font-medium text-primary"
          >
            <MapPin className="h-3.5 w-3.5" /> Open location in Google Maps
          </a>
        )}
      </DialogContent>
    </Dialog>
  );
}