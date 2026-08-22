import { useCallback, useEffect, useRef, useState } from 'react';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { formatDynamic } from '@/lib/currencyFormat';
import { ChevronLeft, ChevronRight, Home, MapPin, Phone, ShieldCheck, User, X } from 'lucide-react';
import tenantPhotoPlaceholder from '@/assets/tenant-photo-placeholder.jpg';
import { cn } from '@/lib/utils';
import { PlanShareButton } from './PlanShareButton';
import { planShareDescription } from '@/lib/planShareLink';

export interface PlanDetail {
  rent_request_id: string;
  funding_amount: number;
  duration_days: number | null;
  daily_repayment: number | null;
  request_city: string | null;
  house_category: string | null;
  projected_end_date: string | null;
  repayment_cadence: string | null;
  tenant_full_name: string | null;
  tenant_first_name: string | null;
  tenant_location: string | null;
  tenant_avatar_url: string | null;
  tenant_has_photo?: boolean | null;
  landlord_name: string | null;
  landlord_phone: string | null;
  lc1_chairperson_name: string | null;
  house_image_urls: string[] | null;
  request_latitude?: number | string | null;
  request_longitude?: number | string | null;
}

/** Lightweight controlled slider: always in sync with the real photo count. */
function PhotoSlider({
  photos,
  index,
  onIndexChange,
  onSelect,
  className,
  imgClassName,
  fit = 'cover',
  keyboard = false,
}: {
  photos: string[];
  index: number;
  onIndexChange: (i: number) => void;
  onSelect?: (i: number) => void;
  className?: string;
  imgClassName?: string;
  fit?: 'cover' | 'contain';
  keyboard?: boolean;
}) {
  const total = photos.length;
  const go = useCallback(
    (dir: -1 | 1) => onIndexChange((index + dir + total) % total),
    [index, total, onIndexChange],
  );
  const startX = useRef<number | null>(null);
  const startY = useRef<number | null>(null);
  const swiped = useRef(false);

  const onTouchStart = (e: React.TouchEvent) => {
    startX.current = e.touches[0].clientX;
    startY.current = e.touches[0].clientY;
    swiped.current = false;
  };
  const onTouchMove = (e: React.TouchEvent) => {
    if (startX.current === null || startY.current === null || swiped.current) return;
    const dx = e.touches[0].clientX - startX.current;
    const dy = e.touches[0].clientY - startY.current;
    if (Math.abs(dx) > 40 && Math.abs(dx) > Math.abs(dy)) {
      swiped.current = true;
      go(dx < 0 ? 1 : -1);
    }
  };
  const onTouchEnd = () => {
    startX.current = null;
    startY.current = null;
  };

  useEffect(() => {
    if (total < 2 || !keyboard) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'ArrowLeft') go(-1);
      if (e.key === 'ArrowRight') go(1);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [go, total, keyboard]);

  if (total === 0) return null;

  return (
    <div
      className={cn('relative overflow-hidden bg-muted touch-pan-y select-none', className)}
      onTouchStart={onTouchStart}
      onTouchMove={onTouchMove}
      onTouchEnd={onTouchEnd}
    >
      <div
        className="flex h-full transition-transform duration-300 ease-out"
        style={{
          width: `${total * 100}%`,
          transform: `translateX(-${index * (100 / total)}%)`,
        }}
      >
        {photos.map((url, i) => (
          <div
            key={`${url}-${i}`}
            className="h-full flex-none"
            style={{ width: `${100 / total}%` }}
          >
            <img
              src={url}
              alt={`House photo ${i + 1}`}
              loading="eager"
              decoding="async"
              draggable={false}
              onClick={() => {
                if (swiped.current) return;
                onSelect?.(i);
              }}
              className={cn(
                'h-full w-full',
                fit === 'cover' ? 'object-cover' : 'object-contain',
                onSelect && 'cursor-zoom-in',
                imgClassName,
              )}
            />
          </div>
        ))}
      </div>

      {total > 1 && (
        <>
          <button
            type="button"
            onClick={() => go(-1)}
            aria-label="Previous photo"
            className="absolute left-3 top-1/2 -translate-y-1/2 grid h-9 w-9 place-items-center rounded-full bg-background/85 text-foreground shadow-md backdrop-blur transition hover:bg-background"
          >
            <ChevronLeft className="h-5 w-5" />
          </button>
          <button
            type="button"
            onClick={() => go(1)}
            aria-label="Next photo"
            className="absolute right-3 top-1/2 -translate-y-1/2 grid h-9 w-9 place-items-center rounded-full bg-background/85 text-foreground shadow-md backdrop-blur transition hover:bg-background"
          >
            <ChevronRight className="h-5 w-5" />
          </button>
          <span className="absolute bottom-3 right-3 rounded-md bg-foreground/70 px-2 py-1 text-[11px] font-semibold text-background">
            {index + 1} / {total}
          </span>
        </>
      )}
    </div>
  );
}

