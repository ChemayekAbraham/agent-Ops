import { useEffect, useState } from 'react';
import {
  Home,
  MapPin,
  Phone,
  MessageSquare,
  Navigation,
  ShieldCheck,
  Users,
  ImageIcon,
  ChevronLeft,
  ChevronRight,
  Check,
  Loader2,
} from 'lucide-react';

import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from '@/components/ui/sheet';
import { Dialog, DialogContent } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { formatUGX } from '@/lib/rentCalculations';
import { prettyName, formatHouseCategory } from '@/lib/formatting';
import { useRelatedHouses } from '@/hooks/useRelatedHouses';

export interface HouseOpportunity {
  house_id: string;
  title: string | null;
  house_category: string | null;
  monthly_rent: number;
  district: string | null;
  sub_county: string | null;
  village: string | null;
  region: string | null;
  number_of_rooms: number | null;
  verified: boolean;
  listing_agent_id: string | null;
  listing_agent_name: string | null;
  image_url?: string | null;
  image_urls?: string[] | null;
  latitude?: number | null;
  longitude?: number | null;
  landlord_id?: string | null;
  landlord_name?: string | null;
  landlord_phone?: string | null;
  distance_km?: number | null;
  created_at?: string | null;
  partner_monthly_return: number;
  partner_annual_return: number;
}

export const houseHasGps = (h: HouseOpportunity) =>
  typeof h.latitude === 'number' && typeof h.longitude === 'number' && (h.latitude !== 0 || h.longitude !== 0);

export const houseMapsUrl = (h: HouseOpportunity) =>
  `https://www.google.com/maps/search/?api=1&query=${h.latitude},${h.longitude}`;

export const housePlace = (h: HouseOpportunity) =>
  [h.village, h.sub_county, h.district].filter(Boolean).join(', ') || h.region || 'Location on file';

const photosOf = (h: HouseOpportunity) =>
  h.image_urls && h.image_urls.length ? h.image_urls : h.image_url ? [h.image_url] : [];

/**
 * Full detail view for one empty house: photo gallery, landlord name and
 * contact, GPS map preview and the 15% monthly return the partner earns.
 */
