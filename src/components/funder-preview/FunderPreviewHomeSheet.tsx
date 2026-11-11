import { getSessionCheckedUser } from '@/lib/authenticatedRequests';
import { useEffect, useRef, useState } from 'react';
import {
  ArrowLeft,
  BadgeCheck,
  Check,
  ExternalLink,
  Heart,
  Home,
  Loader2,
  Lock,
  MapPin,
  Minus,
  Plus,
  Share2,
  ShieldCheck,
  Sprout,
  TrendingUp,
  UserRound,
} from 'lucide-react';
import { toast } from 'sonner';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { ImageLightbox } from '@/components/marketplace/ImageLightbox';
import { cn } from '@/lib/utils';
import { formatDynamic } from '@/lib/currencyFormat';
import { prettyName } from '@/lib/formatting';
import { supabase } from '@/integrations/supabase/client';
import { createHouseShareLink, houseShareMessageFor } from '@/lib/houseSupportShare';
import { createPlanShareLink, planShareFallbackDescription, planShareTitle } from '@/lib/planShareLink';
import type { FunderNewCategory, FunderNewEmptyHouse, FunderNewReadyPlan } from '@/components/funder-new/types';
import { isHouseVerified, itemAmount, itemCoordinates, toSelectionItem } from '@/components/funder-new/utils';
import { useSelfSupportFeePolicy } from '@/hooks/useSelfSupportFeePolicy';
import { AgentCareNote } from '@/components/partner/AgentCareNote';

export interface FunderPreviewEntry {
  category: FunderNewCategory;
  item: FunderNewEmptyHouse | FunderNewReadyPlan;
}

function photosOf(entry: FunderPreviewEntry): string[] {
  if (entry.category === 'empty') {
    const house = entry.item as FunderNewEmptyHouse;
    const list = (house.image_urls ?? []).filter(Boolean);
    return list.length ? list : house.image_url ? [house.image_url] : [];
  }
  return ((entry.item as FunderNewReadyPlan).house_image_urls ?? []).filter(Boolean);
}

/** Trust rows built only from fields the record actually has. */
function trustRows(entry: FunderNewEmptyHouse | FunderNewReadyPlan, category: FunderNewCategory) {
  const rows: Array<{ icon: typeof UserRound; text: string }> = [];
  if (category === 'empty') {
    const house = entry as FunderNewEmptyHouse;
    if (house.listing_agent_name?.trim()) {
      rows.push({ icon: UserRound, text: `Listed by agent ${prettyName(house.listing_agent_name)}` });
    }
    if (house.landlord_phone?.trim() || house.landlord_name?.trim()) {
      rows.push({ icon: ShieldCheck, text: 'Landlord details on file' });
    }
  } else {
    const plan = entry as FunderNewReadyPlan;
    if (plan.tenant_first_name?.trim()) {
      rows.push({ icon: UserRound, text: `Tenant ${prettyName(plan.tenant_first_name)} is ready to move in` });
    }
    if (plan.lc1_chairperson_name?.trim()) rows.push({ icon: ShieldCheck, text: 'LC1 chairperson on file' });
  }
  rows.push({ icon: Lock, text: 'Nothing is charged until you confirm' });
  return rows;
}

const TIMELINE = [
  { when: 'Today', text: 'You support the Rent Plan', icon: Sprout, tone: 'filled' },
  { when: 'After approval', text: 'The family keeps the home', icon: Home, tone: 'soft' },
  { when: 'Every month', text: 'You earn Rent profit share', icon: TrendingUp, tone: 'success' },
] as const;

/** Which brand colour each step's dot carries, so the connector knows what it joins. */
const TONE_ACCENT = { filled: 'primary', soft: 'primary', success: 'success' } as const;

/** Flat connector colour for a step's accent: the change happens behind a dot, never mid-line. */
const ACCENT_LINE = { primary: 'bg-primary', success: 'bg-success' } as const;

/**
 * "Meet the home": the first screen of the support flow on the preview route.

 * One decision per screen: what it costs, what it earns, why it is real, then
 * one Pick action in thumb reach.
 */