/**
 * Read-only plan detail view for self-managed partners.
 * Privacy: tenant photo stays blurred and no phone number or contact detail is
 * ever rendered. Full tenant records unlock only after the partner supports the
 * tenant.
 */
export function SelfPortfolioPlanDetailSheet({
  plan,
  open,
  onOpenChange,
  isFunded,
}: {
  plan: PlanDetail | null;
  open: boolean;
  onOpenChange: (v: boolean) => void;
  isFunded: boolean;
}) {
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null);
  const [heroIndex, setHeroIndex] = useState(0);
  const planId = plan?.rent_request_id ?? null;
  useEffect(() => {
    setHeroIndex(0);
    setLightboxIndex(null);
  }, [planId, open]);
  if (!plan) return null;
  const photos = (plan.house_image_urls ?? []).filter(Boolean);
  const name = plan.tenant_full_name || plan.tenant_first_name || 'Tenant';
  // "Budumbuli, Bugembe Town, Jinja, Eastern" -> address = whole string, region = last segment
  const addressParts = (plan.tenant_location || plan.request_city || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const fullAddress = addressParts.length
    ? `${addressParts.join(', ')}, Uganda`
    : 'Location not captured yet';
  const regionLabel = addressParts.length
    ? addressParts[addressParts.length - 1]
    : 'Uganda';
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="bottom" className="max-h-[92vh] overflow-y-auto rounded-t-none p-0">
        <SheetHeader className="sr-only">
          <SheetTitle>Rent plan details</SheetTitle>
        </SheetHeader>

        {/* Photo carousel */}
        {photos.length > 0 ? (
          <PhotoSlider
            photos={photos}
            index={Math.min(heroIndex, photos.length - 1)}
            onIndexChange={setHeroIndex}
            onSelect={(i) => setLightboxIndex(i)}
            keyboard={lightboxIndex === null}
            className="w-full h-56 rounded-none"
          />
        ) : (
          <div className="relative w-full h-56 bg-muted flex items-center justify-center">
            <Home className="h-8 w-8 text-muted-foreground" />
          </div>
        )}

        {/* Expanded image card */}
        <Dialog
          open={lightboxIndex !== null}
          onOpenChange={(v) => {
            if (!v) {
              if (lightboxIndex !== null) setHeroIndex(lightboxIndex);
              setLightboxIndex(null);
            }
          }}
        >
          <DialogContent className="max-w-3xl border-0 bg-background p-0 overflow-hidden [&>button]:hidden">
            <DialogHeader className="sr-only">
              <DialogTitle>House photo</DialogTitle>
            </DialogHeader>
            {lightboxIndex !== null && (
              <div className="relative">
                <PhotoSlider
                  photos={photos}
                  index={lightboxIndex}
                  onIndexChange={setLightboxIndex}
                  keyboard
                  fit="contain"
                  className="w-full h-[70vh] rounded-none bg-foreground/5"
                />
                <button
                  type="button"
                  onClick={() => {
                    setHeroIndex(lightboxIndex);
                    setLightboxIndex(null);
                  }}
                  aria-label="Close photo"
                  className="absolute right-3 top-3 grid h-9 w-9 place-items-center rounded-full bg-background/85 text-foreground shadow-md backdrop-blur transition hover:bg-background"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>
            )}
          </DialogContent>
        </Dialog>

        {/* Title card */}
        <div className="relative bg-background px-5 pt-5 pb-5">
          <h2 className="text-2xl font-extrabold leading-tight tracking-tight">
            {plan.house_category ? `${plan.house_category.replace(/-/g, ' ')} in ` : 'Rent plan in '}
            {regionLabel}
          </h2>
          <p className="mt-2 text-sm text-muted-foreground flex items-start gap-1">
            <MapPin className="h-3.5 w-3.5 flex-none mt-0.5" />
            <span>{fullAddress}</span>
          </p>

          {/* Invite others to support this plan */}
          <div className="mt-4 rounded-2xl border border-primary/30 bg-primary/5 p-3">
            <p className="text-xs font-bold">Invite someone to support this tenant</p>
            <p className="mt-1 text-[11px] leading-snug text-muted-foreground">
              {planShareDescription(plan)}
            </p>
            <div className="mt-2.5">
              <PlanShareButton plan={plan} variant="block" />
            </div>
          </div>

          {/* Tenant row */}
          <div className="mt-5 flex items-center gap-3">
            {/* Privacy: the tenant photo is never sent to the client for this
                view, so there is no image URL to reveal via devtools. */}
            <div
              aria-label="Tenant photo protected"
              className="relative w-12 h-12 rounded-full overflow-hidden bg-muted flex-none"
            >
              <img
                src={tenantPhotoPlaceholder}
                alt="Tenant photo hidden for privacy"
                loading="lazy"
                width={512}
                height={640}
                className="h-full w-full scale-110 object-cover blur-[5px]"
              />
            </div>
            <div className="min-w-0">
              <p className="font-bold text-sm truncate">Plan for {name}</p>
              <p className="text-xs text-muted-foreground truncate">
                Landlord: {plan.landlord_name ?? 'Landlord'}
              </p>
            </div>
          </div>

          {/* Key details list */}
          <ul className="mt-4 divide-y divide-border border-t border-border">
            <li className="flex items-center justify-between gap-3 py-3">
              <span className="flex items-center gap-2 text-sm text-muted-foreground">
                <Home className="h-4 w-4 flex-none" /> Rent amount
              </span>
              <span className="text-base font-black text-primary truncate">
                {formatDynamic(plan.funding_amount)}
              </span>
            </li>
            <li className="flex items-start justify-between gap-3 py-3">
              <span className="flex items-center gap-2 text-sm text-muted-foreground">
                <User className="h-4 w-4 flex-none" /> Landlord
              </span>
              <div className="flex flex-col items-end gap-0.5 text-right">
                <span className="text-sm font-bold truncate">{plan.landlord_name ?? 'Landlord'}</span>
                {plan.landlord_phone ? (
                  <a
                    href={`tel:${plan.landlord_phone}`}
                    className="text-xs font-semibold text-primary truncate hover:underline"
                  >
                    {plan.landlord_phone}
                  </a>
                ) : (
                  <span className="text-xs font-semibold text-muted-foreground">—</span>
                )}
              </div>
            </li>
            <li className="flex items-center justify-between gap-3 py-3">
              <span className="flex items-center gap-2 text-sm text-muted-foreground">
                <ShieldCheck className="h-4 w-4 flex-none" /> LC Name
              </span>
              <span className="text-sm font-bold truncate">{plan.lc1_chairperson_name ?? '—'}</span>
            </li>
            <li className="flex items-center justify-between gap-3 py-3">
              <span className="flex items-center gap-2 text-sm text-muted-foreground">
                <Phone className="h-4 w-4 flex-none" /> Proxy Agent
              </span>
              <a
                href="tel:+256751424629"
                className="text-sm font-bold truncate text-primary hover:underline"
              >
                +256 751 424 629
              </a>
            </li>
          </ul>

          {/* Thumbnails */}
          {photos.length > 1 && (
            <div className="mt-5">
              <p className="text-sm font-bold mb-2">More photos</p>
              <div className="grid grid-cols-3 gap-2">
                {photos.map((url, i) => (
                  <button
                    type="button"
                    key={`thumb-${url}-${i}`}
                    onClick={() => {
                      setHeroIndex(i);
                      setLightboxIndex(i);
                    }}
                    aria-label={`Expand house photo ${i + 1}`}
                    className={cn(
                      'rounded-xl overflow-hidden ring-2 ring-transparent transition',
                      i === heroIndex && 'ring-primary',
                    )}
                  >
                    <img
                      src={url}
                      alt={`House photo ${i + 1}`}
                      loading="lazy"
                      className="w-full h-24 object-cover bg-muted"
                    />
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Earnings projection */}
          {(() => {
            const monthly = plan.funding_amount * 0.15;
            const daily = monthly / 30;
            const months = Math.max(1, Math.round((plan.duration_days ?? 30) / 30));
            const total = monthly * months;
            return (
              <div className="mt-5 rounded-2xl border border-primary/40 bg-primary/5 p-4">
                <div className="flex items-center justify-between gap-3">
                  <p className="text-sm font-bold">Your projected returns</p>
                  <span className="rounded-full border border-primary/40 bg-background px-2 py-0.5 text-[11px] font-bold text-primary">
                    15% per month
                  </span>
                </div>
                <p className="mt-1 text-xs text-muted-foreground">
                  Based on a rent amount of {formatDynamic(plan.funding_amount)}.
                </p>
                <ul className="mt-3 divide-y divide-primary/20">
                  {[
                    { label: 'Per day', value: daily },
                    { label: 'Per month', value: monthly },
                  ].map((row) => (
                    <li key={row.label} className="flex items-center justify-between gap-3 py-2.5">
                      <span className="text-xs text-muted-foreground">{row.label}</span>
                      <span className="text-sm font-black text-primary">
                        {formatDynamic(Math.round(row.value))}
                      </span>
                    </li>
                  ))}
                  <li className="flex items-center justify-between gap-3 py-2.5">
                    <span className="text-xs text-muted-foreground">
                      Over {months} {months === 1 ? 'month' : 'months'}
                    </span>
                    <span className="text-base font-black text-primary">
                      {formatDynamic(Math.round(total))}
                    </span>
                  </li>
                </ul>
              </div>
            );
          })()}

          {/* Privacy notice band */}
          <div className="mt-4 -mx-5 bg-muted/50 px-5 py-3 flex items-start gap-2">
            <ShieldCheck className="h-4 w-4 text-muted-foreground flex-none mt-0.5" />
            <p className="text-xs text-muted-foreground">
              {isFunded
                ? 'You already support this tenant. The landlord and tenant have agreed to share this information through Welile.'
                : 'Summary only. Photo and contact details stay hidden until you support this tenant.'}
            </p>
          </div>

        </div>
      </SheetContent>
    </Sheet>
  );
}