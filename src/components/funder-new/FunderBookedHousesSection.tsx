import { useState } from 'react';
import { Ban, CheckCircle2, Clock, Home, Loader2, RefreshCw, RotateCcw, Wallet } from 'lucide-react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { formatUGX } from '@/lib/rentCalculations';
import type { HouseOpportunity } from '@/components/agent/EmptyHouseDetailSheet';
import {
  BOOKED_HOUSES_MIN_FUNDING,
  fundBookedHouses,
  loadBookedHouseDetails,
  releaseBookedHouse,
  useFunderBookedHouses,
  type FunderBooking,
} from '@/hooks/useFunderBookedHouses';

const RETURN_RATE = 0.15;

function BookingRow({
  booking,
  busy,
  opening,
  onOpen,
  onRelease,
}: {
  booking: FunderBooking;
  busy: boolean;
  opening: boolean;
  onOpen: () => void;
  onRelease?: () => void;
}) {
  const photo = booking.image_urls?.find(Boolean);
  const held = booking.status === 'reserved' && !booking.taken;
  const taken = booking.status === 'reserved' && booking.taken;
  return (
    <article className="flex items-center gap-3 py-3">
      <button
        type="button"
        onClick={onOpen}
        disabled={opening}
        aria-busy={opening}
        aria-label={`Open details for ${booking.title}`}
        className="flex min-w-0 flex-1 items-center gap-3 rounded-lg text-left outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
      >
        <span className="flex h-16 w-16 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-primary/10">
          {photo ? <img src={photo} alt="" className="h-full w-full object-cover" /> : <Home className="h-6 w-6 text-primary" />}
        </span>
        <div className="min-w-0 flex-1">
          <p className="break-words font-semibold">{booking.title}</p>
          <p className="break-words text-xs text-muted-foreground">{booking.district || 'Location on file'}</p>
          <p className="mt-0.5 text-sm font-semibold">
            {formatUGX(booking.monthly_rent)}{' '}
            <span className="text-xs font-medium text-success">+{formatUGX(Math.round(Number(booking.monthly_rent || 0) * RETURN_RATE))}/mo</span>
          </p>
          {taken ? (
            <Badge variant="outline" className="mt-1 gap-1 border-destructive/40 text-[11px] text-destructive">
              <Ban className="h-3 w-3" aria-hidden />
              Taken — no longer available
            </Badge>
          ) : held ? (
            <Badge variant="secondary" className="mt-1 gap-1 text-[11px]">
              <Clock className="h-3 w-3" aria-hidden />
              Held · {booking.days_left ?? 0} day{(booking.days_left ?? 0) === 1 ? '' : 's'} left
            </Badge>
          ) : (
            <Badge className="mt-1 gap-1 text-[11px]">
              <CheckCircle2 className="h-3 w-3" aria-hidden />
              Funding submitted
            </Badge>
          )}
          {opening ? (
            <p className="mt-1 flex items-center gap-1 text-xs text-muted-foreground">
              <Loader2 className="h-3 w-3 animate-spin" aria-hidden /> Opening details…
            </p>
          ) : null}
        </div>
      </button>
      {held && onRelease ? (
        <Button
          variant="outline"
          size="sm"
          className="shrink-0 border-destructive/40 text-destructive hover:bg-destructive/10 hover:text-destructive"
          disabled={busy}
          onClick={onRelease}
          aria-label={`Give up ${booking.title}`}
        >
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <RotateCcw className="h-4 w-4" />}
          Give up
        </Button>
      ) : null}
    </article>
  );
}

/**
 * Houses this Supporter booked (7-day holds) and houses whose funding was
 * submitted. Held houses are funded together, so a set of small rents can
 * reach the house minimum that a single house cannot. The fund action sits
 * below the list so the supporter reads what they hold before funding it.
 * Tapping a listed house opens the Supporter's own house details sheet —
 * the same one the funder dashboard opens — never the public house page.
 */