export function EmptyHouseDetailSheet({
  house,
  open,
  onOpenChange,
  isPicked,
  onTogglePick,
  isPartner = false,
  remaining,
  onRelatedHouseClick,
}: {
  house: HouseOpportunity | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  isPicked?: boolean;
  onTogglePick?: (house: HouseOpportunity) => void;
  isPartner?: boolean;
  /** Supporter balance still free to commit — drives the funding requirement block. */
  remaining?: number;
  onRelatedHouseClick?: (house: HouseOpportunity) => void;
}) {
  const [index, setIndex] = useState(0);
  const [lightboxOpen, setLightboxOpen] = useState(false);

  const {
    data: related,
    isLoading: relatedLoading,
    error: relatedError,
  } = useRelatedHouses(house);

  useEffect(() => {
    setIndex(0);
    // When the user taps a related house, start them at the top of the new details.
    const sheet = document.querySelector('.app-sheet-content');
    if (sheet) sheet.scrollTo(0, 0);
  }, [house?.house_id]);

  if (!house) return null;

  const photos = photosOf(house);
  const gps = houseHasGps(house);
  const active = photos[Math.min(index, Math.max(photos.length - 1, 0))];

  return (
    <>
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="bottom"
        className="z-[1350] max-h-[90vh] gap-0 overflow-y-auto rounded-t-2xl p-0 sm:left-1/2 sm:w-[26rem] sm:-translate-x-1/2 sm:rounded-t-2xl"
        overlayClassName="z-[1260]"
      >
        <SheetHeader className="border-b p-4 text-left">
          <SheetTitle className="flex items-center gap-2 text-base">
            <Home className="h-4 w-4 text-primary" />
            {house.title || formatHouseCategory(house.house_category) || 'Empty house'}
          </SheetTitle>
          <SheetDescription className="flex items-center gap-1 text-[11px]">
            <MapPin className="h-3 w-3 shrink-0" /> {housePlace(house)}
          </SheetDescription>
        </SheetHeader>

        <div className="space-y-4 p-4 pb-28">
          {/* Gallery */}
          {photos.length > 0 ? (
            <div className="space-y-2">
              <div className="relative overflow-hidden rounded-2xl bg-muted">
                <button
                  type="button"
                  onClick={() => setLightboxOpen(true)}
                  className="block w-full cursor-zoom-in"
                  aria-label="View full photo"
                >
                  <img
                    src={active}
                    alt={`${house.title || 'Empty house'} photo ${index + 1}`}
                    loading="lazy"
                    className="h-56 w-full object-cover"
                  />
                </button>
                {photos.length > 1 && (
                  <>
                    <Button
                      size="icon"
                      variant="secondary"
                      className="absolute left-2 top-1/2 h-8 w-8 -translate-y-1/2 rounded-full opacity-90"
                      onClick={() => setIndex((i) => (i - 1 + photos.length) % photos.length)}
                      aria-label="Previous photo"
                    >
                      <ChevronLeft className="h-4 w-4" />
                    </Button>
                    <Button
                      size="icon"
                      variant="secondary"
                      className="absolute right-2 top-1/2 h-8 w-8 -translate-y-1/2 rounded-full opacity-90"
                      onClick={() => setIndex((i) => (i + 1) % photos.length)}
                      aria-label="Next photo"
                    >
                      <ChevronRight className="h-4 w-4" />
                    </Button>
                    <span className="absolute bottom-2 right-2 rounded-full bg-background/85 px-2 py-0.5 text-[10px] font-semibold">
                      {index + 1} / {photos.length}
                    </span>
                  </>
                )}
              </div>
              {photos.length > 1 && (
                <div className="flex gap-1.5 overflow-x-auto">
                  {photos.map((src, i) => (
                    <button
                      key={`${house.house_id}-thumb-${i}`}
                      type="button"
                      onClick={() => setIndex(i)}
                      className={`h-14 w-20 shrink-0 overflow-hidden rounded-lg border-2 ${
                        i === index ? 'border-primary' : 'border-transparent'
                      }`}
                    >
                      <img src={src} alt={`Thumbnail ${i + 1}`} loading="lazy" className="h-full w-full object-cover" />
                    </button>
                  ))}
                </div>
              )}
            </div>
          ) : (
            <div className="flex h-40 items-center justify-center gap-2 rounded-2xl bg-muted text-xs text-muted-foreground">
              <ImageIcon className="h-4 w-4" /> No photo on file
            </div>
          )}

          {/* Money */}
          <div className="rounded-2xl border border-emerald-500/20 bg-emerald-500/5 p-4">
            <div className="grid grid-cols-2 gap-3">
              <div>
                <p className="text-[10px] font-bold uppercase tracking-wide text-muted-foreground">Monthly rent</p>
                <p className="text-base font-black">{formatUGX(house.monthly_rent)}</p>
              </div>
              <div>
                <p className="text-[10px] font-bold uppercase tracking-wide text-muted-foreground">
                  {isPartner ? 'You earn' : 'Partner earns'}
                </p>
                <p className="text-base font-black text-emerald-600">
                  {formatUGX(house.partner_monthly_return)}/mo
                </p>
              </div>
            </div>
            <p className="mt-2 text-[11px] leading-snug text-muted-foreground">
              15% of the rent every month for 12 months —{' '}
              <span className="font-semibold text-foreground">{formatUGX(house.partner_annual_return)}</span> in total.
            </p>
          </div>

          {/* Supporter opportunity summary — tenant status, terms, requirement, earnings */}
          {isPartner && (
            <div className="space-y-3 rounded-2xl border p-4">
              <p className="text-xs font-bold">Before you select this house</p>

              <div className="space-y-1.5">
                <p className="text-[10px] font-bold uppercase tracking-wide text-muted-foreground">Tenant status</p>
                <p className="flex items-start gap-1.5 text-[12px] leading-snug">
                  <Users className="mt-0.5 h-3.5 w-3.5 shrink-0 text-primary" />
                  <span>
                    Empty — no tenant yet. Once you fund it, a Welile agent is notified and places a
                    tenant within 7 days. You start earning Returns as soon as the tenant begins paying rent.
                  </span>
                </p>
              </div>

              <div className="space-y-1.5 border-t pt-3">
                <p className="text-[10px] font-bold uppercase tracking-wide text-muted-foreground">Rent terms</p>
                <div className="space-y-1 text-[12px]">
                  <div className="flex items-center justify-between">
                    <span className="text-muted-foreground">Monthly rent</span>
                    <span className="font-semibold">{formatUGX(house.monthly_rent)}</span>
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-muted-foreground">Rent Plan length</span>
                    <span className="font-semibold">12 months</span>
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-muted-foreground">Rent collection</span>
                    <span className="font-semibold">Welile collects monthly</span>
                  </div>
                </div>
              </div>

              <div className="space-y-1.5 border-t pt-3">
                <p className="text-[10px] font-bold uppercase tracking-wide text-muted-foreground">
                  What you need to fund it
                </p>
                <div className="space-y-1 text-[12px]">
                  <div className="flex items-center justify-between">
                    <span className="text-muted-foreground">Your contribution</span>
                    <span className="font-semibold">{formatUGX(house.monthly_rent)}</span>
                  </div>
                  {typeof remaining === 'number' && (
                    <>
                      <div className="flex items-center justify-between">
                        <span className="text-muted-foreground">Balance available</span>
                        <span className="font-semibold">{formatUGX(Math.max(0, remaining))}</span>
                      </div>
                      {Number(house.monthly_rent || 0) > remaining ? (
                        <div className="flex items-center justify-between">
                          <span className="text-muted-foreground">Top-up needed</span>
                          <span className="font-bold text-amber-600">
                            {formatUGX(Math.max(0, Number(house.monthly_rent || 0) - remaining))}
                          </span>
                        </div>
                      ) : (
                        <Badge
                          variant="outline"
                          className="h-5 gap-1 border-emerald-500/30 bg-emerald-500/10 text-[10px] text-emerald-600"
                        >
                          <ShieldCheck className="h-3 w-3" /> Ready to fund now
                        </Badge>
                      )}
                    </>
                  )}
                </div>
              </div>

              <div className="space-y-1.5 border-t pt-3">
                <p className="text-[10px] font-bold uppercase tracking-wide text-muted-foreground">
                  Expected earnings
                </p>
                <div className="space-y-1 text-[12px]">
                  <div className="flex items-center justify-between">
                    <span className="text-muted-foreground">Returns each month (15%)</span>
                    <span className="font-black text-emerald-600">{formatUGX(house.partner_monthly_return)}</span>
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-muted-foreground">Total over 12 months</span>
                    <span className="font-bold">{formatUGX(house.partner_annual_return)}</span>
                  </div>
                </div>
                <p className="text-[10px] leading-snug text-muted-foreground">
                  Returns each month = your contribution × 15%. Total = that amount × 12 months.
                </p>
              </div>
            </div>
          )}



          {/* House facts */}
          <div className="rounded-2xl border p-4 space-y-2 text-[12px]">
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground">Type</span>
              <span className="font-semibold">{formatHouseCategory(house.house_category) || 'Not stated'}</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground">Rooms</span>
              <span className="font-semibold">{house.number_of_rooms ?? 'Not stated'}</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground">Status</span>
              {house.verified ? (
                <Badge variant="outline" className="h-5 gap-1 border-emerald-500/30 bg-emerald-500/10 text-[10px] text-emerald-600">
                  <ShieldCheck className="h-3 w-3" /> Verified
                </Badge>
              ) : (
                <span className="font-semibold">Pending verification</span>
              )}
            </div>
            {house.listing_agent_name && (
              <p className="flex items-start gap-1.5 pt-1 text-[11px] text-muted-foreground">
                <Users className="mt-0.5 h-3 w-3 shrink-0" />
                {house.listing_agent_name} places the tenant once this note is fulfilled.
              </p>
            )}
          </div>

          {/* Landlord */}
          <div className="rounded-2xl border border-primary/15 bg-primary/5 p-4 space-y-2.5">
            <p className="text-[10px] font-bold uppercase tracking-wide text-primary/80">Landlord</p>
            <p className="text-base font-bold leading-tight">{house.landlord_name || 'Name not on file'}</p>
            {house.landlord_phone && (
              <p className="text-sm font-medium text-primary">{house.landlord_phone}</p>
            )}
            {house.landlord_phone ? (
              <div className="grid grid-cols-2 gap-2">
                <Button asChild variant="outline" size="sm" className="h-10 gap-1.5 text-[12px]">
                  <a href={`tel:${house.landlord_phone}`}>
                    <Phone className="h-3.5 w-3.5" /> Call
                  </a>
                </Button>
                <Button asChild variant="secondary" size="sm" className="h-10 gap-1.5 text-[12px]">
                  <a href={`sms:${house.landlord_phone}`}>
                    <MessageSquare className="h-3.5 w-3.5" /> Message
                  </a>
                </Button>
              </div>
            ) : (
              <p className="text-[11px] text-muted-foreground">No contact on file.</p>
            )}
          </div>

          {/* Map */}
          <div className="rounded-2xl border p-4 space-y-2">
            <p className="text-xs font-bold">GPS location</p>
            {gps ? (
              <>
                <div className="relative overflow-hidden rounded-xl border">
                  <iframe
                    title={`Map for ${house.title || 'empty house'}`}
                    src={`https://www.google.com/maps?q=${house.latitude},${house.longitude}&z=15&output=embed`}
                    loading="lazy"
                    referrerPolicy="no-referrer-when-downgrade"
                    className="h-48 w-full border-0"
                  />
                </div>
                <div className="flex items-center justify-between gap-2">
                  <span className="text-[10px] text-muted-foreground">
                    {Number(house.latitude).toFixed(5)}, {Number(house.longitude).toFixed(5)}
                  </span>
                  <Button asChild variant="outline" size="sm" className="h-8 gap-1 text-[11px]">
                    <a href={houseMapsUrl(house)} target="_blank" rel="noopener noreferrer">
                      <Navigation className="h-3 w-3" /> Open in Maps
                    </a>
                  </Button>
                </div>
              </>
            ) : (
              <p className="text-[11px] text-muted-foreground">
                No GPS captured for this house yet. Use the location details above.
              </p>
            )}
          </div>
        </div>

        {/* Related houses in the same district */}
        <div className="space-y-3 border-t p-4">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-xs font-bold">Related houses</p>
              <p className="text-[10px] text-muted-foreground">
                {house.district ? `${prettyName(house.district)} district` : 'Same district'}
              </p>
            </div>
            {related && related.length > 0 && (
              <Badge variant="outline" className="h-5 text-[10px]">
                {related.length}
              </Badge>
            )}
          </div>

          {relatedLoading && (
            <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              Finding houses in this district…
            </div>
          )}

          {relatedError && !relatedLoading && (
            <p className="text-[11px] text-muted-foreground">Could not load related houses.</p>
          )}

          {!relatedLoading && related && related.length === 0 && (
            <p className="text-[11px] text-muted-foreground">
              No other empty houses found in this district yet.
            </p>
          )}


          {related && related.length > 0 && (
            <div className="flex gap-3 overflow-x-auto pb-1 -mx-4 px-4 snap-x">
              {related.map((relatedHouse) => (
                <button
                  key={relatedHouse.house_id}
                  type="button"
                  onClick={() => onRelatedHouseClick?.(relatedHouse)}
                  disabled={!onRelatedHouseClick}
                  className={`relative flex w-44 shrink-0 snap-start flex-col overflow-hidden rounded-xl border bg-background text-left transition-colors ${
                    onRelatedHouseClick
                      ? 'cursor-pointer hover:border-primary/60'
                      : 'cursor-default'
                  }`}
                >
                  <div className="h-24 w-full bg-muted">
                    {relatedHouse.image_url ? (
                      <img
                        src={relatedHouse.image_url}
                        alt=""
                        loading="lazy"
                        className="h-full w-full object-cover"
                      />
                    ) : (
                      <div className="flex h-full w-full items-center justify-center text-muted-foreground">
                        <Home className="h-5 w-5" />
                      </div>
                    )}
                  </div>
                  <div className="space-y-1 p-2.5">
                    <p className="truncate text-[11px] font-bold">
                      {formatHouseCategory(relatedHouse.house_category)}
                    </p>
                    <p className="text-[11px] font-black text-emerald-600">
                      {formatUGX(relatedHouse.monthly_rent)}/mo
                    </p>
                    <p className="flex items-center gap-1 truncate text-[10px] text-muted-foreground">
                      <MapPin className="h-3 w-3 shrink-0" />
                      {relatedHouse.distance_km != null
                        ? `${relatedHouse.distance_km.toFixed(1)} km away`
                        : [relatedHouse.village, relatedHouse.sub_county, relatedHouse.district]
                            .filter(Boolean)
                            .join(', ') || 'Nearby'}
                    </p>
                  </div>
                  {onRelatedHouseClick && (
                    <div className="absolute right-2 top-2 rounded-full bg-background/90 p-1 shadow-sm">
                      <ChevronRight className="h-3.5 w-3.5 text-primary" />
                    </div>
                  )}
                </button>
              ))}
            </div>
          )}
        </div>

        {onTogglePick && (
          <div className="sticky bottom-0 border-t bg-background p-4">
            <Button
              className="h-11 w-full gap-2 font-semibold"
              variant={isPicked ? 'outline' : 'default'}
              onClick={() => onTogglePick(house)}
            >
              {isPicked ? (
                <>
                  <Check className="h-4 w-4" /> Selected — tap to remove
                </>
              ) : (
                'Select this house'
              )}
            </Button>
          </div>
        )}
      </SheetContent>
    </Sheet>

    {/* Full-screen photo viewer — sits above the detail sheet (z-[1350]) */}
    <Dialog open={lightboxOpen} onOpenChange={setLightboxOpen}>
      <DialogContent
        className="z-[1450] flex h-[100dvh] w-full max-w-none flex-col items-center justify-center gap-0 border-0 bg-black/95 p-0 sm:rounded-none"
        overlayClassName="z-[1400] bg-black/90"
      >
        <img
          src={active}
          alt={`${house.title || 'Empty house'} photo ${index + 1}`}
          className="max-h-[100dvh] max-w-full object-contain"
        />
        {photos.length > 1 && (
          <>
            <Button
              size="icon"
              variant="secondary"
              className="absolute left-3 top-1/2 h-11 w-11 -translate-y-1/2 rounded-full opacity-90"
              onClick={() => setIndex((i) => (i - 1 + photos.length) % photos.length)}
              aria-label="Previous photo"
            >
              <ChevronLeft className="h-5 w-5" />
            </Button>
            <Button
              size="icon"
              variant="secondary"
              className="absolute right-3 top-1/2 h-11 w-11 -translate-y-1/2 rounded-full opacity-90"
              onClick={() => setIndex((i) => (i + 1) % photos.length)}
              aria-label="Next photo"
            >
              <ChevronRight className="h-5 w-5" />
            </Button>
            <span className="absolute bottom-5 left-1/2 -translate-x-1/2 rounded-full bg-background/85 px-3 py-1 text-xs font-semibold">
              {index + 1} / {photos.length}
            </span>
          </>
        )}
      </DialogContent>
    </Dialog>
    </>
  );
}

export default EmptyHouseDetailSheet;
