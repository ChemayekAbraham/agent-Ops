import { useSelfSupportFeePolicy } from '@/hooks/useSelfSupportFeePolicy';
import { AgentCareNote } from './AgentCareNote';
import { useCallback, useEffect, useRef, useState } from 'react';
import { CONTRACT_TERM_MONTHS } from '@/lib/contractTerm';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { formatDynamic } from '@/lib/currencyFormat';
import { Button } from '@/components/ui/button';
import { ChevronLeft, ChevronRight, Home, MapPin, Phone, ShieldCheck, User, Wallet, X } from 'lucide-react';
import tenantPhotoPlaceholder from '@/assets/tenant-photo-placeholder.jpg';
import { cn } from '@/lib/utils';
import { PlanShareButton } from './PlanShareButton';
import { planShareFallbackDescription } from '@/lib/planShareLink';
import { V360PlanCaptions } from '@/components/v360/V360PlanCaptions';
import { useOwnNewPortfolioRate } from '@/hooks/usePartnerQuoteRate';
import { formatRatePct, rateOrNull } from '@/lib/partnerReturnPolicy';

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
  proxy_agent_phone: string | null;
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
  variant = 'arrows',
}: {
  photos: string[];
  index: number;
  onIndexChange: (i: number) => void;
  onSelect?: (i: number) => void;
  className?: string;
  imgClassName?: string;
  fit?: 'cover' | 'contain';
  keyboard?: boolean;
  /** `dots` is the mobile PageView look: swipe plus a page indicator, no arrow buttons. */
  variant?: 'arrows' | 'dots';
}) {
  const total = photos.length;
  // Clamp defensively: the parent may pass a stale index while a new plan's
  // photos are still swapping in.
  const safeIndex = total > 0 ? Math.min(Math.max(index, 0), total - 1) : 0;
  const indexRef = useRef(safeIndex);
  indexRef.current = safeIndex;
  // Reads the live index from a ref so a stale closure (minified prod bundle,
  // keyboard listener, or an in-flight swipe) can never fight the state.
  const go = useCallback(
    (dir: -1 | 1) => {
      if (total < 2) return;
      const next = (indexRef.current + dir + total) % total;
      indexRef.current = next;
      onIndexChange(next);
    },
    [total, onIndexChange],
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
      {/* Each slide is absolutely stacked and shifted by its own width, so the
          slider never depends on a percentage track width (which silently
          collapses when the container height/width is resolved late). */}
      {photos.map((url, i) => (
        <div
          key={`${url}-${i}`}
          /* `photo-slider-slide` is an explicit opt-out from the Android
             compositor-safe rule that nulls transforms inside dialogs/sheets. */
          className="photo-slider-slide absolute inset-0 transition-transform duration-300 ease-out"
          style={
            {
              '--slide-x': `${(i - safeIndex) * 100}%`,
              transform: 'translate3d(var(--slide-x, 0%), 0, 0)',
            } as React.CSSProperties
          }
          aria-hidden={i !== safeIndex}
        >

          <img
            src={url}
            alt={`House photo ${i + 1}`}
            loading="eager"
            decoding="async"
            draggable={false}
            onClick={() => {
              if (swiped.current || i !== safeIndex) return;
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

      {total > 1 && variant === 'dots' && (
        <div className="absolute inset-x-0 bottom-8 z-20 flex items-center justify-center">
          <div className="flex items-center gap-1 rounded-full bg-foreground/35 px-2 py-1.5 backdrop-blur">
            {photos.map((_, i) => (
              <button
                key={`dot-${i}`}
                type="button"
                onPointerDown={(e) => e.stopPropagation()}
                onClick={(e) => {
                  e.stopPropagation();
                  indexRef.current = i;
                  onIndexChange(i);
                }}
                aria-label={`Show photo ${i + 1} of ${total}`}
                aria-current={i === safeIndex}
                className="grid h-3 place-items-center px-0.5"
              >
                <span
                  className={cn(
                    'block h-1.5 rounded-full bg-background transition-all duration-200',
                    i === safeIndex ? 'w-4' : 'w-1.5 opacity-60',
                  )}
                />
              </button>
            ))}
          </div>
        </div>
      )}

      {total > 1 && variant === 'arrows' && (
        <>
          <button
            type="button"
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => {
              e.stopPropagation();
              go(-1);
            }}
            aria-label="Previous photo"
            className="absolute left-3 top-1/2 z-20 -translate-y-1/2 grid h-9 w-9 place-items-center rounded-full bg-background/85 text-foreground shadow-md backdrop-blur transition hover:bg-background"
          >
            <ChevronLeft className="h-5 w-5" />
          </button>
          <button
            type="button"
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => {
              e.stopPropagation();
              go(1);
            }}
            aria-label="Next photo"
            className="absolute right-3 top-1/2 z-20 -translate-y-1/2 grid h-9 w-9 place-items-center rounded-full bg-background/85 text-foreground shadow-md backdrop-blur transition hover:bg-background"
          >
            <ChevronRight className="h-5 w-5" />
          </button>
          <span className="absolute bottom-3 right-3 z-20 rounded-md bg-foreground/70 px-2 py-1 text-[11px] font-semibold text-background">
            {safeIndex + 1} / {total}
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
  onFund,
}: {
  plan: PlanDetail | null;
  open: boolean;
  onOpenChange: (v: boolean) => void;
  isFunded: boolean;
  /** Renders the Fund button and receives the plan when tapped. */
  onFund?: (plan: PlanDetail) => void;
}) {
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null);
  const [heroIndex, setHeroIndex] = useState(0);
  // "Your projected returns": this partner's own rate for a new portfolio (partner_quote_rate('me')).
  // null while it loads or on error: the projection is null (no figure).
  const { rate: ownRate } = useOwnNewPortfolioRate();
  const ownRatePct = rateOrNull(ownRate);
  // Agent Care: the partner pays pay(rent) (= rent while the switch is off).
  const { pay } = useSelfSupportFeePolicy();
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
      {/* No `relative` here: it would override the sheet's own `fixed`
          positioning (Tailwind orders `relative` after `fixed`) and drop the
          panel into normal flow below the viewport — the sheet would open as a
          blank, washed-out screen. Children position against this fixed box. */}
      <SheetContent side="bottom" className="plan-detail-sheet max-h-[92vh] overflow-y-auto rounded-t-[28px] p-0">

        <SheetHeader className="sr-only">
          <SheetTitle>Rent plan details</SheetTitle>
        </SheetHeader>

        <button
          type="button"
          onClick={() => onOpenChange(false)}
          aria-label="Back"
          className="absolute left-3 top-3 z-30 grid h-10 w-10 place-items-center rounded-full bg-background/90 text-foreground shadow-md backdrop-blur transition active:scale-95 hover:bg-background"
        >
          <ChevronLeft className="h-5 w-5" />
        </button>

        {/* Photo carousel: swipe plus page dots, like a mobile PageView */}
        {photos.length > 0 ? (
          <PhotoSlider
            photos={photos}
            index={Math.min(heroIndex, photos.length - 1)}
            onIndexChange={setHeroIndex}
            onSelect={(i) => setLightboxIndex(i)}
            keyboard={lightboxIndex === null}
            variant="dots"
            className="w-full h-60 rounded-none"
          />
        ) : (
          <div className="relative w-full h-60 bg-muted flex items-center justify-center">
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

        {/* Content sheet overlapping the photo, rounded like a Material bottom sheet */}
        <div className="relative -mt-5 rounded-t-[28px] bg-background px-4 pt-6 pb-0">
          <h2 className="text-2xl font-bold leading-tight tracking-tight">
            {plan.house_category ? `${plan.house_category.replace(/-/g, ' ')} in ` : 'Rent plan in '}
            {regionLabel}
          </h2>
          <p className="mt-2 text-sm text-muted-foreground flex items-start gap-1.5">
            <MapPin className="h-4 w-4 flex-none mt-0.5 text-red-600" />
            <span>{fullAddress}</span>
          </p>

          {/* Invite others to support this plan (tonal card) */}
          <div className="mt-4 rounded-3xl bg-primary/10 p-4">
            <p className="text-sm font-semibold">Invite someone to support this tenant</p>
            <p className="mt-1 text-xs leading-snug text-muted-foreground">
              {planShareFallbackDescription(plan)}
            </p>
            <div className="mt-3">
              <PlanShareButton plan={plan} variant="block" />
            </div>
          </div>

          {/* Opens the house in Google Maps: pinned coordinates when the request
              has them, otherwise a search for the written address. */}
          <Button
            variant="outline"
            className="mt-3 h-11 w-full gap-2 rounded-xl border-primary text-primary hover:bg-primary/5 hover:text-primary"
            onClick={() => {
              const lat = Number(plan.request_latitude);
              const lng = Number(plan.request_longitude);
              const hasCoords = plan.request_latitude != null && plan.request_longitude != null
                && Number.isFinite(lat) && Number.isFinite(lng);
              const query = hasCoords ? `${lat},${lng}` : fullAddress;
              window.open(
                `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(query)}`,
                '_blank',
                'noopener,noreferrer',
              );
            }}
          >
            <svg viewBox="0 0 24 24" className="!h-5 !w-5" aria-hidden>
              <path
                d="M12 1.5a8 8 0 0 0-8 8c0 5.6 6.6 11.8 7.3 12.5a1 1 0 0 0 1.4 0c.7-.7 7.3-6.9 7.3-12.5a8 8 0 0 0-8-8Z"
                fill="#EA4335"
                stroke="#B3261E"
                strokeWidth="1"
              />
              <circle cx="12" cy="9.5" r="3" fill="#8C1D18" />
            </svg>
            House location
          </Button>

          {/* Tenant row (list tile) */}
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

          {/* Key details: list tiles with a tonal leading icon */}
          <ul className="mt-4 divide-y divide-border/60 rounded-3xl bg-muted/40 px-3">
            <li className="flex items-center gap-3 py-3">
              <span className="grid h-10 w-10 flex-none place-items-center rounded-full bg-primary/10 text-primary">
                <Home className="h-5 w-5" />
              </span>
              <span className="min-w-0 flex-1 text-sm text-muted-foreground">Rent amount</span>
              <span className="text-base font-bold text-primary truncate">
                {formatDynamic(pay(Number(plan.funding_amount || 0)))}
              </span>
            </li>
            <li className="py-3 empty:hidden"><AgentCareNote kind="tenant" rent={Number(plan.funding_amount || 0)} /></li>
            <li className="flex items-center gap-3 py-3">
              <span className="grid h-10 w-10 flex-none place-items-center rounded-full bg-primary/10 text-primary">
                <User className="h-5 w-5" />
              </span>
              <span className="min-w-0 flex-1 text-sm text-muted-foreground">Landlord</span>
              <div className="flex min-w-0 flex-col items-end gap-0.5 text-right">
                <span className="text-sm font-semibold truncate">{plan.landlord_name ?? 'Landlord'}</span>
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
            <li className="flex items-center gap-3 py-3">
              <span className="grid h-10 w-10 flex-none place-items-center rounded-full bg-primary/10 text-primary">
                <ShieldCheck className="h-5 w-5" />
              </span>
              <span className="min-w-0 flex-1 text-sm text-muted-foreground">LC Name</span>
              <span className="text-sm font-semibold truncate">{plan.lc1_chairperson_name ?? '—'}</span>
            </li>
            <li className="flex items-center gap-3 py-3">
              <span className="grid h-10 w-10 flex-none place-items-center rounded-full bg-primary/10 text-primary">
                <Phone className="h-5 w-5" />
              </span>
              <span className="min-w-0 flex-1 text-sm text-muted-foreground">Proxy Agent</span>
              <a
                href={`tel:${(plan.proxy_agent_phone ?? '+256 751 424 629').replace(/\s/g, '')}`}
                className="text-sm font-semibold truncate text-primary hover:underline"
              >
                {plan.proxy_agent_phone ?? '+256 751 424 629'}
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
            const monthly = ownRatePct === null ? null : (pay(Number(plan.funding_amount || 0)) * ownRatePct) / 100;
            const daily = monthly === null ? null : monthly / 30;
            // The partner earns across the whole contract, not for the plan's length.
            const months = CONTRACT_TERM_MONTHS;
            const total = monthly === null ? null : monthly * months;
            return (
              <div className="mt-5 rounded-3xl bg-primary/10 p-4">
                <div className="flex items-center justify-between gap-3">
                  <p className="text-sm font-semibold">Your projected Rent profit share</p>
                  {formatRatePct(ownRatePct) && (
                    <span className="rounded-full bg-background px-2.5 py-1 text-[11px] font-bold text-primary">
                      {formatRatePct(ownRatePct)} per month
                    </span>
                  )}
                </div>
                <p className="mt-1 text-xs text-muted-foreground">
                  Based on {formatDynamic(pay(Number(plan.funding_amount || 0)))}.
                </p>
                <ul className="mt-3 divide-y divide-primary/20">
                  {[
                    { label: 'Per day', value: daily },
                    { label: 'Per month', value: monthly },
                  ].map((row) => (
                    <li key={row.label} className="flex items-center justify-between gap-3 py-2.5">
                      <span className="text-xs text-muted-foreground">{row.label}</span>
                      <span className="text-sm font-black text-primary">
                        {row.value === null ? '—' : formatDynamic(Math.round(row.value))}
                      </span>
                    </li>
                  ))}
                  <li className="flex items-center justify-between gap-3 py-2.5">
                    <span className="text-xs text-muted-foreground">
                      Over {months} months
                    </span>
                    <span className="text-base font-black text-primary">
                      {total === null ? '—' : formatDynamic(Math.round(total))}
                    </span>
                  </li>
                </ul>
              </div>
            );
          })()}

          <div className="mt-4">
            <V360PlanCaptions rentRequestId={plan.rent_request_id} />
          </div>

          {/* Privacy notice band */}
          <div className="mt-4 -mx-4 bg-muted/50 px-4 py-3 flex items-start gap-2">
            <ShieldCheck className="h-4 w-4 text-muted-foreground flex-none mt-0.5" />
            <p className="text-xs text-muted-foreground">
              {isFunded
                ? 'You already support this tenant. The landlord and tenant have agreed to share this information through Welile.'
                : 'Summary only. Photo and contact details stay hidden until you support this tenant.'}
            </p>
          </div>

          {/* Bottom action bar: stays on screen while the details scroll */}
          {onFund && !isFunded && (
            <div className="sticky bottom-0 z-20 -mx-4 mt-4 border-t border-border/60 bg-background/95 px-4 pt-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] backdrop-blur">
              <Button
                className="h-12 w-full gap-2 rounded-full bg-emerald-600 text-base font-semibold text-white shadow-md active:scale-[0.99] hover:bg-emerald-700"
                onClick={() => onFund(plan)}
              >
                <Wallet className="h-5 w-5" />
                Fund this tenant — {formatDynamic(pay(Number(plan.funding_amount || 0)))}
              </Button>
            </div>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}