export function FunderPreviewHomeSheet({
  entry,
  open,
  onOpenChange,
  picked,
  onTogglePick,
  saved,
  onToggleSave,
  distanceLabel,
}: {
  entry: FunderPreviewEntry | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  picked: boolean;
  onTogglePick: () => void;
  saved: boolean;
  onToggleSave: () => void;
  distanceLabel?: string | null;
}) {
  const [photoIndex, setPhotoIndex] = useState(0);
  const [viewerIndex, setViewerIndex] = useState<number | null>(null);
  const [sharing, setSharing] = useState(false);
  const stripRef = useRef<HTMLDivElement | null>(null);
  // Agent Care: the partner amount is pay(rent) (= rent while the switch is off).
  const { pay: partnerPay } = useSelfSupportFeePolicy();
  const entryKey = entry ? toSelectionItem(entry.category, entry.item).id : null;

  useEffect(() => {
    setPhotoIndex(0);
    setViewerIndex(null);
    stripRef.current?.scrollTo({ left: 0 });
  }, [entryKey]);

  if (!entry) return null;
  const view = toSelectionItem(entry.category, entry.item, partnerPay);
  const photos = photosOf(entry);
  const verified = isHouseVerified(entry.category, entry.item);
  const rooms = entry.category === 'empty' ? (entry.item as FunderNewEmptyHouse).number_of_rooms : null;
  const placeLine = [view.place, rooms ? `${rooms} ${rooms === 1 ? 'room' : 'rooms'}` : null, distanceLabel]
    .filter(Boolean)
    .join(' · ');
  // Only a recorded GPS pin gets a map link; a missing pin is never guessed.
  const coords = itemCoordinates(entry.item, entry.category);
  const mapsUrl = coords
    ? `https://www.google.com/maps/search/?api=1&query=${coords.lat},${coords.lng}`
    : null;

  /**
   * Share the open home or Rent Plan. Both categories get a real, trackable
   * branded link: empty homes through the house support link, ready plans
   * through the existing plan short link. The native share sheet is used when
   * the device has one; otherwise the message is copied for WhatsApp or SMS.
   */
  const share = async () => {
    if (sharing) return;
    setSharing(true);
    try {
      if (entry.category === 'empty') {
        const link = await createHouseShareLink(view.id);
        // The Returns sentence is the one the database composed (link.description); none -> no figure.
        const text = houseShareMessageFor(
          { title: view.title, place: view.place, monthly_rent: view.amount },
          link.share_url,
          link.description,
        );
        if (typeof navigator !== 'undefined' && navigator.share) {
          await navigator.share({ title: link.og_title ?? view.title, text });
        } else {
          await navigator.clipboard.writeText(text);
          toast.success('Link copied. Paste it in WhatsApp or SMS.');
        }
        return;
      }

      const plan = entry.item as FunderNewReadyPlan;
      const { data: session } = await getSessionCheckedUser();
      const userId = session.user?.id;
      if (!userId) throw new Error('Sign in to share this Rent Plan');
      const link = await createPlanShareLink(userId, plan.rent_request_id);
      const title = planShareTitle(plan);
      const description = link.description ?? planShareFallbackDescription(plan);
      const text = `${title}\n\n${description}\n${link.share_url}`;
      if (typeof navigator !== 'undefined' && navigator.share) {
        await navigator.share({ title, text, url: link.share_url });
      } else {
        await navigator.clipboard.writeText(text);
        toast.success('Link copied. Paste it in WhatsApp or SMS.');
      }
    } catch (err) {
      if ((err as { name?: string })?.name !== 'AbortError') toast.error('Could not create a share link. Please try again.');
    } finally {
      setSharing(false);
    }
  };

  const roundButton =
    'flex h-11 w-11 items-center justify-center rounded-full bg-card text-foreground shadow-[0_4px_14px_-4px_hsl(222_47%_11%/0.3)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring';

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex h-[100dvh] max-h-none w-screen max-w-none flex-col gap-0 overflow-hidden rounded-none border-0 bg-background p-0 sm:h-[92vh] sm:max-w-md sm:rounded-3xl sm:border [&>button.absolute]:hidden">
        <DialogTitle className="sr-only">{view.title}</DialogTitle>
        <DialogDescription className="sr-only">
          {formatDynamic(view.amount)} to support in {view.place}.
        </DialogDescription>

        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain pb-40">
          {/* Photos */}
          <div className="sticky top-0 z-0 h-[262px] w-full flex-none bg-muted">
            {photos.length ? (
              <div
                ref={stripRef}
                className="flex h-full snap-x snap-mandatory overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
                onScroll={(event) => {
                  const el = event.currentTarget;
                  setPhotoIndex(Math.round(el.scrollLeft / Math.max(1, el.clientWidth)));
                }}
              >
                {photos.map((src, index) => (
                  <button
                    key={src}
                    type="button"
                    onClick={() => setViewerIndex(index)}
                    aria-label={`View photo ${index + 1} of ${photos.length} full screen`}
                    className="h-full w-full flex-none cursor-zoom-in snap-center bg-transparent p-0"
                  >
                    <img
                      src={src}
                      alt={index === 0 ? `Photo of ${view.title} in ${view.place}` : ''}
                      loading={index === 0 ? 'eager' : 'lazy'}
                      className="h-full w-full object-cover"
                    />
                  </button>
                ))}
              </div>
            ) : (
              <div className="flex h-full items-center justify-center text-primary/40">
                <Home className="h-14 w-14" aria-hidden />
              </div>
            )}
            <div className="absolute inset-x-4 top-[max(1rem,env(safe-area-inset-top))] flex justify-between">
              <button type="button" aria-label="Back to houses" className={cn(roundButton, 'text-primary')} onClick={() => onOpenChange(false)}>
                <ArrowLeft className="h-5 w-5" aria-hidden />
              </button>
              <div className="flex gap-2.5">
                <button
                  type="button"
                  aria-label={entry.category === 'empty' ? 'Share this house' : 'Share this Rent Plan'}
                  className={roundButton}
                  onClick={share}
                  disabled={sharing}
                >
                  {sharing ? <Loader2 className="h-5 w-5 animate-spin" aria-hidden /> : <Share2 className="h-5 w-5" aria-hidden />}
                </button>
                <button
                  type="button"
                  aria-label={`Save ${view.title}`}
                  aria-pressed={saved}
                  className={cn(roundButton, 'text-destructive')}
                  onClick={onToggleSave}
                >
                  <Heart className={cn('h-5 w-5', saved && 'fill-current')} aria-hidden />
                </button>
              </div>
            </div>
            {photos.length > 1 ? (
              <span className="absolute bottom-10 right-4 rounded-full bg-foreground/75 px-2.5 py-1 text-xs font-semibold text-background">
                {photoIndex + 1} / {photos.length} photos
              </span>
            ) : null}
          </div>

          {/* Details sheet */}
          <div className="relative z-10 -mt-7 space-y-4 rounded-t-[28px] bg-background px-5 pt-6 shadow-[0_-16px_28px_-18px_hsl(222_47%_11%/0.35)]">
            <span aria-hidden className="absolute left-1/2 top-2.5 h-[5px] w-11 -translate-x-1/2 rounded-full bg-border" />

            <div className="flex flex-wrap gap-2">
              <span className="inline-flex items-center gap-1.5 rounded-full bg-success/10 px-3 py-1.5 text-[13px] font-semibold text-success">
                <Check className="h-3.5 w-3.5" strokeWidth={3} aria-hidden />
                {entry.category === 'ready' ? 'Tenant ready' : 'Empty home'}
              </span>
              {verified ? (
                <span className="inline-flex items-center gap-1.5 rounded-full bg-primary/10 px-3 py-1.5 text-[13px] font-semibold text-primary">
                  <BadgeCheck className="h-3.5 w-3.5 fill-primary text-primary [&_path:last-child]:stroke-white" strokeWidth={2.5} aria-hidden />
                  Verified house
                </span>
              ) : null}
            </div>

            <div className="space-y-1">
              <h2 className="text-[26px] font-bold leading-tight tracking-tight">{view.title}</h2>
              {mapsUrl ? (
                <a
                  href={mapsUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  aria-label={`Open ${view.title} in ${view.place} in Google Maps (opens a new tab)`}
                  className="mt-1 flex min-h-12 items-center gap-2.5 rounded-2xl border bg-card py-2 pl-2 pr-3 text-foreground no-underline transition-colors hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <span aria-hidden className="flex h-[34px] w-[34px] flex-none items-center justify-center rounded-[10px] bg-primary/10 text-primary">
                    <MapPin className="h-[18px] w-[18px]" />
                  </span>
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="text-[15px] font-semibold">{placeLine}</span>
                    <span className="text-[13px] font-semibold text-primary">Open in Google Maps</span>
                  </span>
                  <ExternalLink className="h-[18px] w-[18px] flex-none text-primary" aria-hidden />
                </a>
              ) : (
                <p className="flex items-center gap-1.5 text-[15px] text-muted-foreground">
                  <MapPin className="h-4 w-4 flex-none" aria-hidden />
                  {placeLine}
                </p>
              )}
            </div>

            <section aria-labelledby="preview-how-h" className="space-y-3 rounded-[20px] border bg-card p-4">
              <h3 id="preview-how-h" className="text-[15px] font-bold">
                How your support works
              </h3>
              <ol>
                {TIMELINE.map(({ when, text, icon: Icon, tone }, index) => {
                  const first = index === 0;
                  const last = index === TIMELINE.length - 1;
                  const accent = TONE_ACCENT[tone];
                  const belowAccent = last ? null : TONE_ACCENT[TIMELINE[index + 1].tone];
                  return (
                    <li key={when} className="flex items-center gap-3">
                      <span aria-hidden className="relative flex w-9 flex-none self-stretch items-center justify-center">
                        {first ? null : (
                          <span
                            className={cn(
                              'absolute left-1/2 top-0 h-1/2 w-[3px] -translate-x-1/2',
                              ACCENT_LINE[accent],
                            )}
                          />
                        )}
                        {belowAccent ? (
                          <span

                            className={cn(
                              'absolute bottom-0 left-1/2 h-1/2 w-[3px] -translate-x-1/2',
                              ACCENT_LINE[belowAccent],
                            )}
                          />
                        ) : null}
                        <span
                          className={cn(

                            'relative z-10 flex h-9 w-9 flex-none items-center justify-center rounded-full bg-card ring-4 ring-card',
                            tone === 'filled' && 'bg-primary text-primary-foreground',
                            tone === 'soft' && 'text-primary',
                            tone === 'success' && 'text-success',
                          )}
                        >
                          {tone === 'soft' ? <span className="absolute inset-0 rounded-full bg-primary/10" aria-hidden /> : null}
                          {tone === 'success' ? <span className="absolute inset-0 rounded-full bg-success/10" aria-hidden /> : null}
                          <Icon className="relative h-[18px] w-[18px]" />
                        </span>
                      </span>
                      <div className="min-w-0 flex-1 py-2">
                        <p className={cn('text-xs font-bold', tone === 'success' ? 'text-success' : 'text-primary')}>{when}</p>
                        <p className="text-sm font-semibold">{text}</p>
                      </div>
                    </li>
                  );
                })}
              </ol>
            </section>


            <dl className="grid grid-cols-2 gap-2.5">
              <div className="rounded-[18px] border bg-card p-3.5">
                <dt className="text-xs font-medium text-muted-foreground">
                  {entry.category === 'empty' ? 'Monthly rent' : 'Rent Plan amount'}
                </dt>
                <dd className="mt-1 text-lg font-bold tabular-nums">{formatDynamic(view.amount)}</dd>
              </div>
              <div className="rounded-[18px] border bg-card p-3.5">
                <dt className="text-xs font-medium text-muted-foreground">Est. monthly Rent profit share</dt>
                <dd className="mt-1 text-lg font-bold tabular-nums text-success">
                  {view.monthlyReturn !== null ? formatDynamic(view.monthlyReturn) : 'Not available'}
                </dd>
              </div>
            </dl>

            <ul aria-label="Why you can trust this home" className="space-y-2.5">
              {trustRows(entry.item, entry.category).map(({ icon: Icon, text }) => (
                <li key={text} className="flex items-center gap-2.5 text-sm">
                  <span aria-hidden className="flex h-7 w-7 flex-none items-center justify-center rounded-full bg-primary/10 text-primary">
                    <Icon className="h-[15px] w-[15px]" />
                  </span>
                  {text}
                </li>
              ))}
            </ul>
            <AgentCareNote
              kind={entry.category === 'empty' ? 'house' : 'tenant'}
              rent={itemAmount(entry.category, entry.item)}
            />
          </div>
        </div>

        <div className="absolute inset-x-0 bottom-0 space-y-2 bg-card px-5 pb-[max(1.6rem,env(safe-area-inset-bottom))] pt-3.5 shadow-[0_-8px_28px_-10px_hsl(var(--primary)/0.25)]">
          <button
            type="button"
            onClick={onTogglePick}
            aria-pressed={picked}
            className={cn(
              'flex h-[52px] w-full items-center justify-center gap-2 rounded-2xl text-base font-semibold transition-transform active:scale-[0.99] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2',
              picked ? 'border-[1.5px] border-primary bg-card text-primary' : 'bg-primary text-primary-foreground',
            )}
          >
            {picked ? <Minus className="h-5 w-5" aria-hidden /> : <Plus className="h-5 w-5" aria-hidden />}
            {picked ? 'Remove from my plan' : 'Pick this home'}
          </button>
          <p className="text-center text-xs font-medium text-muted-foreground">
            {picked ? 'This home is in your plan.' : 'You can review or remove it before anything is paid.'}
          </p>
        </div>
        {/* Full-screen photo view: opened by tapping any photo above. */}
        <ImageLightbox
          images={photos.map((url, i) => ({ id: `${entryKey}-${i}`, image_url: url }))}
          initialIndex={viewerIndex ?? 0}
          open={viewerIndex !== null}
          onClose={() => setViewerIndex(null)}
          productName={view.title}
        />
      </DialogContent>
    </Dialog>
  );
}