export function FunderBookedHousesSection({ onOpenHouse }: { onOpenHouse: (house: HouseOpportunity) => void }) {
  const { query, bookings, held } = useFunderBookedHouses();
  const [confirming, setConfirming] = useState(false);
  const [funding, setFunding] = useState(false);
  const [releasing, setReleasing] = useState<string | null>(null);
  const [opening, setOpening] = useState<string | null>(null);

  const submitted = bookings.filter((b) => b.status === 'funded');
  const takenBookings = bookings.filter((b) => b.status === 'reserved' && b.taken);
  const heldTotal = held.reduce((sum, b) => sum + Number(b.monthly_rent || 0), 0);
  const belowMinimum = heldTotal < BOOKED_HOUSES_MIN_FUNDING;

  if (query.isPending) {
    return (
      <div className="flex items-center gap-2 py-4 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" /> Loading your booked houses
      </div>
    );
  }
  if (query.isError) {
    return (
      <div className="flex items-center justify-between gap-3 py-3 text-sm">
        <span className="text-destructive">Could not load your booked houses.</span>
        <Button variant="outline" size="sm" onClick={() => void query.refetch()}>
          <RefreshCw className="h-4 w-4" /> Try again
        </Button>
      </div>
    );
  }
  if (held.length === 0 && submitted.length === 0 && takenBookings.length === 0) return null;

  const fundAll = async () => {
    setFunding(true);
    try {
      await fundBookedHouses(held);
      toast.success(`Funding submitted for ${held.length} ${held.length === 1 ? 'house' : 'houses'}. It now goes for operational review.`);
      setConfirming(false);
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setFunding(false);
    }
  };

  const release = async (booking: FunderBooking) => {
    setReleasing(booking.house_id);
    try {
      await releaseBookedHouse(booking);
      toast.success('House returned to the open list for other Supporters');
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setReleasing(null);
    }
  };

  /** Opens the same house details sheet the funder dashboard uses. */
  const openDetails = async (booking: FunderBooking) => {
    setOpening(booking.house_id);
    try {
      onOpenHouse(await loadBookedHouseDetails(booking.house_id));
    } catch (err) {
      toast.error((err as Error).message || 'Could not open these house details.');
    } finally {
      setOpening(null);
    }
  };

  return (
    <section aria-labelledby="booked-houses-h" className="space-y-2">
      <div>
        <h3 id="booked-houses-h" className="font-semibold">
          Booked for you
        </h3>
        {held.length ? (
          <p className="text-xs text-muted-foreground">
            {held.length} held · {formatUGX(heldTotal)} to fund. Holds last 7 days, then the house goes back to the open list.
          </p>
        ) : null}
      </div>

      <div className="divide-y divide-border">
        {held.map((booking) => (
          <BookingRow
            key={booking.intent_id}
            booking={booking}
            busy={releasing === booking.house_id || funding}
            opening={opening === booking.house_id}
            onOpen={() => void openDetails(booking)}
            onRelease={() => void release(booking)}
          />
        ))}
        {submitted.map((booking) => (
          <BookingRow
            key={booking.intent_id}
            booking={booking}
            busy={false}
            opening={opening === booking.house_id}
            onOpen={() => void openDetails(booking)}
          />
        ))}
        {takenBookings.map((booking) => (
          <BookingRow
            key={booking.intent_id}
            booking={booking}
            busy={false}
            opening={opening === booking.house_id}
            onOpen={() => void openDetails(booking)}
          />
        ))}
      </div>

      {held.length ? (
        <div className="space-y-2 rounded-xl border bg-muted/30 p-3">
          {belowMinimum ? (
            <p className="text-xs text-muted-foreground">
              House support starts at {formatUGX(BOOKED_HOUSES_MIN_FUNDING)}. Book more houses to fund these together.
            </p>
          ) : confirming ? (
            <div className="space-y-2">
              <p className="text-sm">
                Fund {held.length} {held.length === 1 ? 'house' : 'houses'} for {formatUGX(heldTotal)} from your support balance?
                Est. monthly Rent profit share {formatUGX(Math.round(heldTotal * RETURN_RATE))}.
              </p>
              <div className="grid grid-cols-2 gap-2">
                <Button variant="outline" disabled={funding} onClick={() => setConfirming(false)}>
                  Not yet
                </Button>
                <Button disabled={funding} onClick={() => void fundAll()}>
                  {funding ? <Loader2 className="h-4 w-4 animate-spin" /> : <Wallet className="h-4 w-4" />}
                  Confirm
                </Button>
              </div>
            </div>
          ) : (
            <Button className="w-full" onClick={() => setConfirming(true)}>
              <Wallet className="h-4 w-4" />
              Fund all {held.length} held · {formatUGX(heldTotal)}
            </Button>
          )}
        </div>
      ) : null}
    </section>
  );
}
